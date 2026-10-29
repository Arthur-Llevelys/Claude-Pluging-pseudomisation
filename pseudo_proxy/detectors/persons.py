# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Détection des personnes physiques.

Règles :
- « Paul DURAND », « DURAND Paul », « M. Paul Durand », « Jean Dupont » (prénom connu)
  reçoivent le même marqueur pour la même personne (clé = nom + prénom normalisés).
- Un « DURAND » seul reçoit le marqueur de la seule personne de ce nom ; s'il y a deux
  DURAND, le nom seul reçoit son propre marqueur (clé = nom sans prénom).
- « Maître DURAND » (ou Me) est une entité distincte, jamais rapprochée d'un homonyme et
  jamais comptée parmi les homonymes.
- Les sigles et termes du droit / de la paie (IDCC, SYNTEC, CSG, DRH, ECLI...) ne sont
  jamais pris pour des noms.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator

from ..lexicon import (
    CIVILITIES,
    LAWYER_CIVILITIES,
    NAME_PARTICLES,
    is_first_name,
    is_title_stopword,
    is_upper_stopword,
)
from ..store import Entity
from ..textnorm import is_all_caps, is_title_case, norm_key
from .base import DetectionContext, Span

CATEGORY = "PERSONNE"
PRIORITY_FULL = 60
PRIORITY_ALONE = 55

_UP = "A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ"
_LO = "a-zàâäçéèêëîïôöùûüÿæœß"

# Jeton en capitales (nom de famille) : DURAND, D'ARTAGNAN, SAINT-EXUPÉRY
_CAPS_TOKEN = rf"(?:[{_UP}]['’])?[{_UP}][{_UP}'’\-]*[{_UP}]"
# Jeton en casse de titre : Jean, Jean-Pierre, D'Arcy, O'Neil
_TITLE_TOKEN = rf"(?:[{_UP}]['’])?[{_UP}][{_LO}]+(?:-[{_UP}][{_LO}]+)*"
# Particules possibles entre les jetons d'un nom
_PARTICLE = r"(?:de|du|des|le|la|les|van|von|der|den|di|da|del|della|d['’]|l['’]|ben|bin|al|el|DE|DU|DES|LE|LA|LES|VAN|VON|DER|DEN|DI|DA|DEL|D['’]|L['’])"

_SURNAME_CAPS = rf"(?:{_PARTICLE}\s+)*{_CAPS_TOKEN}(?:(?:\s+{_PARTICLE})?[\s\-]{_CAPS_TOKEN}){{0,2}}"
_SURNAME_TITLE = rf"(?:{_PARTICLE}\s+)*{_TITLE_TOKEN}(?:(?:\s+{_PARTICLE})?\s{_TITLE_TOKEN}){{0,1}}"

_CIV_ALT = "|".join(sorted((re.escape(c) for c in CIVILITIES), key=len, reverse=True))
# Civilité suivie d'un ou plusieurs jetons de nom. Groupe 1 : civilité ; groupe 2 : nom complet.
CIVILITY_RE = re.compile(
    rf"(?<![\w{_UP}{_LO}])({_CIV_ALT})\s+((?:{_TITLE_TOKEN}\s+)*(?:{_SURNAME_CAPS}|{_SURNAME_TITLE}))(?![{_LO}{_UP}])"
)
# Prénom (casse de titre OU capitales) + NOM en capitales : « Paul DURAND », « PAUL DURAND »
FIRST_LAST_CAPS_RE = re.compile(
    rf"(?<![\w{_UP}{_LO}])((?:{_TITLE_TOKEN}|{_CAPS_TOKEN})(?:\s+{_TITLE_TOKEN})?)\s+({_SURNAME_CAPS})(?![{_LO}{_UP}])"
)
# NOM en capitales + Prénom : « DURAND Paul », « DURAND Jean-Pierre »
LAST_FIRST_RE = re.compile(
    rf"(?<![\w{_UP}{_LO}])({_SURNAME_CAPS})\s+({_TITLE_TOKEN}(?:\s+{_TITLE_TOKEN})?)(?![{_LO}{_UP}])"
)
# Prénom + Nom en casse de titre : « Jean Dupont », « Marie de La Fontaine »
FIRST_LAST_TITLE_RE = re.compile(
    rf"(?<![\w{_UP}{_LO}])({_TITLE_TOKEN}(?:\s+{_TITLE_TOKEN})?)\s+({_SURNAME_TITLE})(?![{_LO}{_UP}'’\-])"
)
# Jeton isolé candidat (capitales ou casse de titre)
ALONE_RE = re.compile(rf"(?<![\w{_UP}{_LO}'’\-])((?:{_PARTICLE}\s+)*(?:{_CAPS_TOKEN}|{_TITLE_TOKEN}))(?![{_LO}{_UP}'’\-])")

_SAINT_BEFORE = re.compile(r"(?:Saint|Sainte|St|Ste)[\s\-]$")


@dataclass(frozen=True)
class PersonMention:
    start: int
    end: int  # bornes du NOM (sans la civilité)
    surname: str  # forme d'origine
    firstname: str  # forme d'origine, éventuellement vide
    is_lawyer: bool


def _norm_surname(surname: str) -> str:
    return norm_key(surname.replace("’", "'"))


def _is_particle(tok: str) -> bool:
    t = tok.lower().replace("’", "'")
    return t in NAME_PARTICLES or (t.endswith("'") and t[:-1] in {"d", "l"})


def _bad_surname_token(tok: str) -> bool:
    core = tok.replace("’", "'").strip("'")
    if len(core) < 2:
        return True
    if is_all_caps(core) and is_upper_stopword(core):
        return True
    if is_title_case(core) and is_title_stopword(core):
        return True
    return False


def clean_surname(surname: str) -> str | None:
    """Coupe le nom au premier jeton interdit (sigle, mot du droit) ou au prénom qui ouvre un autre
    nom, puis retire les particules finales. Retourne None si rien d'exploitable ne reste.
    La coupe se fait toujours par la droite : le début de l'empan reste valable."""
    tokens = surname.split()
    kept: list[str] = []
    core_seen = 0
    for tok in tokens:
        if _is_particle(tok):
            kept.append(tok)
            continue
        if _bad_surname_token(tok):
            break
        # « Dupont Marie Martin » : un prénom après le premier jeton ouvre un autre nom
        if core_seen and is_title_case(tok.replace("’", "'").strip("'")) and is_first_name(tok):
            break
        kept.append(tok)
        core_seen += 1
    while kept and _is_particle(kept[-1]):
        kept.pop()
    if not kept or all(_is_particle(t) for t in kept):
        return None
    return " ".join(kept)


def _firstname_ok(firstname: str, allow_unknown: bool) -> bool:
    tokens = firstname.split()
    if not tokens:
        return False
    if is_first_name(tokens[0]):
        return True
    if allow_unknown:
        return all(is_title_case(t) and not is_title_stopword(t) for t in tokens)
    return False


def _split_after_civility(name: str) -> tuple[str, str]:
    """Sépare « Jean DUPONT » / « Jean Dupont » / « DUPONT » en (prénom, nom)."""
    tokens = name.split()
    if not tokens:
        return "", ""
    caps_idx = None
    for i, tok in enumerate(tokens):
        if is_all_caps(tok.replace("’", "'")) and not _is_particle(tok):
            caps_idx = i
            break
    if caps_idx is not None:
        j = caps_idx
        while j > 0 and _is_particle(tokens[j - 1]):
            j -= 1
        return " ".join(tokens[:j]), " ".join(tokens[j:])
    if len(tokens) >= 2 and is_first_name(tokens[0]):
        return tokens[0], " ".join(tokens[1:])
    return "", " ".join(tokens)


def _candidates(pattern: re.Pattern[str], text: str) -> Iterator[re.Match[str]]:
    """Candidats chevauchants : après chaque match, la recherche reprend un caractère plus loin,
    pour qu'un faux candidat (« Dossier de Jean ») ne masque pas le vrai (« Jean Dupont »)."""
    pos = 0
    while pos <= len(text):
        m = pattern.search(text, pos)
        if m is None:
            return
        yield m
        pos = m.start() + 1


class PersonDetector:
    name = "persons"

    # ------------------------------------------------------------------ passe 1 : noms complets
    def find_full_mentions(self, text: str, strict: bool) -> list[PersonMention]:
        mentions: list[PersonMention] = []
        taken: list[tuple[int, int]] = []

        def free(start: int, end: int) -> bool:
            return all(end <= s or start >= e for s, e in taken)

        def add(start: int, surname: str, firstname: str, is_lawyer: bool) -> None:
            cleaned = clean_surname(surname)
            if cleaned is None:
                return
            base = start + len(firstname) if firstname else start
            idx = text.find(cleaned, base)
            if idx < 0:
                return
            end = idx + len(cleaned)
            if not free(start, end):
                return
            mentions.append(PersonMention(start, end, cleaned, firstname, is_lawyer))
            taken.append((start, end))

        # 1. Civilité + nom (« M. Jean DUPONT », « Maître DURAND », « Madame Dupont »)
        for m in CIVILITY_RE.finditer(text):
            civ, name = m.group(1), m.group(2)
            is_lawyer = norm_key(civ) in LAWYER_CIVILITIES
            firstname, surname = _split_after_civility(name)
            if not surname:
                continue
            if firstname and not _firstname_ok(firstname, allow_unknown=True):
                continue
            add(m.start(2), surname, firstname, is_lawyer)

        # 2. Prénom + NOM en capitales (« Paul DURAND »)
        for m in _candidates(FIRST_LAST_CAPS_RE, text):
            firstname, surname = m.group(1), m.group(2)
            if _SAINT_BEFORE.search(text[max(0, m.start() - 7) : m.start()]):
                continue
            if not _firstname_ok(firstname, allow_unknown=False):
                continue
            add(m.start(), surname, firstname, False)

        # 3. NOM en capitales + Prénom (« DURAND Paul »)
        for m in _candidates(LAST_FIRST_RE, text):
            surname, firstname = m.group(1), m.group(2)
            if not _firstname_ok(firstname, allow_unknown=False):
                continue
            cleaned = clean_surname(surname)
            if cleaned is None or cleaned != surname:
                continue  # un sigle précède le prénom : pas un nom
            if not free(m.start(), m.end()):
                continue
            mentions.append(PersonMention(m.start(), m.end(), cleaned, firstname, False))
            taken.append((m.start(), m.end()))

        # 4. Prénom + Nom en casse de titre (« Jean Dupont »), hors mode strict
        if not strict:
            for m in _candidates(FIRST_LAST_TITLE_RE, text):
                firstname, surname = m.group(1), m.group(2)
                if _SAINT_BEFORE.search(text[max(0, m.start() - 7) : m.start()]):
                    continue
                if not _firstname_ok(firstname, allow_unknown=False):
                    continue
                add(m.start(), surname, firstname, False)

        mentions.sort(key=lambda x: x.start)
        return mentions

    # ------------------------------------------------------------------ enregistrement
    @staticmethod
    def register(text: str, mentions: list[PersonMention], ctx: DetectionContext) -> None:
        """Crée les entités des noms complets avant toute résolution de nom seul."""
        for m in mentions:
            if m.firstname:
                _get_or_create(ctx, m, value=text[m.start : m.end])

    # ------------------------------------------------------------------ détection complète
    def detect(self, text: str, ctx: DetectionContext) -> list[Span]:
        if not ctx.is_enabled(CATEGORY):
            return []
        spans: list[Span] = []
        mentions = self.find_full_mentions(text, ctx.strict_persons)
        covered: list[tuple[int, int]] = []

        for m in mentions:
            value = text[m.start : m.end]
            if m.firstname:
                ent = _get_or_create(ctx, m, value=value)
            else:
                ent = _resolve_surname_only(ctx, m, value=value)
            spans.append(Span(m.start, m.end, CATEGORY, value, ent.key, PRIORITY_FULL, dict(ent.meta)))
            covered.append((m.start, m.end))

        # Noms seuls : jetons correspondant à un nom de famille déjà connu.
        known = _known_surnames(ctx)
        if known:
            for m in ALONE_RE.finditer(text):
                s, e = m.start(1), m.end(1)
                if any(s < ce and cs < e for cs, ce in covered):
                    continue
                token = m.group(1)
                if _norm_surname(token) not in known:
                    continue
                if _SAINT_BEFORE.search(text[max(0, s - 7) : s]):
                    continue
                mention = PersonMention(s, e, token, "", False)
                ent = _resolve_surname_only(ctx, mention, value=token)
                spans.append(Span(s, e, CATEGORY, token, ent.key, PRIORITY_ALONE, dict(ent.meta)))
                covered.append((s, e))
        return spans


# --------------------------------------------------------------------------- aides

def _entity_key(surname: str, firstname: str, is_lawyer: bool) -> str:
    base = f"{_norm_surname(surname)}|{norm_key(firstname)}"
    return ("maitre|" + base) if is_lawyer else base


def _get_or_create(ctx: DetectionContext, m: PersonMention, value: str) -> Entity:
    key = _entity_key(m.surname, m.firstname, m.is_lawyer)
    meta = {"surname": _norm_surname(m.surname), "firstname": norm_key(m.firstname), "is_lawyer": m.is_lawyer}
    return ctx.store.get_or_create(CATEGORY, key, value, meta)


def _known_surnames(ctx: DetectionContext) -> set[str]:
    return {e.meta.get("surname", "") for e in ctx.store.find(CATEGORY, lambda e: bool(e.meta.get("surname")))}


def _resolve_surname_only(ctx: DetectionContext, m: PersonMention, value: str) -> Entity:
    """Nom sans prénom : rattache à l'unique personne de ce nom, sinon marqueur propre."""
    if m.is_lawyer:
        # « Maître DURAND » : entité propre, jamais rapprochée d'un homonyme.
        return _get_or_create(ctx, m, value)
    surname_key = _norm_surname(m.surname)
    candidates = ctx.store.find(
        CATEGORY,
        lambda e: e.meta.get("surname") == surname_key and e.meta.get("firstname") and not e.meta.get("is_lawyer"),
    )
    if len(candidates) == 1:
        ent = candidates[0]
        ctx.store.get_or_create(CATEGORY, ent.key, ent.value)  # rafraîchit le TTL
        return ent
    # 0 ou plusieurs homonymes : le nom seul reçoit son propre marqueur
    return _get_or_create(ctx, PersonMention(m.start, m.end, m.surname, "", False), value)
