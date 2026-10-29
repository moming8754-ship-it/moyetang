# M14 · 认知区增强验收（A 目录语法 `toc第二章` + B 批注栏 + 「启用档案区」开关）
#
# 覆盖：
#   §1 A 目录语法 —— 正文里把规则表 7 行**全写进去**，目录里只许出现 3 条（都是「第二章」，
#      按 `data-toc-line` 断行号）；`TOC`/`Toc`/`tocontinue`/`toc2`/单独 `toc`/行中间的 `toc`
#      一条都不许进；点目录条目（**真实鼠标**）跳到那一行（编辑模式光标 + 视口滚动）；
#      预览模式下 toc 行画成 `[data-toc-heading]`。**正文一个字都不许变**。
#   §2 B 批注栏 —— 开关默认关（边栏没有批注页签）→ 真实鼠标点开关打开 → 页签出现 →
#      ＋（真实鼠标）→ 真实键盘打字 → 存下 → 卡片 / `anno_list` / `annotations.json` 三重落盘 →
#      点引文跳回 → **关掉页面重开**卡片还在 → 改批注 / 删批注 → 改正文（fuzzy 或 exact，绝不 orphan）
#      → 整句删掉（orphan 且批注不消失）。
#   §3 「启用档案区」开关关掉 → 批注页签消失（单独验），再打开又回来；开关只管显示。
#   §4 命令语义 `anno_list` / `anno_create` / `anno_set` / `anno_delete`。
#   §5 收尾：删净自己造的笔记与批注、开关还原、逐条核对用户那 7 条待办 / 3 篇笔记。
#
# 🔴 三条铁规矩（跟 tools\ 里所有脚本一致）：
#   ① **只动自己造的**（`M14 ` 前缀的笔记 + 挂在它上面的批注），用户的东西一个字不动；
#   ② 手势一律走**真实输入**：鼠标 `cdp.ps1 -Action mouse`、键盘 `-Action type`（CDP 的
#      `Input.insertText`，走浏览器输入管线、会真的触发 React onChange）——
#      合成 `dispatchEvent` 会绕过命中测试，给假绿灯（M4 栽过）；
#   ③ 正文铁律：**加目录行 / 加批注都不许改正文一个字** —— 每一步都拿 `note_get` 的 content 逐字比对。
#
# ⚠️ 两处"真机行为"（实测出来的，不是脚本绕路）：
#   ① CodeMirror 只渲染视口内的行 → 要拿正文中后段的坐标，得先把 `.cm-scroller` 滚到底再查元素；
#   ② 「整句删掉」这一步用**真实键盘覆盖输入**实现：先在页面里把 DOM 选区铺满那一行
#      （CodeMirror 监听 `selectionchange` 会把选区同步进自己的 state），再用 `Input.insertText`
#      送一个全角空格把它覆盖掉 —— 走的是浏览器的真实输入管线，不是 `el.value=` 那套。
#
# 用法（应用要以 CDP 9222 起着）：
#   powershell -ExecutionPolicy Bypass -File tools\m14\run.ps1
param([int]$Port = 9222, [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
$DATA = 'D:\东方摩耶堂'
$MAIN = '东方摩耶堂'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m14-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    for ($i = 0; $i -lt 3; $i++) {
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1
      $text = (($out | Out-String).Trim())
      if ($text) { return $text }
      Start-Sleep -Milliseconds 700
    }
    return ''
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function EvalIn([string]$title, [string]$require, [string]$js) {
  $tmp = Join-Path $env:TEMP ("m14f-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $raw = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $require 2>&1
    $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
    if ($errs.Count -gt 0) { return "" }
    return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function EvalJson([string]$js) {
  $t = EvalMain $js
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}
function Drive([string[]]$argv) {
  $raw = & powershell -NoProfile -File $cdp @argv 2>&1
  $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
  if ($errs.Count -gt 0) { return ("ERROR: " + (($errs -join ' ') -replace '\s+', ' ')) }
  return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
}
# 空字符串喂给 `ConvertFrom-Json` 会抛异常（EAP=Stop 时整个脚本当场停）→ 一律走这个
function ParseJson([string]$t) { if (-not $t) { return $null } try { return ($t | ConvertFrom-Json) } catch { return $null } }
# 页面整页重载那一两秒里 eval 会被打断 → 空结果重试几次，别把"上下文被销毁"当断言失败
function EvalInRetry([string]$title, [string]$require, [string]$js) {
  for ($i = 0; $i -lt 4; $i++) {
    $t = EvalIn $title $require $js
    if ($t) { return $t }
    Start-Sleep -Milliseconds 1200
  }
  return ''
}

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] " + $name) }
  else { $script:fail++; Write-Host ("  [X] " + $name + "  ::  " + $detail) }
}
function Step([string]$t) { Write-Host ""; Write-Host ("---- " + $t) }

# 真鼠标点主窗上的坐标（-X/-Y 走 cdp 的 Input.dispatchMouseEvent，是**真实输入**）
function ClickCoords($pt, [string]$what) {
  if (-not $pt) { return ("ERROR: 没拿到坐标（" + $what + " 不在页面上？）") }
  return (Drive @('-Action', 'mouse', '-X', "$($pt.x)", '-Y', "$($pt.y)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', $MAIN, '-RequireSelector', 'nav'))
}
# 真实键盘往某个元素打字（cdp.ps1 的 `-Action type` = CDP `Input.insertText`，浏览器输入管线）。
# ⚠️ 分两种：
#   · `<textarea>` / `<input>`（批注输入框、批注编辑框）→ **先聚焦 + 全选**，
#     这样 insertText 是**替换**而不是往后面追加（M13-C 的教训）；
#   · CodeMirror 的 `.cm-content`（contenteditable）→ **不要**碰焦点与选区：
#     它的光标位置是上一步真实鼠标点出来的，多调一次 `focus()` 会把选区搅乱。
function TypeInto([string]$selector, [string]$text) {
  $tmp = Join-Path $env:TEMP ("m14t-" + [guid]::NewGuid().ToString("N") + ".js")
  $js = "(function(){var el=document.querySelector('" + $selector + "'); if(!el) return 'NOT_FOUND'; if(el.setSelectionRange){ el.focus(); el.setSelectionRange(0,(el.value||'').length); return 'SELECTED:'+(el.value||'').length; } return 'AS_IS';})()"
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $picked = (& powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  $done = (& powershell -NoProfile -File $cdp -Action type -Selector $selector -Text $text -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  return ($picked + " | " + ($done -replace '\s+', ' '))
}

$H = @'
const sl=t=>new Promise(r=>setTimeout(r,t));
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
const bySel=(s)=>document.querySelector(s);
'@

$H2 = $H + @'
const centerOf=(el)=>{ if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2)}; };
const goPage=async(word)=>{ const B=()=>Array.from(document.querySelectorAll('nav button')); let n=null; for(let i=0;i<20&&!n;i++){ n=B().find(b=>(b.innerText||'').indexOf(word)>=0); if(!n) await sl(300);} if(n){ n.click(); await sl(1500);} return !!n; };
const noteRow=(id)=>bySel('[data-note-open="'+id+'"]');
const waitEditor=async()=>{ for(let i=0;i<25;i++){ if(bySel('.cm-content')) return true; await sl(400);} return false; };
const careLine=()=>{ const s=document.getSelection(); const n=s.anchorNode; const e=n?(n.nodeType===3?n.parentElement:n):null; const l=e?e.closest('.cm-line'):null; return l?l.textContent:null; };
const sTop=()=>{ const s=bySel('.cm-scroller'); return s?Math.round(s.scrollTop):null; };
const tocItems=()=>Array.from(document.querySelectorAll('[data-toc-item]')).map(e=>({text:e.getAttribute('data-toc-item'), line:parseInt(e.getAttribute('data-toc-line'),10)}));
const tocHeads=()=>Array.from(document.querySelectorAll('[data-toc-heading]')).map(e=>({text:e.getAttribute('data-toc-heading'), line:parseInt(e.getAttribute('data-toc-line'),10)}));
const cardOf=(id)=>bySel('[data-anno-card="'+id+'"]');
const kindOf=(id)=>{ const c=cardOf(id); return c?c.getAttribute('data-anno-kind'):null; };
// CodeMirror 只渲染视口内的行 → 先把滚动条拉到底，再找那一行；找不到返回 null
const cmLineOf=async(text)=>{ const sc=bySel('.cm-scroller'); for(let i=0;i<8;i++){ const l=Array.from(document.querySelectorAll('.cm-content .cm-line')).find(e=>e.textContent===text); if(l) return l; sc.scrollTop=sc.scrollHeight; await sl(400); } return null; };
const modeOf=(word)=>{ const b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').trim()===word); return b?centerOf(b):null; };
'@

# ═════════════════════════ 测试数据 ═════════════════════════
$NOTE_TITLE = 'M14 目录批注验收'
$SENT = '批注锚点测试句，这一句要写批注。'
$OTHER = '另一句完全不同的话，用来兜底。'
$CHAR = '很'
$ANNO_TEXT = '这一条批注是我写的'
$ANNO_EDIT = '改过的批注文字'

$LINES = @()
for ($i = 1; $i -le 30; $i++) { $LINES += ("填充第 {0:D2} 行。" -f $i) }   # 0..29：垫高度，让"跳行"真的会滚
$LINES += 'toc第二章'                    # 30 ✓ 正例
$LINES += 'toc 第二章'                   # 31 ✓ 正例（中间一个半角空格）
$LINES += '　　toc第二章'                 # 32 ✓ 正例（行首两个全角空格）
$LINES += 'TOC第二章'                    # 33 ✗ 大写不认
$LINES += 'Toc第二章'                    # 34 ✗ 首字母大写不认
$LINES += 'tocontinue 这个词不算'         # 35 ✗ 防误吃
$LINES += 'toc2 这个词也不算'             # 36 ✗ 防误吃
$LINES += 'toc'                          # 37 ✗ 光写 toc
$LINES += '见 toc第二章 那段（这一行也不算）'  # 38 ✗ 不在行首
$LINES += ''                             # 39 空行
$LINES += $SENT                          # 40 批注锚点那一句
$LINES += $OTHER                         # 41 兜底那一句
$CONTENT = ($LINES -join "`n")
$CJSON = ($CONTENT | ConvertTo-Json -Compress)
$L_SENT = 40
$L_OTHER = 41
$BAD_LINES = "'33','34','35','36','37','38'"

Write-Host ""
Write-Host "=== M14 认知区增强（A 目录语法 + B 批注栏 + 档案区开关）==="

# ═════════════════════════ §0 清场 + 基线 ═════════════════════════
Step '⓪ 开场先清场（M13 的教训：上一轮残留的弹窗那层 `fixed inset-0` 会吃掉所有真实鼠标输入）+ 记基线'

$pre = EvalJson @"
(async()=>{
$H2
  for(let i=0;i<5 && bySel('[role="dialog"]');i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250); }
  // 只清自己前缀的：`M14 ` 笔记 + 挂在它们身上的批注
  const stale=(await inv('note_list')).filter(n=>/^M14 /.test(n.title||''));
  const staleIds=stale.map(n=>n.id);
  for(const a of await inv('anno_list')){ if(staleIds.indexOf(a.noteId)>=0){ try{ await inv('anno_delete',{id:a.id}); }catch(e){} } }
  for(const n of stale){ try{ await inv('note_delete',{id:n.id}); }catch(e){} }
  await sl(900);
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const annos=await inv('anno_list');
  const cfg=await inv('config_get');
  // 🔴 开工归零：上一轮要是崩在收尾之前，这个开关会留在"开"的状态 —— 不归零，
  //    ③「开工是关着的」和后面每一格批注断言都会被带成假红（2026-09-27 实测：连挂 16 条）。
  let cfgNow=cfg;
  if(cfg.archive && cfg.archive.enabled){
    cfgNow=Object.assign({},cfg,{archive:{enabled:false}});
    await inv('config_save',{config:cfgNow});
    cfgNow=await inv('config_get');
    await sl(600);
  }
  // 设置页：开关默认状态（真读 DOM 的 checkbox.checked，不看代码猜）
  await goPage('设置');
  // ⚠️ M15 起：这张卡**平时只显示一行小字**（"想启用的话点这行字"），点了才展开开关 ——
  //    不先点开就读不到 toggle，这一格会假红
  const reveal=bySel('[data-archive-reveal]');
  if(reveal){ reveal.click(); await sl(600); }
  let toggle=bySel('[data-archive-toggle]');
  for(let i=0;i<20 && !toggle;i++){ await sl(300); toggle=bySel('[data-archive-toggle]'); }
  const setUi={card:!!bySel('[data-settings-archive]'), has:!!toggle, checked:toggle?toggle.checked:null, pt:toggle?centerOf(toggle):null};
  return JSON.stringify({dialogs:document.querySelectorAll('[role="dialog"]').length,
    leftNotes:notes.filter(n=>/^M14 /.test(n.title||'')).length,
    leftAnnos:annos.filter(a=>!notes.some(n=>n.id===a.noteId)&&/^M14 /.test(String(a.noteId||''))).length,
    annosAll:annos.length, archive:cfgNow.archive.enabled, setUi:setUi,
    todos:todos.map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length})),
    notes:notes.map(n=>({id:n.id,title:n.title,kind:n.kind,content:n.content})),
    cfgAll:{theme:cfg.theme, uiFont:cfg.uiFont, bodyFont:cfg.bodyFont, fontSize:cfg.fontSize, backupKeep:cfg.backupKeep,
      shortcuts:cfg.shortcuts, reminders:cfg.reminders, homeSticky:cfg.homeSticky,
      window:{smallPosition:cfg.window.smallPosition, smallMouseOffset:cfg.window.smallMouseOffset, closeToTray:cfg.window.closeToTray}}});
})()
"@
Write-Host ("  清场 + 基线：" + ($pre | ConvertTo-Json -Compress -Depth 5))
Check '① ★ 开场是干净的（没残留弹窗、没有上一轮留下的 `M14 ` 笔记）' ($pre -and [int]$pre.dialogs -eq 0 -and [int]$pre.leftNotes -eq 0) ("dialogs=" + $(if ($pre) { $pre.dialogs } else { '?' }) + " leftNotes=" + $(if ($pre) { $pre.leftNotes } else { '?' }))
$usersBase = @($pre.todos)
$notesBase = @($pre.notes)
$baseCfg = ($pre.cfgAll | ConvertTo-Json -Depth 8 -Compress)
# 🔴 2026-10-11（v2.19.0）：把「开工时就存在的**别人的**批注条数」记下来 —— 本套件下面所有
#    批注断言一律**跟这个基线比**，不再写死 0。
#    为什么非改不可：用户数据里躺着一条 **2026-10-06 的遗留测试批注**（`d968ac4b`，正文
#    「批注测试」，挂在一篇早就删掉的笔记上），它让这套的 6 条断言全变成假红（实测 **51/6**）。
#    判据要写「前后自比」，别写「用户那边应该长什么样」（§五 的老规矩）。
$annoForeign = if ($pre) { [int]$pre.annosAll } else { 0 }
Write-Host ("  开工时**别人的**批注（本套件一律不碰）：" + $annoForeign + " 条")
Write-Host ("  你的数据：待办 " + $usersBase.Count + " 条 / 笔记 " + $notesBase.Count + " 篇（收尾逐条核对）")
Check ('② ★ 基线记下了（' + $usersBase.Count + ' 条待办 / ' + $notesBase.Count + ' 篇笔记，逐条带 id+标题+状态+番茄数）') ($pre -and $usersBase.Count -gt 0 -and $notesBase.Count -gt 0) ("待办 " + $usersBase.Count + " / 笔记 " + $notesBase.Count)
$origArchive = if ($pre) { $pre.archive } else { $false }
Check '③ ★ 设置页有「档案区」卡片 + `[data-archive-toggle]` 开关，且**开工是关着的**（config_get 与界面 checkbox 两边对上）' ($pre -and $pre.setUi.card -and $pre.setUi.has -and $pre.setUi.checked -eq $false -and $origArchive -eq $false) ("config=" + $origArchive + " checkbox=" + $(if ($pre) { $pre.setUi.checked } else { '?' }))

# ═════════════════════════ §1 A 目录语法 ═════════════════════════
Write-Host ""
Write-Host "=== §1 目录语法 `toc第二章`（M14-A）==="

Step '④ 造一篇自己的笔记（`M14 ` 前缀，收尾自己删）：规则表 7 行全写进正文'
$made = EvalJson @"
(async()=>{
$H2
  const made=await inv('note_create',{title:'$NOTE_TITLE', kind:'doc', content:$CJSON});
  await sl(1200);
  const back=await inv('note_get',{id:made.id});
  await goPage('认知区');
  let row=noteRow(made.id);
  for(let i=0;i<20 && !row;i++){ await sl(400); row=noteRow(made.id); }
  return JSON.stringify({id:made.id, n:back.content.split('\n').length, same:(back.content===$CJSON),
    row:!!row, pt:row?centerOf(row):null});
})()
"@
Write-Host ("  造好：" + ($made | ConvertTo-Json -Compress))
Check ('④ 笔记建好、正文逐字回来一模一样（' + $LINES.Count + ' 行：30 行填充 + 规则表 7 行 + 2 句正文）') ($made -and $made.same -and [int]$made.n -eq $LINES.Count) ("行数 " + $(if ($made) { $made.n } else { '?' }) + "，逐字相同=" + $(if ($made) { $made.same } else { '?' }))
Check '⑤ 认知区里能找到这篇笔记的列表行（真鼠标点得到）' ($made -and $made.row -and $made.pt -and $made.pt.inView) ($made | ConvertTo-Json -Compress)
$NID = $made.id

Step '⑥ 真实鼠标点开这篇笔记 → 编辑器 + 右侧边栏'
Write-Host (ClickCoords $made.pt '笔记列表行')
Start-Sleep -Milliseconds 1800
$pane = EvalJson @"
(async()=>{
$H2
  const ok=await waitEditor();
  return JSON.stringify({editor:ok, side:!!bySel('[data-note-side]'), toggle:!!bySel('[data-side-toggle]'),
    tocTab:!!bySel('[data-side-tab="toc"]'), annoTab:!!bySel('[data-side-tab="anno"]'),
    title:(bySel('input[placeholder="笔记标题"]')||{}).value||null});
})()
"@
Write-Host ("  打开后：" + ($pane | ConvertTo-Json -Compress))
Check '⑥ 笔记打开了：CodeMirror 编辑器 + 右侧 `[data-note-side]` 边栏都在，标题是这篇' ($pane -and $pane.editor -and $pane.side -and $pane.title -eq $NOTE_TITLE) ($pane | ConvertTo-Json -Compress)
Check '⑦ ★★ 开关关着时，右侧边栏**没有** `[data-side-tab="anno"]`（用户定的：批注栏属于档案区）' ($pane -and $pane.tocTab -and $pane.annoTab -eq $false) ("目录页签=" + $(if ($pane) { $pane.tocTab } else { '?' }) + " 批注页签=" + $(if ($pane) { $pane.annoTab } else { '?' }))

Step '⑧ ★ 目录正例（3 条）与反例（`tocontinue` / `toc2` / 单独 `toc` / 行中间 / 大写）一起验'
$toc = EvalJson @"
(async()=>{
$H2
  const items=tocItems();
  return JSON.stringify({items:items, empty:!!bySel('[data-toc-empty]'),
    texts:items.map(e=>e.text), lines:items.map(e=>e.line),
    badText:items.filter(e=>/tocontinue|toc2|^toc$|TOC|Toc|见/i.test(e.text)).map(e=>e.text)});
})()
"@
$tocLines = @()
if ($toc) { $tocLines = @($toc.lines | Sort-Object) }
Write-Host ("  目录读到：" + ($toc | ConvertTo-Json -Compress))
Check '⑧ ★ 目录正好 3 条（规则表里 7 行只有前 3 行算），条目文字都是「第二章」' ($toc -and @($toc.items).Count -eq 3 -and @($toc.texts | Where-Object { $_ -ne '第二章' }).Count -eq 0) ("读到 " + @($toc.items).Count + " 条：" + (@($toc.texts) -join ' / '))
Check '⑨ ★ `data-toc-line` 分别落在第 30 / 31 / 32 行（0 起；前三条都合法，靠行号区分）' ($toc -and $tocLines.Count -eq 3 -and $tocLines[0] -eq 30 -and $tocLines[1] -eq 31 -and $tocLines[2] -eq 32) ("行号 " + ($tocLines -join ','))
Check '⑩ ★★ 反例一条都没进目录：`TOC第二章` / `Toc第二章` / `tocontinue` / `toc2` / 单独 `toc` / 行中间的 全都不在' ($toc -and @($toc.badText).Count -eq 0 -and @($toc.lines | Where-Object { [int]$_ -ge 33 -and [int]$_ -le 38 }).Count -eq 0) ("可疑条目 " + (@($toc.badText) -join ' / ') + "；33~38 行进目录的条数 " + @($toc.lines | Where-Object { [int]$_ -ge 33 -and [int]$_ -le 38 }).Count)
Check '⑪ 有目录时不该显示空状态 `[data-toc-empty]`' ($toc -and $toc.empty -eq $false) ("empty=" + $(if ($toc) { $toc.empty } else { '?' }))

Step '⑫ 折叠开关 `[data-side-toggle]`：真实鼠标点两下（收起 → 再展开）'
$tg = EvalJson @"
(async()=>{
$H2
  const t=bySel('[data-side-toggle]');
  return JSON.stringify({pt:t?centerOf(t):null, open:!!bySel('[data-note-side]')});
})()
"@
Write-Host (ClickCoords $tg.pt '目录/批注 折叠开关')
Start-Sleep -Milliseconds 900
$tgOff = EvalJson @"
(async()=>{
$H2
  return JSON.stringify({side:!!bySel('[data-note-side]')});
})()
"@
# ⚠️ 2026-10-06：原来这里直接复用**收起前**那次读到的坐标再点一下 —— 实测偶发"第二下没生效"
#    （同坐标、同 900ms 间隔，单跑却复现不出来；怀疑是面板收起那一刻的重排把这次点击吃掉了）。
#    产品本身没问题：手动真鼠标点两次（同坐标）能正常"收起 → 展开"（`.spike\diag-sidetoggle.ps1` 见证）。
#    所以套件这边改成**每次都重新取坐标 + 最多试 3 次**；⑬ 仍旧断言"边栏回来了、目录 3 条"，
#    只是不再因为一次偶发点击落空就把后面 6 条全带崩。
$tgOn = $null
for ($i = 0; $i -lt 3; $i++) {
  $tnow = EvalJson @"
(async()=>{
$H2
  const t=bySel('[data-side-toggle]');
  return JSON.stringify({pt:t?centerOf(t):null, side:!!bySel('[data-note-side]')});
})()
"@
  if ($tnow -and $tnow.side) { $tgOn = $tnow; break }
  if (-not $tnow -or -not $tnow.pt) { Start-Sleep -Milliseconds 600; continue }
  Write-Host (ClickCoords $tnow.pt ("目录/批注 折叠开关（第 " + ($i + 1) + " 次）"))
  Start-Sleep -Milliseconds 900
  $tgOn = EvalJson @"
(async()=>{
$H2
  return JSON.stringify({side:!!bySel('[data-note-side]'), items:tocItems().length});
})()
"@
  if ($tgOn -and $tgOn.side) { break }
}
Write-Host ("  收起后：" + ($tgOff | ConvertTo-Json -Compress) + "  再展开：" + ($tgOn | ConvertTo-Json -Compress))
Check '⑫ ★ 真实鼠标点一下折叠开关 → 边栏收起（`[data-note-side]` 消失）' ($tg -and $tg.open -and $tgOff -and $tgOff.side -eq $false) ($tgOff | ConvertTo-Json -Compress)
Check '⑬ 再点一下 → 边栏回来、目录条目还在（3 条）' ($tgOn -and $tgOn.side -and [int]$tgOn.items -eq 3) ($tgOn | ConvertTo-Json -Compress)

Step '⑭ ★ 真实鼠标点第 3 条目录（`data-toc-line=32`）→ 编辑模式光标跑到那一行'
$jump = EvalJson @"
(async()=>{
$H2
  const before=sTop();
  const el=document.querySelector('[data-toc-item][data-toc-line="32"]');
  return JSON.stringify({pt:el?centerOf(el):null, before:before, caretBefore:careLine()});
})()
"@
Write-Host (ClickCoords $jump.pt '目录条目（第 3 条）')
Start-Sleep -Milliseconds 1200
$jumped = EvalJson @"
(async()=>{
$H2
  const after=sTop();
  const caret=careLine();
  const inView=(()=>{ const l=Array.from(document.querySelectorAll('.cm-content .cm-line')).find(e=>e.textContent==='　　toc第二章'); if(!l) return null; const r=l.getBoundingClientRect(); return (r.top>=-2&&r.bottom<=window.innerHeight+2); })();
  const focusInEditor=document.activeElement?(document.activeElement.className||'').indexOf('cm-content')>=0:false;
  return JSON.stringify({after:after, caret:caret, inView:inView, focusInEditor:focusInEditor,
    active:!!document.querySelector('[data-toc-item][data-toc-line="32"]')});
})()
"@
Write-Host ("  点完：" + ($jumped | ConvertTo-Json -Compress) + "（点前 scrollTop=" + $(if ($jump) { $jump.before } else { '?' }) + " 光标行=" + $(if ($jump) { $jump.caretBefore } else { '(空)' }) + "）")
Check '⑭ ★★ 编辑模式光标真的到那一行了（当前行文字 = `　　toc第二章` —— 三条合法行里只有它带全角空格，认得出）' ($jumped -and $jumped.caret -eq '　　toc第二章') ("读到 " + $(if ($jumped) { $jumped.caret } else { '(空)' }))
Check '⑮ ★ 视口真的滚过去了（scrollTop 变了，且那一行落在可视区里）' ($jumped -and $jump -and [int]$jumped.after -ne [int]$jump.before -and $jumped.inView -eq $true) ("scrollTop " + $(if ($jump) { $jump.before } else { '?' }) + " → " + $(if ($jumped) { $jumped.after } else { '?' }) + "；那一行在视野内=" + $(if ($jumped) { $jumped.inView } else { '?' }))

Step '⑯ ★ 点完目录正文一个字没变（`note_get` 逐字比对）'
$c1 = EvalJson @"
(async()=>{
$H2
  const back=await inv('note_get',{id:'$NID'});
  return JSON.stringify({content:back.content, same:(back.content===$CJSON)});
})()
"@
Check '⑯ ★★ 加目录行 + 点目录跳转之后，正文与开工时**逐字完全相同**（V1 铁律：目录只读正文）' ($c1 -and $c1.same -eq $true) ("逐字相同=" + $(if ($c1) { $c1.same } else { '?' }))

Step '⑰ 预览模式：`toc` 行画成标题，且反例行不许被画成标题'
$preMode = EvalJson @"
(async()=>{
$H2
  const pt=modeOf('预览');
  return JSON.stringify({pt:pt});
})()
"@
Write-Host (ClickCoords $preMode.pt '「预览」按钮')
Start-Sleep -Milliseconds 1200
$prev = EvalJson @"
(async()=>{
$H2
  const heads=tocHeads();
  const items=tocItems();
  return JSON.stringify({heads:heads, items:items.length,
    hLines:heads.map(h=>h.line).sort((a,b)=>a-b), hTexts:heads.map(h=>h.text),
    bad:heads.filter(h=>h.text!=='第二章').map(h=>h.text),
    toc32:(()=>{ const e=document.querySelector('[data-toc-heading][data-toc-line="32"]'); return e?centerOf(e):null; })()});
})()
"@
Write-Host ("  预览里：" + ($prev | ConvertTo-Json -Compress))
Check '⑰ ★ 预览模式把 3 条 toc 行画成 `[data-toc-heading]`，文字都是「第二章」、行号 30/31/32' ($prev -and @($prev.heads).Count -eq 3 -and @($prev.hTexts | Where-Object { $_ -ne '第二章' }).Count -eq 0 -and $prev.hLines[0] -eq 30 -and $prev.hLines[1] -eq 31 -and $prev.hLines[2] -eq 32) ("标题 " + @($prev.heads).Count + " 个：" + (@($prev.hTexts) -join ' / ') + " 行号 " + ($prev.hLines -join ','))
Check '⑱ ★ 反例行（大写 / `tocontinue` / `toc2` / 单独 `toc` / 行中间）在预览里**没有**被画成标题' ($prev -and @($prev.bad).Count -eq 0) ("可疑标题 " + (@($prev.bad) -join ' / '))
Check '⑲ 预览里目录页签还在（3 条）' ($prev -and [int]$prev.items -eq 3) ("条目 " + $(if ($prev) { $prev.items } else { '?' }) + " 条")

Step '⑳ 预览模式下点目录条目 → 滚到那个标题（真实鼠标）'
Write-Host (ClickCoords $jump.pt '目录条目（第 3 条，预览模式）')
Start-Sleep -Milliseconds 1200
$pvJump = EvalJson @"
(async()=>{
$H2
  const e=document.querySelector('[data-toc-heading][data-toc-line="32"]');
  const r=e?e.getBoundingClientRect():null;
  return JSON.stringify({found:!!e, inView:r?(r.top>=-2&&r.bottom<=window.innerHeight+2):null,
    caret:careLine()});
})()
"@
Write-Host ("  点完：" + ($pvJump | ConvertTo-Json -Compress))
Check '⑳ ★ 预览模式下点目录 → 那个标题滚进了可视区（滚动是落在标题元素上的）' ($pvJump -and $pvJump.found -and $pvJump.inView -eq $true) ($pvJump | ConvertTo-Json -Compress)
$editBtn = EvalJson @"
(async()=>{
$H2
  const pt=modeOf('编辑');
  return JSON.stringify({pt:pt});
})()
"@
Write-Host (ClickCoords $editBtn.pt '「编辑」按钮（切回去）')
Start-Sleep -Milliseconds 1200
$back2edit = EvalJson @"
(async()=>{
$H2
  const ok=await waitEditor();
  return JSON.stringify({editor:ok});
})()
"@
Check '㉑ 切回编辑模式，编辑器还在' ($back2edit -and $back2edit.editor) ($back2edit | ConvertTo-Json -Compress)

# ═════════════════════════ §2 B 批注栏 ═════════════════════════
Write-Host ""
Write-Host "=== §2 批注栏（M14-B，默认关着）==="

Step '㉒ 真实鼠标点设置页的「启用档案区」开关 → 打开'
$openIt = EvalJson @"
(async()=>{
$H2
  await goPage('设置');
  // ⚠️ M15 起开关藏在「那行小字」后面：先点开再找 toggle（㉒/㊺ 这两格重挂过页面，状态丢了）
  { const rv=bySel('[data-archive-reveal]'); if(rv){ rv.click(); await sl(600); } }
  let t=bySel('[data-archive-toggle]');
  for(let i=0;i<20 && !t;i++){ await sl(300); t=bySel('[data-archive-toggle]'); }
  return JSON.stringify({pt:t?centerOf(t):null, checked:t?t.checked:null});
})()
"@
Write-Host (ClickCoords $openIt.pt '「启用档案区」开关')
Start-Sleep -Milliseconds 1200
$opened = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  const t=bySel('[data-archive-toggle]');
  return JSON.stringify({enabled:cfg.archive.enabled, checked:t?t.checked:null});
})()
"@
Write-Host ("  打开后：" + ($opened | ConvertTo-Json -Compress))
Check '㉒ ★ 真实鼠标点开关 → `config_get` 里 `archive.enabled` = true，界面 checkbox 也勾上了' ($opened -and $opened.enabled -eq $true -and $opened.checked -eq $true) ($opened | ConvertTo-Json -Compress)

Step '㉓ 回认知区：边栏多出「批注」页签'
$reopen = EvalJson @"
(async()=>{
$H2
  await goPage('认知区');
  let row=noteRow('$NID');
  for(let i=0;i<20 && !row;i++){ await sl(400); row=noteRow('$NID'); }
  return JSON.stringify({row:!!row, pt:row?centerOf(row):null});
})()
"@
Write-Host (ClickCoords $reopen.pt '笔记列表行')
Start-Sleep -Milliseconds 1800
$tab = EvalJson @"
(async()=>{
$H2
  await waitEditor();
  const a=bySel('[data-side-tab="anno"]');
  return JSON.stringify({annoTab:!!a, pt:a?centerOf(a):null, title:(bySel('input[placeholder="笔记标题"]')||{}).value||null});
})()
"@
Write-Host ("  边栏：" + ($tab | ConvertTo-Json -Compress))
Check '㉓ ★★ 开关打开后，右侧边栏出现 `[data-side-tab="anno"]`「批注」页签' ($tab -and $tab.annoTab -and $tab.title -eq $NOTE_TITLE) ($tab | ConvertTo-Json -Compress)

Step '㉔ 真实鼠标点「批注」页签 → ＋ 按钮 + 空状态'
Write-Host (ClickCoords $tab.pt '「批注」页签')
Start-Sleep -Milliseconds 900
$annoPane = EvalJson @"
(async()=>{
$H2
  const add=bySel('[data-anno-add]');
  return JSON.stringify({add:!!add, pt:add?centerOf(add):null, empty:!!bySel('[data-anno-empty]'), cards:document.querySelectorAll('[data-anno-card]').length});
})()
"@
Write-Host ("  批注页：" + ($annoPane | ConvertTo-Json -Compress))
Check '㉔ 批注页里有 `[data-anno-add]`（＋ 给光标那一句写批注），还没有批注时显示空状态' ($annoPane -and $annoPane.add -and $annoPane.empty -and [int]$annoPane.cards -eq 0) ($annoPane | ConvertTo-Json -Compress)

Step '㉕ 真实鼠标点正文里那句话（把光标放上去）→ 再点 ＋ 起草'
$sentPt = EvalJson @"
(async()=>{
$H2
  const l=await cmLineOf('$SENT');
  if(!l) return JSON.stringify({found:false});
  l.scrollIntoView({block:'center'});
  const r=l.getBoundingClientRect();
  return JSON.stringify({found:true, x:Math.round(r.left+40), y:Math.round(r.top+r.height/2)});
})()
"@
Write-Host ("  那一句坐标：" + ($sentPt | ConvertTo-Json -Compress))
Write-Host (Drive @('-Action', 'mouse', '-X', "$($sentPt.x)", '-Y', "$($sentPt.y)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', $MAIN, '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 700
$onSent = EvalJson @"
(async()=>{
$H2
  return JSON.stringify({caret:careLine(), addPt:(()=>{const a=bySel('[data-anno-add]'); return a?centerOf(a):null;})()});
})()
"@
Write-Host ("  光标落在：" + ($onSent | ConvertTo-Json -Compress))
Check '㉕ ★ 真实鼠标点正文 → 光标落在那句话上（当前行就是待批注那句）' ($sentPt.found -and $onSent -and $onSent.caret -eq $SENT) ("光标行 = " + $(if ($onSent) { $onSent.caret } else { '(空)' }))
Write-Host (ClickCoords $onSent.addPt '＋ 给光标那一句写批注')
Start-Sleep -Milliseconds 900
$draft = EvalJson @"
(async()=>{
$H2
  const d=bySel('[data-anno-draft]');
  return JSON.stringify({draft:!!d, quote:d?d.innerText.replace(/\s+/g,' ').slice(0,60):null, input:!!bySel('[data-anno-input]')});
})()
"@
Write-Host ("  起草：" + ($draft | ConvertTo-Json -Compress))
Check '㉖ ★ 点 ＋ 弹出 `[data-anno-draft]`，引文就是光标那一句（锚点是算出来的，不是猜的）' ($draft -and $draft.draft -and $draft.input -and ("$($draft.quote)" -like "*$SENT*")) ("引文=" + $(if ($draft) { $draft.quote } else { '(空)' }))

Step '㉗ 真实键盘往 `[data-anno-input]` 打字 → 真实鼠标点 `[data-anno-save]`'
Write-Host ("  " + (TypeInto '[data-anno-input]' $ANNO_TEXT))
Start-Sleep -Milliseconds 600
$savePt = EvalJson @"
(async()=>{
$H2
  const b=bySel('[data-anno-save]');
  return JSON.stringify({pt:b?centerOf(b):null, val:(bySel('[data-anno-input]')||{}).value||null});
})()
"@
Write-Host ("  输入框里读到：" + ($savePt.val | ConvertTo-Json -Compress))
Check '㉗ 真实键盘打的字进了输入框（不是 `el.value=` 那套假输入）' ($savePt -and $savePt.val -eq $ANNO_TEXT) ("读到 " + $(if ($savePt) { $savePt.val } else { '(空)' }))
Write-Host (ClickCoords $savePt.pt '「存下」按钮')
Start-Sleep -Milliseconds 1500
$card = EvalJson @"
(async()=>{
$H2
  let c=null;
  for(let i=0;i<15 && !c;i++){ c=bySel('[data-anno-card]'); if(!c) await sl(300); }
  if(!c) return JSON.stringify({card:false});
  const id=c.getAttribute('data-anno-card');
  const annos=await inv('anno_list');
  const mine=annos.filter(a=>a.noteId==='$NID');
  return JSON.stringify({card:true, id:id, kind:c.getAttribute('data-anno-kind'),
    text:(c.querySelector('[data-anno-text]')||{}).textContent||null,
    quote:(c.querySelector('[data-anno-quote]')||{}).textContent||null,
    cards:document.querySelectorAll('[data-anno-card]').length,
    listCount:annos.length, mineCount:mine.length, quote0:mine.length?mine[0].quote:null,
    hash0:mine.length?mine[0].hash:null, del:!!c.querySelector('[data-anno-del]')});
})()
"@
Write-Host ("  卡片：" + ($card | ConvertTo-Json -Compress))
Check '㉘ ★ 卡片 `[data-anno-card]` 出来了，正文 `[data-anno-text]` = 我打的字、引文 `[data-anno-quote]` = 原句' ($card -and $card.card -and $card.text -eq $ANNO_TEXT -and ("$($card.quote)" -like "*$SENT*")) ("text=" + $(if ($card) { $card.text } else { '?' }) + " quote=" + $(if ($card) { $card.quote } else { '?' }))
Check '㉙ ★ 新批注的锚点解析是 `exact`（没改过正文 → 哈希直接命中）' ($card -and $card.kind -eq 'exact') ("kind=" + $(if ($card) { $card.kind } else { '?' }))
Check '㉚ ★ `anno_list` 里有这一条，且 noteId 就是这篇笔记' ($card -and [int]$card.mineCount -eq 1 -and $card.quote0 -eq $SENT -and $card.hash0) ("我的批注 " + $(if ($card) { $card.mineCount } else { '?' }) + " 条，quote=" + $(if ($card) { $card.quote0 } else { '?' }) + " hash=" + $(if ($card) { $card.hash0 } else { '?' }))
$AID = $card.id

Step '㉛ ★ 真落盘：`annotations.json` 顶层 `{items:[...]}` 且里面有这条'
$annoFile = Join-Path $DATA 'annotations.json'
$disk = $null
if (Test-Path $annoFile) { try { $disk = (Get-Content $annoFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $disk = $null } }
$diskHit = $null
if ($disk -and $disk.items) { $diskHit = @($disk.items | Where-Object { $_.id -eq $AID }) }
Write-Host ("  盘上：" + $(if ($disk) { ("items " + @($disk.items).Count + " 条") } else { '(没读到 annotations.json)' }))
Check '㉛ ★★ 批注真的落盘了：`annotations.json` 顶层是 `{items:[...]}`，里面就是刚写的那条（id 对得上）' ($disk -and $disk.items -and @($diskHit).Count -eq 1 -and $diskHit[0].text -eq $ANNO_TEXT -and $diskHit[0].noteId -eq $NID) ("items=" + $(if ($disk) { @($disk.items).Count } else { '?' }) + " 命中=" + @($diskHit).Count)

Step '㉜ ★ 加批注前后正文逐字比对（批注只活在右边栏，不许碰正文）'
$c2 = EvalJson @"
(async()=>{
$H2
  const back=await inv('note_get',{id:'$NID'});
  return JSON.stringify({content:back.content, same:(back.content===$CJSON)});
})()
"@
Check '㉜ ★★ 写完批注后正文与开工时**逐字完全相同**（含 3 行目录行、7 行规则表）' ($c2 -and $c2.same -eq $true) ("逐字相同=" + $(if ($c2) { $c2.same } else { '?' }))

Step '㉝ ★ 真实鼠标点引文 `[data-anno-quote]` → 跳回那一句'
$beforeJump = EvalJson @"
(async()=>{
$H2
  const sc=bySel('.cm-scroller'); if(sc) sc.scrollTop=sc.scrollHeight;
  await sl(500);
  const q=bySel('[data-anno-quote]');
  return JSON.stringify({pt:q?centerOf(q):null, before:sTop()});
})()
"@
Write-Host (ClickCoords $beforeJump.pt '批注引文')
Start-Sleep -Milliseconds 1200
$jumpedAnno = EvalJson @"
(async()=>{
$H2
  const l=await cmLineOf('$SENT');
  const r=l?l.getBoundingClientRect():null;
  return JSON.stringify({caret:careLine(), after:sTop(), inView:r?(r.top>=-2&&r.bottom<=window.innerHeight+2):null});
})()
"@
Write-Host ("  点完引文：" + ($jumpedAnno | ConvertTo-Json -Compress))
Check '㉝ ★ 点引文 → 跳回那一句（编辑模式光标落在那句上 / 那一行在视野里）' ($jumpedAnno -and ($jumpedAnno.caret -eq $SENT -or $jumpedAnno.inView -eq $true)) ("光标行=" + $(if ($jumpedAnno) { $jumpedAnno.caret } else { '(空)' }) + " inView=" + $(if ($jumpedAnno) { $jumpedAnno.inView } else { '?' }))

Step '㉞ ★★ 关掉页面重开（`location.reload()`）→ 批注卡片还在（落盘 + 重载读回）'
$rl = EvalJson @"
(async()=>{
$H2
  setTimeout(()=>location.reload(),300);
  return JSON.stringify({reloading:true});
})()
"@
Write-Host ("  触发重载：" + ($rl | ConvertTo-Json -Compress))
Start-Sleep -Seconds 8
$ready = EvalInRetry $MAIN 'nav' "(async()=>{ const sl=t=>new Promise(r=>setTimeout(r,t)); for(let i=0;i<40;i++){ if(document.querySelector('nav button')) return 'READY'; await sl(400);} return 'NOT_READY'; })()"
Write-Host ("  重载后：" + $ready)
$afterReload = EvalJson @"
(async()=>{
$H2
  await goPage('认知区');
  let row=noteRow('$NID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NID'); }
  if(row) row.click();
  await sl(1600);
  await waitEditor();
  let a=bySel('[data-side-tab="anno"]');
  for(let i=0;i<15 && !a;i++){ await sl(400); a=bySel('[data-side-tab="anno"]'); }
  if(a) a.click();
  await sl(1200);
  let c=null;
  for(let i=0;i<15 && !c;i++){ c=bySel('[data-anno-card]'); if(!c) await sl(400); }
  const annos=await inv('anno_list');
  return JSON.stringify({annoTab:!!a, card:!!c, cards:document.querySelectorAll('[data-anno-card]').length,
    text:c?(c.querySelector('[data-anno-text]')||{}).textContent||null:null,
    kind:c?c.getAttribute('data-anno-kind'):null,
    listCount:annos.length, mineCount:annos.filter(x=>x.noteId==='$NID').length});
})()
"@
Write-Host ("  重开后：" + ($afterReload | ConvertTo-Json -Compress))
Check '㉞ ★★ 重开页面后卡片还在（`[data-anno-card]`），文字与 kind 原样' ($afterReload -and $afterReload.card -and $afterReload.text -eq $ANNO_TEXT -and $afterReload.kind -eq 'exact') ($afterReload | ConvertTo-Json -Compress)
Check '㉟ 重开后 `anno_list` 还是那一条（没重复、没丢；全部 = 自己那 1 条 + 开工就有的遗留）' ($afterReload -and [int]$afterReload.mineCount -eq 1 -and [int]$afterReload.listCount -eq (1 + $annoForeign)) ("我的 " + $(if ($afterReload) { $afterReload.mineCount } else { '?' }) + " 条 / 全部 " + $(if ($afterReload) { $afterReload.listCount } else { '?' }) + " 条（遗留 " + $annoForeign + "）")

Step '㊱ 改批注：真实鼠标点 `[data-anno-text]` → 真键盘改字 → 点 `[data-anno-edit-save]`'
$editPt = EvalJson @"
(async()=>{
$H2
  const t=bySel('[data-anno-text]');
  return JSON.stringify({pt:t?centerOf(t):null});
})()
"@
Write-Host (ClickCoords $editPt.pt '批注正文（进入编辑）')
Start-Sleep -Milliseconds 900
$editOpen = EvalJson @"
(async()=>{
$H2
  const e=bySel('[data-anno-edit]');
  return JSON.stringify({edit:!!e, val:e?e.value:null, id:e?e.getAttribute('data-anno-edit'):null});
})()
"@
Write-Host ("  编辑态：" + ($editOpen | ConvertTo-Json -Compress))
Check '㊱ ★ 点批注正文 → 出现 `[data-anno-edit="<id>"]`，里面是原来的文字' ($editOpen -and $editOpen.edit -and $editOpen.val -eq $ANNO_TEXT -and $editOpen.id -eq $AID) ($editOpen | ConvertTo-Json -Compress)
# 用不带引号的选择器：`[data-anno-edit="<id>"]` 里的引号穿过 `powershell -File` 传到 cdp.ps1 时会被吃掉
# （项目老坑：**别把带 `"` 的 CSS 选择器穿过 `powershell -File`**）。编辑态只有这一个框，不带 id 也唯一。
Write-Host ("  " + (TypeInto "[data-anno-edit]" $ANNO_EDIT))
Start-Sleep -Milliseconds 600
$editSavePt = EvalJson @"
(async()=>{
$H2
  const b=bySel('[data-anno-edit-save]');
  return JSON.stringify({pt:b?centerOf(b):null});
})()
"@
Write-Host (ClickCoords $editSavePt.pt '批注「存下」')
Start-Sleep -Milliseconds 1400
$edited = EvalJson @"
(async()=>{
$H2
  const c=bySel('[data-anno-card]');
  const annos=await inv('anno_list');
  const mine=annos.filter(a=>a.noteId==='$NID');
  return JSON.stringify({text:c?(c.querySelector('[data-anno-text]')||{}).textContent||null:null,
    kind:c?c.getAttribute('data-anno-kind'):null,
    listText:mine.length?mine[0].text:null, listQuote:mine.length?mine[0].quote:null, listHash:mine.length?mine[0].hash:null});
})()
"@
Write-Host ("  改完：" + ($edited | ConvertTo-Json -Compress))
Check '㊲ ★ 改批注真的存下来了（卡片文字 + `anno_list` 的 text 都变了），而且**锚点四件套没动**' ($edited -and $edited.text -eq $ANNO_EDIT -and $edited.listText -eq $ANNO_EDIT -and $edited.listQuote -eq $SENT -and $edited.listHash -eq $card.hash0) ("卡片=" + $(if ($edited) { $edited.text } else { '?' }) + " list=" + $(if ($edited) { $edited.listText } else { '?' }) + " quote/hash 未变=" + ($edited -and $edited.listQuote -eq $SENT -and $edited.listHash -eq $card.hash0))

Step '㊳ ★ 改正文几个字（真实鼠标点进那句 + 真实键盘插一个字）→ 批注跟着走，绝不 orphan'
$sentPt2 = EvalJson @"
(async()=>{
$H2
  const l=await cmLineOf('$SENT');
  if(!l) return JSON.stringify({found:false});
  l.scrollIntoView({block:'center'});
  const r=l.getBoundingClientRect();
  return JSON.stringify({found:true, x:Math.round(r.left+40), y:Math.round(r.top+r.height/2)});
})()
"@
Write-Host ("  那句话坐标：" + ($sentPt2 | ConvertTo-Json -Compress))
Write-Host (Drive @('-Action', 'mouse', '-X', "$($sentPt2.x)", '-Y', "$($sentPt2.y)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', $MAIN, '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 700
Write-Host ("  " + (TypeInto '.cm-content' $CHAR))
Start-Sleep -Milliseconds 1600
$afterEdit = EvalJson @"
(async()=>{
$H2
  const back=await inv('note_get',{id:'$NID'});
  const after=back.content.split('\n');
  const before=$CJSON.split('\n');
  const othersSame=(()=>{ for(let i=0;i<before.length;i++){ if(i===$L_SENT) continue; if(after[i]!==before[i]) return false; } return after.length===before.length; })();
  const lineOk=(after[$L_SENT].length===before[$L_SENT].length+1 && after[$L_SENT].split('$CHAR').join('')===before[$L_SENT]);
  const c=bySel('[data-anno-card]');
  return JSON.stringify({othersSame:othersSame, lineOk:lineOk, line:after[$L_SENT], was:before[$L_SENT],
    content:back.content,
    kind:c?c.getAttribute('data-anno-kind'):null, orphan:!!bySel('[data-anno-orphan]'),
    caret:careLine()});
})()
"@
Write-Host ("  改完正文：" + ($afterEdit | ConvertTo-Json -Compress -Depth 3))
Check '㊳ ★★ 正文只多了刚敲的那一个字（第 40 行多一个字，其它 41 行一字不差）' ($afterEdit -and $afterEdit.lineOk -and $afterEdit.othersSame) ("第 40 行 " + $(if ($afterEdit) { $afterEdit.was } else { '?' }) + " → " + $(if ($afterEdit) { $afterEdit.line } else { '?' }) + "；其它行未变=" + $(if ($afterEdit) { $afterEdit.othersSame } else { '?' }))
Check '㊴ ★★ 批注跟着走：`data-anno-kind` 变成 `fuzzy`（或仍是 `exact`），**绝不许是 orphan**' ($afterEdit -and ($afterEdit.kind -eq 'fuzzy' -or $afterEdit.kind -eq 'exact')) ("kind=" + $(if ($afterEdit) { $afterEdit.kind } else { '?' }))

Step '㊵ ★ 把那一句整段删掉（真实键盘覆盖输入）→ 批注变 orphan 且**不消失**'
$delPre = EvalJson @"
(async()=>{
$H2
  const back=await inv('note_get',{id:'$NID'});
  const line=back.content.split('\n')[$L_SENT];
  const l=await cmLineOf(line);
  if(!l) return JSON.stringify({found:false});
  l.scrollIntoView({block:'center'});
  const range=document.createRange();
  range.selectNodeContents(l);
  const sel=document.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  await sl(300);
  return JSON.stringify({found:true, line:line, selText:document.getSelection().toString()});
})()
"@
Write-Host ("  选中那一句：" + ($delPre | ConvertTo-Json -Compress))
Write-Host ("  " + (TypeInto '.cm-content' '　'))
Start-Sleep -Milliseconds 1800
$cEditJson = ($afterEdit.content | ConvertTo-Json -Compress)
$orphan = EvalJson @"
(async()=>{
$H2
  const back=await inv('note_get',{id:'$NID'});
  const after=back.content.split('\n');
  const prev=$cEditJson.split('\n');
  let othersSame=(after.length===prev.length);
  for(let i=0;i<prev.length;i++){ if(i===$L_SENT) continue; if(after[i]!==prev[i]) othersSame=false; }
  const c=bySel('[data-anno-card]');
  const id=c?c.getAttribute('data-anno-card'):null;
  const annos=await inv('anno_list');
  return JSON.stringify({line:after[$L_SENT], lineBlank:(after[$L_SENT].trim()===''),
    n:after.length, othersSame:othersSame,
    card:!!c, kind:c?c.getAttribute('data-anno-kind'):null, orphanMark:id?!!bySel('[data-anno-orphan="'+id+'"]'):false,
    quote:c?(c.querySelector('[data-anno-quote]')||{}).textContent||null:null,
    text:c?(c.querySelector('[data-anno-text]')||{}).textContent||null:null,
    listCount:annos.filter(a=>a.noteId==='$NID').length});
})()
"@
Write-Host ("  删完整句：" + ($orphan | ConvertTo-Json -Compress))
Check '㊵ ★★ 那句话真的没了（第 40 行只剩空白）、行数没变、**其它 41 行一字不差**' ($orphan -and $orphan.lineBlank -and [int]$orphan.n -eq $LINES.Count -and $orphan.othersSame) ("第 40 行 = '" + $(if ($orphan) { $orphan.line } else { '?' }) + "'；行数 " + $(if ($orphan) { $orphan.n } else { '?' }) + "；其它行未变=" + $(if ($orphan) { $orphan.othersSame } else { '?' }))
Check '㊶ ★★ 批注变成 `orphan`：`data-anno-kind="orphan"` + `[data-anno-orphan]` 标了出来' ($orphan -and $orphan.kind -eq 'orphan' -and $orphan.orphanMark) ("kind=" + $(if ($orphan) { $orphan.kind } else { '?' }) + " 标记=" + $(if ($orphan) { $orphan.orphanMark } else { '?' }))
Check '㊷ ★★ 批注**没有消失**：卡片还在、原话还留着、`anno_list` 里还是那一条' ($orphan -and $orphan.card -and ("$($orphan.quote)" -like "*$SENT*") -and [int]$orphan.listCount -eq 1) ("卡片=" + $(if ($orphan) { $orphan.card } else { '?' }) + " 引文=" + $(if ($orphan) { $orphan.quote } else { '?' }) + " listCount=" + $(if ($orphan) { $orphan.listCount } else { '?' }))

Step '㊸ 删批注：真实鼠标点 `[data-anno-del]` → 卡片消失'
$delPt = EvalJson @"
(async()=>{
$H2
  const b=bySel('[data-anno-del]');
  return JSON.stringify({pt:b?centerOf(b):null});
})()
"@
Write-Host (ClickCoords $delPt.pt '批注上的「删掉」')
Start-Sleep -Milliseconds 1400
$deleted = EvalJson @"
(async()=>{
$H2
  const annos=await inv('anno_list');
  return JSON.stringify({cards:document.querySelectorAll('[data-anno-card]').length, listCount:annos.length,
    empty:!!bySel('[data-anno-empty]')});
})()
"@
Write-Host ("  删完：" + ($deleted | ConvertTo-Json -Compress))
Check '㊸ ★ 点「删掉」→ 卡片消失、`anno_list` 回到开工时的条数、回到空状态' ($deleted -and [int]$deleted.cards -eq 0 -and [int]$deleted.listCount -eq $annoForeign -and $deleted.empty) ($deleted | ConvertTo-Json -Compress)
$disk2 = $null
if (Test-Path $annoFile) { try { $disk2 = (Get-Content $annoFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $disk2 = $null } }
Check '㊹ 盘上的 `annotations.json` 也跟着少了一条（自己造的批注清干净，只剩开工就有的那些）' ($disk2 -and @($disk2.items).Count -eq $annoForeign) ("items=" + $(if ($disk2) { @($disk2.items).Count } else { '?' }) + " / 开工 " + $annoForeign)

# ═════════════════════════ §3 开关：关掉就没有批注页签 ═════════════════════════
Write-Host ""
Write-Host "=== §3 「启用档案区」开关（关掉就没有批注页签 —— 单独验）==="

Step '㊺ 真实鼠标点设置页开关 → 关掉'
$closeIt = EvalJson @"
(async()=>{
$H2
  await goPage('设置');
  // ⚠️ M15 起开关藏在「那行小字」后面：先点开再找 toggle（㉒/㊺ 这两格重挂过页面，状态丢了）
  { const rv=bySel('[data-archive-reveal]'); if(rv){ rv.click(); await sl(600); } }
  let t=bySel('[data-archive-toggle]');
  for(let i=0;i<20 && !t;i++){ await sl(300); t=bySel('[data-archive-toggle]'); }
  return JSON.stringify({pt:t?centerOf(t):null, checked:t?t.checked:null});
})()
"@
Write-Host (ClickCoords $closeIt.pt '「启用档案区」开关')
Start-Sleep -Milliseconds 1200
$closed = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  const t=bySel('[data-archive-toggle]');
  return JSON.stringify({enabled:cfg.archive.enabled, checked:t?t.checked:null});
})()
"@
Write-Host ("  关掉后：" + ($closed | ConvertTo-Json -Compress))
Check '㊺ ★ 真实鼠标点开关 → `archive.enabled` = false，checkbox 也取消勾选' ($closed -and $closed.enabled -eq $false -and $closed.checked -eq $false) ($closed | ConvertTo-Json -Compress)

Step '㊻ ★ 关着的时候，右侧边栏**没有**批注页签（目录页签照旧）'
$off = EvalJson @"
(async()=>{
$H2
  await goPage('认知区');
  let row=noteRow('$NID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NID'); }
  if(row) row.click();
  await sl(1600);
  await waitEditor();
  return JSON.stringify({tocTab:!!bySel('[data-side-tab="toc"]'), annoTab:!!bySel('[data-side-tab="anno"]'),
    side:!!bySel('[data-note-side]'), items:tocItems().length});
})()
"@
Write-Host ("  边栏：" + ($off | ConvertTo-Json -Compress))
Check '㊻ ★★ 开关关着 → 边栏里**没有** `[data-side-tab="anno"]`（目录页签与 3 条目录条目照旧）' ($off -and $off.side -and $off.tocTab -and $off.annoTab -eq $false -and [int]$off.items -eq 3) ($off | ConvertTo-Json -Compress)

Step '㊼ 再点开 → 批注页签回来（开关只管显示，不动数据）'
$reopen2 = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  cfg.archive.enabled=true;
  await inv('config_save',{config:cfg});
  await sl(900);
  return JSON.stringify({enabled:(await inv('config_get')).archive.enabled});
})()
"@
$tabBack = EvalJson @"
(async()=>{
$H2
  let a=bySel('[data-side-tab="anno"]');
  for(let i=0;i<20 && !a;i++){ await sl(400); a=bySel('[data-side-tab="anno"]'); }
  return JSON.stringify({annoTab:!!a, pt:a?centerOf(a):null, empty:!!bySel('[data-anno-empty]')});
})()
"@
Write-Host ("  打开后：" + ($reopen2 | ConvertTo-Json -Compress) + " 边栏：" + ($tabBack | ConvertTo-Json -Compress))
Check '㊼ ★ 开关再打开 → 批注页签立刻回来（不用重启）' ($reopen2.enabled -eq $true -and $tabBack -and $tabBack.annoTab) ($tabBack | ConvertTo-Json -Compress)

# ═════════════════════════ §4 命令语义 ═════════════════════════
Write-Host ""
Write-Host "=== §4 批注命令语义（anno_list / anno_create / anno_set / anno_delete）==="

Step '㊽ 直接调命令：create → set → delete（验证四条命令的语义，收尾自己清掉）'
$cmd = EvalJson @"
(async()=>{
$H2
  const list0=await inv('anno_list');
  const made=await inv('anno_create',{noteId:'$NID', quote:'命令级测试原句。', prefix:'', suffix:'', hash:'deadbeef', text:'命令造的批注'});
  await sl(600);
  const list1=await inv('anno_list');
  const one=list1.filter(a=>a.id===made.id);
  const set=await inv('anno_set',{id:made.id, text:'命令改过的批注'});
  const list2=await inv('anno_list');
  const two=list2.filter(a=>a.id===made.id);
  const del=await inv('anno_delete',{id:made.id});
  await sl(600);
  const list3=await inv('anno_list');
  return JSON.stringify({n0:list0.length, madeId:!!made.id, quote:one.length?one[0].quote:null, hash:one.length?one[0].hash:null,
    setText:set.text, changed:two.length?two[0].text:null, changedQuote:two.length?two[0].quote:null,
    del:del, left:list3.filter(a=>a.id===made.id).length, n3:list3.length,
    raw:list3.map(a=>({id:a.id,noteId:a.noteId,text:a.text,quote:a.quote,prefix:a.prefix,suffix:a.suffix,hash:a.hash}))});
})()
"@
Write-Host ("  命令级：" + ($cmd | ConvertTo-Json -Compress))
Check '㊽ ★ `anno_create(noteId, quote, prefix, suffix, hash, text)` 落成一条（id 有、quote/hash 原样存着）' ($cmd -and $cmd.madeId -and $cmd.quote -eq '命令级测试原句。' -and $cmd.hash -eq 'deadbeef' -and [int]$cmd.n0 -eq $annoForeign) ($cmd | ConvertTo-Json -Compress)
Check '㊾ ★ `anno_set(id, text)` 只改正文（text 变了、quote/hash 没动）' ($cmd -and $cmd.setText -eq '命令改过的批注' -and $cmd.changed -eq '命令改过的批注' -and $cmd.changedQuote -eq '命令级测试原句。') ($cmd | ConvertTo-Json -Compress)
Check '50 ★ `anno_delete(id)` 返回 true 且那条真没了（`anno_list` 回到开工时的条数）' ($cmd -and $cmd.del -eq $true -and [int]$cmd.left -eq 0 -and [int]$cmd.n3 -eq $annoForeign) ($cmd | ConvertTo-Json -Compress)

# ═════════════════════════ §5 收尾 ═════════════════════════
Write-Host ""
Write-Host "=== §5 收尾（删净自己的东西 + 开关还原 + 用户数据逐条核对）==="

Step '51 删掉自己造的笔记与批注，开关还原成开工时的值'
$fix = EvalJson @"
(async()=>{
$H2
  const mine=(await inv('note_list')).filter(n=>/^M14 /.test(n.title||''));
  const ids=mine.map(n=>n.id);
  for(const a of await inv('anno_list')){ if(ids.indexOf(a.noteId)>=0){ try{ await inv('anno_delete',{id:a.id}); }catch(e){} } }
  for(const n of mine){ try{ await inv('note_delete',{id:n.id}); }catch(e){} }
  const cfg=await inv('config_get');
  cfg.archive.enabled=$($origArchive.ToString().ToLower());
  await inv('config_save',{config:cfg});
  await sl(1300);
  const back=await inv('config_get');
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const annos=await inv('anno_list');
  return JSON.stringify({leftNotes:notes.filter(n=>/^M14 /.test(n.title||'')).map(n=>n.title),
    archive:back.archive.enabled, annosAll:annos.length,
    users:todos.map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length})),
    notes:notes.map(n=>({id:n.id,title:n.title,kind:n.kind,content:n.content})),
    cfgAll:{theme:back.theme, uiFont:back.uiFont, bodyFont:back.bodyFont, fontSize:back.fontSize, backupKeep:back.backupKeep,
      shortcuts:back.shortcuts, reminders:back.reminders, homeSticky:back.homeSticky,
      window:{smallPosition:back.window.smallPosition, smallMouseOffset:back.window.smallMouseOffset, closeToTray:back.window.closeToTray}}});
})()
"@
Write-Host ("  收尾：" + ($fix | ConvertTo-Json -Compress -Depth 5))
Check '51 ★ 自己造的 `M14 ` 笔记清干净了（一条不剩）' ($fix -and @($fix.leftNotes).Count -eq 0) ("剩下 " + (@($fix.leftNotes) -join ' / '))
Check '52 ★ `archive.enabled` 还原成开工时的值并读回来确认' ($fix -and "$($fix.archive)" -eq "$origArchive") ("读回来 " + $(if ($fix) { $fix.archive } else { '?' }) + " / 开工 " + $origArchive)
Check '53 ★ 自己造的批注一条不剩（`anno_list` 回到开工时的条数）' ($fix -and [int]$fix.annosAll -eq $annoForeign) ("批注 " + $(if ($fix) { $fix.annosAll } else { '?' }) + " 条 / 开工 " + $annoForeign)
$endCfg = ($fix.cfgAll | ConvertTo-Json -Depth 8 -Compress)
Check '54 别的设置（主题 / 字号 / 快捷键 / 提醒 / 首页卡片 / 小窗那几项）与开工时一模一样' ($fix -and $baseCfg -eq $endCfg -and [bool]$endCfg) ("开工 " + $baseCfg)
$uBase = (@($usersBase) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)" }) -join ' ; '
$uEnd = (@($fix.users) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)" }) -join ' ; '
Check ('55 ★★ 你的 ' + $usersBase.Count + ' 条待办一条没动（逐条按 id + 标题 + 状态 + 番茄数核对）') ($fix -and $uBase -eq $uEnd -and $usersBase.Count -eq @($fix.users).Count) ("开工 " + $usersBase.Count + " 条 / 收尾 " + @($fix.users).Count + " 条")
$nBase = (@($notesBase) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.kind)|$($_.content)" }) -join ' ; '
$nEnd = (@($fix.notes) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.kind)|$($_.content)" }) -join ' ; '
Check ('56 ★★ 你的 ' + $notesBase.Count + ' 篇笔记一条没动（逐条按 id + 标题 + 类型 + 正文逐字核对 —— 你原来那篇文档笔记也没被目录/批注碰过）') ($fix -and $nBase -eq $nEnd -and $notesBase.Count -eq @($fix.notes).Count) ("开工 " + $notesBase.Count + " 篇 / 收尾 " + @($fix.notes).Count + " 篇")

Step '57 回收站里自己那张测试笔记的留档也清掉（只删 `M14 ` 前缀的）'
$trashDir = Join-Path $DATA 'notes\_trash'
$trashMine = @()
if (Test-Path $trashDir) {
  Get-ChildItem $trashDir -Filter '*.json' | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $raw = Get-Content $_.FullName -Raw -Encoding UTF8
    $t = ''
    try { $t = ($raw | ConvertFrom-Json).title } catch { }
    if ("$t" -like 'M14 *') {
      $trashMine += $t
      Remove-Item $_.FullName -Force
      if (Test-Path "$($_.FullName).bak") { Remove-Item "$($_.FullName).bak" -Force -ErrorAction SilentlyContinue }
    }
  }
}
Write-Host ("  回收站里清掉自己的：" + $(if (@($trashMine).Count) { (@($trashMine) -join ' / ') } else { '(无)' }))
$trashLeft = @()
if (Test-Path $trashDir) {
  Get-ChildItem $trashDir -Filter '*.json' | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $raw = Get-Content $_.FullName -Raw -Encoding UTF8
    $t = ''
    try { $t = ($raw | ConvertFrom-Json).title } catch { }
    if ("$t" -like 'M14 *') { $trashLeft += $t }
  }
}
Check '57 ★ 回收站里没留下 `M14 ` 前缀的测试笔记（用户自己删进回收站的照旧一条不动）' (@($trashLeft).Count -eq 0) ("还剩 " + (@($trashLeft) -join ' / '))

Write-Host ""
Write-Host "======================"
Write-Host ("M14 认知区增强（A 目录语法 + B 批注栏 + 档案区开关）：通过 " + $pass + "，失败 " + $fail)
if ($fail -gt 0) { exit 1 }
