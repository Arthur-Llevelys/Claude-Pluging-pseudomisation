/*
 * Faux serveur d'anonymisation pour les tests automatiques.
 * Reproduit les routes utilisées par l'extension, avec un pseudonymiseur trivial :
 * une liste fixe de données fictives est remplacée par des marqueurs, par dossier.
 */
"use strict";
const http = require("http");

const CLE = "cle-de-test";
// Données fictives « sensibles » connues du faux serveur
const SENSIBLES = [
  ["PERSONNE", "Jean Dupont"],
  ["PERSONNE", "Marie Martin"],
  ["PERSONNE", "Dupont"],
  ["PERSONNE", "Martin"],
  ["SOCIETE", "ZORVAL & Fils"],
  ["SOCIETE", "ZORVAL"],
  ["EMAIL", "jean.dupont@exemple.fr"],
  ["ADRESSE", "12 rue de la Paix\n75002 Paris"],
];

function creer() {
  const dossiers = new Map(); // id -> { entites: Map(valeur -> {marqueur,type,occurrences}), compteurs: {}, utilise }
  const journal = [];         // appels reçus : { route, dossier }
  const etatFaux = { altererReperes: false };

  function dossier(id) {
    if (!dossiers.has(id)) dossiers.set(id, { entites: new Map(), compteurs: {}, utilise: 0 });
    const d = dossiers.get(id);
    d.utilise = Math.floor(Date.now() / 1000);
    return d;
  }

  function anonymiser(texte, id) {
    const d = dossier(id);
    const vues = new Map();
    let out = texte;
    for (const [type, valeur] of SENSIBLES) {
      if (!out.includes(valeur)) continue;
      let e = d.entites.get(valeur);
      if (!e) {
        d.compteurs[type] = (d.compteurs[type] || 0) + 1;
        e = { marqueur: `[${type}_${d.compteurs[type]}]`, type, valeur, occurrences: 0 };
        d.entites.set(valeur, e);
      }
      const n = out.split(valeur).length - 1;
      e.occurrences += n;
      vues.set(e.marqueur, { marqueur: e.marqueur, type, occurrences: n });
      out = out.split(valeur).join(e.marqueur);
    }
    return { texte: out, entites: [...vues.values()], avertissements: [], nb_caracteres: texte.length, dossier: id,
      nb_remplacements: [...vues.values()].reduce((n, e) => n + e.occurrences, 0) };
  }

  function reidentifier(texte, id) {
    const d = dossier(id);
    const parMarqueur = new Map([...d.entites.values()].map(e => [e.marqueur, e.valeur]));
    const inconnus = new Set();
    let n = 0;
    const out = texte.replace(/\[([A-Z_]+)_(\d+)\]/g, m => {
      if (parMarqueur.has(m)) { n++; return parMarqueur.get(m); }
      inconnus.add(m);
      return m;
    });
    return { texte: out, nb_remplacements: n, marqueurs_inconnus: [...inconnus], dossier: id };
  }

  function lireCorps(req) {
    return new Promise(resolve => {
      const morceaux = [];
      req.on("data", c => morceaux.push(c));
      req.on("end", () => resolve(Buffer.concat(morceaux)));
    });
  }

  function champsMultipart(corps, typeContenu) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(typeContenu || "");
    const frontiere = "--" + (m[1] || m[2]);
    const champs = {};
    const texte = corps.toString("latin1");
    for (const bloc of texte.split(frontiere)) {
      const sep = bloc.indexOf("\r\n\r\n");
      if (sep < 0) continue;
      const entete = bloc.slice(0, sep);
      const nom = /name="([^"]+)"/.exec(entete);
      if (!nom) continue;
      const brut = bloc.slice(sep + 4).replace(/\r\n$/, "");
      champs[nom[1]] = Buffer.from(brut, "latin1").toString("utf8");
    }
    return champs;
  }

  const serveur = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj, entetes) => {
      res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, entetes || {}));
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/api/sante") {
      return json(200, { ok: true, version: "faux-1.0", spacy: { actif: false, modele: null, erreur: null },
        types: ["PERSONNE", "SOCIETE", "ADRESSE", "EMAIL", "DATE_NAISSANCE"], cle_requise: true });
    }
    if (req.headers["x-api-key"] !== CLE) return json(401, { erreur: "clé refusée" });
    const corps = await lireCorps(req);

    if (url.pathname === "/api/dossiers" && req.method === "GET") {
      return json(200, { retention_jours: 30, dossiers: [...dossiers.entries()].map(([id, d]) => ({ id, nb_entites: d.entites.size, utilise: d.utilise })) });
    }
    if (url.pathname === "/api/anonymiser" && req.method === "POST") {
      const b = JSON.parse(corps.toString("utf8"));
      journal.push({ route: "anonymiser", dossier: b.dossier });
      return json(200, anonymiser(b.texte, b.dossier));
    }
    if (url.pathname === "/api/anonymiser-fichier" && req.method === "POST") {
      const c = champsMultipart(corps, req.headers["content-type"]);
      journal.push({ route: "anonymiser-fichier", dossier: c.dossier });
      return json(200, anonymiser(c.fichier || "", c.dossier));
    }
    if (url.pathname === "/api/reidentifier" && req.method === "POST") {
      const b = JSON.parse(corps.toString("utf8"));
      journal.push({ route: "reidentifier", dossier: b.dossier });
      const r = reidentifier(b.texte, b.dossier);
      // Option de test : un serveur qui altérerait les repères encadrant les marqueurs
      if (etatFaux.altererReperes) r.texte = r.texte.replace(/@@/g, "");
      return json(200, r);
    }
    if (url.pathname === "/api/reidentifier-fichier" && req.method === "POST") {
      const b = JSON.parse(corps.toString("utf8"));
      journal.push({ route: "reidentifier-fichier", dossier: b.dossier, format: b.format });
      const r = reidentifier(b.texte, b.dossier);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "x-remplacements": String(r.nb_remplacements),
        "x-marqueurs-inconnus": r.marqueurs_inconnus.join(","),
      });
      return res.end(Buffer.from((b.format === "docx" ? "FAUX-DOCX\n" : "") + r.texte, "utf8"));
    }
    const m = /^\/api\/dossiers\/([^/]+)(\/entites)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === "DELETE") { dossiers.delete(id); return json(200, { ok: true }); }
      const d = dossiers.get(id);
      const avecValeurs = url.searchParams.get("valeurs") === "1";
      if (avecValeurs && etatFaux.refuserExport) return json(403, { erreur: "Export des valeurs réelles désactivé." });
      return json(200, { dossier: id, entites: d ? [...d.entites.values()].map(e => (avecValeurs ? e : { marqueur: e.marqueur, type: e.type, occurrences: e.occurrences })) : [] });
    }
    return json(404, { erreur: "route inconnue" });
  });

  return {
    CLE, journal, dossiers, etatFaux,
    demarrer: () => new Promise(resolve => serveur.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${serveur.address().port}`))),
    arreter: () => new Promise(resolve => serveur.close(resolve)),
  };
}

module.exports = { creer, SENSIBLES };
