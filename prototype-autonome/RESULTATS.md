# Prototype — reconnaissance des noms par un petit modèle local (Ollama)

Mesure du 25 novembre 2026, sur 5 documents **entièrement fictifs** : 47 données à masquer, 49 éléments à
conserver (articles de loi, montants, juridictions, villes seules, mots courants…) et un texte sans aucune
donnée personnelle. Les règles sont, pour toutes les configurations, celles du serveur 1.1.0 ; seule change
la reconnaissance des noms sans indice formel (sans civilité ni « Prénom NOM »).

| Configuration | Fuites | Masquages à tort | Durée (5 documents) |
|---|---|---|---|
| Règles seules | 12 | 0 | — |
| Règles + spaCy `fr_core_news_lg` (serveur actuel) | 1 (« Altenor ») | 0 | — |
| Règles + `ministral-3:3b` (3,8 Md de paramètres, 2,8 Go), Ollama du serveur | 1 (« Pierre Petit ») | 0 | 5,7 s |
| Règles + `Qwen3-VL-4B` (4 Md, 2,6 Go), Ollama du serveur | **0** | **0** | 5,7 s |
| Règles + `qwen3.5:9b` (9,7 Md, 6,1 Go), Ollama du serveur | 0 | 0 | 15,9 s |
| Règles + `qwen3:8b` (8 Md, 5,2 Go), **sur le processeur du PC portable** | 0 | 0 | 147 s |
| idem avec l'accélération graphique Vulkan (Radeon 780M) | 0 | 0 | 214 s (plus lent) |

## Ce qu'on en retient

- **La qualité est au rendez-vous** : un modèle de 4 milliards de paramètres fait au moins aussi bien que spaCy
  sur ces exemples, sans aucun masquage à tort. Le modèle ne peut rien inventer : un nom qu'il propose n'est
  retenu que s'il figure mot pour mot dans le texte (3 propositions écartées sur 40 pour ministral-3).
- **La vitesse dépend de la machine** : environ 1 s par document sur le serveur, environ 30 s par document court
  avec un modèle de 8 milliards sur le seul processeur d'un portable. Un modèle de 4 milliards devrait diviser ce
  temps par deux environ (non mesuré en local : il faudrait télécharger le modèle, 2,8 Go).
  Pour un document de 20 pages sur un petit ordinateur, compter plusieurs minutes.
- **Garde-fous intégrés** dans `ner-ollama.js` : adresse Ollama locale ou du réseau privé uniquement ; modèles
  « cloud » d'Ollama refusés (ils enverraient le texte hors du poste — le serveur Ollama du cabinet en propose plusieurs).

## Point d'attention

- Faites écouter Ollama sur 127.0.0.1 (réglage par défaut) : `OLLAMA_HOST=0.0.0.0` l'exposerait à tout le réseau.

## Fichiers

- `ner-ollama.js` : reconnaissance des noms par Ollama (JavaScript, réutilisable tel quel dans l'extension).
- `pont_moteur.py` : passe les documents dans les règles du serveur 1.1.0 avec les propositions fournies.
- `mesurer.js` : la mesure ci-dessus. `node prototype-autonome/mesurer.js <adresse Ollama> <modèle>…`
- `exemple_noms.txt` : nouvel exemple fictif centré sur les noms sans civilité.

## Étape suivante proposée

Passer les règles du serveur en JavaScript dans l'extension (avec les listes `app/data`), y brancher
`ner-ollama.js`, garder la table de correspondance chiffrée sur le poste, et rendre le serveur facultatif
(réglage « Moteur : serveur du cabinet / local avec Ollama »). Les tests du serveur (`test_lot1.py`)
serviraient de référence pour vérifier que la version JavaScript détecte exactement la même chose.
