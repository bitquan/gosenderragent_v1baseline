$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
. (Join-Path $PSScriptRoot "use-ssd-storage.ps1")
Write-Host "[gosenderr-pc] project = $projectRoot"
npm install
Write-Host "[gosenderr-pc] bootstrap complete. Next: npm test ; npm run typecheck ; npm run smoke"
