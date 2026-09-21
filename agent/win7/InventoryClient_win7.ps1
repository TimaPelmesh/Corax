# Windows 7 / PowerShell 2.0 compatible inventory sender.
# Do not fail the whole run on partial WMI/registry errors: we still want to POST what we can.
$ErrorActionPreference = 'Continue'
$INV_DEBUG = $false
try { if ($env:INV_DEBUG -and $env:INV_DEBUG.Trim() -eq '1') { $INV_DEBUG = $true } } catch { }

function Log([string]$Msg) {
    $ts = (Get-Date).ToString('HH:mm:ss.fff')
    Write-Host ("[{0}] {1}" -f $ts, $Msg)
}

function Write-CoraxLastRun {
    param([string]$Result, [string]$Detail)
    $here = $script:CoraxWin7Dir
    if (-not $here) {
        try { $here = Split-Path -Parent $MyInvocation.ScriptName } catch { }
    }
    if (-not $here) { $here = (Get-Location).Path }
    $root = Split-Path -Parent $here
    if (-not $root) { $root = $here }
    $path = Join-Path $root 'corax-last-run.txt'
    $lines = @(
        'CORAX agent',
        ('status:  ' + $Result),
        ('time:    ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
        ('host:    ' + $env:COMPUTERNAME),
        ('server:  ' + [string]$env:INVENTORY_SERVER),
        ('log:     %TEMP%\inventory_agent_win7.log')
    )
    if ($Detail) { $lines += ('detail:  ' + $Detail) }
    $lines += 'OK = PC is in the panel (Computers) and desktop shortcut should exist.'
    try {
        $sw = New-Object System.IO.StreamWriter($path, $false, [System.Text.Encoding]::UTF8)
        foreach ($ln in $lines) { $sw.WriteLine($ln) }
        $sw.Close()
    } catch { }
}

function Get-CoraxPrimaryIPv4Win7 {
    try {
        $nic = @(Get-WmiObject Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPEnabled -and $_.DefaultIPGateway })
        if ($nic.Count -gt 0) {
            foreach ($ip in @($nic[0].IPAddress)) {
                if ($ip -and $ip -notmatch ':') { return $ip }
            }
        }
    } catch { }
    return $null
}

function Convert-CoraxServerUrlWin7 {
    param([string]$BaseUrl)
    $base = $BaseUrl.TrimEnd('/')
    try {
        $u = [uri]$base
        if (@('localhost', '127.0.0.1', '::1') -contains $u.Host) {
            $ip = Get-CoraxPrimaryIPv4Win7
            if ($ip) {
                $ub = New-Object System.UriBuilder($u)
                $ub.Host = $ip
                return $ub.Uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
            }
        }
    } catch { }
    return $base
}

function Install-CoraxHelpdeskShortcut {
    param(
        [string]$ServerUrl,
        [string]$Hostname
    )
    if (-not $ServerUrl -or $ServerUrl.Trim().Length -eq 0) { return }
    if (-not $Hostname -or $Hostname.Trim().Length -eq 0) { return }
    if ($Hostname.Trim() -eq 'unknown-host') { return }
    $base = Convert-CoraxServerUrlWin7 -BaseUrl $ServerUrl
    $pc = [uri]::EscapeDataString($Hostname.Trim())
    $url = $base + '/h#pc=' + $pc
    $nl = "`r`n"
    $icon = Join-Path $env:SystemRoot 'System32\SHELL32.dll'
    $idx = 1
    $body = '[InternetShortcut]' + $nl + 'URL=' + $url + $nl
    if (Test-Path $icon) {
        $body = $body + 'IconFile=' + $icon + $nl + 'IconIndex=' + $idx + $nl
    }
    $names = @('Оставить заявку.lnk', 'Оставить заявку.url')
    $oldNames = @('Заявка в IT.lnk', 'Заявка CORAX.lnk', 'CORAX-ticket.lnk', 'Заявка в IT.url', 'Заявка CORAX.url', 'CORAX-ticket.url')
    $dirs = @()
    try { $pub = [Environment]::GetFolderPath('CommonDesktopDirectory'); if ($pub -and (Test-Path $pub)) { $dirs += $pub } } catch { }
    try { $userDesk = [Environment]::GetFolderPath('Desktop'); if ($userDesk -and (Test-Path $userDesk)) { $dirs += $userDesk } } catch { }
    if ($env:USERPROFILE) {
        $d1 = Join-Path $env:USERPROFILE 'Desktop'
        if (Test-Path $d1) { $dirs += $d1 }
        $d2 = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
        if (Test-Path $d2) { $dirs += $d2 }
    }
    $who = [string]$env:USERNAME
    $isSvc = $false
    if ($who -eq 'SYSTEM' -or $who -eq 'LOCAL SERVICE' -or $who -eq 'NETWORK SERVICE') { $isSvc = $true }
    if ($isSvc) {
        $usersRoot = 'C:\Users'
        try { if ($env:PUBLIC) { $usersRoot = Split-Path -Parent $env:PUBLIC } } catch { }
        try {
            Get-ChildItem -Path $usersRoot -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer } | ForEach-Object {
                $n = $_.Name
                if ($n -eq 'Public' -or $n -eq 'Default' -or $n -eq 'Default User' -or $n -eq 'All Users') { return }
                $d = Join-Path $_.FullName 'Desktop'
                if (Test-Path $d) { $dirs += $d }
            }
        } catch { }
    }
    $explorer = Join-Path $env:SystemRoot 'explorer.exe'
    $unicode = [System.Text.Encoding]::Unicode
    $written = 0
    $seen = @{}
    foreach ($d in $dirs) {
        if ($seen.ContainsKey($d)) { continue }
        $seen[$d] = $true
        foreach ($old in $oldNames) {
            $oldPath = Join-Path $d $old
            if (Test-Path $oldPath) { try { Remove-Item -Path $oldPath -Force -ErrorAction SilentlyContinue } catch { } }
        }
        foreach ($name in $names) {
            $path = Join-Path $d $name
            $ok = $false
            try {
                $w = New-Object -ComObject WScript.Shell
                $sc = $w.CreateShortcut($path)
                if ($name -match '\.lnk$') {
                    $sc.TargetPath = $explorer
                    $sc.Arguments = $url
                    $sc.WindowStyle = 1
                } else {
                    $sc.TargetPath = $url
                }
                if (Test-Path $icon) { $sc.IconLocation = $icon + ',' + $idx }
                $sc.Save()
                if (Test-Path $path) { $ok = $true }
            } catch { }
            if (-not $ok -and $name -match '\.url$') {
                try {
                    [System.IO.File]::WriteAllText($path, $body, $unicode)
                    if (Test-Path $path) { $ok = $true }
                } catch { }
            }
            if ($ok) {
                $written = $written + 1
                Log ("Helpdesk shortcut: " + $path)
                break
            }
        }
    }
    if ($written -gt 0) { Log ("Helpdesk shortcut OK: " + $url + " (" + $written + ")") }
    else { Log ("WARN: helpdesk shortcut was not created for " + $url) }
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
    $t = [string]$s
    $t = $t -replace '\\', '\\\\'
    $t = $t -replace '"', '\"'
    $t = $t -replace "`r", '\r'
    $t = $t -replace "`n", '\n'
    $t = $t -replace "`t", '\t'
    $t = $t -replace ([char]8), '\b'
    $t = $t -replace ([char]12), '\f'
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

function Get-SanitizedAgentText {
    param([string]$Value)
    if ($null -eq $Value) { return $null }
    $t = $Value -replace "`0", ''
    if (-not $t) { return $null }
    $t = $t.Trim()
    if ($t.Length -eq 0) { return $null }
    return $t
}

function Add-InstalledSoftwareEntry {
    param(
        $List,
        $Seen,
        [string]$Name,
        [string]$Version,
        [int]$Max
    )
    if ($List.Count -ge $Max) { return }
    $name = Get-SanitizedAgentText $Name
    if (-not $name) { return }
    $ver = $null
    if ($Version) { $ver = Get-SanitizedAgentText $Version }
    $verKey = if ($ver) { $ver.ToLower() } else { '' }
    $dedupe = ($name.ToLower() + '|' + $verKey)
    if ($Seen.ContainsKey($dedupe)) { return }
    $Seen[$dedupe] = $true
    [void]$List.Add(@{ name = $name; version = $ver })
}

function Get-HashText($Item, [string]$Key) {
    if ($null -eq $Item) { return $null }
    try {
        $v = $Item[$Key]
        if ($v -ne $null -and ([string]$v).Trim().Length -gt 0) { return [string]$v }
    } catch { }
    try {
        $v = $Item.$Key
        if ($v -ne $null -and ([string]$v).Trim().Length -gt 0) { return [string]$v }
    } catch { }
    return $null
}

function Add-SoftwareFromRegistryKey($Root, [string]$SubPath, $List, $Seen, [int]$Max) {
    if ($List.Count -ge $Max) { return }
    $k = $null
    try { $k = $Root.OpenSubKey($SubPath) } catch { return }
    if ($null -eq $k) { return }
    try {
        foreach ($subName in @($k.GetSubKeyNames())) {
            if ($List.Count -ge $Max) { break }
            $sk = $null
            try {
                $sk = $k.OpenSubKey($subName)
                if ($null -eq $sk) { continue }
                $name = $sk.GetValue('DisplayName')
                if ($null -eq $name) { continue }
                $ver = $sk.GetValue('DisplayVersion')
                $verStr = $null
                if ($ver) { $verStr = [string]$ver }
                Add-InstalledSoftwareEntry -List $List -Seen $Seen -Name ([string]$name) -Version $verStr -Max $Max
            } catch {
            } finally {
                try { if ($sk) { $sk.Close() } } catch { }
            }
        }
    } catch {
    } finally {
        try { $k.Close() } catch { }
    }
}

function Get-InstalledSoftwareBasic([int]$Max = 500) {
    $seen = @{}
    $out = New-Object System.Collections.ArrayList
    try {
        $hklm = [Microsoft.Win32.Registry]::LocalMachine
        $hkcu = [Microsoft.Win32.Registry]::CurrentUser
        Add-SoftwareFromRegistryKey $hklm 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' $out $seen $Max
        Add-SoftwareFromRegistryKey $hklm 'SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall' $out $seen $Max
        Add-SoftwareFromRegistryKey $hkcu 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' $out $seen $Max
        Add-SoftwareFromRegistryKey $hkcu 'SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall' $out $seen $Max
    } catch {
        if ($INV_DEBUG) { Log ("DBG: Registry software: " + $_.Exception.Message) }
    }
    if ($out.Count -eq 0) {
        $psPaths = @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        foreach ($pattern in $psPaths) {
            if ($out.Count -ge $Max) { break }
            try {
                $propsList = Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue
                foreach ($props in @($propsList)) {
                    if ($out.Count -ge $Max) { break }
                    if (-not $props -or -not $props.DisplayName) { continue }
                    $ver = $null
                    if ($props.DisplayVersion) { $ver = [string]$props.DisplayVersion }
                    Add-InstalledSoftwareEntry -List $out -Seen $seen -Name ([string]$props.DisplayName) -Version $ver -Max $Max
                }
            } catch { }
        }
    }
    if ($INV_DEBUG) { Log ("DBG: software collected count=" + $out.Count) }
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

    # Win7 Win32_PnPEntity has no PNPClass (Win8+). Dedicated WMI classes first.
    $wmiMap = @(
        @{ Class = 'Win32_Keyboard'; Kind = 'keyboard' },
        @{ Class = 'Win32_PointingDevice'; Kind = 'mouse' },
        @{ Class = 'Win32_DesktopMonitor'; Kind = 'monitor' },
        @{ Class = 'Win32_Printer'; Kind = 'printer' },
        @{ Class = 'Win32_SoundDevice'; Kind = 'audio' },
        @{ Class = 'Win32_NetworkAdapter'; Kind = 'net' }
    )
    foreach ($item in $wmiMap) {
        if ($out.Count -ge $Max) { break }
        $kind = [string]$item.Kind
        try {
            foreach ($row in @(Get-WmiObject -Class $item.Class -ErrorAction SilentlyContinue)) {
                if ($out.Count -ge $Max) { break }
                if (-not $row -or -not $row.Name) { continue }
                $name = ([string]$row.Name).Trim()
                if (-not $name) { continue }
                if (Test-IsNoisePeripheral $kind $name) { continue }
                $k = ($kind + '|' + $name.ToLower())
                if ($seen.ContainsKey($k)) { continue }
                $seen[$k] = $true
                [void]$out.Add(@{ kind = $kind; name = $name })
            }
        } catch { }
    }
    if ($INV_DEBUG) { Log ("DBG: peripherals WMI count=" + $out.Count) }
    return @($out.ToArray())
}

function Get-NetworkAdaptersWin7 {
    $out = New-Object System.Collections.ArrayList
    try {
        foreach ($cfg in @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' -ErrorAction SilentlyContinue)) {
            if (-not $cfg) { continue }
            $ips = New-Object System.Collections.ArrayList
            foreach ($ip in @($cfg.IPAddress)) {
                if ($ip -and $ip -match '^\d+\.\d+\.\d+\.\d+$') { [void]$ips.Add([string]$ip) }
            }
            if ($ips.Count -eq 0) { continue }
            $mac = $null
            if ($cfg.MACAddress) { $mac = ([string]$cfg.MACAddress).Replace('-', ':').ToUpper() }
            $gw = $null
            foreach ($g in @($cfg.DefaultIPGateway)) {
                if ($g -and $g -match '^\d+\.\d+\.\d+\.\d+$') { $gw = [string]$g; break }
            }
            $desc = $null
            if ($cfg.Description) { $desc = ([string]$cfg.Description).Trim() }
            [void]$out.Add(@{
                description = $desc
                mac = $mac
                mac_address = $mac
                ipv4 = @($ips.ToArray())
                gateway = $gw
                status = 'up'
            })
        }
    } catch { }
    return @($out.ToArray())
}

function Get-InteractiveUserWin7 {
    try {
        $cs = Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cs -and $cs.UserName) {
            $u = ([string]$cs.UserName).Trim()
            if ($u) { return $u }
        }
    } catch { }
    try {
        $ex = Get-WmiObject Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ex) {
            $owner = $ex.GetOwner()
            if ($owner -and $owner.User) {
                if ($owner.Domain) { return ([string]$owner.Domain + '\' + [string]$owner.User) }
                return [string]$owner.User
            }
        }
    } catch { }
    return $null
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
$script:CoraxWin7Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-CoraxLastRun -Result 'RUNNING' -Detail 'Collecting inventory'

$base = $env:INVENTORY_SERVER
if (-not $base -or $base.Trim().Length -eq 0) {
    Write-CoraxLastRun -Result 'FAILED' -Detail 'INVENTORY_SERVER is not set'
    throw 'INVENTORY_SERVER is not set. Configure agent_env.bat or set the environment variable.'
}
$base = $base.TrimEnd('/')
$token = $env:AGENT_TOKEN

try { Install-CoraxHelpdeskShortcut -ServerUrl $base -Hostname $env:COMPUTERNAME } catch { }

# POST only to the stamped URL. Do not spray 3250/3001 — that looked like a "weird" send on lab PCs.
$u = New-Object System.Uri($base)
$serverHost = $u.Host
$urlPort = 80
if ($u.Scheme -eq 'https') { $urlPort = 443 }
if ($u.Port -gt 0) { $urlPort = [int]$u.Port }
$uris = @(
    ($base + '/api/v1/agent/inventory'),
    ($base + '/api/agent/inventory')
)

Log "[1/6] Collect: machine + OS + CPU + MAC ..."
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
    $cs = Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cs -and $cs.TotalPhysicalMemory) {
        $ramGb = [math]::Round(([double]$cs.TotalPhysicalMemory / 1GB), 2)
    }
} catch {
    if ($INV_DEBUG) { Log ("DBG: WMI TotalPhysicalMemory failed: " + $_.Exception.Message) }
}

$sw = @()
$per = @()
$disks = @()
$nics = @()
$primaryUser = $null
Log "[2/6] Registry: installed software ..."
try { $sw = @(Get-InstalledSoftwareBasic -Max 400) } catch { if ($INV_DEBUG) { Log ("DBG: software failed: " + $_.Exception.Message) } }
Log "[3/6] WMI: peripherals ..."
try { $per = @(Get-PeripheralsBasic -Max 80) } catch { if ($INV_DEBUG) { Log ("DBG: peripherals failed: " + $_.Exception.Message) } }
Log "[4/6] WMI: disks ..."
try { $disks = @(Get-InventoryDisks) } catch { if ($INV_DEBUG) { Log ("DBG: disks failed: " + $_.Exception.Message) } }
Log "[5/6] WMI: network + user ..."
try { $nics = @(Get-NetworkAdaptersWin7) } catch { if ($INV_DEBUG) { Log ("DBG: nics failed: " + $_.Exception.Message) } }
try { $primaryUser = Get-InteractiveUserWin7 } catch { }

# Build JSON manually (PS2-safe). Hashtable keys via indexer — `.name` is empty on PS 2 arrays.
Log "[6/6] JSON: build payload ..."
$json = '{'
$json += '"hostname":"' + (JsonEscape $hostname) + '",'
$json += '"serial_number":' + ($(if ($serial) { '"' + (JsonEscape $serial) + '"' } else { 'null' })) + ','
$json += '"mac_primary":' + ($(if ($mac) { '"' + (JsonEscape $mac) + '"' } else { 'null' })) + ','
$json += '"cpu":' + ($(if ($cpu) { '"' + (JsonEscape $cpu) + '"' } else { 'null' })) + ','
$json += '"ram_gb":' + ($(if ($ramGb -ne $null) { ([string]$ramGb).Replace(',', '.') } else { 'null' })) + ','
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
    $n = Get-HashText $sw[$i] 'name'
    $v = Get-HashText $sw[$i] 'version'
    $json += '{"name":"' + (JsonEscape ([string]$n)) + '","version":' + ($(if ($v) { '"' + (JsonEscape ([string]$v)) + '"' } else { 'null' })) + '}'
}
$json += '],'
$json += '"peripherals":['
for ($i = 0; $i -lt $per.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $pk = Get-HashText $per[$i] 'kind'
    $pn = Get-HashText $per[$i] 'name'
    $json += '{"kind":"' + (JsonEscape ([string]$pk)) + '","name":"' + (JsonEscape ([string]$pn)) + '"}'
}
$json += '],'
$json += '"disks":['
for ($i = 0; $i -lt $disks.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $d = $disks[$i]
    $mount = Get-HashText $d 'mount'
    $label = Get-HashText $d 'label'
    $tot = $null; $used = $null; $free = $null
    try { $tot = $d['total_gb'] } catch { try { $tot = $d.total_gb } catch { } }
    try { $used = $d['used_percent'] } catch { try { $used = $d.used_percent } catch { } }
    try { $free = $d['free_gb'] } catch { try { $free = $d.free_gb } catch { } }
    $json += '{'
    $json += '"mount":"' + (JsonEscape ([string]$mount)) + '",'
    $json += '"label":' + ($(if ($label) { '"' + (JsonEscape $label) + '"' } else { 'null' })) + ','
    $json += '"total_gb":' + ($(if ($tot -ne $null) { ([string]$tot).Replace(',', '.') } else { 'null' })) + ','
    $json += '"used_percent":' + ($(if ($used -ne $null) { [string]$used } else { 'null' })) + ','
    $json += '"free_gb":' + ($(if ($free -ne $null) { ([string]$free).Replace(',', '.') } else { 'null' }))
    $json += '}'
}
$json += '],'
$json += '"extended":{'
$json += '"agent_version":"3.2.4-win7",'
$json += '"network":{"adapters":['
for ($i = 0; $i -lt $nics.Count; $i++) {
    if ($i -gt 0) { $json += ',' }
    $ad = $nics[$i]
    $desc = Get-HashText $ad 'description'
    $adMac = Get-HashText $ad 'mac'
    $gw = Get-HashText $ad 'gateway'
    $json += '{'
    $json += '"description":' + ($(if ($desc) { '"' + (JsonEscape $desc) + '"' } else { 'null' })) + ','
    $json += '"mac":' + ($(if ($adMac) { '"' + (JsonEscape $adMac) + '"' } else { 'null' })) + ','
    $json += '"mac_address":' + ($(if ($adMac) { '"' + (JsonEscape $adMac) + '"' } else { 'null' })) + ','
    $json += '"status":"up",'
    $json += '"gateway":' + ($(if ($gw) { '"' + (JsonEscape $gw) + '"' } else { 'null' })) + ','
    $json += '"ipv4":['
    $ipList = @()
    try { $ipList = @($ad['ipv4']) } catch { try { $ipList = @($ad.ipv4) } catch { } }
    $ipN = 0
    foreach ($ip in $ipList) {
        if (-not $ip) { continue }
        if ($ipN -gt 0) { $json += ',' }
        $json += '"' + (JsonEscape ([string]$ip)) + '"'
        $ipN++
    }
    $json += ']'
    $json += '}'
}
$json += ']}'
if ($primaryUser) {
    $json += ',"system":{"primary_user":"' + (JsonEscape $primaryUser) + '"}'
    $json += ',"sessions":[{"username":"' + (JsonEscape $primaryUser) + '"}]'
}
$json += '}'
$json += '}'

Log ("Config: base URL = " + $base)
Log ("Config: host = " + $serverHost + " port=" + $urlPort)
Log ("Config: token = " + ($(if ($token) { $token.Substring(0, [Math]::Min(8, $token.Length)) + '...' } else { '(none)' })))
Log ("Config: payload sizes - sw=" + $sw.Count + " per=" + $per.Count + " disks=" + $disks.Count + " nics=" + $nics.Count)

try {
    $payloadPath = Join-Path $env:TEMP 'inventory_payload_win7.json'
    [System.IO.File]::WriteAllText($payloadPath, $json, [System.Text.Encoding]::UTF8)
    Log ("DBG: saved payload to " + $payloadPath + " bytes=" + $json.Length)
} catch { }

$lastErr = $null

function Send-Win7Report([string]$Payload) {
    foreach ($uri in $uris) {
        Log ("HTTP: POST " + $uri)
        try {
            Log-NetDiag -HostName $serverHost -Port $urlPort -Uri $uri
            $resp = Post-Json -Uri $uri -Token $token -Json $Payload
            Log ("HTTP: OK " + $resp)
            Log ("HTTP: working endpoint = " + $uri)
            return $true
        } catch {
            $script:lastErr = $_.Exception
            Log ("HTTP: failed: " + $_.Exception.Message)
        }
    }
    return $false
}

try {
    $pending = Load-PendingReport
    if ($pending -and $pending.Trim().Length -gt 0) {
        Log "Found pending report from previous run. Sending it first..."
        if (Send-Win7Report $pending) { Clear-PendingReport }
    }
} catch { }

if (Send-Win7Report $json) {
    try { Install-CoraxHelpdeskShortcut -ServerUrl $base -Hostname $hostname } catch { }
    Log "=== Inventory client (Win7): done ==="
    Write-CoraxLastRun -Result 'OK' -Detail 'Report sent'
    exit 0
}

Log "=== Inventory client (Win7): FAILED ==="
Write-CoraxLastRun -Result 'FAILED' -Detail 'Upload failed'
if ($lastErr -and $lastErr.InnerException) {
    Log ("Inner: " + $lastErr.InnerException.Message)
}
try { Save-PendingReport -Json $json } catch { }
exit 1

