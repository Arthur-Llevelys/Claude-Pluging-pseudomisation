# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Registre des détecteurs."""
from __future__ import annotations

from .addresses import AddressDetector
from .base import DetectionContext, Span, resolve_overlaps
from .companies import CompanyDetector
from .identifiers import build_identifier_detectors
from .persons import PersonDetector

__all__ = ["DetectionContext", "Span", "resolve_overlaps", "build_detectors", "PersonDetector"]


def build_detectors() -> list:
    """Tous les détecteurs. L'ordre n'a pas d'importance : les chevauchements sont résolus par priorité."""
    detectors: list = list(build_identifier_detectors())
    detectors.append(AddressDetector())
    detectors.append(CompanyDetector())
    detectors.append(PersonDetector())
    return detectors
