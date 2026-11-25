# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Restitution en streaming : marqueurs coupés entre fragments, JSON d'outils, fin de bloc."""
from __future__ import annotations

import json

from pseudo_proxy.engine import StreamRestorer
from pseudo_proxy.streaming import SSERestoreProcessor


def test_stream_restorer_split_marker(engine):
    engine.pseudonymize_text("Jean Dupont")
    r = StreamRestorer(engine.restorer)
    out = r.feed("Bonjour [PER") + r.feed("SONNE_") + r.feed("1], bienvenue [") + r.flush()
    assert out == "Bonjour Jean Dupont, bienvenue ["


def test_stream_restorer_bracket_not_marker(engine):
    r = StreamRestorer(engine.restorer)
    out = r.feed("liste [a, b] et [note") + r.feed(" importante]") + r.flush()
    assert out == "liste [a, b] et [note importante]"


def test_stream_restorer_json_mode_escapes(engine):
    # IBAN coupé sur deux lignes : la valeur réelle contient un saut de ligne, qui doit être
    # échappé lorsqu'il est réinjecté dans un fragment de chaîne JSON (partial_json).
    value = "FR76 3000 6000 0112\n3456 7890 189"
    assert engine.pseudonymize_text(value)[0] == "[IBAN_1]"
    r = StreamRestorer(engine.restorer, json_string=True)
    out = r.feed('{"content": "IBAN [IB') + r.feed('AN_1]"}') + r.flush()
    assert out == '{"content": "IBAN FR76 3000 6000 0112\\n3456 7890 189"}'
    assert json.loads(out) == {"content": f"IBAN {value}"}


def _sse(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events).encode()


def _parse(raw: bytes):
    out = []
    for block in raw.decode().split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data:"):
                out.append(json.loads(line[5:].strip()))
    return out


def test_sse_processor_restores_across_events_and_flushes_on_stop(engine):
    engine.pseudonymize_text("Jean Dupont, jean@exemple.fr")
    events = [
        {"type": "message_start", "message": {"id": "m"}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Cher [PERSON"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "NE_1], votre mail [EMAIL_1] et [PERSONNE_"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t", "name": "write", "input": {}}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"content": "Cher [PERS'}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": 'ONNE_1]"}'}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_stop"},
    ]
    raw = _sse(events)
    proc = SSERestoreProcessor(engine.restorer)
    # découpage arbitraire des octets pour simuler le réseau
    chunks = [raw[i : i + 37] for i in range(0, len(raw), 37)]
    out = b"".join(proc.feed(c) for c in chunks) + proc.finish()
    parsed = _parse(out)
    texts = [e["delta"]["text"] for e in parsed if e["type"] == "content_block_delta" and e["index"] == 0]
    assert "".join(texts) == "Cher Jean Dupont, votre mail jean@exemple.fr et [PERSONNE_"
    jsons = [e["delta"]["partial_json"] for e in parsed if e["type"] == "content_block_delta" and e["index"] == 1]
    assert json.loads("".join(jsons)) == {"content": "Cher Jean Dupont"}
    # l'ordre des événements est préservé : le dernier est message_stop
    assert parsed[-1]["type"] == "message_stop"
    assert proc.restored == 3


def test_sse_processor_passthrough_unknown(engine):
    raw = b": ping\n\nevent: ping\ndata: {\"type\": \"ping\"}\n\n"
    proc = SSERestoreProcessor(engine.restorer)
    assert proc.feed(raw) + proc.finish() == raw
