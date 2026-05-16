<#
.SYNOPSIS
  Uninstall the Cadre Provider Windows service.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ServiceName = 'CadreProvider'

$nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Error 'nssm.exe not found on PATH. Install NSSM from https://nssm.cc/download.'
  exit 1
}

& nssm.exe stop   $ServiceName confirm 2>$null | Out-Null
& nssm.exe remove $ServiceName confirm
