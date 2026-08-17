[CmdletBinding()]
param(
    [ValidateSet("Release", "RelWithDebInfo", "Debug")]
    [string]$Configuration = "Release",
    [ValidateSet("x64")]
    [string]$Architecture = "x64",
    [string]$OutputDirectory,
    [switch]$Clean,
    [switch]$Sign,
    [switch]$UpdatePrebuiltTemplate
)

$ErrorActionPreference = "Stop"
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot "dist\windows"
}
$cpp = Join-Path $PSScriptRoot "cpp"
$build = Join-Path $cpp "build"

function Resolve-CMake {
    $cmd = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $found = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -find "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" |
            Select-Object -First 1
        if ($found -and (Test-Path $found)) { return $found }
    }
    throw "CMake/MSVC not found. Install Visual Studio 2022 Build Tools: Desktop development with C++ + CMake."
}

$cmake = Resolve-CMake
if ($Clean -and (Test-Path $build)) {
    Remove-Item -Recurse -Force $build
}
New-Item -ItemType Directory -Force -Path $build, $OutputDirectory | Out-Null

& (Join-Path $cpp "scripts\New-CoraxAgentIcon.ps1") `
    -OutputPath (Join-Path $cpp "assets\corax-agent.ico")

& $cmake -S $cpp -B $build -G "Visual Studio 17 2022" -A $Architecture
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed ($LASTEXITCODE)" }

& $cmake --build $build --config $Configuration --target CORAX-Agent --parallel
if ($LASTEXITCODE -ne 0) { throw "CMake build failed ($LASTEXITCODE)" }

$built = Join-Path $build "$Configuration\CORAX-Agent.exe"
if (-not (Test-Path $built)) { throw "Build completed but $built was not created." }

$target = Join-Path $OutputDirectory "CORAX-Agent.exe"
Copy-Item -Force $built $target

if ($Sign) {
    & (Join-Path $PSScriptRoot "Sign-WindowsAgent.ps1") -Path $target
}

& (Join-Path $PSScriptRoot "Verify-WindowsAgent.ps1") -Path $target
if ($UpdatePrebuiltTemplate) {
    $prebuilt = Join-Path $cpp "prebuilt\CORAX-Agent.template.exe"
    Copy-Item -Force $target $prebuilt
    Write-Host "Updated panel template: $prebuilt"
}
Write-Host "Built: $target"
