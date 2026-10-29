# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Autotest du pseudonymiseur : 24 contrôles reproduisant les garanties annoncées.

La ligne attendue est « Autotest du pseudonymiseur : 24 contrôles sur 24 réussis ». Si elle
n'est pas obtenue, ne transmettez rien à une IA externe et prévenez l'auteur de l'outil.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .config import Settings
from .engine import Pseudonymizer
from .store import MappingStore
from .validators import luhn_check_digit, nir_key, nir_key_is_valid

TOTAL_EXPECTED = 24


@dataclass
class SelfTestResult:
    total: int
    passed: int
    failures: list[str] = field(default_factory=list)
    details: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.passed == self.total == TOTAL_EXPECTED

    @property
    def line(self) -> str:
        return f"Autotest du pseudonymiseur : {self.passed} contrôles sur {self.total} réussis"

    def as_dict(self) -> dict:
        return {"ok": self.ok, "total": self.total, "passed": self.passed, "line": self.line, "failures": self.failures, "details": self.details}


def _fresh() -> Pseudonymizer:
    return Pseudonymizer(MappingStore(1800), Settings())


def _check_roundtrip(ps: Pseudonymizer, text: str, expected: str) -> tuple[bool, str]:
    out, _ = ps.pseudonymize_text(text)
    if out != expected:
        return False, f"sortie inattendue : {out!r}"
    back, _ = ps.restore_text(out)
    if back != text:
        return False, "restitution différente de l'entrée"
    return True, "ok"


def _check_unchanged(ps: Pseudonymizer, text: str) -> tuple[bool, str]:
    out, _ = ps.pseudonymize_text(text)
    return (True, "ok") if out == text else (False, f"texte modifié : {out!r}")


def _checks() -> list[tuple[str, Callable[[], tuple[bool, str]]]]:
    nir13 = "1850578006084"
    k = nir_key(nir13)
    nir_corse13 = "29403" + "2A" + "123456"
    kc = nir_key(nir_corse13)
    siret = "5420511800001" + luhn_check_digit("5420511800001")
    rpps = "1000345678" + luhn_check_digit("1000345678")

    def c01():
        return _check_roundtrip(_fresh(), "Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé.", "[PERSONNE_1], [EMAIL_1], [TEL_1], doit être relancé.")

    def c02():
        return _check_roundtrip(_fresh(), "IBAN : FR76 3000 6000 0112 3456 7890 189, BIC AGRIFRPP", "IBAN : [IBAN_1], BIC AGRIFRPP")

    def c03():
        return _check_roundtrip(_fresh(), "Veuillez virer sur FR76 3000 6000 0112\n3456 7890 189 avant le 12/05/2024.", "Veuillez virer sur [IBAN_1] avant le 12/05/2024.")

    def c04():
        return _check_unchanged(_fresh(), "FR76 3000 6000 0112 3456 7890 188 n'est pas un IBAN valide")

    def c05():
        ps = _fresh()
        ok, msg = _check_roundtrip(ps, f"NIR 1 85 05 78 006 084 {k:02d} (clé valide)", "NIR [NIR_1] (clé valide)")
        if not ok:
            return ok, msg
        bad = (k + 1) % 97 or 1
        out, _ = _fresh().pseudonymize_text(f"NIR 1.85.05.78.006.084.{bad:02d} (clé fausse)")
        return (True, "ok") if out == "NIR [NIR_1] (clé fausse)" else (False, f"clé fausse non masquée : {out!r}")

    def c06():
        nir = f"2 94 03 2A 123 456 {kc:02d}"
        if not nir_key_is_valid(nir):
            return False, "clé Corse 2A non reconnue"
        return _check_roundtrip(_fresh(), f"Assurée {nir}", "Assurée [NIR_1]")

    def c07():
        return _check_roundtrip(_fresh(), "Immatriculée sous le 542 051 180 au RCS, capital 150 000 000 €.", "Immatriculée sous le [SIREN_1] au RCS, capital 150 000 000 €.")

    def c08():
        return _check_roundtrip(_fresh(), f"SIRET {siret[:3]} {siret[3:6]} {siret[6:9]} {siret[9:]}", "SIRET [SIRET_1]")

    def c09():
        return _check_roundtrip(_fresh(), "Carte 4111111111111111 exp 12/27", "Carte [CB_1] exp 12/27")

    def c10():
        return _check_unchanged(_fresh(), "L'article L. 1234-5 du Code du travail, l'audience du 12/05/2024, 1 500 000 € et 150 000 000 €, le 12 mai 2024.")

    def c11():
        return _check_unchanged(_fresh(), "IDCC 1486 SYNTEC, CSG/CRDS, PMSS, réduction Fillon, AGIRC-ARRCO, DSN, ECLI:FR:CCASS:2020:SO00123, la DRH a tranché.")

    def c12():
        out, _ = _fresh().pseudonymize_text("Paul DURAND a écrit. DURAND Paul a répondu.")
        return (True, "ok") if out == "[PERSONNE_1] a écrit. [PERSONNE_1] a répondu." else (False, out)

    def c13():
        out, _ = _fresh().pseudonymize_text("Paul DURAND a écrit. DURAND a signé.")
        return (True, "ok") if out == "[PERSONNE_1] a écrit. [PERSONNE_1] a signé." else (False, out)

    def c14():
        out, _ = _fresh().pseudonymize_text("Paul DURAND et Marie DURAND. DURAND a signé.")
        return (True, "ok") if out == "[PERSONNE_1] et [PERSONNE_2]. [PERSONNE_3] a signé." else (False, out)

    def c15():
        out, _ = _fresh().pseudonymize_text("Paul DURAND est assisté de Maître DURAND. DURAND a signé.")
        return (True, "ok") if out == "[PERSONNE_1] est assisté de Maître [PERSONNE_2]. [PERSONNE_1] a signé." else (False, out)

    def c16():
        return _check_roundtrip(_fresh(), "ZORVAL SAS assigne la société ZORVAL.", "[SOCIETE_1] SAS assigne la société [SOCIETE_1].")

    def c17():
        return _check_roundtrip(_fresh(), "Il demeure 12 rue de la Paix, 75002 Paris.", "Il demeure [ADRESSE_1].")

    def c18():
        return _check_roundtrip(_fresh(), "Né le 12/05/1980, audience du 12/05/2024.", "Né le [DATE_NAISSANCE_1], audience du 12/05/2024.")

    def c19():
        return _check_roundtrip(_fresh(), "RG n° 23/01234", "RG n° [RG_1]")

    def c20():
        return _check_roundtrip(_fresh(), "N° Portalis DBVX-V-B7F-ABCDE", "N° Portalis [PORTALIS_1]")

    def c21():
        return _check_roundtrip(_fresh(), f"RPPS {rpps}", "RPPS [RPPS_1]")

    def c22():
        return _check_roundtrip(_fresh(), "Sinistre n° SIN-2024-00123 concernant le véhicule AB-123-CD", "Sinistre n° [SINISTRE_1] concernant le véhicule [IMMATRICULATION_1]")

    def c23():
        return _check_roundtrip(_fresh(), "Depuis 8.8.8.8 et 192.168.1.10", "Depuis [IP_1] et 192.168.1.10")

    def c24():
        return _check_roundtrip(
            _fresh(),
            "Voir https://exemple.fr/users/jdupont?token=abc123 (client n° CL-889-X, @jdupont) et https://www.legifrance.gouv.fr/codes",
            "Voir [URL_1] (client n° [ID_CLIENT_1], @[UTILISATEUR_1]) et https://www.legifrance.gouv.fr/codes",
        )

    return [
        ("Exemple de référence : nom, e-mail, téléphone pseudonymisés puis restitués", c01),
        ("IBAN valide (clé mod 97) masqué", c02),
        ("IBAN coupé sur deux lignes masqué en entier", c03),
        ("IBAN à clé fausse laissé intact", c04),
        ("NIR avec espaces ou points masqué, même à clé fausse", c05),
        ("NIR Corse (2A) : clé reconnue et masqué", c06),
        ("SIREN reconnu par sa clé Luhn sans le mot SIREN, montant intact", c07),
        ("SIRET (Luhn 14 chiffres) masqué", c08),
        ("Carte bancaire écrite d'un bloc masquée", c09),
        ("Articles, dates et montants intacts", c10),
        ("Mots protégés (IDCC, SYNTEC, CSG/CRDS, PMSS, Fillon, AGIRC-ARRCO, DSN, ECLI, DRH) intacts", c11),
        ("« Paul DURAND » et « DURAND Paul » : même marqueur", c12),
        ("« DURAND » seul : marqueur de la seule personne de ce nom", c13),
        ("Deux DURAND : le nom seul reçoit son propre marqueur", c14),
        ("« Maître DURAND » jamais rapproché d'un homonyme", c15),
        ("« ZORVAL SAS » et « la société ZORVAL » : même société", c16),
        ("Adresse postale complète masquée", c17),
        ("Date de naissance masquée, autre date intacte", c18),
        ("Numéro RG masqué", c19),
        ("Numéro Portalis masqué", c20),
        ("Numéro RPPS masqué", c21),
        ("Numéro de sinistre et immatriculation masqués", c22),
        ("IP publique masquée, IP privée intacte", c23),
        ("URL avec identifiant, identifiant client et nom d'utilisateur masqués, URL publique intacte", c24),
    ]


def run_selftest() -> SelfTestResult:
    checks = _checks()
    result = SelfTestResult(total=len(checks), passed=0)
    for number, (name, fn) in enumerate(checks, start=1):
        try:
            ok, detail = fn()
        except Exception as exc:  # un contrôle qui plante est un contrôle échoué
            ok, detail = False, f"exception {exc.__class__.__name__}"
        result.details.append({"n": number, "name": name, "ok": ok, "detail": detail if not ok else "ok"})
        if ok:
            result.passed += 1
        else:
            result.failures.append(f"{number}. {name} : {detail}")
    return result
