# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat - Licence AGPL-3.0-or-later
# Démarre le proxy en arrière-plan s'il ne tourne pas, puis lance Claude Code en passant par lui.
# Usage : .\scripts\claude-pseudo.ps1 [arguments transmis à claude]
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = "python" }

Push-Location $root
try {
    & $venvPython -m pseudo_proxy start
    if ($LASTEXITCODE -ne 0) { throw "Le proxy n'a pas pu démarrer." }
    $port = 8080
    if ($env:PSEUDO_PROXY_PORT) { $port = $env:PSEUDO_PROXY_PORT }
    elseif (Test-Path ".env") {
        $line = Get-Content ".env" | Where-Object { $_ -match '^\s*PSEUDO_PROXY_PORT\s*=\s*(\d+)' } | Select-Object -First 1
        if ($line -match '(\d+)\s*$') { $port = $Matches[1] }
    }
} finally {
    Pop-Location
}

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
Write-Host "Claude Code passe par le proxy AxiorHub : $env:ANTHROPIC_BASE_URL" -ForegroundColor Green

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { throw "La commande « claude » est introuvable dans le PATH. Installez Claude Code (npm install -g @anthropic-ai/claude-code)." }
& claude @args
