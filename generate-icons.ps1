Add-Type -AssemblyName System.Drawing

function New-Icon($size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'HighQuality'

    $r = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0,0)),
        (New-Object System.Drawing.PointF($size,$size)),
        [System.Drawing.Color]::FromArgb(255,88,166,255),
        [System.Drawing.Color]::FromArgb(255,31,111,235)
    )
    $g.FillRectangle($r, 0, 0, $size, $size)

    $s = $size / 512.0
    $cx = $size / 2
    $cy = $size / 2
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [Math]::Round(24 * $s))
    $pen.StartCap = 'Round'
    $pen.EndCap = 'Round'
    $pen.LineJoin = 'Round'

    $g.DrawLine($pen, $cx, $cy + 65*$s, $cx, $cy - 65*$s)
    $g.DrawLine($pen, $cx - 40*$s, $cy - 25*$s, $cx, $cy - 65*$s)
    $g.DrawLine($pen, $cx + 40*$s, $cy - 25*$s, $cx, $cy - 65*$s)

    $g.FillEllipse([System.Drawing.Brushes]::White, $cx - 10*$s, $cy + 30*$s, 20*$s, 20*$s)
    $g.FillEllipse([System.Drawing.Brushes]::White, $cx - 50*$s, $cy - 30*$s, 16*$s, 16*$s)
    $g.FillEllipse([System.Drawing.Brushes]::White, $cx + 34*$s, $cy - 30*$s, 16*$s, 16*$s)

    $g.Dispose()
    $bmp.Save("$PSScriptRoot\icon-$size.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "Generated icon-$size.png"
}

New-Icon 192
New-Icon 512
