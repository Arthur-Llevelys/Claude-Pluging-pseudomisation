# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
# Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
"""
Détection des données identifiantes dans un texte français.

Trois couches complémentaires :
  1. Règles (expressions régulières + contrôles de validité) : SIRET, SIREN,
     TVA intracommunautaire, IBAN, NIR, e-mails, téléphones, dates de
     naissance, adresses, personnes précédées d'une civilité, sociétés
     accompagnées d'une forme juridique.
  2. Reconnaissance d'entités nommées spaCy (modèle français), pour les noms
     de personnes et d'organisations sans indice formel. Optionnelle : si
     spaCy n'est pas installé, seules les règles s'appliquent.
  3. Termes imposés (liste permanente, termes saisis pour un dossier, valeurs
     déjà connues du dossier) et propagation des noms de famille.

Chaque détection est un `Span` (début, fin, type, priorité). Les
chevauchements sont arbitrés par priorité puis par longueur.

Version 1.1.0 — garde-fous ajoutés après relecture d'un dossier réel :
  - zones protégées : un montant ou une référence juridique (article L. 441-6,
    numéro de pourvoi, CELEX…) n'est jamais inclus dans une entité ;
  - numéros RCS / SIREN reconnus même coupés par un retour à la ligne ;
  - adresses « Grande rue », numéros doubles (16/18 rue…) ;
  - noms isolés dans un tableau (« S09 Dupont ») ;
  - dénominations (« Agence Martin Bellecour ») prises en une seule société ;
  - mots courants, sigles et villes jamais pris pour une personne ou une
    société (« Son IBAN », « Montant », « LRAR », « Lyon »).
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path

log = logging.getLogger("anonymiseur.detect")

# --------------------------------------------------------------------------
# Types d'entités
# --------------------------------------------------------------------------
TYPES = [
    "PERSONNE", "SOCIETE", "ADRESSE", "DATE_NAISSANCE", "LIEU_NAISSANCE",
    "SIRET", "SIREN", "TVA", "EMAIL", "TELEPHONE", "IBAN", "NIR", "DATE", "AUTRE",
]
TYPES_PAR_DEFAUT = [t for t in TYPES if t != "DATE"]  # toutes les dates : option

# Priorités (la plus haute l'emporte en cas de chevauchement)
P_IMPOSE = 100
P_CONNU = 90
P_IDENTIFIANT = 80
P_DATE_NAISSANCE = 75
P_ADRESSE = 70
P_LIEU_NAISSANCE = 65
P_CIVILITE = 60
P_SOCIETE = 55
P_PRENOM_NOM = 50
P_PROPAGATION = 45
P_NER = 40
P_DATE = 30


@dataclass
class Span:
    start: int
    end: int
    type: str
    priority: int
    source: str
    value: str = ""
    canonical: str | None = None  # valeur de référence (propagation)

    @property
    def length(self) -> int:
        return self.end - self.start


# --------------------------------------------------------------------------
# Utilitaires
# --------------------------------------------------------------------------
UP = "A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ"
LOW = "a-zàâäçéèêëîïôöùûüÿæœß"


def sans_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normaliser(valeur: str, type_: str | None = None) -> str:
    """Forme canonique utilisée pour reconnaître une même valeur."""
    v = sans_accents(valeur).casefold()
    if type_ in {"SIRET", "SIREN", "TVA", "IBAN", "NIR", "TELEPHONE", "RCS"}:
        v = re.sub(r"[^0-9a-z]", "", v)
        if type_ == "TELEPHONE" and v.startswith("0033"):
            v = "0" + v[4:]
        if type_ == "TELEPHONE" and v.startswith("33") and len(v) == 11:
            v = "0" + v[2:]
        return v
    v = re.sub(r"[’`´]", "'", v)
    v = re.sub(r"\s+", " ", v)
    return v.strip(" .,;:«»\"'()[]")


def luhn_ok(chiffres: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(chiffres)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def siret_ok(d: str) -> bool:
    if len(d) != 14:
        return False
    if d.startswith("356000000"):  # La Poste : règle spécifique
        return sum(int(c) for c in d) % 5 == 0
    return luhn_ok(d)


def iban_ok(iban: str) -> bool:
    s = re.sub(r"\s", "", iban).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", s):
        return False
    s = s[4:] + s[:4]
    num = "".join(str(int(c, 36)) for c in s)
    return int(num) % 97 == 1


def nir_ok(nir: str) -> bool:
    s = re.sub(r"\s", "", nir).upper()
    if len(s) == 13:
        return True  # sans clé : on masque par prudence
    if len(s) != 15:
        return False
    corps, cle = s[:13], s[13:]
    corps = corps.replace("2A", "19").replace("2B", "18")
    try:
        return 97 - (int(corps) % 97) == int(cle)
    except ValueError:
        return False


def ligne_en_majuscules(texte: str, pos: int) -> bool:
    """Vrai si la ligne contenant `pos` est un titre en capitales."""
    debut = texte.rfind("\n", 0, pos) + 1
    fin = texte.find("\n", pos)
    ligne = texte[debut: fin if fin != -1 else len(texte)]
    lettres = [c for c in ligne if c.isalpha()]
    if len(lettres) < 12:
        return False
    return sum(c.isupper() for c in lettres) / len(lettres) > 0.8


def contexte_avant(texte: str, pos: int, n: int = 45) -> str:
    return sans_accents(texte[max(0, pos - n): pos]).casefold()


# --------------------------------------------------------------------------
# Listes de mots
# --------------------------------------------------------------------------
FORMES = ("SASU|SAS|SARL|EURL|SA|SNC|SCI|SCP|SCM|SCS|SCA|SELARL|SELAS|SELASU|SELAFA|"
          "SELCA|SPFPL|SCEA|EARL|GAEC|GIE|SCOP|SEM|SPL|EIRL|SEL")
FORMES_SET = set(FORMES.split("|"))

CIVILITES = (r"(?:M\.|MM\.|Mme|Mmes|Mlle|Mlles|Monsieur|Messieurs|Madame|Mesdames|"
             r"Mademoiselle|Me|Maître|Maitre|Dr|Docteur|Pr|Professeur)")

# Mots capitalisés qui ne sont pas des noms de personne / société
MOTS_VIDES = {
    "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "et", "ou", "entre", "par", "pour",
    "avec", "contre", "chez", "dont", "mais", "ce", "cette", "ces", "cet", "en", "a", "au", "aux",
    "selon", "suivant", "attendu", "considerant", "vu", "sur", "sous", "dans", "objet", "fait",
    "monsieur", "madame", "mademoiselle", "maitre", "me", "societe", "ladite", "ledit", "lesdites",
    "lesdits", "article", "articles", "alinea", "tribunal", "cour", "conseil", "chambre", "code",
    "loi", "decret", "arrete", "ordonnance", "jugement", "arret", "dossier", "reference", "ref",
    "affaire", "president", "presidente", "juge", "procureur", "batonnier", "greffier", "greffe",
    "directeur", "directrice", "gerant", "gerante", "ministre", "maire", "prefet", "conseiller",
    "conseillere", "avocat", "avocate", "huissier", "commissaire", "notaire", "expert", "demandeur",
    "demanderesse", "defendeur", "defenderesse", "appelant", "appelante", "intime", "intimee",
    "partie", "parties", "client", "cliente", "bailleur", "preneur", "vendeur", "acquereur",
    "cedant", "cessionnaire", "employeur", "salarie", "salariee", "janvier", "fevrier", "mars",
    "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "france", "paris",
    "republique", "etat", "cedex", "rcs", "tva", "siret", "siren", "ttc", "ht", "eur", "euros",
    "rgpd", "cnil", "urssaf", "annexe", "page", "total", "madame", "messieurs", "cher", "chere",
    "bonjour", "cordialement", "objet", "pj", "nb", "ps", "tel", "fax", "mail", "email",
    "courriel", "adresse", "siege", "social", "capital", "premier", "premiere", "titre",
    "chapitre", "section", "preambule", "definitions", "conditions", "generales", "particulieres",
    "responsable", "service", "chef", "assistant", "assistante", "comptable", "juriste", "associe",
    "associee", "rh", "dg", "pdg", "daf", "drh", "dsi", "ceo", "cfo", "cto", "equipe", "pole",
    "departement", "region", "ville", "commune", "madame", "note", "memo", "courrier", "lettre",
    "mise", "demeure", "requete", "assignation", "conclusions", "sommation", "facture", "devis",
}

MOTS_INSTITUTIONS = {
    "tribunal", "cour", "conseil", "chambre", "parquet", "ministere", "republique", "barreau",
    "ordre", "greffe", "prefecture", "mairie", "urssaf", "cpam", "caf", "dgfip", "impots",
    "tresor", "code", "loi", "decret", "cnil", "inpi", "insee", "assemblee", "senat",
    "gouvernement", "etat", "union", "europeenne", "cjue", "cedh", "juridiction", "cassation",
    "commission", "autorite", "agence", "direction", "bulletin", "journal", "officiel", "rcs",
    "registre", "bodacc", "legifrance", "prud'hommes", "prudhommes", "prud'homal", "commerce",
    "judiciaire", "administratif", "administrative", "constitutionnel", "police", "gendarmerie",
    "douane", "douanes", "banque de france", "caisse", "sécurité", "securite", "sociale",
    "pole", "emploi", "travail", "article", "articles", "tva", "ue", "onu", "ocde",
}

TITRES = {
    "le", "la", "president", "presidente", "juge", "procureur", "batonnier", "greffier",
    "directeur", "directrice", "conseiller", "conseillere", "ministre", "maire", "prefet",
    "rapporteur", "commissaire", "avocat", "general", "generale", "premier", "premiere",
    "substitut", "doyen", "professeur", "docteur", "gerant", "gerante",
}

# --------------------------------------------------------------------------
# Listes livrées avec l'application (app/data/*.txt), extensibles par la configuration
# --------------------------------------------------------------------------
DOSSIER_DONNEES = Path(__file__).parent / "data"


def cle_mot(s: str) -> str:
    """Forme de comparaison d'un mot ou d'un nom de lieu : sans accents, sans casse, tirets = espaces."""
    v = sans_accents(s).casefold().replace("’", "'")
    v = re.sub(r"[\-‐‑]+", " ", v)
    return re.sub(r"\s+", " ", v).strip(" .,;:«»\"'()[]")


def lire_liste(chemin, par_ligne: bool = False) -> set[str]:
    """Lit une liste de mots (séparés par des espaces) ou d'expressions (une par ligne)."""
    out: set[str] = set()
    try:
        with open(chemin, encoding="utf-8") as f:
            for ligne in f:
                ligne = ligne.split("#", 1)[0].strip()
                if not ligne:
                    continue
                for element in ([ligne] if par_ligne else ligne.split()):
                    cle = cle_mot(element)
                    if cle:
                        out.add(cle)
    except OSError:
        pass
    return out


# Mots courants (« Montant », « Créance », « Objet »…), sigles (« IBAN », « LRAR »…), villes
MOTS_COURANTS = lire_liste(DOSSIER_DONNEES / "mots_courants.txt")
SIGLES = lire_liste(DOSSIER_DONNEES / "sigles.txt")
VILLES = lire_liste(DOSSIER_DONNEES / "villes.txt", par_ligne=True)
# Institutions et textes désignés par plusieurs mots (« Banque de France », « Code de commerce »)
INSTITUTIONS = lire_liste(DOSSIER_DONNEES / "institutions.txt", par_ligne=True)
RE_CHIFFRE_ROMAIN = re.compile(r"[IVXLCDM]{1,7}")

# Mots qui introduisent un groupe nominal et ne commencent jamais un nom propre
DETERMINANTS = {
    "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "au", "aux", "ce", "cet", "cette",
    "ces", "son", "sa", "ses", "leur", "leurs", "notre", "votre", "nos", "vos", "mon", "ma", "mes",
    "ton", "ta", "tes", "quel", "quelle", "quels", "quelles", "chaque", "tout", "toute", "tous",
    "toutes", "aucun", "aucune", "selon", "voir", "cf", "par", "pour", "sur", "sous", "avec",
    "sans", "chez", "dans", "en", "a", "et", "ou",
}

# Mots qui ouvrent une dénomination commerciale : le nom qui suit appartient à la société
DENOMINATIONS = (
    "Agence|Cabinet|R[ée]gie|Groupe|[ÉE]tablissements|Ets|Garage|Pharmacie|Boulangerie|P[âa]tisserie|"
    "Boucherie|Restaurant|Brasserie|H[ôo]tel|Clinique|Laboratoires?|[ÉE]tude|Office|Ateliers?|Maison|"
    "Entreprise|Transports|Imprimerie|Librairie|Institut|Studio|Domaine|Ch[âa]teau|Banque|Assurances|"
    "Mutuelle|Auto-[ÉEé]cole|Carrosserie|Menuiserie|Plomberie|Holding|Fondation|Comptoir|Galerie|"
    "R[ée]sidence|Camping|Optique|Compagnie|Cie|St[ée]|Immobili[èe]re|Fonci[èe]re|Syndic"
)


def est_mot_banal(mot: str, courants: set[str] | None = None) -> bool:
    """Vrai si le mot ne peut pas, à lui seul, être un nom propre de personne ou de société."""
    cle = cle_mot(re.sub(r"^[dlDL]['’]", "", mot))

    def connu(c: str) -> bool:
        return (c in MOTS_VIDES or c in MOTS_COURANTS or c in SIGLES or c in DETERMINANTS
                or c in MOTS_INSTITUTIONS or (courants is not None and c in courants))

    if not cle or connu(cle):
        return True
    # pluriels simples : « Avocats », « Créances », « Locaux »
    return len(cle) > 3 and cle[-1] in "sx" and connu(cle[:-1])


def est_ville(valeur: str, villes: set[str] | None = None) -> bool:
    cle = cle_mot(valeur)
    return cle in VILLES or (villes is not None and cle in villes)


PARTICULES = r"(?:de|du|des|d'|d’|le|la|van|von|der|den|di|da|del|dos|ben|bin|el|al)"
MOIS = (r"(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|"
        r"novembre|d[ée]cembre|janv\.?|f[ée]vr?\.?|avr\.?|juil\.?|sept\.?|oct\.?|nov\.?|d[ée]c\.?)")

# --------------------------------------------------------------------------
# Expressions régulières
# --------------------------------------------------------------------------
SEP = r"[ \u00a0\u202f.\-]?"

RE_EMAIL = re.compile(r"\b[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)*\.[a-zA-Z]{2,}\b")
RE_TEL = re.compile(r"(?<![\d\w])(?:(?:\+|00)33[ \u00a0.\-]?(?:\(0\)[ \u00a0]?)?|0)[1-9](?:[ \u00a0.\-]?\d{2}){4}(?!\d)")
RE_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Z0-9]{4}){2,7}(?:[ \u00a0]?[A-Z0-9]{1,4})?\b")
RE_NIR = re.compile(r"(?<!\d)[12][ \u00a0]?\d{2}[ \u00a0]?(?:0[1-9]|1[0-2]|[2-9]\d)[ \u00a0]?(?:\d{2}|2[ABab])"
                    r"[ \u00a0]?\d{3}[ \u00a0]?\d{3}(?:[ \u00a0]?\d{2})?(?!\d)")
RE_TVA = re.compile(r"\bFR[ \u00a0]?[0-9A-Z]{2}[ \u00a0]?\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{3}\b")
RE_SIRET = re.compile(rf"(?<![\d])\d{{3}}{SEP}\d{{3}}{SEP}\d{{3}}{SEP}\d{{5}}(?![\d])")
RE_SIREN = re.compile(rf"(?<![\d])\d{{3}}{SEP}\d{{3}}{SEP}\d{{3}}(?![\d])")
# Séparateur de chiffres pouvant contenir un retour à la ligne (numéro coupé en fin de ligne)
SEPL = r"(?:[ \u00a0\u202f.\-]?(?:\r?\n[ \t\u00a0]*)?)"
# Numéro d'immatriculation annoncé par son contexte, même réparti sur deux lignes :
# « RCS Lyon B 352 332 159 », « immatriculée au RCS de Lyon sous le n° 352 332 / 159 », « SIRET : … »
RE_RCS = re.compile(
    rf"(?i:\bR\.?[ \u00a0]?C\.?[ \u00a0]?S\.?(?![\w])|\bregistre du commerce(?: et des soci[ée]t[ée]s)?\b|\bsiren\b|\bsiret\b)"
    rf"(?P<entre>[^\d\n]{{0,70}}(?:\r?\n[^\d\n]{{0,40}})?)"
    rf"(?P<num>\d{{3}}{SEPL}\d{{3}}{SEPL}\d{{3}}(?:{SEPL}\d{{5}})?)(?!\d)")

DATE_PAT = (rf"(?:\d{{1,2}}[/.\-]\d{{1,2}}[/.\-](?:\d{{4}}|\d{{2}})"
            rf"|(?:1er|\d{{1,2}})[ \u00a0]+{MOIS}[ \u00a0]+\d{{4}}"
            rf"|\d{{4}}-\d{{2}}-\d{{2}})")
RE_DATE = re.compile(rf"(?i)(?<![\d/])(?:{DATE_PAT})(?![\d/])")
RE_DATE_NAISSANCE = re.compile(
    rf"(?i)(?:\bn[ée]e?s?\b(?:\s?\(e\))?|\bnaissance\b|\bdate de naiss\.?|\bd\.?o\.?b\.?\b|\bborn\b)"
    rf"[^\n\d]{{0,35}}?(?P<d>{DATE_PAT})")
VILLE_PAT = (rf"[{UP}][\w\-'’]+(?:[ \-](?:sur|sous|en|l[eè]s|les|le|la|de|du|des|aux|[{UP}][\w\-'’]+)"
             rf"(?=[ \-][{UP}]|\b)){{0,3}}(?:[ \-][{UP}][\w\-'’]+)?")
RE_LIEU_NAISSANCE = re.compile(
    rf"(?i:\bn[ée]e?s?\b(?:\s?\(e\))?)[^\n]{{0,45}}?\b(?:[àa])[ \u00a0]+(?P<lieu>{VILLE_PAT})"
    rf"(?:[ \u00a0]*\((?P<dep>\d{{2,3}}|2[AB])\))?")

TYPES_VOIE = (r"(?:rue|avenue|av\.|bd|boulevard|place|pl\.|chemin|ch\.|all[ée]e|impasse|imp\.|quai|cours|"
              r"route|rte|square|sq\.|passage|voie|rond-point|lieu-dit|lieudit|hameau|mont[ée]e|"
              r"faubourg|fg|cit[ée]|r[ée]sidence|parvis|esplanade|promenade|sentier|chauss[ée]e|"
              r"traverse|villa|domaine|lotissement|zone|za|zi|zac|parc|port|mail)")
MOT_VOIE = rf"(?:(?:[lLdD]['’])?[{UP}0-9][{UP}{LOW}0-9'’\-\.]*|de|du|des|la|le|les|aux|au|sur|sous|en)(?![\w'’])"
# Num\u00e9ro de voie, y compris double : \u00ab 16/18 \u00bb, \u00ab 16-18 \u00bb, \u00ab 16 et 18 \u00bb, \u00ab 16 \u00e0 18 \u00bb
NUM_VOIE = (r"\d{1,4}(?:[ \u00a0]?(?:bis|ter|quater|[a-d])\b)?"
            r"(?:[ \u00a0]?(?:/|-|\u2013|et|\u00e0|au)[ \u00a0]?\d{1,4}(?:[ \u00a0]?(?:bis|ter|quater|[a-d])\b)?)?")
# Qualificatif plac\u00e9 devant le type de voie : \u00ab Grande rue \u00bb, \u00ab Grand'Rue \u00bb, \u00ab Vieux chemin \u00bb
QUALIF_VOIE = (r"(?:(?:grande?|grand['\u2019]|petite?|vieille|vieux|vieil|nouvelle|nouveau|haute?|basse?|ancienne?)"
               r"[ \u00a0\-]?)?")
RE_ADRESSE = re.compile(
    rf"(?i:(?<![\w/])(?P<num>{NUM_VOIE})[,]?[ \u00a0]+{QUALIF_VOIE}{TYPES_VOIE}\.?)"
    rf"(?:[ \u00a0]+{MOT_VOIE}){{1,7}}"
    rf"(?:[ \u00a0]*,?[ \u00a0]*(?:(?:BP|CS|TSA)[ \u00a0]*\d{{2,6}}[ \u00a0]*,?[ \u00a0]*)?\d{{5}}[ \u00a0]+{VILLE_PAT}"
    rf"(?:[ \u00a0]+(?i:cedex)(?:[ \u00a0]*\d{{1,2}})?)?)?")
RE_CP_VILLE = re.compile(rf"(?<![\d\-/.])\d{{5}}[ \u00a0]+(?P<ville>[{UP}][{UP}{LOW}\-'’]+(?:[ \-][{UP}][{UP}{LOW}\-'’]+){{0,3}})"
                         rf"(?:[ \u00a0]+(?i:cedex)(?:[ \u00a0]*\d{{1,2}})?)?")
RE_BOITE = re.compile(r"\b(?:BP|B\.P\.|CS|TSA)[ \u00a0]*\d{2,6}\b")

NOM_MOT = rf"[{UP}][{UP}{LOW}'’\-]*[{UP}{LOW}]"
RE_CIVILITE = re.compile(
    rf"(?<![\w]){CIVILITES}[ \u00a0]+(?P<nom>(?:{NOM_MOT}|[{UP}]\.)(?:[ \u00a0]+(?:{PARTICULES}[ \u00a0]*)?(?:{NOM_MOT})){{0,3}})")
PRENOM = rf"[{UP}][{LOW}]+(?:-[{UP}][{LOW}]+)?"
NOM_CAPS = rf"[{UP}]{{2,}}(?:[\-'’ ][{UP}]{{2,}})*"
RE_PRENOM_NOM = re.compile(rf"(?<![\w])(?P<nom>{PRENOM}(?:[ \u00a0]+{PRENOM})?[ \u00a0]+(?:{PARTICULES}[ \u00a0]+)?{NOM_CAPS})(?![\w])")
RE_NOM_PRENOM = re.compile(rf"(?<![\w])(?P<nom>{NOM_CAPS}[ \u00a0]+{PRENOM}(?:[ \u00a0]+{PRENOM})?)(?![\w])")

MOT_SOC = r"[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ0-9&][\w&'’\.\-]*"
LIAISON_SOC = r"(?:&|et|de|du|des|d'|d’|la|le|les|and|of|the)"
NOM_SOC = rf"{MOT_SOC}(?:[ \u00a0]+(?:{MOT_SOC}|{LIAISON_SOC})){{0,5}}"
RE_SOC_FORME_AVANT = re.compile(rf"(?<![\w])(?:{FORMES})\b\.?[ \u00a0]+(?P<nom>{NOM_SOC})")
RE_SOC_FORME_APRES = re.compile(rf"(?<![\w])(?P<nom>{MOT_SOC}(?:[ \u00a0]+(?:{MOT_SOC}|&)){{0,4}})[ \u00a0]*,?[ \u00a0]*\(?(?:{FORMES})\)?(?![\w])")
RE_SOC_SOCIETE = re.compile(
    rf"\b[Ss]oci[ée]t[ée][ \u00a0]+(?:(?:d[ée]nomm[ée]e|anonyme|civile(?:[ \u00a0]+immobili[èe]re)?|"
    rf"par actions simplifi[ée]e(?:[ \u00a0]+unipersonnelle)?|[àa] responsabilit[ée] limit[ée]e|"
    rf"en nom collectif|d'exercice lib[ée]ral[\w ]*?)[ \u00a0]+)?(?P<nom>{NOM_SOC})")
RE_SOC_GUILLEMETS = re.compile(
    r"(?i:soci[ée]t[ée]|d[ée]nomm[ée]e?|d[ée]nomination(?: sociale)?|enseigne|nom commercial|marque|groupe)"
    r"[^«\"“\n]{0,30}?[«\"“][ \u00a0]*(?P<nom>[^»\"”\n]{2,60}?)[ \u00a0]*[»\"”]")

RE_MARQUEUR = re.compile(r"\[[A-Z_]+_\d+\]")

# Dénomination commerciale : « Agence Martin Bellecour », « Cabinet Durand & Associés », « Régie du Parc »
RE_SOC_DENOMINATION = re.compile(
    rf"(?<![\w])(?P<nom>(?:{DENOMINATIONS})"
    rf"(?:[ \u00a0]+(?:(?:&|et|de|du|des|d'|d’|la|le|les)[ \u00a0]*)?[{UP}][\w&'’\.\-]*){{1,4}})")

# Ligne de tableau : un repère (lot, appartement, code) suivi d'un nom seul — « S09 Dupont », « Lot 12 Martin »
RE_LIGNE_TABLEAU = re.compile(
    rf"(?m)(?:^|[\t|;])[ \u00a0]*(?P<code>[A-Z]{{1,3}}[ \u00a0]?\d{{1,4}}[A-Z]?"
    rf"|(?i:lot|lots|appt?\.?|appartement|porte|local|n°|no)[ \u00a0]*\d{{1,4}}[A-Z]?)"
    rf"[ \u00a0\t]+(?:[|;][ ]*)?(?P<nom>(?:{PARTICULES}[ \u00a0]+)?{NOM_MOT}(?:[ \u00a0\-]+(?:{PARTICULES}[ \u00a0]+)?{NOM_MOT}){{0,2}})"
    rf"[ \u00a0]*(?=$|[\r\t|;]|[ \u00a0]{{2,}}|\d)")

# --------------------------------------------------------------------------
# Zones protégées : jamais incluses dans une entité
# --------------------------------------------------------------------------
_NOMBRE = r"(?:\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d+)"
RE_MONTANT = re.compile(
    rf"(?<![\w,.]){_NOMBRE}(?:[,.]\d{{1,2}})?[ \u00a0\u202f]?(?:€|euros?\b|EUR\b|[kKM]€|francs?\b)(?:[ \u00a0](?:HT|TTC)\b)?"
    rf"|(?<![\w,.]){_NOMBRE},\d{{2}}(?![\d\w])"            # 92,00 : décimal à deux chiffres, sans devise
    rf"|(?:€|EUR)[ \u00a0]?\d[\d \u00a0\u202f.]*(?:,\d{{1,2}})?",
    re.IGNORECASE)

RE_REF_JURIDIQUE = re.compile(
    # « article L. 441-6 », « articles 1240 et 1241 », « art. R. 123-4 »
    r"(?i:\b(?:articles?|art\.))[ \u00a0]+(?:[LRDA]\.?[ \u00a0]?)?\*?\d+(?:[-–.]\d+)*"
    r"(?:(?:[ \u00a0]+(?:et|à)[ \u00a0]+|,[ \u00a0]*)(?:[LRDA]\.?[ \u00a0]?)?\d+(?:[-–.]\d+)*)*"
    r"|\b[LRDA]\.[ \u00a0]?\d{1,4}(?:[-–]\d+){0,4}\b"        # L. 441-6 seul
    r"|\b[LRD]\d{3,4}(?:-\d+){1,4}\b"                         # L441-6
    r"|(?i:\bn[°o])[ \u00a0]?\d{2}-\d{2}[.\u00a0 ]?\d{3}\b"   # pourvoi n° 19-12.345
    r"|\b\d{2}-\d{2}\.\d{3}\b"                                 # 19-12.345
    r"|\bECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9.]+"
    r"|\b[1-9E]\d{4}[A-Z]{1,2}\d{4}\b"                         # CELEX 32016R0679
    r"|(?i:\b(?:RG|R\.G\.))[ \u00a0]?(?:n[°o][ \u00a0]?)?\d{2}/\d{4,5}\b"
    r"|(?i:\b(?:loi|d[ée]cret|ordonnance|directive|r[èe]glement|arr[êe]t[ée]|circulaire))[ \u00a0]+"
    r"(?:\((?:UE|CE|CEE)\)[ \u00a0]+)?n[°o][ \u00a0]?\d{2,4}[-/]\d{1,5}\b"
    r"|\((?:UE|CE|CEE)\)[ \u00a0]+(?:n[°o][ \u00a0]?)?\d{2,4}/\d{1,5}\b")

# Types jamais rognés par une zone protégée (leur forme est contrôlée par ailleurs)
TYPES_IDENTIFIANTS = {"SIRET", "SIREN", "TVA", "EMAIL", "TELEPHONE", "IBAN", "NIR", "DATE", "DATE_NAISSANCE"}
BORDURE = " \u00a0\u202f\t–—-:;,|()"


def zones_protegees(texte: str) -> list[tuple[int, int]]:
    """Montants et références juridiques : aucune entité ne doit les contenir."""
    zones = [(m.start(), m.end()) for m in RE_MONTANT.finditer(texte)]
    zones += [(m.start(), m.end()) for m in RE_REF_JURIDIQUE.finditer(texte)]
    zones.sort()
    return zones


def appliquer_zones(spans: list["Span"], zones: list[tuple[int, int]], texte: str) -> list["Span"]:
    """Rogne ou écarte les entités qui empiètent sur une zone protégée.

    « 12 rue des Tanneurs 92 » devant « ,00 € » redevient « 12 rue des Tanneurs » ; une
    initiale propagée sur « L. 441-6 » est écartée. Les termes imposés par l'utilisateur et
    les identifiants à forme contrôlée ne sont pas touchés.
    """
    if not zones:
        return spans
    out = []
    for s in spans:
        if s.source == "impose" or s.type in TYPES_IDENTIFIANTS:
            out.append(s)
            continue
        debut, fin = s.start, s.end
        for a, b in zones:
            if b <= debut or a >= fin:
                continue
            if a <= debut and b >= fin:      # entité entièrement dans la zone
                fin = debut
                break
            if a > debut:                    # la zone commence dans l'entité : on coupe avant
                fin = min(fin, a)
            else:                            # la zone couvre le début : on reprend après
                debut = max(debut, b)
        if (debut, fin) != (s.start, s.end):
            while fin > debut and texte[fin - 1] in BORDURE:
                fin -= 1
            while debut < fin and texte[debut] in BORDURE:
                debut += 1
            if fin - debut < 2:
                continue
            s = replace(s, start=debut, end=fin)
        out.append(s)
    return out


def fusionner_adjacents(retenus: list["Span"], texte: str) -> list["Span"]:
    """Une société immédiatement suivie d'un nom (un seul espace, même ligne) forme une seule société.

    Évite « [SOCIETE_2] [PERSONNE_1] » pour « Agence Martin Bellecour » lorsque le modèle de
    langue a proposé deux morceaux.
    """
    out: list[Span] = []
    for s in retenus:
        if out:
            p = out[-1]
            entre = texte[p.end:s.start]
            if (p.type == "SOCIETE" and s.type in {"PERSONNE", "SOCIETE"} and entre in {" ", "\u00a0"}
                    and "ner" in {p.source, s.source} and "impose" not in {p.source, s.source}):
                out[-1] = replace(p, end=s.end, value=texte[p.start:s.end],
                                  priority=max(p.priority, s.priority), source="fusion")
                continue
        out.append(s)
    return out


# --------------------------------------------------------------------------
# Listes personnalisées
# --------------------------------------------------------------------------
@dataclass
class Listes:
    jamais: set[str] = field(default_factory=set)        # valeurs normalisées
    toujours: list[tuple[str, str]] = field(default_factory=list)  # (type, valeur)
    courants: set[str] = field(default_factory=set)      # mots courants ajoutés par la configuration
    villes: set[str] = field(default_factory=set)        # villes ajoutées par la configuration

    @classmethod
    def charger(cls, dossier_conf: str) -> "Listes":
        l = cls()
        # Compléments facultatifs aux listes livrées (app/data) : mots courants et villes
        l.courants = lire_liste(os.path.join(dossier_conf, "mots_courants.txt"))
        l.villes = lire_liste(os.path.join(dossier_conf, "villes.txt"), par_ligne=True)
        p = os.path.join(dossier_conf, "ne_jamais_masquer.txt")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                for ligne in f:
                    ligne = ligne.strip()
                    if ligne and not ligne.startswith("#"):
                        l.jamais.add(normaliser(ligne))
        p = os.path.join(dossier_conf, "toujours_masquer.txt")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                for ligne in f:
                    ligne = ligne.strip()
                    if ligne and not ligne.startswith("#"):
                        l.toujours.append(analyser_terme(ligne))
        return l


def analyser_terme(ligne: str) -> tuple[str, str]:
    """« SOCIETE: Alpha Conseil » -> ("SOCIETE", "Alpha Conseil") ; sinon type AUTRE."""
    m = re.match(r"^\s*([A-Z_]+)\s*[:;]\s*(.+)$", ligne)
    if m and m.group(1) in TYPES:
        return m.group(1), m.group(2).strip()
    return "AUTRE", ligne.strip()


# --------------------------------------------------------------------------
# spaCy (optionnel)
# --------------------------------------------------------------------------
_nlp = None
_nlp_etat = {"charge": False, "modele": None, "erreur": None}


def charger_spacy():
    global _nlp
    if _nlp_etat["charge"]:
        return _nlp
    _nlp_etat["charge"] = True
    modele = os.environ.get("ANON_SPACY_MODEL", "fr_core_news_lg")
    if modele.lower() in {"", "aucun", "none", "off"}:
        _nlp_etat["erreur"] = "désactivé"
        return None
    try:
        import spacy  # noqa: WPS433
        _nlp = spacy.load(modele, disable=["parser", "lemmatizer"])
        _nlp.max_length = 2_000_000
        _nlp_etat["modele"] = modele
        log.info("Modèle spaCy chargé : %s", modele)
    except Exception as exc:  # spaCy absent ou modèle non installé
        _nlp_etat["erreur"] = str(exc)
        log.warning("spaCy indisponible (%s) : détection par règles uniquement", exc)
        _nlp = None
    return _nlp


def etat_spacy() -> dict:
    charger_spacy()
    return {"actif": _nlp is not None, "modele": _nlp_etat["modele"], "erreur": _nlp_etat["erreur"]}


def _blocs(texte: str, taille: int = 20000):
    """Découpe le texte en blocs (par paragraphes) avec leur décalage."""
    pos = 0
    n = len(texte)
    while pos < n:
        fin = min(n, pos + taille)
        if fin < n:
            coupe = texte.rfind("\n", pos, fin)
            if coupe > pos:
                fin = coupe + 1
        yield pos, texte[pos:fin]
        pos = fin


def _mots(valeur: str) -> list[str]:
    return [m for m in re.split(r"[\s\-'’.,]+", sans_accents(valeur).casefold()) if m]


def candidats_spacy(texte: str) -> list[tuple[int, int, str]]:
    """Propositions brutes du modèle de langue : (début, fin, étiquette PER ou ORG)."""
    nlp = charger_spacy()
    if nlp is None:
        return []
    out = []
    blocs = list(_blocs(texte))
    for (decalage, _), doc in zip(blocs, nlp.pipe([b for _, b in blocs], batch_size=8)):
        for ent in doc.ents:
            if ent.label_ in {"PER", "ORG"}:
                out.append((ent.start_char + decalage, ent.end_char + decalage, ent.label_))
    return out


RE_PRENOM_AVANT = re.compile(rf"(?<![\w'’])({PRENOM})[  ]$")
_RE_TETE_NER = re.compile(rf"^(?:{CIVILITES}[  ]+|[LlDd]['’]|(?P<mot>[\w]+)[  ]+)")


def filtrer_candidats_ner(texte: str, candidats: list[tuple[int, int, str]],
                          listes: "Listes | None" = None) -> list[Span]:
    """Trie les propositions du modèle de langue : un mot courant, un sigle ou une ville seule
    ne sont jamais une personne ni une société (« Son IBAN », « Montant », « LRAR », « Lyon »)."""
    courants = listes.courants if listes else None
    villes = listes.villes if listes else None
    spans: list[Span] = []
    for debut, fin, etiquette in candidats:
        val = texte[debut:fin]
        # Retirer en tête une civilité, un article ou un possessif (on les laisse visibles)
        while True:
            m = _RE_TETE_NER.match(val)
            if not m or m.end() >= len(val):
                break
            if m.group("mot") is not None and cle_mot(m.group("mot")) not in DETERMINANTS:
                break
            debut += m.end()
            val = texte[debut:fin]
        val_s = val.strip(" .,;:«»\"'()")
        if len(val_s) < 2 or not any(c.isupper() for c in val_s) or any(c.isdigit() for c in val_s):
            continue
        if "\n" in val_s:
            continue
        mots = _mots(val_s)
        if not mots or all(est_mot_banal(m, courants) for m in mots):
            continue
        if est_ville(val_s, villes) or cle_mot(val_s) in INSTITUTIONS:
            continue
        if RE_CHIFFRE_ROMAIN.fullmatch(val_s):
            continue  # « IV », « XII » : numérotation, pas un nom
        if etiquette == "PER":
            if len(mots) == 1 and (mots[0] in MOTS_VIDES or mots[0] in TITRES):
                continue
            # Le modèle propose parfois le seul nom de famille : un prénom juste devant (« Jean » Dupont) lui est rattaché
            avant = RE_PRENOM_AVANT.search(texte[max(0, debut - 30):debut])
            if avant and not est_mot_banal(avant.group(1), courants) and not est_ville(avant.group(1), villes):
                debut -= len(avant.group(0))
            spans.append(Span(debut, debut + len(texte[debut:fin].rstrip(" .,;:")), "PERSONNE", P_NER, "ner"))
        else:
            if any(m in MOTS_INSTITUTIONS for m in mots) or val_s.upper() in FORMES_SET:
                continue
            if val_s.isupper() and len(val_s) <= 3:
                continue  # sigle court : trop ambigu
            spans.append(Span(debut, debut + len(val.rstrip(" .,;:")), "SOCIETE", P_NER, "ner"))
    return spans


def detecter_ner(texte: str, listes: "Listes | None" = None) -> list[Span]:
    return filtrer_candidats_ner(texte, candidats_spacy(texte), listes)


# --------------------------------------------------------------------------
# Détection par règles
# --------------------------------------------------------------------------
ARTICLES = {"les", "la", "le", "l'", "l’"}


def _nettoyer_nom_societe(texte: str, debut: int, fin: int, garder_article: bool = False) -> tuple[int, int] | None:
    val = texte[debut:fin]
    mots = val.split()
    # Retirer les mots de liaison en fin et les mots vides en tête
    while mots and sans_accents(mots[-1]).casefold().strip(".,") in {"&", "et", "de", "du", "des", "d'", "la", "le", "les", "and", "of", "the"}:
        mots.pop()
    while mots and sans_accents(mots[0]).casefold().strip(".,") in MOTS_VIDES:
        if garder_article and sans_accents(mots[0]).casefold() in ARTICLES and len(mots) > 1:
            break
        mots.pop(0)
    if not mots:
        return None
    # point final de phrase (mais pas celui d'un sigle comme « S.A. »)
    if not re.fullmatch(r"(?:[A-Za-z]\.)+", mots[-1]):
        mots[-1] = mots[-1].rstrip(".,;:")
        if not mots[-1]:
            mots.pop()
            if not mots:
                return None
    nom = " ".join(mots)
    if nom.upper() in FORMES_SET or len(nom) < 2:
        return None
    if all(sans_accents(m).casefold() in MOTS_VIDES | MOTS_INSTITUTIONS for m in mots):
        return None
    d = texte.find(mots[0], debut)
    f = texte.rfind(mots[-1], debut, fin) + len(mots[-1])
    if d < 0 or f <= d:
        return None
    return d, f


def detecter_regles(texte: str, types: set[str], toutes_dates: bool,
                    listes: "Listes | None" = None) -> list[Span]:
    spans: list[Span] = []
    courants = listes.courants if listes else None
    villes = listes.villes if listes else None

    def ajouter(d, f, t, p, src):
        if t in types and f > d:
            spans.append(Span(d, f, t, p, src))

    for m in RE_EMAIL.finditer(texte):
        ajouter(m.start(), m.end(), "EMAIL", P_IDENTIFIANT, "regle")
    for m in RE_IBAN.finditer(texte):
        if iban_ok(m.group()):
            ajouter(m.start(), m.end(), "IBAN", P_IDENTIFIANT + 2, "regle")
    for m in RE_TVA.finditer(texte):
        ajouter(m.start(), m.end(), "TVA", P_IDENTIFIANT + 1, "regle")
    for m in RE_NIR.finditer(texte):
        ctx = contexte_avant(texte, m.start(), 60)
        indice = any(k in ctx for k in ("secu", "nir", "insee", "numero ss", "n° ss", "assure social"))
        longueur = len(re.sub(r"\s", "", m.group()))
        if indice or (longueur == 15 and nir_ok(m.group())):
            ajouter(m.start(), m.end(), "NIR", P_IDENTIFIANT + 1, "regle")
    for m in RE_SIRET.finditer(texte):
        chiffres = re.sub(r"\D", "", m.group())
        if siret_ok(chiffres) or "siret" in contexte_avant(texte, m.start()):
            ajouter(m.start(), m.end(), "SIRET", P_IDENTIFIANT, "regle")
    # Numéro annoncé par « RCS », « SIREN », « SIRET » : reconnu même coupé par un retour à la ligne
    for m in RE_RCS.finditer(texte):
        if re.match(r"\s*(?:€|euros?\b|eur\b|k€|m€)", texte[m.end("num"):m.end("num") + 8], re.IGNORECASE):
            continue  # c'est un montant (capital social…), pas un numéro
        chiffres = re.sub(r"\D", "", m.group("num"))
        ajouter(m.start("num"), m.end("num"), "SIRET" if len(chiffres) == 14 else "SIREN", P_IDENTIFIANT + 1, "regle")
    for m in RE_SIREN.finditer(texte):
        chiffres = re.sub(r"\D", "", m.group())
        ctx = re.split(r"\d", contexte_avant(texte, m.start()))[-1]
        if re.match(r"\s*(?:€|euros?\b|eur\b|k€|m€)", texte[m.end():m.end() + 8], re.IGNORECASE):
            continue
        if any(k in ctx for k in ("siren", "rcs", "r.c.s", "immatricul", "identification", "registre")) \
                or (luhn_ok(chiffres) and re.search(r"n[°o]\s*$|numero\s*$", ctx)):
            ajouter(m.start(), m.end(), "SIREN", P_IDENTIFIANT - 1, "regle")
    for m in RE_TEL.finditer(texte):
        ajouter(m.start(), m.end(), "TELEPHONE", P_IDENTIFIANT - 2, "regle")

    for m in RE_DATE_NAISSANCE.finditer(texte):
        ajouter(m.start("d"), m.end("d"), "DATE_NAISSANCE", P_DATE_NAISSANCE, "regle")
    for m in RE_LIEU_NAISSANCE.finditer(texte):
        fin = m.end("dep") + 1 if m.group("dep") else m.end("lieu")
        ajouter(m.start("lieu"), fin, "LIEU_NAISSANCE", P_LIEU_NAISSANCE, "regle")
    if toutes_dates:
        for m in RE_DATE.finditer(texte):
            ajouter(m.start(), m.end(), "DATE", P_DATE, "regle")

    for m in RE_ADRESSE.finditer(texte):
        fin = m.end()
        # ne pas avaler un point final ou une virgule
        while True:
            while fin > m.start() and texte[fin - 1] in " ,.;":
                fin -= 1
            queue = re.search(r"[ \u00a0](?:de|du|des|la|le|les|aux|au|sur|sous|en)$", texte[m.start():fin])
            if not queue:
                break
            fin = m.start() + queue.start()
        ajouter(m.start(), fin, "ADRESSE", P_ADRESSE, "regle")
    for m in RE_CP_VILLE.finditer(texte):
        ajouter(m.start(), m.end(), "ADRESSE", P_ADRESSE - 1, "regle")
    for m in RE_BOITE.finditer(texte):
        ajouter(m.start(), m.end(), "ADRESSE", P_ADRESSE - 1, "regle")

    # Personnes précédées d'une civilité
    for m in RE_CIVILITE.finditer(texte):
        mots = _mots(m.group("nom"))
        if not mots or all(x in TITRES or x in MOTS_VIDES for x in mots):
            continue
        # couper au premier mot-titre éventuel (« Maître Durand Avocat »)
        d, f = m.start("nom"), m.end("nom")
        brut = m.group("nom").split()
        garde = []
        for w in brut:
            if sans_accents(w).casefold().strip(".,") in MOTS_VIDES and garde:
                break
            garde.append(w)
        f = d + len(" ".join(garde)) if garde else f
        if garde and sans_accents(garde[0]).casefold() in MOTS_VIDES:
            continue
        # « Mme L. » : une initiale seule n'identifie personne et, une fois enregistrée,
        # elle serait reconnue à tort dans « L. 441-6 »
        if garde and all(re.fullmatch(rf"[{UP}]\.?", w) for w in garde):
            continue
        ajouter(d, f, "PERSONNE", P_CIVILITE, "regle")

    # Prénom NOM / NOM Prénom
    for regex in (RE_PRENOM_NOM, RE_NOM_PRENOM):
        for m in regex.finditer(texte):
            if ligne_en_majuscules(texte, m.start()):
                continue
            mots = m.group("nom").split()
            mots_n = [sans_accents(x).casefold() for x in mots]
            if any(x in MOTS_VIDES or x in MOTS_INSTITUTIONS or x.upper() in FORMES_SET for x in mots_n):
                continue
            # « Son IBAN », « Votre RIB », « Voir PJ » ont la forme « Prénom NOM » sans en être :
            # un déterminant ou un sigle courant écarte la proposition
            if any(cle_mot(x) in DETERMINANTS or cle_mot(x) in SIGLES for x in mots) \
                    or all(est_mot_banal(x, courants) for x in mots):
                continue
            ajouter(m.start("nom"), m.end("nom"), "PERSONNE", P_PRENOM_NOM - (5 if regex is RE_NOM_PRENOM else 0), "regle")

    # Sociétés
    for regex in (RE_SOC_GUILLEMETS, RE_SOC_FORME_AVANT, RE_SOC_FORME_APRES, RE_SOC_SOCIETE):
        for m in regex.finditer(texte):
            if regex is not RE_SOC_GUILLEMETS and ligne_en_majuscules(texte, m.start()):
                # En titre capitales, seule « FORME + NOM » est retenue, hors formes ambiguës (SA, SEL, SEM)
                forme = texte[m.start():m.start("nom")].strip(" .")
                if regex is not RE_SOC_FORME_AVANT or forme in {"SA", "SEL", "SEM"}:
                    continue
            garder = regex in (RE_SOC_FORME_AVANT, RE_SOC_SOCIETE)
            res = _nettoyer_nom_societe(texte, m.start("nom"), m.end("nom"), garder_article=garder)
            if res:
                prio = P_SOCIETE + (3 if regex is RE_SOC_GUILLEMETS else 0)
                ajouter(res[0], res[1], "SOCIETE", prio, "regle")

    # Dénomination commerciale : le nom qui suit « Agence », « Cabinet », « Régie »… appartient
    # à la société (« Agence Martin Bellecour » = une seule société, pas une société + une personne)
    for m in RE_SOC_DENOMINATION.finditer(texte):
        if ligne_en_majuscules(texte, m.start()):
            continue
        d, f = m.start("nom"), m.end("nom")
        while f > d and texte[f - 1] in ".,;:":
            f -= 1
        suite = [w for w in re.split(r"[  ]+", texte[d:f])[1:]
                 if cle_mot(w) not in {"&", "et", "de", "du", "des", "d", "la", "le", "les"}]
        # « Centre Commercial », « Banque de France » : il faut au moins un vrai nom propre après la dénomination
        if not suite or all(est_mot_banal(w, courants) or est_ville(w, villes) for w in suite):
            continue
        if cle_mot(texte[d:f]) in INSTITUTIONS:
            continue
        ajouter(d, f, "SOCIETE", P_SOCIETE + 1, "regle")

    # Nom isolé dans un tableau, derrière un repère de lot ou de ligne : « S09 Dupont », « Lot 12 Martin »
    for m in RE_LIGNE_TABLEAU.finditer(texte):
        nom = m.group("nom")
        mots = [w for w in re.split(r"[  \-]+", nom) if w and not re.fullmatch(PARTICULES, w, flags=re.IGNORECASE)]
        if not mots or any(est_mot_banal(w, courants) or w.upper() in FORMES_SET for w in mots):
            continue  # « S11 Cave », « A12 Parking » : désignation de lot, pas un nom
        if est_ville(nom, villes) or any(est_ville(w, villes) for w in mots):
            continue
        ajouter(m.start("nom"), m.end("nom"), "PERSONNE", P_NER - 2, "tableau")
    return spans


# --------------------------------------------------------------------------
# Termes imposés / valeurs connues / propagation
# --------------------------------------------------------------------------
def _motif_souple(valeur: str) -> str:
    """Motif tolérant aux espaces multiples et aux apostrophes typographiques."""
    parties = [re.escape(p) for p in re.split(r"\s+", valeur.strip()) if p]
    motif = r"[ \u00a0]+".join(parties)
    # Une seule passe : remplacer d'abord « ' » puis « ’ » réécrivait la classe déjà insérée
    # (« ['['’]] »), et une valeur contenant une apostrophe n'était plus jamais retrouvée
    motif = re.sub(r"['’]", "['’]", motif)
    return motif


def rechercher_termes(texte: str, termes: list[tuple[str, str]], priorite: int, source: str,
                      exiger_majuscule: bool = False) -> list[Span]:
    """Recherche exacte (insensible à la casse et aux accents près) de termes."""
    spans = []
    for type_, valeur in termes:
        if not valeur or len(valeur.strip()) < 2:
            continue
        if type_ in {"SIRET", "SIREN", "TVA", "IBAN", "NIR", "TELEPHONE"}:
            chiffres = re.sub(r"[^0-9A-Za-z]", "", valeur)
            motif = r"[ \u00a0.\-]?".join(re.escape(c) for c in chiffres)
            rx = re.compile(rf"(?<![0-9A-Za-z]){motif}(?![0-9A-Za-z])", re.IGNORECASE)
        else:
            rx = re.compile(rf"(?<![\w]){_motif_souple(valeur)}(?![\w])", re.IGNORECASE)
        for m in rx.finditer(texte):
            if exiger_majuscule and not m.group()[0].isupper():
                continue
            spans.append(Span(m.start(), m.end(), type_, priorite, source, canonical=valeur))
    return spans


def variantes_nom(valeur: str, type_: str) -> list[str]:
    """Formes courtes à propager : nom de famille d'une personne, nom d'une société sans forme."""
    out = []
    mots = [w for w in re.split(r"[ \u00a0]+", valeur.strip()) if w]
    if type_ == "PERSONNE" and len(mots) >= 2:
        caps = [w for w in mots if len(w) >= 3 and w.isupper()]
        if caps:
            out.append(" ".join(caps))
        dernier = mots[-1]
        if len(dernier) >= 3 and sans_accents(dernier).casefold() not in MOTS_VIDES:
            out.append(dernier)
        # nom composé avec particule : « de La Fontaine »
        for i, w in enumerate(mots[1:], start=1):
            if re.fullmatch(PARTICULES, w, flags=re.IGNORECASE):
                out.append(" ".join(mots[i:]))
                break
    if type_ == "SOCIETE":
        sans_forme = [w for w in mots if w.upper().strip("().,") not in FORMES_SET]
        if 0 < len(sans_forme) < len(mots):
            out.append(" ".join(sans_forme))
    uniques = []
    for v in out:
        if v != valeur and v not in uniques and sans_accents(v).casefold() not in MOTS_VIDES:
            uniques.append(v)
    return uniques


# --------------------------------------------------------------------------
# Arbitrage
# --------------------------------------------------------------------------
def resoudre(spans: list[Span], texte: str, jamais: set[str]) -> list[Span]:
    for s in spans:
        s.value = texte[s.start:s.end]
    candidats = [s for s in spans
                 if s.value.strip()
                 and normaliser(s.value) not in jamais
                 and not RE_MARQUEUR.fullmatch(s.value.strip())]
    candidats.sort(key=lambda s: (-s.priority, -s.length, s.start))
    occupe = bytearray(len(texte) + 1)
    retenus: list[Span] = []
    for s in candidats:
        if any(occupe[s.start:s.end]):
            continue
        # ne jamais couper un marqueur existant
        retenus.append(s)
        for i in range(s.start, s.end):
            occupe[i] = 1
    retenus.sort(key=lambda s: s.start)
    return retenus
