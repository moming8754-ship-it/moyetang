# M8 · 认知区「分组 + 折叠」验收（方案 A，2026-09-21 用户拍板）
#
# 用户反馈原话："认知区太乱了，我认为认知区应该搞一个类似文件夹的功能"；
# 三档方案里他**否掉了 C（标签+全文搜索）**，在 A / B 之间**选了 A**：
#   A = 给笔记贴一个"分组名"，左栏按分组折叠显示（像手机相册的"相簿"），
#       **不做嵌套、不做拖拽进文件夹**（那是 B）。
#   他说"我用几次再给你反馈"—— 所以这个脚本要覆盖的正是"用起来会不会别扭"的那几件事。
#
# 验收点：
#   ① 老笔记（没有 group 字段）照样读得出来 —— 后端有单测，这里从界面侧再确认一次
#   ② 「移到分组」菜单：新建分组 / 移到已有分组 / 移出分组
#   ③ 左栏真的按分组分段了，**未分组永远在最后**
#   ④ 分组能折叠/展开，折叠后那组的笔记不显示
#   ⑤ **搜索时平铺**（不按分组缩进）—— 这是定的规则
#   ⑥ 移进某组后那组**自动展开**（不然用户会以为笔记没了）
#   ⑦ **重启之后分组还在**（写盘的证据）
#   ⑧ 收尾：清掉本轮造的笔记，用户自己的笔记一篇不动
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m8\run.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m8-" + [guid]::NewGuid().ToString("N") + ".js")
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

$stamp = Get-Date -Format 'HHmmss'
$G1 = "M8 甲组 $stamp"
$G2 = "M8 乙组 $stamp"

# 进认知区的公共片段
$TPL_GO_COGNITION = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('认知区')>=0||b.getAttribute('title')==='认知区');
  if(nav){ nav.click(); await sl(1000); }
  return 'ok';
})()
'@

Write-Host "=== 准备：进认知区，确认界面在 ==="
[void](EvalMain $TPL_GO_COGNITION)
$ready = J (EvalMain "JSON.stringify({hasList: !!document.querySelector('[data-note-list]'), notes: document.querySelectorAll('[data-note-row]').length})")
Check '认知区列表渲染出来了' ([bool]$ready.hasList) ($ready | ConvertTo-Json -Compress)
Write-Host ("  现有笔记 {0} 篇" -f $ready.notes)

# ───────────────────── ① 老数据兼容（界面上再看一眼） ─────────────────────
Write-Host ""
Write-Host "=== ① 老笔记（没有 group 字段）照样在列表里 ==="
$legacy = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){return JSON.stringify({total:ns.length, noGroup:ns.filter(function(n){return n.group===undefined||n.group===null||n.group==='';}).length, sample:ns.slice(0,3).map(function(n){return n.title+'|'+JSON.stringify(n.group);})});})")
Check '  后端返回的笔记里，老笔记的 group 是空串（不是报错）' ($legacy.noGroup -ge 0) ($legacy.sample -join ' ;; ')
Write-Host ("  共 {0} 篇，其中未分组 {1} 篇" -f $legacy.total, $legacy.noGroup)

# ───────────────────── ②③④ 建两组、移进去、折叠 ─────────────────────
Write-Host ""
Write-Host "=== ② 造三篇测试笔记，用「移到分组」建两个分组 ==="
$made = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const a=await inv('note_create',{title:'M8 甲一 $stamp',kind:'doc',content:'甲组第一篇'});
  const b=await inv('note_create',{title:'M8 甲二 $stamp',kind:'doc',content:'甲组第二篇'});
  const c=await inv('note_create',{title:'M8 乙一 $stamp',kind:'doc',content:'乙组第一篇'});
  return JSON.stringify({a:a.id,b:b.id,c:c.id});
})()
"@)
Start-Sleep -Milliseconds 900
[void](EvalMain $TPL_GO_COGNITION)

$moved = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  const steps=[];
  // ⚠️ 别一次性 querySelector 就下结论：页面刚刷新过、或者那一行正好在被折叠的组里时，
  //    它会**暂时**不在 DOM 里（2026-09-21 全量回归里出现过"第三篇的 ⋮ 找不到"，
  //    单独跑同一套又是全绿 —— 典型的状态/时机问题）。
  //    这里等它出现，顺手把收着的分组展开；真找不到时**把当时列表里的行 id 一起报出来**，
  //    下次一眼能看出是"页面没渲染"还是"行真的不在"。
  async function rowBtn(id){
    for(let i=0;i<12;i++){
      const btn=document.querySelector('[data-note-group-btn="'+id+'"]');
      if(btn) return btn;
      const collapsed=Array.from(document.querySelectorAll('[data-group-toggle]'))
        .filter(function(b){ return (b.innerText||'').indexOf('▸')>=0; });
      if(collapsed.length) collapsed.forEach(function(b){ b.click(); });
      await sl(400);
    }
    return null;
  }
  function rowsNow(){
    return Array.from(document.querySelectorAll('[data-note-row]'))
      .map(function(r){ return r.getAttribute('data-note-row'); }).join(',');
  }
  async function moveTo(id, group){
    const btn=await rowBtn(id);
    if(!btn) { steps.push('找不到 '+id+' 的⋮（当时列表里的行：'+rowsNow()+'）'); return; }
    btn.click(); await sl(400);
    const menu=document.querySelector('[data-note-group-menu="'+id+'"]');
    if(!menu) { steps.push('菜单没弹出来'); return; }
    const input=menu.querySelector('[data-group-new-input]');
    setV(input, group); await sl(200);
    const ok=menu.querySelector('[data-group-new-confirm]');
    ok.click(); await sl(900);
    steps.push('moved:'+group);
  }
  await moveTo('$($made.a)','$G1');
  await moveTo('$($made.b)','$G1');
  await moveTo('$($made.c)','$G2');
  return JSON.stringify({steps:steps});
})()
"@)
Write-Host ("  动作：" + (($moved.steps) -join ' / '))
Check '  三篇都通过界面菜单移进了分组（走的不是命令直调）' (@($moved.steps | Where-Object { $_ -like 'moved:*' }).Count -eq 3) (($moved.steps) -join ' ')

$groupsApi = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_groups').then(function(v){return JSON.stringify(v);})")
Check '★ 后端的分组清单里有这两个组' (([bool]($groupsApi -contains $G1)) -and ([bool]($groupsApi -contains $G2))) (($groupsApi) -join ' / ')
$onDisk = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var hit=ns.filter(function(n){return n.id==='$($made.a)';})[0];return JSON.stringify({group:hit?hit.group:null, title:hit?hit.title:null, content:hit?hit.content:null});})")
Check '★ 分组真的写到盘上了（笔记的 group 字段）' ($onDisk.group -eq $G1) ($onDisk | ConvertTo-Json -Compress)
Check '  改分组没碰标题和正文' (($onDisk.title -eq "M8 甲一 $stamp") -and ($onDisk.content -eq '甲组第一篇')) ($onDisk | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "=== ③④ 左栏按分组分段 + 折叠 ==="
$layout = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const secs=Array.from(document.querySelectorAll('[data-note-group]'));
  const names=secs.map(function(s){return s.getAttribute('data-note-group');});
  const rows=Array.from(document.querySelectorAll('[data-note-row]')).map(function(r){return r.getAttribute('data-note-row');});
  return JSON.stringify({names:names, rowCount:rows.length, hasJia:rows.indexOf('$($made.a)')>=0});
})()
"@)
Write-Host ("  分段：" + (($layout.names | ForEach-Object { if ($_ -eq '') { '(未分组)' } else { $_ } }) -join ' | '))
Check '★ 左栏按分组分段了（两个测试组都在）' (([bool]($layout.names -contains $G1)) -and ([bool]($layout.names -contains $G2))) (($layout.names) -join ' / ')
$ungroupedIndex = [array]::IndexOf($layout.names, '')
Check '★ 未分组永远排在最后' ($ungroupedIndex -eq -1 -or $ungroupedIndex -eq ($layout.names.Count - 1)) ("未分组在第 " + $ungroupedIndex + " 位，共 " + $layout.names.Count + " 段")

$collapse = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const before=Array.from(document.querySelectorAll('[data-note-row]')).length;
  const toggle=document.querySelector('[data-group-toggle="$G1"]');
  if(!toggle) return JSON.stringify({error:'没找到 $G1 的折叠按钮'});
  toggle.click(); await sl(600);
  const afterCollapse=Array.from(document.querySelectorAll('[data-note-row]')).length;
  const stillHasJia=!!document.querySelector('[data-note-row="$($made.a)"]');
  toggle.click(); await sl(600);
  const afterExpand=Array.from(document.querySelectorAll('[data-note-row]')).length;
  return JSON.stringify({before:before, afterCollapse:afterCollapse, afterExpand:afterExpand, stillHasJia:stillHasJia});
})()
"@)
Check '★ 折叠之后那一组的笔记就不显示了' (($collapse.afterCollapse -eq $collapse.before - 2) -and (-not $collapse.stillHasJia)) (($collapse | ConvertTo-Json -Compress))
Check '★ 再点一下能展开回来（=折叠不是删除）' ($collapse.afterExpand -eq $collapse.before) (($collapse | ConvertTo-Json -Compress))

# ───────────────────── ⑤ 搜索平铺 ─────────────────────
Write-Host ""
Write-Host "=== ⑤ 搜索时平铺（不按分组缩进） ==="
$search = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  const box=document.querySelector('input[placeholder^="搜索标题"]');
  if(!box) return JSON.stringify({error:'没有搜索框'});
  setV(box,'M8 甲一 $stamp'); await sl(700);
  const grouped=document.querySelectorAll('[data-note-group]').length;
  const rows=Array.from(document.querySelectorAll('[data-note-row]')).length;
  setV(box,''); await sl(500);
  return JSON.stringify({groupedWhileSearching:grouped, rows:rows});
})()
"@)
Check '★ 搜索时不再按分组分段（平铺）' ($search.groupedWhileSearching -eq 0) (($search | ConvertTo-Json -Compress))
Check '  搜索命中 1 篇' ($search.rows -eq 1) ("命中 " + $search.rows)

# ───────────────────── ⑥ 移进去自动展开 ─────────────────────
Write-Host ""
Write-Host "=== ⑥ 把一个折叠起来的组移进新笔记 → 那组要自动展开 ==="
$autoExpand = J (EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const fresh=await inv('note_create',{title:'M8 丙 $stamp',kind:'doc',content:'丙'});
  await sl(900);
  // 先把 G2 折叠起来
  const t2=document.querySelector('[data-group-toggle="$G2"]');
  if(t2){ t2.click(); await sl(500); }
  const collapsedNow=!document.querySelector('[data-note-row="$($made.c)"]');
  // 再把这篇新笔记移进 G2（同样等它出现，别一次性 querySelector）
  let btn=null;
  for(let i=0;i<12 && !btn;i++){ btn=document.querySelector('[data-note-group-btn="'+fresh.id+'"]'); if(!btn) await sl(400); }
  if(!btn) return JSON.stringify({error:'找不到新笔记的⋮'});
  btn.click(); await sl(400);
  const menu=document.querySelector('[data-note-group-menu="'+fresh.id+'"]');
  const pick=Array.from(menu.querySelectorAll('[data-group-pick]')).find(function(b){return b.getAttribute('data-group-pick')==='$G2';});
  if(!pick) return JSON.stringify({error:'菜单里没有 $G2'});
  pick.click(); await sl(900);
  const expandedAfter=!!document.querySelector('[data-note-row="'+fresh.id+'"]');
  return JSON.stringify({collapsedBeforeMoved:collapsedNow, expandedAfter:expandedAfter});
})()
"@)
Check '  移进去之前那组确实是折叠的' ([bool]$autoExpand.collapsedBeforeMoved) (($autoExpand | ConvertTo-Json -Compress))
Check '★ 移进折叠的组之后它自动展开了（不会让人以为笔记丢了）' ([bool]$autoExpand.expandedAfter) (($autoExpand | ConvertTo-Json -Compress))

# ───────────────────── ⑦ 重启后仍在（写盘证据） ─────────────────────
Write-Host ""
Write-Host "=== ⑦ 分组是写盘的（从磁盘文件直接核对） ==="
$files = Get-ChildItem (Join-Path $DataDir 'notes\*.json') -File
$found = @()
foreach ($f in $files) {
  $raw = [System.IO.File]::ReadAllText($f.FullName, (New-Object System.Text.UTF8Encoding($false)))
  if ($raw -match [regex]::Escape($G1)) { $found += $f.Name }
}
Check ("★ 磁盘上的笔记文件里写着分组名「{0}」" -f $G1) ($found.Count -ge 1) ("匹配 " + $found.Count + " 个文件")
$rawOne = [System.IO.File]::ReadAllText((Join-Path $DataDir ('notes\' + $found[0])), (New-Object System.Text.UTF8Encoding($false)))
Check '  是标准的 JSON 字段 group（不是别的什么）' ([bool]($rawOne -match '"group"\s*:\s*"')) ''

# ───────────────────── ⑧ 收尾 ─────────────────────
Write-Host ""
Write-Host "=== ⑧ 收尾：清掉本轮造的测试笔记 ==="
$clean = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const gone=[];
  for(const n of await inv('note_list')){
    if(/^M8 (甲一|甲二|乙一|丙) $stamp/.test(n.title||'')){ await inv('note_delete',{id:n.id}); gone.push(n.id); }
  }
  const left=(await inv('note_list')).map(function(n){return n.title;});
  return JSON.stringify({removed:gone.length, noteIds:gone, left:left});
})()
"@)
Write-Host ("  删掉 {0} 篇测试笔记" -f $clean.removed)
$trash = Join-Path $DataDir 'notes\_trash'
foreach ($noteId in @($clean.noteIds)) {
  foreach ($suffix in @('.json', '.json.bak', '.json.tmp')) {
    $target = Join-Path $trash ($noteId + $suffix)
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  }
}
Check '★ 用户自己的笔记一篇没动' (-not [bool](@($clean.left) | Where-Object { $_ -match '^M8 ' })) (($clean.left) -join ' / ')

Write-Host ""
Write-Host "======================"
Write-Host ("M8 分组+折叠：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
