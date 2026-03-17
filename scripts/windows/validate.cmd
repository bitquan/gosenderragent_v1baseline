@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0validate.ps1" %*
