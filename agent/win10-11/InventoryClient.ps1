#Requires -Version 5.1
# Keep Win10/11 agent self-contained in this folder: no dependency on agent\ root.
$ErrorActionPreference = 'Stop'

$impl = Join-Path $PSScriptRoot 'InventoryClient_impl.ps1'
if (-not (Test-Path -LiteralPath $impl)) {
    throw "InventoryClient_impl.ps1 not found next to this file: $impl"
}

& $impl
exit $LASTEXITCODE

