---
description: Vide la table de correspondance du proxy AxiorHub (les marqueurs en cours ne seront plus restitués)
allowed-tools: Bash(python:*), Bash(py:*)
---

Vide la table de correspondance du proxy AxiorHub :

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" flush
```

Indique le nombre d'entrées supprimées et rappelle que les marqueurs déjà présents dans la conversation ne pourront plus être restitués ; les nouveaux marqueurs continueront d'être numérotés sans réutiliser les anciens numéros.
