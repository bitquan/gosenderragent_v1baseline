$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
Write-Host "[gosenderr-pc] project = $projectRoot"
npm run dist:win:x64
