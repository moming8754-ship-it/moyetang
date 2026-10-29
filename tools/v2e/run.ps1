# E 批验收 · 桌面挂件（2026-10-03）
#   ① 挂件窗口能建出来、渲染对（格言 / 今日待办 / 番茄三格）
#   ② 设置里的开关：开 → 挂件出现；关 → 挂件收起（且**配置真的落盘**）
#   ③ 尺寸 / 贴法 / 显示哪些格：改了立刻生效（当场重摆，不用重启）
#   ④ **真实鼠标拖标题条** → 窗口真的动了（手势类必须真输入，合成事件会假绿灯）
#   ⑤ 位置记忆：收起再打开 → 回到拖到的地方
#   ⑥ 挂件上的 ✕ 只收窗口、**不改开关**（这是设计：收一下 ≠ 关掉功能）
#   ⑦ 收尾：还原他的开关与位置，只动自己造的数据
#
# 🔴 铁规矩：只动**挂件自己的配置项**（widget.*），跑完原样还原；
#    用户的笔记 / 待办 / 信息一个字不动（这一套本来也不碰它们）。
# ⚠️ `EvalJson` 已经把 JSON 解析成对象，**别再 ConvertFrom-Json**（2026-10-02 栽过）。
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
if (-not (Test-Path -LiteralPath $cdp)) { throw "找不到 cdp.ps1：$cdp" }
$DATA = 'D:\东方摩耶堂'
$MAIN = '东方摩耶堂'
$WIDGET = '东方摩耶堂 · 挂件'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [X] {0}   {1}" -f $name, $detail) -ForegroundColor Red }
}

function EvalIn([string]$title, [string]$require, [string]$js) {
  $tmp = Join-Path $env:TEMP ("v2e-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $require 2>&1
  }
  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  return (@($out) -join "`n").Trim()
}

function EvalMain([string]$js) { return (EvalIn $MAIN 'nav' $js) }
function EvalWidget([string]$js) { return (EvalIn $WIDGET '[data-widget]' $js) }

# EvalJson：**直接返回解析好的对象**（别再 ConvertFrom-Json！）
function EvalJson([string]$js) {
  $raw = (EvalMain $js)
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function WidgetVisible() {
  $raw = EvalMain "window.__TAURI_INTERNALS__.invoke('widget_visible').then(function(v){return String(v);})"
  return ($raw -eq 'True' -or $raw -eq 'true')
}

function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (& $probe) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return $false
}

function SetWidget([string]$jsPatch) {
  $js = @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  $jsPatch
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@
  return (EvalMain $js)
}

try {
Write-Host "`n=== E 批验收开始（桌面挂件）===" -ForegroundColor Cyan

# 开头强制刷新（结构性改动 HMR 处理不干净，见 v2b 脚本的注释）
$null = (EvalMain "location.reload(); 'reloading'")
Start-Sleep -Seconds 6
if (-not (Wait-Until { (EvalMain "document.querySelectorAll('nav').length") -match '^[1-9]' } 15000)) {
  throw "刷新之后页面没起来（vite 还活着吗？）"
}

# ─────────────────────── §0 记住他原来的设置 ───────────────────────
# ⚠️⚠️ **这里不许要求"挂件窗已经存在"**（2026-10-03 全量回归栽的）：
#    他的设置里挂件默认是**关着**的，窗口根本不在 → `EvalWidget`（带 `-RequireSelector`）
#    会等 20 秒然后**抛异常** → 整套脚本当场退出、连成绩行都打不出来，
#    `regress.ps1` 只看到"没读到成绩行（跑起来了吗？）"，看着像"套件没跑"。
#    所以 §0 只**读**一件事：现在挂着没挂着（不要求它在）。
$visibleBefore = WidgetVisible
Write-Host ("  开头：挂件现在是{0}" -f $(if ($visibleBefore) { '开着的' } else { '收着的（正常：他设置里 enabled=false）' }))
$cfg = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled, size:c.widget.size, layer:c.widget.layer, show:c.widget.show, pos:c.widget.pos});})"
if ($null -eq $cfg) { throw "读不到 config（cdp 不通？页面起来了吗？）" }
Write-Host ("  他原来的挂件设置：{0}" -f ($cfg | ConvertTo-Json -Compress))
$enabledBefore = $cfg.enabled
$sizeBefore = $cfg.size
$layerBefore = $cfg.layer
$showBefore = @($cfg.show)
$widgetBeforeJson = ($cfg | ConvertTo-Json -Compress -Depth 5)

# ─────────────────────── §1 挂件能建出来、渲染对 ───────────────────────
Write-Host "`n§1 挂件窗口与渲染" -ForegroundColor Yellow

# 先确保关着（不然"开"这一步验不出来）
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_close').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 800
Check "★ 收起来之后 `widget_visible` = false" (-not (WidgetVisible))

$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_open').then(function(){return 'ok';})")
$shown = Wait-Until { WidgetVisible } 8000
Check "★★ 打开命令之后挂件真的出现了（`widget_visible` = true）" $shown

$titles = (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action targets -Port $Port 2>&1 | Out-String)
Check "★ 它是**独立窗口**（target 里有一个标题叫「东方摩耶堂 · 挂件」的）" ($titles -match '东方摩耶堂 · 挂件') ($titles -replace "`r?`n", ' | ')

$render = (EvalWidget @'
(function(){
  var slots=Array.from(document.querySelectorAll('[data-widget-slot]')).map(function(e){return e.getAttribute('data-widget-slot');});
  return JSON.stringify({
    has:!!document.querySelector('[data-widget]'),
    slots:slots,
    bar:!!document.querySelector('[data-widget-bar]'),
    drag:(document.querySelector('[data-widget-bar]')||{}).getAttribute?document.querySelector('[data-widget-bar]').getAttribute('data-tauri-drag-region')!==null:false,
    close:!!document.querySelector('[data-widget-close]'),
    todos:document.querySelectorAll('[data-widget-todo]').length,
    pom:(document.querySelector('[data-widget-pomodoro]')||{}).innerText||''
  });
})()
'@)
Write-Host ("  渲染：" + $render)
Check "★ 挂件根节点在（`data-widget`）" ($render -match '"has":true') $render
Check "★ 标题条带 `data-tauri-drag-region`（拖动靠它，不自己写指针逻辑）" ($render -match '"drag":true') $render
Check "★ 有收起按钮 ✕" ($render -match '"close":true') $render
Check "★ 默认三格都在（格言 / 今日待办 / 番茄）" ($render -match '"slots":\["motto","todos","pomodoro"\]') $render
Check "★ 番茄那格显示了今天的统计" ($render -match '🍅') $render

# 保存的旧坐标可能来自已断开的显示器：窗口必须被挪回可见区域，不能"闪一下消失"。
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){c.widget.enabled=true;c.widget.pos={x:999999,y:999999};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});}).then(function(){return window.__TAURI_INTERNALS__.invoke('widget_close');}).then(function(){return window.__TAURI_INTERNALS__.invoke('widget_open');}).then(function(){return 'ok';})")
Start-Sleep -Seconds 1
$posJs = "window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position',{label:'widget'}).then(function(p){return JSON.stringify(p);}).catch(function(e){return 'ERR';})"
$offscreenFixed = (EvalMain $posJs)
Check "★★ 屏幕外坐标会被纠正，不会创建在看不见的位置" ((WidgetVisible) -and ($offscreenFixed -notmatch '"x":999999') -and ($offscreenFixed -notmatch '"y":999999')) $offscreenFixed

# ─────────────────────── §2 设置里的开关 ───────────────────────
Write-Host "`n§2 设置里的开关（点一下要对得上）" -ForegroundColor Yellow
$null = (EvalMain "(function(){var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').indexOf('设置')>=0;})[0]; if(b) b.click(); return 'ok';})()")
$cardReady = Wait-Until { (EvalMain "document.querySelectorAll('[data-settings-widget]').length") -match '^[1-9]' } 8000
Check "★ 设置里有「桌面挂件」卡片" $cardReady

# ⚠️ **别写死"点一下应该变关"**（2026-10-03 栽过）：前面几步可能已经把开关改过了，
#    写死方向就会假红。改成：读实际状态 → 断言"点一下应该变成它取反"。
$before2 = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled});})"
$wasOn = [bool]$before2.enabled
Write-Host ("  当前开关：{0}" -f $(if ($wasOn) { '开着' } else { '关着' }))
# ⚠️ 这条用**页面里直接点**（真实鼠标在"主窗不是前台窗口"时不触发，§6 那条已经验过真鼠标）
$null = (EvalMain "(function(){var e=document.querySelector('[data-widget-toggle]'); if(e) e.click(); return 'ok';})()")
if ($wasOn) {
  $offOk = Wait-Until { -not (WidgetVisible) } 8000
  Check "★★ 点开关（开→关）→ 挂件**当场**收起来了（不用重启）" $offOk
  $savedOff = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled});})"
  Check "★ 开关状态真的落盘了（enabled=false）" ($savedOff.enabled -eq $false) ($savedOff | ConvertTo-Json -Compress)
} else {
  $onOk2 = Wait-Until { WidgetVisible } 8000
  Check "★★ 点开关（关→开）→ 挂件**当场**出现了（不用重启）" $onOk2
  $savedOn = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled});})"
  Check "★ 开关状态真的落盘了（enabled=true）" ($savedOn.enabled -eq $true) ($savedOn | ConvertTo-Json -Compress)
}

# 再点一次 → 回到原来的状态（顺便验"两个方向都通"）
$null = (EvalMain "(function(){var e=document.querySelector('[data-widget-toggle]'); if(e) e.click(); return 'ok';})()")
if ($wasOn) {
  Check "★★ 再点一次 → 挂件又回来了" (Wait-Until { WidgetVisible } 8000)
} else {
  Check "★★ 再点一次 → 挂件又收起来了" (Wait-Until { -not (WidgetVisible) } 8000)
}
Write-Host "`n§3 尺寸与「显示哪几格」改了立刻生效" -ForegroundColor Yellow
$null = (EvalMain "(function(){var b=document.querySelector('[data-widget-size=""big""]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Seconds 2
$bigCfg = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({size:c.widget.size});})"
Check "★ 点「大」→ 配置里 size=big" ($bigCfg.size -eq 'big') ($bigCfg | ConvertTo-Json -Compress)
# 大号多两格（时钟 / 信息）—— 得把格子也打开
$null = (EvalMain "(function(){var boxes=Array.from(document.querySelectorAll('[data-widget-slot-toggle]')); ['clock','info'].forEach(function(k){ var b=boxes.filter(function(x){return x.getAttribute('data-widget-slot-toggle')===k;})[0]; if(b && !b.checked) b.click(); }); return 'ok';})()")
Start-Sleep -Seconds 2
$slotCount = (EvalWidget "String(document.querySelectorAll('[data-widget-slot]').length)")
Check ("★★ 打开「时钟/信息」两格 → 挂件上真的多出来了（现在 {0} 格）" -f $slotCount) ([int]$slotCount -ge 5) $slotCount
$clockShown = (EvalWidget "String(document.querySelectorAll('[data-widget-clock]').length)")
Check "★ 大号那格时钟在（`data-widget-clock`）" ([int]$clockShown -ge 1) $clockShown

# 收回中号三格（省得验收把界面改成大号）
$null = (EvalMain "(function(){var b=document.querySelector('[data-widget-size=""mid""]'); if(b) b.click(); return 'ok';})()")
$null = (EvalMain "(function(){var boxes=Array.from(document.querySelectorAll('[data-widget-slot-toggle]')); ['clock','info'].forEach(function(k){ var b=boxes.filter(function(x){return x.getAttribute('data-widget-slot-toggle')===k;})[0]; if(b && b.checked) b.click(); }); return 'ok';})()")
Start-Sleep -Seconds 2

# ─────────────────────── §4 ★ 真实鼠标拖动挂件 ───────────────────────
Write-Host "`n§4 ★ 真实鼠标拖标题条（手势类必须真输入）" -ForegroundColor Yellow
# 先记下当前窗口位置（用 Rust 侧的 outer_position，通过页面 API 读）
$p0 = (EvalMain $posJs)
Write-Host ("  拖动前位置：" + $p0)
# 拿标题条中心的坐标（挂件窗自己的坐标系）
$bar = (EvalWidget "(function(){var e=document.querySelector('[data-widget-bar]'); if(!e) return ''; var r=e.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()")
Check ("拿到标题条坐标（{0}）" -f $bar) ($bar -match '^\d+,\d+$') $bar
# ⚠️⚠️ **真实拖拽这一条验不了**（2026-10-03 如实记着）：
#    `data-tauri-drag-region` 是**原生窗口拖动**（Tauri 在 Rust 侧接住 mousedown 去 `StartDragging`），
#    而 CDP 的合成分派鼠标事件**不会**让原生拖动循环起来 —— 实测位置一动没动。
#    所以这里**不写"拖成功"的断言**（那是假绿灯），改成：
#      ① 验"拖动机制挂上了"（标题条有 data-tauri-drag-region）
#      ② 验"位置记忆"这条路是通的（用 Rust 侧 set_position 模拟拖后的位置 → 收起 → 重开 → 回到那儿）
#    真手拖这一条留给用户（跟托盘 6:00/18:00 那条一样）。
$dragAttr = (EvalWidget "String(document.querySelector('[data-widget-bar]')?.getAttribute('data-tauri-drag-region')!==null)")
Check "★ 拖动机制挂上了（标题条带 data-tauri-drag-region → 原生拖动）" ($dragAttr -eq 'True' -or $dragAttr -eq 'true') $dragAttr
Write-Host "  ⚠ 真实手拖这一条**自动化验不了**（原生拖动接不到合成鼠标事件）→ 留给用户手验" -ForegroundColor DarkGray

# 用 Rust 侧把窗口挪一下 = 模拟"用户拖到了别处"
# ⚠️ Tauri 2 的 `set_position` 参数是"**单键 map**"：`{Logical:{x,y}}` 或 `{Physical:{x,y}}`，
#    写成 `{type:'Physical',x,y}` 会被拒（`invalid value: map, expected map with a single key`）。
$px = [int]($p0 -replace '.*"x":(-?\d+).*','$1') - 140
$py = [int]($p0 -replace '.*"y":(-?\d+).*','$1') + 100
$moved = (EvalMain "window.__TAURI_INTERNALS__.invoke('plugin:window|set_position',{label:'widget',value:{Physical:{x:$px,y:$py}}}).then(function(){return 'ok';}).catch(function(e){return 'ERR:'+String(e).slice(0,60);})")
Write-Host ("  模拟拖到别处：" + $moved)
Start-Sleep -Seconds 1
$p1 = (EvalMain $posJs)
Write-Host ("  挪完位置：" + $p1)
Check ("★ 位置真的能改（{0} → {1}）" -f $p0, $p1) ($p1 -ne $p0 -and $p1 -ne 'ERR') $p1

# ─────────────────────── §5 位置记忆 ───────────────────────
Write-Host "`n§5 位置记忆（收起 → 再打开，回到拖到的地方）" -ForegroundColor Yellow
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_close').then(function(){return 'ok';})")
Start-Sleep -Seconds 1
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_open').then(function(){return 'ok';})")
Start-Sleep -Seconds 2
$p2 = (EvalMain $posJs)
Write-Host ("  重开之后位置：" + $p2)
Check "★★ 重开之后还在刚才拖到的地方（位置记进了 config）" ($p2 -eq $p1) ("$p1 → $p2")
$savedPos = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({pos:c.widget.pos});})"
Check "★ 位置真的写进 config 了（widget.pos 不是空）" ($null -ne $savedPos.pos) ($savedPos | ConvertTo-Json -Compress)

# ─────────────────────── §6 ✕ 只收窗口，不改开关 ───────────────────────
Write-Host "`n§6 挂件上的 ✕（只收窗口，不动开关）" -ForegroundColor Yellow
# ⚠️ 先确保"开着"（上一节可能把它关了，那样这条就验不出"收一下 ≠ 关掉"）
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){c.widget.enabled=true;return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_open').then(function(){return 'ok';})")
$null = (Wait-Until { WidgetVisible } 6000)
$closePos = (EvalWidget "(function(){var e=document.querySelector('[data-widget-close]'); if(!e) return ''; var r=e.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()")
if ($closePos -match '^(\d+),(\d+)$') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action mouse -X ([int]$Matches[1]) -Y ([int]$Matches[2]) -Clicks 1 -Port $Port -TargetTitle $WIDGET -RequireSelector '[data-widget]' | Out-Null
}
$closed = Wait-Until { -not (WidgetVisible) } 8000
Check "★ 真实鼠标点 ✕ → 挂件收起来了" $closed
$stillOn = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled});})"
Check "★★ 但**开关还是开的**（收一下 ≠ 把功能关掉 —— 设计如此）" ($stillOn.enabled -eq $true) ($stillOn | ConvertTo-Json -Compress)

# ─────────────────────── §7 收尾：还原他的设置 ───────────────────────
Write-Host "`n§7 收尾（还原他的挂件设置）" -ForegroundColor Yellow
$restoreJs = @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.widget = $widgetBeforeJson;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@
$null = (EvalMain $restoreJs)
Start-Sleep -Seconds 2
$after = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({enabled:c.widget.enabled, size:c.widget.size, layer:c.widget.layer, show:c.widget.show, pos:c.widget.pos});})"
$afterJson = ($after | ConvertTo-Json -Compress -Depth 5)
Check ("★ 设置已完整还原（{0}）" -f $afterJson) ($afterJson -eq $widgetBeforeJson)
# 他原来是关着的 → 收掉挂件
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_apply').then(function(){return 'ok';})")
Start-Sleep -Seconds 1
Check "★ 挂件已按他的设置收好" ((-not (WidgetVisible)) -or $enabledBefore) ("visible=" + (WidgetVisible))

Write-Host "`n========== E 批验收：通过 $pass，失败 $fail ==========" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
} catch {
  # 🔴 **脚本崩了也要打出小结**（2026-10-02 在 v2a/v2b/v2c 上踩到、2026-10-03 又栽在 v2e 上：
  #    未捕获异常 → 整套脚本当场退出、连成绩行都没有 → `regress.ps1` 报"没读到成绩行"，
  #    看起来像"套件没跑"，其实是"跑崩了"。）
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("========== E 批验收（异常中断）：通过 $pass，失败 $fail ==========") -ForegroundColor Red
  exit 1
}
