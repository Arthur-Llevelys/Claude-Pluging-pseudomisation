# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Proxy de bout en bout avec un faux amont (httpx.MockTransport) : en-têtes, pseudonymisation,
restitution JSON et SSE, count_tokens, limite de taille, échec de pseudonymisation, transfert
transparent, API locale."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from pseudo_proxy.config import Settings
from pseudo_proxy.server import create_app

REAL = "Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé."
PSEUDO = "[PERSONNE_1], [EMAIL_1], [TEL_1], doit être relancé."


class FakeUpstream:
    """Enregistre les requêtes reçues et renvoie la réponse configurée."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.mode = "json"

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v1/messages/count_tokens":
            return httpx.Response(200, json={"input_tokens": 42})
        if path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "claude-x"}]}, headers={"x-upstream": "1"})
        if path != "/v1/messages":
            return httpx.Response(404, json={"error": "nope"})
        body = json.loads(request.content)
        user_text = body["messages"][0]["content"]
        if self.mode == "sse":
            events = [
                {"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 1}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Reçu : [PERSON"}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "NE_1] / [EMAIL_1] / [TEL_1]"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}},
                {"type": "message_stop"},
            ]
            raw = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
            return httpx.Response(200, content=raw, headers={"content-type": "text/event-stream; charset=utf-8", "request-id": "req_1"})
        return httpx.Response(
            200,
            json={"id": "msg", "type": "message", "role": "assistant", "content": [{"type": "text", "text": f"Reçu : {user_text}"}], "stop_reason": "end_turn"},
            headers={"request-id": "req_1", "content-encoding": "identity"},
        )


@pytest.fixture
def upstream():
    return FakeUpstream()


@pytest.fixture
def client(upstream):
    settings = Settings(max_body_bytes=200_000)
    app = create_app(settings, transport=httpx.MockTransport(upstream.handler))
    with TestClient(app) as c:
        yield c


def _headers():
    return {"x-api-key": "sk-test", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", "content-type": "application/json", "host": "127.0.0.1:8080"}


def test_messages_json_roundtrip(client, upstream):
    r = client.post("/v1/messages?beta=true", json={"model": "claude-x", "max_tokens": 10, "messages": [{"role": "user", "content": REAL}]}, headers=_headers())
    assert r.status_code == 200
    # Ce qui est parti vers l'API est pseudonymisé
    sent = json.loads(upstream.requests[0].content)
    assert sent["messages"][0]["content"] == PSEUDO
    assert upstream.requests[0].url.path == "/v1/messages" and upstream.requests[0].url.query == b"beta=true"
    # Les en-têtes nécessaires sont conservés, l'hôte réécrit
    h = upstream.requests[0].headers
    assert h["x-api-key"] == "sk-test" and h["anthropic-version"] == "2023-06-01" and h["anthropic-beta"] == "prompt-caching-2024-07-31"
    assert h["host"] == "api.anthropic.com"
    # La réponse est restituée
    assert r.json()["content"][0]["text"] == f"Reçu : {REAL}"
    assert r.headers["x-axiorhub-replacements"] == "3"
    assert r.headers["request-id"] == "req_1"
    assert "content-encoding" not in r.headers


def test_messages_sse_roundtrip(client, upstream):
    upstream.mode = "sse"
    r = client.post("/v1/messages", json={"model": "claude-x", "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": REAL}]}, headers=_headers())
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    texts = []
    types = []
    for block in r.text.split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data:"):
                ev = json.loads(line[5:])
                types.append(ev["type"])
                if ev["type"] == "content_block_delta":
                    texts.append(ev["delta"]["text"])
    assert "".join(texts) == "Reçu : Jean Dupont / jean.dupont@email.fr / 06 12 34 56 78"
    assert types[0] == "message_start" and types[-1] == "message_stop"


def test_restore_disabled(upstream):
    app = create_app(Settings(restore_enabled=False), transport=httpx.MockTransport(upstream.handler))
    with TestClient(app) as c:
        r = c.post("/v1/messages", json={"model": "m", "max_tokens": 1, "messages": [{"role": "user", "content": REAL}]}, headers=_headers())
    assert r.json()["content"][0]["text"] == f"Reçu : {PSEUDO}"


def test_count_tokens_pseudonymized(client, upstream):
    r = client.post("/v1/messages/count_tokens", json={"model": "m", "messages": [{"role": "user", "content": REAL}]}, headers=_headers())
    assert r.status_code == 200 and r.json() == {"input_tokens": 42}
    assert json.loads(upstream.requests[0].content)["messages"][0]["content"] == PSEUDO


def test_body_too_large(upstream):
    app = create_app(Settings(max_body_bytes=100), transport=httpx.MockTransport(upstream.handler))
    with TestClient(app) as c:
        r = c.post("/v1/messages", content=b"x" * 500, headers=_headers())
    assert r.status_code == 413
    assert upstream.requests == []


def test_pseudonymization_failure_blocks_request(client, upstream, monkeypatch):
    def boom(body):
        raise RuntimeError("cassé")

    monkeypatch.setattr(client.app.state.pseudonymizer, "pseudonymize_request", boom)
    r = client.post("/v1/messages", json={"model": "m", "max_tokens": 1, "messages": [{"role": "user", "content": REAL}]}, headers=_headers())
    assert r.status_code == 500
    assert r.json()["error"]["type"] == "axiorhub_pseudonymization_error"
    assert upstream.requests == []  # rien n'est parti


def test_invalid_json(client, upstream):
    r = client.post("/v1/messages", content=b"{not json", headers=_headers())
    assert r.status_code == 400 and upstream.requests == []


def test_passthrough_other_routes(client, upstream):
    r = client.get("/v1/models", headers={"x-api-key": "sk"})
    assert r.status_code == 200 and r.json()["data"][0]["id"] == "claude-x" and r.headers["x-upstream"] == "1"
    assert upstream.requests[0].headers["x-api-key"] == "sk"


def test_upstream_unreachable():
    def fail(request):
        raise httpx.ConnectError("refused")

    app = create_app(Settings(), transport=httpx.MockTransport(fail))
    with TestClient(app) as c:
        r = c.post("/v1/messages", json={"model": "m", "max_tokens": 1, "messages": [{"role": "user", "content": "x"}]}, headers=_headers())
    assert r.status_code == 502 and r.json()["type"] == "error"


def test_local_api(client):
    assert client.get("/health").json()["status"] == "ok"
    r = client.post("/api/pseudonymize", json={"text": REAL, "include_mapping": True})
    assert r.status_code == 200
    data = r.json()
    assert data["text"] == PSEUDO and data["mapping"]["[PERSONNE_1]"] == "Jean Dupont"
    assert client.post("/api/restore", json={"text": PSEUDO}).json() == {"text": REAL, "restored": 3}
    assert client.get("/api/mapping").json()["mapping"]["[EMAIL_1]"] == "jean.dupont@email.fr"
    stats = client.get("/api/stats").json()
    assert stats["alive"] == 3 and stats["replacements"] == {"PERSONNE": 1, "EMAIL": 1, "TEL": 1}
    assert client.get("/api/selftest").json()["ok"] is True
    assert client.post("/api/flush").json() == {"flushed": 3}
    assert client.get("/api/stats").json()["alive"] == 0


def test_local_api_token(upstream):
    app = create_app(Settings(api_token="secret"), transport=httpx.MockTransport(upstream.handler))
    with TestClient(app) as c:
        assert c.get("/api/stats").status_code == 403
        assert c.get("/api/stats", headers={"x-axiorhub-token": "secret"}).status_code == 200
        assert c.get("/health").status_code == 200  # /health reste public (localhost)
