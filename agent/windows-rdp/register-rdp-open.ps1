$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'open-rdp.vbs'
$dir = Join-Path $env:LOCALAPPDATA 'CORAX'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dest = Join-Path $dir 'open-rdp.vbs'
Copy-Item -LiteralPath $src -Destination $dest -Force
$cmd = 'wscript.exe //B //Nologo "' + $dest + '" "%1"'
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\corax-rdp')
$k.SetValue('', 'URL:CORAX Remote Desktop')
$k.SetValue('URL Protocol', '')
$c = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\corax-rdp\shell\open\command')
$c.SetValue('', $cmd)
$k.Close()
$c.Close()
Write-Output $cmd
