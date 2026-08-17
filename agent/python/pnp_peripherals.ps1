# PnP devices -> JSON array on stdout (for agent.py). Max rows = first argument, default 140.
param([int]$Max = 140)

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

# Avoid non-ASCII literals (WinPS5 reads UTF-8 inconsistently without BOM).
$RU_GENERIC_PNP_MONITOR = -join @(
    [char]0x443, [char]0x43d, [char]0x438, [char]0x432, [char]0x435, [char]0x440, [char]0x441, [char]0x430,
    [char]0x43b, [char]0x44c, [char]0x43d, [char]0x44b, [char]0x439, [char]0x20, [char]0x43c, [char]0x43e,
    [char]0x43d, [char]0x438, [char]0x442, [char]0x43e, [char]0x440, [char]0x20, [char]0x70, [char]0x6e,
    [char]0x70
)
$RU_PRINT_QUEUE_ROOT = -join @(
    [char]0x43a, [char]0x43e, [char]0x440, [char]0x43d, [char]0x435, [char]0x432, [char]0x430, [char]0x44f,
    [char]0x20, [char]0x43e, [char]0x447, [char]0x435, [char]0x440, [char]0x435, [char]0x434, [char]0x44c,
    [char]0x20, [char]0x43f, [char]0x435, [char]0x447, [char]0x430, [char]0x442, [char]0x438
)

function Test-IsRealMonitorName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    $n = $Name.Trim().ToLowerInvariant()
    if ($n -eq $RU_GENERIC_PNP_MONITOR -or $n -eq 'generic pnp monitor') { return $false }
    if ($n -match 'nvidia|amd|radeon|intel\(r\)?.*graphics|geforce|display adapter') { return $false }
    if ($n -match 'mirror|dameware|remote display|basic display') { return $false }
    return $true
}

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
foreach ($d in @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)) {
    if ($out.Count -ge $Max) { break }
    if ($null -eq $d.Class -or '' -eq [string]$d.Class) { continue }
    $cls = [string]$d.Class
    if (-not $classToKind.ContainsKey($cls)) { continue }
    $nameRaw = $null
    if ($d.FriendlyName -and ([string]$d.FriendlyName).Trim()) {
        $nameRaw = [string]$d.FriendlyName
    } elseif ($d.Name -and ([string]$d.Name).Trim()) {
        $nameRaw = [string]$d.Name
    } elseif ($d.InstanceId -and ([string]$d.InstanceId).Trim()) {
        $nameRaw = [string]$d.InstanceId
    }
    if ($null -eq $nameRaw -or '' -eq $nameRaw.Trim()) { continue }
    $name = $nameRaw
    $name = $name.Trim()
    if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
    $kind = [string]$classToKind[$cls]
    if ($kind -eq 'monitor' -and -not (Test-IsRealMonitorName $name)) { continue }
    if (Test-IsNoisePeripheral -Kind $kind -Name $name) { continue }
    $key = $kind + '|' + $name.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    [void]$out.Add([pscustomobject]@{ kind = $kind; name = $name })
}

# Extra monitor detail from EDID-capable monitors (often richer than Generic PnP Monitor).
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
if ($out.Count -eq 0) {
    Write-Output '[]'
    exit 0
}
$out | ConvertTo-Json -Compress -Depth 3

