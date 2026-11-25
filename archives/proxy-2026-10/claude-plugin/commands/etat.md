---
description: État du proxy de pseudonymisation AxiorHub et de la configuration de Claude Code
allowed-tools: Bash(python:*), Bash(py:*)
---

État du proxy AxiorHub (sortie de `status`) :

!`python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" status`

Résume en français, en quelques lignes : le proxy répond-il, la restitution est-elle activée, combien de correspondances sont en mémoire, et surtout la valeur de `claude_code_configured` : si elle est fausse, explique que cette session de Claude Code n'envoie PAS ses requêtes au proxy et que les données personnelles partiraient en clair ; conseille de relancer Claude Code via `scripts/claude-pseudo.ps1`.
