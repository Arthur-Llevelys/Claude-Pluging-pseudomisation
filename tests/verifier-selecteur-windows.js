/*
 * Vérification de la vraie fenêtre de sélection sous Windows (hors suite automatique).
 * Lancement : node tests/verifier-selecteur-windows.js
 *
 * Ouvre réellement la fenêtre sur l'écran, sur un dossier d'essai temporaire, puis la pilote :
 *  1. validation (bouton « Choisir ce dossier ») -> le dossier doit devenir le dossier courant ;
 *  2. fermeture sans choix -> le dossier courant précédent doit être conservé.
 * Le nom du dossier d'essai contient des accents et un tiret long pour contrôler l'encodage du chemin.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { creer: creerFauxServeur } = require("./faux-serveur");
process.env.ANON_MODE_TEST = "1"; // fonctions internes sans démarrage dans ce processus
const ext = require("../server/index.js");

if (process.platform !== "win32") { console.log("Vérification réservée à Windows."); process.exit(0); }

const PILOTE = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 150 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $h = [W]::FindWindow("#32770", $env:PILOTE_TITRE) }
if ($h -eq [IntPtr]::Zero) { Write-Output "FENETRE_ABSENTE"; exit 1 }
Start-Sleep -Milliseconds 1500
Write-Output ("FENETRE_TROUVEE visible=" + [W]::IsWindowVisible($h) + " premier_plan=" + ([W]::GetForegroundWindow() -eq $h))
if ($env:PILOTE_MODE -eq "valider") { [W]::PostMessage($h, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null }
else { [W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
`;

function piloter(mode) {
  return new Promise(resolve => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PILOTE, "utf16le").toString("base64")],
      { env: Object.assign({}, process.env, { PILOTE_TITRE: ext.TITRE_SELECTEUR, PILOTE_MODE: mode }), windowsHide: true });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    p.on("close", () => resolve(out.trim()));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-selecteur-"));
  const racine = path.join(tmp, "CABINET");
  const affaire = path.join(racine, "Affaire Éléonore – été 2026");
  fs.mkdirSync(affaire, { recursive: true });
  fs.writeFileSync(path.join(affaire, "note.txt"), "Jean Dupont écrit.", "utf8");
  const faux = creerFauxServeur();
  const url = await faux.demarrer();
  const env = Object.assign({}, process.env, {
    ANON_SERVEUR: url, ANON_CLE: faux.CLE, ANON_DOSSIER_TRAVAIL: racine, ANON_DOSSIER_SORTIE: "", ANON_ETAT: path.join(tmp, "etat.json"),
    ANON_ATTENTE_SELECTION_MS: "40000",
  });
  delete env.ANON_SELECTEUR_SIMULE;
  delete env.ANON_MODE_TEST;
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let tampon = "", suivant = 1;
  const attentes = new Map();
  let journal = "";
  proc.stderr.on("data", d => { journal += d; });
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
  const requete = (method, params) => new Promise(r => { const id = suivant++; attentes.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const outil = async (name, args) => (await requete("tools/call", { name, arguments: args || {} })).result.content[0].text;
  await requete("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verif", version: "0" } });

  let ok = true;
  const verifier = (cond, libelle) => { console.log((cond ? "OK   " : "ÉCHEC ") + libelle); if (!cond) ok = false; };

  // Le dossier d'essai devient le dossier courant : la fenêtre s'ouvrira dessus
  await outil("choisir_dossier", { chemin: affaire });

  console.log("--- 1. ouverture puis validation");
  let debut = Date.now();
  let [reponse, pilote] = await Promise.all([outil("choisir_dossier"), piloter("valider")]);
  console.log("pilote  :", pilote);
  console.log("réponse :", reponse.split("\n")[0], `(${Date.now() - debut} ms)`);
  verifier(/FENETRE_TROUVEE visible=True/.test(pilote), "la fenêtre s'est affichée à l'écran");
  verifier(/désigné par l'utilisateur dans la fenêtre de sélection/.test(reponse), "le dossier validé devient le dossier courant");
  const etat = JSON.parse(fs.readFileSync(path.join(tmp, "etat.json"), "utf8"));
  verifier(fs.realpathSync(etat.courant.chemin) === fs.realpathSync(affaire), "chemin avec accents et tiret long correctement transmis");
  verifier(!reponse.includes("Éléonore"), "le nom réel du dossier n'est pas communiqué à Claude");

  console.log("--- 2. ouverture puis fermeture sans choix");
  await new Promise(r => setTimeout(r, 300));
  // la sélection précédente a été consommée : ce nouvel appel rouvre bien une fenêtre
  debut = Date.now();
  [reponse, pilote] = await Promise.all([outil("choisir_dossier"), piloter("fermer")]);
  console.log("pilote  :", pilote);
  console.log("réponse :", reponse, `(${Date.now() - debut} ms)`);
  verifier(/FENETRE_TROUVEE visible=True/.test(pilote), "la fenêtre s'est affichée à l'écran");
  verifier(/sans choisir de dossier/.test(reponse) && /conservé/.test(reponse), "fermeture sans choix : dossier courant précédent conservé");

  const liste = await outil("lister_fichiers");
  verifier(/1 document/.test(liste), "lecture sur place après sélection");
  if (!ok) console.log("journal de l'extension :", journal.slice(-600));

  proc.stdin.end(); proc.kill();
  await faux.arreter();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? "\nFenêtre de sélection : vérification réussie." : "\nFenêtre de sélection : au moins un contrôle a échoué.");
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
