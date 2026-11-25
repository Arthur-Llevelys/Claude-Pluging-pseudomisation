# AxiorHub Pseudonymisation Claude

**Créée par Timo Rainio Avocat** · Logiciel libre sous licence [GNU AGPL v3 ou ultérieure](LICENSE) · Windows, macOS, Linux

## 📦 [Télécharger](https://github.com/Arthur-Llevelys/Claude-Pluging-pseudomisation/releases/download/v1.6.1/anonymiseur-cabinet-1.6.1.mcpb)

Extension pour **Claude Desktop** qui permet de travailler avec Claude sur des dossiers clients **sans que les données
personnelles quittent votre poste**. 

Noms, sociétés, adresses, dates et lieux de naissance, SIREN/SIRET, TVA, IBAN, NIR,
e-mails et téléphones sont remplacés par des marqueurs (`[PERSONNE_1]`, `[SOCIETE_2]`, `[ADRESSE_1]`…) avant que Claude ne
lise quoi que ce soit ; les documents produits par Claude sont ensuite ré-identifiés sur votre poste, avec les vraies
données, directement dans le dossier de l'affaire.

```
Pièce sur votre poste : « Madame Hélène Vasseur, 14 rue des Tanneurs, 69005 Lyon, IBAN FR76 3000 6000 0112 3456 7890 189… »
Ce que Claude lit       : « Madame [PERSONNE_1], [ADRESSE_1], IBAN [IBAN_1]… »
Courrier enregistré      : « Madame Hélène Vasseur… » (Word, dans le dossier de l'affaire, mise en forme de votre modèle)
```

> Pensée pour les avocats et les professions tenues au secret : l'outil limite ce qui est transmis à l'IA, il ne
> remplace pas votre vigilance. Aucun détecteur n'est exhaustif : relisez avant tout envoi.
>
> **Ce qui n'est pas filtré** : ce que vous tapez ou collez directement dans la conversation, et les fichiers que vous
> **joignez ou glissez dans la zone de saisie** de Claude — ils partent tels quels.
> - Laissez les pièces dans le dossier de l'affaire (ou demandez à Claude « importe les pièces »)
> et demandez à Claude de les lire ;
> - Pour un texte, copiez-le (Control + C ou Séléctionner le texte et "Copier"), puis demandez à Claude de « lire le presse-papiers ».

## Comment utiliser l'extension avec Claude

| Vous dites à Claude | Ce qui se passe sur votre poste |
|---|---|
| « Ouvre un nouveau dossier » | Dossier créé sous une référence neutre (`2026-11-25-01`) ; le libellé réel se tape dans une fenêtre locale |
| « Choisis le dossier de l'affaire » | Vous désignez le dossier dans une fenêtre ; les pièces sont lues **sur place**, sans copie |
| « Importe les pièces » / « les 3 derniers téléchargements » | Copie dans le dossier ; Claude ne voit que des noms de fichiers pseudonymisés |
| « Lis le presse-papiers » | Le courriel que vous avez copié est enregistré ; Claude n'en reçoit que la version pseudonymisée |
| « Montre mes derniers courriels », « importe le C2 » | Lecture de votre messagerie (IMAP, lecture seule) ; message et pièces jointes rangés dans le dossier |
| « Prépare le courrier sur mon modèle » | Votre modèle Word est rempli (styles, en-têtes, logo conservés) puis ré-identifié |
| « Mets la réponse dans le presse-papiers » | Réponse ré-identifiée prête à coller dans votre webmail, hors historique du presse-papiers Windows |
| « Lyon n'est pas une personne », « ajoute ce nom oublié » | Correction du dossier (`corriger_entite`) ; un nom à ajouter se tape dans une fenêtre locale |

PDF scannés lus par reconnaissance de caractères (OCR), Word, OpenDocument, courriels, RTF, HTML et texte pris en charge.
Un journal local trace chaque opération **sans aucune donnée en clair**.

**Règle absolue du projet** : aucun outil ne renvoie à Claude un texte, un nom de fichier ou un chemin contenant des
données réelles. Le texte ré-identifié est écrit sur votre poste ou dans le presse-papiers, jamais dans la conversation.

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

## Installation (Windows)

1. **Claude Desktop** installé et connecté.

2. Téléchargez [`paquets/anonymiseur-cabinet-1.6.1.mcpb`](paquets/) puis, dans Claude Desktop : Paramètres (`Ctrl` + `,`)
   → **Extensions** → glissez le fichier dans la fenêtre et validez l'installation.

3. Dans les réglages de l'extension :
   - **Dossier racine de vos dossiers** : le dossier qui contient vos affaires ;
   - cochez **Moteur local (sans serveur)** ;
   - facultatif : dossier de vos modèles Word, messagerie IMAP (le mot de passe est stocké chiffré par Claude Desktop).

4. **Ollama** (reconnaissance des noms - facultatif) : installez-le depuis [ollama.com](https://ollama.com/download), puis
   dans un terminal :
   ```
   ollama pull ministral-3:3b
   ```
   Le modèle (2,8 Go) n'est téléchargé qu'une fois. Sans Ollama, l'extension fonctionne avec les règles seules et vous le signale.

6. Facultatif, pour les PDF scannés : **Tesseract**
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
   
8. Ouvrez une nouvelle conversation et dites : « Vérifie l'anonymiseur ».

Serveur Linux (facultatif) : voir [`serveur-ubuntu/LISEZMOI.md`](serveur-ubuntu/LISEZMOI.md) (`sudo bash install.sh`).

## Vérifications

```
node --test tests/extension.test.js      # 32 tests de l'extension (données fictives)
node tests/comparer-moteurs.js           # moteur local et serveur : résultats identiques
cd serveur-ubuntu && python -m tests.test_moteur
```

## Limites

- **Ce que vous tapez ou collez directement dans la conversation n'est pas filtré : passez par « lis le presse-papiers ».**
- La reconnaissance des noms par un petit modèle prend environ 15 à 30 s par page sur un portable sans carte graphique.
- L'OCR peut déformer un nom propre, qui échappe alors au masquage : relisez les PDF scannés.
- Un PDF contenant déjà des marqueurs ne peut pas être ré-identifié : faites produire un Word.

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
