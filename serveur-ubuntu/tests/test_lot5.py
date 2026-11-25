"""
Tests de la version 1.3.0 (lot 5) : lecture des PDF scannés par OCR (ocrmypdf), avec un faux ocrmypdf
pour que le test tourne partout. Si le vrai ocrmypdf est installé (serveur Ubuntu), un essai réel est fait en plus.

    python -m tests.test_lot5      (aussi lancé par « python -m tests.test_moteur »)
"""
import io
import os
import shutil
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fichiers as F  # noqa: E402

ECHECS: list[str] = []
TMP = tempfile.mkdtemp(prefix="anon-lot5-")


def verifier(cond, message):
    print(("  ok   " if cond else "  ÉCHEC ") + message)
    if not cond:
        ECHECS.append(message)


def pdf_texte(lignes: list[str]) -> bytes:
    """PDF minimal d'une page contenant du texte (police standard Helvetica)."""
    contenu = "BT /F1 12 Tf 14 TL 72 720 Td " + " T* ".join(f"({l}) Tj" for l in lignes) + " ET"
    flux = zlib.compress(contenu.encode("latin-1"))
    objets = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(flux)).encode() + b" /Filter /FlateDecode >>\nstream\n" + flux + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    positions = []
    for i, o in enumerate(objets, 1):
        positions.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objets) + 1}\n0000000000 65535 f \n".encode())
    for p in positions:
        out.write(f"{p:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objets) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


def pdf_scanne(pages: int = 2) -> bytes:
    from pypdf import PdfWriter
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(595, 842)
    b = io.BytesIO()
    w.write(b)
    return b.getvalue()


def faux_ocrmypdf(code_retour: int = 0) -> str:
    """Faux ocrmypdf : écrit dans le fichier de sortie (dernier argument) un PDF textuel, ou échoue."""
    d = tempfile.mkdtemp(dir=TMP)
    cible = Path(d, "resultat.pdf")
    cible.write_bytes(pdf_texte(["Madame Odile Fontanel demeure", "12 rue des Tanneurs, 69007 Lyon."]))
    script = Path(d, "faux_ocrmypdf.py")
    script.write_text(f"import shutil, sys\nif {code_retour}: sys.exit({code_retour})\nshutil.copy(r'{cible}', sys.argv[-1])\n", encoding="utf-8")
    if os.name == "nt":
        lanceur = Path(d, "ocrmypdf.cmd")
        lanceur.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        lanceur = Path(d, "ocrmypdf")
        lanceur.write_text(f"#!{sys.executable}\n" + script.read_text(encoding="utf-8"), encoding="utf-8")
        lanceur.chmod(0o755)
    return str(lanceur)


def test_ocr():
    print("\nL5-1. PDF scanné lu par OCR (ocrmypdf)")
    texte, avert = F.extraire_texte("piece.pdf", pdf_texte(["Contrat de bail entre les parties, signe a Lyon le 3 mars 2025."]))
    verifier("Contrat de bail" in texte and not avert, "PDF textuel : lu directement, sans OCR")

    os.environ["ANON_OCRMYPDF"] = faux_ocrmypdf()
    os.environ.pop("ANON_OCR", None)
    texte, avert = F.extraire_texte("scan.pdf", pdf_scanne())
    verifier("Odile Fontanel" in texte and "Tanneurs" in texte, f"PDF scanné : texte obtenu par OCR ({texte[:60]!r})")
    verifier(any("OCR" in a and "Relisez" in a for a in avert), "avertissement : texte issu de l'OCR, à relire")

    os.environ["ANON_OCRMYPDF"] = faux_ocrmypdf(code_retour=2)
    texte, avert = F.extraire_texte("scan.pdf", pdf_scanne())
    verifier(any("l'OCR a échoué" in a for a in avert), "OCR en échec : signalé clairement")

    os.environ["ANON_OCR"] = "0"
    texte, avert = F.extraire_texte("scan.pdf", pdf_scanne())
    verifier(not texte.strip() and any("l'OCR n'est pas installé" in a and "apt install ocrmypdf" in a for a in avert),
             "OCR absent : signalé clairement, avec la commande d'installation")
    os.environ.pop("ANON_OCR", None)
    os.environ.pop("ANON_OCRMYPDF", None)


def test_ocr_reel():
    print("\nL5-2. Essai réel avec ocrmypdf (seulement si installé)")
    if not shutil.which("ocrmypdf"):
        print("  --   ocrmypdf absent de ce poste : essai réel non lancé")
        return
    verifier(F.ocr_disponible() is not None, "ocrmypdf détecté")
    texte, avert = F.extraire_texte("scan.pdf", pdf_scanne(1))
    verifier(not any("a échoué" in a for a in avert), f"ocrmypdf s'exécute sans erreur sur une page blanche ({avert})")


def test_prenom_rattache():
    print("\nL5-3. Nom de famille seul proposé par le modèle : le prénom qui le précède lui est rattaché")
    from app import detect as D
    texte = "From: Jean Dupont <j@x.fr>\nMaître Dupont et Madame Dupont ; Hier Dupont a écrit."
    pos = [(m.start(), m.end(), "PER") for m in __import__("re").finditer("Dupont", texte)]
    spans = D.filtrer_candidats_ner(texte, pos)
    valeurs = [texte[s.start:s.end] for s in spans]
    verifier(valeurs == ["Jean Dupont", "Dupont", "Dupont", "Dupont"], f"« Jean » rattaché ; civilités et mots courants laissés ({valeurs})")


def lancer() -> list[str]:
    ECHECS.clear()
    test_ocr()
    test_ocr_reel()
    test_prenom_rattache()
    return list(ECHECS)


def test_tout():
    assert not lancer(), ECHECS


if __name__ == "__main__":
    echecs = lancer()
    print("\nRésultat :", "TOUT EST OK" if not echecs else f"{len(echecs)} échec(s)")
    sys.exit(1 if echecs else 0)
