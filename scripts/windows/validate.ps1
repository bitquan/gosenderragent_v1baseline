$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
Write-Host "[gosenderr-pc] project = $projectRoot"
npm test
npm run typecheck
npm run smoke
npm run engine:acceptance
