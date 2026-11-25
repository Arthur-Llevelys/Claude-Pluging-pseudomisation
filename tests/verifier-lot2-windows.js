/*
 * Vérification sur le vrai Windows des éléments du lot 2 (hors suite automatique).
 * Lancement : node tests/verifier-lot2-windows.js
 *
 *  1. presse-papiers : écriture d'un long texte accentué, relecture identique, formats d'exclusion de
 *     l'historique présents ; le texte qui s'y trouvait avant est ensuite remis (texte seulement) ;
 *  2. fenêtre de saisie du libellé : ouverte, remplie au clavier par un pilote, valeur relue ;
 *  3. fenêtre de sélection de fichiers : ouverte, un fichier d'essai désigné au clavier, chemin relu ;
 *  4. les deux fenêtres fermées sans choix : annulation correctement signalée.
 * Le contenu du presse-papiers d'origine n'est jamais affiché.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
process.env.ANON_MODE_TEST = "1";
for (const v of ["ANON_PRESSE_PAPIERS_SIMULE", "ANON_SAISIE_SIMULEE", "ANON_SELECTEUR_FICHIERS_SIMULE"]) delete process.env[v];
const ext = require("../server/index.js");

if (process.platform !== "win32") { console.log("Vérification réservée à Windows."); process.exit(0); }

function powershell(script, env) {
  return new Promise(resolve => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { env: Object.assign({}, process.env, env || {}), windowsHide: true });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    p.on("close", () => resolve(out.trim()));
  });
}

// Pilote : attend la fenêtre portant ce titre, la met au premier plan, puis tape le texte (ou la ferme)
// Le pilote remplit la zone de texte par message Windows (WM_SETTEXT) puis valide (bouton « Valider » ou IDOK),
// sans clavier : Windows peut refuser le premier plan à un programme d'arrière-plan, ce qui rendait le clavier aléatoire.
const PILOTE = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool Rappel(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Rappel f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static IntPtr Enfant(IntPtr parent, string classe, string texte) {
    IntPtr trouve = IntPtr.Zero;
    EnumChildWindows(parent, (h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (c.ToString().ToUpperInvariant().Contains(classe) && (texte == null || t.ToString() == texte)) { trouve = h; return false; }
      return true;
    }, IntPtr.Zero);
    return trouve;
  }
}
"@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 150 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $h = [W]::FindWindow([NullString]::Value, $env:PILOTE_TITRE) }
if ($h -eq [IntPtr]::Zero) { Write-Output "FENETRE_ABSENTE"; exit 1 }
Start-Sleep -Milliseconds 1500
Write-Output ("FENETRE_TROUVEE premier_plan=" + ([W]::GetForegroundWindow() -eq $h))
if ($env:PILOTE_TEXTE) {
  $zone = [W]::Enfant($h, "EDIT", $null)
  if ($zone -eq [IntPtr]::Zero) { Write-Output "ZONE_ABSENTE"; [W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; exit 1 }
  [W]::SendMessage($zone, 0x000C, [IntPtr]::Zero, $env:PILOTE_TEXTE) | Out-Null
  Start-Sleep -Milliseconds 300
  $bouton = [W]::Enfant($h, "BUTTON", "Valider")
  if ($bouton -ne [IntPtr]::Zero) { [W]::SendMessage($bouton, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  else { [W]::PostMessage($h, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null }
} else { [W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
`;

let ok = true;
const verifier = (cond, libelle) => { console.log((cond ? "OK    " : "ÉCHEC ") + libelle); if (!cond) ok = false; };

async function avecPilote(titre, texte, action) {
  const pilote = powershell(PILOTE, { PILOTE_TITRE: titre, PILOTE_TEXTE: texte || "" });
  const [resultat, sortiePilote] = await Promise.all([action(), pilote]);
  return { resultat, sortiePilote };
}

async function main() {
  // 1. Presse-papiers
  const avant = await ext.lirePressePapiers();
  const essai = ("Ligne d'essai accentuée : élève, cœur, « guillemets » – tiret long, 10 000 € ; " + "x".repeat(60) + "\n").repeat(600);
  const ecrit = await ext.ecrirePressePapiers(essai);
  verifier(ecrit.ok, `texte de ${essai.length} caractères placé dans le presse-papiers (passé par l'entrée standard)`);
  const relu = await ext.lirePressePapiers();
  verifier(relu.texte === essai.replace(/\n/g, "\r\n"), "texte relu identique (fins de ligne Windows)");
  const formats = await powershell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join '|'");
  verifier(/ExcludeClipboardContentFromMonitorProcessing/.test(formats) && /CanIncludeInClipboardHistory/.test(formats) && /CanUploadToCloudClipboard/.test(formats),
    "formats d'exclusion de l'historique et de la synchronisation présents");
  if (avant.texte) await ext.ecrirePressePapiers(avant.texte.replace(/\r\n/g, "\n"));
  console.log("      presse-papiers d'origine " + (avant.texte ? "remis (texte)" : "vide ou sans texte : non restauré"));

  // 2. Fenêtre de saisie du libellé
  const s = await avecPilote(ext.TITRE_LIBELLE, "Essai éléonore c. société", () => ext.saisirLibelle("2026-01-01-01"));
  console.log("      pilote : " + (s.sortiePilote.match(/FENETRE_[^\r\n]*/) || ["?"])[0]);
  verifier(s.resultat.texte === "Essai éléonore c. société", "fenêtre de saisie : libellé saisi puis validé, relu à l'identique");
  const s2 = await avecPilote(ext.TITRE_LIBELLE, "", () => ext.saisirLibelle("2026-01-01-01"));
  verifier(!!s2.resultat.annule, "fenêtre de saisie fermée : annulation signalée");

  // 3. Fenêtre de sélection de fichiers
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anonlot2"));
  const fichier = path.join(tmp, "piece essai.txt");
  fs.writeFileSync(fichier, "essai", "utf8");
  const f = await avecPilote(ext.TITRE_FICHIERS, fichier, () => ext.ouvrirSelecteurFichiers(tmp));
  console.log("      pilote : " + (f.sortiePilote.match(/FENETRE_[^\r\n]*/) || ["?"])[0]);
  verifier(Array.isArray(f.resultat.chemins) && f.resultat.chemins.length === 1 && path.resolve(f.resultat.chemins[0]) === path.resolve(fichier),
    "fenêtre de sélection de fichiers : fichier désigné relu");
  const f2 = await avecPilote(ext.TITRE_FICHIERS, "", () => ext.ouvrirSelecteurFichiers(tmp));
  verifier(!!f2.resultat.annule, "fenêtre de sélection de fichiers fermée : annulation signalée");
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(ok ? "\nVérification Windows du lot 2 : réussie." : "\nVérification Windows du lot 2 : au moins un contrôle a échoué.");
  process.exit(ok ? 0 : 1);
}

// Garde-fou : une fenêtre qui ne s'afficherait pas ne doit pas bloquer la vérification
setTimeout(() => { console.log("ÉCHEC délai dépassé : une fenêtre ne s'est pas affichée ou n'a pas répondu."); process.exit(1); }, 120000).unref();
main().catch(e => { console.error(e); process.exit(1); });
