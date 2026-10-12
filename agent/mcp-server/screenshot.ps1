# Captures the main window of a process to a PNG file.
# PrintWindow with PW_RENDERFULLCONTENT also captures DirectX/BGFX content, and works when the
# window is covered by others (not when minimized). Kept ASCII only: Windows PowerShell reads
# BOM-less scripts with the ANSI code page.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$MaxWidth = 1280
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win32Capture {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

$proc = Get-Process -Id $ProcessId
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "process $ProcessId has no main window (still loading?)" }
if ([Win32Capture]::IsIconic($hwnd)) { throw "the VPX window is minimized" }

$rect = New-Object Win32Capture+RECT
[void][Win32Capture]::GetClientRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "the window has an empty client area" }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $hdc = $graphics.GetHdc()
    # 1 = PW_CLIENTONLY, 2 = PW_RENDERFULLCONTENT
    $ok = [Win32Capture]::PrintWindow($hwnd, $hdc, 3)
    $graphics.ReleaseHdc($hdc)
    if (-not $ok) { throw "PrintWindow failed" }
    $out = $bitmap
    if ($width -gt $MaxWidth) {
        # Downscale so the image stays small enough for a model to look at
        $scale = $MaxWidth / $width
        $out = New-Object System.Drawing.Bitmap ([int]($width * $scale)), ([int]($height * $scale))
        $g2 = [System.Drawing.Graphics]::FromImage($out)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.DrawImage($bitmap, 0, 0, $out.Width, $out.Height)
        $g2.Dispose()
    }
    $out.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "$($out.Width)x$($out.Height)"
    if ($out -ne $bitmap) { $out.Dispose() }
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
