[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerUrl,
    [string]$AgentToken = $env:CORAX_AGENT_TOKEN,
    [string]$Executable,
    [string]$OutputDirectory,
    [ValidateSet("full", "custom")]
    [string]$Profile = "full"
)

$ErrorActionPreference = "Stop"
if (-not $Executable) {
    $Executable = Join-Path $PSScriptRoot "dist\windows\CORAX-Agent.exe"
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot "dist\portable"
}
if ($ServerUrl -notmatch '^https?://') { throw "ServerUrl must start with http:// or https://" }
if (-not $AgentToken) { throw "Pass -AgentToken or set CORAX_AGENT_TOKEN for this process." }
if (-not (Test-Path $Executable)) { throw "Executable not found: $Executable" }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("corax-agent-" + [Guid]::NewGuid().ToString("N"))
$bundle = Join-Path $OutputDirectory "CORAX-Agent-portable.zip"
New-Item -ItemType Directory -Force -Path $work, $OutputDirectory | Out-Null

try {
    Copy-Item $Executable (Join-Path $work "CORAX-Agent.exe")
    @{
        schema_version = 1
        server_url = $ServerUrl.TrimEnd("/")
        agent_version = "5.0.0"
        profile = $Profile
        silent = $false
    } | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $work "agent.json")

    # One-time bootstrap only. On first launch the native agent writes
    # agent.cred using DPAPI LocalMachine and removes this file.
    @{
        schema_version = 1
        agent_token = $AgentToken
    } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $work "agent.provision.json")

    Copy-Item (Join-Path $PSScriptRoot "cpp\portable\Run CORAX Agent.cmd") $work
    Copy-Item (Join-Path $PSScriptRoot "cpp\portable\Install scheduled task.cmd") $work
    Copy-Item (Join-Path $PSScriptRoot "cpp\portable\Install-CORAXScheduledTask.ps1") $work
    Copy-Item (Join-Path $PSScriptRoot "cpp\portable\README.txt") $work

    $sha = (Get-FileHash -Algorithm SHA256 (Join-Path $work "CORAX-Agent.exe")).Hash
    "$sha  CORAX-Agent.exe" | Set-Content -Encoding ASCII (Join-Path $work "SHA256SUMS.txt")

    if (Test-Path $bundle) { Remove-Item -Force $bundle }
    Compress-Archive -Path (Join-Path $work "*") -DestinationPath $bundle -CompressionLevel Optimal
    Write-Host "Portable bundle created: $bundle"
    Write-Host "The token is not printed. Keep this ZIP private."
} finally {
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
}
