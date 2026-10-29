# 抓取指定进程的 Tauri 窗口**自身内容**（用 PrintWindow，不怕被别的窗口挡住）
# 用法：
#   powershell -File tools\capture-window.ps1 -OutFile D:\...\shot.png
#   powershell -File tools\capture-window.ps1 -TitleLike 东方摩耶堂 -OutFile D:\...\shot.png
# 说明：verify-ui.ps1 走的是 CopyFromScreen（抓屏幕），窗口被压住时会抓到别人的画面；
#       本脚本用 PW_RENDERFULLCONTENT 让窗口自己渲染，适合无人值守地验证界面。
param(
  [string]$ProcessName = 'notes-app',
  [string]$TitleLike = '',
  [string]$OutFile = 'D:\东方摩耶堂\notes-app\capture.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MoyeCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string ClassOf(IntPtr h) { StringBuilder s = new StringBuilder(128); GetClassNameW(h, s, 128); return s.ToString(); }
  public static string TitleOf(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }

  public static IntPtr Find(uint pid, string titleLike) {
    IntPtr best = IntPtr.Zero;
    int bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      if (ClassOf(h) != "Tauri Window") return true;
      if (titleLike.Length > 0 && TitleOf(h).IndexOf(titleLike, StringComparison.Ordinal) < 0) return true;
      RECT r;
      GetWindowRect(h, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

[void][MoyeCap]::SetProcessDPIAware()

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw "进程不存在：$ProcessName" }

$hwnd = [MoyeCap]::Find([uint32]$proc.Id, $TitleLike)
if ($hwnd -eq [IntPtr]::Zero) { throw "找不到 Tauri 窗口（进程 $ProcessName，标题含 '$TitleLike'）" }

$rect = New-Object MoyeCap+RECT
[void][MoyeCap]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Host ("窗口: pid={0} 标题='{1}' 尺寸={2}x{3}" -f $proc.Id, [MoyeCap]::TitleOf($hwnd), $width, $height)

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# 2 = PW_RENDERFULLCONTENT（WebView2 这类分层窗口必须用它，否则抓到黑图/空图）
$ok = [MoyeCap]::PrintWindow($hwnd, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if (-not $ok) { Write-Warning "PrintWindow 返回 false，图可能是空的" }
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Host ("已截图 -> {0}" -f $OutFile)
