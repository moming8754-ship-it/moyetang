# 开发期 UI 驱动：列出窗口 / 最小化还原别人 / 点击 Tauri 窗口客户区 / 发送按键
# 存在理由：本机上 DSH 自己的 GUI 也是 "Tauri Window" 且常压在应用窗口上面，
#          verify-ui.ps1 的 SetForegroundWindow 不一定抢得过来，点击会落到别人身上。
# 用法：
#   powershell -File tools\ui-drive.ps1 -Action list
#   powershell -File tools\ui-drive.ps1 -Action minimize -Pid 1234
#   powershell -File tools\ui-drive.ps1 -Action restore  -Pid 1234
#   powershell -File tools\ui-drive.ps1 -Action click -X 49 -Y 83
#   powershell -File tools\ui-drive.ps1 -Action keys -Text "hello" -Enter
param(
  [ValidateSet('list', 'minimize', 'restore', 'click', 'keys')]
  [string]$Action = 'list',
  [string]$ProcessName = 'notes-app',
  [string]$TitleLike = '',
  [int]$TargetPid = 0,   # 不叫 $Pid：PowerShell 里 $PID 是只读内置变量
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Text = '',
  [switch]$Enter
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MoyeDrive {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public static string ClassOf(IntPtr h) { StringBuilder s = new StringBuilder(128); GetClassNameW(h, s, 128); return s.ToString(); }
  public static string TitleOf(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }

  public static IntPtr FindApp(uint pid, string titleLike) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      if (ClassOf(h) != "Tauri Window") return true;
      if (titleLike.Length > 0 && TitleOf(h).IndexOf(titleLike, StringComparison.Ordinal) < 0) return true;
      RECT r; GetWindowRect(h, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // 列出所有可见的顶层窗口（只看有标题的，省得刷屏）
  public static void List() {
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      string title = TitleOf(h);
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      Console.WriteLine(string.Format("hwnd={0} pid={1} class={2} rect=({3},{4},{5}x{6}) title={7}",
        h, pid, ClassOf(h), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, title));
      return true;
    }, IntPtr.Zero);
  }

  public static bool MinimizePid(uint pid) {
    IntPtr h = FindApp(pid, "");
    if (h == IntPtr.Zero) return false;
    return ShowWindow(h, 6); // SW_MINIMIZE
  }

  public static bool RestorePid(uint pid) {
    IntPtr h = FindApp(pid, "");
    if (h == IntPtr.Zero) return false;
    ShowWindow(h, 9); // SW_RESTORE
    return SetForegroundWindow(h);
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(250);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
"@

[void][MoyeDrive]::SetProcessDPIAware()

switch ($Action) {
  'list' {
    [MoyeDrive]::List()
  }

  'minimize' {
    if ([MoyeDrive]::MinimizePid([uint32]$TargetPid)) { Write-Host "minimized pid=$TargetPid" }
    else { Write-Warning "no window found for pid=$TargetPid" }
  }

  'restore' {
    if ([MoyeDrive]::RestorePid([uint32]$TargetPid)) { Write-Host "restored pid=$TargetPid" }
    else { Write-Warning "no window found for pid=$TargetPid" }
  }

  'click' {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $proc) { throw "process not found: $ProcessName" }
    $hwnd = [MoyeDrive]::FindApp([uint32]$proc.Id, $TitleLike)
    if ($hwnd -eq [IntPtr]::Zero) { throw "Tauri window not found for $ProcessName" }

    [void][MoyeDrive]::ShowWindow($hwnd, 9)
    [void][MoyeDrive]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400

    $origin = New-Object MoyeDrive+POINT
    $origin.X = 0; $origin.Y = 0
    [void][MoyeDrive]::ClientToScreen($hwnd, [ref]$origin)
    $screenX = $origin.X + $X
    $screenY = $origin.Y + $Y
    Write-Host ("client=({0},{1}) screen=({2},{3})" -f $X, $Y, $screenX, $screenY)

    # 第一次点击常被系统拿去激活窗口，所以要连点两次
    [MoyeDrive]::Click($screenX, $screenY)
    Start-Sleep -Milliseconds 350
    [MoyeDrive]::Click($screenX, $screenY)
    Start-Sleep -Milliseconds 600
  }

  'keys' {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $proc) { throw "process not found: $ProcessName" }
    $hwnd = [MoyeDrive]::FindApp([uint32]$proc.Id, $TitleLike)
    if ($hwnd -eq [IntPtr]::Zero) { throw "Tauri window not found for $ProcessName" }
    [void][MoyeDrive]::ShowWindow($hwnd, 9)
    [void][MoyeDrive]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 500

    $payload = $Text
    if ($Enter) { $payload = $payload + '{ENTER}' }
    [System.Windows.Forms.SendKeys]::SendWait($payload)
    Start-Sleep -Milliseconds 500
    Write-Host ("keys sent: {0}" -f $payload)
  }
}
