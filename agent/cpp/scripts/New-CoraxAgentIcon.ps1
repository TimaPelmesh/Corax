param(
    [Parameter(Mandatory = $false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
if (-not $OutputPath) {
    $OutputPath = Join-Path $PSScriptRoot "..\assets\corax-agent.ico"
}
Add-Type -AssemblyName System.Drawing

if (-not ("BirdCutout" -as [type])) {
    $savedLib = $env:LIB
    $env:LIB = $null
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BirdCutout {
  public static Bitmap Cut(string path) {
    using (var source = new Bitmap(path)) {
      var bmp = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.DrawImage(source, 0, 0, source.Width, source.Height);
      }
      var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
      var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      int bytes = Math.Abs(data.Stride) * bmp.Height;
      byte[] raw = new byte[bytes];
      Marshal.Copy(data.Scan0, raw, 0, bytes);
      for (int i = 0; i < raw.Length; i += 4) {
        byte b = raw[i], gch = raw[i + 1], r = raw[i + 2];
        raw[i + 3] = (byte)((r < 28 && gch < 28 && b < 36) ? 0 : 255);
      }
      Marshal.Copy(raw, 0, data.Scan0, bytes);
      bmp.UnlockBits(data);
      return bmp;
    }
  }
}
"@
    if ($null -ne $savedLib) { $env:LIB = $savedLib }
}

function New-BirdBitmap {
    param([string]$LogoPath)
    return [BirdCutout]::Cut($LogoPath)
}

function New-IconFrame {
    param(
        [int]$Size,
        [System.Drawing.Bitmap]$Bird
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $scale = $Size / 256.0
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc((16 * $scale), (16 * $scale), (44 * $scale), (44 * $scale), 180, 90)
    $tile.AddArc((196 * $scale), (16 * $scale), (44 * $scale), (44 * $scale), 270, 90)
    $tile.AddArc((196 * $scale), (196 * $scale), (44 * $scale), (44 * $scale), 0, 90)
    $tile.AddArc((16 * $scale), (196 * $scale), (44 * $scale), (44 * $scale), 90, 90)
    $tile.CloseFigure()
    $graphics.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 248, 250, 252))), $tile)

    $pad = 28 * $scale
    $side = $Size - (2 * $pad)
    $graphics.SetClip($tile)
    $graphics.DrawImage($Bird, $pad, $pad, $side, $side)
    $graphics.ResetClip()

    if ($Size -ge 32) {
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 191, 219, 254), [Math]::Max(1.0, 2.0 * $scale))
        $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
        $graphics.DrawPath($pen, $tile)
        $pen.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()

    $stream.Dispose()
    $tile.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    return $bytes
}

$logoPath = Join-Path $PSScriptRoot "..\..\..\frontend\public\logo.png"
if (-not (Test-Path -LiteralPath $logoPath)) {
    throw "Login bird was not found: $logoPath"
}
$bird = New-BirdBitmap -LogoPath (Resolve-Path -LiteralPath $logoPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $frames += ,@($size, (New-IconFrame -Size $size -Bird $bird))
}
$bird.Dispose()

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
