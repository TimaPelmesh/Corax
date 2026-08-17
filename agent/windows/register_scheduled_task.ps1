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
$bat = Join-Path $AgentRoot 'corax_send.bat'
if (-not (Test-Path -LiteralPath $bat)) {
    throw "corax_send.bat not found: $bat"
}
$batFull = (Resolve-Path -LiteralPath $bat).Path
$taskRun = "cmd.exe /c `"$batFull`" nopause"
$sch = Join-Path $env:SystemRoot 'System32\schtasks.exe'
& $sch /Delete /TN $TaskName /F 2>$null
$args = @('/Create', '/TN', $TaskName, '/TR', $taskRun, '/F', '/RL', 'HIGHEST')
switch ($Schedule) {
    'MONTHLY' { $args += '/SC', 'MONTHLY', '/D', "$DayOfMonth", '/ST', $StartTime }
    'WEEKLY'  { $args += '/SC', 'WEEKLY', '/D', $WeekDay, '/ST', $StartTime }
    'DAILY'   { $args += '/SC', 'DAILY', '/ST', $StartTime }
}
Write-Host "Creating task: $TaskName"
& $sch @args
if ($LASTEXITCODE -ne 0) { throw "schtasks exit $LASTEXITCODE" }
Write-Host 'Done. Task runs corax_send.bat which picks Win7 or Win10/11.'
