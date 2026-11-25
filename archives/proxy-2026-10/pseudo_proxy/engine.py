# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Moteur : pseudonymisation d'un ensemble de textes et restitution des marqueurs.

Les marqueurs ont la forme [CATEGORIE_n]. La restitution tolère les variantes que peut
produire un modèle de langage : [PERSONNE 1], [PERSONNE-1], [PERSONNE\\_1] (échappement
Markdown), espaces intérieurs. Un marqueur inconnu ou expiré est laissé tel quel.
"""
from __future__ import annotations

import json
import re
from collections import Counter

from .config import ALL_CATEGORIES, Settings
from .detectors import DetectionContext, PersonDetector, build_detectors, resolve_overlaps
from .json_walker import collect_request_texts, collect_response_texts
from .store import MappingStore

MARKER_LABELS: frozenset[str] = frozenset(ALL_CATEGORIES)

#: Marqueur complet, variantes tolérées.
MARKER_RE = re.compile(r"\[\s*([A-Z][A-Z_\\]{1,30}?)\\?[ _\-](\d{1,6})\s*\]")
#: Début possible d'un marqueur (pour le streaming : on retient le fragment).
MARKER_PREFIX_RE = re.compile(r"\[\s*(?:[A-Z][A-Z_\\]{0,30}(?:\\?[ _\-]\d{0,6}\s*)?)?$")
MAX_PENDING = 48


def _label_of(raw: str) -> str | None:
    label = raw.replace("\\", "")
    return label if label in MARKER_LABELS else None


class Restorer:
    """Remplace les marqueurs par les valeurs réelles connues du store."""

    def __init__(self, store: MappingStore):
        self.store = store

    def restore(self, text: str, json_string: bool = False) -> tuple[str, int]:
        """Restitue dans un texte. json_string=True : le texte est l'intérieur d'une chaîne JSON
        (fragment `partial_json`), la valeur est donc échappée en conséquence."""
        if "[" not in text:
            return text, 0
        count = 0

        def repl(m: re.Match[str]) -> str:
            nonlocal count
            label = _label_of(m.group(1))
            if label is None:
                return m.group(0)
            marker = MappingStore.make_marker(label, int(m.group(2)))
            value = self.store.lookup_marker(marker)
            if value is None:
                return m.group(0)
            count += 1
            return json.dumps(value, ensure_ascii=False)[1:-1] if json_string else value

        return MARKER_RE.sub(repl, text), count

    def markers_in(self, text: str) -> dict[str, str]:
        """Marqueurs présents dans un texte -> valeur réelle (API locale uniquement)."""
        found: dict[str, str] = {}
        for m in MARKER_RE.finditer(text):
            label = _label_of(m.group(1))
            if label is None:
                continue
            marker = MappingStore.make_marker(label, int(m.group(2)))
            value = self.store.lookup_marker(marker)
            if value is not None:
                found[marker] = value
        return found


class StreamRestorer:
    """Restitution au fil de l'eau : retient un éventuel début de marqueur coupé entre deux fragments."""

    def __init__(self, restorer: Restorer, json_string: bool = False):
        self.restorer = restorer
        self.json_string = json_string
        self.pending = ""
        self.restored = 0

    def feed(self, chunk: str) -> str:
        buf = self.pending + chunk
        self.pending = ""
        if not buf:
            return ""
        idx = buf.rfind("[")
        if idx >= 0:
            tail = buf[idx:]
            if not MARKER_RE.fullmatch(tail) and MARKER_PREFIX_RE.fullmatch(tail) and len(tail) <= MAX_PENDING:
                self.pending = tail
                buf = buf[:idx]
        out, n = self.restorer.restore(buf, self.json_string)
        self.restored += n
        return out

    def flush(self) -> str:
        buf, self.pending = self.pending, ""
        if not buf:
            return ""
        out, n = self.restorer.restore(buf, self.json_string)
        self.restored += n
        return out


class Pseudonymizer:
    """Orchestration : détection -> résolution des chevauchements -> remplacement."""

    def __init__(self, store: MappingStore, settings: Settings):
        self.store = store
        self.settings = settings
        self.detectors = build_detectors()
        self.person_detector = next(d for d in self.detectors if isinstance(d, PersonDetector))
        self.restorer = Restorer(store)

    def _context(self) -> DetectionContext:
        return DetectionContext(
            store=self.store,
            enabled=frozenset(self.settings.enabled_categories()),
            strict_persons=self.settings.strict_person_detection,
        )

    # ------------------------------------------------------------------ pseudonymisation
    def pseudonymize_texts(self, texts: list[str]) -> tuple[list[str], Counter]:
        """Traite plusieurs textes d'une même requête avec une connaissance partagée des personnes."""
        ctx = self._context()
        if ctx.is_enabled("PERSONNE"):
            for text in texts:
                if text and len(text) >= 3:
                    mentions = self.person_detector.find_full_mentions(text, ctx.strict_persons)
                    self.person_detector.register(text, mentions, ctx)
        out: list[str] = []
        stats: Counter = Counter()
        for text in texts:
            new_text, counts = self._pseudonymize_one(text, ctx)
            out.append(new_text)
            stats.update(counts)
        if stats:
            self.store.record_replacements(stats)
        return out, stats

    def pseudonymize_text(self, text: str) -> tuple[str, Counter]:
        texts, stats = self.pseudonymize_texts([text])
        return texts[0], stats

    def _pseudonymize_one(self, text: str, ctx: DetectionContext) -> tuple[str, Counter]:
        if not text or len(text) < 3:
            return text, Counter()
        spans = []
        for detector in self.detectors:
            spans.extend(detector.detect(text, ctx))
        spans = resolve_overlaps(spans)
        if not spans:
            return text, Counter()
        parts: list[str] = []
        last = 0
        stats: Counter = Counter()
        for span in spans:
            entity = self.store.get_or_create(span.category, span.key, span.value, span.meta)
            parts.append(text[last : span.start])
            parts.append(entity.marker)
            last = span.end
            stats[span.category] += 1
        parts.append(text[last:])
        return "".join(parts), stats

    def pseudonymize_request(self, body: dict) -> Counter:
        """Pseudonymise en place une requête Messages. Retourne les compteurs par catégorie."""
        refs = collect_request_texts(body, tool_inputs=self.settings.pseudonymize_tool_inputs)
        if not refs:
            return Counter()
        texts = [ref.get() for ref in refs]
        new_texts, stats = self.pseudonymize_texts(texts)
        for ref, new_text in zip(refs, new_texts):
            if new_text != ref.get():
                ref.set(new_text)
        return stats

    # ------------------------------------------------------------------ restitution
    def restore_text(self, text: str) -> tuple[str, int]:
        out, n = self.restorer.restore(text)
        if n:
            self.store.record_restorations(n)
        return out, n

    def restore_response(self, body: dict) -> int:
        """Restitue en place dans une réponse Messages (non streamée). Retourne le nombre de restitutions."""
        total = 0
        for ref in collect_response_texts(body):
            new_text, n = self.restorer.restore(ref.get())
            if n:
                ref.set(new_text)
                total += n
        if total:
            self.store.record_restorations(total)
        return total

    def mapping_for(self, text: str) -> dict[str, str]:
        return self.restorer.markers_in(text)
