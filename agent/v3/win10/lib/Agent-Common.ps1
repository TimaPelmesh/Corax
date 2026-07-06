#Requires -Version 5.1
# Shared helpers for CORAX Agent

function Log([string]$Msg) {
    Write-Host ("[{0:HH:mm:ss}] " -f (Get-Date)) -NoNewline
    Write-Host $Msg
}

function Set-AgentProgress {
    param([string]$Status, [int]$Percent)
    Write-Progress -Id 1 -Activity '[*] CORAX Agent' -Status $Status -PercentComplete $Percent
}

function Stop-AgentJob {
    param($Job)
    if (-not $Job) { return }
    # Windows PowerShell 5.1: Stop-Job has no -Force (added in PS 6+).
    Stop-Job -Job $Job -ErrorAction SilentlyContinue
}

function Remove-AgentJob {
    param($Job)
    if (-not $Job) { return }
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
}

function Invoke-WithTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [int]$TimeoutSec = 12
    )
    $job = Start-Job -ScriptBlock $ScriptBlock
    try {
        if (Wait-Job -Job $job -Timeout $TimeoutSec) {
            return Receive-Job -Job $job
        }
        return $null
    } finally {
        Stop-AgentJob -Job $job
        Remove-AgentJob -Job $job
    }
}

function Clear-AgentProgress {
    Write-Progress -Id 1 -Activity 'done' -Completed
}

function Get-AgentConfig {
    param([string]$Root = $PSScriptRoot)
    $parent = Split-Path -Parent $Root
    $path = Join-Path $parent 'agent_config.json'
    $defaults = @{
        agent_version = '3.0.1'
        profile       = 'full'
        modules       = @{
            patches = $true; network = $true; domain_sessions = $true
            bitlocker = $true; tpm_secureboot = $true; antivirus = $true
            startup = $true; services = $true; storage_health = $true
            battery = $true; windows_features = $true; office = $true
            usb_history = $true; docker_wsl = $true
        }
        limits = @{
            software_max = 12000; services_max = 120; patches_max = 500; usb_max = 200
        }
    }
    if (-not (Test-Path -LiteralPath $path)) {
        Log "WARN: agent_config.json missing, using defaults (full profile)"
        return [pscustomobject]$defaults
    }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
        $cfg = $raw | ConvertFrom-Json
        if (-not $cfg.modules) { $cfg | Add-Member -NotePropertyName modules -NotePropertyValue $defaults.modules }
        if (-not $cfg.limits) { $cfg | Add-Member -NotePropertyName limits -NotePropertyValue $defaults.limits }
        return $cfg
    } catch {
        Log "WARN: agent_config.json parse error, using defaults"
        return [pscustomobject]$defaults
    }
}

function Test-ModuleEnabled {
    param($Config, [string]$Name)
    if (-not $Config.modules) { return $true }
    $m = $Config.modules
    if ($m.PSObject.Properties.Name -contains $Name) {
        return [bool]$m.$Name
    }
    return $true
}

function Get-ModuleLimit {
    param($Config, [string]$Name, [int]$Default = 500)
    if ($Config.limits -and ($Config.limits.PSObject.Properties.Name -contains $Name)) {
        return [int]$Config.limits.$Name
    }
    return $Default
}

function Test-IsWmiPlaceholder {
    param([string]$s)
    if ([string]::IsNullOrWhiteSpace($s)) { return $true }
    $t = $s.Trim()
    return ($t -match '^(System Product Name|System Manufacturer|System Model|System Version|System SKU|System Serial Number|Default string|Default String|To be filled by O\.E\.M\.|To Be Filled By O\.E\.M\.|To be filled|Not Specified|OEM|O\.E\.M\.|INVALID|Invalid|All Series|Type1Family0|Bad string|undefined|Not Available|N/?A|Product Name|Not Applicable)$')
}

function Get-SanitizedAgentText {
    param([string]$Value)
    if ($null -eq $Value) { return $null }
    $t = $Value -replace "`0", ''
    if ([string]::IsNullOrWhiteSpace($t)) { return $null }
    return $t.Trim()
}

function Get-CleanWmiText {
    param([string]$value)
    $value = Get-SanitizedAgentText $value
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $t = $value.Trim()
    if ($t.Length -gt 256) { $t = $t.Substring(0, 256) }
    if (Test-IsWmiPlaceholder $t) { return $null }
    return $t
}

function Safe-Collect {
    param([string]$Label, [scriptblock]$Block)
    try {
        return & $Block
    } catch {
        Log "WARN: $Label - $($_.Exception.Message)"
        return $null
    }
}
