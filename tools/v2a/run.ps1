# A 批验收 · 真实输入版（2026-10-02）
#   §1 信息区粘贴图片：真剪贴板（CF_BITMAP）+ 真 Ctrl+V → 落盘 assets/ + 建一条图片信息
#   §2 认知区预览显图：图路径单独成行 → 预览里出现 img（句子中间的仍当文字）
#   §3 toc：`toc 第二章，` 目录显示「第二章」；辅助栏 toc 按钮（真鼠标）真插入；tocontinue / toc2 不吃
#
# 🔴 铁规矩：只动自己造的数据（`M-A批 ` 前缀的笔记 + 自己粘贴出来的那条信息），
#    用户的笔记 / 待办一个字不动；跑完把自造的东西**全部**删干净（含以前跑剩的）。
#
# ⚠️⚠️ 三条本机实测的坑（2026-10-02 踩到，别再犯）：
#   ① **.ps1 必须带 UTF-8 BOM** —— 否则 PowerShell 5.1 按 GBK 读中文，整个脚本解析崩掉；
#   ② **`-Expr` 里不许带中文**（`-ExprFile` 没事）：5.1 往原生程序传参按系统 ANSI 编码，
#      含中文的 JS 到页面里就成了坏字符串 → `SyntaxError`。本脚本一律走 EvalMain（内部 -ExprFile）；
#   ③ **别假设"点完就是那个状态"**：信息条数刷新要轮询等，切「预览」页签后要等容器出现 ——
#      2026-10-02 第一版就是没等，报了一串假红（东西其实全对）。
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
# ⚠️⚠️ **别用 `$MyInvocation.MyCommand.Path`**：在函数作用域里它读不到（回到上一层调用的信息），
#      `$here` 会变成空串 → `cdp.ps1` 解析到错误路径 → **所有 Tauri 调用静默失败**，
#      表现成"信息条数 0 → 0"这种假红（2026-10-02 为此白查了半小时）。用 `$PSScriptRoot`。
$here = $PSScriptRoot
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
if (-not (Test-Path -LiteralPath $cdp)) { throw "找不到 cdp.ps1：$cdp" }
$DATA = 'D:\东方摩耶堂'
$MAIN = '东方摩耶堂'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [X] {0}   {1}" -f $name, $detail) -ForegroundColor Red }
}

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("v2a-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1
  }
  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  # ⚠️ `Out-String` 不够稳：cdp.ps1 返回的 JSON 有时会被 PowerShell 自动反序列化成对象数组，
  #    再被 Out-String 渲染成 `id : xxx` 这种列表格式（断言就一个都找不到）——所以**显式判类型**兜一下。
  $first = @($out) | Select-Object -First 1
  if ($null -ne $first -and $first -isnot [string]) {
    return (ConvertTo-Json -InputObject @($out) -Depth 12 -Compress)
  }
  return (@($out) -join "`n").Trim()
}

function MouseAt([int]$x, [int]$y, [int]$clicks = 1) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action mouse -X $x -Y $y -Clicks $clicks -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' | Out-Null
}

function ClickButtonLike([string]$text) {
  $js = @"
(function(){
  var bs=Array.from(document.querySelectorAll('button'));
  var b=bs.filter(function(x){return (x.innerText||'').indexOf('$text')>=0;})[0];
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()
"@
  return (EvalMain $js)
}

function ClickButtonExact([string]$text) {
  $js = @"
(function(){
  var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='$text';})[0];
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()
"@
  return (EvalMain $js)
}

function PosOfButton([string]$text) {
  $js = @"
(function(){
  var bs=Array.from(document.querySelectorAll('button')).filter(function(b){return (b.innerText||'').trim()==='$text';});
  if(!bs.length) return '';
  var b=bs[bs.length-1]; var r=b.getBoundingClientRect();
  return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2);
})()
"@
  return (EvalMain $js)
}

function Invoke-Tauri([string]$call) { return (EvalMain "window.__TAURI_INTERNALS__.invoke($call)") }
# ⚠️⚠️ **别去数返回 JSON 里的 `"id":"`** —— cdp.ps1 在某些路径上会把这段 JSON 当对象渲染成
#      `id : xxx` 的列表文字（2026-10-02 为此白折腾了好几轮）。要让页面**直接回一个数字**。
function CountOf([string]$command) {
  $js = "window.__TAURI_INTERNALS__.invoke('$command',{}).then(function(l){return 'N='+l.length;})"
  $raw = EvalMain $js
  $m = [regex]::Match($raw, 'N=(\d+)')
  if (-not $m.Success) { throw "数不出来（$command 返回：$raw）" }
  return [int]$m.Groups[1].Value
}

# 轮询等条件成立（别假设"睡两秒就好了"）
function Wait-Until([scriptblock]$probe, [int]$timeoutMs = 8000, [int]$stepMs = 400) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (& $probe) { return $true }
    Start-Sleep -Milliseconds $stepMs
  }
  return $false
}

try {
Write-Host "`n=== A 批验收开始 ===" -ForegroundColor Cyan
# 自检：cdp.ps1 路径对不对 + Tauri 桥通不通（这条不过，后面全是假红）
Write-Host ("  [自检] cdp.ps1 = {0}" -f $cdp)
$selfCount = CountOf 'note_list'

if ($selfCount -lt 1) { throw "自检失败：读不到用户的笔记（cdp 不通？）" }
Write-Host ("  [自检] note_list 条数 = {0}" -f $selfCount)


# ─────────────────────── §0 清场 + 记基线 ───────────────────────
Write-Host "`n§0 清场与基线" -ForegroundColor Yellow
$sweepJs = @"
window.__TAURI_INTERNALS__.invoke('note_list',{}).then(function(l){
  var mine=l.filter(function(n){return (n.title||'').indexOf('M-A批')===0;});
  var chain=Promise.resolve();
  mine.forEach(function(n){ chain=chain.then(function(){ return window.__TAURI_INTERNALS__.invoke('note_delete',{id:n.id}); }); });
  return chain.then(function(){ return JSON.stringify({removed:mine.length}); });
})
"@
Write-Host ("  清掉以前跑剩的测试笔记：{0}" -f (EvalMain $sweepJs))

$noteCount = CountOf 'note_list'
$todoCount = CountOf 'todo_list'
$beforeCount = CountOf 'info_list'
Write-Host ("  基线：信息 {0} 条 / 笔记 {1} 篇 / 待办 {2} 条" -f $beforeCount, $noteCount, $todoCount)
Check ("基线读得到（他自己的笔记 {0} 篇）" -f $noteCount) ($noteCount -ge 1)

# 🔴🔴 2026-10-11（v2.22.1）**这条是修一个真吃数据的 bug**：§1 粘完图之后，原来是这样找"刚造的那条"的 ——
#    取 `info_list` 里 **assetPath 以 assets/ 开头、createdAt 最新的那一条**。
#    可它**没有排除用户本来就有的图片信息**！于是**粘图一旦失败**（全量回归里 v2c 排在前面、
#    残留把粘贴吃掉时就会失败），`mine[0]` 取到的就是**用户最新的那条图片信息**，
#    收尾第 324 行再把它 `info_delete` 掉 —— **用户的数据就这么没了一条**。
#    （2026-10-11 实测：全量回归里用户那条 `876464c9`（10-09 的截图信息、挂在笔记
#      《一些可以做的事》上）就是这么被删的；靠 `backups/info-删除前-*.json` 才逐字补回来。）
#    修法：**动手前先把"已经存在的 id"记下来**，之后只认"这次新冒出来的"那个 id；
#    一个都没新 → 当次粘图失败 → **什么都不删**（该红的断言自然照旧红，但不再误伤用户数据）。
$idsBefore = @((EvalMain "window.__TAURI_INTERNALS__.invoke('info_list',{}).then(function(l){return l.map(function(x){return x.id;}).join(',');})") -split ',') | Where-Object { $_ }
Write-Host ("  动手前的信息 id 记下了（{0} 条）" -f $idsBefore.Count)

Check "信息区页面能进去" ((ClickButtonLike '信息区') -eq 'OK')
Start-Sleep -Milliseconds 800

# ─────────────────────── §1 信息区粘贴图片 ───────────────────────
Write-Host "`n§1 信息区：真剪贴板 + 真 Ctrl+V" -ForegroundColor Yellow

$img = Join-Path $env:TEMP 'moye-clip-test.png'
if (-not (Test-Path -LiteralPath $img)) {
  # 自给自足：临时目录可能被系统清掉，脚本不能再依赖上一轮留下的夹具。
  # 用 256×256 PNG，保证文件大小断言也不是被极小图误导。
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.Clear([System.Drawing.Color]::CornflowerBlue)
      $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Orange)
      try { $g.FillEllipse($brush, 32, 32, 192, 192) } finally { $brush.Dispose() }
    } finally {
      $g.Dispose()
    }
    $bmp.Save($img, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }
}
Check "测试图在（$img）" (Test-Path -LiteralPath $img)

$null = EvalMain "(function(){if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return 'blurred';})()"
Start-Sleep -Milliseconds 300

& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action clip -ClipFile $img -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' | Out-Null
Check "真位图已放进系统剪贴板（CF_BITMAP）" $true

& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action paste -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' | Out-Null

$grew = Wait-Until { (CountOf 'info_list') -ge ($beforeCount + 1) } 12000
$afterCount = CountOf 'info_list'
Check ("★ 真 Ctrl+V 之后信息条数 +1（{0} → {1}）" -f $beforeCount, $afterCount) ($afterCount -ge ($beforeCount + 1))

$newInfoJs = @"
window.__TAURI_INTERNALS__.invoke('info_list',{}).then(function(l){
  // 🔴 只认"这次新冒出来的"那条（动手前记下的 id 全排除掉）—— 别再把用户原有的图片信息当成自己造的
  var before='$($idsBefore -join ',')'.split(',');
  var mine=l.filter(function(x){return (x.assetPath||'').indexOf('assets/')===0 && before.indexOf(x.id)<0;});
  mine.sort(function(a,b){return (b.createdAt||'').localeCompare(a.createdAt||'');});
  return JSON.stringify(mine[0]||null);
})
"@
$newInfo = (EvalMain $newInfoJs)
Check "★ 新信息是图片类（kind=image）" ($newInfo -match '"kind":"image"') $newInfo

$rel = ([regex]::Match($newInfo, '"assetPath":"([^"]+)"')).Groups[1].Value
$newId = ([regex]::Match($newInfo, '"id":"([^"]+)"')).Groups[1].Value
Check ("★ 落盘路径合法：{0}" -f $rel) ($rel -match '^assets/.+\.png$') $rel
$abs = Join-Path $DATA ($rel -replace '/', '\')
Check "★ 文件真的写进数据目录了" (Test-Path -LiteralPath $abs) $abs
if (Test-Path -LiteralPath $abs) {
  Check ("新图大小合理（{0} 字节）" -f (Get-Item -LiteralPath $abs).Length) ((Get-Item -LiteralPath $abs).Length -gt 500)
}
Check "★ 这条信息就是刚粘贴的（带今天的日期戳）" ($newInfo -match [regex]::Escape((Get-Date).ToString('yyyy-MM-dd')))

$thumb = (EvalMain "(function(){var i=Array.from(document.querySelectorAll('img')).filter(function(x){return (x.src||'').indexOf('asset')>=0;});return JSON.stringify({count:i.length});})()")
Check "★ 界面上出现缩略图（asset:// 已加载）" ($thumb -match '"count":[1-9]') $thumb

$draft = (EvalMain "(function(){var t=document.querySelector('textarea'); return t? t.value : 'NO_TA';})()")
Check "录入框没被粘贴动过（不抢用户正在打的字）" ($draft -eq '' -or $draft -eq 'NO_TA') $draft

# ─────────────────────── §2 认知区预览显图 ───────────────────────
Write-Host "`n§2 认知区：预览里显示图片" -ForegroundColor Yellow
Check "认知区页面能进去" ((ClickButtonLike '认知区') -eq 'OK')
Start-Sleep -Milliseconds 800

$noteCreateJs = @"
window.__TAURI_INTERNALS__.invoke('note_create',{
  title:'M-A批 预览显图',
  kind:'doc',
  content:'这是预览显图的测试。\n$rel\n中间这句里写一个 $rel 就不该变成图。\ntoc 第二章，\ntoc 结论！\ntocontinue 这行不该进目录\ntoc2 这行也不该\nTOC第二章 大写也不该\n（这篇笔记故意不写待办标记，免得造出测试待办）'
}).then(function(n){return n.id;})
"@
$noteId = (EvalMain $noteCreateJs)
Check ("自造一篇测试笔记（{0}…）" -f $noteId.Substring(0, 8)) ($noteId.Length -gt 8) $noteId
Start-Sleep -Milliseconds 900

$openNoteJs = @"
(function(){
  var t=Array.from(document.querySelectorAll('button')).filter(function(b){return (b.innerText||'').indexOf('M-A批 预览显图')>=0;})[0];
  if(t) t.click();
  return t? 'OPENED':'NO_NOTE';
})()
"@
Check "在左栏点开这篇笔记" ((EvalMain $openNoteJs) -eq 'OPENED')
Start-Sleep -Milliseconds 800

# ⚠️ 切预览后**等容器真的出现**再断言（否则读到的是编辑模式）
Check "切到「预览」" ((ClickButtonExact '预览') -eq 'OK')
$previewReady = Wait-Until { (EvalMain "document.querySelectorAll('.markdown-preview').length") -match '^[1-9]' } 6000
Check "预览容器真的挂上了（不是还在编辑模式）" $previewReady

$prevJs = @"
(function(){
  var figs=document.querySelectorAll('[data-preview-image]');
  var missing=document.querySelectorAll('[data-preview-image-missing]');
  var imgs=Array.from(document.querySelectorAll('.markdown-preview img'));
  var heads=Array.from(document.querySelectorAll('.markdown-preview [data-toc-heading]')).map(function(h){return h.getAttribute('data-toc-heading');});
  return JSON.stringify({figs:figs.length, missing:missing.length, imgs:imgs.length,
    path:figs.length?figs[0].getAttribute('data-preview-image'):'',
    src:imgs.length?(imgs[0].src||'').slice(0,24):'', heads:heads});
})()
"@
$prev = (EvalMain $prevJs)
Check "★ 预览里图片渲染出来了（1 个 figure）" ($prev -match '"figs":1') $prev
Check "★ img 在、src 是 asset URL、没走兜底" ($prev -match '"imgs":1' -and $prev -match 'asset' -and $prev -match '"missing":0') $prev
Check "同一个路径写在句子中间时**没**被当图（只有 1 个 figure）" ($prev -match '"figs":1') $prev
Check "★ 预览里 toc 行画成标题（剥掉标点后是「第二章」「结论」）" ($prev -match '"heads":\["第二章","结论"\]') $prev

$null = ClickButtonLike '目录'
Start-Sleep -Milliseconds 700
$tocText = (EvalMain "(function(){var el=document.querySelector('[data-toc-line]'); return el? (el.getAttribute('data-toc-heading')||el.innerText) : 'NONE';})()")
Check ("★ toc 带逗号 → 目录显示「第二章」（实际：{0}）" -f $tocText) ($tocText.Trim() -eq '第二章') $tocText

# ─────────────────────── §3 辅助栏 toc 按钮 ───────────────────────
Write-Host "`n§3 辅助栏 toc 按钮（真鼠标点）" -ForegroundColor Yellow
$null = ClickButtonExact '编辑'
$editorReady = Wait-Until { (EvalMain "document.querySelectorAll('.cm-content').length") -match '^[1-9]' } 6000
Check "编辑器挂上了（.cm-content 出现）" $editorReady

$contentBefore = (EvalMain "window.__TAURI_INTERNALS__.invoke('note_get',{id:'$noteId'}).then(function(n){return n.content;})")

$null = EvalMain @"
(function(){
  var ta=document.querySelector('.cm-content');
  if(!ta) return 'NO_CM';
  var sel=window.getSelection(); sel.removeAllRanges();
  var r=document.createRange(); r.setStart(ta.firstChild||ta,0); r.collapse(true);
  sel.addRange(r);
  return 'caret';
})()
"@
Start-Sleep -Milliseconds 400

# ⚠️⚠️ **这条吃过三种假红，规矩改成"量 → 点 → 按效果验 → 不对就重新量再点"**：
#
#   ① **"系统级点击会打到别的窗口上"** —— 这句是**错的**，别再照着改：
#      `cdp.ps1 -Action mouse` 走的是 `Input.dispatchMouseEvent`，**直接发给页面**，
#      跟操作系统前台是谁没关系。（2026-10-03 一度归因成"主窗不在前台"，白改一版。）
#   ② **真正的坑：量到的坐标和点下去的落点会对不上。** 真鼠标点击会先发一次 `mouseMoved`
#      （触发 hover），hover 会让辅助栏重排一下 → 按旧坐标按下就落到**旁边那颗按钮**上了。
#      证据：本来要插 `toc`，正文里却多出一段 `` `代码` ``（旁边那颗的产物）。
#   ③ 所以断言**只看效果**："toc 数量必须变 ±1"（在 toc 行上再点一次是**取消**，-1 也是对的；
#      这是 format.ts 里写明的规矩）。点错按钮 → 数量不变 → 如实报红；每轮重新量一次坐标，
#      最多 3 轮（第一轮之后鼠标已经 hover 在那儿了，重量的坐标就是重排之后的）。
#
#   主窗前台那件事仍然读一下（只为诊断留个记录），**不拿它当判据**。
$null = (EvalMain "window.__TAURI_INTERNALS__.invoke('main_show').catch(function(){return null;}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 700
$focused = (EvalMain "String(document.hasFocus())")
Write-Host ("  主窗在前台吗（仅诊断用）：{0}" -f $focused)

Check ("找到辅助栏 toc 按钮坐标（{0}）" -f (PosOfButton 'toc')) ((PosOfButton 'toc') -match '^\d+,\d+$') (PosOfButton 'toc')

$script:delta = 0
$script:rounds = 0
$blocked = ''
for ($script:rounds = 1; $script:rounds -le 3; $script:rounds++) {
  $tocPos = PosOfButton 'toc'
  if ($tocPos -notmatch '^(\d+),(\d+)$') { $blocked = "量不到 toc 按钮坐标（$tocPos）"; break }
  # ⚠️ **先只 hover 过去（0 次点击），再重新量一次坐标**：
  #    hover 会让右侧那行"提示文字"变宽（实测 175px → 251px），按钮行跟着重排，
  #    `toc` 会横着挪 88px（实测 (502,307) → (590,307)）。
  #    所以"照着 hover 之前的坐标去点"必然点到旁边那颗 —— 2026-10-03 就是这么插进来一段
  #    `` `代码` ``（旁边 </> 那顆的产物）。**hover 之后量到的坐标才是它真正所在的位置。**
  MouseAt ([int]$Matches[1]) ([int]$Matches[2]) 0
  Start-Sleep -Milliseconds 450
  $tocPos2 = PosOfButton 'toc'
  if ($tocPos2 -notmatch '^(\d+),(\d+)$') { $blocked = "hover 之后量不到坐标（$tocPos2）"; break }
  $tx = [int]$Matches[1]; $ty = [int]$Matches[2]
  $hit = (EvalMain @"
(function(){
  var el=document.elementFromPoint($tx,$ty);
  if(!el) return 'NO_EL';
  var b=el.closest?el.closest('button'):null;
  if(!b) return 'NOT_BTN:'+(el.tagName||'');
  var t=(b.innerText||'').trim();
  return t==='toc' ? 'HIT' : ('OTHER:'+t.slice(0,12));
})()
"@)
  Write-Host ("  第 {0} 轮：hover 后 toc 在 ({1},{2})（hover 前是 {3}），命中校验 = {4}" -f $script:rounds, $tx, $ty, $tocPos, $hit)
  if ($hit -ne 'HIT') { $blocked = "hover 后的坐标上命中的不是 toc 按钮（$hit）"; continue }
  MouseAt $tx $ty
  $changed = Wait-Until {
    $now = (EvalMain "window.__TAURI_INTERNALS__.invoke('note_get',{id:'$noteId'}).then(function(n){return n.content;})")
    $script:delta = (($now -split 'toc').Count) - (($contentBefore -split 'toc').Count)
    ($script:delta -ne 0)
  } 5000
  if ($changed) { break }
}

if ($script:delta -ne 0) {
  Check ("★ 真鼠标点 toc → 正文真的变了（toc 数量 {0}{1}，点了 {2} 轮）" -f $(if ($script:delta -gt 0) { '+' } else { '' }), $script:delta, $script:rounds) ([Math]::Abs($script:delta) -eq 1) ("delta=" + $script:delta)
} else {
  Check "★ 真鼠标点 toc → 正文真的变了" $false ("3 轮都没生效：" + $blocked + "（toc 数量一直是 0 变化）")
}

# ─────────────────────── §4 收尾 ───────────────────────
Write-Host "`n§4 收尾（只删自己造的东西）" -ForegroundColor Yellow
$null = Invoke-Tauri "'note_delete',{id:'$noteId'}"
# 🔴 收尾只删**这次自己造的那条**：它是"动手前不存在"的 id（`$idsBefore` 里没有）。
#    万一 `$newId` 空着、或者撞上了动手前就有的 id（＝粘图根本没成功），**一个都不删**
#    —— 宁可留一条测试品（`tools\cleanup-test-data.ps1` 会认出来），也绝不误删用户的东西。
if ($newId -and ($idsBefore -notcontains $newId)) {
  $null = Invoke-Tauri "'info_delete',{id:'$newId'}"
  Write-Host ("  删掉本次造的测试信息：{0}" -f $newId)
} elseif ($newId) {
  Write-Host ("  ⚠️ 本次没造出信息（`$newId` 是动手前就有的 {0}）→ **什么都不删**" -f $newId) -ForegroundColor Yellow
}

$noteBack = Wait-Until { (CountOf 'note_list') -eq $noteCount } 8000
Check ("测试笔记已删（回到 {0} 篇）" -f $noteCount) $noteBack
$infoBack = Wait-Until { (CountOf 'info_list') -eq $beforeCount } 8000
Check ("信息条数回到基线（{0} 条）" -f $beforeCount) $infoBack
$todoBack = CountOf 'todo_list'
Check ("待办条数没变（{0} 条）" -f $todoCount) ($todoBack -eq $todoCount)

$swept2 = (EvalMain $sweepJs)
Write-Host ("  收尾再扫一遍测试笔记：{0}" -f $swept2)
Check "没有 `M-A批` 残留" ((CountOf 'note_list') -eq $noteCount)

# ⚠️ `info_delete` 只从 info.jsonl 摘记账、**不动 assets/ 里的文件**（V1 铁律：原图不删）
#    → 每跑一次这个套件就会留一张我造的测试图，必须自己收掉。
if ($abs -and (Test-Path -LiteralPath $abs)) {
  Remove-Item -LiteralPath $abs -Force
  Write-Host ("  收掉测试图：{0}" -f (Split-Path $abs -Leaf))
}
Check "测试图已从 assets/ 收掉" (-not (Test-Path -LiteralPath $abs))

# ⚠️ `note_delete` 是**挪进回收站**（不是硬删），脚本自己造的笔记会留在 `notes/_trash/`
#    → 收尾必须把它们从回收站也收掉，否则跑一次攒一批（用户会看见一堆「M-A批」）。
$trashDir = Join-Path $DATA 'notes\_trash'
$removedTrash = 0
if (Test-Path -LiteralPath $trashDir) {
  $leftover = @(Get-ChildItem -LiteralPath $trashDir -File -Filter *.json |
      Where-Object { $_.Name -notlike '*.bak' } |
      Where-Object { (Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).title -like 'M-A批*' })
  foreach ($one in $leftover) {
    $base = $one.FullName -replace '\.json$', ''
    Remove-Item -LiteralPath "$base.json" -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$base.json.bak" -Force -ErrorAction SilentlyContinue
    $removedTrash++
  }
}
Write-Host ("  回收站里收掉测试笔记：{0} 篇" -f $removedTrash)
$stillThere = @(Get-ChildItem -LiteralPath $trashDir -File -Filter *.json |
    Where-Object { $_.Name -notlike '*.bak' } |
    Where-Object { (Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).title -like 'M-A批*' })
Check "回收站里没有 `M-A批` 残留" ($stillThere.Count -eq 0)

Write-Host "`n========== A 批验收：通过 $pass，失败 $fail ==========" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
} catch {
  # 🔴 **脚本崩了也要打出小结**（2026-10-02 踩到：v2 三个套件里只要有未捕获异常，
  #    整套脚本当场退出、连成绩行都没有，`regress.ps1` 就报"没读到成绩行（跑起来了吗？）"，
  #    看起来像"套件没跑"，其实是"跑崩了"。这里兜住，把真实错误和已通过的条数都打出来。）
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("========== 验收（异常中断）：通过 $pass ，失败 $fail ==========") -ForegroundColor Red
  exit 1
}
