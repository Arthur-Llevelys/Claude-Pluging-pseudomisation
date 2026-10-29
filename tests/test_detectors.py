# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Détecteurs : personnes (homonymes, Maître), sociétés, adresses, identifiants à clé, mots protégés."""
from __future__ import annotations

import pytest

from pseudo_proxy.validators import luhn_check_digit, nir_key


def P(engine, text):
    return engine.pseudonymize_text(text)[0]


# --------------------------------------------------------------------------- personnes

def test_same_person_both_orders(engine):
    assert P(engine, "Paul DURAND a écrit. DURAND Paul a répondu.") == "[PERSONNE_1] a écrit. [PERSONNE_1] a répondu."


def test_surname_alone_links_to_unique_person(engine):
    assert P(engine, "Paul DURAND a écrit. DURAND a signé. Monsieur Durand est absent.") == (
        "[PERSONNE_1] a écrit. [PERSONNE_1] a signé. Monsieur [PERSONNE_1] est absent."
    )


def test_two_homonyms_surname_alone_gets_own_marker(engine):
    assert P(engine, "Paul DURAND et Marie DURAND. DURAND a signé.") == "[PERSONNE_1] et [PERSONNE_2]. [PERSONNE_3] a signé."


def test_lawyer_never_linked(engine):
    out = P(engine, "Paul DURAND est assisté de Maître DURAND. DURAND a signé. Me DURAND plaide.")
    assert out == "[PERSONNE_1] est assisté de Maître [PERSONNE_2]. [PERSONNE_1] a signé. Me [PERSONNE_2] plaide."


def test_civilities_and_roles(engine):
    out = P(engine, "Monsieur Jean DUPONT, Mme Dupont, M. le Président, Madame la Directrice, Me Paul Durand")
    assert out == "Monsieur [PERSONNE_1], Mme [PERSONNE_1], M. le Président, Madame la Directrice, Me [PERSONNE_2]"


def test_title_case_names(engine):
    out = P(engine, "Jean Dupont rencontre Marie Martin. Marine Nationale. Code Civil. Jean Jaurès.")
    assert out == "[PERSONNE_1] rencontre [PERSONNE_2]. Marine Nationale. Code Civil. [PERSONNE_3]."


def test_protected_words_not_persons(engine):
    text = "IDCC 1486 SYNTEC, CSG/CRDS, PMSS, réduction Fillon, AGIRC-ARRCO, DSN, ECLI:FR:CCASS:2020:SO00123, la DRH a tranché."
    assert P(engine, text) == text


def test_person_followed_by_acronym(engine):
    assert P(engine, "Paul DURAND ET Marie MARTIN") == "[PERSONNE_1] ET [PERSONNE_2]"


def test_known_person_across_requests(engine):
    P(engine, "Le client Paul DURAND.")
    assert P(engine, "DURAND conteste.") == "[PERSONNE_1] conteste."


# --------------------------------------------------------------------------- sociétés

def test_company_forms_and_introducers(engine):
    out = P(engine, "ZORVAL SAS assigne la société ZORVAL. La SCI Les Lilas et Zorval Industries SARL.")
    assert out == "[SOCIETE_1] SAS assigne la société [SOCIETE_1]. La SCI [SOCIETE_2] et [SOCIETE_3] SARL."


def test_company_leading_noise_trimmed(engine):
    assert P(engine, "Avocat de ZORVAL SAS") == "Avocat de [SOCIETE_1] SAS"


# --------------------------------------------------------------------------- adresses

def test_full_address_with_postcode(engine):
    assert P(engine, "Il demeure 12 rue de la Paix, 75002 Paris.") == "Il demeure [ADRESSE_1]."


def test_address_stops_at_sentence(engine):
    out = P(engine, "Il travaille 3 bis avenue Victor Hugo à Lyon. Jean habite 12 rue des lilas et travaille.")
    assert out == "Il travaille [ADRESSE_1]. Jean habite [ADRESSE_2] et travaille."


def test_article_number_not_address(engine):
    text = "article 3 place dans le code"
    assert P(engine, text) == text


# --------------------------------------------------------------------------- identifiants à clé

def test_iban_split_and_invalid(engine):
    assert P(engine, "FR76 3000 6000 0112\n3456 7890 189 fin") == "[IBAN_1] fin"
    bad = "FR76 3000 6000 0112 3456 7890 188 fin"
    assert P(engine, bad) == bad


def test_nir_variants(engine):
    k = nir_key("1850578006084")
    assert P(engine, f"1 85 05 78 006 084 {k:02d}") == "[NIR_1]"
    assert P(engine, f"1.85.05.78.006.084.{k:02d}") == "[NIR_1]"  # même NIR, même marqueur
    assert P(engine, "1-85-05-78-006-084-00") == "[NIR_1]"  # clé fausse : masqué quand même, même NIR
    kc = nir_key("29403" + "2A" + "123456")
    assert P(engine, f"2 94 03 2A 123 456 {kc:02d}") == "[NIR_2]"


def test_siren_siret_card_rpps(engine):
    siret = "5420511800001" + luhn_check_digit("5420511800001")
    rpps = "1000345678" + luhn_check_digit("1000345678")
    out = P(engine, f"SIREN 542 051 180, SIRET {siret}, carte 4111111111111111, RPPS {rpps}, capital 150 000 000 €")
    assert out == "SIREN [SIREN_1], SIRET [SIRET_1], carte [CB_1], RPPS [RPPS_1], capital 150 000 000 €"


def test_dates_amounts_articles_intact(engine):
    text = "L'article L. 1234-5 du Code du travail, l'audience du 12/05/2024, 1 500 000 € et 150 000 000 €, le 12 mai 2024."
    assert P(engine, text) == text


def test_birthdate_only_with_context(engine):
    assert P(engine, "Né le 12/05/1980, audience du 12/05/2024, née le 3 mars 1975.") == (
        "Né le [DATE_NAISSANCE_1], audience du 12/05/2024, née le [DATE_NAISSANCE_2]."
    )


def test_legal_references(engine):
    out = P(engine, "RG n° 23/01234 ; N° Portalis DBVX-V-B7F-ABCDE ; sinistre n° SIN-2024-00123 ; véhicule AB-123-CD")
    assert out == "RG n° [RG_1] ; N° Portalis [PORTALIS_1] ; sinistre n° [SINISTRE_1] ; véhicule [IMMATRICULATION_1]"


def test_phones(engine):
    assert P(engine, "Tél. +33 6 12 34 56 78, 01.23.45.67.89, +41 22 123 45 67") == "Tél. [TEL_1], [TEL_2], [TEL_3]"


def test_ip_url_user_client(engine):
    out = P(engine, r"Depuis 8.8.8.8 et 192.168.1.10 ; https://exemple.fr/users/jdupont?token=abc ; https://legifrance.gouv.fr/codes ; client n° CL-889-X ; @jdupont ; C:\Users\timo\x.txt")
    assert out == r"Depuis [IP_1] et 192.168.1.10 ; [URL_1] ; https://legifrance.gouv.fr/codes ; client n° [ID_CLIENT_1] ; @[UTILISATEUR_1] ; C:\Users\[UTILISATEUR_2]\x.txt"


@pytest.mark.parametrize(
    "text",
    [
        "La Cour de cassation a jugé le 3 mars 2021.",
        "Tribunal judiciaire de Paris, Pôle social.",
        "Montant : 1 234,56 € TTC, TVA 20 %.",
        "Articles 1240 et 1241 du Code civil.",
    ],
)
def test_legal_prose_untouched(engine, text):
    assert P(engine, text) == text
