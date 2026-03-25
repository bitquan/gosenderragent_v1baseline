$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $projectRoot
. (Join-Path $PSScriptRoot "use-ssd-storage.ps1")
Write-Host "[gosenderr-pc] project = $projectRoot"

function Invoke-Step {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Label,
		[Parameter(Mandatory = $true)]
		[scriptblock]$Action
	)

	Write-Host "[gosenderr-pc] step = $Label"
	& $Action
	if ($LASTEXITCODE -ne 0) {
		throw "Step failed: $Label (exit code $LASTEXITCODE)"
	}
}

Invoke-Step -Label "npm test" -Action { npm test }
Invoke-Step -Label "npm run test:planner-ranking" -Action { npm run test:planner-ranking }
Invoke-Step -Label "npm run typecheck" -Action { npm run typecheck }
Invoke-Step -Label "npm run smoke" -Action { npm run smoke }
Invoke-Step -Label "npm run engine:acceptance" -Action { npm run engine:acceptance }
