# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Exemples de bout en bout : nom, e-mail, IBAN pseudonymisés puis restitués ; stabilité ; TTL ; listes."""
from __future__ import annotations

from pseudo_proxy.config import Settings
from pseudo_proxy.engine import Pseudonymizer
from pseudo_proxy.store import MappingStore


def test_reference_example(engine):
    text = "Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé."
    out, stats = engine.pseudonymize_text(text)
    assert out == "[PERSONNE_1], [EMAIL_1], [TEL_1], doit être relancé."
    assert dict(stats) == {"PERSONNE": 1, "EMAIL": 1, "TEL": 1}
    restored, n = engine.restore_text(out)
    assert restored == text
    assert n == 3


def test_name_email_iban_roundtrip(engine):
    text = "Virement de Marie Curie (marie.curie@exemple.org) vers FR76 3000 6000 0112 3456 7890 189."
    out, _ = engine.pseudonymize_text(text)
    assert "Marie Curie" not in out and "marie.curie" not in out and "3000 6000" not in out
    assert out == "Virement de [PERSONNE_1] ([EMAIL_1]) vers [IBAN_1]."
    assert engine.restore_text(out)[0] == text


def test_stable_markers_across_requests(engine):
    out1, _ = engine.pseudonymize_text("Contacter jean.dupont@email.fr.")
    out2, _ = engine.pseudonymize_text("Relancer JEAN.DUPONT@email.fr demain.")
    assert "[EMAIL_1]" in out1 and "[EMAIL_1]" in out2
    # la valeur restituée est la première forme rencontrée
    assert engine.restore_text("[EMAIL_1]")[0] == "jean.dupont@email.fr"


def test_counter_never_reused_after_expiry():
    clock = [0.0]
    store = MappingStore(60, clock=lambda: clock[0])
    engine = Pseudonymizer(store, Settings())
    out, _ = engine.pseudonymize_text("a@b.fr")
    assert out == "[EMAIL_1]"
    clock[0] = 120.0  # expiration
    assert store.count_alive() == 0
    assert engine.restore_text("[EMAIL_1]")[0] == "[EMAIL_1]"  # expiré : laissé tel quel
    out2, _ = engine.pseudonymize_text("c@d.fr")
    assert out2 == "[EMAIL_2]"  # jamais réattribué


def test_sliding_ttl_refresh():
    clock = [0.0]
    store = MappingStore(60, clock=lambda: clock[0])
    engine = Pseudonymizer(store, Settings())
    engine.pseudonymize_text("a@b.fr")
    clock[0] = 50.0
    engine.pseudonymize_text("a@b.fr")  # rafraîchit
    clock[0] = 100.0
    assert engine.restore_text("[EMAIL_1]")[0] == "a@b.fr"


def test_deny_list():
    settings = Settings(categories_deny={"TEL"})
    engine = Pseudonymizer(MappingStore(60), settings)
    out, _ = engine.pseudonymize_text("Jean Dupont, 06 12 34 56 78")
    assert out == "[PERSONNE_1], 06 12 34 56 78"


def test_allow_list():
    settings = Settings(categories_allow={"EMAIL"})
    engine = Pseudonymizer(MappingStore(60), settings)
    out, _ = engine.pseudonymize_text("Jean Dupont, jean@exemple.fr, 06 12 34 56 78")
    assert out == "Jean Dupont, [EMAIL_1], 06 12 34 56 78"


def test_restore_tolerates_llm_variants(engine):
    engine.pseudonymize_text("Jean Dupont et jean@exemple.fr")
    text = "Bonjour [PERSONNE 1], [PERSONNE-1], [PERSONNE\\_1], [ PERSONNE_1 ] et [EMAIL\\_1]. [TODO_1] reste."
    out, n = engine.restore_text(text)
    assert out == "Bonjour Jean Dupont, Jean Dupont, Jean Dupont, Jean Dupont et jean@exemple.fr. [TODO_1] reste."
    assert n == 5


def test_request_walk_system_messages_tool_result_and_tool_use(engine):
    body = {
        "model": "claude-x",
        "system": [{"type": "text", "text": "Dossier de Jean Dupont.", "cache_control": {"type": "ephemeral"}}],
        "messages": [
            {"role": "user", "content": "Appeler le 06 12 34 56 78."},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "Jean Dupont réfléchit", "signature": "sig"},
                    {"type": "tool_use", "id": "t1", "name": "write", "input": {"path": "x.txt", "content": "IBAN FR76 3000 6000 0112 3456 7890 189"}},
                ],
            },
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "ok jean.dupont@email.fr"}]}]},
        ],
        "metadata": {"user_id": "user_abc"},
    }
    stats = engine.pseudonymize_request(body)
    assert body["system"][0]["text"] == "Dossier de [PERSONNE_1]."
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert body["messages"][0]["content"] == "Appeler le [TEL_1]."
    assert body["messages"][1]["content"][0]["thinking"] == "Jean Dupont réfléchit"  # jamais modifié
    assert body["messages"][1]["content"][1]["input"]["content"] == "IBAN [IBAN_1]"
    assert body["messages"][2]["content"][0]["content"][0]["text"] == "ok [EMAIL_1]"
    assert body["metadata"] == {"user_id": "user_abc"}
    assert stats["PERSONNE"] == 1 and stats["IBAN"] == 1 and stats["EMAIL"] == 1 and stats["TEL"] == 1


def test_response_restore_text_and_tool_use(engine):
    engine.pseudonymize_text("Jean Dupont jean@exemple.fr")
    body = {
        "content": [
            {"type": "thinking", "thinking": "[PERSONNE_1]", "signature": "s"},
            {"type": "text", "text": "Courrier pour [PERSONNE_1] ([EMAIL_1])."},
            {"type": "tool_use", "id": "t", "name": "write", "input": {"content": "Cher [PERSONNE_1],"}},
        ]
    }
    n = engine.restore_response(body)
    assert n == 3
    assert body["content"][0]["thinking"] == "[PERSONNE_1]"
    assert body["content"][1]["text"] == "Courrier pour Jean Dupont (jean@exemple.fr)."
    assert body["content"][2]["input"]["content"] == "Cher Jean Dupont,"


def test_no_real_value_in_output_and_mapping_stays_local(engine):
    text = "Paul DURAND, FR76 3000 6000 0112 3456 7890 189, 1 85 05 78 006 084 91, 4111 1111 1111 1111"
    out, _ = engine.pseudonymize_text(text)
    for fragment in ("DURAND", "3000 6000", "006 084", "4111"):
        assert fragment not in out
    mapping = engine.mapping_for(out)
    assert set(mapping) == {"[PERSONNE_1]", "[IBAN_1]", "[NIR_1]", "[CB_1]"}
    assert engine.store.stats()["replacements"] == {"PERSONNE": 1, "IBAN": 1, "NIR": 1, "CB": 1}
