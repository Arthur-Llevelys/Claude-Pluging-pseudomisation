---
description: Aperçu de ce qui part vers Claude pour un fichier donné (chemin en argument), pseudonymisé localement
allowed-tools: Bash(python:*), Bash(py:*)
argument-hint: <chemin du fichier texte>
---

Aperçu de la pseudonymisation du fichier `$ARGUMENTS` (calculé localement, seules les catégories et le texte pseudonymisé apparaissent) :

!`python "${CLAUDE_PLUGIN_ROOT}/scripts/axpseudo.py" preview "$ARGUMENTS"`

Montre à l'utilisateur le texte pseudonymisé tel qu'il partirait vers l'API, puis la liste des catégories détectées. Signale ce qui, à ta lecture, aurait dû être masqué et ne l'a pas été (sans jamais recopier une donnée personnelle en clair : décris-la par sa catégorie et sa position).
