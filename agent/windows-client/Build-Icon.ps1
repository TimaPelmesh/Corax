# Draws Assets\corax.ico — rounded night tile and a C stroke. Windows 10/11.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$assets = Join-Path $root "Assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-Mark([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 7, 11, 18))
    $radius = [Math]::Max(2, [int]($size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Point 0, 0),
        (New-Object System.Drawing.Point $size, $size),
        ([System.Drawing.Color]::FromArgb(255, 37, 99, 235)),
        ([System.Drawing.Color]::FromArgb(255, 147, 197, 253))
    )
    $g.FillPath($brush, $path)
    $penWidth = [Math]::Max(2, $size * 0.11)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 244, 244, 245)), ([single]$penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $inset = $size * 0.30
    $g.DrawArc($pen, $inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset), 40, 280)
    $g.Dispose()
    $brush.Dispose()
    $pen.Dispose()
    $path.Dispose()
    return $bmp
}

function Get-IconImage([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width
    $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $raw = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    } finally {
        $bmp.UnlockBits($data)
    }
    $xor = New-Object System.Collections.Generic.List[byte]
    for ($y = $h - 1; $y -ge 0; $y--) {
        $row = $y * $stride
        for ($x = 0; $x -lt $w; $x++) {
            $i = $row + ($x * 4)
            $xor.Add($raw[$i])
            $xor.Add($raw[$i + 1])
            $xor.Add($raw[$i + 2])
            $xor.Add($raw[$i + 3])
        }
    }
    $maskStride = [int]([Math]::Ceiling($w / 32.0) * 4)
    $and = New-Object byte[] ($maskStride * $h)
    $header = New-Object byte[] 40
    [BitConverter]::GetBytes([int]40).CopyTo($header, 0)
    [BitConverter]::GetBytes([int]$w).CopyTo($header, 4)
    [BitConverter]::GetBytes([int]($h * 2)).CopyTo($header, 8)
    [BitConverter]::GetBytes([int16]1).CopyTo($header, 12)
    [BitConverter]::GetBytes([int16]32).CopyTo($header, 14)
    $image = New-Object byte[] ($header.Length + $xor.Count + $and.Length)
    [Array]::Copy($header, 0, $image, 0, 40)
    [byte[]]$xorBytes = $xor.ToArray()
    [Array]::Copy($xorBytes, 0, $image, 40, $xorBytes.Length)
    [Array]::Copy($and, 0, $image, 40 + $xorBytes.Length, $and.Length)
    return $image
}

$sizes = 16, 32, 48, 64, 256
$images = @()
foreach ($size in $sizes) {
    $mark = New-Mark $size
    try { $images += ,(Get-IconImage $mark) } finally { $mark.Dispose() }
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$images.Count)
$offset = 6 + (16 * $images.Count)
for ($n = 0; $n -lt $images.Count; $n++) {
    $dim = $sizes[$n]
    $bw.Write([byte]($(if ($dim -ge 256) { 0 } else { $dim })))
    $bw.Write([byte]($(if ($dim -ge 256) { 0 } else { $dim })))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$images[$n].Length)
    $bw.Write([uint32]$offset)
    $offset += $images[$n].Length
}
foreach ($image in $images) { $bw.Write($image, 0, $image.Length) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assets "corax.ico"), $ms.ToArray())
$bw.Dispose()
Write-Output "Wrote Assets\corax.ico"
