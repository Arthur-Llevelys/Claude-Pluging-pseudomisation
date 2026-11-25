# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Types communs aux détecteurs : empan détecté et contexte de détection."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:  # pragma: no cover
    from ..store import MappingStore


@dataclass(frozen=True)
class Span:
    """Portion de texte à remplacer.

    start/end : bornes dans le texte d'origine (end exclu).
    category  : catégorie (PERSONNE, EMAIL, ...).
    value     : texte réel à restituer (= text[start:end] sauf cas particulier).
    key       : clé normalisée identifiant la même donnée sous d'autres graphies.
    priority  : en cas de chevauchement, l'empan de priorité la plus haute l'emporte,
                puis le plus long.
    meta      : informations non sensibles (ex. is_lawyer) stockées avec l'entité.
    """

    start: int
    end: int
    category: str
    value: str
    key: str
    priority: int = 50
    meta: dict = field(default_factory=dict, compare=False, hash=False)

    def __len__(self) -> int:
        return self.end - self.start

    def overlaps(self, other: "Span") -> bool:
        return self.start < other.end and other.start < self.end


@dataclass
class DetectionContext:
    """Contexte partagé par les détecteurs pendant le traitement d'une requête."""

    store: "MappingStore"
    enabled: frozenset[str]
    strict_persons: bool = False

    def is_enabled(self, category: str) -> bool:
        return category in self.enabled


class Detector(Protocol):
    name: str

    def detect(self, text: str, ctx: DetectionContext) -> list[Span]:  # pragma: no cover - protocole
        ...


def resolve_overlaps(spans: list[Span]) -> list[Span]:
    """Garde un ensemble d'empans disjoints : priorité la plus haute, puis le plus long."""
    ordered = sorted(spans, key=lambda s: (-s.priority, -(s.end - s.start), s.start))
    kept: list[Span] = []
    for span in ordered:
        if span.end <= span.start:
            continue
        if any(span.overlaps(k) for k in kept):
            continue
        kept.append(span)
    kept.sort(key=lambda s: s.start)
    return kept
