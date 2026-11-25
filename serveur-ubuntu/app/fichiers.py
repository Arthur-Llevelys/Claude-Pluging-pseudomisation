# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
# Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
"""Extraction de texte (txt, md, csv, docx, odt, pdf) et production de .docx."""
from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree as ET

EXTENSIONS = {".txt", ".md", ".csv", ".docx", ".odt", ".pdf", ".rtf", ".html", ".htm", ".eml"}


def _decoder(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _docx(data: bytes) -> str:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(io.BytesIO(data))
    parties: list[str] = []

    def bloc(parent) -> list[str]:
        out = []
        for enfant in parent.element.body.iterchildren():
            tag = enfant.tag.rsplit("}", 1)[-1]
            if tag == "p":
                out.append(Paragraph(enfant, parent).text)
            elif tag == "tbl":
                t = Table(enfant, parent)
                for row in t.rows:
                    cellules = []
                    for c in row.cells:
                        txt = "\n".join(p.text for p in c.paragraphs).strip()
                        if not cellules or cellules[-1] != txt:  # cellules fusionnées
                            cellules.append(txt)
                    out.append(" | ".join(cellules))
        return out

    # En-têtes et pieds de page : ils contiennent souvent noms et adresses
    vus = set()
    for section in doc.sections:
        for hf in (section.header, section.first_page_header, section.footer, section.first_page_footer):
            try:
                if hf is None or hf.is_linked_to_previous and hf in vus:
                    continue
                txt = "\n".join(p.text for p in hf.paragraphs if p.text.strip())
                for t in hf.tables:
                    for row in t.rows:
                        txt += "\n" + " | ".join(c.text for c in row.cells)
                txt = txt.strip()
                if txt and txt not in vus:
                    vus.add(txt)
                    parties.append(f"[En-tête / pied de page]\n{txt}")
            except Exception:
                continue
    parties.extend(bloc(doc))
    # Notes de bas de page (python-docx ne les expose pas : lecture XML directe)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if "word/footnotes.xml" in z.namelist():
                root = ET.fromstring(z.read("word/footnotes.xml"))
                ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                notes = []
                for fn in root.iter(f"{ns}footnote"):
                    if fn.get(f"{ns}id") in {"-1", "0"}:
                        continue
                    t = "".join(x.text or "" for x in fn.iter(f"{ns}t")).strip()
                    if t:
                        notes.append(t)
                if notes:
                    parties.append("[Notes de bas de page]\n" + "\n".join(notes))
    except Exception:
        pass
    return "\n".join(parties)


def _odt(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ET.fromstring(z.read("content.xml"))
    ns_text = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
    lignes = []
    for el in root.iter():
        if el.tag in (f"{ns_text}p", f"{ns_text}h"):
            lignes.append("".join(el.itertext()))
    return "\n".join(lignes)


def _pages_pdf(data: bytes) -> list[str]:
    from pypdf import PdfReader

    pages = []
    for p in PdfReader(io.BytesIO(data)).pages:
        try:
            pages.append(p.extract_text() or "")
        except Exception:
            pages.append("")
    return pages


def ocr_disponible() -> str | None:
    """Chemin d'ocrmypdf s'il est installé et non désactivé (ANON_OCR=0), sinon None."""
    import os
    import shutil

    if os.environ.get("ANON_OCR", "1").lower() in {"0", "non", "false"}:
        return None
    return shutil.which(os.environ.get("ANON_OCRMYPDF", "ocrmypdf"))


def _ocr(data: bytes) -> bytes:
    """Ajoute une couche de texte aux pages scannées (ocrmypdf + tesseract) ; les pages déjà textuelles sont gardées."""
    import os
    import subprocess
    import tempfile

    langues = os.environ.get("ANON_OCR_LANGUES", "fra")
    delai = int(os.environ.get("ANON_OCR_DELAI", "300"))
    with tempfile.TemporaryDirectory(prefix="anon-ocr-") as d:
        entree, sortie = os.path.join(d, "entree.pdf"), os.path.join(d, "sortie.pdf")
        with open(entree, "wb") as f:
            f.write(data)
        r = subprocess.run([ocr_disponible(), "-l", langues, "--skip-text", "--output-type", "pdf", "--quiet", entree, sortie],
                           capture_output=True, timeout=delai)
        if r.returncode not in (0, 6) or not os.path.exists(sortie):  # 6 : pages déjà textuelles
            raise RuntimeError(f"ocrmypdf a échoué (code {r.returncode})")
        with open(sortie, "rb") as f:
            return f.read()


def _pdf(data: bytes) -> tuple[str, list[str]]:
    pages = _pages_pdf(data)
    avert = []
    vides = sum(1 for p in pages if len(p.strip()) < 20)
    if pages and vides / len(pages) > 0.5:
        if ocr_disponible():
            try:
                pages = _pages_pdf(_ocr(data))
                avert.append(f"PDF scanné : texte obtenu par reconnaissance de caractères (OCR) sur {vides} page(s). "
                             "Relisez les noms propres : l'OCR peut en déformer certains, qui échappent alors au masquage.")
            except Exception as exc:  # OCR en échec : on le dit, sans échouer en silence
                avert.append(f"PDF scanné : l'OCR a échoué ({exc}) ; {vides} page(s) sur {len(pages)} non analysée(s).")
        else:
            avert.append(f"{vides} page(s) sur {len(pages)} sans texte exploitable : PDF probablement scanné, et l'OCR n'est pas "
                         "installé sur le serveur (sudo apt install ocrmypdf tesseract-ocr-fra). Son contenu n'est pas analysé.")
    return "\n\n".join(pages), avert


def _html(data: bytes) -> str:
    t = _decoder(data)
    t = re.sub(r"(?is)<(script|style).*?</\1>", "", t)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h\d>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    import html
    return html.unescape(t)


def _rtf(data: bytes) -> str:
    t = _decoder(data)
    t = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252"), t)
    t = re.sub(r"\\par[d]?\b", "\n", t)
    t = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", t)
    t = re.sub(r"[{}]", "", t)
    return t


def _eml(data: bytes) -> str:
    import email
    from email import policy

    msg = email.message_from_bytes(data, policy=policy.default)
    entetes = "\n".join(f"{k}: {msg[k]}" for k in ("From", "To", "Cc", "Date", "Subject") if msg[k])
    corps = msg.get_body(preferencelist=("plain", "html"))
    texte = corps.get_content() if corps else ""
    if corps and corps.get_content_type() == "text/html":
        texte = _html(texte.encode())
    return entetes + "\n\n" + texte


def extraire_texte(nom: str, data: bytes) -> tuple[str, list[str]]:
    ext = ("." + nom.rsplit(".", 1)[-1].lower()) if "." in nom else ""
    if ext == ".docx":
        return _docx(data), []
    if ext == ".odt":
        return _odt(data), []
    if ext == ".pdf":
        return _pdf(data)
    if ext in {".html", ".htm"}:
        return _html(data), []
    if ext == ".rtf":
        return _rtf(data), ["RTF : extraction simplifiée, mise en forme perdue."]
    if ext == ".eml":
        return _eml(data), ["Les pièces jointes du courriel ne sont pas analysées."]
    if ext in {".txt", ".md", ".csv", ""}:
        return _decoder(data), []
    raise ValueError(f"Format non pris en charge : {ext or 'sans extension'} "
                     f"(acceptés : {', '.join(sorted(EXTENSIONS))})")


# --------------------------------------------------------------------------
def _runs_gras(paragraphe, texte: str):
    """Ajoute le texte en gérant **gras** et *italique* (Markdown léger)."""
    for morceau in re.split(r"(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)", texte):
        if not morceau:
            continue
        if morceau.startswith("**") and morceau.endswith("**"):
            paragraphe.add_run(morceau[2:-2]).bold = True
        elif morceau.startswith("*") and morceau.endswith("*") and len(morceau) > 2:
            paragraphe.add_run(morceau[1:-1]).italic = True
        else:
            paragraphe.add_run(morceau)


def texte_vers_docx(texte: str, titre: str | None = None) -> bytes:
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)
    if titre:
        doc.core_properties.title = titre
    for ligne in texte.splitlines():
        brut = ligne.rstrip()
        if not brut.strip():
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", brut)
        if m:
            doc.add_heading(m.group(2).strip(), level=min(len(m.group(1)), 4))
            continue
        m = re.match(r"^\s*[-*•]\s+(.*)$", brut)
        if m:
            _runs_gras(doc.add_paragraph(style="List Bullet"), m.group(1))
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)$", brut)
        if m:
            _runs_gras(doc.add_paragraph(style="List Number"), m.group(1))
            continue
        if re.fullmatch(r"\s*(-{3,}|\*{3,}|_{3,})\s*", brut):
            continue
        _runs_gras(doc.add_paragraph(), brut)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
