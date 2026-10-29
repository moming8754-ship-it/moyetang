# 通过 CDP（Chrome DevTools Protocol）驱动应用窗口里的网页 —— 无人值守验证界面用
#
# 为什么需要它：本机上"点窗口 + SendKeys"这条路不可靠（窗口常被别的程序压住，
# SendKeys 依赖前台焦点，实测打不进 WebView）。开 WebView2 的远程调试端口后，
# 可以直接在页面里点元素、输入文字、读文本、截图，不依赖前台焦点。
#
# 启动应用时要带上端口（否则本脚本连不上）：
#   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
#   npm run tauri dev
#
# 用法：
#   powershell -File tools\cdp.ps1 -Action list
#   powershell -File tools\cdp.ps1 -Action text
#   powershell -File tools\cdp.ps1 -Action eval  -Expr "document.title"
#   powershell -File tools\cdp.ps1 -Action click -Selector "button[type=submit]"
#   powershell -File tools\cdp.ps1 -Action type  -Selector "textarea" -Text "hello" -Enter
#   powershell -File tools\cdp.ps1 -Action shot  -OutFile D:\东方摩耶堂\notes-app\cdp.png
#   powershell -File tools\cdp.ps1 -Action mouse -Selector "[data-node-id]" -Clicks 2   # 真实双击
#   powershell -File tools\cdp.ps1 -Action mouse -Selector "from" -ToSelector "to"      # 真实拖拽
#
# ⚠️ **`-Action mouse` 是"真实输入"，`-Action click`/页面里 `el.click()` 是"合成事件"。**
# 两者不等价：合成事件绕过了浏览器的命中测试、指针捕获、焦点与默认行为。
# M4 就栽在这上面 —— 验收脚本用 `dispatchEvent(new MouseEvent('dblclick'))` 直接打在节点上，
# 一路绿灯；而用户真手双击时，事件被 `setPointerCapture` 改道到了画布容器，
# 于是"双击改文字"对用户完全失效，脚本却看不出来。
# **凡是手势类交互（双击 / 拖拽 / 长按），验收必须用 `-Action mouse` 走真实输入。**
param(
  [ValidateSet('list', 'text', 'eval', 'click', 'type', 'shot', 'mouse', 'wheel', 'targets', 'clip', 'paste')]
  [string]$Action = 'list',
  [int]$Port = 9222,
  # 多窗口时用来挑 target（按页面 title 匹配，先精确再模糊）。
  # ⚠️ 主窗和小窗 URL 完全一样（同一份前端产物），标题是小窗自己设的
  # 「东方摩耶堂 · 速记」—— 但**标题会骗人**（小窗重载的那一瞬间标题跟主窗一样、
  # 隐藏的小窗也照样是个 target）。所以关键脚本请连 `-RequireSelector` 一起用。
  [string]$TargetTitle = '',
  # ★ 更可靠的挑法：**谁的页面上真有这个元素，才算谁**。
  # 主窗传 `nav`（侧边栏），小窗传 `[data-small-body]`。
  [string]$RequireSelector = '',
  # 第几个 page target（-1 = 不按序号挑）。多窗口且 title 分不开时用它。
  [int]$TargetIndex = -1,
  [string]$Expr = '',
  # ⚠️ 多行 JS **不要**走 -Expr：`powershell -File` 会把长字符串拆得乱七八糟
  # （报 "Cannot process argument transformation on parameter 'Clicks'" 之类）。
  # 把 JS 存成文件、用 -ExprFile 交进来 —— 和 `run.ps1` 一个套路。
  # 文件放**项目目录之外**（比如 $env:TEMP），否则会惊动 vite 的 watcher。
  [string]$ExprFile = '',
  [string]$Selector = '',
  [string]$ToSelector = '',
  # ★ 拖拽落点的**坐标**（给了就不查 `-ToSelector`）。
  # 为什么需要：真实拖拽要求"两端同时在屏幕上"，而查起点的默认实现会**顺手把起点滚进视野** ——
  # 页面一滚，另一个端点可能就被挤出屏幕（实测过一次：落点算出来 y=-840，鼠标落在屏幕外，
  # 拖拽静默失败）。所以给"能自己保证两端同屏"的调用方一个直接给坐标的入口。
  [int]$ToX = -1,
  [int]$ToY = -1,
  # ★ 查 `-Selector` 时**不要** scrollIntoView（调用方自己已经滚好了）
  [switch]$NoScroll,
  [string]$Text = '',
  [int]$Clicks = 1,
  # 直接给页面坐标（CSS 像素）就跳过 -Selector —— uuid 这类"以数字开头的属性值"
  # 在 CSS 里必须加引号，而引号穿过 PowerShell 很容易被拆坏，用坐标最省事
  [int]$X = -1,
  [int]$Y = -1,
  # ★ **真实滚轮**（`-Action wheel`）：走 CDP `Input.dispatchMouseEvent type=mouseWheel`，
  #   跟用户手上那颗轮子走同一条路（合成 `WheelEvent` 会绕过浏览器输入层，是假绿灯）。
  #   `-DeltaY` 负 = 往前滚（缩放大都用负值），正 = 往后滚。`-Ctrl` = 按住 Ctrl 再滚。
  [int]$DeltaY = -120,
  [switch]$Ctrl,
  [switch]$Enter,
  # ★ **真实剪贴板**：把这张图放进系统剪贴板（配合 `-Action paste` 用真实 Ctrl+V 验"粘贴图片"）。
  # 为什么不能只在页面里合成一个 `ClipboardEvent`：那绕过浏览器的真剪贴板读取，
  # 是**假绿灯**（M4 的合成事件教训）—— 真粘贴才验得出"剪贴板里到底有没有图"。
  [string]$ClipFile = '',
  [string]$OutFile = 'D:\东方摩耶堂\notes-app\cdp.png'
)

$ErrorActionPreference = 'Stop'
$script:msgId = 0

function Get-AllPageTargets {
  param([int]$Port, [string]$TitleLike = '')
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5
  $pages = @($targets | Where-Object { $_.type -eq 'page' })
  if ($TitleLike) {
    # **先精确、再模糊**。为什么要这样：
    # 主窗 title 是「东方摩耶堂」，小窗是「东方摩耶堂 · 速记」—— 模糊匹配的话
    # `-TargetTitle '东方摩耶堂'` 会把两个都命中，取谁完全看顺序（不可靠）。
    # 精确优先之后：传全名拿主窗、传「速记」拿小窗，两边都唯一。
    $exact = @($pages | Where-Object { $_.title -eq $TitleLike })
    if ($exact.Count -gt 0) { $pages = $exact }
    else {
      # ⚠️ 降级到模糊时**取标题最短的排在前面**：主窗标题是「东方摩耶堂」，小窗是
      #    「东方摩耶堂 · 速记」（更长）。
      $pages = @($pages | Where-Object { $_.title -like "*$TitleLike*" } | Sort-Object { $_.title.Length })
    }
  }
  return , $pages
}

function Get-PageTarget {
  param([int]$Port, [string]$TitleLike = '', [int]$Index = -1, [string]$RequireSelector = '')
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5
  $pages = Get-AllPageTargets -Port $Port -TitleLike $TitleLike
  # ⚠️⚠️ **标题这东西本身就会骗人 —— 靠内容认窗口才靠谱。**
  #
  # 踩过两次（都是白跑一整轮回归）：
  #   ① 小窗 `hide()` 只是隐藏、**不销毁**，它的 webview 一直是个 page target，而且常常排第一；
  #      于是**不传 title** 的脚本（原来 `m4/m5/run.ps1` 就没传）整场跑在小窗上，
  #      每条断言都报"应用没起来：导航栏找不到"，看着像产品全崩；
  #   ② 小窗**重载的那一瞬间**，它的 title 回到 `index.html` 里的「东方摩耶堂」，
  #      和主窗**一模一样** —— 这时按 title 挑谁都不对。
  # 所以给了 `-RequireSelector`：**谁页面上真有这个元素，才算谁**。
  # 主窗传 `nav`（侧边栏），小窗传 `[data-small-body]`。
  #
  # ⚠️ 还得**重试**：`tools/` 就在 vite 的监听范围里，**改一次脚本就会让两个页面一起整页重载**，
  #    那一两秒里谁的页面上都没有元素（`readyState` 还在 loading）—— 不重试就会误报
  #    "应用是不是没起来"。所以最多等 20 秒，每 1 秒重新扫一遍候选。
  if ($RequireSelector) {
    $probe = "!!document.querySelector('" + $RequireSelector.Replace("'", "\'") + "')"
    $deadline = (Get-Date).AddSeconds(20)
    $hit = @()
    $lastSeen = @()
    while ($true) {
      $fresh = Get-AllPageTargets -Port $Port -TitleLike $TitleLike
      $lastSeen = @($fresh | ForEach-Object { $_.title })
      foreach ($candidate in $fresh) {
        try {
          $probeWs = Connect-Cdp -WsUrl $candidate.webSocketDebuggerUrl
          try {
            $got = Invoke-Eval $probeWs $probe
            if ($got -eq $true) { $hit += $candidate }
          }
          finally { try { $probeWs.Dispose() } catch { } }
        }
        catch {
          # 正在重载的窗口 evaluate 会报错 —— 这一轮先跳过它
        }
      }
      if ($hit.Count -gt 0) { break }
      if ((Get-Date) -ge $deadline) { break }
      Start-Sleep -Milliseconds 1000
    }
    if ($hit.Count -eq 0) {
      $all = ($lastSeen) -join ' | '
      throw "等了 20 秒，没有哪个窗口的页面上有「$RequireSelector」（候选：$all）。应用是不是没起来？"
    }
    $pages = $hit
  }
  if ($TitleLike -notlike '*速记*') {
    $noSmall = @($pages | Where-Object { $_.title -notlike '*速记*' })
    if ($noSmall.Count -gt 0) { $pages = $noSmall }
  }
  if ($Index -ge 0 -and $Index -lt $pages.Count) { return $pages[$Index] }
  $page = $pages | Select-Object -First 1
  if (-not $page) {
    $all = ($targets | ForEach-Object { "$($_.type):$($_.title)" }) -join ' | '
    throw "port $Port 上没有匹配的 page 目标（title 过滤='$TitleLike'）。当前有：$all"
  }
  return $page
}

function Connect-Cdp {
  param([string]$WsUrl)
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$WsUrl, [System.Threading.CancellationToken]::None).Wait()
  return $ws
}

function Send-Cdp {
  param($Ws, [string]$Method, $Params)
  $script:msgId++
  $payload = @{ id = $script:msgId; method = $Method; params = $Params } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
  $Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()

  while ($true) {
    $buffer = New-Object byte[] 262144
    $segIn = New-Object System.ArraySegment[byte] -ArgumentList @(, $buffer)
    $ms = New-Object System.IO.MemoryStream
    do {
      $res = $Ws.ReceiveAsync($segIn, [System.Threading.CancellationToken]::None).Result
      if ($res.Count -gt 0) { $ms.Write($buffer, 0, $res.Count) }
    } while (-not $res.EndOfMessage)
    $json = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    $ms.Dispose()
    if ([string]::IsNullOrWhiteSpace($json)) { continue }
    $obj = $json | ConvertFrom-Json
    if ($obj.id -eq $script:msgId) { return $obj }
    # 不是本次请求的响应（事件等）→ 继续等
  }
}

function Invoke-Eval {
  param($Ws, [string]$Expression)
  $resp = Send-Cdp $Ws 'Runtime.evaluate' @{
    expression    = $Expression
    returnByValue = $true
    awaitPromise  = $true
  }
  if ($resp.result.exceptionDetails) {
    $msg = $resp.result.exceptionDetails.exception.description
    if (-not $msg) { $msg = $resp.result.exceptionDetails.text }
    throw "页面里报错：$msg"
  }
  return $resp.result.result.value
}

$target = Get-PageTarget -Port $Port -TitleLike $TargetTitle -Index $TargetIndex -RequireSelector $RequireSelector
$ws = Connect-Cdp -WsUrl $target.webSocketDebuggerUrl

try {
  switch ($Action) {
    'list' {
      Write-Output ("url={0}" -f $target.url)
      Write-Output ("title={0}" -f $target.title)
    }

    # 列出所有 page target —— 多窗口（主窗 + 小窗）时用它确认谁是谁
    'targets' {
      $all = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5
      $all | Where-Object { $_.type -eq 'page' } | ForEach-Object {
        Write-Output ("title={0}  url={1}  id={2}" -f $_.title, $_.url, $_.id)
      }
    }

    'text' {
      Write-Output (Invoke-Eval $ws 'document.body.innerText')
    }

    'eval' {
      if ($ExprFile) {
        if (-not (Test-Path $ExprFile)) { throw "找不到 JS 文件：$ExprFile" }
        # 从文件读原文（带中文的 JS 一定要按 UTF-8 读）
        $Expr = Get-Content -Raw -Encoding UTF8 $ExprFile
      }
      if (-not $Expr) { throw "缺少 -Expr（或 -ExprFile）" }
      Write-Output (Invoke-Eval $ws $Expr)
    }

    'click' {
      if (-not $Selector) { throw "缺少 -Selector" }
      $sel = $Selector.Replace("'", "\'")
      $js = "(function(){var el=document.querySelector('$sel'); if(!el) return 'NOT_FOUND'; el.scrollIntoView({block:'center'}); el.click(); return 'CLICKED';})()"
      Write-Output (Invoke-Eval $ws $js)
    }

    'type' {
      if (-not $Selector) { throw "缺少 -Selector" }
      # 先聚焦目标元素，再用 Input.insertText 送字（绕过焦点/输入法问题）
      $sel = $Selector.Replace("'", "\'")
      $focused = Invoke-Eval $ws "(function(){var el=document.querySelector('$sel'); if(!el) return 'NOT_FOUND'; el.focus(); return document.activeElement === el ? 'FOCUSED' : 'FOCUS_FAILED';})()"
      Write-Output $focused
      if ($focused -eq 'FOCUS_FAILED') { throw "元素没能获得焦点：$Selector" }

      if ($Text) {
        $resp = Send-Cdp $ws 'Input.insertText' @{ text = $Text }
        if ($resp.error) { throw "insertText 失败：$($resp.error.message)" }
        Write-Output ("typed {0} chars" -f $Text.Length)
      }

      if ($Enter) {
        foreach ($type in @('rawKeyDown', 'char', 'keyUp')) {
          [void](Send-Cdp $ws 'Input.dispatchKeyEvent' @{
              type                  = $type
              key                   = 'Enter'
              code                  = 'Enter'
              text                  = "`r"
              windowsVirtualKeyCode = 13
              nativeVirtualKeyCode  = 13
            })
        }
        Write-Output "pressed Enter"
      }
    }

    'shot' {
      $resp = Send-Cdp $ws 'Page.captureScreenshot' @{ format = 'png' }
      if ($resp.error) { throw "截图失败：$($resp.error.message)" }
      [System.IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String($resp.result.data))
      Write-Output ("saved {0}" -f $OutFile)
    }

    # 把一张图放进**真实系统剪贴板**（后面用 `-Action paste` 送真 Ctrl+V 去验粘贴）
    'clip' {
      if (-not $ClipFile) { throw "缺少 -ClipFile（要放进剪贴板的图片文件）" }
      if (-not (Test-Path -LiteralPath $ClipFile)) { throw "找不到图片：$ClipFile" }
      if ($PSVersionTable.PSVersion.Major -le 5) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bmp = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ClipFile).Path)
        [System.Windows.Forms.Clipboard]::SetImage($bmp)
        $bmp.Dispose()
      }
      else {
        # pwsh 7：Set-Clipboard -Path 是**文件列表**，不是位图；要位图得直接调 Win32
        Add-Type -AssemblyName System.Drawing.Common -ErrorAction SilentlyContinue
        if (-not ('CdpClip' -as [type])) {
          Add-Type -Namespace '' -Name 'CdpClip' -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(System.IntPtr h);
[DllImport("user32.dll", SetLastError=true)] public static extern bool EmptyClipboard();
[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
[DllImport("user32.dll", SetLastError=true)] public static extern System.IntPtr SetClipboardData(uint fmt, System.IntPtr mem);
'@
        }
        $img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ClipFile).Path)
        $bmp2 = New-Object System.Drawing.Bitmap $img
        $hbm = $bmp2.GetHbitmap()
        if (-not [CdpClip]::OpenClipboard([System.IntPtr]::Zero)) { throw "打不开剪贴板（是不是被别的程序占着？）" }
        try {
          [void][CdpClip]::EmptyClipboard()
          $ok = [CdpClip]::SetClipboardData(2, $hbm)   # 2 = CF_BITMAP
          if ($ok -eq [System.IntPtr]::Zero) { throw "写入剪贴板失败" }
        }
        finally { [void][CdpClip]::CloseClipboard() }
        $img.Dispose()
        $bmp2.Dispose()
      }
      Write-Output ("clipboard set: {0}" -f $ClipFile)
    }

    # 真实 Ctrl+V（走 CDP 的输入管线 → 真键盘事件 → 浏览器自己去读剪贴板）
    'paste' {
      foreach ($type in @('rawKeyDown', 'keyUp')) {
        [void](Send-Cdp $ws 'Input.dispatchKeyEvent' @{
            type                     = $type
            key                      = 'v'
            code                     = 'KeyV'
            windowsVirtualKeyCode    = 86
            nativeVirtualKeyCode     = 86
            modifiers                = 2          # 2 = Ctrl
          })
      }
      Write-Output "pressed Ctrl+V"
    }

    'wheel' {
      if ($X -ge 0 -and $Y -ge 0) {
        $x = [double]$X
        $y = [double]$Y
      }
      else {
        if (-not $Selector) { throw "缺少 -Selector（或用 -X/-Y 直接给坐标）" }
        $selw = $Selector.Replace("'", "\'")
        $scrollw = if ($NoScroll) { '' } else { "el.scrollIntoView({block:'center'});" }
        $raww = Invoke-Eval $ws "(function(){var el=document.querySelector('$selw'); if(!el) return ''; $scrollw var r=el.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()"
        if (-not $raww) { throw "找不到元素：$Selector" }
        $partsw = $raww.Split(',')
        $x = [double]$partsw[0]
        $y = [double]$partsw[1]
      }
      # CDP 的 modifiers 位：Alt=1、Ctrl=2、Meta=4、Shift=8
      $mods = if ($Ctrl) { 2 } else { 0 }
      [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none'; clickCount = 0; buttons = 0; modifiers = $mods })
      [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = $x; y = $y; deltaX = 0; deltaY = $DeltaY; modifiers = $mods })
      Write-Output ("wheel dy={0} ctrl={1} at ({2},{3})" -f $DeltaY, [bool]$Ctrl, $x, $y)
    }
    'mouse' {
      if ($X -ge 0 -and $Y -ge 0) {
        $x = [double]$X
        $y = [double]$Y
      }
      else {
        if (-not $Selector) { throw "缺少 -Selector（或用 -X/-Y 直接给坐标）" }
        $sel = $Selector.Replace("'", "\'")
        # 取目标元素中心点（页面坐标 = CSS 像素，与窗口位置无关）
        # ⚠️ 默认会 `scrollIntoView` 把元素滚进视野 —— 但**拖拽时这会把另一个端点挤出屏幕**，
        #    所以给了 `-NoScroll` 就不滚（调用方自己负责"两端同屏"）。
        $scroll = if ($NoScroll) { '' } else { "el.scrollIntoView({block:'center'});" }
        $raw = Invoke-Eval $ws "(function(){var el=document.querySelector('$sel'); if(!el) return ''; $scroll var r=el.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()"
        if (-not $raw) { throw "找不到元素：$Selector" }
        $parts = $raw.Split(',')
        $x = [double]$parts[0]
        $y = [double]$parts[1]
      }

      $to = $null
      if ($ToX -ge 0 -and $ToY -ge 0) {
        $to = @{ x = [double]$ToX; y = [double]$ToY }
      }
      elseif ($ToSelector) {
        $sel2 = $ToSelector.Replace("'", "\'")
        $raw2 = Invoke-Eval $ws "(function(){var el=document.querySelector('$sel2'); if(!el) return ''; var r=el.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()"
        if (-not $raw2) { throw "找不到目标元素：$ToSelector" }
        $p2 = $raw2.Split(',')
        $to = @{ x = [double]$p2[0]; y = [double]$p2[1] }
      }

      # 先移过去（很多组件依赖 mousemove 才认 hover）
      [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none'; clickCount = 0; buttons = 0 })

      if ($to) {
        # 拖拽：按下 → 中间补几步 move（组件常按"位移阈值"判定是否成拖） → 松开
        [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1; buttons = 1 })
        for ($i = 1; $i -le 6; $i++) {
          $mx = [math]::Round($x + ($to.x - $x) * $i / 6)
          $my = [math]::Round($y + ($to.y - $y) * $i / 6)
          [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $mx; y = $my; button = 'left'; buttons = 1 })
        }
        [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $to.x; y = $to.y; button = 'left'; clickCount = 1; buttons = 0 })
        Write-Output ("dragged ({0},{1}) -> ({2},{3})" -f $x, $y, $to.x, $to.y)
      }
      else {
        for ($c = 1; $c -le $Clicks; $c++) {
          [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = $c; buttons = 1 })
          [void](Send-Cdp $ws 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = $c; buttons = 0 })
        }
        Write-Output ("clicked x{0} at ({1},{2})" -f $Clicks, $x, $y)
      }
    }
  }
}
finally {
  try { [void]$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', [System.Threading.CancellationToken]::None).Wait(2000) } catch { }
  $ws.Dispose()
}
