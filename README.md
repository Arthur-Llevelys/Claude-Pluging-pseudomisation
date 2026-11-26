# AxiorHub : Extension de pseudonymisation dans Claude Desktop
**Créée par Timo Rainio Avocat** · Logiciel libre sous licence [GNU AGPL v3 ou ultérieure](LICENSE) · Windows, macOS, Linux

## 📦 [Télécharger](https://github.com/Arthur-Llevelys/Claude-Pluging-pseudomisation/raw/main/paquets/anonymiseur-cabinet-1.9.1.mcpb)
### Version pour Mistral Vibe Desktop : [anonymiseur-vibe-1.9.1.zip](https://github.com/Arthur-Llevelys/Claude-Pluging-pseudomisation/raw/main/paquets/anonymiseur-vibe-1.9.1.zip) (voir « Nouveau dans la 1.9 »)


### Extension pour Claude Desktop qui permet de travailler avec Claude sur des dossiers clients sans que les données personnelles quittent votre poste. 

Noms, sociétés, adresses, dates et lieux de naissance, SIREN/SIRET, TVA, IBAN, NIR,
e-mails et téléphones sont remplacés par des marqueurs (`[PERSONNE_1]`, `[SOCIETE_2]`, `[ADRESSE_1]`…) avant que Claude ne
lise quoi que ce soit ; les documents produits par Claude sont ensuite ré-identifiés sur votre poste, avec les vraies
données, directement dans le dossier de l'affaire.

```
Texte présent dans un document sur votre poste : « Madame Hélène Vasseur, 14 rue des Tanneurs, 69005 Lyon, IBAN FR76 3000 6000 0112 3456 7890 189… »
Avec cette extension, ce que Claude lit : « Madame [PERSONNE_1], [ADRESSE_1], IBAN [IBAN_1]… »
Courrier enregistré avec les données restituées : « Madame Hélène Vasseur… » (Word, dans le dossier de l'affaire, mise en forme de votre modèle)
```

> **Extension Claude pensée pour les avocats et les professions tenues au secret** . L'outil limite ce qui est transmis à l'IA (il "pseudomise", il n'anonymise pas), il ne
> remplace pas votre vigilance. Aucun détecteur n'est exhaustif à 100% : **relisez avant tout envoi**.
>
> **Comment ça fonctionne ?**
>
> - **Ne pas faire :** taper une instruction ou copier/coller un texte directement dans la conversation de Claude Desktop ou joindre
>  ou glisser des fichiers dans la zone de saisie de Claude — ils partent tels quels à Anthropic ;
> - **Ce qu'il faut faire :** Il faut laisser les pièces dans le dossier dédié à l'affaire et demander à Claude : « Choisis le dossier de l'affaire »
>   ou : « Ouvre un nouveau dossier » ;
> - **Pour un texte**, il faut soit sélectionner le texte, copier le texte ( **Ctrl + C** ) , puis demandez à Claude de « lire le presse-papiers »,
>   soit depuis la version 1.7.0 : sélectionner le texte à copier, copier le texte ( **Ctrl + C** ) puis coller le dans
>   la case des instructions de Claude Desktop en appuyant simultanément sur :  **Ctrl + Alt + Maj + V** (« cela colle le texte pseudonymisé ») ;
> - **Pour un fichier**, effectuer un clic droit → **Envoyer vers → « Anonymiseur - copie pseudonymisée »**, puis glissez la copie dans Claude.

---
## Comment utiliser l'extension avec Claude ?

| Vous dites à Claude | Ce qui se passe sur votre poste |
|---|---|
| « Ouvre un nouveau dossier » | Dossier créé sous une référence neutre (`2026-11-25-01`) ; le libellé réel se tape dans une fenêtre locale |
| « Choisis le dossier de l'affaire » | Vous désignez le dossier dans une fenêtre ; les pièces sont lues **sur place**, sans copie |
| « Travaille dans ce dossier » ou clic droit sur le dossier → Envoyer vers → « Anonymiseur - travailler dans ce dossier » | Le dossier devient le dossier de travail sans fenêtre ; il est repris ensuite sans rien demander pendant 7 jours |
| « Importe les pièces » / « les 3 derniers téléchargements » | Copie dans le dossier ; Claude ne voit que des noms de fichiers pseudonymisés |
| « Lis le presse-papiers » | Le courriel que vous avez copié est enregistré ; Claude n'en reçoit que la version pseudonymisée |
| « Montre mes derniers courriels », « importe le C2 » | Lecture de votre messagerie (IMAP, lecture seule) ; message et pièces jointes rangés dans le dossier |
| « Prépare le courrier sur mon modèle » | Votre modèle Word est rempli (styles, en-têtes, logo conservés) puis ré-identifié |
| « Mets la réponse dans le presse-papiers » | Réponse ré-identifiée prête à coller dans votre webmail, hors historique du presse-papiers Windows |
| « Lyon n'est pas une personne », « ajoute ce nom oublié » | Correction du dossier (`corriger_entite`) ; un nom à ajouter se tape dans une fenêtre locale |

PDF scannés lus par reconnaissance de caractères (OCR), Word, OpenDocument, courriels, RTF, HTML et texte pris en charge.
Un journal local trace chaque opération **sans aucune donnée en clair**.

**Règle du projet :** aucun outil ne renvoie à Claude un texte, un nom de fichier ou un chemin contenant des
données réelles. Le texte ré-identifié est écrit sur votre poste ou dans le presse-papiers, jamais dans la conversation.

---
## Nouveau dans la 1.9 : la même extension dans Mistral Vibe Desktop

L'Anonymiseur fonctionne aussi avec **Mistral Vibe Desktop** (mode Code, sessions locales), avec les mêmes outils, la
même détection, les mêmes tables de correspondance et les mêmes marqueurs que dans Claude.

**Installation (Windows)**

1. Installez **Node.js** (version LTS, [nodejs.org](https://nodejs.org)) : Vibe ne le fournit pas, contrairement à Claude Desktop.
2. Téléchargez [`paquets/anonymiseur-vibe-1.9.1.zip`](https://github.com/Arthur-Llevelys/Claude-Pluging-pseudomisation/raw/main/paquets/anonymiseur-vibe-1.9.1.zip),
   décompressez-le, puis double-cliquez sur **`vibe\installer-pour-vibe.cmd`**.
3. Une fenêtre s'ouvre : adresse du serveur et **clé d'API** (ou « Moteur local »), dossier racine des affaires, case
   **« Verrouiller le dossier racine pour Vibe »** (laissez-la cochée). Si l'extension est déjà installée dans Claude
   Desktop, ses réglages non secrets sont repris ; la clé se retape (sur le serveur Ubuntu :
   `sudo grep ANON_API_KEY /etc/anonymiseur/anonymiseur.env`). Elle est chiffrée par Windows, jamais écrite en clair.
4. Fermez puis rouvrez Vibe Desktop ; ouvrez une session locale **sur le dossier verrouillé** (ou un de ses
   sous-dossiers), puis demandez par exemple « Liste les pièces du dossier ».

**Comment ça marche.** Vibe Desktop sous Windows ne sait pas lancer une extension locale (erreur
`mcp_transport_failed`, y compris pour d'autres extensions que celle-ci). L'Anonymiseur tourne donc **en tâche de fond**,
sans fenêtre, à partir de l'ouverture de session Windows (raccourci « Anonymiseur pour Vibe » du dossier Démarrage) ;
il n'écoute que le poste lui-même (`127.0.0.1`), exige un jeton secret et refuse toute requête venant d'une page Web.
Vibe s'y connecte comme à un connecteur.

**Le dossier verrouillé, protection indispensable.** Vibe est un agent de programmation : dans une session ordinaire,
il lit les fichiers **en clair** et envoie au modèle l'**arborescence du dossier** (donc les noms de fichiers). Vibe
Desktop ne permet pas de choisir un agent personnalisé : c'est le **dossier** qui protège. Dans un dossier verrouillé
(fichier `.vibe\config.toml` posé par l'installateur), toute session n'a que les outils de l'Anonymiseur — lecture
directe des fichiers et commandes refusées — et Vibe n'envoie ni l'arborescence ni les détails du poste.

> **Précautions propres à Vibe Desktop**
> - **N'ouvrez jamais une session Vibe sur un dossier client non verrouillé.**
> - Le **nom du dossier** de la session reste visible du modèle : travaillez dans des dossiers d'affaires à référence
>   neutre (« 2026-11-25-01 », créés par « Ouvre un nouveau dossier »), pas dans un dossier nommé d'après le client.
> - Vibe Desktop n'applique pas les consignes de l'extension : s'il vous propose de **coller ou glisser** un document
>   dans la conversation, refusez ; demandez-lui d'utiliser les outils de l'Anonymiseur.
> - Le mode **Work** de Vibe Desktop n'a pas accès à l'extension : utilisez le mode **Code**, session locale.

| Fichier du dossier `vibe` | Rôle |
|---|---|
| `installer-pour-vibe.cmd` | Copie l'extension, ouvre les réglages, la lance en tâche de fond, la déclare dans Vibe (configuration sauvegardée, autres entrées intactes), verrouille le dossier racine |
| `reglages-vibe.cmd` | Rouvre la fenêtre des réglages (nouvelle clé, autre serveur, moteur local) et relance l'extension |
| `verrouiller-un-dossier-pour-vibe.cmd` | Verrouille un autre dossier |
| `desinstaller-de-vibe.cmd` | Arrête l'extension, retire verrous, lancement automatique et déclaration dans Vibe ; réglages et tables de correspondance conservés |

Les raccourcis Ctrl + Alt + Maj + V / R et « Envoyer vers » restent communs : si Claude et Vibe sont ouverts ensemble,
une seule copie de l'extension les prend en charge.

## Nouveau dans la 1.8.0 : le dossier de travail se gère tout seul

Vous désignez le dossier d'une affaire une fois ; ensuite, plus aucune fenêtre ne vous le redemande.

| Geste | Ce qui se passe |
|---|---|
| « Choisis le dossier de l'affaire » (première fois) | Une fenêtre s'ouvre ; le dossier choisi devient le **dossier de travail** |
| Les fois suivantes | Claude reprend ce dossier **sans rien demander**, pendant 7 jours après sa dernière utilisation (réglage « Durée de mémoire du dossier courant ») |
| « Change de dossier » | La fenêtre s'ouvre de nouveau pour désigner une autre affaire |
| « Importe les pièces » et vous choisissez des fichiers | Leur dossier devient le dossier de travail : les fichiers déjà rangés dans vos dossiers d'affaires sont **lus sur place, sans copie** ; seuls ceux venus d'ailleurs (Téléchargements, bureau…) sont copiés dans le dossier de travail |
| Clic droit sur un dossier (ou un fichier) → **Envoyer vers → « Anonymiseur - travailler dans ce dossier »** | Le dossier devient le dossier de travail de Claude, sans aucune fenêtre ; demandez ensuite « liste les pièces » |
| Clic droit sur un fichier → **Envoyer vers → « Anonymiseur - copie pseudonymisée »** | En plus de la copie, le dossier du fichier devient le dossier de travail |

Les livrables sont toujours enregistrés dans le dossier d'origine des pièces. Un sous-dossier d'une affaire créée par
l'extension (« Pièces », etc.) est rattaché à l'affaire : mêmes marqueurs, même table de correspondance.
Claude ne voit toujours ni le nom réel du dossier ni son chemin.

## Nouveau dans la 1.7.0 : coller pseudonymisé et « Envoyer vers »

Ce que vous tapez, collez ou glissez dans la zone de saisie de Claude part tel quel : aucune extension ne peut
filtrer ce champ. La 1.7.0 ajoute deux gestes qui remplacent le collage et la pièce jointe :

| Geste | Ce qui se passe |
|---|---|
| Copier un texte, puis **Ctrl + Alt + Maj + V** dans la conversation | Le texte copié est pseudonymisé sur le poste (mêmes marqueurs que le dossier courant), puis c'est cette version qui est collée. Une notification indique le nombre de données masquées. |
| Copier la réponse de Claude, puis **Ctrl + Alt + Maj + R** | Les vrais noms sont remis dans le presse-papiers (exclu de l'historique Windows) : collez dans votre messagerie. |
| Clic droit sur un fichier → **Envoyer vers → « Anonymiseur - copie pseudonymisée »** | Une copie texte pseudonymisée est créée à côté du fichier (OCR compris pour les PDF scannés), avec un nom lui-même pseudonymisé : glissez cette copie dans Claude. |

Les raccourcis fonctionnent tant que Claude Desktop est ouvert ; une icône en forme de bouclier dans la zone de
notification signale qu'ils sont actifs. Réglage **« Raccourcis Windows »** (activé par défaut) pour les
désactiver ; l'entrée « Envoyer vers » est alors retirée. Si vous désinstallez l'extension, supprimez à la main
l'entrée « Anonymiseur - copie pseudonymisée » de `%APPDATA%\Microsoft\Windows\SendTo`.
Rien ne vous empêche de coller l'original par erreur avec Ctrl + V : ces gestes réduisent le risque sans le supprimer.

## Deux façons de faire tourner la détection

1. **Via la moteur local (recommandé pour un cabinet sans serveur)** — tout se passe dans l'extension, sur le poste :
   - des **règles** éprouvées (formats d'identifiants avec contrôle de clé, adresses, civilités, sociétés, montants et
     références juridiques protégés…) ;
   - Optionnel : vous pouvez ajouter un **petit modèle de langue local via [Ollama](https://ollama.com)** pour
     reconnaître les noms de personnes et de sociétés sans indice formel (« Marine Marchande confirme… »,
     « la SAS Lumière a cessé les paiements ») ;
   - une **table de correspondance chiffrée par affaire** (AES-256-GCM), dont la clé est protégée par Windows (DPAPI).
     
2. **Via un serveur d'anonymisation** (dossier `serveur-ubuntu/`) — pour un cabinet qui dispose d'un serveur Linux : mêmes
   règles, reconnaissance des noms par spaCy, OCR par ocrmypdf, interface web. Les deux moteurs donnent des résultats
   identiques (vérifié par `tests/comparer-moteurs.js`).

---
### Pourquoi ajouter un petit modèle avec Ollama, plutôt qu'utiliser les règles seules de l'extension ?

Les règles ne voient un nom que s'il a une forme reconnaissable (« M. Dupont », « Jean DUPONT » ...etc.). 
Dans un courriel ou un compte rendu, les noms apparaissent parfois nus : sans modèle de langue, ils **fuiraient**. 

**Sur les tests, avec exemples fictifs :**

| Configuration | Données restées en clair | Mots masqués à tort |
|---|---|---|
| Règles seules | 12 sur 47 | 0 |
| Règles + petit modèle de 4 milliards de paramètres (Ollama) | 0 à 1 sur 47 | 0 |

Pourquoi un **petit** modèle LLM (3 à 4 milliards de paramètres, environ 2,5 à 3 Go) : il tourne sur un ordinateur ordinaire,
sans carte graphique, et il suffit pour repérer des noms. 

Pourquoi **Ollama** : le modèle tourne sur votre poste (ou sur une machine de votre réseau), gratuitement, sans abonnement 
ni envoi de données. L'extension refuse toute adresse Internet et les modèles « cloud » d'Ollama, et ne retient un nom 
proposé par le modèle que s'il figure mot pour mot dans le texte.

Détails et mesures : [`prototype-autonome/RESULTATS.md`](prototype-autonome/RESULTATS.md).

---
## Installation (Windows)

1. **Claude Desktop** installé et connecté.

2. **Téléchargez** [`paquets/anonymiseur-cabinet-1.9.1.mcpb`](paquets/) puis, **dans Claude Desktop** : Paramètres (`Ctrl` + `,`)
   → **Extensions** → glissez le fichier dans la fenêtre et validez l'installation.

3. **Dans les réglages de l'extension :**
   - **Dossier racine de vos dossiers** : le dossier qui contient vos affaires ;
   - **sans serveur** : cochez **Moteur local (sans serveur)** ;
   - **avec un serveur d'anonymisation** : laissez « Moteur local » décoché, renseignez la **clé d'API** et l'**adresse du
     serveur**, par exemple `http://192.168.1.10:8765`. L'adresse proposée par défaut, `http://127.0.0.1:8765`, ne convient
     que si le serveur tourne sur le même ordinateur ;
   - **Raccourcis Windows** (coché par défaut) : `Ctrl` + `Alt` + `Maj` + `V`, `Ctrl` + `Alt` + `Maj` + `R` et « Envoyer vers » ;
   - facultatif : dossier de vos modèles Word, messagerie IMAP (le mot de passe est stocké chiffré par Claude Desktop).

4. **Ollama** (reconnaissance des noms - facultatif) : installez-le depuis [ollama.com](https://ollama.com/download), puis
   dans un terminal :
   ```
   ollama pull ministral-3:3b
   ```
   Le modèle (2,8 Go) n'est téléchargé qu'une fois. Sans Ollama, l'extension fonctionne avec les règles seules et vous le signale.

5. Facultatif, pour les PDF scannés : **Tesseract**
   (Windows : programme d'installation « [Tesseract at UB Mannheim](https://tesseractocr.org/fr/install/) », en cochant la langue
   française).

   Pour ajouter le français dans Tesseract
   - Ouvrez cette page : https://github.com/tesseract-ocr/tessdata/raw/main/fra.traineddata
   - Elle télécharge directement le fichier fra.traineddata.
   - Copiez le fichier téléchargé dans :
   ```
   C:\Program Files\Tesseract-OCR\tessdata
   ```
   Si Windows demande une autorisation pour coller dans Program Files, cliquez sur Continuer et validez avec votre compte administrateur.
   Fermez puis rouvrez PowerShell, puis tapez :
   ```
   tesseract --list-langs
   ```
   Vous devriez maintenant voir :
   ```
   eng
   fra
   osd
   ```
   
6. Pour voir les notifications des raccourcis : Paramètres Windows → Système → **Notifications**, activées, avec
   « Windows PowerShell » autorisé (c'est lui qui affiche les bulles de l'Anonymiseur), et « Ne pas déranger » désactivé.

7. Ouvrez une nouvelle conversation et dites : « Vérifie l'anonymiseur ». La réponse doit indiquer « moteur local » ou
   « serveur joignable » et « Clé d'API : acceptée ».

Serveur Linux (facultatif) : voir [`serveur-ubuntu/LISEZMOI.md`](serveur-ubuntu/LISEZMOI.md) (`sudo bash install.sh`).

---
## Dépannage

| Ce que vous constatez | Cause probable et solution |
|---|---|
| Un **bip** quand vous appuyez sur `Ctrl` + `Alt` + `Maj` + `V`, et rien n'est collé | Le raccourci est bien reçu, mais l'extension a rencontré une erreur : le bip est le son de sa notification d'avertissement. Rendez les notifications visibles (étape 6 de l'installation) pour lire le message. Le plus souvent : **adresse du serveur** incorrecte (voir la ligne suivante), ou presse-papiers sans texte. |
| « Serveur d'anonymisation injoignable (http://127.0.0.1:8765) » | L'adresse du serveur est restée sur sa valeur par défaut. Réglages de l'extension → **Adresse du serveur d'anonymisation** → mettez celle de votre serveur (`http://192.168.1.10:8765`, par exemple), ou cochez **Moteur local**. |
| « Clé d'API refusée » | Recopiez la clé du serveur (`sudo grep ANON_API_KEY /etc/anonymiseur/anonymiseur.env`) dans les réglages de l'extension. |
| Aucune icône de bouclier près de l'horloge | Les raccourcis ne sont pas actifs : vérifiez le réglage **Raccourcis Windows**, puis quittez complètement Claude Desktop (icône près de l'horloge → Quitter) et rouvrez-le. Si une autre application utilise déjà la même combinaison de touches, Windows refuse de l'attribuer à l'Anonymiseur. |
| Le texte collé n'utilise pas les marqueurs de l'affaire | Les raccourcis suivent le **dossier courant** de l'extension. Faites d'abord choisir le dossier dans Claude. Le dossier courant est oublié après 12 heures sans utilisation. |
| Deux extensions « Anonymiseur (cabinet) » dans Claude après une mise à jour | Claude identifie une extension par son nom d'auteur. Gardez la version la plus récente et désinstallez l'autre, puis vérifiez ses réglages (adresse du serveur, clé). |
| « Envoyer vers » répond que Claude Desktop n'est pas ouvert | La copie pseudonymisée est produite par l'extension : ouvrez Claude Desktop, puis recommencez. |
| « Reconnaissance des noms inactive » | Ollama n'est pas démarré, ou le modèle n'est pas téléchargé (`ollama pull ministral-3:3b`). Les règles continuent de s'appliquer : relisez les noms. |

---
## Vérifications

```
node --test tests/extension.test.js      # 34 tests de l'extension (données fictives)
node tests/verifier-raccourcis-windows.js # raccourcis et « Envoyer vers » en conditions réelles (Windows)
node tests/comparer-moteurs.js           # moteur local et serveur : résultats identiques
cd serveur-ubuntu && python -m tests.test_moteur
```

---
## Et avec ChatGPT ou Mistral ?

L'extension parle MCP, un protocole ouvert que d'autres assistants commencent à utiliser ; seul son emballage
(paquet `.mcpb`, page de réglages) est propre à Claude Desktop. État des lieux en novembre 2026 :

| Assistant | Possible ? | Ce qu'il faudrait |
|---|---|---|
| **Mistral Vibe Desktop** (mode Code, sessions locales) | **Oui, depuis la 1.9** | Installateur `vibe/installer-pour-vibe.cmd` : extension en tâche de fond et dossier verrouillé (voir « Nouveau dans la 1.9 ») |
| **ChatGPT** | Pas directement : ChatGPT n'accepte que des serveurs distants, et l'accès complet (écriture des livrables) est réservé aux offres Business et Enterprise | Rendre l'extension joignable par un tunnel sécurisé (« Secure MCP Tunnel » d'OpenAI), avec authentification |

En attendant, les gestes **Ctrl + Alt + Maj + V** (coller pseudonymisé), **Ctrl + Alt + Maj + R** (remettre les vrais noms)
et **Envoyer vers → « Anonymiseur - copie pseudonymisée »** fonctionnent dans n'importe quelle fenêtre, y compris
ChatGPT ou Le Chat de Mistral, tant que Claude Desktop est ouvert : le texte collé ou le fichier joint n'y part que sous
sa forme pseudonymisée.

## Limites

- **Ce que vous tapez ou collez avec `Ctrl` + `V` directement dans la conversation, et les fichiers que vous y glissez, ne
  sont pas filtrés** : collez avec `Ctrl` + `Alt` + `Maj` + `V`, dites « lis le presse-papiers », ou utilisez « Envoyer vers ».
- La reconnaissance des noms par un petit modèle prend environ 15 à 30 s par page sur un portable sans carte graphique.
- L'OCR peut déformer un nom propre, qui échappe alors au masquage : relisez les PDF scannés.
- Un PDF contenant déjà des marqueurs ne peut pas être ré-identifié : faites produire un Word.

---
## Licence

Copyright © 2026 Timo Rainio. Logiciel libre : vous pouvez le redistribuer et le modifier selon les termes de la
**GNU Affero General Public License** version 3 ou ultérieure (fichier [LICENSE](LICENSE)).

Conformément à l'article 7 (b) et (c) de la licence, la mention
**« AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat »** doit être conservée dans toute copie ou
version dérivée, ainsi que dans les mentions légales affichées par le logiciel (voir [NOTICE](NOTICE)). Si vous
mettez une version modifiée à disposition d'utilisateurs à travers un réseau, vous devez leur donner accès à son
code source (article 13).

Ce logiciel est fourni sans aucune garantie. Il ne constitue pas un conseil juridique ; son utilisation ne dispense
pas des obligations déontologiques et réglementaires (secret professionnel, RGPD) qui pèsent sur chaque utilisateur.

---

Historique des versions et notes techniques : [`NOTES-VERSIONS.md`](NOTES-VERSIONS.md). L'ancien proxy « AxiorHub
Pseudonymisation Claude » pour Claude Code (octobre 2026) est conservé dans [`archives/`](archives/).
