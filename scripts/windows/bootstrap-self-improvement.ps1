param(
  [string]$ProjectRoot = "",
  [string]$SchedulerRoot = "",
  [switch]$StartScheduler
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = Join-Path $PSScriptRoot "..\.."
}

$projectRoot = (Resolve-Path $ProjectRoot).Path
$defaultLabRoot = "E:\dev\projects\gosenderr_dev_offload\assistant_labs\persistent\self-host"
if (-not $SchedulerRoot) {
  if (Test-Path $defaultLabRoot) {
    $SchedulerRoot = (Resolve-Path $defaultLabRoot).Path
  } else {
    $SchedulerRoot = $projectRoot
  }
} else {
  $SchedulerRoot = (Resolve-Path $SchedulerRoot).Path
}

$runtimeRoot = Join-Path $projectRoot "runtime"
$pathSeparator = [System.IO.Path]::PathSeparator
$previousPythonPath = $env:PYTHONPATH
$previousProjectRoot = $env:PROJECT_ROOT
$previousSeedPayload = $env:GOSENDERR_SELF_IMPROVEMENT_SEEDS

$seedPayloads = @(
  @{
    seedId = "bootstrap-core-bug-slice"
    targetPaths = @("core/")
    title = "Fix the next core stability bug"
    summary = "Repair the next bounded core/runtime regression and keep the slice small, reversible, and bug-focused."
    requestedBy = "bootstrap"
    severity = 0
  },
  @{
    seedId = "bootstrap-host-bug-slice"
    targetPaths = @("host/")
    title = "Tighten self-host runtime control"
    summary = "Repair the next bounded self-host or scheduler control issue without widening scope beyond host wiring."
    requestedBy = "bootstrap"
    severity = 0
  },
  @{
    seedId = "bootstrap-renderer-bug-slice"
    targetPaths = @("renderer-src/")
    title = "Fix the next renderer bug"
    summary = "Repair the next bounded Electron renderer issue and keep the slice limited to the visible bug surface."
    requestedBy = "bootstrap"
    severity = 0
  }
) | ConvertTo-Json -Compress -Depth 6

try {
  $env:PYTHONPATH = @($runtimeRoot, $previousPythonPath) -join $pathSeparator
  $env:PROJECT_ROOT = $projectRoot
  $env:GOSENDERR_SELF_IMPROVEMENT_SEEDS = $seedPayloads

  Write-Host "[gosenderr-pc] project root  = $projectRoot"
  Write-Host "[gosenderr-pc] scheduler root = $SchedulerRoot"
  Write-Host "[gosenderr-pc] seeding starter self-improvement backlog"

  @'
import json
import os
from backend.agent.runtime import runtime_api

payloads = json.loads(os.environ["GOSENDERR_SELF_IMPROVEMENT_SEEDS"])
result = runtime_api.bootstrap_self_improvement_backlog({
    "seeds": payloads,
    "pauseExisting": True,
    "historyLimit": 40,
    "limit": 8,
})
print(json.dumps({
    "pausedSeedIds": result.get("pausedSeedIds"),
    "seeded": result.get("seeded"),
}, indent=2))
'@ | python -

  if ($StartScheduler) {
    $env:PROJECT_ROOT = $SchedulerRoot
    Write-Host "[gosenderr-pc] starting scheduler in foreground"
    python -m backend.agent.runtime.runtime_api scheduler-start --payload-json "{}"
  } else {
    Write-Host "[gosenderr-pc] backlog seeded. Start the scheduler from the app or rerun with -StartScheduler."
  }
} finally {
  $env:PYTHONPATH = $previousPythonPath
  $env:PROJECT_ROOT = $previousProjectRoot
  $env:GOSENDERR_SELF_IMPROVEMENT_SEEDS = $previousSeedPayload
}
