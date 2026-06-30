#Requires -Version 5.1
param(
    [string]$AgentRoot = $PSScriptRoot,
    [string]$TaskName = 'InventoryAgent-Scheduled',
    [ValidateRange(1, 31)]
    [int]$DayOfMonth = 1,
    [string]$StartTime = '09:00',
    [ValidateSet('MONTHLY', 'WEEKLY', 'DAILY')]
    [string]$Schedule = 'MONTHLY',
    [ValidateSet('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')]
    [string]$WeekDay = 'MON',
    [string]$RunAsUser = '',
    [string]$RunAsPassword = ''
)

$ErrorActionPreference = 'Stop'

$bat = Join-Path $AgentRoot 'inventory_send_win10.bat'
if (-not (Test-Path -LiteralPath $bat)) {
    throw "Не найден inventory_send_win10.bat: $bat. Укажите -AgentRoot '\\fileserver\share\agent\win10-11'."
}

$batFull = (Resolve-Path -LiteralPath $bat).Path
$taskRun = "cmd.exe /c `"$batFull`" nopause"

$sch = Join-Path $env:SystemRoot 'System32\schtasks.exe'
if (-not (Test-Path $sch)) {
    throw "Не найден schtasks.exe"
}

& $sch /Delete /TN $TaskName /F 2>$null

$args = @(
    '/Create'
    '/TN', $TaskName
    '/TR', $taskRun
    '/F'
)

switch ($Schedule) {
    'MONTHLY' { $args += '/SC', 'MONTHLY', '/D', "$DayOfMonth", '/ST', $StartTime }
    'WEEKLY'  { $args += '/SC', 'WEEKLY',  '/D', $WeekDay,      '/ST', $StartTime }
    'DAILY'   { $args += '/SC', 'DAILY',                    '/ST', $StartTime }
}

if ($RunAsUser -ne '') {
    $args += '/RU', $RunAsUser
    if ($RunAsPassword -ne '') { $args += '/RP', $RunAsPassword }
}

Write-Host "Создание задания: $TaskName"
Write-Host "Команда: $taskRun"
Write-Host "Расписание: $Schedule, время: $StartTime"
& $sch @args

if ($LASTEXITCODE -ne 0) {
    throw "schtasks код $LASTEXITCODE. Попробуйте консоль от администратора или проверьте права /RU."
}

Write-Host ""
Write-Host "OK. Планировщик: taskschd.msc -> $TaskName"
Write-Host "Тест: schtasks /Run /TN `"$TaskName`""

