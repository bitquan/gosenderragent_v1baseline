$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
. (Join-Path $PSScriptRoot "use-ssd-storage.ps1")
Write-Host "[gosenderr-pc] project = $projectRoot"
npm run dist:win:x64
