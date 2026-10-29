# M7 · PRD 10.1（启动与数据持久化）+ 10.2（信息区）逐条验收
#
# 这两组在 M1/M2 时验过，但 M5/M6/M7 动过 `InfoPage` 的联动按钮、首页动态区、
# `note_save` 的 marker 同步 —— 所以现在**重新逐条过一遍**（PRD 第 10 章是"做什么"的准绳）。
#
# 10.1 第 4 条「关闭重开/重启电脑后数据仍在」需要**真的重启应用**，脚本干不了，
#      所以本脚本会**故意留下一条标记信息**（打印它的 id），
#      重启后再跑 `tools\m7\after-restart.ps1` 复查 —— 那才是真正的持久化证据。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\prd12.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("p12-" + [guid]::NewGuid().ToString("N") + ".js")
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

$stamp = Get-Date -Format 'HHmmss'
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
    const nav=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
    if(nav){ nav.click(); await sl(700); }
    // 首页"到了没有"的判断：卡片 / 空态提示 / 侧边栏任意一个在就算到了
    // （用户把首页右侧的入口列表去掉了之后，首页只剩动态区，没东西时只有一句提示）
    if(document.querySelector('[data-home-todo]')||document.querySelector('[data-home-reminder]')||
       document.querySelector('[data-home-empty]')||document.body.innerText.indexOf('最近待办')>=0) break;
    await sl(400);
  }
  const text=document.body.innerText;
  // ⚠️ 2026-09-21：用户要求首页**右侧不再放入口列表**（"左侧都有那几个区域了"），
  //    所以这六个入口现在只在**左侧导航**里。这里数的是"界面上这六个入口都在"，
  //    顺便记一下首页右边有没有重复放一份（应该没有）。
  const entries=['首页','信息区','认知区','执行区','技能区','设置'].filter(function(name){return text.indexOf(name)>=0;});
  return JSON.stringify({
    title:document.title, entries:entries,
    hasDynamic: !!document.querySelector('[data-home-todo]')||!!document.querySelector('[data-home-reminder]'),
    homeEmptyHint: !!document.querySelector('[data-home-empty]'),
    // 首页里还有没有"信息区/技能区"这类入口卡片（按它们的说明文字认）
    homeEntryCards: Array.from(document.querySelectorAll('section button')).filter(function(b){
      return /主动收集|灵感|长远技能积累|快进快出的收集箱/.test(b.innerText||'');
    }).length,
  });
})()
'@

# ───────────────────── 开工前：把上一次跑剩下的清干净 ─────────────────────
# ⚠️ 这个脚本**故意**会在结尾留下一条「M7 持久化标记」的信息（给重启复查用）。
# 于是"连着跑两次 prd12、中间不重启"就会带着上一次的标记开工 —— 上一次真撞到了：
# 多出来的那条未联动信息让 10.2 的一条断言无故失败（21/22），清干净就 22/22。
# 所以开工第一件事：把残留的标记与上次的测试数据删掉（只认自己的名字）。
Write-Host "=== 开工前：清理上一次跑剩下的测试数据 ==="
$preexisting = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let infos=0, todos=0, notes=0;
  for(const i of await inv('info_list')){ if(/^M7 (持久化标记|多分类验收)/.test(i.text||'')){ await inv('info_delete',{id:i.id}); infos++; } }
  for(const t of await inv('todo_list')){ if(/^M7 (持久化标记|多分类验收)/.test(t.title||'')){ await inv('todo_delete',{id:t.id}); todos++; } }
  const gone=[];
  for(const n of await inv('note_list')){ if(/^M7 (持久化标记|多分类验收|联动跳转验收)/.test(n.title||'')){ await inv('note_delete',{id:n.id}); gone.push(n.id); notes++; } }
  return JSON.stringify({infos:infos, todos:todos, notes:notes, noteIds:gone});
})()
'@)
Write-Host ("  清掉残留：信息 {0} / 待办 {1} / 笔记 {2}" -f $preexisting.infos, $preexisting.todos, $preexisting.notes)

# ───────────────────── 10.1 启动与数据持久化 ─────────────────────
Write-Host "=== PRD 10.1 启动与数据持久化 ==="
# ⚠️ 这一条要**重试**：主窗正在整页重载的那一瞬间，CDP 报的 title 可能是空的，
#    于是挑 target 会掉到模糊匹配上去（历史上真掉到过小窗「东方摩耶堂 · 速记」）。
#    "应用能不能打开"本来就该给几次机会 —— 不能因为赶上重载就判它坏。
$homeUi = $null
for ($i = 0; $i -lt 5; $i++) {
  $homeUi = J (EvalMain $TPL_HOME)
  if ($homeUi.title -eq '东方摩耶堂' -and @($homeUi.entries).Count -ge 6) { break }
  Start-Sleep -Milliseconds 1200
}
Check '10.1-1 应用能打开（窗口标题对、界面渲染出来了）' ($homeUi.title -eq '东方摩耶堂') ($homeUi.title)
Check '10.1-1 六个入口都在（首页/信息区/认知区/执行区/技能区/设置）' ($homeUi.entries.Count -ge 6) ($homeUi.entries -join ' / ')
# 2026-09-21 用户要求：首页右侧不再重复放入口列表（左侧导航已经有了）
Check '10.1-1（新）首页不再重复放入口卡片（用户 2026-09-21 的要求）' ($homeUi.homeEntryCards -eq 0) ("首页上的入口卡片数 " + $homeUi.homeEntryCards)

Write-Host "  10.1-2「首次打开首页没有动态卡片」的验法："
Write-Host "         动态区是**条件渲染**的（有提醒或有待办才出现）。"
Write-Host "         现在数据里有待办，所以直接验"两个开关都关 → 整块不渲染"这个条件本身。"
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.homeSticky.reminders=false; c.homeSticky.recentTodos=false;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 1000
$noDynamic = J (EvalMain $TPL_HOME)
Check '10.1-2 两个常驻项都关掉 → 首页整块动态区不渲染' (-not [bool]$noDynamic.hasDynamic) ($noDynamic | ConvertTo-Json -Compress)
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.homeSticky.reminders=true; c.homeSticky.recentTodos=true;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 900

# 设置页：数据目录可见 + 能打开
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('设置')>=0||b.getAttribute('title')==='设置');
  if(nav){ nav.click(); await sl(800); }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 800
$dirUi = J (EvalMain @'
JSON.stringify((function(){
  const text=document.body.innerText;
  const hasPath = /[A-Za-z]:\\\\/.test(text);
  const openBtn = Array.from(document.querySelectorAll('button')).find(b=>/打开/.test(b.innerText||''));
  return {hasPath:hasPath, hasOpenButton:!!openBtn, openLabel:openBtn?openBtn.innerText.trim():''};
})())
'@)
Check '10.1-5 设置里看得到数据目录路径' ([bool]$dirUi.hasPath) ($dirUi | ConvertTo-Json -Compress)
Check '10.1-5（后半句要有「打开」按钮；真打开文件夹要弹系统窗口，脚本不点它）' ([bool]$dirUi.hasOpenButton) ($dirUi.openLabel)

# ───────────────────── 10.2 信息区 ─────────────────────
Write-Host ""
Write-Host "=== PRD 10.2 信息区 ==="
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  let tries=0;
  while(tries<8){
    tries++;
    const nav=B().find(b=>(b.innerText||'').indexOf('信息区')>=0||b.getAttribute('title')==='信息区');
    if(nav){ nav.click(); await sl(700); }
    if(document.querySelector('textarea[placeholder^="随手记一条"]')) break;
    await sl(400);
  }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 700

# 10.2-1 回车录入 + 时间倒序
$MARK = "M7 持久化标记 $stamp"
$typed = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const ta=document.querySelector('textarea[placeholder^="随手记一条"]');
  if(!ta) return JSON.stringify({error:'没找到录入框'});
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'$MARK');
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(250);
  ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await sl(1600);
  const items=Array.from(document.querySelectorAll('li[id^="info-"]'));
  return JSON.stringify({count:items.length, first:(items[0]||{}).innerText||''});
})()
"@)
Check '10.2-1 录入框在（回车即存）' (-not $typed.error) ($typed.error)
Check '10.2-1 回车之后列表里立即出现了它' ($typed.first -match 'M7 持久化标记') ($typed.first -replace "`r?`n", ' | ')
Check '10.2-1 而且排在第一条（时间倒序）' ($typed.first -match 'M7 持久化标记') ($typed.first)

# 10.2-2 图片：建一条**图片类信息**，断言列表里真的渲染出缩略图（<img>）
#
# ⚠️ 这条原来是"在现有数据里找一条 image 信息" —— **数据一变就假红**：
#    2026-09-21 全量回归时数据里正好没有图片信息，它直接报"需要在界面上拖一张图才能验"。
#    现在改成**自己造一条**（用完删掉），不再依赖别人留下的数据。
#    图片指到 `assets/` 里已有的文件（**不复制新文件、不留孤儿**）——
#    `asset_import` 复制文件那一环由 `tools/m4/08-节点插图片.js` 覆盖着。
Write-Output "  （10.2-2：自己造一条图片信息指到 assets/ 里已有的图，验缩略图渲染，验完删掉）"
$imgAsset = $null
$assetDir = Join-Path $DataDir 'assets'
if (Test-Path $assetDir) {
  $imgAsset = (Get-ChildItem $assetDir -File |
    Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|gif|webp)$' } |
    Select-Object -First 1).Name
}
if ($imgAsset) {
  $imgInfo = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const made=await inv('info_create',{text:'M7 图片缩略图验收 $stamp',kind:'image',
    categories:[], assetPath:'assets/$imgAsset'});
  await new Promise(r=>setTimeout(r,1200));
  return JSON.stringify({id:made.id, path:made.assetPath||''});
})()
"@)
  Start-Sleep -Milliseconds 900
  # ⚠️ PS 双引号串里表示字面双引号要写 `""`（不是 `\"` —— 反斜杠不是 PS 的转义符，
  #    写了会让 JS 收到残缺代码、报 SyntaxError，看着像产品问题其实是脚本问题）。
  #    另外 CSS 属性选择器的值 `info-xxx` 以字母开头，是合法标识符，**不用加引号**。
  $thumb = J (EvalMain "JSON.stringify(!!document.querySelector(""[id=info-$($imgInfo.id)] img""))")
  Check '10.2-2 图片类信息在列表里渲染出了缩略图（<img>）' ([bool]$thumb) ("asset=" + $imgAsset + " info=" + $imgInfo.id)

  # 收尾：把这条测试信息删掉（assets 里那个文件是本来就有的，不动它）
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('info_delete',{id:'$($imgInfo.id)'}).then(function(){return 'ok';})")
  Start-Sleep -Milliseconds 700
} else {
  Check '10.2-2 图片类信息在列表里渲染出了缩略图（<img>）' $false "assets\ 目录里一张图都没有，没法造图片信息（这条不该发生：用户自己的图应该在里面）"
}

# 10.2-3 多个分类 → 多个标签
$multi = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const made=await inv('info_create',{text:'M7 多分类验收 $stamp',kind:'text',categories:['主动冒出','突然想起','被动接收'],assetPath:null});
  return JSON.stringify({id:made.id, cats:made.categories});
})()
"@)
Start-Sleep -Milliseconds 900
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('信息区')>=0||b.getAttribute('title')==='信息区');
  if(nav){ nav.click(); await sl(800); }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 700
$catTags = J (EvalMain "JSON.stringify((function(){var li=document.querySelector(""[id=info-$($multi.id)]""); if(!li) return {none:true}; return {text:li.innerText.replace(/\n/g,' | ')};})())")
Check '10.2-3 一条信息能挂多个分类' ($multi.cats.Count -eq 3) ($multi.cats -join '·')
Check '10.2-3 列表上把它们都显示成标签了' ($catTags.text -match '主动冒出' -and $catTags.text -match '突然想起' -and $catTags.text -match '被动接收') ($catTags.text)

# 10.2-4 搜索
$search = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const box=document.querySelector('input[placeholder^=\"搜索信息文字\"]');
  if(!box) return JSON.stringify({error:'没找到搜索框'});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,'M7 多分类验收 $stamp');
  box.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(700);
  const items=Array.from(document.querySelectorAll('li[id^=\"info-\"]'));
  return JSON.stringify({count:items.length, texts:items.map(function(li){return (li.innerText||'').slice(0,20);})});
})()
"@)
Check '10.2-4 搜索能按文字筛出那一条' ($search.count -ge 1 -and $search.count -lt 5) ("命中 " + $search.count + " 条")
Check '10.2-4 命中的正是搜索的那条' ([bool](@($search.texts) | Where-Object { $_ -match 'M7 多分类' })) ($search.texts -join ' ;; ')
# 清空搜索
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const box=document.querySelector('input[placeholder^="搜索信息文字"]');
  if(box){ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,''); box.dispatchEvent(new Event('input',{bubbles:true})); }
  await sl(500);
  return 'ok';
})()
'@)

# 10.2-5 状态筛选
$filterUi = J (EvalMain @'
JSON.stringify((function(){
  const B=Array.from(document.querySelectorAll('button'));
  const names=['全部','待联动','已联动'];
  const found=names.filter(function(n){return B.some(function(b){return (b.innerText||'').trim()===n;});});
  return {found:found};
})())
'@)
Check '10.2-5 顶部有「全部 / 待联动 / 已联动」状态筛选' ($filterUi.found.Count -ge 3) ($filterUi.found -join ' / ')

# 10.2-6 联动 A：点信息条目里的按钮 → 弹窗 → 联动 → 笔记里出现来源标记
Write-Host "  （10.2-6/7/9 联动：先在界面上点 A，再用命令走 B，最后验两个去向都在）"
$linked = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const li=document.querySelector('li[id=\"info-$($multi.id)\"]');
  if(!li) return JSON.stringify({error:'信息条目不在'});
  const btn=Array.from(li.querySelectorAll('button')).find(b=>(b.innerText||'').indexOf('联动到认知区')>=0);
  if(!btn) return JSON.stringify({error:'条目里没有联动按钮'});
  btn.click();
  await sl(900);
  const dlg=document.querySelector('[role=\"dialog\"]');
  if(!dlg) return JSON.stringify({error:'没弹出入选笔记的弹窗'});
  // ★ 一定要显式选「新建笔记」：弹窗默认是新建，但万一以后默认值被人改回「选已有笔记」，
  //   点「联动」就会把测试信息写进用户自己的笔记里（2026-09-20 真发生过：写进了「密码学联系」）。
  //   所以这里不赌默认值 —— 先点「新建笔记」，再把标题改成测试专用名字。
  const newMode=Array.from(dlg.querySelectorAll('button')).find(b=>(b.innerText||'').trim()==='新建笔记');
  if(!newMode) return JSON.stringify({error:'弹窗里没有「新建笔记」模式'});
  newMode.click();
  await sl(150);
  const input=dlg.querySelector('input');
  if(!input) return JSON.stringify({error:'新建模式下没有标题输入框'});
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(input,'M7 多分类验收联动笔记');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(150);
  const ok=Array.from(dlg.querySelectorAll('button')).find(b=>(b.innerText||'').trim()==='联动');
  if(!ok) return JSON.stringify({error:'弹窗里没有「联动」按钮'});
  ok.click();
  await sl(2200);
  return JSON.stringify({ok:true});
})()
"@)
Check '10.2-6 点信息条目里的「联动到认知区」能弹出选笔记的窗、并完成联动' ([bool]$linked.ok) ($linked.error)

$afterA = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){var i=v.filter(function(x){return x.id==='$($multi.id)';})[0]; return JSON.stringify({status:i?i.status:null, links:i?(i.links||[]).map(function(l){return l.targetKind;}):[]});})")
Check '10.2-6 联动后原信息仍在、状态变成已联动' ($afterA.status -eq 'linked') ($afterA | ConvertTo-Json -Compress)
Check '10.2-6 原信息上记了「→ 认知区」这个去向' ([bool]($afterA.links -contains 'note')) ($afterA.links -join ',')

# 笔记里要有〔联动信息〕标记
$noteHas = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const notes=await inv('note_list');
  const hit=notes.filter(function(n){return (n.content||'').indexOf('〔联动信息〕')>=0;});
  return JSON.stringify({count:hit.length, titles:hit.map(function(n){return n.title;})});
})()
'@)
Check '10.2-6 联动内容在笔记里带了「〔联动信息〕」来源标记' ($noteHas.count -ge 1) ($noteHas.titles -join ' / ')

# 10.2-7 联动 B：建为待办
$todoB = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const li=document.querySelector('li[id=\"info-$($multi.id)\"]');
  const btn=li?Array.from(li.querySelectorAll('button')).find(b=>(b.innerText||'').indexOf('建为待办')>=0):null;
  if(!btn) return JSON.stringify({error:'条目里没有「建为待办」按钮'});
  btn.click();
  await sl(2000);
  return JSON.stringify({ok:true});
})()
"@)
Check '10.2-7 点「建为待办」能建出待办' ([bool]$todoB.ok) ($todoB.error)

$afterB = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){var i=v.filter(function(x){return x.id==='$($multi.id)';})[0]; return JSON.stringify({links:i?(i.links||[]).map(function(l){return l.targetKind;}):[]});})")
Check '10.2-9 同一信息先 A 后 B → 两个去向标记都在（note + todo）' (([bool]($afterB.links -contains 'note')) -and ([bool]($afterB.links -contains 'todo'))) ($afterB.links -join ',')
$fromInfo = J (EvalMain "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(v){var t=v.filter(function(x){return x.source&&x.source.infoId==='$($multi.id)';})[0]; return JSON.stringify(t?{id:t.id,title:t.title,kind:t.source.kind}:{none:true});})")
Check '10.2-7 待办标题=信息标题、来源记的是信息区' ((-not [bool]$fromInfo.none) -and $fromInfo.kind -eq 'info') ($fromInfo | ConvertTo-Json -Compress)

# ───────────────────── 清掉本轮造的数据（**留下标记信息给重启复查**） ─────────────────────
Write-Host ""
Write-Host "=== 清掉本轮造的测试数据（「$MARK」故意留下，给重启复查用） ==="
$clean = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const infos=await inv('info_list');
  let ri=0;
  for(const i of infos){
    if((i.text||'').indexOf('M7 多分类验收')>=0){ await inv('info_delete',{id:i.id}); ri++; }
  }
  const todos=await inv('todo_list');
  let rt=0;
  for(const t of todos){
    if((t.title||'').indexOf('M7 多分类验收')>=0){ await inv('todo_delete',{id:t.id}); rt++; }
  }
  const notes=await inv('note_list');
  const gone=[];
  for(const n of notes){
    if((n.content||'').indexOf('M7 多分类验收')>=0 || /^M7 多分类验收/.test(n.title)){ await inv('note_delete',{id:n.id}); gone.push(n.id); }
  }
  return JSON.stringify({infos:ri, todos:rt, notes:gone.length, noteIds:gone});
})()
"@)
Write-Host ("  清掉 信息 {0} / 待办 {1} / 笔记 {2}" -f $clean.infos, $clean.todos, $clean.notes)
# ⚠️ `note_delete` 是**进回收站**不是真删：不把副本清掉，跑几次用户的回收站里就攒一堆
#    「M7 多分类验收…」（按 id 精确删，绝不动用户自己的回收站）
$trash = Join-Path $DataDir 'notes\_trash'
$trashRemoved = 0
foreach ($noteId in @($clean.noteIds)) {
  foreach ($suffix in @('.json', '.json.bak', '.json.tmp')) {
    $target = Join-Path $trash ($noteId + $suffix)
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force; $trashRemoved++ }
  }
}
Write-Host ("  回收站里连带清掉 {0} 个文件（只删这几篇的）" -f $trashRemoved)

$markInfo = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){var i=v.filter(function(x){return (x.text||'').indexOf('M7 持久化标记')>=0;})[0]; return JSON.stringify(i?{id:i.id,text:i.text}:{none:true});})")
Check ("「" + $MARK + "」已经落盘（重启后要复查它还在）") (-not [bool]$markInfo.none) ($markInfo | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "======================"
Write-Host ("PRD 10.1/10.2：通过 {0}，失败 {1}" -f $pass, $fail)
Write-Host ("留给重启复查的标记信息 id = {0}" -f $markInfo.id)
if ($fail -gt 0) { exit 1 }
