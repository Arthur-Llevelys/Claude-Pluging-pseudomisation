"""
Tests du moteur. Lancement sur le serveur :
    cd /opt/anonymiseur && sudo -u anonymiseur venv/bin/python -m tests.test_moteur
(ou, sans spaCy : ANON_SPACY_MODEL=aucun python3 -m tests.test_moteur)
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.fernet import Fernet  # noqa: E402

from app import detect as D  # noqa: E402
from app.engine import Moteur  # noqa: E402
from app.store import Store  # noqa: E402

ICI = Path(__file__).parent
ECHECS = []


def verifier(cond, message):
    print(("  ok   " if cond else "  ÉCHEC ") + message)
    if not cond:
        ECHECS.append(message)


def moteur():
    base = tempfile.mktemp(suffix=".db")
    conf = str(ICI.parent / "config") if (ICI.parent / "config").exists() else os.environ.get("ANON_CONFIG_DIR", "/etc/anonymiseur")
    return Moteur(Store(base, Fernet.generate_key().decode()), D.Listes.charger(conf))


def main():
    print("spaCy :", D.etat_spacy())
    M = moteur()
    txt = (ICI / "exemple.txt").read_text(encoding="utf-8")
    r = M.anonymiser(txt, "t")
    sortie = r["texte"]
    print("\n1. Données à masquer")
    for secret in ["ALPHA CONSEIL", "12 bis rue Victor Hugo", "732 829 320 00074", "FR40 732829320",
                   "Jean-Pierre DUPONT", "Sophie Martin", "14/03/1978", "Villeurbanne", "45 avenue des Frères Lumière",
                   "2 78 03 69 266 084 17", "06 12 34 56 78", "sophie.martin@exemple.fr",
                   "FR76 3000 6000 0112 3456 7890 189", "Beta Immobilier", "Claire Lefèvre", "Dupont"]:
        verifier(secret not in sortie, f"masqué : {secret}")

    print("\n2. Éléments à conserver")
    for garde in ["Cour de cassation", "Code de commerce", "L. 145-9", "22-19.123", "3 mars 2025",
                  "10 000 euros", "Barreau de Lyon", "SAS au capital", "Monsieur", "Madame", "SARL"]:
        verifier(garde in sortie, f"conservé : {garde}")

    print("\n3. Cohérence des marqueurs")
    verifier(sortie.count("[PERSONNE_1]") == 3, "DUPONT / Dupont / Jean-Pierre DUPONT => même marqueur")
    r2 = M.anonymiser("Courrier de Jean-Pierre DUPONT à Mme Martin.", "t")
    verifier("[PERSONNE_1]" in r2["texte"] and "[PERSONNE_2]" in r2["texte"], "même marqueur dans un 2e document du dossier")
    r3 = M.anonymiser("Courrier de Jean-Pierre DUPONT.", "autre-dossier")
    verifier("[PERSONNE_1]" in r3["texte"], "dossiers indépendants")

    print("\n4. Ré-identification")
    back = M.reidentifier("Selon [PERSONNE_1] et personne_2, la [SOCIETE_1] ; [PERSONNE_99].", "t")
    verifier("Jean-Pierre DUPONT" in back["texte"] and "Sophie Martin" in back["texte"], "marqueurs remplacés (y compris forme altérée)")
    verifier(back["marqueurs_inconnus"] == ["[PERSONNE_99]"], "marqueur inconnu signalé")

    print("\n5. Faux positifs (texte sans données personnelles)")
    neutre = (ICI / "sans_donnees.txt").read_text(encoding="utf-8")
    rn = M.anonymiser(neutre, "neutre")
    verifier(rn["nb_remplacements"] == 0, f"aucun remplacement (obtenu : {[e['marqueur'] for e in rn['entites']]})")

    print("\n6. Montants, références et dates ordinaires")
    rm = M.anonymiser("Facture de 123 456 789 euros, RG n° 23/01234, audience du 12/05/2025.", "m")
    verifier(rm["nb_remplacements"] == 0, "montant / RG / date d'audience conservés")
    rd = M.anonymiser("Audience du 12/05/2025.", "m", {"toutes_dates": True})
    verifier("[DATE_" in rd["texte"], "option toutes_dates")

    print("\n7. Termes imposés et liste d'exclusion")
    ri = M.anonymiser("Le projet Chrysalide avance.", "i", {"termes": ["AUTRE: Chrysalide"]})
    verifier("[AUTRE_1]" in ri["texte"], "terme imposé masqué")

    print("\n8. Version 1.1.0 : erreurs relevées sur un dossier réel (données fictives)")
    from tests import test_lot1
    ECHECS.extend(test_lot1.lancer())

    print("\n9. Version 1.2.0 : corrections d'un dossier, export des valeurs fermé")
    from tests import test_lot4
    ECHECS.extend(test_lot4.lancer())

    print("\n10. Version 1.3.0 : PDF scannés lus par OCR")
    from tests import test_lot5
    ECHECS.extend(test_lot5.lancer())

    print("\nRésultat :", "TOUT EST OK" if not ECHECS else f"{len(ECHECS)} échec(s)")
    for echec in ECHECS:
        print("  -", echec)
    return 1 if ECHECS else 0


if __name__ == "__main__":
    sys.exit(main())
