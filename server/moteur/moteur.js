/*
 * AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat
 * Logiciel libre : GNU AGPL v3 ou ultérieure (fichiers LICENSE et NOTICE).
 */
/*
 * Moteur local : anonymisation et ré-identification sur le poste, sans serveur
 * (portage de app/engine.py du serveur 1.1.0), avec une table de correspondance chiffrée par affaire.
 *
 * Table de correspondance :
 *  - un fichier par référence d'anonymisation (D-xxxxxxxx.json) ;
 *  - valeurs réelles chiffrées en AES-256-GCM avec une clé propre à l'affaire (dérivée par HKDF) ;
 *  - recherche d'une valeur déjà vue par empreinte HMAC-SHA256 (jamais de valeur en clair) ;
 *  - clé maîtresse protégée sous Windows par DPAPI (liée à la session Windows de l'utilisateur).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const D = require("./detect");
const { candidatsOllama } = require("./ner-ollama");

const CONSIGNE =
  "Consigne : le texte ci-dessous a été pseudonymisé. Les éléments d'identification ont été remplacés par des marqueurs entre crochets " +
  "([PERSONNE_1], [SOCIETE_1], [ADRESSE_1], [SIRET_1]…). Reprends ces marqueurs exactement à l'identique dans ta réponse (sans les traduire, " +
  "les accorder ni les modifier) et ne cherche pas à deviner les données d'origine. Un même marqueur désigne toujours la même personne ou entité.";
const TYPES_RE = [...D.TYPES].sort((a, b) => b.length - a.length).join("|");
const RE_MARQUEUR_SOUPLE = new RegExp(`\\[\\s*(${TYPES_RE})[ _\\-]?(\\d+)\\s*\\]|(?<![\\p{L}\\p{N}_\\[])(${TYPES_RE})_(\\d+)(?![\\p{L}\\p{N}_\\]])`, "giu");
const RE_DOSSIER = /^[\p{L}\p{N}_\-. ]{1,64}$/u;

// ---------------------------------------------------------------------------- clé maîtresse
function powershell(script, entree) {
  return new Promise(resolve => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out.trim()));
    p.stdin.end(entree || "");
  });
}
const PS_DPAPI = op => `
Add-Type -AssemblyName System.Security
$e = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$s = [Text.Encoding]::UTF8.GetBytes('anonymiseur-cabinet')
$r = [Security.Cryptography.ProtectedData]::${op}($e, $s, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($r))`;

async function cleMaitresse(dossier) {
  fs.mkdirSync(dossier, { recursive: true });
  const fichier = path.join(dossier, "cle.dat");
  const dpapi = process.platform === "win32" && process.env.ANON_DPAPI !== "0";
  if (fs.existsSync(fichier)) {
    const contenu = JSON.parse(fs.readFileSync(fichier, "utf8"));
    if (contenu.protection === "dpapi") {
      const b64 = await powershell(PS_DPAPI("Unprotect"), contenu.cle);
      const cle = Buffer.from(b64, "base64");
      if (cle.length !== 32) throw new Error("clé de la table locale illisible (session Windows différente ?)");
      return cle;
    }
    return Buffer.from(contenu.cle, "base64");
  }
  const cle = crypto.randomBytes(32);
  let enregistre = { protection: "fichier", cle: cle.toString("base64") };
  if (dpapi) {
    const prot = await powershell(PS_DPAPI("Protect"), cle.toString("base64"));
    if (prot) enregistre = { protection: "dpapi", cle: prot };
  }
  fs.writeFileSync(fichier, JSON.stringify(enregistre), { encoding: "utf8", mode: 0o600 });
  return cle;
}

// ---------------------------------------------------------------------------- table de correspondance
class Stockage {
  constructor(dossier) {
    this.dossier = dossier;
    this.cle = null;
    this.cache = new Map();
    this.modifies = new Set();
  }

  async ouvrir() {
    if (!this.cle) this.cle = await cleMaitresse(this.dossier);
    return this;
  }

  valider(dossier) {
    const d = String(dossier || "general").trim();
    if (!RE_DOSSIER.test(d)) throw new Error("Nom de dossier invalide (lettres, chiffres, espace, - _ . ; 64 caractères max)");
    return d;
  }

  cleDe(ref, usage) {
    return Buffer.from(crypto.hkdfSync("sha256", this.cle, Buffer.from("anonymiseur-cabinet"), Buffer.from(`${usage}:${ref}`), 32));
  }

  fichier(ref) {
    return path.join(this.dossier, encodeURIComponent(ref) + ".json");
  }

  table(ref) {
    // Relue si une autre instance de l'extension l'a modifiée sur le disque (et qu'aucun changement n'attend ici)
    let mtime = 0;
    try { mtime = fs.statSync(this.fichier(ref)).mtimeMs; } catch { /* pas encore de fichier */ }
    if (this.cache.has(ref) && !this.modifies.has(ref) && (this.mtimes || new Map()).get(ref) !== mtime) this.cache.delete(ref);
    if (!this.cache.has(ref)) {
      let t;
      try { t = JSON.parse(fs.readFileSync(this.fichier(ref), "utf8")); } catch { t = null; }
      this.cache.set(ref, t || { version: 1, ref, cree: Date.now(), utilise: Date.now(), compteurs: {}, entrees: [] });
      (this.mtimes = this.mtimes || new Map()).set(ref, mtime);
    }
    return this.cache.get(ref);
  }

  empreinte(ref, norm) {
    return crypto.createHmac("sha256", this.cleDe(ref, "empreinte")).update(norm, "utf8").digest("hex");
  }

  chiffrer(ref, valeur) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.cleDe(ref, "table"), iv);
    const corps = Buffer.concat([c.update(valeur, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), corps].map(b => b.toString("base64")).join(".");
  }

  dechiffrer(ref, chiffre) {
    const [iv, tag, corps] = chiffre.split(".").map(b => Buffer.from(b, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", this.cleDe(ref, "table"), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(corps), d.final()]).toString("utf8");
  }

  toucher(ref) {
    this.table(ref).utilise = Date.now();
    this.modifies.add(ref);
  }

  marqueurPour(ref, type, valeur, norm, canoniqueDe = null) {
    const t = this.table(ref);
    const emp = this.empreinte(ref, norm);
    const existante = t.entrees.find(e => e.empreinte === emp);
    this.modifies.add(ref);
    if (existante) { existante.occurrences++; return existante.marqueur; }
    let marqueur = null, canonique = false;
    if (canoniqueDe !== null) {
      const ref2 = t.entrees.find(e => e.empreinte === this.empreinte(ref, canoniqueDe));
      if (ref2) { marqueur = ref2.marqueur; type = ref2.type; }
    }
    if (marqueur === null) {
      const n = (t.compteurs[type] || 0) + 1;
      t.compteurs[type] = n;
      marqueur = `[${type}_${n}]`;
      canonique = true;
    }
    t.entrees.push({ marqueur, type, empreinte: emp, valeur: this.chiffrer(ref, valeur), canonique, occurrences: 1, cree: Date.now() });
    return marqueur;
  }

  enregistrer() {
    for (const ref of this.modifies) {
      const f = this.fichier(ref), tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.cache.get(ref) || this.table(ref)), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, f);
      try { (this.mtimes = this.mtimes || new Map()).set(ref, fs.statSync(f).mtimeMs); } catch { /* relu au prochain accès */ }
    }
    this.modifies.clear();
  }

  valeursConnues(ref) {
    const exclus = this.exclusions(ref);
    return this.table(ref).entrees.filter(e => !exclus.has(e.empreinte)).map(e => [e.marqueur, e.type, this.dechiffrer(ref, e.valeur), e.canonique]);
  }

  tableInverse(ref) {
    const out = {};
    const entrees = this.table(ref).entrees;
    for (const e of entrees) if (e.canonique) out[e.marqueur] = this.dechiffrer(ref, e.valeur);
    // Marqueurs absorbés par une fusion : toujours ré-identifiables dans les anciens documents
    for (const e of entrees) if (e.ancien && e.ancienCanonique && !(e.ancien in out)) out[e.ancien] = this.dechiffrer(ref, e.valeur);
    return out;
  }

  // ------------------------------------------------------------------ corrections (aucune valeur réelle renvoyée)
  typesMarqueurs(ref) {
    const out = {};
    for (const e of this.table(ref).entrees) if (!(e.marqueur in out)) out[e.marqueur] = e.type;
    return out;
  }

  fusionner(ref, garder, absorbes) {
    const type = this.typesMarqueurs(ref)[garder];
    let n = 0;
    for (const e of this.table(ref).entrees) {
      if (!absorbes.includes(e.marqueur)) continue;
      if (!e.ancien) { e.ancien = e.marqueur; e.ancienCanonique = e.canonique; }
      Object.assign(e, { marqueur: garder, type, canonique: false });
      n++;
    }
    this.modifies.add(ref);
    return n;
  }

  exclure(ref, marqueur) {
    const t = this.table(ref);
    t.exclus = t.exclus || [];
    const emps = t.entrees.filter(e => e.marqueur === marqueur).map(e => e.empreinte);
    for (const e of emps) if (!t.exclus.includes(e)) t.exclus.push(e);
    this.modifies.add(ref);
    return emps.length;
  }

  reinclure(ref, { marqueur = null, empreinte = null } = {}) {
    const t = this.table(ref);
    const cibles = new Set(empreinte !== null ? [empreinte] : t.entrees.filter(e => e.marqueur === marqueur).map(e => e.empreinte));
    const avant = (t.exclus || []).length;
    t.exclus = (t.exclus || []).filter(e => !cibles.has(e));
    this.modifies.add(ref);
    return avant - t.exclus.length;
  }

  exclusions(ref) {
    return new Set(this.table(ref).exclus || []);
  }

  entites(ref, avecValeurs) {
    const parMarqueur = new Map();
    for (const e of this.table(ref).entrees) {
      const x = parMarqueur.get(e.marqueur) || { marqueur: e.marqueur, type: e.type, occurrences: 0, variantes: [] };
      x.occurrences += e.occurrences;
      if (avecValeurs) { if (e.canonique) x.valeur = this.dechiffrer(ref, e.valeur); else x.variantes.push(this.dechiffrer(ref, e.valeur)); }
      parMarqueur.set(e.marqueur, x);
    }
    const out = [...parMarqueur.values()];
    const exclus = this.exclusions(ref);
    const marqueursExclus = new Set(this.table(ref).entrees.filter(e => exclus.has(e.empreinte)).map(e => e.marqueur));
    for (const x of out) if (marqueursExclus.has(x.marqueur)) x.exclu = true;
    if (!avecValeurs) for (const x of out) delete x.variantes;
    return out.sort((a, b) => a.type.localeCompare(b.type) || parseInt(a.marqueur.replace(/\D/g, ""), 10) - parseInt(b.marqueur.replace(/\D/g, ""), 10));
  }

  listerDossiers() {
    let noms = [];
    try { noms = fs.readdirSync(this.dossier).filter(n => n.endsWith(".json")); } catch { /* aucun */ }
    return noms.map(n => {
      const t = this.table(decodeURIComponent(n.slice(0, -5)));
      return { id: t.ref, cree: t.cree / 1000, utilise: t.utilise / 1000, nb_entites: new Set(t.entrees.map(e => e.marqueur)).size };
    }).sort((a, b) => b.utilise - a.utilise);
  }

  supprimer(ref) {
    this.cache.delete(ref);
    this.modifies.delete(ref);
    try { fs.unlinkSync(this.fichier(ref)); } catch { /* déjà absent */ }
  }
}

// ---------------------------------------------------------------------------- moteur
class Moteur {
  /**
   * @param stockage Stockage ouvert
   * @param listes   listes personnalisées (D.chargerListes)
   * @param ner      { url, modele } pour Ollama, ou null (règles seules) ; ner.candidats(texte) pour les tests
   */
  constructor(stockage, listes, ner = null) {
    this.store = stockage;
    this.listes = listes || D.chargerListes(null);
    this.ner = ner;
    this.etatNer = { actif: false, modele: ner && ner.modele, erreur: ner ? null : "non configuré" };
  }

  async candidats(texte) {
    if (!this.ner) return null;
    try {
      const r = this.ner.candidats ? { candidats: await this.ner.candidats(texte) } : await candidatsOllama(texte, this.ner);
      this.etatNer = { actif: true, modele: this.ner.modele, erreur: null };
      return r.candidats;
    } catch (e) {
      this.etatNer = { actif: false, modele: this.ner.modele, erreur: e.message };
      return null;
    }
  }

  async anonymiser(texte, dossier, options = {}, inclureValeurs = false) {
    dossier = this.store.valider(dossier);
    this.store.toucher(dossier);
    const types = new Set(options.types || D.TYPES_PAR_DEFAUT);
    const toutesDates = !!options.toutes_dates;
    if (toutesDates) types.add("DATE");
    const utiliserNer = options.ner !== false;

    const zonesMarqueurs = [];
    for (const m of texte.matchAll(D.RE_MARQUEUR)) zonesMarqueurs.push([m.index, m.index + m[0].length]);
    const horsMarqueurs = spans => spans.filter(s => !zonesMarqueurs.some(([a, b]) => a < s.end && s.start < b));
    const zones = D.zonesProtegees(texte);
    const jamais = new Set(this.listes.jamais);
    for (const t of options.jamais || []) if (typeof t === "string" && t.trim()) jamais.add(D.normaliser(t));

    // 1. Détection automatique
    let spans = D.detecterRegles(texte, types, toutesDates, this.listes);
    let nerActif = false;
    if (utiliserNer && this.ner) {
      const cands = await this.candidats(texte);
      if (cands) {
        nerActif = true;
        spans = spans.concat(D.filtrerCandidatsNer(texte, cands, this.listes).filter(s => types.has(s.type)));
      }
    }
    // 2. Termes imposés
    const imposes = [...this.listes.toujours];
    for (const t of options.termes || []) if (typeof t === "string" && t.trim()) imposes.push(D.analyserTerme(t));
    spans = spans.concat(D.rechercherTermes(texte, imposes, D.P_IMPOSE, "impose"));
    // 3. Valeurs déjà connues du dossier
    const connues = this.store.valeursConnues(dossier);
    for (const [, type, valeur] of connues) {
      const unMot = valeur.split(/\s+/).filter(Boolean).length === 1;
      spans = spans.concat(D.rechercherTermes(texte, [[type, valeur]], D.P_CONNU, "connu", ["PERSONNE", "SOCIETE", "AUTRE"].includes(type) && unMot));
    }
    // Valeurs exclues par l'utilisateur pour ce dossier (corriger_entite) : plus jamais masquées, sauf terme imposé
    const exclus = this.store.exclusions(dossier);
    const nonExclus = liste => !exclus.size ? liste
      : liste.filter(s => s.source === "impose" || !exclus.has(this.store.empreinte(dossier, D.normaliser(texte.slice(s.start, s.end), s.type))));
    spans = nonExclus(D.appliquerZones(horsMarqueurs(spans), zones, texte));
    let retenus = D.resoudre(spans, texte, jamais);

    // 4. Propagation
    let propag = [];
    const references = new Map();
    for (const s of retenus) if (s.type === "PERSONNE" || s.type === "SOCIETE") references.set(`${s.type}\u0000${s.value}`, [s.type, s.value]);
    for (const [, t, v, c] of connues) if (c && (t === "PERSONNE" || t === "SOCIETE")) references.set(`${t}\u0000${v}`, [t, v]);
    for (const [type, valeur] of references.values()) {
      propag = propag.concat(D.rechercherTermes(texte, [[type, valeur]], D.P_PROPAGATION + 1, "meme_texte", true));
      for (const variante of D.variantesNom(valeur, type)) {
        if (jamais.has(D.normaliser(variante))) continue;
        for (const s of D.rechercherTermes(texte, [[type, variante]], D.P_PROPAGATION, "propagation", true)) {
          s.canonical = valeur;
          propag.push(s);
        }
      }
    }
    if (propag.length) {
      propag = nonExclus(D.appliquerZones(horsMarqueurs(propag), zones, texte));
      retenus = D.resoudre(spans.concat(propag), texte, jamais);
    }
    retenus = D.fusionnerAdjacents(retenus, texte);

    // Rattacher une forme courte au nom complet quand il n'y a pas d'ambiguïté
    const varianteVersRef = new Map();
    for (const [type, valeur] of references.values()) {
      for (const v of D.variantesNom(valeur, type)) {
        const k = `${type}\u0000${D.normaliser(v)}`;
        if (!varianteVersRef.has(k)) varianteVersRef.set(k, new Set());
        varianteVersRef.get(k).add(D.normaliser(valeur));
      }
    }
    const refsOriginales = new Map();
    for (const [, v] of references.values()) refsOriginales.set(D.normaliser(v), v);
    for (const s of retenus) {
      if (s.source === "propagation" || (s.type !== "PERSONNE" && s.type !== "SOCIETE")) continue;
      const refs = varianteVersRef.get(`${s.type}\u0000${D.normaliser(s.value)}`);
      if (refs && refs.size === 1) {
        const ref = [...refs][0];
        if (ref !== D.normaliser(s.value)) { s.source = "propagation"; s.canonical = refsOriginales.get(ref); }
      }
    }

    // 5. Attribution des marqueurs (références d'abord, variantes ensuite)
    const attribution = new Map();
    const ordre = retenus.map((_, i) => i).sort((a, b) => (retenus[a].source === "propagation") - (retenus[b].source === "propagation"));
    for (const i of ordre) {
      const s = retenus[i];
      const norm = D.normaliser(s.value, s.type);
      const canon = s.source === "propagation" && s.canonical ? D.normaliser(s.canonical, s.type) : null;
      const valeur = s.value.trim().replace(/[ \t]*\r?\n[ \t]*/g, " ");
      attribution.set(i, this.store.marqueurPour(dossier, s.type, valeur, norm, canon));
    }
    this.store.enregistrer();

    // 6. Remplacement
    let sortie = "", pos = 0;
    retenus.forEach((s, i) => { sortie += texte.slice(pos, s.start) + attribution.get(i); pos = s.end; });
    sortie += texte.slice(pos);
    if (options.consigne) sortie = CONSIGNE + "\n\n---\n\n" + sortie;

    const compte = new Map(), typesParMarqueur = new Map();
    for (const [i, m] of attribution) { compte.set(m, (compte.get(m) || 0) + 1); typesParMarqueur.set(m, retenus[i].type); }
    const inverse = inclureValeurs ? this.store.tableInverse(dossier) : {};
    const entites = [...compte.entries()].map(([marqueur, n]) => {
      const e = { marqueur, type: typesParMarqueur.get(marqueur), occurrences: n };
      if (inclureValeurs) {
        e.valeur = inverse[marqueur] || "";
        e.formes = [...new Set([...attribution].filter(([, m]) => m === marqueur).map(([i]) => retenus[i].value))].sort();
      }
      return e;
    }).sort((a, b) => a.type.localeCompare(b.type) || parseInt(a.marqueur.replace(/\D/g, ""), 10) - parseInt(b.marqueur.replace(/\D/g, ""), 10));
    const statistiques = {};
    for (const e of entites) statistiques[e.type] = (statistiques[e.type] || 0) + 1;
    const avertissements = [];
    if (utiliserNer && !nerActif) {
      avertissements.push("Reconnaissance des noms par le modèle local (Ollama) inactive : seules les règles ont été appliquées. " +
        "Relisez particulièrement les noms de personnes et de sociétés.");
    }
    return { dossier, texte: sortie, entites, statistiques, nb_remplacements: retenus.length, avertissements };
  }

  /** Corrections d'un dossier : fusionner, exclure, reinclure, ajouter (même comportement que le serveur 1.2.0). */
  corriger(dossier, action, marqueurs = null, type = null, valeur = null) {
    dossier = this.store.valider(dossier);
    const connus = this.store.typesMarqueurs(dossier);
    const norme = m => {
      const r = new RegExp(`^(?:${RE_MARQUEUR_SOUPLE.source})$`, "iu").exec(String(m).trim());
      if (!r) throw new Error(`Marqueur mal formé : ${String(m).slice(0, 40)}`);
      return `[${(r[1] || r[3]).toUpperCase()}_${r[2] || r[4]}]`;
    };
    const ms = [...new Set((marqueurs || []).map(norme))];
    if (["fusionner", "exclure", "reinclure"].includes(action)) {
      if (!ms.length) throw new Error("Indiquez le ou les marqueurs concernés.");
      const inconnus = ms.filter(m => !(m in connus));
      if (inconnus.length) throw new Error("Marqueur(s) inconnu(s) dans ce dossier : " + inconnus.join(", "));
    }
    let r;
    if (action === "fusionner") {
      if (ms.length < 2) throw new Error("Indiquez au moins deux marqueurs : celui à garder, puis celui ou ceux à fusionner.");
      r = { action, marqueur: ms[0], absorbes: ms.slice(1), valeurs: this.store.fusionner(dossier, ms[0], ms.slice(1)) };
    } else if (action === "exclure") {
      r = { action, marqueurs: ms, valeurs: ms.reduce((n, m) => n + this.store.exclure(dossier, m), 0) };
    } else if (action === "reinclure") {
      r = { action, marqueurs: ms, valeurs: ms.reduce((n, m) => n + this.store.reinclure(dossier, { marqueur: m }), 0) };
    } else if (action === "ajouter") {
      if (!D.TYPES.includes(type)) throw new Error("Type inconnu : " + D.TYPES.join(", "));
      const v = String(valeur || "").trim();
      if (v.length < 2 || v.length > 300 || /\[[A-Z_]+_\d+\]/.test(v)) throw new Error("Valeur invalide (2 à 300 caractères, sans marqueur).");
      const norm = D.normaliser(v, type);
      this.store.reinclure(dossier, { empreinte: this.store.empreinte(dossier, norm) });
      const m = this.store.marqueurPour(dossier, type, v, norm);
      r = { action, marqueur: m, deja_connu: m in connus };
    } else {
      throw new Error("Action inconnue : fusionner, exclure, reinclure ou ajouter.");
    }
    this.store.enregistrer();
    return r;
  }

  reidentifier(texte, dossier) {
    dossier = this.store.valider(dossier);
    const table = this.store.tableInverse(dossier);
    this.store.toucher(dossier);
    let remplaces = 0;
    const inconnus = new Set();
    let sortie = texte.replace(RE_MARQUEUR_SOUPLE, (tout, t1, n1, t3, n4) => {
      const cle = `[${(t1 || t3).toUpperCase()}_${n1 || n4}]`;
      if (cle in table) { remplaces++; return table[cle]; }
      inconnus.add(cle);
      return tout;
    });
    this.store.enregistrer();
    sortie = sortie.split(CONSIGNE + "\n\n---\n\n").join("");
    return { dossier, texte: sortie, nb_remplacements: remplaces, marqueurs_inconnus: [...inconnus].sort() };
  }
}

module.exports = { Moteur, Stockage, CONSIGNE };
