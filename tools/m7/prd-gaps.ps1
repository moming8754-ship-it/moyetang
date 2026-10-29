# M7 · PRD 第 10 章最后几个「没人逐条验过」的条目
#
# 为什么还要单独一个脚本：前面几套把它们漏了，或者只从**侧面**验过 ——
# 而 PRD 第 10 章是"逐条可实际检查"的准绳，漏一条就是漏一条。
#   G1  10.2-5  一条信息 45 分钟没联动 → 出提醒（内容含该信息与分类）→ 首页动态提醒区也有
#   G2  10.2-6 后半：点信息上的「→ 认知区《XX》」要**真的跳过去**、并打开那篇笔记
#   G3  10.6-3  点首页「最近待办」卡片 → 跳到执行区并**定位**那条待办
#   G4  10.8-3 前半：点 quit → 弹二次确认（真退出见 tools\m7\quit.ps1）
#
# ⚠️ G1 的「45 分钟」不是靠等 45 分钟，也不是"插一条 fireAt 在过去的提醒"——
#    后者只验了"提醒会弹"，没验 **45 分钟这个阈值**。
#    这里把测试信息的 `createdAt` 直接写成 46 分钟前，让真正的判定逻辑
#    （`reminder::scan` 拿 `reminders.infoStaleMinutes`（=45）去比）自己把它挑出来。
# ⚠️ `info.jsonl` 是用户的真数据：先备份、只**追加**一行、结尾按 id 精确删干净。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\prd-gaps.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7gap-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    # ⚠️ 空返回要重试：前端 HMR 触发**整页重载**的那一瞬间，Runtime.evaluate 会返回 undefined。
    #    表现是"脚本什么都没说，下一步拿着空 JSON 说首页没有入口"——看着像产品坏了，
    #    其实只是赶上了那一刻（2026-09-20 真在 prd12 上撞到过一次）。
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

# 回首页（先把可能挡着的弹窗关掉，否则点什么都点不动）
$TPL_HOME = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  let tries=0;
  while(tries<8){
    tries++;
    // ⚠️ 侧栏按钮的文字是「🏠\n首页」（图标换行 + 名字），判"是不是首页按钮"只能
    //    用 indexOf，不能用 === —— 这里踩过一次：`=== '首页'` 永远找不到，
    //    于是根本没跳回首页，后面"首页有没有提醒/待办卡片"全成了假失败。
    const nav=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
    if(nav){ nav.click(); }
    await sl(700);
    if(document.querySelector('[data-home-todo]')||document.querySelector('[data-home-reminder]')||document.querySelector('[data-home-empty]')||document.body.innerText.indexOf('最近待办')>=0) break;
  }
  return JSON.stringify({ok:true, onHome:!!document.querySelector('[data-home-todo]')||!!document.querySelector('[data-home-reminder]')||!!document.querySelector('[data-home-empty]')||document.body.innerText.indexOf('最近待办')>=0});
})()
'@

Write-Host "=== G1 PRD 10.2-5：45 分钟没联动的信息要出提醒（含信息与分类），首页也看得到 ==="
$stamp = Get-Date -Format 'HHmmss'
$testId = [guid]::NewGuid().ToString()
$testText = "M7 未联动45分钟验收 $stamp"
$testCat = '主动冒出·突然想起'
$infoPath = Join-Path $DataDir 'info.jsonl'
Copy-Item $infoPath (Join-Path $DataDir 'backups\info-before-m7-gaps.jsonl') -Force
$beforeInfoCount = @(Get-Content -Encoding UTF8 $infoPath | Where-Object { $_.Trim() -ne '' }).Count

# 直接把"46 分钟前创建、还没联动"的那条写进 info.jsonl。
# ⚠️ 必须**无 BOM**：PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
#    而 serde_json 不吃 BOM → 整个 info.jsonl 读不出来。真踩过，见进度.md。
$oldCreated = (Get-Date).AddMinutes(-46).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
$line = '{"id":"' + $testId + '","kind":"text","text":"' + $testText + '","createdAt":"' + $oldCreated + '","categories":["' + $testCat + '"],"status":"pending","links":[]}'
$raw = [System.IO.File]::ReadAllText($infoPath)
if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n")) { $raw += "`r`n" }
$raw += $line + "`r`n"
[System.IO.File]::WriteAllText($infoPath, $raw, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("  已写入一条「46 分钟前创建、未联动」的信息（id={0}，createdAt={1}）" -f $testId, $oldCreated)

$seen = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){var i=v.filter(function(x){return x.id==='$testId';})[0]; return JSON.stringify(i?{id:i.id,text:i.text,cats:i.categories,status:i.status}:{none:true});})")
Check '  写进去的那条信息程序能读出来（info.jsonl 没写坏）' ((-not [bool]$seen.none) -and $seen.text -eq $testText) ($seen | ConvertTo-Json -Compress)
Check '  它带着 1 个分类、状态是待联动' (($seen.cats.Count -eq 1) -and $seen.status -eq 'pending') ($seen | ConvertTo-Json -Compress)

# 判定逻辑是 `fireAt = createdAt + infoStaleMinutes`（=46 分钟前 + 45 分钟 = 1 分钟前，已经到点），
# 而"建提醒"和"把到点的提醒标成 fired"在同一次 scan 里 —— 快的话一趟 30 秒就全好了。
Write-Output "  等后台调度线程扫到它（30 秒一趟，最多等 75 秒）…"
$made = $null
$firstSeen = $null
$waited = 0
for ($i = 0; $i -lt 75; $i++) {
  Start-Sleep -Seconds 1
  $waited = $i + 1
  $list = J (EvalMain "window.__TAURI_INTERNALS__.invoke('reminder_list').then(function(v){return JSON.stringify(v);})")
  $mine = @($list | Where-Object { $_.refId -eq $testId })
  if ($mine.Count -gt 0 -and $null -eq $firstSeen) { $firstSeen = $mine[0] }
  $firedOne = @($mine | Where-Object { $_.status -eq 'fired' })
  if ($firedOne.Count -gt 0) { $made = $firedOne[0]; break }
}
Check '★ 45 分钟没联动的信息会被自动判定成「该提醒了」并生成提醒' ($null -ne $firstSeen) ("等了 $waited 秒还是没生成")
Check '★ 到了点之后它会被标成 fired（首页才会把它当"该提醒了"显示出来）' ($null -ne $made) ("等了 $waited 秒还是 pending")
if ($null -ne $made) {
  Check '   提醒种类是「信息太久没联动」' ($made.kind -eq 'info-stale') ($made.kind)
  Check '   提醒内容里带着那条信息的文字' ([bool]($made.payload.text -like "*$testText*")) ($made.payload | ConvertTo-Json -Compress)
  Check '   提醒内容里也带着它的分类' ([bool]($made.payload.categoryText -like '*突然想起*')) ($made.payload | ConvertTo-Json -Compress)
} else {
  Check '   提醒种类是「信息太久没联动」' $false '没有提醒'
  Check '   提醒内容里带着那条信息的文字' $false '没有提醒'
  Check '   提醒内容里也带着它的分类' $false '没有提醒'
}

# 首页动态提醒区也要有它（PRD 原话："且首页动态提醒区出现该提醒"）
$homeNav1 = J (EvalMain $TPL_HOME)
Start-Sleep -Milliseconds 900
Check '  回到了首页（没回到首页的话下面这条就是假失败）' ([bool]$homeNav1.onHome) ($homeNav1 | ConvertTo-Json -Compress)
$homeRem = J (EvalMain @"
JSON.stringify((function(){
  var cards=Array.from(document.querySelectorAll('[data-home-reminder]'));
  var hit=cards.filter(function(c){return (c.innerText||'').indexOf('$testText')>=0;});
  return {count:cards.length, hit:hit.length, text:hit.length?(hit[0].innerText||'').replace(/\n/g,' | ').slice(0,140):''};
})())
"@)
Check '★ 首页动态提醒区出现了这条提醒' ($homeRem.hit -ge 1) ("提醒卡 $($homeRem.count) 个，命中 $($homeRem.hit) 个")

# 收尾：信息删掉（顺带把它的提醒也带走）
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('info_delete',{id:'$testId'}).then(function(v){return JSON.stringify(v);})")
Start-Sleep -Milliseconds 800
$rawAfter = [System.IO.File]::ReadAllText($infoPath)
Check '★ 收尾：测试信息从 info.jsonl 里删干净了' (-not $rawAfter.Contains($testId)) '那条还在'
$afterInfoCount = @(Get-Content -Encoding UTF8 $infoPath | Where-Object { $_.Trim() -ne '' }).Count
Check ("   信息条数回到动手之前（{0} → {1}）" -f $beforeInfoCount, $afterInfoCount) ($afterInfoCount -eq $beforeInfoCount)
$remLeft = J (EvalMain "window.__TAURI_INTERNALS__.invoke('reminder_list').then(function(v){return JSON.stringify(v.filter(function(r){return r.refId==='$testId';}));})")
Check '   它的提醒也跟着没了（不留孤儿提醒）' ($remLeft.Count -eq 0) ($remLeft | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "=== G2 PRD 10.2-6：点信息上的「→ 认知区《XX》」要真的跳过去 ==="
$stamp2 = $stamp
$noteTitle = "M7 联动跳转验收 $stamp2"
$linkInfo = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const info=await inv('info_create',{text:'M7 联动跳转验收 $stamp2',kind:'text',categories:['主动冒出'],assetPath:null});
  const linked=await inv('info_link_note',{infoId:info.id,noteTitle:'$noteTitle',noteKind:'doc'});
  return JSON.stringify({infoId:info.id, noteId:linked.noteId||linked.id, title:linked.title});
})()
"@)
Write-Host ("  建了信息 {0}，联动进新笔记「{1}」" -f $linkInfo.infoId, $noteTitle)

# 回信息区找那条链接标记，真点它
$jumped = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('信息区')>=0||b.getAttribute('title')==='信息区');
  if(!nav) return JSON.stringify({error:'侧栏上找不到「信息区」入口'});
  nav.click(); await sl(1000);
  const inInfo=!!document.querySelector('li[id^="info-"]');
  const li=document.querySelector('li[id="info-$($linkInfo.infoId)"]');
  if(!li) return JSON.stringify({error:'信息条目不在（可能被搜索框或状态筛选藏了）', inInfo:inInfo, ids:Array.from(document.querySelectorAll('li[id^="info-"]')).map(function(x){return x.id;})});
  const chip=Array.from(li.querySelectorAll('button')).find(b=>(b.innerText||'').indexOf('→ 认知区')>=0);
  if(!chip) return JSON.stringify({error:'信息上没有「→ 认知区《…》」这个去向标记', inInfo:inInfo, text:(li.innerText||'').slice(0,120)});
  const chipText=(chip.innerText||'').trim();
  chip.click();
  await sl(1800);
  return JSON.stringify({
    inInfo:inInfo,
    chipText:chipText,
    stillInInfo: !!document.querySelector('li[id^="info-"]'),
    cmText: (document.querySelector('.cm-content')||{}).innerText||'',
  });
})()
"@)
Check '  先在信息区里看到那条信息（含它的「→ 认知区《…》」去向标记）' (-not [bool]$jumped.error) ($jumped.error)
if (-not $jumped.error) { Write-Host ("  去向标记写的是：" + $jumped.chipText) }
Check '★ 点它真的离开了信息区（说明跳转动作发生了）' ($jumped.inInfo -and (-not [bool]$jumped.stillInInfo)) ("点之前是否在信息区=" + $jumped.inInfo + "；点之后还在=" + $jumped.stillInInfo)
$cmPreview = ''
if ($jumped.cmText) { $cmPreview = ($jumped.cmText -replace "`r?`n", ' | ') }
if ($cmPreview.Length -gt 120) { $cmPreview = $cmPreview.Substring(0, 120) }
Check '★ 跳过去之后打开的就是那篇笔记（编辑器里能看到联动进来的内容）' ([bool]($cmPreview -like "*M7 联动跳转验收*")) $cmPreview

# 收尾：把那篇测试笔记和信息删掉（**连同回收站里那几个副本**，按 id 精确删）
$g2clean = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  await inv('info_delete',{id:'$($linkInfo.infoId)'});
  const gone=[];
  for(const n of await inv('note_list')){ if(/^M7 联动跳转验收/.test(n.title||'')){ await inv('note_delete',{id:n.id}); gone.push(n.id); } }
  return JSON.stringify({gone:gone});
})()
"@)
Start-Sleep -Milliseconds 900
# ⚠️ `note_delete` 是**进回收站**不是真删；不把副本清掉的话，跑几次就攒一堆
#    「M7 联动跳转验收 …」躺在用户回收站里（第一版就是这样，跑完还剩两个文件）。
$trash = Join-Path $DataDir 'notes\_trash'
$trashRemoved = 0
foreach ($noteId in @($g2clean.gone)) {
  foreach ($suffix in @('.json', '.json.bak', '.json.tmp')) {
    $target = Join-Path $trash ($noteId + $suffix)
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force; $trashRemoved++ }
  }
}
Write-Host ("  回收站里连带清掉 {0} 个文件（只删这几篇的）" -f $trashRemoved)
$leftNotes = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(v){return JSON.stringify(v.map(function(n){return n.title;}));})")
Check '   收尾：测试笔记已从认知区列表里消失' (-not [bool](@($leftNotes) | Where-Object { $_ -like 'M7 联动跳转验收*' })) ($leftNotes -join ' / ')
Check '   收尾：回收站里也没留下它的副本' ($trashRemoved -ge 2) ("清了 $trashRemoved 个文件")

Write-Host ""
Write-Host "=== G3 PRD 10.6-3：点首页「最近待办」卡片 → 跳到执行区并定位那条待办 ==="
$homeNav2 = J (EvalMain $TPL_HOME)
Start-Sleep -Milliseconds 900
Check '  回到了首页（没回到首页的话下面这条就是假失败）' ([bool]$homeNav2.onHome) ($homeNav2 | ConvertTo-Json -Compress)
$homeCards = J (EvalMain "JSON.stringify(Array.from(document.querySelectorAll('[data-home-todo]')).map(function(b){return {id:b.getAttribute('data-home-todo'), text:(b.innerText||'').trim()};}))")
Check '  首页「最近待办」里有卡片可点' (@($homeCards).Count -ge 1) ("卡片数 " + @($homeCards).Count)
if (@($homeCards).Count -ge 1) {
  $target = @($homeCards)[0]
  Write-Host ("  点第一条：「{0}」" -f $target.text)
  $jump = J (EvalMain @"
  (async()=>{
    const sl=t=>new Promise(r=>setTimeout(r,t));
    const card=document.querySelector('[data-home-todo="$($target.id)"]');
    if(!card) return JSON.stringify({error:'卡片没了'});
    card.click();
    for(let i=0;i<16;i++){
      await sl(500);
      const one=document.querySelector('[data-todo-id="$($target.id)"]');
      if(one && (one.className||'').indexOf('ring-amber')>=0) return JSON.stringify({ok:true, waited:i});
    }
    const one=document.querySelector('[data-todo-id="$($target.id)"]');
    return JSON.stringify({error:'卡片出现了但没高亮', found:!!one});
  })()
"@)
  Check '★ 点首页待办卡片 → 跳到执行区并高亮定位了那条待办' ([bool]$jump.ok) ($jump.error)
} else {
  Check '★ 点首页待办卡片 → 跳到执行区并高亮定位了那条待办' $false '首页没有待办卡片'
}

Write-Host ""
Write-Host "=== G4 PRD 10.8-3：点 quit → 二次确认（先不真退出） ==="
$homeNav3 = J (EvalMain $TPL_HOME)
Start-Sleep -Milliseconds 800
Check '  回到了首页（首页的 quit 卡片才点得到）' ([bool]$homeNav3.onHome) ($homeNav3 | ConvertTo-Json -Compress)
$quitUi = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const quit=B().find(b=>(b.innerText||'').indexOf('quit')>=0||b.getAttribute('title')==='退出程序');
  if(!quit) return JSON.stringify({error:'界面上找不到 quit 入口'});
  quit.click();
  await sl(700);
  const dlg=document.querySelector('[role="dialog"]');
  if(!dlg) return JSON.stringify({error:'点了 quit 没有二次确认弹窗'});
  const title=(dlg.innerText||'').split('\n')[0].trim();
  const hasCancel=B().some(b=>(b.innerText||'').trim()==='取消');
  // 取消掉，这一步不真退出（真退出见 tools\m7\quit.ps1）
  const cancel=B().find(b=>(b.innerText||'').trim()==='取消');
  if(cancel) cancel.click();
  await sl(500);
  return JSON.stringify({title:title, hasCancel:hasCancel, closed:!document.querySelector('[role="dialog"]')});
})()
"@)
Check '  界面上有 quit 入口' (-not [bool]$quitUi.error) ($quitUi.error)
Check '★ 点 quit 会弹二次确认（不是点一下就退）' ([bool]($quitUi.title -like '*退出*')) ($quitUi.title)
Check '  确认框上有「取消」' ([bool]$quitUi.hasCancel) ''
Check '  点取消之后确认框关掉了、程序还在' ([bool]$quitUi.closed) ''
$alive = J (EvalMain "window.__TAURI_INTERNALS__.invoke('app_info').then(function(v){return JSON.stringify({ok:true, version:v.version});}).catch(function(e){return JSON.stringify({error:String(e)});})")
Check '★ 取消之后程序完全正常（命令还能调）' ([bool]$alive.ok) ($alive.error)

Write-Host ""
Write-Host "=== G5 PRD §3.2：动态卡片右上角「×」= 临时收起（重开就回来） ==="
# 这一条 PRD 不在第 10 章里，在 §3.2 的规则表最后一行："每张卡片右上角「×」临时收起；永久取消去设置"。
[void](EvalMain $TPL_HOME)
Start-Sleep -Milliseconds 900
$hideUi = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const has=()=>!!document.querySelector('[data-home-hide="todos"]');
  const todosBefore=document.querySelectorAll('[data-home-todo]').length;
  if(!has()) return JSON.stringify({error:'「最近待办」卡片右上角没有 ×', todosBefore:todosBefore});
  document.querySelector('[data-home-hide="todos"]').click();
  await sl(700);
  return JSON.stringify({
    todosBefore:todosBefore,
    todosAfter:document.querySelectorAll('[data-home-todo]').length,
    cardStillThere:!!document.querySelector('[data-home-hide="todos"]'),
    reminderCard:!!document.querySelector('[data-home-reminder]'),
  });
})()
'@)
Check '  动态卡片右上角有「×」' (-not [bool]$hideUi.error) ($hideUi.error)
Check '★ 点 × 之后这张卡片**临时收起**了' ($hideUi.todosBefore -ge 1 -and $hideUi.todosAfter -eq 0) ("点之前 $($hideUi.todosBefore) 条 → 点之后 $($hideUi.todosAfter) 条")
Check '  收起的是它自己（别的卡片不受影响）' (-not $hideUi.cardStillThere) ("提醒卡还在吗=" + $hideUi.reminderCard)

# ★「临时」的含义：重开程序要回来。这里用**页面重载**代替重开（UI 的内存状态一样会清空）。
[void](EvalMain "setTimeout(function(){location.reload();},300); 'reloading'")
Start-Sleep -Seconds 5
$afterReload = J (EvalMain "JSON.stringify({card:!!document.querySelector('[data-home-hide=todos]'), todos:document.querySelectorAll('[data-home-todo]').length})")
Check '★ 重开（页面重载）之后卡片又回来了 —— 说明「收起」确实是**临时**的' ([bool]$afterReload.card) ($afterReload | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "======================"
Write-Host ("PRD 补漏（10.2-5 / 10.2-6 / 10.6-3 / 10.8-3 / §3.2 卡片×）：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
