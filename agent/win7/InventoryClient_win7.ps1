# Windows 7 / PowerShell 2.0 compatible inventory sender.
# Do not fail the whole run on partial WMI/registry errors: we still want to POST what we can.
$ErrorActionPreference = 'Continue'
$INV_DEBUG = $false
try { if ($env:INV_DEBUG -and $env:INV_DEBUG.Trim() -eq '1') { $INV_DEBUG = $true } } catch { }

function Log([string]$Msg) {
    $ts = (Get-Date).ToString('HH:mm:ss.fff')
    Write-Host ("[{0}] {1}" -f $ts, $Msg)
}

function Get-QueueFilePath {
    $root = $env:ProgramData
    if (-not $root -or $root.Trim().Length -eq 0) { $root = $env:TEMP }
    $dir = Join-Path $root 'InventoryAgent'
    try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { }
    return (Join-Path $dir 'pending_report.json')
}

function Save-PendingReport([string]$Json) {
    try {
        $p = Get-QueueFilePath
        [System.IO.File]::WriteAllText($p, $Json, [System.Text.Encoding]::UTF8)
        Log ("Saved pending report: " + $p)
    } catch { }
}

function Load-PendingReport {
    try {
        $p = Get-QueueFilePath
        if (Test-Path -LiteralPath $p) {
            return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
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

function Log-NetDiag([string]$HostName, [int]$Port, [string]$Uri) {
    # Win7-safe connectivity hints: DNS + TCP connect with short timeout.
    try {
        $ips = @()
        try {
            $addrs = [System.Net.Dns]::GetHostAddresses($HostName)
            foreach ($a in $addrs) { $ips += $a.IPAddressToString }
        } catch { }
        if ($ips.Count -gt 0) {
            Log ("NET: DNS " + $HostName + " -> " + ($ips -join ', '))
        }
    } catch { }

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(2500, $false)
        if (-not $ok) {
            try { $client.Close() } catch { }
            Log ("NET: TCP timeout " + $HostName + ":" + $Port + " (2.5s)")
            return
        }
        $client.EndConnect($iar)
        Log ("NET: TCP OK " + $HostName + ":" + $Port)
        try { $client.Close() } catch { }
    } catch {
        $ex = $_.Exception
        $sx = $ex
        while ($sx -and -not ($sx -is [System.Net.Sockets.SocketException])) {
            $sx = $sx.InnerException
        }
        if ($sx -is [System.Net.Sockets.SocketException]) {
            Log ("NET: TCP FAIL " + $HostName + ":" + $Port + " socket=" + [int]$sx.ErrorCode + " " + $sx.Message)
        } else {
            Log ("NET: TCP FAIL " + $HostName + ":" + $Port + " " + $ex.Message)
        }
    }
}

function JsonEscape([string]$s) {
    if ($s -eq $null) { return '' }
    $t = $s
    $t = $t -replace '\\', '\\\\'
    $t = $t -replace '"', '\"'
    $t = $t -replace "`r", '\r'
    $t = $t -replace "`n", '\n'
    $t = $t -replace "`t", '\t'
    return $t
}

function Safe-Call([string]$Label, [scriptblock]$Fn) {
    try {
        return & $Fn
    } catch {
        if ($INV_DEBUG) {
            try { Log ("DBG: " + $Label + " failed: " + $_.Exception.Message) } catch { }
        }
        return $null
    }
}

function FirstNonEmpty([object[]]$vals) {
    foreach ($v in $vals) {
        if ($v -ne $null) {
            $s = [string]$v
            if ($s -and $s.Trim().Length -gt 0) { return $s.Trim() }
        }
    }
    return $null
}

function Get-WmiText([string]$Class, [string]$Prop) {
    try {
        $o = Get-WmiObject -Class $Class -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($o -and $o.$Prop) {
            $s = [string]$o.$Prop
            if ($s -and $s.Trim().Length -gt 0) { return $s.Trim() }
        }
    } catch { }
    return $null
}

function Get-WmiNumber([string]$Class, [string]$Prop) {
    try {
        $o = Get-WmiObject -Class $Class -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($o -and $o.$Prop -ne $null) { return $o.$Prop }
    } catch { }
    return $null
}

function Get-PrimaryMac() {
    try {
        $cfg = Get-WmiObject Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPEnabled -eq $true } | Select-Object -First 1
        if ($cfg -and $cfg.MACAddress) {
            return ([string]$cfg.MACAddress).Replace('-', ':').ToUpper()
        }
    } catch { }
    return $null
}

function Get-MemoryUsedPercent() {
    try {
        $os = Get-WmiObject Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $os) { return $null }
        # Values are in KB.
        $t = [double]$os.TotalVisibleMemorySize
        $f = [double]$os.FreePhysicalMemory
        if ($t -le 0) { return $null }
        return [int]([math]::Round(100.0 * ($t - $f) / $t, 0))
    } catch { }
    return $null
}

function Get-GpuName() {
    try {
        $names = @()
        $vs = Get-WmiObject Win32_VideoController -ErrorAction SilentlyContinue
        foreach ($v in $vs) {
            if ($v -and $v.Name) {
                $n = ([string]$v.Name).Trim()
                if ($n) { $names += $n }
            }
        }
        if ($names.Count -eq 0) { return $null }
        foreach ($n in $names) {
            if ($n -match '(?i)(nvidia|amd|radeon|geforce|intel)') { return $n }
        }
        foreach ($n in $names) {
            if ($n -notmatch '(?i)^microsoft\s+(basic|remote)\s+display') { return $n }
        }
        return [string]$names[0]
    } catch { }
    return $null
}

function Get-InstalledSoftwareBasic([int]$Max = 500) {
    # Minimal Win7-safe approach via reg.exe (no ConvertTo-Json, no registry providers assumptions).
    $paths = @(
        'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    $seen = @{}
    $out = New-Object System.Collections.ArrayList

    foreach ($base in $paths) {
        try {
            $keys = & reg.exe query $base 2>&1
            if ($INV_DEBUG) {
                Log ("DBG: reg query " + $base + " exit=" + $LASTEXITCODE + " lines=" + $keys.Count)
                $keys | Select-Object -First 3 | ForEach-Object { Log ("DBG: reg> " + [string]$_) }
            }
            foreach ($k in $keys) {
                if ($out.Count -ge $Max) { break }
                $key = [string]$k
                if (-not $key.Trim().StartsWith($base)) { continue }
                $dnOut = & reg.exe query $key /v DisplayName 2>&1
                $dnLine = ($dnOut | Select-String -Pattern 'DisplayName').Line
                if (-not $dnLine) { continue }
                $name = ($dnLine -replace '.*REG_\w+\s+', '').Trim()
                if (-not $name) { continue }
                $verOut = & reg.exe query $key /v DisplayVersion 2>&1
                $verLine = ($verOut | Select-String -Pattern 'DisplayVersion').Line
                $ver = $null
                if ($verLine) { $ver = ($verLine -replace '.*REG_\w+\s+', '').Trim() }
                $nameKey = ($name.ToLower() + [char]0 + ($(if ($ver) { $ver.ToLower() } else { '' })))
                if ($seen.ContainsKey($nameKey)) { continue }
                $seen[$nameKey] = $true
                [void]$out.Add(@{ name = $name; version = $(if ($ver) { $ver } else { $null }) })
            }
        } catch {
            if ($INV_DEBUG) { Log ("DBG: reg exception on " + $base + ": " + $_.Exception.Message) }
        }
    }

    # Fallback: registry provider (sometimes more reliable than parsing reg.exe output)
    if ($out.Count -eq 0) {
        $provPaths = @(
            'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
            'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
        foreach ($p in $provPaths) {
            try {
                $kids = Get-ChildItem -Path $p -ErrorAction SilentlyContinue
                if ($INV_DEBUG) { Log ("DBG: regprov enum " + $p + " keys=" + $kids.Count) }
                foreach ($k in $kids) {
                    if ($out.Count -ge $Max) { break }
                    $props = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
                    if (-not $props) { continue }
                    $dn = $props.DisplayName
                    if (-not $dn) { continue }
                    $name = ([string]$dn).Trim()
                    if (-not $name) { continue }
                    $ver = $null
                    if ($props.DisplayVersion) { $ver = ([string]$props.DisplayVersion).Trim() }
                    $nameKey = ($name.ToLower() + [char]0 + ($(if ($ver) { $ver.ToLower() } else { '' })))
                    if ($seen.ContainsKey($nameKey)) { continue }
                    $seen[$nameKey] = $true
                    [void]$out.Add(@{ name = $name; version = $(if ($ver) { $ver } else { $null }) })
                }
            } catch {
                if ($INV_DEBUG) { Log ("DBG: regprov exception on " + $p + ": " + $_.Exception.Message) }
            }
        }
    }

    if ($INV_DEBUG -and $out.Count -eq 0) {
        Log "DBG: software still empty after reg.exe + registry provider fallback"
    }
    return @($out.ToArray())
}

function Get-InventoryDisks {
    $out = New-Object System.Collections.ArrayList
    $seen = @{}
    try {
        $ds = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue
        foreach ($d in $ds) {
            $dev = $null
            try { $dev = [string]$d.DeviceID } catch { }
            if (-not $dev) { continue }
            $mount = $dev.Trim().ToUpper()
            if ($mount -notmatch '^[A-Z]:$') { continue }
            if ($seen.ContainsKey($mount)) { continue }
            $seen[$mount] = $true
            $label = $null
            try { if ($d.VolumeName) { $label = ([string]$d.VolumeName).Trim() } } catch { }
            $size = $null
            $free = $null
            try { $size = [double]$d.Size } catch { $size = $null }
            try { $free = [double]$d.FreeSpace } catch { $free = $null }
            $totalGb = $null
            $freeGb = $null
            $usedPct = $null
            if ($size -ne $null -and $size -gt 0) {
                $totalGb = [math]::Round($size / 1GB, 2)
                if ($free -ne $null) { $freeGb = [math]::Round($free / 1GB, 2) }
                if ($free -ne $null) { $usedPct = [int]([math]::Round(100.0 * ($size - $free) / $size, 0)) }
            }
            [void]$out.Add(@{
                mount = $mount
                label = $label
                total_gb = $totalGb
                used_percent = $usedPct
                free_gb = $freeGb
            })
        }
    } catch { }
    return @($out.ToArray())
}

function Get-PeripheralsBasic([int]$Max = 80) {
    $out = New-Object System.Collections.ArrayList
    $seen = @{}

    $RU_PRINT_QUEUE_ROOT = -join @(
        [char]0x43a, [char]0x43e, [char]0x440, [char]0x43d, [char]0x435, [char]0x432, [char]0x430, [char]0x44f,
        [char]0x20, [char]0x43e, [char]0x447, [char]0x435, [char]0x440, [char]0x435, [char]0x434, [char]0x44c,
        [char]0x20, [char]0x43f, [char]0x435, [char]0x447, [char]0x430, [char]0x442, [char]0x438
    )

    function Test-IsNoisePeripheral([string]$Kind, [string]$Name) {
        if (-not $Kind -or -not $Name) { return $true }
        $n = ([string]$Name).Trim()
        if (-not $n) { return $true }
        $nl = $n.ToLower()

        if ($Kind -eq 'net') {
            if ($nl -match '^wan\s+miniport\b') { return $true }
            if ($nl -match '\b(pppoe|pptp|sstp|l2tp|ikev2)\b') { return $true }
            if ($nl -match '\b(network\s+monitor|isatap|teredo|6to4)\b') { return $true }
            if ($nl -match 'kernel\s+debug\s+network\s+adapter') { return $true }
            if ($nl -match '\b(hyper-?v|vmware|virtualbox)\b') { return $true }
            if ($nl -match '\bvirtual\s+(ethernet|switch)\b') { return $true }
            if ($nl -match '\b(tap|tunnel|loopback|vpn)\b') { return $true }
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

    # Win7: full enumeration of Win32_PnPEntity can be extremely slow/hang on some PCs.
    # Query only selected PNPClass values with WQL filters.
    $want = @(
        @{ pnp = 'Keyboard'; kind = 'keyboard' },
        @{ pnp = 'Mouse'; kind = 'mouse' },
        @{ pnp = 'Monitor'; kind = 'monitor' },
        @{ pnp = 'Image'; kind = 'camera' },
        @{ pnp = 'Camera'; kind = 'camera' },
        @{ pnp = 'Media'; kind = 'audio' },
        @{ pnp = 'AudioEndpoint'; kind = 'audio' },
        @{ pnp = 'Printer'; kind = 'printer' },
        @{ pnp = 'PrintQueue'; kind = 'printer' },
        @{ pnp = 'Bluetooth'; kind = 'bluetooth' },
        @{ pnp = 'Net'; kind = 'net' }
    )

    try {
        foreach ($w in $want) {
            if ($out.Count -ge $Max) { break }
            $pnpClass = [string]$w.pnp
            $kind = [string]$w.kind
            $flt = "PNPClass='$pnpClass'"
            try {
                $devs = Get-WmiObject Win32_PnPEntity -Filter $flt -ErrorAction SilentlyContinue
                if ($INV_DEBUG) { Log ("DBG: PnPEntity filter " + $flt + " count=" + $(if ($devs) { @($devs).Count } else { 0 })) }
                foreach ($d in @($devs)) {
                    if ($out.Count -ge $Max) { break }
                    $name = $null
                    try { if ($d.Name) { $name = ([string]$d.Name).Trim() } } catch { }
                    if (-not $name) { continue }
                    if (Test-IsNoisePeripheral $kind $name) { continue }
                    $k = ($kind + '|' + $name.ToLower())
                    if ($seen.ContainsKey($k)) { continue }
                    $seen[$k] = $true
                    [void]$out.Add(@{ kind = $kind; name = $name })
                }
            } catch {
                if ($INV_DEBUG) { Log ("DBG: PnPEntity filter failed (" + $flt + "): " + $_.Exception.Message) }
            }
        }
    } catch {
        if ($INV_DEBUG) { Log ("DBG: peripherals filtered exception: " + $_.Exception.Message) }
    }

    # Fallback WMI classes if PnPEntity yields nothing
    if ($out.Count -eq 0) {
        try {
            foreach ($k in @(Get-WmiObject Win32_Keyboard -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($k -and $k.Name) { [void]$out.Add(@{ kind='keyboard'; name=([string]$k.Name).Trim() }) }
            }
        } catch { }
        try {
            foreach ($m in @(Get-WmiObject Win32_PointingDevice -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($m -and $m.Name) { [void]$out.Add(@{ kind='mouse'; name=([string]$m.Name).Trim() }) }
            }
        } catch { }
        try {
            foreach ($p in @(Get-WmiObject Win32_Printer -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($p -and $p.Name) { [void]$out.Add(@{ kind='printer'; name=([string]$p.Name).Trim() }) }
            }
        } catch { }
        try {
            foreach ($a in @(Get-WmiObject Win32_SoundDevice -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($a -and $a.Name) { [void]$out.Add(@{ kind='audio'; name=([string]$a.Name).Trim() }) }
            }
        } catch { }
        try {
            foreach ($n in @(Get-WmiObject Win32_NetworkAdapter -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($n -and $n.Name) {
                    $nm = ([string]$n.Name).Trim()
                    if (-not (Test-IsNoisePeripheral 'net' $nm)) { [void]$out.Add(@{ kind='net'; name=$nm }) }
                }
            }
        } catch { }
        try {
            foreach ($mon in @(Get-WmiObject Win32_DesktopMonitor -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if ($mon -and $mon.Name) { [void]$out.Add(@{ kind='monitor'; name=([string]$mon.Name).Trim() }) }
            }
        } catch { }

        # de-dupe fallback entries
        $ded = New-Object System.Collections.ArrayList
        foreach ($x in $out) {
            if (-not $x.name) { continue }
            if (Test-IsNoisePeripheral ([string]$x.kind) ([string]$x.name)) { continue }
            $key = ($x.kind + '|' + ([string]$x.name).ToLower())
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            [void]$ded.Add($x)
        }
        $out = $ded
        if ($INV_DEBUG) { Log ("DBG: peripherals fallback count=" + $out.Count) }
    }
    return @($out.ToArray())
}

function Post-Json([string]$Uri, [string]$Token, [string]$Json) {
    # Win7 often has system proxy enabled; WebClient may route through it and get 504.
    # Use HttpWebRequest with Proxy disabled + explicit timeouts.
    $req = [System.Net.HttpWebRequest]([System.Net.WebRequest]::Create($Uri))
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Proxy = $null
    $req.Timeout = 45000
    $req.ReadWriteTimeout = 45000
    if ($Token -and $Token.Trim().Length -gt 0) {
        $req.Headers.Add('Authorization', 'Bearer ' + $Token.Trim())
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Close()
    }

    $resp = $null
    $respStream = $null
    $reader = $null
    try {
        $resp = [System.Net.HttpWebResponse]$req.GetResponse()
        $respStream = $resp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($respStream, [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    } catch [System.Net.WebException] {
        $we = $_.Exception
        # Extra diagnostics for "Unable to connect" cases
        try {
            $sx = $we
            while ($sx -and -not ($sx -is [System.Net.Sockets.SocketException])) { $sx = $sx.InnerException }
            if ($sx -is [System.Net.Sockets.SocketException]) {
                Log ("NET: socket=" + [int]$sx.ErrorCode + " " + $sx.Message)
            }
        } catch { }
        $r = $we.Response
        if ($r -ne $null) {
            try {
                $status = [int]$r.StatusCode
                $rs = $r.GetResponseStream()
                $rd = New-Object System.IO.StreamReader($rs, [System.Text.Encoding]::UTF8)
                $body = $rd.ReadToEnd()
                throw ("HTTP " + $status + ": " + $body)
            } catch {
                throw ("HTTP error: " + $we.Message)
            } finally {
                try { if ($rd) { $rd.Close() } } catch { }
                try { if ($rs) { $rs.Close() } } catch { }
                try { $r.Close() } catch { }
            }
        }
        throw ("HTTP error: " + $we.Message)
    } finally {
        if ($reader) { $reader.Close() }
        if ($respStream) { $respStream.Close() }
        if ($resp) { $resp.Close() }
    }
}

Log "=== Inventory client (Win7): start ==="

$base = $env:INVENTORY_SERVER
if (-not $base -or $base.Trim().Length -eq 0) {
    throw 'INVENTORY_SERVER is not set. Configure agent_env.bat or set the environment variable.'
}
$base = $base.TrimEnd('/')
$token = $env:AGENT_TOKEN

# Candidates: ports from URL (e.g. 3250 for docker 3250:3001), then 3001, 3000; paths /api/v1/agent/inventory or legacy
$u = New-Object System.Uri($base)
$serverHost = $u.Host
$scheme = $u.Scheme
$ports = @()
if ($u.Port -gt 0) {
    $urlPort = [int]$u.Port
    if ($urlPort -eq 3250 -and -not ($ports -contains 3001)) { $ports += 3001 }
    if (-not ($ports -contains $urlPort)) { $ports += $urlPort }
}
if (-not ($ports -contains 3250)) { $ports += 3250 }
if (-not ($ports -contains 3001)) { $ports += 3001 }
if (-not ($ports -contains 3000)) { $ports += 3000 }
$paths = @('/api/v1/agent/inventory', '/api/agent/inventory')

Log "[1/5] Collect: machine + OS + CPU + MAC ..."
$hostname = FirstNonEmpty @($env:COMPUTERNAME, (Get-WmiText 'Win32_ComputerSystem' 'Name'))
if (-not $hostname -or $hostname.Trim().Length -eq 0) { $hostname = 'unknown-host' }
$osName = Safe-Call "WMI OS Caption" { Get-WmiText 'Win32_OperatingSystem' 'Caption' }
$osVer = Safe-Call "WMI OS Version" { Get-WmiText 'Win32_OperatingSystem' 'Version' }
$osBuild = Safe-Call "WMI OS BuildNumber" { Get-WmiText 'Win32_OperatingSystem' 'BuildNumber' }
$osVersion = $null
if ($osVer -or $osBuild) {
    $osVersion = ((@($osVer, $(if ($osBuild) { 'build ' + $osBuild } else { $null })) | Where-Object { $_ -ne $null -and ([string]$_).Trim() -ne '' }) -join ' ').Trim()
}
$cpu = Safe-Call "WMI CPU Name" { Get-WmiText 'Win32_Processor' 'Name' }
$mfr = Safe-Call "WMI CS Manufacturer" { Get-WmiText 'Win32_ComputerSystem' 'Manufacturer' }
$model = Safe-Call "WMI CS Model" { Get-WmiText 'Win32_ComputerSystem' 'Model' }
$serial = Safe-Call "WMI BIOS SerialNumber" { Get-WmiText 'Win32_BIOS' 'SerialNumber' }
$mac = Safe-Call "WMI primary MAC" { Get-PrimaryMac }
$memPct = Safe-Call "WMI memory percent" { Get-MemoryUsedPercent }
$gpuName = Safe-Call "WMI GPU Name" { Get-GpuName }
$mbMfr = Safe-Call "WMI baseboard Manufacturer" { Get-WmiText 'Win32_BaseBoard' 'Manufacturer' }
$mbProduct = Safe-Call "WMI baseboard Product" { Get-WmiText 'Win32_BaseBoard' 'Product' }
$ramGb = $null
try {
    $cs = Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs -and $cs.TotalPhysicalMemory) {
        $ramGb = [math]::Round(([double]$cs.TotalPhysicalMemory / 1GB), 2)
    }
} catch {
    if ($INV_DEBUG) { Log ("DBG: WMI TotalPhysicalMemory failed: " + $_.Exception.Message) }
}

$sw = @()
$per = @()
$disks = @()
Log "[2/5] Registry: installed software ..."
try { $sw = @(Get-InstalledSoftwareBasic -Max 400) } catch { if ($INV_DEBUG) { Log ("DBG: software failed: " + $_.Exception.Message) } }
Log "[3/5] WMI: peripherals ..."
try { $per = @(Get-PeripheralsBasic -Max 80) } catch { if ($INV_DEBUG) { Log ("DBG: peripherals failed: " + $_.Exception.Message) } }
Log "[4/5] WMI: disks ..."
try { $disks = @(Get-InventoryDisks) } catch { if ($INV_DEBUG) { Log ("DBG: disks failed: " + $_.Exception.Message) } }

# Build JSON manually (PS2-safe).
Log "[5/5] JSON: build payload ..."
$json = '{'
$json += '"hostname":"' + (JsonEscape $hostname) + '",'
$json += '"serial_number":' + ($(if ($serial) { '"' + (JsonEscape $serial) + '"' } else { 'null' })) + ','
$json += '"mac_primary":' + ($(if ($mac) { '"' + (JsonEscape $mac) + '"' } else { 'null' })) + ','
$json += '"cpu":' + ($(if ($cpu) { '"' + (JsonEscape $cpu) + '"' } else { 'null' })) + ','
$json += '"ram_gb":' + ($(if ($ramGb -ne $null) { [string]$ramGb } else { 'null' })) + ','
$json += '"memory_used_percent":' + ($(if ($memPct -ne $null) { [string]$memPct } else { 'null' })) + ','
$json += '"gpu_name":' + ($(if ($gpuName) { '"' + (JsonEscape $gpuName) + '"' } else { 'null' })) + ','
$json += '"os_name":' + ($(if ($osName) { '"' + (JsonEscape $osName) + '"' } else { 'null' })) + ','
$json += '"os_version":' + ($(if ($osVersion) { '"' + (JsonEscape $osVersion) + '"' } else { 'null' })) + ','
$json += '"manufacturer":' + ($(if ($mfr) { '"' + (JsonEscape $mfr) + '"' } else { 'null' })) + ','
$json += '"model":' + ($(if ($model) { '"' + (JsonEscape $model) + '"' } else { 'null' })) + ','
$json += '"motherboard_manufacturer":' + ($(if ($mbMfr) { '"' + (JsonEscape $mbMfr) + '"' } else { 'null' })) + ','
$json += '"motherboard_product":' + ($(if ($mbProduct) { '"' + (JsonEscape $mbProduct) + '"' } else { 'null' })) + ','
$json += '"location":null,'
$json += '"software":['
for ($i = 0; $i -lt $sw.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $n = $sw[$i].name
    $v = $sw[$i].version
    $json += '{"name":"' + (JsonEscape ([string]$n)) + '","version":' + ($(if ($v) { '"' + (JsonEscape ([string]$v)) + '"' } else { 'null' })) + '}'
}
$json += '],'
$json += '"peripherals":['
for ($i = 0; $i -lt $per.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $json += '{"kind":"' + (JsonEscape ([string]$per[$i].kind)) + '","name":"' + (JsonEscape ([string]$per[$i].name)) + '"}'
}
$json += '],'
$json += '"disks":['
for ($i = 0; $i -lt $disks.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $d = $disks[$i]
    $json += '{'
    $json += '"mount":"' + (JsonEscape ([string]$d.mount)) + '",'
    $json += '"label":' + ($(if ($d.label) { '"' + (JsonEscape ([string]$d.label)) + '"' } else { 'null' })) + ','
    $json += '"total_gb":' + ($(if ($d.total_gb -ne $null) { [string]$d.total_gb } else { 'null' })) + ','
    $json += '"used_percent":' + ($(if ($d.used_percent -ne $null) { [string]$d.used_percent } else { 'null' })) + ','
    $json += '"free_gb":' + ($(if ($d.free_gb -ne $null) { [string]$d.free_gb } else { 'null' }))
    $json += '}'
}
$json += ']'
$json += '}'

Log ("Config: base URL = " + $base)
Log ("Config: host = " + $serverHost)
Log ("Config: token = " + ($(if ($token) { $token.Substring(0, [Math]::Min(8, $token.Length)) + '...' } else { '(none)' })))
Log ("Config: payload sizes - sw=" + $sw.Count + " per=" + $per.Count + " disks=" + $disks.Count)

# For troubleshooting (especially on Win7): store payload locally.
try {
    $payloadPath = Join-Path $env:TEMP 'inventory_payload_win7.json'
    [System.IO.File]::WriteAllText($payloadPath, $json, [System.Text.Encoding]::UTF8)
    Log ("DBG: saved payload to " + $payloadPath + " bytes=" + $json.Length)
} catch { }

$lastErr = $null

# Store-and-forward: send previous unsent report first.
try {
    $pending = Load-PendingReport
    if ($pending -and $pending.Trim().Length -gt 0) {
        Log "Found pending report from previous run. Sending it first..."
        foreach ($p0 in $ports) {
            foreach ($path0 in $paths) {
                $uri0 = "{0}://{1}:{2}{3}" -f $scheme, $serverHost, $p0, $path0
                Log ("HTTP: POST (pending) " + $uri0)
                try {
                    Log-NetDiag -HostName $serverHost -Port ([int]$p0) -Uri $uri0
                    $resp0 = Post-Json -Uri $uri0 -Token $token -Json $pending
                    Log ("HTTP: OK (pending) " + $resp0)
                    Clear-PendingReport
                    $p0 = $null
                    $path0 = $null
                    break
                } catch {
                    $lastErr = $_.Exception
                    Log ("HTTP: pending failed: " + $lastErr.Message)
                }
            }
        }
    }
} catch { }

foreach ($p in $ports) {
    foreach ($path in $paths) {
        $uri = "{0}://{1}:{2}{3}" -f $scheme, $serverHost, $p, $path
        Log ("HTTP: POST " + $uri)
        try {
            Log-NetDiag -HostName $serverHost -Port ([int]$p) -Uri $uri
            $resp = Post-Json -Uri $uri -Token $token -Json $json
            Log ("HTTP: OK " + $resp)
            Log ("HTTP: working endpoint = " + $uri)
            Log "=== Inventory client (Win7): done ==="
            exit 0
        } catch {
            $lastErr = $_.Exception
            Log ("HTTP: failed: " + $lastErr.Message)
        }
    }
}

Log "=== Inventory client (Win7): FAILED ==="
if ($lastErr -and $lastErr.InnerException) {
    Log ("Inner: " + $lastErr.InnerException.Message)
}
try { Save-PendingReport -Json $json } catch { }
exit 1

