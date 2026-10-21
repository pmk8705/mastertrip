param([string]$Icon, [string]$Out)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Icon)
$b = [System.Drawing.Bitmap]::new($src)
$mx = $b.Width - 1; $my = $b.Height - 1
foreach ($p in @(@(0, 0), @($mx, 0), @(0, $my), @($mx, $my))) {
  $c = $b.GetPixel($p[0], $p[1]); "corner ($($p[0]),$($p[1])): R=$($c.R) G=$($c.G) B=$($c.B)"
}

# Preview: circle mask (Android), rounded square (iOS/Android), and real home-screen size
$W = 560; $H = 220
$canvas = [System.Drawing.Bitmap]::new($W, $H)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'
$g.Clear([System.Drawing.Color]::FromArgb(40, 40, 46))

function Draw-Clipped($g, $img, [int]$x, [int]$y, [int]$s, [string]$shape) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  if ($shape -eq 'circle') { $path.AddEllipse($x, $y, $s, $s) }
  else {
    $r = [int]($s * 0.45)
    $path.AddArc($x, $y, $r, $r, 180, 90); $path.AddArc($x + $s - $r, $y, $r, $r, 270, 90)
    $path.AddArc($x + $s - $r, $y + $s - $r, $r, $r, 0, 90); $path.AddArc($x, $y + $s - $r, $r, $r, 90, 90)
    $path.CloseFigure()
  }
  $g.SetClip($path)
  $g.DrawImage($img, $x, $y, $s, $s)
  $g.ResetClip()
}

Draw-Clipped $g $src 20 20 180 'circle'
Draw-Clipped $g $src 220 20 180 'squircle'
Draw-Clipped $g $src 440 40 56 'circle'
Draw-Clipped $g $src 440 120 48 'squircle'
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $canvas.Dispose(); $b.Dispose(); $src.Dispose()
"preview saved"
