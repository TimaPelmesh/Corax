#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$TaskName = "CORAX Agent Inventory",
    [string]$At = "09:00"
)

$ErrorActionPreference = "Stop"
$agent = Join-Path $PSScriptRoot "CORAX-Agent.exe"
if (-not (Test-Path $agent)) { throw "CORAX-Agent.exe is missing beside this script." }

# Provision once in the same LocalMachine DPAPI context before SYSTEM runs it.
$provision = Join-Path $PSScriptRoot "agent.provision.json"
$credential = Join-Path $PSScriptRoot "agent.cred"
if ((Test-Path $provision) -and -not (Test-Path $credential)) {
    $process = Start-Process -FilePath $agent -ArgumentList "--provision-only" -WorkingDirectory $PSScriptRoot -Wait -PassThru
    if (-not (Test-Path $credential)) {
        throw "The token could not be protected with Windows DPAPI. Agent exit code: $($process.ExitCode)."
    }
}

$action = New-ScheduledTaskAction -Execute $agent -Argument "--silent" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description "CORAX secure hardware and software inventory" `
    -Force | Out-Null

Write-Host "Installed '$TaskName' at $At as LocalSystem."
