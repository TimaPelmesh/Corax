#Requires -Version 5.1
# Shared helpers for CORAX Agent

function Log([string]$Msg) {
    $stamp = Get-Date -Format 'HH:mm:ss'
    $line = "[$stamp] $Msg"
    Write-Host $line
    $targets = [System.Collections.Generic.List[string]]::new()
    if ($env:TEMP) { [void]$targets.Add((Join-Path $env:TEMP 'corax-agent.log')) }
    if ($global:CoraxAgentLogDir) {
        [void]$targets.Add((Join-Path $global:CoraxAgentLogDir 'corax-agent.log'))
    }
    foreach ($p in ($targets | Select-Object -Unique)) {
        try { Add-Content -LiteralPath $p -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
    }
}

function Get-CoraxLastRunPath {
    $dir = $global:CoraxAgentLogDir
    if (-not $dir) { $dir = $PSScriptRoot }
    $leaf = Split-Path -Leaf $dir
    if ($leaf -eq 'win10' -or $leaf -eq 'win7') {
        $parent = Split-Path -Parent $dir
        if ($parent) { $dir = $parent }
    }
    return (Join-Path $dir 'corax-last-run.txt')
}

function Write-CoraxLastRun {
    param(
        [Parameter(Mandatory = $true)][string]$Result,
        [string]$Detail = ''
    )
    $path = Get-CoraxLastRunPath
    $lines = @(
        'CORAX agent'
        ('status:  ' + $Result)
        ('time:    ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
        ('host:    ' + $env:COMPUTERNAME)
        ('server:  ' + [string]$env:INVENTORY_SERVER)
        ('log:     corax-agent.log')
    )
    if ($Detail) { $lines += ('detail:  ' + $Detail) }
    $lines += 'OK = PC is in the panel (Computers) and desktop shortcut should exist.'
    try {
        [System.IO.File]::WriteAllLines($path, [string[]]$lines)
    } catch { }
}

function Set-AgentProgress {
    param([string]$Status, [int]$Percent)
    $pct = [Math]::Max(0, [Math]::Min(100, $Percent))
    Write-Host ("  [{0,3}%] {1}" -f $pct, $Status)
}

function Stop-AgentJob {
    param($Job)
    if (-not $Job) { return }
    # Windows PowerShell 5.1: Stop-Job has no -Force (added in PS 6+).
    Stop-Job -Job $Job -ErrorAction SilentlyContinue
}

function Remove-AgentJob {
    param($Job)
    if (-not $Job) { return }
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
}

function Invoke-WithTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [int]$TimeoutSec = 12
    )
    # Start-Job is optional. On locked-down PCs it throws and used to abort
    # the whole agent after the splash — skip the module instead.
    $job = $null
    try {
        $job = Start-Job -ScriptBlock $ScriptBlock -ErrorAction Stop
    } catch {
        Log "WARN: Start-Job unavailable, skip timed collect: $($_.Exception.Message)"
        return $null
    }
    try {
        if (Wait-Job -Job $job -Timeout $TimeoutSec) {
            return Receive-Job -Job $job
        }
        return $null
    } finally {
        Stop-AgentJob -Job $job
        Remove-AgentJob -Job $job
    }
}

function Clear-AgentProgress {
}

function Get-AgentConfig {
    param([string]$Root = $PSScriptRoot)
    $defaults = @{
        agent_version = '3.0.1'
        profile       = 'full'
        modules       = @{
            patches = $true; network = $true; domain_sessions = $true
            bitlocker = $true; tpm_secureboot = $true; antivirus = $true
            startup = $true; services = $true; storage_health = $true
            battery = $true; windows_features = $true; office = $true
            usb_history = $true; docker_wsl = $true
        }
        limits = @{
            software_max = 12000; services_max = 120; patches_max = 500; usb_max = 200
        }
    }
    $path = $null
    $dir = $Root
    for ($i = 0; $i -lt 5; $i++) {
        $try = Join-Path $dir 'agent_config.json'
        if (Test-Path -LiteralPath $try) {
            $path = $try
            break
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    if (-not $path) {
        Log "WARN: agent_config.json missing, using defaults (full profile)"
        return [pscustomobject]$defaults
    }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
        $cfg = $raw | ConvertFrom-Json
        if (-not $cfg.modules) { $cfg | Add-Member -NotePropertyName modules -NotePropertyValue $defaults.modules }
        if (-not $cfg.limits) { $cfg | Add-Member -NotePropertyName limits -NotePropertyValue $defaults.limits }
        return $cfg
    } catch {
        Log "WARN: agent_config.json parse error, using defaults"
        return [pscustomobject]$defaults
    }
}

function Test-ModuleEnabled {
    param($Config, [string]$Name)
    if (-not $Config.modules) { return $true }
    $m = $Config.modules
    if ($m.PSObject.Properties.Name -contains $Name) {
        return [bool]$m.$Name
    }
    return $true
}

function Get-ModuleLimit {
    param($Config, [string]$Name, [int]$Default = 500)
    if ($Config.limits -and ($Config.limits.PSObject.Properties.Name -contains $Name)) {
        return [int]$Config.limits.$Name
    }
    return $Default
}

function Test-IsWmiPlaceholder {
    param([string]$s)
    if ([string]::IsNullOrWhiteSpace($s)) { return $true }
    $t = $s.Trim()
    return ($t -match '^(System Product Name|System Manufacturer|System Model|System Version|System SKU|System Serial Number|Default string|Default String|To be filled by O\.E\.M\.|To Be Filled By O\.E\.M\.|To be filled|Not Specified|OEM|O\.E\.M\.|INVALID|Invalid|All Series|Type1Family0|Bad string|undefined|Not Available|N/?A|Product Name|Not Applicable)$')
}

function Get-SanitizedAgentText {
    param([string]$Value)
    if ($null -eq $Value) { return $null }
    $t = $Value -replace "`0", ''
    if ([string]::IsNullOrWhiteSpace($t)) { return $null }
    return $t.Trim()
}

function Get-CleanWmiText {
    param([string]$value)
    $value = Get-SanitizedAgentText $value
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $t = $value.Trim()
    if ($t.Length -gt 256) { $t = $t.Substring(0, 256) }
    if (Test-IsWmiPlaceholder $t) { return $null }
    return $t
}

function Safe-Collect {
    param([string]$Label, [scriptblock]$Block)
    try {
        return & $Block
    } catch {
        Log "WARN: $Label - $($_.Exception.Message)"
        return $null
    }
}

function Get-CoraxDesktopDirs {
    $dirs = New-Object System.Collections.Generic.List[string]
    $add = {
        param([string]$p)
        if ([string]::IsNullOrWhiteSpace($p)) { return }
        try {
            if (-not (Test-Path -LiteralPath $p)) { return }
            [void]$dirs.Add((Get-Item -LiteralPath $p).FullName)
        } catch { }
    }
    foreach ($folder in @(
            [Environment]::GetFolderPath('CommonDesktopDirectory')
            [Environment]::GetFolderPath('Desktop')
        )) {
        if ($folder -and -not (Test-Path -LiteralPath $folder)) {
            try { New-Item -ItemType Directory -Path $folder -Force | Out-Null } catch { }
        }
        & $add $folder
    }
    try { & $add ([Environment]::GetFolderPath('DesktopDirectory')) } catch { }
    if ($env:USERPROFILE) {
        & $add (Join-Path $env:USERPROFILE 'Desktop')
        & $add (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
        Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'OneDrive*' } |
            ForEach-Object { & $add (Join-Path $_.FullName 'Desktop') }
    }
    if ($env:OneDrive) { & $add (Join-Path $env:OneDrive 'Desktop') }
    if ($env:OneDriveCommercial) { & $add (Join-Path $env:OneDriveCommercial 'Desktop') }
    $who = [string]$env:USERNAME
    if ($who -match '^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$') {
        $usersRoot = Split-Path -Parent $env:PUBLIC
        if (-not $usersRoot) { $usersRoot = 'C:\Users' }
        Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '^(Public|Default|Default User|All Users|WDAGUtilityAccount)$' } |
            ForEach-Object {
                & $add (Join-Path $_.FullName 'Desktop')
                & $add (Join-Path $_.FullName 'OneDrive\Desktop')
                Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like 'OneDrive*' } |
                    ForEach-Object { & $add (Join-Path $_.FullName 'Desktop') }
            }
    }
    if ($PSScriptRoot) {
        $win10 = Split-Path -Parent $PSScriptRoot
        & $add $win10
        if ($win10) { & $add (Split-Path -Parent $win10) }
    }
    return @($dirs | Select-Object -Unique)
}

function Save-CoraxInternetShortcut {
    param([string]$Path, [string]$Url, [string]$IconFile, [int]$IconIndex)
    $isLnk = $Path -match '\.lnk$'
    $w = $null
    try {
        $w = New-Object -ComObject WScript.Shell
        $sc = $w.CreateShortcut($Path)
        if ($isLnk) {
            $sc.TargetPath = (Join-Path $env:SystemRoot 'explorer.exe')
            $sc.Arguments = $Url
            $sc.WindowStyle = 1
        } else {
            $sc.TargetPath = $Url
        }
        if ($IconFile) { $sc.IconLocation = "$IconFile,$IconIndex" }
        try { $sc.Description = 'Helpdesk /h' } catch { }
        $sc.Save()
        if (Test-Path -LiteralPath $Path) { return $true }
    } catch { }
    finally {
        if ($w) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch { } }
    }
    if ($isLnk) { return $false }
    try {
        $nl = "`r`n"
        $body = '[InternetShortcut]' + $nl + 'URL=' + $Url + $nl
        if ($IconFile) {
            $body += 'IconFile=' + $IconFile + $nl + 'IconIndex=' + $IconIndex + $nl
        }
        [System.IO.File]::WriteAllText($Path, $body, [Text.Encoding]::Unicode)
        return (Test-Path -LiteralPath $Path)
    } catch {
        Log ("WARN: shortcut write $($Path): $($_.Exception.Message)")
        return $false
    }
}

function Get-CoraxPrimaryIPv4 {
    # Основной IPv4 текущей машины (адаптер с default gateway).
    try {
        $cfg = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
        if ($cfg) {
            $ip = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
            if ($ip) { return $ip }
        }
    } catch { }
    try {
        $nic = Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction Stop |
            Where-Object { $_.IPEnabled -and $_.DefaultIPGateway } | Select-Object -First 1
        if ($nic) {
            $ip = @($nic.IPAddress) | Where-Object { $_ -and $_ -notmatch ':' } | Select-Object -First 1
            if ($ip) { return $ip }
        }
    } catch { }
    return $null
}

function Convert-CoraxServerUrl {
    # Если хост localhost/127.x — подставляем реальный IPv4 (агент на сервере -> IP сервера).
    param([string]$BaseUrl)
    $base = $BaseUrl.TrimEnd('/')
    try {
        $u = [uri]$base
        if ($u.Host -in @('localhost', '127.0.0.1', '::1')) {
            $ip = Get-CoraxPrimaryIPv4
            if ($ip) {
                $ub = New-Object System.UriBuilder($u)
                $ub.Host = $ip
                return $ub.Uri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
            }
        }
    } catch { }
    return $base
}

function Remove-CoraxOldShortcuts {
    param([string]$Dir)
    foreach ($old in @('Заявка в IT', 'Заявка CORAX', 'CORAX-ticket')) {
        foreach ($ext in @('.lnk', '.url')) {
            $p = Join-Path $Dir ($old + $ext)
            if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } catch { } }
        }
    }
}

function Install-CoraxHelpdeskShortcut {
    param(
        [string]$ServerUrl,
        [string]$Hostname,
        [string]$IconPath = ''
    )
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) { return }
    $hostName = ([string]$Hostname).Trim()
    if (-not $hostName -or $hostName -eq 'unknown-host') { return }
    $base = Convert-CoraxServerUrl -BaseUrl $ServerUrl
    $pc = [uri]::EscapeDataString($hostName)
    $url = "$base/h#pc=$pc"
    $icon = $IconPath
    $idx = 81
    if (-not $icon -or -not (Test-Path -LiteralPath $icon)) {
        $sys = Join-Path $env:SystemRoot 'System32'
        $tryIcon = Join-Path $sys 'imageres.dll'
        if (Test-Path -LiteralPath $tryIcon) { $icon = $tryIcon; $idx = 81 }
        else { $icon = Join-Path $sys 'shell32.dll'; $idx = 14 }
    }
    $names = @(
        'Оставить заявку.lnk',
        'Оставить заявку.url'
    )
    $written = 0
    foreach ($d in (Get-CoraxDesktopDirs)) {
        Remove-CoraxOldShortcuts -Dir $d
        foreach ($name in $names) {
            $path = Join-Path $d $name
            if (Save-CoraxInternetShortcut -Path $path -Url $url -IconFile $icon -IconIndex $idx) {
                $written++
                Log "Helpdesk shortcut: $path"
                break
            }
        }
    }
    if ($written -gt 0) { Log "Helpdesk shortcut OK: $url ($written)" }
    else { Log "WARN: helpdesk shortcut was not created for $url" }
}

