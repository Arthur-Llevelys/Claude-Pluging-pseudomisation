# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Détection des sociétés : « ZORVAL SAS », « la société ZORVAL », « SCI Les Lilas ».

Seul le nom est remplacé ; la forme juridique et le mot introducteur restent lisibles
(« [SOCIETE_1] SAS », « la société [SOCIETE_1] »). Les deux formes partagent la même clé.
"""
from __future__ import annotations

import re

from ..lexicon import COMPANY_FORMS, COMPANY_INTRODUCERS, is_first_name, is_title_stopword, is_upper_stopword
from ..textnorm import is_all_caps, is_title_case, norm_key
from .base import DetectionContext, Span

CATEGORY = "SOCIETE"
PRIORITY = 58  # sous les identifiants, au-dessus des personnes « nom seul »

_UP = "A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ"
_LO = "a-zàâäçéèêëîïôöùûüÿæœ"

_FORMS_ALT = "|".join(sorted((re.escape(f) for f in COMPANY_FORMS), key=len, reverse=True))
_INTRO_ALT = "|".join(sorted((re.escape(i) for i in COMPANY_INTRODUCERS), key=len, reverse=True))

# Jeton de nom de société : commence par une majuscule ou un chiffre, peut contenir & ' . -
_NAME_TOKEN = rf"[{_UP}0-9](?:[{_UP}{_LO}0-9&'’\-]|\.(?=[{_UP}{_LO}0-9]))*"
_CONNECTOR = r"(?:&|de|du|des|la|le|les|d['’]|et(?=\s+(?:Fils|Associ[ée]s|Cie|Compagnie|Fr[èe]res|Partenaires|Partners|Associates|Co)))"
_NAME = rf"{_NAME_TOKEN}(?:\s+(?:{_CONNECTOR}\s+)?{_NAME_TOKEN}){{0,4}}"

# « ZORVAL SAS », « Zorval Industries SARL »
NAME_FORM_RE = re.compile(rf"(?<![\w{_UP}{_LO}])({_NAME})\s+({_FORMS_ALT})(?![\w{_LO}])")
# « la société ZORVAL », « SCI Les Lilas », « le cabinet DURAND & Associés »
INTRO_NAME_RE = re.compile(
    rf"(?<![\w{_UP}{_LO}])(?:la\s+|le\s+|l['’])?({_INTRO_ALT})\s+({_NAME})(?![\w{_LO}])"
)

_FORMS_KEYS = {norm_key(f.rstrip(".")) for f in COMPANY_FORMS}
_CONNECTORS = {"&", "et", "de", "du", "des", "la", "le", "les", "d'"}
_GENERIC_WORDS = {
    "generale", "general", "francaise", "francais", "nationale", "national", "nouvelle", "mere",
    "fille", "civile", "anonyme", "commerciale", "immobiliere", "par", "actions", "simplifiee",
}


def _company_key(name: str) -> str:
    tokens = [t for t in re.split(r"[\s\-]+", norm_key(name.replace("’", "'"))) if t]
    tokens = [t.strip(".") for t in tokens if t.strip(".") not in _FORMS_KEYS]
    return " ".join(tokens)


_ARTICLES = {"le", "la", "les", "l'"}


def _bad_leading(tok: str) -> bool:
    core = tok.rstrip(".")
    if norm_key(core.replace("’", "'")) in _ARTICLES:
        return False  # « Les Lilas » : l'article fait partie du nom
    if is_all_caps(core) and is_upper_stopword(core):
        return True
    if is_title_case(core) and (is_title_stopword(core) or norm_key(core) in _GENERIC_WORDS):
        return True
    return False


def trim_name(name: str) -> str | None:
    """Retire les mots de tête parasites (« Avocat de ZORVAL ») et la forme juridique finale."""
    tokens = name.split()
    while tokens and (_bad_leading(tokens[0]) or tokens[0].replace("’", "'").lower() in (_CONNECTORS - _ARTICLES)):
        tokens.pop(0)
    while tokens and norm_key(tokens[-1].rstrip(".")) in _FORMS_KEYS:
        tokens.pop()
    while tokens and tokens[-1].replace("’", "'").lower() in _CONNECTORS:
        tokens.pop()
    if not tokens:
        return None
    joined = " ".join(tokens)
    if not any(c.isalpha() for c in joined) or len(_company_key(joined)) < 2:
        return None
    return joined


class CompanyDetector:
    name = "companies"

    def detect(self, text: str, ctx: DetectionContext) -> list[Span]:
        if not ctx.is_enabled(CATEGORY):
            return []
        spans: list[Span] = []
        for m in NAME_FORM_RE.finditer(text):
            form = m.group(2)
            trimmed = trim_name(m.group(1))
            if trimmed is None:
                continue
            tokens = trimmed.split()
            # « Monsieur SA », « Jean Dupont SA » : avec SA/SE, on exige des capitales ou plusieurs jetons non prénoms
            if form in {"SA", "SE"} and (len(tokens) == 1 and not is_all_caps(tokens[0])):
                continue
            if is_first_name(tokens[0]) and len(tokens) >= 2 and not is_all_caps(tokens[-1]):
                # ressemble à « Prénom Nom » : laissé au détecteur de personnes
                continue
            start = m.end(1) - len(trimmed)
            spans.append(Span(start, m.end(1), CATEGORY, trimmed, _company_key(trimmed), PRIORITY))
        for m in INTRO_NAME_RE.finditer(text):
            trimmed = trim_name(m.group(2))
            if trimmed is None:
                continue
            start = m.start(2) + (len(m.group(2)) - len(m.group(2).lstrip()))
            # trim_name coupe par la gauche ET par la droite : on recalcule la position réelle
            idx = text.find(trimmed, m.start(2), m.end(2))
            if idx < 0:
                continue
            spans.append(Span(idx, idx + len(trimmed), CATEGORY, trimmed, _company_key(trimmed), PRIORITY))
        return spans
