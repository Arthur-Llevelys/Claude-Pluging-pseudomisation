---
description: Arrête le proxy de pseudonymisation AxiorHub et vide sa table de correspondance
allowed-tools: Bash(python:*), Bash(py:*)
---

Arrête le proxy local de pseudonymisation AxiorHub :

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" stop
```

Rappelle ensuite à l'utilisateur que la table de correspondance (marqueurs -> valeurs réelles) n'existait qu'en mémoire et qu'elle est perdue à l'arrêt : les marqueurs encore présents dans la conversation Claude Code ne pourront plus être restitués.
