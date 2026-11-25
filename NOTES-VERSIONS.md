# Anonymiseur (cabinet) — version 1.6.0

## Nouveau dans la 1.6.0 : PDF scannés et courriels

- **PDF scannés (OCR)** : avec le serveur, `ocrmypdf` (serveur 1.3.0) ; avec le moteur local, **Tesseract**
  installé sur le poste (Windows : programme d'installation « Tesseract at UB Mannheim », en cochant *French*).
  Les pages scannées sont extraites du PDF telles quelles (images JPEG) et lues par Tesseract ; l'image ne reste
  pas sur le disque. Sans OCR, la lecture le signale avec la marche à suivre.
- **Import direct d'un courriel** : renseignez dans les réglages de l'extension le serveur IMAP de votre
  messagerie, votre identifiant et votre mot de passe (stocké chiffré par Claude Desktop). Puis :
  « montre-moi mes derniers courriels » → liste avec expéditeurs et objets pseudonymisés (C1, C2…) ;
  « importe le C2 » → le message (.eml) et ses pièces jointes sont enregistrés dans le dossier de l'affaire, et
  Claude reçoit la version pseudonymisée du message. La boîte est ouverte en lecture seule : rien n'est marqué
  comme lu, déplacé ni supprimé.

---

## Version 1.5.0

## Nouveau dans la 1.5.0 : corriger la pseudonymisation d'un dossier

Outil `corriger_entite`, avec le moteur local comme avec le serveur (le serveur doit être en **1.2.0** :
`mettre-a-jour-le-serveur.cmd`). Les corrections valent pour les documents lus ensuite : il faut relire un
document pour en obtenir la version corrigée.

| Vous dites à Claude | Ce qui se passe |
|---|---|
| « Marie Martin n'a pas été masquée, ajoute-la » | Claude ouvre une fenêtre sur votre écran : vous tapez le nom, il ne passe jamais par la conversation. Si le nom figure déjà en clair dans ce que Claude a lu (une fuite), il peut le transmettre directement. |
| « Lyon n'est pas une personne » | `exclure` : la valeur ne sera plus masquée dans les nouveaux documents de ce dossier ; annulable avec `reinclure`. |
| « [PERSONNE_1] et [PERSONNE_4] sont la même personne » | `fusionner` : un seul marqueur désormais ; un ancien document contenant [PERSONNE_4] se ré-identifie toujours. |

`entites_du_dossier` signale les marqueurs exclus. Côté serveur, l'export en masse des valeurs réelles est
désormais fermé par défaut (voir `serveur-ubuntu/LISEZMOI.md`).

---

## Version 1.4.0

## Nouveau dans la 1.4.0 : moteur local, sans serveur

Réglage **Moteur local (sans serveur)** : l'extension fait tout sur le poste.

- **Détection** : les mêmes règles que le serveur 1.1.0, réécrites en JavaScript (`server/moteur/detect.js`).
  Le script `node tests/comparer-moteurs.js` passe 45 textes fictifs dans les deux moteurs : résultats identiques
  au caractère près (105 cas sur 105, corrections comprises).
- **Noms sans civilité** : reconnus par un petit modèle de langue local via **Ollama** (par défaut `ministral-3:3b`,
  2,8 Go). Adresse d'Ollama : ce poste par défaut, ou une machine de votre réseau local (par exemple votre serveur
  Ubuntu : `http://192.168.1.10:11434`, par exemple). Les adresses Internet et les modèles « cloud » d'Ollama sont refusés.
  Sans Ollama, les règles seules s'appliquent et chaque lecture le signale.
- **Table de correspondance** : chiffrée affaire par affaire sur le poste (AES-256-GCM, une clé par affaire),
  dans `%LOCALAPPDATA%\AnonymiseurCabinet\tables\`. La clé maîtresse est protégée par Windows (DPAPI) : elle n'est
  lisible que par votre session Windows. Elle ne quitte jamais le poste et n'est jamais exportée.
- **Documents** : texte des Word, OpenDocument, courriels, RTF, HTML et PDF lu sur le poste ; Word produits sur le poste.

Pour l'essayer sur votre poste : Paramètres de l'extension → cocher **Moteur local** ; **Adresse d'Ollama** :
l'adresse de votre serveur Ollama (par exemple `http://192.168.1.10:11434`) ; **Modèle** : `ministral-3:3b`.
`etat_anonymiseur` indique alors « moteur local » et si Ollama répond.

Points d'attention :
- les marqueurs du moteur local et ceux du serveur sont deux tables distinctes : un document à marqueurs produit
  avec l'un ne se ré-identifie pas avec l'autre. Changez de moteur entre deux affaires, pas au milieu d'une ;
- le PDF est lu par une extraction simplifiée (texte des pages) : vérifiez qu'il est complet ; un PDF scanné ne
  donne rien (OCR prévu au lot 5) ;
- sur un portable sans carte graphique, la reconnaissance des noms prend environ 15 à 30 s par page
  (voir `prototype-autonome/RESULTATS.md`) ;
- la table locale n'est pas purgée automatiquement (le serveur, lui, supprime un dossier inactif depuis 30 jours).

---

## Version 1.3.0 : restitution

| Vous dites à Claude | Ce qui se passe |
|---|---|
| « Prépare le courrier sur mon modèle » | `lister_modeles` montre les modèles Word de votre **dossier des modèles** (nouveau réglage). Claude lit le modèle, puis `enregistrer_document` avec `modele` et une liste de remplacements (« [NOM DU CLIENT] » → « [PERSONNE_1] », « XXXX » → « [SOCIETE_1] »…). Le modèle est repris **tel quel** : polices, styles, logo, en-têtes et pieds de page, tableaux. Un texte que Word a découpé en plusieurs morceaux est quand même trouvé ; il prend la mise en forme de son premier morceau. Une adresse sur deux lignes devient un vrai retour à la ligne. Le modèle d'origine n'est jamais modifié ; un modèle `.dotx` donne un `.docx`. |
| Claude a produit lui-même un Word ou un Excel | `enregistrer_fichier` reçoit le fichier, remet les vraies données à la place des marqueurs (mise en forme conservée) et l'écrit dans le dossier de l'affaire, sans passer par Nextcloud ni un autre connecteur. Le PDF est refusé : demandez un docx. |
| « Et ouvre-le » | Paramètre `ouvrir`, ou nouveau réglage **Ouvrir automatiquement les livrables** : le document s'ouvre dans Word (ou l'application par défaut) dès qu'il est enregistré. |

Nouveaux réglages, facultatifs : **Dossier des modèles** et **Ouvrir automatiquement les livrables** (désactivé par défaut).

Limites : un texte à remplacer doit tenir dans un seul paragraphe du modèle ; les zones de texte flottantes
et les champs de formulaire Word ne sont pas traités. Mise à jour : glisser `anonymiseur-cabinet-1.3.0.mcpb`
dans Paramètres → Extensions ; retour en arrière : `anonymiseur-cabinet-1.2.0.mcpb` ou `sauvegarde-1.2.0`.

---

## Version 1.2.0

## Nouveau dans la 1.2.0 : rien ne passe en clair par la conversation

| Vous dites à Claude | Ce qui se passe |
|---|---|
| « Ouvre un nouveau dossier » | `creer_dossier_affaire` crée sous votre dossier racine un dossier nommé `2026-11-25-01` (référence du jour, numérotée), en fait le dossier courant et ouvre sa table de correspondance sur le serveur. |
| « … et laisse-moi saisir le libellé » | Une fenêtre s'ouvre : vous tapez « Dupont c. Société X », le dossier devient `2026-11-25-01 - Dupont c. Société X` sur votre poste. Claude ne voit que `2026-11-25-01`. Le dossier garde sa référence d'anonymisation même renommé (petite fiche cachée `.anonymiseur-affaire.json`, qui ne contient que les références neutres). |
| « Importe les pièces » | `importer_fichiers` ouvre une fenêtre où vous désignez un ou plusieurs fichiers ; ils sont **copiés** dans le dossier de l'affaire (les originaux restent en place, rien n'est écrasé). Claude reçoit les noms pseudonymisés et les identifiants F1, F2… |
| « Importe les 3 derniers téléchargements » | Mêmes effets, avec les 3 documents les plus récents de votre dossier Téléchargements (pratique après avoir enregistré les pièces jointes d'un courriel). |
| « Lis le presse-papiers » | Vous avez copié le message d'un client dans votre webmail : `importer_presse_papiers` l'enregistre en `.txt` dans le dossier de l'affaire et Claude n'en reçoit que la version pseudonymisée. |
| « Mets la réponse dans le presse-papiers » | `reidentifier_vers_presse_papiers` remet les vraies données dans la réponse rédigée par Claude et la place dans votre presse-papiers : vous n'avez plus qu'à coller (Ctrl+V) dans votre messagerie. Ce contenu est exclu de l'historique du presse-papiers Windows (Win+V) et de la synchronisation entre appareils. Claude ne voit qu'une confirmation. |

Nouveau réglage facultatif : **Sous-dossier des nouvelles affaires** (par exemple `03 - Dossiers`).

**Journal local** : chaque opération (création, import, lecture, ré-identification, presse-papiers) est notée dans
`%LOCALAPPDATA%\AnonymiseurCabinet\journal.log` : date, opération, référence d'anonymisation, identifiant F…,
extension, volumes et nombres d'entités par type. Jamais de nom de fichier, de chemin, de texte ni de valeur
réelle. Le journal reste sur le poste ; il passe en `journal.log.1` au-delà de 5 Mo.

Mise à jour : comme pour la 1.1.1, glissez `anonymiseur-cabinet-1.2.0.mcpb` (dossier parent) dans Paramètres →
Extensions de Claude Desktop, puis ouvrez une nouvelle conversation. Retour en arrière : `anonymiseur-cabinet-1.1.1.mcpb`
ou le dossier `sauvegarde-1.1.1`.

Limites de la 1.2.0 :
- le texte du presse-papiers reste dans le presse-papiers après l'import : il reste à vous de copier autre chose
  si vous le souhaitez ; la réponse ré-identifiée, elle, y reste jusqu'à votre prochaine copie ;
- le dossier Téléchargements est celui de votre profil (`Downloads`) ; s'il a été déplacé, utilisez la fenêtre de sélection ;
- importer un courriel directement depuis la messagerie et l'OCR des PDF scannés viendront au lot 5.

---

Extension Claude Desktop de Timo RAINIO. Elle pseudonymise vos documents sur votre serveur local avant
que Claude ne les lise, et ré-identifie les livrables sur votre poste.

**La version 1.1 supprime les copies de fichiers.** La 1.1.1 corrige le démarrage dans Claude Desktop : la 1.1.0 ne répondait pas dans l'application et ne doit pas être utilisée. Vous ne déposez plus les pièces dans un dossier
particulier et vous ne recopiez plus les résultats vers le dossier d'origine.

## Ce qui change

| Avant (1.0.1) | Maintenant (1.1.1) |
|---|---|
| Copier les pièces dans un dossier connu de l'extension | Vous désignez le dossier de l'affaire dans une fenêtre de sélection ; les pièces sont lues là où elles sont |
| Livrables écrits dans `10 - IA\_Restitution`, puis recopiés à la main | Livrables écrits directement dans le dossier de l'affaire, à côté des pièces |
| Remettre les vrais noms à la main dans un Word produit autrement | Outil `reidentifier_fichier` : remet les vraies données dans un Word, PowerPoint, Excel ou texte à marqueurs, mise en forme conservée |
| Une seule référence d'anonymisation (« general ») pour tout, sauf précision | Chaque dossier reçoit automatiquement sa propre référence (`D-xxxxxxxx`) : les marqueurs d'une affaire ne se mélangent plus avec ceux d'une autre |

L'extension 1.1.1 fonctionne avec le serveur 1.0.1 comme avec le serveur 1.1.0. Vos réglages (adresse, clé,
dossier racine) sont conservés.

## Serveur 1.1.0 : détection corrigée

La détection se fait sur le serveur Ubuntu : c'est lui qu'il faut mettre à jour pour corriger les erreurs
relevées sur un dossier réel. L'extension n'a pas à être réinstallée.

| Avant (serveur 1.0.1) | Maintenant (serveur 1.1.0) |
|---|---|
| Un numéro RCS coupé par un retour à la ligne restait en clair | Reconnu sur deux lignes, un seul marqueur |
| `S09 Dupont` dans un tableau restait en clair | Le nom qui suit un repère de lot est masqué |
| `110 Grande rue…`, `16/18 rue…` masqués en partie | Adresse entière masquée |
| `[ADRESSE_8],00 €` : le montant était avalé | Montants et références d'articles sont des zones protégées |
| `L. 441-6`, `Lyon`, `Montant`, `Créance`, `LRAR`, `Objet` devenaient des marqueurs | Laissés en clair |
| `Son IBAN est…` devenait `[PERSONNE_2] est [IBAN_1]` | `Son IBAN est [IBAN_1]` |
| `Agence Martin Bellecour` devenait `[SOCIETE_2] [PERSONNE_1]` | Une seule société |

Mise à jour : double-cliquez sur `mettre-a-jour-le-serveur.cmd` (dossier parent). Le script demande votre nom
d'utilisateur sur le serveur, copie l'archive `anonymiseur-serveur-1.1.0.tar.gz`, lance l'installation puis
les tests ; le serveur vous demande lui-même vos mots de passe. Clés, réglages et table de correspondance
sont conservés, et une copie de sécurité de la table est faite avant la mise à jour.

Le détail (cas corrigés, listes modifiables, dossiers déjà ouverts, retour en arrière, limites) est dans
`serveur-ubuntu/LISEZMOI.md`.

## Installation

1. Dans Claude Desktop : Paramètres (`Ctrl` + `,`) → Extensions, puis glissez-y le fichier
   `anonymiseur-cabinet-1.1.1.mcpb` (dossier parent) et validez. Le double-clic sur le fichier ne fonctionne pas avec
   la version Windows « empaquetée » de Claude, qui ne s'associe pas aux fichiers `.mcpb`.
2. Vérifiez les réglages : l'adresse, la clé et le dossier racine doivent être déjà remplis. S'ils sont vides,
   ressaisissez-les. Le champ « Dossier de sortie de secours » devient facultatif ; un nouveau champ
   « Sous-dossier des livrables » permet de ranger les documents produits dans un sous-dossier (par exemple
   `Projets IA`) plutôt qu'à la racine du dossier de l'affaire.
3. Ouvrez une nouvelle conversation : une conversation déjà ouverte garde l'ancienne liste d'outils.

Retour à la version précédente : réinstallez `anonymiseur_1.mcpb` (v1.0.1), ou les fichiers du dossier
`sauvegarde-1.0.1`.

## Utilisation

Dites simplement à Claude ce que vous voulez faire, par exemple :

> Analyse les pièces du dossier et prépare un projet de conclusions.

1. Claude appelle `choisir_dossier` : **une fenêtre s'ouvre sur votre écran**. Vous y désignez le dossier de
   l'affaire. Claude ne voit jamais le nom réel du dossier, seulement une version pseudonymisée et une
   référence neutre. Si la fenêtre n'apparaît pas au premier plan, elle est derrière la fenêtre de Claude.
2. Claude liste et lit les pièces sur place (noms et contenus pseudonymisés).
3. Claude appelle `enregistrer_document` : le Word ré-identifié apparaît dans le dossier de l'affaire.

Autres façons de désigner le dossier, sans fenêtre :

- « Reprends le dossier récent R1 » : les derniers dossiers utilisés sont proposés par `etat_anonymiseur`.
- Dans une session Claude Code ou Cowork ouverte sur un dossier : Claude passe ce dossier lui-même.

Pour ré-identifier un fichier qui contient des marqueurs (un Word produit par Claude avec votre modèle de
courrier, par exemple) : « Ré-identifie ce fichier ». Le fichier source n'est ni modifié ni supprimé.

## Garde-fous

- **Rien n'est copié ni déplacé.** L'extension lit vos fichiers et n'écrit que les livrables demandés, sans
  jamais écraser un fichier existant (un suffixe `(2)` est ajouté).
- **Emplacements autorisés** : le dossier racine des réglages, le dossier d'une session Claude Code, et les
  dossiers que vous avez désignés vous-même dans la fenêtre. Un chemin fourni par Claude en dehors de ces
  emplacements est refusé. Un disque entier ou votre profil utilisateur ne peut pas être choisi.
- **Le dossier courant est oublié après 12 heures sans utilisation**, pour ne pas écrire par erreur dans le
  dossier de la veille. Claude a pour consigne de vous refaire choisir le dossier au début d'un nouveau travail.
- **Aucun nom réel ne remonte à Claude** : ni le chemin, ni le nom du dossier, ni le contenu ré-identifié.
- Le dossier courant et les dossiers récents sont mémorisés sur votre poste uniquement, dans
  `%LOCALAPPDATA%\AnonymiseurCabinet\etat.json`.

## Limites

- Ce que vous tapez ou collez dans la conversation n'est toujours pas filtré.
- `reidentifier_fichier` ne voit que les fichiers présents sur votre poste. Un fichier créé par Claude dans son
  espace distant (conversation classique) doit passer par `enregistrer_document`.
- Un PDF ne peut pas être ré-identifié : faites produire un Word.
- Les marqueurs d'un dossier choisi commencent leur propre numérotation. Une conversation commencée avant la
  mise à jour, qui utilisait la référence « general », ne retrouvera pas ses marqueurs dans la nouvelle
  référence du dossier : terminez-la ou précisez à Claude d'utiliser la référence « general ».
- Le serveur supprime les correspondances d'un dossier après sa durée de rétention : passé ce délai, un ancien
  fichier à marqueurs ne peut plus être ré-identifié.

## Vérifications

```powershell
node --test tests/extension.test.js          # 32 tests, faux serveur, données fictives
node tests/verifier-selecteur-windows.js     # ouvre la vraie fenêtre de sélection et la pilote
node tests/verifier-lot2-windows.js          # presse-papiers réel, fenêtres de saisie et de sélection de fichiers
$env:ANON_CLE = "votre clé" ; node tests/essai-serveur-reel.js   # bout en bout sur votre serveur, données fictives
```

Le dernier script travaille dans un dossier temporaire et supprime sa référence d'essai du serveur à la fin.

Tests du serveur (données fictives, bases temporaires), sur le serveur après la mise à jour :

```
cd /opt/anonymiseur && sudo -u anonymiseur venv/bin/python -m tests.test_moteur
```

La dernière ligne doit être `Résultat : TOUT EST OK`. `tests/test_lot1.py` contient un contrôle par erreur
signalée ; `tests/exemple_lot1.txt` les rassemble dans un document fictif.

## Fichiers

- `manifest.json` : description de l'extension, réglages, liste des outils.
- `server/index.js` : le serveur MCP local, sans dépendance.
- `tests/` : faux serveur d'anonymisation, suite de tests, vérification de la fenêtre, essai sur le serveur réel.
- `sauvegarde-1.0.1/` : copie de la version installée avant modification.
- `../anonymiseur-cabinet-1.1.1.mcpb` : le paquet à installer.
- `serveur-ubuntu/` : le code du serveur 1.1.0 (`app/`, listes dans `app/data/`, `config/`, `tests/`, `install.sh`).
- `sauvegarde-1.0.1/serveur-ubuntu/` : le code du serveur 1.0.1, pour un retour en arrière.
- `../anonymiseur-serveur-1.1.0.tar.gz` et `../mettre-a-jour-le-serveur.cmd` : l'archive du serveur et son lanceur.
