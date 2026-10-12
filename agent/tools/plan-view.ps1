# Renders the shape list written by plan-view.mjs to a PNG. Kept ASCII only: Windows PowerShell
# reads BOM-less scripts with the ANSI code page.
param(
    [Parameter(Mandatory = $true)][string]$InFile,
    [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$spec = Get-Content -Raw -Path $InFile | ConvertFrom-Json
$s = [double]$spec.scale
$margin = 10
$w = [int]([double]$spec.width * $s) + 2 * $margin
$h = [int]([double]$spec.height * $s) + 2 * $margin

function Color([string]$hex) {
    $r = [Convert]::ToInt32($hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(5, 2), 16)
    $a = if ($hex.Length -ge 9) { [Convert]::ToInt32($hex.Substring(7, 2), 16) } else { 255 }
    return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}
function Pt($p) { return New-Object System.Drawing.PointF ([float]($margin + [double]$p[0] * $s)), ([float]($margin + [double]$p[1] * $s)) }

$bitmap = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.Clear([System.Drawing.Color]::White)
    foreach ($sh in $spec.shapes) {
        $color = Color $sh.color
        $width = if ($sh.width) { [float]$sh.width } else { 1.0 }
        $pen = New-Object System.Drawing.Pen $color, $width
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        if ($sh.dash) { $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash }
        try {
            $pts = @($sh.pts | ForEach-Object { Pt $_ })
            switch ($sh.kind) {
                'line' { if ($pts.Count -ge 2) { $g.DrawLines($pen, [System.Drawing.PointF[]]$pts) } }
                'poly' {
                    if ($pts.Count -ge 2) {
                        if ($sh.closed) {
                            if ($sh.fill) {
                                $brush = New-Object System.Drawing.SolidBrush (Color $sh.fill)
                                $g.FillPolygon($brush, [System.Drawing.PointF[]]$pts)
                                $brush.Dispose()
                            }
                            $g.DrawPolygon($pen, [System.Drawing.PointF[]]$pts)
                        } else { $g.DrawLines($pen, [System.Drawing.PointF[]]$pts) }
                    }
                }
                'circle' {
                    $r = [float]([double]$sh.r * $s)
                    $c = $pts[0]
                    $g.DrawEllipse($pen, $c.X - $r, $c.Y - $r, 2 * $r, 2 * $r)
                }
                'text' {
                    $size = if ($sh.size) { [float]$sh.size } else { 9.0 }
                    $font = New-Object System.Drawing.Font 'Segoe UI', $size
                    $brush = New-Object System.Drawing.SolidBrush $color
                    $g.DrawString([string]$sh.text, $font, $brush, $pts[0])
                    $brush.Dispose(); $font.Dispose()
                }
            }
        } finally { $pen.Dispose() }
    }
    $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bitmap.Dispose()
}
