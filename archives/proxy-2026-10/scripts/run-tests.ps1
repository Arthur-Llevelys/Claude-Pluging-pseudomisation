# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat - Licence AGPL-3.0-or-later
# Lance la suite de tests pytest puis l'autotest des 24 contrôles.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { $venvPython = "python" }
& $venvPython -X utf8 -m pytest tests -q
& $venvPython -X utf8 -m pseudo_proxy selftest -v
