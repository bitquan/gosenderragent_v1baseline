$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
Write-Host "[gosenderr-pc] project = $projectRoot"
Write-Host "[gosenderr-pc] Qwen2.5 Coder 7B"
ollama pull 'qwen2.5-coder:7b'
Write-Host "[gosenderr-pc] Qwen2.5 Coder 14B"
ollama pull 'qwen2.5-coder:14b'
