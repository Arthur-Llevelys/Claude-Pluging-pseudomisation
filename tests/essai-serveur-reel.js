/*
 * Essai de bout en bout sur le VRAI serveur d'anonymisation, avec des données fictives.
 *
 * La clé d'API n'est pas lisible dans les réglages de Claude Desktop (elle y est chiffrée) : fournissez-la
 * dans votre terminal, elle n'est ni affichée ni enregistrée.
 *
 *   PowerShell :  $env:ANON_CLE = "votre clé" ; node tests/essai-serveur-reel.js
 *
 * - l'adresse du serveur est lue dans les réglages de l'extension installée (ou dans ANON_SERVEUR) ;
 * - tout se passe dans un dossier temporaire, jamais dans vos dossiers ;
 * - tout est rangé sous une référence d'anonymisation d'essai, supprimée du serveur à la fin.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
process.env.ANON_MODE_TEST = "1"; // fonctions internes sans démarrage dans ce processus
const ext = require("../server/index.js");

const REGLAGES = path.join(process.env.APPDATA || "", "Claude", "Claude Extensions Settings", "local.mcpb.timo-rainio.anonymiseur-cabinet.json");
const FICTIFS = ["Vasseur", "BRUMEVAL", "helene.vasseur@exemple-fictif.fr"]; // doivent être masqués à l'aller, rétablis au retour
const NOTE =
  "Madame Hélène Vasseur, née le 3 mars 1975 à Annecy, demeurant 14 rue des Tanneurs, 69005 Lyon, " +
  "joignable à helene.vasseur@exemple-fictif.fr ou au 06 12 34 56 78, a saisi le conseil de prud'hommes contre son employeur, " +
  "la société BRUMEVAL SAS (SIREN 542 051 180). Son IBAN est FR76 3000 6000 0112 3456 7890 189. " +
  // (pas de forme abrégée du nom : « Madame Vasseur » serait restituée « Madame Hélène Vasseur », le serveur
  //  rattachant les formes courtes au nom complet — l'aller-retour ne serait plus identique au caractère près)
  "Elle réclame 12 500 euros au titre de l'article L. 1235-3 du code du travail.";

async function main() {
  let reglages = {};
  try { reglages = JSON.parse(fs.readFileSync(REGLAGES, "utf8")).userConfig || {}; } catch { /* réglages absents : variables d'environnement seules */ }
  const serveur = String(process.env.ANON_SERVEUR || reglages.serveur || "http://127.0.0.1:8765").replace(/\/+$/, "");
  // Moteur local : ni serveur ni clé ; la table de correspondance est créée dans le dossier temporaire
  const local = /^(1|true)$/i.test(process.env.ANON_MOTEUR_LOCAL || "");
  const cle = process.env.ANON_CLE || (local ? "inutile" : "");
  if (!cle) {
    console.log("Clé d'API absente. Dans PowerShell :  $env:ANON_CLE = \"votre clé\" ; node tests/essai-serveur-reel.js");
    console.log("(La clé enregistrée par Claude Desktop est chiffrée : ce script ne peut pas la lire.)");
    process.exit(2);
  }
  const api = (chemin, options = {}) => fetch(serveur + chemin, Object.assign({}, options, { headers: Object.assign({ "X-API-Key": cle }, options.headers || {}), signal: AbortSignal.timeout(60000) }));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-reel-"));
  const racine = path.join(tmp, "CABINET-ESSAI");
  const affaire = path.join(racine, "Essai extension 1.1.0 - Vasseur c. BRUMEVAL");
  fs.mkdirSync(path.join(affaire, "Pièces"), { recursive: true });
  fs.writeFileSync(path.join(affaire, "Note Vasseur.txt"), NOTE, "utf8");
  fs.writeFileSync(path.join(affaire, "Pièces", "Courrier BRUMEVAL.md"), "# Courrier\n\nLa société BRUMEVAL SAS répond à Madame Hélène Vasseur.\n", "utf8");

  const env = Object.assign({}, process.env, {
    ANON_TABLES: path.join(tmp, "tables"),
    ANON_SERVEUR: serveur, ANON_CLE: cle, ANON_DOSSIER_TRAVAIL: racine, ANON_DOSSIER_SORTIE: "", ANON_DOSSIER_DEFAUT: "general",
    ANON_ETAT: path.join(tmp, "etat.json"), ANON_SELECTEUR_SIMULE: path.join(tmp, "selection.txt"),
    ANON_SAISIE_SIMULEE: path.join(tmp, "saisie.txt"), ANON_PRESSE_PAPIERS_SIMULE: path.join(tmp, "presse-papiers.txt"),
    ANON_JOURNAL: path.join(tmp, "journal.log"), ANON_TELECHARGEMENTS: path.join(tmp, "Téléchargements"),
  });
  delete env.ANON_MODE_TEST;
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let tampon = "", suivant = 1;
  const attentes = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const msg = JSON.parse(tampon.slice(0, i));
      tampon = tampon.slice(i + 1);
      if (attentes.has(msg.id)) { attentes.get(msg.id)(msg); attentes.delete(msg.id); }
    }
  });
  proc.stderr.on("data", () => {});
  const requete = (method, params) => new Promise(r => { const id = suivant++; attentes.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const vues = [];
  const outil = async (name, args) => {
    const r = (await requete("tools/call", { name, arguments: args || {} })).result;
    vues.push(r.content[0].text);
    return { texte: r.content[0].text, erreur: !!r.isError };
  };

  let ok = true;
  let ref = null, ref2 = null;
  const verifier = (cond, libelle) => { console.log((cond ? "OK    " : "ÉCHEC ") + libelle); if (!cond) ok = false; };

  try {
    await requete("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "essai", version: "0" } });

    const etat = await outil("etat_anonymiseur");
    if (local) verifier(!etat.erreur && /moteur local/.test(etat.texte) && /règles \+ Ollama/.test(etat.texte), "moteur local actif, Ollama joignable avec le modèle");
    else verifier(!etat.erreur && /serveur joignable/.test(etat.texte) && /Clé d'API : acceptée/.test(etat.texte), "serveur réel joignable, clé acceptée");
    console.log("      " + etat.texte.split("\n").slice(0, 2).join(" | "));

    fs.writeFileSync(path.join(tmp, "selection.txt"), affaire, "utf8"); // équivaut au choix dans la fenêtre
    const choix = await outil("choisir_dossier");
    ref = (/(D-[0-9a-f]{8})/.exec(choix.texte) || [])[1];
    verifier(!choix.erreur && !!ref, `dossier d'essai choisi, référence d'anonymisation attribuée (${ref})`);
    console.log("      " + (choix.texte.split("\n")[1] || ""));

    const liste = await outil("lister_fichiers");
    verifier(/2 document\(s\)/.test(liste.texte), "les deux documents sont listés sur place, sous-dossier compris");
    for (const l of liste.texte.split("\n").filter(x => /^F\d/.test(x))) console.log("      " + l);

    const lecture = await outil("lire_fichier_anonymise", { fichier: "F1" });
    const pseudo = lecture.texte.split("────────────────────────\n")[1] || "";
    const marqueurs = [...new Set(pseudo.match(/\[[A-Z_]+_\d+\]/g) || [])];
    verifier(!lecture.erreur && marqueurs.length >= 3, `document lu pseudonymisé : ${marqueurs.length} marqueurs distincts`);
    console.log("      " + (lecture.texte.split("\n")[1] || ""));
    verifier(/L\. 1235-3/.test(pseudo) && /12 500 euros/.test(pseudo), "article de loi et montant restés lisibles");

    // Livrable : Claude réutilise les marqueurs ; le fichier doit arriver dans le dossier de l'affaire, ré-identifié
    const enr = await outil("enregistrer_document", { texte: "# Projet de conclusions\n\n" + pseudo + "\n\n- Demande : **12 500 euros**", nom_fichier: "projet-conclusions" });
    const docx = path.join(affaire, "projet-conclusions.docx");
    verifier(!enr.erreur && fs.existsSync(docx), "livrable enregistré directement dans le dossier de l'affaire");
    console.log("      " + enr.texte.split("\n").slice(0, 2).join(" | "));
    let texteDocx = "";
    try {
      const partie = ext.lireZip(fs.readFileSync(docx)).find(e => e.nom === "word/document.xml");
      texteDocx = ext.contenuEntree(partie).toString("utf8");
    } catch (e) { console.log("      lecture du docx impossible : " + e.message); }
    verifier(FICTIFS.every(v => texteDocx.includes(v)), "le Word contient les vraies données (noms, société, e-mail)");
    verifier(!/\[[A-Z_]+_\d+\]/.test(texteDocx), "plus aucun marqueur dans le Word");

    // Fichier Word créé « par Claude » avec des marqueurs, dont un découpé en trois morceaux comme le fait Word
    const travail = path.join(tmp, "sorties-claude");
    fs.mkdirSync(travail);
    const premier = marqueurs[0];
    const xmlTexte = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const reste = pseudo.replace(premier, "\u0000");
    const [avant, apres] = [reste.slice(0, reste.indexOf("\u0000")), reste.slice(reste.indexOf("\u0000") + 1)];
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>' +
      `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlTexte(avant)}</w:t></w:r><w:r><w:t>[</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>${premier.slice(1, -1)}</w:t></w:r>` +
      `<w:proofErr w:type="spellEnd"/><w:r><w:t xml:space="preserve">]${xmlTexte(apres)}</w:t></w:r></w:p></w:body></w:document>`;
    fs.writeFileSync(path.join(travail, "courrier-mis-en-forme.docx"), ext.ecrireZip([
      ext.creerEntree("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      ext.creerEntree("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      ext.creerEntree("word/document.xml", documentXml),
    ]));
    const reid = await outil("reidentifier_fichier", { fichier: path.join(travail, "courrier-mis-en-forme.docx"), sous_dossier: "Projets" });
    const produit = path.join(affaire, "Projets", "courrier-mis-en-forme.docx");
    verifier(!reid.erreur && fs.existsSync(produit), "fichier Word à marqueurs ré-identifié et rangé dans le dossier de l'affaire");
    console.log("      " + reid.texte.split("\n").slice(0, 2).join(" | "));
    let xmlProduit = "";
    try { xmlProduit = ext.contenuEntree(ext.lireZip(fs.readFileSync(produit)).find(e => e.nom === "word/document.xml")).toString("utf8"); } catch { /* vérifié ci-dessous */ }
    const texteProduit = xmlProduit.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    verifier(texteProduit === NOTE, "le texte du Word ré-identifié est identique au texte d'origine, marqueur découpé compris");
    verifier(/<w:rPr><w:b\/><\/w:rPr>/.test(xmlProduit), "mise en forme du Word conservée");

    const ent = await outil("entites_du_dossier");
    verifier(!ent.erreur && ent.texte.includes(ref), "marqueurs de l'affaire consultables sans valeurs réelles");

    // Lot 4 : exclure puis réintégrer un marqueur, ajouter une donnée vue en clair
    const lieu = (/\[LIEU_NAISSANCE_\d+\]/.exec(pseudo) || [])[0];
    const excl = await outil("corriger_entite", { action: "exclure", marqueurs: [lieu] });
    const relu = (await outil("lire_fichier_anonymise", { fichier: "F1" })).texte;
    const rein = await outil("corriger_entite", { action: "reinclure", marqueurs: [lieu] });
    verifier(!!lieu && !excl.erreur && /Annecy/.test(relu) && !rein.erreur, `corriger_entite : ${lieu} exclu (laissé en clair à la relecture) puis réintégré`);
    const ajout = await outil("corriger_entite", { action: "ajouter", type: "AUTRE", texte_vu: "conseil de prud'hommes" });
    vues.splice(vues.indexOf(relu), 1); // la relecture contient volontairement « Annecy » en clair
    verifier(!ajout.erreur && /\[AUTRE_1\]/.test(ajout.texte), "corriger_entite : donnée ajoutée, seul son marqueur est renvoyé");

    // Lot 2 : nouvelle affaire avec libellé saisi localement, courriel copié, réponse renvoyée au presse-papiers
    fs.writeFileSync(path.join(tmp, "saisie.txt"), "Vasseur c. BRUMEVAL", "utf8");
    const creation = await outil("creer_dossier_affaire", { saisir_libelle: true });
    ref2 = (/Référence d'anonymisation : (D-[0-9a-f]{8})/.exec(creation.texte) || [])[1];
    verifier(!creation.erreur && !!ref2 && fs.readdirSync(racine).some(n => n.endsWith(" - Vasseur c. BRUMEVAL")),
      `dossier d'affaire créé avec son libellé sur le poste, référence ${ref2} ouverte sur le serveur`);
    fs.writeFileSync(path.join(tmp, "presse-papiers.txt"), NOTE, "utf8");
    const pp = await outil("importer_presse_papiers");
    const ppTexte = pp.texte.split("────────────────────────\n")[1] || "";
    verifier(!pp.erreur && /\[PERSONNE_\d+\]/.test(ppTexte) && /\[IBAN_\d+\]/.test(ppTexte) && /Son IBAN est/.test(ppTexte),
      "courriel copié : seule sa version pseudonymisée est renvoyée");
    const pers = (/\[PERSONNE_\d+\]/.exec(ppTexte) || [""])[0];
    const sortiePP = await outil("reidentifier_vers_presse_papiers", { texte: `Chère **${pers}**,\nvotre IBAN [IBAN_1] est bien noté.` });
    const colle = fs.readFileSync(path.join(tmp, "presse-papiers.txt"), "utf8");
    verifier(!sortiePP.erreur && /Vasseur/.test(colle) && colle.includes("FR76 3000 6000 0112 3456 7890 189") && !/\[|\*\*/.test(colle),
      "réponse ré-identifiée placée dans le presse-papiers, sans marqueur ni Markdown");
    const journal = fs.readFileSync(path.join(tmp, "journal.log"), "utf8");
    verifier(!FICTIFS.some(v => journal.includes(v)) && !journal.includes(tmp.replace(/\\/g, "\\\\")), "journal local sans donnée ni chemin réels");

    const fuite = vues.find(s => FICTIFS.some(v => s.includes(v)) || s.includes(tmp));
    verifier(!fuite, "aucune donnée réelle ni chemin réel dans ce que Claude a reçu");
    if (fuite) console.log("      fuite dans : " + fuite.slice(0, 300));
  } catch (e) {
    ok = false;
    console.log("ÉCHEC exception : " + e.message);
  } finally {
    proc.stdin.end(); proc.kill();
    if (local) {
      const tables = path.join(tmp, "tables");
      const fichiers = fs.existsSync(tables) ? fs.readdirSync(tables) : [];
      const enClair = fichiers.some(n => FICTIFS.some(v => fs.readFileSync(path.join(tables, n), "utf8").includes(v)));
      const cleDat = fichiers.includes("cle.dat") ? JSON.parse(fs.readFileSync(path.join(tables, "cle.dat"), "utf8")).protection : "absente";
      verifier(fichiers.length >= 2 && !enClair, `table locale chiffrée (${fichiers.length - 1} affaire(s), aucune valeur en clair)`);
      verifier(process.platform !== "win32" || cleDat === "dpapi", `clé de la table protégée par Windows (DPAPI) : ${cleDat}`);
    }
    for (const r of local ? [] : [ref, ref2].filter(Boolean)) {
      try {
        await api(`/api/dossiers/${encodeURIComponent(r)}`, { method: "DELETE" });
        const restants = (await (await api("/api/dossiers")).json()).dossiers.map(d => d.id);
        verifier(!restants.includes(r), `référence d'essai ${r} supprimée du serveur`);
      } catch (e) { console.log("Nettoyage du serveur impossible : " + e.message); ok = false; }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(ok ? "\nEssai sur le serveur réel : réussi." : "\nEssai sur le serveur réel : au moins un contrôle a échoué.");
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
