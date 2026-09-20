#Requires -Version 5.1
<#
  CORAX Full Audit — ручной "максимальный" сборщик для Windows.

  В отличие от штатного тихого агента (раскатка через GPO), этот скрипт
  запускается администратором вручную на конкретной машине и собирает по
  максимуму: железо, здоровье, эксплуатацию и безопасность.

  Особенности:
    * сам поднимает права (UAC), если запущен без админа;
    * шумный вывод в консоль — видно, что собирается;
    * one-shot, без планировщика;
    * шлёт тот же отчёт на /api/v1/agent/inventory (Bearer-токен),
      всё «расширенное» кладёт в extended.* — схему бэкенда трогать не нужно.

  Запуск:
    powershell -ExecutionPolicy Bypass -File Corax-FullAudit.ps1 -Server http://SERVER:3001 -Token <TOKEN>
  либо задать переменные окружения INVENTORY_SERVER / AGENT_TOKEN,
  либо просто запустить и ввести значения в консоли.
#>

[CmdletBinding()]
param(
    [string]$Server = $env:INVENTORY_SERVER,
    [string]$Token  = $env:AGENT_TOKEN,
    [switch]$NoPause,
    [int]$SoftwareMax = 8000,
    [int]$EventMax = 40
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# ----------------------------------------------------------------------------
# Инфраструктура: вывод, самоподъём прав, утилиты
# ----------------------------------------------------------------------------

function Write-Step($msg)  { Write-Host ("  [*] {0}" -f $msg) -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host ("  [+] {0}" -f $msg) -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host ("  [!] {0}" -f $msg) -ForegroundColor Yellow }
function Write-ErrLine($msg) { Write-Host ("  [x] {0}" -f $msg) -ForegroundColor Red }

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    } catch {
        return $false
    }
}

function Invoke-SelfElevate {
    # Обычно повышение делает corax_audit.bat (одно окно). Это — запасной путь,
    # если .ps1 запустили напрямую без прав администратора.
    if (Test-IsAdmin) { return }
    if ([string]::IsNullOrWhiteSpace($PSCommandPath)) {
        Write-Warn2 'Запуск без прав администратора (не удалось определить путь для перезапуска).'
        return
    }
    Write-Warn2 'Нужны права администратора — открываю окно с повышением прав (UAC)...'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Process -Id $PID).Path
    if ([string]::IsNullOrWhiteSpace($psi.FileName)) { $psi.FileName = 'powershell.exe' }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Server) { $argList += @('-Server', "`"$Server`"") }
    if ($Token)  { $argList += @('-Token', "`"$Token`"") }
    $psi.Arguments = ($argList -join ' ')
    $psi.Verb = 'runas'
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    try { $psi.WorkingDirectory = (Split-Path -Parent $PSCommandPath) } catch { }
    try {
        [void][System.Diagnostics.Process]::Start($psi)
        exit 0
    } catch {
        # 1223 = пользователь отклонил UAC; иначе повышение недоступно (политики/сервис AppInfo).
        Write-Warn2 ("Повышение прав не выполнено ({0})." -f $_.Exception.Message)
        Write-Warn2 'Продолжаю без администратора — часть данных (BitLocker, SMART, службы, локальные админы) будет пропущена.'
    }
}

function To-Bool($v) {
    if ($null -eq $v) { return $null }
    try { return [bool]$v } catch { return $null }
}

function Round-Gb($bytes, $digits = 2) {
    if (-not $bytes) { return $null }
    try {
        $n = [double]$bytes
        if ($n -le 0) { return $null }
        return [math]::Round($n / 1GB, $digits)
    } catch { return $null }
}

function Safe([scriptblock]$block, $label) {
    try {
        return & $block
    } catch {
        Write-Warn2 ("{0}: пропущено ({1})" -f $label, $_.Exception.Message)
        return $null
    }
}

# ----------------------------------------------------------------------------
# CORE — базовый инвентарь (совпадает по форме со штатным агентом)
# ----------------------------------------------------------------------------

function Get-CorePayload {
    $cs  = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    $os  = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $mb  = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue | Select-Object -First 1
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
        Where-Object { $_.Name } | Select-Object -First 1

    $ramGb = Round-Gb $cs.TotalPhysicalMemory
    $memUsedPct = $null
    if ($os -and $os.TotalVisibleMemorySize -gt 0) {
        $memUsedPct = [int]((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) * 100) / $os.TotalVisibleMemorySize)
    }

    # первый физический MAC с включённым IP
    $mac = $null
    $nic = Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPEnabled -and $_.MACAddress } | Select-Object -First 1
    if ($nic) { $mac = $nic.MACAddress }

    # логические тома
    $disks = @()
    foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)) {
        if (-not $d.Size) { continue }
        $totalGb = Round-Gb $d.Size
        $freeGb  = Round-Gb $d.FreeSpace
        $usedPct = 0
        if ($d.Size -gt 0) { $usedPct = [int]((($d.Size - $d.FreeSpace) * 100) / $d.Size) }
        $disks += [ordered]@{
            mount = $d.DeviceID
            label = if ($d.VolumeName) { $d.VolumeName } else { $null }
            total_gb = $totalGb
            used_percent = $usedPct
            free_gb = $freeGb
        }
    }

    $software = Get-InstalledSoftware
    $peripherals = Get-Peripherals
    $printers = Get-Printers

    return [ordered]@{
        hostname = $env:COMPUTERNAME
        serial_number = if ($bios) { ($bios.SerialNumber | Out-String).Trim() } else { $null }
        mac_primary = $mac
        cpu = if ($cpu) { ($cpu.Name | Out-String).Trim() } else { $null }
        ram_gb = $ramGb
        os_name = if ($os) { ($os.Caption | Out-String).Trim() } else { 'Windows' }
        os_version = if ($os) { $os.Version } else { $null }
        manufacturer = if ($cs) { $cs.Manufacturer } else { $null }
        model = if ($cs) { $cs.Model } else { $null }
        gpu_name = if ($gpu) { $gpu.Name } else { $null }
        memory_used_percent = $memUsedPct
        motherboard_manufacturer = if ($mb) { $mb.Manufacturer } else { $null }
        motherboard_product = if ($mb) { $mb.Product } else { $null }
        disks = $disks
        software = $software
        peripherals = $peripherals
        printers = $printers
    }
}

function Get-InstalledSoftware {
    $items = New-Object System.Collections.Generic.List[object]
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $seen = @{}
    foreach ($p in $paths) {
        foreach ($k in (Get-ItemProperty $p -ErrorAction SilentlyContinue)) {
            $name = $k.DisplayName
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ($k.SystemComponent -eq 1) { continue }
            $key = ($name + '|' + $k.DisplayVersion).ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$items.Add([ordered]@{
                name = [string]$name
                version = if ($k.DisplayVersion) { [string]$k.DisplayVersion } else { $null }
            })
            if ($items.Count -ge $SoftwareMax) { break }
        }
    }
    return @($items.ToArray())
}

function Get-Peripherals {
    $out = New-Object System.Collections.Generic.List[object]
    $classes = @('Keyboard', 'Mouse', 'Monitor', 'Printer', 'Camera', 'Media')
    foreach ($pnp in (Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
            Where-Object { $_.PNPClass -in $classes -and $_.Name })) {
        [void]$out.Add([ordered]@{
            kind = ($pnp.PNPClass).ToLowerInvariant()
            name = [string]$pnp.Name
        })
        if ($out.Count -ge 200) { break }
    }
    return @($out.ToArray())
}

function Get-Printers {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($pr in (Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue)) {
        [void]$out.Add([ordered]@{
            name = [string]$pr.Name
            driver_name = [string]$pr.DriverName
            port_name = [string]$pr.PortName
            shared = [bool]$pr.Shared
            is_default = [bool]$pr.Default
            is_network = [bool]$pr.Network
            work_offline = [bool]$pr.WorkOffline
        })
    }
    return @($out.ToArray())
}

# ----------------------------------------------------------------------------
# EXTENDED — расширенный аудит
# ----------------------------------------------------------------------------

function Get-Ext-System {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $primary = $null
    if ($cs -and $cs.UserName) { $primary = $cs.UserName }
    $uptimeHours = $null
    $lastBoot = $null
    if ($os -and $os.LastBootUpTime) {
        $lastBoot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        $uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    }
    $tz = Safe { (Get-TimeZone).Id } 'timezone'
    return @{
        system = @{ primary_user = $primary }
        uptime_hours = $uptimeHours
        last_boot = $lastBoot
        timezone = $tz
    }
}

function Get-Ext-Network {
    $adapters = New-Object System.Collections.Generic.List[object]
    $dns = New-Object System.Collections.Generic.List[string]
    $gws = New-Object System.Collections.Generic.List[string]
    foreach ($n in (Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPEnabled })) {
        $ipv4 = @($n.IPAddress) | Where-Object { $_ -and $_ -notmatch ':' } | Select-Object -First 1
        [void]$adapters.Add(@{
            name = [string]$n.Description
            mac = [string]$n.MACAddress
            ipv4 = $ipv4
        })
        foreach ($g in @($n.DefaultIPGateway)) { if ($g) { [void]$gws.Add([string]$g) } }
        foreach ($d in @($n.DNSServerSearchOrder)) { if ($d) { [void]$dns.Add([string]$d) } }
    }
    $wifi = @()
    $ssid = Safe {
        $line = (netsh wlan show interfaces 2>$null | Select-String -Pattern '^\s*SSID\s*:' | Select-Object -First 1)
        if ($line) { ($line.ToString() -replace '^\s*SSID\s*:\s*', '').Trim() } else { $null }
    } 'wifi'
    if ($ssid) { $wifi = @(@{ ssid = $ssid }) }
    return @{
        adapters = @($adapters.ToArray())
        dns_v4 = @($dns.ToArray() | Where-Object { $_ -notmatch ':' } | Select-Object -Unique)
        dns_v6 = @($dns.ToArray() | Where-Object { $_ -match ':' } | Select-Object -Unique)
        gateways = @($gws.ToArray() | Select-Object -Unique)
        primary_ip = @($adapters.ToArray() | ForEach-Object { $_.ipv4 } | Where-Object { $_ } | Select-Object -First 1)
        wifi = $wifi
    }
}

function Get-Ext-Storage {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($pd in (Safe { Get-PhysicalDisk } 'physical_disks')) {
        $rel = Safe { $pd | Get-StorageReliabilityCounter } 'reliability'
        [void]$out.Add([ordered]@{
            friendly_name = [string]$pd.FriendlyName
            media_type = [string]$pd.MediaType
            health_status = [string]$pd.HealthStatus
            size_gb = Round-Gb $pd.Size
            bus = [string]$pd.BusType
            serial = [string]$pd.SerialNumber
            temperature_c = if ($rel) { $rel.Temperature } else { $null }
            wear_percent = if ($rel) { $rel.Wear } else { $null }
            power_on_hours = if ($rel) { $rel.PowerOnHours } else { $null }
            read_errors = if ($rel) { $rel.ReadErrorsTotal } else { $null }
        })
    }
    return @($out.ToArray())
}

function Get-Ext-RamModules {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($m in (Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)) {
        [void]$out.Add([ordered]@{
            bank = [string]$m.BankLabel
            slot = [string]$m.DeviceLocator
            size_gb = Round-Gb $m.Capacity
            speed_mhz = [int]$m.Speed
            manufacturer = [string]$m.Manufacturer
            part_number = ([string]$m.PartNumber).Trim()
        })
    }
    return @($out.ToArray())
}

function Get-Ext-Monitors {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($mon in (Safe { Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID } 'monitors')) {
        $decode = {
            param($arr)
            if (-not $arr) { return $null }
            ( -join ($arr | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ }) ).Trim()
        }
        [void]$out.Add([ordered]@{
            manufacturer = & $decode $mon.ManufacturerName
            model = & $decode $mon.UserFriendlyName
            serial = & $decode $mon.SerialNumberID
            year = [int]$mon.YearOfManufacture
        })
    }
    return @($out.ToArray())
}

function Get-Ext-Gpus {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($g in (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name })) {
        [void]$out.Add([ordered]@{
            name = [string]$g.Name
            vram_gb = Round-Gb $g.AdapterRAM
            driver_version = [string]$g.DriverVersion
        })
    }
    return @($out.ToArray())
}

function Get-Ext-Security {
    $out = @{}

    # BitLocker
    $bl = New-Object System.Collections.Generic.List[object]
    foreach ($v in (Safe { Get-BitLockerVolume } 'bitlocker')) {
        [void]$bl.Add([ordered]@{
            mount = [string]$v.MountPoint
            protection = [string]$v.ProtectionStatus
            method = [string]$v.EncryptionMethod
            percent = [int]$v.EncryptionPercentage
        })
    }
    if ($bl.Count) { $out.bitlocker = @($bl.ToArray()) }

    # TPM
    $tpm = Safe { Get-Tpm } 'tpm'
    if ($tpm) {
        $out.tpm = @{
            present = [bool]$tpm.TpmPresent
            ready = [bool]$tpm.TpmReady
            enabled = [bool]$tpm.TpmEnabled
        }
    }

    # Secure Boot
    $sb = Safe { Confirm-SecureBootUEFI } 'secure_boot'
    if ($null -ne $sb) { $out.secure_boot_enabled = [bool]$sb }

    # Defender
    $mp = Safe { Get-MpComputerStatus } 'defender'
    if ($mp) {
        $sigAge = $null
        if ($mp.AntivirusSignatureLastUpdated) {
            $sigAge = [math]::Round(((Get-Date) - $mp.AntivirusSignatureLastUpdated).TotalDays, 1)
        }
        $out.defender = @{
            antivirus_enabled = [bool]$mp.AntivirusEnabled
            rtp_enabled = [bool]$mp.RealTimeProtectionEnabled
            signature_age_days = $sigAge
            last_quick_scan = if ($mp.QuickScanEndTime) { $mp.QuickScanEndTime.ToUniversalTime().ToString('o') } else { $null }
        }
        $out.antivirus = @(@{ display_name = 'Windows Defender'; enabled = [bool]$mp.AntivirusEnabled })
    }

    # Сторонние AV из SecurityCenter2
    $av = Safe { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct } 'antivirus'
    if ($av) {
        $list = New-Object System.Collections.Generic.List[object]
        foreach ($a in $av) { [void]$list.Add(@{ display_name = [string]$a.displayName }) }
        if ($list.Count) { $out.antivirus = @($list.ToArray()) }
    }

    # Firewall
    $fw = Safe { Get-NetFirewallProfile } 'firewall'
    if ($fw) {
        $prof = @{}
        foreach ($p in $fw) { $prof[($p.Name).ToLowerInvariant()] = [bool]$p.Enabled }
        $out.firewall = $prof
    }

    # Локальные админы
    $admins = New-Object System.Collections.Generic.List[string]
    $am = Safe { Get-LocalGroupMember -Group 'Administrators' } 'local_admins'
    if (-not $am) { $am = Safe { Get-LocalGroupMember -SID 'S-1-5-32-544' } 'local_admins' }
    foreach ($a in $am) { [void]$admins.Add([string]$a.Name) }
    if ($admins.Count) { $out.local_admins = @($admins.ToArray() | Select-Object -First 25) }

    # Истекающие сертификаты (машинное хранилище)
    $certs = New-Object System.Collections.Generic.List[object]
    foreach ($c in (Safe { Get-ChildItem Cert:\LocalMachine\My } 'certs')) {
        if (-not $c.NotAfter) { continue }
        $days = [int]((($c.NotAfter) - (Get-Date)).TotalDays)
        if ($days -gt 180) { continue }
        [void]$certs.Add([ordered]@{
            subject = [string]$c.Subject
            not_after = $c.NotAfter.ToUniversalTime().ToString('o')
            days_left = $days
        })
    }
    if ($certs.Count) { $out.expiring_certs = @($certs.ToArray()) }

    return $out
}

function Get-Ext-Patches {
    $out = New-Object System.Collections.Generic.List[object]
    $last = $null
    foreach ($h in (Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending)) {
        if ($h.InstalledOn -and -not $last) { $last = $h.HotFixID }
        [void]$out.Add([ordered]@{
            hotfix_id = [string]$h.HotFixID
            installed_on = if ($h.InstalledOn) { $h.InstalledOn.ToString('yyyy-MM-dd') } else { $null }
        })
        if ($out.Count -ge 200) { break }
    }
    return @{ patches = @($out.ToArray()); last_hotfix_id = $last }
}

function Get-Ext-PendingReboot {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
    )
    foreach ($k in $keys) { if (Test-Path $k) { return $true } }
    $pfro = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
    if ($pfro.PendingFileRenameOperations) { return $true }
    return $false
}

function Get-Ext-Ops {
    $out = @{}

    # Слушающие порты
    $ports = New-Object System.Collections.Generic.List[object]
    $conns = Safe { Get-NetTCPConnection -State Listen } 'listening_ports'
    if ($conns) {
        $procCache = @{}
        foreach ($c in ($conns | Sort-Object LocalPort -Unique)) {
            $pname = $null
            if ($c.OwningProcess) {
                if (-not $procCache.ContainsKey($c.OwningProcess)) {
                    $procCache[$c.OwningProcess] = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
                }
                $pname = $procCache[$c.OwningProcess]
            }
            [void]$ports.Add([ordered]@{ proto = 'tcp'; port = [int]$c.LocalPort; process = $pname })
        }
    }
    if ($ports.Count) {
        $out.listening_ports = @($ports.ToArray() | Select-Object -First 60)
        $out.listening_ports_count = $ports.Count
    }

    # Автозапуск (Run-ключи)
    $autoruns = New-Object System.Collections.Generic.List[object]
    $runKeys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    )
    foreach ($rk in $runKeys) {
        $props = Get-ItemProperty $rk -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -like 'PS*') { continue }
            [void]$autoruns.Add([ordered]@{ name = $p.Name; command = [string]$p.Value })
        }
    }
    if ($autoruns.Count) { $out.autoruns = @($autoruns.ToArray() | Select-Object -First 60) }

    # Задачи планировщика (только не-Microsoft, включённые)
    $tasks = Safe {
        Get-ScheduledTask | Where-Object {
            $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\Microsoft\*'
        }
    } 'scheduled_tasks'
    if ($tasks) {
        $out.scheduled_tasks_count = @($tasks).Count
        $out.scheduled_tasks = @($tasks | Select-Object -First 40 | ForEach-Object {
            @{ name = [string]$_.TaskName; path = [string]$_.TaskPath }
        })
    }

    # Запущенные службы (счётчик + автозапуск-режим)
    $svc = Safe { Get-CimInstance Win32_Service } 'services'
    if ($svc) {
        $out.services_running = @($svc | Where-Object { $_.State -eq 'Running' }).Count
        $out.services_auto_stopped = @($svc | Where-Object {
            $_.StartMode -eq 'Auto' -and $_.State -ne 'Running'
        } | Select-Object -First 40 | ForEach-Object { @{ name = [string]$_.Name; display = [string]$_.DisplayName } })
    }

    return $out
}

function Get-Ext-HardErrors {
    $ids = 41, 1001, 6008, 7, 11, 51, 17, 18, 19
    $events = Safe {
        Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = $ids } -MaxEvents 200 -ErrorAction Stop
    } 'hard_errors'
    if (-not $events) { return @() }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($e in ($events | Select-Object -First $EventMax)) {
        $msg = ([string]$e.Message)
        if ($msg.Length -gt 240) { $msg = $msg.Substring(0, 240) }
        [void]$out.Add([ordered]@{
            time = $e.TimeCreated.ToUniversalTime().ToString('o')
            id = [int]$e.Id
            source = [string]$e.ProviderName
            message = $msg
        })
    }
    return @($out.ToArray())
}

function Get-Ext-BatteryHealth {
    $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $bat) { return $null }
    $out = @{ charge_remaining_percent = [int]$bat.EstimatedChargeRemaining }
    $full = Safe { Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1 } 'battery_full'
    $static = Safe { Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData | Select-Object -First 1 } 'battery_static'
    if ($full -and $static -and $static.DesignedCapacity -gt 0) {
        $out.health_percent = [int](($full.FullChargedCapacity * 100) / $static.DesignedCapacity)
    }
    return $out
}

function Get-Ext-Displays {
    $out = @{}
    $displays = New-Object System.Collections.Generic.List[object]
    $primary = $null
    foreach ($v in (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.CurrentHorizontalResolution })) {
        $res = ("{0}x{1}" -f $v.CurrentHorizontalResolution, $v.CurrentVerticalResolution)
        if ($v.CurrentRefreshRate) { $res += "@{0}Hz" -f $v.CurrentRefreshRate }
        if (-not $primary) { $primary = $res }
        [void]$displays.Add([ordered]@{ adapter = [string]$v.Name; resolution = $res })
    }
    if ($primary) { $out.screen_resolution = $primary }
    if ($displays.Count) { $out.displays = @($displays.ToArray()) }
    return $out
}

function Get-Ext-SecurityPosture {
    $out = @{}

    # RDP включён?
    $ts = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue
    if ($ts) { $out.rdp_enabled = ($ts.fDenyTSConnections -eq 0) }

    # SMB1 (небезопасный) включён?
    $smb1 = Safe { (Get-SmbServerConfiguration).EnableSMB1Protocol } 'smb1'
    if ($null -ne $smb1) { $out.smb1_enabled = [bool]$smb1 }

    # UAC включён?
    $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction SilentlyContinue
    if ($uac) { $out.uac_enabled = ($uac.EnableLUA -eq 1) }

    # Активация Windows
    $act = Safe {
        Get-CimInstance -ClassName SoftwareLicensingProduct -ErrorAction Stop |
            Where-Object { $_.PartialProductKey -and $_.ApplicationID -eq '55c92734-d682-4d71-983e-d6ec3f16059f' } |
            Select-Object -First 1
    } 'activation'
    if ($act) {
        $out.activation = switch ([int]$act.LicenseStatus) {
            1 { 'Licensed' }
            0 { 'Unlicensed' }
            2 { 'OOB Grace' }
            3 { 'OOT Grace' }
            5 { 'Notification' }
            6 { 'Extended Grace' }
            default { "Status $($act.LicenseStatus)" }
        }
    }
    return $out
}

function Get-Ext-Devices {
    $out = @{}
    $problem = New-Object System.Collections.Generic.List[object]
    foreach ($p in (Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
            Where-Object { $_.ConfigManagerErrorCode -and $_.ConfigManagerErrorCode -ne 0 })) {
        [void]$problem.Add([ordered]@{ name = [string]$p.Name; error = [int]$p.ConfigManagerErrorCode })
        if ($problem.Count -ge 40) { break }
    }
    if ($problem.Count) { $out.problem_devices = @($problem.ToArray()) }

    $drv = Safe {
        Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop |
            Where-Object { $_.DriverProviderName -and $_.DriverProviderName -ne 'Microsoft' }
    } 'drivers'
    if ($drv) { $out.drivers_third_party_count = @($drv).Count }
    return $out
}

function Get-Ext-Accounts {
    $out = @{}

    # Локальные пользователи (включённые)
    $users = New-Object System.Collections.Generic.List[object]
    foreach ($u in (Safe { Get-LocalUser } 'local_users')) {
        [void]$users.Add([ordered]@{
            name = [string]$u.Name
            enabled = [bool]$u.Enabled
            last_logon = if ($u.LastLogon) { $u.LastLogon.ToUniversalTime().ToString('o') } else { $null }
        })
    }
    if ($users.Count) {
        $out.local_users = @($users.ToArray() | Select-Object -First 40)
        $out.local_users_enabled = @($users.ToArray() | Where-Object { $_.enabled }).Count
    }

    # Сетевые шары (кроме админских по умолчанию)
    $shares = New-Object System.Collections.Generic.List[object]
    foreach ($sh in (Get-CimInstance Win32_Share -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '\$$' })) {
        [void]$shares.Add([ordered]@{ name = [string]$sh.Name; path = [string]$sh.Path })
    }
    if ($shares.Count) { $out.shares = @($shares.ToArray()) }

    # Активные сессии (quser)
    $logged = New-Object System.Collections.Generic.List[string]
    $q = Safe { quser 2>$null } 'logged_on'
    if ($q) {
        foreach ($line in ($q | Select-Object -Skip 1)) {
            $name = ($line.TrimStart('>').Trim() -split '\s+')[0]
            if ($name) { [void]$logged.Add($name) }
        }
    }
    if ($logged.Count) { $out.logged_on_users = @($logged.ToArray() | Select-Object -Unique) }
    return $out
}

function Get-Ext-UsbHistory {
    $out = @{}
    $hist = New-Object System.Collections.Generic.List[object]
    foreach ($k in (Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USBSTOR' -ErrorAction SilentlyContinue)) {
        $friendly = ($k.PSChildName -replace '^Disk&Ven_', '' -replace '&Prod_', ' ' -replace '&Rev_.*$', '')
        [void]$hist.Add([ordered]@{ device = $friendly })
        if ($hist.Count -ge 60) { break }
    }
    if ($hist.Count) {
        $out.usb_storage_history = @($hist.ToArray())
        $out.usb_storage_history_count = $hist.Count
    }
    return $out
}

function Get-Ext-Processes {
    $out = @{}
    $procs = Safe {
        Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15
    } 'top_processes'
    if ($procs) {
        $out.top_processes = @($procs | ForEach-Object {
            @{ name = [string]$_.ProcessName; ram_mb = [int]($_.WorkingSet64 / 1MB) }
        })
    }
    return $out
}

# ----------------------------------------------------------------------------
# Ярлык "Заявка в IT" на рабочий стол (как у штатного агента)
# ----------------------------------------------------------------------------

function Get-PrimaryIPv4 {
    try {
        $cfg = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
        if ($cfg) { $ip = ($cfg.IPv4Address | Select-Object -First 1).IPAddress; if ($ip) { return $ip } }
    } catch { }
    try {
        $nic = Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction Stop |
            Where-Object { $_.IPEnabled -and $_.DefaultIPGateway } | Select-Object -First 1
        if ($nic) { $ip = @($nic.IPAddress) | Where-Object { $_ -and $_ -notmatch ':' } | Select-Object -First 1; if ($ip) { return $ip } }
    } catch { }
    return $null
}

function Convert-ServerUrl {
    param([string]$BaseUrl)
    $b = $BaseUrl.TrimEnd('/')
    try {
        $u = [uri]$b
        if ($u.Host -in @('localhost', '127.0.0.1', '::1')) {
            $ip = Get-PrimaryIPv4
            if ($ip) { $ub = New-Object System.UriBuilder($u); $ub.Host = $ip; return $ub.Uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/') }
        }
    } catch { }
    return $b
}

function Install-HelpdeskShortcut {
    param([string]$ServerUrl, [string]$Hostname)
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) { return }
    $host2 = ([string]$Hostname).Trim()
    if (-not $host2) { return }
    $base = Convert-ServerUrl -BaseUrl $ServerUrl
    $url = ("{0}/h#pc={1}" -f $base, [uri]::EscapeDataString($host2))
    $sys = Join-Path $env:SystemRoot 'System32'
    $icon = Join-Path $sys 'imageres.dll'
    $idx = 81
    if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path $sys 'shell32.dll'; $idx = 14 }

    $dirs = New-Object System.Collections.Generic.List[string]
    foreach ($d in @(
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Desktop'),
        (Join-Path $env:USERPROFILE 'Desktop'),
        (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
    )) {
        if ($d -and (Test-Path -LiteralPath $d) -and -not $dirs.Contains($d)) { [void]$dirs.Add($d) }
    }

    $written = 0
    $wsh = $null
    try { $wsh = New-Object -ComObject WScript.Shell } catch { }
    foreach ($dir in $dirs) {
        # убрать старые/переименованные ярлыки
        foreach ($old in @('Заявка в IT', 'Заявка CORAX', 'CORAX-ticket')) {
            foreach ($ext in @('.lnk', '.url')) {
                $op = Join-Path $dir ($old + $ext)
                if (Test-Path -LiteralPath $op) { try { Remove-Item -LiteralPath $op -Force -ErrorAction SilentlyContinue } catch { } }
            }
        }
        $path = Join-Path $dir 'Оставить заявку.lnk'
        try {
            if ($wsh) {
                $sc = $wsh.CreateShortcut($path)
                $sc.TargetPath = (Join-Path $env:SystemRoot 'explorer.exe')
                $sc.Arguments = $url
                $sc.IconLocation = "$icon,$idx"
                $sc.Description = 'Оставить заявку в IT'
                $sc.Save()
                if (Test-Path -LiteralPath $path) { $written++; continue }
            }
        } catch { }
        # fallback .url
        try {
            $urlPath = Join-Path $dir 'Оставить заявку.url'
            $body = "[InternetShortcut]`r`nURL=$url`r`nIconFile=$icon`r`nIconIndex=$idx`r`n"
            [System.IO.File]::WriteAllText($urlPath, $body, [Text.Encoding]::Unicode)
            if (Test-Path -LiteralPath $urlPath) { $written++ }
        } catch { }
    }
    if ($wsh) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) } catch { } }
    if ($written -gt 0) { Write-Ok ("Ярлык 'Оставить заявку' создан ({0}) -> {1}" -f $written, $url) }
    else { Write-Warn2 'Ярлык на рабочий стол создать не удалось' }
}

# ----------------------------------------------------------------------------
# Отправка
# ----------------------------------------------------------------------------

function Get-UriCandidates([string]$BaseUrl) {
    $u = [Uri]$BaseUrl
    $ports = New-Object System.Collections.Generic.List[int]
    if ($u.Port -gt 0) { [void]$ports.Add([int]$u.Port) }
    foreach ($p in @(3001, 3250, 3000)) { if (-not $ports.Contains([int]$p)) { [void]$ports.Add([int]$p) } }
    $paths = @('/api/v1/agent/inventory', '/api/agent/inventory')
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($port in $ports) {
        $b = (New-Object System.UriBuilder($u.Scheme, $u.Host, $port)).Uri.GetLeftPart([System.UriPartial]::Authority)
        foreach ($path in $paths) {
            $uri = $b.TrimEnd('/') + $path
            if (-not $list.Contains($uri)) { [void]$list.Add($uri) }
        }
    }
    return @($list.ToArray())
}

function Send-Report($Payload, [string]$BaseUrl, [string]$Token) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    Write-Step ("Размер отчёта: {0:N0} символов" -f $json.Length)
    $headers = @{ Authorization = "Bearer $Token" }
    foreach ($uri in (Get-UriCandidates -BaseUrl $BaseUrl)) {
        Write-Step "POST $uri"
        try {
            $resp = Invoke-RestMethod -Uri $uri -Method Post -Body $json -ContentType 'application/json' -Headers $headers -TimeoutSec 90
            Write-Ok "Отчёт принят сервером."
            return $true
        } catch {
            Write-Warn2 ("не прошло: {0}" -f $_.Exception.Message)
        }
    }
    return $false
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

Invoke-SelfElevate

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor DarkCyan
Write-Host '   CORAX FULL AUDIT — ручной расширенный сбор данных' -ForegroundColor White
Write-Host '  ============================================================' -ForegroundColor DarkCyan
Write-Host ''

if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = Read-Host 'Адрес сервера (например http://192.168.1.10:3001)'
}
if ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = Read-Host 'Токен агента'
}
if ([string]::IsNullOrWhiteSpace($Server) -or [string]::IsNullOrWhiteSpace($Token)) {
    Write-ErrLine 'Не заданы адрес сервера или токен. Выход.'
    if (-not $NoPause) { Read-Host 'Enter для выхода' }
    exit 2
}
$Server = $Server.TrimEnd('/')

$exit = 1
try {

if (Test-IsAdmin) { Write-Ok 'Права администратора: есть' }
else { Write-Warn2 'Права администратора: НЕТ — часть данных (BitLocker, SMART, службы) не соберётся' }

Write-Host ''
Write-Step 'Базовый инвентарь (железо, ОС, ПО)...'
$core = Get-CorePayload
Write-Ok ("Хост {0}: ПО {1}, дисков {2}" -f $core.hostname, @($core.software).Count, @($core.disks).Count)

$extended = [ordered]@{
    agent_version = 'audit-1.0.0-win'
    profile = 'full-audit'
    platform = 'windows'
    collected_at = (Get-Date).ToUniversalTime().ToString('o')
    partial = $false
}

$steps = @(
    @{ label = 'Система/uptime'; fn = { Get-Ext-System };        merge = 'spread' }
    @{ label = 'Сеть';          fn = { Get-Ext-Network };       merge = 'network' }
    @{ label = 'Диски/SMART';   fn = { Get-Ext-Storage };       key = 'physical_disks' }
    @{ label = 'Память (планки)'; fn = { Get-Ext-RamModules };  key = 'ram_modules' }
    @{ label = 'Мониторы';      fn = { Get-Ext-Monitors };      key = 'monitors' }
    @{ label = 'Видеокарты';    fn = { Get-Ext-Gpus };          key = 'gpus' }
    @{ label = 'Дисплеи/разрешение'; fn = { Get-Ext-Displays }; merge = 'spread' }
    @{ label = 'Безопасность';  fn = { Get-Ext-Security };      merge = 'spread' }
    @{ label = 'Security posture (RDP/SMB1/UAC/активация)'; fn = { Get-Ext-SecurityPosture }; merge = 'spread' }
    @{ label = 'Проблемные устройства/драйверы'; fn = { Get-Ext-Devices }; merge = 'spread' }
    @{ label = 'Учётки/шары/сессии'; fn = { Get-Ext-Accounts }; merge = 'spread' }
    @{ label = 'История USB-накопителей'; fn = { Get-Ext-UsbHistory }; merge = 'spread' }
    @{ label = 'Топ процессов по памяти'; fn = { Get-Ext-Processes }; merge = 'spread' }
    @{ label = 'Обновления';    fn = { Get-Ext-Patches };       merge = 'spread' }
    @{ label = 'Эксплуатация';  fn = { Get-Ext-Ops };           merge = 'spread' }
    @{ label = 'Аварии/BSOD';   fn = { Get-Ext-HardErrors };    key = 'hard_errors' }
)

foreach ($s in $steps) {
    Write-Step ("Сбор: {0}..." -f $s.label)
    $res = Safe $s.fn $s.label
    if ($null -eq $res) { continue }
    if ($s.merge -eq 'network') {
        $extended.network = $res
    } elseif ($s.merge -eq 'spread') {
        foreach ($k in $res.Keys) { $extended[$k] = $res[$k] }
    } else {
        $extended[$s.key] = $res
    }
}

$extended.pending_reboot = (Safe { Get-Ext-PendingReboot } 'pending_reboot') -eq $true
$bh = Safe { Get-Ext-BatteryHealth } 'battery_health'
if ($bh) { $extended.battery_health = $bh }

$payload = [ordered]@{}
foreach ($k in $core.Keys) { $payload[$k] = $core[$k] }
$payload.extended = $extended

Write-Host ''
Write-Step 'Отправка на сервер...'
$ok = Send-Report -Payload $payload -BaseUrl $Server -Token $Token

Write-Host ''
if ($ok) {
    Write-Ok '=== ГОТОВО. Полный аудит отправлен. ==='
    Safe { Install-HelpdeskShortcut -ServerUrl $Server -Hostname $core.hostname } 'shortcut' | Out-Null
    $exit = 0
} else {
    Write-ErrLine '=== НЕ УДАЛОСЬ отправить отчёт (см. ошибки выше). ==='
    $exit = 1
}

}
catch {
    Write-Host ''
    Write-ErrLine ("НЕОЖИДАННАЯ ОШИБКА: {0}" -f $_.Exception.Message)
    Write-Host ("  {0}" -f $_.ScriptStackTrace) -ForegroundColor DarkGray
    $exit = 1
}
finally {
    if (-not $NoPause) { Write-Host ''; Read-Host 'Enter для выхода' }
}
exit $exit
