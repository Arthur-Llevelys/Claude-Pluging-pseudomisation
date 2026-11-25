# Serveur d'anonymisation — version 1.3.0

## Nouveau dans la 1.3.0

- **PDF scannés lus par OCR** : un PDF sans texte (scan) passe automatiquement par `ocrmypdf` (Tesseract, français)
  avant l'analyse ; les pages déjà textuelles sont gardées telles quelles. `install.sh` installe
  `ocrmypdf` et `tesseract-ocr-fra`. Si l'OCR manque ou échoue, la lecture le dit clairement au lieu de rendre un
  texte vide. Réglages facultatifs (`/etc/anonymiseur/anonymiseur.env`) : `ANON_OCR=0` (désactiver),
  `ANON_OCR_LANGUES=fra+eng`, `ANON_OCR_DELAI=300` (secondes).
- **Prénom rattaché au nom** : quand le modèle de langue ne reconnaît que le nom de famille (« Dupont »), le prénom
  qui le précède (« Jean ») est masqué avec lui.

---

Mise à jour du serveur Ubuntu de l'Anonymiseur (cabinet). Elle regroupe les corrections de détection
relevées sur un dossier réel (1.1.0) et les corrections de dossier (1.2.0). Elle fonctionne avec toutes les
versions de l'extension ; l'outil `corriger_entite` demande l'extension 1.5.0.

## Nouveau dans la 1.2.0

- **Corrections d'un dossier** (route `POST /api/dossiers/{référence}/corriger`, utilisée par l'outil
  `corriger_entite` de l'extension) : *fusionner* deux marqueurs désignant la même personne (l'ancien marqueur
  reste ré-identifiable), *exclure* un marqueur masqué à tort (sa valeur reste en clair dans les nouveaux
  documents du dossier), *réintégrer*, *ajouter* une donnée oubliée. Les réponses ne contiennent que des marqueurs.
- **Export des valeurs réelles fermé par défaut** : l'écran « Dossiers » de l'interface web n'affiche plus que
  les marqueurs. Pour rouvrir l'export, ajoutez `ANON_EXPORT_VALEURS=1` dans `/etc/anonymiseur/anonymiseur.env`
  puis `sudo systemctl restart anonymiseur`.
- **Correctif** : une valeur déjà connue contenant une apostrophe (« Conseil d'État », « D'ARTOIS ») n'était
  jamais retrouvée dans les documents suivants du dossier.

## Corrections de détection (1.1.0)

**Données qui n'étaient pas masquées**

| Cas | Exemple (fictif) | Résultat |
|---|---|---|
| Numéro RCS / SIREN / SIRET coupé par un retour à la ligne | `RCS de Lyon sous le n° 352 332` ⏎ `159` | un seul `[SIREN_1]`, restitué sur une ligne |
| Nom isolé dans un tableau, derrière un repère de lot | `S09 Dupont`, `Lot 14 Marchetti`, `S09 \| Dupont \| 92,00 €` | `S09 [PERSONNE_1]` |
| Adresse avec qualificatif | `110 Grande rue de la Guillotière` | adresse entière masquée |
| Adresse à numéro double | `16/18 rue Paul Verdier`, `16-18`, `16 et 18` | adresse entière masquée |
| Société à dénomination | `l'Agence Martin Bellecour` | `l'[SOCIETE_1]` (une seule entité) |

**Texte masqué à tort**

| Cas | Exemple | Résultat |
|---|---|---|
| Montant avalé par un marqueur | `12 rue des Tanneurs 92,00 €` donnait `[ADRESSE_8],00 €` | `[ADRESSE_1] 92,00 €` |
| Référence d'article prise pour une personne | `L. 441-6`, `R. 123-4`, `n° 19-12.345` | laissée en clair |
| Ville seule | `Fait à Lyon` | laissée en clair (masquée dans une adresse complète) |
| Mot courant ou sigle | `Montant`, `Créance`, `Objet`, `Subject`, `LRAR` | laissé en clair |
| « Son IBAN » pris pour une personne | `Son IBAN est FR76…` donnait `[PERSONNE_2] est [IBAN_1]` | `Son IBAN est [IBAN_1]` |

Les montants et les références juridiques sont désormais des **zones protégées** : aucune entité ne peut
les contenir, quelle que soit la règle ou la proposition du modèle de langue.

## Dossiers déjà ouverts

Les mots enregistrés à tort par l'ancienne version (« Montant », « Lyon », « Son IBAN », une initiale)
cessent d'être masqués dans les nouveaux documents. Leur marqueur reste connu : un ancien document
contenant `[PERSONNE_2]` se ré-identifie toujours. Lorsqu'un tel mot figure dans un texte, la réponse
le signale par un avertissement qui ne cite que des marqueurs, jamais de valeur.

Un vrai nom qui est aussi un mot courant (« M. Bureau ») reste reconnu par sa civilité et reste masqué
dans tous les documents suivants du dossier.

## Listes modifiables sans toucher au code

Dans `/etc/anonymiseur/`, puis `sudo systemctl restart anonymiseur` :

| Fichier | Rôle |
|---|---|
| `ne_jamais_masquer.txt` | expressions à ne jamais masquer (une par ligne) |
| `toujours_masquer.txt` | termes à toujours masquer, tous dossiers (`TYPE: valeur`) |
| `mots_courants.txt` *(nouveau)* | mots ordinaires qui ne sont jamais un nom à eux seuls |
| `villes.txt` *(nouveau)* | villes et lieux qui ne sont jamais un nom à eux seuls |

Pour une seule demande, l'API accepte aussi `options.jamais` (liste d'expressions à ne pas masquer),
à côté de `options.termes` (à masquer en plus). Les listes livrées sont dans `app/data/`.

## Mise à jour

Depuis le poste Windows, dans le dossier qui contient l'archive (remplacez `utilisateur`) :

```
scp anonymiseur-serveur-1.3.0.tar.gz utilisateur@ADRESSE_DU_SERVEUR:
ssh -t utilisateur@ADRESSE_DU_SERVEUR "tar xzf anonymiseur-serveur-1.3.0.tar.gz && sudo bash anonymiseur-serveur-1.3.0/install.sh"
```

`install.sh` conserve la clé d'API, la clé de chiffrement, les fichiers de `/etc/anonymiseur` et la
table de correspondance. Avant de remplacer le code, il fait une copie de sécurité de la table
(`correspondances.db.avant-mise-a-jour`, chiffrée comme l'original, même dossier protégé) ; le serveur
la supprime de lui-même à l'issue de la durée de conservation (30 jours par défaut).

La table reçoit une colonne supplémentaire à la première ouverture. Elle reste lisible par la
version 1.0.1 : un retour en arrière consiste à relancer l'`install.sh` de l'ancienne version.

## Vérification sur le serveur

```
cd /opt/anonymiseur && sudo -u anonymiseur venv/bin/python -m tests.test_moteur
```

La dernière ligne doit être `Résultat : TOUT EST OK`. Les contrôles n'utilisent que des données
fictives et des bases temporaires ; ils ne lisent ni n'écrivent la table de correspondance du cabinet.

## Limites connues

- Un nom de tableau n'est reconnu que juste après un repère (`S09`, `Lot 12`, `Appt 3`…). Un nom seul
  dans une cellule, sans repère ni civilité, dépend du modèle de langue.
- Un nom de famille qui est aussi un mot courant (« Bureau », « Jardin », « Page ») n'est reconnu que
  précédé d'une civilité ou d'un prénom, ou imposé dans `toujours_masquer.txt`.
- Une forme abrégée (« Madame Vasseur ») porte le même marqueur que le nom complet et est donc
  restituée sous la forme complète (« Madame Hélène Vasseur »).
- Une relecture humaine reste nécessaire avant tout envoi : aucun détecteur n'est exhaustif.
