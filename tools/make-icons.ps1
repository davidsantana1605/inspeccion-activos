# Generates PNG icons with System.Drawing (Windows PowerShell 5.1). Run from repo root:
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# $mode: any (rounded square, transparent corners) | full (full-bleed background: maskable / apple)
function New-Icon([int]$size, [string]$mode, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $navy = [System.Drawing.Color]::FromArgb(255, 30, 58, 95)
  $white = [System.Drawing.Color]::White
  $amber = [System.Drawing.Color]::FromArgb(255, 245, 166, 35)
  if ($mode -eq 'any') {
    $bg = New-RoundedPath 0 0 $size $size ($size * 0.22)
    $g.FillPath((New-Object System.Drawing.SolidBrush $navy), $bg)
    $scale = 0.62
  } else {
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $navy), 0, 0, $size, $size)
    $scale = 0.50   # glyph stays inside the central ~80% safe zone
  }
  $gw = $size * $scale
  $gx = ($size - $gw) / 2
  $gy = ($size - $gw * 1.15) / 2
  $gh = $gw * 1.15
  # clipboard body
  $body = New-RoundedPath $gx ($gy + $gh * 0.08) $gw ($gh * 0.92) ($gw * 0.08)
  $g.FillPath((New-Object System.Drawing.SolidBrush $white), $body)
  # clip tab
  $tab = New-RoundedPath ($gx + $gw * 0.3) $gy ($gw * 0.4) ($gh * 0.16) ($gw * 0.04)
  $g.FillPath((New-Object System.Drawing.SolidBrush $amber), $tab)
  # check mark
  $pen = New-Object System.Drawing.Pen $navy, ([float]($gw * 0.1))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $pts = @(
    (New-Object System.Drawing.PointF ($gx + $gw * 0.22), ($gy + $gh * 0.58)),
    (New-Object System.Drawing.PointF ($gx + $gw * 0.43), ($gy + $gh * 0.76)),
    (New-Object System.Drawing.PointF ($gx + $gw * 0.78), ($gy + $gh * 0.40))
  )
  $g.DrawLines($pen, $pts)
  $g.Dispose()
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon 192 'any' 'icon-192.png'
New-Icon 512 'any' 'icon-512.png'
New-Icon 192 'full' 'maskable-192.png'
New-Icon 512 'full' 'maskable-512.png'
New-Icon 180 'full' 'apple-touch-icon.png'
Get-ChildItem $out | Select-Object Name, Length
