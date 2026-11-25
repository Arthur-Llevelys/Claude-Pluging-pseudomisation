# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat - Licence AGPL-3.0-or-later
# Lance le proxy au premier plan (Ctrl+C pour arrêter). Lit le fichier .env du projet.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = "python" }
& $venvPython -m pseudo_proxy serve @args
