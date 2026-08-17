$ErrorActionPreference = 'SilentlyContinue'

function Get-PrinterStatusLabel {
    param([int]$Code)
    switch ($Code) {
        1 { return 'other' }
        2 { return 'unknown' }
        3 { return 'idle' }
        4 { return 'printing' }
        5 { return 'warmup' }
        6 { return 'stopped' }
        7 { return 'offline' }
        default { return "code_$Code" }
    }
}

function Test-IsNoisePrinterName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $true }
    $nl = $Name.Trim().ToLowerInvariant()
    if ($nl -match '^microsoft\s+print\s+to\s+pdf$') { return $true }
    if ($nl -match '\bxps\s+document\s+writer\b') { return $true }
    if ($nl -match 'onenote') { return $true }
    if ($nl -match '^fax$') { return $true }
    return $false
}

function Get-PrinterIpFromPort {
    param([string]$PortName)
    if ([string]::IsNullOrWhiteSpace($PortName)) { return $null }
    if ($PortName.Trim() -match '\b(\d{1,3}(?:\.\d{1,3}){3})\b') { return $Matches[1] }
    return $null
}

$out = @()
$seen = @{}
foreach ($pr in @(Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue)) {
    $name = if ($pr.Name) { [string]$pr.Name }.Trim() else { $null }
    if (-not $name -or (Test-IsNoisePrinterName $name)) { continue }
    $key = $name.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $port = if ($pr.PortName) { [string]$pr.PortName }.Trim() else { $null }
    $driver = if ($pr.DriverName) { [string]$pr.DriverName }.Trim() else { $null }
    $ip = Get-PrinterIpFromPort $port
    $isNet = $false
    if ($null -ne $pr.Network) { $isNet = [bool]$pr.Network }
    if ($ip) { $isNet = $true }
    $statusCode = $null
    if ($null -ne $pr.PrinterStatus) { $statusCode = [int]$pr.PrinterStatus }
    $statusLabel = if ($pr.WorkOffline) { 'offline' } elseif ($null -ne $statusCode) { Get-PrinterStatusLabel $statusCode } else { $null }
    $out += [pscustomobject]@{
        name         = $name
        driver_name  = $driver
        port_name    = $port
        shared       = [bool]$pr.Shared
        is_default   = [bool]$pr.Default
        is_network   = $isNet
        ip_address   = $ip
        status_code  = $statusCode
        status_label = $statusLabel
        work_offline = [bool]$pr.WorkOffline
    }
}
$out | ConvertTo-Json -Depth 4 -Compress
