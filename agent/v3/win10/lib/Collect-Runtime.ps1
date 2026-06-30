#Requires -Version 5.1
# Startup programs, Windows services (fast: one WMI query)

function Get-ExtendedRuntime {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'startup') {
        Log '[ext] startup entries...'
        $startup = [System.Collections.ArrayList]@()
        $runPaths = @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
        )
        foreach ($rp in $runPaths) {
            try {
                $props = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
                if (-not $props) { continue }
                foreach ($pn in $props.PSObject.Properties.Name) {
                    if ($pn -in @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')) { continue }
                    $val = [string]$props.$pn
                    if ($val.Length -gt 1024) { $val = $val.Substring(0, 1024) }
                    [void]$startup.Add(@{ source = $rp; name = $pn; command = $val })
                }
            } catch { }
        }
        $out.startup = @($startup.ToArray())
    }

    if (Test-ModuleEnabled $Config 'services') {
        Log '[ext] Windows services (fast)...'
        $max = Get-ModuleLimit -Config $Config -Name 'services_max' -Default 120
        $services = [System.Collections.ArrayList]@()
        foreach ($svc in @(Get-Service -ErrorAction SilentlyContinue)) {
            if ($services.Count -ge $max) { break }
            $running = $svc.Status -eq 'Running'
            $auto = $svc.StartType -in @('Automatic', 'Boot', 'System')
            if (-not $running -and -not $auto) { continue }
            [void]$services.Add(@{
                name         = [string]$svc.Name
                display_name = [string]$svc.DisplayName
                status       = [string]$svc.Status
                start_type   = [string]$svc.StartType
            })
        }
        if ($services.Count -gt 0) { $out.services = @($services.ToArray()) }
    }

    return $out
}
