[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Path)) { throw "File not found: $Path" }

$item = Get-Item $Path
$version = $item.VersionInfo
$hash = Get-FileHash -Algorithm SHA256 $Path
$signature = Get-AuthenticodeSignature $Path

if ($item.Length -lt 50000) { throw "PE file is unexpectedly small: $($item.Length) bytes." }
if ($version.ProductName -ne "CORAX Agent") { throw "Missing CORAX ProductName version resource." }
if (-not $version.FileVersion) { throw "Missing FileVersion resource." }
if ($RequireSignature -and $signature.Status -ne "Valid") {
    throw "Authenticode signature is required but status is $($signature.Status)."
}

Write-Host "CORAX Agent verification"
Write-Host "  File:      $($item.FullName)"
Write-Host "  Size:      $($item.Length) bytes"
Write-Host "  Version:   $($version.FileVersion)"
Write-Host "  SHA-256:   $($hash.Hash)"
Write-Host "  Signature: $($signature.Status)"
if ($signature.SignerCertificate) {
    Write-Host "  Publisher: $($signature.SignerCertificate.Subject)"
}
