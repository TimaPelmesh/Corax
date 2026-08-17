#Requires -Version 5.1
# Copied from previous agent\InventoryClient.ps1 so win10-11 is self-contained.
# Log lines = ASCII only (encoding-safe on any PC).
$ErrorActionPreference = 'Stop'
try {
    $names = [enum]::GetNames([Net.SecurityProtocolType])
    if ($names -contains 'Tls12') {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } elseif ($names -contains 'Tls') {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls
    }
} catch {
}

function Log([string]$Msg) {
    Write-Host ("[{0:HH:mm:ss.fff}] " -f (Get-Date)) -NoNewline
    Write-Host $Msg
}

function Get-SanitizedAgentText {
    param([string]$Value)
    if ($null -eq $Value) { return $null }
    $t = $Value -replace "`0", ''
    if ([string]::IsNullOrWhiteSpace($t)) { return $null }
    return $t.Trim()
}

function Log-ConnectHints {
    param([string]$HostName, [int]$Port, $Err)
    Log "----- Set / server (read if POST failed) -----"
    Log ("Target: {0}:{1}" -f $HostName, $Port)
    $sx = $Err
    while ($sx -and -not ($sx -is [System.Net.Sockets.SocketException])) {
        $sx = $sx.InnerException
    }
    if ($sx -is [System.Net.Sockets.SocketException]) {
        $code = [int]$sx.ErrorCode
        Log ("Socket ErrorCode={0}: {1}" -f $code, $sx.Message)
        if ($code -eq 10061) {
            Log "  Connection refused: nothing is accepting TCP on this host:port."
            Log "  On SERVER run API bound to all interfaces: 0.0.0.0 (not only 127.0.0.1)."
            Log "  On SERVER Windows allow inbound TCP port {0} (open_firewall_port.bat as Admin)." -f $Port
            Log "  If agent and server run on SAME PC use http://127.0.0.1:{0} in bat INVENTORY_SERVER." -f $Port
            Log "  Else INVENTORY_SERVER must be the LAN IP of the machine where the API runs."
        } elseif ($code -eq 10060) {
            Log "  Timeout: firewall, wrong IP, or server not running."
        }
    } else {
        Log ("Detail: " + $Err.Message)
    }
    Log "-----"
}

function Set-BuddyProgress {
    param([string]$Status, [int]$Percent)
    Write-Progress -Id 1 -Activity '[*] Inventory agent' -Status $Status -PercentComplete $Percent
}

function Clear-BuddyProgress {
    Write-Progress -Id 1 -Activity 'done' -Completed
}

function Get-QueueFilePath {
    $root = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:TEMP }
    $dir = Join-Path $root 'InventoryAgent'
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { }
    Join-Path $dir 'pending_report.json'
}

function Save-PendingReport([string]$Json) {
    try {
        $p = Get-QueueFilePath
        [System.IO.File]::WriteAllText($p, $Json, [System.Text.UTF8Encoding]::new($false))
        Log ("Saved pending report: " + $p)
    } catch { }
}

function Load-PendingReport {
    try {
        $p = Get-QueueFilePath
        if (Test-Path -LiteralPath $p) {
            return [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
        }
    } catch { }
    return $null
}

function Clear-PendingReport {
    try {
        $p = Get-QueueFilePath
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    } catch { }
}

function Invoke-InventoryPost {
    param([string]$Uri, [string]$Json)
    $backoff = @(2, 5, 15)
    for ($i = 0; $i -lt ($backoff.Count + 1); $i++) {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.UseProxy = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(45)
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', "Bearer $token")
        $content = New-Object System.Net.Http.StringContent($Json, [System.Text.UTF8Encoding]::new($false), 'application/json')
        try {
            $response = $client.PostAsync($Uri, $content).GetAwaiter().GetResult()
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($response.IsSuccessStatusCode) {
                return @{ ok = $true; body = $body }
            }
            $code = [int]$response.StatusCode
            if ($code -ge 500 -and $i -lt $backoff.Count) {
                Start-Sleep -Seconds $backoff[$i]
                continue
            }
            return @{ ok = $false; body = $body; code = $code }
        } catch {
            $err = $_.Exception
            if ($i -lt $backoff.Count) {
                Start-Sleep -Seconds $backoff[$i]
                continue
            }
            throw $err
        } finally {
            if ($client) { $client.Dispose() }
            if ($handler) { $handler.Dispose() }
        }
    }
    return @{ ok = $false; body = '' }
}

Log "=== Inventory client: start ==="

$base = $env:INVENTORY_SERVER
if ([string]::IsNullOrWhiteSpace($base)) {
    throw "INVENTORY_SERVER is not set. Configure it via environment variables (GPO/Intune/SCCM)."
}
$base = $base.TrimEnd('/')
$token = $env:AGENT_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "AGENT_TOKEN is not set. Ask admin for an agent token and set it as an environment variable."
}

function Get-InventoryUriCandidates {
    param([string]$BaseUrl)
    $u = [Uri]$BaseUrl
    $ports = New-Object System.Collections.Generic.List[int]
    # Docker often maps API as host:3250 -> container:3001; start_all.bat uses native :3001.
    # If env still says :3250 but Docker is off, try 3001 first to avoid long timeouts on 3250.
    if ($u.Port -gt 0) {
        $urlPort = [int]$u.Port
        if ($urlPort -eq 3250 -and -not $ports.Contains(3001)) { [void]$ports.Add(3001) }
        if (-not $ports.Contains($urlPort)) { [void]$ports.Add($urlPort) }
    }
    foreach ($p in @(3250, 3001, 3000)) {
        if (-not $ports.Contains([int]$p)) { [void]$ports.Add([int]$p) }
    }
    $paths = @('/api/v1/agent/inventory', '/api/agent/inventory')
    $seen = @{}
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($port in $ports) {
        $builder = New-Object System.UriBuilder($u.Scheme, $u.Host, $port)
        $candidateBase = $builder.Uri.GetLeftPart([System.UriPartial]::Authority)
        foreach ($path in $paths) {
            $candidateUri = $candidateBase.TrimEnd('/') + $path
            $key = $candidateUri.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$list.Add([pscustomobject]@{
                Base = $candidateBase
                Uri  = $candidateUri
                Host = $u.Host
                Port = $port
                Path = $path
            })
        }
    }
    return @($list.ToArray())
}

$uriCandidates = @(Get-InventoryUriCandidates -BaseUrl $base)
$uri = $uriCandidates[0].Uri

Log ("Config: base URL = " + $base)
Log ("Config: POST      = " + $uri)
Log ("Config: token     = " + ($token.Substring(0, [Math]::Min(8, $token.Length)) + "..."))
if ($uriCandidates.Count -gt 1) {
    Log ("Config: fallback  = " + (($uriCandidates | Select-Object -Skip 1 | ForEach-Object { $_.Uri }) -join ' | '))
}

function Get-PrimaryMac {
    $cfg = Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled } | Select-Object -First 1
    if (-not $cfg) { return $null }
    ($cfg.MACAddress -replace '-', ':').ToUpperInvariant()
}

function Get-PreferredHostname {
    if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Trim()) { return $env:COMPUTERNAME.Trim() }
    try {
        $n = [System.Net.Dns]::GetHostName()
        if ($n -and $n.Trim()) { return $n.Trim() }
    } catch { }
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
        if ($cs -and $cs.Name -and $cs.Name.Trim()) { return $cs.Name.Trim() }
    } catch { }
    return 'unknown-host'
}

function Test-IsWmiPlaceholder {
    param([string]$s)
    if ([string]::IsNullOrWhiteSpace($s)) { return $true }
    $t = $s.Trim()
    return ($t -match '^(System Product Name|System Manufacturer|System Model|System Version|System SKU|Default string|Default String|To be filled by O\.E\.M\.|To Be Filled By O\.E\.M\.|To be filled|System Serial Number|Not Specified|OEM|O\.E\.M\.|INVALID|Invalid|All Series|Type1Family0|Bad string|undefined|Not Available|N/?A|Product Name|Not Applicable)$')
}

function Get-CleanWmiText {
    param([string]$value)
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $t = $value.Trim()
    if ($t.Length -gt 256) { $t = $t.Substring(0, 256) }
    if (Test-IsWmiPlaceholder $t) { return $null }
    return $t
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

function Get-InstalledSoftwareMax([int]$Max = 12000) {
    $pathPatterns = New-Object System.Collections.Generic.List[string]
    [void]$pathPatterns.Add('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
    [void]$pathPatterns.Add('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
    [void]$pathPatterns.Add('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
    [void]$pathPatterns.Add('HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
    try {
        foreach ($usr in Get-ChildItem -Path 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue) {
            $sid = $usr.PSChildName
            if ($sid -notmatch '^S-1-5-21-') { continue }
            [void]$pathPatterns.Add("Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall\*")
            [void]$pathPatterns.Add("Registry::HKEY_USERS\$sid\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*")
        }
    } catch { }

    $seen = @{}
    $list = New-Object System.Collections.Generic.List[object]
    :outer foreach ($pattern in $pathPatterns) {
        foreach ($prop in (Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue)) {
            if ($list.Count -ge $Max) { break outer }
            $dn = $prop.DisplayName
            if (-not $dn) { continue }
            $name = Get-SanitizedAgentText $dn.ToString()
            if (-not $name) { continue }
            if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
            $v = $null
            if ($prop.DisplayVersion) {
                $v = Get-SanitizedAgentText $prop.DisplayVersion.ToString()
                if ($v -and $v.Length -gt 255) { $v = $v.Substring(0, 255) }
            }
            $verKey = if ($v) { $v.ToLowerInvariant() } else { '' }
            $dedupe = $name.ToLowerInvariant() + '|' + $verKey
            if ($seen.ContainsKey($dedupe)) { continue }
            $seen[$dedupe] = $true
            $list.Add(@{ name = $name; version = $v })
        }
    }
    @($list | Sort-Object { $_.name })
}

function Get-PnpPeripheralsForReport([int]$Max = 140) {
    $classToKind = @{
        'Keyboard'       = 'keyboard'
        'Mouse'          = 'mouse'
        'Monitor'        = 'monitor'
        'Display'        = 'monitor'
        'Image'          = 'camera'
        'Camera'         = 'camera'
        'AudioEndpoint'  = 'audio'
        'MEDIA'          = 'audio'
        'MIDI'           = 'audio'
        'Printer'        = 'printer'
        'PrintQueue'     = 'printer'
        'Biometric'      = 'biometric'
        'Bluetooth'      = 'bluetooth'
        'Net'            = 'net'
        'PointerClass'   = 'touchpad'
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
    $seen = @{}
    $out = [System.Collections.ArrayList]@()
    $devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)
    foreach ($d in $devs) {
        if ($out.Count -ge $Max) { break }
        if ($null -eq $d.Class -or '' -eq [string]$d.Class) { continue }
        $cls = [string]$d.Class
        if (-not $classToKind.ContainsKey($cls)) { continue }
        $nameRaw = $null
        if ($d.FriendlyName -and ([string]$d.FriendlyName).Trim()) { $nameRaw = [string]$d.FriendlyName }
        elseif ($d.Name -and ([string]$d.Name).Trim()) { $nameRaw = [string]$d.Name }
        elseif ($d.InstanceId -and ([string]$d.InstanceId).Trim()) { $nameRaw = [string]$d.InstanceId }
        if (-not $nameRaw) { continue }
        $name = $nameRaw.Trim()
        if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
        $kind = [string]$classToKind[$cls]
        if ($kind -eq 'monitor' -and -not (Test-IsRealMonitorName $name)) { continue }
        if (Test-IsNoisePeripheral -Kind $kind -Name $name) { continue }
        $key = $kind + '|' + $name.ToLowerInvariant()
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
            $name = ($parts -join " ").Trim()
            if (-not $name) { continue }
            if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
            if (-not (Test-IsRealMonitorName $name)) { continue }
            $key = "monitor|" + $name.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$out.Add([pscustomobject]@{ kind = 'monitor'; name = $name })
        }
    } catch { }
    @($out.ToArray())
}

function Get-InventoryGpuName {
    $names = [System.Collections.ArrayList]@()
    foreach ($v in @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)) {
        if ($v.Name -and $v.Name.Trim()) { [void]$names.Add($v.Name.Trim()) }
    }
    if ($names.Count -eq 0) { return $null }
    foreach ($n in $names) {
        if ($n -match '(?i)(nvidia|amd|radeon|intel\s*arc|intel\(r\)\s*iris|intel\(r\)\s*uhd|intel\s+uhd)') {
            if ($n.Length -gt 512) { return $n.Substring(0, 512) }
            return $n
        }
    }
    foreach ($n in $names) {
        if ($n -notmatch '(?i)^microsoft\s+(basic|remote)\s+display') {
            if ($n.Length -gt 512) { return $n.Substring(0, 512) }
            return $n
        }
    }
    $f = [string]$names[0]
    if ($f.Length -gt 512) { return $f.Substring(0, 512) }
    return $f
}

function Get-InventoryDisks {
    $rows = [System.Collections.ArrayList]@()
    $seen = @{}
    function Add-DiskRow {
        param([string]$Mount, $Label, [double]$TotalGb, [double]$FreeGb, [double]$UsedPct)
        if ([string]::IsNullOrWhiteSpace($Mount)) { return }
        $mountNorm = $Mount.Trim().ToUpperInvariant()
        if ($mountNorm -notmatch '^[A-Z]:$') { return }
        if ($seen.ContainsKey($mountNorm)) { return }
        $seen[$mountNorm] = $true
        $lbl = $Label
        if ($lbl -is [string] -and $lbl.Length -gt 128) { $lbl = $lbl.Substring(0, 128) }
        [void]$rows.Add([pscustomobject]@{
            mount        = $mountNorm
            label        = $lbl
            total_gb     = $TotalGb
            used_percent = $UsedPct
            free_gb      = $FreeGb
        })
    }

    foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue)) {
        $size = [double]$d.Size
        if ($size -le 0) { continue }
        $free = [double]$d.FreeSpace
        $usedPct = [int]([math]::Round(100.0 * ($size - $free) / $size, 0))
        Add-DiskRow -Mount $d.DeviceID -Label $d.VolumeName -TotalGb ([math]::Round($size / 1GB, 2)) -FreeGb ([math]::Round($free / 1GB, 2)) -UsedPct $usedPct
    }

    try {
        foreach ($v in @(Get-CimInstance Win32_Volume -Filter "DriveType=3" -ErrorAction SilentlyContinue)) {
            $size = [double]$v.Capacity
            if ($size -le 0) { continue }
            $free = [double]$v.FreeSpace
            $usedPct = [int]([math]::Round(100.0 * ($size - $free) / $size, 0))
            $mount = $null
            if ($v.DriveLetter -and $v.DriveLetter.Trim()) { $mount = $v.DriveLetter.Trim() }
            elseif ($v.Name -and $v.Name.Trim()) { $mount = $v.Name.Trim().TrimEnd('\') }
            elseif ($v.DeviceID -and $v.DeviceID.Trim()) { $mount = $v.DeviceID.Trim() }
            Add-DiskRow -Mount $mount -Label $v.Label -TotalGb ([math]::Round($size / 1GB, 2)) -FreeGb ([math]::Round($free / 1GB, 2)) -UsedPct $usedPct
        }
    } catch { }

    if ($rows.Count -eq 0) {
        try {
            foreach ($vol in @(Get-Volume -ErrorAction SilentlyContinue)) {
                if (-not $vol.DriveLetter) { continue }
                $size = [double]$vol.Size
                if ($size -le 0) { continue }
                $free = [double]$vol.SizeRemaining
                $usedPct = [int]([math]::Round(100.0 * ($size - $free) / $size, 0))
                Add-DiskRow -Mount ($vol.DriveLetter + ':') -Label $vol.FileSystemLabel -TotalGb ([math]::Round($size / 1GB, 2)) -FreeGb ([math]::Round($free / 1GB, 2)) -UsedPct $usedPct
            }
        } catch { }
    }
    return @($rows.ToArray())
}

$sw = @()
$periph = @()
$swatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
    Set-BuddyProgress '[1/5] WMI: computer system...' 18
    Log "[1/5] WMI: Win32_ComputerSystem ..."
    $cs = Get-CimInstance Win32_ComputerSystem

    Set-BuddyProgress '[2/5] WMI: BIOS, OS, CPU, MAC...' 34
    Log "[2/5] WMI: BIOS, OS, CPU, MAC ..."
    $bios = Get-CimInstance Win32_BIOS
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $mac = Get-PrimaryMac

    $ram = [math]::Round([double]$cs.TotalPhysicalMemory / 1GB, 2)
    $cpuName = $null
    if ($cpu -and $cpu.Name) {
        $cpuName = $cpu.Name.Trim()
        if ($cpuName.Length -gt 512) { $cpuName = $cpuName.Substring(0, 512) }
    }

    $serial = Get-CleanWmiText $(if ($bios.SerialNumber) { $bios.SerialNumber } else { $null })
    $mfr = Get-CleanWmiText $(if ($cs.Manufacturer) { $cs.Manufacturer } else { $null })
    $model = Get-CleanWmiText $(if ($cs.Model) { $cs.Model } else { $null })

    $csp = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
    if ($csp) {
        if (-not $mfr) { $mfr = Get-CleanWmiText $csp.Vendor }
        if (-not $model) {
            $model = Get-CleanWmiText $csp.Name
            if (-not $model) { $model = Get-CleanWmiText $csp.Version }
            if (-not $model) { $model = Get-CleanWmiText $csp.IdentifyingNumber }
        }
    }

    $mbMfr = $null
    $mbProduct = $null
    $bb = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue
    if ($bb) {
        $mbMfr = Get-CleanWmiText $(if ($bb.Manufacturer) { $bb.Manufacturer } else { $null })
        $mbProduct = Get-CleanWmiText $(if ($bb.Product) { $bb.Product } else { $null })
        if (-not $mfr) { $mfr = $mbMfr }
        if (-not $model) { $model = $mbProduct }
        if (-not $serial) { $serial = Get-CleanWmiText $bb.SerialNumber }
    }

    if (-not $serial) {
        $enc = @(Get-CimInstance Win32_SystemEnclosure -ErrorAction SilentlyContinue)
        foreach ($e in $enc) {
            $sn = Get-CleanWmiText $(if ($e.SerialNumber) { $e.SerialNumber } else { $null })
            if ($sn) { $serial = $sn; break }
        }
    }

    if (-not $mbProduct -and $model) { $mbProduct = $model }
    if (-not $mbMfr -and $mfr) { $mbMfr = $mfr }

    Set-BuddyProgress '[3/5] Registry: installed software...' 52
    Log "[3/5] Registry: installed software ..."
    $sw = @(Get-InstalledSoftwareMax)

    Set-BuddyProgress '[4/5] PnP: peripherals...' 68
    Log "[4/5] PnP: peripherals ..."
    $periph = @(Get-PnpPeripheralsForReport)

    Set-BuddyProgress '[4b/5] RAM %, GPU, disks...' 78
    Log "[4b/5] RAM %, GPU, logical disks ..."
    $memPct = $null
    try {
        $osm = Get-CimInstance Win32_OperatingSystem
        $tMem = [double]$osm.TotalVisibleMemorySize * 1KB
        $fMem = [double]$osm.FreePhysicalMemory * 1KB
        if ($tMem -gt 0) { $memPct = [int]([math]::Round(100.0 * ($tMem - $fMem) / $tMem, 0)) }
    } catch { }

    $gpuName = Get-InventoryGpuName
    $diskArr = Get-InventoryDisks

    $payload = [ordered]@{
        hostname                = (Get-PreferredHostname)
        serial_number           = $serial
        mac_primary             = $mac
        cpu                     = $cpuName
        ram_gb                  = $ram
        memory_used_percent     = $memPct
        gpu_name                = $gpuName
        disks                   = @($diskArr)
        os_name                 = if ($os.Caption) { ($os.Caption -split '\|')[0].Trim() } else { 'Windows' }
        os_version              = "$( $os.Version ) build $( $os.BuildNumber )".Trim()
        manufacturer            = $mfr
        model                   = $model
        motherboard_manufacturer = $mbMfr
        motherboard_product     = $mbProduct
        software                = @($sw)
        peripherals             = @($periph)
    }

    $json = ($payload | ConvertTo-Json -Depth 8 -Compress)
    Set-BuddyProgress '[5/5] JSON ready...' 88

    Add-Type -AssemblyName System.Net.Http

    $pending = Load-PendingReport
    if ($pending) {
        Log "Found pending report from previous run. Sending it first..."
        foreach ($candidate in $uriCandidates) {
            try {
                $r0 = Invoke-InventoryPost -Uri $candidate.Uri -Json $pending
                if ($r0.ok) {
                    Log ("HTTP: OK (pending) " + $r0.body)
                    Clear-PendingReport
                    break
                }
            } catch {
            }
        }
    }

    foreach ($candidate in $uriCandidates) {
        Set-BuddyProgress ('HTTP: trying ' + $candidate.Uri) 92
        Log ("HTTP: POST " + $candidate.Uri + " ...")
        try {
            $r = Invoke-InventoryPost -Uri $candidate.Uri -Json $json
            if ($r.ok) {
                Clear-BuddyProgress
                Log ("HTTP: OK " + $r.body)
                exit 0
            }
            if ($null -ne $r.code) {
                $body = $r.body
                if ([string]::IsNullOrWhiteSpace($body)) { $body = "<empty>" }
                $oneLine = ($body -replace "(\r\n|\n|\r)+", " ") 
                if ($oneLine.Length -gt 240) { $oneLine = $oneLine.Substring(0, 240) + "..." }
                Log ("HTTP: FAIL " + $r.code + " " + $oneLine)
            } else {
                Log "HTTP: FAIL (unknown)"
            }
        } catch {
            $err = $_.Exception
            Log-ConnectHints -HostName $candidate.Host -Port $candidate.Port -Err $err
        }
    }
    Clear-BuddyProgress
    Save-PendingReport -Json $json
    Log "=== Inventory client: FAILED ==="
    exit 1
}
catch {
    Clear-BuddyProgress
    Log "ERROR: exception"
    Log ($_.Exception.Message)
    exit 1
}

