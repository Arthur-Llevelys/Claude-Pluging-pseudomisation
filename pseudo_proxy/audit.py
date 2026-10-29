# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Journal d'audit local : catégories détectées et nombre de remplacements, jamais les valeurs."""
from __future__ import annotations

import logging
import sys
from collections import Counter
from logging.handlers import RotatingFileHandler

from .config import Settings

_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def setup_logging(settings: Settings) -> None:
    root = logging.getLogger("pseudo_proxy")
    root.setLevel(getattr(logging, settings.log_level, logging.INFO))
    if root.handlers:
        return
    handler: logging.Handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(handler)
    if settings.log_file:
        fh = RotatingFileHandler(settings.log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        fh.setFormatter(logging.Formatter(_FORMAT))
        root.addHandler(fh)
    root.propagate = False


class Audit:
    """Trace une ligne par requête. Aucune donnée personnelle n'est jamais écrite."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.log = logging.getLogger("pseudo_proxy.audit")

    def request(
        self,
        path: str,
        status: int,
        replacements: Counter,
        restored: int,
        pdf_alerts: int,
        duration_ms: float,
        streamed: bool,
        error: str | None = None,
    ) -> None:
        if not self.enabled:
            return
        cats = " ".join(f"{k}={v}" for k, v in sorted(replacements.items())) or "-"
        self.log.info(
            "path=%s statut=%s flux=%s remplacements=%d [%s] restitutions=%d alertes_pdf=%d duree_ms=%.0f%s",
            path,
            status,
            "oui" if streamed else "non",
            sum(replacements.values()),
            cats,
            restored,
            pdf_alerts,
            duration_ms,
            f" erreur={error}" if error else "",
        )

    def pdf_alert(self, page: int, fragments: int, reasons: list[str], addressed_to_ai: bool) -> None:
        if not self.enabled:
            return
        level = "ELEVEE" if addressed_to_ai else "MODEREE"
        self.log.warning(
            "securite_ia alerte=%s page=%d fragments_masques=%d motifs=%s cible_ia=%s",
            level,
            page,
            fragments,
            ",".join(reasons),
            "oui" if addressed_to_ai else "non",
        )
