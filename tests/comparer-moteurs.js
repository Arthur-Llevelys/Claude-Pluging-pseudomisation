/*
 * Comparaison du moteur local (JavaScript, server/moteur) avec le moteur du serveur 1.1.0 (Python, serveur-ubuntu/app),
 * sur des textes entièrement fictifs : les deux doivent produire exactement le même texte pseudonymisé et les mêmes entités.
 * Les propositions de noms (normalement spaCy ou Ollama) sont fixées à l'avance et données aux deux moteurs.
 *
 *   node tests/comparer-moteurs.js        (nécessite l'environnement Python .venv-serveur)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Moteur, Stockage } = require("../server/moteur/moteur");
const D = require("../server/moteur/detect");

const RACINE = path.join(__dirname, "..");
const PY = path.join(RACINE, ".venv-serveur", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const T = f => fs.readFileSync(path.join(RACINE, f), "utf8");

// Propositions de noms fixées (comme le ferait le modèle de langue) : [texte exact, étiquette]
function propositions(texte, paires) {
  const out = [];
  for (const [nom, et] of paires) {
    let i = -1;
    while ((i = texte.indexOf(nom, i + 1)) >= 0) out.push([i, i + nom.length, et]);
  }
  return out;
}
const NOMS = [["Hélène Vasseur", "PER"], ["Vasseur", "PER"], ["Karim Benali", "PER"], ["Benali", "PER"], ["Odile Fontanel", "PER"],
  ["Lumicor", "ORG"], ["Grégoire Aubertin", "PER"], ["Altenor", "ORG"], ["Brivane Distribution", "ORG"], ["Josiane Morel", "PER"], ["Morel", "PER"],
  ["Les Amis du Vieux Quartier", "ORG"], ["France Travail", "ORG"], ["CPAM du Rhône", "ORG"], ["Cour de cassation", "ORG"], ["Objet", "ORG"],
  ["Montant", "PER"], ["Lyon", "PER"], ["Son IBAN", "PER"], ["Agence", "ORG"], ["Martin Bellecour", "PER"], ["Pierre Petit", "PER"],
  ["Sophie Martin", "PER"], ["Cass", "PER"], ["IV", "PER"], ["Bull", "ORG"], ["Banque de France", "ORG"], ["Président Directeur Général", "ORG"]];

const PHRASES = [
  "La société Brumeval Immobilier est immatriculée au RCS de Lyon sous le n° 352 332\n159, depuis 2019.",
  "Extrait : RCS Lyon B 352 332 159.", "SIRET : 732 829 320\r\n00074 (siège).", "Siren 352\n332 159.",
  "Société immatriculée au RCS de Lyon, au capital de 100 000 000 euros.",
  "Lot    Propriétaire    Solde\nS09 Dupont\nS10 Lefèvre\nS11 Cave\nA12 Parking\nLot 14 Marchetti\nS15\tDe Almeida\t92,00\nS16 Lyon\n\nDupont n'a pas réglé.",
  "Lot | Propriétaire | Solde\nS09 | Dupont | 92,00 €\nS10 | Lefèvre | 15,50 €\nS11 | Cave | 0,00 €\n",
  "Le siège est 110 Grande rue de la Guillotière, 69007 Lyon.", "Le lot se situe 16/18 rue Paul Verdier à Lyon.",
  "Immeuble sis 16-18 avenue des Acacias.", "Local situé 16 et 18 rue du Moulin.", "Elle habite 4 Petite rue des Lilas.",
  "Entrepôt : 25 Vieux chemin de Montribloud.", "Domicile : 3 rue du 8 Mai 1945, 69100 Villeurbanne.",
  "Lot 7 : 12 rue des Tanneurs 92,00 € restant dus.", "12 rue des Tanneurs – 92,00 €", "12 rue des Tanneurs 92.00 €",
  "Solde : 15 chemin du Lavoir 300 € au 3 mars.", "8 avenue des Acacias 1 250,50 euros.",
  "Loyer dû par la SARL Dupont Frères 1 250,00 € au titre du mois.", "Facture de la société Brumeval Immobilier 980,00 € TTC.",
  "Mme L. conteste la facture. En application de l'article L. 441-6 du code de commerce, de l'article R. 123-4 et des articles 1240 et 1241 du code civil (pourvoi n° 19-12.345, RG 23/01234, règlement (UE) 2016/679, loi n° 2016-1321, CELEX 32016R0679, L441-6), elle doit payer.",
  "Son IBAN est FR76 3000 6000 0112 3456 7890 189.", "Votre RIB : FR76 3000 6000 0112 3456 7890 189.",
  "La copropriété est représentée par l'Agence Martin Bellecour, syndic en exercice.",
  "La Banque de France a répondu.", "Rendez-vous à l'Hôtel de Ville.", "L'Agence Nationale a statué.", "Le Cabinet Durand & Associés plaide.",
  "Selon la Régie Lemoine, le bail court.", "Courrier des Établissements Ferrand Frères.", "M. Bureau a signé le bail.",
  "Madame Hélène Vasseur, née le 3 mars 1975 à Annecy, demeurant 14 rue des Tanneurs, 69005 Lyon, joignable à helene.vasseur@exemple-fictif.fr ou au 06 12 34 56 78, a saisi le conseil de prud'hommes contre la société BRUMEVAL SAS (SIREN 542 051 180).",
  "Né le 14/03/1978 à Villeurbanne (69), assuré social n° 2 78 03 69 266 084 17.", "TVA FR40 732829320 ; BP 1234 ; CS 70001.",
  "Facture de 123 456 789 euros, RG n° 23/01234, audience du 12/05/2025.", "Courrier de Jean-Pierre DUPONT à Mme Martin, puis DUPONT Jean-Pierre répond.",
  "La SCI Les Tilleuls et la société « Horizon Bâtiment » ; ALPHA CONSEIL SAS ; Beta Immobilier SARL.",
  "Maître Durand Avocat représente Monsieur le Président ; Dr Martin-Lefèvre.",
  "CONCLUSIONS POUR LA SAS ZORVAL ET MONSIEUR JEAN DUPONT",
];

const DOCS = [
  ...["serveur-ubuntu/tests/exemple.txt", "serveur-ubuntu/tests/exemple2.txt", "serveur-ubuntu/tests/exemple_lot1.txt", "serveur-ubuntu/tests/sans_donnees.txt",
    "prototype-autonome/exemple_noms.txt"].map(f => ({ nom: path.basename(f), texte: T(f) })),
  ...PHRASES.map((p, i) => ({ nom: `phrase ${i + 1}`, texte: p })),
];

async function main() {
  // Deux passages : règles seules, puis règles + propositions de noms fixées
  const cas = [];
  for (const d of DOCS) {
    cas.push({ nom: d.nom + " (règles seules)", texte: d.texte, candidats: [] });
    cas.push({ nom: d.nom + " (avec noms proposés)", texte: d.texte, candidats: propositions(d.texte, NOMS) });
  }
  // Suite de documents dans un même dossier : valeurs connues et propagation d'un document à l'autre
  const suite = ["Courrier de Jean-Pierre DUPONT et de la société Brumeval Immobilier.", "DUPONT relance Brumeval Immobilier.", "Dupont et Mme Martin."];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-comparaison-"));
  const entree = path.join(tmp, "entree.json"), sortie = path.join(tmp, "sortie.json");
  const pyDocs = cas.map(c => ({ nom: c.nom, texte: c.texte, candidats: c.candidats }));
  fs.writeFileSync(entree, JSON.stringify(pyDocs), "utf8");
  const r = spawnSync(PY, [path.join(RACINE, "prototype-autonome", "pont_moteur.py"), entree, sortie],
    { env: Object.assign({}, process.env, { PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", ANON_SPACY_MODEL: "aucun" }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const attendus = JSON.parse(fs.readFileSync(sortie, "utf8"));

  process.env.ANON_DPAPI = "0";
  const stockage = await new Stockage(path.join(tmp, "tables")).ouvrir();
  const moteur = new Moteur(stockage, D.chargerListes(null), null);
  let ecarts = 0;
  for (let i = 0; i < cas.length; i++) {
    moteur.ner = { modele: "fixe", candidats: async () => cas[i].candidats };
    const js = await moteur.anonymiser(cas[i].texte, `mesure-${i}`, {}, true);
    const py = attendus[i];
    const entJs = js.entites.map(e => [e.marqueur, e.valeur]), entPy = py.entites;
    if (js.texte !== py.texte || JSON.stringify(entJs) !== JSON.stringify(entPy)) {
      ecarts++;
      console.log(`ÉCART  ${cas[i].nom}`);
      console.log("  serveur :", JSON.stringify(py.texte).slice(0, 400));
      console.log("  local   :", JSON.stringify(js.texte).slice(0, 400));
      if (JSON.stringify(entJs) !== JSON.stringify(entPy)) console.log("  entités serveur :", JSON.stringify(entPy), "\n  entités local   :", JSON.stringify(entJs));
    }
  }
  // Suite de documents (même dossier) et ré-identification
  fs.writeFileSync(entree, JSON.stringify(suite.map(t => ({ nom: "suite", texte: t, candidats: [] }))), "utf8");
  const pySuite = [];
  {
    // Le pont donne un dossier par document : on reproduit la suite avec un seul dossier côté Python
    const script = path.join(tmp, "suite.py");
    fs.writeFileSync(script, `import json, sys, tempfile\nsys.path.insert(0, ${JSON.stringify(path.join(RACINE, "serveur-ubuntu"))})\n` +
      "from cryptography.fernet import Fernet\nfrom app import detect as D\nfrom app.engine import Moteur\nfrom app.store import Store\n" +
      "D.candidats_spacy = lambda t: []\nm = Moteur(Store(tempfile.mktemp(), Fernet.generate_key().decode()), D.Listes.charger(tempfile.mkdtemp()))\n" +
      `out = [m.anonymiser(t, 'suite')['texte'] for t in json.load(open(sys.argv[1], encoding='utf-8'))]\n` +
      "out.append(m.reidentifier('[PERSONNE_1] / [SOCIETE_1] / personne_2 / [PERSONNE_9]', 'suite'))\n" +
      "json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)\n", "utf8");
    const textes = path.join(tmp, "suite.json");
    fs.writeFileSync(textes, JSON.stringify(suite), "utf8");
    const r2 = spawnSync(PY, [script, textes, sortie], { env: Object.assign({}, process.env, { PYTHONUTF8: "1", ANON_SPACY_MODEL: "aucun" }), encoding: "utf8" });
    if (r2.status !== 0) throw new Error(r2.stderr);
    pySuite.push(...JSON.parse(fs.readFileSync(sortie, "utf8")));
  }
  moteur.ner = { modele: "fixe", candidats: async () => [] };
  const jsSuite = [];
  for (const t of suite) jsSuite.push((await moteur.anonymiser(t, "suite")).texte);
  jsSuite.push(moteur.reidentifier("[PERSONNE_1] / [SOCIETE_1] / personne_2 / [PERSONNE_9]", "suite"));
  const reidPy = pySuite.pop(), reidJs = jsSuite.pop();
  if (JSON.stringify(jsSuite) !== JSON.stringify(pySuite)) { ecarts++; console.log("ÉCART  suite de documents\n  serveur :", pySuite, "\n  local   :", jsSuite); }
  if (reidJs.texte !== reidPy.texte || JSON.stringify(reidJs.marqueurs_inconnus) !== JSON.stringify(reidPy.marqueurs_inconnus)) {
    ecarts++; console.log("ÉCART  ré-identification\n  serveur :", reidPy, "\n  local   :", reidJs);
  }
  // Corrections d'un dossier (lot 4) : mêmes opérations, mêmes résultats attendus des deux moteurs
  const OPS = [
    ["anonymiser", "Courrier de Jean-Pierre DUPONT. Signé : J.-P. Dupont-Martin. M. Bureau a signé. Réunion chez Brivane.", ["PERSONNE: J.-P. Dupont-Martin"]],
    ["corriger", "fusionner", ["[PERSONNE_1]", "PERSONNE_2"], null, null],
    ["corriger", "exclure", ["[PERSONNE_3]"], null, null],
    ["corriger", "exclure", ["[PERSONNE_9]"], null, null],
    ["corriger", "ajouter", null, "SOCIETE", "Brivane"],
    ["corriger", "ajouter", null, "SOCIETE", "Brivane"],
    ["corriger", "ajouter", null, "CHAT", "Minou"],
    ["anonymiser", "Relance à Jean-Pierre DUPONT, J.-P. Dupont-Martin, M. Bureau et BRIVANE.", []],
    ["reidentifier", "[PERSONNE_1] / [PERSONNE_2] / [PERSONNE_3] / [SOCIETE_1]"],
    ["corriger", "reinclure", ["[PERSONNE_3]"], null, null],
    ["anonymiser", "M. Bureau et Brivane.", []],
    ["corriger", "fusionner", ["[PERSONNE_1]"], null, null],
    ["entites"],
  ];
  const opsJson = path.join(tmp, "ops.json");
  fs.writeFileSync(opsJson, JSON.stringify(OPS), "utf8");
  const scriptOps = path.join(tmp, "ops.py");
  fs.writeFileSync(scriptOps, `import json, sys, tempfile\nsys.path.insert(0, ${JSON.stringify(path.join(RACINE, "serveur-ubuntu"))})\n` +
    "from cryptography.fernet import Fernet\nfrom app import detect as D\nfrom app.engine import Moteur\nfrom app.store import Store\n" +
    "m = Moteur(Store(tempfile.mktemp(), Fernet.generate_key().decode()), D.Listes.charger(tempfile.mkdtemp()))\nout = []\n" +
    "for op in json.load(open(sys.argv[1], encoding='utf-8')):\n" +
    "    try:\n" +
    "        if op[0] == 'anonymiser': out.append(m.anonymiser(op[1], 'corr', {'ner': False, 'termes': op[2]})['texte'])\n" +
    "        elif op[0] == 'corriger': out.append(m.corriger('corr', op[1], op[2], op[3], op[4]))\n" +
    "        elif op[0] == 'reidentifier': out.append(m.reidentifier(op[1], 'corr')['texte'])\n" +
    "        else: out.append([[e['marqueur'], e['type'], bool(e.get('exclu'))] for e in m.store.entites('corr', False)])\n" +
    "    except ValueError as e: out.append('ERREUR: ' + str(e))\n" +
    "json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)\n", "utf8");
  const r3 = spawnSync(PY, [scriptOps, opsJson, sortie], { env: Object.assign({}, process.env, { PYTHONUTF8: "1", ANON_SPACY_MODEL: "aucun" }), encoding: "utf8" });
  if (r3.status !== 0) throw new Error(r3.stderr);
  const pyOps = JSON.parse(fs.readFileSync(sortie, "utf8"));
  moteur.ner = null;
  const jsOps = [];
  for (const op of OPS) {
    try {
      if (op[0] === "anonymiser") jsOps.push((await moteur.anonymiser(op[1], "corr", { ner: false, termes: op[2] })).texte);
      else if (op[0] === "corriger") jsOps.push(moteur.corriger("corr", op[1], op[2], op[3], op[4]));
      else if (op[0] === "reidentifier") jsOps.push(moteur.reidentifier(op[1], "corr").texte);
      else jsOps.push(stockage.entites("corr", false).map(e => [e.marqueur, e.type, !!e.exclu]));
    } catch (e) { jsOps.push("ERREUR: " + e.message); }
  }
  if (process.env.AFFICHER) console.log(JSON.stringify(jsOps, null, 1));
  OPS.forEach((op, i) => {
    if (JSON.stringify(jsOps[i]) !== JSON.stringify(pyOps[i])) {
      ecarts++;
      console.log(`ÉCART  corrections, étape ${i + 1} (${op[0]} ${op[1] && op[0] === "corriger" ? op[1] : ""})\n  serveur : ${JSON.stringify(pyOps[i])}\n  local   : ${JSON.stringify(jsOps[i])}`);
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const total = cas.length + 2 + OPS.length;
  console.log(`\n${total - ecarts}/${total} cas identiques (${DOCS.length} textes, règles seules et avec noms proposés, suite de documents, ré-identification).`);
  process.exit(ecarts ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
