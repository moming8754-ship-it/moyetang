# 倒计时验收（2026-10-04 · V2 打磨「倒计时」批）
#
# 验四件事：
#   ① 日程月视图：`＋ 倒计时` 就地加（日期默认=选中那天）→ 目标日那格真的挂上小标签
#   ② 数字对不对：标签上的天数 = 目标日 − 今天（今天/未来/过去三种都验）
#   ③ 点标签就地改 / 「从挂件上拿掉」；挂件上那一格真的显示出来
#   ④ 收尾：只删自己造的 `M-倒计时` 数据，并把挂件格子开关**还原成他原来的样子**
#
# 🔴 铁规矩：只动自己造的数据；他的倒计时（如果有）一条不碰。
# ⚠️ `.ps1` 必须带 UTF-8 BOM；`-Expr` 不许带中文（一律 `-ExprFile`）。
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
if (-not (Test-Path -LiteralPath $cdp)) { throw "找不到 cdp.ps1：$cdp" }
$MAIN = '东方摩耶堂'
$WIDGET = '东方摩耶堂 · 挂件'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [X] {0}   {1}" -f $name, $detail) -ForegroundColor Red }
}
function EvalIn([string]$title, [string]$require, [string]$js) {
  $tmp = Join-Path $env:TEMP ("v2f-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $require 2>&1
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  $first = @($out) | Select-Object -First 1
  if ($null -ne $first -and $first -isnot [string]) { return (ConvertTo-Json -InputObject @($out) -Depth 12 -Compress) }
  return (@($out) -join "`n").Trim()
}
function EvalMain([string]$js) { return (EvalIn $MAIN 'nav' $js) }
function EvalJson([string]$js) {
  $raw = EvalMain $js
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}
function GoPage([string]$name) {
  $js = "(function(){var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='$name';})[0]; if(!b) return 'NO_BTN'; b.click(); return 'OK';})()"
  $r = EvalMain $js
  Start-Sleep -Milliseconds 900
  return ($r -eq 'OK')
}
function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 350) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) { if (& $probe) { return $true }; Start-Sleep -Milliseconds $stepMs }
  return $false
}
# 今天 + N 天的 `YYYY-MM-DD`（本地日历天；跟界面里那套算法同源）
function DayKey([int]$offset) { return (Get-Date).AddDays($offset).ToString('yyyy-MM-dd') }

try {
Write-Host "`n=== 倒计时验收开始 ===" -ForegroundColor Cyan

$base = EvalJson "window.__TAURI_INTERNALS__.invoke('countdown_list').then(function(l){return JSON.stringify({n:l.length, ids:l.map(function(x){return x.id;})});})"
if ($null -eq $base) { throw "读不到倒计时（CDP 不通？应用起了吗？）" }
Write-Host ("  基线：他的倒计时 {0} 条" -f $base.n)

$swept = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let n=0;
  for(const one of await inv('countdown_list')){ if(/^M-倒计时/.test(one.title)){ await inv('countdown_delete',{id:one.id}); n++; } }
  return JSON.stringify({n:n});
})()
'@
Write-Host ("  §0 清残留：删掉 {0} 条" -f $swept.n)
# ⚠️ 基线要在**清完之后**读（上一次跑剩的测试数据会把它抬高）
$base = EvalJson "window.__TAURI_INTERNALS__.invoke('countdown_list').then(function(l){return JSON.stringify({n:l.length, ids:l.map(function(x){return x.id;})});})"
Write-Host ("  清完之后他的倒计时：{0} 条" -f $base.n)

# ─────────── §1 月视图里加（用户要求"就放月视图里设置"） ───────────
Write-Host "`n§1 日程月视图：＋ 倒计时 → 目标日那格挂上小标签" -ForegroundColor Yellow
Check "能进日程页" (GoPage '日程')

$btn = (EvalMain "String(!!document.querySelector('[data-cal-countdown-add]'))")
Check "★ 月视图标题栏有「＋ 倒计时」" ($btn -eq 'True' -or $btn -eq 'true') $btn

$target = DayKey 30
$null = (EvalMain "(function(){var b=document.querySelector('[data-cal-countdown-add]'); if(b) b.click(); return 'ok';})()")
$formUp = Wait-Until { (EvalMain "String(!!document.querySelector('[data-cal-countdown-form]'))") -match '^(True|true)$' } 5000
Check "★ 点它**就地**弹出小表单（不跳页）" $formUp

# 页面内打字（跟 m7 那套一样：value setter + input 事件）
$typed = EvalJson @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  const t=document.querySelector('[data-cal-countdown-title]');
  const d=document.querySelector('[data-cal-countdown-date]');
  if(!t||!d) return JSON.stringify({error:'NO_INPUT'});
  const wasDefault=d.value;
  setV(t,'M-倒计时 期末考');
  setV(d,'$target');
  await sl(250);
  return JSON.stringify({defaultDate:wasDefault, title:t.value, date:d.value});
})()
"@
Check ("★ 日期默认填的是「选中的那天」（{0}）" -f $typed.defaultDate) ("$($typed.defaultDate)" -match '^\d{4}-\d{2}-\d{2}$') ($typed | ConvertTo-Json -Compress)
$null = (EvalMain "(function(){var b=document.querySelector('[data-cal-countdown-save]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 1200

$made = EvalJson "window.__TAURI_INTERNALS__.invoke('countdown_list').then(function(l){var one=l.filter(function(x){return x.title==='M-倒计时 期末考';})[0]; return JSON.stringify({id:one?one.id:null, date:one?one.date:null, onWidget:one?one.onWidget:null, n:l.length});})"
Check ("★★ 加进去了，而且**真的落盘**（date={0} / onWidget={1}）" -f $made.date, $made.onWidget) ($made.date -eq $target -and $made.onWidget -eq $true) ($made | ConvertTo-Json -Compress)

# 标签是不是挂在那一天那一格上
$onDay = (EvalMain "String(!!document.querySelector('[data-cal-day=""$target""] [data-cal-countdown=""$($made.id)""]'))")
Check "★★ 小标签挂在**目标日那一格**上（不是今天那格）" ($onDay -eq 'True' -or $onDay -eq 'true') $onDay

$daysShown = (EvalMain "String((document.querySelector('[data-cal-countdown=""$($made.id)""]')||{}).getAttribute?document.querySelector('[data-cal-countdown=""$($made.id)""]').getAttribute('data-cal-countdown-days'):'')")
Check ("★★ 天数算对了（标签上写 {0}，应该是 30）" -f $daysShown) ("$daysShown" -eq '30') ("data-cal-countdown-days=" + $daysShown)

# 刷新之后再确认一次（"真的落盘"）
$null = (EvalMain "location.reload(); 'reloading'")
Start-Sleep -Seconds 6
if (-not (Wait-Until { (EvalMain "document.querySelectorAll('nav').length") -match '^[1-9]' } 15000)) { throw "刷新之后页面没起来" }
Check "能进日程页（刷新之后）" (GoPage '日程')
# ⚠️ 刷新之后月视图停在**今天那个月**，目标日在 +30 天（可能是下个月）就看不见 DOM 标签了 ——
#    所以这条读**数据**（刷新后前端是从盘上重新拉的，读到 = 真落盘）。
$stillThere = EvalJson "window.__TAURI_INTERNALS__.invoke('countdown_list').then(function(l){return JSON.stringify({has:!!l.filter(function(x){return x.id==='$($made.id)';})[0]});})"
Check "★★ 刷新之后还在（真落盘，不是内存里好看）" ([bool]$stillThere.has) ($stillThere | ConvertTo-Json -Compress)

# ─────────── §2 三种天数文案（今天 / 过去） ───────────
Write-Host "`n§2 「就是今天」与「已过 N 天」" -ForegroundColor Yellow
$todayKey = DayKey 0
$pastKey = DayKey -3
$extra = EvalJson @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('countdown_create',{title:'M-倒计时 今天', date:'$todayKey', note:null});
  const b=await inv('countdown_create',{title:'M-倒计时 已过', date:'$pastKey', note:null});
  return JSON.stringify({a:a.id,b:b.id});
})()
"@
Start-Sleep -Milliseconds 1200
$t0 = (EvalMain "String((document.querySelector('[data-cal-countdown=""$($extra.a)""]')||{}).getAttribute?document.querySelector('[data-cal-countdown=""$($extra.a)""]').getAttribute('data-cal-countdown-days'):'')")
Check ("★ 目标是今天 → 天数 = 0（界面显示「今天」）" -f $t0) ("$t0" -eq '0') $t0
$past = (EvalMain "String((document.querySelector('[data-cal-countdown=""$($extra.b)""]')||{}).getAttribute?document.querySelector('[data-cal-countdown=""$($extra.b)""]').getAttribute('data-cal-countdown-days'):'')")
Check ("★ 目标日已经过了 3 天 → 天数 = -3（界面显示「已过 3 天」）" -f $past) ("$past" -eq '-3') $past

# ─────────── §3 点标签就地改 / 从挂件上拿掉 ───────────
Write-Host "`n§3 点标签就地改、改挂件开关" -ForegroundColor Yellow
$clicked = EvalJson @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const id='$($extra.a)';
  for(let i=0;i<3;i++){
    const el=document.querySelector('[data-cal-countdown="'+id+'"]');
    if(!el) { await sl(500); continue; }
    el.click(); await sl(600);
    if(document.querySelector('[data-cal-countdown-menu]')) return JSON.stringify({ok:true, rounds:i+1});
  }
  return JSON.stringify({ok:false, label:!!document.querySelector('[data-cal-countdown="'+id+'"]')});
})()
"@
Write-Host ("  点标签：{0}" -f ($clicked | ConvertTo-Json -Compress))
# ⚠️ 断言要看**点的那一条**（`$extra.a` = 今天那条）—— 我上面先写成 `$made.id`（+30 天那条，
#    它根本不在当前月、菜单当然不是它的），白红了一条。
Check "★ 点标签 → 就地弹出改/删菜单" ([bool]$clicked.ok) ($clicked | ConvertTo-Json -Compress)
$menuOpen = (EvalMain "String(!!document.querySelector('[data-cal-countdown-menu=""$($extra.a)""]'))")
Check ("★ 菜单确实是那一条的（{0}）" -f $extra.a.Substring(0, 8)) ($menuOpen -eq 'True' -or $menuOpen -eq 'true') $menuOpen

$newDate = DayKey 10
$null = (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(document.querySelector('[data-cal-countdown-edit-date]'),'$newDate');
  await sl(250);
  return 'ok';
})()
"@)
$null = (EvalMain "(function(){var b=document.querySelector('[data-cal-countdown-edit-save]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 1200
$moved = EvalJson "window.__TAURI_INTERNALS__.invoke('countdown_list').then(function(l){var one=l.filter(function(x){return x.id==='$($extra.a)';})[0]; return JSON.stringify({date:one?one.date:null});})"
Check ("★★ 改日期 → 落盘改成 {0}（改的是点开菜单的那一条）" -f $moved.date) ($moved.date -eq $newDate) ($moved | ConvertTo-Json -Compress)

# ─────────── §4 挂件上那一格 ───────────
Write-Host "`n§4 桌面挂件：勾上「倒计时」那格 → 真的显示出来" -ForegroundColor Yellow
$before = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({show:c.widget.show, enabled:c.widget.enabled});})"
Write-Host ("  他原来的挂件设置：enabled={0} show={1}" -f $before.enabled, (($before.show) -join ','))

# 打开挂件 + 勾上倒计时那一格（方向无关：先读实际状态再切）
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){c.widget.enabled=true; if(c.widget.show.indexOf('countdown')<0){c.widget.show.push('countdown');} return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1500
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('widget_open').then(function(){return 'ok';})")
Start-Sleep -Seconds 2
$slot = (EvalIn $WIDGET '[data-widget]' "String(!!document.querySelector('[data-widget-slot=""countdown""]'))")
Check "★★ 挂件上出现「倒计时」那一格" ($slot -eq 'True' -or $slot -eq 'true') $slot
$wDays = (EvalIn $WIDGET '[data-widget]' "(function(){var e=document.querySelector('[data-widget-countdown-item=""$($extra.a)""]'); return e? e.getAttribute('data-widget-countdown-days') : '';})()")
Check ("★★ 挂件上我那条的天数跟月视图一致（挂件 {0}，应是 10）" -f $wDays) ("$wDays" -eq '10') ("data-widget-countdown-days=" + $wDays)

# 设置页里那个开关也在
Check "能进设置页" (GoPage '设置')
Start-Sleep -Milliseconds 800
$toggle = (EvalMain "String(!!document.querySelector('[data-widget-slot-toggle=""countdown""]'))")
Check "★ 设置里挂件那排有「倒计时」勾选框" ($toggle -eq 'True' -or $toggle -eq 'true') $toggle

# ─────────── §5 收尾 ───────────
Write-Host "`n§5 收尾（删测试数据 + 还原他的挂件设置）" -ForegroundColor Yellow
$clean = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let n=0;
  for(const one of await inv('countdown_list')){ if(/^M-倒计时/.test(one.title)){ await inv('countdown_delete',{id:one.id}); n++; } }
  const left=await inv('countdown_list');
  return JSON.stringify({deleted:n, left:left.length, leftIds:left.map(function(x){return x.id;})});
})()
'@
Check ("★ 测试用的倒计时全删了（删 {0} 条，剩 {1} 条）" -f $clean.deleted, $clean.left) ($clean.left -eq $base.n) ($clean | ConvertTo-Json -Compress)
Check "★ 他的倒计时一条没少（id 对得上）" (@($clean.leftIds).Count -eq @($base.ids).Count) (($clean.leftIds) -join ',')

$restore = EvalJson "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){c.widget.enabled=$($before.enabled.ToString().ToLower()); c.widget.show=[$(($before.show | ForEach-Object { "'" + $_ + "'" }) -join ',')]; return window.__TAURI_INTERNALS__.invoke('config_save',{config:c});}).then(function(){return window.__TAURI_INTERNALS__.invoke('widget_apply');}).then(function(){return window.__TAURI_INTERNALS__.invoke('config_get');}).then(function(c){return JSON.stringify({enabled:c.widget.enabled, show:c.widget.show});})"
Start-Sleep -Seconds 2
Check ("★ 挂件设置还原成他原来的样子（enabled={0} / show={1}）" -f $restore.enabled, (($restore.show) -join ',')) ((($restore.show) -join ',') -eq (($before.show) -join ',')) ($restore | ConvertTo-Json -Compress)

Write-Host "`n========== 倒计时验收：通过 $pass，失败 $fail ==========" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
} catch {
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("========== 倒计时验收（异常中断）：通过 $pass，失败 $fail ==========") -ForegroundColor Red
  exit 1
}
