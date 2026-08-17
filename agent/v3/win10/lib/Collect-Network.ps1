#Requires -Version 5.1
# IP, DNS, gateways, Wi-Fi

function Test-IsUsefulDns {
    param([string]$Addr)
    if ([string]::IsNullOrWhiteSpace($Addr)) { return $false }
    $a = $Addr.Trim().ToLowerInvariant()
    if ($a -match '^127\.') { return $false }
    if ($a -match '^fe80:') { return $false }
    if ($a -match '^fec0:') { return $false }
    if ($a -match '^::1$') { return $false }
    if ($a -match '^0\.0\.0\.0$') { return $false }
    return $true
}

function Get-ExtendedNetwork {
    param($Config)
    if (-not (Test-ModuleEnabled $Config 'network')) { return @{} }

    Log '[ext] network adapters, DNS, Wi-Fi...'
    $adapters = [System.Collections.ArrayList]@()
    $dnsV4 = [System.Collections.ArrayList]@()
    $dnsV6 = [System.Collections.ArrayList]@()
    $gateways = [System.Collections.ArrayList]@()
    $wifi = [System.Collections.ArrayList]@()

    try {
        foreach ($nc in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
            if ($nc.NetAdapter -and [string]$nc.NetAdapter.Status -eq 'Disconnected') { continue }
            $ipv4 = @()
            $ipv6 = @()
            if ($nc.IPv4Address) { $ipv4 += [string]$nc.IPv4Address.IPAddress }
            if ($nc.IPv6Address) { $ipv6 += [string]$nc.IPv6Address.IPAddress }
            $gw = $null
            if ($nc.IPv4DefaultGateway) { $gw = [string]$nc.IPv4DefaultGateway.NextHop }
            [void]$adapters.Add(@{
                interface_alias = [string]$nc.InterfaceAlias
                interface_index = [int]$nc.InterfaceIndex
                mac_address     = if ($nc.NetAdapter) { [string]$nc.NetAdapter.MacAddress } else { $null }
                status          = if ($nc.NetAdapter) { [string]$nc.NetAdapter.Status } else { $null }
                ipv4            = @($ipv4)
                ipv6            = @($ipv6 | Where-Object { $_ -and $_ -notmatch '^fe80:' })
                gateway         = $gw
                dhcp_enabled    = if ($nc.NetIPv4Interface) { [bool]$nc.NetIPv4Interface.Dhcp } else { $null }
            })
            if ($gw -and $gateways -notcontains $gw) { [void]$gateways.Add($gw) }
            if ($nc.DNSServer) {
                foreach ($d in $nc.DNSServer.ServerAddresses) {
                    if (-not (Test-IsUsefulDns $d)) { continue }
                    $ds = [string]$d
                    if ($ds -match ':') {
                        if ($dnsV6 -notcontains $ds) { [void]$dnsV6.Add($ds) }
                    } else {
                        if ($dnsV4 -notcontains $ds) { [void]$dnsV4.Add($ds) }
                    }
                }
            }
        }
    } catch {
        foreach ($cfg in @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' -ErrorAction SilentlyContinue)) {
            [void]$adapters.Add(@{
                description = [string]$cfg.Description
                mac_address = ($cfg.MACAddress -replace '-', ':')
                ipv4        = @($cfg.IPAddress | Where-Object { $_ -match '^\d+\.' })
                ipv6        = @()
                gateway     = @($cfg.DefaultIPGateway | Where-Object { $_ -match '^\d+\.' }) -join ','
                dhcp_enabled = [bool]$cfg.DHCPEnabled
            })
        }
    }

    try {
        $wlan = netsh wlan show interfaces 2>$null
        if ($wlan) {
            $ssid = $null; $signal = $null; $auth = $null
            foreach ($line in ($wlan -split "`n")) {
                if ($line -match '^\s*SSID\s*:\s*(.+)$' -and $line -notmatch 'BSSID') { $ssid = $Matches[1].Trim() }
                if ($line -match '^\s*Signal\s*:\s*(.+)$') { $signal = $Matches[1].Trim() }
                if ($line -match '^\s*Authentication\s*:\s*(.+)$') { $auth = $Matches[1].Trim() }
            }
            if ($ssid) {
                [void]$wifi.Add(@{ ssid = $ssid; signal = $signal; authentication = $auth })
            }
        }
    } catch { }

    @{
        adapters = @($adapters.ToArray())
        dns_v4   = @($dnsV4.ToArray())
        dns_v6   = @($dnsV6.ToArray())
        gateways = @($gateways.ToArray())
        wifi     = @($wifi.ToArray())
    }
}
