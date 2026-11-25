# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
from __future__ import annotations

import pytest

from pseudo_proxy.config import Settings
from pseudo_proxy.selftest import TOTAL_EXPECTED, run_selftest
from pseudo_proxy.store import MappingStore


def test_selftest_24_of_24():
    result = run_selftest()
    assert result.failures == []
    assert result.total == TOTAL_EXPECTED == result.passed
    assert result.line == "Autotest du pseudonymiseur : 24 contrôles sur 24 réussis"
    assert result.ok


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("PSEUDO_PROXY_BIND_HOST", "127.0.0.1")
    monkeypatch.setenv("PSEUDO_PROXY_PORT", "8099")
    monkeypatch.setenv("PSEUDO_PROXY_RESTORE", "false")
    monkeypatch.setenv("PSEUDO_PROXY_MAPPING_TTL_SECONDS", "600")
    monkeypatch.setenv("PSEUDO_PROXY_CATEGORIES_DENY", "tel, ip")
    monkeypatch.setenv("PSEUDO_PROXY_MAX_BODY_MB", "8")
    s = Settings.from_env()
    assert s.port == 8099 and s.restore_enabled is False and s.mapping_ttl_seconds == 600
    assert not s.category_enabled("TEL") and not s.category_enabled("IP") and s.category_enabled("EMAIL")
    assert s.max_body_bytes == 8 * 1024 * 1024
    assert "api_token" not in s.public_dict()


def test_settings_reject_unknown_category(monkeypatch):
    monkeypatch.setenv("PSEUDO_PROXY_CATEGORIES_ALLOW", "FOO")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_settings_reject_bad_pdf_mode(monkeypatch):
    monkeypatch.setenv("PSEUDO_PROXY_PDF_GUARD", "maybe")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_store_stats_have_no_values():
    store = MappingStore(60)
    store.get_or_create("EMAIL", "a@b.fr", "a@b.fr")
    stats = store.stats()
    assert "a@b.fr" not in repr(stats)
    assert stats["alive_by_category"] == {"EMAIL": 1}
