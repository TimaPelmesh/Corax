#Requires -Version 5.1
# USB (shallow scan), Docker, WSL

function Get-ExtendedVirtual {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'usb_history') {
        Log '[ext] USB devices (quick scan)...'
        $max = Get-ModuleLimit -Config $Config -Name 'usb_max' -Default 80
        $usb = [System.Collections.ArrayList]@()
        $usbRoot = 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB'
        try {
            if (Test-Path $usbRoot) {
                foreach ($vendor in @(Get-ChildItem -Path $usbRoot -ErrorAction SilentlyContinue)) {
                    foreach ($dev in @(Get-ChildItem -Path $vendor.PSPath -ErrorAction SilentlyContinue)) {
                        if ($usb.Count -ge $max) { break }
                        $friendly = $null
                        try {
                            $fp = Join-Path $dev.PSPath 'Device Parameters'
                            if (Test-Path $fp) {
                                $dp = Get-ItemProperty -Path $fp -ErrorAction SilentlyContinue
                                if ($dp.FriendlyName) { $friendly = [string]$dp.FriendlyName }
                            }
                        } catch { }
                        $name = if ($friendly) { $friendly } else { $dev.PSChildName }
                        [void]$usb.Add(@{
                            friendly_name = $name
                            instance_id   = $dev.PSChildName
                        })
                    }
                    if ($usb.Count -ge $max) { break }
                }
            }
        } catch { }
        if ($usb.Count -gt 0) { $out.usb_devices = @($usb.ToArray()) }
    }

    if (Test-ModuleEnabled $Config 'docker_wsl') {
        Log '[ext] Docker, WSL, Hyper-V...'
        $virt = @{}

        if (Get-Command docker -ErrorAction SilentlyContinue) {
            $dv = Invoke-WithTimeout -TimeoutSec 3 -ScriptBlock {
                docker version --format '{{.Server.Version}}' 2>$null
            }
            if ($dv) {
                $virt.docker = @{ installed = $true; server_version = [string]$dv }
            } else {
                $virt.docker = @{ installed = $true; server_version = $null }
            }
        } else {
            $virt.docker = @{ installed = $false }
        }

        try {
            $wslRaw = Invoke-WithTimeout -TimeoutSec 3 -ScriptBlock {
                wsl --list --verbose 2>$null
            }
            $wslLines = if ($wslRaw) { @($wslRaw) } else { @() }
            if ($wslLines.Count -gt 0) {
                $distros = [System.Collections.ArrayList]@()
                foreach ($line in $wslLines) {
                    if ($line -match '^\s*$' -or $line -match 'NAME\s+STATE') { continue }
                    $parts = ($line -split '\s+', 3) | Where-Object { $_ }
                    if ($parts.Count -ge 2) {
                        [void]$distros.Add(@{
                            name    = [string]$parts[0]
                            state   = [string]$parts[1]
                            version = if ($parts.Count -ge 3) { [string]$parts[2] } else { $null }
                        })
                    }
                }
                $virt.wsl = @{ distros = @($distros.ToArray()) }
            }
        } catch {
            $virt.wsl = @{ installed = (Test-Path "$env:WINDIR\System32\wsl.exe") }
        }

        try {
            $hv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization' -ErrorAction SilentlyContinue
            if ($hv) { $virt.hyper_v_note = 'Virtualization key present' }
        } catch { }

        $out.virtualization = $virt
    }

    return $out
}
