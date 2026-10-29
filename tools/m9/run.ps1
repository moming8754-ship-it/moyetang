# M9 · 执行区增强验收（用户 2026-09-21 指定的顺序：1 → 2 → 3 → 4 → 5 → 9 → 6）
#
# 用户原话："执行区的待办'有点太简陋'……按照1234596顺序完成。"
# 也就是：
#   ① 截止日期 + 逾期标红      ② 子任务 checklist        ③ 番茄钟统计
#   ④ 已完成归档              ⑤ 搜索 + 按来源筛选       ⑨ 快捷输入语法
#   ⑥ 重复待办
#
# 这个脚本**按节组织**，每做完一项就加一节；参数 `-Only` 可以只跑某几节（开发时省时间）：
#   powershell -File tools\m9\run.ps1               # 全跑
#   powershell -File tools\m9\run.ps1 -Only 1,2     # 只跑第 1、2 节
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m9\run.ps1               # 全跑
#   powershell -File tools\m9\run.ps1 -Only 1,2     # 只跑第 1、2 节（开发时省时间）
#
# ⚠️ `-Only` 收的是**字符串**（"1,2"）：写成 `[int[]]` 的话，`powershell -File` 传参时
#    会把 "1,2" 当成一个元素塞进数组，`-contains 1` 永远不成立 ——
#    症状是"脚本只跑了准备和收尾，中间一节都没进"（真踩过）。
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂', [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m9-" + [guid]::NewGuid().ToString("N") + ".js")
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
function J([string]$json) { return ($json | ConvertFrom-Json) }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}
function Want([int]$n) {
  if (-not $Only.Trim()) { return $true }
  $list = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  return ($list -contains $n)
}

$stamp = Get-Date -Format 'HHmmss'

# 进执行区 + 关掉残留弹窗（弹窗那层 fixed inset-0 会吃掉真实鼠标输入）
$TPL_TODO_PAGE = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
  if(nav){ nav.click(); await sl(1000); }
  return 'ok';
})()
'@

function ClosePanels {
  # ⚠️ 用 here-string 写多行 JS：普通双引号串里 `\"` **不是**转义（PowerShell 用反引号），
  #    拼出来的 JS 会带上多余的反斜杠 → `SyntaxError: Invalid or unexpected token`。
  #    here-string 里 JS 字符串用单引号、里面直接写裸 `"` 就行。
  [void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  for(let i=0;i<4 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sl(250);
  }
  return 'ok';
})()
'@)
}

Write-Host "=== 准备：进执行区 ==="
[void](EvalMain $TPL_TODO_PAGE)

# ⚠️ **开工先清上一次的残留**：脚本要是崩在中途（开发时经常），收尾那段不会跑，
#    残留的测试待办会让后面"总数/总时长"这类断言算错（真踩过：数字正好翻倍）。
$staleClean = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let n=0;
  for(const t of await inv('todo_list')){ if(/^M9 /.test(t.title||'')){ await inv('todo_delete',{id:t.id}); n++; } }
  return JSON.stringify({removed:n});
})()
'@)
if ($staleClean.removed -gt 0) { Write-Host ("  （先清掉上一次残留的 {0} 条 M9 测试待办）" -f $staleClean.removed) }
Start-Sleep -Milliseconds 600
[void](EvalMain $TPL_TODO_PAGE)

$ready = J (EvalMain "JSON.stringify({todoSet:!!document.querySelector('[data-todo-set]'), cards:document.querySelectorAll('[data-todo-set] [data-todo-id]').length})")
Check '执行区渲染出来了' ([bool]$ready.todoSet) ($ready | ConvertTo-Json -Compress)
Write-Host ("  待办集里 {0} 张卡" -f $ready.cards)

# ═══════════════════════ 第 1 节：截止日期 + 逾期标红 ═══════════════════════
if (Want 1) {
  Write-Host ""
  Write-Host "=== ① 截止日期 + 逾期标红（M9-1） ==="

  # 造三条测试待办：一条未来截止、一条已经逾期、一条没截止
  $made = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const soon=await inv('todo_create',{title:'M9 截止-未来 $stamp'});
  const past=await inv('todo_create',{title:'M9 截止-逾期 $stamp'});
  const none=await inv('todo_create',{title:'M9 截止-没有 $stamp'});
  // 未来 3 天 / 昨天
  const future=new Date(Date.now()+3*86400000).toISOString();
  const yesterday=new Date(Date.now()-86400000).toISOString();
  await inv('todo_set_due',{id:soon.id,dueAt:future});
  await inv('todo_set_due',{id:past.id,dueAt:yesterday});
  return JSON.stringify({soon:soon.id, past:past.id, none:none.id, future:future, yesterday:yesterday});
})()
"@)
  Start-Sleep -Milliseconds 1000
  [void](EvalMain $TPL_TODO_PAGE)

  $dueApi = J (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){var f=function(id){var t=ts.filter(function(x){return x.id===id;})[0];return t?(t.dueAt||null):'MISSING';};return JSON.stringify({soon:f('$($made.soon)'), past:f('$($made.past)'), none:f('$($made.none)')});})")
  Check '★ 截止日期写到了盘上（未来的那条）' ([bool]$dueApi.soon) ($dueApi.soon)
  Check '★ 逾期的那条也写着截止日期' ([bool]$dueApi.past) ($dueApi.past)
  Check '  没设的那条就是空（不是 0 也不是空串）' ($null -eq $dueApi.none) ("none=" + $dueApi.none)

  # ★ 这两个时间戳要等价（后端存的是 ISO，比较的时候别被时区坑了）
  $sameInstant = ([Math]::Abs(([datetime]$dueApi.soon).ToUniversalTime().Subtract(([datetime]$made.future).ToUniversalTime()).TotalSeconds) -lt 1)
  Check '  存回来的时间戳和设进去的是同一时刻（没被时区搬走）' $sameInstant ("设 " + $made.future + " 回 " + $dueApi.soon)

  $overdueUi = J (EvalMain @"
JSON.stringify((function(){
  var soon=document.querySelector('[data-todo-due="$($made.soon)"]');
  var past=document.querySelector('[data-todo-due="$($made.past)"]');
  var none=document.querySelector('[data-todo-due="$($made.none)"]');
  return {
    soonText: soon?(soon.innerText||'').trim():null,
    soonOverdue: soon?soon.getAttribute('data-todo-overdue'):null,
    pastText: past?(past.innerText||'').trim():null,
    pastOverdue: past?past.getAttribute('data-todo-overdue'):null,
    noneShown: !!none,
  };
})())
"@)
  Write-Host ("  未来那条显示：「{0}」逾期标记={1}" -f $overdueUi.soonText, $overdueUi.soonOverdue)
  Write-Host ("  逾期那条显示：「{0}」逾期标记={1}" -f $overdueUi.pastText, $overdueUi.pastOverdue)
  Check '★ 未来的截止日期显示成"X天后/日期"这种能看懂的写法' ([bool]($overdueUi.soonText -match '⏳')) ($overdueUi.soonText)
  Check '★ 未来那条**不算**逾期' ($overdueUi.soonOverdue -eq '0') ("overdue=" + $overdueUi.soonOverdue)
  Check '★ 过期那条算逾期（标记 = 1）' ($overdueUi.pastOverdue -eq '1') ("overdue=" + $overdueUi.pastOverdue)
  Check '★ 逾期那条写的是「逾期 N 天」' ([bool]($overdueUi.pastText -match '逾期')) ($overdueUi.pastText)
  Check '  没设截止日期的卡片上不显示这一块' (-not [bool]$overdueUi.noneShown) ''

  # 逾期那行要真的**红**（不是只写个"逾期"两个字就完）
  $redCheck = J (EvalMain @"
JSON.stringify((function(){
  var el=document.querySelector('[data-todo-due="$($made.past)"]');
  if(!el) return {error:'找不到'};
  var cls=el.className||'';
  var color=getComputedStyle(el).color;
  return {hasRose: /rose/.test(cls), color: color};
})())
"@)
  Check '★ 逾期那条用了红色系样式（rose）' ([bool]$redCheck.hasRose) ($redCheck | ConvertTo-Json -Compress)
  Write-Host ("  逾期那行的实际文字颜色：{0}" -f $redCheck.color)

  # 完成了就不该再催（"做完了"比"逾期了"重要）
  $doneNotOverdue = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  await inv('todo_set_done',{id:'$($made.past)',done:true});
  await sl(900);
  // ⚠️ 标完成之后卡片会**移进归档区**，而归档默认是收起来的 ——
  //    不先展开就 querySelector 不到它，会得到一个"假红"（M9-4 上线后踩过）。
  const wasOpen=!!document.querySelector('[data-archive-body]');
  if(!wasOpen){ const toggle=document.querySelector('[data-archive-toggle]'); if(toggle){ toggle.click(); await sl(700); } }
  const el=document.querySelector('[data-todo-due="$($made.past)"]');
  const overdue=el?el.getAttribute('data-todo-overdue'):null;
  // 还原：本来就是收着的就再收回去，别把状态漏给后面的节
  if(!wasOpen && document.querySelector('[data-archive-body]')){
    const toggle=document.querySelector('[data-archive-toggle]'); if(toggle){ toggle.click(); await sl(400); }
  }
  return JSON.stringify({overdue:overdue, found:!!el});
})()
"@)
  Check '★ 标成完成之后就不再标红了（事情做完了就别催）' ($doneNotOverdue.overdue -eq '0') ("overdue=" + $doneNotOverdue.overdue + " found=" + $doneNotOverdue.found)
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('todo_set_done',{id:'$($made.past)',done:false}).then(function(){return 'ok';})")

  # ⚙ 弹窗里能设、能清（走界面，不是命令直调）
  Start-Sleep -Milliseconds 600
  [void](EvalMain $TPL_TODO_PAGE)
  $panelSet = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  // ⚠️ 别一次性 querySelector：卡片可能还没渲染出来（2026-09-21 回归里踩过一次假红），等它出现
  let gear=null;
  for(let i=0;i<15 && !gear;i++){ gear=document.querySelector('[data-todo-gear="$($made.none)"]'); if(!gear) await sl(400); }
  if(!gear) return JSON.stringify({error:'找不到 ⚙'});
  gear.click(); await sl(600);
  const input=document.querySelector('[data-todo-due-input]');
  if(!input) return JSON.stringify({error:'⚙ 里没有截止日期输入框'});
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  // 设成"明天 09:30"
  const d=new Date(Date.now()+86400000); d.setHours(9,30,0,0);
  const pad=n=>String(n).padStart(2,'0');
  const local=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  setV(input, local); await sl(300);
  document.querySelector('[data-todo-due-save]').click();
  await sl(1200);
  return JSON.stringify({ok:true, local:local});
})()
"@)
  Check '  ⚙ 弹窗里有截止日期输入框，而且能点保存' ([bool]$panelSet.ok) ($panelSet.error)
  $afterPanel = J (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){var t=ts.filter(function(x){return x.id==='$($made.none)';})[0];return JSON.stringify({dueAt:t?(t.dueAt||null):'MISSING', plannedAt:t?(t.plannedAt||null):null});})")
  Check '★ 从 ⚙ 里设的截止日期落盘了' ([bool]$afterPanel.dueAt) ($afterPanel | ConvertTo-Json -Compress)
  Check '  而且**没有**顺手写进"设定时间"（两个字段是分开的）' ($null -eq $afterPanel.plannedAt) ("plannedAt=" + $afterPanel.plannedAt)

  ClosePanels
  $panelClear = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  // ⚠️ 别一次性 querySelector：卡片可能还没渲染出来（2026-09-21 回归里踩过一次假红），等它出现
  let gear=null;
  for(let i=0;i<15 && !gear;i++){ gear=document.querySelector('[data-todo-gear="$($made.none)"]'); if(!gear) await sl(400); }
  if(!gear) return JSON.stringify({error:'找不到 ⚙'});
  gear.click(); await sl(600);
  const clear=document.querySelector('[data-todo-due-clear]');
  if(!clear) return JSON.stringify({error:'没有「清掉」按钮'});
  clear.click(); await sl(1000);
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const ts=await inv('todo_list');
  const t=ts.filter(function(x){return x.id==='$($made.none)';})[0];
  return JSON.stringify({dueAt:t?(t.dueAt||null):'MISSING'});
})()
"@)
  Check '★ 「清掉」能把截止日期清掉' ($null -eq $panelClear.dueAt) ("dueAt=" + $panelClear.dueAt)

  ClosePanels
  # 收尾：删掉这一节造的
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){var ids=ts.filter(function(t){return /^M9 截止-/.test(t.title);}).map(function(t){return t.id;});return JSON.stringify(ids);})")
  # （真正的清理放在脚本末尾统一做，这里只是把状态还原）
  [void](EvalMain "(async()=>{const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});for(const t of await inv('todo_list')){if(/^M9 截止-/.test(t.title)) await inv('todo_set_done',{id:t.id,done:false});}return 'ok';})()")
}

# ═══════════════════════ 第 2 节：子任务 checklist ═══════════════════════
if (Want 2) {
  Write-Host ""
  Write-Host "=== ② 子任务 checklist（M9-2） ==="

  $sub = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const t=await inv('todo_create',{title:'M9 子任务 $stamp'});
  return JSON.stringify({id:t.id, subtasks:(t.subtasks||[]).length});
})()
"@)
  Check '  新建的待办没有子任务' ($sub.subtasks -eq 0) ("subtasks=" + $sub.subtasks)
  Start-Sleep -Milliseconds 800
  [void](EvalMain $TPL_TODO_PAGE)

  # 全部走 ⚙ 界面：打开 → 输入 → 加 → 再加一条
  $added = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  // ⚠️ 别一次性 querySelector：卡片可能还没渲染出来（2026-09-21 回归里踩过一次假红），等它出现
  let gear=null;
  for(let i=0;i<15 && !gear;i++){ gear=document.querySelector('[data-todo-gear="$($sub.id)"]'); if(!gear) await sl(400); }
  if(!gear) return JSON.stringify({error:'找不到 ⚙'});
  gear.click(); await sl(700);
  const input=document.querySelector('[data-subtask-input]');
  if(!input) return JSON.stringify({error:'⚙ 里没有子任务输入框'});
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  const addBtn=()=>document.querySelector('[data-subtask-add]');
  const disabledWhenEmpty=addBtn().disabled;
  setV(input,'擦桌子'); await sl(300);
  addBtn().click(); await sl(900);
  const input2=document.querySelector('[data-subtask-input]');
  setV(input2,'拖地'); await sl(300);
  addBtn().click(); await sl(900);
  const rows=Array.from(document.querySelectorAll('[data-subtask]'));
  return JSON.stringify({disabledWhenEmpty:disabledWhenEmpty, rows:rows.length,
    texts:rows.map(function(r){return (r.innerText||'').trim();})});
})()
"@)
  Check '  输入框空着的时候「加」是禁用的' ([bool]$added.disabledWhenEmpty) ''
  Check '★ 从 ⚙ 里加了两条子任务' ($added.rows -eq 2) (($added.texts) -join ' / ')
  $onDiskSub = J (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){var t=ts.filter(function(x){return x.id==='$($sub.id)';})[0];return JSON.stringify({n:(t.subtasks||[]).length, texts:(t.subtasks||[]).map(function(s){return s.text+'/'+s.done;})});})")
  Check '★ 子任务写到盘上了，默认都没完成' (($onDiskSub.n -eq 2) -and (@($onDiskSub.texts | Where-Object { $_ -like '*/false' }).Count -eq 2)) (($onDiskSub.texts) -join ' / ')

  # 勾第一个（点 checkbox）
  $toggled = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const boxes=Array.from(document.querySelectorAll('[data-subtask-check]'));
  if(boxes.length<2) return JSON.stringify({error:'勾选框不够两个'});
  const firstId=boxes[0].getAttribute('data-subtask-check');
  boxes[0].click(); await sl(1000);
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const ts=await inv('todo_list');
  const t=ts.filter(function(x){return x.id==='$($sub.id)';})[0];
  const first=(t.subtasks||[]).filter(function(s){return s.id===firstId;})[0];
  const second=(t.subtasks||[]).filter(function(s){return s.id!==firstId;})[0];
  return JSON.stringify({firstDone:first?first.done:null, secondDone:second?second.done:null, firstId:firstId});
})()
"@)
  Check '★ 勾上第一条 → 磁盘上 done=true' ([bool]$toggled.firstDone) (($toggled | ConvertTo-Json -Compress))
  Check '  第二条没被连累' (-not [bool]$toggled.secondDone) ("secondDone=" + $toggled.secondDone)

  # 关掉 ⚙，看卡片上的进度
  ClosePanels
  Start-Sleep -Milliseconds 800
  $progress = J (EvalMain @"
JSON.stringify((function(){
  var el=document.querySelector('[data-todo-subtask-progress="$($sub.id)"]');
  return el?{text:(el.innerText||'').trim(), done:el.getAttribute('data-todo-subtask-done'), total:el.getAttribute('data-todo-subtask-total')}:{none:true};
})())
"@)
  Write-Host ("  卡片上的进度：「{0}」（{1}/{2}）" -f $progress.text, $progress.done, $progress.total)
  Check '★ 卡片上显示子任务进度 1/2' (($progress.done -eq '1') -and ($progress.total -eq '2')) (($progress | ConvertTo-Json -Compress))
  Check '  进度那行写着 1/2（不是只有个进度条）' ([bool]($progress.text -match '1/2')) ($progress.text)

  # 都勾完 → 进度变绿；但**待办本身不许被自动标完成**
  $allDone = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  // ⚠️ 别一次性 querySelector：卡片可能还没渲染出来（2026-09-21 回归里踩过一次假红），等它出现
  let gear=null;
  for(let i=0;i<15 && !gear;i++){ gear=document.querySelector('[data-todo-gear="$($sub.id)"]'); if(!gear) await sl(400); }
  gear.click(); await sl(700);
  for(const box of Array.from(document.querySelectorAll('[data-subtask-check]'))){
    if(!box.checked) { box.click(); await sl(700); }
  }
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const ts=await inv('todo_list');
  const t=ts.filter(function(x){return x.id==='$($sub.id)';})[0];
  const done=(t.subtasks||[]).filter(function(s){return s.done;}).length;
  return JSON.stringify({done:done, status:t.status});
})()
"@)
  Check '★ 全部勾完 → 2/2' ($allDone.done -eq 2) ("done=" + $allDone.done)
  Check '★ 子任务全完成**不会**顺手把待办标成完成（那是人的决定）' ($allDone.status -eq 'open') ("status=" + $allDone.status)

  # 删一条
  $removed = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const btns=Array.from(document.querySelectorAll('[data-subtask-remove]'));
  if(!btns.length) return JSON.stringify({error:'没有删除按钮'});
  btns[0].click(); await sl(1000);
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const ts=await inv('todo_list');
  const t=ts.filter(function(x){return x.id==='$($sub.id)';})[0];
  return JSON.stringify({left:(t.subtasks||[]).length});
})()
"@)
  Check '★ 删掉一条 → 只剩 1 条' ($removed.left -eq 1) ("left=" + $removed.left)

  ClosePanels
  Start-Sleep -Milliseconds 600
  $progress2 = J (EvalMain @"
JSON.stringify((function(){
  var el=document.querySelector('[data-todo-subtask-progress="$($sub.id)"]');
  return el?{done:el.getAttribute('data-todo-subtask-done'), total:el.getAttribute('data-todo-subtask-total')}:{none:true};
})())
"@)
  Check '  卡片进度跟着变成 1/1' (($progress2.done -eq '1') -and ($progress2.total -eq '1')) (($progress2 | ConvertTo-Json -Compress))
}

# ═══════════════════════ 第 3 节：番茄钟统计 ═══════════════════════
if (Want 3) {
  Write-Host ""
  Write-Host "=== ③ 番茄钟统计（M9-3） ==="
  Write-Host "  （这一项**没动后端**：番茄记录早就在 todos.json 的 pomodoros 里，只是以前没人算过）"

  # 造两条测试待办，各记几笔番茄（今天）
  #
  # ⚠️ 断言必须用**增量**（先记下当前总量、再比差值）：用户自己的待办里也可能有番茄记录，
  #    写死"应该等于 3300 秒"在真实数据上必然假红（第一版就是这么错的，数字正好翻倍）。
  $beforeFocus = J (EvalMain "JSON.stringify((function(){var el=document.querySelector('[data-focus-today]');return {seconds:parseInt(el.getAttribute('data-focus-seconds'),10)||0, count:parseInt(el.getAttribute('data-focus-count'),10)||0};})())")
  Write-Host ("  动手前：今日专注 {0} 秒 / {1} 个番茄（用户自己可能也有记录，所以下面比的是**增量**）" -f $beforeFocus.seconds, $beforeFocus.count)

  $focus = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('todo_create',{title:'M9 专注-甲 $stamp'});
  const b=await inv('todo_create',{title:'M9 专注-乙 $stamp'});
  // 甲：两笔 25 分；乙：一笔 5 分
  await inv('todo_add_pomodoro',{id:a.id,mode:'countdown',seconds:1500,note:'',finish:false});
  await inv('todo_add_pomodoro',{id:a.id,mode:'countdown',seconds:1500,note:'第二次',finish:false});
  await inv('todo_add_pomodoro',{id:b.id,mode:'countdown',seconds:300,note:'',finish:false});
  return JSON.stringify({a:a.id, b:b.id});
})()
"@)
  Start-Sleep -Milliseconds 1200
  [void](EvalMain $TPL_TODO_PAGE)

  $cardFocus = J (EvalMain @"
JSON.stringify((function(){
  var a=document.querySelector('[data-todo-pomodoro-count="$($focus.a)"]');
  var b=document.querySelector('[data-todo-pomodoro-count="$($focus.b)"]');
  return {
    aText: a?(a.innerText||'').trim():null, aSeconds: a?a.getAttribute('data-todo-focus-seconds'):null,
    bText: b?(b.innerText||'').trim():null, bSeconds: b?b.getAttribute('data-todo-focus-seconds'):null,
  };
})())
"@)
  Write-Host ("  甲卡片：「{0}」  乙卡片：「{1}」" -f $cardFocus.aText, $cardFocus.bText)
  Check '★ 卡片上写的是「番茄数 + 累计时长」（不只是数个数）' (([bool]($cardFocus.aText -match '🍅 2')) -and ([bool]($cardFocus.aText -match '50 分'))) ($cardFocus.aText)
  Check '★ 时长算对了（2 × 25 分 = 50 分 → 3000 秒）' ($cardFocus.aSeconds -eq '3000') ("aSeconds=" + $cardFocus.aSeconds)
  Check '  另一条各算各的（5 分 = 300 秒）' (($cardFocus.bSeconds -eq '300') -and ([bool]($cardFocus.bText -match '5 分'))) ($cardFocus.bText)

  $today = J (EvalMain "JSON.stringify((function(){var el=document.querySelector('[data-focus-today]');return el?{seconds:el.getAttribute('data-focus-seconds'), count:el.getAttribute('data-focus-count'), text:(el.innerText||'').replace(/\n/g,' | ')}:{none:true};})())")
  Write-Host ("  左侧「今天的专注」：「{0}」" -f $today.text)
  Check '★ 页面上有「今天的专注」这块' (-not [bool]$today.none) ''
  $deltaSeconds = ([int]$today.seconds) - $beforeFocus.seconds
  $deltaCount = ([int]$today.count) - $beforeFocus.count
  Check '★ 今日专注时长**增加了 3300 秒**（3000 + 300，各条相加）' ($deltaSeconds -eq 3300) ("增量 " + $deltaSeconds + " 秒")
  Check '★ 今日番茄个数**增加了 3 个**' ($deltaCount -eq 3) ("增量 " + $deltaCount + " 个")
  Check '  显示成人话（小时/分钟），不是一串秒数' ([bool]($today.text -match '分|小时')) ($today.text)

  Write-Host "  ⚠️ 说明：「只算今天」用的是 `isToday`（按本地日期比），"
  Write-Host "     它已经被 M5 的今日时间轴验收（tools/m5/06）钉住过：昨天的记录不进来。"
}

# ═══════════════════════ 第 4 节：已完成归档 ═══════════════════════
if (Want 4) {
  Write-Host ""
  Write-Host "=== ④ 已完成归档（M9-4） ==="

  $arch = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('todo_create',{title:'M9 归档-甲 $stamp'});
  const b=await inv('todo_create',{title:'M9 归档-乙 $stamp'});
  await inv('todo_set_done',{id:a.id,done:true});
  return JSON.stringify({a:a.id, b:b.id});
})()
"@)
  Start-Sleep -Milliseconds 1000
  [void](EvalMain $TPL_TODO_PAGE)

  $inSet = J (EvalMain @"
JSON.stringify((function(){
  var inSet=function(id){
    return Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'))
      .some(function(el){return el.getAttribute('data-todo-id')===id;});
  };
  return {done: inSet('$($arch.a)'), open: inSet('$($arch.b)')};
})())
"@)
  Check '★ 已完成的**不在待办集里**了（待办集只剩还没做的）' (-not [bool]$inSet.done) ("完成的那条还在待办集=" + $inSet.done)
  Check '  没完成的那条照旧在待办集里' ([bool]$inSet.open) ''

  $archiveUi = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  // ⚠️ "默认是收起的"说的是**重新挂载之后**的默认状态。
  //    §1 那边为了检查"完成了就不标红"会把归档展开一次 —— 若它留下的状态被带到这里，
  //    这条断言就会假红（2026-09-21 全量回归里正是如此，单独跑这一节却没事）。
  //    所以先离开执行区再回来，拿一个干净的初始状态。
  const home=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
  if(home){ home.click(); await sl(700); }
  const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
  if(nav){ nav.click(); await sl(1200); }
  var host=document.querySelector('[data-todo-archive]');
  var toggle=document.querySelector('[data-archive-toggle]');
  return JSON.stringify({hasHost:!!host, toggleText: toggle?(toggle.innerText||'').replace(/\n/g,' ').trim():null,
          bodyOpen: !!document.querySelector('[data-archive-body]')});
})()
"@)
  Write-Host ("  归档区标题：「{0}」" -f $archiveUi.toggleText)
  Check '★ 页面上有「已完成 N」这一块' ([bool]$archiveUi.hasHost) ''
  Check '  标题上写着条数' ([bool]($archiveUi.toggleText -match '已完成')) ($archiveUi.toggleText)
  Check '★ 归档区**默认是收起的**（别一直挤在眼前）' (-not [bool]$archiveUi.bodyOpen) ("bodyOpen=" + $archiveUi.bodyOpen)

  $expanded = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  document.querySelector('[data-archive-toggle]').click(); await sl(700);
  var todayGroup=document.querySelector('[data-archive-group="__today"]');
  var row=Array.from(document.querySelectorAll('[data-todo-id]')).find(function(el){return el.getAttribute('data-todo-id')==='$($arch.a)';});
  return JSON.stringify({
    bodyOpen: !!document.querySelector('[data-archive-body]'),
    todayText: todayGroup?(todayGroup.innerText||'').split('\n')[0]:null,
    doneShown: !!row,
  });
})()
"@)
  Check '★ 点一下能展开' ([bool]$expanded.bodyOpen) ''
  Check '★ 展开后能看到刚完成那条' ([bool]$expanded.doneShown) ''
  Check '★ 而且它在「今天完成」这一组里（刚做完的不会让人以为丢了）' ([bool]($expanded.todayText -match '今天完成')) ($expanded.todayText)

  $collapsed = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  document.querySelector('[data-archive-toggle]').click(); await sl(600);
  return JSON.stringify({bodyOpen: !!document.querySelector('[data-archive-body]')});
})()
"@)
  Check '  再点一下能收回去' (-not [bool]$collapsed.bodyOpen) ''
}

# ═══════════════════════ 第 5 节：搜索 + 按来源筛选 ═══════════════════════
if (Want 5) {
  Write-Host ""
  Write-Host "=== ⑤ 搜索 + 按来源筛选（M9-5） ==="

  # 造三条来源不同的待办（手动 / 笔记 / 信息）
  $sf = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const manual=await inv('todo_create',{title:'M9 筛选-手动 $stamp'});
  const note=await inv('note_create',{title:'M9 筛选源笔记 $stamp',kind:'doc',
    content:'-[]M9 筛选-笔记 $stamp\n'});
  await new Promise(r=>setTimeout(r,1200));
  const info=await inv('info_create',{text:'M9 筛选-信息 $stamp',kind:'text',categories:[],assetPath:null});
  const fromInfo=await inv('info_link_todo',{infoId:info.id});
  return JSON.stringify({manual:manual.id, noteId:note.id, infoId:info.id, fromInfo:fromInfo.id});
})()
"@)
  Start-Sleep -Milliseconds 1200
  [void](EvalMain $TPL_TODO_PAGE)

  $uiReady = J (EvalMain @'
JSON.stringify({
  hasSearch: !!document.querySelector('[data-todo-search]'),
  filters: Array.from(document.querySelectorAll('[data-todo-source-filter]')).map(function(b){return b.getAttribute('data-todo-source-filter');}),
})
'@)
  Check '★ 执行区顶部有搜索框' ([bool]$uiReady.hasSearch) ''
  Check '★ 有四个来源筛选按钮（全部/来自笔记/来自信息/手动建的）' (@($uiReady.filters).Count -eq 4) (($uiReady.filters) -join ' / ')

  $searchHit = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(document.querySelector('[data-todo-search]'),'M9 筛选-笔记 $stamp'); await sl(800);
  const rows=Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));
  const hint=(document.querySelector('[data-todo-search-hint]')||{}).innerText||'';
  return JSON.stringify({count:rows.length, hint:hint.replace(/\n/g,' ')});
})()
"@)
  Check '★ 搜索能按标题筛出那一条' ($searchHit.count -eq 1) ("命中 " + $searchHit.count + " 条")
  Check '  界面上写了"命中几条"' ([bool]($searchHit.hint -match '命中')) ($searchHit.hint)

  $filterNote = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(document.querySelector('[data-todo-search]'),''); await sl(600);
  document.querySelector('[data-todo-source-filter="note"]').click(); await sl(800);
  const rows=Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const all=await inv('todo_list');
  const kinds=rows.map(function(r){var id=r.getAttribute('data-todo-id');var t=all.filter(function(x){return x.id===id;})[0];return t?t.source.kind:'?';});
  return JSON.stringify({count:rows.length, kinds:kinds});
})()
"@)
  Write-Host ("  只看「来自笔记」：命中 {0} 条，来源分别是 {1}" -f $filterNote.count, (($filterNote.kinds) -join ','))
  Check '★ 按来源筛选之后，剩下的**全是**笔记来的' (@($filterNote.kinds | Where-Object { $_ -ne 'note' }).Count -eq 0) (($filterNote.kinds) -join ',')
  Check '  确实筛出东西来了（不是空结果）' ($filterNote.count -ge 1) ("命中 " + $filterNote.count)

  $searchDone = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const t=await inv('todo_create',{title:'M9 筛选-完成 $stamp'});
  await inv('todo_set_done',{id:t.id,done:true});
  await sl(1000);
  document.querySelector('[data-todo-source-filter="all"]').click(); await sl(500);
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(document.querySelector('[data-todo-search]'),'M9 筛选-完成 $stamp'); await sl(900);
  const archiveBody=!!document.querySelector('[data-archive-body]');
  const doneRow=Array.from(document.querySelectorAll('[data-todo-id]')).some(function(el){return el.getAttribute('data-todo-id')===t.id;});
  return JSON.stringify({archiveAutoOpen:archiveBody, doneFound:doneRow});
})()
"@)
  Check '★ 搜索时归档区**自动展开**（搜的东西可能已经完成了）' ([bool]$searchDone.archiveAutoOpen) ''
  Check '★ 搜得到已完成的那条' ([bool]$searchDone.doneFound) ''

  [void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const clear=document.querySelector('[data-todo-search-clear]');
  if(clear) clear.click();
  await sl(500);
  return 'ok';
})()
'@)
  $cleared = J (EvalMain @'
JSON.stringify({q:(document.querySelector('[data-todo-search]')||{}).value||'', filtered:!!document.querySelector('[data-todo-search-hint]')})
'@)
  Check '  「清掉筛选」能把搜索和来源筛选一起还原' (($cleared.q -eq '') -and (-not [bool]$cleared.filtered)) (($cleared | ConvertTo-Json -Compress))

  # 收尾：删掉这一节造的笔记与信息（待办在末尾统一清）
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('note_delete',{id:'$($sf.noteId)'}).then(function(){return 'ok';})")
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('info_delete',{id:'$($sf.infoId)'}).then(function(){return 'ok';})")
}

# ═══════════════════════ 第 9 节：快捷输入语法 ═══════════════════════
# 用户要的是"一行写清一件事"：`买牛奶 !明天`。
# 这一节的断言盯的是**两件事**：① 界面实时回显识别结果（打错了能看见）
# ② 落盘时标题里**没有** `!明天`、而 plannedAt 真的是明天。
if (Want 9) {
  Write-Host ""
  Write-Host "=== ⑨ 快捷输入语法（M9-9） ==="

  # 把输入框设成某段文字，回读实时提示。用了普通双引号 here-string，`$text` 会被插值。
  function SetQuick([string]$text) {
    return (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const el=document.querySelector('[data-todo-new-input]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'$text');
  el.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(350);
  const hint=document.querySelector('[data-quick-hint]');
  return JSON.stringify({
    hint: hint?hint.innerText.replace(/\n/g,' '):'',
    at: hint?hint.getAttribute('data-quick-hint-time'):'',
  });
})()
"@)
  }

  # 回车 = 真的把输入框里的东西交出去（`add()` 走的就是这条路）
  function CommitQuick {
    return (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const el=document.querySelector('[data-todo-new-input]');
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await sl(1300);
  const all=await inv('todo_list');
  const hit=all.filter(function(t){return (t.title||'').indexOf('M9 快捷')===0;});
  const t=hit[hit.length-1]||{};
  const tl=document.querySelector('[data-timeline-item="'+t.id+'"]');
  // ⚠️ 后端存的是 **UTC ISO**（`toISOString()`）：本地 18:30 在 +08 会存成 `T10:30Z`，
  //    所以时刻要在 JS 里还原成本地再断言，直接拿 `T18:30` 去 match 原始串必然假红（真踩过）。
  const d=t.plannedAt?new Date(t.plannedAt):null;
  const p=n=>String(n).padStart(2,'0');
  return JSON.stringify({
    id:t.id||'', title:t.title||'', plannedAt:t.plannedAt||'', total:hit.length,
    localDate:d?(d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())):'',
    localClock:d?(p(d.getHours())+':'+p(d.getMinutes())):'',
    localDow:d?d.getDay():-1,
    inputLeft:(document.querySelector('[data-todo-new-input]')||{}).value||'',
    hintGone:!document.querySelector('[data-quick-hint]'),
    onTimeline:!!tl,
  });
})()
'@)
  }

  $hasInput = J (EvalMain @'
JSON.stringify({
  input: !!document.querySelector('[data-todo-new-input]'),
  placeholder: (document.querySelector('[data-todo-new-input]')||{}).placeholder||'',
})
'@)
  Check '★ 加一条的输入框在' ([bool]$hasInput.input) ''
  Check '  占位符里写了语法提示（不然用户不知道有这功能）' ([bool]($hasInput.placeholder -match '!明天')) ($hasInput.placeholder)

  # ── ① `!明天`：实时回显 + 落盘后标题干净 ──
  $h1 = J (SetQuick 'M9 快捷-明天 !明天')
  Check '★ 打 "!明天" 时**实时**回显识别结果' ([bool]$h1.hint) ($h1.hint)
  Check '  回显里带了原文 token' ([bool]($h1.hint -match '!明天')) ($h1.hint)
  $tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
  Check '  解析出来的时间就是明天' ([bool]($h1.at -like "$tomorrow*")) ("$($h1.at) / 期望 $tomorrow")

  $m1 = J (CommitQuick)
  Check '★ 存下去之后标题里**没有** "!明天"' ($m1.title -eq 'M9 快捷-明天') ($m1.title)
  Check '★ plannedAt 真的设成了明天（不是只改了个标题）' ($m1.localDate -eq $tomorrow) ("$($m1.plannedAt) → 本地 $($m1.localDate) / 期望 $tomorrow")
  Check '  加完之后输入框清空、提示消失' (($m1.inputLeft -eq '') -and [bool]$m1.hintGone) ("left='" + $m1.inputLeft + "' hintGone=" + $m1.hintGone)

  # ── ② `!今天`：应该出现在"今天的专注/今日时间轴"里 ──
  [void](SetQuick 'M9 快捷-今天 !今天')
  $m2 = J (CommitQuick)
  $today = (Get-Date).ToString('yyyy-MM-dd')
  Check '★ "!今天" 设成今天' ($m2.localDate -eq $today) ("$($m2.plannedAt) → 本地 $($m2.localDate) / 期望 $today")
  Check '★ 设了今天的待办出现在**今日时间轴**上' ([bool]$m2.onTimeline) ''

  # ── ③ `!18:30`：时分（已过则顺延明天，所以只断言"时刻"） ──
  $h3 = J (SetQuick 'M9 快捷-时分 !18:30')
  Check '  打 "!18:30" 能识别' ([bool]($h3.hint -match '18:30')) ($h3.hint)
  $m3 = J (CommitQuick)
  Check '★ "!18:30" 的时刻存对了（18 点 30）' ($m3.localClock -eq '18:30') ("$($m3.plannedAt) → 本地 $($m3.localClock)")
  Check '  标题里没留下 "!18:30"' ($m3.title -eq 'M9 快捷-时分') ($m3.title)

  # ── ④ `!周五`：周几说法 ──
  $h4 = J (SetQuick 'M9 快捷-周五 !周五')
  Check '  打 "!周五" 能识别' ([bool]$h4.hint) ($h4.hint)
  $m4 = J (CommitQuick)
  Check '★ "!周五" 落在**星期五**' ($m4.localDow -eq 5) ("$($m4.plannedAt) → 本地星期 $($m4.localDow)（5=周五）")
  Check '  而且是不超过 7 天内的那个周五' (
    [bool]($m4.plannedAt) -and (([datetime]$m4.plannedAt) - (Get-Date)).TotalDays -lt 7.5
  ) ($m4.plannedAt)

  # ── ⑤ `!9-25`：月-日 ──
  [void](SetQuick 'M9 快捷-月日 !9-25')
  $m5 = J (CommitQuick)
  Check '★ "!9-25" 解析成 9 月 25 日' ([bool]($m5.localDate -like '*-09-25')) ("$($m5.plannedAt) → 本地 $($m5.localDate)")

  # ── ⑥ 看不懂的 token：**一个字都不能吃掉** ──
  $h6 = J (SetQuick 'M9 快捷-乱写 !这不是时间')
  Check '  看不懂的说法**不**瞎回显' (-not [bool]$h6.hint) ($h6.hint)
  $m6 = J (CommitQuick)
  Check '★ 看不懂时原文原样保留（没把用户打的字吃掉）' (
    $m6.title -eq 'M9 快捷-乱写 !这不是时间'
  ) ($m6.title)
  Check '  也不会硬塞一个时间进去' (-not [bool]$m6.plannedAt) ($m6.plannedAt)

  # ── ⑦ 普通待办（没有 `!`）不受影响 ──
  $h7 = J (SetQuick 'M9 快捷-普通')
  Check '  没有 "!" 时不显示识别提示' (-not [bool]$h7.hint) ($h7.hint)
  $m7 = J (CommitQuick)
  Check '  普通待办照常建出来、没有时间' (($m7.title -eq 'M9 快捷-普通') -and (-not [bool]$m7.plannedAt)) ($m7.title)

  Write-Host ("  这一节一共造了 {0} 条 M9 快捷* 待办（末尾统一清）" -f $m7.total)

  # 收尾：把输入框腾空，别留着字影响后面的节
  [void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const el=document.querySelector('[data-todo-new-input]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'');
  el.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(300);
  return 'ok';
})()
'@)
}

# ═══════════════════════ 第 6 节：重复待办 ═══════════════════════
# 用户原话里的第 6 项（顺序上排最后）。要盯的三件事：
#   ① ⚙ 里能设能清；② 勾完**自动派下一条**（时间往后推、子任务重置、状态回到未完成）；
#   ③ 来回勾**不会滚出一串**（这是重复功能最容易翻车的地方）。
if (Want 6) {
  Write-Host ""
  Write-Host "=== ⑥ 重复待办（M9-6） ==="

  # 造一条"带重复规则"的待办，返回它的 id 与设定时间
  $rp = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const d=new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
  const pad=n=>String(n).padStart(2,'0');
  const isoLocal=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':00';
  const t=await inv('todo_create',{title:'M9 重复-每天 $stamp', plannedAt:new Date(isoLocal).toISOString()});
  await inv('todo_subtask_add',{id:t.id,text:'第一步'});
  await inv('todo_subtask_add',{id:t.id,text:'第二步'});
  await new Promise(r=>setTimeout(r,400));
  return JSON.stringify({id:t.id, day:d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())});
})()
"@)
  Start-Sleep -Milliseconds 900
  [void](EvalMain $TPL_TODO_PAGE)
  Write-Host ("  造了一条重复待办（设定时间 $($rp.day) 09:00）")

  # ── ① ⚙ 里能设 ──
  $setRepeat = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  // ⚠️ 别一次性 querySelector：卡片可能还没渲染出来（2026-09-21 回归里踩过一次假红），等它出现
  let gear=null;
  for(let i=0;i<15 && !gear;i++){ gear=document.querySelector('[data-todo-gear="$($rp.id)"]'); if(!gear) await sl(400); }
  if(gear) gear.click();
  await sl(700);
  const btns=Array.from(document.querySelectorAll('[data-todo-repeat-set]'));
  const labels=btns.map(function(b){return b.getAttribute('data-todo-repeat-set')+':'+(b.innerText||'').trim();});
  const daily=btns.filter(function(b){return b.getAttribute('data-todo-repeat-set')==='daily';})[0];
  const beforeCard=!!document.querySelector('[data-todo-repeat-badge="$($rp.id)"]');
  if(daily) daily.click();
  await sl(900);
  const all=await inv('todo_list');
  const t=all.filter(function(x){return x.id==='$($rp.id)';})[0]||{};
  return JSON.stringify({labels:labels, beforeCard:beforeCard, repeat:t.repeat||''});
})()
"@)
  Check '★ ⚙ 里有四个重复档（不重复/每天/每周/每月）' (@($setRepeat.labels).Count -eq 4) (($setRepeat.labels) -join ' | ')
  Check '★ 点「每天」之后 repeat 真的存下去了' ($setRepeat.repeat -eq 'daily') ("repeat=" + $setRepeat.repeat)
  Check '  设之前卡片上没有 🔁 徽标' (-not [bool]$setRepeat.beforeCard) ''

  # 关掉 ⚙，回列表看徽标
  ClosePanels
  $badge = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  await sl(600);
  const b=document.querySelector('[data-todo-repeat-badge="$($rp.id)"]');
  return JSON.stringify({has:!!b, value:b?b.getAttribute('data-todo-repeat'):'', text:b?(b.innerText||'').trim():''});
})()
"@)
  Check '★ 设了重复之后卡片上出现 🔁 徽标' ([bool]$badge.has) ''
  Check '  徽标上写的是「每天」' ($badge.text -eq '🔁 每天') ($badge.text)

  # ── ② 勾完自动派下一条 ──
  $tick = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  await inv('todo_set_done',{id:'$($rp.id)',done:true});
  await sl(1200);
  const all=await inv('todo_list');
  const spawned=all.filter(function(t){return t.repeatFrom==='$($rp.id)';});
  const n=spawned[0]||{};
  const pad=x=>String(x).padStart(2,'0');
  const d=n.plannedAt?new Date(n.plannedAt):null;
  return JSON.stringify({
    count:spawned.length,
    title:n.title||'',
    status:n.status||'',
    repeat:n.repeat||'',
    planned:n.plannedAt||'',
    localDay:d?(d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())):'',
    subs:(n.subtasks||[]).length,
    subsDone:(n.subtasks||[]).filter(function(s){return s.done;}).length,
    pomodoros:(n.pomodoros||[]).length,
    sourceKind:(n.source||{}).kind||'',
    origin:(all.filter(function(t){return t.id==='$($rp.id)';})[0]||{}).status||'',
  });
})()
"@)
  $nextDay = ([datetime]::ParseExact($rp.day, 'yyyy-MM-dd', $null)).AddDays(1).ToString('yyyy-MM-dd')
  Check '★ 勾完自动派出一条下一次的（正好一条）' ($tick.count -eq 1) ("派了 " + $tick.count + " 条")
  Check '  原来那条是"已完成"' ($tick.origin -eq 'done') ($tick.origin)
  Check '  新的一条是"未完成"' ($tick.status -eq 'open') ($tick.status)
  Check '  标题一样、重复规则接着传下去' (($tick.title -eq "M9 重复-每天 $stamp") -and ($tick.repeat -eq 'daily')) ("$($tick.title) / $($tick.repeat)")
  Check ("★ 时间往后推了一天（{0} → {1}）" -f $rp.day, $nextDay) ($tick.localDay -eq $nextDay) ("$($tick.planned) → $($tick.localDay)")
  Check '★ 子任务照抄一份、全部重置成没完成' (($tick.subs -eq 2) -and ($tick.subsDone -eq 0)) ("$($tick.subs) 条，其中 $($tick.subsDone) 条已完成")
  Check '  番茄钟记录**不**带过去（带过去统计就假了）' ($tick.pomodoros -eq 0) ("$($tick.pomodoros)")
  Check '  新那条的来源算"手动"（不挂回笔记/信息）' ($tick.sourceKind -eq 'manual') ($tick.sourceKind)

  # ── ②b 界面上真的看得见（后端派了不等于界面刷新了） ──
  Start-Sleep -Milliseconds 600
  [void](EvalMain $TPL_TODO_PAGE)
  $visible = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  await sl(700);
  const cards=Array.from(document.querySelectorAll('[data-todo-set] [data-todo-id]'));
  const mine=cards.filter(function(el){return (el.innerText||'').indexOf('M9 重复-每天 $stamp')>=0;});
  return JSON.stringify({mine:mine.length, total:cards.length});
})()
"@)
  Check '★ 派出来的下一条**真的出现在待办集界面上**（不是只写进了文件）' ($visible.mine -eq 1) ("界面上有 " + $visible.mine + " 张 / 一共 " + $visible.total + " 张")

  # ── ③ 来回勾不滚一串 ──
  $twice = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  await inv('todo_set_done',{id:'$($rp.id)',done:false});
  await inv('todo_set_done',{id:'$($rp.id)',done:true});
  await sl(1000);
  const all=await inv('todo_list');
  return JSON.stringify({spawned:all.filter(function(t){return t.repeatFrom==='$($rp.id)';}).length});
})()
"@)
  Check '★ 取消完成再勾一次，**不会**再派一条' ($twice.spawned -eq 1) ("现在有 " + $twice.spawned + " 条派生出来的")

  # ── ④ 清掉重复规则 ──
  $cleared = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const all=await inv('todo_list');
  const next=all.filter(function(t){return t.repeatFrom==='$($rp.id)';})[0];
  await inv('todo_set_repeat',{id:next.id,repeat:null});
  await sl(700);
  const after=(await inv('todo_list')).filter(function(t){return t.id===next.id;})[0];
  return JSON.stringify({repeat:after.repeat||'', hasRepeatFrom:!!after.repeatFrom});
})()
"@)
  Check '★ 「不重复」能把规则清掉' (-not [bool]$cleared.repeat) ("repeat=" + $cleared.repeat)

  # ── ⑤ 没有重复规则的待办勾完不派新的 ──
  $plain = (J (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_create',{title:'M9 重复-一次性 $stamp'}).then(function(t){return JSON.stringify({id:t.id});})")).id
  $plainTick = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const before=(await inv('todo_list')).length;
  await inv('todo_set_done',{id:'$plain',done:true});
  await sl(900);
  return JSON.stringify({added:(await inv('todo_list')).length-before});
})()
"@)
  Check '★ 没设重复的待办勾完不会多出东西' ($plainTick.added -eq 0) ("多了 " + $plainTick.added + " 条")
}

# ═══════════════════════ 收尾 ═══════════════════════
Write-Host ""
Write-Host "=== 收尾：清掉本轮造的全部 M9 测试数据 ==="
ClosePanels
$clean = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let todos=0;
  for(const t of await inv('todo_list')){ if(/^M9 /.test(t.title||'')){ await inv('todo_delete',{id:t.id}); todos++; } }
  const left=(await inv('todo_list')).map(function(t){return t.title;});
  return JSON.stringify({todos:todos, left:left});
})()
"@)
Write-Host ("  删掉 {0} 条测试待办" -f $clean.todos)
Check '★ 用户自己的待办一条没动' (-not [bool](@($clean.left) | Where-Object { $_ -match '^M9 ' })) (($clean.left) -join ' / ')

Write-Host ""
Write-Host "======================"
Write-Host ("M9 执行区增强：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }

