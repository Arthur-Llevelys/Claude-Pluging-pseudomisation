# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Ligne de commande : python -m pseudo_proxy <commande>.

serve       lance le proxy au premier plan
start       lance le proxy en arrière-plan (Windows) et attend qu'il réponde
stop        arrête un proxy lancé en arrière-plan
status      état du proxy (GET /health)
stats       statistiques d'audit (sans aucune valeur réelle)
selftest    autotest des 24 contrôles (sans serveur)
preview     affiche ce qui partirait vers Claude pour un texte (fichier ou entrée standard)
pdf-check   analyse un PDF et affiche le texte masqué repéré (en local uniquement)
flush       vide la table de correspondance
env         affiche la configuration à donner à Claude Code
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import __mention__, __version__
from .config import Settings


def _base_url(settings: Settings) -> str:
    host = "127.0.0.1" if settings.bind_host in {"0.0.0.0", "::", "localhost"} else settings.bind_host
    return f"http://{host}:{settings.port}"


def _headers(settings: Settings) -> dict[str, str]:
    return {"x-axiorhub-token": settings.api_token} if settings.api_token else {}


def _get(settings: Settings, path: str, timeout: float = 5.0):
    import httpx

    r = httpx.get(_base_url(settings) + path, headers=_headers(settings), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _post(settings: Settings, path: str, payload: dict | None = None, timeout: float = 10.0):
    import httpx

    r = httpx.post(_base_url(settings) + path, json=payload or {}, headers=_headers(settings), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _print_json(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _log_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_STATE_HOME") or str(Path.home())
    d = Path(base) / "AxiorHub" / "pseudo_proxy"
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------- commandes

def cmd_serve(args, settings: Settings) -> int:
    import uvicorn

    from .server import create_app

    if args.host:
        settings.bind_host = args.host
    if args.port:
        settings.port = args.port
    app = create_app(settings)
    config = uvicorn.Config(app, host=settings.bind_host, port=settings.port, log_level=settings.log_level.lower(), access_log=False)
    server = uvicorn.Server(config)
    app.state.uvicorn_server = server
    print(f"{__mention__} v{__version__}")
    print(f"Proxy : {_base_url(settings)}  ->  {settings.upstream_base_url}")
    print(f"Catégories : {', '.join(settings.enabled_categories())}")
    print(f"Restitution : {'activée' if settings.restore_enabled else 'désactivée'} | TTL : {settings.mapping_ttl_seconds}s | Garde PDF : {settings.pdf_guard_mode}")
    print("Dans Claude Code : ANTHROPIC_BASE_URL=" + _base_url(settings))
    server.run()
    return 0


def cmd_start(args, settings: Settings) -> int:
    try:
        info = _get(settings, "/health", timeout=2.0)
        print(f"Déjà en service : {info.get('name')} v{info.get('version')} sur {_base_url(settings)}")
        return 0
    except Exception:
        pass
    log_path = _log_dir() / "pseudo_proxy.log"
    cmd = [sys.executable, "-m", "pseudo_proxy", "serve"]
    child_env = os.environ.copy()
    child_env.setdefault("PYTHONUTF8", "1")  # journal en UTF-8 quelle que soit la page de codes Windows
    kwargs: dict = {"stdin": subprocess.DEVNULL, "cwd": os.getcwd(), "env": child_env}
    log_file = open(log_path, "ab")
    kwargs["stdout"] = log_file
    kwargs["stderr"] = subprocess.STDOUT
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:  # pragma: no cover
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **kwargs)
    for _ in range(50):
        time.sleep(0.2)
        try:
            info = _get(settings, "/health", timeout=1.0)
            print(f"Proxy démarré (PID {proc.pid}) : {info.get('name')} v{info.get('version')} sur {_base_url(settings)}")
            print(f"Journal : {log_path}")
            print("Dans Claude Code : ANTHROPIC_BASE_URL=" + _base_url(settings))
            return 0
        except Exception:
            if proc.poll() is not None:
                break
    print(f"Le proxy n'a pas démarré. Consultez le journal : {log_path}", file=sys.stderr)
    return 1


def cmd_stop(args, settings: Settings) -> int:
    try:
        _post(settings, "/api/shutdown")
        print("Arrêt demandé.")
        return 0
    except Exception as exc:
        print(f"Aucun proxy joignable sur {_base_url(settings)} ({exc.__class__.__name__}).", file=sys.stderr)
        return 1


def cmd_status(args, settings: Settings) -> int:
    try:
        info = _get(settings, "/health")
    except Exception as exc:
        print(f"Proxy injoignable sur {_base_url(settings)} ({exc.__class__.__name__}).")
        print("Démarrez-le avec : python -m pseudo_proxy start")
        return 1
    base = os.environ.get("ANTHROPIC_BASE_URL", "")
    info["claude_code_configured"] = base.rstrip("/") == _base_url(settings)
    info["ANTHROPIC_BASE_URL"] = base or "(non définie dans cet environnement)"
    _print_json(info)
    return 0


def cmd_stats(args, settings: Settings) -> int:
    try:
        _print_json(_get(settings, "/api/stats"))
        return 0
    except Exception as exc:
        print(f"Proxy injoignable ({exc.__class__.__name__}).", file=sys.stderr)
        return 1


def cmd_selftest(args, settings: Settings) -> int:
    from .selftest import run_selftest

    result = run_selftest()
    print(result.line)
    if args.verbose or not result.ok:
        for d in result.details:
            print(f"  {'OK ' if d['ok'] else 'KO '} {d['n']:>2}. {d['name']}" + ("" if d["ok"] else f" -> {d['detail']}"))
    if not result.ok:
        print("ATTENTION : ne transmettez rien à une IA externe et prévenez l'auteur de l'outil.", file=sys.stderr)
        return 1
    return 0


def cmd_preview(args, settings: Settings) -> int:
    from .engine import Pseudonymizer
    from .store import MappingStore

    if args.file:
        text = Path(args.file).read_text(encoding="utf-8", errors="replace")
    else:
        text = sys.stdin.read()
    ps = Pseudonymizer(MappingStore(settings.mapping_ttl_seconds), settings)
    out, stats = ps.pseudonymize_text(text)
    print(out)
    print("\n--- catégories détectées :", ", ".join(f"{k}={v}" for k, v in sorted(stats.items())) or "aucune", file=sys.stderr)
    return 0


def cmd_pdf_check(args, settings: Settings) -> int:
    from .pdf_guard import analyze_pdf

    data = Path(args.file).read_bytes()
    analysis = analyze_pdf(data)
    if analysis.error:
        print(f"Analyse impossible : {analysis.error}", file=sys.stderr)
        return 2
    if analysis.hidden_count == 0:
        print(f"Aucun texte masqué repéré ({len(analysis.pages)} page(s)).")
        return 0
    print(f"Texte masqué repéré : {analysis.hidden_count} fragment(s) sur {len(analysis.pages)} page(s).")
    if analysis.addressed_to_ai:
        print("ALERTE ÉLEVÉE : ce texte semble s'adresser à une IA (consignes cachées).")
    for page in analysis.pages:
        if not page.hidden_fragments:
            continue
        print(f"\n--- Page {page.number} : {', '.join(page.reasons)}")
        if args.show:
            for frag in page.hidden_fragments:
                print(f"  > {frag[:500]}")
    if not args.show:
        print("\nAjoutez --show pour afficher le texte masqué (en local uniquement).")
    return 1


def cmd_flush(args, settings: Settings) -> int:
    try:
        _print_json(_post(settings, "/api/flush"))
        return 0
    except Exception as exc:
        print(f"Proxy injoignable ({exc.__class__.__name__}).", file=sys.stderr)
        return 1


def cmd_env(args, settings: Settings) -> int:
    url = _base_url(settings)
    print("# PowerShell (session courante) :")
    print(f'$env:ANTHROPIC_BASE_URL = "{url}"')
    print("# PowerShell (permanent pour l'utilisateur) :")
    print(f'[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "{url}", "User")')
    print("# cmd.exe :")
    print(f"set ANTHROPIC_BASE_URL={url}")
    print("# bash :")
    print(f'export ANTHROPIC_BASE_URL="{url}"')
    print("# ~/.claude/settings.json :")
    print(json.dumps({"env": {"ANTHROPIC_BASE_URL": url}}, indent=2))
    return 0


# --------------------------------------------------------------------------- point d'entrée

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m pseudo_proxy", description=f"{__mention__} (v{__version__})")
    parser.add_argument("--env-file", help="fichier .env à charger (défaut : ./.env s'il existe)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("serve", help="lance le proxy au premier plan")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.set_defaults(func=cmd_serve)

    sub.add_parser("start", help="lance le proxy en arrière-plan").set_defaults(func=cmd_start)
    sub.add_parser("stop", help="arrête le proxy").set_defaults(func=cmd_stop)
    sub.add_parser("status", help="état du proxy").set_defaults(func=cmd_status)
    sub.add_parser("stats", help="statistiques d'audit").set_defaults(func=cmd_stats)

    p = sub.add_parser("selftest", help="autotest des 24 contrôles")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(func=cmd_selftest)

    p = sub.add_parser("preview", help="aperçu de ce qui part vers Claude")
    p.add_argument("file", nargs="?")
    p.set_defaults(func=cmd_preview)

    p = sub.add_parser("pdf-check", help="repère le texte masqué d'un PDF")
    p.add_argument("file")
    p.add_argument("--show", action="store_true", help="affiche le texte masqué")
    p.set_defaults(func=cmd_pdf_check)

    sub.add_parser("flush", help="vide la table de correspondance").set_defaults(func=cmd_flush)
    sub.add_parser("env", help="configuration à donner à Claude Code").set_defaults(func=cmd_env)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        settings = Settings.from_env(args.env_file)
    except ValueError as exc:
        print(f"Configuration invalide : {exc}", file=sys.stderr)
        return 2
    return args.func(args, settings)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
