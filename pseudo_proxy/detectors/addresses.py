# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Détection des adresses postales : « 12 rue de la Paix, 75002 Paris », « 3 bis avenue Victor Hugo ».

Le nom de voie s'arrête au premier mot en minuscules qui n'est pas une particule, pour ne pas
avaler la suite de la phrase. Le code postal et la ville sont inclus lorsqu'ils suivent.
Un « code postal + ville » seul n'est pas masqué (information de juridiction utile).
"""
from __future__ import annotations

import re

from ..textnorm import norm_key
from .base import DetectionContext, Span

CATEGORY = "ADRESSE"
PRIORITY = 80

# Types de voie sans ambiguïté (acceptent un nom de voie tout en minuscules).
_SAFE_TYPES = (
    "rue", "avenue", "av", "bd", "boulevard", "chemin", "allée", "allee", "impasse", "quai", "route",
    "rte", "lieu-dit", "hameau", "résidence", "residence", "lotissement", "faubourg", "fbg",
    "esplanade", "rond-point", "chaussée", "chaussee", "ruelle", "venelle", "sentier", "traverse",
)
# Types ambigus (mots courants) : exigent un nom de voie commençant par une majuscule.
_AMBIGUOUS_TYPES = (
    "place", "pl", "cours", "square", "passage", "voie", "zone", "za", "zi", "zac", "promenade",
    "villa", "cité", "cite", "clos", "mail", "montée", "montee", "parvis", "domaine", "rampe", "ch",
)
_TYPES_ALT = "|".join(sorted((re.escape(t) for t in _SAFE_TYPES + _AMBIGUOUS_TYPES), key=len, reverse=True))

START_RE = re.compile(
    rf"(?<![\w])(\d{{1,4}}(?:\s?(?:bis|ter|quater|quinquies)|\s?[A-Da-d](?=\s))?)\s*,?\s*({_TYPES_ALT})\.?\s+",
    re.IGNORECASE,
)
_TOKEN_RE = re.compile(r"[^\s,;:()\[\]\"«»]+")
_PARTICLES = {
    "de", "du", "des", "la", "le", "les", "l'", "d'", "et", "aux", "au", "sur", "sous", "en", "à", "a",
    "saint", "sainte", "st", "ste", "général", "general", "maréchal", "marechal", "docteur", "dr",
    "président", "president", "commandant", "capitaine", "lieutenant", "abbé", "abbe", "père", "pere",
    "professeur", "pr", "mgr", "petit", "petite", "grand", "grande", "vieux", "vieille", "haut", "haute",
    "bas", "basse", "neuf", "neuve",
}
POSTCODE_CITY_RE = re.compile(
    r"\s*,?\s*(?:[-–]\s*)?(\d{5})\s+([A-ZÀ-Ö][A-Za-zÀ-ÿ'’\-]+(?:\s+(?:[A-ZÀ-Ö][A-Za-zÀ-ÿ'’\-]+|sur|sous|en|la|le|les|de|du|des|aux|lès))*)(?:\s+(?:CEDEX|Cedex)\s*\d{0,2})?"
)
_NOT_ADDRESS_BEFORE = re.compile(r"(article|art\.|al\.|alinéa|alinea|n°|§|page|p\.)\s*$", re.IGNORECASE)


def _is_particle(tok: str) -> bool:
    t = tok.lower().replace("’", "'")
    return t in _PARTICLES or (t.endswith("'") and t[:-1] in {"l", "d"})


class AddressDetector:
    name = "addresses"

    def detect(self, text: str, ctx: DetectionContext) -> list[Span]:
        if not ctx.is_enabled(CATEGORY):
            return []
        spans: list[Span] = []
        for m in START_RE.finditer(text):
            start = m.start(1)
            if _NOT_ADDRESS_BEFORE.search(text[max(0, start - 12) : start]):
                continue
            street_type = m.group(2).lower()
            pos = m.end()

            # Jetons successifs sur la même ligne, séparés par des espaces seulement.
            tokens: list[tuple[int, int, str]] = []
            scan = pos
            while len(tokens) < 8:
                tm = _TOKEN_RE.match(text, scan)
                if not tm:
                    break
                tokens.append((tm.start(), tm.end(), tm.group(0)))
                nxt = tm.end()
                while nxt < len(text) and text[nxt] in " \t":
                    nxt += 1
                if nxt == tm.end():
                    break
                scan = nxt

            kept: list[tuple[int, int, str]] = []
            for s, e, tok in tokens:
                core = tok.rstrip(".")
                if not core:
                    break
                if core[0].isupper() or core[0].isdigit() or _is_particle(core):
                    kept.append((s, s + len(core), core))
                else:
                    break
                if tok.endswith(".") and len(core) > 3:
                    break  # fin de phrase : « ... à Lyon. Jean habite »
            while kept and _is_particle(kept[-1][2]) and not kept[-1][2][0].isupper():
                kept.pop()

            if not kept:
                # Nom de voie tout en minuscules : accepté pour les types non ambigus (« 12 rue des lilas »).
                if street_type not in _SAFE_TYPES:
                    continue
                lower_tokens = tokens[:4]
                lower_tokens = [t for t in lower_tokens if re.fullmatch(r"[a-zà-ÿ'’\-]+", t[2])]
                if not lower_tokens:
                    continue
                # on s'arrête avant un verbe/adverbe fréquent de liaison
                stop_words = {"est", "sont", "a", "ont", "et", "ou", "mais", "donc", "pour", "par", "avec", "dans", "doit", "peut", "sera"}
                cut: list[tuple[int, int, str]] = []
                for t in lower_tokens:
                    if t[2] in stop_words and cut:
                        break
                    cut.append(t)
                kept = cut[:3]
                if not kept:
                    continue
            end = kept[-1][1]

            pc = POSTCODE_CITY_RE.match(text, end)
            if pc:
                end = pc.end()
            value = text[start:end].rstrip(" ,")
            end = start + len(value)
            if len(value) < 6:
                continue
            spans.append(Span(start, end, CATEGORY, value, norm_key(re.sub(r"[,\s]+", " ", value)), PRIORITY))
        return spans
