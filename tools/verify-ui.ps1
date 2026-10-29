# 真实窗口自检（开发期用）：定位 Tauri 主窗口 -> 可选在客户区坐标点一下 -> 截图
# 用法：
#   powershell -File tools\verify-ui.ps1 -OutFile D:\...\shot.png
#   powershell -File tools\verify-ui.ps1 -ClickX 110 -ClickY 269 -OutFile D:\...\shot.png
# 说明：只按「Tauri Window」类 + 可见 + 面积最大挑窗口，避免误抓 single-instance 的隐藏窗口。
param(
  [string]$ProcessName = 'notes-app',
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [int]$WaitMs = 1500,
  [string]$OutFile = 'D:\东方摩耶堂\notes-app\verify-ui.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MoyeUi {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  // 找出该进程里面积最大的可见「Tauri Window」
  public static IntPtr FindTauriWindow(uint pid) {
    IntPtr best = IntPtr.Zero;
    int bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(128);
      GetClassNameW(h, cls, 128);
      if (cls.ToString() != "Tauri Window") return true;
      RECT r;
      GetWindowRect(h, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static int[] WindowRect(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  public static int[] ClientOrigin(IntPtr h) {
    POINT p; p.X = 0; p.Y = 0;
    ClientToScreen(h, ref p);
    return new int[] { p.X, p.Y };
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(250);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);   // LEFTDOWN
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);   // LEFTUP
  }
}
"@

[void][MoyeUi]::SetProcessDPIAware()   # 必须在量坐标前调用：否则 125% 缩放下 GDI 截图会整体偏移
$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw "进程不存在：$ProcessName" }

$hwnd = [MoyeUi]::FindTauriWindow([uint32]$proc.Id)
if ($hwnd -eq [IntPtr]::Zero) { throw "找不到 Tauri 主窗口（进程 $ProcessName）" }

[void][MoyeUi]::ShowWindow($hwnd, 9)   # SW_RESTORE：窗口可能被最小化，先还原再量尺寸
[void][MoyeUi]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 1200

$rect = [MoyeUi]::WindowRect($hwnd)
$origin = [MoyeUi]::ClientOrigin($hwnd)
Write-Host ("窗口: 位置=({0},{1}) 尺寸={2}x{3} 客户区原点=({4},{5})" -f $rect[0], $rect[1], $rect[2], $rect[3], $origin[0], $origin[1])

if ($ClickX -ge 0 -and $ClickY -ge 0) {
  $screenX = $origin[0] + $ClickX
  $screenY = $origin[1] + $ClickY
  Write-Host ("点击客户区 ({0},{1}) -> 屏幕 ({2},{3})" -f $ClickX, $ClickY, $screenX, $screenY)
  [MoyeUi]::Click($screenX, $screenY)      # 第一次点击常常只用于把窗口激活，会被系统吃掉
  Start-Sleep -Milliseconds 400
  [MoyeUi]::Click($screenX, $screenY)      # 第二次才真正落到按钮上
  Start-Sleep -Milliseconds $WaitMs
}

$rect = [MoyeUi]::WindowRect($hwnd)
$bitmap = New-Object System.Drawing.Bitmap($rect[2], $rect[3])
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect[0], $rect[1], 0, 0, (New-Object System.Drawing.Size($rect[2], $rect[3])))
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Host ("已截图 {0}x{1} -> {2}" -f $rect[2], $rect[3], $OutFile)
