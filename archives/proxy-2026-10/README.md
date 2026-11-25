# AxiorHub Pseudonymisation Claude

**Créé par Timo RAINIO Avocat** · Licence [GNU AGPL v3 ou ultérieure](LICENSE) · Windows, Python 3.11+

Un proxy local qui se place entre **Claude Code** (ou **claude.ai** via l'extension Chrome) et l'API
Claude. Il remplace les données personnelles par des marqueurs stables avant l'envoi, puis remet les
vraies valeurs dans la réponse. La table de correspondance ne quitte jamais votre machine et n'est
jamais écrite sur disque.

```
Entrée (Claude Code)  : « Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé. »
Envoyé à l'API Claude : « [PERSONNE_1], [EMAIL_1], [TEL_1], doit être relancé. »
Réponse restituée     : « Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé. »
```

> **Avertissement.** Cet outil réduit l'exposition des données personnelles ; il ne constitue ni une
> anonymisation définitive ni une validation juridique RGPD. Voir [Limites](#limites-de-la-pseudonymisation)
> et [Avertissement](#avertissement).

---

## Sommaire

1. [Fonctionnement](#fonctionnement)
2. [Ce qui est pseudonymisé](#ce-qui-est-pseudonymisé)
3. [Installation](#installation)
4. [Lancement du proxy](#lancement-du-proxy)
5. [Configuration de Claude Code](#configuration-de-claude-code)
6. [Plugin Claude Code](#plugin-claude-code)
7. [Extension Chrome (claude.ai)](#extension-chrome-claudeai)
8. [Configuration (.env)](#configuration-env)
9. [Audit, autotest, garde PDF](#audit-autotest-garde-pdf)
10. [Exemple concret](#exemple-concret)
11. [Limites de la pseudonymisation](#limites-de-la-pseudonymisation)
12. [Avertissement](#avertissement)
13. [Arborescence et rôle de chaque fichier](#arborescence-et-rôle-de-chaque-fichier)
14. [Tests](#tests)
15. [Licence et mention](#licence-et-mention)

---

## Fonctionnement

```
 Claude Code ──ANTHROPIC_BASE_URL──▶  Proxy 127.0.0.1:8080  ──HTTPS──▶  api.anthropic.com
 claude.ai + extension Chrome ──▶  (pseudonymise → transfère → restitue)
```

1. Claude Code envoie ses requêtes `POST /v1/messages` au proxy au lieu de l'API.
2. Le proxy analyse tous les textes de la requête : `system`, messages utilisateur et assistant,
   résultats d'outils, arguments d'outils. Les blocs `thinking` ne sont jamais modifiés (signature).
3. Les PDF joints passent par le **garde PDF** : le texte caché (blanc sur blanc, ≤ 2 pt, hors page,
   invisible, transparent) est retiré avant lecture.
4. Chaque donnée détectée est remplacée par un marqueur stable (`[PERSONNE_1]`, `[IBAN_1]`…). La même
   valeur reçoit toujours le même marqueur ; un numéro n'est jamais réattribué.
5. La requête pseudonymisée part vers l'API avec les en-têtes d'origine (`x-api-key` ou
   `Authorization`, `anthropic-version`, `anthropic-beta`…).
6. La réponse (JSON ou flux SSE) est restituée : les marqueurs redeviennent les vraies valeurs, y compris
   lorsqu'un marqueur est coupé entre deux fragments du flux, et dans les arguments d'outils (le fichier
   que Claude Code écrit contient donc les vraies valeurs).
7. La correspondance vit en mémoire avec une durée de vie glissante (30 min par défaut). Si la
   pseudonymisation échoue, **la requête ne part pas**.

Toute autre route (`/v1/models`, OAuth, télémétrie…) est transmise telle quelle, pour que Claude Code
continue de fonctionner normalement.

## Ce qui est pseudonymisé

| Catégorie | Marqueur | Reconnaissance |
|---|---|---|
| Noms et prénoms | `[PERSONNE_n]` | « Paul DURAND », « DURAND Paul », « M. Paul Durand », « Jean Dupont » (prénom du lexique), civilités (M., Mme, Maître, Dr…). « DURAND » seul reçoit le marqueur de la seule personne de ce nom ; deux DURAND → le nom seul a son propre marqueur ; « Maître DURAND » n'est jamais rapproché d'un homonyme. |
| Sociétés | `[SOCIETE_n]` | « ZORVAL SAS », « la société ZORVAL », « SCI Les Lilas » : même marqueur pour les deux formes, la forme juridique reste lisible. |
| E-mails | `[EMAIL_n]` | Syntaxe standard, insensible à la casse. |
| Téléphones | `[TEL_n]` | Français (0X, +33, 0033, séparateurs variés) et internationaux. |
| Adresses postales | `[ADRESSE_n]` | « 12 rue de la Paix, 75002 Paris », « 3 bis avenue Victor Hugo ». Le nom de voie s'arrête au premier mot de liaison. |
| N° de Sécurité sociale (NIR) | `[NIR_n]` | Espaces, points ou tirets ; Corse 2A/2B. Masqué même si la clé est fausse ; 13 chiffres sans clé seulement avec contexte. |
| IBAN | `[IBAN_n]` | Clé mod 97 vérifiée, longueur par pays ; reconnu même coupé sur deux lignes. Un IBAN à clé fausse n'est pas masqué. |
| Cartes bancaires | `[CB_n]` | 13/15/16/19 chiffres, clé Luhn, d'un bloc ou par groupes. |
| SIREN / SIRET | `[SIREN_n]` / `[SIRET_n]` | Clé Luhn (règle La Poste pour le SIRET), sans besoin du mot « SIREN ». Montants (€) exclus. |
| Dates de naissance | `[DATE_NAISSANCE_n]` | Uniquement avec contexte (« né le », « naissance »…). Les autres dates restent intactes. |
| Identifiants clients | `[ID_CLIENT_n]` | « client n° », « dossier n° », « contrat », « adhérent », « police »… |
| URL avec identifiants | `[URL_n]` | Paramètres `token=`, `user=`, `email=`…, chemins `/users/<x>`, `/clients/<x>`, segments de jeton. Les URL publiques (Légifrance…) restent en clair. |
| Noms d'utilisateur | `[UTILISATEUR_n]` | `@pseudo`, « identifiant : x », `C:\Users\<nom>`, `/home/<nom>`. |
| IP publiques | `[IP_n]` | IPv4/IPv6 globales ; les plages privées (192.168…, 10…) et les numéros de version restent intacts. |
| N° RG | `[RG_n]` | « RG n° 23/01234 ». |
| N° Portalis | `[PORTALIS_n]` | « DBVX-V-B7F-ABCDE ». |
| N° RPPS | `[RPPS_n]` | 11 chiffres avec contexte « RPPS » ou clé Luhn. |
| N° de sinistre | `[SINISTRE_n]` | « sinistre n° SIN-2024-00123 ». |
| Immatriculations | `[IMMATRICULATION_n]` | SIV « AB-123-CD » ; avec espaces seulement en contexte véhicule ; ancien format avec contexte. |

Restent lisibles pour le raisonnement : articles de loi, dates, montants, et les termes protégés
IDCC, SYNTEC, CSG/CRDS, PMSS, réduction Fillon, AGIRC-ARRCO, DSN, ECLI, DRH… (liste dans
`pseudo_proxy/lexicon.py`).

## Installation

Prérequis : Windows 10/11, [Python 3.11 ou plus récent](https://www.python.org/downloads/windows/)
(cochez « Add python.exe to PATH »), Claude Code installé (`npm install -g @anthropic-ai/claude-code`).

```powershell
cd axiorhub-pseudo-claude
.\scripts\install.ps1
```

Le script crée `.venv`, installe les dépendances (`requirements.txt`), installe le paquet en mode
développement, copie `.env.example` vers `.env` et lance l'autotest. La ligne attendue est :

```
Autotest du pseudonymiseur : 24 contrôles sur 24 réussis
```

Installation manuelle équivalente :

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -e .
copy .env.example .env
python -m pseudo_proxy selftest
```

Si PowerShell refuse d'exécuter les scripts : `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Lancement du proxy

Au premier plan (Ctrl+C pour arrêter) :

```powershell
.\scripts\start-proxy.ps1
```

ou, dans l'environnement virtuel activé :

```powershell
python -m pseudo_proxy serve
```

En arrière-plan (journal dans `%LOCALAPPDATA%\AxiorHub\pseudo_proxy\pseudo_proxy.log`) :

```powershell
python -m pseudo_proxy start
python -m pseudo_proxy status
python -m pseudo_proxy stop
```

Autres commandes : `stats` (audit), `selftest`, `preview <fichier>`, `pdf-check <fichier.pdf> [--show]`,
`flush`, `env`.

## Configuration de Claude Code

Claude Code lit `ANTHROPIC_BASE_URL` au démarrage. Trois façons de la définir :

**1. Script tout-en-un (recommandé)** : démarre le proxy s'il ne tourne pas, définit la variable et
lance Claude Code dans la même fenêtre.

```powershell
.\scripts\claude-pseudo.ps1
```

**2. Variable d'environnement** :

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"      # session courante
claude
```

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://127.0.0.1:8080", "User")   # permanent
```

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"      # Git Bash / WSL
```

**3. Fichier `~/.claude/settings.json`** :

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080" } }
```

L'authentification est inchangée : clé API (`x-api-key`) ou connexion Claude.ai (`Authorization`)
sont transmises telles quelles. Vérifiez avec `python -m pseudo_proxy status` : la valeur
`claude_code_configured` doit être `true` dans la fenêtre où vous lancez Claude Code.

## Plugin Claude Code

Le plugin `claude-plugin/` ajoute à Claude Code :

| Élément | Rôle |
|---|---|
| `/axiorhub-pseudo:demarrer` | Démarre le proxy en arrière-plan. |
| `/axiorhub-pseudo:etat` | État du proxy et vérification que la session passe bien par lui. |
| `/axiorhub-pseudo:audit` | Catégories détectées et nombre de remplacements (jamais les valeurs). |
| `/axiorhub-pseudo:autotest` | Les 24 contrôles ; la ligne attendue est « 24 contrôles sur 24 réussis ». |
| `/axiorhub-pseudo:apercu <fichier>` | Ce qui partirait vers Claude pour ce fichier. |
| `/axiorhub-pseudo:pdf <fichier.pdf>` | Recherche de texte caché dans un PDF. |
| `/axiorhub-pseudo:purger`, `:arreter` | Vide la table ; arrête le proxy. |
| Hook `SessionStart` | Affiche un avertissement si la session n'utilise pas le proxy. |
| Hook `UserPromptSubmit` | Si la session n'utilise pas le proxy, analyse localement le message et **bloque** l'envoi s'il contient des données personnelles (`AXIORHUB_PSEUDO_HOOK=block` par défaut, `warn` ou `off`). |
| Skill `axiorhub-pseudonymisation` | Explique à Claude comment travailler avec les marqueurs (les conserver à l'identique, ne jamais deviner les valeurs). |

Installation pour un essai :

```powershell
claude --plugin-dir .\claude-plugin
```

Installation durable via la place de marché locale fournie (`.claude-plugin/marketplace.json`),
dans Claude Code :

```
/plugin marketplace add C:\chemin\vers\axiorhub-pseudo-claude
/plugin install axiorhub-pseudo@axiorhub
```

Les scripts du plugin trouvent le paquet `pseudo_proxy` dans le dossier parent du plugin ou via la
variable `AXIORHUB_PSEUDO_HOME` ; avec `pip install -e .`, il est trouvé partout.

## Extension Chrome (claude.ai)

L'extension `chrome-extension/` applique la même pseudonymisation aux messages saisis sur
**claude.ai**, en s'appuyant sur le proxy local (elle ne parle qu'à `127.0.0.1`).

- À l'envoi d'un message, le texte saisi et les textes collés en pièce jointe sont pseudonymisés via
  `POST /api/pseudonymize` ; un bandeau indique le nombre de données masquées.
- La réponse en flux est restituée à la volée ; l'historique rechargé est restitué tant que la table
  est en mémoire (TTL).
- **Mode strict** (par défaut) : si le proxy est injoignable, le message **n'est pas envoyé**.
- Popup : état, interrupteur, « Aperçu de ce qui part », bouton Autotest (ligne verte « 24 contrôles
  sur 24 réussis » ; orange sinon : ne transmettez rien à une IA externe), audit par catégorie.
- Réglages : port, jeton (`PSEUDO_PROXY_API_TOKEN`), mode strict, restitution.

Installation : `chrome://extensions` → activer le **Mode développeur** → **Charger l'extension non
empaquetée** → choisir le dossier `chrome-extension`. Le proxy doit tourner (`python -m pseudo_proxy start`).

Limites propres à l'extension : les **fichiers joints** (PDF, images, documents) ne sont pas
pseudonymisés ; l'interception repose sur les adresses internes de claude.ai (`…/completion`), qui
peuvent changer ; la table de correspondance utilisée pour l'affichage est chargée dans l'onglet
claude.ai (sur votre machine).

## Configuration (.env)

Toutes les variables sont facultatives (voir `.env.example`).

| Variable | Défaut | Rôle |
|---|---|---|
| `PSEUDO_PROXY_BIND_HOST` | `127.0.0.1` | Adresse d'écoute. Autre valeur = joignable depuis le réseau : à protéger. |
| `PSEUDO_PROXY_PORT` | `8080` | Port d'écoute. |
| `PSEUDO_PROXY_UPSTREAM_URL` | `https://api.anthropic.com` | API cible. |
| `PSEUDO_PROXY_UPSTREAM_TIMEOUT` / `_CONNECT_TIMEOUT` | `600` / `10` | Délais (s) vers l'API. |
| `PSEUDO_PROXY_MAX_BODY_MB` | `64` | Taille maximale d'une requête. |
| `PSEUDO_PROXY_MAPPING_TTL_SECONDS` | `1800` | Durée de vie glissante des correspondances. |
| `PSEUDO_PROXY_RESTORE` | `true` | Restituer les valeurs dans les réponses. |
| `PSEUDO_PROXY_CATEGORIES_ALLOW` | *(vide)* | Liste blanche de catégories. |
| `PSEUDO_PROXY_CATEGORIES_DENY` | *(vide)* | Liste noire de catégories. |
| `PSEUDO_PROXY_TOOL_INPUTS` | `true` | Pseudonymiser aussi les arguments d'outils. |
| `PSEUDO_PROXY_STRICT_PERSONS` | `false` | Ne détecter que « Prénom NOM », « NOM Prénom » et civilités. |
| `PSEUDO_PROXY_PDF_GUARD` | `replace` | `replace`, `block` ou `off`. |
| `PSEUDO_PROXY_PDF_GUARD_MAX_MB` | `25` | Taille maximale d'un PDF analysé. |
| `PSEUDO_PROXY_AUDIT` | `true` | Journal d'audit. |
| `PSEUDO_PROXY_LOG_LEVEL` / `_LOG_FILE` | `INFO` / *(vide)* | Niveau et fichier de journal. |
| `PSEUDO_PROXY_API_TOKEN` | *(vide)* | Jeton exigé sur `/api/*` (en-tête `x-axiorhub-token`). |

## Audit, autotest, garde PDF

**Audit.** Une ligne par requête, sans aucune valeur réelle :

```
path=/v1/messages statut=200 flux=oui remplacements=3 [EMAIL=1 PERSONNE=1 TEL=1] restitutions=3 alertes_pdf=0 duree_ms=1840
```

`python -m pseudo_proxy stats` (ou `GET /api/stats`) donne les cumuls par catégorie et le nombre
d'entrées vivantes.

**Autotest.** `python -m pseudo_proxy selftest -v` rejoue 24 contrôles : exemple de référence, IBAN
coupé, IBAN à clé fausse, NIR (y compris Corse), SIREN/SIRET, CB, intégrité des articles/dates/montants,
mots protégés, homonymes DURAND, Maître, sociétés ZORVAL, adresse, date de naissance, RG, Portalis, RPPS,
sinistre, immatriculation, IP, URL. Si la ligne n'est pas « 24 contrôles sur 24 réussis », ne
transmettez rien à une IA externe et prévenez l'auteur de l'outil.

**Garde PDF.** À la lecture d'un PDF joint, le texte qu'un humain ne voit pas (blanc sur blanc, police
≤ 2 pt, hors page, invisible, transparent) est retiré avant lecture par l'IA et remplacé par la ligne
`[AxiorHub : texte masqué retiré du PDF, page N : …]`. La couche OCR d'un scan et un titre blanc sur
bandeau coloré ne sont pas signalés. Si le texte caché semble s'adresser à une IA, l'alerte est élevée
(en-tête `x-axiorhub-pdf-alert: elevee`, ligne `securite_ia` dans le journal). En mode `block`, la
requête est refusée. Pour inspecter une pièce : `python -m pseudo_proxy pdf-check piece.pdf --show`.
En mode `replace`, le PDF est transmis sous forme de texte (mise en page et images perdues).

API locale (plugin, extension) : `GET /health`, `GET /api/config`, `GET /api/stats`,
`POST /api/pseudonymize {"text": …, "include_mapping": true}`, `POST /api/restore {"text": …}`,
`GET /api/mapping`, `GET /api/selftest`, `POST /api/flush`, `POST /api/shutdown`. Réservée à la machine
locale ; jeton optionnel.

## Exemple concret

Entrée saisie dans Claude Code :

```
Jean Dupont, jean.dupont@email.fr, 06 12 34 56 78, doit être relancé.
```

Ce que reçoit l'API Claude (visible avec `python -m pseudo_proxy preview`) :

```
[PERSONNE_1], [EMAIL_1], [TEL_1], doit être relancé.
```

Réponse de Claude : « Voici le courriel de relance pour [PERSONNE_1] à envoyer à [EMAIL_1]… ».
Réponse restituée à Claude Code :

```
Voici le courriel de relance pour Jean Dupont à envoyer à jean.dupont@email.fr…
```

Si Claude écrit un fichier (`Write`) contenant `[PERSONNE_1]`, l'argument est restitué avant que
Claude Code n'exécute l'outil : le fichier sur le disque contient « Jean Dupont ».

Journal d'audit correspondant : `remplacements=3 [EMAIL=1 PERSONNE=1 TEL=1] restitutions=2`.

## Limites de la pseudonymisation

- **Détection par règles, pas par compréhension.** Un nom hors lexique de prénoms et écrit en casse de
  titre (« Zébulon Marchetti ») n'est pas détecté sans civilité ; un nom tout en minuscules ne l'est
  jamais. Les faits (dates, lieux, montants, fonctions, récit) restent en clair et peuvent permettre une
  ré-identification par recoupement.
- **Faux positifs possibles** : un mot en casse de titre pris pour un nom, une suite de 9 chiffres à
  clé Luhn valide prise pour un SIREN. Les listes blanche/noire et `PSEUDO_PROXY_STRICT_PERSONS`
  permettent d'ajuster ; `preview` montre ce qui part.
- **Formes multiples.** Quand une même donnée apparaît sous plusieurs graphies (« DURAND Paul » puis
  « Paul DURAND »), la première forme rencontrée est restituée partout.
- **Durée de vie.** Après le TTL d'inactivité (30 min par défaut), les correspondances disparaissent :
  les marqueurs encore présents dans une conversation ne sont plus restitués et une nouvelle valeur
  identique reçoit un nouveau numéro (jamais un ancien). Allongez le TTL pour les longues sessions.
- **Le modèle doit respecter les marqueurs.** La restitution tolère `[PERSONNE 1]`, `[PERSONNE-1]`,
  `[PERSONNE\_1]`, mais pas une reformulation (« la personne 1 »).
- **Images et documents non PDF** ne sont pas analysés. Les PDF ne sont analysés que pour le texte caché ;
  le texte visible d'un PDF passe par la pseudonymisation seulement lorsque le PDF a été converti en texte
  (mode `replace` avec texte caché détecté).
- **Blocs `thinking`** et définitions d'outils ne sont pas modifiés.
- **Le proxy voit tout en clair** : il doit rester sur votre machine (`127.0.0.1`). Les autres processus
  locaux peuvent joindre l'API locale ; utilisez `PSEUDO_PROXY_API_TOKEN` sur un poste partagé.
- **Performance** : chaque requête est analysée en entier (Claude Code renvoie tout l'historique à chaque
  tour) ; comptez quelques dizaines à quelques centaines de millisecondes selon la taille du contexte.

## Avertissement

La pseudonymisation remplace des identifiants directs par des marqueurs réversibles sur votre poste.
Au sens du RGPD (art. 4-5), les données ainsi traitées **restent des données personnelles** : la table de
correspondance existe, même si elle ne quitte pas votre machine, et le contexte transmis peut permettre
une ré-identification. Cet outil **ne remplace ni une anonymisation définitive, ni une analyse d'impact,
ni une validation juridique** de vos traitements (base légale, information des personnes, contrat de
sous-traitance avec le fournisseur d'IA, transferts hors UE, secret professionnel). Il est fourni sans
garantie (voir [LICENSE](LICENSE)) et doit être évalué par vous au regard de vos obligations.

## Arborescence et rôle de chaque fichier

```
axiorhub-pseudo-claude/
├── LICENSE                       Texte intégral de la GNU AGPL v3.
├── NOTICE                        Mention d'auteur et rappel des obligations AGPL (art. 7 et 13).
├── README.md                     Ce document.
├── requirements.txt              Dépendances Python (FastAPI, uvicorn, httpx, pdfminer.six, python-dotenv, pytest).
├── pyproject.toml                Métadonnées du paquet, commande `axiorhub-pseudo`, réglages pytest.
├── .env.example                  Toutes les variables de configuration commentées.
├── .gitignore
├── .claude-plugin/marketplace.json   Place de marché locale pour installer le plugin dans Claude Code.
├── pseudo_proxy/                 Le proxy (paquet Python).
│   ├── __init__.py               Version, mention et licence.
│   ├── __main__.py               Point d'entrée `python -m pseudo_proxy`.
│   ├── cli.py                    Commandes : serve, start, stop, status, stats, selftest, preview, pdf-check, flush, env.
│   ├── config.py                 Lecture et validation des variables PSEUDO_PROXY_*, liste des catégories.
│   ├── store.py                  Table de correspondance en mémoire : TTL glissant, compteurs jamais réinitialisés, statistiques sans valeurs.
│   ├── validators.py             Clés : IBAN mod 97, Luhn (SIREN, SIRET La Poste, CB, RPPS), NIR (Corse 2A/2B), IP publique.
│   ├── textnorm.py               Normalisation (accents, casse) pour les clés et comparaisons.
│   ├── lexicon.py                Prénoms usuels, mots protégés (IDCC, SYNTEC, CSG…), civilités, formes de sociétés.
│   ├── detectors/
│   │   ├── __init__.py           Registre des détecteurs.
│   │   ├── base.py               Type `Span`, contexte de détection, résolution des chevauchements par priorité.
│   │   ├── identifiers.py        E-mail, téléphone, IBAN, CB, NIR, SIREN/SIRET, RPPS, RG, Portalis, sinistre, immatriculation, IP, URL, identifiant client, nom d'utilisateur, date de naissance.
│   │   ├── persons.py            Personnes : ordres Prénom/NOM, civilités, nom seul, homonymes, Maître.
│   │   ├── companies.py          Sociétés : « ZORVAL SAS », « la société ZORVAL », forme juridique conservée.
│   │   └── addresses.py          Adresses postales avec arrêt au premier mot de liaison, code postal et ville.
│   ├── engine.py                 Moteur : détection → remplacement ; restitution (variantes de marqueurs tolérées) ; restitution en flux avec rétention des marqueurs coupés.
│   ├── json_walker.py            Parcours du JSON de l'API Messages (system, messages, tool_result, tool_use ; thinking ignoré).
│   ├── streaming.py              Traitement du flux SSE : text_delta, input_json_delta, synthèse d'un dernier delta à la fin d'un bloc.
│   ├── pdf_guard.py              Garde PDF : analyse pdfminer (couleur, taille, position, mode de rendu, alpha), exceptions OCR/bandeau, remplacement du document.
│   ├── selftest.py               Les 24 contrôles de l'autotest.
│   ├── audit.py                  Journal d'audit (catégories et comptes uniquement) et alertes sécurité IA.
│   └── server.py                 Application FastAPI : /v1/messages, /v1/messages/count_tokens, transfert transparent, API locale, erreurs.
├── tests/                        Suite pytest (74 tests).
│   ├── conftest.py               Fixtures : moteur neuf, fabrique de PDF minimalistes.
│   ├── test_validators.py        Clés IBAN/Luhn/NIR/IP.
│   ├── test_pseudonymizer.py     Nom + e-mail + IBAN pseudonymisés puis restitués, stabilité, TTL, listes, parcours JSON.
│   ├── test_detectors.py         Personnes, homonymes, Maître, sociétés, adresses, identifiants, mots protégés.
│   ├── test_streaming.py         Marqueurs coupés en flux, JSON d'outils, fin de bloc.
│   ├── test_proxy.py             Proxy de bout en bout avec faux amont : en-têtes, SSE, count_tokens, limite de taille, échec = pas d'envoi, API locale.
│   ├── test_pdf_guard.py         Texte blanc, minuscule, hors page, invisible, transparent ; exceptions OCR et bandeau ; modes replace/block/off.
│   └── test_selftest_and_config.py  Autotest 24/24, lecture de la configuration.
├── claude-plugin/                Plugin Claude Code.
│   ├── .claude-plugin/plugin.json    Manifeste du plugin.
│   ├── commands/*.md             Commandes /axiorhub-pseudo:demarrer, etat, audit, autotest, apercu, pdf, purger, arreter.
│   ├── skills/axiorhub-pseudonymisation/SKILL.md   Règles de travail avec les marqueurs.
│   ├── hooks/hooks.json          Hooks SessionStart et UserPromptSubmit.
│   └── scripts/                  axpseudo.py (lanceur), check_proxy.py (vérification au démarrage), guard_prompt.py (blocage hors proxy).
├── chrome-extension/             Extension Chrome (Manifest V3).
│   ├── manifest.json             Permissions : storage, 127.0.0.1 ; scripts sur claude.ai.
│   ├── interceptor.js            Monde principal : enveloppe fetch, pseudonymise à l'envoi, restitue le flux et l'historique.
│   ├── bridge.js                 Relais entre la page et le service worker.
│   ├── service_worker.js         Seul point de contact avec le proxy local ; réglages.
│   ├── popup.html/.js/.css       État, interrupteur, aperçu, autotest, audit.
│   ├── options.html/.js          Port, jeton, mode strict, restitution.
│   └── icons/                    Icônes.
└── scripts/                      Scripts Windows.
    ├── install.ps1               Environnement virtuel, dépendances, .env, autotest.
    ├── start-proxy.ps1           Proxy au premier plan.
    ├── claude-pseudo.ps1         Démarre le proxy puis Claude Code avec ANTHROPIC_BASE_URL.
    └── run-tests.ps1             pytest + autotest.
```

## Tests

```powershell
.\scripts\run-tests.ps1
```

ou `python -X utf8 -m pytest tests -q`. Les tests incluent les exemples demandés : un nom, un e-mail et
un IBAN pseudonymisés puis restitués (`tests/test_pseudonymizer.py`), le flux SSE avec marqueurs coupés
(`tests/test_streaming.py`), et le proxy complet face à un faux serveur (`tests/test_proxy.py`).

## Licence et mention

Copyright (C) 2026 Timo RAINIO. Logiciel libre sous **GNU Affero General Public License v3.0 ou
ultérieure** : vous pouvez l'utiliser, l'étudier, le modifier et le redistribuer aux conditions de la
licence, notamment la mise à disposition du code source modifié aux utilisateurs qui y accèdent par un
réseau (article 13). La mention **« AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat »**
doit être conservée dans les versions dérivées (article 7).
