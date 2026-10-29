# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Table de correspondance marqueur <-> valeur réelle, en mémoire uniquement.

- Les entrées expirent après un TTL glissant (rafraîchi à chaque usage).
- Les compteurs ne sont jamais remis à zéro pendant la vie du processus : un marqueur
  expiré n'est jamais réattribué à une autre valeur, ce qui évite toute confusion.
- Rien n'est écrit sur disque. Les valeurs réelles ne sortent de ce module que par
  `lookup_marker` (restitution) et `alive_mapping` (API locale).
"""
from __future__ import annotations

import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Iterable


@dataclass
class Entity:
    category: str
    marker: str
    value: str  # première forme rencontrée : c'est elle qui est restituée
    key: str  # forme normalisée servant à reconnaître la même donnée
    expires_at: float
    meta: dict = field(default_factory=dict)
    forms: set[str] = field(default_factory=set)  # autres graphies rencontrées


class MappingStore:
    """Stockage thread-safe des correspondances, avec TTL glissant."""

    def __init__(self, ttl_seconds: int = 1800, clock: Callable[[], float] | None = None):
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds doit être strictement positif")
        self.ttl = float(ttl_seconds)
        self._clock = clock or time.monotonic
        self._lock = threading.RLock()
        self._by_key: dict[tuple[str, str], Entity] = {}
        self._by_marker: dict[str, Entity] = {}
        self._counters: Counter[str] = Counter()
        self.replacements: Counter[str] = Counter()  # statistiques cumulées, sans valeur
        self.restorations: int = 0
        self.created_at = time.time()

    # ------------------------------------------------------------------ interne
    def _now(self) -> float:
        return self._clock()

    def _purge_locked(self) -> None:
        now = self._now()
        expired = [k for k, ent in self._by_key.items() if ent.expires_at <= now]
        for k in expired:
            ent = self._by_key.pop(k)
            self._by_marker.pop(ent.marker, None)

    @staticmethod
    def make_marker(category: str, number: int) -> str:
        return f"[{category}_{number}]"

    # ------------------------------------------------------------------ API
    def purge(self) -> int:
        with self._lock:
            before = len(self._by_key)
            self._purge_locked()
            return before - len(self._by_key)

    def get(self, category: str, key: str) -> Entity | None:
        with self._lock:
            self._purge_locked()
            ent = self._by_key.get((category, key))
            if ent is not None:
                ent.expires_at = self._now() + self.ttl
            return ent

    def get_or_create(self, category: str, key: str, value: str, meta: dict | None = None) -> Entity:
        """Retourne l'entité existante (TTL rafraîchi) ou en crée une avec un nouveau numéro."""
        with self._lock:
            self._purge_locked()
            ent = self._by_key.get((category, key))
            now = self._now()
            if ent is None:
                self._counters[category] += 1
                marker = self.make_marker(category, self._counters[category])
                ent = Entity(
                    category=category,
                    marker=marker,
                    value=value,
                    key=key,
                    expires_at=now + self.ttl,
                    meta=dict(meta or {}),
                )
                self._by_key[(category, key)] = ent
                self._by_marker[marker] = ent
            else:
                ent.expires_at = now + self.ttl
                if value != ent.value:
                    ent.forms.add(value)
                if meta:
                    for k, v in meta.items():
                        ent.meta.setdefault(k, v)
            return ent

    def lookup_marker(self, marker: str) -> str | None:
        with self._lock:
            self._purge_locked()
            ent = self._by_marker.get(marker)
            if ent is None:
                return None
            ent.expires_at = self._now() + self.ttl
            return ent.value

    def find(self, category: str, predicate: Callable[[Entity], bool]) -> list[Entity]:
        with self._lock:
            self._purge_locked()
            return [e for (cat, _), e in self._by_key.items() if cat == category and predicate(e)]

    def record_replacements(self, counts: Iterable[tuple[str, int]] | Counter) -> None:
        with self._lock:
            if isinstance(counts, Counter):
                self.replacements.update(counts)
            else:
                for cat, n in counts:
                    self.replacements[cat] += n

    def record_restorations(self, n: int) -> None:
        with self._lock:
            self.restorations += n

    def alive_mapping(self) -> dict[str, str]:
        """Marqueur -> valeur réelle pour toutes les entrées vivantes (API locale uniquement)."""
        with self._lock:
            self._purge_locked()
            return {m: e.value for m, e in self._by_marker.items()}

    def count_alive(self) -> int:
        with self._lock:
            self._purge_locked()
            return len(self._by_key)

    def flush(self) -> int:
        """Vide la table (les compteurs ne sont pas réinitialisés)."""
        with self._lock:
            n = len(self._by_key)
            self._by_key.clear()
            self._by_marker.clear()
            return n

    def stats(self) -> dict:
        """Statistiques sans aucune valeur réelle."""
        with self._lock:
            self._purge_locked()
            alive_by_cat: Counter[str] = Counter(e.category for e in self._by_key.values())
            return {
                "alive": len(self._by_key),
                "alive_by_category": dict(alive_by_cat),
                "counters": dict(self._counters),
                "replacements": dict(self.replacements),
                "restorations": self.restorations,
                "ttl_seconds": int(self.ttl),
            }
