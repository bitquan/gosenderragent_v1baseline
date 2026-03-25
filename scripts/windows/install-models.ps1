$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
. (Join-Path $PSScriptRoot "use-ssd-storage.ps1")
Write-Host "[gosenderr-pc] project = $projectRoot"

$nodeExe = "node"
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
	$pythonExe = "python"
}

$modelStorageRoot = ""
$configPath = Join-Path $projectRoot "dev_assistant.yaml"
if (Test-Path $configPath) {
	$storageLine = Select-String -Path $configPath -Pattern '^assistant_training_model_storage_root:\s*(.+)$' | Select-Object -First 1
	if ($storageLine) {
		$modelStorageRoot = ($storageLine.Matches[0].Groups[1].Value.Trim().Trim('"')).Replace('/', '\\')
	}
}
if (-not $modelStorageRoot) {
	$modelStorageRoot = Join-Path $env:USERPROFILE "large-storage\models"
}
New-Item -ItemType Directory -Force -Path $modelStorageRoot | Out-Null

$desktopSecretReader = Join-Path $projectRoot "scripts\read-desktop-secret.js"

function Resolve-DesktopSecretValue {
	param(
		[string[]]$SecretNames
	)
	if (-not (Test-Path $desktopSecretReader)) {
		return $null
	}
	foreach ($secretName in $SecretNames) {
		try {
			$secretPayloadRaw = & $nodeExe $desktopSecretReader $secretName
			if ($LASTEXITCODE -ne 0 -or -not $secretPayloadRaw) {
				continue
			}
			$secretPayload = $secretPayloadRaw | ConvertFrom-Json
			if ($secretPayload.ok -and $secretPayload.value) {
				return [PSCustomObject]@{
					secretName = $secretName
					value = [string]$secretPayload.value
					backend = [string]$secretPayload.backend
				}
			}
		} catch {
			Write-Host "[gosenderr-pc] warning: could not read $secretName from desktop secrets"
		}
	}
	return $null
}

if (-not $env:HF_TOKEN) {
	$desktopHuggingFaceSecret = Resolve-DesktopSecretValue -SecretNames @('HF_TOKEN', 'HUGGINGFACE_API_KEY')
	if ($desktopHuggingFaceSecret) {
		$env:HF_TOKEN = $desktopHuggingFaceSecret.value
		Write-Host "[gosenderr-pc] using Hugging Face token from desktop secrets ($($desktopHuggingFaceSecret.secretName) via $($desktopHuggingFaceSecret.backend))"
	}
}
if (-not $env:HF_TOKEN) {
	Write-Host "[gosenderr-pc] HF_TOKEN not found in environment or desktop secrets; continuing with unauthenticated Hugging Face downloads"
}

& $pythonExe -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('huggingface_hub') else 1)"
if ($LASTEXITCODE -ne 0) {
	Write-Host "[gosenderr-pc] installing huggingface_hub"
	& $pythonExe -m pip install huggingface_hub
	if ($LASTEXITCODE -ne 0) {
		throw "pip install huggingface_hub failed with exit code $LASTEXITCODE"
	}
}

function Invoke-CheckedCommand {
	param(
		[string]$Command,
		[string[]]$Arguments,
		[string]$Label
	)
	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "${Label} failed with exit code $LASTEXITCODE"
	}
}

function Invoke-HfDownload {
	param(
		[string]$RepoId,
		[string]$FileName
	)
	$pythonSnippet = "from huggingface_hub import hf_hub_download; import sys; hf_hub_download(repo_id=sys.argv[1], filename=sys.argv[2], local_dir=sys.argv[3])"
	Invoke-CheckedCommand -Command $pythonExe -Arguments @('-c', $pythonSnippet, $RepoId, $FileName, $modelStorageRoot) -Label "huggingface download"
}

Write-Host "[gosenderr-pc] Qwen2.5 Coder 7B"
Invoke-CheckedCommand -Command 'ollama' -Arguments @('pull', 'qwen2.5-coder:7b') -Label 'ollama pull qwen2.5-coder:7b'

Write-Host "[gosenderr-pc] Qwen2.5 Coder 14B"
Invoke-CheckedCommand -Command 'ollama' -Arguments @('pull', 'qwen2.5-coder:14b') -Label 'ollama pull qwen2.5-coder:14b'

Write-Host "[gosenderr-pc] DeepSeek Coder V2 Lite"
Invoke-HfDownload -RepoId 'QuantFactory/DeepSeek-Coder-V2-Lite-Instruct-GGUF' -FileName 'DeepSeek-Coder-V2-Lite-Instruct.Q4_K_M.gguf'
Write-Host "[gosenderr-pc] staged for import via Settings -> AI -> Import all stored models"

Write-Host "[gosenderr-pc] Qwen3 14B"
Invoke-HfDownload -RepoId 'Qwen/Qwen3-14B-GGUF' -FileName 'Qwen3-14B-Q4_K_M.gguf'
Write-Host "[gosenderr-pc] staged for import via Settings -> AI -> Import all stored models"
