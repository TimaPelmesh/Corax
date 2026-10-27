[CmdletBinding(DefaultParameterSetName = "Store")]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(ParameterSetName = "Store")]
    [string]$CertificateThumbprint = $env:CORAX_SIGN_CERT_THUMBPRINT,

    [Parameter(ParameterSetName = "Pfx")]
    [string]$PfxPath = $env:CORAX_SIGN_PFX,

    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Resolve-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path $kits) {
        $found = Get-ChildItem $kits -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    throw "signtool.exe not found. Install Windows 10/11 SDK."
}

if (-not (Test-Path $Path)) { throw "File not found: $Path" }
$signtool = Resolve-SignTool

if ($PSCmdlet.ParameterSetName -eq "Pfx" -or $PfxPath) {
    if (-not $PfxPath -or -not (Test-Path $PfxPath)) {
        throw "Set -PfxPath or CORAX_SIGN_PFX."
    }
    $password = $env:CORAX_SIGN_PFX_PASSWORD
    if (-not $password) {
        throw "Set CORAX_SIGN_PFX_PASSWORD for the current process. It is never stored by this script."
    }
    & $signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $PfxPath /p $password $Path
} else {
    if (-not $CertificateThumbprint) {
        throw "Set -CertificateThumbprint or CORAX_SIGN_CERT_THUMBPRINT."
    }
    & $signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /sha1 $CertificateThumbprint $Path
}
if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed ($LASTEXITCODE)" }

& $signtool verify /pa /all /v $Path
if ($LASTEXITCODE -ne 0) { throw "Signature verification failed ($LASTEXITCODE)" }
Write-Host "Signed and timestamped: $Path"
