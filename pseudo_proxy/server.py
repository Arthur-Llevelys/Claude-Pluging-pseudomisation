# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Serveur FastAPI : proxy entre Claude Code (ANTHROPIC_BASE_URL) et https://api.anthropic.com.

- POST /v1/messages et /v1/messages/count_tokens : garde PDF -> pseudonymisation -> transfert
  -> restitution (réponse JSON ou flux SSE).
- Toute autre route est transmise telle quelle (OAuth, modèles, télémétrie...).
- /health et /api/* : API locale pour le plugin Claude Code et l'extension Chrome.

Si la pseudonymisation échoue, la requête ne part jamais vers l'API : une erreur 500 est
renvoyée à Claude Code.
"""
from __future__ import annotations

import hmac
import json
import logging
import time
from collections import Counter
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware

from . import __mention__, __version__
from .audit import Audit, setup_logging
from .config import Settings
from .engine import Pseudonymizer
from .pdf_guard import PdfGuardBlocked, guard_request
from .selftest import run_selftest
from .store import MappingStore
from .streaming import SSERestoreProcessor

log = logging.getLogger("pseudo_proxy.server")

_REQUEST_DROP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "x-axiorhub-token",
}
_RESPONSE_DROP = {"content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"}
_LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}


def api_error(status: int, error_type: str, message: str) -> JSONResponse:
    return JSONResponse({"type": "error", "error": {"type": error_type, "message": message}}, status_code=status)


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    setup_logging(settings)
    store = MappingStore(settings.mapping_ttl_seconds)
    pseudonymizer = Pseudonymizer(store, settings)
    audit = Audit(settings.audit_enabled)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        timeout = httpx.Timeout(connect=settings.connect_timeout, read=settings.upstream_timeout, write=60.0, pool=10.0)
        app.state.client = httpx.AsyncClient(base_url=settings.upstream_base_url, timeout=timeout, transport=transport, follow_redirects=False)
        log.info("%s v%s - proxy sur http://%s:%d -> %s", __mention__, __version__, settings.bind_host, settings.port, settings.upstream_base_url)
        try:
            yield
        finally:
            await app.state.client.aclose()

    app = FastAPI(title="AxiorHub Pseudonymisation Claude", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.store = store
    app.state.pseudonymizer = pseudonymizer
    app.state.audit = audit
    app.state.started_at = time.time()
    app.state.uvicorn_server = None

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=settings.api_cors_origin_regex,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type", "x-axiorhub-token"],
        allow_credentials=False,
    )

    # ------------------------------------------------------------------ aides
    def local_only(request: Request) -> JSONResponse | None:
        host = request.client.host if request.client else ""
        if host not in _LOOPBACK:
            return JSONResponse({"error": "API locale réservée à la machine hôte"}, status_code=403)
        if settings.api_token:
            given = request.headers.get("x-axiorhub-token", "")
            if not hmac.compare_digest(given, settings.api_token):
                return JSONResponse({"error": "jeton API invalide"}, status_code=403)
        return None

    async def read_body(request: Request) -> bytes | JSONResponse:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
            return api_error(413, "request_too_large", f"corps de requête > {settings.max_body_bytes} octets")
        body = await request.body()
        if len(body) > settings.max_body_bytes:
            return api_error(413, "request_too_large", f"corps de requête > {settings.max_body_bytes} octets")
        return body

    def upstream_headers(request: Request) -> dict[str, str]:
        return {k: v for k, v in request.headers.items() if k.lower() not in _REQUEST_DROP}

    def response_headers(upstream: httpx.Response, extra: dict[str, str]) -> dict[str, str]:
        headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _RESPONSE_DROP}
        headers.update(extra)
        return headers

    def target_url(request: Request) -> str:
        path = request.url.path
        return f"{path}?{request.url.query}" if request.url.query else path

    # ------------------------------------------------------------------ /v1/messages
    @app.post("/v1/messages")
    @app.post("/v1/messages/count_tokens")
    async def messages(request: Request):
        started = time.perf_counter()
        path = request.url.path
        is_count = path.endswith("/count_tokens")
        body = await read_body(request)
        if isinstance(body, JSONResponse):
            return body
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("objet JSON attendu")
        except ValueError as exc:
            return api_error(400, "invalid_request_error", f"JSON invalide : {exc}")

        stats: Counter = Counter()
        pdf_alerts = 0
        extra_headers: dict[str, str] = {}
        try:
            report = guard_request(payload, settings.pdf_guard_mode, settings.pdf_guard_max_bytes, audit)
            pdf_alerts = len(report.alerts)
            if report.severity:
                extra_headers["x-axiorhub-pdf-alert"] = report.severity
            stats = pseudonymizer.pseudonymize_request(payload)
        except PdfGuardBlocked as exc:
            audit.request(path, 422, stats, 0, len(exc.report.alerts), (time.perf_counter() - started) * 1000, False, "pdf_bloque")
            pages = ", ".join(str(a["page"]) for a in exc.report.alerts)
            return api_error(
                422,
                "axiorhub_pdf_blocked",
                f"AxiorHub : texte masqué détecté dans un PDF (page(s) {pages}). La requête n'a pas été transmise "
                f"(PSEUDO_PROXY_PDF_GUARD=block). Vérifiez la pièce avec : python -m pseudo_proxy pdf-check <fichier>.",
            )
        except Exception as exc:  # la requête ne doit pas partir si la pseudonymisation échoue
            log.exception("échec de la pseudonymisation : %s", exc.__class__.__name__)
            audit.request(path, 500, stats, 0, pdf_alerts, (time.perf_counter() - started) * 1000, False, "pseudonymisation")
            return api_error(500, "axiorhub_pseudonymization_error", "AxiorHub : la pseudonymisation a échoué, la requête n'a pas été transmise à l'API Claude.")

        extra_headers["x-axiorhub-replacements"] = str(sum(stats.values()))
        new_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        wants_stream = bool(payload.get("stream")) and not is_count
        client: httpx.AsyncClient = app.state.client
        req = client.build_request("POST", target_url(request), content=new_body, headers=upstream_headers(request))
        try:
            upstream = await client.send(req, stream=True)
        except httpx.TimeoutException:
            audit.request(path, 504, stats, 0, pdf_alerts, (time.perf_counter() - started) * 1000, wants_stream, "timeout_amont")
            return api_error(504, "api_error", "AxiorHub : délai dépassé vers l'API Claude.")
        except httpx.HTTPError as exc:
            audit.request(path, 502, stats, 0, pdf_alerts, (time.perf_counter() - started) * 1000, wants_stream, exc.__class__.__name__)
            return api_error(502, "api_error", f"AxiorHub : API Claude injoignable ({exc.__class__.__name__}).")

        content_type = upstream.headers.get("content-type", "")
        if "text/event-stream" in content_type and upstream.status_code == 200:
            processor = SSERestoreProcessor(pseudonymizer.restorer) if (settings.restore_enabled and not is_count) else None

            async def stream():
                try:
                    async for chunk in upstream.aiter_bytes():
                        yield processor.feed(chunk) if processor else chunk
                    if processor:
                        tail = processor.finish()
                        if tail:
                            yield tail
                finally:
                    await upstream.aclose()
                    restored = processor.restored if processor else 0
                    if restored:
                        store.record_restorations(restored)
                    audit.request(path, upstream.status_code, stats, restored, pdf_alerts, (time.perf_counter() - started) * 1000, True)

            return StreamingResponse(stream(), status_code=upstream.status_code, headers=response_headers(upstream, extra_headers), media_type=content_type)

        # Réponse non streamée
        try:
            raw = await upstream.aread()
        finally:
            await upstream.aclose()
        restored = 0
        if upstream.status_code == 200 and settings.restore_enabled and not is_count and "application/json" in content_type:
            try:
                data = json.loads(raw)
                if isinstance(data, dict):
                    restored = pseudonymizer.restore_response(data)
                    raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            except ValueError:
                pass
        audit.request(path, upstream.status_code, stats, restored, pdf_alerts, (time.perf_counter() - started) * 1000, False)
        return Response(content=raw, status_code=upstream.status_code, headers=response_headers(upstream, extra_headers), media_type=content_type or None)

    # ------------------------------------------------------------------ API locale
    @app.get("/health")
    async def health(request: Request):
        return {
            "status": "ok",
            "name": __mention__,
            "version": __version__,
            "uptime_seconds": int(time.time() - app.state.started_at),
            "mappings_alive": store.count_alive(),
            "restore_enabled": settings.restore_enabled,
            "pdf_guard_mode": settings.pdf_guard_mode,
            "api_token_required": bool(settings.api_token),
        }

    @app.get("/api/config")
    async def api_config(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        return settings.public_dict()

    @app.get("/api/stats")
    async def api_stats(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        return store.stats()

    @app.post("/api/pseudonymize")
    async def api_pseudonymize(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        body = await read_body(request)
        if isinstance(body, JSONResponse):
            return body
        try:
            data = json.loads(body)
            text = data["text"]
            if not isinstance(text, str):
                raise TypeError
        except Exception:
            return JSONResponse({"error": "attendu : {\"text\": \"...\"}"}, status_code=400)
        try:
            out, stats = pseudonymizer.pseudonymize_text(text)
        except Exception as exc:
            log.exception("échec de la pseudonymisation (API locale) : %s", exc.__class__.__name__)
            return JSONResponse({"error": "la pseudonymisation a échoué"}, status_code=500)
        result = {"text": out, "stats": dict(stats)}
        if data.get("include_mapping"):
            result["mapping"] = pseudonymizer.mapping_for(out)
        return result

    @app.post("/api/restore")
    async def api_restore(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        body = await read_body(request)
        if isinstance(body, JSONResponse):
            return body
        try:
            data = json.loads(body)
            text = data["text"]
            if not isinstance(text, str):
                raise TypeError
        except Exception:
            return JSONResponse({"error": "attendu : {\"text\": \"...\"}"}, status_code=400)
        out, n = pseudonymizer.restore_text(text)
        return {"text": out, "restored": n}

    @app.get("/api/mapping")
    async def api_mapping(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        return {"mapping": store.alive_mapping(), "ttl_seconds": settings.mapping_ttl_seconds}

    @app.get("/api/selftest")
    async def api_selftest(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        result = run_selftest()
        return result.as_dict()

    @app.post("/api/flush")
    async def api_flush(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        return {"flushed": store.flush()}

    @app.post("/api/shutdown")
    async def api_shutdown(request: Request):
        denied = local_only(request)
        if denied:
            return denied
        server = app.state.uvicorn_server
        if server is None:
            return JSONResponse({"error": "arrêt non disponible dans ce mode"}, status_code=501)
        server.should_exit = True
        return {"stopping": True}

    # ------------------------------------------------------------------ transfert transparent
    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def passthrough(request: Request, path: str):
        body = await read_body(request)
        if isinstance(body, JSONResponse):
            return body
        client: httpx.AsyncClient = app.state.client
        req = client.build_request(request.method, target_url(request), content=body or None, headers=upstream_headers(request))
        try:
            upstream = await client.send(req, stream=True)
        except httpx.TimeoutException:
            return api_error(504, "api_error", "AxiorHub : délai dépassé vers l'API Claude.")
        except httpx.HTTPError as exc:
            return api_error(502, "api_error", f"AxiorHub : API Claude injoignable ({exc.__class__.__name__}).")

        async def stream():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()

        log.debug("transfert transparent %s /%s -> %s", request.method, path, upstream.status_code)
        return StreamingResponse(stream(), status_code=upstream.status_code, headers=response_headers(upstream, {}), media_type=upstream.headers.get("content-type"))

    return app
