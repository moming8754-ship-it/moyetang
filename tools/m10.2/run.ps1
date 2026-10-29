# ════════════════════════════════════════════════════════════════════════════
# M10.2 · V1 收尾验收（DEV-PLAN-v2 §2 的任务 1 + 任务 3）
#
#   §1 任务 3「软件页面上方显示版本号」
#      · 顶栏有版本号徽标，且**与 tauri.conf.json 的 version 一致**（这一条就是"没硬编码"的证据）
#      · 六个页面都看得到；与设置页「关于」里的是同一个号
#   §2 任务 1「修『改字号没用』」
#      · 六档字号逐个切，量**浏览器算出来的 font-size**（不是读我们自己的变量）：
#        侧栏 nav 按钮 / 顶栏版本徽标 / 正文(body) / 编辑器(.cm-content) / 预览(.markdown-preview)
#      · 六档量出来必须互不相同 —— 这正是"改了没用"的反面
#
# 用法（应用要以 CDP 9222 起着，见 tools\cdp.ps1）：
#   powershell -ExecutionPolicy Bypass -File tools\m10.2\run.ps1
#   powershell -ExecutionPolicy Bypass -File tools\m10.2\run.ps1 -Only 1
#
# ⚠️ 数据安全：本脚本只动**自己造的东西**——
#   ① `config.json` 的 `fontSize`：**开工先读原值、收尾还原、并断言还原成功**（顺带核对 theme /
#      快捷键 / 小窗位置没被碰过）。进度.md 第五节记着：m7/prd.ps1 曾把用户的主题从 dark 改成
#      system，跑一遍测试他自己的选择就没了 —— 写任何会改 config 的用例都照这里来。
#   ② 一篇 `M10 字号验收` 的文本笔记（收尾按 id 删掉；`notes/_trash/` 里的副本交给
#      `tools\cleanup-test-data.ps1`）。
# ════════════════════════════════════════════════════════════════════════════
param([int]$Port = 9222, [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
$confPath = Join-Path (Split-Path -Parent $tools) 'src-tauri\tauri.conf.json'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m102-" + [guid]::NewGuid().ToString("N") + ".js")
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

# 求值 + 解析；读不到就回 $null（调用方必须显式判空 —— 否则会变成"假通过"）
function EvalJson([string]$js) {
  $t = EvalMain $js
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}

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

Write-Host ""
Write-Host "=== §1 任务 3：软件页面上方显示版本号 ==="

$confVer = ''
if (Test-Path $confPath) { $confVer = (Get-Content -Raw -Encoding UTF8 $confPath | ConvertFrom-Json).version }
Check '读得到 tauri.conf.json 的 version（版本号的单一来源）' ([bool]$confVer) $confPath

if (Want 1) {
  $top = EvalJson @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let el=null;
  for(let i=0;i<20 && !el;i++){ el=document.querySelector('[data-app-version]'); if(!el) await sl(400); }
  return JSON.stringify({found:!!el, text:el?el.textContent.trim():'', title:el?(el.getAttribute('title')||''):''});
})()
'@
  if (-not $top) {
    Check '① 顶栏有版本号徽标' $false '没读到结果（应用没起来 / 挑错窗口了？）'
    Check '② 顶栏版本号与 tauri.conf.json 一致' $false '上一条没跑起来'
  }
  else {
    Check '① 顶栏有版本号徽标 [data-app-version]' $top.found '顶栏没找到这个元素'
    Check ("② 顶栏显示 v{0}，与 tauri.conf.json 的 version 一致（★ 这条就是「没硬编码」的证据）" -f $confVer) ($top.text -eq ('v' + $confVer)) ("顶栏显示的是 '" + $top.text + "'")

    # 六个页面都看得到：逐个点导航，每切一次就看一眼顶栏还在不在、号变没变
    $pages = EvalJson @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const LAB=['首页','信息区','认知区','执行区','技能区','设置'];
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  const seen={};
  for(const lab of LAB){
    let nav=null;
    for(let i=0;i<15 && !nav;i++){
      nav=B().find(b=>(b.innerText||'').indexOf(lab)>=0 || b.getAttribute('title')===lab);
      if(!nav) await sl(300);
    }
    if(!nav){ seen[lab]='找不到导航按钮'; continue; }
    nav.click(); await sl(800);
    const el=document.querySelector('[data-app-version]');
    seen[lab]=el?el.textContent.trim():'顶栏没有版本号了';
  }
  return JSON.stringify(seen);
})()
'@
    foreach ($lab in @('首页', '信息区', '认知区', '执行区', '技能区', '设置')) {
      $got = ''
      if ($pages) { $got = [string]$pages.$lab }
      Check ("③ 【{0}】也能看到版本号 {1}" -f $lab, $top.text) ($got -eq $top.text) ("读到 '" + $got + "'")
    }

    $about = EvalJson @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<15 && !nav;i++){
    nav=B().find(b=>(b.innerText||'').indexOf('设置')>=0 || b.getAttribute('title')==='设置');
    if(!nav) await sl(300);
  }
  if(nav){ nav.click(); await sl(900); }
  let el=null;
  for(let i=0;i<20 && !el;i++){ el=document.querySelector('[data-about-version]'); if(!el) await sl(400); }
  return JSON.stringify({found:!!el, text:el?el.textContent.trim():''});
})()
'@
    if (-not $about) {
      Check '④ 设置页「关于」里的版本与顶栏一致' $false '没读到结果'
    }
    else {
      Check ("④ 设置页「关于」里也是 {0}，与顶栏同一个号" -f $confVer) ($about.found -and $about.text -eq $confVer) ("关于里读到 '" + $about.text + "'")
    }
  }
}

Write-Host ""
Write-Host "=== §2 任务 1：改字号要真的看得见 ==="

$orig = $null          # 用户原来的 fontSize（收尾必须还原成它）
$noteId = ''
$keepTheme = $null
$keepKey = $null
$keepSmall = $null

if (Want 2) {
  # ── 准备：记下原配置 → 进认知区 → 建一篇自己的文本笔记并打开（要量编辑器与预览）──
  $setup = EvalJson @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  for(let i=0;i<4 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const cfg=await inv('config_get');
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<15 && !nav;i++){
    nav=B().find(b=>(b.innerText||'').indexOf('认知区')>=0 || b.getAttribute('title')==='认知区');
    if(!nav) await sl(300);
  }
  if(nav){ nav.click(); await sl(1000); }
  const note=await inv('note_create',{title:'M10 字号验收',kind:'doc',content:'# 字号验收\n\n这一行用来量编辑器与预览的字号。\n'});
  await sl(1200);
  let open=null;
  for(let i=0;i<20 && !open;i++){ open=document.querySelector('button[data-note-open="' + note.id + '"]'); if(!open) await sl(400); }
  if(open){ open.click(); await sl(1200); }
  let cm=null;
  for(let i=0;i<20 && !cm;i++){ cm=document.querySelector('.cm-content'); if(!cm) await sl(400); }
  return JSON.stringify({orig:cfg.fontSize, noteId:note.id, opened:!!open, editor:!!cm,
                         theme:cfg.theme, key:cfg.shortcuts.toggleSmallWindow, small:cfg.window.smallPosition});
})()
'@
  if (-not $setup) {
    Check '★ 准备：建一篇自己的文本笔记并打开编辑器' $false '没读到结果'
  }
  else {
    $orig = [int]$setup.orig
    $noteId = [string]$setup.noteId
    $keepTheme = $setup.theme
    $keepKey = $setup.key
    $keepSmall = $setup.small
    Check ("★ 准备：自己的笔记打开了，编辑器就位（你原来的字号 = {0}）" -f $orig) ($setup.opened -and $setup.editor) ("opened=" + $setup.opened + " editor=" + $setup.editor)
  }
}

$wantSection2 = (Want 2) -and ($null -ne $orig)

if ($wantSection2) {
  # ── 六档逐个切：设置 → 轮询到生效 → 量浏览器算出来的 font-size ──
  $SIZES = @(14, 15, 16, 17, 18, 20)
  $navVals = @()
  foreach ($sz in $SIZES) {
    $r = EvalJson @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const N=$sz;
  const cfg=await inv('config_get');
  cfg.fontSize=N;
  await inv('config_save',{config:cfg});
  const root=document.documentElement;
  // 轮询到生效为止：别用固定 sleep —— config_save 走 data-changed，前端 refresh 之后才落到界面上
  let settled=false;
  for(let i=0;i<25 && !settled;i++){
    await sl(200);
    const a=parseFloat(getComputedStyle(root).getPropertyValue('--font-size-base'));
    const b=parseFloat(getComputedStyle(document.body).fontSize);
    settled=(a===N) && (b===N);
  }
  const cs=(el)=>el?parseFloat(getComputedStyle(el).fontSize):null;
  const findBtn=(txt)=>Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()===txt)||null;
  const s={};
  s.base=parseFloat(getComputedStyle(root).getPropertyValue('--font-size-base'));
  s.body=cs(document.body);
  s.nav=cs(document.querySelector('nav button'));
  s.badge=cs(document.querySelector('[data-app-version]'));
  s.editor=cs(document.querySelector('.cm-content'));
  const pv=findBtn('预览');
  if(pv){ pv.click(); await sl(800); }
  let pe=null;
  for(let i=0;i<12 && !pe;i++){ pe=document.querySelector('.markdown-preview'); if(!pe) await sl(300); }
  s.preview=cs(pe);
  const eb=findBtn('编辑');
  if(eb){ eb.click(); await sl(500); }
  const want={base:N, body:N, nav:N*0.875, badge:N*0.75, editor:N, preview:N*0.875};
  const near=(a,b)=>(a!==null)&&(Math.abs(a-b)<0.06);
  const bad=[];
  for(const k of Object.keys(want)){ if(!near(s[k],want[k])) bad.push(k+'='+s[k]+' 期望 '+want[k]); }
  return JSON.stringify({size:N, settled:settled, s:s, bad:bad});
})()
"@
    if (-not $r) {
      Check ("② 字号 {0}：五个探针都对得上" -f $sz) $false '没读到结果'
      continue
    }
    $navVals += [double]$r.s.nav
    $detail = ''
    if ($r.bad.Count -gt 0) { $detail = ($r.bad -join ' / ') }
    if (-not $r.settled) { $detail = ($detail + ' ｜ 等了 5 秒还没生效').Trim() }
    $name = "② 字号 {0} → 侧栏 {1} / 顶栏 {2} / 正文 {3} / 编辑器 {4} / 预览 {5}" -f $sz, $r.s.nav, $r.s.badge, $r.s.body, $r.s.editor, $r.s.preview
    Check $name (($r.bad.Count -eq 0) -and $r.settled) $detail
  }

  $uniq = @($navVals | Select-Object -Unique).Count
  Check '③ 六档字号量出来互不相同（★ 这就是"改了没用"的反面）' ($uniq -eq $SIZES.Count) ("侧栏量到：" + ($navVals -join ' / '))
}

if ($wantSection2) {
  # ── 收尾：还原字号 + 核对没碰过别的设置 + 删掉自己造的笔记 ──
  $restore = EvalJson @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const cfg=await inv('config_get');
  cfg.fontSize=$orig;
  await inv('config_save',{config:cfg});
  let ok=false, c2=null;
  for(let i=0;i<25 && !ok;i++){ await sl(200); c2=await inv('config_get'); ok=(c2.fontSize===$orig); }
  return JSON.stringify({ok:ok, got:c2?c2.fontSize:null, theme:c2?c2.theme:null,
                         key:c2?c2.shortcuts.toggleSmallWindow:null, small:c2?c2.window.smallPosition:null});
})()
"@
  if (-not $restore) {
    Check ("④ 收尾把字号还原成你原来的 {0}" -f $orig) $false '没读到结果'
  }
  else {
    Check ("④ 收尾把字号还原成你原来的 {0}" -f $orig) $restore.ok ("现在是 " + $restore.got)
    $sameCfg = ($restore.theme -eq $keepTheme) -and ($restore.key -eq $keepKey) -and ($restore.small -eq $keepSmall)
    Check '⑤ 顺手核对：主题 / 快捷键 / 小窗位置一个都没被碰过' $sameCfg ("theme=" + $restore.theme + " key=" + $restore.key + " small=" + $restore.small)
  }

  $clean = EvalJson @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const id='$noteId';
  const before=(await inv('note_list')).map(n=>n.title);
  if(id){ await inv('note_delete',{id:id}); }
  await sl(900);
  const after=(await inv('note_list')).map(n=>n.title);
  return JSON.stringify({before:before, after:after});
})()
"@
  if (-not $clean) {
    Check '⑥ 收尾删掉测试笔记（你的笔记一篇没动）' $false '没读到结果'
  }
  else {
    $left = @($clean.after)
    $noTest = -not ($left -contains 'M10 字号验收')
    Check '⑥ 收尾删掉「M10 字号验收」，你的笔记一篇没动' $noTest ($left -join ' / ')
    $mine = @($left | Where-Object { $_ -ne 'M10 字号验收' })
    $beforeMine = @(@($clean.before) | Where-Object { $_ -ne 'M10 字号验收' })
    $sameCount = ($mine.Count -eq $beforeMine.Count)
    Check '⑦ 前后比对：你原有的笔记标题一篇不少' $sameCount ("前 " + ($beforeMine -join ' / ') + " → 后 " + ($mine -join ' / '))
  }
}

Write-Host ""
Write-Host "======================"
Write-Host ("M10.2 V1 收尾：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
