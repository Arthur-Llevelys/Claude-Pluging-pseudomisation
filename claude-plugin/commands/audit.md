---
description: Audit de la pseudonymisation - catégories détectées et nombre de remplacements, sans valeurs réelles
allowed-tools: Bash(python:*), Bash(py:*)
---

Statistiques d'audit du proxy AxiorHub (aucune valeur réelle, uniquement des catégories et des comptes) :

!`python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" stats`

Présente un tableau en français : catégorie, remplacements cumulés depuis le démarrage, correspondances actuellement en mémoire. Indique le total de restitutions et le TTL. N'invente aucune valeur.
