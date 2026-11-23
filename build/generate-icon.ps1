Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)

function New-RoundedRectPath {
    param([float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
    $d = $r * 2
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc($x, $y, $d, $d, 180, 90)
    $gp.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $gp.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $gp.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    return $gp
}

function Render-IconPngBytes {
    param([int]$size)
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 256.0
    $g.ScaleTransform($s, $s)

    # Background squircle
    $bgPath = New-RoundedRectPath 8 8 240 240 56
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF(256, 256)),
        [System.Drawing.Color]::FromArgb(255, 22, 32, 50),
        [System.Drawing.Color]::FromArgb(255, 9, 13, 20)
    )
    $g.FillPath($bgBrush, $bgPath)

    $rimBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF(256, 256)),
        [System.Drawing.Color]::FromArgb(165, 56, 189, 248),
        [System.Drawing.Color]::FromArgb(60, 37, 99, 235)
    )
    $rimPen = New-Object System.Drawing.Pen($rimBrush, 5.5)
    $g.DrawPath($rimPen, $bgPath)

    # Sculpted cloud silhouette using overlapping circles + base rect
    $cloudBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(40, 62)),
        (New-Object System.Drawing.PointF(216, 180)),
        [System.Drawing.Color]::FromArgb(255, 103, 232, 249),
        [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    )
    $g.FillEllipse($cloudBrush, 42, 108, 68, 68)
    $g.FillEllipse($cloudBrush, 74, 62, 106, 106)
    $g.FillEllipse($cloudBrush, 144, 100, 72, 76)
    $g.FillRectangle($cloudBrush, 74, 132, 106, 44)

    # Bidirectional arrows cut-out inside cloud
    $arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 11, 15, 24), 11.5)
    $arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $arrowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # Top arrow ->
    $g.DrawLine($arrowPen, 96, 121, 154, 121)
    $g.DrawLine($arrowPen, 140, 107, 154, 121)
    $g.DrawLine($arrowPen, 140, 135, 154, 121)

    # Bottom arrow <-
    $g.DrawLine($arrowPen, 160, 149, 102, 149)
    $g.DrawLine($arrowPen, 116, 135, 102, 149)
    $g.DrawLine($arrowPen, 116, 163, 102, 149)

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()

    $ms.Dispose()
    $arrowPen.Dispose()
    $cloudBrush.Dispose()
    $rimPen.Dispose()
    $rimBrush.Dispose()
    $bgBrush.Dispose()
    $bgPath.Dispose()
    $g.Dispose()
    $bmp.Dispose()
    return ,$bytes
}

$pngList = @()
foreach ($sz in $sizes) {
    $bytes = Render-IconPngBytes -size $sz
    $pngList += ,@($sz, $bytes)
    if ($sz -eq 256) {
        [System.IO.File]::WriteAllBytes((Join-Path $here 'icon.png'), $bytes)
    }
}

# Build multi-resolution ICO file
$icoStream = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($icoStream)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$pngList.Count)

$offset = 6 + (16 * $pngList.Count)
foreach ($entry in $pngList) {
    $sz = [int]$entry[0]
    $bytes = [byte[]]$entry[1]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($entry in $pngList) {
    $bw.Write([byte[]]$entry[1])
}
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $here 'icon.ico'), $icoStream.ToArray())
$bw.Dispose()
$icoStream.Dispose()

Write-Output "Generated build/icon.ico and build/icon.png ($($sizes -join ', '))"
