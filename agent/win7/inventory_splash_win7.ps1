# Safe boot banner (Win7 / PowerShell 2.0, ASCII only).
# Skip unless CORAX_SPLASH=1. Do not move/hide the console cursor.
param([switch]$Quick)

if ($Quick -or $env:INV_NOPAUSE -eq '1') { exit 0 }

try { $Host.UI.RawUI.WindowTitle = 'CORAX AGENT' } catch { }

try {
    Write-Host ''
    Write-Host '  =============================================' -ForegroundColor Green
    Write-Host '       CORAX AGENT  ::  WIN7 UPLINK' -ForegroundColor Green
    Write-Host '  =============================================' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Starting inventory collector...' -ForegroundColor Cyan
    Write-Host ''
} catch { }
exit 0
