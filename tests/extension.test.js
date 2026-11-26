/*
 * Tests automatiques de l'extension Anonymiseur (cabinet) v1.1.0.
 * Lancement : node --test tests/
 * Tout se passe dans un dossier temporaire, avec un faux serveur d'anonymisation et des données fictives.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { creer: creerFauxServeur } = require("./faux-serveur");
process.env.ANON_MODE_TEST = "1"; // charge les fonctions internes sans démarrer le serveur dans ce processus
const ext = require("../server/index.js");
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

const SCRIPT = path.join(__dirname, "..", "server", "index.js");
const REELS = ["Dupont", "Martin", "ZORVAL", "jean.dupont", "rue de la Paix"]; // ne doivent jamais apparaître côté Claude

// --------------------------------------------------------------------------- client MCP minimal
class Client {
  constructor(env, { racines } = {}) {
    this.racines = racines || null;
    this.suivant = 1;
    this.attentes = new Map();
    this.tampon = "";
    this.sorties = []; // tout ce que « Claude » a reçu
    const envEnfant = Object.assign({}, process.env, env);
    delete envEnfant.ANON_MODE_TEST;
    this.proc = spawn(process.execPath, [SCRIPT], { env: envEnfant, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", d => {
      this.tampon += d;
      let i;
      while ((i = this.tampon.indexOf("\n")) >= 0) {
        const ligne = this.tampon.slice(0, i).trim();
        this.tampon = this.tampon.slice(i + 1);
        if (!ligne) continue;
        const msg = JSON.parse(ligne);
        if (msg.method === "roots/list") {
          this.envoyer({ jsonrpc: "2.0", id: msg.id, result: { roots: (this.racines || []).map(p => ({ uri: require("url").pathToFileURL(p).href, name: "session" })) } });
        } else if (msg.id !== undefined && this.attentes.has(msg.id)) {
          this.attentes.get(msg.id)(msg);
          this.attentes.delete(msg.id);
        }
      }
    });
    this.proc.stderr.on("data", () => {});
  }
  envoyer(msg) { this.proc.stdin.write(JSON.stringify(msg) + "\n"); }
  requete(method, params) {
    const id = this.suivant++;
    return new Promise(resolve => { this.attentes.set(id, resolve); this.envoyer({ jsonrpc: "2.0", id, method, params }); });
  }
  async init() {
    const r = await this.requete("initialize", { protocolVersion: "2025-06-18", capabilities: this.racines ? { roots: { listChanged: true } } : {}, clientInfo: { name: "test", version: "0" } });
    this.envoyer({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise(r2 => setTimeout(r2, 150));
    return r.result;
  }
  async outil(name, args) {
    const r = await this.requete("tools/call", { name, arguments: args || {} });
    const texte = r.result.content[0].text;
    this.sorties.push(texte);
    return { texte, erreur: !!r.result.isError };
  }
  fermer() { this.proc.stdin.end(); this.proc.kill(); }
}

// --------------------------------------------------------------------------- jeu d'essai
function preparer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-test-"));
  const racine = path.join(tmp, "CABINET");
  const affaire = path.join(racine, "03 - Dossiers", "Dupont c. ZORVAL");
  const autreAffaire = path.join(racine, "03 - Dossiers", "Martin - licenciement");
  const sortie = path.join(racine, "10 - IA", "_Restitution");
  const dehors = path.join(tmp, "Hors cabinet", "Dossier Martin");
  for (const d of [path.join(affaire, "Pièces"), autreAffaire, sortie, dehors]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(affaire, "Note Dupont.txt"), "Jean Dupont (jean.dupont@exemple.fr) assigne ZORVAL.", "utf8");
  fs.writeFileSync(path.join(affaire, "Pièces", "Contrat ZORVAL.md"), "# Contrat\nEntre ZORVAL & Fils et Jean Dupont, 12 rue de la Paix\n75002 Paris.", "utf8");
  fs.writeFileSync(path.join(affaire, "tableau.xlsx"), "binaire", "utf8");
  fs.writeFileSync(path.join(autreAffaire, "Lettre Martin.txt"), "Marie Martin conteste son licenciement.", "utf8");
  fs.writeFileSync(path.join(dehors, "Courrier Martin.txt"), "Marie Martin écrit à ZORVAL.", "utf8");
  fs.writeFileSync(path.join(racine, "Modele courrier.txt"), "Modèle sans donnée.", "utf8");
  const selection = path.join(tmp, "selection.txt");
  const telechargements = path.join(tmp, "Téléchargements");
  fs.mkdirSync(telechargements);
  return {
    tmp, racine, affaire, autreAffaire, sortie, dehors, selection, telechargements, etat: path.join(tmp, "etat", "etat.json"),
    saisie: path.join(tmp, "saisie.txt"), fichiers: path.join(tmp, "fichiers.txt"), pressePapiers: path.join(tmp, "presse-papiers.txt"),
    journal: path.join(tmp, "etat", "journal.log"),
  };
}

async function contexte(t, options = {}) {
  const j = preparer();
  const faux = creerFauxServeur();
  const url = await faux.demarrer();
  const env = Object.assign({
    ANON_SERVEUR: url, ANON_CLE: faux.CLE, ANON_DOSSIER_TRAVAIL: j.racine, ANON_DOSSIER_SORTIE: j.sortie,
    ANON_DOSSIER_DEFAUT: "general", ANON_ETAT: j.etat, ANON_SELECTEUR_SIMULE: j.selection, ANON_ATTENTE_SELECTION_MS: "3000",
    ANON_SAISIE_SIMULEE: j.saisie, ANON_SELECTEUR_FICHIERS_SIMULE: j.fichiers, ANON_PRESSE_PAPIERS_SIMULE: j.pressePapiers,
    ANON_TELECHARGEMENTS: j.telechargements, ANON_JOURNAL: j.journal,
  }, options.env || {});
  const client = new Client(env, { racines: options.racines ? options.racines(j) : null });
  t.after(async () => { client.fermer(); await faux.arreter(); fs.rmSync(j.tmp, { recursive: true, force: true }); });
  const init = await client.init();
  return { j, faux, client, init, env };
}

function aucuneFuite(client, j) {
  for (const s of client.sorties) {
    for (const mot of REELS) assert.ok(!s.includes(mot), `donnée réelle « ${mot} » visible dans une réponse : ${s.slice(0, 200)}`);
    assert.ok(!s.includes(j.tmp), "chemin réel visible dans une réponse");
  }
}

// --------------------------------------------------------------------------- tests
test("initialisation : version du manifeste et quinze outils, identiques à ceux du manifeste", async t => {
  const { client, init } = await contexte(t);
  assert.equal(init.serverInfo.version, MANIFESTE.version);
  assert.equal(ext.VERSION, MANIFESTE.version);
  assert.match(init.instructions, /choisir_dossier/);
  assert.match(init.instructions, /importer_presse_papiers/);
  const liste = await client.requete("tools/list", {});
  const noms = liste.result.tools.map(o => o.name).sort();
  assert.deepEqual(noms,
    ["choisir_dossier", "corriger_entite", "creer_dossier_affaire", "enregistrer_document", "enregistrer_fichier", "entites_du_dossier", "etat_anonymiseur",
      "importer_courriel", "importer_fichiers", "importer_presse_papiers", "lire_fichier_anonymise", "lister_fichiers", "lister_modeles", "reidentifier_fichier",
      "reidentifier_vers_presse_papiers"]);
  assert.deepEqual(MANIFESTE.tools.map(o => o.name).sort(), noms);
});

test("sans dossier courant : comportement d'origine (racine) et invitation à choisir", async t => {
  const { client, j } = await contexte(t);
  const r = await client.outil("lister_fichiers");
  assert.match(r.texte, /Aucun dossier courant/);
  assert.match(r.texte, /choisir_dossier/);
  assert.match(r.texte, /1 document/); // non récursif à la racine : seul le modèle
  const e = await client.outil("enregistrer_document", { texte: "Bonjour", nom_fichier: "essai", format: "txt" });
  assert.match(e.texte, /dossier de sortie configuré/);
  assert.ok(fs.existsSync(path.join(j.sortie, "essai.txt")));
});

test("travail sur place : choisir, lister, lire, enregistrer dans le dossier d'origine", async t => {
  const { client, j, faux } = await contexte(t);
  fs.writeFileSync(j.selection, j.affaire, "utf8"); // l'utilisateur « désigne » le dossier dans la fenêtre
  const choix = await client.outil("choisir_dossier");
  assert.equal(choix.erreur, false);
  assert.match(choix.texte, /désigné par l'utilisateur dans la fenêtre de sélection/);
  const ref = /Référence d'anonymisation de cette affaire : (D-[0-9a-f]{8})/.exec(choix.texte)[1];
  assert.match(choix.texte, /2 document\(s\)/);
  assert.match(choix.texte, /\.xlsx ×1/);

  const liste = await client.outil("lister_fichiers");
  assert.match(liste.texte, /lecture sur place, sans copie/);
  assert.match(liste.texte, /F1 · /);
  assert.match(liste.texte, /F2 · /);
  assert.ok(liste.texte.includes(ref));

  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "F1" });
  assert.match(lecture.texte, /\[PERSONNE_\d\]/);
  assert.match(lecture.texte, /\[SOCIETE_\d\]/);
  assert.ok(faux.journal.some(a => a.route === "anonymiser-fichier" && a.dossier === ref), "la référence du dossier est appliquée automatiquement");
  // Marqueurs attribués par le faux serveur (le nom du dossier a été pseudonymisé en premier)
  const marqueur = valeur => faux.dossiers.get(ref).entites.get(valeur).marqueur;
  const P = marqueur("Jean Dupont"), S = marqueur("ZORVAL");

  const enr = await client.outil("enregistrer_document", { texte: `Cher ${P}, ${S} vous répond.`, nom_fichier: "projet-courrier" });
  assert.match(enr.texte, /dans le dossier courant \(le dossier d'origine des pièces\)/);
  const produit = path.join(j.affaire, "projet-courrier.docx");
  assert.ok(fs.existsSync(produit), "le livrable est écrit dans le dossier de l'affaire, pas ailleurs");
  const contenu = fs.readFileSync(produit, "utf8");
  assert.match(contenu, /Cher Jean Dupont, ZORVAL vous répond\./);
  assert.equal(fs.readdirSync(j.sortie).length, 0, "rien dans l'ancien dossier de sortie");

  // même nom : pas d'écrasement
  await client.outil("enregistrer_document", { texte: `Version 2 ${P}`, nom_fichier: "projet-courrier" });
  assert.ok(fs.existsSync(path.join(j.affaire, "projet-courrier (2).docx")));

  // sous-dossier créé à la demande, et sortie forcée vers l'ancien dossier
  await client.outil("enregistrer_document", { texte: `x ${P}`, nom_fichier: "note", format: "md", sous_dossier: "Projets IA" });
  assert.ok(fs.existsSync(path.join(j.affaire, "Projets IA", "note.md")));
  await client.outil("enregistrer_document", { texte: `x ${P}`, nom_fichier: "note", format: "md", emplacement: "dossier_sortie" });
  assert.ok(fs.existsSync(path.join(j.sortie, "note.md")));

  const etat = await client.outil("etat_anonymiseur");
  assert.match(etat.texte, /Dossier courant : « /);
  assert.match(etat.texte, /R1 · /);
  aucuneFuite(client, j);
});

test("sécurité : sorties de dossier refusées, chemins hors emplacements autorisés refusés", async t => {
  const { client, j } = await contexte(t);
  await client.outil("choisir_dossier", { chemin: "03 - Dossiers/Dupont c. ZORVAL" });
  const a = await client.outil("enregistrer_document", { texte: "x", nom_fichier: "n", format: "txt", sous_dossier: "..\\..\\ailleurs" });
  assert.equal(a.erreur, true);
  const b = await client.outil("lister_fichiers", { sous_dossier: "..\\Martin - licenciement" });
  assert.equal(b.erreur, true);
  const c = await client.outil("lire_fichier_anonymise", { fichier: path.join(j.dehors, "Courrier Martin.txt") });
  assert.equal(c.erreur, true);
  const d = await client.outil("choisir_dossier", { chemin: j.dehors });
  assert.equal(d.erreur, true);
  assert.match(d.texte, /hors des emplacements autorisés/);
  const e = await client.outil("choisir_dossier", { chemin: os.homedir() });
  assert.equal(e.erreur, true);
  // un fichier de la racine reste lisible par chemin relatif (comportement d'origine)
  const f = await client.outil("lire_fichier_anonymise", { fichier: "Modele courrier.txt" });
  assert.equal(f.erreur, false);
  aucuneFuite(client, j);
});

test("fenêtre de sélection : dossier hors racine autorisé par le geste de l'utilisateur, annulation, récents", async t => {
  const { client, j } = await contexte(t);
  fs.writeFileSync(j.selection, "ANNULE", "utf8");
  const annule = await client.outil("choisir_dossier");
  assert.match(annule.texte, /sans choisir de dossier/);

  fs.writeFileSync(j.selection, j.dehors, "utf8");
  const dehors = await client.outil("choisir_dossier", { changer: true });
  assert.equal(dehors.erreur, false);
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Courrier Martin.txt" });
  assert.match(lecture.texte, /\[PERSONNE_\d\] écrit à \[SOCIETE_\d\]/);

  fs.writeFileSync(j.selection, j.affaire, "utf8");
  await client.outil("choisir_dossier", { changer: true });
  const etat = await client.outil("etat_anonymiseur");
  assert.match(etat.texte, /R1 · .*R2 · /);
  const retour = await client.outil("choisir_dossier", { recent: "R2" });
  assert.match(retour.texte, /repris des dossiers récents/);
  const liste = await client.outil("lister_fichiers");
  assert.match(liste.texte, /1 document/);
  // le dossier désigné une fois dans la fenêtre peut ensuite être repris par son chemin
  const parChemin = await client.outil("choisir_dossier", { chemin: j.dehors });
  assert.equal(parChemin.erreur, false);
  aucuneFuite(client, j);
});

test("fenêtre de sélection lente : la main est rendue, puis le choix est pris en compte", async t => {
  const { client, j } = await contexte(t, { env: { ANON_SELECTEUR_DELAI_MS: "1200", ANON_ATTENTE_SELECTION_MS: "300" } });
  fs.writeFileSync(j.selection, j.affaire, "utf8");
  const attente = await client.outil("choisir_dossier");
  assert.match(attente.texte, /n'a pas encore choisi/);
  const tropTot = await client.outil("lister_fichiers");
  assert.equal(tropTot.erreur, true);
  assert.match(tropTot.texte, /encore ouverte/);
  await new Promise(r => setTimeout(r, 1300));
  const liste = await client.outil("lister_fichiers");
  assert.equal(liste.erreur, false);
  assert.match(liste.texte, /2 document/);
  // un nouvel appel sans argument juste après ne rouvre pas de fenêtre : il rend le résultat du choix
  const rappel = await client.outil("choisir_dossier");
  assert.match(rappel.texte, /Dossier courant défini/);
});

test("le dossier courant survit au redémarrage, puis expire", async t => {
  const { client, j, env } = await contexte(t);
  await client.outil("choisir_dossier", { chemin: j.affaire });
  client.fermer();
  const c2 = new Client(env);
  t.after(() => c2.fermer());
  await c2.init();
  const liste = await c2.outil("lister_fichiers");
  assert.match(liste.texte, /Dossier courant/);
  assert.match(liste.texte, /2 document/);
  c2.fermer();
  // choix vieux de 8 jours (mémoire par défaut : 7 jours) : oublié
  const etat = JSON.parse(fs.readFileSync(j.etat, "utf8"));
  etat.courant.utilise_le = etat.courant.choisi_le = Date.now() - 8 * 24 * 3600 * 1000;
  fs.writeFileSync(j.etat, JSON.stringify(etat), "utf8");
  const c3 = new Client(env);
  t.after(() => c3.fermer());
  await c3.init();
  const apres = await c3.outil("lister_fichiers");
  assert.match(apres.texte, /Aucun dossier courant/);
});

test("session rattachée à un dossier : pris automatiquement comme dossier courant", async t => {
  const { client, j } = await contexte(t, { racines: jeu => [jeu.autreAffaire] });
  const liste = await client.outil("lister_fichiers");
  assert.match(liste.texte, /Dossier courant/);
  assert.match(liste.texte, /1 document/);
  const enr = await client.outil("enregistrer_document", { texte: "Réponse à [PERSONNE_1]", nom_fichier: "reponse", format: "txt" });
  assert.match(enr.texte, /dossier courant/);
  assert.ok(fs.existsSync(path.join(j.autreAffaire, "reponse.txt")));
  aucuneFuite(client, j);
});

test("reidentifier_fichier : Word avec marqueur découpé, texte, RTF ; rien sans marqueur", async t => {
  const { client, j, faux } = await contexte(t);
  const choix = await client.outil("choisir_dossier", { chemin: j.affaire });
  const ref = /(D-[0-9a-f]{8})/.exec(choix.texte)[1];
  await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  await client.outil("lire_fichier_anonymise", { fichier: "Pièces/Contrat ZORVAL.md" });
  // Marqueurs attribués par le faux serveur
  const marqueur = valeur => faux.dossiers.get(ref).entites.get(valeur).marqueur;
  const P = marqueur("Jean Dupont"), S = marqueur("ZORVAL & Fils"), A = marqueur("12 rue de la Paix\n75002 Paris"), E = marqueur("jean.dupont@exemple.fr");
  const sDecoupe = S.slice(1, -1);                       // SOCIETE_n, entre deux morceaux « [ » et « ] » comme le fait Word
  const pEspace = P.replace(/_(\d+)\]$/, " $1]");        // variante [PERSONNE n]
  const pMarkdown = P.replace(/_(\d+)\]$/, "\\_$1]");    // variante [PERSONNE\_n]

  // Un docx « créé par Claude » dans un autre dossier du poste, avec des marqueurs
  const travail = path.join(j.tmp, "sorties-claude");
  fs.mkdirSync(travail);
  const documentXml = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Cher ${P},</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">La société </w:t></w:r><w:r><w:t>[</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>${sDecoupe}</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:t>] vous écrit au ${A}.</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Inconnu : [PERSONNE_99] ; hors type : [ANNEXE_3] ; variante : ${pEspace}</w:t></w:r></w:p>` +
    "</w:body></w:document>";
  const zip = ext.ecrireZip([
    ext.creerEntree("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    ext.creerEntree("word/document.xml", documentXml),
    ext.creerEntree("word/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
  ]);
  const source = path.join(travail, "courrier.docx");
  fs.writeFileSync(source, zip);

  const r = await client.outil("reidentifier_fichier", { fichier: source });
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /4 marqueur\(s\) remplacé\(s\)/);
  assert.match(r.texte, /\[PERSONNE_99\]/);
  assert.ok(!r.texte.includes("[ANNEXE_3]"), "un crochet qui n'est pas un marqueur n'est pas signalé");
  const produit = path.join(j.affaire, "courrier.docx");
  assert.ok(fs.existsSync(produit));
  const entrees = ext.lireZip(fs.readFileSync(produit));
  assert.deepEqual(entrees.map(e => e.nom), ["[Content_Types].xml", "word/document.xml", "word/media/image1.png"]);
  const xml = ext.contenuEntree(entrees[1]).toString("utf8");
  assert.match(xml, /Cher Jean Dupont,/);
  assert.match(xml, /ZORVAL &amp; Fils/);                       // valeur échappée pour XML
  // Adresse sur deux lignes : vrai retour à la ligne Word (depuis la 1.3.0)
  assert.match(xml, /12 rue de la Paix<\/w:t><w:br\/><w:t xml:space="preserve">75002 Paris/);
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr>/);                 // mise en forme intacte
  assert.match(xml, /\[PERSONNE_99\]/);                          // inconnu laissé tel quel
  assert.match(xml, /\[ANNEXE_3\]/);
  assert.match(xml, /variante : Jean Dupont/);
  assert.ok(!xml.includes(sDecoupe), "le marqueur découpé en trois morceaux est bien remplacé");
  assert.deepEqual([...ext.contenuEntree(entrees[2])], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // image intacte
  assert.ok(fs.existsSync(source), "le fichier source n'est pas supprimé");

  // Texte et RTF
  fs.writeFileSync(path.join(travail, "note.md"), `Pour ${pMarkdown} (${E}).`, "utf8");
  await client.outil("reidentifier_fichier", { fichier: path.join(travail, "note.md"), sous_dossier: "Projets" });
  assert.equal(fs.readFileSync(path.join(j.affaire, "Projets", "note.md"), "utf8"), "Pour Jean Dupont (jean.dupont@exemple.fr).");
  fs.writeFileSync(path.join(travail, "lettre.rtf"), `{\\rtf1 Adresse : ${A}}`, "latin1");
  await client.outil("reidentifier_fichier", { fichier: path.join(travail, "lettre.rtf") });
  assert.equal(fs.readFileSync(path.join(j.affaire, "lettre.rtf"), "latin1"), "{\\rtf1 Adresse : 12 rue de la Paix\\line 75002 Paris}");

  // Source dans le dossier courant : le produit porte un nom distinct
  fs.writeFileSync(path.join(j.affaire, "brouillon.txt"), `À ${P}`, "utf8");
  const meme = await client.outil("reidentifier_fichier", { fichier: "brouillon.txt" });
  assert.match(meme.texte, /brouillon \(ré-identifié\)\.txt/);

  // Aucun marqueur : rien n'est copié ; PDF refusé
  fs.writeFileSync(path.join(travail, "vide.txt"), "Aucun marqueur ici.", "utf8");
  const vide = await client.outil("reidentifier_fichier", { fichier: path.join(travail, "vide.txt") });
  assert.match(vide.texte, /rien n'a été enregistré/);
  assert.ok(!fs.existsSync(path.join(j.affaire, "vide.txt")));
  fs.writeFileSync(path.join(travail, "x.pdf"), "%PDF", "utf8");
  const pdf = await client.outil("reidentifier_fichier", { fichier: path.join(travail, "x.pdf") });
  assert.equal(pdf.erreur, true);
  aucuneFuite(client, j);
});

test("reidentifier_fichier : méthode de secours si le serveur altère les repères", async t => {
  const { client, j, faux } = await contexte(t);
  const choix = await client.outil("choisir_dossier", { chemin: j.affaire });
  const ref = /(D-[0-9a-f]{8})/.exec(choix.texte)[1];
  await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  const P = faux.dossiers.get(ref).entites.get("Jean Dupont").marqueur;
  faux.etatFaux.altererReperes = true;
  const travail = path.join(j.tmp, "sorties-claude");
  fs.mkdirSync(travail);
  fs.writeFileSync(path.join(travail, "mot.txt"), `Bonjour ${P}, et [PERSONNE_99].`, "utf8");
  const r = await client.outil("reidentifier_fichier", { fichier: path.join(travail, "mot.txt") });
  assert.equal(r.erreur, false, r.texte);
  assert.equal(fs.readFileSync(path.join(j.affaire, "mot.txt"), "utf8"), "Bonjour Jean Dupont, et [PERSONNE_99].");
  assert.match(r.texte, /\[PERSONNE_99\]/);
  aucuneFuite(client, j);
});

test("référence d'anonymisation : propre à chaque dossier, stable, neutre", async t => {
  const { client, j, faux } = await contexte(t);
  const a = await client.outil("choisir_dossier", { chemin: j.affaire });
  const refA = /(D-[0-9a-f]{8})/.exec(a.texte)[1];
  const b = await client.outil("choisir_dossier", { chemin: j.autreAffaire });
  const refB = /(D-[0-9a-f]{8})/.exec(b.texte)[1];
  assert.notEqual(refA, refB);
  const a2 = await client.outil("choisir_dossier", { chemin: j.affaire });
  assert.equal(/(D-[0-9a-f]{8})/.exec(a2.texte)[1], refA);
  await client.outil("lire_fichier_anonymise", { fichier: "F1", dossier: "D-2026-042" }).catch(() => {});
  const explicite = await client.outil("lister_fichiers", { dossier: "D-2026-042" });
  assert.match(explicite.texte, /D-2026-042/); // un paramètre explicite reste prioritaire
  assert.ok(faux.journal.some(x => x.dossier === "D-2026-042"));
  const ent = await client.outil("entites_du_dossier");
  assert.ok(ent.texte.includes(refA));
});

test("démarrage : répond aussi lorsqu'il est chargé par un lanceur, comme le fait Claude Desktop", async () => {
  // Claude Desktop (Node intégré) ne lance pas le fichier directement : il le charge depuis son propre lanceur.
  // La version 1.1.0 ne démarrait pas dans ce cas et ne répondait jamais à « initialize ».
  const lanceurs = [
    ["-e", `require(${JSON.stringify(SCRIPT)})`],
    ["--input-type=module", "-e", `await import(${JSON.stringify(require("url").pathToFileURL(SCRIPT).href)})`],
  ];
  for (const args of lanceurs) {
    const env = Object.assign({}, process.env, { ANON_ETAT: path.join(os.tmpdir(), "anon-test-lanceur-etat.json") });
    delete env.ANON_MODE_TEST;
    const proc = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const reponse = await new Promise(resolve => {
      let tampon = "";
      const minuterie = setTimeout(() => resolve(null), 5000);
      proc.stdout.on("data", d => {
        tampon += d;
        if (tampon.includes("\n")) { clearTimeout(minuterie); resolve(JSON.parse(tampon.split("\n")[0])); }
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lanceur", version: "0" } } }) + "\n");
    });
    proc.kill();
    assert.ok(reponse, `aucune réponse à initialize avec le lanceur : ${args[0]}`);
    assert.equal(reponse.result.serverInfo.version, MANIFESTE.version);
  }
});

// --------------------------------------------------------------------------- lot 2 (version 1.2.0)
test("creer_dossier_affaire : références neutres incrémentées, libellé saisi localement, jamais renvoyé", async t => {
  const { client, j, faux } = await contexte(t, { env: { ANON_SOUS_DOSSIER_AFFAIRES: "03 - Dossiers" } });
  const parent = path.join(j.racine, "03 - Dossiers");
  const jour = new Date();
  const prefixe = `${jour.getFullYear()}-${String(jour.getMonth() + 1).padStart(2, "0")}-${String(jour.getDate()).padStart(2, "0")}`;

  const a = await client.outil("creer_dossier_affaire");
  assert.equal(a.erreur, false, a.texte);
  assert.ok(a.texte.includes(`Référence neutre : ${prefixe}-01.`));
  const refA = /Référence d'anonymisation : (D-[0-9a-f]{8})/.exec(a.texte)[1];
  assert.ok(fs.existsSync(path.join(parent, `${prefixe}-01`, ext.FICHIER_AFFAIRE)), "dossier et fiche cachée créés sous le sous-dossier des affaires");
  assert.ok(faux.dossiers.has(refA), "table de correspondance ouverte sur le serveur");
  const etatA = await client.outil("etat_anonymiseur");
  assert.ok(etatA.texte.includes(`« ${prefixe}-01 » — référence d'anonymisation ${refA}`), "devient le dossier courant");

  // Libellé réel tapé dans la fenêtre locale
  fs.writeFileSync(j.saisie, "Dupont c. ZORVAL", "utf8");
  const b = await client.outil("creer_dossier_affaire", { saisir_libelle: true });
  assert.equal(b.erreur, false, b.texte);
  assert.ok(b.texte.includes(`${prefixe}-02`));
  assert.match(b.texte, /Libellé réel saisi par l'utilisateur/);
  const dossierB = path.join(parent, `${prefixe}-02 - Dupont c. ZORVAL`);
  assert.ok(fs.existsSync(dossierB), "libellé ajouté au nom du dossier sur le poste");
  const refB = /Référence d'anonymisation : (D-[0-9a-f]{8})/.exec(b.texte)[1];
  assert.notEqual(refA, refB);

  // Repris plus tard par la fenêtre : même référence, nom affiché = référence neutre
  fs.writeFileSync(j.selection, dossierB, "utf8");
  const reprise = await client.outil("choisir_dossier");
  assert.ok(reprise.texte.includes(refB) && reprise.texte.includes(`« ${prefixe}-02 »`), reprise.texte);
  fs.mkdirSync(path.join(dossierB, "Pièces Dupont"));
  fs.writeFileSync(j.selection, path.join(dossierB, "Pièces Dupont"), "utf8");
  const sousDossier = await client.outil("choisir_dossier");
  assert.ok(sousDossier.texte.includes(refB), "un sous-dossier de l'affaire garde la référence de l'affaire");

  // Fenêtre fermée sans libellé ; référence fournie ; refus
  fs.writeFileSync(j.saisie, "ANNULE", "utf8");
  const c = await client.outil("creer_dossier_affaire", { saisir_libelle: true, reference: "AFF-12" });
  assert.match(c.texte, /fermée sans libellé/);
  assert.ok(fs.existsSync(path.join(parent, "AFF-12")));
  assert.equal((await client.outil("creer_dossier_affaire", { reference: "AFF-12" })).erreur, true, "référence déjà utilisée");
  assert.equal((await client.outil("creer_dossier_affaire", { reference: "../ailleurs" })).erreur, true, "référence invalide");
  assert.equal((await client.outil("creer_dossier_affaire")).texte.includes(`${prefixe}-03`), true, "numérotation reprise après les existants");
  aucuneFuite(client, j);
});

test("importer_fichiers : fenêtre de sélection et Téléchargements, copie sans écraser, noms pseudonymisés", async t => {
  const { client, j } = await contexte(t);
  assert.equal((await client.outil("importer_fichiers", { mode: "telechargements" })).erreur, true, "dossier courant exigé pour les Téléchargements");
  await client.outil("creer_dossier_affaire");
  const courant = fs.readdirSync(j.racine).find(n => /^\d{4}-\d{2}-\d{2}-01$/.test(n));
  const dossier = path.join(j.racine, courant);

  const pieceA = path.join(j.dehors, "Courrier Martin.txt");
  const pieceB = path.join(j.dehors, "Photo Martin.jpg");
  fs.writeFileSync(pieceB, "image", "utf8");
  fs.writeFileSync(j.fichiers, [pieceA, pieceB, path.join(j.dehors, "absent.pdf")].join("\n"), "utf8");
  const r = await client.outil("importer_fichiers");
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /2 fichier\(s\) copié\(s\)/);
  assert.match(r.texte, /F\d+ · Courrier \[PERSONNE_\d\]\.txt|F\d+ · Courrier …\.txt/);
  assert.match(r.texte, /1 fichier\(s\) copié\(s\) dans un format que lire_fichier_anonymise ne lit pas/);
  assert.match(r.texte, /1 élément\(s\) ignoré\(s\)/);
  assert.ok(fs.existsSync(path.join(dossier, "Courrier Martin.txt")) && fs.existsSync(pieceA), "copié, original conservé");
  const id = /(F\d+) · Courrier/.exec(r.texte)[1];
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: id });
  assert.match(lecture.texte, /\[PERSONNE_\d\] écrit à \[SOCIETE_\d\]/);

  // Deuxième import du même fichier : pas d'écrasement ; fichier déjà dans le dossier : pas de copie
  fs.writeFileSync(j.fichiers, [pieceA, path.join(dossier, "Courrier Martin.txt")].join("\n"), "utf8");
  const r2 = await client.outil("importer_fichiers", { sous_dossier: "Pièces reçues" });
  assert.match(r2.texte, /1 fichier\(s\) copié\(s\) dans le dossier courant, sous-dossier « Pièces reçues »/);
  assert.match(r2.texte, /1 fichier\(s\) déjà présent/);
  assert.ok(fs.existsSync(path.join(dossier, "Pièces reçues", "Courrier Martin.txt")));
  fs.writeFileSync(j.fichiers, pieceA, "utf8");
  await client.outil("importer_fichiers");
  assert.ok(fs.existsSync(path.join(dossier, "Courrier Martin (2).txt")), "suffixe (2) au lieu d'écraser");

  fs.writeFileSync(j.fichiers, "ANNULE", "utf8");
  assert.match((await client.outil("importer_fichiers")).texte, /sans choisir de fichier/);

  // Téléchargements : les plus récents d'abord, formats lisibles seulement
  const maintenant = Date.now() / 1000;
  for (const [nom, age] of [["ancien.pdf", 300], ["Assignation Dupont.txt", 10], ["Facture ZORVAL.md", 20], ["video.mp4", 1], ["dl.crdownload", 1]]) {
    const p = path.join(j.telechargements, nom);
    fs.writeFileSync(p, nom.includes("Dupont") ? "Jean Dupont est assigné." : "contenu", "utf8");
    fs.utimesSync(p, maintenant - age, maintenant - age);
  }
  const r3 = await client.outil("importer_fichiers", { mode: "telechargements", nombre: 2 });
  assert.match(r3.texte, /2 fichier\(s\) copié\(s\)/, r3.texte);
  assert.ok(fs.existsSync(path.join(dossier, "Assignation Dupont.txt")) && fs.existsSync(path.join(dossier, "Facture ZORVAL.md")));
  assert.ok(!fs.existsSync(path.join(dossier, "ancien.pdf")) && !fs.existsSync(path.join(dossier, "video.mp4")));
  aucuneFuite(client, j);
});

test("presse-papiers : import pseudonymisé enregistré en .txt, réponse ré-identifiée renvoyée au presse-papiers", async t => {
  const { client, j } = await contexte(t);
  assert.equal((await client.outil("importer_presse_papiers")).erreur, true, "dossier courant exigé");
  await client.outil("creer_dossier_affaire");
  const dossier = path.join(j.racine, fs.readdirSync(j.racine).find(n => /^\d{4}-\d{2}-\d{2}-01$/.test(n)));

  fs.writeFileSync(j.pressePapiers, "", "utf8");
  const vide = await client.outil("importer_presse_papiers");
  assert.equal(vide.erreur, true);
  assert.match(vide.texte, /ne contient pas de texte/);

  const courriel = "Bonjour Maître,\r\nJe suis Jean Dupont (jean.dupont@exemple.fr). ZORVAL ne m'a pas payé.\r\nCordialement";
  fs.writeFileSync(j.pressePapiers, courriel, "utf8");
  const imp = await client.outil("importer_presse_papiers");
  assert.equal(imp.erreur, false, imp.texte);
  assert.match(imp.texte, /Je suis \[PERSONNE_1\] \(\[EMAIL_1\]\)\. \[SOCIETE_1\] ne m'a pas payé\./);
  const txt = fs.readdirSync(dossier).find(n => /^presse-papiers .*\.txt$/.test(n));
  assert.ok(txt, "fichier .txt créé dans le dossier courant");
  assert.equal(fs.readFileSync(path.join(dossier, txt), "utf8"), courriel.replace(/\r\n/g, "\n"), "texte d'origine conservé sur le poste");
  const id = /sous l'identifiant (F\d+)/.exec(imp.texte)[1];
  assert.match((await client.outil("lister_fichiers")).texte, new RegExp(`${id} · presse-papiers`));

  // Réponse rédigée avec les marqueurs -> presse-papiers en clair, réponse de l'outil sans donnée réelle
  const reponse = "# Réponse\n\nCher **[PERSONNE_1]**,\n\nNous écrivons à [SOCIETE_1]. Votre adresse [EMAIL_1] est notée. [PERSONNE_9]";
  const sortie = await client.outil("reidentifier_vers_presse_papiers", { texte: reponse });
  assert.equal(sortie.erreur, false, sortie.texte);
  assert.match(sortie.texte, /3 marqueur\(s\) remplacé\(s\)/);
  assert.match(sortie.texte, /Marqueurs inconnus .*\[PERSONNE_9\]/);
  assert.equal(fs.readFileSync(j.pressePapiers, "utf8"),
    "Réponse\n\nCher Jean Dupont,\n\nNous écrivons à ZORVAL. Votre adresse jean.dupont@exemple.fr est notée. [PERSONNE_9]");
  await client.outil("reidentifier_vers_presse_papiers", { texte: "**[PERSONNE_1]**", texte_brut: true });
  assert.equal(fs.readFileSync(j.pressePapiers, "utf8"), "**Jean Dupont**");

  fs.writeFileSync(j.pressePapiers, "inchangé", "utf8");
  const inconnu = await client.outil("reidentifier_vers_presse_papiers", { texte: "Bonjour [PERSONNE_42]" });
  assert.match(inconnu.texte, /n'a pas été modifié/);
  assert.equal(fs.readFileSync(j.pressePapiers, "utf8"), "inchangé");
  aucuneFuite(client, j);
});

test("journal local : chaque opération tracée, sans nom, chemin ni texte en clair", async t => {
  const { client, j } = await contexte(t);
  fs.writeFileSync(j.saisie, "Dupont c. ZORVAL", "utf8");
  await client.outil("creer_dossier_affaire", { saisir_libelle: true });
  fs.writeFileSync(j.fichiers, path.join(j.dehors, "Courrier Martin.txt"), "utf8");
  const imp = await client.outil("importer_fichiers");
  await client.outil("lire_fichier_anonymise", { fichier: /(F\d+) ·/.exec(imp.texte)[1] });
  fs.writeFileSync(j.pressePapiers, "Jean Dupont, 12 rue de la Paix\n75002 Paris", "utf8");
  await client.outil("importer_presse_papiers");
  await client.outil("reidentifier_vers_presse_papiers", { texte: "Cher [PERSONNE_1]" });
  await client.outil("enregistrer_document", { texte: "Note pour [PERSONNE_1]", nom_fichier: "note", format: "txt" });

  const brut = fs.readFileSync(j.journal, "utf8");
  const lignes = brut.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lignes.map(l => l.operation),
    ["creation_dossier", "import_fichiers", "lecture", "import_presse_papiers", "presse_papiers_sortie", "enregistrement_document"]);
  assert.ok(lignes.every(l => /^\d{4}-\d{2}-\d{2}T/.test(l.date) && /^D-[0-9a-f]{8}$/.test(l.ref)));
  assert.equal(lignes[0].libelle_saisi, true);
  assert.equal(lignes[2].entites.PERSONNE, 1);
  for (const mot of [...REELS, "Courrier", "Paris", j.tmp, j.tmp.replace(/\\/g, "\\\\")]) {
    assert.ok(!brut.includes(mot), `le journal contient « ${mot} »`);
  }
  aucuneFuite(client, j);
});

test("fonctions du lot 2 : libellé nettoyé, Markdown retiré, numérotation du jour", () => {
  assert.equal(ext.nettoyerLibelle(' Dupont c. "X" / Y: Z ... '), "Dupont c. X Y Z");
  assert.equal(ext.texteSansMarkdown("## Titre\n**gras** et __souligné__\n* point"), "Titre\ngras et souligné\n- point");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-ref-"));
  const ref1 = ext.prochaineReference(tmp);
  assert.match(ref1, /^\d{4}-\d{2}-\d{2}-01$/);
  fs.mkdirSync(path.join(tmp, ref1.replace(/01$/, "07") + " - Libellé"));
  assert.ok(ext.prochaineReference(tmp).endsWith("-08"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- lot 3 (version 1.3.0)
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function docx(corps, { entete, dotx } = {}) {
  const type = dotx ? "template" : "document";
  return ext.ecrireZip([
    ext.creerEntree("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}.main+xml"/></Types>`),
    ext.creerEntree("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS_W}><w:body>${corps}</w:body></w:document>`),
    ...(entete ? [ext.creerEntree("word/header1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS_W}>${entete}</w:hdr>`)] : []),
  ]);
}
const partie = (buf, nom) => ext.contenuEntree(ext.lireZip(buf).find(e => e.nom === nom)).toString("utf8");
const texteXml = xml => xml.replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

test("modèles Word : dossier des modèles absent, message explicite", async t => {
  const { client } = await contexte(t, { env: { ANON_DOSSIER_MODELES: path.join(os.tmpdir(), "anon-dossier-inexistant") } });
  assert.match((await client.outil("lister_modeles")).texte, /Aucun dossier de modèles/);
});

test("modèles Word : remplissage complet sur un dossier d'affaire", async t => {
  const tmpModeles = fs.mkdtempSync(path.join(os.tmpdir(), "anon-modeles-"));
  t.after(() => fs.rmSync(tmpModeles, { recursive: true, force: true }));
  const { client, j, faux } = await contexte(t, { env: { ANON_DOSSIER_MODELES: tmpModeles, ANON_OUVRIR_SIMULE: path.join(tmpModeles, "ouverts.txt") } });
  const corps =
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Madame, Monsieur </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>[NOM</w:t></w:r>' +
    '<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> DU CLIENT]</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:t>,</w:t></w:r></w:p>' +
    "<w:p><w:r><w:t>Adresse du client</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Nous vous écrivons au sujet de la société XXXX et de la société XXXX.</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Texte du cabinet inchangé.</w:t></w:r></w:p>";
  fs.writeFileSync(path.join(tmpModeles, "Courrier modele.docx"), docx(corps, { entete: "<w:p><w:r><w:t>Réf. : REFERENCE</w:t></w:r></w:p>" }));
  fs.writeFileSync(path.join(tmpModeles, "Mise en demeure.dotx"), docx("<w:p><w:r><w:t>Destinataire : DEST</w:t></w:r></w:p>", { dotx: true }));
  fs.writeFileSync(path.join(tmpModeles, "notes.txt"), "pas un modèle", "utf8");
  const original = fs.readFileSync(path.join(tmpModeles, "Courrier modele.docx"));

  fs.writeFileSync(j.selection, j.affaire, "utf8");
  await client.outil("choisir_dossier");
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Pièces/Contrat ZORVAL.md" }); // attribue les marqueurs
  await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  const ref = /« (D-[0-9a-f]{8}) »/.exec(lecture.texte)[1];
  const marqueur = v => faux.dossiers.get(ref).entites.get(v).marqueur;
  const P = marqueur("Jean Dupont"), S = marqueur("ZORVAL & Fils"), A = marqueur("12 rue de la Paix\n75002 Paris");

  const liste = await client.outil("lister_modeles");
  assert.match(liste.texte, /2 modèle\(s\) Word/);
  const id = /(F\d+) · Courrier modele\.docx/.exec(liste.texte)[1];
  const idDotx = /(F\d+) · Mise en demeure\.dotx/.exec(liste.texte)[1];

  const r = await client.outil("enregistrer_document", {
    modele: id, nom_fichier: "courrier-client", ouvrir: true,
    remplacements: [
      { rechercher: "[NOM DU CLIENT]", remplacer: P },
      { rechercher: "Adresse du client", remplacer: A },
      { rechercher: "XXXX", remplacer: S },
      { rechercher: "REFERENCE", remplacer: "2026-11-25-01" },
      { rechercher: "Madame,  Monsieur", remplacer: "Cher" },   // espaces différents : toléré
      { rechercher: "texte absent du modèle", remplacer: "x" },
    ],
  });
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /6 remplacement\(s\) effectué\(s\) dans le modèle ; 4 marqueur\(s\) remplacé\(s\)/);
  assert.match(r.texte, /remplacement\(s\) n° 6/);
  assert.match(r.texte, /Fichier ouvert sur le poste/);
  const produit = path.join(j.affaire, "courrier-client.docx");
  assert.ok(fs.existsSync(produit));
  assert.equal(fs.readFileSync(path.join(tmpModeles, "ouverts.txt"), "utf8").trim(), fs.realpathSync(produit), "ouverture demandée sur le bon fichier");
  const doc = partie(fs.readFileSync(produit), "word/document.xml");
  assert.equal(texteXml(doc),
    "Cher Jean Dupont," + "12 rue de la Paix\n75002 Paris" + "Nous vous écrivons au sujet de la société ZORVAL & Fils et de la société ZORVAL & Fils." + "Texte du cabinet inchangé.");
  // « [NOM » (gras) + « DU CLIENT] » (italique) : le nom prend la mise en forme du premier morceau
  assert.match(doc, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Jean Dupont<\/w:t>/, "mise en forme du premier morceau conservée");
  assert.match(doc, /<w:proofErr w:type="spellStart"\/>/, "le reste du XML du modèle est conservé");
  assert.equal(texteXml(partie(fs.readFileSync(produit), "word/header1.xml")), "Réf. : 2026-11-25-01", "en-tête rempli");
  assert.ok(fs.readFileSync(path.join(tmpModeles, "Courrier modele.docx")).equals(original), "modèle d'origine intact");

  // Modèle .dotx : devient un .docx
  const r2 = await client.outil("enregistrer_document", { modele: idDotx, nom_fichier: "mise-en-demeure", remplacements: [{ rechercher: "DEST", remplacer: S }] });
  assert.equal(r2.erreur, false, r2.texte);
  const md = fs.readFileSync(path.join(j.affaire, "mise-en-demeure.docx"));
  assert.match(partie(md, "[Content_Types].xml"), /wordprocessingml\.document\.main\+xml/);
  assert.equal(texteXml(partie(md, "word/document.xml")), "Destinataire : ZORVAL & Fils");

  // « rechercher » recopié de la lecture pseudonymisée (contient un marqueur) : remis en clair avant recherche
  fs.writeFileSync(path.join(tmpModeles, "Lettre client.docx"), docx("<w:p><w:r><w:t>Client : Jean Dupont.</w:t></w:r></w:p>"));
  const liste2 = await client.outil("lister_modeles");
  const id3 = /(F\d+) · Lettre client\.docx/.exec(liste2.texte)[1];
  await client.outil("enregistrer_document", { modele: id3, nom_fichier: "avec-nom", remplacements: [{ rechercher: `Client : ${P}.`, remplacer: `Client : ${P} (${S}).` }] });
  assert.equal(texteXml(partie(fs.readFileSync(path.join(j.affaire, "avec-nom.docx")), "word/document.xml")), "Client : Jean Dupont (ZORVAL & Fils).");

  // Erreurs
  assert.equal((await client.outil("enregistrer_document", { modele: "F999", nom_fichier: "x", remplacements: [{ rechercher: "a", remplacer: "b" }] })).erreur, true);
  assert.equal((await client.outil("enregistrer_document", { modele: id, nom_fichier: "x", remplacements: [] })).erreur, true);
  assert.equal((await client.outil("enregistrer_document", { modele: path.join(j.dehors, "Courrier Martin.txt"), nom_fichier: "x", remplacements: [{ rechercher: "a", remplacer: "b" }] })).erreur, true,
    "un fichier hors des emplacements autorisés n'est pas accepté comme modèle");
  aucuneFuite(client, j);
});

test("enregistrer_fichier : docx, xlsx et texte reçus en base64 ré-identifiés ; PDF et contenu invalide refusés ; ouverture selon le réglage", async t => {
  const ouverts = path.join(os.tmpdir(), `anon-ouverts-${process.pid}-${Date.now()}.txt`);
  t.after(() => fs.rmSync(ouverts, { force: true }));
  const { client, j, faux } = await contexte(t, { env: { ANON_OUVRIR_AUTO: "true", ANON_OUVRIR_SIMULE: ouverts } });
  await client.outil("choisir_dossier", { chemin: j.affaire });
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  const ref = /« (D-[0-9a-f]{8}) »/.exec(lecture.texte)[1];
  const P = faux.dossiers.get(ref).entites.get("Jean Dupont").marqueur;

  const r = await client.outil("enregistrer_fichier", { nom_fichier: "projet.docx", contenu_base64: docx(`<w:p><w:r><w:t>Pour ${P}.</w:t></w:r></w:p>`).toString("base64") });
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /1 marqueur\(s\) remplacé\(s\)/);
  assert.match(r.texte, /Fichier ouvert sur le poste/, "réglage « ouvrir automatiquement » appliqué");
  assert.equal(texteXml(partie(fs.readFileSync(path.join(j.affaire, "projet.docx")), "word/document.xml")), "Pour Jean Dupont.");

  const xlsx = ext.ecrireZip([ext.creerEntree("xl/sharedStrings.xml", `<sst><si><t>${P}</t></si></sst>`)]);
  await client.outil("enregistrer_fichier", { nom_fichier: "tableau.xlsx", contenu_base64: xlsx.toString("base64"), sous_dossier: "Tableaux", ouvrir: false });
  assert.match(partie(fs.readFileSync(path.join(j.affaire, "Tableaux", "tableau.xlsx")), "xl/sharedStrings.xml"), /<t xml:space="preserve">Jean Dupont<\/t>/);
  assert.equal(fs.readFileSync(ouverts, "utf8").trim().split("\n").length, 1, "ouvrir=false l'emporte sur le réglage");

  await client.outil("enregistrer_fichier", { nom_fichier: "note.md", contenu_base64: Buffer.from(`# Note\n${P}`).toString("base64") });
  assert.equal(fs.readFileSync(path.join(j.affaire, "note.md"), "utf8"), "# Note\nJean Dupont");
  const sans = await client.outil("enregistrer_fichier", { nom_fichier: "vide.txt", contenu_base64: Buffer.from("rien").toString("base64") });
  assert.match(sans.texte, /enregistré tel quel/);

  assert.match((await client.outil("enregistrer_fichier", { nom_fichier: "a.pdf", contenu_base64: "JVBERi0=" })).texte, /PDF n'est pas accepté/);
  assert.equal((await client.outil("enregistrer_fichier", { nom_fichier: "a.docx", contenu_base64: Buffer.from("pas un zip").toString("base64") })).erreur, true);
  assert.equal((await client.outil("enregistrer_fichier", { nom_fichier: "a.docx", contenu_base64: "%%%" })).erreur, true);
  assert.equal((await client.outil("enregistrer_fichier", { nom_fichier: "sans-extension", contenu_base64: "YQ==" })).erreur, true);
  aucuneFuite(client, j);
});

test("fonctions du lot 3 : motif tolérant, remplacement sur plusieurs morceaux, dotx", () => {
  const rx = new RegExp(ext.motifSouple("l'article  1240"));
  assert.ok(rx.test("l’article 1240") && rx.test("l'article 1240"));
  const { octets, trouves } = ext.appliquerModele(docx("<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>B C</w:t></w:r></w:p>"), [{ rechercher: "AB", remplacer: "X\nY" }]);
  assert.deepEqual(trouves, [1]);
  assert.equal(texteXml(partie(octets, "word/document.xml")), "X\nY C");
  assert.match(partie(ext.dotxVersDocx(docx("", { dotx: true })), "[Content_Types].xml"), /document\.main\+xml/);
});

// --------------------------------------------------------------------------- moteur local (version 1.4.0)
/** Faux service Ollama : repère les noms fictifs connus dans le texte reçu. */
function fauxOllama() {
  const http = require("http");
  const recus = [];
  const PERSONNES = ["Jean Dupont", "Marie Martin"], ORGS = ["ZORVAL & Fils", "ZORVAL"];
  const srv = http.createServer((req, res) => {
    let corps = "";
    req.on("data", d => { corps += d; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "ministral-3:3b" }, { name: "glm-5.2:cloud" }] }));
      const b = JSON.parse(corps || "{}");
      recus.push(b);
      const texte = (b.messages || []).filter(m => m.role === "user").map(m => m.content).join("\n");
      res.end(JSON.stringify({ message: { content: JSON.stringify({
        personnes: [...PERSONNES.filter(n => texte.includes(n)), "Nom Inventé"], organisations: ORGS.filter(n => texte.includes(n)) }) } }));
    });
  });
  return {
    recus,
    demarrer: () => new Promise(r => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))),
    arreter: () => new Promise(r => srv.close(r)),
  };
}

test("moteur local : sans serveur, noms reconnus par Ollama, table chiffrée sur le poste, livrables ré-identifiés", async t => {
  const ollama = fauxOllama();
  const url = await ollama.demarrer();
  t.after(() => ollama.arreter());
  const tables = fs.mkdtempSync(path.join(os.tmpdir(), "anon-tables-"));
  t.after(() => fs.rmSync(tables, { recursive: true, force: true }));
  const { client, j, faux } = await contexte(t, { env: { ANON_MOTEUR_LOCAL: "true", ANON_OLLAMA_URL: url, ANON_OLLAMA_MODELE: "ministral-3:3b", ANON_TABLES: tables, ANON_DPAPI: "0" } });

  const etat = await client.outil("etat_anonymiseur");
  assert.equal(etat.erreur, false, etat.texte);
  assert.match(etat.texte, /moteur local/);
  assert.match(etat.texte, /règles \+ Ollama ministral-3:3b/);

  fs.writeFileSync(j.selection, j.affaire, "utf8");
  await client.outil("choisir_dossier");
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  assert.match(lecture.texte, /\[PERSONNE_1\] \(\[EMAIL_1\]\) assigne \[SOCIETE_1\]\./, lecture.texte);
  assert.ok(!lecture.texte.includes("Nom Inventé"));
  assert.equal(faux.journal.length, 0, "le serveur d'anonymisation n'est jamais appelé");
  assert.ok(ollama.recus.every(b => b.model === "ministral-3:3b" && b.think === false), "modèle demandé, sans raisonnement");

  // Table de correspondance : un fichier par affaire, aucune valeur en clair
  const fichiers = fs.readdirSync(tables);
  assert.ok(fichiers.includes("cle.dat") && fichiers.some(f => /^D-[0-9a-f]{8}\.json$/.test(f)), fichiers.join(","));
  for (const f of fichiers) {
    const brut = fs.readFileSync(path.join(tables, f), "utf8");
    for (const mot of REELS) assert.ok(!brut.includes(mot), `« ${mot} » en clair dans ${f}`);
  }

  // Livrable docx produit sur le poste
  const enr = await client.outil("enregistrer_document", { texte: "# Note\n\nPour **[PERSONNE_1]** contre [SOCIETE_1].\n- point [EMAIL_1]", nom_fichier: "note-locale" });
  assert.equal(enr.erreur, false, enr.texte);
  assert.match(enr.texte, /3 marqueur\(s\) remplacé\(s\)/);
  const xml = partie(fs.readFileSync(path.join(j.affaire, "note-locale.docx")), "word/document.xml");
  assert.match(texteXml(xml), /NotePour Jean Dupont contre ZORVAL\.•\tpoint jean\.dupont@exemple\.fr/);
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Jean Dupont/);

  const pp = await client.outil("reidentifier_vers_presse_papiers", { texte: "Cher [PERSONNE_1]" });
  assert.equal(pp.erreur, false, pp.texte);
  assert.equal(fs.readFileSync(j.pressePapiers, "utf8"), "Cher Jean Dupont");
  const ent = await client.outil("entites_du_dossier");
  assert.match(ent.texte, /\[PERSONNE_1\] \(PERSONNE\)/);

  // Redémarrage : la table est relue (même marqueur pour la même personne)
  const client2 = new Client(Object.assign({}, process.env, { ANON_MOTEUR_LOCAL: "true", ANON_OLLAMA_URL: url, ANON_TABLES: tables, ANON_DPAPI: "0",
    ANON_DOSSIER_TRAVAIL: j.racine, ANON_ETAT: j.etat, ANON_SELECTEUR_SIMULE: j.selection, ANON_PRESSE_PAPIERS_SIMULE: j.pressePapiers }));
  t.after(() => client2.fermer());
  await client2.init();
  await client2.outil("choisir_dossier", { chemin: j.affaire });
  const relu = await client2.outil("lire_fichier_anonymise", { fichier: "Pièces/Contrat ZORVAL.md" });
  assert.match(relu.texte, /\[PERSONNE_1\]/, relu.texte);
  aucuneFuite(client, j);
  aucuneFuite(client2, j);
});

test("moteur local : modèle « cloud » et adresse Internet refusés, règles seules signalées", async t => {
  const ollama = fauxOllama();
  const url = await ollama.demarrer();
  t.after(() => ollama.arreter());
  for (const [env, attendu] of [
    [{ ANON_OLLAMA_URL: url, ANON_OLLAMA_MODELE: "glm-5.2:cloud" }, /modèle « cloud » refusé/],
    [{ ANON_OLLAMA_URL: "http://8.8.8.8:11434", ANON_OLLAMA_MODELE: "ministral-3:3b" }, /adresse Ollama refusée/],
    [{ ANON_OLLAMA_URL: url, ANON_OLLAMA_MODELE: "absent:1b" }, /modèle absent:1b absent d'Ollama/],
  ]) {
    const tables = fs.mkdtempSync(path.join(os.tmpdir(), "anon-tables-"));
    const { client, j } = await contexte(t, { env: Object.assign({ ANON_MOTEUR_LOCAL: "1", ANON_TABLES: tables, ANON_DPAPI: "0" }, env) });
    const etat = await client.outil("etat_anonymiseur");
    assert.match(etat.texte, attendu, etat.texte);
    assert.match(etat.texte, /règles seules/);
    await client.outil("choisir_dossier", { chemin: j.affaire });
    if (!/absent/.test(String(attendu))) {
      const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
      assert.match(lecture.texte, /⚠ Reconnaissance des noms par le modèle local \(Ollama\) inactive/);
      assert.match(lecture.texte, /\[EMAIL_1\]/, "les règles s'appliquent toujours");
    }
    fs.rmSync(tables, { recursive: true, force: true });
  }
  assert.ok(!ollama.recus.some(b => /cloud/.test(b.model)), "aucun texte envoyé à un modèle « cloud »");
});

test("moteur local : lecture des formats (Word avec tableau et en-tête, OpenDocument, courriel, RTF, HTML, PDF)", () => {
  const { creerFichiers } = require("../server/moteur/fichiers");
  const F = creerFichiers({ lireZip: ext.lireZip, contenuEntree: ext.contenuEntree, ecrireZip: ext.ecrireZip, creerEntree: ext.creerEntree });
  const word = docx('<w:p><w:r><w:t>Entre </w:t></w:r><w:r><w:t>Jean Dupont</w:t><w:tab/><w:t>et</w:t></w:r></w:p>' +
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Lot</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>S09 Dupont</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
  { entete: "<w:p><w:r><w:t>Réf. 2026-01</w:t></w:r></w:p>" });
  assert.equal(F.extraireTexte(".docx", word).texte, "Entre Jean Dupont\tet\nLot | S09 Dupont\n\nRéf. 2026-01");
  const odt = ext.ecrireZip([ext.creerEntree("content.xml", '<office:document-content><text:p>Marie<text:s/>Martin<text:tab/>x</text:p><text:h>Titre</text:h></office:document-content>')]);
  assert.equal(F.extraireTexte(".odt", odt).texte, "Marie Martin\tx\nTitre\n");
  const courriel = "From: =?UTF-8?B?SsOpcsO0bWU=?= <j@exemple.fr>\r\nSubject: =?UTF-8?Q?Cr=C3=A9ance?=\r\nContent-Type: multipart/mixed; boundary=\"zz\"\r\n\r\n" +
    "--zz\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBonjour Ma=C3=AEtre,\r\nJe suis Marie Mar=\r\ntin.\r\n" +
    "--zz\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--zz--\r\n";
  assert.equal(F.extraireTexte(".eml", Buffer.from(courriel, "latin1")).texte, "From: Jérôme <j@exemple.fr>\nSubject: Créance\n\nBonjour Maître,\r\nJe suis Marie Martin.");
  assert.equal(F.extraireTexte(".rtf", Buffer.from("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Ma\\'eetre Dupont\\par Soci\\u233?t\\u233? ZORVAL}", "latin1")).texte, "Maître Dupont\nSociété ZORVAL");
  assert.equal(F.extraireTexte(".html", Buffer.from("<html><style>p{}</style><p>Jean&nbsp;Dupont</p><table><tr><td>a</td><td>b</td></tr></table></html>")).texte, "Jean Dupont\na | b |");
  const flux = require("zlib").deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Madame Marie Martin) Tj T* [(demeure ) -250 (12 rue de la Paix)] TJ ET", "latin1"));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + flux.length + " /Filter /FlateDecode >>\nstream\n", "latin1"), flux, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
  const lu = F.extraireTexte(".pdf", pdf);
  assert.equal(lu.texte, "Madame Marie Martin\ndemeure 12 rue de la Paix");
  assert.match(lu.avert[0], /extraction simplifiée/);
  assert.match(F.extraireTexte(".pdf", Buffer.from("%PDF-1.4\n<< /Encrypt 5 0 R >>")).avert[0], /protégé/);
});

// --------------------------------------------------------------------------- lot 4 (version 1.5.0)
test("corriger_entite (moteur local) : ajouter par fenêtre ou texte vu, exclure, réintégrer, fusionner ; seuls des marqueurs reviennent", async t => {
  const tables = fs.mkdtempSync(path.join(os.tmpdir(), "anon-tables-"));
  t.after(() => fs.rmSync(tables, { recursive: true, force: true }));
  const { client, j } = await contexte(t, { env: { ANON_MOTEUR_LOCAL: "true", ANON_OLLAMA_DESACTIVE: "1", ANON_TABLES: tables, ANON_DPAPI: "0" } });
  await client.outil("choisir_dossier", { chemin: j.affaire });
  fs.writeFileSync(path.join(j.affaire, "Courrier.txt"), "Courrier de Jean DUPONT à Marie Martin. M. Bureau signe pour ZORVAL.", "utf8");
  const lire = async () => (await client.outil("lire_fichier_anonymise", { fichier: "Courrier.txt" })).texte.split("────────────────────────\n")[1];

  assert.equal(await lire(), "Courrier de [PERSONNE_1] à Marie Martin. M. [PERSONNE_2] signe pour ZORVAL.", "règles seules : deux noms oubliés");

  // Ajouter : nom tapé par l'utilisateur dans la fenêtre locale
  fs.writeFileSync(j.saisie, "Marie Martin", "utf8");
  const a = await client.outil("corriger_entite", { action: "ajouter", type: "PERSONNE" });
  assert.equal(a.erreur, false, a.texte);
  assert.match(a.texte, /Donnée saisie par l'utilisateur dans la fenêtre locale : elle sera désormais masquée sous le marqueur \[PERSONNE_3\]/);
  // Ajouter : texte vu en clair (fuite)
  const b = await client.outil("corriger_entite", { action: "ajouter", type: "SOCIETE", texte_vu: "ZORVAL" });
  assert.match(b.texte, /\[SOCIETE_1\]/);
  assert.equal(await lire(), "Courrier de [PERSONNE_1] à [PERSONNE_3]. M. [PERSONNE_2] signe pour [SOCIETE_1].");

  // Exclure « Bureau » (supposé mot courant ici), puis réintégrer
  const e = await client.outil("corriger_entite", { action: "exclure", marqueurs: ["[PERSONNE_2]"] });
  assert.match(e.texte, /Exclusion enregistrée/);
  assert.equal(await lire(), "Courrier de [PERSONNE_1] à [PERSONNE_3]. M. Bureau signe pour [SOCIETE_1].");
  assert.match((await client.outil("entites_du_dossier")).texte, /\[PERSONNE_2\] \(PERSONNE\) — \d+ occurrence\(s\) — exclu/);
  await client.outil("corriger_entite", { action: "reinclure", marqueurs: ["PERSONNE_2"] });
  assert.match(await lire(), /M\. \[PERSONNE_2\] signe/);

  // Fusionner : Marie Martin et Jean DUPONT deviennent un seul marqueur (exemple artificiel)
  const f = await client.outil("corriger_entite", { action: "fusionner", marqueurs: ["[PERSONNE_1]", "[PERSONNE_3]"] });
  assert.match(f.texte, /\[PERSONNE_3\] → \[PERSONNE_1\]/);
  assert.equal(await lire(), "Courrier de [PERSONNE_1] à [PERSONNE_1]. M. [PERSONNE_2] signe pour [SOCIETE_1].");
  await client.outil("reidentifier_vers_presse_papiers", { texte: "[PERSONNE_3] / [PERSONNE_1]" });
  assert.equal(fs.readFileSync(j.pressePapiers, "utf8"), "Marie Martin / Jean DUPONT", "ancien marqueur toujours ré-identifiable");

  // Erreurs
  assert.match((await client.outil("corriger_entite", { action: "exclure", marqueurs: ["[PERSONNE_9]"] })).texte, /inconnu/);
  assert.equal((await client.outil("corriger_entite", { action: "ajouter" })).erreur, true);
  assert.equal((await client.outil("corriger_entite", { action: "supprimer" })).erreur, true);
  fs.writeFileSync(j.saisie, "ANNULE", "utf8");
  assert.match((await client.outil("corriger_entite", { action: "ajouter", type: "PERSONNE" })).texte, /sans rien saisir/);

  for (const s of client.sorties) for (const mot of ["Marie Martin", "Jean DUPONT", "Bureau signe"]) {
    assert.ok(!s.includes(mot) || s.includes("Courrier de"), `« ${mot} » visible dans une réponse d'outil de correction : ${s.slice(0, 120)}`);
  }
  const journal = fs.readFileSync(j.journal, "utf8");
  assert.ok(/"operation":"correction"/.test(journal) && !/Martin|DUPONT|ZORVAL/.test(journal), "corrections journalisées sans valeur");
});

test("corriger_entite (serveur ancien) : message clair si le serveur n'est pas en 1.2.0 ; secours d'export refusé sans blocage", async t => {
  const { client, j, faux } = await contexte(t);
  await client.outil("choisir_dossier", { chemin: j.affaire });
  await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  const r = await client.outil("corriger_entite", { action: "exclure", marqueurs: ["[PERSONNE_1]"] });
  assert.equal(r.erreur, true);
  assert.match(r.texte, /mis à jour en version 1\.2\.0/);
  // Repères altérés ET export des valeurs refusé : les marqueurs sont signalés inconnus, sans planter
  faux.etatFaux.altererReperes = true;
  faux.etatFaux.refuserExport = true;
  const fichier = path.join(j.tmp, "a-marqueurs.txt");
  fs.writeFileSync(fichier, "Pour [PERSONNE_1].", "utf8");
  const reid = await client.outil("reidentifier_fichier", { fichier });
  assert.match(reid.texte, /Aucun marqueur de ce fichier n'est connu/);
});

// --------------------------------------------------------------------------- lot 5 (version 1.6.0)
test("importer_courriel : liste pseudonymisée, import du message et des pièces jointes, boîte en lecture seule", async t => {
  const imap = require("./faux-imap").creer();
  const port = await imap.demarrer();
  t.after(() => imap.arreter());
  const sansConfig = await contexte(t);
  const r0 = await sansConfig.client.outil("importer_courriel");
  assert.equal(r0.erreur, true);
  assert.match(r0.texte, /messagerie n'est pas configurée/);

  const { client, j, faux } = await contexte(t, { env: { ANON_IMAP_SERVEUR: "127.0.0.1", ANON_IMAP_PORT: String(port), ANON_IMAP_TLS: "0",
    ANON_IMAP_UTILISATEUR: "avocat", ANON_IMAP_MOT_DE_PASSE: "secret" } });
  const liste = await client.outil("importer_courriel", { nombre: 5 });
  assert.equal(liste.erreur, false, liste.texte);
  assert.match(liste.texte, /C1 · 25\/11\/2025 \d\dh03 · De : \[PERSONNE_\d\] <\[EMAIL_\d\]> \| Objet : Créance \[SOCIETE_\d\]/);
  assert.match(liste.texte, /C2 · .* Objet : Ancien message/);
  assert.ok(![...faux.dossiers.keys()].some(k => /^D-/.test(k)), "référence temporaire de la liste supprimée du serveur");

  assert.equal((await client.outil("importer_courriel", { courriel: "C1" })).erreur, true, "dossier courant exigé pour importer");
  await client.outil("choisir_dossier", { chemin: j.affaire });
  const imp = await client.outil("importer_courriel", { courriel: "C1", sous_dossier: "Courriels" });
  assert.equal(imp.erreur, false, imp.texte);
  assert.match(imp.texte, /Courriel enregistré dans le dossier courant, sous-dossier « Courriels » sous l'identifiant F\d+ \(\.eml\), avec 2 pièce\(s\) jointe\(s\)/);
  assert.match(imp.texte, /Ma(î|Ã®)tre,|\[SOCIETE_\d\] ne m'a pas pay/);
  const dossier = path.join(j.affaire, "Courriels");
  const noms = fs.readdirSync(dossier).sort();
  assert.ok(noms.some(n => /^courriel .*\.eml$/.test(n)), noms.join(", "));
  assert.ok(noms.includes("Facture ZORVAL.pdf") && noms.includes("Lettre de Jean Dupont été.txt"), noms.join(", "));
  assert.ok(fs.readFileSync(path.join(dossier, "Facture ZORVAL.pdf")).equals(imap.PDF), "pièce jointe décodée à l'identique");
  assert.match(imp.texte, /F\d+ · Courriels \/ Lettre de \[PERSONNE_\d\] (…|été)\.txt/);

  // Par Message-ID
  const parId = await client.outil("importer_courriel", { courriel: "<ancien@exemple.fr>" });
  assert.match(parId.texte, /avec 0 pièce\(s\) jointe\(s\)/);
  assert.equal((await client.outil("importer_courriel", { courriel: "<inconnu@exemple.fr>" })).erreur, true);

  // Boîte jamais modifiée : EXAMINE et BODY.PEEK seulement, mot de passe jamais journalisé
  assert.ok(imap.commandes.every(c => !/^(SELECT|STORE|COPY|MOVE|EXPUNGE|UID STORE)/i.test(c) && (!/FETCH/i.test(c) || /PEEK/i.test(c))), imap.commandes.join(" | "));
  assert.ok(imap.commandes.some(c => /^EXAMINE "INBOX"/.test(c)));
  assert.ok(!fs.readFileSync(j.journal, "utf8").includes("secret"));
  aucuneFuite(client, j);
});

test("OCR du moteur local : page scannée (image JPEG) lue par Tesseract ; Tesseract absent signalé", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-ocr-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fauxTesseract = path.join(tmp, "faux-tesseract.js");
  fs.writeFileSync(fauxTesseract, "if (process.argv.includes('--version')) { console.log('tesseract 5'); process.exit(0); }\n" +
    "const fs = require('fs'); const img = fs.readFileSync(process.argv[2]);\n" +
    "if (img[0] !== 0xff || img[1] !== 0xd8) process.exit(3);\nprocess.stdout.write('Madame Marie Martin, née le 3 mars 1975.\\n');\n", "utf8");
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"),
    jpeg, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
  const tables = path.join(tmp, "tables");
  const { client, j } = await contexte(t, { env: { ANON_MOTEUR_LOCAL: "1", ANON_OLLAMA_DESACTIVE: "1", ANON_TABLES: tables, ANON_DPAPI: "0", ANON_TESSERACT: fauxTesseract } });
  fs.writeFileSync(path.join(j.affaire, "scan.pdf"), pdf);
  await client.outil("choisir_dossier", { chemin: j.affaire });
  const r = await client.outil("lire_fichier_anonymise", { fichier: "scan.pdf" });
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /texte obtenu par reconnaissance de caractères \(OCR\) sur 1 page/);
  assert.match(r.texte, /Madame \[PERSONNE_1\], née le \[DATE_NAISSANCE_1\]/);

  const sans = await contexte(t, { env: { ANON_MOTEUR_LOCAL: "1", ANON_OLLAMA_DESACTIVE: "1", ANON_TABLES: path.join(tmp, "t2"), ANON_DPAPI: "0",
    ANON_TESSERACT: path.join(tmp, "absent.exe") } });
  fs.writeFileSync(path.join(sans.j.affaire, "scan.pdf"), pdf);
  await sans.client.outil("choisir_dossier", { chemin: sans.j.affaire });
  const r2 = await sans.client.outil("lire_fichier_anonymise", { fichier: "scan.pdf" });
  assert.match(r2.texte, /l'OCR n'est pas installé sur ce poste\. Installez Tesseract/);
});

test("pièces jointes : noms encodés (RFC 2231, mots encodés), courriel joint, corps ignoré", () => {
  const { piecesJointes } = require("../server/courriel");
  const { creerFichiers } = require("../server/moteur/fichiers");
  const F = creerFichiers({ lireZip: ext.lireZip, contenuEntree: ext.contenuEntree, ecrireZip: ext.ecrireZip, creerEntree: ext.creerEntree });
  const brut = "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\ncorps\r\n" +
    "--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment;\r\n filename*0*=UTF-8''Re%C3%A7u%20;\r\n filename*1*=n%C2%B01.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nQUJD\r\n" +
    "--x\r\nContent-Type: image/png; name=\"=?UTF-8?B?w6l0w6kucG5n?=\"\r\nContent-Transfer-Encoding: base64\r\n\r\nREVG\r\n" +
    "--x\r\nContent-Type: message/rfc822\r\n\r\nSubject: joint\r\n\r\ncorps joint\r\n--x--\r\n";
  const p = piecesJointes(brut, F);
  assert.deepEqual(p.map(x => x.nom), ["Reçu n°1.pdf", "été.png", "courriel joint.eml"]);
  assert.equal(p[0].octets.toString(), "ABC");
  assert.equal(p[1].octets.toString(), "DEF");
});

// --------------------------------------------------------------------------- raccourcis Windows (version 1.7.0)
const attendre = async (cond, ms = 6000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
const lire = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const notifs = journal => lire(journal).split("\n").filter(l => l.startsWith("NOTIF\t")).map(l => {
  const p = l.split("\t");
  return { titre: Buffer.from(p[1], "base64").toString("utf8"), texte: Buffer.from(p[2], "base64").toString("utf8"), alerte: p[3] === "1" };
});

test("raccourcis : Coller pseudonymisé puis Remettre les vrais noms, avec les marqueurs du dossier courant", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-raccourcis-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const declencheur = path.join(tmp, "declencheur.txt"), journalEcouteur = path.join(tmp, "ecouteur.log");
  const { client, j, faux } = await contexte(t, { env: {
    ANON_RACCOURCIS: "true", ANON_ECOUTEUR_COMMANDE: JSON.stringify([process.execPath, path.join(__dirname, "faux-ecouteur.js")]),
    ANON_FAUX_DECLENCHEUR: declencheur, ANON_FAUX_JOURNAL: journalEcouteur, ANON_ENVOIS: path.join(tmp, "envois"), ANON_SENDTO: "0",
  } });
  await client.outil("choisir_dossier", { chemin: j.affaire });
  const lecture = await client.outil("lire_fichier_anonymise", { fichier: "Note Dupont.txt" });
  const ref = /« (D-[0-9a-f]{8}) »/.exec(lecture.texte)[1];
  const M = v => faux.dossiers.get(ref).entites.get(v).marqueur;

  // Coller pseudonymisé : le presse-papiers est remplacé par la version pseudonymisée, puis l'écouteur colle
  const original = "Bonjour Maître, je suis Jean Dupont (jean.dupont@exemple.fr) et ZORVAL me doit 1 200 €.";
  fs.writeFileSync(j.pressePapiers, original, "utf8");
  fs.writeFileSync(declencheur, "COLLER", "utf8");
  assert.ok(await attendre(() => /^COLLER$/m.test(lire(journalEcouteur))), "l'écouteur a reçu l'ordre de coller");
  assert.equal(lire(j.pressePapiers), `Bonjour Maître, je suis ${M("Jean Dupont")} (${M("jean.dupont@exemple.fr")}) et ${M("ZORVAL")} me doit 1 200 €.`,
    "mêmes marqueurs que les pièces du dossier courant");
  assert.ok(await attendre(() => notifs(journalEcouteur).length === 1));
  assert.equal(notifs(journalEcouteur)[0].titre, "Texte pseudonymisé collé");
  assert.match(notifs(journalEcouteur)[0].texte, /3 donnée\(s\) masquée\(s\), dossier « /);

  // Remettre les vrais noms : texte à marqueurs copié depuis la réponse de Claude
  fs.writeFileSync(j.pressePapiers, `Cher **${M("Jean Dupont")}**, nous écrivons à ${M("ZORVAL")}. [PERSONNE_9]`, "utf8");
  fs.writeFileSync(declencheur, "REID", "utf8");
  assert.ok(await attendre(() => notifs(journalEcouteur).length === 2));
  assert.equal(lire(j.pressePapiers), "Cher Jean Dupont, nous écrivons à ZORVAL. [PERSONNE_9]");
  assert.equal(notifs(journalEcouteur)[1].titre, "Vrais noms remis dans le presse-papiers");
  assert.match(notifs(journalEcouteur)[1].texte, /2 marqueur\(s\) remplacé\(s\).*1 marqueur\(s\) inconnu/);
  assert.equal(lire(journalEcouteur).match(/^COLLER$/gm).length, 1, "« vrais noms » ne colle rien tout seul");

  // Cas d'erreur : presse-papiers vide, texte sans marqueur
  fs.writeFileSync(j.pressePapiers, "", "utf8");
  fs.writeFileSync(declencheur, "COLLER", "utf8");
  assert.ok(await attendre(() => notifs(journalEcouteur).length === 3));
  assert.match(notifs(journalEcouteur)[2].texte, /ne contient pas de texte/);
  fs.writeFileSync(j.pressePapiers, "Aucun marqueur ici.", "utf8");
  fs.writeFileSync(declencheur, "REID", "utf8");
  assert.ok(await attendre(() => notifs(journalEcouteur).length === 4));
  assert.match(notifs(journalEcouteur)[3].texte, /aucun marqueur/);
  assert.equal(lire(j.pressePapiers), "Aucun marqueur ici.", "presse-papiers inchangé");

  const journalOps = lire(j.journal);
  assert.ok(/raccourci_coller/.test(journalOps) && /raccourci_reidentifier/.test(journalOps) && !/Dupont|ZORVAL/.test(journalOps), "journal sans valeur");
  aucuneFuite(client, j);
});

test("« Envoyer vers » : copie pseudonymisée créée à côté du fichier, nom lui-même pseudonymisé ; demandes anciennes ignorées", async t => {
  const envois = fs.mkdtempSync(path.join(os.tmpdir(), "anon-envois-"));
  t.after(() => fs.rmSync(envois, { recursive: true, force: true }));
  const { client, j, faux } = await contexte(t, { env: {
    ANON_RACCOURCIS: "1", ANON_ECOUTEUR_COMMANDE: JSON.stringify([process.execPath, "-e", "process.stdin.resume()"]),
    ANON_ENVOIS: envois, ANON_SENDTO: "0",
  } });
  await client.outil("choisir_dossier", { chemin: j.affaire });
  const source = path.join(j.affaire, "Courrier Dupont.txt");
  fs.writeFileSync(source, "Courrier de Jean Dupont à ZORVAL & Fils.", "utf8");
  const demander = (id, fichiers, quand = Date.now()) => fs.writeFileSync(path.join(envois, `${id}.json`), JSON.stringify({ id, quand, fichiers }), "utf8");

  demander("a".repeat(32), [source, path.join(j.affaire, "absent.pdf"), path.join(j.affaire, "tableau.xlsx")]);
  const resultat = path.join(envois, "a".repeat(32) + ".resultat.json");
  assert.ok(await attendre(() => fs.existsSync(resultat), 8000), "demande traitée");
  const r = JSON.parse(fs.readFileSync(resultat, "utf8"));
  assert.equal(r.sorties.length, 1);
  assert.equal(path.dirname(r.sorties[0]), fs.realpathSync(j.affaire), "copie à côté de l'original");
  assert.match(path.basename(r.sorties[0]), /^Courrier PERSONNE_\d+ \(pseudonymisé\)\.txt$/, path.basename(r.sorties[0]));
  const ref = [...faux.dossiers.keys()].find(k => k.startsWith("D-"));
  const M = v => faux.dossiers.get(ref).entites.get(v).marqueur;
  assert.equal(fs.readFileSync(r.sorties[0], "utf8"), `Courrier de ${M("Jean Dupont")} à ${M("ZORVAL & Fils")}.`);
  assert.match(r.message, /1 copie\(s\) pseudonymisée\(s\) créée\(s\).*\n[\s\S]*absent\.pdf : fichier introuvable[\s\S]*tableau\.xlsx : format non pris en charge/);
  assert.ok(fs.existsSync(source), "original intact");

  demander("b".repeat(32), [source], Date.now() - 10 * 60000);
  await new Promise(res => setTimeout(res, 2500));
  assert.ok(!fs.existsSync(path.join(envois, "b".repeat(32) + ".resultat.json")), "une demande vieille de 10 minutes n'est pas traitée");
  aucuneFuite(client, j);
});

// --------------------------------------------------------------------------- 1.8.0 : dossier fluide
test("dossier courant repris sans fenêtre ; changer=true pour en désigner un autre ; mémoire réglable", async t => {
  const { client, j } = await contexte(t);
  await client.outil("choisir_dossier", { chemin: j.affaire });
  fs.writeFileSync(j.selection, j.autreAffaire, "utf8");
  const repris = await client.outil("choisir_dossier");
  assert.equal(repris.erreur, false);
  assert.match(repris.texte, /repris sans rien demander/);
  assert.match((await client.outil("lister_fichiers")).texte, /2 document/, "toujours le premier dossier : aucune fenêtre ouverte");
  const change = await client.outil("choisir_dossier", { changer: true });
  assert.equal(change.erreur, false, change.texte);
  assert.match((await client.outil("lister_fichiers")).texte, /1 document/, "fenêtre ouverte, autre dossier pris");
  aucuneFuite(client, j);
});

test("mémoire du dossier courant : durée réglée en heures", async t => {
  const { client, j, env } = await contexte(t, { env: { ANON_DUREE_DOSSIER_COURANT_H: "2" } });
  await client.outil("choisir_dossier", { chemin: j.affaire });
  client.fermer();
  const etat = JSON.parse(fs.readFileSync(j.etat, "utf8"));
  etat.courant.utilise_le = etat.courant.choisi_le = Date.now() - 3 * 3600 * 1000;
  fs.writeFileSync(j.etat, JSON.stringify(etat), "utf8");
  const c2 = new Client(env);
  t.after(() => c2.fermer());
  await c2.init();
  assert.match((await c2.outil("lister_fichiers")).texte, /Aucun dossier courant/);
});

test("importer_fichiers : les fichiers désignés définissent le dossier de travail, lus sur place ou copiés", async t => {
  const { client, j } = await contexte(t);
  // sans dossier courant : un fichier de l'arborescence du cabinet fixe le dossier, sans copie
  fs.writeFileSync(j.fichiers, path.join(j.autreAffaire, "Lettre Martin.txt"), "utf8");
  const r = await client.outil("importer_fichiers");
  assert.equal(r.erreur, false, r.texte);
  assert.match(r.texte, /Dossier de travail défini d'après les fichiers/);
  assert.match(r.texte, /1 fichier\(s\) lu\(s\) sur place, sans copie/);
  assert.deepEqual(fs.readdirSync(j.autreAffaire), ["Lettre Martin.txt"], "aucune copie");
  assert.match((await client.outil("lister_fichiers")).texte, /1 document/);
  // fichier d'une autre affaire du cabinet : bascule vers son dossier
  fs.writeFileSync(j.fichiers, path.join(j.affaire, "Note Dupont.txt"), "utf8");
  const r2 = await client.outil("importer_fichiers");
  assert.match(r2.texte, /Dossier de travail défini d'après les fichiers/);
  assert.match((await client.outil("lister_fichiers")).texte, /2 document/);
  // fichier venu d'ailleurs (Téléchargements) : copié dans le dossier courant
  const telecharge = path.join(j.telechargements, "Assignation Dupont.txt");
  fs.writeFileSync(telecharge, "Jean Dupont est assigné.", "utf8");
  fs.writeFileSync(j.fichiers, telecharge, "utf8");
  const r3 = await client.outil("importer_fichiers");
  assert.match(r3.texte, /1 fichier\(s\) copié\(s\)/, r3.texte);
  assert.doesNotMatch(r3.texte, /Dossier de travail défini/);
  assert.ok(fs.existsSync(path.join(j.affaire, "Assignation Dupont.txt")) && fs.existsSync(telecharge));
  aucuneFuite(client, j);
});

test("« Envoyer vers → travailler dans ce dossier » : dossier défini sans fenêtre ; la copie pseudonymisée suit le dossier du fichier", async t => {
  const envois = fs.mkdtempSync(path.join(os.tmpdir(), "anon-envois-"));
  t.after(() => fs.rmSync(envois, { recursive: true, force: true }));
  const { client, j } = await contexte(t, { env: {
    ANON_RACCOURCIS: "1", ANON_ECOUTEUR_COMMANDE: JSON.stringify([process.execPath, "-e", "process.stdin.resume()"]),
    ANON_ENVOIS: envois, ANON_SENDTO: "0",
  } });
  const demander = (id, mode, fichiers) => fs.writeFileSync(path.join(envois, `${id}.json`), JSON.stringify({ id, mode, quand: Date.now(), fichiers }), "utf8");
  const resultat = async id => {
    const p = path.join(envois, id + ".resultat.json");
    assert.ok(await attendre(() => fs.existsSync(p), 8000), "demande traitée");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  demander("c".repeat(32), "dossier", [j.autreAffaire]);
  const r = await resultat("c".repeat(32));
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Dossier de travail de Claude/);
  const liste = await client.outil("lister_fichiers");
  assert.match(liste.texte, /1 document/);
  assert.doesNotMatch(liste.texte, /Martin/, "le nom réel reste sur le poste");
  // un fichier désigné en mode dossier : son dossier est pris
  demander("d".repeat(32), "dossier", [path.join(j.affaire, "Note Dupont.txt")]);
  assert.equal((await resultat("d".repeat(32))).ok, true);
  assert.match((await client.outil("lister_fichiers")).texte, /2 document/);
  // copie pseudonymisée depuis l'autre affaire : le dossier courant suit
  demander("e".repeat(32), "copie", [path.join(j.autreAffaire, "Lettre Martin.txt")]);
  const r3 = await resultat("e".repeat(32));
  assert.equal(r3.sorties.length, 1);
  assert.match(r3.message, /Dossier de travail de Claude/);
  assert.match((await client.outil("lister_fichiers")).texte, /2 document/, "Lettre + sa copie pseudonymisée");
  aucuneFuite(client, j);
});

// --------------------------------------------------------------------------- fonctions internes
test("zip : aller-retour et lecture d'une archive stockée", () => {
  const entrees = [ext.creerEntree("mimetype", "application/vnd.oasis.opendocument.text"), ext.creerEntree("content.xml", "<a>é</a>".repeat(500))];
  const relu = ext.lireZip(ext.ecrireZip(entrees));
  assert.equal(relu[0].methode, 0);
  assert.equal(relu[1].methode, 8);
  assert.equal(ext.contenuEntree(relu[1]).toString("utf8"), "<a>é</a>".repeat(500));
  assert.equal(ext.crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.throws(() => ext.lireZip(Buffer.from("pas un zip du tout, vraiment pas")));
});

test("marqueurs : variantes tolérées, types inconnus ignorés", () => {
  const types = new Set(ext.TYPES_PAR_DEFAUT);
  const m = ext.trouverMarqueurs("[PERSONNE_1] [DATE_NAISSANCE_12] [PERSONNE 2] [SOCIETE-3] [DATE\\_NAISSANCE\\_4] [TODO_1] [x] [PERSONNE_]", types);
  assert.deepEqual(m.map(x => x.marqueur), ["[PERSONNE_1]", "[DATE_NAISSANCE_12]", "[PERSONNE_2]", "[SOCIETE_3]", "[DATE_NAISSANCE_4]"]);
});

test("noms : seuls les mots du vocabulaire documentaire restent visibles", () => {
  assert.equal(ext.filtrerMots("03 - Dossiers / [PERSONNE_1] c. Zorval"), "03 - Dossiers / [PERSONNE_1] c. …");
  assert.equal(ext.filtrerNomFichier("Contrat Zorval final.pdf"), "Contrat … final.pdf");
  assert.equal(ext.nettoyerSousDossier("Projets IA/2026"), ["Projets IA", "2026"].join(path.sep));
  assert.throws(() => ext.nettoyerSousDossier("../ailleurs"));
});
