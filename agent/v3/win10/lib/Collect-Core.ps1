#Requires -Version 5.1
# Core inventory (hardware, OS, software, peripherals) - CORAX API v1

function Get-PrimaryMac {
    $cfg = Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPEnabled } | Select-Object -First 1
    if (-not $cfg) { return $null }
    ($cfg.MACAddress -replace '-', ':').ToUpperInvariant()
}

function Get-PreferredHostname {
    if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Trim()) { return $env:COMPUTERNAME.Trim() }
    try {
        $n = [System.Net.Dns]::GetHostName()
        if ($n -and $n.Trim()) { return $n.Trim() }
    } catch { }
    'unknown-host'
}

function Get-InstalledSoftwareMax([int]$Max = 12000) {
    $pathPatterns = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    try {
        foreach ($usr in Get-ChildItem -Path 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue) {
            $sid = $usr.PSChildName
            if ($sid -notmatch '^S-1-5-21-') { continue }
            $pathPatterns += "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
            $pathPatterns += "Registry::HKEY_USERS\$sid\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
        }
    } catch { }

    $seen = @{}
    $list = [System.Collections.Generic.List[object]]::new()
    :outer foreach ($pattern in $pathPatterns) {
        foreach ($prop in @(Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue)) {
            if ($list.Count -ge $Max) { break outer }
            $dn = $prop.DisplayName
            if (-not $dn) { continue }
            $name = $dn.ToString().Trim()
            if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
            $v = $null
            if ($prop.DisplayVersion) {
                $v = $prop.DisplayVersion.ToString().Trim()
                if ($v.Length -gt 255) { $v = $v.Substring(0, 255) }
            }
            $verKey = if ($v) { $v.ToLowerInvariant() } else { '' }
            $dedupe = $name.ToLowerInvariant() + [char]0 + $verKey
            if ($seen.ContainsKey($dedupe)) { continue }
            $seen[$dedupe] = $true
            [void]$list.Add(@{ name = $name; version = $v })
        }
    }
    @($list | Sort-Object { $_.name })
}

function Test-IsRealMonitorName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    $n = $Name.Trim().ToLowerInvariant()
    if ($n -match 'pnp') { return $false }
    if ($n -match 'nvidia|amd|radeon|intel\(r\)?.*graphics|geforce|display adapter') { return $false }
    if ($n -match 'mirror|dameware|remote display|basic display') { return $false }
    return $true
}

function Get-PnpPeripheralsForReport([int]$Max = 140) {
    $classToKind = @{
        Keyboard = 'keyboard'; Mouse = 'mouse'; Monitor = 'monitor'; Display = 'monitor'
        Image = 'camera'; Camera = 'camera'; AudioEndpoint = 'audio'; MEDIA = 'audio'; MIDI = 'audio'
        Printer = 'printer'; PrintQueue = 'printer'; Biometric = 'biometric'
        Bluetooth = 'bluetooth'; Net = 'net'; PointerClass = 'touchpad'
    }

    $RU_PRINT_QUEUE_ROOT = -join @(
        [char]0x43a, [char]0x43e, [char]0x440, [char]0x43d, [char]0x435, [char]0x432, [char]0x430, [char]0x44f,
        [char]0x20, [char]0x43e, [char]0x447, [char]0x435, [char]0x440, [char]0x435, [char]0x434, [char]0x44c,
        [char]0x20, [char]0x43f, [char]0x435, [char]0x447, [char]0x430, [char]0x442, [char]0x438
    )

    function Test-IsNoisePeripheral {
        param([string]$Kind, [string]$Name)
        if ([string]::IsNullOrWhiteSpace($Kind) -or [string]::IsNullOrWhiteSpace($Name)) { return $true }
        $n = $Name.Trim()
        if (-not $n) { return $true }
        $nl = $n.ToLowerInvariant()

        if ($Kind -eq 'net') {
            if ($nl -match '^wan\s+miniport\b') { return $true }
            if ($nl -match '\b(pppoe|pptp|sstp|l2tp|ikev2)\b') { return $true }
            if ($nl -match '\b(network\s+monitor|isatap|teredo|6to4)\b') { return $true }
            if ($nl -match '\bmicrosoft\s+wi-?fi\s+direct\s+virtual\s+adapter\b') { return $true }
            if ($nl -match '\bmicrosoft\s+kernel\s+debug\s+network\s+adapter\b') { return $true }
            if ($nl -match '\b(hyper-?v|vmware|virtualbox)\b') { return $true }
            if ($nl -match '\bvirtual\s+(ethernet|switch)\b') { return $true }
            if ($nl -match '\b(tap|tunnel|loopback|vpn|wintun)\b') { return $true }
        }

        if ($Kind -eq 'keyboard' -or $Kind -eq 'mouse') {
            if ($nl -match '\bdameware\b') { return $true }
        }

        if ($Kind -eq 'printer') {
            if ($nl -eq $RU_PRINT_QUEUE_ROOT -or $nl -eq 'print queue root') { return $true }
            if ($nl -match '^microsoft\s+print\s+to\s+pdf$') { return $true }
            if ($nl -match '\bxps\s+document\s+writer\b') { return $true }
            if ($nl -match 'onenote') { return $true }
            if ($nl -match '^fax$') { return $true }
        }

        return $false
    }

    $kindOrder = @{
        monitor = 0; printer = 1; keyboard = 2; mouse = 3; camera = 4; audio = 5
        biometric = 6; bluetooth = 7; touchpad = 8; net = 9
    }

    $seen = @{}
    $out = [System.Collections.ArrayList]@()
    foreach ($d in @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)) {
        if ($out.Count -ge $Max) { break }
        if (-not $d.Class) { continue }
        $cls = [string]$d.Class
        if (-not $classToKind.ContainsKey($cls)) { continue }
        $nameRaw = $null
        if ($d.FriendlyName -and ([string]$d.FriendlyName).Trim()) { $nameRaw = [string]$d.FriendlyName }
        elseif ($d.Name -and ([string]$d.Name).Trim()) { $nameRaw = [string]$d.Name }
        else { continue }
        $name = $nameRaw.Trim()
        if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
        $kind = [string]$classToKind[$cls]
        if ($kind -eq 'monitor' -and -not (Test-IsRealMonitorName $name)) { continue }
        if (Test-IsNoisePeripheral -Kind $kind -Name $name) { continue }
        $key = "$kind|$($name.ToLowerInvariant())"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$out.Add([pscustomobject]@{ kind = $kind; name = $name })
    }
    try {
        foreach ($m in @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue)) {
            if ($out.Count -ge $Max) { break }
            $parts = @()
            $mf = -join ($m.ManufacturerName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })
            $pn = -join ($m.UserFriendlyName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })
            $sn = -join ($m.SerialNumberID | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })
            if ($mf) { $parts += $mf.Trim() }
            if ($pn) { $parts += $pn.Trim() }
            if ($sn) { $parts += ("SN:" + $sn.Trim()) }
            $name = ($parts -join ' ').Trim()
            if (-not $name) { continue }
            if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
            if (-not (Test-IsRealMonitorName $name)) { continue }
            $key = "monitor|$($name.ToLowerInvariant())"
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$out.Add([pscustomobject]@{ kind = 'monitor'; name = $name })
        }
    } catch { }

    @($out.ToArray() | Sort-Object { if ($kindOrder.ContainsKey($_.kind)) { $kindOrder[$_.kind] } else { 99 } }, { $_.name })
}

function Get-InventoryGpuName {
    $names = [System.Collections.ArrayList]@()
    foreach ($v in @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)) {
        if ($v.Name -and $v.Name.Trim()) { [void]$names.Add($v.Name.Trim()) }
    }
    if ($names.Count -eq 0) { return $null }
    foreach ($n in $names) {
        if ($n -match '(?i)(nvidia|amd|radeon|intel)') {
            if ($n.Length -gt 512) { return $n.Substring(0, 512) }
            return $n
        }
    }
    return [string]$names[0]
}

function Get-InventoryDisks {
    $rows = [System.Collections.ArrayList]@()
    $seen = @{}
    foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue)) {
        $size = [double]$d.Size
        if ($size -le 0) { continue }
        $mount = ($d.DeviceID -as [string]).Trim().ToUpperInvariant()
        if ($seen.ContainsKey($mount)) { continue }
        $seen[$mount] = $true
        $free = [double]$d.FreeSpace
        [void]$rows.Add([pscustomobject]@{
            mount = $mount; label = $d.VolumeName
            total_gb = [math]::Round($size / 1GB, 2)
            used_percent = [int]([math]::Round(100.0 * ($size - $free) / $size, 0))
            free_gb = [math]::Round($free / 1GB, 2)
        })
    }
    @($rows.ToArray())
}

function Get-CoreInventoryPayload {
    param($Config)
    $swMax = Get-ModuleLimit -Config $Config -Name 'software_max' -Default 12000

    Set-AgentProgress '[1/4] WMI: system, BIOS, OS, CPU...' 20
    Log '[core] WMI: system, BIOS, OS, CPU...'
    $cs = Get-CimInstance Win32_ComputerSystem
    $bios = Get-CimInstance Win32_BIOS
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

    $serial = Get-CleanWmiText $(if ($bios.SerialNumber) { $bios.SerialNumber })
    $mfr = Get-CleanWmiText $(if ($cs.Manufacturer) { $cs.Manufacturer })
    $model = Get-CleanWmiText $(if ($cs.Model) { $cs.Model })

    $bb = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue
    $mbMfr = $mbProd = $null
    if ($bb) {
        $mbMfr = Get-CleanWmiText $bb.Manufacturer
        $mbProd = Get-CleanWmiText $bb.Product
        if (-not $serial) { $serial = Get-CleanWmiText $bb.SerialNumber }
        if (-not $mfr) { $mfr = $mbMfr }
        if (-not $model) { $model = $mbProd }
    }

    $ram = [math]::Round([double]$cs.TotalPhysicalMemory / 1GB, 2)
    $cpuName = if ($cpu.Name) { $cpu.Name.Trim() } else { $null }
    $memPct = $null
    try {
        $tMem = [double]$os.TotalVisibleMemorySize * 1KB
        $fMem = [double]$os.FreePhysicalMemory * 1KB
        if ($tMem -gt 0) { $memPct = [int]([math]::Round(100.0 * ($tMem - $fMem) / $tMem, 0)) }
    } catch { }

    Set-AgentProgress '[2/4] Registry: installed software...' 40
    Log '[core] Registry: installed software...'
    $sw = @(Get-InstalledSoftwareMax -Max $swMax)

    Set-AgentProgress '[3/4] PnP: peripherals...' 55
    Log '[core] PnP: peripherals...'
    $periph = @(Get-PnpPeripheralsForReport)

    Set-AgentProgress '[4/4] GPU, disks...' 65
    Log '[core] GPU, disks...'
    $gpu = Get-InventoryGpuName
    $disks = @(Get-InventoryDisks)

    [ordered]@{
        hostname                 = (Get-PreferredHostname)
        serial_number            = $serial
        mac_primary              = (Get-PrimaryMac)
        cpu                      = $cpuName
        ram_gb                   = $ram
        memory_used_percent      = $memPct
        gpu_name                 = $gpu
        disks                    = $disks
        os_name                  = if ($os.Caption) { ($os.Caption -split '\|')[0].Trim() } else { 'Windows' }
        os_version               = "$($os.Version) build $($os.BuildNumber)".Trim()
        manufacturer             = $mfr
        model                    = $model
        motherboard_manufacturer = $mbMfr
        motherboard_product      = $mbProd
        software                 = $sw
        peripherals              = $periph
    }
}
