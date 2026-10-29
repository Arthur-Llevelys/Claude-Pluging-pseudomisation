# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Validateurs à clé : IBAN (mod 97), Luhn (SIREN, SIRET, carte bancaire, RPPS), NIR, IP.

Vérifier la clé permet de reconnaître les numéros plus souvent (quels que soient les
espaces ou coupures) sans masquer n'importe quelle suite de chiffres.
"""
from __future__ import annotations

import ipaddress
import re

_NON_ALNUM = re.compile(r"[^A-Z0-9]")

#: Longueurs d'IBAN par pays (ISO 13616) pour les pays les plus fréquents.
IBAN_LENGTHS: dict[str, int] = {
    "AD": 24, "AE": 23, "AL": 28, "AT": 20, "AZ": 28, "BA": 20, "BE": 16, "BG": 22, "BH": 22,
    "BR": 29, "BY": 28, "CH": 21, "CR": 22, "CY": 28, "CZ": 24, "DE": 22, "DK": 18, "DO": 28,
    "EE": 20, "EG": 29, "ES": 24, "FI": 18, "FO": 18, "FR": 27, "GB": 22, "GE": 22, "GI": 23,
    "GL": 18, "GR": 27, "GT": 28, "HR": 21, "HU": 28, "IE": 22, "IL": 23, "IS": 26, "IT": 27,
    "JO": 30, "KW": 30, "KZ": 20, "LB": 28, "LC": 32, "LI": 21, "LT": 20, "LU": 20, "LV": 21,
    "MC": 27, "MD": 24, "ME": 22, "MK": 19, "MR": 27, "MT": 31, "MU": 30, "NL": 18, "NO": 15,
    "PK": 24, "PL": 28, "PS": 29, "PT": 25, "QA": 29, "RO": 24, "RS": 22, "SA": 24, "SE": 24,
    "SI": 19, "SK": 24, "SM": 27, "ST": 25, "SV": 28, "TL": 23, "TN": 24, "TR": 26, "UA": 29,
    "VA": 22, "VG": 24, "XK": 20,
}


def compact_iban(raw: str) -> str:
    return _NON_ALNUM.sub("", raw.upper())


def iban_is_valid(raw: str) -> bool:
    """Contrôle de structure et de clé (ISO 7064 mod 97-10)."""
    iban = compact_iban(raw)
    if not (15 <= len(iban) <= 34):
        return False
    if not (iban[:2].isalpha() and iban[2:4].isdigit()):
        return False
    expected = IBAN_LENGTHS.get(iban[:2])
    if expected is not None and len(iban) != expected:
        return False
    rearranged = iban[4:] + iban[:4]
    numeric = "".join(str(int(ch, 36)) for ch in rearranged)
    return int(numeric) % 97 == 1


def luhn_is_valid(digits: str) -> bool:
    digits = re.sub(r"\D", "", digits)
    if len(digits) < 2:
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = ord(ch) - 48
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def luhn_check_digit(partial: str) -> str:
    """Chiffre de contrôle Luhn à ajouter à `partial` (utile pour les tests)."""
    partial = re.sub(r"\D", "", partial)
    for d in "0123456789":
        if luhn_is_valid(partial + d):
            return d
    raise ValueError("impossible")  # pragma: no cover


def siren_is_valid(digits: str) -> bool:
    digits = re.sub(r"\D", "", digits)
    return len(digits) == 9 and luhn_is_valid(digits)


def siret_is_valid(digits: str) -> bool:
    """SIRET : Luhn sur 14 chiffres, sauf La Poste (356 000 000) : somme des chiffres multiple de 5."""
    digits = re.sub(r"\D", "", digits)
    if len(digits) != 14:
        return False
    if digits.startswith("356000000"):
        return sum(int(c) for c in digits) % 5 == 0
    return luhn_is_valid(digits)


def card_is_valid(digits: str) -> bool:
    """Carte bancaire : 13, 15, 16 ou 19 chiffres, premier chiffre 3 à 6, clé Luhn."""
    digits = re.sub(r"\D", "", digits)
    if len(digits) not in (13, 15, 16, 19):
        return False
    if digits[0] not in "3456":
        return False
    return luhn_is_valid(digits)


def rpps_is_valid(digits: str) -> bool:
    """RPPS : 11 chiffres commençant par 10, dernier chiffre clé Luhn."""
    digits = re.sub(r"\D", "", digits)
    return len(digits) == 11 and digits.startswith("10") and luhn_is_valid(digits)


_NIR_RE = re.compile(r"^([12])(\d{2})(\d{2})(\d{2}|2[AB])(\d{3})(\d{3})(\d{2})?$")


def nir_parse(raw: str) -> tuple[str, str | None] | None:
    """Retourne (13 caractères du NIR, clé ou None) si la structure est celle d'un NIR."""
    compact = re.sub(r"[\s.\-]", "", raw.upper())
    m = _NIR_RE.match(compact)
    if not m:
        return None
    sex, yy, mm, dept, commune, order, key = m.groups()
    month = int(mm)
    if not (1 <= month <= 12 or 20 <= month <= 42 or 50 <= month <= 99):
        return None
    if dept.isdigit():
        d = int(dept)
        if not (1 <= d <= 95 or 97 <= d <= 99):
            return None
    return sex + yy + mm + dept + commune + order, key


def nir_key(nir13: str) -> int:
    """Clé de contrôle du NIR : 97 - (NIR mod 97), avec 2A -> 19 et 2B -> 18 (Corse)."""
    body = nir13.upper()
    dept = body[5:7]
    if dept == "2A":
        body = body[:5] + "19" + body[7:]
    elif dept == "2B":
        body = body[:5] + "18" + body[7:]
    return 97 - (int(body) % 97)


def nir_key_is_valid(raw: str) -> bool:
    parsed = nir_parse(raw)
    if parsed is None or parsed[1] is None:
        return False
    return nir_key(parsed[0]) == int(parsed[1])


def is_public_ip(text: str) -> bool:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return False
    return ip.is_global and not ip.is_multicast
