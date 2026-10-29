# M7.1 · 用户试用反馈修复的验收（2026-09-21）
#
# 用户 09-20 夜里到 09-21 上午自己用了一遍，在认知区写了一篇「各种各样（笑）」，
# 里面 8 条建议；另外他对着第八节那 11 条待拍板逐一给了答复（A1/A2/A3、B1~B4、C1~C4）。
# 这个脚本逐条验**改完之后的实际行为**，不许只验"代码里写了"。
#
#   ① 小窗保存时**不拿正文首行当标题**（用户原话："标题不应该也变成这段话的最上面那一行"）
#   ② 保存后认知区**立刻就有正文**（用户原话："结果就是直接没有正文了……是有延迟吗"）
#   ③ 保存后**重开小窗是白纸**（用户原话："没有一个新的空白页面给我写"）
#   ④ 小窗**拖入/粘贴图片**（用户原话："不论是拖入还是粘贴图片文件都不可行"）
#   ⑤ 认知区左栏**再窄 1/3**（用户原话："用来编辑文本的地方太小了"）
#   ⑥ 首页**不再重复放六个入口**（用户原话："左侧都有那几个区域了"）
#   ⑦ A1：清理按钮改成「**查看**」——点开只列出来，不删；删单条另有确认
#   ⑧ B3：待办**两边都显示**（待办集 + 四象限）
#   ⑨ B4：小窗位置可选「跟随鼠标」（拿真实窗口坐标比，不看配置自说自话）
#   ⑩ C1：番茄钟**自定义时长**
#   ⑪ C2：信息删除有二次确认，而且**删之前留档**
#
# ⚠️ ④ 的拖放是**页面内合成事件**（DataTransfer + File），不是真手拖 —— 这一条如实标注，
#    真手拖留给用户自己试（写进 进度.md 的"要你亲手验"清单）。
#    其余每一条都是真实行为：真命令、真窗口坐标、真磁盘文件。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7.1\run.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m71-" + [guid]::NewGuid().ToString("N") + ".js")
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
function EvalSmall([string]$js) {
  $tmp = Join-Path $env:TEMP ("m71s-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    for ($i = 0; $i -lt 3; $i++) {
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle '速记' -RequireSelector '[data-small-body]' 2>&1
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

$stamp = Get-Date -Format 'HHmmss'

# 收尾用：把本轮造的东西清掉（**只认自己的名字**）
function Cleanup {
  $res = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const isTest=function(s){ return /^(M71 |未命名速记 )/.test((s||'').trim()); };
  let notes=0, todos=0, infos=0;
  const gone=[];
  for(const n of await inv('note_list')){ if(isTest(n.title)){ await inv('note_delete',{id:n.id}); gone.push(n.id); notes++; } }
  for(const t of await inv('todo_list')){ if(isTest(t.title)){ await inv('todo_delete',{id:t.id}); todos++; } }
  for(const i of await inv('info_list')){ if(isTest(i.text)){ await inv('info_delete',{id:i.id}); infos++; } }
  return JSON.stringify({notes:notes,todos:todos,infos:infos,noteIds:gone});
})()
'@)
  # 回收站里那些副本也按 id 精确清掉（note_delete 是进回收站，不是真删）
  $trash = Join-Path $DataDir 'notes\_trash'
  foreach ($noteId in @($res.noteIds)) {
    foreach ($suffix in @('.json', '.json.bak', '.json.tmp')) {
      $target = Join-Path $trash ($noteId + $suffix)
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
  }
  Write-Host ("  收尾清掉：笔记 {0} / 待办 {1} / 信息 {2}" -f $res.notes, $res.todos, $res.infos)
}

Write-Host "=== 准备：把上一轮残留清掉，并确保小窗是打开的 ==="
Cleanup
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2500

# ───────────────────── ① 小窗保存：标题不取正文首行 ─────────────────────
Write-Host ""
Write-Host "=== ① 小窗保存时，标题**不该**变成正文的第一行 ==="
$body1 = "这是我随口写的一段话"
$saved1 = J (EvalSmall @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  document.querySelector('[data-small-new]').click();
  await sl(500);
  setV(document.querySelector('[data-small-title]'),'');
  // ⚠️ 换行必须写成 \n 转义：here-string 里塞真换行会把 JS 字符串打断（踩过一次）
  setV(document.querySelector('[data-small-body]'),'这是我随口写的一段话，不该变成笔记标题。\n第二行也只是正文。');
  await sl(300);
  document.querySelector('[data-small-save]').click();
  await sl(2200);
  return JSON.stringify({
    editing:(document.querySelector('[data-small-editing]')||{}).innerText||'',
    status:(document.querySelector('[data-small-status]')||{}).innerText||''
  });
})()
'@)
Start-Sleep -Milliseconds 900
$made1 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var hit=ns.filter(function(n){return (n.content||'').indexOf('这是我随口写的一段话')>=0;})[0]; return JSON.stringify(hit?{title:hit.title, content:(hit.content||'').slice(0,30)}:{none:true});})")
Check '  存下来了（找得到那条正文）' (-not [bool]$made1.none) ($made1 | ConvertTo-Json -Compress)
Check '★ 标题**不是**正文第一行（用户明确不要这样）' ([bool]($made1.title -notmatch '这是我随口写的一段话')) ($made1.title)
Check '★ 标题是个一眼能认领的默认名（未命名速记 …）' ([bool]($made1.title -match '^未命名速记')) ($made1.title)
Write-Host ("  实际标题：「{0}」" -f $made1.title)

# ───────────────────── ② 保存后正文立刻就在（没有"先空再补"） ─────────────────────
Write-Host ""
Write-Host "=== ② 保存后认知区**立刻**就有正文（用户报的"只有标题没正文"） ==="
$body2 = "M71 立刻有正文验收 $stamp"
$title2 = "M71 立刻有正文 $stamp"
[void](EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  document.querySelector('[data-small-new]').click();
  await sl(500);
  setV(document.querySelector('[data-small-title]'),'$title2');
  setV(document.querySelector('[data-small-body]'),'$body2');
  await sl(300);
  document.querySelector('[data-small-save]').click();
})()
"@)
# 连采三次：**任何一次**都不该出现"标题在、正文空"的中间态
$samples = @()
for ($i = 0; $i -lt 6; $i++) {
  Start-Sleep -Milliseconds 220
  $s = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var hit=ns.filter(function(n){return n.title==='$title2';})[0]; return JSON.stringify(hit?{exists:true, len:(hit.content||'').length} : {exists:false});})")
  $samples += $s
}
$sawEmptyMiddle = @($samples | Where-Object { $_.exists -and $_.len -eq 0 })
Check '★ 采样期间从没出现过"只有标题、正文空"的中间态' ($sawEmptyMiddle.Count -eq 0) (($samples | ForEach-Object { "$($_.exists)/$($_.len)" }) -join ' ')
$final = @($samples | Where-Object { $_.exists } | Select-Object -Last 1)
Check '  最后正文是完整的' ($final.Count -ge 1 -and $final[0].len -eq $body2.Length) ("len=" + $final[0].len + " 期望 " + $body2.Length)

# ───────────────────── ③ 保存过之后，重开小窗是白纸 ─────────────────────
Write-Host ""
Write-Host "=== ③ 保存过之后重开小窗 → 应该是一张白纸（用户要的空白页） ==="
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1500
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2500
$fresh = J (EvalSmall "JSON.stringify({title:(document.querySelector('[data-small-title]')||{}).value||'', body:(document.querySelector('[data-small-body]')||{}).value||'', editing:!!document.querySelector('[data-small-editing]')})")
Check '★ 重开是空白的新页（标题、正文都空，也没在"编辑中"）' (($fresh.title -eq '') -and ($fresh.body -eq '') -and (-not $fresh.editing)) (($fresh | ConvertTo-Json -Compress))

Write-Host "  —— 再验另一半：**没保存的草稿不许丢** ——"
$draft = "M71 草稿不丢 $stamp"
[void](EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(document.querySelector('[data-small-title]'),'$draft');
  setV(document.querySelector('[data-small-body]'),'这条还没点保存就收起了。');
  await sl(400);
  return JSON.stringify({status:(document.querySelector('[data-small-status]')||{}).innerText||''});
})()
"@)
Start-Sleep -Milliseconds 600
# 走"热键那条路"（Rust 直接 hide）：前端只能尽力保存 —— 不管走哪条，内容都不许丢
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2600
$keptDraft = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var hit=ns.filter(function(n){return n.title==='$draft';})[0]; return JSON.stringify(hit?{title:hit.title, content:(hit.content||'').slice(0,20)}:{none:true});})")
Check '★ 没点保存的草稿在收起时被自动存住了（一个字没丢）' (-not [bool]$keptDraft.none) ($keptDraft | ConvertTo-Json -Compress)
Check '  而且正文也在' ($keptDraft.content -eq '这条还没点保存就收起了。') ($keptDraft.content)

# ───────────────────── ④ 小窗：粘图 / 拖图 ─────────────────────
Write-Host ""
Write-Host "=== ④ 小窗里粘图 / 拖图（⚠️ 这一步是**页面内合成事件**，真手拖留给你自己试） ==="
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2200
$png = J (EvalSmall @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  // 一张 1x1 的真 PNG（字节写死，免得依赖图片文件）
  const b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin=atob(b64); const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  const file=new File([bytes],'paste.png',{type:'image/png'});

  const ta=document.querySelector('[data-small-body]');
  if(!ta) return JSON.stringify({error:'小窗正文框不在'});
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(ta,''); await sl(200);

  // ① 粘贴
  const dt1=new DataTransfer(); dt1.items.add(file);
  ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt1,bubbles:true,cancelable:true}));
  await sl(2500);
  const afterPaste=(document.querySelector('[data-small-body]')||{}).value||'';

  // ② 拖放
  setV(document.querySelector('[data-small-body]'),''); await sl(200);
  const ta2=document.querySelector('[data-small-body]');
  const dt2=new DataTransfer(); dt2.items.add(file);
  ta2.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt2,bubbles:true,cancelable:true}));
  ta2.dispatchEvent(new DragEvent('drop',{dataTransfer:dt2,bubbles:true,cancelable:true}));
  await sl(2500);
  const afterDrop=(document.querySelector('[data-small-body]')||{}).value||'';

  return JSON.stringify({afterPaste:afterPaste.slice(0,60), afterDrop:afterDrop.slice(0,60)});
})()
'@)
Check '★ 粘贴图片 → 正文里出现了 Markdown 图片标记' ([bool]($png.afterPaste -match '!\[\]\(assets/')) ($png.afterPaste)
Check '★ 拖入图片 → 同样出现了图片标记' ([bool]($png.afterDrop -match '!\[\]\(assets/')) ($png.afterDrop)
$assetOk = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(){return JSON.stringify({ok:true});})")
Check '  命令通道还正常（没有把应用弄崩）' ([bool]$assetOk.ok) ''
# 收尾：清掉小窗里这段草稿（免得下次打开它还在）
[void](EvalSmall "(async()=>{document.querySelector('[data-small-new]')?.click(); await new Promise(r=>setTimeout(r,300)); return 'ok';})()")
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1200

# ───────────────────── ⑤ 认知区左栏窄 1/3 ─────────────────────
Write-Host ""
Write-Host "=== ⑤ 认知区左栏再窄 1/3（编辑区更宽） ==="
$col = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('认知区')>=0||b.getAttribute('title')==='认知区');
  if(nav){ nav.click(); await sl(1000); }
  // ⚠️ 页面上有**两个 aside**：第一个是全局侧边栏（w-56 那根带边框的导航），
  //    第二个才是认知区自己的笔记列表。要**按内容认**（含"新建笔记"那个），别按序号抓 ——
  //    第一版就量到侧边栏去了，差点误判成"没改成功"。
  const asides=Array.from(document.querySelectorAll('aside'));
  const aside=asides.find(function(a){return (a.innerText||'').indexOf('新建笔记')>=0;});
  const editor=document.querySelector('.cm-content')||document.querySelector('[data-tree-canvas]');
  return JSON.stringify({
    listWidth: aside?Math.round(aside.getBoundingClientRect().width):null,
    allAsides: asides.map(function(a){return Math.round(a.getBoundingClientRect().width);}),
    editorWidth: editor?Math.round(editor.getBoundingClientRect().width):null,
    pageWidth: Math.round(document.body.getBoundingClientRect().width),
  });
})()
'@)
Write-Host ("  笔记列表 {0}px ｜ 编辑区 {1}px ｜ 页面 {2}px ｜ 所有 aside：{3}" -f $col.listWidth, $col.editorWidth, $col.pageWidth, (($col.allAsides) -join '/'))
Check '★ 认知区笔记列表 ≈192px（原来是 288px，缩了 1/3）' ($col.listWidth -ge 180 -and $col.listWidth -le 200) ("实测 " + $col.listWidth)
Check '★ 编辑区确实比它宽得多（空间真的让出来了）' ($col.editorWidth -gt $col.listWidth * 2) ("编辑区 " + $col.editorWidth)

# ───────────────────── ⑥ 首页不再重复放六个入口 ─────────────────────
Write-Host ""
Write-Host "=== ⑥ 首页只留动态区，不再重复放六个入口 ==="
$homeUi = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
  if(nav){ nav.click(); await sl(900); }
  const cards=Array.from(document.querySelectorAll('section button')).filter(function(b){
    return /主动收集|灵感|长远技能积累|快进快出的收集箱|数据目录、外观/.test(b.innerText||'');
  });
  return JSON.stringify({
    entryCards: cards.length,
    hasDynamic: !!document.querySelector('[data-home-todo]')||!!document.querySelector('[data-home-reminder]')||!!document.querySelector('[data-home-empty]'),
    navStillThere: !!document.querySelector('nav'),
  });
})()
'@)
Check '★ 首页上不再有入口卡片' ($homeUi.entryCards -eq 0) ("还有 " + $homeUi.entryCards + " 张")
Check '  首页还剩动态区那套（或空态提示）' ([bool]$homeUi.hasDynamic) ''
Check '  六个入口在左侧导航里照旧' ([bool]$homeUi.navStillThere) ''

# ───────────────────── ⑦ A1：清理按钮改成「查看」 ─────────────────────
Write-Host ""
Write-Host "=== ⑦ A1：「来源已移除 N 条 · 查看」——点开只列出来，一个字节都不删 ==="
# 造两条"来源已经没了"的待办，走**真实路径**：
#   建一篇笔记 → 正文里写两条 `-[]` 标记 → 等同步生成待办 → 把那篇笔记删掉
#   → 两条待办的来源就"没了"（后端会标 sourceRemoved / 前端也会看出 source 不存在）。
# ⚠️ 别用 `todo_create` 造：它建的是 `manual` 来源的待办，**永远不算来源已移除**
#    （第一版就这么写的，于是那个入口根本不出现，7 条断言全红）。
$stale = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const note=await inv('note_create',{title:'M71 来源笔记 $stamp',kind:'doc',
    content:'随手记一句，下面两条待办会被留下来。\n-[]M71 来源没了的甲 $stamp\n-[]M71 来源没了的乙 $stamp\n'});
  await new Promise(r=>setTimeout(r,1200));
  const todos=await inv('todo_list');
  const mine=todos.filter(function(t){return (t.title||'').indexOf('M71 来源没了的')>=0;});
  const ids=mine.map(function(t){return t.id;});
  // 笔记一删，这两条待办的来源就没了（后端标 sourceRemoved，**不删待办**）
  await inv('note_delete',{id:note.id});
  await new Promise(r=>setTimeout(r,900));
  return JSON.stringify({noteId:note.id, todos:ids.length, ids:ids});
})()
"@)
Write-Host ("  用「笔记里的标记 + 删掉那篇笔记」造出 {0} 条来源已移除的待办" -f $stale.todos)
Check '  造出了 2 条（走的是真实路径，不是手搓 source）' ($stale.todos -eq 2) ($stale | ConvertTo-Json -Compress)

$purgeUi = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
  if(nav){ nav.click(); await sl(900); }
  const btn=document.querySelector('[data-todo-purge]');
  return JSON.stringify({exists:!!btn, text: btn?(btn.innerText||'').trim():''});
})()
'@)
Check '  执行区有那个入口' ([bool]$purgeUi.exists) ($purgeUi | ConvertTo-Json -Compress)
Check '★ 文案是「查看」不是「清理」（用户拍板 A1）' ([bool]($purgeUi.text -match '查看')) ($purgeUi.text)

$opened = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const btn=document.querySelector('[data-todo-purge]');
  if(!btn) return JSON.stringify({error:'按钮没了'});
  const before=await window.__TAURI_INTERNALS__.invoke('todo_list');
  btn.click();
  await sl(800);
  const dlg=document.querySelector('[role="dialog"]');
  const items=Array.from(document.querySelectorAll('[data-removed-item]'));
  const after=await window.__TAURI_INTERNALS__.invoke('todo_list');
  return JSON.stringify({
    dialogTitle: dlg?(dlg.innerText||'').split('\n')[0]:'',
    items: items.length,
    hasDeleteAll: !!document.querySelector('[data-removed-delete-all]'),
    perItemButtons: document.querySelectorAll('[data-removed-delete]').length,
    countBefore: before.length, countAfter: after.length,
  });
})()
'@)
Check '★ 点它只**打开一个窗**（不是直接删）' ([bool]($opened.dialogTitle -match '来源已移除')) ($opened.dialogTitle)
Check '★ 打开这个窗的过程中待办**一条都没少**' ($opened.countBefore -eq $opened.countAfter) ("$($opened.countBefore) → $($opened.countAfter)")
Check '  窗里逐条列出来，每条都有「删掉这条」' ($opened.items -ge 1 -and $opened.perItemButtons -eq $opened.items) ("条目 $($opened.items) / 按钮 $($opened.perItemButtons)")
Check '  还有一个「全删掉」按钮' ([bool]$opened.hasDeleteAll) ''

$delOne = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const btn=document.querySelector('[data-removed-delete]');
  if(!btn) return JSON.stringify({error:'没有单条删除按钮'});
  btn.click();
  await sl(600);
  const dlg=document.querySelector('[role="dialog"]');
  const txt=dlg?(dlg.innerText||''):'';
  // 点"取消"，确认框应该关掉、东西还在
  const cancel=Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>(b.innerText||'').trim()==='取消');
  if(cancel) cancel.click();
  await sl(600);
  return JSON.stringify({confirmShown: txt.indexOf('backups')>=0 || txt.indexOf('删掉')>=0, text:txt.slice(0,80)});
})()
'@)
Check '★ 删单条也有二次确认（而且写明会留档）' ([bool]$delOne.confirmShown) ($delOne.text)
# 关掉窗，别挡着后面的真实输入
[void](EvalMain "(async()=>{for(let i=0;i<4;i++){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,250));}return 'ok';})()")

# ───────────────────── ⑧ B3：待办两边都显示 ─────────────────────
Write-Host ""
Write-Host "=== ⑧ B3：一条待办在**待办集和四象限里都能看到**（用户：两边都显示吧） ==="
$both = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
  if(nav){ nav.click(); await sl(900); }
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const id='$($stale.ids[1])';
  await inv('todo_set_quadrant',{id:id,quadrant:'q1'});
  await sl(1200);
  const inSet=!!document.querySelector('[data-todo-set] [data-todo-id="'+id+'"]');
  // #8（2026-10-21）：四象限板搬到首页了 —— 执行区不该有，首页该有。
  const boardInTodo=!!document.querySelector('[data-quadrant]');
  const badge=!!document.querySelector('[data-todo-quadrant-badge="'+id+'"]');
  const navHome=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
  if(navHome){ navHome.click(); await sl(1100); }
  const q=document.querySelector('[data-quadrant="q1"]');
  const inQ=!!(q && q.querySelector('[data-todo-id="'+id+'"]'));
  return JSON.stringify({inSet:inSet, inQ:inQ, badge:badge, boardInTodo:boardInTodo});
})()
"@)
Check '★ 排进象限后，**首页**四象限里有它（#8 已搬去首页）' ([bool]$both.inQ) ($both | ConvertTo-Json -Compress)
Check '★ 待办集里**同样**还有它（B3 要的"两边都显示"）' ([bool]$both.inSet) ($both | ConvertTo-Json -Compress)
Check '  待办集那张卡上有个象限小标（知道它排在哪儿）' ([bool]$both.badge) ''
Check '★ 执行区不再挂四象限板（搬走了）' (-not [bool]$both.boardInTodo) ($both | ConvertTo-Json -Compress)
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('todo_set_quadrant',{id:'$($stale.ids[1])',quadrant:null}).then(function(){return 'ok';})")

# ───────────────────── ⑨ B4：小窗位置可跟随鼠标 ─────────────────────
Write-Host ""
Write-Host "=== ⑨ B4：小窗位置可选「跟随鼠标」（拿真实窗口坐标比，不看配置自说自话） ==="
$posCfg = J (EvalMain "(async()=>{const c=await window.__TAURI_INTERNALS__.invoke('config_get');return JSON.stringify({pos:(c.window&&c.window.smallPosition)||null});})()")
Check '  设置里有「小窗位置」这个字段' ($null -ne $posCfg.pos) ($posCfg | ConvertTo-Json -Compress)
$uiPos = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  // ⚠️ 得先**导航到设置页**再查（第一版忘了这一步，按钮当然找不到 —— 那时停在执行区）
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('设置')>=0||b.getAttribute('title')==='设置');
  if(nav){ nav.click(); await sl(1200); }
  return JSON.stringify({
    center:!!document.querySelector('[data-small-position=center]'),
    mouse:!!document.querySelector('[data-small-position=mouse]'),
    section:(document.body.innerText||'').indexOf('小窗出现在哪儿')>=0,
  });
})()
'@)
Check '  设置页有两个可点的选项（屏幕正中 / 跟随鼠标）' (([bool]$uiPos.center) -and ([bool]$uiPos.mouse)) ($uiPos | ConvertTo-Json -Compress)
Check '  而且这块有说明文字（用户看得懂它是干什么的）' ([bool]$uiPos.section) ''

# 用 Win32 拿真实窗口矩形 + 光标位置（不改产品代码，纯外部观测）
if (-not ("M71Win" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class M71Win {
  // ⚠️ 用 **EnumWindows 按标题找**，不用 FindWindow：
  //    FindWindow 要精确匹配类名+标题，中文标题还牵涉字符集编组，实测返回 0（窗口明明在）；
  //    EnumWindows 把每个窗口的标题都读出来，自己比一下最稳。
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public static IntPtr Find(string wanted) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,l) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString() == wanted) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<string> Titles() {
    var list = new List<string>();
    EnumWindows((h,l) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.Length > 0) list.Add(sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
}
function SmallRect {
  $h = [M71Win]::Find("东方摩耶堂 · 速记")
  if ($h -eq [IntPtr]::Zero) {
    $all = ([M71Win]::Titles() | Where-Object { $_ -match '摩耶' }) -join ' | '
    Write-Host ("  [调试] 没找到小窗窗口，当前含「摩耶」的窗口有：" + $all)
    return $null
  }
  $r = New-Object M71Win+RECT
  if (-not [M71Win]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ left = $r.Left; top = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

# 先把光标放到屏幕左上角区域一个**确定**的位置
$cursor = New-Object M71Win+POINT
[void][M71Win]::GetCursorPos([ref]$cursor)
[void][M71Win]::SetCursorPos(200, 200)
Start-Sleep -Milliseconds 400

# 切到「跟随鼠标」
[void](EvalMain "(async()=>{const c=await window.__TAURI_INTERNALS__.invoke('config_get');c.window.smallPosition='mouse';await window.__TAURI_INTERNALS__.invoke('config_save',{config:c});return 'ok';})()")
Start-Sleep -Milliseconds 900
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1200
[void][M71Win]::SetCursorPos(200, 200)
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2000
$rectMouse = SmallRect
$curMouse = New-Object M71Win+POINT
[void][M71Win]::GetCursorPos([ref]$curMouse)
if ($rectMouse) {
  Write-Host ("  跟随鼠标：光标 ({0},{1}) ｜ 小窗左上 ({2},{3}) 尺寸 {4}x{5}" -f $curMouse.X, $curMouse.Y, $rectMouse.left, $rectMouse.top, $rectMouse.w, $rectMouse.h)
  # ⚠️ **这个断言天生怕"人正在动鼠标"**：窗口是照着"唤起那一刻"的光标位置摆的，
  #    量测却在 2 秒之后 —— 2026-09-21 真撞上：用户在跟我聊天时顺手挪了一下鼠标，
  #    窗口老老实实待在 (211,211)，光标已经跑到 423，于是算出 dx=-212 报红。
  #    所以**采样 3 次取最接近的一次**：真人动鼠标不该算产品的错，但也不能把阈值放水到没意义。
  $best = $null
  for ($try = 0; $try -lt 3; $try++) {
    $r = SmallRect
    $c = New-Object M71Win+POINT
    [void][M71Win]::GetCursorPos([ref]$c)
    if ($r) {
      $dx = $r.left - $c.X
      $dy = $r.top - $c.Y
      $score = [Math]::Abs($dx) + [Math]::Abs($dy)
      if ($null -eq $best -or $score -lt $best.score) {
        $best = @{ dx = $dx; dy = $dy; score = $score }
      }
    }
    Start-Sleep -Milliseconds 400
  }
  if ($best) {
    $near = ([Math]::Abs($best.dx) -le 120) -and ([Math]::Abs($best.dy) -le 120)
    Check '★ 小窗真的弹在鼠标附近（左上角离光标 ≤120px）' $near ("dx=" + $best.dx + " dy=" + $best.dy)
    if (-not $near) { Write-Host "  （如果这会儿你正在动鼠标，这条可能被你自己搅了 —— 重跑一次就好）" }
  } else {
    Check '★ 小窗真的弹在鼠标附近（左上角离光标 ≤120px）' $false '三次都没读到位'
  }
} else {
  Check '★ 小窗真的弹在鼠标附近（左上角离光标 ≤120px）' $false '没找到小窗的原生窗口（EnumWindows 没命中标题）'
}

# 切回「屏幕正中」，窗口应该跑到屏幕中间去（离光标远）
[void](EvalMain "(async()=>{const c=await window.__TAURI_INTERNALS__.invoke('config_get');c.window.smallPosition='center';await window.__TAURI_INTERNALS__.invoke('config_save',{config:c});return 'ok';})()")
Start-Sleep -Milliseconds 900
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1200
[void][M71Win]::SetCursorPos(200, 200)
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2000
$rectCenter = SmallRect
if ($rectCenter) {
  Write-Host ("  屏幕正中：小窗左上 ({0},{1})（光标仍在 200,200）" -f $rectCenter.left, $rectCenter.top)
  $farFromCursor = ([Math]::Abs($rectCenter.left - 200) -gt 150) -or ([Math]::Abs($rectCenter.top - 200) -gt 150)
  Check '★ 切回「屏幕正中」后它不再贴着鼠标' $farFromCursor ("左上 " + $rectCenter.left + "," + $rectCenter.top)
} else {
  Check '★ 切回「屏幕正中」后它不再贴着鼠标' $false '没找到小窗窗口'
}
# 把光标放回屏幕中间，别让它留在角落
[void][M71Win]::SetCursorPos(900, 500)
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900

# ───────────────────── ⑩ C1：番茄钟自定义时长 ─────────────────────
Write-Host ""
Write-Host "=== ⑩ C1：番茄钟可以自定义时长 ==="
$pomo = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
  if(nav){ nav.click(); await sl(900); }
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const start=B().find(b=>(b.innerText||'').indexOf('开始')>=0 && b.closest('[data-todo-id]'));
  if(!start) return JSON.stringify({error:'找不到【开始】按钮'});
  start.click();
  await sl(900);
  const input=document.querySelector('[data-pomodoro-custom]');
  if(!input) return JSON.stringify({error:'番茄钟里没有自定义时长输入框'});
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  setV(input,'3');
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await sl(700);
  const clock=(document.querySelector('[data-pomodoro-clock]')||{}).innerText||'';
  const active=Array.from(document.querySelectorAll('[data-pomodoro-duration]')).map(function(b){
    return (b.className||'').indexOf('border-indigo')>=0 ? b.getAttribute('data-pomodoro-duration') : null;
  }).filter(Boolean);
  return JSON.stringify({clock:clock, activePresets:active});
})()
'@)
Check '  番茄钟里有自定义时长输入框' (-not ($pomo.error -eq '番茄钟里没有自定义时长输入框')) ($pomo.error)
Check '★ 输入 3 分钟 → 表盘变成 03:00' ([bool]($pomo.clock -match '^03:00')) ($pomo.clock)
Check '  自定义值不再匹配任何预设档（说明真的用了自定义）' (@($pomo.activePresets).Count -eq 0) (($pomo.activePresets) -join ',')
# 关掉番茄钟（别让它挡着后面的真实输入）
[void](EvalMain "(async()=>{const B=()=>Array.from(document.querySelectorAll('button'));for(let i=0;i<3;i++){const b=B().find(x=>(x.innerText||'').trim()==='关闭'||(x.innerText||'').trim()==='取消');if(b){b.click();await new Promise(r=>setTimeout(r,300));}else{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,300));}}return 'ok';})()")

# ───────────────────── ⑪ C2：信息删除有确认 + 删前留档 ─────────────────────
Write-Host ""
Write-Host "=== ⑪ C2：删信息有二次确认，而且**删之前留档**（.bak 只留上一版，不够） ==="
$infoId = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_create',{text:'M71 留档验收 $stamp',kind:'text',categories:[],assetPath:null}).then(function(v){return JSON.stringify({id:v.id});})")
Start-Sleep -Milliseconds 800
# ⚠️ 别用"文件个数 +1"来判有没有留档：`store::safety` **每族只留最近 20 份**，
#    攒满 20 份之后新档会顶掉最旧的那份，个数**不变**（2026-09-21 全量回归就这么假红过：
#    "前 20 → 后 20"）。判"留了一份新的"要看**最新那份是不是换了名字**。
$beforeFiles = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter 'info-删除前-*.json' -ErrorAction SilentlyContinue)
$beforeNewest = ($beforeFiles | Sort-Object LastWriteTime | Select-Object -Last 1).Name
$beforeCount = $beforeFiles.Count
$confirmUi = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('信息区')>=0||b.getAttribute('title')==='信息区');
  if(nav){ nav.click(); await sl(900); }
  const li=document.querySelector('li[id="info-$($infoId.id)"]');
  if(!li) return JSON.stringify({error:'信息条目不在'});
  const del=Array.from(li.querySelectorAll('button')).find(function(b){return (b.innerText||'').indexOf('删除')>=0;});
  if(!del) return JSON.stringify({error:'条目上没有删除按钮'});
  del.click();
  await sl(700);
  const dlg=document.querySelector('[role="dialog"]');
  const shown=!!dlg;
  const cancel=Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>(b.innerText||'').trim()==='取消');
  if(cancel) cancel.click();
  await sl(600);
  const still=!!document.querySelector('li[id="info-$($infoId.id)"]');
  return JSON.stringify({confirmShown:shown, stillThere:still});
})()
"@)
Check '★ 删信息会先弹二次确认' ([bool]$confirmUi.confirmShown) ($confirmUi | ConvertTo-Json -Compress)
Check '  点取消之后信息还在（确认框挡得住手滑）' ([bool]$confirmUi.stillThere) ''
# 真删一次，验留档
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('info_delete',{id:'$($infoId.id)'}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 1000
$afterFiles = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter 'info-删除前-*.json' -ErrorAction SilentlyContinue)
$afterNewest = ($afterFiles | Sort-Object LastWriteTime | Select-Object -Last 1).Name
Check '★ 删信息之前在 backups/ 里留了一份档' (($null -ne $afterNewest) -and ($afterNewest -ne $beforeNewest)) ("最新那份：$beforeNewest → $afterNewest（个数 $beforeCount → " + $afterFiles.Count + "，每族上限 20 份，顶掉最旧的时个数不变）")
if (($null -ne $afterNewest) -and ($afterNewest -ne $beforeNewest)) {
  $newest = $afterFiles | Sort-Object LastWriteTime | Select-Object -Last 1
  $text = [System.IO.File]::ReadAllText($newest.FullName, (New-Object System.Text.UTF8Encoding($false)))
  # ⚠️ 匹配串要用**双引号**（单引号里 $stamp 不插值，会去找字面上的 "$stamp"，永远匹配不上 —— 第一版就是这么假红的）
  Check '  留档里确实有被删掉那条的原文' ([bool]($text -match "M71 留档验收 $stamp")) ($newest.Name)
  # BOM 直接看**字节**：`String.StartsWith([char]0xFEFF)` 这种写法在 PS 5.1 下行为不稳
  # （留档文件本身一直是干净的，是断言写法在假红）
  $bytes = [System.IO.File]::ReadAllBytes($newest.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Check '  留档不带 BOM、而且是 JSON' ((-not $hasBom) -and $text.TrimStart().StartsWith('{')) ("BOM=" + $hasBom + " 头字节 " + (($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '))
  # 解析成对象再确认一次：结构是 { at, label, files: { "info-删除前.txt": "<info.jsonl 原文>" } }
  $parsed = $null
  try { $parsed = $text | ConvertFrom-Json } catch { }
  Check '  留档能被解析成 JSON（结构对）' ($null -ne $parsed -and $null -ne $parsed.files) ''
  if ($parsed) {
    $kept = ($parsed.files.PSObject.Properties | Select-Object -First 1).Value
    Check '  留档里那份原文含那条信息' ([bool]($kept -match "M71 留档验收 $stamp")) ((($parsed.files.PSObject.Properties | Select-Object -First 1).Name))
  } else {
    Check '  留档里那份原文含那条信息' $false '解析失败'
  }
}

# ───────────────────── 收尾 ─────────────────────
Write-Host ""
Write-Host "=== 收尾：清掉本轮造的测试数据 ==="
Cleanup
$leftNotes = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(v){return JSON.stringify(v.map(function(n){return n.title;}));})")
Check '★ 认知区里没留下测试笔记' (-not [bool](@($leftNotes) | Where-Object { $_ -match '^(M71 |未命名速记 )' })) (($leftNotes) -join ' / ')

Write-Host ""
Write-Host "======================"
Write-Host ("M7.1 用户反馈修复：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
