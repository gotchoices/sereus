<#
.SYNOPSIS
  Install the Cadre Provider as a Windows service using NSSM.

.DESCRIPTION
  Registers a Windows service named "CadreProvider" that runs the Cadre
  Provider via NSSM. The service is configured so that exit code 0 is
  final (no restart) — this is what makes the `shutdownAfter` flag and
  any explicit SIGTERM-style stop result in a clean exit. Non-zero exits
  trigger a 5-second-delayed restart, throttled to 10 seconds.

  NSSM (the Non-Sucking Service Manager) must be on PATH. Get it from
  https://nssm.cc/download.

.PARAMETER NodePath
  Path to node.exe. Defaults to (Get-Command node).Source.

.PARAMETER InstallDir
  Directory containing dist\bin\provider.js. Defaults to the package's
  parent dir relative to this script (..\).

.PARAMETER ConfigPath
  Path to the provider config (YAML or JSON). Defaults to
  $InstallDir\provider.yaml.

.PARAMETER LogDir
  Directory for stdout/stderr logs. Created if missing.
#>

[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$InstallDir,
  [string]$ConfigPath,
  [string]$LogDir = 'C:\ProgramData\CadreProvider\logs'
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'CadreProvider'

$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Error @"
nssm.exe not found on PATH.
Install NSSM from https://nssm.cc/download and either add it to PATH or
copy nssm.exe to a directory on PATH. NSSM is required to host the
Cadre Provider as a Windows service.
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

if (-not $InstallDir) {
  $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$ProviderJs = Join-Path $InstallDir 'dist\bin\provider.js'
if (-not (Test-Path $ProviderJs)) {
  Write-Error "Provider entry not found at $ProviderJs. Run 'yarn build' or set -InstallDir."
  exit 1
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $InstallDir 'provider.yaml'
}

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# Remove any existing service so this script is idempotent
$existing = & nssm.exe status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Removing existing $ServiceName service..."
  & nssm.exe stop   $ServiceName confirm | Out-Null
  & nssm.exe remove $ServiceName confirm | Out-Null
}

Write-Host "Installing $ServiceName service..."
& nssm.exe install $ServiceName $NodePath $ProviderJs start -c $ConfigPath
& nssm.exe set $ServiceName AppDirectory   $InstallDir
& nssm.exe set $ServiceName AppExit Default Restart
& nssm.exe set $ServiceName AppExit 0       Exit
& nssm.exe set $ServiceName AppRestartDelay 5000
& nssm.exe set $ServiceName AppThrottle     10000
& nssm.exe set $ServiceName AppStdout       (Join-Path $LogDir 'out.log')
& nssm.exe set $ServiceName AppStderr       (Join-Path $LogDir 'err.log')
& nssm.exe set $ServiceName AppRotateFiles  1
& nssm.exe set $ServiceName Start           SERVICE_AUTO_START

Write-Host "Service installed. Start it with: nssm start $ServiceName"
