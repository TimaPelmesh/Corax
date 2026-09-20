#Requires -Version 5.1
# BitLocker, TPM, Secure Boot, antivirus (WMI SecurityCenter2)

function Get-ExtendedSecurity {
    param($Config)
    $out = @{}

    if (Test-ModuleEnabled $Config 'bitlocker') {
        Log '[ext] BitLocker (quick)...'
        $vols = [System.Collections.ArrayList]@()
        try {
            $bl = Invoke-WithTimeout -TimeoutSec 6 -ScriptBlock {
                Get-BitLockerVolume -ErrorAction SilentlyContinue
            }
            if ($bl) {
                foreach ($v in @($bl)) {
                    [void]$vols.Add(@{
                        mount_point       = [string]$v.MountPoint
                        volume_status     = [string]$v.VolumeStatus
                        protection_status = [string]$v.ProtectionStatus
                        encryption_method = [string]$v.EncryptionMethod
                    })
                }
            }
        } catch { }
        if ($vols.Count -gt 0) { $out.bitlocker = @($vols.ToArray()) }
    }

    if (Test-ModuleEnabled $Config 'tpm_secureboot') {
        Log '[ext] TPM, Secure Boot...'
        $tpm = @{}
        try {
            $t = Get-Tpm -ErrorAction SilentlyContinue
            if ($t) {
                $tpm = @{
                    present = [bool]$t.TpmPresent
                    ready   = [bool]$t.TpmReady
                    enabled = [bool]$t.TpmEnabled
                    version = if ($t.ManufacturerVersion) { [string]$t.ManufacturerVersion } else { $null }
                }
            }
        } catch { $tpm.error = $_.Exception.Message }
        $out.tpm = $tpm

        try {
            $sb = Confirm-SecureBootUEFI -ErrorAction SilentlyContinue
            $out.secure_boot_enabled = [bool]$sb
        } catch {
            $out.secure_boot_enabled = $null
        }
    }

    if (Test-ModuleEnabled $Config 'antivirus') {
        Log '[ext] antivirus (SecurityCenter2)...'
        $av = [System.Collections.ArrayList]@()
        try {
            foreach ($p in @(Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue)) {
                [void]$av.Add(@{
                    display_name  = [string]$p.displayName
                    product_state = [string]$p.productState
                    path_to_signed_product_exe = [string]$p.pathToSignedProductExe
                })
            }
        } catch { }
        try {
            foreach ($p in @(Get-CimInstance -Namespace root\SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue)) {
                [void]$av.Add(@{
                    kind = 'firewall'
                    display_name = [string]$p.displayName
                    product_state = [string]$p.productState
                })
            }
        } catch { }
        if ($av.Count -gt 0) { $out.antivirus = @($av.ToArray()) }
    }

    return $out
}
