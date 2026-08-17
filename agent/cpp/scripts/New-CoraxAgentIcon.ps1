param(
    [Parameter(Mandatory = $false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
if (-not $OutputPath) {
    $OutputPath = Join-Path $PSScriptRoot "..\assets\corax-agent.ico"
}
Add-Type -AssemblyName System.Drawing

function New-IconFrame {
    param([int]$Size)

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $scale = $Size / 256.0
    function Pt([float]$x, [float]$y) {
        return New-Object System.Drawing.PointF(($x * $scale), ($y * $scale))
    }

    $navy = [System.Drawing.Color]::FromArgb(255, 11, 18, 32)
    $blue = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    $blueLight = [System.Drawing.Color]::FromArgb(255, 147, 197, 253)
    $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

    # A simple rounded tile remains clear on both light and dark desktops.
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc((20 * $scale), (20 * $scale), (48 * $scale), (48 * $scale), 180, 90)
    $tile.AddArc((188 * $scale), (20 * $scale), (48 * $scale), (48 * $scale), 270, 90)
    $tile.AddArc((188 * $scale), (188 * $scale), (48 * $scale), (48 * $scale), 0, 90)
    $tile.AddArc((20 * $scale), (188 * $scale), (48 * $scale), (48 * $scale), 90, 90)
    $tile.CloseFigure()
    $graphics.FillPath((New-Object System.Drawing.SolidBrush($navy)), $tile)

    # Angular CORAX “C”, aligned with the web application favicon.
    $mark = New-Object System.Drawing.Drawing2D.GraphicsPath
    $mark.AddPolygon([System.Drawing.PointF[]]@(
        (Pt 80 57), (Pt 172 57), (Pt 202 87), (Pt 174 115),
        (Pt 111 115), (Pt 111 141), (Pt 174 141), (Pt 202 169),
        (Pt 172 199), (Pt 80 199), (Pt 51 170), (Pt 51 86)
    ))
    $graphics.FillPath((New-Object System.Drawing.SolidBrush($blue)), $mark)

    # Small light facet gives the mark depth without hurting 16px readability.
    $facet = New-Object System.Drawing.Drawing2D.GraphicsPath
    $facet.AddPolygon([System.Drawing.PointF[]]@(
        (Pt 80 57), (Pt 172 57), (Pt 187 72), (Pt 72 90), (Pt 51 86)
    ))
    $graphics.FillPath((New-Object System.Drawing.SolidBrush($blueLight)), $facet)

    if ($Size -ge 32) {
        $pen = New-Object System.Drawing.Pen($white, [Math]::Max(1.0, 2.0 * $scale))
        $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
        $graphics.DrawPath($pen, $tile)
        $pen.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()

    $stream.Dispose()
    $tile.Dispose()
    $mark.Dispose()
    $facet.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    return $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $frames += ,@($size, (New-IconFrame -Size $size))
}

$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$file = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($file)
try {
    $writer.Write([UInt16]0)                 # reserved
    $writer.Write([UInt16]1)                 # icon
    $writer.Write([UInt16]$frames.Count)
    $offset = 6 + (16 * $frames.Count)
    foreach ($frame in $frames) {
        $size = [int]$frame[0]
        $bytes = [byte[]]$frame[1]
        $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $bytes.Length
    }
    foreach ($frame in $frames) {
        $writer.Write([byte[]]$frame[1])
    }
} finally {
    $writer.Dispose()
    $file.Dispose()
}

Write-Host "CORAX icon generated: $OutputPath"
