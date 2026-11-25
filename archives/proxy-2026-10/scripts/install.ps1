# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat - Licence AGPL-3.0-or-later
# Installation sous Windows : environnement virtuel, dépendances, paquet, autotest.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host "AxiorHub Pseudonymisation Claude - installation" -ForegroundColor Cyan

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw "Python 3.11+ introuvable. Installez-le depuis https://www.python.org/downloads/windows/ (cochez « Add python.exe to PATH »)." }

if (-not (Test-Path ".venv")) {
    Write-Host "Création de l'environnement virtuel .venv ..."
    & $python.Source -m venv .venv
}
$venvPython = Join-Path $root ".venv\Scripts\python.exe"

Write-Host "Installation des dépendances ..."
& $venvPython -m pip install --upgrade pip --quiet
& $venvPython -m pip install -r requirements.txt --quiet
& $venvPython -m pip install -e . --quiet

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Fichier .env créé à partir de .env.example (modifiez-le si besoin)."
}

Write-Host ""
& $venvPython -m pseudo_proxy selftest
Write-Host ""
Write-Host "Installation terminée." -ForegroundColor Green
Write-Host "  Lancer le proxy      : .\scripts\start-proxy.ps1"
Write-Host "  Lancer Claude Code   : .\scripts\claude-pseudo.ps1"
Write-Host "  Tests                : .\scripts\run-tests.ps1"
