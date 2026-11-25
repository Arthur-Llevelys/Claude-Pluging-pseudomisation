/*
 * Mesure du prototype : reconnaissance des noms par spaCy (serveur actuel) ou par un petit modèle Ollama,
 * combinée aux mêmes règles (moteur du serveur 1.1.0), sur des exemples entièrement fictifs.
 *
 *   node prototype-autonome/mesurer.js <adresse Ollama> <modèle> [<modèle>…]
 *   ex. : node prototype-autonome/mesurer.js http://127.0.0.1:11434 ministral-3:3b
 *
 * Pour chaque configuration : fuites (données à masquer restées visibles), masquages à tort
 * (éléments à conserver disparus), durée.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { candidatsOllama } = require("./ner-ollama");

const ICI = __dirname;
const TESTS = path.join(ICI, "..", "serveur-ubuntu", "tests");
const PY = path.join(ICI, "..", ".venv-serveur", "Scripts", "python.exe");

const DOCS = [
  {
    nom: "exemple", fichier: path.join(TESTS, "exemple.txt"),
    masquer: ["ALPHA CONSEIL", "12 bis rue Victor Hugo", "732 829 320 00074", "FR40 732829320", "Jean-Pierre DUPONT", "Sophie Martin",
      "14/03/1978", "Villeurbanne", "45 avenue des Frères Lumière", "2 78 03 69 266 084 17", "06 12 34 56 78", "sophie.martin@exemple.fr",
      "FR76 3000 6000 0112 3456 7890 189", "Beta Immobilier", "Claire Lefèvre", "Dupont"],
    garder: ["Cour de cassation", "Code de commerce", "L. 145-9", "22-19.123", "3 mars 2025", "10 000 euros", "Barreau de Lyon", "SAS au capital", "Monsieur", "Madame", "SARL"],
  },
  {
    nom: "exemple2", fichier: path.join(TESTS, "exemple2.txt"),
    masquer: ["Paul Durand-Leroy", "Durand-Leroy Paul", "Horizon Bâtiment", "552 100 554", "Lefèvre", "Pierre Petit", "Sophie Martin", "Jean-Pierre DUPONT", "2 juin 1965", "06 00 00 00 01"],
    garder: ["Tribunal de commerce de Lyon", "Cour d'appel de Lyon", "Conseil d'État", "123 456 789 euros", "article 700", "petit immeuble", "petit commerçant", "Monsieur le Président", "URSSAF"],
  },
  {
    nom: "lot1", fichier: path.join(TESTS, "exemple_lot1.txt"),
    masquer: ["352 332", "Dupont", "Lefèvre", "Grande rue de la Guillotière", "rue Paul Verdier", "12 rue des Tanneurs", "Martin Bellecour", "FR76 3000", "Brumeval"],
    garder: ["– 92,00 €", "1 250,50 €", "10 000 euros", "L. 441-6", "R. 123-4", "19-12.345", "32016R0679", "Fait à Lyon", "Créance impayée", "conteste le Montant",
      "LRAR", "Objet :", "Subject:", "Son IBAN est", "S11 Cave", "Cour de cassation", "3 mars 2025"],
  },
  {
    nom: "noms", fichier: path.join(ICI, "exemple_noms.txt"),
    masquer: ["Hélène Vasseur", "Vasseur", "Karim Benali", "Benali", "Odile Fontanel", "Lumicor", "Grégoire Aubertin", "Altenor", "Brivane", "Amis du Vieux Quartier", "Josiane Morel", "Morel"],
    garder: ["France Travail", "CPAM du Rhône", "Code du travail", "L. 1235-3", "Cour de cassation", "conseil de prud'hommes de Lyon", "8 450 €", "Objet : relance",
      "14 octobre 2025", "Prochaine étape", "Présents", "30 juin 2026"],
  },
  { nom: "sans_donnees", fichier: path.join(TESTS, "sans_donnees.txt"), masquer: [], garder: [], zero: true },
];

function pont(docs, avecSpacy) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-mesure-"));
  const entree = path.join(tmp, "entree.json"), sortie = path.join(tmp, "sortie.json");
  fs.writeFileSync(entree, JSON.stringify(docs), "utf8");
  const env = Object.assign({}, process.env, { PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", ANON_SPACY_MODEL: avecSpacy ? "fr_core_news_lg" : "aucun" });
  const debut = Date.now();
  const r = spawnSync(PY, [path.join(ICI, "pont_moteur.py"), entree, sortie], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error("pont Python : " + (r.stderr || "").slice(-800));
  const res = JSON.parse(fs.readFileSync(sortie, "utf8"));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { res, duree: Date.now() - debut };
}

function evaluer(doc, sortie) {
  const fuites = doc.masquer.filter(m => sortie.texte.includes(m));
  const atort = doc.garder.filter(g => !sortie.texte.includes(g));
  if (doc.zero && sortie.entites.length) atort.push(...sortie.entites.map(([m, v]) => `${m}=${JSON.stringify(v)}`));
  return { fuites, atort };
}

function rapport(titre, docs, resultats, dureeNer) {
  let F = 0, A = 0;
  const lignes = [];
  docs.forEach((d, i) => {
    const { fuites, atort } = evaluer(d, resultats[i]);
    F += fuites.length; A += atort.length;
    lignes.push(`   ${d.nom.padEnd(13)} fuites ${String(fuites.length).padStart(2)}${fuites.length ? " " + JSON.stringify(fuites) : ""}` +
      ` | masqués à tort ${String(atort.length).padStart(2)}${atort.length ? " " + JSON.stringify(atort) : ""}`);
  });
  console.log(`\n== ${titre} : ${F} fuite(s), ${A} masquage(s) à tort` + (dureeNer !== undefined ? ` — reconnaissance des noms : ${(dureeNer / 1000).toFixed(1)} s` : ""));
  for (const l of lignes) console.log(l);
  return { F, A };
}

async function main() {
  const [url, ...modeles] = process.argv.slice(2);
  const docs = DOCS.map(d => Object.assign({}, d, { texte: fs.readFileSync(d.fichier, "utf8") }));
  const total = docs.reduce((n, d) => n + d.masquer.length, 0), totalG = docs.reduce((n, d) => n + d.garder.length, 0);
  console.log(`${docs.length} documents fictifs, ${total} données à masquer, ${totalG} éléments à conserver (+ un texte sans donnée personnelle).`);

  const regles = pont(docs.map(d => ({ nom: d.nom, texte: d.texte, candidats: [] })), false);
  rapport("Règles seules (aucune reconnaissance de noms)", docs, regles.res);
  const spacy = pont(docs.map(d => ({ nom: d.nom, texte: d.texte, candidats: null })), true);
  rapport(`Règles + spaCy fr_core_news_lg (serveur actuel)${spacy.res[0].spacy ? "" : " — ⚠ spaCy INACTIF"}`, docs, spacy.res);

  for (const modele of modeles) {
    const cands = [];
    let duree = 0, proposes = 0, inventes = 0;
    try {
      // Premier appel « à blanc » : chargement du modèle en mémoire, non compté
      await candidatsOllama("Bonjour.", { url, modele, delaiMs: 300000 });
      for (const d of docs) {
        const r = await candidatsOllama(d.texte, { url, modele });
        cands.push(r.candidats); duree += r.stats.duree_ms; proposes += r.stats.proposes; inventes += r.stats.inventes;
      }
    } catch (e) {
      console.log(`\n== ${modele} : ÉCHEC — ${e.message}`);
      continue;
    }
    const res = pont(docs.map((d, i) => ({ nom: d.nom, texte: d.texte, candidats: cands[i] })), false);
    rapport(`Règles + ${modele} via Ollama (${proposes} noms proposés, ${inventes} écartés car absents du texte)`, docs, res.res, duree);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
