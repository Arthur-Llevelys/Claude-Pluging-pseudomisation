/*
 * Tests de l'adaptation à Mistral Vibe (1.9.0) : réglages lus dans un fichier local, installateur Windows
 * (configuration de Vibe, agent dédié, clé chiffrée par DPAPI), démarrage tel que Vibe le fait, désinstallation.
 * Lancement : node --test tests/vibe.test.js — tout se passe dans des dossiers temporaires.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { creer: creerFauxServeur } = require("./faux-serveur");

const RACINE_PROJET = path.join(__dirname, "..");
const SCRIPT = path.join(RACINE_PROJET, "server", "index.js");
const INSTALLATEUR = path.join(RACINE_PROJET, "vibe", "installer-pour-vibe.ps1");
const PYTHON = path.join(RACINE_PROJET, ".venv-serveur", "Scripts", "python.exe");

function envPropre(sup) {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(e)) if (k.startsWith("ANON_")) delete e[k];
  return Object.assign(e, sup);
}
const executer = (cmd, args, env) => new Promise((res, rej) => execFile(cmd, args, { env, encoding: "utf8", windowsHide: true, timeout: 120000 },
  (err, stdout, stderr) => err ? rej(new Error(`${err.message}\n${stdout}\n${stderr}`)) : res(stdout)));

/** Démarre l'extension comme un client MCP le fait, et renvoie le texte d'etat_anonymiseur. */
async function etatVia(commande, args, env) {
  const proc = spawn(commande, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let tampon = "";
  const attentes = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const m = JSON.parse(tampon.slice(0, i)); tampon = tampon.slice(i + 1);
      if (attentes.has(m.id)) { attentes.get(m.id)(m); attentes.delete(m.id); }
    }
  });
  proc.stderr.on("data", () => {});
  let n = 1;
  const requete = (method, params) => new Promise(r => { const id = n++; attentes.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  try {
    await requete("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vibe-essai", version: "0" } });
    const r = await requete("tools/call", { name: "etat_anonymiseur", arguments: {} });
    return r.result.content[0].text;
  } finally { proc.stdin.end(); proc.kill(); }
}

test("réglages hors de Claude : fichier désigné par ANON_REGLAGES, variable d'environnement prioritaire", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-vibe-"));
  const faux = creerFauxServeur();
  const url = await faux.demarrer();
  t.after(async () => { await faux.arreter(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const reglages = path.join(tmp, "reglages.json");
  fs.writeFileSync(reglages, JSON.stringify({ ANON_SERVEUR: url, ANON_CLE: faux.CLE, ANON_DUREE_DOSSIER_COURANT_H: 48, ANON_MODE_TEST: "1", AUTRE: "x" }), "utf8");
  const base = { ANON_REGLAGES: reglages, ANON_ETAT: path.join(tmp, "etat", "etat.json"), ANON_JOURNAL: path.join(tmp, "journal.log"), ANON_RACCOURCIS: "0" };
  const etat = await etatVia(process.execPath, [SCRIPT], envPropre(base));
  assert.match(etat, new RegExp(`serveur joignable : ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(etat, /Clé d'API : acceptée/);
  // une variable déjà renseignée (comme le fait Claude Desktop) l'emporte sur le fichier
  const etat2 = await etatVia(process.execPath, [SCRIPT], envPropre(Object.assign({}, base, { ANON_CLE: "mauvaise-cle" })));
  assert.doesNotMatch(etat2, /Clé d'API : acceptée/);
  // consignes de l'agent dédié
  const consignes = await executer(process.execPath, [SCRIPT, "--consignes-agent"], envPropre({}));
  assert.match(consignes, /secret\s+professionnel/);
  assert.match(consignes, /choisir_dossier/);
});

test("installateur Vibe : configuration, agent dédié, clé chiffrée, démarrage, réinstallation, désinstallation", { skip: process.platform !== "win32" || !fs.existsSync(PYTHON) }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-vibe-inst-"));
  const faux = creerFauxServeur();
  const url = await faux.demarrer();
  t.after(async () => { await faux.arreter(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const dossierVibe = path.join(tmp, ".vibe");
  const destination = path.join(tmp, "AnonymiseurCabinet", "vibe");
  fs.mkdirSync(dossierVibe, { recursive: true });
  const configAvant = [
    'applied_migrations = ["a"]', "", "[[mcp_servers]]", 'name = "vibe"', 'transport = "stdio"', 'command = "npx"', "args = [", '    "-y",', '    "paquet",', "]", "",
    "[tools.bash]", 'allowlist = ["git"]', "",
  ].join("\n");
  fs.writeFileSync(path.join(dossierVibe, "config.toml"), configAvant, "utf8");
  const racine = path.join(tmp, "CABINET");
  fs.mkdirSync(racine);
  const argsInst = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALLATEUR, "-SansFenetre", "-Silencieux",
    "-DossierVibe", dossierVibe, "-Destination", destination, "-ReglagesClaude", path.join(tmp, "absent.json")];
  const envInst = envPropre({ ANON_INSTALL_SERVEUR: url, ANON_INSTALL_CLE: faux.CLE, ANON_INSTALL_RACINE: racine });
  const sortie = await executer("powershell.exe", argsInst, envInst);
  assert.match(sortie, /installé dans Mistral Vibe/, sortie);

  const lireToml = async f => JSON.parse(await executer(PYTHON, ["-I", "-c",
    "import sys,json,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", f], envPropre({})));
  const config = await lireToml(path.join(dossierVibe, "config.toml"));
  assert.deepEqual(config.mcp_servers.map(s => s.name), ["vibe", "anonymiseur"]);
  assert.deepEqual(config.tools.bash.allowlist, ["git"], "réglages existants conservés");
  const notre = config.mcp_servers[1];
  assert.equal(notre.transport, "stdio");
  assert.ok(fs.existsSync(notre.command) && fs.existsSync(notre.args[0]), "node et l'extension copiée existent");
  assert.equal(notre.env.ANON_REGLAGES, path.join(destination, "reglages.json"));
  assert.ok(fs.existsSync(path.join(dossierVibe, "config.toml.avant-anonymiseur")), "sauvegarde");

  const agent = await lireToml(path.join(dossierVibe, "agents", "anonymiseur.toml"));
  assert.deepEqual(agent.enabled_tools, ["anonymiseur_*"], "l'agent n'a que les outils de l'extension");
  assert.equal(agent.system_prompt_id, "anonymiseur");
  assert.equal(agent.tools.anonymiseur_lire_fichier_anonymise.permission, "always");
  assert.equal(agent.tools.anonymiseur_enregistrer_document, undefined, "les écritures restent soumises à approbation");
  assert.match(fs.readFileSync(path.join(dossierVibe, "prompts", "anonymiseur.md"), "utf8"), /conservez les marqueurs/);

  const reglagesTexte = fs.readFileSync(notre.env.ANON_REGLAGES, "utf8");
  assert.ok(!reglagesTexte.includes(faux.CLE), "la clé n'est jamais écrite en clair");
  const reglages = JSON.parse(reglagesTexte.replace(/^﻿/, ""));
  assert.equal(typeof reglages.ANON_CLE.dpapi, "string");
  assert.equal(reglages.ANON_DOSSIER_TRAVAIL, racine);

  // Démarrage exactement comme Vibe : commande, arguments et environnement de la configuration
  const etat = await etatVia(notre.command, notre.args, envPropre(Object.assign({}, notre.env, {
    ANON_ETAT: path.join(tmp, "etat", "etat.json"), ANON_JOURNAL: path.join(tmp, "journal.log"), ANON_RACCOURCIS: "0", ANON_SENDTO: "0",
  })));
  assert.match(etat, /Clé d'API : acceptée/, "clé déchiffrée par DPAPI");
  assert.match(etat, /Extension 1\.9\.0/);

  // Réinstallation : une seule entrée, la clé déjà enregistrée est conservée
  await executer("powershell.exe", argsInst, envPropre({}));
  const config2 = await lireToml(path.join(dossierVibe, "config.toml"));
  assert.deepEqual(config2.mcp_servers.map(s => s.name), ["vibe", "anonymiseur"]);
  assert.equal(typeof JSON.parse(fs.readFileSync(notre.env.ANON_REGLAGES, "utf8").replace(/^﻿/, "")).ANON_CLE.dpapi, "string");

  // Désinstallation : notre entrée et l'agent retirés, le reste intact
  await executer("powershell.exe", argsInst.concat(["-Desinstaller"]), envPropre({}));
  const config3 = await lireToml(path.join(dossierVibe, "config.toml"));
  assert.deepEqual(config3.mcp_servers.map(s => s.name), ["vibe"]);
  assert.deepEqual(config3.tools.bash.allowlist, ["git"]);
  assert.ok(!fs.existsSync(path.join(dossierVibe, "agents", "anonymiseur.toml")));
  assert.ok(!fs.existsSync(path.join(destination, "extension")));
});
