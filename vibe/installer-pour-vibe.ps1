# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat (GNU AGPL v3 ou ultérieure)
# Installe l'Anonymiseur (cabinet) dans Mistral Vibe (Vibe Desktop, sessions locales, et Vibe en ligne de commande) :
#  1. copie l'extension sur le poste ;
#  2. réglages dans une fenêtre locale (clé d'API chiffrée par Windows, jamais écrite en clair) ;
#  3. déclare l'extension dans la configuration de Vibe (sauvegarde préalable, autres entrées intactes) ;
#  4. crée l'agent « Anonymiseur (cabinet) », limité aux seuls outils de l'extension.
# Options : -Reglages (rouvrir seulement la fenêtre des réglages), -Desinstaller.
param(
  [switch]$Reglages,
  [switch]$Desinstaller,
  [switch]$SansFenetre,
  [switch]$Silencieux,
  [string]$DossierVibe = (Join-Path $env:USERPROFILE '.vibe'),
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'AnonymiseurCabinet\vibe'),
  [string]$ReglagesClaude = (Join-Path $env:APPDATA 'Claude\Claude Extensions Settings\local.mcpb.timo-rainio-avocat.anonymiseur-cabinet.json')
)
$ErrorActionPreference = 'Stop'
$NOM = 'anonymiseur'
$source = Split-Path -Parent $PSScriptRoot
$fichierReglages = Join-Path $Destination 'reglages.json'
$utf8 = New-Object Text.UTF8Encoding $false

function Dire($texte) {
  if ($Silencieux) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.WriteLine($texte); return }
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($texte, 'Anonymiseur (cabinet) pour Mistral Vibe')
}
function EcrireTexte($chemin, $texte) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $chemin) | Out-Null
  [IO.File]::WriteAllText($chemin, $texte, $utf8)
}
function TomlChaine($s) {
  if ($s -notmatch "'") { return "'" + $s + "'" }
  return '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"'
}
function Chiffrer($texte) {
  Add-Type -AssemblyName System.Security
  $b = [Text.Encoding]::UTF8.GetBytes($texte)
  return [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}

# --- Configuration de Vibe : retirer puis (ré)écrire notre entrée, sans toucher aux autres -------------------------
function RetirerEntree($lignes) {
  $garde = New-Object System.Collections.Generic.List[string]
  $i = 0
  while ($i -lt $lignes.Count) {
    if ($lignes[$i] -match '^\s*\[\[mcp_servers\]\]\s*$') {
      $j = $i + 1
      while ($j -lt $lignes.Count -and $lignes[$j] -notmatch '^\s*\[') { $j++ }
      $bloc = $lignes[$i..($j - 1)]
      if ($bloc -match ('^\s*name\s*=\s*["'']' + $NOM + '["'']\s*$')) {
        while ($garde.Count -and $garde[$garde.Count - 1] -match '^\s*(# Anonymiseur \(cabinet\).*)?$') { $garde.RemoveAt($garde.Count - 1) }
        $i = $j; continue
      }
    }
    $garde.Add($lignes[$i]); $i++
  }
  return ,$garde
}
function MettreAJourConfigVibe($ajouter) {
  $config = Join-Path $DossierVibe 'config.toml'
  $brut = ''
  if (Test-Path -LiteralPath $config) {
    $brut = [IO.File]::ReadAllText($config)
    Copy-Item -LiteralPath $config -Destination ($config + '.avant-anonymiseur') -Force
  }
  $nl = if ($brut.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lignes = RetirerEntree ([string[]]($brut -split '\r?\n'))
  while ($lignes.Count -and $lignes[$lignes.Count - 1] -eq '') { $lignes.RemoveAt($lignes.Count - 1) }
  if ($ajouter) {
    $node = (Get-Command node -ErrorAction Stop).Source
    $index = Join-Path $Destination 'extension\server\index.js'
    if ($lignes.Count) { $lignes.Add('') }
    foreach ($l in @(
      '# Anonymiseur (cabinet) : pseudonymisation des dossiers clients (ajouté par installer-pour-vibe)',
      '[[mcp_servers]]',
      ('name = "' + $NOM + '"'),
      'transport = "stdio"',
      ('command = ' + (TomlChaine $node)),
      ('args = [' + (TomlChaine $index) + ']'),
      ('env = { "ANON_REGLAGES" = ' + (TomlChaine $fichierReglages) + ' }'),
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 600')) { $lignes.Add($l) }
  }
  New-Item -ItemType Directory -Force -Path $DossierVibe | Out-Null
  [IO.File]::WriteAllText($config, (($lignes -join $nl) + $nl), $utf8)
}

# --- Agent dédié : seuls les outils de l'extension -----------------------------------------------------------------
function EcrireAgent {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $consignes =& (Get-Command node).Source (Join-Path $Destination 'extension\server\index.js') --consignes-agent
  EcrireTexte (Join-Path $DossierVibe "prompts\$NOM.md") (($consignes -join "`n") + "`n")
  $lecture = @('etat_anonymiseur', 'choisir_dossier', 'lister_fichiers', 'lire_fichier_anonymise', 'entites_du_dossier', 'lister_modeles')
  $t = @(
    '# Agent créé par installer-pour-vibe (Anonymiseur cabinet) : il ne dispose que des outils de l''extension,',
    '# aucun accès direct aux fichiers, aux commandes ni au Web : les pièces ne lui parviennent que pseudonymisées.',
    'agent_type = "agent"',
    'display_name = "Anonymiseur (cabinet)"',
    'description = "Dossiers clients : seuls les outils de pseudonymisation sont accessibles."',
    'safety = "safe"',
    ('system_prompt_id = "' + $NOM + '"'),
    ('enabled_tools = ["' + $NOM + '_*"]'))
  foreach ($o in $lecture) { $t += ''; $t += ('[tools.' + $NOM + '_' + $o + ']'); $t += 'permission = "always"' }
  EcrireTexte (Join-Path $DossierVibe "agents\$NOM.toml") (($t -join "`n") + "`n")
}

# --- Réglages ------------------------------------------------------------------------------------------------------
function LireReglages {
  $r = [ordered]@{}
  if (Test-Path -LiteralPath $fichierReglages) {
    (Get-Content -LiteralPath $fichierReglages -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $r[$_.Name] = $_.Value }
    return $r
  }
  # Première installation : reprendre les réglages NON secrets de l'extension Claude Desktop, s'il y en a
  $manifeste = Join-Path $source 'manifest.json'
  if ((Test-Path -LiteralPath $ReglagesClaude) -and (Test-Path -LiteralPath $manifeste)) {
    try {
      $m = Get-Content -LiteralPath $manifeste -Raw -Encoding UTF8 | ConvertFrom-Json
      $u = (Get-Content -LiteralPath $ReglagesClaude -Raw -Encoding UTF8 | ConvertFrom-Json).userConfig
      foreach ($p in $m.server.mcp_config.env.PSObject.Properties) {
        if ($p.Value -match '^\$\{user_config\.(.+)\}$') {
          $champ = $Matches[1]
          $def = $m.user_config.$champ
          if ($def -and -not $def.sensitive -and $null -ne $u.$champ -and "$($u.$champ)" -ne '') { $r[$p.Name] = $u.$champ }
        }
      }
    } catch { }
  }
  if (-not $r.Contains('ANON_RACCOURCIS')) { $r['ANON_RACCOURCIS'] = $true }
  return $r
}
function EcrireReglages($r) {
  EcrireTexte $fichierReglages ($r | ConvertTo-Json -Depth 3)
}
function FenetreReglages($r) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Anonymiseur (cabinet) pour Mistral Vibe : réglages'
  $f.Size = New-Object System.Drawing.Size(640, 470); $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false
  $y = 15
  $champs = @{}
  function Ligne($libelle, $cle, $valeur, [switch]$Masque, [switch]$Parcourir) {
    $l = New-Object System.Windows.Forms.Label; $l.Text = $libelle; $l.Location = New-Object System.Drawing.Point(15, ($script:y + 3)); $l.Size = New-Object System.Drawing.Size(210, 20)
    $t = New-Object System.Windows.Forms.TextBox; $t.Location = New-Object System.Drawing.Point(230, $script:y); $t.Size = New-Object System.Drawing.Size(($(if ($Parcourir) { 290 } else { 380 })), 22)
    $t.Text = "$valeur"; if ($Masque) { $t.UseSystemPasswordChar = $true }
    $f.Controls.Add($l); $f.Controls.Add($t)
    if ($Parcourir) {
      $b = New-Object System.Windows.Forms.Button; $b.Text = 'Parcourir…'; $b.Location = New-Object System.Drawing.Point(525, ($script:y - 1)); $b.Size = New-Object System.Drawing.Size(85, 24)
      $b.Add_Click({ $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($t.Text) { $d.SelectedPath = $t.Text }; if ($d.ShowDialog() -eq 'OK') { $t.Text = $d.SelectedPath } }.GetNewClosure())
      $f.Controls.Add($b)
    }
    $champs[$cle] = $t
    $script:y += 34
  }
  $script:y = 15
  Ligne 'Adresse du serveur' 'ANON_SERVEUR' $(if ($r['ANON_SERVEUR']) { $r['ANON_SERVEUR'] } else { 'http://127.0.0.1:8765' })
  Ligne 'Clé d''API du serveur' 'ANON_CLE' '' -Masque
  $aide = New-Object System.Windows.Forms.Label; $aide.Location = New-Object System.Drawing.Point(230, ($script:y - 8)); $aide.Size = New-Object System.Drawing.Size(390, 18)
  $aide.Text = $(if ($r['ANON_CLE']) { 'Laisser vide pour garder la clé déjà enregistrée.' } else { 'Chiffrée par Windows, jamais écrite en clair.' }); $aide.ForeColor = 'Gray'
  $f.Controls.Add($aide); $script:y += 14
  $local = New-Object System.Windows.Forms.CheckBox; $local.Text = 'Moteur local (détection sur ce poste, sans serveur)'; $local.Location = New-Object System.Drawing.Point(230, $script:y); $local.Size = New-Object System.Drawing.Size(390, 22)
  $local.Checked = ("$($r['ANON_MOTEUR_LOCAL'])" -match '^(1|true|oui|yes)$'); $f.Controls.Add($local); $script:y += 32
  Ligne 'Modèle Ollama (moteur local)' 'ANON_OLLAMA_MODELE' $(if ($r['ANON_OLLAMA_MODELE']) { $r['ANON_OLLAMA_MODELE'] } else { 'ministral-3:3b' })
  Ligne 'Dossier racine des affaires' 'ANON_DOSSIER_TRAVAIL' $r['ANON_DOSSIER_TRAVAIL'] -Parcourir
  Ligne 'Dossier des modèles Word' 'ANON_DOSSIER_MODELES' $r['ANON_DOSSIER_MODELES'] -Parcourir
  $rac = New-Object System.Windows.Forms.CheckBox; $rac.Text = 'Raccourcis Windows et « Envoyer vers »'; $rac.Location = New-Object System.Drawing.Point(230, $script:y); $rac.Size = New-Object System.Drawing.Size(390, 22)
  $rac.Checked = ("$($r['ANON_RACCOURCIS'])" -match '^(1|true|oui|yes)$'); $f.Controls.Add($rac); $script:y += 40
  $ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Enregistrer'; $ok.Location = New-Object System.Drawing.Point(410, $script:y); $ok.Size = New-Object System.Drawing.Size(100, 30); $ok.DialogResult = 'OK'
  $an = New-Object System.Windows.Forms.Button; $an.Text = 'Annuler'; $an.Location = New-Object System.Drawing.Point(515, $script:y); $an.Size = New-Object System.Drawing.Size(95, 30); $an.DialogResult = 'Cancel'
  $f.Controls.Add($ok); $f.Controls.Add($an); $f.AcceptButton = $ok; $f.CancelButton = $an
  if ($f.ShowDialog() -ne 'OK') { return $false }
  foreach ($cle in @('ANON_SERVEUR', 'ANON_OLLAMA_MODELE', 'ANON_DOSSIER_TRAVAIL', 'ANON_DOSSIER_MODELES')) {
    $v = $champs[$cle].Text.Trim()
    if ($v) { $r[$cle] = $v } elseif ($r.Contains($cle)) { $r.Remove($cle) }
  }
  if ($champs['ANON_CLE'].Text) { $r['ANON_CLE'] = @{ dpapi = (Chiffrer $champs['ANON_CLE'].Text) } }
  $r['ANON_MOTEUR_LOCAL'] = $local.Checked
  $r['ANON_RACCOURCIS'] = $rac.Checked
  return $true
}

# --- Déroulement ---------------------------------------------------------------------------------------------------
try {
  if ($Desinstaller) {
    MettreAJourConfigVibe $false
    foreach ($p in @("agents\$NOM.toml", "prompts\$NOM.md")) { Remove-Item -LiteralPath (Join-Path $DossierVibe $p) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $Destination 'extension') -Recurse -Force -ErrorAction SilentlyContinue
    Dire "L'Anonymiseur est retiré de Mistral Vibe. Vos réglages et vos tables de correspondance sont conservés sur le poste."
    exit 0
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Dire "Node.js est nécessaire (Vibe ne le fournit pas, contrairement à Claude Desktop).`n`nInstallez la version LTS depuis https://nodejs.org puis relancez cet installateur."
    exit 1
  }
  $r = LireReglages
  if (-not $SansFenetre) {
    if (-not (FenetreReglages $r)) { Dire 'Installation annulée : rien n''a été modifié.'; exit 1 }
  } else {
    if ($env:ANON_INSTALL_SERVEUR) { $r['ANON_SERVEUR'] = $env:ANON_INSTALL_SERVEUR }
    if ($env:ANON_INSTALL_RACINE) { $r['ANON_DOSSIER_TRAVAIL'] = $env:ANON_INSTALL_RACINE }
    if ($env:ANON_INSTALL_CLE) { $r['ANON_CLE'] = @{ dpapi = (Chiffrer $env:ANON_INSTALL_CLE) } }
  }
  EcrireReglages $r
  if ($Reglages) { Dire 'Réglages enregistrés. Ils seront pris en compte à la prochaine session Vibe.'; exit 0 }
  $cible = Join-Path $Destination 'extension'
  New-Item -ItemType Directory -Force -Path $cible | Out-Null
  Remove-Item -LiteralPath (Join-Path $cible 'server') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath (Join-Path $source 'server') -Destination $cible -Recurse -Force
  MettreAJourConfigVibe $true
  EcrireAgent
  Dire ("L'Anonymiseur est installé dans Mistral Vibe.`n`n" +
    "1. Fermez puis rouvrez Vibe Desktop.`n" +
    "2. Dans une session locale, choisissez l'agent « Anonymiseur (cabinet) » : il n'a accès qu'aux outils de pseudonymisation.`n" +
    "3. Demandez par exemple : « Choisis le dossier de l'affaire ».`n`n" +
    "N'utilisez pas les autres agents de Vibe sur vos dossiers clients : ils peuvent lire les fichiers en clair.")
} catch {
  Dire ("L'installation a échoué : " + $_.Exception.Message)
  exit 1
}
