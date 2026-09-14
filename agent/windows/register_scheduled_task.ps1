#Requires -Version 2.0
param(
    [string]$AgentRoot = $PSScriptRoot,
    [string]$TaskName = 'CORAX-Agent',
    [string]$StartTime = '09:00',
    [ValidateSet('MONTHLY', 'WEEKLY', 'DAILY')]
    [string]$Schedule = 'WEEKLY',
    [ValidateSet('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')]
    [string]$WeekDay = 'MON',
    [ValidateRange(1, 31)]
    [int]$DayOfMonth = 1
)

$ErrorActionPreference = 'Stop'
$vbs = Join-Path $AgentRoot 'corax_send_silent.vbs'
if (-not (Test-Path -LiteralPath $vbs)) {
    throw "corax_send_silent.vbs not found: $vbs"
}
$vbsFull = (Resolve-Path -LiteralPath $vbs).Path
$taskRun = "wscript.exe //B //Nologo `"$vbsFull`""
$sch = Join-Path $env:SystemRoot 'System32\schtasks.exe'
& $sch /Delete /TN $TaskName /F 2>$null
$args = @('/Create', '/TN', $TaskName, '/TR', $taskRun, '/F', '/RL', 'HIGHEST', '/RU', 'SYSTEM', '/NP')
switch ($Schedule) {
    'MONTHLY' { $args += '/SC', 'MONTHLY', '/D', "$DayOfMonth", '/ST', $StartTime }
    'WEEKLY'  { $args += '/SC', 'WEEKLY', '/D', $WeekDay, '/ST', $StartTime }
    'DAILY'   { $args += '/SC', 'DAILY', '/ST', $StartTime }
}
Write-Host "Creating task: $TaskName"
& $sch @args
if ($LASTEXITCODE -ne 0) { throw "schtasks exit $LASTEXITCODE" }
Write-Host 'Done. Hidden SYSTEM task: wscript runs corax_send.bat nopause with no window. OS is picked each run.'
