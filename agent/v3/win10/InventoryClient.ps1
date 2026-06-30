#Requires -Version 5.1
# CORAX Agent - main entrypoint

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$AgentRoot = $PSScriptRoot
$Lib = Join-Path $AgentRoot 'lib'

. (Join-Path $Lib 'Agent-Common.ps1')
. (Join-Path $Lib 'Collect-Core.ps1')
. (Join-Path $Lib 'Collect-System.ps1')
. (Join-Path $Lib 'Collect-Network.ps1')
. (Join-Path $Lib 'Collect-Security.ps1')
. (Join-Path $Lib 'Collect-Runtime.ps1')
. (Join-Path $Lib 'Collect-Storage.ps1')
. (Join-Path $Lib 'Collect-SoftwareExt.ps1')
. (Join-Path $Lib 'Collect-Virtual.ps1')
. (Join-Path $Lib 'Invoke-Post.ps1')

function Start-ExtendedCollectJob {
    param(
        [string]$CollectorFile,
        [string]$FunctionName,
        $Config
    )
    $libEsc = ($Lib -replace "'", "''")
    $fileEsc = ((Join-Path $Lib $CollectorFile) -replace "'", "''")
    $init = [scriptblock]::Create(". '$libEsc\Agent-Common.ps1'; . '$fileEsc'")
    return Start-Job -InitializationScript $init -ScriptBlock {
        param($Func, $Cfg)
        & (Get-Command $Func) -Config $Cfg
    } -ArgumentList $FunctionName, $Config
}

function Wait-ExtendedJobEntries {
    param(
        [array]$Entries,
        [int]$TimeoutSec = 90
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    foreach ($entry in $Entries) {
        $left = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalSeconds)
        Wait-Job -Job $entry.Job -Timeout $left | Out-Null
    }
    $out = @{}
    foreach ($entry in $Entries) {
        $r = Receive-Job -Job $entry.Job -ErrorAction SilentlyContinue
        Stop-AgentJob -Job $entry.Job
        Remove-AgentJob -Job $entry.Job
        if (-not $r -or -not ($r -is [hashtable])) { continue }
        if ($entry.WrapNetwork) {
            if ($r.Count -gt 0) { $out.network = $r }
        } else {
            foreach ($k in $r.Keys) { $out[$k] = $r[$k] }
        }
    }
    return $out
}

try {
    Log '=== CORAX Agent start ==='
    Set-AgentProgress 'Config...' 5
    $config = Get-AgentConfig -Root $Lib

    $base = $env:INVENTORY_SERVER
    if ([string]::IsNullOrWhiteSpace($base)) {
        throw 'INVENTORY_SERVER is not set. Configure agent_env.bat from admin bundle.'
    }
    $base = $base.TrimEnd('/')

    $token = $env:AGENT_TOKEN
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw 'AGENT_TOKEN is not set. Configure agent_env.bat from admin bundle.'
    }

    Set-AgentProgress 'Core: hardware, OS, software...' 15
    $core = Get-CoreInventoryPayload -Config $config

    $extended = [ordered]@{
        agent_version = if ($config.agent_version) { [string]$config.agent_version } else { '3.0.1' }
        profile       = if ($config.profile) { [string]$config.profile } else { 'full' }
        collected_at  = (Get-Date).ToUniversalTime().ToString('o')
    }

    Log '[ext] wave 1: system, network, security (parallel)...'
    Set-AgentProgress 'Extended wave 1 (system, network, security)...' 35
    $wave1 = @(
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-System.ps1' -FunctionName 'Get-ExtendedSystem' -Config $config); WrapNetwork = $false }
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-Network.ps1' -FunctionName 'Get-ExtendedNetwork' -Config $config); WrapNetwork = $true }
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-Security.ps1' -FunctionName 'Get-ExtendedSecurity' -Config $config); WrapNetwork = $false }
    )
    $w1 = Wait-ExtendedJobEntries -Entries $wave1 -TimeoutSec 45
    foreach ($k in $w1.Keys) { $extended[$k] = $w1[$k] }

    Log '[ext] wave 2: services, storage, office, docker (parallel)...'
    Set-AgentProgress 'Extended wave 2 (services, storage, software, virtual)...' 65
    $wave2 = @(
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-Runtime.ps1' -FunctionName 'Get-ExtendedRuntime' -Config $config); WrapNetwork = $false }
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-Storage.ps1' -FunctionName 'Get-ExtendedStorage' -Config $config); WrapNetwork = $false }
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-SoftwareExt.ps1' -FunctionName 'Get-ExtendedSoftware' -Config $config); WrapNetwork = $false }
        @{ Job = (Start-ExtendedCollectJob -CollectorFile 'Collect-Virtual.ps1' -FunctionName 'Get-ExtendedVirtual' -Config $config); WrapNetwork = $false }
    )
    $w2 = Wait-ExtendedJobEntries -Entries $wave2 -TimeoutSec 60
    foreach ($k in $w2.Keys) { $extended[$k] = $w2[$k] }

    $payload = [ordered]@{}
    foreach ($k in $core.Keys) { $payload[$k] = $core[$k] }
    $payload.extended = $extended

    Set-AgentProgress 'Upload report...' 92
    $exitCode = Send-InventoryReport -Payload $payload -BaseUrl $base -Token $token
    Clear-AgentProgress
    if ($exitCode -eq 0) {
        Log '=== CORAX Agent OK ==='
    } else {
        Log '=== CORAX Agent FAILED (see above) ==='
    }
    exit $exitCode
}
catch {
    Clear-AgentProgress
    Log "ERROR: $($_.Exception.Message)"
    exit 1
}
