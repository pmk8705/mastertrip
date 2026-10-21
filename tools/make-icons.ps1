param(
  [string]$Src = (Join-Path $PSScriptRoot 'icon-source.webp'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\icons'),
  [string]$WorkDir = $env:TEMP,
  [double]$InsetRatio = 0.06,  # crop away the rounded corners drawn into the source art
  [double]$Scale = 0.76        # maskable: artwork size inside the safe zone
)
# Usage: powershell -File tools\make-icons.ps1
# Writes icon-192/512 + apple-touch-icon (full-bleed artwork) and icon-maskable-192/512
# (artwork shrunk into the 80% safe zone, margin filled with each row's edge color).
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Drawing

# 1) Decode WebP via WIC and crop away the drawn rounded corners -> full-res PNG
$stream = [IO.File]::OpenRead($Src)
$frame = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'PreservePixelFormat', 'OnLoad').Frames[0]
$stream.Close()
$inset = [int]([Math]::Min($frame.PixelWidth, $frame.PixelHeight) * $InsetRatio)
$side = [Math]::Min($frame.PixelWidth, $frame.PixelHeight) - 2 * $inset
$crop = [System.Windows.Media.Imaging.CroppedBitmap]::new($frame, [System.Windows.Int32Rect]::new($inset, $inset, $side, $side))
$conv = [System.Windows.Media.Imaging.FormatConvertedBitmap]::new($crop, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
$enc = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
$enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($conv))
$masterPath = Join-Path $WorkDir 'master-crop.png'
$fs = [IO.File]::Create($masterPath); $enc.Save($fs); $fs.Close()

# 2) Fast pixel work in C#
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class IconTools {
    static Bitmap Resize(Image src, int w, int h) {
        var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(b)) {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            using (var ia = new ImageAttributes()) {
                ia.SetWrapMode(WrapMode.TileFlipXY); // avoid dark fringes at edges
                g.DrawImage(src, new Rectangle(0, 0, w, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
            }
        }
        return b;
    }

    static int[] Read(Bitmap b) {
        var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var px = new int[b.Width * b.Height];
        Marshal.Copy(d.Scan0, px, 0, px.Length);
        b.UnlockBits(d);
        return px;
    }

    static Bitmap Write(int[] px, int w, int h) {
        var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(px, 0, d.Scan0, px.Length);
        b.UnlockBits(d);
        return b;
    }

    // Separable box blur, repeated 3x (close to Gaussian), clamped edges.
    static int[] Blur(int[] src, int w, int h, int r) {
        var a = (int[])src.Clone();
        var t = new int[a.Length];
        for (int pass = 0; pass < 3; pass++) {
            BoxH(a, t, w, h, r);
            BoxV(t, a, w, h, r);
        }
        return a;
    }
    static void BoxH(int[] s, int[] d, int w, int h, int r) {
        for (int y = 0; y < h; y++) {
            long sr = 0, sg = 0, sb = 0; int row = y * w; int n = 2 * r + 1;
            for (int k = -r; k <= r; k++) { int c = s[row + Math.Min(w - 1, Math.Max(0, k))]; sr += (c >> 16) & 255; sg += (c >> 8) & 255; sb += c & 255; }
            for (int x = 0; x < w; x++) {
                d[row + x] = (255 << 24) | ((int)(sr / n) << 16) | ((int)(sg / n) << 8) | (int)(sb / n);
                int cOut = s[row + Math.Max(0, x - r)], cIn = s[row + Math.Min(w - 1, x + r + 1)];
                sr += ((cIn >> 16) & 255) - ((cOut >> 16) & 255); sg += ((cIn >> 8) & 255) - ((cOut >> 8) & 255); sb += (cIn & 255) - (cOut & 255);
            }
        }
    }
    static void BoxV(int[] s, int[] d, int w, int h, int r) {
        for (int x = 0; x < w; x++) {
            long sr = 0, sg = 0, sb = 0; int n = 2 * r + 1;
            for (int k = -r; k <= r; k++) { int c = s[Math.Min(h - 1, Math.Max(0, k)) * w + x]; sr += (c >> 16) & 255; sg += (c >> 8) & 255; sb += c & 255; }
            for (int y = 0; y < h; y++) {
                d[y * w + x] = (255 << 24) | ((int)(sr / n) << 16) | ((int)(sg / n) << 8) | (int)(sb / n);
                int cOut = s[Math.Max(0, y - r) * w + x], cIn = s[Math.Min(h - 1, y + r + 1) * w + x];
                sr += ((cIn >> 16) & 255) - ((cOut >> 16) & 255); sg += ((cIn >> 8) & 255) - ((cOut >> 8) & 255); sb += (cIn & 255) - (cOut & 255);
            }
        }
    }

    public static void MakeMaskable(string srcPath, string outPath, int size, double scale, double featherRatio) {
        using (var src = Image.FromFile(srcPath)) {
            int fs = (int)Math.Round(size * scale);
            int off = (size - fs) / 2;
            int[] fg;
            using (var small = Resize(src, fs, fs)) fg = Read(small);

            // Background: the scene is layered top-to-bottom (sky, sea, foam, sand), so each output row
            // takes the per-channel median of the artwork's outermost columns at the matching height.
            // Those columns hold no boat/gull, so no ghosts; rows above/below the artwork are clamped.
            int strip = Math.Max(1, fs / 120);
            var rowColor = new int[fs];
            var rs = new int[strip * 2]; var gs = new int[strip * 2]; var bs = new int[strip * 2];
            for (int y = 0; y < fs; y++) {
                int k = 0;
                for (int x = 0; x < strip; x++) {
                    foreach (int xx in new[] { x, fs - 1 - x }) {
                        int c = fg[y * fs + xx]; rs[k] = (c >> 16) & 255; gs[k] = (c >> 8) & 255; bs[k] = c & 255; k++;
                    }
                }
                Array.Sort(rs); Array.Sort(gs); Array.Sort(bs);
                rowColor[y] = (255 << 24) | (rs[k / 2] << 16) | (gs[k / 2] << 8) | bs[k / 2];
            }
            var bg = new int[size * size];
            for (int y = 0; y < size; y++) {
                int sy = Math.Min(fs - 1, Math.Max(0, y - off));
                int c = rowColor[sy];
                for (int x = 0; x < size; x++) bg[y * size + x] = c;
            }
            bg = Blur(bg, size, size, Math.Max(1, size / 100));

            int feather = Math.Max(1, (int)(fs * featherRatio));
            var outPx = (int[])bg.Clone();
            for (int y = 0; y < fs; y++) {
                for (int x = 0; x < fs; x++) {
                    int edge = Math.Min(Math.Min(x, y), Math.Min(fs - 1 - x, fs - 1 - y));
                    double a = edge >= feather ? 1.0 : (double)edge / feather;
                    a = a * a * (3 - 2 * a); // smoothstep
                    int i = (y + off) * size + (x + off);
                    int c1 = fg[y * fs + x], c0 = bg[i];
                    int r = (int)(((c1 >> 16) & 255) * a + ((c0 >> 16) & 255) * (1 - a));
                    int g = (int)(((c1 >> 8) & 255) * a + ((c0 >> 8) & 255) * (1 - a));
                    int b = (int)((c1 & 255) * a + (c0 & 255) * (1 - a));
                    outPx[i] = (255 << 24) | (r << 16) | (g << 8) | b;
                }
            }
            using (var outBmp = Write(outPx, size, size)) outBmp.Save(outPath, ImageFormat.Png);
        }
    }

    public static void SaveResized(string srcPath, string outPath, int size) {
        using (var src = Image.FromFile(srcPath))
        using (var b = Resize(src, size, size)) b.Save(outPath, ImageFormat.Png);
    }
}
'@

New-Item -ItemType Directory -Force $OutDir | Out-Null
# Regular icons (full-bleed artwork) for iOS / desktop / non-masking launchers
[IconTools]::SaveResized($masterPath, (Join-Path $OutDir 'icon-512.png'), 512)
[IconTools]::SaveResized($masterPath, (Join-Path $OutDir 'icon-192.png'), 192)
[IconTools]::SaveResized($masterPath, (Join-Path $OutDir 'apple-touch-icon.png'), 180)
# Maskable icons for Android adaptive (circle etc.)
[IconTools]::MakeMaskable($masterPath, (Join-Path $OutDir 'icon-maskable-512.png'), 512, $Scale, 0.12)
[IconTools]::MakeMaskable($masterPath, (Join-Path $OutDir 'icon-maskable-192.png'), 192, $Scale, 0.12)
Get-ChildItem $OutDir | Select-Object Name, Length
