"""Pont de mesure : passe des documents dans le moteur du serveur 1.1.0 (règles), avec au choix
les propositions de spaCy (ANON_SPACY_MODEL) ou des propositions fournies (celles d'Ollama).
Usage : pont_moteur.py <entrée.json> <sortie.json>
Entrée : [{"nom": ..., "texte": ..., "candidats": [[début, fin, "PER"|"ORG"], ...] | null}]
"""
import json
import sys
import tempfile
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent / "serveur-ubuntu"
sys.path.insert(0, str(RACINE))

from cryptography.fernet import Fernet  # noqa: E402

from app import detect as D  # noqa: E402
from app.engine import Moteur  # noqa: E402
from app.store import Store  # noqa: E402

docs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
conf = tempfile.mkdtemp()  # listes livrées seulement, sans configuration personnelle
moteur = Moteur(Store(tempfile.mktemp(suffix=".db"), Fernet.generate_key().decode()), D.Listes.charger(conf))
origine = D.candidats_spacy
sortie = []
for i, doc in enumerate(docs):
    if doc.get("candidats") is not None:
        cands = [tuple(c) for c in doc["candidats"]]
        D.candidats_spacy = lambda texte, c=cands: c
    else:
        D.candidats_spacy = origine
    r = moteur.anonymiser(doc["texte"], f"mesure-{i}", inclure_valeurs=True)
    sortie.append({"nom": doc["nom"], "texte": r["texte"], "entites": [[e["marqueur"], e["valeur"]] for e in r["entites"]],
                   "spacy": D.etat_spacy()["actif"]})
Path(sys.argv[2]).write_text(json.dumps(sortie, ensure_ascii=False), encoding="utf-8")
