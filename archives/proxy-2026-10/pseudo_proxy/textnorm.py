# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Normalisation de texte : suppression des accents, casse, espaces."""
from __future__ import annotations

import re
import unicodedata

_WS = re.compile(r"\s+")


def unaccent(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def norm_key(text: str) -> str:
    """Clé insensible aux accents, à la casse et aux espaces multiples."""
    return _WS.sub(" ", unaccent(text).casefold().strip())


def compact_key(text: str) -> str:
    """Clé ne gardant que lettres et chiffres (identifiants, téléphones, IBAN)."""
    return re.sub(r"[^a-z0-9]", "", unaccent(text).casefold())


def is_title_case(token: str) -> bool:
    return len(token) >= 2 and token[0].isupper() and any(c.islower() for c in token[1:])


def is_all_caps(token: str) -> bool:
    letters = [c for c in token if c.isalpha()]
    return len(letters) >= 2 and all(c.isupper() for c in letters)
