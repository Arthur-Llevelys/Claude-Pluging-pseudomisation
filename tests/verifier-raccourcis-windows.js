/*
 * Vérification réelle, sous Windows, des raccourcis de la version 1.7.0 (hors suite automatique).
 * Lancement : node tests/verifier-raccourcis-windows.js
 *
 *  1. l'extension démarre l'écouteur de raccourcis (fenêtre invisible + icône de notification) ;
 *  2. une fenêtre d'essai avec une zone de texte s'ouvre ; le pilote appuie sur Ctrl+Alt+Maj+V :
 *     la zone doit recevoir la version pseudonymisée du texte copié ;
 *  3. Ctrl+Alt+Maj+R sur un texte à marqueurs : le presse-papiers doit contenir les vrais noms ;
 *  4. « Envoyer vers » : raccourci créé (dans un dossier temporaire), script lancé sur un fichier fictif.
 * Le texte du presse-papiers d'origine est remis à la fin. Données entièrement fictives.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
// Exécution non bloquante : le faux serveur d'anonymisation tourne dans ce même processus et doit pouvoir répondre
const executer = (cmd, args, envSup, ms = 120000) => new Promise(resolve => {
  const p = spawn(cmd, args, { env: Object.assign({}, process.env, envSup || {}), windowsHide: true });
  let out = "";
  p.stdout.on("data", d => { out += d; });
  p.stderr.on("data", () => {});
  const k = setTimeout(() => p.kill(), ms);
  p.on("close", () => { clearTimeout(k); resolve(out); });
});
const { creer: creerFauxServeur } = require("./faux-serveur");
process.env.ANON_MODE_TEST = "1";
for (const v of ["ANON_PRESSE_PAPIERS_SIMULE", "ANON_SAISIE_SIMULEE", "ANON_SELECTEUR_FICHIERS_SIMULE"]) delete process.env[v];
const ext = require("../server/index.js");
if (process.platform !== "win32") { console.log("Vérification réservée à Windows."); process.exit(0); }

let ok = true;
const verifier = (cond, libelle) => { console.log((cond ? "OK    " : "ÉCHEC ") + libelle); if (!cond) ok = false; };
const pause = ms => new Promise(r => setTimeout(r, ms));

const PILOTE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Raccourci(byte lettre) {
    byte[] mods = { 0x11, 0x12, 0x10 };
    foreach (byte m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
    keybd_event(lettre, 0, 0, UIntPtr.Zero); keybd_event(lettre, 0, 2, UIntPtr.Zero);
    Array.Reverse(mods);
    foreach (byte m in mods) keybd_event(m, 0, 2, UIntPtr.Zero);
  }
}
"@
if ($env:PILOTE_MODE -eq 'coller') {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Essai Anonymiseur - coller pseudonymisé'; $f.TopMost = $true; $f.Width = 520; $f.Height = 140; $f.StartPosition = 'CenterScreen'
  $t = New-Object System.Windows.Forms.TextBox; $t.Multiline = $true; $t.Dock = 'Fill'; $f.Controls.Add($t)
  $f.Show(); $f.Activate(); [K]::SetForegroundWindow($f.Handle) | Out-Null; $t.Focus() | Out-Null
  for ($i = 0; $i -lt 10; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  [K]::Raccourci(0x56)
  for ($i = 0; $i -lt 200 -and -not $t.Text; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  for ($i = 0; $i -lt 10; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  [Console]::Out.Write('TEXTE:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Text)))
  $f.Close()
} else { [K]::Raccourci(0x52); [Console]::Out.Write('ENVOYE') }
`;
const piloter = mode => executer("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
  Buffer.from(PILOTE, "utf16le").toString("base64")], { PILOTE_MODE: mode }, 60000);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-raccourcis-reel-"));
  const affaire = path.join(tmp, "CABINET", "Affaire essai");
  fs.mkdirSync(affaire, { recursive: true });
  const sendTo = path.join(tmp, "SendTo");
  fs.mkdirSync(sendTo);
  const faux = creerFauxServeur();
  const url = await faux.demarrer();
  const etat = path.join(tmp, "etat", "etat.json");
  const env = Object.assign({}, process.env, {
    ANON_SERVEUR: url, ANON_CLE: faux.CLE, ANON_DOSSIER_TRAVAIL: path.join(tmp, "CABINET"), ANON_ETAT: etat,
    ANON_RACCOURCIS: "true", ANON_ENVOIS: path.join(tmp, "envois"), ANON_SENDTO: sendTo, ANON_JOURNAL: path.join(tmp, "journal.log"),
  });
  delete env.ANON_MODE_TEST;
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let erreurs = "", tampon = "";
  const attentes = new Map();
  proc.stderr.on("data", d => { erreurs += d; });
  proc.stdout.on("data", d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const m = JSON.parse(tampon.slice(0, i)); tampon = tampon.slice(i + 1);
      if (attentes.has(m.id)) { attentes.get(m.id)(m); attentes.delete(m.id); }
    }
  });
  let n = 1;
  const requete = (method, params) => new Promise(r => { const id = n++; attentes.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const avant = await ext.lirePressePapiers();
  try {
    await requete("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "essai", version: "0" } });
    await requete("tools/call", { name: "choisir_dossier", arguments: { chemin: affaire } });
    for (let i = 0; i < 200 && !/PRET:/.test(erreurs); i++) await pause(100);
    verifier(/PRET:COLLER,REID/.test(erreurs), "écouteur démarré, deux raccourcis enregistrés" + (/OCCUPE/.test(erreurs) ? " (OCCUPÉS par une autre instance)" : ""));

    // 2. Coller pseudonymisé dans une vraie zone de texte
    await ext.ecrirePressePapiers("Courrier de Jean Dupont pour ZORVAL.");
    const sortie = await piloter("coller");
    const colle = (/TEXTE:([A-Za-z0-9+/=]*)/.exec(sortie) || [])[1];
    const texte = colle !== undefined ? Buffer.from(colle, "base64").toString("utf8") : "";
    verifier(/^Courrier de \[PERSONNE_\d+\] pour \[SOCIETE_\d+\]\.$/.test(texte.trim()), `Ctrl+Alt+Maj+V : version pseudonymisée collée dans la fenêtre (« ${texte.trim()} »)`);
    const marqueur = (/\[PERSONNE_\d+\]/.exec(texte) || ["[PERSONNE_1]"])[0];

    // 3. Remettre les vrais noms
    await ext.ecrirePressePapiers(`Pour ${marqueur}, merci.`);
    await piloter("reid");
    let lu = "";
    for (let i = 0; i < 60 && !/Jean Dupont/.test(lu); i++) { await pause(100); lu = (await ext.lirePressePapiers()).texte || ""; }
    verifier(lu.trim() === "Pour Jean Dupont, merci.", `Ctrl+Alt+Maj+R : vrais noms remis dans le presse-papiers (« ${lu.trim()} »)`);

    // 4. « Envoyer vers »
    const lien = path.join(sendTo, "Anonymiseur - copie pseudonymisée.lnk");
    verifier(fs.existsSync(lien), "raccourci « Envoyer vers » créé");
    const source = path.join(affaire, "Note Dupont.txt");
    fs.writeFileSync(source, "Jean Dupont écrit à ZORVAL & Fils.", "utf8");
    const script = path.join(path.dirname(etat), "envoyer-vers.ps1");
    const r = { stdout: await executer("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, source], { ANON_ENVOI_SILENCIEUX: "1" }) };
    const copies = fs.readdirSync(affaire).filter(f => /\(pseudonymisé\)\.txt$/.test(f));
    const contenu = copies.length ? fs.readFileSync(path.join(affaire, copies[0]), "utf8") : "";
    verifier(copies.length === 1 && /^\[PERSONNE_\d+\] écrit à \[SOCIETE_\d+\]\.$/.test(contenu) && /1 copie\(s\) pseudonymisée\(s\)/.test(r.stdout),
      `« Envoyer vers » : copie pseudonymisée créée (${copies[0] || "aucune"})`);

    // 5. « Envoyer vers → travailler dans ce dossier » (1.8.0)
    verifier(fs.existsSync(path.join(sendTo, "Anonymiseur - travailler dans ce dossier.lnk")), "raccourci « travailler dans ce dossier » créé");
    const autre = path.join(path.dirname(affaire), "Martin - licenciement");
    fs.mkdirSync(autre, { recursive: true });
    const r2 = await executer("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--dossier", autre], { ANON_ENVOI_SILENCIEUX: "1" });
    const courantApres = (JSON.parse(fs.readFileSync(etat, "utf8")).courant || {}).chemin;
    verifier(/Dossier de travail de Claude/.test(r2) && courantApres === fs.realpathSync(autre),
      "« travailler dans ce dossier » : dossier courant défini sans fenêtre");
  } catch (e) {
    ok = false;
    console.log("ÉCHEC exception : " + e.message);
  } finally {
    proc.stdin.end();
    await pause(800);
    proc.kill();
    if (avant.texte) await ext.ecrirePressePapiers(avant.texte.replace(/\r\n/g, "\n"));
    console.log("      presse-papiers d'origine " + (avant.texte ? "remis (texte)" : "vide ou sans texte : non restauré"));
    await faux.arreter();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!ok) console.log("Journal de l'extension :\n" + erreurs.split("\n").filter(l => /raccourci|envoi|Envoyer/i.test(l)).slice(-10).join("\n"));
  console.log(ok ? "\nVérification Windows des raccourcis : réussie." : "\nVérification Windows des raccourcis : au moins un contrôle a échoué.");
  process.exit(ok ? 0 : 1);
}
setTimeout(() => { console.log("ÉCHEC délai dépassé"); process.exit(1); }, 180000).unref();
main().catch(e => { console.error(e); process.exit(1); });
