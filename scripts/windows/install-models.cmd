@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-models.ps1" %*
