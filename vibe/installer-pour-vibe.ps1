# AxiorHub Pseudonymisation Claude - Créée par Timo Rainio Avocat (GNU AGPL v3 ou ultérieure)
# Installe l'Anonymiseur (cabinet) dans Mistral Vibe (Vibe Desktop, sessions locales, et Vibe en ligne de commande) :
#  1. copie l'extension sur le poste ;
#  2. réglages dans une fenêtre locale (clé d'API chiffrée par Windows, jamais écrite en clair) ;
#  3. déclare l'extension dans la configuration de Vibe (sauvegarde préalable, autres entrées intactes) ;
#  4. crée l'agent « Anonymiseur (cabinet) » (Vibe en ligne de commande), limité aux seuls outils de l'extension ;
#  5. verrouille le dossier des affaires : toute session Vibe ouverte dans ce dossier (ou un sous-dossier) n'a que
#     les outils de l'extension, et Vibe n'envoie au modèle ni l'arborescence du dossier ni les détails du poste.
#     (Vibe Desktop ne propose que ses modes intégrés : c'est le dossier, et non l'agent, qui protège.)
# Options : -Reglages (rouvrir les réglages), -ChoisirDossier ou -Verrouiller <dossier> (verrouiller un autre
# dossier), -Deverrouiller <dossier>, -Desinstaller.
param(
  [switch]$Reglages,
  [switch]$Desinstaller,
  [switch]$ChoisirDossier,
  [string]$Verrouiller = '',
  [string]$Deverrouiller = '',
  [switch]$SansFenetre,
  [switch]$Silencieux,
  [string]$DossierVibe = (Join-Path $env:USERPROFILE '.vibe'),
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'AnonymiseurCabinet\vibe'),
  [string]$ReglagesClaude = (Join-Path $env:APPDATA 'Claude\Claude Extensions Settings\local.mcpb.timo-rainio-avocat.anonymiseur-cabinet.json'),
  [string]$DossierDemarrage = [Environment]::GetFolderPath('Startup')
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
function Dechiffrer($b64) {
  Add-Type -AssemblyName System.Security
  $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b64), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::UTF8.GetString($b)
}

# --- Extension en tâche de fond (HTTP local) : Vibe Desktop sous Windows ne sait pas lancer une extension locale -----
# Elle démarre à l'ouverture de session Windows (raccourci du dossier Démarrage), sans fenêtre, et n'écoute que
# 127.0.0.1 avec un jeton ; Vibe s'y connecte comme à un connecteur.
$lanceur = Join-Path $Destination 'lancer-anonymiseur.vbs'
$raccourciDemarrage = Join-Path $DossierDemarrage 'Anonymiseur pour Vibe.lnk'
function ArreterExtension {
  $motif = [regex]::Escape((Join-Path $Destination 'extension'))
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $motif } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function InstallerLancement {
  $node = (Get-Command node -ErrorAction Stop).Source
  $index = Join-Path $Destination 'extension\server\index.js'
  $vbs = @(
    "' Anonymiseur (cabinet) pour Mistral Vibe : lance l'extension en tâche de fond, sans fenêtre (installer-pour-vibe)",
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.Environment("Process")("ANON_REGLAGES") = "' + $fichierReglages.Replace('"', '""') + '"'),
    ('sh.Run """' + $node.Replace('"', '""') + '"" ""' + $index.Replace('"', '""') + '"" --http", 0, False'))
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  [IO.File]::WriteAllText($lanceur, (($vbs -join "`r`n") + "`r`n"), [Text.Encoding]::Unicode)
  New-Item -ItemType Directory -Force -Path $DossierDemarrage | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($raccourciDemarrage)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $s.Arguments = '"' + $lanceur + '"'
  $s.Description = 'Anonymiseur (cabinet) pour Mistral Vibe'
  $s.Save()
}
function LancerExtension($port) {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $lanceur + '"')
  for ($i = 0; $i -lt 60; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { Start-Sleep -Milliseconds 250 }
  }
  return $false
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
function MettreAJourConfigVibe($ajouter, $port, $jeton) {
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
    if ($lignes.Count) { $lignes.Add('') }
    foreach ($l in @(
      '# Anonymiseur (cabinet) : pseudonymisation des dossiers clients (ajouté par installer-pour-vibe)',
      '[[mcp_servers]]',
      ('name = "' + $NOM + '"'),
      'transport = "streamable-http"',
      ('url = "http://127.0.0.1:' + $port + '/mcp"'),
      ('headers = { "Authorization" = "Bearer ' + $jeton + '" }'),
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

# --- Dossiers verrouillés ------------------------------------------------------------------------------------------
$MARQUE = '# Anonymiseur (cabinet) : dossier verrouillé pour Mistral Vibe'
$listeVerrous = Join-Path $Destination 'dossiers-verrouilles.txt'
function TomlBasique($s) { return '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"' }
function ModifierConfiance($dossier, $ajouter) {
  # trusted_folders.toml : trusted = [...] / untrusted = [...] ; la configuration d'un dossier n'est lue que s'il est de confiance
  $f = Join-Path $DossierVibe 'trusted_folders.toml'
  $texte = if (Test-Path -LiteralPath $f) { [IO.File]::ReadAllText($f) } else { "trusted = []`nuntrusted = []`n" }
  foreach ($cle in @('trusted', 'untrusted')) {
    $m = [regex]::Match($texte, '(?ms)^' + $cle + '\s*=\s*\[(.*?)\]')
    $elements = New-Object System.Collections.Generic.List[string]
    if ($m.Success) {
      foreach ($e in [regex]::Matches($m.Groups[1].Value, '"((?:[^"\\]|\\.)*)"|''([^'']*)''')) {
        $v = if ($e.Groups[1].Success) { $e.Groups[1].Value -replace '\\(.)', '$1' } else { $e.Groups[2].Value }
        if ($v -ne $dossier) { $elements.Add($v) }
      }
    }
    if ($cle -eq 'trusted' -and $ajouter) { $elements.Add($dossier) }
    $ligne = $cle + ' = [' + (($elements | ForEach-Object { TomlBasique $_ }) -join ', ') + ']'
    $texte = if ($m.Success) { $texte.Substring(0, $m.Index) + $ligne + $texte.Substring($m.Index + $m.Length) } else { $texte.TrimEnd() + "`n" + $ligne + "`n" }
  }
  EcrireTexte $f $texte
}
function VerrouillerDossier($dossier) {
  $dossier = (Resolve-Path -LiteralPath $dossier).ProviderPath.TrimEnd('\')
  $config = Join-Path $dossier '.vibe\config.toml'
  if ((Test-Path -LiteralPath $config) -and -not ([IO.File]::ReadAllText($config).StartsWith($MARQUE))) {
    Copy-Item -LiteralPath $config -Destination ($config + '.avant-anonymiseur') -Force
  }
  $t = @($MARQUE,
    '# Toute session Vibe ouverte dans ce dossier ou un sous-dossier : seuls les outils de l''Anonymiseur, aucune',
    '# arborescence ni détail du poste envoyé au modèle. Ne pas modifier : retirer avec desinstaller-de-vibe.cmd.',
    ('system_prompt_id = "' + $NOM + '"'),
    'include_project_context = false',
    'include_prompt_detail = false',
    ('enabled_tools = ["' + $NOM + '_*"]'))
  foreach ($o in @('etat_anonymiseur', 'choisir_dossier', 'lister_fichiers', 'lire_fichier_anonymise', 'entites_du_dossier', 'lister_modeles')) {
    $t += ''; $t += ('[tools.' + $NOM + '_' + $o + ']'); $t += 'permission = "always"'
  }
  EcrireTexte $config (($t -join "`n") + "`n")
  ModifierConfiance $dossier $true
  $liste = @(); if (Test-Path -LiteralPath $listeVerrous) { $liste = @(Get-Content -LiteralPath $listeVerrous -Encoding UTF8 | Where-Object { $_ -and $_ -ne $dossier }) }
  EcrireTexte $listeVerrous ((@($liste) + $dossier) -join "`r`n")
  return $dossier
}
function DeverrouillerDossier($dossier) {
  $dossier = $dossier.TrimEnd('\')
  $config = Join-Path $dossier '.vibe\config.toml'
  if ((Test-Path -LiteralPath $config) -and [IO.File]::ReadAllText($config).StartsWith($MARQUE)) {
    Remove-Item -LiteralPath $config -Force
    if (Test-Path -LiteralPath ($config + '.avant-anonymiseur')) { Move-Item -LiteralPath ($config + '.avant-anonymiseur') -Destination $config }
    $d = Join-Path $dossier '.vibe'
    if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force }
  }
  ModifierConfiance $dossier $false
  if (Test-Path -LiteralPath $listeVerrous) {
    EcrireTexte $listeVerrous ((@(Get-Content -LiteralPath $listeVerrous -Encoding UTF8 | Where-Object { $_ -and $_ -ne $dossier })) -join "`r`n")
  }
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
  $rac.Checked = ("$($r['ANON_RACCOURCIS'])" -match '^(1|true|oui|yes)$'); $f.Controls.Add($rac); $script:y += 32
  $verr = New-Object System.Windows.Forms.CheckBox; $verr.Text = 'Verrouiller le dossier racine pour Vibe (recommandé)'; $verr.Location = New-Object System.Drawing.Point(230, $script:y); $verr.Size = New-Object System.Drawing.Size(390, 22)
  $verr.Checked = -not $Reglages; $f.Controls.Add($verr); $script:y += 40
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
  $script:verrouillerRacine = $verr.Checked
  return $true
}

# --- Déroulement ---------------------------------------------------------------------------------------------------
$script:verrouillerRacine = $false
try {
  if ($Deverrouiller) {
    DeverrouillerDossier $Deverrouiller
    Dire "Dossier déverrouillé : les sessions Vibe y retrouvent tous leurs outils."
    exit 0
  }
  if ($ChoisirDossier -or $Verrouiller) {
    if (-not (Test-Path -LiteralPath (Join-Path $DossierVibe "prompts\$NOM.md"))) { Dire 'Installez d''abord l''Anonymiseur avec installer-pour-vibe.cmd.'; exit 1 }
    if ($ChoisirDossier) {
      Add-Type -AssemblyName System.Windows.Forms
      $d = New-Object System.Windows.Forms.FolderBrowserDialog
      $d.Description = 'Dossier à verrouiller pour Mistral Vibe (sessions limitées aux outils de l''Anonymiseur)'
      if ($d.ShowDialog() -ne 'OK') { exit 1 }
      $Verrouiller = $d.SelectedPath
    }
    $v = VerrouillerDossier $Verrouiller
    Dire ("Dossier verrouillé : « " + (Split-Path -Leaf $v) + " ».`n`nToute session Vibe ouverte dans ce dossier n'aura que les outils de l'Anonymiseur. Fermez puis rouvrez Vibe Desktop.")
    exit 0
  }
  if ($Desinstaller) {
    if (Test-Path -LiteralPath $listeVerrous) { foreach ($d in @(Get-Content -LiteralPath $listeVerrous -Encoding UTF8 | Where-Object { $_ })) { DeverrouillerDossier $d } }
    MettreAJourConfigVibe $false
    ArreterExtension
    foreach ($p in @($raccourciDemarrage, $lanceur)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    foreach ($p in @("agents\$NOM.toml", "prompts\$NOM.md")) { Remove-Item -LiteralPath (Join-Path $DossierVibe $p) -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
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
    if ($env:ANON_INSTALL_PORT) { $r['ANON_HTTP_PORT'] = [int]$env:ANON_INSTALL_PORT }
  }
  # Jeton de la connexion locale Vibe → extension (créé une fois, gardé chiffré dans les réglages)
  $jeton = $null
  if ($r['ANON_HTTP_JETON'] -and $r['ANON_HTTP_JETON'].dpapi) { try { $jeton = Dechiffrer $r['ANON_HTTP_JETON'].dpapi } catch { $jeton = $null } }
  if (-not $jeton) {
    $octets = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($octets)
    $jeton = [Convert]::ToBase64String($octets).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $r['ANON_HTTP_JETON'] = @{ dpapi = (Chiffrer $jeton) }
  }
  if (-not $r['ANON_HTTP_PORT']) { $r['ANON_HTTP_PORT'] = 8790 }
  $port = [int]$r['ANON_HTTP_PORT']
  EcrireReglages $r
  ArreterExtension
  if ($Reglages) {
    $ok = (Test-Path -LiteralPath $lanceur) -and (LancerExtension $port)
    Dire ('Réglages enregistrés' + $(if ($ok) { ' et extension relancée.' } else { '.' })); exit 0
  }
  $cible = Join-Path $Destination 'extension'
  New-Item -ItemType Directory -Force -Path $cible | Out-Null
  Remove-Item -LiteralPath (Join-Path $cible 'server') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath (Join-Path $source 'server') -Destination $cible -Recurse -Force
  MettreAJourConfigVibe $true $port $jeton
  EcrireAgent
  InstallerLancement
  if (-not (LancerExtension $port)) { throw "l'extension ne répond pas sur le port $port (port déjà utilisé ?)" }
  if ($env:ANON_INSTALL_VERROUILLER -eq '1') { $script:verrouillerRacine = $true }
  $verrou = ''
  if ($script:verrouillerRacine -and $r['ANON_DOSSIER_TRAVAIL'] -and (Test-Path -LiteralPath $r['ANON_DOSSIER_TRAVAIL'])) {
    $verrou = VerrouillerDossier $r['ANON_DOSSIER_TRAVAIL']
  }
  Dire ("L'Anonymiseur est installé dans Mistral Vibe.`n`n" +
    $(if ($verrou) { "Dossier verrouillé : « " + (Split-Path -Leaf $verrou) + " ».`n`n" } else { "Aucun dossier verrouillé : utilisez verrouiller-un-dossier-pour-vibe.cmd.`n`n" }) +
    "1. Fermez puis rouvrez Vibe Desktop.`n" +
    "2. Ouvrez une session locale (mode Code) SUR un dossier verrouillé : elle n'a que les outils de l'Anonymiseur.`n" +
    "3. Demandez par exemple : « Liste les pièces du dossier ».`n`n" +
    "N'ouvrez jamais une session Vibe sur un dossier client non verrouillé : Vibe lirait les fichiers en clair.")
} catch {
  Dire ("L'installation a échoué : " + $_.Exception.Message)
  exit 1
}
