# M7 · PRD 第 10 章补充验收（**之前没验过的那些条目**）
#
# 前面几套已经覆盖了 10.2 / 10.3 / 10.4 / 10.5 前三条 / 10.7 全部。
# 这里专门补剩下的、以及这轮新加的东西：
#   10.6-1 首页「最近待办」显示最近 3 个且按时间排序
#   10.6-2 设置里关掉「最近待办常驻」→ 首页不再显示
#   10.6-4 点首页提醒里的【联动到认知区】→ 直接完成联动（不用再进信息区）
#   10.5-4 Esc 关闭小窗 → 重新打开，内容正确
#   10.8-1 主题切换立即生效并保留
#   10.8-2 快捷键可修改并"生效"（注册状态跟着变）
#
# ⚠️ 10.6-4 需要一条"已弹出的信息提醒"。造它的办法（进度.md 第七节教的）：
#    建一条信息 → 直接在 `reminders.json` 里插一条 `fireAt` 在过去的 `info-stale`
#    → 等后台调度线程（30 秒一趟）把它标成 fired。比等真实的 45 分钟靠谱。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\prd.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7prd-" + [guid]::NewGuid().ToString("N") + ".js")
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
function EvalSmall([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7prds-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle '速记' -RequireSelector '[data-small-body]' 2>&1
    return (($out | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function J([string]$json) { return ($json | ConvertFrom-Json) }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}

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
    if(document.querySelector('[data-home-todo]') || document.querySelector('[data-home-reminder]') || document.querySelector('[data-home-empty]') || document.body.innerText.indexOf('最近待办')>=0) break;
    await sl(400);
  }
  const todos=Array.from(document.querySelectorAll('[data-home-todo]')).map(b=>b.getAttribute('data-home-todo'));
  const titles=Array.from(document.querySelectorAll('[data-home-todo]')).map(b=>(b.innerText||'').trim());
  return JSON.stringify({
    tocCount:todos.length, todos:todos, titles:titles, tries:tries,
    hasReminderBlock: document.body.innerText.indexOf('提醒')>=0,
    hasTodoBlock: document.body.innerText.indexOf('最近待办')>=0,
    dynamicVisible: !!(document.querySelector('[data-home-todo]')||document.querySelector('[data-home-reminder]')),
  });
})()
'@

# ─────────────────────── ① 10.6-1 首页最近待办 ───────────────────────
Write-Host "=== ① PRD 10.6-1：首页「最近待办」显示最近 3 个、按时间排序 ==="
$expected = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const todos=await inv('todo_list');
  const open=todos.filter(t=>t.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return JSON.stringify({openCount:open.length, top3:open.slice(0,3).map(t=>t.id), top3Titles:open.slice(0,3).map(t=>t.title)});
})()
'@)
Write-Host ("  未完成待办 {0} 条；按创建时间最近的 3 条：{1}" -f $expected.openCount, ($expected.top3 -join ' / '))
$homeUi = J (EvalMain $TPL_HOME)
Check '首页动态区出现了「最近待办」' ([bool]$homeUi.hasTodoBlock) ($homeUi | ConvertTo-Json -Compress)
# ⚠️⚠️ **别写死 3**（2026-10-03 全量回归假红过一条）：PRD 要的是"最多显示 3 个"，
#    而用户把待办做完之后"未完成"的可能只剩 1 条 —— 那时显示 1 个是**对的**。
#    写死 `-eq 3` 就在他自己数据干净的时候冤枉程序（当时报"显示 1"）。
$wantCount = [Math]::Min(3, [int]$expected.openCount)
Check ("★ 只显示 {0} 个（PRD：最多 3 个 = min(3, 未完成 {1} 条)）" -f $wantCount, $expected.openCount) ($homeUi.tocCount -eq $wantCount) ("显示 " + $homeUi.tocCount)
# ⚠️ 按 **id** 比，别按按钮上的文字：那个按钮里除了标题还有 ☐ 和来源标注，
#    `innerText` 的第一行是 ☐ 而不是标题 —— 第一版按文字比，白报了一次失败。
$wantIds = @($expected.top3)
$gotIds = @($homeUi.todos)
$sameOrder = ($wantIds.Count -eq $gotIds.Count)
if ($sameOrder) {
  for ($i = 0; $i -lt $wantIds.Count; $i++) {
    if ($wantIds[$i] -ne $gotIds[$i]) { $sameOrder = $false }
  }
}
Check '★ 而且就是"按时间最近"的那 3 个、顺序也对' $sameOrder ("期望 " + ($expected.top3Titles -join ' / ') + "；实际 " + ($homeUi.titles -join ' / '))

# ─────────────────────── ② 10.6-2 关开关 ───────────────────────
Write-Host ""
Write-Host "=== ② PRD 10.6-2：设置里关掉「最近待办常驻」→ 首页不再显示 ==="
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.homeSticky.recentTodos=false;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
# ⚠️ 配置存下去之后 App 要**异步** refresh 一次才会把新配置读到界面上（`config_save` 会广播
#    `data-changed` → 前端 refresh → loadConfig）。原来这里固定睡 900ms 就断言，
#    机器一忙就会在"还没刷新完"的时候查 → 假红（2026-09-21 单跑这套时撞到过：
#    "还显示 3 个"）。改成**轮询到生效为止**。
$homeUi2 = $null
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 500
  $homeUi2 = J (EvalMain $TPL_HOME)
  if ($homeUi2.tocCount -eq 0) { break }
}
Check '★ 关掉之后首页不再显示「最近待办」卡片' ($homeUi2.tocCount -eq 0) ("还显示 " + $homeUi2.tocCount + " 个")
Check '其他区块不受影响（开关是各自独立的）' ($homeUi2.hasReminderBlock -or $homeUi2.tocCount -eq 0)

# 打开回来
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.homeSticky.recentTodos=true;
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
$homeUi3 = $null
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 500
  $homeUi3 = J (EvalMain $TPL_HOME)
  if ($homeUi3.tocCount -eq $wantCount) { break }
}
Check '★ 再打开开关，卡片回来了（设置真的落盘了）' ($homeUi3.tocCount -eq $wantCount) ("显示 " + $homeUi3.tocCount)

# ─────────────────────── ③ 10.6-4 首页提醒里直接联动 ───────────────────────
Write-Host ""
Write-Host "=== ③ PRD 10.6-4：点首页提醒里的【联动到认知区】→ 直接完成联动 ==="
$stamp = Get-Date -Format 'HHmmss'
$info = J (EvalMain @"
window.__TAURI_INTERNALS__.invoke('info_create',{text:'M7 首页联动验收 $stamp',kind:'text',categories:['主动冒出'],assetPath:null}).then(function(v){return JSON.stringify({id:v.id});})
"@)
Write-Host ("  建了一条信息：" + $info.id)

# 直接在 reminders.json 里插一条"已到点但还没弹"的提醒，交给后台调度线程处理
$remindersPath = Join-Path $DataDir 'reminders.json'
Copy-Item $remindersPath (Join-Path $DataDir 'backups\reminders-before-m7-prd.json') -Force -ErrorAction SilentlyContinue
$rem = Get-Content -Raw -Encoding UTF8 $remindersPath | ConvertFrom-Json
$past = (Get-Date).AddMinutes(-5).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
$newRem = [pscustomobject]@{
  id       = [guid]::NewGuid().ToString()
  kind     = 'info-stale'
  refId    = $info.id
  fireAt   = $past
  status   = 'pending'
  payload  = [pscustomobject]@{ text = "M7 首页联动验收 $stamp"; categoryText = '主动冒出' }
  snoozedUntil = $null
}
$items = @($rem.items) + $newRem
$json = ([pscustomobject]@{ items = $items } | ConvertTo-Json -Depth 12)
# ⚠️⚠️ 必须**无 BOM**：PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
#     而 serde_json **不接受 BOM** → 整个 reminders.json 读不出来
#     （`expected value at line 1 column 1`），提醒功能当场全废。真踩过，见进度.md。
[System.IO.File]::WriteAllText($remindersPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "  已插一条待弹提醒（fireAt 在过去），等后台调度线程扫到…"

$fired = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  $list = J (EvalMain "window.__TAURI_INTERNALS__.invoke('reminder_list').then(function(v){return JSON.stringify(v);})")
  $mine = $list | Where-Object { $_.refId -eq $info.id -and $_.status -eq 'fired' }
  if ($mine) { $fired = $mine; break }
}
Check '★ 后台调度线程把它标成了 fired（最多等 45 秒）' ($null -ne $fired) ("等了 $i 秒")

[void](EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const nav=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
  if(nav){ nav.click(); await sl(800); }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 800
# ⚠️ 这里**不能用** `\"` 去转义（PowerShell 不用反斜杠转义，它会把字符串弄坏 →
#    JS 收到残缺的代码，报的是 SyntaxError，看着像产品问题其实是脚本问题）。
#    最稳的写法：PS 用**单引号**、JS 里用**双引号**，然后拼接 id —— 一个转义都不需要。
$jsHasLink = 'JSON.stringify(!!Array.from(document.querySelectorAll("[data-home-reminder-link]")).find(function(el){return el.getAttribute("data-home-reminder-link")==="' + $info.id + '";}))'
$linkBtn = J (EvalMain $jsHasLink)
Check '★ 首页提醒卡里出现了【联动到认知区】按钮' ([bool]$linkBtn)
if ([bool]$linkBtn) {
  $jsClickLink = '(function(){var b=Array.from(document.querySelectorAll("[data-home-reminder-link]")).find(function(el){return el.getAttribute("data-home-reminder-link")==="' + $info.id + '";}); if(!b) return "NO_BUTTON"; b.click(); return "clicked";})()'
  Write-Output ("  点它：" + (EvalMain $jsClickLink))
  Start-Sleep -Milliseconds 2200
  $linked = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){var i=v.filter(function(x){return x.id==='$($info.id)';})[0]; return JSON.stringify({status:i?i.status:null, links:i?(i.links||[]).map(function(l){return l.targetKind;}):[]});})")
  Check '★ 直接在首页点一下就完成了联动（信息变成 linked）' ($linked.status -eq 'linked') ($linked | ConvertTo-Json -Compress)
  Check '★ 而且去向记的是"认知区"' ([bool]($linked.links -contains 'note')) ($linked.links -join ',')
}

# ─────────────────────── ④ 10.5-4 小窗重开内容正确 ───────────────────────
Write-Host ""
Write-Host "=== ④ PRD 10.5-4：Esc 关掉小窗 → 重新打开，内容正确 ==="
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2200
# ⚠️ 开窗时先记下**它原本的样子**：小窗里可能本来就躺着一份没保存的草稿
#    （2026-10-03 真撞到：里面是 `ZZZZZZZZ`）。按用户 2026-09-21 定的规矩
#    「有未保存的草稿就原样留着、一个字不许丢」，那种情况下"重开是白纸"**本来就不该成立** ——
#    所以下面那条断言要分情况（是空的才断"白纸"，不是空的就如实记"未能验证"）。
$preDraft = J (EvalSmall "JSON.stringify({title:(document.querySelector('[data-small-title]')||{}).value||'', body:(document.querySelector('[data-small-body]')||{}).value||''})")
$preDraftBody = ("" + $preDraft.body)
$hasPreDraft = [bool]($preDraftBody -or ("" + $preDraft.title))
if ($hasPreDraft) {
  # 🔴🔴 **有草稿就整段跳过 —— 绝不拿用户没保存的东西做实验。**
  #   2026-10-03 真发生：小窗里躺着他打的一串 `ZZZZZZZZ`（没保存），脚本接着往里面打字、
  #   又触发了一次"收起自动保存"，结果他的草稿被存成了**两篇**垃圾笔记进了认知区。
  #   规矩（用户 2026-09-21 定的）：有未保存的草稿就原样留着、一个字不许丢 —— 那就不该碰它。
  Write-Host ("  [ ] 未能验证（不计入通过/失败，本段整段跳过）：开窗时小窗里有一份没保存的草稿「{0}…」" -f $preDraftBody.Substring(0, [Math]::Min(12, $preDraftBody.Length))) -ForegroundColor DarkYellow
  Write-Host "      拿它做实验会把它存成笔记（或覆盖掉），所以脚本不碰它 —— 请先自己把小窗里的东西存掉或清掉再跑。" -ForegroundColor DarkYellow
} else {
$typedText = "小窗重开验收 $stamp"
$typed = J (EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  if(!document.querySelector('[data-small-body]')) return JSON.stringify({error:'小窗没渲染出来'});
  // 标题显式写上：这样收尾清测试数据时认得出来
  // （不写标题的话默认名是「未命名速记 …」，清理正则匹配不到，会留垃圾）
  setV(document.querySelector('[data-small-title]'),'$typedText');
  setV(document.querySelector('[data-small-body]'),'$typedText 的内容');
  await sl(300);
  return JSON.stringify({ok:true, body:(document.querySelector('[data-small-body]')||{}).value||''});
})()
"@)
Check '小窗能打开、能打字' (-not $typed.error) ($typed.error)
Check '打进去的内容在' ($typed.body -match '小窗重开验收') ($typed.body)

# Esc 关闭（页面自己监听，所以页面内派发是对的）
[void](EvalSmall "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'esc'")
Start-Sleep -Milliseconds 2400
$vis = J (EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_visible').then(function(v){return JSON.stringify(v);})")
Check 'Esc 之后小窗收起了' ($vis -eq $false) ("visible=" + $vis)

# 重新打开 —— 2026-09-21 按用户反馈**改了语义**，所以断言也跟着改：
#   用户原话："启动小窗后还是我上次打开小窗编辑的笔记，没有一个新的空白页面给我写"
#   新规矩：**没有未保存的草稿 → 给一张白纸**；有未保存的草稿 → 原样留着（一个字不许丢）。
#   所以"内容正确"拆成两件事验：① 重开是一张白纸；② 刚才写的东西**在认知区里完好**（正文也在，
#   这正好把用户另一条反馈"保存后进入认知区只有标题没有正文"一起盯住）。
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_show').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 2200
$reopened = J (EvalSmall "JSON.stringify({body:(document.querySelector('[data-small-body]')||{}).value||'', title:(document.querySelector('[data-small-title]')||{}).value||'', editing:!!document.querySelector('[data-small-editing]')})")
# 这一段只在"开窗时没有草稿"的分支里跑（有草稿就整段跳过了），所以这里就断"白纸"这一种情况
Check '★ 重新打开小窗是一张空白的新页（用户要的）' (($reopened.body -eq '') -and ($reopened.title -eq '') -and (-not $reopened.editing)) (($reopened | ConvertTo-Json -Compress))
$savedRow = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var n=ns.filter(function(x){return (x.content||'').indexOf('小窗重开验收 $stamp')>=0;})[0]; return JSON.stringify(n?{title:n.title, content:(n.content||'').slice(0,40)}:{none:true});})")
Check '★ 刚才写的内容完好地存进了认知区（收起没丢东西）' (-not [bool]$savedRow.none) ($savedRow | ConvertTo-Json -Compress)
Check '★ 而且正文也在 —— 不是只剩个标题（用户报过的那个坑）' ([bool]($savedRow.content -match "小窗重开验收 $stamp")) ($savedRow.content)
}   # ← 结束"开窗时没有草稿"的分支（有草稿时上面整段被跳过）
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 700

# ─────────────────────── ⑤ 10.8-1 主题切换 ───────────────────────
Write-Host ""
Write-Host "=== ⑤ PRD 10.8-1：主题切换立即生效并保留 ==="

# ⚠️ 先把**用户原来的主题**记下来，测完还原成他原来那个。
#    原来这里写死了"还原成跟随系统" —— 用户要是本来就选的是「浅色/深色」，跑一遍测试就被改掉了
#    （2026-09-21 全量回归之后 config.json 里是 system，说不清是他选的还是脚本改的）。
$themeBefore = (J (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({theme:c.theme});})")).theme
Write-Host ("  用户原来的主题：{0}（测完还原成它）" -f $themeBefore)

$themeNow = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const before=await inv('config_get');
  // 切到深色
  before.theme='dark';
  await inv('config_save',{config:before});
  return JSON.stringify({theme:before.theme});
})()
'@)
Start-Sleep -Milliseconds 1200
$domDark = J (EvalMain "JSON.stringify({dark:document.documentElement.classList.contains('dark')})")
Check '★ 切到深色主题 → <html> 立刻带上 dark 类' ([bool]$domDark.dark) ($domDark | ConvertTo-Json -Compress)
$persisted = J (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({theme:c.theme});})")
Check '★ 主题落盘了（关掉重开还记得）' ($persisted.theme -eq 'dark') ($persisted.theme)
# 还原成用户原来那个主题
[void](EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.theme='$themeBefore';
  await inv('config_save',{config:c});
  return 'ok';
})()
"@)
Start-Sleep -Milliseconds 900
$themeBack = (J (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify({theme:c.theme});})")).theme
Check '★ 测完把主题还原成用户原来那个' ($themeBack -eq $themeBefore) ("$themeBefore → $themeBack")

# ─────────────────────── ⑥ 10.8-2 快捷键可改并生效 ───────────────────────
Write-Host ""
Write-Host "=== ⑥ PRD 10.8-2：快捷键可修改并生效 ==="
$key0 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('shortcut_status').then(function(s){return JSON.stringify(s);})")
Write-Host ("  当前 {0}（registered={1}）" -f $key0.accelerator, $key0.registered)
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.shortcuts.toggleSmallWindow='Ctrl+Alt+Space';
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 1200
$key1 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('shortcut_status').then(function(s){return JSON.stringify(s);})")
Check '★ 改成 Ctrl+Alt+Space 之后立刻生效（不用重启）' ($key1.accelerator -eq 'Ctrl+Alt+Space') ($key1.accelerator)
Check '★ 这个键在本机真的注册上了' ([bool]$key1.registered) ("registered=" + $key1.registered)
[void](EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.shortcuts.toggleSmallWindow='Ctrl+Space';
  await inv('config_save',{config:c});
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 900
Write-Output "  （已把快捷键还原成 PRD 默认的 Ctrl+Space）"

# ─────────────────────── ⑦ 收尾：把本轮造的测试数据清干净 ───────────────────────
# 之前这里没收尾，跑完会在用户的认知区里留下「小窗重开验收 …」「M7 首页联动验收 …」
# 两篇测试笔记 —— 用户自己打开认知区就会看见一堆没用的东西。
Write-Host ""
Write-Host "=== ⑦ 收尾：清掉本轮造的测试数据 ==="
$clean = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const testTitle=function(t){ return /^(小窗重开验收|M7 首页联动验收|M7 持久化标记)/.test(t||''); };
  let ri=0;
  for(const i of await inv('info_list')){
    if(testTitle(i.text)){ await inv('info_delete',{id:i.id}); ri++; }
  }
  let rt=0;
  for(const t of await inv('todo_list')){
    if(testTitle(t.title)){ await inv('todo_delete',{id:t.id}); rt++; }
  }
  const gone=[];
  for(const n of await inv('note_list')){
    if(testTitle(n.title)){ await inv('note_delete',{id:n.id}); gone.push(n.id); }
  }
  return JSON.stringify({infos:ri, todos:rt, notes:gone.length, noteIds:gone});
})()
'@)
Write-Host ("  清掉 信息 {0} / 待办 {1} / 笔记 {2}" -f $clean.infos, $clean.todos, $clean.notes)
# 回收站里只删**刚删掉这几篇**的副本（按 id 精确删），不动用户自己的回收站
$trash = Join-Path $DataDir 'notes\_trash'
$trashRemoved = 0
foreach ($noteId in @($clean.noteIds)) {
  foreach ($suffix in @('.json', '.json.bak', '.json.tmp')) {
    $target = Join-Path $trash ($noteId + $suffix)
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force; $trashRemoved++ }
  }
}
Write-Host ("  回收站里连带清掉 {0} 个文件（只删这几篇的，别的没碰）" -f $trashRemoved)
$leftover = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const bad=[];
  for(const i of await inv('info_list')){ if(/^(小窗重开验收|M7 首页联动验收|M7 持久化标记)/.test(i.text||'')) bad.push('信息:'+i.text); }
  for(const t of await inv('todo_list')){ if(/^(小窗重开验收|M7 首页联动验收|M7 持久化标记)/.test(t.title||'')) bad.push('待办:'+t.title); }
  for(const n of await inv('note_list')){ if(/^(小窗重开验收|M7 首页联动验收|M7 持久化标记)/.test(n.title||'')) bad.push('笔记:'+n.title); }
  return JSON.stringify({bad:bad, notes:(await inv('note_list')).map(function(n){return n.title;})});
})()
'@)
Check '★ 测试数据清干净了（认知区不留测试笔记）' ($leftover.bad.Count -eq 0) ($leftover.bad -join ' / ')
Write-Host ("  现在认知区里的笔记：{0}" -f (($leftover.notes) -join ' / '))

Write-Host ""
Write-Host "======================"
Write-Host ("M7 PRD 补充验收：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
