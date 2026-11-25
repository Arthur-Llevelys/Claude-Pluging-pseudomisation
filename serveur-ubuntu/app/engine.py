# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
# Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
"""Orchestration : anonymisation et ré-identification."""
from __future__ import annotations

import re
from collections import Counter

from . import detect as D
from .store import GENERATION, Store

CONSIGNE = (
    "Consigne : le texte ci-dessous a été pseudonymisé. Les éléments d'identification "
    "ont été remplacés par des marqueurs entre crochets ([PERSONNE_1], [SOCIETE_1], "
    "[ADRESSE_1], [SIRET_1]…). Reprends ces marqueurs exactement à l'identique dans ta "
    "réponse (sans les traduire, les accorder ni les modifier) et ne cherche pas à deviner "
    "les données d'origine. Un même marqueur désigne toujours la même personne ou entité."
)

TYPES_RE = "|".join(sorted(D.TYPES, key=len, reverse=True))
# Tolérant : [PERSONNE_1], [ PERSONNE_1 ], [Personne_1], PERSONNE_1, [PERSONNE 1]
RE_MARQUEUR_SOUPLE = re.compile(
    rf"\[\s*({TYPES_RE})[ _\-]?(\d+)\s*\]|(?<![\w\[])({TYPES_RE})_(\d+)(?![\w\]])", re.IGNORECASE)


class Moteur:
    def __init__(self, store: Store, listes: D.Listes):
        self.store = store
        self.listes = listes

    # ------------------------------------------------------------------
    def _faux_positif_ancien(self, type_: str, valeur: str) -> bool:
        """Valeur enregistrée par une version antérieure et que les règles actuelles n'accepteraient plus."""
        if type_ not in {"PERSONNE", "SOCIETE"}:
            return False
        v = valeur.strip()
        if re.fullmatch(r"[A-ZÀ-Ý]\.?", v):  # initiale seule
            return True
        mots = [m for m in re.split(r"[\s\-]+", v) if m]
        if mots and all(D.est_mot_banal(m, self.listes.courants) for m in mots):
            return True
        return D.est_ville(v, self.listes.villes)

    # ------------------------------------------------------------------
    def anonymiser(self, texte: str, dossier: str, options: dict | None = None,
                   inclure_valeurs: bool = False) -> dict:
        options = options or {}
        dossier = self.store.valider_dossier(dossier)
        self.store.toucher(dossier)

        types = set(options.get("types") or D.TYPES_PAR_DEFAUT)
        toutes_dates = bool(options.get("toutes_dates"))
        if toutes_dates:
            types.add("DATE")
        utiliser_ner = options.get("ner", True)

        # Marqueurs déjà présents dans le texte : on n'y touche pas
        zones_marqueurs = [(m.start(), m.end()) for m in D.RE_MARQUEUR.finditer(texte)]

        def hors_marqueurs(spans):
            return [s for s in spans if not any(a < s.end and s.start < b for a, b in zones_marqueurs)]

        # Zones protégées : montants et références juridiques, jamais inclus dans une entité
        zones = D.zones_protegees(texte)
        # Termes à ne jamais masquer : liste permanente + ceux transmis avec la demande
        jamais = set(self.listes.jamais)
        for t in options.get("jamais") or []:
            if isinstance(t, str) and t.strip():
                jamais.add(D.normaliser(t))

        # 1. Détection automatique
        spans = D.detecter_regles(texte, types, toutes_dates, self.listes)
        if utiliser_ner:
            spans += [s for s in D.detecter_ner(texte, self.listes) if s.type in types]

        # 2. Termes imposés (liste permanente + termes du formulaire)
        imposes = list(self.listes.toujours)
        for t in options.get("termes") or []:
            if isinstance(t, str) and t.strip():
                imposes.append(D.analyser_terme(t))
        spans += D.rechercher_termes(texte, imposes, D.P_IMPOSE, "impose")

        # 3. Valeurs déjà connues du dossier (cohérence entre documents)
        # Une valeur enregistrée à tort par une version antérieure (« Montant », « Lyon », « Son IBAN »,
        # une initiale seule) n'est plus recherchée : elle cesse d'être masquée, sans perdre son marqueur.
        # Les valeurs enregistrées depuis la version 1.1.0 ont déjà passé ces contrôles : elles sont
        # toujours recherchées (« M. Bureau » reste masqué dans les documents suivants).
        connues, ecartees = [], []
        for marqueur, type_, valeur, canonique, generation in self.store.valeurs_connues(dossier):
            if generation < GENERATION and self._faux_positif_ancien(type_, valeur):
                if D.rechercher_termes(texte, [(type_, valeur)], 0, "ancien", exiger_majuscule=True):
                    ecartees.append(marqueur)
                continue
            connues.append((marqueur, type_, valeur, canonique))
        for marqueur, type_, valeur, canonique in connues:
            un_mot = len(valeur.split()) == 1
            spans += D.rechercher_termes(
                texte, [(type_, valeur)], D.P_CONNU, "connu",
                exiger_majuscule=(type_ in {"PERSONNE", "SOCIETE", "AUTRE"} and un_mot))

        # Valeurs exclues par l'utilisateur pour ce dossier (corriger_entite) : plus jamais masquées, sauf terme imposé
        exclus = self.store.exclusions(dossier)

        def non_exclus(liste):
            if not exclus:
                return liste
            return [s for s in liste if s.source == "impose"
                    or self.store.empreinte(dossier, D.normaliser(texte[s.start:s.end], s.type)) not in exclus]

        spans = non_exclus(D.appliquer_zones(hors_marqueurs(spans), zones, texte))
        retenus = D.resoudre(spans, texte, jamais)

        # 4. Propagation : « Jean DUPONT » => « DUPONT », « M. Dupont »…
        propag = []
        references = {(s.type, s.value) for s in retenus if s.type in {"PERSONNE", "SOCIETE"}}
        references |= {(t, v) for _, t, v, c in connues if c and t in {"PERSONNE", "SOCIETE"}}
        for type_, valeur in references:
            # autres occurrences de la valeur complète (ex. en capitales dans un titre)
            propag += D.rechercher_termes(texte, [(type_, valeur)], D.P_PROPAGATION + 1, "meme_texte",
                                          exiger_majuscule=True)
            for variante in D.variantes_nom(valeur, type_):
                if D.normaliser(variante) in jamais:
                    continue
                for s in D.rechercher_termes(texte, [(type_, variante)], D.P_PROPAGATION, "propagation",
                                             exiger_majuscule=True):
                    s.canonical = valeur
                    propag.append(s)
        if propag:
            propag = non_exclus(D.appliquer_zones(hors_marqueurs(propag), zones, texte))
            retenus = D.resoudre(spans + propag, texte, jamais)
        # « Agence » + « Martin Bellecour » proposés séparément : une seule société
        retenus = D.fusionner_adjacents(retenus, texte)

        # Rattacher une forme courte détectée isolément (« Monsieur DUPONT »)
        # au nom complet (« Jean-Pierre DUPONT ») quand il n'y a pas d'ambiguïté.
        variante_vers_ref: dict[tuple[str, str], set[str]] = {}
        for type_, valeur in references:
            for v in D.variantes_nom(valeur, type_):
                variante_vers_ref.setdefault((type_, D.normaliser(v)), set()).add(D.normaliser(valeur))
        refs_originales = {D.normaliser(v): v for _, v in references}
        for s in retenus:
            if s.source == "propagation" or s.type not in {"PERSONNE", "SOCIETE"}:
                continue
            refs = variante_vers_ref.get((s.type, D.normaliser(s.value)))
            if refs and len(refs) == 1:
                ref = next(iter(refs))
                if ref != D.normaliser(s.value):
                    s.source, s.canonical = "propagation", refs_originales[ref]

        # 5. Attribution des marqueurs (références d'abord, variantes ensuite)
        attribution: dict[int, str] = {}
        ordre = sorted(range(len(retenus)), key=lambda i: retenus[i].source == "propagation")
        for i in ordre:
            s = retenus[i]
            norm = D.normaliser(s.value, s.type)
            canon = D.normaliser(s.canonical, s.type) if s.source == "propagation" and s.canonical else None
            # Une valeur coupée par un retour à la ligne (numéro RCS en fin de ligne) est enregistrée d'un seul tenant
            valeur = re.sub(r"[ \t]*\r?\n[ \t]*", " ", s.value.strip())
            attribution[i] = self.store.marqueur_pour(dossier, s.type, valeur, norm, canonique_de=canon)
        self.store.valider()

        # 6. Remplacement
        morceaux, pos = [], 0
        for i, s in enumerate(retenus):
            morceaux.append(texte[pos:s.start])
            morceaux.append(attribution[i])
            pos = s.end
        morceaux.append(texte[pos:])
        sortie = "".join(morceaux)

        if options.get("consigne"):
            sortie = CONSIGNE + "\n\n---\n\n" + sortie

        compte = Counter(attribution.values())
        types_par_marqueur = {attribution[i]: retenus[i].type for i in attribution}
        entites = []
        inverse = self.store.table_inverse(dossier) if inclure_valeurs else {}
        for marqueur, n in compte.items():
            e = {"marqueur": marqueur, "type": types_par_marqueur[marqueur], "occurrences": n}
            if inclure_valeurs:
                e["valeur"] = inverse.get(marqueur, "")
                e["formes"] = sorted({retenus[i].value for i in attribution if attribution[i] == marqueur})
            entites.append(e)
        entites.sort(key=lambda e: (e["type"], int(re.sub(r"\D", "", e["marqueur"]) or 0)))

        stats = Counter(e["type"] for e in entites)
        avert = []
        ner = D.etat_spacy()
        if utiliser_ner and not ner["actif"]:
            avert.append("Détection des noms par spaCy inactive : seules les règles ont été appliquées. "
                         "Relisez particulièrement les noms de personnes et de sociétés.")
        if ecartees:
            # Uniquement des marqueurs : jamais la valeur elle-même
            avert.append("Mots courants, villes ou initiales enregistrés à tort par une version antérieure et "
                         "laissés en clair dans ce texte : " + ", ".join(sorted(set(ecartees))) + ".")
        return {
            "dossier": dossier,
            "texte": sortie,
            "entites": entites,
            "statistiques": dict(stats),
            "nb_remplacements": len(retenus),
            "avertissements": avert,
        }

    # ------------------------------------------------------------------
    @staticmethod
    def _marqueur(m: str) -> str:
        r = RE_MARQUEUR_SOUPLE.fullmatch(str(m).strip())
        if not r:
            raise ValueError(f"Marqueur mal formé : {str(m)[:40]}")
        return f"[{(r.group(1) or r.group(3)).upper()}_{r.group(2) or r.group(4)}]"

    def corriger(self, dossier: str, action: str, marqueurs: list | None = None,
                 type_: str | None = None, valeur: str | None = None) -> dict:
        """Corrections d'un dossier : fusionner, exclure, reinclure, ajouter. Ne renvoie jamais de valeur réelle."""
        dossier = self.store.valider_dossier(dossier)
        connus = self.store.types_marqueurs(dossier)
        ms = list(dict.fromkeys(self._marqueur(m) for m in (marqueurs or [])))
        if action in {"fusionner", "exclure", "reinclure"}:
            if not ms:
                raise ValueError("Indiquez le ou les marqueurs concernés.")
            inconnus = [m for m in ms if m not in connus]
            if inconnus:
                raise ValueError("Marqueur(s) inconnu(s) dans ce dossier : " + ", ".join(inconnus))
        if action == "fusionner":
            if len(ms) < 2:
                raise ValueError("Indiquez au moins deux marqueurs : celui à garder, puis celui ou ceux à fusionner.")
            n = self.store.fusionner(dossier, ms[0], ms[1:])
            return {"action": action, "marqueur": ms[0], "absorbes": ms[1:], "valeurs": n}
        if action == "exclure":
            n = sum(self.store.exclure(dossier, m) for m in ms)
            return {"action": action, "marqueurs": ms, "valeurs": n}
        if action == "reinclure":
            n = sum(self.store.reinclure(dossier, marqueur=m) for m in ms)
            return {"action": action, "marqueurs": ms, "valeurs": n}
        if action == "ajouter":
            if type_ not in D.TYPES:
                raise ValueError("Type inconnu : " + ", ".join(D.TYPES))
            v = (valeur or "").strip()
            if len(v) < 2 or D.RE_MARQUEUR.search(v) or len(v) > 300:
                raise ValueError("Valeur invalide (2 à 300 caractères, sans marqueur).")
            norm = D.normaliser(v, type_)
            self.store.reinclure(dossier, empreinte=self.store.empreinte(dossier, norm))
            deja = {m for m in connus}
            m = self.store.marqueur_pour(dossier, type_, v, norm)
            self.store.valider()
            return {"action": action, "marqueur": m, "deja_connu": m in deja}
        raise ValueError("Action inconnue : fusionner, exclure, reinclure ou ajouter.")

    # ------------------------------------------------------------------
    def reidentifier(self, texte: str, dossier: str) -> dict:
        dossier = self.store.valider_dossier(dossier)
        table = self.store.table_inverse(dossier)
        self.store.toucher(dossier)
        remplaces = 0
        inconnus: set[str] = set()

        def remplacer(m: re.Match) -> str:
            nonlocal remplaces
            type_ = (m.group(1) or m.group(3)).upper()
            num = m.group(2) or m.group(4)
            cle = f"[{type_}_{num}]"
            if cle in table:
                remplaces += 1
                return table[cle]
            inconnus.add(cle)
            return m.group(0)

        sortie = RE_MARQUEUR_SOUPLE.sub(remplacer, texte)
        # Retirer la consigne si elle a été recopiée
        sortie = sortie.replace(CONSIGNE + "\n\n---\n\n", "")
        return {"dossier": dossier, "texte": sortie, "nb_remplacements": remplaces,
                "marqueurs_inconnus": sorted(inconnus)}
