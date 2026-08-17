#Requires -Version 5.1
# SMART / physical disks, laptop battery

function Get-ExtendedStorage {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'storage_health') {
        Log '[ext] physical disks (quick)...'
        $disks = [System.Collections.ArrayList]@()
        try {
            $pdList = Invoke-WithTimeout -TimeoutSec 5 -ScriptBlock {
                Get-PhysicalDisk -ErrorAction SilentlyContinue
            }
            if ($pdList) {
                foreach ($pd in @($pdList)) {
                    [void]$disks.Add(@{
                        friendly_name  = [string]$pd.FriendlyName
                        media_type     = [string]$pd.MediaType
                        health_status  = [string]$pd.HealthStatus
                        operational_status = [string]$pd.OperationalStatus
                        size_gb        = [math]::Round([double]$pd.Size / 1GB, 2)
                        serial_number  = [string]$pd.SerialNumber
                    })
                }
            }
        } catch { }
        if ($disks.Count -eq 0) {
            try {
                foreach ($d in @(Get-CimInstance MSFT_PhysicalDisk -Namespace root\Microsoft\Windows\Storage -ErrorAction SilentlyContinue)) {
                    [void]$disks.Add(@{
                        friendly_name = [string]$d.FriendlyName
                        media_type    = [string]$d.MediaType
                        health_status = [string]$d.HealthStatus
                        size_gb       = if ($d.Size) { [math]::Round([double]$d.Size / 1GB, 2) } else { $null }
                    })
                }
            } catch { }
        }
        if ($disks.Count -gt 0) { $out.physical_disks = @($disks.ToArray()) }
    }

    if (Test-ModuleEnabled $Config 'battery') {
        Log '[ext] battery...'
        try {
            $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($bat) {
                $out.battery = @{
                    name              = [string]$bat.Name
                    chemistry         = [string]$bat.Chemistry
                    design_capacity   = [int]$bat.DesignCapacity
                    full_charge_capacity = [int]$bat.FullChargeCapacity
                    estimated_charge_remaining = [int]$bat.EstimatedChargeRemaining
                    battery_status    = [int]$bat.BatteryStatus
                }
            }
        } catch { }
    }

    return $out
}
