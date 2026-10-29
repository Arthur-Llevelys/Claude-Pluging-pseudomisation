# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Hook SessionStart : vérifie que Claude Code passe bien par le proxy de pseudonymisation.

Sortie JSON (contexte ajouté pour Claude + message système affiché à l'utilisateur).
Ne contient jamais de donnée personnelle.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

PORT = os.environ.get("PSEUDO_PROXY_PORT", "8080")
EXPECTED = f"http://127.0.0.1:{PORT}"


def proxy_health(base: str) -> dict | None:
    try:
        with urllib.request.urlopen(base + "/health", timeout=1.5) as resp:  # noqa: S310 - adresse locale
            data = json.loads(resp.read().decode("utf-8"))
            return data if data.get("name", "").startswith("AxiorHub") else None
    except Exception:
        return None


def main() -> int:
    base = os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/")
    configured = base in {EXPECTED, EXPECTED.replace("127.0.0.1", "localhost")}
    health = proxy_health(base if configured else EXPECTED)

    if configured and health:
        msg = (
            f"AxiorHub Pseudonymisation : proxy actif (v{health.get('version')}), Claude Code passe par {base}. "
            f"Restitution {'activée' if health.get('restore_enabled') else 'désactivée'}, "
            f"{health.get('mappings_alive', 0)} correspondance(s) en mémoire."
        )
        context = (
            "Les données personnelles de cette session sont pseudonymisées par le proxy AxiorHub : conservez les marqueurs "
            "[PERSONNE_n], [EMAIL_n], [IBAN_n]... exactement tels quels dans vos réponses et fichiers ; ne cherchez jamais "
            "à deviner les valeurs réelles. Le proxy les restitue à l'utilisateur."
        )
        level = "ok"
    elif configured and not health:
        msg = (
            f"ATTENTION AxiorHub : ANTHROPIC_BASE_URL pointe vers {base} mais le proxy ne répond pas. "
            "Les appels à l'API vont échouer. Lancez : python -m pseudo_proxy start"
        )
        context = "Le proxy de pseudonymisation AxiorHub est configuré mais injoignable : signalez-le à l'utilisateur."
        level = "down"
    else:
        where = f"(un proxy AxiorHub répond pourtant sur {EXPECTED})" if health else "(aucun proxy AxiorHub actif)"
        msg = (
            f"ATTENTION AxiorHub : Claude Code n'utilise PAS le proxy de pseudonymisation {where}. "
            "Les données personnelles partiraient en clair vers l'API. Relancez Claude Code via scripts/claude-pseudo.ps1 "
            f'ou avec $env:ANTHROPIC_BASE_URL = "{EXPECTED}". Le hook de protection bloquera les messages contenant des données personnelles.'
        )
        context = (
            "Le proxy de pseudonymisation AxiorHub n'est pas utilisé dans cette session : rappelez à l'utilisateur de ne pas "
            "coller de données personnelles et proposez-lui de relancer Claude Code avec ANTHROPIC_BASE_URL configurée."
        )
        level = "off"

    out = {
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context},
    }
    if level != "ok":
        out["systemMessage"] = msg
    else:
        out["systemMessage"] = msg
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
