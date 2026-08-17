#Requires -Version 5.1
# Office (fast registry + licensing), optional Windows features (timeout)

function Get-OfficeVersionLabel {
    param([string]$Ver)
    switch ($Ver) {
        '14.0' { return 'Office 2010' }
        '15.0' { return 'Office 2013' }
        '16.0' { return 'Office 2016 / 365' }
        default { return "Office ($Ver)" }
    }
}

function Get-ExtendedSoftware {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'windows_features') {
        Log '[ext] Windows features (timeout 5s)...'
        $features = [System.Collections.ArrayList]@()
        try {
            $job = Start-Job -ScriptBlock {
                Get-WindowsOptionalFeature -Online -ErrorAction SilentlyContinue |
                    Where-Object { $_.State -eq 'Enabled' } |
                    Select-Object -First 100
            }
            $done = Wait-Job -Job $job -Timeout 5
            if ($done) {
                foreach ($f in @(Receive-Job -Job $job)) {
                    [void]$features.Add(@{ name = [string]$f.FeatureName; state = [string]$f.State })
                }
            } else {
                Stop-AgentJob -Job $job
            }
            Remove-AgentJob -Job $job
        } catch { }
        if ($features.Count -gt 0) { $out.windows_features = @($features.ToArray()) }
    }

    if (Test-ModuleEnabled $Config 'office') {
        Log '[ext] Microsoft Office (registry)...'
        $installs = [System.Collections.ArrayList]@()
        $licenses = [System.Collections.ArrayList]@()
        $seenVer = @{}

        foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Office', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Office')) {
            try {
                if (-not (Test-Path $root)) { continue }
                foreach ($ver in @(Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
                    $verKey = [string]$ver.PSChildName
                    if ($seenVer.ContainsKey($verKey)) { continue }
                    $p = Join-Path $ver.PSPath 'Common\InstallRoot'
                    $ir = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
                    if ($ir -and $ir.Path) {
                        $seenVer[$verKey] = $true
                        [void]$installs.Add(@{
                            version      = $verKey
                            label        = (Get-OfficeVersionLabel $verKey)
                            install_root = [string]$ir.Path
                        })
                    }
                }
            } catch { }
        }

        if ($installs.Count -gt 0) {
            try {
                $licJob = Start-Job -ScriptBlock {
                    Get-CimInstance -ClassName SoftwareLicensingProduct -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -match 'Office' -and $_.PartialProductKey } |
                        Select-Object -First 8
                }
                $licDone = Wait-Job -Job $licJob -Timeout 4
                if ($licDone) {
                    foreach ($lic in @(Receive-Job -Job $licJob)) {
                        [void]$licenses.Add(@{
                            product        = [string]$lic.Name
                            license_status = [int]$lic.LicenseStatus
                            partial_key    = [string]$lic.PartialProductKey
                        })
                    }
                } else {
                    Stop-AgentJob -Job $licJob
                }
                Remove-AgentJob -Job $licJob
            } catch { }
        }

        if ($installs.Count -gt 0) { $out.office_installs = @($installs.ToArray()) }
        if ($licenses.Count -gt 0) { $out.office_licenses = @($licenses.ToArray()) }
    }

    return $out
}
