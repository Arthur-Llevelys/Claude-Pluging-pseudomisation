# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Fixtures communes : moteur neuf, fabrique de PDF minimalistes."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pseudo_proxy.config import Settings  # noqa: E402
from pseudo_proxy.engine import Pseudonymizer  # noqa: E402
from pseudo_proxy.store import MappingStore  # noqa: E402


@pytest.fixture
def settings() -> Settings:
    return Settings()


@pytest.fixture
def store() -> MappingStore:
    return MappingStore(1800)


@pytest.fixture
def engine(store, settings) -> Pseudonymizer:
    return Pseudonymizer(store, settings)


def make_pdf(content: bytes, extra_objs: list[bytes] | None = None, resources_extra: bytes = b"") -> bytes:
    """Fabrique un PDF d'une page (Helvetica) avec le flux de contenu donné."""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> "
        + resources_extra
        + b" >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ] + (extra_objs or [])
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture
def pdf_factory():
    return make_pdf
