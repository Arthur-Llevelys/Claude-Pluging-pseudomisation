# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
from pseudo_proxy.validators import (
    card_is_valid,
    iban_is_valid,
    is_public_ip,
    luhn_check_digit,
    luhn_is_valid,
    nir_key,
    nir_key_is_valid,
    rpps_is_valid,
    siren_is_valid,
    siret_is_valid,
)


def test_iban_mod97():
    assert iban_is_valid("FR76 3000 6000 0112 3456 7890 189")
    assert iban_is_valid("fr7630006000011234567890189")
    assert iban_is_valid("FR76 3000 6000 0112\n3456 7890 189")
    assert iban_is_valid("DE89 3704 0044 0532 0130 00")
    assert not iban_is_valid("FR76 3000 6000 0112 3456 7890 188")
    assert not iban_is_valid("FR76 3000 6000 0112 3456 7890")  # longueur FR incorrecte
    assert not iban_is_valid("1234567890123456")


def test_luhn():
    assert luhn_is_valid("4111111111111111")
    assert not luhn_is_valid("4111111111111112")
    assert luhn_check_digit("411111111111111") == "1"


def test_siren_siret():
    assert siren_is_valid("542 051 180")
    assert not siren_is_valid("542 051 181")
    siret = "5420511800001" + luhn_check_digit("5420511800001")
    assert siret_is_valid(siret)
    assert siret_is_valid("356 000 000 00056")  # La Poste : somme des chiffres multiple de 5
    assert not siret_is_valid("356 000 000 00048")
    assert not siret_is_valid("12345678901234")


def test_card():
    assert card_is_valid("4111 1111 1111 1111")
    assert card_is_valid("378282246310005")  # 15 chiffres
    assert not card_is_valid("1111111111111111")  # premier chiffre hors 3-6
    assert not card_is_valid("4111111111111112")


def test_rpps():
    rpps = "1000345678" + luhn_check_digit("1000345678")
    assert rpps_is_valid(rpps)
    assert not rpps_is_valid("20003456789")


def test_nir_key_and_corsica():
    nir13 = "1850578006084"
    k = nir_key(nir13)
    assert nir_key_is_valid(f"1 85 05 78 006 084 {k:02d}")
    assert not nir_key_is_valid(f"1 85 05 78 006 084 {(k + 1) % 97:02d}")
    corse = "29403" + "2A" + "123456"
    kc = nir_key(corse)
    assert nir_key_is_valid(f"2 94 03 2A 123 456 {kc:02d}")
    corse_b = "29403" + "2B" + "123456"
    assert nir_key_is_valid(f"294032B123456{nir_key(corse_b):02d}")


def test_public_ip():
    assert is_public_ip("8.8.8.8")
    assert not is_public_ip("192.168.1.10")
    assert not is_public_ip("10.0.0.1")
    assert not is_public_ip("127.0.0.1")
    assert not is_public_ip("999.1.1.1")
