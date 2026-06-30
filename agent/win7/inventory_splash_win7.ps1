# Lightweight boot splash (Win7 / PowerShell 2.0, ASCII only).
param([switch]$Quick)

if ($Quick -or $env:INV_NOPAUSE -eq '1') { return }

$Host.UI.RawUI.WindowTitle = 'INVENTORY AGENT'

Write-Host ''
Write-Host '  ==============================================' -ForegroundColor Green
Write-Host '       INVENTORY AGENT  ::  WIN7 UPLINK' -ForegroundColor Green
Write-Host '  ==============================================' -ForegroundColor Green
Write-Host ''

$steps = @(
    'BOOTSTRAP WMI COLLECTOR',
    'MOUNT REGISTRY SNAPSHOT',
    'PREPARE JSON PAYLOAD',
    'OPEN SECURE HTTP CHANNEL'
)

$i = 0
foreach ($s in $steps) {
    $i++
    $pct = $i * 25
    $bar = ''
    $j = 0
    while ($j -lt $i) { $bar += '#'; $j++ }
    while ($j -lt 4) { $bar += '.'; $j++ }
    Write-Host ('  [' + $bar + '] ' + $pct.ToString() + '%  ' + $s) -ForegroundColor DarkGreen
    Start-Sleep -Milliseconds 350
}

Write-Host ''
Write-Host '  >> STARTING INVENTORY CLIENT...' -ForegroundColor Cyan
Write-Host ''
Start-Sleep -Milliseconds 300
