# Hacker-style boot splash (Win10/11, PowerShell 5+).
# Skip: set INV_NOPAUSE=1 or pass -Quick
param([switch]$Quick)

$ErrorActionPreference = 'SilentlyContinue'

if ($Quick -or $env:INV_NOPAUSE -eq '1') { return }

function Write-Slow([string]$Text, [int]$DelayMs = 12, [string]$Color = 'Green') {
    foreach ($ch in $Text.ToCharArray()) {
        Write-Host -NoNewline $ch -ForegroundColor $Color
        Start-Sleep -Milliseconds $DelayMs
    }
    Write-Host ''
}

function Write-ScanLine([string]$Label, [string]$Value, [string]$Status = 'OK') {
    $pad = 28 - $Label.Length
    if ($pad -lt 1) { $pad = 1 }
    $dots = '.' * $pad
    Write-Host "  [" -NoNewline -ForegroundColor DarkGreen
    Write-Host $Status -NoNewline -ForegroundColor $(if ($Status -eq 'OK') { 'Green' } else { 'Yellow' })
    Write-Host "] " -NoNewline -ForegroundColor DarkGreen
    Write-Host ($Label + $dots + $Value) -ForegroundColor DarkGray
}

$cursorWasVisible = [Console]::CursorVisible
[Console]::CursorVisible = $false
$Host.UI.RawUI.WindowTitle = 'INVENTORY :: SECURE UPLINK'

try {
    try { Clear-Host } catch { }

    $w = [Math]::Min(72, [Math]::Max(60, [Console]::WindowWidth))
    $barW = [Math]::Min(40, $w - 24)

    # Header art (ASCII only)
    $art = @(
        '  ___                      _                      _   ',
        ' |_ _|_ __  _ __ ___  _ __| |_ _ __ ___  _ __  __ _| |_ ',
        '  | || ''_ \| ''_ ` _ \| ''_ \ __| ''_ ` _ \| ''_ \/ _` | __|',
        '  | || | | | | | | | | | | |_| | | | | | | | (_| | |_ ',
        ' |___|_| |_|_| |_| |_|_|_|\__|_|_| |_|_|_|_|\__,_|\__|',
        '        :: INVENTORY AGENT // SECURE UPLINK v2.0 ::   '
    )

    Write-Host ''
    foreach ($line in $art) {
        Write-Host $line -ForegroundColor Green
        Start-Sleep -Milliseconds 35
    }
    Write-Host ''
    Write-Host ('  ' + ('=' * ($w - 4))) -ForegroundColor DarkGreen
    Write-Host ''

    Write-Slow '  > INITIALIZING SECURE INVENTORY CHANNEL...' 8 'Cyan'
    Start-Sleep -Milliseconds 200

    # Matrix rain burst (short)
    $chars = '01ABCDEF#$@<>{}[]|/\-=+*'
    $rows = 6
    for ($r = 0; $r -lt $rows; $r++) {
        $line = '  '
        for ($c = 0; $c -lt ($w - 6); $c++) {
            if ((Get-Random -Maximum 4) -eq 0) {
                $line += $chars[(Get-Random -Maximum $chars.Length)]
            } else {
                $line += ' '
            }
        }
        Write-Host $line -ForegroundColor DarkGreen
        Start-Sleep -Milliseconds 45
    }
    Write-Host ''

    # Fake subsystem scan
    Write-Host '  [ SYS SCAN ]' -ForegroundColor Green
    Start-Sleep -Milliseconds 120
    Write-ScanLine 'WMI bridge' 'online'
    Start-Sleep -Milliseconds 80
    Write-ScanLine 'Registry hive' 'mounted'
    Start-Sleep -Milliseconds 80
    Write-ScanLine 'TLS handshake' 'pending'
    Start-Sleep -Milliseconds 100
    Write-ScanLine 'TLS handshake' 'verified'
    Start-Sleep -Milliseconds 80
    Write-ScanLine 'Token vault' 'loaded'
    Start-Sleep -Milliseconds 80
    Write-ScanLine 'Payload encoder' 'JSON/UTF-8'
    Write-Host ''

    # Progress bar
    Write-Host '  LOADING MODULES ' -NoNewline -ForegroundColor Cyan
    Write-Host ('[' + (' ' * $barW) + ']') -NoNewline -ForegroundColor DarkGray
    Write-Host ' 0%' -ForegroundColor DarkGreen

    $top = [Console]::CursorTop - 1
    $left = 19

    for ($p = 0; $p -le 100; $p += 2) {
        $filled = [int][Math]::Round(($barW * $p) / 100)
        if ($filled -gt $barW) { $filled = $barW }
        $empty = $barW - $filled
        $bar = ('#' * $filled) + (' ' * $empty)

        try {
            [Console]::SetCursorPosition($left, $top)
            Write-Host $bar -NoNewline -ForegroundColor Green
            [Console]::SetCursorPosition($left + $barW + 2, $top)
            $pct = ('{0,3}' -f $p) + '%'
            Write-Host $pct -NoNewline -ForegroundColor $(if ($p -ge 100) { 'Green' } else { 'DarkGreen' })
        } catch {
            # Fallback if console resize breaks cursor position
            Write-Host "`r  LOADING MODULES [$bar] $p%" -NoNewline -ForegroundColor Green
        }

        $delay = 28
        if ($p -gt 70) { $delay = 45 }
        if ($p -gt 90) { $delay = 70 }
        Start-Sleep -Milliseconds $delay
    }

    Write-Host ''
    Write-Host ''
    Write-Slow '  > HANDOFF TO INVENTORY CLIENT...' 10 'Green'
    Start-Sleep -Milliseconds 250

    Write-Host ''
    Write-Host ('  ' + ('=' * ($w - 4))) -ForegroundColor DarkGreen
    Write-Host '  LINK ESTABLISHED // STARTING COLLECTOR' -ForegroundColor Green
    Write-Host ''
    Start-Sleep -Milliseconds 400
}
finally {
    [Console]::CursorVisible = $cursorWasVisible
}
