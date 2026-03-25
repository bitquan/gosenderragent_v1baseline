$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Get-GoSenderrConfigValue {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Key,
		[string]$DefaultValue = ""
	)
	$configPath = Join-Path $projectRoot "dev_assistant.yaml"
	if (-not (Test-Path $configPath)) {
		return $DefaultValue
	}
	$match = Select-String -Path $configPath -Pattern ("^{0}:\s*(.+)$" -f [regex]::Escape($Key)) | Select-Object -First 1
	if (-not $match) {
		return $DefaultValue
	}
	return ($match.Matches[0].Groups[1].Value.Trim().Trim('"')).Replace('/', '\')
}

function Resolve-GoSenderrOllamaHome {
	param(
		[Parameter(Mandatory = $true)]
		[string]$ModelStorageRoot
	)
	$normalizedRoot = [System.IO.Path]::GetFullPath($ModelStorageRoot)
	if ([System.IO.Path]::GetFileName($normalizedRoot).ToLowerInvariant() -eq 'models') {
		$parentRoot = Split-Path $normalizedRoot -Parent
		if ([System.IO.Path]::GetFileName($parentRoot).ToLowerInvariant() -eq 'ollama-home') {
			return $parentRoot
		}
		return Join-Path $parentRoot 'ollama-home'
	}
	return Join-Path $normalizedRoot 'ollama-home'
}

$defaultOffloadRoot = Join-Path (Split-Path $projectRoot -Parent) 'gosenderr_dev_offload'
$defaultColdStorageRoot = 'D:\dev\projects\gosenderr_dev_backup'
$offloadRoot = Get-GoSenderrConfigValue -Key 'assistant_artifacts_root' -DefaultValue $defaultOffloadRoot
$coldStorageRoot = Get-GoSenderrConfigValue -Key 'assistant_cold_storage_root' -DefaultValue $defaultColdStorageRoot
$promotionsRoot = Get-GoSenderrConfigValue -Key 'assistant_promotions_root' -DefaultValue (Join-Path $coldStorageRoot 'assistant_promotions')
$desktopReleaseDir = Get-GoSenderrConfigValue -Key 'assistant_desktop_release_dir' -DefaultValue (Join-Path $coldStorageRoot 'desktop_releases')
$migratedInternalRoot = Get-GoSenderrConfigValue -Key 'assistant_migrated_internal_root' -DefaultValue (Join-Path $coldStorageRoot 'migrated_internal')
$modelStorageRoot = Get-GoSenderrConfigValue -Key 'assistant_training_model_storage_root' -DefaultValue (Join-Path $offloadRoot 'local_model_storage\models')
$devDataRoot = Join-Path $offloadRoot 'dev_data'
$desktopRuntimeRoot = Join-Path $devDataRoot 'desktop_app_state'
$desktopUserDataDir = Join-Path $desktopRuntimeRoot 'user-data'
$desktopSessionDataDir = Join-Path $desktopRuntimeRoot 'session-data'
$desktopCacheDir = Join-Path $desktopSessionDataDir 'Cache'
$npmCacheDir = Join-Path $devDataRoot 'npm-cache'
$pipCacheDir = Join-Path $devDataRoot 'pip-cache'
$huggingFaceHome = Join-Path $devDataRoot 'huggingface'
$huggingFaceHubCache = Join-Path $huggingFaceHome 'hub'
$tempDir = Join-Path $devDataRoot 'temp'
$ollamaHome = Resolve-GoSenderrOllamaHome -ModelStorageRoot $modelStorageRoot
$ollamaModels = Join-Path $ollamaHome 'models'

$requiredDirs = @(
	$offloadRoot,
	$coldStorageRoot,
	(Join-Path $offloadRoot 'assistant_benchmarks'),
	(Join-Path $offloadRoot 'assistant_labs'),
	(Join-Path $offloadRoot 'assistant_runs'),
	(Join-Path $offloadRoot 'desktop_builds'),
	(Join-Path $offloadRoot 'desktop_update_channel\live'),
	(Join-Path $offloadRoot 'learning_journal'),
	(Join-Path $offloadRoot 'model_foundry'),
	(Join-Path $offloadRoot 'trusted_docs'),
	$promotionsRoot,
	(Join-Path $promotionsRoot 'backups'),
	(Join-Path $promotionsRoot 'debug'),
	$desktopReleaseDir,
	$migratedInternalRoot,
	$devDataRoot,
	$desktopRuntimeRoot,
	$desktopUserDataDir,
	$desktopSessionDataDir,
	$desktopCacheDir,
	$npmCacheDir,
	$pipCacheDir,
	$huggingFaceHome,
	$huggingFaceHubCache,
	$tempDir,
	$ollamaHome,
	$ollamaModels,
	$modelStorageRoot
)

foreach ($pathToCreate in $requiredDirs) {
	if ($pathToCreate) {
		New-Item -ItemType Directory -Force -Path $pathToCreate | Out-Null
	}
}

$env:GOSENDERR_OFFLOAD_ROOT = $offloadRoot
$env:GOSENDERR_COLD_STORAGE_ROOT = $coldStorageRoot
$env:GOSENDERR_PROMOTIONS_ROOT = $promotionsRoot
$env:GOSENDERR_DESKTOP_RELEASE_DIR = $desktopReleaseDir
$env:GOSENDERR_MIGRATED_INTERNAL_ROOT = $migratedInternalRoot
$env:DESKTOP_AGENT_LOCAL_STORAGE_ROOT = $desktopRuntimeRoot
$env:DESKTOP_AGENT_USER_DATA_DIR = $desktopUserDataDir
$env:DESKTOP_AGENT_SESSION_DATA_DIR = $desktopSessionDataDir
$env:DESKTOP_AGENT_CACHE_DIR = $desktopCacheDir
$env:npm_config_cache = $npmCacheDir
$env:PIP_CACHE_DIR = $pipCacheDir
$env:HF_HOME = $huggingFaceHome
$env:HUGGINGFACE_HUB_CACHE = $huggingFaceHubCache
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:OLLAMA_HOME = $ollamaHome
$env:OLLAMA_MODELS = $ollamaModels

Write-Host "[gosenderr-pc] storage root = $offloadRoot"
Write-Host "[gosenderr-pc] cold storage = $coldStorageRoot"
Write-Host "[gosenderr-pc] app state = $desktopUserDataDir"
Write-Host "[gosenderr-pc] promotions = $promotionsRoot"
Write-Host "[gosenderr-pc] releases = $desktopReleaseDir"
Write-Host "[gosenderr-pc] model storage = $modelStorageRoot"
Write-Host "[gosenderr-pc] ollama models = $ollamaModels"