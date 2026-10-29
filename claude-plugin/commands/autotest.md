---
description: Autotest du pseudonymiseur AxiorHub (24 contrôles) - à lancer avant de transmettre des pièces à une IA
allowed-tools: Bash(python:*), Bash(py:*)
---

Résultat de l'autotest du pseudonymiseur AxiorHub :

!`python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" selftest -v`

Rapporte la ligne « Autotest du pseudonymiseur : N contrôles sur 24 réussis » telle quelle.
- Si N = 24 : indique simplement que tout est en ordre.
- Sinon : écris en gras que l'utilisateur ne doit RIEN transmettre à une IA externe tant que l'autotest n'est pas rétabli, liste les contrôles en échec et conseille de prévenir l'auteur de l'outil.
