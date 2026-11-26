@echo off
rem Anonymiseur (cabinet) : retrait de Mistral Vibe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-pour-vibe.ps1" -Desinstaller
