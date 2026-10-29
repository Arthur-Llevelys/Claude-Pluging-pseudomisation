# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Hook UserPromptSubmit : si Claude Code ne passe pas par le proxy, analyse localement le message
et bloque son envoi lorsqu'il contient des données personnelles.

Modes (variable AXIORHUB_PSEUDO_HOOK) : block (défaut), warn, off.
Le message n'est jamais journalisé ; seules les catégories et les comptes sont indiqués.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from axpseudo import ensure_importable  # noqa: E402

PORT = os.environ.get("PSEUDO_PROXY_PORT", "8080")
EXPECTED = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}


def proxy_alive(base: str) -> bool:
    try:
        with urllib.request.urlopen(base + "/health", timeout=1.5) as resp:  # noqa: S310 - adresse locale
            return json.loads(resp.read().decode("utf-8")).get("name", "").startswith("AxiorHub")
    except Exception:
        return False


def main() -> int:
    mode = os.environ.get("AXIORHUB_PSEUDO_HOOK", "block").strip().lower()
    if mode == "off":
        return 0
    base = os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/")
    if base in EXPECTED and proxy_alive(base):
        return 0  # le proxy pseudonymise : rien à faire

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    prompt = payload.get("prompt") or ""
    if not prompt.strip():
        return 0

    ensure_importable()
    try:
        from pseudo_proxy.config import Settings
        from pseudo_proxy.engine import Pseudonymizer
        from pseudo_proxy.store import MappingStore
    except ImportError:
        print(json.dumps({"systemMessage": "AxiorHub : paquet pseudo_proxy introuvable, contrôle du message impossible."}))
        return 0

    _, stats = Pseudonymizer(MappingStore(60), Settings()).pseudonymize_text(prompt)
    if not stats:
        return 0
    detail = ", ".join(f"{k}={v}" for k, v in sorted(stats.items()))
    reason = (
        f"AxiorHub : le proxy de pseudonymisation n'est pas actif pour cette session et votre message contient des "
        f"données personnelles ({detail}). Envoi bloqué. Lancez le proxy (python -m pseudo_proxy start) puis relancez "
        f"Claude Code avec ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT} (scripts/claude-pseudo.ps1). "
        "Pour désactiver ce blocage : AXIORHUB_PSEUDO_HOOK=warn ou off."
    )
    if mode == "warn":
        print(json.dumps({"systemMessage": reason.replace("Envoi bloqué.", "Avertissement : envoi en clair.")}, ensure_ascii=False))
        return 0
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
