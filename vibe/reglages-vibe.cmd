@echo off
rem Anonymiseur (cabinet) : modifier les reglages utilises par Mistral Vibe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-pour-vibe.ps1" -Reglages
