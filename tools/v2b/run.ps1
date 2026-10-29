# B 批验收 · 真实输入版（2026-10-02）
#   ① 番茄钟面板不再挡人：#10a 的核心 —— 面板开着时**别的区真的能点**（真实鼠标）
#   ② 「结束」的二次确认：点结束 → 出确认条（**还没落盘**）→ 点「继续专注」→ 什么都没发生
#   ③ 手动暂停 / 继续：计时真的冻住、那段时间不计入专注；小窗上也有这颗按钮
#
# 🔴 铁规矩：只动自己造的数据（`M-B批 ` 前缀的待办），用户的东西一个字不动；跑完清干净。
# ⚠️ 本脚本必须带 UTF-8 BOM（否则 PowerShell 5.1 按 GBK 读中文 → 整个脚本崩）；
#    含中文的 JS 一律走 EvalMain（内部 -ExprFile），别用 -Expr。
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
if (-not (Test-Path -LiteralPath $cdp)) { throw "找不到 cdp.ps1：$cdp" }
$DATA = 'D:\东方摩耶堂'
$MAIN = '东方摩耶堂'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [X] {0}   {1}" -f $name, $detail) -ForegroundColor Red }
}

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("v2b-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1
  }
  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  $first = @($out) | Select-Object -First 1
  if ($null -ne $first -and $first -isnot [string]) {
    return (ConvertTo-Json -InputObject @($out) -Depth 12 -Compress)
  }
  return (@($out) -join "`n").Trim()
}

function MouseAt([int]$x, [int]$y, [int]$clicks = 1) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action mouse -X $x -Y $y -Clicks $clicks -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' | Out-Null
}

function ClickButtonLike([string]$text) {
  $js = @"
(function(){
  var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').indexOf('$text')>=0;})[0];
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()
"@
  return (EvalMain $js)
}

function CountOf([string]$command) {
  $raw = EvalMain "window.__TAURI_INTERNALS__.invoke('$command',{}).then(function(l){return 'N='+l.length;})"
  $m = [regex]::Match($raw, 'N=(\d+)')
  if (-not $m.Success) { throw "数不出来（$command 返回：$raw）" }
  return [int]$m.Groups[1].Value
}

function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (& $probe) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return $false
}

# ⚠️⚠️ **导航要"点了再确认"**（2026-10-02 踩到，害我白查一轮）：
#   `ClickButtonLike '执行区'` 是**一次性**的，而每一步 `EvalMain` 都是一次独立的页面往返 ——
#   后面某一步如果顺手把页面切走了，再回来断言就会出现"卡片找不到"这种**假红**（东西其实好好的）。
#   所以导航一律走这个函数：**点完轮询确认 `h1` 真的换成了目标页**。
function GoPage([string]$name) {
  for ($i = 0; $i -lt 3; $i++) {
    $null = ClickButtonLike $name
    $ok = Wait-Until { (EvalMain "(function(){var h=document.querySelector('h1'); return h? h.innerText : '';})()") -match $name } 4000
    if ($ok) { return $true }
  }
  return $false
}

# 元素中心的坐标（纯 ASCII 选择器 —— 中文选择器会被 GBK 传参弄坏，见进度.md 第五节）
function CenterOf([string]$selector) {
  $js = "(function(){var e=document.querySelector('$selector'); if(!e) return ''; var r=e.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()"
  return (EvalMain $js)
}

# 这个坐标上"到底是谁"（鼠标点不中时用它定位，别再靠猜）
function HitAt([int]$x, [int]$y) {
  $js = "(function(){var e=document.elementFromPoint($x,$y); return e? (e.tagName+'|'+(e.innerText||'').trim().slice(0,14)) : 'NONE';})()"
  return (EvalMain $js)
}

# ⚠️ **真实鼠标点 + 等状态真的变**（2026-10-02 踩到：发完鼠标事件立刻断言会假红 ——
#    React 的渲染是异步的，中间那几百毫秒 DOM 还是旧样子）
function MouseClickAndWait([string]$selector, [string]$expectSelector, [int]$timeoutMs = 8000) {
  $pos = CenterOf $selector
  if ($pos -notmatch '^(\d+),(\d+)$') { return $false }
  $x = [int]$Matches[1]; $y = [int]$Matches[2]
  MouseAt $x $y
  return (Wait-Until { (EvalMain "document.querySelectorAll('$expectSelector').length") -match '^[1-9]' } $timeoutMs)
}

# 真实鼠标点一下（不关心状态变化时用它）
function MouseClick([string]$selector) {
  $pos = CenterOf $selector
  if ($pos -notmatch '^(\d+),(\d+)$') { return $false }
  MouseAt ([int]$Matches[1]) ([int]$Matches[2])
  return $true
}

# ★ **把系统空闲清零**（M13 那套里的招，注释写着"只有真实输入算，CDP 的事件不算"）：
#   往页面里挪 1 像素 —— 这是真鼠标输入，`GetLastInputInfo` 的空闲会归零，
#   于是 M13-B 的"疑似离开"不会在验收途中自己冒出来。
#   ⚠️ 必须先 `Input.dispatchMouseEvent` 不能靠合成 DOM 事件，所以走 cdp 的 mouse 动作。
function ResetIdle() {
  $pos = (EvalMain "(function(){return Math.round(window.innerWidth/2)+','+Math.round(window.innerHeight/2);})()")
  if ($pos -match '^(\d+),(\d+)$') {
    $x = [int]$Matches[1]; $y = [int]$Matches[2]
    MouseAt ($x + 1) ($y + 1)
    Start-Sleep -Milliseconds 150
    MouseAt $x $y
    Start-Sleep -Milliseconds 250
  }
}

try {
Write-Host "`n=== B 批验收开始 ===" -ForegroundColor Cyan

# 🔴🔴 **开头先强制刷新页面**（2026-10-02 血泪教训）：
#   改完 `src/` 之后 vite 会 HMR，但**结构性改动**（把 `Modal` 换成 `aside`、新增/删除按钮）
#   HMR 处理不干净 —— 页面会继续跑**旧组件代码**，于是"新按钮找不到"报一堆假红，
#   而人去看源码、跑 tsc 全是好的（这一轮为此白查了好几轮）。
#   所以：**验收一律从 reload 开始**，多花 6 秒，省半小时。
$null = (EvalMain "location.reload(); 'reloading'")
Start-Sleep -Seconds 6

$alive = Wait-Until { (EvalMain "document.querySelectorAll('nav').length") -match '^[1-9]' } 15000
if (-not $alive) { throw "刷新之后页面没起来（vite 还活着吗？）" }

# ─────────────────────── §0 清场 + 基线 ───────────────────────
Write-Host "`n§0 清场与基线" -ForegroundColor Yellow
$sweepJs = @"
window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){
  var mine=l.filter(function(t){return (t.title||'').indexOf('M-B批')===0;});
  var chain=Promise.resolve();
  mine.forEach(function(t){ chain=chain.then(function(){ return window.__TAURI_INTERNALS__.invoke('todo_delete',{id:t.id}); }); });
  return chain.then(function(){ return 'SWEPT='+mine.length; });
})
"@
Write-Host ("  清掉以前跑剩的测试待办：" + (EvalMain $sweepJs))

$todoCount = CountOf 'todo_list'
Write-Host ("  基线：待办 {0} 条" -f $todoCount)

# ⚠️⚠️ **测试期间把「疑似离开」阈值临时调高**（2026-10-02 踩到，不调就永远是假红）：
#   我写脚本 / 读代码时人是离开电脑的 → 空闲早就超过默认 90 秒 → 一按结束就触发 M13-B 的
#   **结算卡**（"有 N 分钟疑似离开，计入还是作废"）→ 待办**故意**不被标完成、面板**故意**不关。
#   那是设计好的行为、不是 bug；但会让"点确认后真收尾"这条断言假红。
#   → 阈值临时调到 3600 秒，验完在 §6 收尾**原样还原**（他自己的设置不许动）。
$configBefore = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({away:c.focus.awayThresholdSeconds, ask:c.focus.askOnFinish});})")
Write-Host ("  他原来的专注设置：{0}" -f $configBefore)
$awayBefore = [int]([regex]::Match($configBefore, '"away":(\d+)').Groups[1].Value)
$null = EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.focus.awayThresholdSeconds = 3600;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@
Start-Sleep -Milliseconds 700
$awayNow = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return String(c.focus.awayThresholdSeconds);})")
Check ("★ 阈值临时调成 3600 秒（读回来 {0}，跑完还原）" -f $awayNow) ($awayNow -eq '3600') $awayNow

# 上一轮即便异常退出也要先收掉会话（不然小窗挂着、monitor 还在跑）
$null = EvalMain "window.__TAURI_INTERNALS__.invoke('focus_monitor_stop').catch(function(){return null;}).then(function(){return 'ok';})"
Start-Sleep -Milliseconds 400
# ─────────────────────── §1 开一场专注，面板出现 ───────────────────────
Write-Host "`n§1 开始专注 → 右侧面板出现（且**没有**遮罩）" -ForegroundColor Yellow
Check "执行区能进去" (GoPage '执行区')
# 开专注之前先活动一下鼠标：不然"开的那一刻机器已经空闲"会让 M13-B 立刻记一次疑似离开
ResetIdle

$created = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_create',{title:'M-B批 面板不挡人'}).then(function(t){return t.id;})")
Check ("造一条测试待办（{0}…）" -f $created.Substring(0, 8)) ($created.Length -gt 8) $created

# 卡片是异步刷出来的（`todo_create` → `data-changed` → refresh）→ **轮询等它出现**
$cardReady = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-start=""$created""]').length") -match '^[1-9]' } 10000
Check "★ 测试卡片出现在执行区（等到了）" $cardReady

$jsStart = @"
(function(){
  // ⚠️ 开始按钮自带 `data-todo-start`，**别去卡片里按文字找**（它的文字是「▶ 开始」）
  var b=document.querySelector('[data-todo-start="$created"]');
  if(!b) return 'NO_START';
  b.click(); return 'OK';
})()
"@
$startRes = (EvalMain $jsStart)
Check ("点了卡片上的【开始】（返回 {0}）" -f $startRes) ($startRes -eq 'OK')
$panelReady = Wait-Until { (EvalMain "document.querySelectorAll('[data-pomodoro-panel]').length") -match '^[1-9]' } 8000
Check "★ 右侧专注面板出现了（`data-pomodoro-panel`）" $panelReady

$overlay = (EvalMain @"
(function(){
  // 有没有"全屏遮罩"？判据：存在一张 fixed inset-0 的元素，且它盖住了页面中心（elementFromPoint 命中它）
  var cx=Math.round(window.innerWidth/2), cy=Math.round(window.innerHeight/2);
  var hit=document.elementFromPoint(cx, cy);
  var blockedByBackdrop=false, node=hit;
  while(node){ if(node.className && typeof node.className==='string' && node.className.indexOf('backdrop-blur')>=0) blockedByBackdrop=true; node=node.parentElement; }
  var dims=Array.from(document.querySelectorAll('div')).filter(function(d){
    var s=getComputedStyle(d);
    return s.position==='fixed' && d.className && typeof d.className==='string'
      && d.className.indexOf('inset-0')>=0 && d.className.indexOf('z-40')>=0;
  }).length;
  return JSON.stringify({blockedByBackdrop:blockedByBackdrop, fixedOverlays:dims, centerTag:(hit||{}).tagName||''});
})()
"@)
Check "★★ 页面中心没有被遮罩吃掉（backdrop-blur 不在命中链上）" ($overlay -match '"blockedByBackdrop":false') $overlay
Check "★ 也没有别的 `fixed inset-0 z-40` 全屏层" ($overlay -match '"fixedOverlays":0') $overlay

# ─────────────────────── §2 ★ 真实鼠标：面板开着时去别的区 ───────────────────────
Write-Host "`n§2 ★ 真实鼠标：一边计时一边去信息区（这是 #10a 的核心）" -ForegroundColor Yellow
$posRaw = (EvalMain @"
(function(){
  var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').indexOf('信息区')>=0;})[0];
  if(!b) return '';
  var r=b.getBoundingClientRect();
  return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);
})()
"@)
Check ("拿到侧栏「信息区」的坐标（{0}）" -f $posRaw) ($posRaw -match '^\d+,\d+$') $posRaw
if ($posRaw -match '^(\d+),(\d+)$') { MouseAt ([int]$Matches[1]) ([int]$Matches[2]) }
$jumped = Wait-Until { (EvalMain "(function(){var h=document.querySelector('h1'); return h? h.innerText : '';})()") -match '信息区' } 6000
Check "★★ 真实鼠标点侧栏**真的跳过去了**（面板没吃鼠标）" $jumped

$stillRunning = (EvalMain "document.querySelectorAll('[data-pomodoro-panel]').length")
Check "★ 跳走之后面板**还在**（切页面没把计时卸载）" ("$stillRunning" -match '^[1-9]') "count=$stillRunning"
# 在信息区里读两次表面板：两次不一样 = 计时**在后台照走**（这就是"不挡人"的关键证据）
$clock1 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Start-Sleep -Seconds 3
$clock2 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Check ("★ 在信息区待着的时候计时**照走**（{0} → {1}）" -f $clock1, $clock2) ($clock1 -ne $clock2 -and $clock1 -ne 'NONE') "$clock1 / $clock2"

# ─────────────────────── §3 手动暂停 / 继续 ───────────────────────
Write-Host "`n§3 手动暂停（真实鼠标点 ⏸，得先回执行区 —— 面板在那儿）" -ForegroundColor Yellow
Check "回到执行区" (GoPage '执行区')
Start-Sleep -Milliseconds 500
# 诊断（成本很低，失败时全靠它定位）
$diag = (EvalMain @"
(function(){
  var h=document.querySelector('h1');
  return JSON.stringify({
    h1: h? h.innerText : 'NONE',
    panel: document.querySelectorAll('[data-pomodoro-panel]').length,
    pause: document.querySelectorAll('[data-pomodoro-pause]').length,
    confirmBar: document.querySelectorAll('[data-pomodoro-confirm]').length
  });
})()
"@)
Write-Host ("  [诊断] " + $diag)
$pausePos = (EvalMain @"
(function(){
  var b=document.querySelector('[data-pomodoro-pause]');
  if(!b) return '';
  var r=b.getBoundingClientRect();
  return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);
})()
"@)
Check ("找到 ⏸ 暂停按钮坐标（{0}）" -f $pausePos) ($pausePos -match '^\d+,\d+$') $pausePos
$pausedNow = MouseClickAndWait '[data-pomodoro-pause]' '[data-pomodoro-manual-paused]'
Check "★ 点了暂停 → 面板上出「你手动暂停了」" $pausedNow
$frozen1 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Start-Sleep -Seconds 3
$frozen2 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Check ("★ 暂停期间计时**冻住**（{0} = {1}）" -f $frozen1, $frozen2) ($frozen1 -eq $frozen2) "$frozen1 / $frozen2"

# 小窗上那颗按钮也该变成「▶ 继续」（小窗是**另一个页面 target**，得单独连它）
$smallPause = (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -Expr "document.querySelector('[data-focus-pause]') ? document.querySelector('[data-focus-pause]').innerText.trim() : 'NO_BTN'" -Port $Port -TargetTitle '专注中' 2>&1 | Out-String).Trim()
Check ("★ 小窗上那颗按钮变成「▶ 继续」（实际：{0}）" -f $smallPause) ($smallPause -match '继续') $smallPause

# 继续：点同一个按钮 → 「你手动暂停了」那条消失，且计时重新走起来
$resumed = $false
$pos2 = CenterOf '[data-pomodoro-pause]'
if ($pos2 -match '^(\d+),(\d+)$') {
  MouseAt ([int]$Matches[1]) ([int]$Matches[2])
  $resumed = Wait-Until { (EvalMain "document.querySelectorAll('[data-pomodoro-manual-paused]').length") -eq '0' } 6000
}
Check "★ 再点一下 → 解除暂停（那条提示消失）" $resumed
Start-Sleep -Seconds 2
$running1 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Start-Sleep -Seconds 2
$running2 = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-clock]'); return e? e.innerText : 'NONE';})()")
Check ("★ 解除暂停后计时又走起来了（{0} → {1}）" -f $running1, $running2) ($running1 -ne $running2 -and $running2 -ne 'NONE') "$running1 / $running2"

# ─────────────────────── §4 「结束」的二次确认 ───────────────────────
Write-Host "`n§4 结束要先确认（真实鼠标点 ✓ 结束）" -ForegroundColor Yellow
# 收尾前再活动一次鼠标（万一中途空闲超阈值，结算卡会插进来，那一步就得人工选了）
ResetIdle
$awayState = (EvalMain "window.__TAURI_INTERNALS__.invoke('focus_monitor_state').then(function(s){return JSON.stringify({times:s.interruptedTimes, idles:s.idleSeconds, threshold:3600});})")
Write-Host ("  [诊断] 监控状态：{0}" -f $awayState)
Check ("★ 这一场没有被判成疑似离开（次数 {0}）" -f ([regex]::Match($awayState, '"times":(\d+)').Groups[1].Value)) (([regex]::Match($awayState, '"times":(\d+)').Groups[1].Value) -eq '0') $awayState
Check ("找到「结束并标完成」坐标（{0}）" -f (CenterOf '[data-pomodoro-finish]')) ((CenterOf '[data-pomodoro-finish]') -match '^\d+,\d+$')
$before = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){var t=l.filter(function(x){return x.id==='$created';})[0]; return t? ('status='+t.status+'|pom='+t.pomodoros.length) : 'GONE';})")
$confirmShown = MouseClickAndWait '[data-pomodoro-finish]' '[data-pomodoro-confirm]'
Check "★ 点「结束」→ 先出确认条（不是直接结束）" $confirmShown
$after = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){var t=l.filter(function(x){return x.id==='$created';})[0]; return t? ('status='+t.status+'|pom='+t.pomodoros.length) : 'GONE';})")
Check ("★★ 出确认条那一刻**什么都没落盘**（{0} → {1}）" -f $before, $after) ($before -eq $after) "$before / $after"

# 点「继续专注」→ 确认条消失、面板还在
$cancelGone = $false
$cancelPos = CenterOf '[data-pomodoro-confirm-cancel]'
if ($cancelPos -match '^(\d+),(\d+)$') {
  MouseAt ([int]$Matches[1]) ([int]$Matches[2])
  $cancelGone = Wait-Until { (EvalMain "document.querySelectorAll('[data-pomodoro-confirm]').length") -eq '0' } 6000
}
Check "★ 点「继续专注」→ 确认条收起来了" $cancelGone
Check "★ 面板还在、计时还在" ((EvalMain "document.querySelectorAll('[data-pomodoro-panel]').length") -match '^[1-9]')

# ─────────────────────── §5 真的结束（走确认）───────────────────────
Write-Host "`n§5 走完确认：真的结束" -ForegroundColor Yellow
$confirmAgain = MouseClickAndWait '[data-pomodoro-finish]' '[data-pomodoro-confirm]'
Check "再次点结束 → 确认条又出来了" $confirmAgain
$okPos = CenterOf '[data-pomodoro-confirm-finish]'
if ($okPos -match '^(\d+),(\d+)$') { MouseAt ([int]$Matches[1]) ([int]$Matches[2]) }
$finished = Wait-Until {
  $now = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){var t=l.filter(function(x){return x.id==='$created';})[0]; return t? ('status='+t.status+'|pom='+t.pomodoros.length) : 'GONE';})")
  $now -match 'status=done' -and $now -notmatch 'pom=0'
} 8000
$final = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){var t=l.filter(function(x){return x.id==='$created';})[0]; return t? ('status='+t.status+'|pom='+t.pomodoros.length) : 'GONE';})")
Check ("★ 确认之后真收尾了：待办标完成 + 记了一笔番茄（{0}）" -f $final) $finished
Check "★ 面板收起来了（没有会话了）" ((EvalMain "document.querySelectorAll('[data-pomodoro-panel]').length") -eq '0')

# ─────────────────────── §6 收尾 ───────────────────────
Write-Host "`n§6 收尾（只删自己造的 + 还原他的设置）" -ForegroundColor Yellow
$null = EvalMain "window.__TAURI_INTERNALS__.invoke('todo_delete',{id:'$created'}).then(function(){return 'ok';})"
$null = EvalMain "window.__TAURI_INTERNALS__.invoke('focus_monitor_stop').catch(function(){return null;}).then(function(){return 'ok';})"

# 把「疑似离开」阈值还原成他原来那个数（默认 90）
$null = EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.focus.awayThresholdSeconds = $awayBefore;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@
Start-Sleep -Milliseconds 700
$awayRestored = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return String(c.focus.awayThresholdSeconds);})")
Check ("★ 专注阈值已还原成 {0}（实际 {1}）" -f $awayBefore, $awayRestored) ("$awayRestored" -eq "$awayBefore") $awayRestored

Start-Sleep -Milliseconds 400
$backOk = Wait-Until { (CountOf 'todo_list') -eq $todoCount } 8000
Check ("测试待办已删（回到 {0} 条）" -f $todoCount) $backOk
$swept2 = (EvalMain $sweepJs)
Write-Host ("  收尾再扫一遍：" + $swept2)

Write-Host "`n========== B 批验收：通过 $pass ，失败 $fail ==========" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
} catch {
  # 🔴 **脚本崩了也要打出小结**（2026-10-02 踩到：v2 三个套件里只要有未捕获异常，
  #    整套脚本当场退出、连成绩行都没有，`regress.ps1` 就报"没读到成绩行（跑起来了吗？）"，
  #    看起来像"套件没跑"，其实是"跑崩了"。这里兜住，把真实错误和已通过的条数都打出来。）
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("========== 验收（异常中断）：通过 $pass ，失败 $fail ==========") -ForegroundColor Red
  exit 1
}