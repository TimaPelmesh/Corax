# Safe boot banner (Win10/11). Skip: INV_NOPAUSE=1 or nopause arg.
#
# Do not move the console cursor or hide it, and do not clear the screen or
# run random "rain" loops. Those APIs abort conhost on many PCs (admin and
# user), so the .bat window vanishes in the middle of the animation.
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
} catch {
    # Banner is cosmetic. Collection still runs from the .bat.
}
exit 0
