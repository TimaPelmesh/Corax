#Requires -Version 5.1
# CORAX Agent - main entrypoint
#
# Core inventory is POSTed before extended modules. If BitLocker/WMI/Start-Job
# later dies, the PC still appears in the panel. Extended extras are best-effort.

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$AgentRoot = $PSScriptRoot
$global:CoraxAgentLogDir = $AgentRoot
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

function Merge-ExtendedHashtable {
    param($Target, $Source, [switch]$AsNetwork)
    if (-not $Source -or -not ($Source -is [hashtable]) -or $Source.Count -lt 1) { return }
    if ($AsNetwork) {
        $Target.network = $Source
        return
    }
    foreach ($k in $Source.Keys) { $Target[$k] = $Source[$k] }
}

function Invoke-ExtendedInProcess {
    param($Config)
    $out = @{}
    $steps = @(
        @{ Label = 'system'; AsNetwork = $false; Fn = { Get-ExtendedSystem -Config $Config } }
        @{ Label = 'network'; AsNetwork = $true; Fn = { Get-ExtendedNetwork -Config $Config } }
        @{ Label = 'security'; AsNetwork = $false; Fn = { Get-ExtendedSecurity -Config $Config } }
        @{ Label = 'runtime'; AsNetwork = $false; Fn = { Get-ExtendedRuntime -Config $Config } }
        @{ Label = 'storage'; AsNetwork = $false; Fn = { Get-ExtendedStorage -Config $Config } }
        @{ Label = 'software'; AsNetwork = $false; Fn = { Get-ExtendedSoftware -Config $Config } }
        @{ Label = 'virtual'; AsNetwork = $false; Fn = { Get-ExtendedVirtual -Config $Config } }
    )
    $n = 0
    foreach ($step in $steps) {
        $n++
        $pct = 40 + [int](50 * $n / $steps.Count)
        Set-AgentProgress ("Extended: {0}..." -f $step.Label) $pct
        Log ("[ext] {0} (in-process)..." -f $step.Label)
        try {
            $r = & $step.Fn
            Merge-ExtendedHashtable -Target $out -Source $r -AsNetwork:$step.AsNetwork
        } catch {
            Log ("WARN: extended {0} skipped: {1}" -f $step.Label, $_.Exception.Message)
        }
    }
    return $out
}

function New-CorePayload {
    param($Core, $Extended)
    $payload = [ordered]@{}
    foreach ($k in $Core.Keys) { $payload[$k] = $Core[$k] }
    $payload.extended = $Extended
    return $payload
}

try {
    Log '=== CORAX Agent start ==='
    Write-CoraxLastRun -Result 'RUNNING' -Detail 'Collecting inventory'
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

    if ($config.helpdesk_shortcut -ne $false) {
        try {
            Install-CoraxHelpdeskShortcut -ServerUrl $base -Hostname $env:COMPUTERNAME
        } catch {
            Log "WARN: shortcut: $($_.Exception.Message)"
        }
    }

    Set-AgentProgress 'Core: hardware, OS, software...' 15
    $core = $null
    try {
        $core = Get-CoreInventoryPayload -Config $config
    } catch {
        Log "WARN: core collect failed: $($_.Exception.Message)"
    }
    if (-not $core -or -not $core.hostname) {
        $core = [ordered]@{
            hostname    = $env:COMPUTERNAME
            os_name     = 'Windows'
            software    = @()
            disks       = @()
            peripherals = @()
        }
        Log 'WARN: sending hostname-only core payload'
    }

    $extended = [ordered]@{
        agent_version = if ($config.agent_version) { [string]$config.agent_version } else { '3.0.1' }
        profile       = if ($config.profile) { [string]$config.profile } else { 'full' }
        collected_at  = (Get-Date).ToUniversalTime().ToString('o')
        partial       = $true
    }

    # POST core first — panel must see this PC even if extras crash later.
    Set-AgentProgress 'Upload core report...' 32
    $corePayload = New-CorePayload -Core $core -Extended $extended
    $exitCode = Send-InventoryReport -Payload $corePayload -BaseUrl $base -Token $token
    if ($exitCode -eq 0) {
        Log 'Core inventory sent (PC should appear in panel).'
        if ($config.helpdesk_shortcut -ne $false) {
            try {
                Install-CoraxHelpdeskShortcut -ServerUrl $base -Hostname $core.hostname
            } catch {
                Log "WARN: shortcut: $($_.Exception.Message)"
            }
        }
    } else {
        Log 'WARN: core upload failed; will retry after extended collect.'
    }

    Log '[ext] in-process modules (jobs disabled — they crash some PCs after splash)...'
    $extra = Invoke-ExtendedInProcess -Config $config
    foreach ($k in $extra.Keys) { $extended[$k] = $extra[$k] }
    $extended.partial = $false
    $extended.collected_at = (Get-Date).ToUniversalTime().ToString('o')

    Set-AgentProgress 'Upload full report...' 92
    $fullPayload = New-CorePayload -Core $core -Extended $extended
    $fullExit = Send-InventoryReport -Payload $fullPayload -BaseUrl $base -Token $token
    if ($fullExit -eq 0) {
        $exitCode = 0
        if ($config.helpdesk_shortcut -ne $false) {
            try {
                Install-CoraxHelpdeskShortcut -ServerUrl $base -Hostname $core.hostname
            } catch {
                Log "WARN: shortcut: $($_.Exception.Message)"
            }
        }
    }

    Clear-AgentProgress
    if ($exitCode -eq 0) {
        Log '=== CORAX Agent OK ==='
        Write-CoraxLastRun -Result 'OK' -Detail 'Report sent'
    } else {
        Log '=== CORAX Agent FAILED (core+full upload). See corax-agent.log ==='
        Write-CoraxLastRun -Result 'FAILED' -Detail 'Upload failed; see corax-agent.log'
    }
    exit $exitCode
}
catch {
    Clear-AgentProgress
    Log "ERROR: $($_.Exception.Message)"
    Write-CoraxLastRun -Result 'FAILED' -Detail $_.Exception.Message
    exit 1
}
