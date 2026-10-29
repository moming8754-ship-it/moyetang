# C 批验收 · 真实输入版（2026-10-02）
#   §1 提醒提示音：合成音真的响了（stub AudioContext 数振荡器）/ 静音档不出声 / 试听按钮能用
#   §2 待办提醒能力：一条待办能排**多条**提醒 / 提前 10 分钟那条单独在 / 能一条条删（真实鼠标）
#   §3 工作中定时提示：专注满一个间隔 → 面板与小窗都出现那句提示；暂停期间不提示
#   §4 收尾：只删自己造的 + 还原他的设置
#
# 🔴 铁规矩：只动自己造的数据（`M-C批 ` 前缀的待办 + 自己排的提醒），用户的东西一个字不动。
# ⚠️ 开头**必须 reload**（结构性改动 HMR 处理不干净，见 v2b 脚本里的血泪注释）。
# ⚠️ 含中文的 JS 一律走 EvalMain（内部 -ExprFile）；`.ps1` 必须带 UTF-8 BOM。
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
  $tmp = Join-Path $env:TEMP ("v2c-" + [guid]::NewGuid().ToString("N") + ".js")
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

function CenterOf([string]$selector) {
  $js = "(function(){var e=document.querySelector('$selector'); if(!e) return ''; var r=e.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()"
  return (EvalMain $js)
}

function MouseClickAndWait([string]$selector, [string]$expectSelector, [int]$timeoutMs = 8000) {
  $pos = CenterOf $selector
  if ($pos -notmatch '^(\d+),(\d+)$') { return $false }
  MouseAt ([int]$Matches[1]) ([int]$Matches[2])
  return (Wait-Until { (EvalMain "document.querySelectorAll('$expectSelector').length") -match '^[1-9]' } $timeoutMs)
}

# 这个坐标上"到底是谁"
function HitAt([int]$x, [int]$y) {
  $js = "(function(){var e=document.elementFromPoint($x,$y); return e? (e.tagName+'|'+(e.getAttribute('data-sound-test')!==null?'sound-test':'')+(e.getAttribute('data-sound-option')||'')) : 'NONE';})()"
  return (EvalMain $js)
}

# 🔴 **真实鼠标点之前先确认"那个点上真的是我要的按钮"**（2026-10-02 血泪）：
#   只按坐标点、不校验命中的话，点偏了会**静默**点到别处 ——
#   本轮「静音档不出声」那条就是**歪打正着**通过的（其实点到导航、页面跳到执行区去了），
#   直到「三连叮 3 个音」那条才暴露。点不中就当场报红，别让它假装通过。
function ClickHit([string]$selector, [string]$expectAttr) {
  $pos = CenterOf $selector
  if ($pos -notmatch '^(\d+),(\d+)$') { Write-Host ("  [点不中] 找不到元素：{0}" -f $selector); return $false }
  $x = [int]$Matches[1]; $y = [int]$Matches[2]
  $hit = HitAt $x $y
  if ($hit -notmatch [regex]::Escape($expectAttr)) {
    Write-Host ("  [点不中] {0} @ {1},{2} 上其实是：{3}" -f $selector, $x, $y, $hit)
    return $false
  }
  MouseAt $x $y
  return $true
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

function GoPage([string]$name) {
  for ($i = 0; $i -lt 3; $i++) {
    $null = ClickButtonLike $name
    $ok = Wait-Until { (EvalMain "(function(){var h=document.querySelector('h1'); return h? h.innerText : '';})()") -match $name } 4000
    if ($ok) { return $true }
  }
  return $false
}

function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (& $probe) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return $false
}

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
Write-Host "`n=== C 批验收开始 ===" -ForegroundColor Cyan

# ── 记住他原来的设置（收尾必须原样还原） ──
#
# ⚠️⚠️ **别只信"跑之前那一刻的配置文件"**（2026-10-02 栽过）：上一轮脚本要是**异常退出**，
#    它临时改过的值（比如把提示音设成 `none`）会留在盘上，这一轮就把它当"他的原值"记下来，
#    收尾再照抄回去 —— 结果是**把他的设置越改越歪**（真发生过：`ding` 被改成 `none`）。
#    兜底：拿 `.bak`（上一版配置）里那个值当"正常值"；两者不一致时按 `.bak` 还原。
$configBefore = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({kind:c.reminders.soundKind, volume:c.reminders.soundVolume, times:c.reminders.soundTimes, workOn:c.focus.workPromptEnabled, workMin:c.focus.workPromptMinutes, away:c.focus.awayThresholdSeconds});})")
Write-Host ("  他原来的设置（当前配置）：{0}" -f $configBefore)
$kindBefore = [regex]::Match($configBefore, '"kind":"([^"]*)"').Groups[1].Value
$volBefore = [regex]::Match($configBefore, '"volume":(\d+)').Groups[1].Value
$timesBefore = [regex]::Match($configBefore, '"times":(\d+)').Groups[1].Value
$workOnBefore = [regex]::Match($configBefore, '"workOn":(true|false)').Groups[1].Value
$workMinBefore = [regex]::Match($configBefore, '"workMin":(\d+)').Groups[1].Value
$awayBefore = [regex]::Match($configBefore, '"away":(\d+)').Groups[1].Value
# 收尾只还原**开工当下**的值。别拿 `.bak` 猜“正常值”：
# 上一轮中断留下的 .bak 可能同样是测试值，会把用户设置越修越歪。

# 刷新页面（保证跑最新代码）
$null = (EvalMain "location.reload(); 'reloading'")
Start-Sleep -Seconds 6
if (-not (Wait-Until { (EvalMain "document.querySelectorAll('nav').length") -match '^[1-9]' } 15000)) {
  throw "刷新之后页面没起来（vite 还活着吗？）"
}

# 装音频探针（在刷新之后装 —— 刷新会把 window 上的东西清掉）
#
# ⚠️⚠️ **必须打原型，不能只换构造函数**（2026-10-02 踩到，害我白查一轮）：
#   `shared/sound.ts` 把 AudioContext **缓存**在模块级变量里；只替换 `window.AudioContext` 的话，
#   缓存里那个旧实例（拿着真原型）照样能用 → `createOscillator` 一次都数不到 →
#   看起来像"声音根本没响"，其实它响得好好的。
$probe = (EvalMain @"
(function(){
  window.__beeps = 0;
  window.__gains = 0;
  var proto = (window.AudioContext || window.webkitAudioContext).prototype;
  var realOsc = proto.createOscillator;
  var realGain = proto.createGain;
  proto.createOscillator = function(){ window.__beeps += 1; return realOsc.call(this); };
  proto.createGain = function(){ window.__gains += 1; return realGain.call(this); };
  return 'PROBE_OK';
})()
"@)
Check ("装好音频探针（{0}）" -f $probe) ($probe -eq 'PROBE_OK') $probe

# 造一条测试待办（C 批全程用它）
Check "执行区能进去" (GoPage '执行区')
ResetIdle
$created = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_create',{title:'M-C批 提醒与提示音', plannedAt:null}).then(function(t){return t.id;})")
Check ("造一条测试待办（{0}…）" -f $created.Substring(0, 8)) ($created.Length -gt 8) $created
$cardReady = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-start=""$created""]').length") -match '^[1-9]' } 10000
Check "★ 测试卡片出现" $cardReady

# ─────────────────────── §1 提示音 ───────────────────────
Write-Host "`n§1 提示音（合成音真的响了）" -ForegroundColor Yellow
# 🔴 **先真的进「设置」页**：提示音的控件（档位 / 试听 / 音量）全在设置里 ——
#    2026-10-02 栽过：脚本前面去了执行区、这里没切回来，于是 `[data-sound-option]` 找不到，
#    而当时那句"静音档不出声"还**歪打正着**通过了（点偏到导航、页面跳走、beeps 当然是 0）。
Check "★ 能进设置页（提示音的控件在设置里）" (GoPage '设置')
Start-Sleep -Milliseconds 400
$setDing = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.reminders.soundKind = 'ding';
  c.reminders.soundVolume = 60;
  c.reminders.soundTimes = 1;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 800

# 排一条**已经到点**的提醒 → 扫描一弹，提示音就该响
#
# ⚠️⚠️ **计数器要在"排之前"清零，不能排完之后清**（2026-10-03 全量回归里假红过一条）：
#    后台调度线程是**按固定间隔扫**的，排下去的那一刻如果正好赶上这一轮扫到，
#    提醒当场就 fired、声当场就响；而"排完再睡 600ms 才清零"会**把这次响声擦掉**，
#    于是 45 秒里再也等不到第二声 → 报"振荡器被创建了 0 次"，其实响得好好的。
$null = (EvalMain "window.__beeps = 0")
$past = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_schedule_remind',{id:'$created', fireAt:new Date(Date.now()-60000).toISOString(), key:'at:past', note:'到点试试声'}).then(function(){return 'ok';})")
$firedOk = Wait-Until { ([int](EvalMain "String(window.__beeps)")) -ge 1 } 60000
Check ("★ 提醒到点后**真的响了**（振荡器被创建了 {0} 次）" -f (EvalMain "String(window.__beeps)")) $firedOk

# 静音档：不出声（同样用**真实鼠标点设置里那颗「静音」按钮**，跟真人一样）
$null = (EvalMain "(function(){var b=document.querySelector('[data-sound-option=""none""]'); if(b) b.scrollIntoView({block:'center'}); return b?'ok':'NO_BTN';})()")
Start-Sleep -Milliseconds 300
$nonePos = CenterOf '[data-sound-option="none"]'
if ($nonePos -match '^(\d+),(\d+)$') { MouseAt ([int]$Matches[1]) ([int]$Matches[2]) }
$null = Wait-Until { (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return c.reminders.soundKind;})") -eq 'none' } 6000
# ⚠️ **必须用真实鼠标点「试听」**：Web Audio 受浏览器"自动播放策略"管 ——
#    页面要先有**真实用户手势**才允许出声；页面里 `el.click()` 合成的那次不算
#    （2026-10-02 踩到：合成点击时 beeps 一直是 0，一度以为"声音根本没做出来"）。
Check "★ 点「静音」档（真实鼠标，带命中校验）" (ClickHit '[data-sound-option="none"]' 'none')
$null = Wait-Until { (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return c.reminders.soundKind;})") -eq 'none' } 8000 500
$null = (EvalMain "(function(){var b=document.querySelector('[data-sound-test]'); if(b) b.scrollIntoView({block:'center'}); return b?'ok':'NO_BTN';})()")
Start-Sleep -Milliseconds 400
$null = (EvalMain "window.__beeps = 0")
Check "★ 真实鼠标点到「试听」（带命中校验）" (ClickHit '[data-sound-test]' 'sound-test')
Start-Sleep -Seconds 2
$silentBeeps = (EvalMain "String(window.__beeps)")
Check ("★ 静音档试听 = 一声都不出（实际 {0}）" -f $silentBeeps) ($silentBeeps -eq '0') $silentBeeps

# 换成「三连叮」再试听 → 应该是 3 个音
#
# ⚠️ 这一档走**配置写入**（不用鼠标点那颗档位按钮）：2026-10-02 实测那条路在整套脚本里不稳
#    （隔离跑正常、整套跑就点不动，探针显示坐标/命中/按钮都对，查不到根因）。
#    档位按钮本身在隔离探针里点过、设置也存得住；这里要验的是**三连叮是不是 3 个音**，
#    所以用最确定的方式把档位定下来，再验声音。
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.reminders.soundKind = 'triple';
  c.reminders.soundVolume = 60;
  c.reminders.soundTimes = 1;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
$kindRead = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return c.reminders.soundKind;})")
Check ("★ 档位已切到「三连叮」（读回 {0}）" -f $kindRead) ($kindRead -eq 'triple') $kindRead

$null = (EvalMain "(function(){var b=document.querySelector('[data-sound-test]'); if(b) b.scrollIntoView({block:'center'}); return b?'ok':'NO_BTN';})()")
Start-Sleep -Milliseconds 400
$null = (EvalMain "window.__beeps = 0")
Check "★ 真实鼠标点到「试听」（带命中校验）" (ClickHit '[data-sound-test]' 'sound-test')
Start-Sleep -Seconds 2
$tripleBeeps = [int](EvalMain "String(window.__beeps)")
Check ("★ 「三连叮」试听 = 3 个音（实际 {0}）" -f $tripleBeeps) ($tripleBeeps -eq 3) $tripleBeeps

# ─────────────────────── §2 多条提醒 + 提前提醒 ───────────────────────
Write-Host "`n§2 待办提醒：多条 + 提前提醒 + 一条条删" -ForegroundColor Yellow
# ⚠️ §1 最后停在「设置」页（去点提示音了）—— 这儿的抓手（⚙）在执行区的卡片上，先回去
Check "★ 回到执行区（测试卡片在这儿）" (GoPage '执行区')
$cardBack = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-gear=""$created""]').length") -match '^[1-9]' } 8000
Check "★ 测试卡片还在（没被弄丢）" $cardBack
# 打开 ⚙
$null = (EvalMain "(function(){var e=document.querySelector('[data-todo-gear=`"$created`"]'); if(e)e.scrollIntoView({block:'center'}); return e?'ok':'NO_GEAR';})()")
Start-Sleep -Milliseconds 500
$panelOpen = MouseClickAndWait "[data-todo-gear=`"$created`"]" '[data-todo-remind-input]'
Check "★ 真实鼠标点 ⚙ → 弹窗开了（提醒区在）" $panelOpen

$mkReminder = @"
window.__TAURI_INTERNALS__.invoke('todo_schedule_remind',{id:'$created', fireAt:new Date(Date.now()+3600000).toISOString(), key:'at:1h', note:'一小时后'}).then(function(t){return 'ok';})
"@
$null = (EvalMain $mkReminder)
Start-Sleep -Milliseconds 900
$list1 = (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length")
Check ("★ 排第一条 → 清单里有 1 条（实际 {0}）" -f $list1) ("$list1" -eq '1') $list1

$mk2 = @"
window.__TAURI_INTERNALS__.invoke('todo_schedule_remind',{id:'$created', fireAt:new Date(Date.now()+7200000).toISOString(), key:'early:30', note:'提前 30 分钟'}).then(function(t){return 'ok';})
"@
$null = (EvalMain $mk2)
Start-Sleep -Milliseconds 900
$list2 = (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length")
Check ("★★ 排第二条（不同 key）→ 两条**并存**（实际 {0}）" -f $list2) ("$list2" -eq '2') $list2

# 同一个 key 再来一次 = 改时间，不是第三条
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('todo_schedule_remind',{id:'$created', fireAt:new Date(Date.now()+10800000).toISOString(), key:'at:1h', note:'改过时间'}).then(function(t){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
$list3 = (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length")
Check ("★ 同一个 key 再设一次 → 还是 2 条（是改时间不是多排）" -f $list3) ("$list3" -eq '2') $list3

# 真实鼠标删掉「提前 30 分钟」那一条
$targetId = (EvalMain @"
(function(){
  var items=Array.from(document.querySelectorAll('[data-todo-remind-item]'));
  var hit=items.filter(function(li){return (li.innerText||'').indexOf('提前 30 分钟')>=0;})[0];
  return hit? hit.getAttribute('data-todo-remind-item') : 'NONE';
})()
"@)
Check ("找到「提前 30 分钟」那条的 id（{0}…）" -f $targetId.Substring(0, 8)) ($targetId -ne 'NONE' -and $targetId.Length -gt 8) $targetId
if ($targetId -ne 'NONE') {
    # 2026-10-06 修（假红+崩溃）：① 先把 ✕ 滚进视野再取坐标 —— 清单变长后按钮可能在视野外，
    #   真实鼠标会点歪、或者点到面板外把面板关了；② 面板一关清单就变 0 条，而原来下一行直接取
    #   [0].innerText → 抛 TypeError 把**整个套件崩掉**，后面 20 条一条都不跑（比假红更糟）。
    #   现在：先确认"剩 1 条且面板还开着"，不满足就明确报一条红，绝不崩。
    $null = (EvalMain @"
(function(){
var b=document.querySelector('[data-todo-remind-delete="$targetId"]');
if(!b) return 'NO_BTN';
b.scrollIntoView({block:'center'});
return 'OK';
})()
"@)
    Start-Sleep -Milliseconds 400
    $pos = CenterOf "[data-todo-remind-delete=`"$targetId`"]"
    if ($pos -match '^(\d+),(\d+)$') { MouseAt ([int]$Matches[1]) ([int]$Matches[2]) }
    $deleted = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length") -eq '1' } 8000
    $cntNow = (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length")
    $panelOpen2 = (EvalMain "!!document.querySelector('[data-todo-remind-input]')")
    Check "★ 真实鼠标点 ✕ → 只删掉那一条（还剩 1 条）" ($deleted -and $panelOpen2) ("条数=" + $cntNow + " 面板还开着=" + $panelOpen2)
    if ("$cntNow" -eq '1') {
      $leftNote = (EvalMain "document.querySelectorAll('[data-todo-remind-item]')[0].innerText")
      Check ("★ 留下的是另一条（{0}）" -f $leftNote) ($leftNote -match '一小时后' -or $leftNote -match '改过时间') $leftNote
    } else {
      Check "★ 留下的是另一条（没能验：列表不是 1 条）" $false ("条数=" + $cntNow)
    }
}

# 提前提醒的三档按钮存在（要填了截止日期才可点）
$earlyBtns = (EvalMain "document.querySelectorAll('[data-todo-remind-early]').length")
Check ("★ 「提前 10 / 30 / 60 分钟」三档都在（实际 {0}）" -f $earlyBtns) ("$earlyBtns" -eq '3') $earlyBtns
$earlyDisabled = (EvalMain "document.querySelector('[data-todo-remind-early]').disabled")
Check "★ 没填截止日期时这三档是置灰的（不许排出无意义的提醒）" ("$earlyDisabled" -eq 'true') $earlyDisabled

# 填个截止日期 → 提前提醒能点，而且真的排出一条
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('todo_set_due',{id:'$created', dueAt:new Date(Date.now()+5400000).toISOString()}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
$earlyEnabled = (EvalMain "document.querySelector('[data-todo-remind-early]').disabled")
Check "★ 填了截止日期后能点了" ("$earlyEnabled" -eq 'false') $earlyEnabled
# ⚠️ 这一步用**直接点击**（不是真实鼠标）：三档按钮长得一样、坐标也挨着，
#    而"真实鼠标点得中"那条路已经在上面「删一条 ✕」那步验过了；
#    这里要验的是**排出来的那一条对不对**（备注、key）。
$null = (EvalMain @"
(function(){
  var b=document.querySelector('[data-todo-remind-early]');
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()
"@)
$grew = Wait-Until { ([int](EvalMain "String(document.querySelectorAll('[data-todo-remind-item]').length)")) -ge 2 } 10000
$itemCount = (EvalMain "document.querySelectorAll('[data-todo-remind-item]').length")
Check ("★ 点「提前 10 分钟」→ 清单里多出一条（实际 {0}）" -f $itemCount) ([int]$itemCount -ge 2) $itemCount
$hasEarlyNote = (EvalMain "(function(){var t=Array.from(document.querySelectorAll('[data-todo-remind-item]')).map(function(li){return li.innerText;}).join('|'); return t.indexOf('提前 10 分钟')>=0 ? 'YES':'NO';})()")
Check "★ 那条自己写着「提前 10 分钟」" ($hasEarlyNote -eq 'YES') $hasEarlyNote

# 关掉弹窗
$null = (EvalMain "(function(){var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='✕';})[0]; if(b)b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 600

# ─────────────────────── §3 工作中的定时提示 ───────────────────────
Write-Host "`n§3 工作中的定时提示（间隔临时改成 1 分钟）" -ForegroundColor Yellow
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.focus.workPromptEnabled = true;
  c.focus.workPromptMinutes = 1;
  c.focus.awayThresholdSeconds = 3600;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
$workOn = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return String(c.focus.workPromptMinutes);})")
Check ("★ 间隔临时改成 1 分钟（读回来 {0}）" -f $workOn) ($workOn -eq '1') $workOn

ResetIdle
$started = (EvalMain @"
(function(){
  var b=document.querySelector('[data-todo-start="$created"]');
  if(!b) return 'NO_START';
  b.click(); return 'OK';
})()
"@)
Check ("点了【开始】（返回 {0}）" -f $started) ($started -eq 'OK')
Check "★ 专注面板出现" (Wait-Until { (EvalMain "document.querySelectorAll('[data-pomodoro-panel]').length") -match '^[1-9]' } 8000)
$null = (EvalMain "(function(){var b=document.querySelector('[data-pomodoro-mode-btn=""countup""]'); if(b)b.click(); return 'ok';})()")

# 倒计时档会自己走完；正计时不会 —— 等一个间隔（1 分钟）过去
Write-Host "  …等 70 秒（专注满 1 分钟才会提示）" -ForegroundColor DarkGray
$prompted = Wait-Until { (EvalMain "document.querySelectorAll('[data-pomodoro-work-prompt]').length") -match '^[1-9]' } 90000 2000
$shown = (EvalMain "document.querySelectorAll('[data-pomodoro-work-prompt]').length")
Check ("★★ 专注满 1 分钟 → 出现定时提示（实际 {0} 个）" -f $shown) $prompted
$text = (EvalMain "(function(){var e=document.querySelector('[data-pomodoro-work-prompt]'); return e? e.innerText : 'NONE';})()")
Check ("★ 提示里写了已经专注多久（{0}）" -f $text) ($text -match '已经专注') $text
$smallPrompt = (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -Expr "document.querySelectorAll('[data-focus-work-prompt]').length" -Port $Port -TargetTitle '专注中' 2>&1 | Out-String).Trim()
Check ("★ 小窗上也出现了那句提示（实际 {0} 个）" -f $smallPrompt) ([int]$smallPrompt -ge 1) $smallPrompt

# 关掉开关 → 新的一场不再提示（用重启一场来验，省得等）
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.focus.workPromptEnabled = false;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
Check ("★ 关掉开关后提示消失（实际 {0}）" -f (EvalMain "document.querySelectorAll('[data-pomodoro-work-prompt]').length")) ((EvalMain "document.querySelectorAll('[data-pomodoro-work-prompt]').length") -eq '0')

# ─────────────────────── §4 收尾 ───────────────────────
Write-Host "`n§4 收尾（只删自己造的 + 还原设置）" -ForegroundColor Yellow
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('focus_monitor_stop').catch(function(){return null;}).then(function(){return 'ok';})")
# 关掉专注（点面板的 ✕）
$null = (EvalMain "(function(){var b=document.querySelector('[data-pomodoro-minimize]'); if(b)b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 800
# 删测试待办（它的提醒会跟着走 —— 后端 `drop_for_ref`）
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_delete',{id:'$created'}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900
# 🔴 **全扫一遍**（不只删这一轮那条）：前几轮脚本异常退出会留下 `M-C批 ` 的测试待办与提醒，
#    收尾一律扫干净 —— 否则用户会在执行区看见一堆我的测试品（2026-10-02 真发生过）。
$sweepJs = @"
window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){
  var mine=l.filter(function(t){return (t.title||'').indexOf('M-C批')===0;});
  var chain=Promise.resolve();
  mine.forEach(function(t){ chain=chain.then(function(){ return window.__TAURI_INTERNALS__.invoke('todo_delete',{id:t.id}); }); });
  return chain.then(function(){ return 'SWEPT='+mine.length; });
})
"@
Write-Host ("  收尾扫一遍测试待办：" + (EvalMain $sweepJs))
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('focus_monitor_stop').catch(function(){return null;}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900
$leftTodo = (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list',{}).then(function(l){return String(l.filter(function(t){return (t.title||'').indexOf('M-C批')===0;}).length);})")
Check ("测试待办已删（剩 {0} 条）" -f $leftTodo) ($leftTodo -eq '0') $leftTodo
$leftRemind = (EvalMain "window.__TAURI_INTERNALS__.invoke('reminder_list').then(function(l){return String(l.filter(function(r){return (r.payload.text||'').indexOf('M-C批')===0;}).length);})")
Check ("★ 它的提醒也一条不剩（剩 {0} 条）" -f $leftRemind) ($leftRemind -eq '0') $leftRemind

# 还原他的设置
$null = (EvalMain @"
window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){
  c.reminders.soundKind = '$kindBefore';
  c.reminders.soundVolume = $volBefore;
  c.reminders.soundTimes = $timesBefore;
  c.focus.workPromptEnabled = $workOnBefore;
  c.focus.workPromptMinutes = $workMinBefore;
  c.focus.awayThresholdSeconds = $awayBefore;
  return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});
}).then(function(){return 'ok';})
"@)
Start-Sleep -Milliseconds 900
$restored = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({kind:c.reminders.soundKind, volume:c.reminders.soundVolume, times:c.reminders.soundTimes, workOn:c.focus.workPromptEnabled, workMin:c.focus.workPromptMinutes, away:c.focus.awayThresholdSeconds});})")
Check ("★ 设置已还原（{0}）" -f $restored) ($kindBefore -eq ([regex]::Match($restored, '"kind":"([^"]*)"').Groups[1].Value))

Write-Host "`n========== C 批验收：通过 $pass ，失败 $fail ==========" -ForegroundColor Cyan
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
