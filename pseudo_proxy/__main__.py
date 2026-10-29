# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Point d'entrée : python -m pseudo_proxy <commande>."""
import sys

from .cli import main

sys.exit(main())
