# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Lanceur du plugin : rend `pseudo_proxy` importable même sans `pip install -e .`.

Le paquet est cherché dans l'ordre : variable AXIORHUB_PSEUDO_HOME, dossier parent du plugin
(dépôt complet), puis l'environnement Python courant.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def locate_package_root() -> Path | None:
    candidates = []
    if os.environ.get("AXIORHUB_PSEUDO_HOME"):
        candidates.append(Path(os.environ["AXIORHUB_PSEUDO_HOME"]))
    plugin_root = Path(os.environ.get("CLAUDE_PLUGIN_ROOT") or Path(__file__).resolve().parents[1])
    candidates.append(plugin_root.parent)
    candidates.append(plugin_root)
    for cand in candidates:
        if (cand / "pseudo_proxy" / "__init__.py").is_file():
            return cand
    return None


def ensure_importable() -> None:
    root = locate_package_root()
    if root is not None and str(root) not in sys.path:
        sys.path.insert(0, str(root))


ensure_importable()

if __name__ == "__main__":
    try:
        from pseudo_proxy.cli import main
    except ImportError:
        print(
            "AxiorHub : le paquet pseudo_proxy est introuvable. Installez-le (pip install -e <dossier du projet>) "
            "ou définissez AXIORHUB_PSEUDO_HOME vers le dossier du projet.",
            file=sys.stderr,
        )
        sys.exit(2)
    sys.exit(main())
