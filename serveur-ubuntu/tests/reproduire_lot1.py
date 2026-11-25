"""
Reproduction des erreurs de détection relevées sur un dossier réel, avec un exemple fictif.
Affiche, pour chaque point, si le texte est masqué ou conservé comme il se doit.

    python -m tests.reproduire_lot1                      (avec spaCy si le modèle est installé)
    ANON_SPACY_MODEL=aucun python -m tests.reproduire_lot1   (règles seules)
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.fernet import Fernet  # noqa: E402

from app import detect as D  # noqa: E402
from app.engine import Moteur  # noqa: E402
from app.store import Store  # noqa: E402

ICI = Path(__file__).parent

# (libellé, texte qui doit avoir disparu de la sortie)
A_MASQUER = [
    ("RCS coupé par un retour à la ligne", "352 332"),
    ("RCS coupé : fin du numéro", "\n159"),
    ("nom isolé dans un tableau (S09)", "Dupont"),
    ("nom isolé dans un tableau (S10)", "Lefèvre"),
    ("adresse « Grande rue »", "Grande rue de la Guillotière"),
    ("adresse « Grande rue » : numéro", "110 "),
    ("adresse à numéro double : 16/", "16/"),
    ("adresse à numéro double : voie", "rue Paul Verdier"),
    ("adresse du tableau", "12 rue des Tanneurs"),
    ("société à dénomination : Martin", "Martin"),
    ("société à dénomination : Bellecour", "Bellecour"),
    ("IBAN", "FR76 3000"),
]
# (libellé, texte qui doit être resté tel quel dans la sortie)
A_CONSERVER = [
    ("montant après une adresse", "– 92,00 €"),
    ("montant de la créance", "1 250,50 €"),
    ("capital", "10 000 euros"),
    ("article L.", "L. 441-6"),
    ("article R.", "R. 123-4"),
    ("numéro de pourvoi", "19-12.345"),
    ("référence CELEX", "32016R0679"),
    ("ville seule (Fait à Lyon)", "Fait à Lyon"),
    ("mot courant : Créance", "Créance impayée"),
    ("mot courant : Montant", "conteste le Montant"),
    ("mot courant : Montant de la créance", "Montant de la créance"),
    ("sigle : LRAR", "LRAR"),
    ("en-tête : Objet", "Objet :"),
    ("en-tête : Subject", "Subject:"),
    ("« Son IBAN »", "Son IBAN est"),
    ("mot de tableau : Cave", "S11 Cave"),
    ("institution", "Cour de cassation"),
    ("date ordinaire", "3 mars 2025"),
]


def main():
    print("spaCy :", D.etat_spacy())
    moteur = Moteur(Store(tempfile.mktemp(suffix=".db"), Fernet.generate_key().decode()), D.Listes.charger(str(ICI.parent / "config")))
    texte = (ICI / "exemple_lot1.txt").read_text(encoding="utf-8")
    r = moteur.anonymiser(texte, "lot1", inclure_valeurs=True)
    sortie = r["texte"]
    echecs = 0
    print("\n--- doit être masqué ---")
    for libelle, fragment in A_MASQUER:
        ok = fragment not in sortie
        echecs += not ok
        print(("  ok    " if ok else "  FUITE ") + libelle)
    print("\n--- doit être conservé ---")
    for libelle, fragment in A_CONSERVER:
        ok = fragment in sortie
        echecs += not ok
        print(("  ok    " if ok else "  MASQUÉ À TORT ") + libelle)
    print("\n--- société en une seule entité ---")
    ligne = next((l for l in sortie.split("\n") if "représentée par" in l), "")
    une_seule = "l'Agence [SOCIETE_" in ligne.replace("l’", "l'") or "[SOCIETE_" in ligne and "[PERSONNE_" not in ligne
    echecs += not une_seule
    print(("  ok    " if une_seule else "  COUPÉE ") + "« Agence Martin Bellecour » : " + ligne.strip()[:110])
    print("\n--- texte produit ---")
    print(sortie)
    print("\n--- entités ---")
    for e in r["entites"]:
        print(f"  {e['marqueur']:22} {e['valeur']!r}")
    print(f"\n{echecs} écart(s)")
    return echecs


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
