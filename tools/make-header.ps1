param(
  [string]$Src = (Join-Path $PSScriptRoot 'header-source.jpg'),
  [string]$Out = (Join-Path $PSScriptRoot '..\img\header.jpg'),
  [int]$Width = 0  # 0 = keep the source width (never upscale a small source)
)
# Note: PowerShell variable names ignore case, so $src/$Src or $out/$Out would collide.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-header.ps1
# Turns the Gemini banner into img/header.jpg: paints over the Gemini sparkle watermark
# (bottom-right) with sea copied from just left of it, then resizes to $Width px wide.
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Drawing

$stream = [IO.File]::OpenRead($Src)
$frame = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'PreservePixelFormat', 'OnLoad').Frames[0]
$stream.Close()
$conv = [System.Windows.Media.Imaging.FormatConvertedBitmap]::new($frame, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
$enc = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
$enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($conv))
$ms = [IO.MemoryStream]::new()
$enc.Save($ms)
$bmp = [System.Drawing.Bitmap]::new($ms)
$imgW = $bmp.Width; $imgH = $bmp.Height
"source: ${imgW}x${imgH}"

# Watermark box (relative to the image, measured on the 1792x592 original)
$box = [System.Drawing.Rectangle]::new([int]($imgW * 0.905), [int]($imgH * 0.72), [int]($imgW * 0.06), [int]($imgH * 0.16))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'
$from = [System.Drawing.Rectangle]::new($box.X - [int]($box.Width * 1.3), $box.Y, $box.Width, $box.Height)
$patch = $bmp.Clone($from, $bmp.PixelFormat)
$g.DrawImage($patch, $box)
$g.Dispose()

if ($Width -le 0 -or $Width -gt $imgW) { $Width = $imgW }
$newH = [int]([double]$imgH * $Width / $imgW)
$resized = [System.Drawing.Bitmap]::new($Width, $newH)
$g2 = [System.Drawing.Graphics]::FromImage($resized)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.PixelOffsetMode = 'HighQuality'
$g2.DrawImage($bmp, 0, 0, $Width, $newH)
$g2.Dispose()

$jpg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = [System.Drawing.Imaging.EncoderParameters]::new(1)
$ep.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long]86)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$resized.Save([IO.Path]::GetFullPath($Out), $jpg, $ep)
"saved: ${Width}x${newH} -> $Out ($((Get-Item $Out).Length) bytes)"
