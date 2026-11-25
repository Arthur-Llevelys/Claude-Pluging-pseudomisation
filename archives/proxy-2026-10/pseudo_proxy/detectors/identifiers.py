# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Détecteurs d'identifiants structurés : e-mail, téléphone, IBAN, carte bancaire, NIR,
SIREN/SIRET, RPPS, RG, Portalis, sinistre, immatriculation, IP, URL, identifiant client,
nom d'utilisateur, date de naissance.

Chaque détecteur retourne des `Span`. Les numéros à clé ne sont retenus que si la clé est
valide (sauf le NIR, masqué même avec une clé fausse, sa structure étant très spécifique).
"""
from __future__ import annotations

import re
from typing import Callable

from ..textnorm import compact_key, norm_key
from ..validators import (
    card_is_valid,
    compact_iban,
    iban_is_valid,
    is_public_ip,
    nir_parse,
    rpps_is_valid,
    siren_is_valid,
    siret_is_valid,
)
from .base import DetectionContext, Span

# --------------------------------------------------------------------------- utilitaires

_CURRENCY_AFTER = re.compile(r"^\s{0,2}(€|euros?|EUR|%|\$|£|k€|M€)", re.IGNORECASE)
_CURRENCY_BEFORE = re.compile(r"(€|EUR|\$|£)\s{0,2}$")


def _money_context(text: str, start: int, end: int) -> bool:
    """Vrai si la suite de chiffres ressemble à un montant (devise avant ou après)."""
    return bool(_CURRENCY_AFTER.match(text[end : end + 8])) or bool(_CURRENCY_BEFORE.search(text[max(0, start - 4) : start]))


class RegexDetector:
    """Détecteur générique : une expression, un groupe de capture optionnel, un validateur."""

    def __init__(
        self,
        name: str,
        category: str,
        pattern: re.Pattern[str],
        priority: int,
        *,
        group: int | str = 0,
        validator: Callable[[str, str, int, int], bool] | None = None,
        keyfunc: Callable[[str], str] = compact_key,
    ):
        self.name = name
        self.category = category
        self.pattern = pattern
        self.priority = priority
        self.group = group
        self.validator = validator
        self.keyfunc = keyfunc

    def detect(self, text: str, ctx: DetectionContext) -> list[Span]:
        if not ctx.is_enabled(self.category):
            return []
        spans: list[Span] = []
        for m in self.pattern.finditer(text):
            start, end = m.span(self.group)
            if start < 0 or end <= start:
                continue
            value = text[start:end]
            if self.validator is not None and not self.validator(value, text, start, end):
                continue
            spans.append(
                Span(start, end, self.category, value, self.keyfunc(value), self.priority)
            )
        return spans


# --------------------------------------------------------------------------- e-mail
EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])")

# --------------------------------------------------------------------------- téléphone
PHONE_FR_RE = re.compile(
    r"(?<![\d\w+])(?:(?:\+|00)\s?33\s?[\s.-]?\(?0?\)?\s?[1-9](?:[\s.-]?\d{2}){4}|0[1-9](?:[\s.-]?\d{2}){4})(?![\d])"
)
PHONE_INTL_RE = re.compile(r"(?<![\d\w+])\+(?!33)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\d])")

# --------------------------------------------------------------------------- IBAN
# Autorise espaces, points, tirets et retours à la ligne à l'intérieur (IBAN coupé sur deux lignes).
IBAN_RE = re.compile(r"(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ \t\r\n.\-]{0,3}[A-Z0-9]){11,30}(?![A-Z0-9])")


def _iban_ok(value: str, text: str, start: int, end: int) -> bool:
    return iban_is_valid(value)


def _iban_key(value: str) -> str:
    return compact_iban(value).lower()


# --------------------------------------------------------------------------- carte bancaire
CARD_RE = re.compile(r"(?<![\d])(?:\d[ \-]?){12,18}\d(?![\d])")


def _card_ok(value: str, text: str, start: int, end: int) -> bool:
    digits = re.sub(r"\D", "", value)
    # Groupes réguliers (4-4-4-4, 4-6-5) ou bloc unique : on refuse les suites mal découpées.
    groups = re.split(r"[ \-]", value.strip())
    if len(groups) > 1 and any(len(g) not in (3, 4, 5, 6, 7) for g in groups):
        return False
    return card_is_valid(digits) and not _money_context(text, start, end)


# --------------------------------------------------------------------------- NIR
NIR_RE = re.compile(
    r"(?<![\dA-Z])([12])[ .\-]?(\d{2})[ .\-]?(\d{2})[ .\-]?(\d{2}|2[AB])[ .\-]?(\d{3})[ .\-]?(\d{3})(?:[ .\-]?(\d{2}))?(?![\dA-Z])"
)
NIR_CONTEXT_RE = re.compile(r"(s[ée]curit[ée]\s+sociale|\bNIR\b|n[°o]\s*SS\b|\bINSEE\b|num[ée]ro\s+de\s+s[ée]cu)", re.IGNORECASE)


def _nir_ok(value: str, text: str, start: int, end: int) -> bool:
    parsed = nir_parse(value)
    if parsed is None:
        return False
    body, key = parsed
    if key is not None:
        return True  # masqué même si la clé est fausse
    # 13 chiffres sans clé : uniquement avec un contexte explicite
    window = text[max(0, start - 60) : start]
    return bool(NIR_CONTEXT_RE.search(window))


def _nir_key(value: str) -> str:
    parsed = nir_parse(value)
    return parsed[0].lower() if parsed else compact_key(value)


# --------------------------------------------------------------------------- SIREN / SIRET
SIRET_RE = re.compile(r"(?<![\d])\d{3}[ .]?\d{3}[ .]?\d{3}[ .]?\d{5}(?![\d])")
SIREN_RE = re.compile(r"(?<![\d])\d{3}[ .]?\d{3}[ .]?\d{3}(?![\d])")


def _siret_ok(value: str, text: str, start: int, end: int) -> bool:
    return siret_is_valid(value) and not _money_context(text, start, end)


def _siren_ok(value: str, text: str, start: int, end: int) -> bool:
    if _money_context(text, start, end):
        return False
    seps = {c for c in value if not c.isdigit()}
    if len(seps) > 1:  # mélange de séparateurs : pas un SIREN
        return False
    return siren_is_valid(value)


# --------------------------------------------------------------------------- RPPS
RPPS_RE = re.compile(r"(?<![\d])(?:RPPS\W{0,8})?(\d{11})(?![\d])", re.IGNORECASE)


def _rpps_ok(value: str, text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 20) : start]
    if re.search(r"RPPS", before, re.IGNORECASE):
        return len(value) == 11
    return rpps_is_valid(value)


# --------------------------------------------------------------------------- RG / Portalis
RG_RE = re.compile(r"\bRG[^\n\d]{0,14}(\d{2}/\d{5})(?![\d])")
PORTALIS_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z]-[A-Z0-9]{3}-[A-Z0-9]{4,6})\b")

# --------------------------------------------------------------------------- sinistre
SINISTRE_RE = re.compile(
    r"sinistre\s*(?:n[°o]\s*|num[ée]ro\s*|r[ée]f(?:[ée]rence)?\.?\s*|:\s*|=\s*|#\s*)+([A-Z0-9][A-Z0-9/._\-]{3,24})(?![\w/.\-])",
    re.IGNORECASE,
)


def _has_digit(value: str, text: str, start: int, end: int) -> bool:
    return any(c.isdigit() for c in value) and not value.endswith((".", "/", "-"))


# --------------------------------------------------------------------------- immatriculation
SIV_RE = re.compile(r"\b([A-HJ-NP-TV-Z]{2})[\- ]?(\d{3})[\- ]?([A-HJ-NP-TV-Z]{2})\b")
FNI_RE = re.compile(r"immatricul\w*\W{0,12}(\d{1,4}\s?[A-Z]{2,3}\s?\d{2,3})\b", re.IGNORECASE)


def _siv_ok(value: str, text: str, start: int, end: int) -> bool:
    letters = re.sub(r"[^A-Z]", "", value)
    if letters.startswith("SS") or letters.endswith("SS"):
        return False
    # Sans séparateur ou avec tirets : fiable. Avec espaces : exige un contexte véhicule.
    if " " in value:
        window = text[max(0, start - 80) : start]
        return bool(re.search(r"(v[ée]hicule|voiture|immatricul|plaque|automobile|camion|moto)", window, re.IGNORECASE))
    return True


# --------------------------------------------------------------------------- IP
IPV4_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
IPV6_RE = re.compile(r"(?<![:\w])(?:[23][0-9A-Fa-f]{3}:(?:[0-9A-Fa-f]{0,4}:){1,6}[0-9A-Fa-f]{1,4})(?![:\w])")


def _ip_ok(value: str, text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 10) : start].lower()
    if re.search(r"(v|version|ver\.?)\s*$", before):
        return False
    return is_public_ip(value)


# --------------------------------------------------------------------------- URL
URL_RE = re.compile(r"\b(?:https?://|mailto:)[^\s<>\"'`)\]]+", re.IGNORECASE)
_URL_SENSITIVE_QUERY = re.compile(
    r"[?&](?:user(?:name|id)?|usr|login|e?mail|token|access_token|refresh_token|session(?:id)?|sid|id|uid|key|api_?key|code|phone|tel|name|nom|prenom|client(?:id)?|customer|account|compte|dossier|ref|signature|sig|auth)=",
    re.IGNORECASE,
)
_URL_SENSITIVE_PATH = re.compile(
    r"/(?:users?|utilisateurs?|clients?|customers?|profiles?|profil|members?|membres?|comptes?|accounts?|dossiers?|patients?|salari[ée]s?|candidats?|~)[/:][^/?#\s]+",
    re.IGNORECASE,
)
_URL_TOKEN_SEGMENT = re.compile(r"/[A-Za-z0-9_\-]{24,}(?=[/?#]|$)")


def _url_ok(value: str, text: str, start: int, end: int) -> bool:
    lower = value.lower()
    if lower.startswith("mailto:"):
        return True
    if "@" in value:
        return True
    if _URL_SENSITIVE_QUERY.search(value):
        return True
    path = re.sub(r"^https?://[^/]+", "", value, flags=re.IGNORECASE)
    if _URL_SENSITIVE_PATH.search(path):
        return True
    if _URL_TOKEN_SEGMENT.search(path.split("?")[0]):
        return True
    return False


# --------------------------------------------------------------------------- identifiant client
ID_CLIENT_RE = re.compile(
    r"\b(?:(?:n[°o]\.?|num[ée]ro|r[ée]f(?:[ée]rence)?\.?|id(?:entifiant)?|code)\s*(?:de\s+|du\s+|d[ue]\s+)?"
    r"(?:client|dossier|contrat|adh[ée]rent|assur[ée]|abonn[ée]|compte|soci[ée]taire|allocataire|patient|salari[ée]|membre|usager|affaire|police|facture|commande)"
    r"|(?:client|dossier|contrat|adh[ée]rent|assur[ée]|abonn[ée]|compte|soci[ée]taire|allocataire|patient|salari[ée]|membre|usager|affaire|police|facture|commande)\s*(?:n[°o]\.?|num[ée]ro|num\.?|#|r[ée]f\.?|id))"
    r"\s*(?:n[°o]\.?|:|=|#)?\s*([A-Z0-9][A-Z0-9/._\-]{3,24})(?![\w/.\-])",
    re.IGNORECASE,
)


def _id_client_ok(value: str, text: str, start: int, end: int) -> bool:
    if not any(c.isdigit() for c in value):
        return False
    if value.endswith((".", "/", "-")):
        return False
    # Un RG (23/01234) est traité par le détecteur RG.
    return not re.fullmatch(r"\d{2}/\d{5}", value)


# --------------------------------------------------------------------------- nom d'utilisateur
HANDLE_RE = re.compile(r"(?<![\w@.])@([A-Za-z][A-Za-z0-9_.]{2,30})(?![\w@])")
LOGIN_RE = re.compile(
    r"\b(?:identifiant|login|utilisateur|username|user ?name|user|pseudo|nom d['’]utilisateur|compte)\s*(?:de connexion)?\s*[:=]\s*([A-Za-z][A-Za-z0-9_.@\-]{2,40})(?![\w@])",
    re.IGNORECASE,
)
USER_PATH_RE = re.compile(r"(?:[A-Za-z]:)?[\\/](?:Users|Utilisateurs|home)[\\/]([^\\/\s\"'<>|:*?]{2,64})(?=[\\/\s\"'<>|]|$)")


def _handle_ok(value: str, text: str, start: int, end: int) -> bool:
    # @ suivi d'un mot : on écarte les décorateurs Python, mentions de type @Override, @media CSS.
    return value[0].islower() or value[0].isdigit() or "_" in value or "." in value


_PATH_USER_STOP = {"public", "default", "all users", "defaultuser", "defaultaccount", "shared", "administrateur", "administrator", "guest", "invité", "invite"}


def _path_user_ok(value: str, text: str, start: int, end: int) -> bool:
    return norm_key(value) not in _PATH_USER_STOP and not value.startswith(("$", "%", "{", "[", "<"))


# --------------------------------------------------------------------------- date de naissance
_MONTHS = r"(?:janv\.?|janvier|f[ée]v\.?|f[ée]vrier|mars|avr\.?|avril|mai|juin|juil\.?|juillet|ao[uû]t|sept?\.?|septembre|oct\.?|octobre|nov\.?|novembre|d[ée]c\.?|d[ée]cembre|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)"
BIRTHDATE_RE = re.compile(
    r"\b(?:n[ée]e?s?|naissance|birth(?:day|date)?|born|DDN|date de naissance|dob)\b[^\d\n]{0,25}?"
    r"(\d{1,2}(?:er)?[\s/.\-]+(?:\d{1,2}|" + _MONTHS + r")[\s/.\-]+\d{4}|\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)


def build_identifier_detectors() -> list[RegexDetector]:
    """Instancie tous les détecteurs d'identifiants, par ordre de priorité décroissante."""
    return [
        RegexDetector("url", "URL", URL_RE, 99, validator=_url_ok, keyfunc=lambda v: v.strip().rstrip("/").lower()),
        RegexDetector("iban", "IBAN", IBAN_RE, 100, validator=_iban_ok, keyfunc=_iban_key),
        RegexDetector("email", "EMAIL", EMAIL_RE, 98, keyfunc=lambda v: v.lower()),
        RegexDetector("nir", "NIR", NIR_RE, 97, validator=_nir_ok, keyfunc=_nir_key),
        RegexDetector("rg", "RG", RG_RE, 96, group=1),
        RegexDetector("portalis", "PORTALIS", PORTALIS_RE, 96, group=1, keyfunc=lambda v: v.upper()),
        RegexDetector("card", "CB", CARD_RE, 95, validator=_card_ok),
        RegexDetector("siv", "IMMATRICULATION", SIV_RE, 94, validator=_siv_ok, keyfunc=lambda v: re.sub(r"[^A-Z0-9]", "", v.upper())),
        RegexDetector("fni", "IMMATRICULATION", FNI_RE, 94, group=1, keyfunc=lambda v: re.sub(r"[^A-Z0-9]", "", v.upper())),
        RegexDetector("sinistre", "SINISTRE", SINISTRE_RE, 93, group=1, validator=_has_digit, keyfunc=lambda v: v.upper()),
        RegexDetector("rpps", "RPPS", RPPS_RE, 92, group=1, validator=_rpps_ok),
        RegexDetector("siret", "SIRET", SIRET_RE, 90, validator=_siret_ok),
        RegexDetector("birthdate", "DATE_NAISSANCE", BIRTHDATE_RE, 89, group=1),
        RegexDetector("phone_fr", "TEL", PHONE_FR_RE, 88),
        RegexDetector("phone_intl", "TEL", PHONE_INTL_RE, 87),
        RegexDetector("siren", "SIREN", SIREN_RE, 85, validator=_siren_ok),
        RegexDetector("id_client", "ID_CLIENT", ID_CLIENT_RE, 82, group=1, validator=_id_client_ok, keyfunc=lambda v: v.upper()),
        RegexDetector("ipv4", "IP", IPV4_RE, 75, validator=_ip_ok),
        RegexDetector("ipv6", "IP", IPV6_RE, 75, validator=_ip_ok, keyfunc=lambda v: v.lower()),
        RegexDetector("login", "UTILISATEUR", LOGIN_RE, 70, group=1, keyfunc=lambda v: v.lower()),
        RegexDetector("handle", "UTILISATEUR", HANDLE_RE, 70, group=1, validator=_handle_ok, keyfunc=lambda v: v.lower()),
        RegexDetector("user_path", "UTILISATEUR", USER_PATH_RE, 70, group=1, validator=_path_user_ok, keyfunc=lambda v: v.lower()),
    ]
