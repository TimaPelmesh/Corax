# Safe boot banner (Win10/11). Skip: INV_NOPAUSE=1 or -Quick.
# Do not move/hide the console cursor or clear the screen — that kills conhost on some PCs.
param([switch]$Quick)

$ErrorActionPreference = 'SilentlyContinue'
if ($Quick -or $env:INV_NOPAUSE -eq '1') { exit 0 }

try { $Host.UI.RawUI.WindowTitle = 'CORAX AGENT' } catch { }

try {
    Write-Host ''
    Write-Host '  =============================================' -ForegroundColor Green
    Write-Host '              CORAX AGENT  ::  UPLINK' -ForegroundColor Green
    Write-Host '  =============================================' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Starting inventory collector...' -ForegroundColor Cyan
    Write-Host '  After send: desktop shortcut  /h  (this PC)' -ForegroundColor DarkGray
    Write-Host ''
} catch { }
exit 0
