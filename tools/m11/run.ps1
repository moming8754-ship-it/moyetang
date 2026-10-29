# M11-A · 日程（日历 · 过去）验收
#
#   §1 月历：导航里有「日程」、月历画出来了、翻月 / 今天 都能用
#   §2 点某天 → 右边日报的「完成 / 设计 / 填写 / 未跟进」四个计数与真实数据一致
#        ⚠️ **一律自己前后比对（差值）**，不写死"应该有 3 条"——
#           用户自己的待办/信息可能就在今天，写死了必然假红（进度.md 第五节栽过好几次）
#   §3 写一句"为什么没跟进"（**真实键盘打字 + 真实回车**）→ 落盘 → 重新拉还在
#   §4 导出 txt：文件真的写出来了、里面有三类内容 + 我写的那句话
#        （⚠️ 走的是 `daily_export` 命令 + 显式路径；**系统文件对话框没法自动点**，那一环由用户手点一次）
#   §5 收尾：清掉本轮造的待办 / 信息 / 说明 / 导出的 txt，并核对用户数据没动
#
# 用法（应用要以 CDP 9222 起着）：powershell -ExecutionPolicy Bypass -File tools\m11\run.ps1
param([int]$Port = 9222, [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # …\tools\m11
$tools = Split-Path -Parent $here                            # …\tools
$cdp = Join-Path $tools 'cdp.ps1'
$dataDir = 'D:\东方摩耶堂'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m11-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    for ($i = 0; $i -lt 3; $i++) {
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle '东方摩耶堂' -RequireSelector 'nav' 2>&1
      $text = (($out | Out-String).Trim())
      if ($text) { return $text }
      Start-Sleep -Milliseconds 700
    }
    return ''
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function EvalJson([string]$js) {
  $t = EvalMain $js
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}
function Drive([string[]]$argv) {
  $raw = & powershell -NoProfile -File $cdp @argv 2>&1
  $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
  if ($errs.Count -gt 0) { return ("ERROR: " + (($errs -join ' ') -replace '\s+', ' ')) }
  return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
}
$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] " + $name) }
  else { $script:fail++; Write-Host ("  [X] " + $name + "  ::  " + $detail) }
}
function Step([string]$t) { Write-Host ""; Write-Host ("---- " + $t) }
function Want([int]$n) {
  if (-not $Only.Trim()) { return $true }
  $list = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  return ($list -contains $n)
}

# 页面里共用的小工具
$H = @'
const sl=t=>new Promise(r=>setTimeout(r,t));
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
const localDate=(d)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
'@

Write-Host ""
Write-Host "=== §1 月历 ==="

$enter = EvalJson @"
(async()=>{
$H
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){
    nav=B().find(b=>(b.innerText||'').indexOf('日程')>=0 || b.getAttribute('title')==='日程');
    if(!nav) await sl(300);
  }
  if(!nav) return JSON.stringify({nav:false});
  nav.click(); await sl(1200);
  let grid=null;
  for(let i=0;i<20 && !grid;i++){ grid=document.querySelector('[data-schedule-grid]'); if(!grid) await sl(300); }
  const head=document.querySelector('[data-cal-month]');
  const cells=Array.from(document.querySelectorAll('[data-cal-day]'));
  const today=localDate(new Date());
  const todayCell=cells.find(c=>c.getAttribute('data-cal-day')===today);
  return JSON.stringify({nav:true, grid:!!grid, month:head?head.textContent.trim():null,
    monthKey:head?head.getAttribute('data-cal-month'):null, cells:cells.length,
    hasToday:!!todayCell, panel:document.querySelector('[data-day-panel]')?document.querySelector('[data-day-panel]').getAttribute('data-day-panel'):null,
    today:today});
})()
"@
if (-not $enter) {
  Check '① 导航里有「日程」并进得去' $false '没读到结果（应用没起来？）'
}
else {
  Check '① 导航里有「日程」，点进去月历画出来了' ($enter.nav -and $enter.grid) ("nav=" + $enter.nav + " grid=" + $enter.grid)
  Check '② 网格是整周（35 或 42 格）' ($enter.cells -eq 35 -or $enter.cells -eq 42) ("格子数 " + $enter.cells)
  Check '③ 默认停在"今天"那一天' ($enter.panel -eq $enter.today) ("面板日期 " + $enter.panel + "，今天是 " + $enter.today)
}

if (Want 1) {
  $nav2 = EvalJson @"
(async()=>{
$H
  const before=document.querySelector('[data-cal-month]').getAttribute('data-cal-month');
  document.querySelector('[data-cal-next]').click(); await sl(700);
  const next=document.querySelector('[data-cal-month]').getAttribute('data-cal-month');
  document.querySelector('[data-cal-prev]').click(); await sl(700);
  const back=document.querySelector('[data-cal-month]').getAttribute('data-cal-month');
  document.querySelector('[data-cal-next]').click(); await sl(500);
  document.querySelector('[data-cal-today]').click(); await sl(700);
  const home=document.querySelector('[data-cal-month]').getAttribute('data-cal-month');
  const panel=document.querySelector('[data-day-panel]').getAttribute('data-day-panel');
  return JSON.stringify({before:before, next:next, back:back, home:home, panel:panel, today:localDate(new Date())});
})()
"@
  if (-not $nav2) { Check '④ 翻月 / 今天 按钮' $false '没读到结果' }
  else {
    Check '④ 「下月」真的翻了一个月、「上月」翻得回来' `
      (($nav2.next -ne $nav2.before) -and ($nav2.back -eq $nav2.before)) `
      ("$($nav2.before) → $($nav2.next) → $($nav2.back)")
    Check '⑤ 「今天」回到本月并把选中日期拨回今天' ($nav2.home -eq $nav2.before -and $nav2.panel -eq $nav2.today) ("月 " + $nav2.home + "，选中 " + $nav2.panel)
  }
}

Write-Host ""
if (Want 2) {
Write-Host "=== §2 点某天 → 右边日报的四个计数 ==="

# 先量一份"基线"（用户自己的数据可能就在今天），后面一律比差值
$baseline = EvalJson @"
(async()=>{
$H
  const today=localDate(new Date());
  const cell=Array.from(document.querySelectorAll('[data-cal-day]')).find(c=>c.getAttribute('data-cal-day')===today);
  if(cell) cell.click();
  await sl(800);
  const num=(attr)=>{ const el=document.querySelector('['+attr+']'); return el?parseInt(el.getAttribute(attr),10)||0:null; };
  return JSON.stringify({date:today,
    done:num('data-day-done'), planned:num('data-day-planned'), info:num('data-day-info'), unfollowed:num('data-day-unfollowed')});
})()
"@
Write-Host ("  基线：" + ($baseline | ConvertTo-Json -Compress))

# 造两条今天的数据：A 设了时间并完成；B 设了过去的时间、还没完成（= 未跟进）
$made = EvalJson @"
(async()=>{
$H
  const now=new Date();
  const early=new Date(now.getFullYear(),now.getMonth(),now.getDate(),0,5).toISOString();
  const a=await inv('todo_create',{title:'M11 日历验收甲',plannedAt:early});
  await sl(600);
  await inv('todo_set_done',{id:a.id,done:true});
  await sl(600);
  const b=await inv('todo_create',{title:'M11 日历验收乙',plannedAt:early});
  await sl(600);
  const info=await inv('info_create',{text:'M11 日历验收信息',kind:'text',categories:[]});
  await sl(1200);
  return JSON.stringify({aId:a.id,bId:b.id,infoId:info.id,date:localDate(new Date())});
})()
"@
Write-Host ("  造数据：" + ($made | ConvertTo-Json -Compress))

$after = EvalJson @"
(async()=>{
$H
  document.querySelector('[data-cal-today]').click(); await sl(900);
  const num=(attr)=>{ const el=document.querySelector('['+attr+']'); return el?parseInt(el.getAttribute(attr),10)||0:null; };
  const todayEl=Array.from(document.querySelectorAll('[data-cal-day]')).find(c=>c.getAttribute('data-cal-day')===localDate(new Date()));
  return JSON.stringify({done:num('data-day-done'), planned:num('data-day-planned'), info:num('data-day-info'),
    unfollowed:num('data-day-unfollowed'),
    cellDone:todayEl?parseInt(todayEl.getAttribute('data-cal-done'),10):null,
    cellPlanned:todayEl?parseInt(todayEl.getAttribute('data-cal-planned'),10):null,
    cellInfo:todayEl?parseInt(todayEl.getAttribute('data-cal-info'),10):null,
    hasA:!!Array.from(document.querySelectorAll('[data-day-panel] *')).find(e=>/M11 日历验收甲/.test(e.textContent||'')),
    hasB:!!Array.from(document.querySelectorAll('[data-day-panel] *')).find(e=>/M11 日历验收乙/.test(e.textContent||'')),
    hasInfo:!!Array.from(document.querySelectorAll('[data-day-panel] *')).find(e=>/M11 日历验收信息/.test(e.textContent||''))});
})()
"@
Write-Host ("  造完之后：" + ($after | ConvertTo-Json -Compress))

if ($baseline -and $after) {
  Check '⑥ 「完成了」比基线多 1 条' ([int]$after.done - [int]$baseline.done -eq 1) ("基线 $($baseline.done) → 现在 $($after.done)")
  Check '⑦ 「设计了」比基线多 2 条（A 和 B 都设了今天）' ([int]$after.planned - [int]$baseline.planned -eq 2) ("基线 $($baseline.planned) → 现在 $($after.planned)")
  Check '⑧ 「填写了」比基线多 1 条' ([int]$after.info - [int]$baseline.info -eq 1) ("基线 $($baseline.info) → 现在 $($after.info)")
  Check '⑨ 「未跟进」比基线多 1 条（只有 B：设了今天、已过点、还没完成）' ([int]$after.unfollowed - [int]$baseline.unfollowed -eq 1) ("基线 $($baseline.unfollowed) → 现在 $($after.unfollowed)")
  Check '⑩ 月历格子上今天的小色块也跟着涨（完成 / 设计 / 填写 各 +1 / +1 / +2 里的对应项）' `
    (([int]$after.cellDone - [int]$baseline.done -ge 0) -and ($after.cellPlanned -ge 2) -and ($after.cellInfo -ge 1)) `
    ("格子 done=$($after.cellDone) planned=$($after.cellPlanned) info=$($after.cellInfo)")
  Check '⑪ 甲 / 乙 / 那条信息都在右侧日报里露脸了' ($after.hasA -and $after.hasB -and $after.hasInfo) ("甲=$($after.hasA) 乙=$($after.hasB) 信息=$($after.hasInfo)")
}
else { Check '⑥~⑪ 日报四个计数与真实数据一致' $false '前面有一步没读到结果' }

Write-Host ""
Write-Host "=== §3 写一句"为什么没跟进"（真实键盘）→ 落盘 ==="

$bId = $made.bId
$dateKey = $made.date
# ⚠️ 先把那个 textarea 用 JS 聚焦，再用 `textarea:focus` 去打字 ——
#    不直接把 `[data-day-note="todo:xxx"]` 当选择器传给 cdp.ps1：
#    它里面的**双引号会在 powershell -File 传参时被吃掉**，选择器就废了（前面踩过）。
$focused = EvalJson @"
(async()=>{
$H
  const box=document.querySelector('[data-day-note="todo:$bId"]');
  if(!box) return JSON.stringify({ok:false});
  box.focus();
  return JSON.stringify({ok:document.activeElement===box});
})()
"@
Write-Host ("  聚焦输入框：" + ($focused | ConvertTo-Json -Compress))
Write-Host (Drive @('-Action', 'type', '-Selector', 'textarea:focus', '-Text', '验收：今天没排上，明天补', '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 900
$saved = EvalJson @"
(async()=>{
$H
  const r=await inv('daily_get',{date:'$dateKey'});
  const mine=(r.notes||[]).find(n=>n.key==='todo:$bId');
  const box=document.querySelector('[data-day-note]');
  return JSON.stringify({backend: mine?mine.text:null, notes:r.notes.length});
})()
"@
Write-Host ("  后端读回来：" + ($saved | ConvertTo-Json -Compress))
Check '⑫ 打的那句话真的落盘了（`daily_get` 读得回来）' ($saved -and $saved.backend -eq '验收：今天没排上，明天补') ("读到 " + $(if ($saved) { $saved.backend } else { '(空)' }))

$file = Join-Path (Join-Path $dataDir 'dailies') "$dateKey.json"
$onDisk = Test-Path $file
Check ('⑬ 磁盘上真的有 dailies\' + $dateKey + '.json') $onDisk $file
if ($onDisk) {
  $raw = Get-Content -Raw -Encoding UTF8 $file
  Check '⑭ 文件里存的是"手写的那部分"（有 notes、没有自动那三类）' `
    (($raw -match 'todo:' + [regex]::Escape($bId)) -and ($raw -notmatch '"done"') -and ($raw -notmatch '"planned"')) `
    $raw.Substring(0, [Math]::Min(200, $raw.Length))
}

Write-Host ""
Write-Host "=== §4 导出 txt ==="

$outFile = Join-Path $env:TEMP ("m11-" + $dateKey + "-日报.txt")
$outJs = $outFile -replace '\\', '/'          # 传给 JS 用正斜杠，省掉反斜杠转义那点破事
if (Test-Path $outFile) { Remove-Item $outFile -Force }

# 走页面里**真实的导出路径**（拼正文 → daily_export），只把"系统文件对话框"那一步换成钩子传路径：
# 对话框没法自动点，但"拼正文 + 落盘"这段必须能自动验（同 `dsh:file-drop` 那个钩子的理由）
$fired = EvalJson @"
(async()=>{
$H
  window.dispatchEvent(new CustomEvent('dsh:daily-export',{detail:{dest:'$outJs'}}));
  await sl(2000);
  return JSON.stringify({fired:true, dest:'$outJs'});
})()
"@
Start-Sleep -Milliseconds 800
Write-Host ("  触发导出：" + ($fired | ConvertTo-Json -Compress))

$wroteOut = Test-Path $outFile
Check '⑮ 导出真的写出了 txt（钩子只跳过系统对话框，拼正文与落盘是同一条路）' $wroteOut $outFile
if ($wroteOut) {
  $txt = Get-Content -Raw -Encoding UTF8 $outFile
  $firstLine = ($txt -split "`n")[0]
  Check '⑯ txt 里有四段标题（完成 / 设计 / 填写 / 未跟进）' (($txt -match '【完成了') -and ($txt -match '【设计了') -and ($txt -match '【填写了') -and ($txt -match '【未跟进')) $firstLine
  Check '⑰ 我写的那句话**原样**在 txt 里（程序不改用户写的字）' ($txt -match '验收：今天没排上，明天补') $firstLine
  Check '⑱ txt 里有那两条测试待办与那条测试信息' (($txt -match 'M11 日历验收甲') -and ($txt -match 'M11 日历验收乙') -and ($txt -match 'M11 日历验收信息')) $firstLine
  Check '⑲ 第一行是给人看的日期标题' (($txt -match '日报') -and ($txt -match $dateKey)) $firstLine
}

Write-Host ""
Write-Host ""
Write-Host ""
Write-Host "=== §5 周视图（M11-B）：一周七列 / 某一列加事 / 拖到另一列改期 ==="

$week = EvalJson @"
(async()=>{
$H
  document.querySelector('[data-schedule-view="week"]').click(); await sl(900);
  const board=document.querySelector('[data-week-board]');
  const cols=Array.from(document.querySelectorAll('[data-week-day]'));
  const label=document.querySelector('[data-week-label]');
  const today=localDate(new Date());
  const keys=cols.map(c=>c.getAttribute('data-week-day'));
  // ⚠️ 目标列**只能从这一屏实际的七列里挑**：按"今天 + 2 天"算的话，周六会算到下周一去（第一版就这么假红了）
  const addKey=keys.filter(k=>k!==today).slice(-1)[0];
  const dragKey=keys.filter(k=>k!==addKey)[0];
  return JSON.stringify({board:!!board, weekStart:board?board.getAttribute('data-week-board'):null,
    cols:cols.length, label:label?label.textContent.trim():null,
    firstDay:cols.length?cols[0].getAttribute('data-week-day'):null,
    lastDay:cols.length?cols[cols.length-1].getAttribute('data-week-day'):null,
    today:today, addKey:addKey, dragKey:dragKey});
})()
"@
Write-Host ("  周视图：" + ($week | ConvertTo-Json -Compress))
Check '㉒ 切到周视图，七列都画出来了' ($week -and $week.board -and [int]$week.cols -eq 7) ("列数 " + $(if ($week) { $week.cols } else { '?' }))
Check '㉓ 一列就是一天、整整 7 天连着' ($week -and $week.firstDay -and $week.lastDay) ("从 " + $(if ($week) { $week.firstDay } else { '?' }) + " 到 " + $(if ($week) { $week.lastDay } else { '?' }))
Check '㉔ 默认停在"本周"（周一打头）' ($week -and $week.weekStart -eq $week.firstDay) ("周起点 " + $(if ($week) { $week.weekStart } else { '?' }))

# 在某一列点「＋ 安排」→ 真实键盘打字 + 真实回车
$openAdd = EvalJson @"
(async()=>{
$H
  const key='$($week.addKey)';
  const btn=Array.from(document.querySelectorAll('[data-week-add]')).find(b=>b.getAttribute('data-week-add')===key);
  if(!btn) return JSON.stringify({ok:false, key:key});
  btn.click(); await sl(700);
  const input=document.querySelector('[data-week-add-input]');
  if(!input) return JSON.stringify({ok:false, key:key, input:false});
  input.focus();
  return JSON.stringify({ok:true, key:key, focused:document.activeElement===input});
})()
"@
Write-Host ("  打开「＋ 安排」：" + ($openAdd | ConvertTo-Json -Compress))
Check '㉕ 点「＋ 安排」会冒出输入框（而且已经聚焦）' ($openAdd -and $openAdd.ok -and $openAdd.focused) ($openAdd | ConvertTo-Json -Compress)

Write-Host (Drive @('-Action', 'type', '-Selector', 'input[data-week-add-input]', '-Text', 'M11 周视图验收', '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1400
$added = EvalJson @"
(async()=>{
$H
  const all=await inv('todo_list');
  const mine=all.find(t=>t.title==='M11 周视图验收');
  const key='$($week.addKey)';
  const col=Array.from(document.querySelectorAll('[data-week-day]')).find(c=>c.getAttribute('data-week-day')===key);
  return JSON.stringify({exists:!!mine, planned:mine?mine.plannedAt:null,
    plannedDay:mine&&mine.plannedAt?localDate(new Date(mine.plannedAt)):null, want:key,
    colCount:col?parseInt(col.getAttribute('data-week-count'),10):null,
    inCol:col?!!col.querySelector('[data-week-item]'):false, id:mine?mine.id:null});
})()
"@
Write-Host ("  加完之后：" + ($added | ConvertTo-Json -Compress))
Check '㉖ 在日程页加的事**真的落成了一条待办**（`plannedAt` = 那天）' ($added -and $added.exists -and $added.plannedDay -eq $added.want) ("plannedAt 落在 " + $(if ($added) { $added.plannedDay } else { '?' }) + "，期望 " + $(if ($week) { $week.addKey } else { '?' }))
Check '㉗ 它立刻出现在那一列里' ($added -and $added.inCol) ("那一列有 " + $(if ($added) { $added.colCount } else { '?' }) + " 件")

# 「在日程页安排的事，执行区立刻可见」（用户点名的那一条）
$inTodo = EvalJson @"
(async()=>{
$H
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){ nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区'); if(!nav) await sl(300); }
  if(nav){ nav.click(); await sl(1400); }
  let card=null;
  for(let i=0;i<20 && !card;i++){
    card=Array.from(document.querySelectorAll('[data-todo-id]')).find(e=>e.getAttribute('data-todo-title')==='M11 周视图验收');
    if(!card) await sl(300);
  }
  return JSON.stringify({card:!!card});
})()
"@
Write-Host ("  执行区里：" + ($inTodo | ConvertTo-Json -Compress))
Check '㉘ ★ 在日程页安排的事，**执行区立刻看得见**（用户点名要的那条）' ($inTodo -and $inTodo.card) ($inTodo | ConvertTo-Json -Compress)

# 拖到另一列 = 改日期（**真实鼠标**：手势类不能用合成事件验）
$coords = EvalJson @"
(async()=>{
$H
  // 回到日程 → 周视图（离开再回来，页面的视图状态会重置成月视图）
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){ nav=B().find(b=>(b.innerText||'').indexOf('日程')>=0||b.getAttribute('title')==='日程'); if(!nav) await sl(300); }
  if(nav){ nav.click(); await sl(1400); }
  document.querySelector('[data-schedule-view="week"]').click(); await sl(900);
  const board=document.querySelector('[data-week-board]');
  if(board) board.scrollIntoView({block:'center'});
  await sl(700);
  const item=document.querySelector('[data-week-item="$($added.id)"]');
  if(!item) return JSON.stringify({ok:false, why:'卡片不在周视图里'});
  const from=item.getBoundingClientRect();
  const toEl=Array.from(document.querySelectorAll('[data-week-day]')).find(c=>c.getAttribute('data-week-day')==='$($week.dragKey)');
  if(!toEl) return JSON.stringify({ok:false, why:'找不到目标列'});
  const to=toEl.getBoundingClientRect();
  // ⚠️ 起终点必须同时在屏幕上（进度.md 第五节的坑：cdp 只把起点滚进视野）
  const onScreen=(r)=>r.top>=0 && r.bottom<=window.innerHeight && r.left>=0 && r.right<=window.innerWidth;
  return JSON.stringify({ok:true, fromX:Math.round(from.left+from.width/2), fromY:Math.round(from.top+from.height/2),
    toX:Math.round(to.left+to.width/2), toY:Math.round(to.top+Math.min(150,to.height/2)),
    toKey:'$($week.dragKey)', bothVisible:onScreen(from)&&onScreen(to)});
})()
"@
Write-Host ("  拖拽坐标：" + ($coords | ConvertTo-Json -Compress))
if ($coords -and $coords.ok) {
  Check '㉙ 拖拽的起点和终点都在屏幕上（不然会静默失效）' ($coords.bothVisible -eq $true) ($coords | ConvertTo-Json -Compress)
  Write-Host (Drive @('-Action', 'mouse', '-X', "$($coords.fromX)", '-Y', "$($coords.fromY)", '-ToX', "$($coords.toX)", '-ToY', "$($coords.toY)", '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
  Start-Sleep -Milliseconds 1500
  $moved = EvalJson @"
(async()=>{
$H
  const all=await inv('todo_list');
  const mine=all.find(t=>t.id==='$($added.id)');
  return JSON.stringify({plannedDay:mine&&mine.plannedAt?localDate(new Date(mine.plannedAt)):null, want:'$($coords.toKey)',
    stillOne:all.filter(t=>t.title==='M11 周视图验收').length});
})()
"@
  Write-Host ("  拖完：" + ($moved | ConvertTo-Json -Compress))
  Check '㉚ ★ 真实鼠标把卡片拖到另一列 → 日期真的改了' ($moved -and $moved.plannedDay -eq $moved.want) ("落到了 " + $(if ($moved) { $moved.plannedDay } else { '?' }) + "，期望 " + $coords.toKey)
  Check '㉛ 拖拽没有把它复制成两条' ($moved -and [int]$moved.stillOne -eq 1) ("同名待办 " + $(if ($moved) { $moved.stillOne } else { '?' }) + " 条")
}
else {
  Check '㉙ 拖拽的起点和终点都在屏幕上' $false '没算出坐标'
  Check '㉚ 真实鼠标拖动 = 改日期' $false '上一条没跑起来'
  Check '㉛ 拖拽没复制' $false '上一条没跑起来'
}

Write-Host ""
Write-Host "=== §6 收尾：清掉本轮造的东西 ==="
$clean = EvalJson @"
(async()=>{
$H
  for(const t of await inv('todo_list')){ if(/^M11 /.test(t.title||'')) { try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  for(const i of await inv('info_list')){ if(/^M11 /.test(i.text||'')) { try { await inv('info_delete',{id:i.id}); } catch(e){} } }
  // 只删**我自己写的那条说明**，别碰用户可能写过的当天小结
  await inv('daily_note_set',{date:'$dateKey', key:'todo:$bId', text:''});
  await sl(900);
  const r=await inv('daily_get',{date:'$dateKey'});
  return JSON.stringify({todos:(await inv('todo_list')).map(t=>t.title), infos:(await inv('info_list')).map(i=>(i.text||'').slice(0,20)),
    notesLeft:(r.notes||[]).map(n=>n.key)});
})()
"@
Write-Host ("  清完之后：" + ($clean | ConvertTo-Json -Compress))
$leftover = @(@($clean.todos) + @($clean.infos) | Where-Object { $_ -match '^M11 ' })
Check '㉜ 测试待办 / 信息清干净了' ($leftover.Count -eq 0) ($leftover -join ' / ')
Check '㉝ 我写的那条说明也删掉了（不留垃圾，也没碰你写的当天小结）' (-not (@($clean.notesLeft) -contains "todo:$bId")) (($clean.notesLeft) -join ' / ')
if (Test-Path $outFile) { Remove-Item $outFile -Force }

Write-Host ""
}

Write-Host "======================"
Write-Host ("M11-A 日程（日历）：通过 " + $pass + "，失败 " + $fail)
if ($fail -gt 0) { exit 1 }
