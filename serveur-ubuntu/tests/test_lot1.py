"""
Tests de la version 1.1.0 : erreurs de détection relevées sur un dossier réel, reproduites ici
avec des données ENTIÈREMENT FICTIVES. Un contrôle par erreur signalée.

    python -m tests.test_lot1                          (avec spaCy si le modèle est installé)
    ANON_SPACY_MODEL=aucun python -m tests.test_lot1   (règles seules)

Ces contrôles sont aussi lancés par « python -m tests.test_moteur » et par pytest.

Les propositions du modèle de langue sont simulées quand il le faut : le résultat ne dépend
donc pas de la présence ni de la version de spaCy.
"""
import contextlib
import os
import re
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.fernet import Fernet  # noqa: E402

from app import detect as D  # noqa: E402
from app.engine import Moteur  # noqa: E402
from app.store import GENERATION, Store  # noqa: E402

ICI = Path(__file__).parent
TMP = tempfile.mkdtemp(prefix="anon-tests-")
# Configuration vide : les contrôles ne dépendent que des listes livrées avec l'application,
# pas des fichiers personnalisés du serveur (/etc/anonymiseur).
CONF = tempfile.mkdtemp(prefix="conf-vide-", dir=TMP)
ECHECS: list[str] = []
CONTROLES = []
IBAN = "FR76 3000 6000 0112 3456 7890 189"


def verifier(cond, message):
    print(("  ok   " if cond else "  ÉCHEC ") + message)
    if not cond:
        ECHECS.append(message)


def controle(titre):
    """Enregistre un contrôle ; sous pytest, il échoue si l'une de ses vérifications échoue."""
    def decorateur(fonction):
        def enveloppe():
            avant = len(ECHECS)
            print("\n" + titre)
            fonction()
            if "pytest" in sys.modules:
                assert len(ECHECS) == avant, ECHECS[avant:]
        enveloppe.__name__ = fonction.__name__
        CONTROLES.append(enveloppe)
        return enveloppe
    return decorateur


_NUMERO = [0]


def base():
    _NUMERO[0] += 1
    return os.path.join(TMP, f"base-{_NUMERO[0]}.db")


def moteur(listes=None):
    return Moteur(Store(base(), Fernet.generate_key().decode()), listes or D.Listes.charger(CONF))


def positions(texte, paires):
    """[(fragment, étiquette)] -> [(début, fin, étiquette)] pour les fragments présents (mot entier)."""
    out = []
    for fragment, etiquette in paires:
        m = re.search(r"(?<!\w)" + re.escape(fragment) + r"(?!\w)", texte)
        if m:
            out.append((m.start(), m.end(), etiquette))
    return out


@contextlib.contextmanager
def modele_simule(paires):
    """Remplace le modèle de langue par des propositions choisies (PER = personne, ORG = organisation)."""
    origine = D.candidats_spacy
    D.candidats_spacy = lambda texte: positions(texte, paires)
    try:
        yield
    finally:
        D.candidats_spacy = origine


SCHEMA_1_0 = """
CREATE TABLE dossiers(id TEXT PRIMARY KEY, cree REAL NOT NULL, utilise REAL NOT NULL);
CREATE TABLE entrees(dossier TEXT NOT NULL, marqueur TEXT NOT NULL, type TEXT NOT NULL,
    empreinte TEXT NOT NULL, valeur BLOB NOT NULL, canonique INTEGER NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 0, cree REAL NOT NULL, PRIMARY KEY(dossier, empreinte));
CREATE TABLE compteurs(dossier TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY(dossier, type));
"""


def moteur_sur_ancienne_base(dossier, entrees):
    """Moteur ouvert sur une base au format de la version 1.0.1, déjà remplie : [(type, valeur)]."""
    chemin, cle = base(), Fernet.generate_key().decode()
    aide = Store(base(), cle)  # même clé : sert seulement à chiffrer et à calculer les empreintes
    db = sqlite3.connect(chemin)
    db.executescript(SCHEMA_1_0)
    compteurs: dict[str, int] = {}
    maintenant = time.time()
    for type_, valeur in entrees:
        n = compteurs[type_] = compteurs.get(type_, 0) + 1
        db.execute(
            "INSERT INTO entrees(dossier, marqueur, type, empreinte, valeur, canonique, occurrences, cree) "
            "VALUES(?,?,?,?,?,1,1,?)",
            (dossier, f"[{type_}_{n}]", type_, aide.empreinte(dossier, D.normaliser(valeur, type_)),
             aide._chiffrer(valeur), maintenant))
    for type_, n in compteurs.items():
        db.execute("INSERT INTO compteurs(dossier, type, n) VALUES(?,?,?)", (dossier, type_, n))
    db.execute("INSERT INTO dossiers(id, cree, utilise) VALUES(?,?,?)", (dossier, maintenant, maintenant))
    db.commit()
    db.close()
    return Moteur(Store(chemin, cle), D.Listes.charger(CONF))


def valeurs(resultat, type_=None):
    return [e["valeur"] for e in resultat["entites"] if type_ is None or e["type"] == type_]


# ============================================================================
# 4a. FUITES
# ============================================================================
@controle("A1. Numéro RCS / SIREN / SIRET coupé par un retour à la ligne")
def test_rcs_coupe_par_retour_ligne():
    M = moteur()
    r = M.anonymiser("La société Brumeval Immobilier est immatriculée au RCS de Lyon sous le n° 352 332\n"
                     "159, depuis 2019.", "a1", inclure_valeurs=True)
    s = r["texte"]
    verifier("352 332" not in s and "159" not in s, "numéro réparti sur deux lignes : entièrement masqué")
    verifier("[SIREN_1]" in s, "un seul marqueur [SIREN_1] pour les deux morceaux")
    verifier(valeurs(r, "SIREN") == ["352 332 159"], f"valeur enregistrée d'un seul tenant (obtenu : {valeurs(r, 'SIREN')})")
    verifier("depuis 2019" in s, "le texte qui suit le numéro est conservé")
    retour = M.reidentifier("Numéro : [SIREN_1].", "a1")
    verifier(retour["texte"] == "Numéro : 352 332 159.", "ré-identification : numéro restitué sur une ligne")
    r2 = M.anonymiser("Extrait : RCS Lyon B 352 332 159.", "a1")
    verifier("[SIREN_1]" in r2["texte"], "même numéro écrit sur une ligne dans un autre document : même marqueur")

    r3 = moteur().anonymiser("SIRET : 732 829 320\r\n00074 (siège).", "a1b", inclure_valeurs=True)
    verifier("[SIRET_1]" in r3["texte"] and "00074" not in r3["texte"] and "732" not in r3["texte"],
             "SIRET coupé après le neuvième chiffre (fin de ligne Windows)")
    r4 = moteur().anonymiser("Siren 352\n332 159.", "a1c")
    verifier("[SIREN_1]" in r4["texte"] and "332" not in r4["texte"], "SIREN coupé après le troisième chiffre")
    r5 = moteur().anonymiser("Société immatriculée au RCS de Lyon, au capital de 100 000 000 euros.", "a1d")
    verifier("100 000 000 euros" in r5["texte"] and "[SIREN_" not in r5["texte"],
             "un capital de neuf chiffres après « RCS » n'est pas pris pour un numéro")


@controle("A2. Noms de propriétaires isolés dans un tableau")
def test_noms_isoles_dans_un_tableau():
    texte = ("Lot    Propriétaire    Solde\n"
             "S09 Dupont\n"
             "S10 Lefèvre\n"
             "S11 Cave\n"
             "A12 Parking\n"
             "Lot 14 Marchetti\n"
             "S15\tDe Almeida\t92,00\n"
             "S16 Lyon\n"
             "\n"
             "Dupont n'a pas réglé sa quote-part.\n")
    r = moteur().anonymiser(texte, "a2", {"ner": False}, inclure_valeurs=True)
    s = r["texte"]
    for nom in ["Dupont", "Lefèvre", "Marchetti", "Almeida"]:
        verifier(nom not in s, f"masqué : {nom}")
    for garde in ["S09 ", "S10 ", "S11 Cave", "A12 Parking", "Lot 14 ", "S16 Lyon", "92,00", "Propriétaire    Solde"]:
        verifier(garde in s, f"conservé : {garde.strip()}")
    verifier(s.count("[PERSONNE_1]") == 2, "le nom du tableau est aussi masqué dans la phrase qui suit")
    verifier(all(e["type"] == "PERSONNE" for e in r["entites"]), "les noms du tableau sont des personnes")

    word = "Lot | Propriétaire | Solde\nS09 | Dupont | 92,00 €\nS10 | Lefèvre | 15,50 €\nS11 | Cave | 0,00 €\n"
    s2 = moteur().anonymiser(word, "a2b", {"ner": False})["texte"]
    verifier("Dupont" not in s2 and "Lefèvre" not in s2, "tableau Word (cellules séparées par « | ») : noms masqués")
    verifier("S11 | Cave" in s2 and "92,00 €" in s2 and "15,50 €" in s2, "tableau Word : désignation de lot et montants conservés")


@controle("A3. Adresses partielles")
def test_adresses_partielles():
    cas = [
        ("Le siège est 110 Grande rue de la Guillotière, 69007 Lyon.", ["110", "Grande rue", "Guillotière", "69007"], ["Le siège est"]),
        ("Le lot se situe 16/18 rue Paul Verdier à Lyon.", ["16/", "18 rue", "Verdier"], ["Le lot se situe", "à Lyon"]),
        ("Immeuble sis 16-18 avenue des Acacias.", ["16-18", "Acacias"], ["Immeuble sis"]),
        ("Local situé 16 et 18 rue du Moulin.", ["16 et 18", "Moulin"], ["Local situé"]),
        ("Elle habite 4 Petite rue des Lilas.", ["4 Petite", "Lilas"], ["Elle habite"]),
        ("Entrepôt : 25 Vieux chemin de Montribloud.", ["25 Vieux", "Montribloud"], ["Entrepôt"]),
        ("Domicile : 3 rue du 8 Mai 1945, 69100 Villeurbanne.", ["3 rue", "8 Mai 1945", "69100", "Villeurbanne"], ["Domicile"]),
    ]
    for texte, masques, gardes in cas:
        s = moteur().anonymiser(texte, "a3", {"ner": False})["texte"]
        ok = all(m not in s for m in masques) and all(g in s for g in gardes) and "[ADRESSE_" in s
        verifier(ok, f"{texte}  ->  {s}")


# ============================================================================
# 4b. SUR-MASQUAGE
# ============================================================================
@controle("B1. Montants absorbés par un marqueur d'adresse ou de société")
def test_montants_non_absorbes():
    cas = [
        ("Lot 7 : 12 rue des Tanneurs 92,00 € restant dus.", "92,00 €", "Tanneurs"),
        ("12 rue des Tanneurs – 92,00 €", "– 92,00 €", "Tanneurs"),
        ("12 rue des Tanneurs 92.00 €", "92.00 €", "Tanneurs"),
        ("Solde : 15 chemin du Lavoir 300 € au 3 mars.", "300 €", "Lavoir"),
        ("8 avenue des Acacias 1 250,50 euros.", "1 250,50 euros", "Acacias"),
        ("Loyer dû par la SARL Dupont Frères 1 250,00 € au titre du mois.", "1 250,00 €", "Dupont"),
        ("Facture de la société Brumeval Immobilier 980,00 € TTC.", "980,00 € TTC", "Brumeval"),
    ]
    for texte, montant, masque in cas:
        s = moteur().anonymiser(texte, "b1", {"ner": False})["texte"]
        ok = montant in s and masque not in s and not re.search(r"\][,.]\d", s)
        verifier(ok, f"{texte}  ->  {s}")
    zones = D.zones_protegees("Capital 10 000 euros, solde 1 250,50 €, colonne 92,00 et 3 k€.")
    verifier(len(zones) == 4, f"quatre montants reconnus comme zones protégées (obtenu : {len(zones)})")


@controle("B2. Références d'articles prises pour des personnes (« L. 441-6 »)")
def test_references_articles():
    texte = ("Mme L. conteste la facture. En application de l'article L. 441-6 du code de commerce, de "
             "l'article R. 123-4 et des articles 1240 et 1241 du code civil (pourvoi n° 19-12.345, "
             "RG 23/01234, règlement (UE) 2016/679, loi n° 2016-1321, CELEX 32016R0679, L441-6), elle doit payer.")
    r = moteur().anonymiser(texte, "b2", {"ner": False})
    verifier(r["texte"] == texte, f"aucun remplacement, texte inchangé (obtenu : {[e['marqueur'] for e in r['entites']]})")
    with modele_simule([("L", "PER"), ("L. 441-6", "PER"), ("R. 123-4", "ORG")]):
        r2 = moteur().anonymiser(texte, "b2b")
    verifier(r2["texte"] == texte, "même si le modèle de langue propose « L. 441-6 » comme personne")
    # Une initiale enregistrée comme personne par l'ancienne version ne doit plus toucher aux articles
    M = moteur_sur_ancienne_base("b2c", [("PERSONNE", "L.")])
    r3 = M.anonymiser(texte, "b2c", {"ner": False})
    verifier(r3["texte"] == texte, "initiale « L. » enregistrée par l'ancienne version : les articles restent lisibles")
    for fragment in ["L. 441-6", "article R. 123-4", "articles 1240 et 1241", "n° 19-12.345", "RG 23/01234",
                     "(UE) 2016/679", "loi n° 2016-1321", "32016R0679", "L441-6"]:
        zones = D.zones_protegees(texte)
        debut = texte.index(fragment)
        verifier(any(a <= debut and debut + len(fragment) <= b for a, b in zones), f"zone protégée : {fragment}")


@controle("B3. Villes et mots courants pris pour des personnes ou des sociétés")
def test_villes_et_mots_courants():
    texte = ("Objet : relance par LRAR\n"
             "Subject: Créance impayée\n"
             "\n"
             f"Montant dû : 1 250,50 €. Fait à Lyon. Son IBAN est {IBAN}.\n"
             "Sophie Martin représente Brumeval.")
    propositions = [("Objet", "ORG"), ("LRAR", "ORG"), ("Subject", "ORG"), ("Créance", "ORG"), ("Montant", "PER"),
                    ("Lyon", "PER"), ("Son IBAN", "PER"), ("Sophie Martin", "PER"), ("Brumeval", "ORG")]
    retenus = D.filtrer_candidats_ner(texte, positions(texte, propositions))
    verifier(sorted(texte[s.start:s.end] for s in retenus) == ["Brumeval", "Sophie Martin"],
             "tri des propositions du modèle : seuls le vrai nom et la vraie société sont retenus")
    with modele_simule(propositions):
        r = moteur().anonymiser(texte, "b3", inclure_valeurs=True)
    attendu = texte.replace(IBAN, "[IBAN_1]").replace("Sophie Martin", "[PERSONNE_1]").replace("Brumeval", "[SOCIETE_1]")
    verifier(r["texte"] == attendu, "moteur complet : « Objet », « Subject », « LRAR », « Créance », « Montant », "
                                    "« Lyon » et « Son IBAN » restent en clair")
    verifier(r["nb_remplacements"] == 3, f"trois remplacements exactement (obtenu : {r['nb_remplacements']})")

    for phrase in [f"Son IBAN est {IBAN}.", f"Votre RIB : {IBAN}.", f"Voir PJ. Notre IBAN : {IBAN}."]:
        s = moteur().anonymiser(phrase, "b3b", {"ner": False})["texte"]
        verifier(s == phrase.replace(IBAN, "[IBAN_1]"), f"règles seules : {phrase[:14]}… -> {s}")

    for ville in ["Lyon", "Paris", "Marseille", "Villeurbanne", "Saint-Étienne"]:
        verifier(D.est_ville(ville), f"ville connue : {ville}")
    for mot in ["Créance", "Montant", "LRAR", "Objet", "Subject", "Créances", "IBAN", "l'Objet"]:
        verifier(D.est_mot_banal(mot), f"mot courant ou sigle : {mot}")
    for nom in ["Dupont", "Lefèvre", "Brumeval", "Martin"]:
        verifier(not D.est_mot_banal(nom) and not D.est_ville(nom), f"n'est pas un mot courant : {nom}")

    r2 = moteur().anonymiser("Domicile : 12 rue des Tanneurs, 69007 Lyon. Fait à Lyon.", "b3c", {"ner": False})
    verifier("69007" not in r2["texte"] and "Fait à Lyon" in r2["texte"],
             "la ville reste masquée dans une adresse complète, pas dans « Fait à Lyon »")


@controle("B4. Société coupée en deux (« Agence Martin Bellecour »)")
def test_societe_en_une_seule_entite():
    texte = "La copropriété est représentée par l'Agence Martin Bellecour, syndic en exercice."
    r = moteur().anonymiser(texte, "b4", {"ner": False}, inclure_valeurs=True)
    verifier(r["texte"] == "La copropriété est représentée par l'[SOCIETE_1], syndic en exercice.", f"règles seules : {r['texte']}")
    verifier(valeurs(r) == ["Agence Martin Bellecour"], f"une seule entité, la société entière (obtenu : {valeurs(r)})")
    # Ce que proposait le modèle de langue : « Agence » d'un côté, « Martin Bellecour » de l'autre
    with modele_simule([("Agence", "ORG"), ("Martin Bellecour", "PER")]):
        r2 = moteur().anonymiser(texte, "b4b", inclure_valeurs=True)
    verifier("[PERSONNE_" not in r2["texte"] and r2["texte"].count("[SOCIETE_") == 1,
             f"modèle proposant deux morceaux : un seul marqueur de société ({r2['texte']})")

    t = "Brumeval Martin Bellecour assigne."
    morceaux = [D.Span(0, 8, "SOCIETE", D.P_NER, "ner", "Brumeval"),
                D.Span(9, 25, "PERSONNE", D.P_PRENOM_NOM, "regle", "Martin Bellecour")]
    fusion = D.fusionner_adjacents(morceaux, t)
    verifier(len(fusion) == 1 and fusion[0].type == "SOCIETE" and t[fusion[0].start:fusion[0].end] == "Brumeval Martin Bellecour",
             "fusion d'une société et du nom qui la suit immédiatement")
    t2 = "Brumeval, Martin Bellecour assigne."
    separes = [D.Span(0, 8, "SOCIETE", D.P_NER, "ner", "Brumeval"),
               D.Span(10, 26, "PERSONNE", D.P_PRENOM_NOM, "regle", "Martin Bellecour")]
    verifier(len(D.fusionner_adjacents(separes, t2)) == 2, "pas de fusion quand une virgule sépare les deux")

    for neutre in ["La Banque de France a répondu.", "Rendez-vous à l'Hôtel de Ville.", "L'Agence Nationale a statué.",
                   "Un Groupe de travail est constitué.", "Le Cabinet d'avocats est fermé."]:
        rn = moteur().anonymiser(neutre, "b4c", {"ner": False})
        verifier(rn["nb_remplacements"] == 0, f"pas une dénomination commerciale : {neutre}")
    for texte_soc, nom in [("Le Cabinet Durand & Associés plaide.", "Durand"), ("Selon la Régie Lemoine, le bail court.", "Lemoine"),
                           ("Courrier des Établissements Ferrand Frères.", "Ferrand")]:
        rs = moteur().anonymiser(texte_soc, "b4d", {"ner": False})
        verifier(nom not in rs["texte"] and "[SOCIETE_1]" in rs["texte"], f"dénomination masquée : {texte_soc} -> {rs['texte']}")


@controle("B5. Dossiers déjà ouverts : anciennes erreurs oubliées, vrais noms conservés")
def test_anciennes_erreurs_dans_un_dossier_existant():
    anciennes = [("PERSONNE", "Montant"), ("PERSONNE", "Lyon"), ("PERSONNE", "Son IBAN"), ("PERSONNE", "L."),
                 ("PERSONNE", "Jean DUPONT"), ("SOCIETE", "Créance"), ("SOCIETE", "LRAR"), ("SOCIETE", "Objet")]
    M = moteur_sur_ancienne_base("b5", anciennes)
    colonnes = {r[1] for r in M.store.db.execute("PRAGMA table_info(entrees)")}
    verifier("generation" in colonnes, "base de la version 1.0.1 mise à niveau à l'ouverture")
    texte = ("Objet : relance par LRAR.\nMontant de la Créance dû à Lyon. Son IBAN est inconnu. "
             "Selon l'article L. 441-6, Jean DUPONT doit payer.")
    r = M.anonymiser(texte, "b5", {"ner": False})
    verifier(r["texte"] == texte.replace("Jean DUPONT", "[PERSONNE_5]"),
             f"seul le vrai nom est masqué, avec son marqueur d'origine ({r['texte']!r})")
    avert = " ".join(r["avertissements"])
    verifier(all(m in avert for m in ["[PERSONNE_1]", "[PERSONNE_2]", "[PERSONNE_3]", "[PERSONNE_4]",
                                      "[SOCIETE_1]", "[SOCIETE_2]", "[SOCIETE_3]"]) and "[PERSONNE_5]" not in avert,
             "l'avertissement cite les marqueurs laissés en clair")
    verifier(not any(v in avert for v in ["Montant", "Lyon", "IBAN", "Créance", "LRAR", "Objet", "DUPONT"]),
             "l'avertissement ne contient aucune valeur, seulement des marqueurs")
    retour = M.reidentifier("[PERSONNE_1] réclamé par [SOCIETE_2] à [PERSONNE_5].", "b5")
    verifier(retour["texte"] == "Montant réclamé par LRAR à Jean DUPONT.",
             "un ancien document à marqueurs se ré-identifie toujours")

    # Un vrai nom qui est aussi un mot courant : reconnu par sa civilité, puis suivi dans tout le dossier
    M2 = moteur()
    r1 = M2.anonymiser("M. Bureau a signé le bail.", "b5b", {"ner": False})
    verifier(r1["texte"] == "M. [PERSONNE_1] a signé le bail.", f"« M. Bureau » masqué ({r1['texte']})")
    r2 = M2.anonymiser("Bureau conteste la somme, mais le bureau du syndic est fermé.", "b5b", {"ner": False})
    verifier(r2["texte"] == "[PERSONNE_1] conteste la somme, mais le bureau du syndic est fermé.",
             f"document suivant : le nom reste masqué, le mot courant reste lisible ({r2['texte']})")
    generations = {g for (g,) in M2.store.db.execute("SELECT generation FROM entrees")}
    verifier(generations == {GENERATION}, "les nouvelles entrées portent la génération courante")

    # Même nom enregistré par l'ancienne version : confirmé dès que les règles actuelles le retrouvent
    M3 = moteur_sur_ancienne_base("b5c", [("PERSONNE", "Bureau")])
    M3.anonymiser("M. Bureau a signé le bail.", "b5c", {"ner": False})
    r3 = M3.anonymiser("Bureau conteste la somme.", "b5c", {"ner": False})
    verifier(r3["texte"] == "[PERSONNE_1] conteste la somme.", "ancien nom confirmé par sa civilité : suivi dans le dossier")


@controle("B6. Liste d'exclusion configurable")
def test_liste_exclusion_configurable():
    texte = "La société Brumeval Immobilier écrit à Jean DUPONT au sujet de Zorglub."
    with modele_simule([("Zorglub", "PER")]):
        r0 = moteur().anonymiser(texte, "b6")
        verifier("Brumeval" not in r0["texte"] and "DUPONT" not in r0["texte"] and "Zorglub" not in r0["texte"],
                 "sans exclusion : société, personne et proposition du modèle masquées")
        r1 = moteur().anonymiser(texte, "b6b", {"jamais": ["Brumeval Immobilier"]})
        verifier("Brumeval Immobilier" in r1["texte"] and "DUPONT" not in r1["texte"],
                 "exclusion transmise avec la demande (options.jamais)")
        conf = tempfile.mkdtemp(prefix="conf-", dir=TMP)
        Path(conf, "ne_jamais_masquer.txt").write_text("# commentaire\nBrumeval Immobilier\n", encoding="utf-8")
        Path(conf, "mots_courants.txt").write_text("# mots du cabinet\nzorglub\n", encoding="utf-8")
        Path(conf, "villes.txt").write_text("Trifouillis-les-Oies\n", encoding="utf-8")
        listes = D.Listes.charger(conf)
        r2 = moteur(listes).anonymiser(texte, "b6c")
        verifier("Brumeval Immobilier" in r2["texte"] and "Zorglub" in r2["texte"] and "DUPONT" not in r2["texte"],
                 "fichiers de configuration : ne_jamais_masquer.txt et mots_courants.txt")
    verifier(D.est_ville("Trifouillis-les-Oies", listes.villes) and not D.est_ville("Trifouillis-les-Oies"),
             "fichier de configuration : villes.txt")
    with modele_simule([("Trifouillis-les-Oies", "PER")]):
        r3 = moteur(listes).anonymiser("Fait à Trifouillis-les-Oies.", "b6d")
    verifier(r3["nb_remplacements"] == 0, "une ville ajoutée par la configuration n'est plus prise pour une personne")
    ri = moteur().anonymiser("Le Montant est contesté.", "b6e", {"termes": ["AUTRE: Montant"], "ner": False})
    verifier("[AUTRE_1]" in ri["texte"], "un terme imposé par l'utilisateur l'emporte toujours, même un mot courant")


@controle("B7. Texte sans donnée personnelle : propositions erronées du modèle de langue")
def test_texte_sans_donnees():
    neutre = (ICI / "sans_donnees.txt").read_text(encoding="utf-8")
    propositions = [("Cass", "PER"), ("IV", "PER"), ("Bull", "ORG"), ("CONDAMNE", "ORG"), ("DÉPENS", "ORG"),
                    ("Président Directeur Général", "ORG"), ("Banque de France", "ORG"), ("Règlement", "PER"),
                    ("SA DÉFENDERESSE", "ORG"), ("Union Européenne", "ORG")]
    trouvees = positions(neutre, propositions)
    verifier(len(trouvees) >= 7, f"le texte de référence contient les expressions testées ({len(trouvees)})")
    with modele_simule(propositions):
        r = moteur().anonymiser(neutre, "b7", inclure_valeurs=True)
    verifier(r["nb_remplacements"] == 0, f"aucun remplacement (obtenu : {valeurs(r)})")


@controle("C1. Exemple complet (tests/exemple_lot1.txt)")
def test_exemple_complet():
    from tests.reproduire_lot1 import A_CONSERVER, A_MASQUER
    texte = (ICI / "exemple_lot1.txt").read_text(encoding="utf-8")
    r = moteur().anonymiser(texte, "c1", inclure_valeurs=True)
    for libelle, fragment in A_MASQUER:
        verifier(fragment not in r["texte"], f"masqué : {libelle}")
    for libelle, fragment in A_CONSERVER:
        verifier(fragment in r["texte"], f"conservé : {libelle}")
    verifier("Agence Martin Bellecour" in valeurs(r, "SOCIETE") and not valeurs(r, "PERSONNE") == ["Martin Bellecour"],
             "« Agence Martin Bellecour » : une seule société")
    retour = moteur_retour(r, texte)
    verifier(retour, "aller-retour : le texte ré-identifié est identique à l'original (au retour à la ligne du RCS près)")


def moteur_retour(resultat, original):
    """Ré-identifie le texte produit avec la table renvoyée et le compare à l'original."""
    texte = resultat["texte"]
    for e in sorted(resultat["entites"], key=lambda e: -len(e["marqueur"])):
        texte = texte.replace(e["marqueur"], e["valeur"])
    aplati = lambda t: re.sub(r"\s+", " ", t)  # noqa: E731
    return aplati(texte) == aplati(original)


@controle("C2. Serveur : version, option « jamais », copie de sécurité")
def test_serveur():
    os.environ.update(ANON_SECRET_KEY=Fernet.generate_key().decode(), ANON_API_KEY="cle-de-test",
                      ANON_DB=base(), ANON_CONFIG_DIR=CONF, ANON_LOG_LEVEL="WARNING")
    from app import main
    verifier(tuple(int(x) for x in main.VERSION.split(".")) >= (1, 1, 0), f"version du serveur : {main.VERSION}")
    options = main._options({"jamais": ["Brumeval", " "], "termes": "AUTRE: Chrysalide\n\nSOCIETE: Alpha"})
    verifier(options["jamais"] == ["Brumeval"] and options["termes"] == ["AUTRE: Chrysalide", "SOCIETE: Alpha"],
             "options « jamais » et « termes » lues depuis la demande")

    # Copie de sécurité faite par install.sh : gardée pendant la durée de conservation, supprimée ensuite
    Path(main.SAUVEGARDE).write_bytes(b"copie")
    main._nettoyer_sauvegarde()
    verifier(os.path.exists(main.SAUVEGARDE), "copie de sécurité récente : conservée")
    ancien = time.time() - (main.RETENTION + 1) * 86400
    os.utime(main.SAUVEGARDE, (ancien, ancien))
    main._nettoyer_sauvegarde()
    verifier(not os.path.exists(main.SAUVEGARDE), "copie de sécurité plus ancienne que la durée de conservation : supprimée")

    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from starlette.testclient import TestClient
    except Exception as exc:  # httpx absent : cette partie n'est pas lancée, ce n'est pas un échec
        print(f"  --   appels HTTP non lancés (module httpx absent : {type(exc).__name__})")
        return
    with TestClient(main.app) as client:
        sante = client.get("/api/sante").json()
        verifier(sante["version"] == main.VERSION, f"version annoncée : {sante['version']}")
        refus = client.post("/api/anonymiser", json={"texte": "x"})
        verifier(refus.status_code == 401, "sans clé d'API : refus")
        rep = client.post("/api/anonymiser", headers={"X-API-Key": "cle-de-test"}, json={
            "texte": "La société Brumeval Immobilier écrit à Jean DUPONT.", "dossier": "http",
            "options": {"jamais": ["Brumeval Immobilier"], "ner": False}}).json()
        verifier("Brumeval Immobilier" in rep["texte"] and "DUPONT" not in rep["texte"],
                 f"option « jamais » transmise par l'API ({rep['texte']})")


def lancer() -> list[str]:
    """Lance tous les contrôles ; renvoie la liste des échecs."""
    ECHECS.clear()
    for c in CONTROLES:
        c()
    return list(ECHECS)


def main():
    print("spaCy :", D.etat_spacy())
    echecs = lancer()
    print("\nRésultat :", "TOUT EST OK" if not echecs else f"{len(echecs)} échec(s)")
    for e in echecs:
        print("  -", e)
    return 1 if echecs else 0


if __name__ == "__main__":
    sys.exit(main())
