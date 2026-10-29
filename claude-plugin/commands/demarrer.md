---
description: Démarre le proxy de pseudonymisation AxiorHub en arrière-plan (127.0.0.1:8080)
allowed-tools: Bash(python:*), Bash(py:*)
---

Démarre le proxy local de pseudonymisation AxiorHub puis rends compte à l'utilisateur.

Exécute exactement cette commande :

```
python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" start
```

Puis indique à l'utilisateur, en français et en trois lignes maximum :
1. si le proxy est démarré (ou l'était déjà) et sur quelle adresse ;
2. que Claude Code ne passe par le proxy que s'il a été lancé avec `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` (script `scripts/claude-pseudo.ps1`), et que la session en cours doit être relancée si ce n'est pas le cas ;
3. où se trouve le journal en cas d'échec.

Ne reproduis jamais de donnée personnelle dans ta réponse.
