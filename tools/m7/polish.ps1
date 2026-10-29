# M7 · 收尾功能验收：字体/字号 + 清空回收站
#
# 覆盖 PRD §5.5「外观」里的字体与字号（`config.uiFont / bodyFont / fontSize`），
# 以及"回收站清理入口"（`notes/_trash/` 原本没有清理办法）。
#
# ⚠️ 字体这条最容易"设了没用"却看不出来：带空格的字体名**不加引号**时，
#    整条 `font-family` 会被浏览器判为非法声明直接失效，而控制台不报错。
#    所以这里必须断言**真实算出来的** font-family，而不是只看配置值。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\polish.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7p-" + [guid]::NewGuid().ToString("N") + ".js")
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

# ─────────────────────── ① 设置页有这些控件 ───────────────────────
Write-Host "=== ① 设置页：字体 / 字号 / 清空回收站 三个入口都在 ==="
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  let tries=0;
  while(tries<8){
    tries++;
    const nav=Array.from(document.querySelectorAll('button')).find(b=>(b.innerText||'').indexOf('设置')>=0||b.getAttribute('title')==='设置');
    if(nav){ nav.click(); await sl(700); }
    if(document.querySelector('[data-font-ui]')) break;
    await sl(400);
  }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 600
Check '有「界面字体」输入框' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-font-ui]'))")))
Check '有「正文字体」输入框' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-font-body]'))")))
Check '有字号按钮组' ((J (EvalMain "JSON.stringify(document.querySelectorAll('[data-font-size]').length)")) -ge 4)
Check '有「清空回收站」按钮' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-trash-purge]'))")))

# ─────────────────────── ② 界面字体真的生效 ───────────────────────
Write-Host ""
Write-Host "=== ② 界面字体：设成带空格的字体名也要真生效 ==="
$APPLY_FONT = @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.uiFont='Microsoft YaHei UI';
  c.bodyFont='';
  c.fontSize=17;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@
[void](EvalMain $APPLY_FONT)
Start-Sleep -Milliseconds 1200
$fontState = J (EvalMain @'
JSON.stringify((function(){
  const root=document.documentElement;
  return {
    uiVar: root.style.getPropertyValue('--font-ui'),
    bodyVar: root.style.getPropertyValue('--font-body'),
    sizeVar: root.style.getPropertyValue('--font-size-base'),
    bodyFontFamily: getComputedStyle(document.body).fontFamily,
    bodyFontSize: getComputedStyle(document.body).fontSize,
  };
})())
'@)
Write-Host ("  --font-ui = {0}" -f $fontState.uiVar)
Write-Host ("  body 实际 font-family = {0}" -f $fontState.bodyFontFamily)
Write-Host ("  body 实际 font-size = {0}" -f $fontState.bodyFontSize)
Check '★ 带空格的字体名被自动加了引号（不加引号整条声明会失效）' ($fontState.uiVar -match '"Microsoft YaHei UI"') ($fontState.uiVar)
Check '★ 界面真的用上了这个字体（不是只在配置里）' ($fontState.bodyFontFamily -match 'YaHei') ($fontState.bodyFontFamily)
Check '★ 字号 17px 真的生效了' ($fontState.bodyFontSize -eq '17px') ($fontState.bodyFontSize)
Check '字号也挂到变量上了' ($fontState.sizeVar -eq '17px') ($fontState.sizeVar)
Check '正文字体没设时不写 --font-body（跟着界面字体走）' (-not [bool]$fontState.bodyVar) ($fontState.bodyVar)

# ─────────────────────── ③ 正文字体单独设 ───────────────────────
Write-Host ""
Write-Host "=== ③ 正文字体单独设 → 编辑器与预览用它，界面按钮不受影响 ==="
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.bodyFont='Consolas';
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 1200
$bodyState = J (EvalMain @'
JSON.stringify((function(){
  const root=document.documentElement;
  const body=getComputedStyle(document.body).fontFamily;
  return {bodyVar: root.style.getPropertyValue('--font-body'), bodyFontFamily: body};
})())
'@)
Check '正文字体变量写进去了' ($bodyState.bodyVar -match 'Consolas') ($bodyState.bodyVar)
Check '★ 界面字体没被正文字体顶掉（两者独立）' ($bodyState.bodyFontFamily -match 'YaHei') ($bodyState.bodyFontFamily)

# 打开一篇笔记，看编辑器/预览有没有用正文字体
#
# ⚠️ 这一段原来是"在左栏里找一篇标题含「笔记测试」的笔记"—— 那篇是**别的套件造的**。
#    它被别人清掉之后，这里就永远打不开编辑器，报两条假红：
#    `编辑器正文用的是「正文字体」 :: NO_EDITOR`（2026-09-21 全量回归踩到）。
#    现在**自己造一篇**（用完删掉），不再依赖任何别的套件留下的数据。
$fontNote = J (EvalMain @"
window.__TAURI_INTERNALS__.invoke('note_create',{title:'M7 字体验收 $stamp',kind:'doc',content:'字体验收用的正文'})
  .then(function(n){return JSON.stringify({id:n.id});})
"@)
Start-Sleep -Milliseconds 900
[void](EvalMain @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  let tries=0;
  while(tries<10){
    tries++;
    const nav=B().find(b=>(b.innerText||'').indexOf('认知区')>=0||b.getAttribute('title')==='认知区');
    if(nav){ nav.click(); await sl(700); }
    const li=B().filter(b=>(b.innerText||'').indexOf('M7 字体验收 $stamp')>=0)[0];
    if(li){ li.click(); await sl(900); }
    if(document.querySelector('.cm-content')) break;
    await sl(500);
  }
  return 'ok';
})()
"@)
Start-Sleep -Milliseconds 700
$editorFont = J (EvalMain "JSON.stringify((function(){var c=document.querySelector('.cm-content'); return c?getComputedStyle(c).fontFamily:'NO_EDITOR';})())")
Write-Host ("  编辑器 .cm-content font-family = {0}" -f $editorFont)
Check '★ 编辑器正文用的是「正文字体」（不是界面字体）' ($editorFont -match 'Consolas') ($editorFont)

# 切到预览看看
[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const pv=Array.from(document.querySelectorAll('button')).find(b=>(b.innerText||'').trim()==='预览');
  if(pv){ pv.click(); await sl(900); }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 700
$previewFont = J (EvalMain "JSON.stringify((function(){var p=document.querySelector('.markdown-preview'); return p?getComputedStyle(p).fontFamily:'NO_PREVIEW';})())")
Write-Host ("  预览 .markdown-preview font-family = {0}" -f $previewFont)
Check '★ Markdown 预览也用的是「正文字体」' ($previewFont -match 'Consolas') ($previewFont)

# 收尾：把自己造的那篇字体验收笔记删掉（只删自己认得出来的那一条）
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('note_delete',{id:'$($fontNote.id)'}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 700

# ─────────────────────── ④ 还原字体设置 ───────────────────────
Write-Host ""
Write-Host "=== ④ 收尾：把字体设置还原成默认 ==="
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.uiFont=''; c.bodyFont=''; c.fontSize=16;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 1000
$restored = J (EvalMain @'
JSON.stringify((function(){
  const root=document.documentElement;
  return {ui:root.style.getPropertyValue('--font-ui'), body:root.style.getPropertyValue('--font-body'), size:getComputedStyle(document.body).fontSize};
})())
'@)
Check '清空之后字体变量都撤掉了' ((-not [bool]$restored.ui) -and (-not [bool]$restored.body)) ($restored | ConvertTo-Json -Compress)
Check '字号回到 16px' ($restored.size -eq '16px') ($restored.size)

# ─────────────────────── ⑤ 清空回收站 ───────────────────────
Write-Host ""
Write-Host "=== ⑤ 清空回收站：先造一个删掉的笔记，再清 ==="

# ⚠️⚠️ **`trash_purge` 清的是整个回收站，包括用户自己删的东西！**
#     2026-09-21 全量回归跑这套时，把用户回收站里的两条笔记（「好累呀，去休息吧」「笔记测试」）
#     一起清掉了 —— 幸好 `store::safety` 会在清空前留档，已经照档恢复回去。
#     **测试不许动用户的数据**，所以这里先把"本来就躺在回收站里的东西"挪到一边，跑完再挪回来。
#     ⚠️ 挪的时机必须在**造测试笔记之前**，否则会连自己造的那条也挪走、purge 回来 0、断言全假红。
$trashDir = Join-Path $DataDir 'notes\_trash'
$stashDir = Join-Path $env:TEMP ('m7-trash-stash-' + [guid]::NewGuid().ToString('N'))
$stashed = @()
if (Test-Path $trashDir) {
  $existing = @(Get-ChildItem $trashDir -File -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $stashDir | Out-Null
    foreach ($f in $existing) {
      Move-Item -LiteralPath $f.FullName -Destination (Join-Path $stashDir $f.Name) -Force
      $stashed += $f.Name
    }
    Write-Host ("  （回收站里本来有 {0} 个文件 —— 先挪到一边，测完还回去）" -f $stashed.Count)
  }
}

$before = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const made=await inv('note_create',{title:'M7 回收站验收',kind:'doc'});
  await inv('note_save',{note:Object.assign({},made,{content:'这条是用来验回收站的'})});
  await inv('note_delete',{id:made.id});
  return JSON.stringify({ok:true});
})()
'@)
Check '造了一篇笔记并删掉（会进回收站）' ([bool]$before.ok)

# ⚠️ **先抓一份"清之前"的笔记标题**，清完再比对。
#    原来这条断言硬编码了用户笔记的标题（`密码学联系`），用户一改名就假红 ——
#    2026-09-21 全量回归真踩到（那篇笔记现在叫「基础密码学的学习规划」）。
#    断言的本意是"清回收站不许动正式笔记"，跟标题叫什么无关，所以改成前后比对。
$aliveBefore = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(v){return JSON.stringify(v.map(function(n){return n.title;}));})")

$purged = J (EvalMain "window.__TAURI_INTERNALS__.invoke('trash_purge').then(function(n){return JSON.stringify(n);})")
Write-Output ("  清空回收站 → 删掉 {0} 个文件" -f $purged)
Check '★ 清空回收站返回了删掉的个数' ($purged -ge 1) ($purged)

# 再清一次应该是 0（幂等，不报错）
$again = J (EvalMain "window.__TAURI_INTERNALS__.invoke('trash_purge').then(function(n){return JSON.stringify(n);})")
Check '★ 再清一次返回 0（回收站空了，不报错）' ($again -eq 0) ($again)

# 现有数据一根毫毛都不能动
$alive = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(v){return JSON.stringify(v.map(function(n){return n.title;}));})")
Write-Host ("  清之前的笔记：" + ($aliveBefore -join ' / '))
Write-Host ("  清之后的笔记：" + ($alive -join ' / '))
Check '★ 清空回收站没有动到正式笔记' (($alive -join '|') -eq ($aliveBefore -join '|')) ($alive -join ' / ')
Check '  清之前本来是有正式笔记的（不然上面那条是空对空）' (@($aliveBefore).Count -ge 1) ("清之前 " + @($aliveBefore).Count + " 篇")
Check '被删的那篇没被"复活"' (-not [bool]($alive -contains 'M7 回收站验收')) ($alive -join ' / ')

# 把一开始挪走的（用户自己的）回收站内容还回去 —— 一个字节都不能少
if ($stashed.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $trashDir | Out-Null
  foreach ($name in $stashed) {
    Move-Item -LiteralPath (Join-Path $stashDir $name) -Destination (Join-Path $trashDir $name) -Force
  }
  Remove-Item $stashDir -Force -Recurse -ErrorAction SilentlyContinue
}
$trashNow = @(Get-ChildItem $trashDir -File -ErrorAction SilentlyContinue).Count
Check '★ 测完之后回收站里原有内容一个不少地回来了' ($trashNow -eq $stashed.Count) ("还回去 " + $stashed.Count + " 个，现在 " + $trashNow + " 个")

Write-Host ""
Write-Host "======================"
Write-Host ("M7 收尾功能：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
