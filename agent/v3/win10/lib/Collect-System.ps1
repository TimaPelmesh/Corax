#Requires -Version 5.1
# User sessions, Windows patches (KB) — без домена и uptime

function Get-ExtendedSystem {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'domain_sessions') {
        Log '[ext] user, sessions...'
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
        $out.system = @{
            computer_role      = if ($cs) { [string]$cs.DomainRole } else { $null }
            primary_user       = if ($cs -and $cs.UserName) { [string]$cs.UserName } else { $null }
            system_type        = if ($cs) { [string]$cs.SystemType } else { $null }
            total_processes    = if ($os) { [int]$os.NumberOfProcesses } else { $null }
            locale             = if ($os) { [string]$os.Locale } else { $null }
        }

        $sessions = [System.Collections.ArrayList]@()
        try {
            foreach ($s in @(query user 2>$null)) {
                if ($s -match '^\s*USERNAME') { continue }
                if ($s -match '^\s*(\S+)\s+(\S+)\s+(\d+)\s+(\S+)') {
                    [void]$sessions.Add(@{
                        username = $Matches[1]; session = $Matches[2]
                        id = $Matches[3]; state = $Matches[4]
                    })
                }
            }
        } catch { }
        if ($sessions.Count -gt 0) { $out.sessions = @($sessions.ToArray()) }
    }

    if (Test-ModuleEnabled $Config 'patches') {
        Log '[ext] Windows patches (KB)...'
        $max = Get-ModuleLimit -Config $Config -Name 'patches_max' -Default 500
        $patches = [System.Collections.ArrayList]@()
        try {
            $hotfixes = Invoke-WithTimeout -TimeoutSec 15 -ScriptBlock {
                @(Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending)
            }
            if ($hotfixes) {
                foreach ($hf in @($hotfixes)) {
                    if ($patches.Count -ge $max) { break }
                    [void]$patches.Add(@{
                        hotfix_id   = [string]$hf.HotFixID
                        description = [string]$hf.Description
                        installed_on = if ($hf.InstalledOn) { $hf.InstalledOn.ToString('o') } else { $null }
                    })
                }
            }
        } catch { }
        if ($patches.Count -eq 0) {
            foreach ($q in @(Get-CimInstance Win32_QuickFixEngineering -ErrorAction SilentlyContinue)) {
                if ($patches.Count -ge $max) { break }
                [void]$patches.Add(@{
                    hotfix_id = [string]$q.HotFixID
                    description = [string]$q.Description
                    installed_on = if ($q.InstalledOn) {
                        try { [Management.ManagementDateTimeConverter]::ToDateTime($q.InstalledOn).ToString('o') } catch { $null }
                    } else { $null }
                })
            }
        }
        if ($patches.Count -gt 0) { $out.patches = @($patches.ToArray()) }
    }

    return $out
}
