#!/usr/bin/env node
/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU Affero General Public License v3 ou ultérieure (fichiers LICENSE et NOTICE).
 * La mention ci-dessus doit être conservée dans toute version dérivée (AGPL, article 7 b et c).
 *
 * Anonymiseur — extension Claude Desktop (serveur MCP local, sans dépendance).
 *
 * Principe : Claude ne lit JAMAIS vos fichiers en clair. Cette extension lit le
 * fichier sur votre poste, l'envoie à votre serveur d'anonymisation (réseau
 * local), et ne transmet à Claude que la version pseudonymisée. À l'inverse,
 * elle reçoit de Claude un texte à marqueurs, le fait ré-identifier par le
 * serveur et l'écrit directement sur votre disque — sans jamais renvoyer le
 * texte en clair à Claude.
 *
 * Version 1.1.0 — travail sur place, sans copie de fichiers :
 *  - choisir_dossier : vous désignez le dossier d'affaire dans une fenêtre de
 *    sélection ; Claude n'en voit jamais le nom réel ;
 *  - les documents sont lus là où ils se trouvent ;
 *  - les livrables ré-identifiés sont écrits dans ce même dossier ;
 *  - reidentifier_fichier : remet les vraies données dans un fichier (docx,
 *    texte…) qui contient des marqueurs ;
 *  - chaque dossier reçoit automatiquement sa propre référence d'anonymisation.
 *
 * Version 1.1.1 — correction : le serveur démarre aussi lorsqu'il est chargé par le lanceur
 * intégré de Claude Desktop (la 1.1.0 ne répondait pas dans l'application).
 *
 * Version 1.2.0 — dossier d'affaire et imports sans passer par la conversation :
 *  - creer_dossier_affaire : crée le dossier sous la racine avec une référence neutre
 *    (AAAA-MM-JJ-NN) ; le libellé réel éventuel est saisi dans une fenêtre locale ;
 *  - importer_fichiers : copie dans le dossier courant des fichiers désignés dans une
 *    fenêtre de sélection, ou les derniers fichiers du dossier Téléchargements ;
 *  - importer_presse_papiers : enregistre le texte copié par l'utilisateur et n'en renvoie
 *    que la version pseudonymisée ;
 *  - reidentifier_vers_presse_papiers : place un texte ré-identifié dans le presse-papiers,
 *    exclu de l'historique et de la synchronisation de Windows ;
 *  - journal local des opérations, sans aucune donnée en clair.
 *
 * Version 1.3.0 — restitution :
 *  - enregistrer_document avec modele + remplacements : le modèle Word du cabinet est rempli,
 *    mise en forme conservée (texte réparti sur plusieurs morceaux compris), puis ré-identifié ;
 *  - enregistrer_fichier : fichier produit par Claude (docx, xlsx, pptx…) reçu en base64 ;
 *  - lister_modeles : modèles du dossier des modèles configuré ;
 *  - ouverture automatique du livrable dans l'application par défaut (réglage ou paramètre ouvrir).
 *
 * Version 1.4.0 — moteur local, sans serveur (réglage « Moteur local ») :
 *  - règles de détection du serveur 1.1.0 portées en JavaScript (server/moteur/detect.js), résultats identiques ;
 *  - reconnaissance des noms par un petit modèle local via Ollama (server/moteur/ner-ollama.js) ;
 *  - table de correspondance chiffrée par affaire sur le poste, clé protégée par Windows (server/moteur/moteur.js) ;
 *  - lecture des documents et production des docx sur le poste (server/moteur/fichiers.js).
 *
 * Version 1.5.0 — corrections : corriger_entite (fusionner, exclure, reinclure, ajouter), avec le serveur 1.2.0
 * comme avec le moteur local ; la donnée à ajouter est tapée par l'utilisateur dans une fenêtre locale.
 *
 * Version 1.6.0 — PDF scannés et courriels : OCR (Tesseract) dans le moteur local, ocrmypdf sur le serveur 1.3.0 ;
 * importer_courriel lit la messagerie (IMAP, lecture seule) et range le message et ses pièces jointes dans le dossier.
 *
 * Protocole : MCP (JSON-RPC 2.0) sur stdio, messages séparés par des sauts de ligne.
 */
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { fileURLToPath } = require("url");

const VERSION = "1.6.1";
const SERVEUR = (process.env.ANON_SERVEUR || "http://127.0.0.1:8765").replace(/\/+$/, "");
const CLE = process.env.ANON_CLE || "";
const DOSSIER_TRAVAIL = process.env.ANON_DOSSIER_TRAVAIL || "";
const DOSSIER_SORTIE = process.env.ANON_DOSSIER_SORTIE || "";
const DOSSIER_DEFAUT = process.env.ANON_DOSSIER_DEFAUT || "general";
const SOUS_DOSSIER_LIVRABLES = process.env.ANON_SOUS_DOSSIER_LIVRABLES || "";
const SOUS_DOSSIER_AFFAIRES = process.env.ANON_SOUS_DOSSIER_AFFAIRES || "";
const DOSSIER_MODELES = process.env.ANON_DOSSIER_MODELES || "";
const OUVRIR_AUTO = /^(1|true|oui|yes)$/i.test(process.env.ANON_OUVRIR_AUTO || "");
const SAUT = " "; // saut de ligne à convertir en <w:br/> dans un document Word
const FICHIER_AFFAIRE = ".anonymiseur-affaire.json"; // fiche cachée d'un dossier d'affaire : références neutres seulement
const RE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}$/;
const MAX_IMPORT_OCTETS = 100 * 1024 * 1024;
const MAX_TELECHARGEMENTS = 20;
// Messagerie (importer_courriel) : réglages de l'extension, mot de passe stocké chiffré par Claude Desktop
const IMAP = {
  hote: process.env.ANON_IMAP_SERVEUR || "", port: parseInt(process.env.ANON_IMAP_PORT || "", 10) || 993,
  utilisateur: process.env.ANON_IMAP_UTILISATEUR || "", motDePasse: process.env.ANON_IMAP_MOT_DE_PASSE || "",
  dossier: process.env.ANON_IMAP_DOSSIER || "", tls: !/^(0|false|non)$/i.test(process.env.ANON_IMAP_TLS || ""),
};
const courrielsConnus = new Map(); // C1 -> { uid, validite }
const TAILLE_PARTIE = 80000; // caractères renvoyés à Claude par appel
const MAX_OCTETS = 25 * 1024 * 1024;
const MAX_FICHIERS = 500;
const PROFONDEUR_MAX = 6;
const EXTENSIONS = new Set([".txt", ".md", ".csv", ".docx", ".odt", ".pdf", ".rtf", ".html", ".htm", ".eml"]);
// Formats dans lesquels on sait remettre les vraies données à la place des marqueurs
const EXT_REID_ZIP = new Set([".docx", ".pptx", ".xlsx", ".odt", ".ods", ".odp"]);
const EXT_REID_TEXTE = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".html", ".htm", ".xml", ".json", ".tex", ".eml", ".rtf"]);
const VERSIONS_PROTOCOLE = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// Le dossier courant est oublié après ce délai sans utilisation (évite d'écrire dans le dossier de la veille)
const DUREE_COURANT_MS = (parseFloat(process.env.ANON_DUREE_DOSSIER_COURANT_H) || 12) * 3600 * 1000;
// Temps d'attente de la fenêtre de sélection avant de rendre la main à Claude (la fenêtre reste ouverte)
const ATTENTE_SELECTION_MS = parseInt(process.env.ANON_ATTENTE_SELECTION_MS || "45000", 10) || 45000;
const DELAI_MAX_SELECTION_MS = 15 * 60 * 1000;
const TYPES_PAR_DEFAUT = ["PERSONNE", "SOCIETE", "ADRESSE", "DATE_NAISSANCE", "LIEU_NAISSANCE", "SIRET", "SIREN", "TVA",
  "EMAIL", "TELEPHONE", "IBAN", "NIR", "DATE", "AUTRE"];

const log = (...a) => process.stderr.write("[anonymiseur] " + a.join(" ") + "\n");

// ---------------------------------------------------------------------------
// Outils utilitaires
// ---------------------------------------------------------------------------
class ErreurOutil extends Error {}

function valeurConfig(v) {
  // Claude Desktop laisse parfois « ${user_config.x} » si le champ est vide
  return v && !/^\$\{user_config\./.test(v) ? v : "";
}

function existeDossier(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function reel(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function dansRacine(racineAbs, cible) {
  const rel = path.relative(racineAbs, cible);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Dossier racine configuré dans les réglages (peut être absent ou momentanément injoignable). */
function racineConfiguree() {
  const v = valeurConfig(DOSSIER_TRAVAIL);
  return v && existeDossier(v) ? reel(v) : null;
}

/** Dossier des modèles de documents (réglage facultatif). */
function racineModeles() {
  const v = valeurConfig(DOSSIER_MODELES);
  return v && existeDossier(v) ? reel(v) : null;
}

function racineSortie() {
  const v = valeurConfig(DOSSIER_SORTIE);
  return v && existeDossier(v) ? reel(v) : null;
}

// ---------------------------------------------------------------------------
// Moteur local (sans serveur) : mêmes réponses que le serveur d'anonymisation, calculées sur le poste
// ---------------------------------------------------------------------------
const MOTEUR_LOCAL = /^(1|true|oui|yes|local)$/i.test(valeurConfig(process.env.ANON_MOTEUR_LOCAL || ""));
const OLLAMA_URL = valeurConfig(process.env.ANON_OLLAMA_URL || "") || "http://127.0.0.1:11434";
const OLLAMA_MODELE = valeurConfig(process.env.ANON_OLLAMA_MODELE || "") || "ministral-3:3b";
let moteurLocalPret = null;

function moteurLocal() {
  if (!moteurLocalPret) {
    moteurLocalPret = (async () => {
      const { Moteur, Stockage } = require("./moteur/moteur");
      const D = require("./moteur/detect");
      const { creerFichiers } = require("./moteur/fichiers");
      const base = path.dirname(FICHIER_ETAT);
      const stockage = await new Stockage(process.env.ANON_TABLES || path.join(base, "tables")).ouvrir();
      const listes = D.chargerListes(process.env.ANON_LISTES || path.join(base, "listes"));
      const ner = process.env.ANON_OLLAMA_DESACTIVE === "1" ? null : { url: OLLAMA_URL, modele: OLLAMA_MODELE };
      return { D, stockage, moteur: new Moteur(stockage, listes, ner), fichiers: creerFichiers({ lireZip, contenuEntree, ecrireZip, creerEntree }) };
    })();
    moteurLocalPret.catch(() => { moteurLocalPret = null; });
  }
  return moteurLocalPret;
}

/** Vérifie qu'Ollama répond et dispose du modèle (sans rien lui envoyer d'autre que la demande de liste). */
async function etatOllama() {
  const { adresseAutorisee, modeleAutorise } = require("./moteur/ner-ollama");
  if (process.env.ANON_OLLAMA_DESACTIVE === "1") return { actif: false, erreur: "désactivée" };
  if (!adresseAutorisee(OLLAMA_URL)) return { actif: false, erreur: "adresse Ollama refusée (seules les adresses locales ou du réseau privé sont acceptées)" };
  if (!modeleAutorise(OLLAMA_MODELE)) return { actif: false, erreur: "modèle « cloud » refusé (il enverrait le texte hors du poste)" };
  try {
    const r = await (await fetch(OLLAMA_URL.replace(/\/+$/, "") + "/api/tags", { signal: AbortSignal.timeout(4000) })).json();
    const noms = (r.models || []).map(x => x.name);
    if (!noms.some(n => n === OLLAMA_MODELE || n === OLLAMA_MODELE + ":latest")) return { actif: false, erreur: `modèle ${OLLAMA_MODELE} absent d'Ollama (ollama pull ${OLLAMA_MODELE})` };
    return { actif: true };
  } catch {
    return { actif: false, erreur: "Ollama ne répond pas (est-il installé et démarré ?)" };
  }
}

async function apiLocale(chemin, options = {}) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const methode = (options.method || "GET").toUpperCase();
  const url = new URL(chemin, "http://local");
  const corps = () => { try { return JSON.parse(options.body || "{}"); } catch { return {}; } };
  try {
    const L = await moteurLocal();
    if (url.pathname === "/api/sante") {
      const o = await etatOllama();
      return json({ ok: true, moteur: "local", version: "local " + VERSION, types: L.D.TYPES, types_par_defaut: L.D.TYPES_PAR_DEFAUT,
        spacy: { actif: o.actif, modele: `Ollama ${OLLAMA_MODELE}`, erreur: o.erreur || null }, cle_requise: false });
    }
    if (url.pathname === "/api/dossiers" && methode === "GET") return json({ dossiers: L.stockage.listerDossiers(), retention_jours: null });
    if (url.pathname === "/api/anonymiser" && methode === "POST") {
      const b = corps();
      if (!String(b.texte || "").trim()) return json({ erreur: "Le champ « texte » est vide." }, 400);
      return json(await L.moteur.anonymiser(String(b.texte), b.dossier || "general", b.options || {}, !!b.inclure_valeurs));
    }
    if (url.pathname === "/api/anonymiser-fichier" && methode === "POST") {
      const fd = options.body;
      const fichier = fd.get("fichier");
      const ext = path.extname((fichier && fichier.name) || "document.txt").toLowerCase();
      const { texte, avert } = await L.fichiers.extraireTexteAsync(ext, Buffer.from(await fichier.arrayBuffer()));
      if (!texte.trim()) return json({ erreur: "Aucun texte exploitable dans ce fichier. " + avert.join(" ") }, 400);
      let opts = {};
      try { opts = JSON.parse(fd.get("options") || "{}"); } catch { /* options par défaut */ }
      const r = await L.moteur.anonymiser(texte, fd.get("dossier") || "general", opts, false);
      r.avertissements = avert.concat(r.avertissements);
      r.nb_caracteres = texte.length;
      return json(r);
    }
    if (url.pathname === "/api/reidentifier" && methode === "POST") {
      const b = corps();
      return json(L.moteur.reidentifier(String(b.texte || ""), b.dossier || "general"));
    }
    if (url.pathname === "/api/reidentifier-fichier" && methode === "POST") {
      const b = corps();
      const fmt = ["docx", "md", "txt"].includes(String(b.format || "docx").toLowerCase()) ? String(b.format || "docx").toLowerCase() : null;
      if (!fmt) return json({ erreur: "Format attendu : docx, md ou txt." }, 400);
      const r = L.moteur.reidentifier(String(b.texte || ""), b.dossier || "general");
      const octets = fmt === "docx" ? L.fichiers.texteVersDocx(r.texte) : Buffer.from(r.texte, "utf8");
      return new Response(octets, { status: 200, headers: { "x-remplacements": String(r.nb_remplacements), "x-marqueurs-inconnus": r.marqueurs_inconnus.join(",") } });
    }
    const mc = /^\/api\/dossiers\/([^/]+)\/corriger$/.exec(url.pathname);
    if (mc && methode === "POST") {
      const b = corps();
      const ref = L.stockage.valider(decodeURIComponent(mc[1]));
      return json(Object.assign(L.moteur.corriger(ref, String(b.action || ""), b.marqueurs, b.type, b.valeur), { ok: true, dossier: ref }));
    }
    const m = /^\/api\/dossiers\/([^/]+)(\/entites)?$/.exec(url.pathname);
    if (m) {
      const ref = L.stockage.valider(decodeURIComponent(m[1]));
      if (methode === "DELETE") { L.stockage.supprimer(ref); return json({ ok: true, dossier: ref }); }
      return json({ dossier: ref, entites: L.stockage.entites(ref, url.searchParams.get("valeurs") === "1") });
    }
    return json({ erreur: "route inconnue" }, 404);
  } catch (e) {
    log("moteur local :", e.message);
    return json({ erreur: e.message }, 400);
  }
}

async function appelApi(chemin, options = {}) {
  if (MOTEUR_LOCAL) {
    const rep = await apiLocale(chemin, options);
    if (!rep.ok) {
      let msg = rep.statusText;
      try { msg = (await rep.json()).erreur || msg; } catch { /* corps non JSON */ }
      throw new ErreurOutil(`Moteur local : ${msg}`);
    }
    return rep;
  }
  const cle = valeurConfig(CLE);
  options.headers = Object.assign({}, options.headers || {}, cle ? { "X-API-Key": cle } : {});
  options.signal = AbortSignal.timeout(180000);
  let rep;
  try {
    rep = await fetch(SERVEUR + chemin, options);
  } catch (e) {
    throw new ErreurOutil(
      `Serveur d'anonymisation injoignable (${SERVEUR}). Vérifiez que le poste est sur le réseau du cabinet ` +
      `et que le service tourne (systemctl status anonymiseur). Détail : ${e.cause?.code || e.message}`);
  }
  if (rep.status === 401) throw new ErreurOutil("Clé d'API refusée par le serveur : vérifiez les réglages de l'extension.");
  if (!rep.ok) {
    let msg = rep.statusText;
    try { msg = (await rep.json()).erreur || msg; } catch { /* corps non JSON */ }
    throw new ErreurOutil(`Erreur du serveur d'anonymisation (${rep.status}) : ${msg}`);
  }
  return rep;
}

function nomDossier(d) {
  const v = (d || valeurConfig(DOSSIER_DEFAUT) || "general").trim();
  if (!/^[\p{L}\p{N}_\-. ]{1,64}$/u.test(v)) throw new ErreurOutil("Nom de dossier invalide (lettres, chiffres, espace, - _ .).");
  return v;
}

function taille(o) {
  return o < 1024 ? `${o} o` : o < 1048576 ? `${Math.round(o / 1024)} Ko` : `${(o / 1048576).toFixed(1)} Mo`;
}

function ilYA(horodatage) {
  const s = Math.max(0, Math.round((Date.now() - horodatage) / 1000));
  if (s < 90) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

// Identifiants courts des fichiers (F1, F2…) : le chemin réel reste sur le poste.
const fichiersConnus = new Map(); // id -> chemin absolu
const idsParChemin = new Map();
function idPour(chemin) {
  if (!idsParChemin.has(chemin)) {
    const id = "F" + (idsParChemin.size + 1);
    idsParChemin.set(chemin, id);
    fichiersConnus.set(id, chemin);
  }
  return idsParChemin.get(chemin);
}

/** Parcourt un dossier : documents pris en charge + décompte des fichiers ignorés par extension. */
async function parcourir(dir, recursif, profondeur = 0, acc = { fichiers: [], ignores: new Map(), tronque: false }, exts = EXTENSIONS) {
  let entrees;
  try { entrees = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  entrees.sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));
  for (const e of entrees) {
    if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursif && profondeur < PROFONDEUR_MAX) await parcourir(p, recursif, profondeur + 1, acc, exts);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (exts.has(ext)) acc.fichiers.push(p);
      else acc.ignores.set(ext || "(sans extension)", (acc.ignores.get(ext || "(sans extension)") || 0) + 1);
    }
    if (acc.fichiers.length >= MAX_FICHIERS) { acc.tronque = true; break; }
  }
  return acc;
}

async function anonymiserTexte(texte, dossier) {
  const rep = await appelApi("/api/anonymiser", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texte, dossier, options: { consigne: false }, inclure_valeurs: false }),
  });
  return rep.json();
}

// Noms de fichiers : après pseudonymisation par le serveur, on ne garde que les mots
// d'un vocabulaire documentaire courant ; tout autre mot est remplacé par « … ».
// (Un nom de fichier n'a pas de contexte : la détection y est moins fiable.)
const VOCABULAIRE = new Set((
  "le la les l d de du des un une et ou en au aux a pour par sur sous avec sans contre entre vs v n no num " +
  "final finale def definitif definitive version brouillon projet copie scan scanne signe signee signes original " +
  "modif modifie modifiee corrige corrigee annote relu relue valide validee draft " +
  "contrat contrats bail baux commercial commerciale habitation professionnel professionnelle avenant annexe annexes " +
  "piece pieces bordereau conclusions conclusion assignation requete ordonnance jugement arret decision memo note notes " +
  "consultation courrier courriers lettre lettres mail mails email emails courriel courriels mise demeure relance " +
  "facture factures devis avoir statuts statut kbis extrait pv proces verbal verbaux ag age ago assemblee generale " +
  "ordinaire extraordinaire cession parts actions protocole transaction accord accords convention conventions pacte " +
  "associes associe cgv cgu conditions generales vente cahier charges nda confidentialite rgpd dpa politique mentions " +
  "legales licenciement rupture conventionnelle prudhommes prud hommes titre acte actes notarie attestation attestations " +
  "certificat justificatif justificatifs releve releves compte comptes bilan liasse fiscale declaration dossier dossiers " +
  "client clients affaire affaires societe societes entreprise dirigeant gerant president fournisseur fournisseurs " +
  "partenaire prestataire contentieux precontentieux recouvrement injonction payer creance creances echeancier plan " +
  "mandat procuration pouvoir pouvoirs rapport audit analyse synthese chronologie calendrier planning agenda honoraires " +
  "reponse reponses question questions cr rendu reunion rdv tribunal cour appel cassation tj tc ca greffe huissier " +
  "commissaire justice signification commandement saisie expertise expert bon commande livraison reception travaux " +
  "chantier lot marche public offre candidature cv fiche paie bulletin salaire salarie employeur travail cdi cdd " +
  "demission sanction avertissement entretien prealable notification doc document documents fichier image photo photos " +
  "tableau liste modele trame exemple test nouveau nouvelle ancien ancienne janvier fevrier mars avril mai juin juillet " +
  "aout septembre octobre novembre decembre partie parties adverse adverses demande demandes defense replique dupliques " +
  "resiliation renouvellement conge loyer loyers charges depot garantie caution etat lieux inventaire diagnostic " +
  "mission lettre engagement tarif tarifs grille bareme divers autres autre brouillons archives archive " +
  "procedure procedures correspondance correspondances administratif administrative comptabilite juridique social " +
  "fiscal penal civil famille immobilier etrangers sejour asile recours refere fond instruction audience plaidoirie " +
  "ia restitution livrable livrables projets pieces adverses notre nos communiquees recues envoyees entrant sortant " +
  "presse papiers import importe importes importees telechargement telechargements jointe jointes"
).split(/\s+/));

function sansAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Remplace par « … » tout mot hors vocabulaire documentaire (les marqueurs sont conservés). */
function filtrerMots(texte) {
  const morceaux = texte.split(/(\[[A-Z_]+_\d+\]|\p{L}+)/u);
  const out = morceaux.map(m => {
    if (!m || /^\[[A-Z_]+_\d+\]$/.test(m) || !/^\p{L}+$/u.test(m)) return m;
    const n = sansAccents(m).toLowerCase();
    return m.length <= 2 || VOCABULAIRE.has(n) ? m : "…";
  }).join("");
  return out.replace(/…(?:[\s\-.]*…)+/g, "…");
}

function filtrerNomFichier(nom) {
  const ext = path.extname(nom);
  return filtrerMots(nom.slice(0, nom.length - ext.length)) + ext;
}

function resumeEntites(entites) {
  const parType = {};
  for (const e of entites || []) parType[e.type] = (parType[e.type] || 0) + 1;
  const s = Object.entries(parType).map(([t, n]) => `${t} ×${n}`).join(", ");
  return s || "aucune donnée identifiante détectée";
}

function resumeIgnores(ignores) {
  if (!ignores.size) return null;
  const total = [...ignores.values()].reduce((a, b) => a + b, 0);
  const detail = [...ignores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e} ×${n}`).join(", ");
  return `${total} fichier(s) d'un format non pris en charge ignoré(s) : ${detail}.`;
}

// ---------------------------------------------------------------------------
// État local : dossier courant, dossiers récents, dossiers autorisés par sélection
// (fichier sur le poste de l'utilisateur ; jamais transmis à Claude ni au serveur)
// ---------------------------------------------------------------------------
function cheminEtatDefaut() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AnonymiseurCabinet", "etat.json");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AnonymiseurCabinet", "etat.json");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "anonymiseur-cabinet", "etat.json");
}
const FICHIER_ETAT = process.env.ANON_ETAT || cheminEtatDefaut();

// ---------------------------------------------------------------------------
// Journal local des opérations (sur le poste uniquement, jamais transmis) :
// date, opération, référence d'anonymisation, identifiant F…, extension, volumes, nombres.
// Jamais de nom de fichier, de chemin, de texte ni de valeur réelle.
// ---------------------------------------------------------------------------
const FICHIER_JOURNAL = process.env.ANON_JOURNAL || path.join(path.dirname(FICHIER_ETAT), "journal.log");
const CHAMPS_JOURNAL = new Set(["ref", "reference", "fichier", "extension", "octets", "nombre", "remplacements", "inconnus",
  "entites", "source", "mode", "ignores", "deja_presents", "caracteres", "libelle_saisi", "format"]);

function journaliser(operation, details = {}) {
  try {
    const ligne = { date: new Date().toISOString(), operation };
    for (const [k, v] of Object.entries(details)) {
      if (!CHAMPS_JOURNAL.has(k) || v === undefined || v === null) continue;
      ligne[k] = typeof v === "object" ? v : typeof v === "string" ? v.slice(0, 60) : v;
    }
    fs.mkdirSync(path.dirname(FICHIER_JOURNAL), { recursive: true });
    try { if (fs.statSync(FICHIER_JOURNAL).size > 5 * 1024 * 1024) fs.renameSync(FICHIER_JOURNAL, FICHIER_JOURNAL + ".1"); } catch { /* absent */ }
    fs.appendFileSync(FICHIER_JOURNAL, JSON.stringify(ligne) + "\n", "utf8");
  } catch (e) {
    log("journal non écrit :", e.message);
  }
}

/** Nombre d'entités par type (pour le journal) : { PERSONNE: 2, … }. */
function compteTypes(entites) {
  const out = {};
  for (const e of entites || []) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}

let etatCache = null;
function etat() {
  if (!etatCache) {
    try { etatCache = JSON.parse(fs.readFileSync(FICHIER_ETAT, "utf8")); } catch { etatCache = {}; }
    if (!etatCache || typeof etatCache !== "object") etatCache = {};
    if (!Array.isArray(etatCache.recents)) etatCache.recents = [];
    if (!Array.isArray(etatCache.autorises)) etatCache.autorises = [];
  }
  return etatCache;
}

function sauverEtat() {
  try {
    fs.mkdirSync(path.dirname(FICHIER_ETAT), { recursive: true });
    const tmp = FICHIER_ETAT + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(etat(), null, 2), "utf8");
    fs.renameSync(tmp, FICHIER_ETAT);
  } catch (e) {
    log("état local non enregistré :", e.message);
  }
}

let courantMemoire = null; // choix explicite fait pendant la vie de ce processus
let courantSession = null; // dossier de la session, communiqué par le client MCP (racine unique)
let racinesClient = [];    // racines déclarées par le client MCP (Claude Code, Cowork…)

/** Un dossier trop large (disque entier, profil utilisateur) n'est jamais accepté comme dossier de travail. */
function tropLarge(abs) {
  const home = reel(os.homedir()) || os.homedir();
  return path.parse(abs).root === abs || dansRacine(abs, home);
}

function racinesFixes() {
  const out = [];
  const r = racineConfiguree();
  if (r) out.push(r);
  for (const p of racinesClient) out.push(p);
  return out;
}

/** Emplacements dans lesquels l'extension accepte de lire. */
function estAutorise(abs) {
  if (racinesFixes().some(r => dansRacine(r, abs))) return true;
  const m = racineModeles();
  if (m && dansRacine(m, abs)) return true;
  if (etat().autorises.some(r => dansRacine(r, abs))) return true;
  const c = courant();
  return !!c && dansRacine(c.chemin, abs);
}

/**
 * Référence d'anonymisation propre à un dossier : neutre (aucun nom), stable dans le temps.
 * Calculée sur le chemin relatif à la racine configurée, pour être identique sur tous vos postes.
 */
/**
 * Fiche d'un dossier d'affaire créé par creer_dossier_affaire (le dossier lui-même ou un parent) :
 * elle garde la référence d'anonymisation même si le dossier est renommé avec un libellé réel.
 */
function ficheAffaire(abs) {
  const r = racineConfiguree();
  let d = abs;
  for (let i = 0; i < 8; i++) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(d, FICHIER_AFFAIRE), "utf8"));
      if (f && /^D-[0-9a-f]{8}$/.test(f.ref_anonymisation) && RE_REFERENCE.test(String(f.reference || ""))) {
        return { dossier: d, reference: f.reference, ref: f.ref_anonymisation };
      }
    } catch { /* pas de fiche ici */ }
    if ((r && d === r) || tropLarge(d)) break;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function refPour(abs) {
  const fa = ficheAffaire(abs);
  if (fa) return fa.ref;
  const r = racineConfiguree();
  let base = abs;
  if (r && dansRacine(r, abs)) {
    base = path.relative(r, abs);
    if (!base) return nomDossier(); // la racine elle-même : référence par défaut des réglages
  }
  const norme = base.split(path.sep).join("/").normalize("NFC").toLowerCase();
  return "D-" + crypto.createHash("sha256").update(norme).digest("hex").slice(0, 8);
}

/** Dossier courant : choix explicite > dossier de la session > dernier choix encore récent. */
function courant() {
  if (courantMemoire && existeDossier(courantMemoire.chemin)) return courantMemoire;
  if (racinesClient.length === 1 && existeDossier(racinesClient[0]) && !tropLarge(racinesClient[0])) {
    if (!courantSession || courantSession.chemin !== racinesClient[0]) {
      courantSession = { chemin: racinesClient[0], ref: refPour(racinesClient[0]), libelle: null, choisi_le: Date.now(), utilise_le: Date.now(), source: "session" };
    }
    return courantSession;
  }
  const c = etat().courant;
  if (c && c.chemin && existeDossier(c.chemin) && Date.now() - (c.utilise_le || c.choisi_le || 0) <= DUREE_COURANT_MS) return c;
  return null;
}

let dernierEnregistrementEtat = 0;
function toucher(c) {
  if (!c) return;
  c.utilise_le = Date.now();
  if (c === etat().courant && Date.now() - dernierEnregistrementEtat > 60000) {
    dernierEnregistrementEtat = Date.now();
    sauverEtat();
  }
}

/** Nom du dossier tel que Claude peut le voir : pseudonymisé par le serveur puis filtré. */
async function libellePour(abs, ref) {
  // Dossier d'affaire créé par l'extension : on montre sa référence neutre, jamais son libellé réel
  const fa = ficheAffaire(abs);
  let prefixe = "", rel;
  if (fa) {
    rel = path.relative(fa.dossier, abs);
    if (!rel) return fa.reference;
    prefixe = fa.reference + " / ";
  } else {
    const r = racineConfiguree();
    rel = r && dansRacine(r, abs) ? path.relative(r, abs) : path.basename(abs);
    if (!rel) return "(dossier racine configuré)";
  }
  const affichage = rel.split(path.sep).slice(-3).join(" / ").replace(/_/g, " ");
  try {
    const rep = await anonymiserTexte(affichage, ref);
    return prefixe + (filtrerMots(String(rep.texte || "").split("\n")[0]) || "(nom masqué)");
  } catch {
    return prefixe + "(nom masqué)";
  }
}

async function libelleDe(c) {
  if (!c.libelle) c.libelle = await libellePour(c.chemin, c.ref);
  return c.libelle;
}

const MSG_CHOISIR =
  "Aucun dossier courant. Appelez choisir_dossier : sans argument, une fenêtre s'ouvre sur l'écran de l'utilisateur " +
  "pour qu'il désigne le dossier à traiter (les documents y sont lus sur place, sans copie).";

// ---------------------------------------------------------------------------
// Fenêtre de sélection de dossier (sur l'écran de l'utilisateur)
// ---------------------------------------------------------------------------
const CODE_CSHARP_SELECTEUR = `
using System;
using System.Runtime.InteropServices;
public static class AnonSelecteur {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  public static string Choisir(IntPtr proprietaire, string titre, string initial) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 | 0x40 | 0x800); // dossiers seulement, système de fichiers, chemin existant
    dlg.SetTitle(titre);
    dlg.SetOkButtonLabel("Choisir ce dossier");
    if (!String.IsNullOrEmpty(initial)) {
      try {
        Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem item; SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
        dlg.SetFolder(item);
      } catch {}
    }
    if (dlg.Show(proprietaire) != 0) return null;
    IShellItem res; dlg.GetResult(out res);
    string chemin; res.GetDisplayName(0x80058000, out chemin);
    return chemin;
  }
}`;

const SCRIPT_POWERSHELL_SELECTEUR = `
$ErrorActionPreference = 'Stop'
$titre = $env:ANON_SEL_TITRE
$initial = $env:ANON_SEL_INITIAL
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = $titre
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.FormBorderStyle = 'None'
$f.StartPosition = 'CenterScreen'
$f.Size = New-Object System.Drawing.Size(1, 1)
$f.Opacity = 0
$f.Show()
$f.Activate()
$choix = $null
$moderne = $false
try {
  Add-Type -TypeDefinition $env:ANON_SEL_CODE -Language CSharp
  $moderne = $true
} catch { $moderne = $false }
if ($moderne) {
  try { $choix = [AnonSelecteur]::Choisir($f.Handle, $titre, $initial) } catch { $moderne = $false }
}
if (-not $moderne) {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $titre
  $d.ShowNewFolderButton = $false
  if ($initial -and (Test-Path -LiteralPath $initial)) { $d.SelectedPath = $initial }
  if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { $choix = $d.SelectedPath }
}
$f.Close()
if ($choix) { [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($choix))) }
else { [Console]::Out.Write('ANNULE') }
`;

const TITRE_SELECTEUR = "Anonymiseur (cabinet) — choisissez le dossier à traiter avec Claude";
let processusSelecteur = null;

function lancerProcessus(cmd, args, env, options = {}) {
  return new Promise(resolve => {
    let sortie = "", erreur = "";
    let enfant;
    const avecEntree = typeof options.entree === "string";
    try {
      enfant = spawn(cmd, args, { env: Object.assign({}, process.env, env || {}), windowsHide: true, stdio: [avecEntree ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, sortie: "", erreur: e.message });
    }
    if (avecEntree) {
      enfant.stdin.on("error", () => { /* processus terminé avant lecture */ });
      enfant.stdin.end(options.entree, "utf8");
    }
    processusSelecteur = enfant;
    const minuterie = setTimeout(() => { try { enfant.kill(); } catch { /* déjà terminé */ } }, DELAI_MAX_SELECTION_MS);
    enfant.stdout.on("data", d => { sortie += d.toString("utf8"); });
    enfant.stderr.on("data", d => { erreur += d.toString("utf8"); });
    enfant.on("error", e => { clearTimeout(minuterie); processusSelecteur = null; resolve({ code: -1, sortie, erreur: e.message }); });
    enfant.on("close", code => { clearTimeout(minuterie); processusSelecteur = null; resolve({ code, sortie, erreur }); });
  });
}

/** Ouvre la fenêtre de sélection. Résout en { chemin } | { annule: true } | { erreur }. */
async function ouvrirSelecteur(initial) {
  // Simulation pour les tests automatiques : fichier contenant le chemin à « choisir » (ou ANNULE)
  const simule = process.env.ANON_SELECTEUR_SIMULE;
  if (simule) {
    const delai = parseInt(process.env.ANON_SELECTEUR_DELAI_MS || "0", 10) || 0;
    if (delai) await new Promise(r => setTimeout(r, delai));
    let v = "";
    try { v = fs.readFileSync(simule, "utf8").trim(); } catch { /* fichier absent = annulation */ }
    return !v || v === "ANNULE" ? { annule: true } : { chemin: v };
  }
  if (process.platform === "win32") {
    const encode = Buffer.from(SCRIPT_POWERSHELL_SELECTEUR, "utf16le").toString("base64");
    const r = await lancerProcessus("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode],
      { ANON_SEL_TITRE: TITRE_SELECTEUR, ANON_SEL_INITIAL: initial || "", ANON_SEL_CODE: CODE_CSHARP_SELECTEUR });
    const m = /OK:([A-Za-z0-9+/=]+)/.exec(r.sortie);
    if (m) return { chemin: Buffer.from(m[1], "base64").toString("utf8") };
    if (r.sortie.includes("ANNULE")) return { annule: true };
    log("sélecteur : échec", String(r.code), r.erreur.slice(0, 300));
    return { erreur: "la fenêtre de sélection n'a pas pu s'ouvrir sur ce poste" };
  }
  if (process.platform === "darwin") {
    const script = `POSIX path of (choose folder with prompt "${TITRE_SELECTEUR.replace(/"/g, "'")}")`;
    const r = await lancerProcessus("osascript", ["-e", script]);
    const v = r.sortie.trim();
    return r.code === 0 && v ? { chemin: v } : { annule: true };
  }
  for (const [cmd, args] of [
    ["zenity", ["--file-selection", "--directory", "--title", TITRE_SELECTEUR]],
    ["kdialog", ["--getexistingdirectory", initial || os.homedir(), "--title", TITRE_SELECTEUR]],
  ]) {
    const r = await lancerProcessus(cmd, args);
    if (r.code === 0 && r.sortie.trim()) return { chemin: r.sortie.trim() };
    if (r.code === 1) return { annule: true };
  }
  return { erreur: "aucune fenêtre de sélection disponible sur ce poste (installez zenity ou kdialog)" };
}

// ---------------------------------------------------------------------------
// Autres fenêtres locales (lot 2) et presse-papiers
// Le texte saisi ou copié reste dans ce processus : il n'est jamais renvoyé à Claude.
// ---------------------------------------------------------------------------
const TITRE_FICHIERS = "Anonymiseur (cabinet) — choisissez les pièces à importer dans le dossier de l'affaire";
const TITRE_LIBELLE = "Anonymiseur (cabinet) — libellé du dossier d'affaire";

// Fenêtre propriétaire invisible, au premier plan : la boîte de dialogue s'ouvre devant Claude
const PS_PROPRIETAIRE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.TopMost = $true; $f.ShowInTaskbar = $false; $f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'
$f.Size = New-Object System.Drawing.Size(1, 1); $f.Opacity = 0
$f.Show(); $f.Activate()
`;

const SCRIPT_PS_FICHIERS = `
$ErrorActionPreference = 'Stop'
${PS_PROPRIETAIRE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = $env:ANON_SEL_TITRE
if ($env:ANON_SEL_INITIAL -and (Test-Path -LiteralPath $env:ANON_SEL_INITIAL)) { $d.InitialDirectory = $env:ANON_SEL_INITIAL }
$d.Filter = 'Documents (pdf, Word, texte, courriels…)|*.pdf;*.docx;*.doc;*.odt;*.rtf;*.txt;*.md;*.csv;*.html;*.htm;*.eml;*.xlsx;*.pptx|Tous les fichiers|*.*'
$r = $d.ShowDialog($f)
$f.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
  $j = ($d.FileNames | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }) -join ','
  [Console]::Out.Write('OK:' + $j)
} else { [Console]::Out.Write('ANNULE') }
`;

// La première fenêtre d'un processus lancé masqué est masquée par Windows : la fenêtre fantôme
// ($f, ci-dessous renommée $p) l'absorbe, puis sert de propriétaire à la vraie fenêtre de saisie.
const SCRIPT_PS_LIBELLE = `
$ErrorActionPreference = 'Stop'
${PS_PROPRIETAIRE}
$p = $f
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:ANON_SAI_TITRE
$f.TopMost = $true; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.ClientSize = New-Object System.Drawing.Size(480, 160)
$l = New-Object System.Windows.Forms.Label
$l.Text = $env:ANON_SAI_INVITE; $l.SetBounds(12, 12, 456, 48)
$t = New-Object System.Windows.Forms.TextBox
$t.SetBounds(12, 66, 456, 24); $t.MaxLength = 80
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Valider'; $ok.SetBounds(258, 116, 100, 30); $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$sans = New-Object System.Windows.Forms.Button
$sans.Text = $env:ANON_SAI_ANNULER; $sans.SetBounds(368, 116, 100, 30); $sans.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$f.Controls.AddRange(@($l, $t, $ok, $sans)); $f.AcceptButton = $ok; $f.CancelButton = $sans
$f.Add_Shown({ $f.Activate(); $t.Focus() })
$r = $f.ShowDialog($p)
$p.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $t.Text.Trim()) {
  [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Text.Trim())))
} else { [Console]::Out.Write('ANNULE') }
`;

const SCRIPT_PS_LIRE_PP = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$t = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
if ($t) { [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))) } else { [Console]::Out.Write('VIDE') }
`;

// Texte reçu sur l'entrée standard (jamais en argument ni en variable d'environnement).
// Formats documentés par Microsoft : le contenu n'entre ni dans l'historique (Win+V) ni dans la synchronisation.
const SCRIPT_PS_ECRIRE_PP = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$b64 = [Console]::In.ReadToEnd()
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64.Trim()))
$d = New-Object System.Windows.Forms.DataObject
$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $t)
$d.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0))))
$d.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0))))
$d.SetData('CanUploadToCloudClipboard', (New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0))))
[System.Windows.Forms.Clipboard]::SetDataObject($d, $true, 10, 100)
[Console]::Out.Write('OK')
`;

function lancerPowerShell(script, env, options) {
  const encode = Buffer.from(script, "utf16le").toString("base64");
  return lancerProcessus("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode], env, options);
}

/** Fenêtre de sélection de fichiers (plusieurs). Résout en { chemins } | { annule } | { erreur }. */
async function ouvrirSelecteurFichiers(initial) {
  const simule = process.env.ANON_SELECTEUR_FICHIERS_SIMULE;
  if (simule) {
    let v = "";
    try { v = fs.readFileSync(simule, "utf8").trim(); } catch { /* absent = annulation */ }
    return !v || v === "ANNULE" ? { annule: true } : { chemins: v.split(/\r?\n/).map(x => x.trim()).filter(Boolean) };
  }
  if (process.platform === "win32") {
    const r = await lancerPowerShell(SCRIPT_PS_FICHIERS, { ANON_SEL_TITRE: TITRE_FICHIERS, ANON_SEL_INITIAL: initial || "" });
    const m = /OK:([A-Za-z0-9+/=,]+)/.exec(r.sortie);
    if (m) return { chemins: m[1].split(",").filter(Boolean).map(b => Buffer.from(b, "base64").toString("utf8")) };
    if (r.sortie.includes("ANNULE")) return { annule: true };
    log("sélecteur de fichiers : échec", String(r.code), r.erreur.slice(0, 300));
    return { erreur: "la fenêtre de sélection de fichiers n'a pas pu s'ouvrir sur ce poste" };
  }
  if (process.platform === "darwin") {
    const script = `set l to choose file with prompt "${TITRE_FICHIERS.replace(/"/g, "'")}" with multiple selections allowed\n` +
      `set s to ""\nrepeat with x in l\nset s to s & POSIX path of x & linefeed\nend repeat\nreturn s`;
    const r = await lancerProcessus("osascript", ["-e", script]);
    const v = r.sortie.trim();
    return r.code === 0 && v ? { chemins: v.split("\n").filter(Boolean) } : { annule: true };
  }
  const r = await lancerProcessus("zenity", ["--file-selection", "--multiple", "--separator=\n", "--title", TITRE_FICHIERS]);
  if (r.code === 0 && r.sortie.trim()) return { chemins: r.sortie.trim().split("\n") };
  if (r.code === 1) return { annule: true };
  return { erreur: "aucune fenêtre de sélection disponible sur ce poste (installez zenity)" };
}

/** Fenêtre de saisie du libellé réel. Résout en { texte } | { annule } | { erreur }. */
function saisirLibelle(reference) {
  return saisirTexte(TITRE_LIBELLE, `Libellé du dossier ${reference} (par exemple : Dupont c. Société X). Il sera ajouté au nom du dossier sur ce poste ` +
    "et ne sera pas communiqué à Claude. Laissez vide pour garder la seule référence.", "Sans libellé");
}

const TITRE_ENTITE = "Anonymiseur (cabinet) — donnée à masquer";

let fichiersMimeCache = null;
function fichiersMime() {
  if (!fichiersMimeCache) fichiersMimeCache = require("./moteur/fichiers").creerFichiers({ lireZip, contenuEntree, ecrireZip, creerEntree });
  return fichiersMimeCache;
}

function configImap() {
  const v = k => valeurConfig(IMAP[k] === undefined ? "" : String(IMAP[k]));
  if (!v("hote") || !v("utilisateur") || !v("motDePasse")) return null;
  return { hote: v("hote"), port: IMAP.port, utilisateur: v("utilisateur"), motDePasse: v("motDePasse"), dossier: v("dossier") || "INBOX", tls: IMAP.tls };
}

function dateCourte(s) {
  const d = new Date(s);
  if (isNaN(d)) return "date inconnue";
  const z = n => String(n).padStart(2, "0");
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}h${z(d.getMinutes())}`;
}

/** Fenêtre de saisie d'un texte tapé par l'utilisateur (jamais transmis à Claude). */
async function saisirTexte(titre, invite, boutonAnnuler = "Annuler") {
  const TITRE_LIBELLE = titre; // eslint-disable-line no-shadow
  const simule = process.env.ANON_SAISIE_SIMULEE;
  if (simule) {
    let v = "";
    try { v = fs.readFileSync(simule, "utf8").trim(); } catch { /* absent = annulation */ }
    return !v || v === "ANNULE" ? { annule: true } : { texte: v };
  }
  if (process.platform === "win32") {
    const r = await lancerPowerShell(SCRIPT_PS_LIBELLE, { ANON_SAI_TITRE: TITRE_LIBELLE, ANON_SAI_INVITE: invite, ANON_SAI_ANNULER: boutonAnnuler });
    const m = /OK:([A-Za-z0-9+/=]+)/.exec(r.sortie);
    if (m) return { texte: Buffer.from(m[1], "base64").toString("utf8") };
    if (r.sortie.includes("ANNULE")) return { annule: true };
    log("saisie du libellé : échec", String(r.code), r.erreur.slice(0, 300));
    return { erreur: "la fenêtre de saisie n'a pas pu s'ouvrir sur ce poste" };
  }
  if (process.platform === "darwin") {
    const r = await lancerProcessus("osascript", ["-e", `text returned of (display dialog "${invite.replace(/"/g, "'")}" default answer "" with title "${TITRE_LIBELLE}")`]);
    return r.code === 0 && r.sortie.trim() ? { texte: r.sortie.trim() } : { annule: true };
  }
  const r = await lancerProcessus("zenity", ["--entry", "--title", TITRE_LIBELLE, "--text", invite]);
  if (r.code === 0 && r.sortie.trim()) return { texte: r.sortie.trim() };
  if (r.code === 1) return { annule: true };
  return { erreur: "aucune fenêtre de saisie disponible sur ce poste (installez zenity)" };
}

/** Libellé utilisable dans un nom de dossier Windows. */
function nettoyerLibelle(s) {
  return String(s || "").replace(/[<>:"/\\|?*\x00-\x1f\[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80);
}

/** Lit le texte du presse-papiers du poste. Résout en { texte } | { erreur }. */
async function lirePressePapiers() {
  const simule = process.env.ANON_PRESSE_PAPIERS_SIMULE;
  if (simule) {
    try { return { texte: fs.readFileSync(simule, "utf8") }; } catch { return { texte: "" }; }
  }
  if (process.platform === "win32") {
    const r = await lancerPowerShell(SCRIPT_PS_LIRE_PP, {});
    const m = /OK:([A-Za-z0-9+/=]+)/.exec(r.sortie);
    if (m) return { texte: Buffer.from(m[1], "base64").toString("utf8") };
    if (r.sortie.includes("VIDE")) return { texte: "" };
    log("lecture du presse-papiers : échec", String(r.code), r.erreur.slice(0, 300));
    return { erreur: "le presse-papiers n'a pas pu être lu sur ce poste" };
  }
  for (const [cmd, args] of process.platform === "darwin" ? [["pbpaste", []]] : [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]]]) {
    const r = await lancerProcessus(cmd, args);
    if (r.code === 0) return { texte: r.sortie };
  }
  return { erreur: "aucun outil de lecture du presse-papiers disponible sur ce poste" };
}

/** Place un texte dans le presse-papiers du poste. Résout en { ok, hors_historique } | { erreur }. */
async function ecrirePressePapiers(texte) {
  const simule = process.env.ANON_PRESSE_PAPIERS_SIMULE;
  if (simule) {
    fs.writeFileSync(simule, texte, "utf8");
    return { ok: true, hors_historique: true };
  }
  if (process.platform === "win32") {
    const r = await lancerPowerShell(SCRIPT_PS_ECRIRE_PP, {}, { entree: Buffer.from(texte.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64") });
    if (r.sortie.includes("OK")) return { ok: true, hors_historique: true };
    log("écriture du presse-papiers : échec", String(r.code), r.erreur.slice(0, 300));
    return { erreur: "le presse-papiers n'a pas pu être rempli sur ce poste" };
  }
  for (const [cmd, args] of process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]) {
    const r = await lancerProcessus(cmd, args, {}, { entree: texte });
    if (r.code === 0) return { ok: true, hors_historique: false };
  }
  return { erreur: "aucun outil d'écriture du presse-papiers disponible sur ce poste" };
}

/** Markdown léger retiré pour un texte à coller dans une messagerie. */
function texteSansMarkdown(t) {
  return t.replace(/^#{1,6}[ \t]+/gm, "").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/^[ \t]*[*+][ \t]+/gm, "- ");
}

/**
 * Fenêtre locale dont le résultat peut arriver après le délai d'un appel d'outil : si l'utilisateur n'a pas
 * encore répondu, l'outil rend la main avec messageAttente ; un nouvel appel récupère le résultat.
 */
const dialogues = new Map(); // clé -> { promesse, issue, quand }
async function viaDialogue(cle, lancer, messageAttente) {
  let d = dialogues.get(cle);
  if (d && d.issue && Date.now() - d.quand > 90000) { dialogues.delete(cle); d = null; }
  if (!d) {
    d = { issue: null, quand: 0 };
    d.promesse = (async () => {
      let issue;
      try { issue = { texte: await lancer() }; } catch (e) { issue = { erreur: e instanceof ErreurOutil ? e.message : "Erreur interne : " + e.message }; }
      d.issue = issue;
      d.quand = Date.now();
      return issue;
    })();
    dialogues.set(cle, d);
  }
  const issue = await avecDelai(d.promesse, ATTENTE_SELECTION_MS);
  if (issue === DELAI) return messageAttente;
  dialogues.delete(cle);
  if (issue.erreur) throw new ErreurOutil(issue.erreur);
  return issue.texte;
}

let selectionEnCours = null;   // { promesse } tant que la fenêtre est ouverte
let derniereSelection = null;  // { quand, texte, erreur } résultat du dernier passage par la fenêtre

const DELAI = Symbol("delai");
function avecDelai(promesse, ms) {
  let minuterie;
  return Promise.race([
    promesse,
    new Promise(resolve => { minuterie = setTimeout(() => resolve(DELAI), ms); }),
  ]).finally(() => clearTimeout(minuterie));
}

/** Si une fenêtre de sélection est ouverte, attend le choix de l'utilisateur avant de continuer. */
async function attendreSelection() {
  if (!selectionEnCours) return;
  const r = await avecDelai(selectionEnCours.promesse, ATTENTE_SELECTION_MS);
  if (r === DELAI) {
    throw new ErreurOutil(
      "La fenêtre de sélection du dossier est encore ouverte sur l'écran de l'utilisateur : il n'a pas encore choisi. " +
      "Demandez-lui de désigner le dossier dans cette fenêtre, puis réessayez.");
  }
}

async function compterDocuments(abs) {
  const r = await parcourir(abs, true);
  return r;
}

/** Enregistre le dossier courant (mémoire + état local) et le place en tête des dossiers récents. */
function enregistrerCourant(abs, ref, libelle, source) {
  const maintenant = Date.now();
  const e = etat();
  const fiche = { chemin: abs, ref, libelle, choisi_le: maintenant, utilise_le: maintenant, source };
  e.courant = fiche;
  courantMemoire = fiche;
  e.recents = [{ chemin: abs, ref, libelle, utilise_le: maintenant }, ...e.recents.filter(r => r.chemin !== abs)].slice(0, 8);
  if (source === "selecteur" && !racinesFixes().some(r => dansRacine(r, abs)) && !e.autorises.some(r => dansRacine(r, abs))) {
    e.autorises = [abs, ...e.autorises].slice(0, 30);
  }
  dernierEnregistrementEtat = maintenant;
  sauverEtat();
  return fiche;
}

/** Fait d'un dossier le dossier courant. source : selecteur | chemin | recent. Retourne le texte destiné à Claude. */
async function appliquerChoix(cheminBrut, source) {
  const abs = reel(cheminBrut);
  if (!abs || !existeDossier(abs)) {
    throw new ErreurOutil(
      "Dossier introuvable sur le poste de l'utilisateur. Appelez choisir_dossier sans argument : " +
      "l'utilisateur le désignera lui-même dans la fenêtre de sélection.");
  }
  if (tropLarge(abs)) {
    throw new ErreurOutil("Ce dossier est trop large (disque entier ou profil utilisateur). Choisissez le dossier de l'affaire à traiter.");
  }
  // Un dossier désigné par l'utilisateur dans la fenêtre est autorisé par ce geste ; un chemin fourni
  // en argument doit se trouver dans un emplacement déjà autorisé.
  if (source !== "selecteur" && !estAutorise(abs)) {
    throw new ErreurOutil(
      "Ce dossier est hors des emplacements autorisés (dossier racine des réglages, dossier de la session, dossiers déjà " +
      "désignés par l'utilisateur). Appelez choisir_dossier sans argument : l'utilisateur le désignera dans la fenêtre de sélection.");
  }
  const ref = refPour(abs);
  const libelle = await libellePour(abs, ref);
  enregistrerCourant(abs, ref, libelle, source);
  journaliser("choix_dossier", { ref, source });

  const contenu = await compterDocuments(abs);
  const origine = source === "selecteur" ? "désigné par l'utilisateur dans la fenêtre de sélection"
    : source === "recent" ? "repris des dossiers récents" : "défini à partir du chemin fourni";
  const lignes = [
    `Dossier courant défini (${origine}).`,
    `Nom du dossier (pseudonymisé) : « ${libelle} ».`,
    `Référence d'anonymisation de cette affaire : ${ref} — appliquée automatiquement, ne précisez pas le paramètre dossier.`,
    `Contenu : ${contenu.fichiers.length}${contenu.tronque ? "+" : ""} document(s) pris en charge, sous-dossiers compris.`,
    resumeIgnores(contenu.ignores),
    "Les documents sont lus sur place, sans copie. Les livrables (enregistrer_document, reidentifier_fichier) seront écrits dans ce même dossier" +
      (sousLivrables() ? `, sous-dossier « ${sousLivrables()} ».` : "."),
    "Étape suivante : lister_fichiers.",
  ];
  return lignes.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Destination des livrables
// ---------------------------------------------------------------------------
function nettoyerSousDossier(s) {
  const v = valeurConfig(String(s || "")).trim();
  if (!v) return "";
  const bruts = v.split(/[\\/]+/).map(x => x.trim()).filter(Boolean);
  // Toute tentative de remonter dans l'arborescence est refusée, pas corrigée en silence
  if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v) || bruts.some(x => /^\.+$/.test(x))) throw new ErreurOutil("Sous-dossier invalide : indiquez un simple nom de sous-dossier.");
  const segments = bruts.map(x => x.replace(/[\[\]<>:"|?*\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "").slice(0, 60)).filter(Boolean);
  return segments.join(path.sep);
}

/** Sous-dossier des livrables défini dans les réglages (vide = à la racine du dossier courant). */
function sousLivrables() {
  try { return nettoyerSousDossier(SOUS_DOSSIER_LIVRABLES); } catch { return ""; }
}

/** Où écrire un livrable : par défaut dans le dossier courant (le dossier d'origine des pièces). */
function destination(args) {
  const c = courant();
  const veutSortie = args.emplacement === "dossier_sortie";
  if (c && !veutSortie) {
    const sous = [sousLivrables(), nettoyerSousDossier(args.sous_dossier)].filter(Boolean);
    const cible = path.resolve(c.chemin, ...sous);
    if (!dansRacine(c.chemin, cible)) throw new ErreurOutil("Sous-dossier invalide.");
    fs.mkdirSync(cible, { recursive: true });
    const cibleReelle = reel(cible);
    if (!cibleReelle || !dansRacine(c.chemin, cibleReelle)) throw new ErreurOutil("Sous-dossier invalide.");
    toucher(c);
    return {
      dir: cibleReelle,
      ou: "dans le dossier courant (le dossier d'origine des pièces)" + (sous.length ? `, sous-dossier « ${sous.join(path.sep)} »` : ""),
      courant: c,
    };
  }
  const sortie = racineSortie();
  if (!sortie) {
    throw new ErreurOutil(c
      ? "Le dossier de sortie n'est pas configuré dans les réglages de l'extension : omettez le paramètre emplacement pour écrire dans le dossier courant."
      : MSG_CHOISIR + " Le livrable y sera enregistré directement.");
  }
  return { dir: sortie, ou: "dans le dossier de sortie configuré" + (c ? "" : " (aucun dossier courant)"), courant: c };
}

function nomDeBase(nom, defaut) {
  return String(nom || defaut || "document").replace(/[\[\]]/g, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "").slice(0, 80) || "document";
}

async function ecrireSansEcraser(dir, base, ext, octets) {
  let cible = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(cible); i++) cible = path.join(dir, `${base} (${i})${ext}`);
  await fsp.writeFile(cible, octets, { flag: "wx" });
  return cible;
}

async function copierSansEcraser(source, dir) {
  const ext = path.extname(source);
  const base = path.basename(source, ext);
  let cible = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(cible); i++) cible = path.join(dir, `${base} (${i})${ext}`);
  await fsp.copyFile(source, cible, fs.constants.COPYFILE_EXCL);
  return cible;
}

/** Sous-dossier de la racine où créer les dossiers d'affaire (réglage facultatif). */
function sousAffaires() {
  try { return nettoyerSousDossier(SOUS_DOSSIER_AFFAIRES); } catch { return ""; }
}

function aujourdHui() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function horodatage() {
  const d = new Date();
  return `${aujourdHui()} ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Prochaine référence neutre du jour (AAAA-MM-JJ-NN) d'après les dossiers déjà présents. */
function prochaineReference(parent) {
  const jour = aujourdHui();
  let max = 0;
  let noms = [];
  try { noms = fs.readdirSync(parent); } catch { /* dossier vide */ }
  for (const n of noms) {
    const m = new RegExp(`^${jour}-(\\d{2,3})(?:$|[ \\-])`).exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${jour}-${String(max + 1).padStart(2, "0")}`;
}

/** Dossier où ranger des pièces importées : le dossier courant (ou l'un de ses sous-dossiers). */
function dossierImport(c, sousDossier) {
  const sous = nettoyerSousDossier(sousDossier);
  const cible = path.resolve(c.chemin, ...(sous ? [sous] : []));
  if (!dansRacine(c.chemin, cible)) throw new ErreurOutil("Sous-dossier invalide.");
  fs.mkdirSync(cible, { recursive: true });
  const reelle = reel(cible);
  if (!reelle || !dansRacine(c.chemin, reelle)) throw new ErreurOutil("Sous-dossier invalide.");
  return { dir: reelle, ou: "dans le dossier courant" + (sous ? `, sous-dossier « ${sous} »` : "") };
}

/** Lignes « F3 · nom pseudonymisé · taille » pour une liste de fichiers (noms analysés par le serveur, puis filtrés). */
async function lignesFichiers(base, fichiers, dossier) {
  if (!fichiers.length) return [];
  // Extension retirée avant analyse (sinon « Dupont.pdf » peut être avalé en entier), remise ensuite ;
  // les « _ » sont traités comme des espaces pour la détection
  const exts = fichiers.map(f => path.extname(f));
  const affichages = fichiers.map((f, i) => {
    const rel = path.relative(base, f);
    return rel.slice(0, rel.length - exts[i].length).split(path.sep).join(" / ").replace(/_/g, " ").replace(/[\r\n]+/g, " ");
  });
  const r = await anonymiserTexte(affichages.join("\n"), dossier);
  const noms = String(r.texte || "").split("\n");
  return fichiers.map((f, i) => {
    let t = 0;
    try { t = fs.statSync(f).size; } catch { /* ignoré */ }
    return `${idPour(f)} · ${filtrerNomFichier((noms[i] ?? "(nom indisponible)") + exts[i])} · ${taille(t)}`;
  });
}

/** Référence d'anonymisation à utiliser : paramètre explicite > dossier courant > réglage par défaut. */
function refOutil(args, c) {
  if (args && args.dossier) return nomDossier(String(args.dossier));
  return c ? c.ref : nomDossier();
}

// ---------------------------------------------------------------------------
// ZIP minimal (lecture / écriture), pour ré-identifier docx, pptx, xlsx, odt
// ---------------------------------------------------------------------------
const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function lireZip(buf) {
  const invalide = () => new ErreurOutil("Fichier illisible : ce n'est pas un document Office ou OpenDocument valide.");
  if (buf.length < 22) throw invalide();
  let i = buf.length - 22;
  const min = Math.max(0, buf.length - 22 - 65535);
  while (i >= min && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < min) throw invalide();
  const nb = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  if (nb === 0xffff || p === 0xffffffff) throw new ErreurOutil("Document trop volumineux (format ZIP64 non pris en charge).");
  const entrees = [];
  for (let n = 0; n < nb; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw invalide();
    const drapeaux = buf.readUInt16LE(p + 8);
    const methode = buf.readUInt16LE(p + 10);
    const heure = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const tComp = buf.readUInt32LE(p + 20), tBrut = buf.readUInt32LE(p + 24);
    const lNom = buf.readUInt16LE(p + 28), lExtra = buf.readUInt16LE(p + 30), lCom = buf.readUInt16LE(p + 32);
    const attrExt = buf.readUInt32LE(p + 38);
    const decalage = buf.readUInt32LE(p + 42);
    const nomBrut = Buffer.from(buf.subarray(p + 46, p + 46 + lNom));
    if (drapeaux & 1) throw new ErreurOutil("Document protégé par mot de passe : ré-identification impossible.");
    if (decalage + 30 > buf.length || buf.readUInt32LE(decalage) !== 0x04034b50) throw invalide();
    const debut = decalage + 30 + buf.readUInt16LE(decalage + 26) + buf.readUInt16LE(decalage + 28);
    entrees.push({
      nom: nomBrut.toString(drapeaux & 0x800 ? "utf8" : "latin1"),
      nomBrut, drapeaux, methode, heure, date, crc, tBrut, attrExt,
      brut: buf.subarray(debut, debut + tComp),
    });
    p += 46 + lNom + lExtra + lCom;
  }
  return entrees;
}

function contenuEntree(e) {
  if (e.methode === 0) return Buffer.from(e.brut);
  if (e.methode === 8) return zlib.inflateRawSync(e.brut);
  throw new ErreurOutil("Document compressé dans un format non pris en charge.");
}

function creerEntree(nom, contenu, modele) {
  const donnees = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, "utf8");
  const stocke = nom === "mimetype"; // OpenDocument : le type MIME doit rester non compressé
  return {
    nom,
    nomBrut: modele ? modele.nomBrut : Buffer.from(nom, "utf8"),
    drapeaux: modele ? modele.drapeaux : 0x800,
    methode: stocke ? 0 : 8,
    heure: modele ? modele.heure : 0,
    date: modele ? modele.date : 0x21, // 1er janvier 1980
    crc: crc32(donnees),
    tBrut: donnees.length,
    attrExt: modele ? modele.attrExt : 0,
    brut: stocke ? donnees : zlib.deflateRawSync(donnees, { level: 6 }),
  };
}

function ecrireZip(entrees) {
  const morceaux = [], centraux = [];
  let pos = 0;
  for (const e of entrees) {
    const drapeaux = e.drapeaux & 0x800; // seul l'indicateur « noms en UTF-8 » est conservé
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(drapeaux, 6);
    local.writeUInt16LE(e.methode, 8);
    local.writeUInt16LE(e.heure, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(e.crc >>> 0, 14);
    local.writeUInt32LE(e.brut.length, 18);
    local.writeUInt32LE(e.tBrut, 22);
    local.writeUInt16LE(e.nomBrut.length, 26);
    local.writeUInt16LE(0, 28);
    morceaux.push(local, e.nomBrut, e.brut);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(drapeaux, 8);
    c.writeUInt16LE(e.methode, 10);
    c.writeUInt16LE(e.heure, 12);
    c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(e.crc >>> 0, 16);
    c.writeUInt32LE(e.brut.length, 20);
    c.writeUInt32LE(e.tBrut, 24);
    c.writeUInt16LE(e.nomBrut.length, 28);
    c.writeUInt32LE(e.attrExt >>> 0, 38);
    c.writeUInt32LE(pos, 42);
    centraux.push(c, e.nomBrut);
    pos += 30 + e.nomBrut.length + e.brut.length;
  }
  const cd = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(cd.length, 12);
  fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...morceaux, cd, fin]);
}

// ---------------------------------------------------------------------------
// Ré-identification locale d'un fichier contenant des marqueurs
// ---------------------------------------------------------------------------
// Marqueur toléré : [PERSONNE_1], [PERSONNE 1], [PERSONNE-1], [PERSONNE\_1] (échappement Markdown)
const RE_MARQUEUR = /\[\s?([A-Z]+(?:\\?_[A-Z]+)*)\\?[_ \-](\d{1,6})\s?\]/g;

let typesConnus = null;
async function typesMarqueurs() {
  if (typesConnus) return typesConnus;
  let types = TYPES_PAR_DEFAUT;
  try {
    const s = await (await appelApi("/api/sante")).json();
    if (Array.isArray(s.types) && s.types.length) types = [...new Set([...TYPES_PAR_DEFAUT, ...s.types])];
  } catch { /* liste par défaut */ }
  typesConnus = new Set(types);
  return typesConnus;
}

/** Marqueurs présents dans un texte : [{ a, b, marqueur }] (positions, forme normalisée [TYPE_n]). */
function trouverMarqueurs(texte, types) {
  const out = [];
  if (texte.indexOf("[") < 0) return out;
  RE_MARQUEUR.lastIndex = 0;
  let m;
  while ((m = RE_MARQUEUR.exec(texte))) {
    const type = m[1].replace(/\\/g, "");
    if (!types.has(type)) continue;
    out.push({ a: m.index, b: m.index + m[0].length, marqueur: `[${type}_${parseInt(m[2], 10)}]` });
  }
  return out;
}

/**
 * Demande au serveur la valeur réelle de chaque marqueur (les valeurs restent dans ce processus).
 * Méthode principale : la route de ré-identification du serveur, chaque marqueur étant encadré de
 * repères pour retrouver sa valeur. Secours : la table des correspondances du dossier.
 */
async function valeursPour(marqueurs, ref) {
  const valeurs = new Map();
  const inconnus = new Set();
  const nonVus = [];
  for (let debut = 0; debut < marqueurs.length; debut += 400) {
    const lot = marqueurs.slice(debut, debut + 400);
    const texte = lot.map((m, i) => `@@AX${i}@@${m}@@/AX${i}@@`).join("\n");
    let r = null;
    try {
      r = await (await appelApi("/api/reidentifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte, dossier: ref }),
      })).json();
    } catch (e) {
      log("ré-identification par repères indisponible :", e.message);
    }
    const signales = new Set((r && r.marqueurs_inconnus) || []);
    const re = /@@AX(\d+)@@([\s\S]*?)@@\/AX\1@@/g;
    const vus = new Set();
    let m;
    while (r && (m = re.exec(String(r.texte || "")))) {
      const marqueur = lot[parseInt(m[1], 10)];
      if (marqueur === undefined) continue;
      vus.add(marqueur);
      if (m[2] === marqueur || signales.has(marqueur)) inconnus.add(marqueur);
      else valeurs.set(marqueur, m[2]);
    }
    for (const marqueur of lot) if (!vus.has(marqueur)) nonVus.push(marqueur);
  }
  if (nonVus.length) {
    // Secours : correspondances du dossier (mêmes données que l'écran « Dossiers » du serveur)
    // (fermée par défaut depuis le serveur 1.2.0 : les marqueurs concernés sont alors signalés inconnus)
    const table = new Map();
    let r = null;
    try { r = await (await appelApi(`/api/dossiers/${encodeURIComponent(ref)}/entites?valeurs=1`)).json(); } catch (e) { log("secours indisponible :", e.message); }
    for (const e of (r && r.entites) || []) {
      if (e && typeof e.marqueur === "string" && typeof e.valeur === "string") table.set(e.marqueur, e.valeur);
    }
    for (const marqueur of nonVus) {
      if (table.has(marqueur)) valeurs.set(marqueur, table.get(marqueur));
      else inconnus.add(marqueur);
    }
  }
  return { valeurs, inconnus };
}

function xmlEchapper(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function xmlEchapperAttribut(s) {
  return xmlEchapper(s).replace(/"/g, "&quot;");
}
function xmlDecoder(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (tout, c) => {
    if (c === "lt") return "<";
    if (c === "gt") return ">";
    if (c === "amp") return "&";
    if (c === "quot") return '"';
    if (c === "apos") return "'";
    const code = c[1] === "x" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : tout;
  });
}
function rtfEchapper(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\n") out += "\\line ";
    else if (ch === "\r") continue;
    else if (code < 128) out += ch;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}
function jsonEchapper(s) {
  return JSON.stringify(s).slice(1, -1);
}

/** Remplace les marqueurs d'un texte brut. echapper : adaptation de la valeur au format du fichier. */
function remplacerMarqueurs(texte, types, valeurs, echapper, compteur) {
  const trouves = trouverMarqueurs(texte, types);
  if (!trouves.length) return texte;
  let out = "", pos = 0;
  for (const t of trouves) {
    const v = valeurs.get(t.marqueur);
    if (v === undefined) continue;
    out += texte.slice(pos, t.a) + (echapper ? echapper(v) : v);
    pos = t.b;
    compteur.n++;
  }
  return out + texte.slice(pos);
}

// Parties d'un document où un marqueur peut être découpé entre plusieurs « morceaux » de texte
// (Word insère des coupures autour des mots inconnus du correcteur) : [paragraphe, nœud de texte]
function decoupageXml(nomPartie) {
  if (/^word\//.test(nomPartie)) return ["w:p", "w:t"];
  if (/^ppt\//.test(nomPartie)) return ["a:p", "a:t"];
  if (/^xl\/sharedStrings\.xml$/.test(nomPartie)) return ["si", "t"];
  return null;
}

/**
 * Parcourt les paragraphes d'une partie XML. visiteur(texteDuParagraphe) retourne la liste des
 * remplacements [{ a, b, valeur }] à appliquer (positions dans le texte reconstitué du paragraphe).
 */
function traiterParagraphes(xml, balisePara, baliseTexte, visiteur, options = {}) {
  const rePara = new RegExp(`<${balisePara}(?=[\\s>/])[\\s\\S]*?</${balisePara}>`, "g");
  return xml.replace(rePara, para => {
    if (!options.toujours && para.indexOf("[") < 0) return para;
    const reT = new RegExp(`(<${baliseTexte}(?=[\\s>])[^>]*>)([^<]*)(</${baliseTexte}>)`, "g");
    const noeuds = [];
    let m;
    while ((m = reT.exec(para))) {
      noeuds.push({ debut: m.index, fin: m.index + m[0].length, ouv: m[1], ferm: m[3], texte: xmlDecoder(m[2]) });
    }
    if (!noeuds.length) return para;
    let pos = 0;
    for (const n of noeuds) { n.a = pos; pos += n.texte.length; n.b = pos; n.nouveau = n.texte; }
    const remplacements = visiteur(noeuds.map(n => n.texte).join(""));
    if (!remplacements || !remplacements.length) return para;
    // De droite à gauche : les positions situées avant restent valables
    for (const r of [...remplacements].sort((x, y) => y.a - x.a)) {
      const touches = noeuds.filter(n => n.b > r.a && n.a < r.b);
      if (!touches.length) continue;
      const premier = touches[0], dernier = touches[touches.length - 1];
      if (premier === dernier) {
        premier.nouveau = premier.nouveau.slice(0, r.a - premier.a) + r.valeur + premier.nouveau.slice(r.b - premier.a);
      } else {
        dernier.nouveau = dernier.nouveau.slice(r.b - dernier.a);
        for (const n of touches.slice(1, -1)) n.nouveau = "";
        premier.nouveau = premier.nouveau.slice(0, r.a - premier.a) + r.valeur;
      }
      for (const n of touches) n.modifie = true;
    }
    let out = para;
    for (const n of [...noeuds].reverse()) {
      if (!n.modifie) continue;
      let ouv = n.ouv;
      if (baliseTexte !== "a:t" && !/xml:space=/.test(ouv)) ouv = ouv.replace(/>$/, ' xml:space="preserve">');
      // Saut de ligne dans une valeur (adresse sur deux lignes) : vrai retour à la ligne dans Word
      const contenu = xmlEchapper(n.nouveau).split(SAUT).join(baliseTexte === "w:t" ? n.ferm + "<w:br/>" + ouv : baliseTexte === "t" ? "\n" : " ");
      out = out.slice(0, n.debut) + ouv + contenu + n.ferm + out.slice(n.fin);
    }
    return out;
  });
}

/** Ré-identifie le contenu d'un fichier. Retourne { octets, remplaces, distincts, inconnus } ou null si aucun marqueur. */
async function reidentifierContenu(donnees, ext, ref) {
  const types = await typesMarqueurs();
  const presents = new Set();
  const collecter = texte => { for (const t of trouverMarqueurs(texte, types)) presents.add(t.marqueur); };

  if (EXT_REID_ZIP.has(ext)) {
    const entrees = lireZip(donnees);
    const parties = [];
    for (const e of entrees) {
      if (!/\.xml$/i.test(e.nom) || e.tBrut > 64 * 1024 * 1024) continue;
      const xml = contenuEntree(e).toString("utf8");
      const decoupe = decoupageXml(e.nom);
      if (decoupe) traiterParagraphes(xml, decoupe[0], decoupe[1], texte => { collecter(texte); return null; });
      collecter(xml);
      parties.push({ e, xml, decoupe });
    }
    if (!presents.size) return null;
    const { valeurs, inconnus } = await valeursPour([...presents], ref);
    const compteur = { n: 0 };
    const modifiees = new Map();
    for (const partie of parties) {
      let xml = partie.xml;
      if (partie.decoupe) {
        xml = traiterParagraphes(xml, partie.decoupe[0], partie.decoupe[1], texte => {
          const out = [];
          for (const t of trouverMarqueurs(texte, types)) {
            const v = valeurs.get(t.marqueur);
            if (v !== undefined) { out.push({ a: t.a, b: t.b, valeur: v.replace(/\r?\n/g, SAUT) }); compteur.n++; }
          }
          return out;
        });
      }
      // Marqueurs restants hors paragraphes (propriétés du document, attributs…)
      xml = remplacerMarqueurs(xml, types, valeurs, xmlEchapperAttribut, compteur);
      if (xml !== partie.xml) modifiees.set(partie.e, creerEntree(partie.e.nom, xml, partie.e));
    }
    const octets = ecrireZip(entrees.map(e => modifiees.get(e) || e));
    return { octets, remplaces: compteur.n, distincts: valeurs.size, inconnus: [...inconnus] };
  }

  // Fichiers texte
  let encodage = "utf8", bom = Buffer.alloc(0), corps = donnees;
  if (ext === ".rtf") encodage = "latin1";
  else if (donnees.length >= 2 && donnees[0] === 0xff && donnees[1] === 0xfe) { encodage = "utf16le"; bom = donnees.subarray(0, 2); corps = donnees.subarray(2); }
  else if (donnees.length >= 3 && donnees[0] === 0xef && donnees[1] === 0xbb && donnees[2] === 0xbf) { bom = donnees.subarray(0, 3); corps = donnees.subarray(3); }
  const texte = corps.toString(encodage);
  collecter(texte);
  if (!presents.size) return null;
  const { valeurs, inconnus } = await valeursPour([...presents], ref);
  const echapper = ext === ".rtf" ? rtfEchapper
    : [".html", ".htm", ".xml"].includes(ext) ? xmlEchapperAttribut
    : ext === ".json" ? jsonEchapper : null;
  const compteur = { n: 0 };
  const nouveau = remplacerMarqueurs(texte, types, valeurs, echapper, compteur);
  return {
    octets: Buffer.concat([bom, Buffer.from(nouveau, encodage)]),
    remplaces: compteur.n, distincts: valeurs.size, inconnus: [...inconnus],
  };
}

// ---------------------------------------------------------------------------
// Modèles Word (lot 3)
// ---------------------------------------------------------------------------
const EXT_MODELES = new Set([".docx", ".dotx"]);

/** Motif tolérant : espaces multiples ou insécables, apostrophes droites ou typographiques. */
function motifSouple(s) {
  return String(s).trim().split(/\s+/)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['’]/g, "['’]"))
    .join("[\\s\\u00a0\\u202f]+");
}

/**
 * Applique des remplacements « texte du modèle → texte à marqueurs » à un modèle Word (docx ou dotx),
 * dans le corps, les en-têtes, les pieds de page et les notes, en gardant la mise en forme du premier
 * morceau de texte remplacé, même quand le texte cherché est réparti sur plusieurs morceaux (runs).
 * Retourne { octets, trouves } (nombre d'occurrences par remplacement).
 */
function appliquerModele(donnees, remplacements) {
  const entrees = lireZip(donnees);
  const motifs = remplacements.map(r => new RegExp(motifSouple(r.rechercher), "g"));
  const trouves = remplacements.map(() => 0);
  const sortie = entrees.map(e => {
    if (e.nom === "[Content_Types].xml") {
      // Un modèle .dotx devient un document .docx
      const x = contenuEntree(e).toString("utf8");
      const y = x.replace(/wordprocessingml\.template\.main\+xml/g, "wordprocessingml.document.main+xml");
      return y !== x ? creerEntree(e.nom, y, e) : e;
    }
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(e.nom)) return e;
    const xml = contenuEntree(e).toString("utf8");
    const nouveau = traiterParagraphes(xml, "w:p", "w:t", texte => {
      const out = [], occupe = [];
      motifs.forEach((rx, i) => {
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(texte))) {
          if (!m[0]) { rx.lastIndex++; continue; }
          const a = m.index, b = a + m[0].length;
          if (occupe.some(([x, y]) => a < y && x < b)) continue;
          occupe.push([a, b]);
          out.push({ a, b, valeur: String(remplacements[i].remplacer).replace(/\r?\n/g, SAUT) });
          trouves[i]++;
        }
      });
      return out;
    }, { toujours: true });
    return nouveau !== xml ? creerEntree(e.nom, nouveau, e) : e;
  });
  return { octets: ecrireZip(sortie), trouves };
}

/** Un modèle .dotx relu comme un document .docx (seul le type du contenu principal change). */
function dotxVersDocx(buf) {
  return ecrireZip(lireZip(buf).map(e => e.nom !== "[Content_Types].xml" ? e
    : creerEntree(e.nom, contenuEntree(e).toString("utf8").replace(/wordprocessingml\.template\.main\+xml/g, "wordprocessingml.document.main+xml"), e)));
}

/** Retrouve un modèle : identifiant F…, nom relatif au dossier des modèles ou au dossier courant, chemin absolu autorisé. */
function trouverModele(ref, c) {
  const brut = String(ref || "").trim();
  if (!brut) return null;
  const connu = fichiersConnus.get(brut.toUpperCase());
  const candidats = connu ? [connu] : path.isAbsolute(brut) ? [brut]
    : [racineModeles() ? path.resolve(racineModeles(), brut) : null, c ? path.resolve(c.chemin, brut) : null].filter(Boolean);
  for (const cand of candidats) {
    for (const essai of [cand, ...(path.extname(cand) ? [] : [cand + ".docx", cand + ".dotx"])]) {
      const r = reel(essai);
      let estFichier = false;
      try { estFichier = !!r && fs.statSync(r).isFile(); } catch { /* absent */ }
      if (estFichier && estAutorise(r) && EXT_MODELES.has(path.extname(r).toLowerCase())) return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ouverture d'un livrable dans l'application par défaut du poste (lot 3)
// ---------------------------------------------------------------------------
function veutOuvrir(args) {
  return args.ouvrir === undefined ? OUVRIR_AUTO : !!args.ouvrir;
}

/** Ouvre le fichier sur le poste (Word, Excel…). Le chemin ne quitte pas le poste. */
async function ouvrirSurPoste(cible) {
  const simule = process.env.ANON_OUVRIR_SIMULE;
  if (simule) { fs.appendFileSync(simule, cible + "\n", "utf8"); return true; }
  let r;
  if (process.platform === "win32") {
    r = await lancerPowerShell("Start-Process -LiteralPath $env:ANON_OUVRIR", { ANON_OUVRIR: cible });
  } else {
    r = await lancerProcessus(process.platform === "darwin" ? "open" : "xdg-open", [cible]);
  }
  if (r.code !== 0) log("ouverture du fichier : échec", String(r.code), r.erreur.slice(0, 200));
  return r.code === 0;
}

/** Phrase de compte rendu sur l'ouverture, sans chemin. */
async function ouvrirSiDemande(args, cible) {
  if (!veutOuvrir(args)) return null;
  return (await ouvrirSurPoste(cible))
    ? "Fichier ouvert sur le poste de l'utilisateur dans l'application par défaut."
    : "⚠ Le fichier n'a pas pu être ouvert automatiquement : il est enregistré, l'utilisateur peut l'ouvrir lui-même.";
}

// ---------------------------------------------------------------------------
// Outils MCP
// ---------------------------------------------------------------------------
const OUTILS = [
  {
    name: "choisir_dossier",
    title: "Choisir le dossier à traiter (sans rien copier)",
    description:
      "Définit le dossier courant : le dossier du poste de l'utilisateur dans lequel les documents sont lus là où ils se trouvent " +
      "et où les livrables ré-identifiés sont enregistrés. Aucune copie de fichiers n'est nécessaire. " +
      "Sans argument (à privilégier) : une fenêtre de sélection s'ouvre sur l'écran de l'utilisateur, qui désigne le dossier ; " +
      "ne lui demandez pas d'écrire un chemin dans la conversation, il contient souvent des noms de clients. " +
      "Avec chemin : dossier déjà connu de vous, par exemple le dossier de travail d'une session Claude Code ou Cowork. " +
      "Avec recent : un dossier récent (R1, R2… affichés par etat_anonymiseur). Le nom réel du dossier ne vous est jamais communiqué.",
    inputSchema: {
      type: "object",
      properties: {
        chemin: { type: "string", description: "Chemin absolu d'un dossier du poste de l'utilisateur, ou chemin relatif au dossier racine des réglages. Facultatif." },
        recent: { type: "string", description: "Identifiant d'un dossier récent (R1, R2…). Facultatif." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lister_fichiers",
    title: "Lister les documents (noms pseudonymisés)",
    description:
      "Liste les documents du dossier courant (docx, pdf, odt, txt, md, csv, rtf, html, eml), sous-dossiers compris, tels qu'ils sont " +
      "sur le poste : rien n'est copié ni déplacé. Les noms de fichiers sont eux-mêmes pseudonymisés ; chaque document reçoit un " +
      "identifiant court (F1, F2…) à utiliser avec lire_fichier_anonymise. Si aucun dossier courant n'est défini, appelez d'abord choisir_dossier.",
    inputSchema: {
      type: "object",
      properties: {
        sous_dossier: { type: "string", description: "Sous-dossier relatif au dossier courant (facultatif)." },
        recursif: { type: "boolean", description: "Inclure les sous-dossiers (6 niveaux max). Défaut : true dans un dossier courant." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "lire_fichier_anonymise",
    title: "Lire un document pseudonymisé",
    description:
      "Lit un document du poste de l'utilisateur, là où il se trouve, et renvoie UNIQUEMENT sa version pseudonymisée : noms, prénoms, " +
      "sociétés, adresses, dates et lieux de naissance, SIRET/SIREN, TVA, IBAN, NIR, e-mails et téléphones sont remplacés par des " +
      "marqueurs ([PERSONNE_1], [SOCIETE_2]…). Un même marqueur désigne toujours la même entité dans un dossier. " +
      "Les longs documents sont découpés : utiliser le paramètre partie pour lire la suite.",
    inputSchema: {
      type: "object",
      properties: {
        fichier: { type: "string", description: "Identifiant renvoyé par lister_fichiers (ex. F3), ou chemin relatif au dossier courant." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
        partie: { type: "integer", minimum: 1, description: "Numéro de la partie à lire pour les longs documents (défaut 1)." },
      },
      required: ["fichier"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "enregistrer_document",
    title: "Enregistrer le document final ré-identifié",
    description:
      "Enregistre sur le poste de l'utilisateur un document rédigé avec les marqueurs : le serveur remplace les marqueurs par les " +
      "vraies données et le fichier est écrit directement dans le dossier courant, c'est-à-dire le dossier d'origine des pièces " +
      "(à défaut de dossier courant : dans le dossier de sortie des réglages). Le texte ré-identifié n'est PAS renvoyé. " +
      "Deux façons : (1) texte : format docx (Markdown léger accepté : # titres, - listes, **gras**), md ou txt ; " +
      "(2) modele + remplacements : le modèle Word du cabinet (identifiant F… donné par lister_modeles) est repris tel quel, mise en " +
      "forme comprise, et chaque « rechercher » (texte du modèle, tel que lu avec lire_fichier_anonymise) est remplacé par « remplacer » " +
      "(texte à marqueurs), y compris dans les en-têtes et pieds de page, puis le tout est ré-identifié. Le modèle d'origine n'est pas modifié.",
    inputSchema: {
      type: "object",
      properties: {
        texte: { type: "string", description: "Texte complet avec les marqueurs tels quels ([PERSONNE_1]…). Inutile avec modele." },
        modele: { type: "string", description: "Modèle Word (docx ou dotx) : identifiant F… de lister_modeles, ou nom relatif au dossier des modèles. Facultatif." },
        remplacements: {
          type: "array", maxItems: 200,
          description: "Avec modele : liste de remplacements, appliqués à chaque occurrence. Un « rechercher » tient dans un paragraphe ; un saut de ligne dans « remplacer » devient un retour à la ligne.",
          items: {
            type: "object",
            properties: {
              rechercher: { type: "string", description: "Texte présent dans le modèle (ex. « [NOM DU CLIENT] », « XXXX », « Madame, Monsieur »)." },
              remplacer: { type: "string", description: "Texte qui le remplace, marqueurs compris (ex. « [PERSONNE_1] »)." },
            },
            required: ["rechercher", "remplacer"],
          },
        },
        nom_fichier: { type: "string", description: "Nom du fichier sans extension. Ne pas y mettre de données réelles (utiliser une référence neutre)." },
        format: { type: "string", enum: ["docx", "md", "txt"], description: "Défaut : docx (toujours docx avec modele)." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant où ranger le fichier (créé s'il n'existe pas). Facultatif, nom neutre." },
        emplacement: { type: "string", enum: ["dossier_courant", "dossier_sortie"], description: "Défaut : dossier_courant. dossier_sortie = dossier de sortie des réglages." },
        ouvrir: { type: "boolean", description: "Ouvrir le fichier produit dans l'application par défaut du poste. Défaut : réglage de l'extension." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
      required: ["nom_fichier"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "reidentifier_fichier",
    title: "Remettre les vraies données dans un fichier à marqueurs",
    description:
      "Prend un fichier présent sur le poste de l'utilisateur et qui contient des marqueurs ([PERSONNE_1]…) — par exemple un document " +
      "Word que vous venez de créer — remplace les marqueurs par les vraies données et enregistre le résultat dans le dossier courant. " +
      "Formats : docx, pptx, xlsx, odt, txt, md, csv, html, rtf, json. La mise en forme du fichier est conservée. " +
      "Le contenu ré-identifié ne vous est PAS renvoyé. Le fichier source n'est ni modifié ni supprimé.",
    inputSchema: {
      type: "object",
      properties: {
        fichier: { type: "string", description: "Chemin absolu du fichier à marqueurs sur le poste de l'utilisateur, ou chemin relatif au dossier courant." },
        nom_fichier: { type: "string", description: "Nom du fichier produit, sans extension (défaut : celui du fichier source). Nom neutre." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant où ranger le fichier (facultatif)." },
        emplacement: { type: "string", enum: ["dossier_courant", "dossier_sortie"], description: "Défaut : dossier_courant." },
        ouvrir: { type: "boolean", description: "Ouvrir le fichier produit dans l'application par défaut du poste. Défaut : réglage de l'extension." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
      required: ["fichier"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "enregistrer_fichier",
    title: "Enregistrer un fichier produit par vous, ré-identifié",
    description:
      "Reçoit un fichier que vous avez produit (Word, Excel, PowerPoint, OpenDocument ou texte), encodé en base64 et contenant des marqueurs, " +
      "remplace les marqueurs par les vraies données (mise en forme conservée) et l'écrit dans le dossier courant. À utiliser quand le fichier " +
      "a été créé dans votre propre espace (et n'existe donc pas sur le poste de l'utilisateur) : aucun passage par un autre connecteur n'est " +
      "nécessaire. Le PDF n'est pas accepté (marqueurs non remplaçables de façon fiable) : produisez un docx. Le contenu ré-identifié n'est PAS renvoyé.",
    inputSchema: {
      type: "object",
      properties: {
        contenu_base64: { type: "string", description: "Contenu du fichier encodé en base64 (25 Mo maximum une fois décodé)." },
        nom_fichier: { type: "string", description: "Nom du fichier avec son extension (ex. « tableau-creances.xlsx »). Nom neutre, sans donnée réelle." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant (facultatif, nom neutre)." },
        emplacement: { type: "string", enum: ["dossier_courant", "dossier_sortie"], description: "Défaut : dossier_courant." },
        ouvrir: { type: "boolean", description: "Ouvrir le fichier produit dans l'application par défaut du poste. Défaut : réglage de l'extension." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
      required: ["contenu_base64", "nom_fichier"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lister_modeles",
    title: "Lister les modèles Word du cabinet",
    description:
      "Liste les modèles Word (docx, dotx) du dossier des modèles configuré dans l'extension, noms pseudonymisés, avec un identifiant F…. " +
      "Lisez ensuite le modèle avec lire_fichier_anonymise pour repérer les textes à remplacer, puis appelez enregistrer_document avec modele " +
      "et remplacements.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "creer_dossier_affaire",
    title: "Créer le dossier d'une nouvelle affaire",
    description:
      "Crée sur le poste de l'utilisateur, sous le dossier racine des réglages, le dossier de travail d'une nouvelle affaire, nommé par une " +
      "référence neutre (AAAA-MM-JJ-NN, attribuée automatiquement, ou celle fournie dans reference), le définit comme dossier courant et ouvre " +
      "sa table de correspondance sur le serveur. Avec saisir_libelle=true, une fenêtre s'ouvre sur l'écran de l'utilisateur pour qu'il tape " +
      "lui-même un libellé réel (ex. noms des parties), ajouté au nom du dossier sur son poste et jamais communiqué : ne demandez jamais ce " +
      "libellé dans la conversation. Renvoie uniquement la référence neutre et la référence d'anonymisation. " +
      "À utiliser au début d'une nouvelle affaire ; pour une affaire existante, utilisez choisir_dossier. Ensuite : importer_fichiers ou importer_presse_papiers.",
    inputSchema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence neutre du dossier (lettres, chiffres, - _ . ; 40 caractères max), sans nom de personne. Facultatif : par défaut AAAA-MM-JJ-NN." },
        saisir_libelle: { type: "boolean", description: "Ouvrir une fenêtre locale pour que l'utilisateur saisisse un libellé réel. Défaut : false." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "importer_fichiers",
    title: "Importer des pièces dans le dossier courant",
    description:
      "Copie des fichiers dans le dossier courant (les originaux restent en place). Mode selection (défaut) : une fenêtre s'ouvre sur l'écran " +
      "de l'utilisateur, qui désigne lui-même un ou plusieurs fichiers ; ne lui demandez pas de chemin. Mode telechargements : copie les " +
      "nombre derniers documents du dossier Téléchargements du poste (pratique juste après avoir enregistré les pièces jointes d'un courriel). " +
      "Renvoie uniquement les noms pseudonymisés et les identifiants F1, F2… à passer à lire_fichier_anonymise. Un dossier courant est " +
      "nécessaire (creer_dossier_affaire ou choisir_dossier).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["selection", "telechargements"], description: "Défaut : selection." },
        nombre: { type: "integer", minimum: 1, maximum: MAX_TELECHARGEMENTS, description: "Mode telechargements : nombre de documents les plus récents à copier (défaut 1)." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant où ranger les pièces (créé si besoin), nom neutre. Facultatif." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "importer_courriel",
    title: "Importer un courriel de la messagerie",
    description:
      "Lit la messagerie de l'utilisateur (IMAP, réglée dans l'extension) sans la modifier. Sans paramètre : liste les derniers messages, " +
      "expéditeurs et objets pseudonymisés, avec un identifiant C1, C2…. Avec courriel=C… (ou un Message-ID) : enregistre le message (.eml) " +
      "et ses pièces jointes dans le dossier courant, et renvoie la version pseudonymisée du message et les identifiants F… des pièces. " +
      "Le texte en clair n'entre jamais dans la conversation. N'utilisez pas un autre connecteur de messagerie pour lire les courriels d'un client.",
    inputSchema: {
      type: "object",
      properties: {
        courriel: { type: "string", description: "Identifiant C… donné par la liste, ou Message-ID du message. Omettre pour obtenir la liste." },
        nombre: { type: "integer", minimum: 1, maximum: 30, description: "Liste : nombre de messages récents (défaut 10)." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant où ranger le message et ses pièces (nom neutre, facultatif)." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "importer_presse_papiers",
    title: "Importer le texte copié par l'utilisateur",
    description:
      "Lit sur le poste le texte que l'utilisateur a copié (par exemple le message d'un client dans son webmail), l'enregistre en .txt dans " +
      "le dossier courant et ne renvoie que sa version pseudonymisée. À utiliser quand l'utilisateur dit « lis le presse-papiers » ou veut " +
      "vous transmettre un courriel : le texte en clair n'entre jamais dans la conversation. Un dossier courant est nécessaire.",
    inputSchema: {
      type: "object",
      properties: {
        nom_fichier: { type: "string", description: "Nom du fichier .txt, sans extension, neutre (défaut : « presse-papiers » + date et heure)." },
        sous_dossier: { type: "string", description: "Sous-dossier du dossier courant (facultatif, nom neutre)." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "reidentifier_vers_presse_papiers",
    title: "Copier un texte ré-identifié dans le presse-papiers",
    description:
      "Remplace les marqueurs d'un texte (par exemple une réponse au client rédigée avec vous) par les vraies données et place le résultat " +
      "dans le presse-papiers du poste, prêt à être collé (Ctrl+V) dans la messagerie de l'utilisateur. Sous Windows, ce contenu est exclu " +
      "de l'historique du presse-papiers et de la synchronisation. Ne renvoie qu'une confirmation : vous ne voyez jamais le texte ré-identifié. " +
      "Le Markdown léger (# titres, **gras**) est retiré, sauf texte_brut=true.",
    inputSchema: {
      type: "object",
      properties: {
        texte: { type: "string", description: "Texte avec les marqueurs tels quels ([PERSONNE_1]…)." },
        texte_brut: { type: "boolean", description: "Conserver le texte tel quel, Markdown compris. Défaut : false." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
      required: ["texte"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "corriger_entite",
    title: "Corriger la pseudonymisation du dossier",
    description:
      "Corrige les marqueurs du dossier courant, pour les documents lus ensuite (le texte déjà lu n'est pas modifié : relisez-le). Actions : " +
      "fusionner (marqueurs = [à garder, à fusionner…] : une même personne ou société sous deux marqueurs ; les anciens restent ré-identifiables) ; " +
      "exclure (marqueurs = [M] : un mot courant, une ville, une juridiction masqués à tort ne le seront plus dans ce dossier) ; " +
      "reinclure (annule une exclusion) ; ajouter (type : un nom ou une donnée que la détection a laissés en clair). Pour ajouter : si le texte " +
      "est visible en clair dans ce que vous avez lu (une fuite), passez-le dans texte_vu ; sinon omettez texte_vu : une fenêtre s'ouvre sur " +
      "l'écran de l'utilisateur pour qu'il tape lui-même la donnée — ne la lui demandez jamais dans la conversation. Ne renvoie que des marqueurs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["fusionner", "exclure", "reinclure", "ajouter"] },
        marqueurs: { type: "array", items: { type: "string" }, description: "Marqueurs concernés, ex. [\"[PERSONNE_1]\", \"[PERSONNE_4]\"] (fusionner : le premier est gardé)." },
        type: { type: "string", enum: TYPES_PAR_DEFAUT, description: "Ajouter : type de la donnée (PERSONNE, SOCIETE, ADRESSE…)." },
        texte_vu: { type: "string", description: "Ajouter : la donnée exactement telle qu'elle apparaît en clair dans le texte que vous avez reçu. Facultatif." },
        dossier: { type: "string", description: "Référence d'anonymisation. À omettre : elle est déduite du dossier courant." },
      },
      required: ["action"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "entites_du_dossier",
    title: "Marqueurs connus d'un dossier",
    description:
      "Liste les marqueurs déjà attribués dans un dossier (marqueur, type, nombre d'occurrences), sans les valeurs réelles.",
    inputSchema: {
      type: "object",
      properties: { dossier: { type: "string", description: "Référence d'anonymisation. Défaut : celle du dossier courant." } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "etat_anonymiseur",
    title: "Vérifier la connexion et le dossier courant",
    description: "Vérifie que le serveur d'anonymisation répond, indique le dossier courant, les dossiers récents (R1, R2…) et l'endroit où les livrables seront enregistrés.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const INSTRUCTIONS =
  "Les documents de l'utilisateur sont pseudonymisés avant de vous parvenir. Les données identifiantes sont remplacées " +
  "par des marqueurs entre crochets ([PERSONNE_1], [SOCIETE_1], [ADRESSE_1], [SIRET_1]…). Règles : " +
  "(1) conservez les marqueurs exactement à l'identique dans vos réponses et rédactions (pas de traduction, d'accord ni de reformulation) ; " +
  "(2) ne cherchez jamais à deviner ni à demander les données réelles ; " +
  "(3) les documents se traitent là où ils se trouvent, sans copie : au début d'un travail, appelez choisir_dossier. Sans argument, une fenêtre " +
  "s'ouvre sur l'écran de l'utilisateur pour qu'il désigne le dossier (ne lui demandez pas d'écrire le chemin : il contient souvent des noms) ; " +
  "si vous travaillez dans une session déjà rattachée à un dossier du poste (Claude Code, Cowork), passez ce dossier dans chemin. " +
  "Le dossier choisi devient le dossier courant : lister_fichiers, lire_fichier_anonymise, enregistrer_document et reidentifier_fichier y travaillent " +
  "directement, et la référence d'anonymisation de l'affaire est attribuée automatiquement (n'indiquez pas le paramètre dossier). " +
  "Si le dossier courant a été choisi il y a plus d'une heure ou pour une autre affaire, rappelez choisir_dossier ; " +
  "(4) pour produire un livrable final avec les vraies données, appelez enregistrer_document : le fichier est écrit dans le dossier courant, " +
  "à côté des pièces. Si vous avez créé vous-même un fichier à marqueurs sur le poste de l'utilisateur (docx, etc.), appelez reidentifier_fichier. " +
  "Pour une réponse à coller dans sa messagerie, appelez reidentifier_vers_presse_papiers. Vous ne verrez jamais le contenu ré-identifié ; " +
  "(5) nouvelle affaire : creer_dossier_affaire (référence neutre ; un libellé réel ne se saisit que dans la fenêtre locale, avec saisir_libelle). " +
  "Pièces à ajouter : importer_fichiers (fenêtre de sélection, ou derniers fichiers des Téléchargements). Courriel ou texte que l'utilisateur " +
  "a copié : importer_presse_papiers — proposez-le dès qu'il veut vous transmettre un message ; courriel resté dans sa messagerie : " +
  "importer_courriel (liste pseudonymisée, puis import du message et de ses pièces jointes) ; " +
  "(6) modèles du cabinet : lister_modeles, puis lire_fichier_anonymise sur le modèle, puis enregistrer_document avec modele et " +
  "remplacements (texte exact du modèle → texte à marqueurs). Fichier que vous avez produit vous-même (docx, xlsx…) : enregistrer_fichier " +
  "en base64 ; pour ouvrir le livrable chez l'utilisateur : ouvrir=true ; " +
  "(7) détection imparfaite dans un document lu (nom laissé en clair, mot courant masqué, même personne sous deux marqueurs) : " +
  "corriger_entite, puis relire le document ; " +
  "(8) si l'utilisateur colle directement du texte non pseudonymisé dans la conversation, rappelez-lui brièvement qu'il peut le copier puis " +
  "vous demander de lire le presse-papiers (importer_presse_papiers).";

async function executer(nom, args) {
  switch (nom) {
    case "etat_anonymiseur": {
      const s = await (await appelApi("/api/sante")).json();
      await appelApi("/api/dossiers"); // vérifie aussi la clé
      const c = selectionEnCours ? null : courant();
      const lignes = [
        ...(s.moteur === "local" ? [
          `${"AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat"} — logiciel libre (AGPL).`,
          `Extension ${VERSION} — moteur local : la détection et la table de correspondance (chiffrée) restent sur ce poste, sans serveur.`,
          `Détection des noms : ${s.spacy.actif ? `règles + ${s.spacy.modele} (modèle local)` : `règles seules — ${s.spacy.modele} indisponible : ${s.spacy.erreur}`}.`,
        ] : [
          `${"AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat"} — logiciel libre (AGPL).`,
        `Extension ${VERSION} — serveur joignable : ${SERVEUR} (version ${s.version}).`,
          `Détection des noms : ${s.spacy && s.spacy.actif ? "spaCy (" + s.spacy.modele + ") + règles" : "règles seules (spaCy inactif sur le serveur)"}.`,
          `Clé d'API : acceptée.`,
        ]),
      ];
      if (selectionEnCours) {
        lignes.push("Dossier courant : la fenêtre de sélection est ouverte sur l'écran de l'utilisateur, en attente de son choix.");
      } else if (c) {
        lignes.push(`Dossier courant : « ${await libelleDe(c)} » — référence d'anonymisation ${c.ref} — ` +
          (c.source === "session" ? "dossier de la session en cours" : `choisi ${ilYA(c.choisi_le)}`) +
          ` (oublié après ${Math.round(DUREE_COURANT_MS / 3600000)} h sans utilisation). Lecture sur place, sans copie.`);
      } else {
        lignes.push("Dossier courant : aucun. Appelez choisir_dossier (une fenêtre de sélection s'ouvre sur l'écran de l'utilisateur).");
      }
      const sous = sousLivrables();
      lignes.push(c
        ? `Livrables : enregistrés dans le dossier courant${sous ? `, sous-dossier « ${sous} »` : ""}, à côté des pièces.`
        : `Livrables : ${racineSortie() ? "sans dossier courant, enregistrés dans le dossier de sortie des réglages" : "un dossier courant est nécessaire (dossier de sortie non configuré)"}.`);
      const recents = etat().recents.filter(r => existeDossier(r.chemin)).slice(0, 8);
      if (recents.length) {
        lignes.push("Dossiers récents (choisir_dossier avec recent) : " +
          recents.map((r, i) => `R${i + 1} · « ${r.libelle || "(nom masqué)"} » (${r.ref}, utilisé ${ilYA(r.utilise_le || 0)})`).join(" ; ") + ".");
      }
      lignes.push(`Dossier racine des réglages : ${racineConfiguree() ? "configuré" : "non configuré ou injoignable"} ; dossier de sortie : ${racineSortie() ? "configuré" : "non configuré"}.`);
      lignes.push(`Référence d'anonymisation par défaut (hors dossier courant) : ${nomDossier()}.`);
      return lignes.join("\n");
    }

    case "choisir_dossier": {
      if (args.recent) {
        const recents = etat().recents.filter(r => existeDossier(r.chemin)).slice(0, 8);
        const m = /^R?(\d+)$/i.exec(String(args.recent).trim());
        const r = m ? recents[parseInt(m[1], 10) - 1] : null;
        if (!r) throw new ErreurOutil("Dossier récent inconnu. Appelez etat_anonymiseur pour voir la liste (R1, R2…), ou choisir_dossier sans argument.");
        return appliquerChoix(r.chemin, "recent");
      }
      if (args.chemin) {
        const brut = String(args.chemin).trim();
        const racineCfg = racineConfiguree();
        const candidat = path.isAbsolute(brut) ? brut : racineCfg ? path.resolve(racineCfg, brut) : null;
        if (!candidat) throw new ErreurOutil("Chemin relatif sans dossier racine configuré. Appelez choisir_dossier sans argument.");
        return appliquerChoix(candidat, "chemin");
      }
      // Fenêtre de sélection sur l'écran de l'utilisateur
      if (!selectionEnCours) {
        if (derniereSelection && Date.now() - derniereSelection.quand < 90000) {
          const d = derniereSelection;
          derniereSelection = null;
          if (d.erreur) throw new ErreurOutil(d.erreur);
          return d.texte;
        }
        const c = courant();
        const initial = (c && c.chemin) || racineConfiguree() || os.homedir();
        const promesse = (async () => {
          let issue;
          try {
            const r = await ouvrirSelecteur(initial);
            if (r.chemin) issue = { texte: await appliquerChoix(r.chemin, "selecteur") };
            else if (r.annule) {
              const actuel = courant();
              issue = { texte: "L'utilisateur a fermé la fenêtre sans choisir de dossier. " +
                (actuel ? "Le dossier courant précédent est conservé." : "Aucun dossier courant n'est défini.") };
            } else {
              issue = { erreur: `Sélection impossible : ${r.erreur}. Demandez à l'utilisateur le chemin du dossier et passez-le dans chemin.` };
            }
          } catch (e) {
            issue = { erreur: e instanceof ErreurOutil ? e.message : "Erreur interne : " + e.message };
          }
          selectionEnCours = null;
          derniereSelection = Object.assign({ quand: Date.now() }, issue);
          return issue;
        })();
        selectionEnCours = { promesse };
      }
      const issue = await avecDelai(selectionEnCours.promesse, ATTENTE_SELECTION_MS);
      if (issue === DELAI) {
        return "La fenêtre de sélection est ouverte sur l'écran de l'utilisateur, qui n'a pas encore choisi. " +
          "Dites-lui de désigner le dossier dans cette fenêtre (elle peut se trouver derrière une autre). " +
          "Dès qu'il aura choisi, ce dossier deviendra le dossier courant : appelez alors lister_fichiers.";
      }
      derniereSelection = null;
      if (issue.erreur) throw new ErreurOutil(issue.erreur);
      return issue.texte;
    }

    case "lister_fichiers": {
      await attendreSelection();
      const c = courant();
      const base = c ? c.chemin : racineConfiguree();
      if (!base) throw new ErreurOutil(MSG_CHOISIR);
      let dir = base;
      if (args.sous_dossier) {
        const cible = path.resolve(base, String(args.sous_dossier));
        const reelle = dansRacine(base, cible) ? reel(cible) : null;
        if (!reelle || !existeDossier(reelle) || !dansRacine(base, reelle)) throw new ErreurOutil("Sous-dossier introuvable ou hors du dossier courant.");
        dir = reelle;
      }
      const recursif = args.recursif === undefined ? !!c : !!args.recursif;
      const { fichiers, ignores, tronque } = await parcourir(dir, recursif);
      const dossier = refOutil(args, c);
      toucher(c);
      const entete = c
        ? `Dossier courant : « ${await libelleDe(c)} » — lecture sur place, sans copie. Référence d'anonymisation : ${dossier}.`
        : `Aucun dossier courant : liste du dossier racine des réglages (référence d'anonymisation : ${dossier}). ` +
          `Pour travailler directement dans le dossier d'une affaire, appelez choisir_dossier.`;
      const pied = [resumeIgnores(ignores), tronque ? `Liste limitée aux ${MAX_FICHIERS} premiers documents : précisez sous_dossier.` : null].filter(Boolean);
      if (!fichiers.length) return [entete, "Aucun document pris en charge dans ce dossier.", ...pied].join("\n");
      const lignes = await lignesFichiers(base, fichiers, dossier);
      return [entete, `${fichiers.length} document(s) (« … » = mot du nom de fichier masqué par précaution) :`, ...lignes, ...pied].join("\n");
    }

    case "lire_fichier_anonymise": {
      await attendreSelection();
      const c = courant();
      const ref = String(args.fichier || "").trim();
      const introuvable = () => new ErreurOutil(
        "Fichier introuvable ou hors des dossiers autorisés. Utilisez d'abord lister_fichiers et passez l'identifiant (F1, F2…).");
      let chemin = fichiersConnus.get(ref.toUpperCase());
      if (chemin) {
        if (!fs.existsSync(chemin)) throw introuvable();
      } else {
        if (!ref) throw introuvable();
        const racineCfg = racineConfiguree();
        const candidats = path.isAbsolute(ref) ? [ref]
          : [c ? path.resolve(c.chemin, ref) : null, racineCfg ? path.resolve(racineCfg, ref) : null].filter(Boolean);
        chemin = null;
        for (const cand of candidats) {
          const reelle = reel(cand);
          let estFichier = false;
          try { estFichier = !!reelle && fs.statSync(reelle).isFile(); } catch { /* absent */ }
          if (estFichier && estAutorise(reelle)) { chemin = reelle; break; }
        }
        if (!chemin) throw introuvable();
      }
      const extLue = path.extname(chemin).toLowerCase();
      if (!EXTENSIONS.has(extLue) && extLue !== ".dotx") throw new ErreurOutil("Format de fichier non pris en charge.");
      const st = await fsp.stat(chemin);
      if (st.size > MAX_OCTETS) throw new ErreurOutil(`Fichier trop volumineux (${taille(st.size)}, max 25 Mo).`);
      // Un modèle du cabinet est lu sous la référence de l'affaire en cours : ses marqueurs éventuels restent cohérents avec enregistrer_document
      const dansModeles = !!racineModeles() && dansRacine(racineModeles(), chemin);
      const dossier = args.dossier ? nomDossier(String(args.dossier)) : c && (dansRacine(c.chemin, chemin) || dansModeles) ? c.ref : nomDossier();
      toucher(c);
      const data = extLue === ".dotx" ? dotxVersDocx(await fsp.readFile(chemin)) : await fsp.readFile(chemin);
      const fd = new FormData();
      // Nom neutre transmis au serveur : seule l'extension compte
      fd.append("fichier", new Blob([data]), "document" + (extLue === ".dotx" ? ".docx" : extLue));
      fd.append("dossier", dossier);
      fd.append("options", JSON.stringify({ consigne: false }));
      const r = await (await appelApi("/api/anonymiser-fichier", { method: "POST", body: fd })).json();
      const id = idPour(chemin);
      const texte = String(r.texte || "");
      journaliser("lecture", { ref: dossier, fichier: id, extension: path.extname(chemin).toLowerCase(), octets: st.size,
        remplacements: r.nb_remplacements, entites: compteTypes(r.entites) });
      const total = Math.max(1, Math.ceil(texte.length / TAILLE_PARTIE));
      const partie = Math.min(Math.max(1, parseInt(args.partie || 1, 10) || 1), total);
      const extrait = texte.slice((partie - 1) * TAILLE_PARTIE, partie * TAILLE_PARTIE);
      const entete = [
        `Document ${id} — version pseudonymisée (référence d'anonymisation « ${dossier} »), lu sur place.`,
        `Entités remplacées : ${resumeEntites(r.entites)}.`,
        total > 1 ? `Partie ${partie}/${total} — appelez à nouveau avec partie=${partie + 1} pour la suite.` : null,
        ...(r.avertissements || []).map(a => "⚠ " + a),
        "Conservez les marqueurs à l'identique.",
        "────────────────────────",
      ].filter(Boolean);
      return entete.join("\n") + "\n" + extrait;
    }

    case "enregistrer_document": {
      await attendreSelection();
      if (args.modele) {
        // Document fondé sur un modèle Word du cabinet
        const modele = trouverModele(args.modele, courant());
        if (!modele) {
          throw new ErreurOutil("Modèle introuvable ou hors des emplacements autorisés. Appelez lister_modeles et passez l'identifiant F… " +
            "d'un modèle Word (docx ou dotx).");
        }
        const liste = Array.isArray(args.remplacements) ? args.remplacements : [];
        const remplacements = liste.filter(r => r && typeof r.rechercher === "string" && r.rechercher.trim() && typeof r.remplacer === "string").slice(0, 200);
        if (!remplacements.length) throw new ErreurOutil("Indiquez au moins un remplacement { rechercher, remplacer } pour remplir le modèle.");
        const st = await fsp.stat(modele);
        if (st.size > MAX_OCTETS) throw new ErreurOutil(`Modèle trop volumineux (${taille(st.size)}, max 25 Mo).`);
        const dest = destination(args);
        const dossier = refOutil(args, dest.courant);
        // Un « rechercher » recopié de la lecture pseudonymisée peut contenir des marqueurs : on y remet les vraies valeurs
        const types = await typesMarqueurs();
        const dansRecherches = [...new Set(remplacements.flatMap(r => trouverMarqueurs(r.rechercher, types).map(t => t.marqueur)))];
        if (dansRecherches.length) {
          const { valeurs } = await valeursPour(dansRecherches, dossier);
          for (const r of remplacements) r.rechercher = remplacerMarqueurs(r.rechercher, types, valeurs, null, { n: 0 });
        }
        let applique;
        try { applique = appliquerModele(await fsp.readFile(modele), remplacements); } catch {
          throw new ErreurOutil("Le modèle n'a pas pu être lu comme un document Word (fichier endommagé ou protégé ?).");
        }
        const resultat = await reidentifierContenu(applique.octets, ".docx", dossier);
        const octets = resultat ? resultat.octets : applique.octets;
        const base = nomDeBase(String(args.nom_fichier || "document").replace(/\.(docx|dotx)$/i, ""));
        const cible = await ecrireSansEcraser(dest.dir, base, ".docx", octets);
        const absents = applique.trouves.map((n, i) => (n ? null : i + 1)).filter(Boolean);
        journaliser("enregistrement_modele", { ref: dossier, octets: octets.length, nombre: applique.trouves.reduce((a, b) => a + b, 0),
          remplacements: resultat ? resultat.remplaces : 0, inconnus: resultat ? resultat.inconnus.length : 0 });
        const lignes = [
          `Document établi sur le modèle et enregistré sur le poste de l'utilisateur, ${dest.ou} : ${path.basename(cible)}. Mise en forme du modèle conservée ; le modèle n'est pas modifié.`,
          `${applique.trouves.reduce((a, b) => a + b, 0)} remplacement(s) effectué(s) dans le modèle ; ${resultat ? resultat.remplaces : 0} marqueur(s) remplacé(s) par les données réelles (référence « ${dossier} »).`,
        ];
        if (absents.length) lignes.push(`⚠ Texte introuvable dans le modèle pour le(s) remplacement(s) n° ${absents.join(", ")} : vérifiez l'orthographe exacte (un « rechercher » doit tenir dans un seul paragraphe).`);
        if (resultat && resultat.inconnus.length) lignes.push(`⚠ Marqueurs inconnus dans « ${dossier} », laissés tels quels : ${resultat.inconnus.join(", ")}.`);
        const ouv = await ouvrirSiDemande(args, cible);
        if (ouv) lignes.push(ouv);
        return lignes.join("\n");
      }
      const format = ["docx", "md", "txt"].includes(args.format) ? args.format : "docx";
      const texte = String(args.texte || "");
      if (!texte.trim()) throw new ErreurOutil("Le texte à enregistrer est vide (ou indiquez modele et remplacements).");
      const dest = destination(args);
      const dossier = refOutil(args, dest.courant);
      const base = nomDeBase(String(args.nom_fichier || "document").replace(/\.(docx|md|txt)$/i, ""));
      const rep = await appelApi("/api/reidentifier-fichier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte, dossier, format, nom: base }),
      });
      const octets = Buffer.from(await rep.arrayBuffer());
      const remplaces = rep.headers.get("x-remplacements") || "0";
      const inconnus = (rep.headers.get("x-marqueurs-inconnus") || "").split(",").filter(Boolean);
      const cible = await ecrireSansEcraser(dest.dir, base, "." + format, octets);
      journaliser("enregistrement_document", { ref: dossier, format, octets: octets.length, remplacements: parseInt(remplaces, 10) || 0, inconnus: inconnus.length });
      const lignes = [
        `Document enregistré sur le poste de l'utilisateur, ${dest.ou} : ${path.basename(cible)}.`,
        `${remplaces} marqueur(s) remplacé(s) par les données réelles (référence d'anonymisation « ${dossier} »).`,
      ];
      if (inconnus.length) lignes.push(`⚠ Marqueurs inconnus dans « ${dossier} », laissés tels quels : ${inconnus.join(", ")}.`);
      const ouv = await ouvrirSiDemande(args, cible);
      if (ouv) lignes.push(ouv);
      return lignes.join("\n");
    }

    case "reidentifier_fichier": {
      await attendreSelection();
      const c = courant();
      const ref = String(args.fichier || "").trim();
      if (!ref) throw new ErreurOutil("Indiquez le fichier à ré-identifier.");
      const candidats = path.isAbsolute(ref) ? [ref] : [c ? path.resolve(c.chemin, ref) : null].filter(Boolean);
      let source = fichiersConnus.get(ref.toUpperCase()) || null;
      for (const cand of candidats) {
        if (source) break;
        const reelle = reel(cand);
        try { if (reelle && fs.statSync(reelle).isFile()) source = reelle; } catch { /* absent */ }
      }
      if (!source) {
        throw new ErreurOutil(
          "Fichier introuvable sur le poste de l'utilisateur. Cet outil ne voit que les fichiers présents sur son poste : " +
          "si le document a été créé dans un espace distant, utilisez enregistrer_document avec le texte à marqueurs.");
      }
      const ext = path.extname(source).toLowerCase();
      if (ext === ".pdf") throw new ErreurOutil("Un PDF ne peut pas être ré-identifié : produisez le document en docx, puis ré-identifiez-le.");
      if (!EXT_REID_ZIP.has(ext) && !EXT_REID_TEXTE.has(ext)) {
        throw new ErreurOutil("Format non pris en charge pour la ré-identification (acceptés : docx, pptx, xlsx, odt, txt, md, csv, html, rtf, json).");
      }
      const st = await fsp.stat(source);
      if (st.size > MAX_OCTETS) throw new ErreurOutil(`Fichier trop volumineux (${taille(st.size)}, max 25 Mo).`);
      const dest = destination(args);
      const dossier = refOutil(args, dest.courant);
      const resultat = await reidentifierContenu(await fsp.readFile(source), ext, dossier);
      if (!resultat) return "Aucun marqueur trouvé dans ce fichier : rien n'a été enregistré.";
      if (!resultat.remplaces) {
        return `Aucun marqueur de ce fichier n'est connu dans « ${dossier} » (${resultat.inconnus.join(", ")}) : rien n'a été enregistré. ` +
          "Vérifiez que le dossier courant est celui dont proviennent les pièces.";
      }
      let base = nomDeBase(args.nom_fichier ? String(args.nom_fichier).replace(new RegExp("\\" + ext + "$", "i"), "") : path.basename(source, path.extname(source)));
      // Même dossier que la source et même nom : on distingue la version ré-identifiée
      if (path.dirname(source) === dest.dir && !args.nom_fichier) base = nomDeBase(base + " (ré-identifié)");
      const cible = await ecrireSansEcraser(dest.dir, base, ext, resultat.octets);
      journaliser("reidentification_fichier", { ref: dossier, extension: ext, octets: resultat.octets.length,
        remplacements: resultat.remplaces, inconnus: resultat.inconnus.length });
      const lignes = [
        `Fichier ré-identifié enregistré sur le poste de l'utilisateur, ${dest.ou} : ${path.basename(cible)}.`,
        `${resultat.remplaces} marqueur(s) remplacé(s) par les données réelles (${resultat.distincts} distinct(s), référence « ${dossier} »). Mise en forme conservée.`,
      ];
      if (resultat.inconnus.length) lignes.push(`⚠ Marqueurs inconnus dans « ${dossier} », laissés tels quels : ${resultat.inconnus.join(", ")}.`);
      const ouv = await ouvrirSiDemande(args, cible);
      if (ouv) lignes.push(ouv);
      return lignes.join("\n");
    }

    case "enregistrer_fichier": {
      await attendreSelection();
      const nom = String(args.nom_fichier || "").trim();
      const ext = path.extname(nom).toLowerCase();
      if (ext === ".pdf") throw new ErreurOutil("Le PDF n'est pas accepté : ses marqueurs ne peuvent pas être remplacés de façon fiable. Produisez un docx.");
      if (!EXT_REID_ZIP.has(ext) && !EXT_REID_TEXTE.has(ext)) {
        throw new ErreurOutil("Indiquez dans nom_fichier une extension acceptée : docx, xlsx, pptx, odt, ods, odp, txt, md, csv, html, rtf, json.");
      }
      const b64 = String(args.contenu_base64 || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      if (!b64 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new ErreurOutil("contenu_base64 est vide ou n'est pas du base64 valide.");
      if (b64.length > Math.ceil(MAX_OCTETS / 3) * 4 + 4) throw new ErreurOutil("Fichier trop volumineux (25 Mo maximum).");
      const donnees = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (!donnees.length) throw new ErreurOutil("Le fichier décodé est vide.");
      if (EXT_REID_ZIP.has(ext)) {
        try { lireZip(donnees); } catch { throw new ErreurOutil(`Le contenu reçu n'est pas un fichier ${ext} valide (archive illisible).`); }
      }
      const dest = destination(args);
      const dossier = refOutil(args, dest.courant);
      const resultat = await reidentifierContenu(donnees, ext, dossier);
      const octets = resultat ? resultat.octets : donnees;
      const cible = await ecrireSansEcraser(dest.dir, nomDeBase(nom.slice(0, nom.length - ext.length)), ext, octets);
      journaliser("enregistrement_fichier", { ref: dossier, extension: ext, octets: octets.length,
        remplacements: resultat ? resultat.remplaces : 0, inconnus: resultat ? resultat.inconnus.length : 0 });
      const lignes = [`Fichier enregistré sur le poste de l'utilisateur, ${dest.ou} : ${path.basename(cible)}.`];
      if (!resultat) lignes.push("Aucun marqueur dans ce fichier : enregistré tel quel.");
      else {
        lignes.push(`${resultat.remplaces} marqueur(s) remplacé(s) par les données réelles (${resultat.distincts} distinct(s), référence « ${dossier} »). Mise en forme conservée.`);
        if (resultat.inconnus.length) lignes.push(`⚠ Marqueurs inconnus dans « ${dossier} », laissés tels quels : ${resultat.inconnus.join(", ")}.`);
      }
      const ouv = await ouvrirSiDemande(args, cible);
      if (ouv) lignes.push(ouv);
      return lignes.join("\n");
    }

    case "lister_modeles": {
      const m = racineModeles();
      if (!m) {
        return "Aucun dossier de modèles n'est configuré (ou il est injoignable). L'utilisateur peut l'indiquer dans les réglages de l'extension " +
          "(« Dossier des modèles »). En attendant, un modèle présent dans le dossier courant peut être passé à enregistrer_document par son identifiant F….";
      }
      const c = selectionEnCours ? null : courant();
      const { fichiers: tous, tronque } = await parcourir(m, true, 0, undefined, EXT_MODELES);
      const modeles = tous.filter(f => EXT_MODELES.has(path.extname(f).toLowerCase()));
      if (!modeles.length) return "Le dossier des modèles ne contient aucun modèle Word (docx ou dotx).";
      const lignes = await lignesFichiers(m, modeles, c ? c.ref : nomDossier());
      return [`${modeles.length} modèle(s) Word (« … » = mot du nom masqué par précaution) :`, ...lignes,
        tronque ? `Liste limitée aux ${MAX_FICHIERS} premiers fichiers.` : null,
        "Lisez un modèle avec lire_fichier_anonymise (identifiant F…), puis appelez enregistrer_document avec modele et remplacements."]
        .filter(Boolean).join("\n");
    }

    case "creer_dossier_affaire": {
      await attendreSelection();
      const racine = racineConfiguree();
      if (!racine) throw new ErreurOutil("Le dossier racine des réglages n'est pas configuré ou est injoignable : impossible de créer le dossier d'affaire.");
      const sous = sousAffaires();
      const parentBrut = path.resolve(racine, ...(sous ? [sous] : []));
      fs.mkdirSync(parentBrut, { recursive: true });
      const parent = reel(parentBrut);
      if (!parent || !dansRacine(racine, parent)) throw new ErreurOutil("Sous-dossier des affaires invalide dans les réglages.");
      let reference;
      if (args.reference !== undefined && String(args.reference).trim()) {
        reference = String(args.reference).trim();
        if (!RE_REFERENCE.test(reference)) throw new ErreurOutil("Référence invalide : lettres, chiffres, - _ . uniquement (40 caractères max), sans nom de personne.");
        const existants = fs.readdirSync(parent).filter(n => n === reference || n.startsWith(reference + " - "));
        if (existants.length) throw new ErreurOutil(`Un dossier porte déjà la référence ${reference}. Choisissez-en une autre, ou appelez choisir_dossier pour le reprendre.`);
      } else {
        reference = prochaineReference(parent);
      }

      const creer = async (libelle, saisie) => {
        const ref = "D-" + crypto.randomBytes(4).toString("hex");
        // Table de correspondance ouverte sur le serveur avant toute création locale (échec = rien n'est créé)
        await anonymiserTexte(`Dossier ${reference}`, ref);
        const nom = libelle ? `${reference} - ${libelle}` : reference;
        const brut = path.join(parent, nom);
        if (fs.existsSync(brut)) throw new ErreurOutil(`Un dossier ${reference} existe déjà : relancez creer_dossier_affaire sans référence.`);
        fs.mkdirSync(brut);
        const abs = reel(brut);
        const fiche = path.join(abs, FICHIER_AFFAIRE);
        fs.writeFileSync(fiche, JSON.stringify({ reference, ref_anonymisation: ref, cree_le: new Date().toISOString(), extension: VERSION }, null, 2), "utf8");
        if (process.platform === "win32") lancerProcessus("attrib", ["+h", fiche]).catch(() => {});
        enregistrerCourant(abs, ref, reference, "creation");
        journaliser("creation_dossier", { ref, reference, libelle_saisi: !!libelle });
        const lignes = [
          "Dossier d'affaire créé sur le poste de l'utilisateur et défini comme dossier courant.",
          `Référence neutre : ${reference}.`,
          `Référence d'anonymisation : ${ref} — appliquée automatiquement, ne précisez pas le paramètre dossier.`,
        ];
        if (saisie === "libelle") lignes.push("Libellé réel saisi par l'utilisateur dans la fenêtre locale : ajouté au nom du dossier sur son poste, non communiqué.");
        else if (saisie === "annule") lignes.push("Fenêtre de saisie fermée sans libellé : le dossier porte la seule référence neutre.");
        lignes.push("Étape suivante : importer_fichiers (pièces) ou importer_presse_papiers (courriel copié par l'utilisateur).");
        return lignes.join("\n");
      };

      if (!args.saisir_libelle) return creer("", null);
      return viaDialogue("libelle", async () => {
        const s = await saisirLibelle(reference);
        if (s.erreur) throw new ErreurOutil(`Saisie du libellé impossible : ${s.erreur}. Relancez creer_dossier_affaire sans saisir_libelle.`);
        const libelle = s.annule ? "" : nettoyerLibelle(s.texte);
        return creer(libelle, libelle ? "libelle" : "annule");
      }, `Une fenêtre est ouverte sur l'écran de l'utilisateur pour qu'il saisisse le libellé du dossier ${reference} (elle peut se trouver ` +
        "derrière une autre). Dites-lui de le taper puis de valider ; appelez ensuite à nouveau creer_dossier_affaire avec les mêmes paramètres " +
        "pour obtenir le résultat. Ne lui demandez pas ce libellé dans la conversation.");
    }

    case "importer_fichiers": {
      await attendreSelection();
      const c = courant();
      if (!c) throw new ErreurOutil("Aucun dossier courant : appelez creer_dossier_affaire (nouvelle affaire) ou choisir_dossier, puis importer_fichiers.");
      const mode = args.mode === "telechargements" ? "telechargements" : "selection";

      const importer = async chemins => {
        const dest = dossierImport(c, args.sous_dossier);
        const copies = [], lisibles = [];
        let deja = 0, ignores = 0, octets = 0;
        for (const brut of chemins) {
          const src = reel(brut);
          let st = null;
          try { st = src ? fs.statSync(src) : null; } catch { /* absent */ }
          if (!st || !st.isFile() || st.size > MAX_IMPORT_OCTETS) { ignores++; continue; }
          if (dansRacine(c.chemin, src)) {
            deja++;
            if (EXTENSIONS.has(path.extname(src).toLowerCase())) lisibles.push(src);
            continue;
          }
          const cible = await copierSansEcraser(src, dest.dir);
          copies.push(cible);
          octets += st.size;
          if (EXTENSIONS.has(path.extname(cible).toLowerCase())) lisibles.push(cible);
        }
        toucher(c);
        journaliser("import_fichiers", { ref: c.ref, mode, nombre: copies.length, deja_presents: deja, ignores, octets });
        if (!copies.length && !deja) {
          return "Aucun fichier importé" + (ignores ? ` (${ignores} élément(s) introuvable(s), illisible(s) ou de plus de 100 Mo).` : ".");
        }
        const lignes = [
          `${copies.length} fichier(s) copié(s) ${dest.ou} ; les originaux restent en place.`,
          ...(await lignesFichiers(c.chemin, lisibles, c.ref)),
        ];
        const nonLisibles = copies.length - lisibles.filter(p => copies.includes(p)).length;
        if (nonLisibles) lignes.push(`${nonLisibles} fichier(s) copié(s) dans un format que lire_fichier_anonymise ne lit pas (pas d'identifiant).`);
        if (deja) lignes.push(`${deja} fichier(s) déjà présent(s) dans le dossier courant : non copié(s).`);
        if (ignores) lignes.push(`${ignores} élément(s) ignoré(s) : introuvable(s), illisible(s) ou de plus de 100 Mo.`);
        lignes.push("(« … » = mot du nom de fichier masqué par précaution.) Étape suivante : lire_fichier_anonymise avec l'identifiant F….");
        return lignes.join("\n");
      };

      if (mode === "telechargements") {
        const dl = process.env.ANON_TELECHARGEMENTS || path.join(os.homedir(), "Downloads");
        const nombre = Math.min(Math.max(parseInt(args.nombre || 1, 10) || 1, 1), MAX_TELECHARGEMENTS);
        let entrees = [];
        try { entrees = await fsp.readdir(dl, { withFileTypes: true }); } catch {
          throw new ErreurOutil("Dossier Téléchargements introuvable sur ce poste : utilisez importer_fichiers en mode selection.");
        }
        const candidats = [];
        for (const e of entrees) {
          if (!e.isFile() || e.name.startsWith(".") || e.name.startsWith("~$")) continue;
          if (!EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
          const p = path.join(dl, e.name);
          try { candidats.push({ p, t: fs.statSync(p).mtimeMs }); } catch { /* disparu */ }
        }
        candidats.sort((a, b) => b.t - a.t);
        if (!candidats.length) return "Aucun document pris en charge dans le dossier Téléchargements.";
        return importer(candidats.slice(0, nombre).map(x => x.p));
      }

      return viaDialogue("fichiers", async () => {
        const initial = process.env.ANON_TELECHARGEMENTS || path.join(os.homedir(), "Downloads");
        const r = await ouvrirSelecteurFichiers(initial);
        if (r.erreur) throw new ErreurOutil(`Sélection impossible : ${r.erreur}. Essayez le mode telechargements.`);
        if (r.annule) return "L'utilisateur a fermé la fenêtre sans choisir de fichier : rien n'a été importé.";
        return importer(r.chemins);
      }, "Une fenêtre de sélection de fichiers est ouverte sur l'écran de l'utilisateur (elle peut se trouver derrière une autre). " +
        "Dites-lui de désigner les pièces puis de valider ; appelez ensuite à nouveau importer_fichiers pour obtenir le résultat.");
    }

    case "importer_courriel": {
      await attendreSelection();
      const cfg = configImap();
      if (!cfg) {
        throw new ErreurOutil("La messagerie n'est pas configurée dans l'extension : l'utilisateur doit renseigner, dans les réglages de " +
          "l'extension Anonymiseur, le serveur IMAP, l'identifiant et le mot de passe de sa messagerie. En attendant : importer_presse_papiers " +
          "(il copie le message) ou importer_fichiers (pièces jointes enregistrées dans Téléchargements).");
      }
      const { ClientImap, piecesJointes } = require("./courriel");
      const F = fichiersMime();
      const client = new ClientImap({ hote: cfg.hote, port: cfg.port, tls: cfg.tls });
      try {
        try { await client.connexion(cfg.utilisateur, cfg.motDePasse, cfg.dossier); } catch (e) {
          throw new ErreurOutil(`Connexion à la messagerie impossible : ${e.message}. Vérifiez les réglages IMAP de l'extension.`);
        }
        const id = String(args.courriel || "").trim();
        if (!id) {
          // Liste des derniers messages : expéditeurs et objets pseudonymisés sous une référence temporaire, aussitôt supprimée
          const nombre = Math.min(Math.max(parseInt(args.nombre || 10, 10) || 10, 1), 30);
          const uids = (await client.uids("ALL")).slice(-nombre).reverse();
          if (!uids.length) return "Aucun message dans la boîte de réception.";
          const entetes = new Map((await client.entetes(uids)).map(e => [e.uid, F.partieMime(e.entete + "\r\n\r\n").champ]));
          const lignes = uids.map(u => {
            const champ = entetes.get(u) || (() => "");
            return `De : ${F.decoderEntete(champ("From")) || "?"} | Objet : ${F.decoderEntete(champ("Subject")) || "(sans objet)"}`.replace(/[\r\n]+/g, " ");
          });
          const tmp = "D-" + crypto.randomBytes(4).toString("hex");
          let pseudo;
          try { pseudo = String((await anonymiserTexte(lignes.join("\n"), tmp)).texte || "").split("\n"); } finally {
            try { await appelApi(`/api/dossiers/${encodeURIComponent(tmp)}`, { method: "DELETE" }); } catch { /* référence temporaire */ }
          }
          courrielsConnus.clear();
          const sortie = uids.map((u, i) => {
            courrielsConnus.set(`C${i + 1}`, { uid: u, validite: client.uidValidity });
            return `C${i + 1} · ${dateCourte((entetes.get(u) || (() => ""))("Date"))} · ${pseudo[i] ?? "(illisible)"}`;
          });
          journaliser("liste_courriels", { nombre: uids.length });
          return [`${uids.length} derniers messages de la boîte (pseudonymisés ; la boîte n'est pas modifiée) :`, ...sortie,
            "Pour importer un message dans le dossier courant, avec ses pièces jointes : importer_courriel avec courriel=C…"].join("\n");
        }
        const c = courant();
        if (!c) throw new ErreurOutil("Aucun dossier courant : appelez creer_dossier_affaire ou choisir_dossier, puis importer_courriel.");
        let uid;
        const connu = courrielsConnus.get(id.toUpperCase());
        if (connu) {
          if (connu.validite !== client.uidValidity) throw new ErreurOutil("La liste des messages n'est plus valable : rappelez importer_courriel sans paramètre.");
          uid = connu.uid;
        } else if (/^<?[^<>\s@]+@[^<>\s]+>?$/.test(id)) {
          uid = (await client.uids(`HEADER Message-ID ${ClientImap.chaine(id.startsWith("<") ? id : `<${id}>`)}`))[0];
        } else {
          throw new ErreurOutil("Identifiant inconnu : appelez importer_courriel sans paramètre pour obtenir la liste (C1, C2…).");
        }
        const brut = uid ? await client.message(uid) : null;
        if (!brut) throw new ErreurOutil("Message introuvable dans la boîte de réception.");
        const dest = dossierImport(c, args.sous_dossier);
        const cible = await ecrireSansEcraser(dest.dir, nomDeBase("", `courriel ${horodatage()}`), ".eml", brut);
        const copies = [];
        for (const p of piecesJointes(brut.toString("latin1"), F)) {
          const ext = path.extname(p.nom).toLowerCase().replace(/[^.a-z0-9]/g, "");
          copies.push(await ecrireSansEcraser(dest.dir, nomDeBase(path.basename(p.nom, path.extname(p.nom)), "piece-jointe"), ext, p.octets));
        }
        toucher(c);
        journaliser("import_courriel", { ref: c.ref, nombre: copies.length, octets: brut.length });
        const lisibles = copies.filter(f => EXTENSIONS.has(path.extname(f).toLowerCase()));
        const lecture = await executer("lire_fichier_anonymise", { fichier: idPour(cible) });
        return [
          `Courriel enregistré ${dest.ou} sous l'identifiant ${idPour(cible)} (.eml), avec ${copies.length} pièce(s) jointe(s) ; la boîte de messagerie n'est pas modifiée.`,
          ...(await lignesFichiers(c.chemin, lisibles, c.ref)),
          copies.length > lisibles.length ? `${copies.length - lisibles.length} pièce(s) jointe(s) dans un format non lisible (images…), enregistrée(s) sans identifiant.` : null,
          "",
          lecture,
        ].filter(x => x !== null).join("\n");
      } finally {
        await client.fermer();
      }
    }

    case "importer_presse_papiers": {
      await attendreSelection();
      const c = courant();
      if (!c) throw new ErreurOutil("Aucun dossier courant : appelez creer_dossier_affaire ou choisir_dossier, puis importer_presse_papiers.");
      const lu = await lirePressePapiers();
      if (lu.erreur) throw new ErreurOutil(`Lecture impossible : ${lu.erreur}.`);
      const texte = String(lu.texte || "").replace(/\r\n?/g, "\n");
      if (!texte.trim()) throw new ErreurOutil("Le presse-papiers ne contient pas de texte. Demandez à l'utilisateur de copier le message (Ctrl+C), puis réessayez.");
      const dest = dossierImport(c, args.sous_dossier);
      const base = nomDeBase(args.nom_fichier ? String(args.nom_fichier).replace(/\.txt$/i, "") : "", `presse-papiers ${horodatage()}`);
      // Pseudonymisation d'abord : si le serveur est injoignable, rien n'est écrit
      const r = await anonymiserTexte(texte, c.ref);
      const cible = await ecrireSansEcraser(dest.dir, base, ".txt", Buffer.from(texte, "utf8"));
      const id = idPour(cible);
      toucher(c);
      journaliser("import_presse_papiers", { ref: c.ref, fichier: id, caracteres: texte.length, remplacements: r.nb_remplacements, entites: compteTypes(r.entites) });
      const pseudo = String(r.texte || "");
      const total = Math.max(1, Math.ceil(pseudo.length / TAILLE_PARTIE));
      return [
        `Texte du presse-papiers enregistré ${dest.ou} sous l'identifiant ${id} (fichier .txt). Version pseudonymisée (référence d'anonymisation « ${c.ref} ») :`,
        `Entités remplacées : ${resumeEntites(r.entites)}.`,
        total > 1 ? `Partie 1/${total} — pour la suite : lire_fichier_anonymise avec fichier=${id} et partie=2.` : null,
        ...(r.avertissements || []).map(a => "⚠ " + a),
        "Conservez les marqueurs à l'identique.",
        "────────────────────────",
      ].filter(Boolean).join("\n") + "\n" + pseudo.slice(0, TAILLE_PARTIE);
    }

    case "reidentifier_vers_presse_papiers": {
      await attendreSelection();
      const texte = String(args.texte || "");
      if (!texte.trim()) throw new ErreurOutil("Le texte est vide.");
      const c = courant();
      const dossier = refOutil(args, c);
      const r = await (await appelApi("/api/reidentifier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte, dossier }),
      })).json();
      const inconnus = r.marqueurs_inconnus || [];
      if (!r.nb_remplacements && inconnus.length) {
        return `Aucun marqueur de ce texte n'est connu dans « ${dossier} » (${inconnus.join(", ")}) : le presse-papiers n'a pas été modifié. ` +
          "Vérifiez que le dossier courant est celui de l'affaire.";
      }
      const sortie = args.texte_brut ? String(r.texte || "") : texteSansMarkdown(String(r.texte || ""));
      const e = await ecrirePressePapiers(sortie);
      if (e.erreur) throw new ErreurOutil(`Presse-papiers indisponible : ${e.erreur}. Utilisez enregistrer_document au format txt.`);
      toucher(c);
      journaliser("presse_papiers_sortie", { ref: dossier, caracteres: sortie.length, remplacements: r.nb_remplacements || 0, inconnus: inconnus.length });
      const lignes = [
        "Texte ré-identifié placé dans le presse-papiers du poste de l'utilisateur : il peut le coller (Ctrl+V) dans sa messagerie.",
        `${r.nb_remplacements || 0} marqueur(s) remplacé(s) par les données réelles (référence d'anonymisation « ${dossier} »).`,
        e.hors_historique && process.platform === "win32" ? "Contenu exclu de l'historique du presse-papiers Windows et de la synchronisation entre appareils." : null,
        "Invitez l'utilisateur à relire le texte avant envoi.",
      ];
      if (inconnus.length) lignes.push(`⚠ Marqueurs inconnus dans « ${dossier} », laissés tels quels : ${inconnus.join(", ")}.`);
      return lignes.filter(Boolean).join("\n");
    }

    case "entites_du_dossier": {
      const dossier = refOutil(args, selectionEnCours ? null : courant());
      const r = await (await appelApi(`/api/dossiers/${encodeURIComponent(dossier)}/entites`)).json();
      if (!r.entites.length) return `Aucun marqueur dans « ${dossier} ».`;
      return `Référence « ${dossier} » — ${r.entites.length} marqueur(s) :\n` +
        r.entites.map(e => `${e.marqueur} (${e.type}) — ${e.occurrences} occurrence(s)${e.exclu ? " — exclu : laissé en clair dans les nouveaux documents" : ""}`).join("\n");
    }

    case "corriger_entite": {
      await attendreSelection();
      const c = courant();
      const dossier = refOutil(args, c);
      const action = String(args.action || "");
      const envoyer = async corps => {
        try {
          return await (await appelApi(`/api/dossiers/${encodeURIComponent(dossier)}/corriger`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
          })).json();
        } catch (e) {
          if (/\(404\)/.test(e.message)) throw new ErreurOutil("Le serveur d'anonymisation ne connaît pas encore les corrections : il doit être mis à jour en version 1.2.0.");
          throw e;
        }
      };
      const RELIRE = "Relisez les documents concernés avec lire_fichier_anonymise : le texte déjà lu dans la conversation n'est pas modifié.";
      if (action === "ajouter") {
        const type = String(args.type || "");
        if (!TYPES_PAR_DEFAUT.includes(type)) throw new ErreurOutil("Indiquez le type de la donnée à ajouter (PERSONNE, SOCIETE, ADRESSE…).");
        const conclure = (r, origine) => {
          journaliser("correction", { ref: dossier, mode: "ajouter", nombre: 1 });
          toucher(c);
          return [`${origine} : ${r.deja_connu ? "elle était déjà connue sous" : "elle sera désormais masquée sous"} le marqueur ${r.marqueur} dans « ${dossier} ».`, RELIRE].join("\n");
        };
        if (args.texte_vu !== undefined && String(args.texte_vu).trim()) {
          return conclure(await envoyer({ action, type, valeur: String(args.texte_vu) }), "Donnée ajoutée au dossier");
        }
        return viaDialogue("entite", async () => {
          const s = await saisirTexte(TITRE_ENTITE, `Tapez exactement la donnée à masquer dans le dossier ${dossier} (type : ${type}), telle qu'elle figure ` +
            "dans les documents. Elle ne sera pas communiquée à Claude.");
          if (s.erreur) throw new ErreurOutil(`Saisie impossible : ${s.erreur}.`);
          if (s.annule) return "L'utilisateur a fermé la fenêtre sans rien saisir : aucune correction.";
          return conclure(await envoyer({ action, type, valeur: s.texte }), "Donnée saisie par l'utilisateur dans la fenêtre locale");
        }, "Une fenêtre est ouverte sur l'écran de l'utilisateur pour qu'il tape la donnée à masquer (elle peut se trouver derrière une autre). " +
          "Dites-lui de la saisir puis de valider ; appelez ensuite à nouveau corriger_entite avec les mêmes paramètres pour obtenir le résultat.");
      }
      if (!["fusionner", "exclure", "reinclure"].includes(action)) throw new ErreurOutil("Action inconnue : fusionner, exclure, reinclure ou ajouter.");
      const r = await envoyer({ action, marqueurs: Array.isArray(args.marqueurs) ? args.marqueurs.map(String) : [] });
      journaliser("correction", { ref: dossier, mode: action, nombre: r.valeurs });
      toucher(c);
      const phrase = action === "fusionner"
        ? `Fusion faite dans « ${dossier} » : ${r.absorbes.join(", ")} → ${r.marqueur}. Les documents lus désormais n'utiliseront que ${r.marqueur} ; ` +
          `un ancien document contenant ${r.absorbes.join(" ou ")} se ré-identifie toujours.`
        : action === "exclure"
          ? `Exclusion enregistrée dans « ${dossier} » : ${r.marqueurs.join(", ")} ne sera plus masqué dans les nouveaux documents de ce dossier ` +
            "(les documents déjà produits se ré-identifient toujours). Annulable avec reinclure."
          : `Exclusion annulée dans « ${dossier} » : ${r.marqueurs.join(", ")} sera de nouveau masqué.`;
      return [phrase, RELIRE].join("\n");
    }

    default:
      throw new ErreurOutil(`Outil inconnu : ${nom}`);
  }
}

// ---------------------------------------------------------------------------
// Boucle JSON-RPC sur stdio
// ---------------------------------------------------------------------------
function envoyer(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let clientDeclareRacines = false;
let compteurRequetes = 0;
const requetesEnAttente = new Map(); // id -> fonction de traitement de la réponse

/** Demande au client MCP les dossiers de la session (si le client sait les fournir). */
function demanderRacines() {
  if (!clientDeclareRacines) return;
  const id = "anonymiseur-racines-" + (++compteurRequetes);
  requetesEnAttente.set(id, reponse => {
    const liste = (reponse.result && Array.isArray(reponse.result.roots)) ? reponse.result.roots : [];
    const dossiers = [];
    for (const r of liste) {
      try {
        if (!r || typeof r.uri !== "string" || !r.uri.startsWith("file:")) continue;
        const p = reel(fileURLToPath(r.uri));
        if (p && existeDossier(p) && !tropLarge(p)) dossiers.push(p);
      } catch { /* URI inexploitable */ }
    }
    racinesClient = dossiers;
    courantSession = null;
    log(`dossiers de session communiqués par le client : ${dossiers.length}`);
  });
  envoyer({ jsonrpc: "2.0", id, method: "roots/list" });
}

async function traiter(msg) {
  const { id, method, params } = msg;

  // Réponse à une requête émise par l'extension (roots/list)
  if (method === undefined && id !== undefined) {
    const suite = requetesEnAttente.get(id);
    if (suite) {
      requetesEnAttente.delete(id);
      try { suite(msg); } catch (e) { log("réponse client inexploitable :", e.message); }
    }
    return;
  }

  const repondre = result => id !== undefined && envoyer({ jsonrpc: "2.0", id, result });
  const echec = (code, message) => id !== undefined && envoyer({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const demande = params?.protocolVersion;
      clientDeclareRacines = !!(params?.capabilities && params.capabilities.roots);
      return repondre({
        protocolVersion: VERSIONS_PROTOCOLE.includes(demande) ? demande : VERSIONS_PROTOCOLE[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "anonymiseur", title: "Anonymiseur", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
      demanderRacines();
      return;
    case "notifications/roots/list_changed":
      demanderRacines();
      return;
    case "ping":
      return repondre({});
    case "tools/list":
      return repondre({ tools: OUTILS });
    case "tools/call": {
      const nom = params?.name;
      try {
        const texte = await executer(nom, params?.arguments || {});
        return repondre({ content: [{ type: "text", text: texte }] });
      } catch (e) {
        if (!(e instanceof ErreurOutil)) log("erreur", nom, e.stack || e.message);
        return repondre({ content: [{ type: "text", text: e instanceof ErreurOutil ? e.message : "Erreur interne : " + e.message }], isError: true });
      }
    }
    case "resources/list":
      return repondre({ resources: [] });
    case "prompts/list":
      return repondre({ prompts: [] });
    default:
      if (method && method.startsWith("notifications/")) return; // pas de réponse aux notifications
      return echec(-32601, `Méthode non prise en charge : ${method}`);
  }
}

function demarrer() {
  let tampon = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", morceau => {
    tampon += morceau;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, i).trim();
      tampon = tampon.slice(i + 1);
      if (!ligne) continue;
      let msg;
      try { msg = JSON.parse(ligne); } catch {
        envoyer({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
        continue;
      }
      const lot = Array.isArray(msg) ? msg : [msg];
      for (const m of lot) traiter(m).catch(e => log("erreur", e.stack || e.message));
    }
  });
  process.stdin.on("end", () => {
    if (processusSelecteur) { try { processusSelecteur.kill(); } catch { /* déjà terminé */ } }
    process.exit(0);
  });
  log(`démarré (v${VERSION}) — serveur ${SERVEUR}`);
}

// Le serveur démarre TOUJOURS, y compris lorsque Claude Desktop charge ce fichier par l'intermédiaire
// de son propre lanceur (Node intégré) : dans ce cas le fichier n'est pas le « module principal ».
// Seuls les tests automatiques, qui positionnent ANON_MODE_TEST=1 avant de charger le fichier,
// obtiennent les fonctions internes sans démarrage.
if (!(process.env.ANON_MODE_TEST === "1" && require.main !== module)) {
  demarrer();
} else {
  module.exports = {
    VERSION, OUTILS, lireZip, ecrireZip, creerEntree, contenuEntree, crc32, trouverMarqueurs, traiterParagraphes,
    remplacerMarqueurs, rtfEchapper, xmlEchapper, xmlDecoder, filtrerMots, filtrerNomFichier, nettoyerSousDossier,
    refPour, TYPES_PAR_DEFAUT, SCRIPT_POWERSHELL_SELECTEUR, CODE_CSHARP_SELECTEUR, TITRE_SELECTEUR,
    TITRE_FICHIERS, TITRE_LIBELLE, lirePressePapiers, ecrirePressePapiers, ouvrirSelecteurFichiers, saisirLibelle,
    texteSansMarkdown, nettoyerLibelle, prochaineReference, journaliser, FICHIER_AFFAIRE,
    appliquerModele, motifSouple, dotxVersDocx, ouvrirSurPoste, saisirTexte, TITRE_ENTITE,
  };
}
