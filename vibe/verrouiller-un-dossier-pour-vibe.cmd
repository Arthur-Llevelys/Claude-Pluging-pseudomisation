@echo off
rem Anonymiseur (cabinet) : verrouiller un dossier pour Mistral Vibe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-pour-vibe.ps1" -ChoisirDossier
