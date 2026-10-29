# D 批验收（2026-10-04）· 执行区分组（#5）+ 线分层（#9 扩到三个区）
#
# 验的四件事：
#   ① 认知区左栏：**组间实线 + 组内行间细线**真的画出来了，而且行不再是各自一张圆角卡
#   ② 执行区：建分组 / 卡片进组 / 折叠 / **落盘** / 搜索时平铺 / `#组名` 快捷语法
#   ③ 执行区与信息区：`线分层` 同样生效（待办行、信息行不再是框；四象限合成网格；左栏合成一片）
#   ④ 收尾：只删自己造的 `M-D批` 数据，并核对用户的待办/笔记条数没变
#
# 🔴 铁规矩：只动自己造的数据（`M-D批 ` 开头的待办 / 信息 / 笔记），用户的一个字不动。
# ⚠️ `.ps1` 必须带 UTF-8 BOM；`-Expr` 不许带中文（一律走 `-ExprFile`）。
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
if (-not (Test-Path -LiteralPath $cdp)) { throw "找不到 cdp.ps1：$cdp" }
$MAIN = '东方摩耶堂'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [X] {0}   {1}" -f $name, $detail) -ForegroundColor Red }
}

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("v2d-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  $first = @($out) | Select-Object -First 1
  if ($null -ne $first -and $first -isnot [string]) { return (ConvertTo-Json -InputObject @($out) -Depth 12 -Compress) }
  return (@($out) -join "`n").Trim()
}

# EvalJson：**已经解析成对象**，别再 ConvertFrom-Json（2026-10-02 栽过）
function EvalJson([string]$js) {
  $raw = EvalMain $js
  if (-not $raw) { return $null }
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function MouseAt([int]$x, [int]$y, [int]$clicks = 1) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action mouse -X $x -Y $y -Clicks $clicks -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' | Out-Null
}

function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 350) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (& $probe) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return $false
}

function GoPage([string]$name) {
  $js = @"
(function(){
  var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='$name';})[0];
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()
"@
  $r = EvalMain $js
  Start-Sleep -Milliseconds 800
  return ($r -eq 'OK')
}

try {
Write-Host "`n=== D 批验收开始（执行区分组 + 线分层）===" -ForegroundColor Cyan

# 页面起来了吗 + 数据基线
$ready = EvalJson "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(l){return JSON.stringify({n:l.length});})"
if ($null -eq $ready) { throw "读不到待办（CDP 不通？应用起了吗？）" }
$noteCount = (EvalJson "window.__TAURI_INTERNALS__.invoke('note_list').then(function(l){return JSON.stringify({n:l.length});})").n
$todoCount = $ready.n
Write-Host ("  基线：待办 {0} 条 / 笔记 {1} 篇" -f $todoCount, $noteCount)

# §0 清掉上一次跑剩的测试数据（只删 M-D批 开头的）
$swept = EvalJson @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let t=0,i=0,n=0;
  for(const one of await inv('todo_list')){ if(/^M-D批/.test(one.title)){ await inv('todo_delete',{id:one.id}); t++; } }
  for(const one of await inv('info_list')){ if(/^M-D批/.test(one.text||'')){ await inv('info_delete',{id:one.id}); i++; } }
  for(const one of await inv('note_list')){ if(/^M-D批/.test(one.title)){ await inv('note_delete',{id:one.id}); n++; } }
  return JSON.stringify({todos:t,infos:i,notes:n});
})()
"@
Write-Host ("  §0 清残留：待办 {0} / 信息 {1} / 笔记 {2}" -f $swept.todos, $swept.infos, $swept.notes)

# ─────────────────── §1 认知区：线分层（#9） ───────────────────
Write-Host "`n§1 认知区左栏：组间实线 + 组内行间细线（#9）" -ForegroundColor Yellow
Check "能进认知区" (GoPage '认知区')

# ⚠️ 用户的笔记可能**只有一组**（"未分组"），那样根本不存在"组与组之间"这条线 ——
#    所以先自己造一篇测试笔记、丢进一个测试分组，凑出"两个段"再量。
$gNote = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const n=await inv('note_create',{title:'M-D批 认知区分组探针',kind:'doc',content:'线分层的探针'});
  await inv('note_set_group',{noteId:n.id, group:'M-D批组'});
  return JSON.stringify({id:n.id});
})()
'@
# ⚠️ `note_set_group` 是**操作式、不广播 data-changed** 的命令（设计如此），所以直接调它之后
#    **界面不会自己刷** —— 刷一下页面再量（顺带也验了"分组真的落盘了"）。
$null = (EvalMain "location.reload(); 'reloading'")
Start-Sleep -Seconds 6
if (-not (Wait-Until { (EvalMain "document.querySelectorAll('nav').length") -match '^[1-9]' } 15000)) {
  throw "刷新之后页面没起来（vite 还活着吗？）"
}
Check "能进认知区（刷新之后）" (GoPage '认知区')

# ⚠️ 2026-10-21 补：用户设置是「分类收起」（`cognitionGroupDefault = collapse-grouped`），
#    分组默认折着 → `[data-note-row]` 只剩未分组那几行，行数断言会假红。
#    量之前先把折着的组点开（只改这次会话的内存状态，**不写配置**）。
$null = (EvalMain "Array.from(document.querySelectorAll('[data-group-toggle]')).forEach(function(b){ if((b.innerText||'').indexOf('\u25b8')>=0) b.click(); }); 'ok'")
Start-Sleep -Milliseconds 700

$g = EvalJson @'
(function(){
  const secs=Array.from(document.querySelectorAll('[data-note-group]'));
  const rows=Array.from(document.querySelectorAll('[data-note-row]'));
  const px=(el,prop)=>el?parseFloat(getComputedStyle(el)[prop])||0:-1;
  // ⚠️ Tailwind 4 的 `divide-y` 是给**非最后一个**子元素加 `border-bottom`
  //    （不是给后面的加 border-top）—— 所以"行与行之间那条线"要读**非最后一行的 borderBottomWidth**。
  //    2026-10-04 在这儿量错过一次（读 borderTopWidth 恒为 0，差点当成"线没画出来"）。
  // ⚠️ 别死盯第一组：分组按名字排序，"M-D批组"（我造的那篇，只有 1 行）会排在最前面。
  //    行间那条线要在**行数最多的那一组**里量。
  const uls=Array.from(document.querySelectorAll('[data-note-group] ul'));
  const firstList=uls.sort(function(a,b){return b.children.length-a.children.length;})[0]||null;
  const lis=firstList?Array.from(firstList.children):[];
  const rowDiv=rows[0]?rows[0].querySelector('div'):null;
  const second=secs[1]||null;
  return JSON.stringify({
    groups:secs.length, rows:rows.length,
    groupNames:secs.map(s=>s.getAttribute('data-note-group')),
    groupGapLine:second?px(second,'borderTopWidth'):-1,
    rowSepLine:lis.length>1?Math.max.apply(null,lis.slice(0,-1).map(function(k){return parseFloat(getComputedStyle(k).borderBottomWidth)||0;})):-1,
    rowOwnTop:rowDiv?px(rowDiv,'borderTopWidth'):-1,
    rowRadius:rowDiv?parseFloat(getComputedStyle(rowDiv).borderTopLeftRadius)||0:-1
  });
})()
'@
Write-Host ("  组 {0} 个 / 行 {1} 条" -f $g.groups, $g.rows)
Check ("★ 行数 = 笔记数 + 我造的那篇（{0}）—— 线分层没把笔记弄丢" -f ($noteCount + 1)) ($g.rows -eq ($noteCount + 1)) ("行 " + $g.rows + " / 应有 " + ($noteCount + 1))
Check ("★★ 组与组之间真的有一条线（borderTop = {0}px，段数 {1}）" -f $g.groupGapLine, $g.groups) ($g.groupGapLine -gt 0) ("borderTopWidth=" + $g.groupGapLine)
Check ("★★ 组内行与行之间真的有一条细线（非最后一行 borderBottom = {0}px）" -f $g.rowSepLine) ($g.rowSepLine -gt 0) ("borderBottomWidth=" + $g.rowSepLine)
Check ("★★ 笔记行**不再各自包一个圆角框**（自身 borderTop={0}px / 圆角={1}px）" -f $g.rowOwnTop, $g.rowRadius) ($g.rowOwnTop -eq 0 -and $g.rowRadius -eq 0) ("borderTop=" + $g.rowOwnTop + " radius=" + $g.rowRadius)

# ─────────────────── §2 执行区：分组（#5） ───────────────────
Write-Host "`n§2 执行区「待办集」：建分组 / 进组 / 折叠 / 落盘" -ForegroundColor Yellow
Check "能进执行区" (GoPage '执行区')

$made = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('todo_create',{title:'M-D批 甲',plannedAt:null});
  const b=await inv('todo_create',{title:'M-D批 乙',plannedAt:null});
  const c=await inv('todo_create',{title:'M-D批 丙',plannedAt:null});
  return JSON.stringify({a:a.id,b:b.id,c:c.id});
})()
'@
Write-Host ("  造了三条测试待办：甲 {0}… / 乙 {1}… / 丙 {2}…" -f $made.a.Substring(0,8), $made.b.Substring(0,8), $made.c.Substring(0,8))
$cardsOk = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-id=""$($made.a)""]').length") -match '^[1-9]' } 10000
Check "★ 三条测试卡片出现在待办集里" $cardsOk

# 点「⋮」开菜单（真鼠标：先把坐标量出来 + 命中校验）
# 🔴 2026-10-11（v2.20.0）：**先把它滚进视口再量坐标**。
#    原来直接量 —— 用户待办一多，测试卡片被排到列表下面（实测量到 y=981，而窗口只有 820 高），
#    真实鼠标点不到按钮 → 小菜单根本不开 → 后面 8 条断言连锁假红（29/8）。
#    ⚠️ 真实鼠标只能点**屏幕上看得见**的地方（§五 的老坑："真实拖拽要求起终点同时在屏幕上"）。
$btn = (EvalMain "(function(){var b=document.querySelector('[data-todo-group-btn=""$($made.a)""]'); if(!b) return ''; b.scrollIntoView({block:'center'}); var r=b.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()")
Check ("找到「⋮ 移到分组」按钮坐标（{0}，已滚进视口）" -f $btn) ($btn -match '^\d+,\d+$') $btn
if ($btn -match '^(\d+),(\d+)$') {
  # 先 hover 再重新量（D 批的教训：hover 会让布局动，旧坐标会点偏）
  MouseAt ([int]$Matches[1]) ([int]$Matches[2]) 0
  Start-Sleep -Milliseconds 350
  $btn2 = (EvalMain "(function(){var b=document.querySelector('[data-todo-group-btn=""$($made.a)""]'); if(!b) return ''; var r=b.getBoundingClientRect(); return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);})()")
  if ($btn2 -match '^(\d+),(\d+)$') { MouseAt ([int]$Matches[1]) ([int]$Matches[2]) }
}
$menuOpen = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-group-menu=""$($made.a)""]').length") -match '^[1-9]' } 5000
Check "★ 真鼠标点 ⋮ → 「移到分组…」小菜单真的开了" $menuOpen

# 在小菜单里新建一个分组（页面内打字：跟 m7 那套一样用 value setter + input 事件）
$typed = (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const i=document.querySelector('[data-todo-group-new-input]');
  if(!i) return 'NO_INPUT';
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(i,'M-D批组');
  await sl(200);
  i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  return 'OK';
})()
"@)
Check "小菜单里有「新分组名…」输入框" ($typed -eq 'OK') $typed

$grouped = Wait-Until { (EvalMain "document.querySelectorAll('[data-todo-group=""M-D批组""]').length") -match '^[1-9]' } 8000
Check "★★ 新分组「M-D批组」当场出现（组标题在）" $grouped
$inGroup = (EvalMain "String(!!(function(){var s=document.querySelector('[data-todo-group=""M-D批组""]'); return s && s.querySelector('[data-todo-id=""$($made.a)""]');})())")
Check "★★ 那张卡片真的进了这个组" ($inGroup -eq 'True' -or $inGroup -eq 'true') $inGroup

$saved = EvalJson "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(l){var t=l.filter(function(x){return x.id==='$($made.a)';})[0]; return JSON.stringify({group:t?t.group:null});})"
Check ("★★ 分组真的落盘了（todos.json 里 group = {0}）" -f $saved.group) ($saved.group -eq 'M-D批组') ($saved | ConvertTo-Json -Compress)

# 折叠 / 展开
$before = (EvalMain "document.querySelectorAll('[data-todo-id]').length")
$null = (EvalMain "(function(){var b=document.querySelector('[data-todo-group-toggle=""M-D批组""]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 500
$collapsed = (EvalMain "String(!!(function(){var s=document.querySelector('[data-todo-group=""M-D批组""]'); return s && !s.querySelector('[data-todo-id]');})())")
Check "★ 点组标题 → 这一组折叠起来（卡片看不见了，组标题还在）" ($collapsed -eq 'True' -or $collapsed -eq 'true') $collapsed
$null = (EvalMain "(function(){var b=document.querySelector('[data-todo-group-toggle=""M-D批组""]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 500
$expanded = (EvalMain "String(!!(function(){var s=document.querySelector('[data-todo-group=""M-D批组""]'); return s && s.querySelector('[data-todo-id]');})())")
Check "★ 再点一下 → 又展开（卡片回来）" ($expanded -eq 'True' -or $expanded -eq 'true') $expanded

# `#组名` 快捷语法：建出来直接进组
$quick = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const i=document.querySelector('[data-todo-new-input]');
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(i,'M-D批 丁 #M-D批组');
  await sl(250);
  const hint=document.querySelector('[data-quick-hint-group]');
  const hintGroup=hint?hint.getAttribute('data-quick-hint-group'):'';
  i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await sl(1200);
  const list=await inv('todo_list');
  const one=list.filter(t=>t.title==='M-D批 丁')[0];
  return JSON.stringify({hintGroup:hintGroup, id:one?one.id:null, group:one?one.group:null, inputLeft:i.value});
})()
'@
Check ("★ 输入框实时提示认出了分组（{0}）" -f $g.hintGroup) ($quick.hintGroup -eq 'M-D批组') ($quick | ConvertTo-Json -Compress)
Check ("★★ `#M-D批组` 建出来的待办直接进组（group = {0}）" -f $quick.group) ($quick.group -eq 'M-D批组') ($quick | ConvertTo-Json -Compress)
Check "★ 建完之后输入框自己清空了" ("" -eq $quick.inputLeft) $quick.inputLeft

# 搜索时平铺（跟认知区一个规矩）
$null = (EvalMain "(function(){var i=document.querySelector('[data-todo-search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'M-D批'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()")
Start-Sleep -Milliseconds 700
$flat = EvalJson @'
(function(){
  const secs=document.querySelectorAll('[data-todo-group]').length;
  const mine=document.querySelectorAll('[data-todo-id]').length;
  return JSON.stringify({sections:secs, cards:mine});
})()
'@
Check ("★ 搜索时**平铺**（不再是分组段：段数 {0}）" -f $flat.sections) ($flat.sections -eq 0) ($flat | ConvertTo-Json -Compress)
Check ("★ 搜索命中的卡片还在（{0} 张）" -f $flat.cards) ($flat.cards -ge 4) ($flat | ConvertTo-Json -Compress)
$null = (EvalMain "(function(){var b=document.querySelector('[data-todo-search-clear]'); if(b) b.click(); return 'ok';})()")
Start-Sleep -Milliseconds 700

# ─────────────────── §3 线分层：执行区 + 四象限（首页）+ 左栏 ───────────────────
Write-Host "`n§3 执行区：线分层（待办行 / 四象限 / 左栏）" -ForegroundColor Yellow
# #8（2026-10-21）：四象限板搬到首页了 —— 格子样式去首页量，量完回执行区。
$null = GoPage '首页'
Start-Sleep -Milliseconds 800
$quadStyle = EvalJson @'
(function(){
  const px=(el,prop)=>el?parseFloat(getComputedStyle(el)[prop])||0:-1;
  const cells=Array.from(document.querySelectorAll('[data-quadrant]'));
  return JSON.stringify({
    board:!!document.querySelector('[data-quadrant-board]'),
    cells:cells.length,
    cellRight:cells.length?px(cells[0],'borderRightWidth'):-1,
    cellBottom:cells.length?px(cells[0],'borderBottomWidth'):-1,
    cellRadius:cells.length?parseFloat(getComputedStyle(cells[0]).borderTopLeftRadius)||0:-1
  });
})()
'@
Check ("★★ 四象限（现挂首页）有板、四格（{0} 格）" -f $quadStyle.cells) ([bool]$quadStyle.board -and $quadStyle.cells -eq 4) ($quadStyle | ConvertTo-Json -Compress)
Check ("★★ 四象限合成一个网格：格子有内部线（右 {0}px / 下 {1}px）" -f $quadStyle.cellRight, $quadStyle.cellBottom) ($quadStyle.cellRight -gt 0 -and $quadStyle.cellBottom -gt 0) ($quadStyle | ConvertTo-Json -Compress)
Check ("★★ 四个格子不再是圆角虚框（圆角={0}px）" -f $quadStyle.cellRadius) ($quadStyle.cellRadius -eq 0) ("radius=" + $quadStyle.cellRadius)
$null = GoPage '执行区'
Start-Sleep -Milliseconds 900
$style = EvalJson @'
(function(){
  const px=(el,prop)=>el?parseFloat(getComputedStyle(el)[prop])||0:-1;
  const rows=Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));
  // ⚠️ 卡片外面还套着 `<li>`，所以 `parentElement` 是 li 不是 ul —— 要 `closest('ul')`
  //    （2026-10-04 在这儿量错过一次：拿到 li 只有 1 个孩子，误报"没有行间线"）。
  const list=rows[0]?rows[0].closest('ul'):null;
  const lis=list?Array.from(list.children):[];
  const secs=Array.from(document.querySelectorAll('[data-todo-group]'));
  const focus=document.querySelector('[data-focus-today]');
  return JSON.stringify({
    cards:rows.length, lis:lis.length,
    rowTop:px(rows[0],'borderTopWidth'), rowRadius:rows[0]?parseFloat(getComputedStyle(rows[0]).borderTopLeftRadius)||0:-1,
    // Tailwind 4 的 `divide-y` = 非最后一个子元素加 border-bottom（读 border-top 永远 0）
    sepLine:lis.length>1?Math.max.apply(null,lis.slice(0,-1).map(function(k){return parseFloat(getComputedStyle(k).borderBottomWidth)||0;})):-1,
    groupLine:secs.length>1?px(secs[1],'borderTopWidth'):-1, groupCount:secs.length,
    hasQuadrant:!!document.querySelector('[data-quadrant]'),
    focusLeft:px(focus,'borderLeftWidth'), focusTop:px(focus,'borderTopWidth'), focusBg:focus?getComputedStyle(focus).backgroundColor:''
  });
})()
'@
Check ("★ 待办行不再是圆角卡片（自身 borderTop={0}px / 圆角={1}px）" -f $style.rowTop, $style.rowRadius) ($style.rowTop -eq 0 -and $style.rowRadius -eq 0) ($style | ConvertTo-Json -Compress)
Check ("★ 待办行与行之间有细线（非最后一行 borderBottom = {0}px，行数 {1}）" -f $style.sepLine, $style.lis) ($style.sepLine -gt 0) ("borderBottom=" + $style.sepLine + " / lis=" + $style.lis)
Check ("★ 两个分组段之间有实线（{0}px，段数 {1}）" -f $style.groupLine, $style.groupCount) ($style.groupCount -lt 2 -or $style.groupLine -gt 0) ($style | ConvertTo-Json -Compress)
Check ("★ 执行区**不再**挂四象限板（#8 已搬首页）" ) (-not [bool]$style.hasQuadrant) ($style | ConvertTo-Json -Compress)
Check ("★★ 左栏「今天的专注」不再是红框卡片（左边条 {0}px / 上边框 {1}px）" -f $style.focusLeft, $style.focusTop) ($style.focusLeft -gt 0 -and $style.focusTop -eq 0) ($style | ConvertTo-Json -Compress)

# ─────────────────── §4 信息区：线分层 ───────────────────
Write-Host "`n§4 信息区：列表改成线分层" -ForegroundColor Yellow
$infoIds = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('info_create',{text:'M-D批 信息一',kind:'text',categories:[],assetPath:null});
  const b=await inv('info_create',{text:'M-D批 信息二',kind:'text',categories:[],assetPath:null});
  return JSON.stringify({a:a.id,b:b.id});
})()
'@
Check "能进信息区" (GoPage '信息区')
Start-Sleep -Milliseconds 800
$infoStyle = EvalJson @'
(function(){
  const rows=[document.getElementById('info-__A__'),document.getElementById('info-__B__')].filter(Boolean);
  if(rows.length<2) return JSON.stringify({rows:rows.length});
  const px=(el,prop)=>parseFloat(getComputedStyle(el)[prop])||0;
  // ⚠️ 同样：Tailwind 4 的 divide-y 在「非最后一个」元素上给 border-bottom；
  //    而且信息列表是**最新的在最前** —— 所以别只盯 rows[0]，要看「任一非最后一行有没有线」。
  const ul=rows[0].parentElement;
  const kids=ul?Array.from(ul.children):[];
  const sep=kids.length>1?Math.max.apply(null,kids.slice(0,-1).map(function(k){return px(k,'borderBottomWidth');})):0;
  return JSON.stringify({rows:rows.length, kids:kids.length, sep:sep,
    radius:px(rows[0],'borderTopLeftRadius'), left:px(rows[0],'borderLeftWidth')});
})()
'@.Replace('__A__', $infoIds.a).Replace('__B__', $infoIds.b)
Write-Host ("  信息行：" + ($infoStyle | ConvertTo-Json -Compress))
Check "★ 两条测试信息都渲染出来了（按 id 定位得到）" ($infoStyle.rows -eq 2) ($infoStyle | ConvertTo-Json -Compress)
Check ("★ 信息行不再是圆角框（圆角={0}px）" -f $infoStyle.radius) ($infoStyle.radius -eq 0) ($infoStyle | ConvertTo-Json -Compress)
Check ("★ 信息行与行之间有细线（非最后一行 borderBottom {0}px，共 {1} 行）" -f $infoStyle.sep, $infoStyle.kids) ($infoStyle.sep -gt 0) ($infoStyle | ConvertTo-Json -Compress)

# 收尾：把认知区那篇探针笔记也删掉
$null = (EvalMain "(function(){return 'ok';})()")

# ─────────────────── §5 收尾 ───────────────────
Write-Host "`n§5 收尾（只删自己造的 + 核对用户数据）" -ForegroundColor Yellow
$clean = EvalJson @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let t=0,i=0,n=0;
  for(const one of await inv('todo_list')){ if(/^M-D批/.test(one.title)){ await inv('todo_delete',{id:one.id}); t++; } }
  for(const one of await inv('info_list')){ if(/^M-D批/.test(one.text||'')){ await inv('info_delete',{id:one.id}); i++; } }
  // §1 那篇"认知区分组探针"也要删（它是笔记，不是待办）
  for(const one of await inv('note_list')){ if(/^M-D批/.test(one.title)){ await inv('note_delete',{id:one.id}); n++; } }
  const groups=await inv('todo_groups');
  const left=await inv('todo_list');
  return JSON.stringify({todos:t, infos:i, notes:n, groups:groups, todosLeft:left.length,
    leftover:left.filter(x=>/^M-D批/.test(x.title)).length});
})()
'@
Check ("★ 测试待办全删了（删 {0} 条，剩 {1} 条残留）" -f $clean.todos, $clean.leftover) ($clean.leftover -eq 0) ($clean | ConvertTo-Json -Compress)
Check ("★ 测试信息也删了（{0} 条）" -f $clean.infos) ($clean.infos -ge 2) ($clean | ConvertTo-Json -Compress)
Check ("★ §1 那篇探针笔记也删了（{0} 篇）" -f $clean.notes) ($clean.notes -ge 1) ($clean | ConvertTo-Json -Compress)
Check ("★ 测试分组名跟着没了（现在分组：{0}）" -f (($clean.groups) -join '/')) (-not ($clean.groups -contains 'M-D批组')) ($clean | ConvertTo-Json -Compress)
Check ("★★ 用户的待办一条没少（{0} 条 → {1} 条）" -f $todoCount, $clean.todosLeft) ($clean.todosLeft -eq $todoCount) ($clean | ConvertTo-Json -Compress)
$noteNow = (EvalJson "window.__TAURI_INTERNALS__.invoke('note_list').then(function(l){return JSON.stringify({n:l.length});})").n
Check ("★★ 用户的笔记一篇没少（{0} 篇 → {1} 篇）" -f $noteCount, $noteNow) ($noteNow -eq $noteCount) ("笔记 " + $noteNow)

Write-Host "`n========== D 批验收：通过 $pass，失败 $fail ==========" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
} catch {
  # 🔴 **崩了也要打成绩行**（否则 regress.ps1 只看到"没读到成绩行"，看着像"没跑"）
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("========== D 批验收（异常中断）：通过 $pass，失败 $fail ==========") -ForegroundColor Red
  exit 1
}
