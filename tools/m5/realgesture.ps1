# M5 · 真实鼠标手势验收（**不能用合成事件替代的那一半**）
#
# 为什么单独一个脚本：M4 出过"整套 JS 全绿、用户却完全用不了"的 bug ——
# `dispatchEvent` 直接派发到元素上，绕过了浏览器的**命中测试**与指针处理，于是假绿灯。
# M5 的执行区里有两处典型手势：
#   ① **拖动排序**（卡片在待办集里换位置）
#   ② **拖进/拖出四象限**（命中判定靠 `document.elementFromPoint` → 只有真实输入才有意义）
#
# ⚠️⚠️ 两个**必须**遵守的前置条件（第一版就是栽在这上面，6 条失败、看着像产品 bug）：
#   1. **屏幕上不能有残留弹窗**。`Modal` 的背景是 `fixed inset-0 z-40`，它会把后面
#      所有真实鼠标输入吃掉 —— 点哪都点在弹窗上，而页面只是暗了一点，极难看出来。
#      所以脚本开头先断言"没有弹窗"，失败时给的是人话，而不是一堆莫名其妙的 X。
#   2. **拖拽的起点和终点必须同时在屏幕上**。`cdp.ps1` 只把**起点**滚进视野，
#      终点它不管；终点要是在视口外，落点就飞了。待办集长起来之后
#      （十几张卡 1400+px）这几乎必然发生，所以拖之前明确把容器拉到顶/拉到底。
#
# 用法（应用要以 CDP 端口起着；**先把 tools\m5 的 00~06 跑完**）：
#   powershell -File tools\m5\realgesture.ps1
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\tools\m5
$tools = Split-Path -Parent $here                             # …\tools
$cdp = Join-Path $tools 'cdp.ps1'

# ⚠️ 用**子进程**调 cdp.ps1：本脚本被 `powershell -File` 用 5.1 跑，
# 而 5.1 下 `$out = & 别的.ps1` 的输出捕获行为和 pwsh 7 不一样（M4 实测捕到空值）。
function Eval([string]$js) {
  $tmp = Join-Path $env:TEMP ("m5-rg-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -RequireSelector 'nav' 2>&1
    return (($out | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function MouseDrag([string]$from, [string]$to) {
  $out = & powershell -NoProfile -File $cdp -Action mouse -Selector $from -ToSelector $to -Port $Port -RequireSelector 'nav' 2>&1
  return (($out | Out-String).Trim())
}
<#
  真实鼠标单击。
  ⚠️ **找不到元素时 `cdp.ps1` 是 `throw`**，而这个脚本 `$ErrorActionPreference = 'Stop'` ——
     照原样写，一次"元素不在 DOM 里"就会让整个脚本当场退出、**连成绩行都不打**
     （2026-09-21 全量回归里就是这样整丢了 M5 手势那一套：驱动只看到空输出）。
     所以这里把异常和 stderr 都收下来、当返回值交给调用方断言，别让它掀桌子。
#>
function MouseClick([string]$sel) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & powershell -NoProfile -File $cdp -Action mouse -Selector $sel -Clicks 1 -Port $Port -RequireSelector 'nav' 2>&1
    $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
    if ($errs.Count -gt 0) { return ("ERROR: " + (($errs -join ' ') -replace '\s+', ' ')) }
    return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
  } catch {
    return ("ERROR: " + $_.Exception.Message)
  } finally {
    $ErrorActionPreference = $prev
  }
}
function J([string]$json) { return ($json | ConvertFrom-Json) }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}

# ─────────────────── 可复用的 JS 模板（占位符替换，别在 PS 里拼 JS 引号） ───────────────────

$TPL_PREPARE = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const setCards=()=>Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));

  // 0) 先把残留弹窗清掉 —— 它会吃掉后面所有的真实鼠标输入
  for(let i=0;i<4 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sl(250);
    const d=document.querySelector('[role="dialog"]');
    if(d){ const x=d.querySelector('button[aria-label="关闭"]'); if(x) x.click(); await sl(250); }
  }

  const todos=await inv('todo_list');
  const need=['笔记来的甲','笔记来的丙','手工建的丁'];
  const missing=need.filter(n=>!todos.some(t=>t.title===n));
  if(missing.length) return JSON.stringify({error:'缺测试数据（先跑 00~06）: '+missing.join('、')});

  // 分类清干净，保证这几张卡都在待办集里
  for(const t of todos){
    if(t.quadrant && /笔记来的|手工建的/.test(t.title)) await inv('todo_set_quadrant',{id:t.id,quadrant:null});
  }
  await inv('todo_reorder',{orderedIds:need.map(n=>todos.filter(t=>t.title===n)[0].id)});
  const tree=(await inv('note_list')).filter(n=>n.kind==='tree')[0];
  if(tree) await inv('note_tree_ensure_root',{noteId:tree.id});
  await sl(900);

  // 带重试地导航到执行区（HMR 整页重载会把 view 打回首页）
  //
  // ⚠️ 2026-09-21 加严：原来是"一看到卡就走"，结果踩到过两种时机问题 ——
  //    ① 卡先渲染出来、**转眼中途被整页重载清空**（最后统计到 0 张，重试次数却是 0）；
  //    ② 从别的套件（尤其 m4）刚切过来时，执行区还没挂载好。
  //    现在改成"导到位之后**连续两次**都看到卡才算稳"，不稳就继续点导航。
  let tries=0;
  while(setCards().length===0 && tries<16){
    tries++;
    const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
    if(nav){ nav.click(); await sl(700); } else { await sl(500); }
  }
  let stable=0;
  for(let i=0;i<15 && stable<2;i++){
    await sl(400);
    if(setCards().length>0) stable++; else { stable=0; tries++; const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区'); if(nav){ nav.click(); await sl(500); } }
  }
  const set=document.querySelector('[data-todo-set]');
  const scroller=set?set.closest('.overflow-y-auto'):null;
  if(scroller) scroller.scrollTop=0;
  await sl(500);

  return JSON.stringify({
    count:setCards().length,
    dialogLeft: !!document.querySelector('[role="dialog"]'),
    tries:tries,
    stable:stable,
    hasSet:!!document.querySelector('[data-todo-set]'),
    error:null,
  });
})()
'@

$TPL_LAYOUT = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const set=document.querySelector('[data-todo-set]');
  const scroller=set?set.closest('.overflow-y-auto'):null;
  // `top` = 滚到顶；`bottom` = 拉到底；**`keep` = 一个像素都不动**（读当前布局）。
  // ⚠️ `keep` 是 2026-09-21 加的：拖拽前要先把起点滚进视野，倘若紧接着又用 `top`
  //    把页面滚回顶上，起点立刻被推出视口（实测起点 y=1509 而视口只有 820）。
  if(scroller){
    if('__WHERE__'==='bottom') scroller.scrollTop = scroller.scrollHeight;
    else if('__WHERE__'==='top') scroller.scrollTop = 0;
  }
  await sl(500);
  const cards=Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));
  const rects=cards.map(function(c){
    const b=c.getBoundingClientRect();
    return {id:c.getAttribute('data-todo-id'),title:c.getAttribute('data-todo-title'),top:Math.round(b.top),bottom:Math.round(b.bottom)};
  });
  const q1=document.querySelector('[data-quadrant="q1"]');
  const qb=q1?q1.getBoundingClientRect():null;
  const sc=scroller?scroller.getBoundingClientRect():null;
  return JSON.stringify({
    ids:rects.map(function(r){return r.id;}),
    titles:rects.map(function(r){return r.title;}),
    q1:qb?{top:Math.round(qb.top),bottom:Math.round(qb.bottom)}:null,
    scroller:sc?{top:Math.round(sc.top),bottom:Math.round(sc.bottom)}:null,
    visibleIds:rects.filter(function(r){return sc && r.top>=sc.top && r.bottom<=sc.bottom;}).map(function(r){return r.id;}),
    order:(await inv('todo_list')).map(function(t){return t.title;}),
  });
})()
'@

$TPL_TODO = @'
window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){
  var t = ts.filter(function(x){ return x.id === '__ID__'; })[0];
  return JSON.stringify(t ? {exists:true,title:t.title,quadrant:t.quadrant||null,status:t.status,doneAt:t.doneAt||null} : {exists:false});
})
'@
$TPL_INSET = @'
JSON.stringify(!!(function(){var s=document.querySelector('[data-todo-set]');return s?s.querySelector('[data-todo-id="__ID__"]'):null;})())
'@
$TPL_INQ = @'
JSON.stringify(!!(function(){var q=document.querySelector('[data-quadrant="q1"]');return q?q.querySelector('[data-todo-id="__ID__"]'):null;})())
'@
$TPL_EDITOPEN = @'
JSON.stringify(!!document.querySelector('[data-todo-set] input[type=text]'))
'@

function ReadTodo([string]$id) { return J ((Eval ($TPL_TODO.Replace('__ID__', $id)) | Out-String).Trim()) }
function InSet([string]$id) { return [bool](J ((Eval ($TPL_INSET.Replace('__ID__', $id)) | Out-String).Trim())) }
function InQ1([string]$id) { return [bool](J ((Eval ($TPL_INQ.Replace('__ID__', $id)) | Out-String).Trim())) }
function Layout([string]$where) { return J ((Eval ($TPL_LAYOUT.Replace('__WHERE__', $where)) | Out-String).Trim()) }
function TitleOf($layer, [string]$id) { return $layer.titles[[array]::IndexOf($layer.ids, $id)] }

# ─────────────────────────── 准备 ───────────────────────────
Write-Host "=== 准备：清弹窗、固定顺序、进执行区 ==="
$prep = J (Eval $TPL_PREPARE)
if ($prep.error) { Write-Host ("  " + $prep.error); exit 1 }
Write-Host ("  [调试] 卡数={0} 重试={1}" -f $prep.count, $prep.tries)
Check '待办集里有卡（00~06 跑过了）' ($prep.count -ge 3) ("卡数=$($prep.count)")
Check '★ 前置：屏幕上没有残留弹窗（它会吃掉所有真实鼠标输入）' (-not $prep.dialogLeft)
if ($prep.count -lt 3 -or $prep.dialogLeft) { exit 1 }

# ─────────────────────────── ① 拖动排序 ───────────────────────────
Write-Host ""
Write-Host "=== ① 真实拖拽 → 待办集里换位置（拉到顶，取前两张） ==="
$top = Layout 'top'
Write-Host ("  拉到顶后同屏的卡片：" + (($top.visibleIds | ForEach-Object { TitleOf $top $_ }) -join ' | '))
Check '拉到顶之后至少两张卡同屏（拖拽要求起终点都在屏幕上）' ($top.visibleIds.Count -ge 2) ("可见 " + $top.visibleIds.Count)
if ($top.visibleIds.Count -lt 2) { Write-Host "  卡片太多或视图太矮，没法同屏拖拽"; exit 1 }

$srcId = $top.ids[1]
$dstId = $top.ids[0]
$srcTitle = TitleOf $top $srcId
$dstTitle = TitleOf $top $dstId
$orderBefore = ($top.order -join ' | ')
Write-Host ("  把「$srcTitle」拖到「$dstTitle」前面")
# 落点选**标题按钮**：标题在卡片上半部，中心 y 比卡片中线高 → 会插到它前面，结果确定
$dragOut = MouseDrag "[data-todo-id='$srcId']" "[data-todo-title-btn='$dstId']"
Write-Host ("  " + $dragOut)
Start-Sleep -Milliseconds 1300

$after = Layout 'top'
Check '真实拖拽改变了顺序' (($after.order -join ' | ') -ne $orderBefore) ($orderBefore + '  ->  ' + ($after.order -join ' | '))
Check '★ 被拖的那张跑到了第一位' ($after.order[0] -eq $srcTitle) ("实际第一位=" + $after.order[0] + "，期望=" + $srcTitle)
Check '★ 卡片总数没变（拖动不会弄丢卡）' ($after.order.Count -eq $top.order.Count) ("$($after.order.Count) vs $($top.order.Count)")
Check '界面上的顺序也跟着变了（不只是磁盘）' ($after.titles[0] -eq $after.order[0]) ("DOM 第一位=" + $after.titles[0])
Check '★ 拖完不会顺手把标题点进编辑态（justDragged 抑制生效）' (-not [bool](J ((Eval $TPL_EDITOPEN | Out-String).Trim())))

# ─────────────── ② 拖进四象限（#8 起这块板已搬到首页，这条路不存在了） ───────────────
Write-Host ""
Write-Host "=== ② 四象限已搬到首页（2026-10-21 · 反馈 #8）→ 执行区没有格子可拖，跳过 ==="
Write-Host "  原来这里验「真实拖进 q1 / 再拖回待办集」；板子搬走后执行区只保留排序拖动（①）。"
Write-Host "  分类入口仍在卡片 ⚙「调整分类」（m5/04 覆盖）；首页那块板由 m7.1 ⑧ / v2d 覆盖。"
$moveId = $after.ids[0]
$moveTitle = TitleOf $after $moveId
Write-Host ("  ④ 拿这一张去验勾选框：「$moveTitle」")

# ─────────────────────────── ④ 真实单击勾选框 ───────────────────────────
Write-Host ""
Write-Host "=== ④ 真实单击 → 勾选框（真实输入下 click 还能不能用） ==="
$beforeClick = ReadTodo $moveId
Check '前置：这一条现在是未完成' ($beforeClick.status -eq 'open') ("status=" + $beforeClick.status)

[void](MouseClick "[data-todo-check='$moveId']")
Start-Sleep -Milliseconds 1000
$doneState = ReadTodo $moveId
Check '★ 真实单击勾选框 → 标成完成' ($doneState.status -eq 'done') ("status=" + $doneState.status)
Check '★ 标完成不等于删除（真实输入下也一样）' ([bool]$doneState.exists)

# ⚠️ M9-4 起：勾完的卡片会**移进收起的「已完成归档」区**，那个勾选框就不在 DOM 里了。
#    所以先用**真实点击**把归档展开（顺带把"归档开关在真实输入下能不能用"也验了），
#    再去点第二次。不展开的话 `cdp.ps1 -Action mouse` 会报"找不到元素"。
$archState = J ((Eval @'
JSON.stringify((function(){
  const box=document.querySelector('[data-archive-body]');
  return {open:!!box, toggle:!!document.querySelector('[data-archive-toggle]')};
})())
'@) | Out-String).Trim()
Check '  勾完之后卡片确实离开了待办集（M9-4 归档）' (-not (InSet $moveId)) ''
if (-not $archState.open) {
  [void](MouseClick '[data-archive-toggle]')
  Start-Sleep -Milliseconds 900
}
$archAfter = J ((Eval @'
JSON.stringify((function(){
  return {open:!!document.querySelector('[data-archive-body]')};
})())
'@) | Out-String).Trim()
Check '★ 真实点击能展开「已完成归档」区' ([bool]$archAfter.open) ($archAfter | ConvertTo-Json -Compress)

[void](MouseClick "[data-todo-check='$moveId']")
Start-Sleep -Milliseconds 1000
$undone = ReadTodo $moveId
Check '★ 真实单击再点一次 → 退回未完成' ($undone.status -eq 'open') ("status=" + $undone.status)
Check '★ 退回未完成时 doneAt 被抹掉' ($null -eq $undone.doneAt) ("doneAt=" + $undone.doneAt)

Write-Host ""
Write-Host "======================"
Write-Host ("真实手势：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
