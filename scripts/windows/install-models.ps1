$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
Write-Host "[gosenderr-pc] project = $projectRoot"
Write-Host "[gosenderr-pc] Qwen2.5 Coder 7B"
ollama pull 'qwen2.5-coder:7b'
Write-Host "[gosenderr-pc] Qwen2.5 Coder 14B"
ollama pull 'qwen2.5-coder:14b'
Write-Host "[gosenderr-pc] DeepSeek Coder V2 Lite"
ollama pull 'deepseek-coder-v2-lite-instruct:q4-k-m'
Write-Host "[gosenderr-pc] Qwen3 14B"
ollama pull 'qwen3-14b:q4-k-m'
