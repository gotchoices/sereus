<#
.SYNOPSIS
  Install the Cadre Host as a Windows service using NSSM.

.DESCRIPTION
  Registers a Windows service named "CadreHost" that runs cadre-host via
  NSSM. The service is configured so that exit code 0 is final (no
  restart); non-zero exits trigger a 5-second-delayed restart, throttled
  to 10 seconds.

  NSSM (the Non-Sucking Service Manager) must be on PATH. Get it from
  https://nssm.cc/download.

.PARAMETER NodePath
  Path to node.exe. Defaults to (Get-Command node).Source.

.PARAMETER HostJs
  Path to the cadre-host CLI entrypoint (dist/bin/host.js). Defaults to
  the script's parent dir + dist\bin\host.js.

.PARAMETER DataDir
  Cadre host data directory (host.config.json + identity + state). Defaults
  to $env:LocalAppData\CadreHost.
#>

[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$HostJs,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'CadreHost'

$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Error @"
nssm.exe not found on PATH.
Install NSSM from https://nssm.cc/download and either add it to PATH or
copy nssm.exe to a directory on PATH. NSSM is required to host the
Cadre Host as a Windows service.
"@
  exit 1
}

if (-not $NodePath) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error 'node.exe not found on PATH. Pass -NodePath explicitly.'
    exit 1
  }
  $NodePath = $node.Source
}

if (-not $HostJs) {
  $HostJs = (Resolve-Path (Join-Path $PSScriptRoot '..\dist\bin\host.js')).Path
}

if (-not (Test-Path $HostJs)) {
  Write-Error "Cadre-host entry not found at $HostJs. Run 'yarn build' or set -HostJs."
  exit 1
}

if (-not $DataDir) {
  $DataDir = Join-Path $env:LocalAppData 'CadreHost'
}

$LogDir = Join-Path $DataDir 'logs'
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Remove any existing service so this script is idempotent.
$existing = & nssm.exe status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Removing existing $ServiceName service..."
  & nssm.exe stop   $ServiceName confirm | Out-Null
  & nssm.exe remove $ServiceName confirm | Out-Null
}

Write-Host "Installing $ServiceName service..."

# Use array-passed args so paths with spaces (e.g. "C:\Program Files\nodejs\node.exe")
# are quoted correctly.
$installArgs = @('install', $ServiceName, $NodePath, $HostJs, 'start', '--no-tui', '--data-dir', $DataDir)
& nssm.exe @installArgs

& nssm.exe set $ServiceName AppExit Default Restart
& nssm.exe set $ServiceName AppExit 0       Exit
& nssm.exe set $ServiceName AppRestartDelay 5000
& nssm.exe set $ServiceName AppThrottle     10000
& nssm.exe set $ServiceName AppStdout       (Join-Path $LogDir 'out.log')
& nssm.exe set $ServiceName AppStderr       (Join-Path $LogDir 'err.log')
& nssm.exe set $ServiceName AppRotateFiles  1
& nssm.exe set $ServiceName Start           SERVICE_AUTO_START

Write-Host "Service installed. Start it with: nssm start $ServiceName"
