# M15 · 隐藏档案库验收（第七个区，**平时没有入口**）
#
# 覆盖（对应用户点名的那 9 条必验）：
#   §1 【必验①★★】默认没有入口 —— 设置里**只有** `[data-archive-reveal]` 那行小字（**没有**
#      `[data-archive-toggle]`）、侧栏**找不到**「档案库」、三个「收进档案库」入口一个都不出现；
#   §2 【必验②★】启用链路 —— 真实鼠标点那行小字 → 开关出现 → 真实鼠标点开关 →
#      `config_get` 里 `archive.enabled=true` + **侧栏出现「档案库」** → **重开页面后还在**；
#   §3 【必验③★】收进去 —— 造 `M15 ` 待办 / 信息 / 笔记各一条 → 各自的入口收进档案库 →
#      原位列表里**真的没了**（`todo_list` / `info_list` / `note_list` 查不到）+ 档案卡出现
#      （笔记那条还核对 `notes/_archive/<id>.json` 真存在）；
#   §4 【必验④★】撤销 —— 再收一条 → 真实鼠标点 toast 上的 `[data-toast-action]` →
#      东西回到原位、档案库里没了；
#   §5 【必验⑤★★】取出字段逐项复原（计划里点名的风险）—— 三种来源各取出一次，**逐字段比**：
#      信息 `categories` / `createdAt` / **id 原样**；笔记**正文逐字相同** + `group` / 标题；
#      待办 **`pomodoros` 一条不少**、`subtasks`、`quadrant`、`plannedAt` / `dueAt`、`status`、**id 原样**；
#   §6 【必验⑧】收纳笔记不再冤标待办 —— 收一篇带 `-[]` 待办的笔记 → 那条待办的
#      `source.sourceRemoved` **必须还是 false**；取出后仍正常；
#   §7 【必验⑥★】库里能直接改 —— 点「看看」→ 改标题 + 改正文 → 点「存下」→
#      **关页面重开还在**；笔记那条同时核对 `notes/_archive/<id>.json` 里正文真的变了；
#   §8 【必验⑦】彻底删掉 —— 二次确认 → 删掉 → `backups/` 里**新写**了一份「档案-删除前」
#      （判据是"有没有新写的"，**不数份数**）；
#   §9 【必验⑨】收尾 —— `archive.enabled` **还原成开工前的值**、删净 `M15 ` 测试数据、
#      **用户的 7 条待办 / 4 篇笔记逐条核对没动**（一律用 `/^M15 /` 过滤，不拿总数硬断言）。
#
# 🔴 三条铁规矩（跟 tools\ 里其它脚本一致）：
#   ① **只动自己造的**（`M15 ` 前缀的待办 / 信息 / 笔记 + 档案里挂在这些上面的条目），
#      用户的东西一个字不动；
#   ② 手势一律走**真实输入**：鼠标 `cdp.ps1 -Action mouse`、键盘 `-Action type`（CDP 的
#      `Input.insertText`，走浏览器输入管线、会真的触发 React onChange）——
#      合成 `dispatchEvent` 会绕过命中测试，给假绿灯（M4 栽过）；
#   ③ 每一步**都先清场**：`fixed inset-0` 那层弹窗会吃掉所有真实鼠标点击（M13 的教训），
#      收尾也一定**再关一次弹窗**。
#
# ⚠️ 三处"真机行为"（实测/读码得到，不是脚本绕路）：
#   ① 「那行小字」（`[data-archive-reveal]`）是**组件局部 state**，初值是 `config.archive.enabled`
#      —— 想验"开工只有小字"，得**先切走别的页再切回设置**强制重挂，否则读到的是上一轮留下的展开态；
#   ② ⚠️ `[data-archive-toggle]` 这个钩子**在待办页也有一份**（M9-4「已完成」折叠区，见
#      `TodoPage.tsx` 575~586）—— 所以本脚本**只在设置页**读它，切页之后一律重新取；
#   ③ 笔记那条档案在磁盘上有**两份**（`archive.json` 的快照 + `notes/_archive/<id>.json`），
#      改正文两边都要动 —— 所以"重开还在"之外还额外核对盘上那个文件。
#
# ⚠️ **本条没验、且故意不验的一件事**（写清楚免得以为漏了）：
#   `todo_purge_removed`（界面上的「清理」）会先跑 `mark_orphans_removed` 对账再**真删**
#   —— M15 修的正是那个对账函数（把"收进档案库的笔记"也算"还在"）。但用户现有数据里
#   **本来就有一条 `sourceRemoved=true` 的待办**（`1高数复习，紧`），一跑它就**当场删用户的待办**。
#   所以本脚本**绝不调用它**，只验"收纳前 / 收纳后 / 取出后 `sourceRemoved` 都是 false"
#   这条能在真机上安全观察到的部分；对账函数本身留给 Rust 单测（那里有 temp_store，不碰真数据）。
#
# 用法（应用要以 CDP 9222 起着）：
#   powershell -ExecutionPolicy Bypass -File tools\m15\run.ps1
param([int]$Port = 9222, [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'
$DATA = 'D:\东方摩耶堂'
$MAIN = '东方摩耶堂'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m15-" + [guid]::NewGuid().ToString("N") + ".js")
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
  $tmp = Join-Path $env:TEMP ("m15f-" + [guid]::NewGuid().ToString("N") + ".js")
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
# ⚠️ `<input>` / `<textarea>` 先聚焦 + 全选，这样 insertText 是**替换**而不是往后面追加（M13-C 的教训）。
# ⚠️ **别把带 `"` 的 CSS 选择器穿过 `powershell -File`**（引号会被吃掉）—— 所以档案库里那些
#    `[data-archive-edit-title="<id>"]` 一律用**不带引号的属性存在选择器** `[data-archive-edit-title]`
#    （详情面板同时只开一个，不带 id 也唯一）。
function TypeInto([string]$selector, [string]$text) {
  $tmp = Join-Path $env:TEMP ("m15t-" + [guid]::NewGuid().ToString("N") + ".js")
  $js = "(function(){var el=document.querySelector('" + $selector + "'); if(!el) return 'NOT_FOUND'; if(el.setSelectionRange){ el.focus(); el.setSelectionRange(0,(el.value||'').length); return 'SELECTED:'+(el.value||'').length; } return 'AS_IS';})()"
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $picked = (& powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  $done = (& powershell -NoProfile -File $cdp -Action type -Selector $selector -Text $text -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  return ($picked + " | " + ($done -replace '\s+', ' '))
}

# 真实键盘往 **CodeMirror 正文区**打字（2026-10-11 · P3 返工后新加的）。
# 为什么不能复用 `TypeInto`：它靠 `el.setSelectionRange()` —— 那是 `<input>`/`<textarea>` 才有的 API，
# CodeMirror 的正文是 contenteditable，调它直接报错。
# 做法：先 focus 编辑区 + 用 DOM Selection **全选**，再走 `cdp -Action type`（CDP `Input.insertText`
# 会**替换**当前选区）→ 于是这是"整篇重写"，跟以前 textarea 那套语义一样。
# ⚠️ 这条机制是**实测**过的（`.spike\m15probe-body.ps1`）：这么打进去的字真的进 CodeMirror，
#    点「存下」之后盘上 `notes/_archive/<id>.json` 的 content 与打进去的字**逐字相同**。
function TypeIntoEditor([string]$selector, [string]$text) {
  $tmp = Join-Path $env:TEMP ("m15e-" + [guid]::NewGuid().ToString("N") + ".js")
  $js = "(function(){var el=document.querySelector('" + $selector + "'); if(!el) return 'NOT_FOUND'; var cm=el.querySelector('.cm-content')||el; cm.focus(); var s=window.getSelection(); var r=document.createRange(); r.selectNodeContents(cm); s.removeAllRanges(); s.addRange(r); return 'SELECTED:'+String(s).length;})()"
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $picked = (& powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  $done = (& powershell -NoProfile -File $cdp -Action type -Selector ($selector + ' .cm-content') -Text $text -Port $Port -TargetTitle $MAIN -RequireSelector 'nav' 2>&1 | Out-String).Trim()
  return ($picked + " | " + ($done -replace '\s+', ' '))
}

# 比正文用的归一化：去掉 `\r`、并把**每一行的行尾空格**剪掉。
# 为什么允许剪行尾空格：DOM 读回来的文字里，行尾空格可能被浏览器吃掉（`white-space` 那点事），
# 而**盘上那份是逐字卡着的**（#40 就是干这个的，一个字都不许差）。
# 所以"界面里显示的是不是原来那篇"用归一化比，"存下去有没有走样"用盘上逐字比 —— 两件事分开管。
function NormBody($text) {
  if ($null -eq $text) { return '' }
  $lines = ("$text" -replace "`r", '') -split "`n"
  return (($lines | ForEach-Object { $_.TrimEnd() }) -join "`n")
}

# 整页重载 + 等页面回来（"关页面重开"那几条用它）
function ReloadAndWait([int]$WaitMs = 8000) {
  EvalJson "(async()=>{ setTimeout(()=>location.reload(),300); return JSON.stringify({reloading:true}); })()" | Out-Null
  Start-Sleep -Milliseconds $WaitMs
  return (EvalInRetry $MAIN 'nav' "(async()=>{ const sl=t=>new Promise(r=>setTimeout(r,t)); for(let i=0;i<40;i++){ if(document.querySelector('nav button')) return 'READY'; await sl(400);} return 'NOT_READY'; })()")
}

$H = @'
const sl=t=>new Promise(r=>setTimeout(r,t));
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
const bySel=(s)=>document.querySelector(s);
'@

$H2 = $H + @'
const centerOf=(el)=>{ if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2)}; };
const navBtn=(w)=>Array.from(document.querySelectorAll('nav button')).find(b=>(b.innerText||'').indexOf(w)>=0);
const navHas=(w)=>!!navBtn(w);
const goPage=async(word)=>{ let n=null; const B=()=>Array.from(document.querySelectorAll('nav button')); for(let i=0;i<20&&!n;i++){ n=B().find(b=>(b.innerText||'').indexOf(word)>=0); if(!n) await sl(300);} if(n){ n.click(); await sl(1500);} return !!n; };
// `fixed inset-0` 那层弹窗会吃掉真实鼠标点击 → 每一步开工/收工都拿 Escape 清干净
const closeDialogs=async()=>{ for(let i=0;i<5 && bySel('[role="dialog"]');i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);} return document.querySelectorAll('[role="dialog"]').length; };
const noteRow=(id)=>bySel('[data-note-open="'+id+'"]');
// 用户可能把「认知区分组默认收起」开着（配置 `collapse-grouped`）：要点的探针笔记
// 会被整组藏起来。这里只在找不到行时展开各分组，绝不改配置。
const ensureNoteRow=async(id)=>{
  const opener=bySel('[data-cog-list-toggle="open"]');
  if(opener){ opener.click(); await sl(350); }
  let row=noteRow(id);
  if(row) return row;
  const groups=Array.from(document.querySelectorAll('[data-group-toggle]'));
  for(const group of groups){
    group.click();
    await sl(250);
    row=noteRow(id);
    if(row) return row;
  }
  return row;
};
const waitEditor=async()=>{ for(let i=0;i<25;i++){ if(bySel('.cm-content')) return true; await sl(400);} return false; };
const archCard=(id)=>bySel('[data-archive-card="'+id+'"]');
const archKind=(id)=>{ const c=archCard(id); return c?c.getAttribute('data-archive-kind'):null; };
const archIds=()=>Array.from(document.querySelectorAll('[data-archive-card]')).map(e=>e.getAttribute('data-archive-card'));
const archKinds=()=>Array.from(document.querySelectorAll('[data-archive-card]')).map(e=>e.getAttribute('data-archive-card')+'='+e.getAttribute('data-archive-kind'));
const archCount=()=>{ const e=bySel('[data-archive-count]'); return e?e.getAttribute('data-archive-count'):null; };
const infoArchive=(id)=>bySel('[data-info-archive="'+id+'"]');
const noteArchive=(id)=>bySel('[data-note-archive="'+id+'"]');
const todoArchive=(id)=>bySel('[data-todo-archive="'+id+'"]');
const todoGear=(id)=>bySel('[data-todo-gear="'+id+'"]');
const todoCard=(id)=>bySel('[data-todo-id="'+id+'"]');
// 设置页那行小字 / 开关（**只在设置页读** —— 待办页的 M9「已完成」也用 data-archive-toggle）
const setPage=async()=>{ await goPage('首页'); await goPage('设置'); await sl(400); };
const revealEl=()=>bySel('[data-archive-reveal]');
const toggleEl=()=>bySel('[data-archive-toggle]');
const toastAction=()=>bySel('[data-toast-action]');
const waitEl=async(sel,rounds)=>{ for(let i=0;i<(rounds||20);i++){ const e=bySel(sel); if(e) return e; await sl(300);} return null; };
// 🔴 「只量坐标、**绝不滚动**」版 —— 浮动菜单（`FloatingMenu`，portal + fixed）**一滚动就自己关**，
//    所以轮到要点菜单里的东西时，**不能**用 `centerOf`（它先 scrollIntoView，菜单当场没了）。
//    正确顺序：**先**把那一行滚进视野 → 再开菜单 → 再用这个量坐标。
//    （2026-10-11 实测：§11 那条笔记没分组、排在列表最下面，`.cm-line` 那套都对了，
//      就是这一下把菜单滚没了 → `gone:false`、没有 toast，红了一条 #22。）
const centerNoScroll=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2)}; };
// 🔴 2026-10-11（P3 档案区返工）：档案库从"一摞卡片"改成**左列表 ＋ 右编辑面板**。
//   ⇒ 左边每一行还是 `[data-archive-card="<id>"]`（标题/来源/日期也在它身上），
//     但**面板里的抓手（取出 / 彻底删掉 / 存下 / 标题框 / 正文区）只对"选中的那一条"渲染**。
//   ⇒ 所以凡是要点面板里的东西，**必须先点一下左边那一行**（`pickArch` 就是干这个的）。
const pickArch=async(id)=>{ let r=null; for(let i=0;i<25&&!r;i++){ r=bySel('[data-archive-card="'+id+'"]'); if(!r) await sl(400);} if(r){ r.click(); await sl(1000);} return !!r; };
// 正文现在是 CodeMirror（不再是 textarea）→ 读它得**按行拼回来**：
// CodeMirror 一行一个 `.cm-line` div，按 `\n` 接起来正好是那篇正文。
// ⚠️ 别用 `.cm-content` 的 `innerText`：那是"块级元素之间加换行"，**空行会多出一倍**
//    （实测 `\n\n` 读回来变 `\n\n\n` —— 2026-10-11 就为这个红了一条 #37）。
const archBody=()=>{ const e=bySel('[data-archive-edit-body]'); if(!e) return null; const c=e.querySelector('.cm-content'); if(!c) return null; return Array.from(c.querySelectorAll('.cm-line')).map(x=>x.textContent).join('\n'); };
// 🔴 档案库这一页**只在挂载时读一次盘**（它不广播 data-changed、也不监听）——
//   所以"刚收进去的东西出现了没"必须**先离开这一页再回来**。`goPage('档案库')` 在人已经
//   站在这页上时点的是同一个 nav 按钮、**不会重新挂载** → 列表还是旧的（2026-10-11 实测踩到，
//   原来 6 条红里有 3 条就是这个）。
const bounceArch=async()=>{ await goPage('首页'); await sl(400); await goPage('档案库'); await sl(1200); };
'@

# ═════════════════════════ 测试数据 ═════════════════════════
$TODO_TITLE = 'M15 待办-取出逐字段'
$INFO_TEXT = "M15 信息-取出逐字段`n第二行也要原样回来"
$INFO_CAT = '主动冒出·突然想起'
$NOTE_TITLE = 'M15 笔记-取出正文逐字'
$NOTE_GROUP = 'M15分组'
$MARK_TEXT = 'M15 从笔记来的待办'
$NOTE_CONTENT = "# M15 标题`n`n-[]$MARK_TEXT`n`n第二段：标点，句号。  `n"
$UNDO_TEXT = 'M15 撤销信息-收了再撤回'
$NOTE_NEW_TITLE = 'M15 改过的笔记标题'
$NOTE_NEW_BODY = 'M15 改过的正文：这一行是重写的。'
$PLANNED = '2026-10-05T09:30:00+08:00'
$DUE = '2026-10-09T18:00:00+08:00'

$INFO_JSON = ($INFO_TEXT | ConvertTo-Json -Compress)
$NOTE_JSON = ($NOTE_CONTENT | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "=== M15 隐藏档案库（默认没入口 → 启用 → 收/取/改/删）==="

# ═════════════════════════ §0 清场 + 基线 ═════════════════════════
Step '⓪ 开场先清场（上一轮残留的弹窗 / 残留 `M15 ` 数据）+ 记基线 + 开关归零'

$pre = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  // 只清自己前缀的：档案条目 → 待办 / 信息 / 笔记（顺序：先把档案里的删掉，再清原位）
  const mineArch=(await inv('archive_list')).filter(a=>/^M15 /.test(a.title||''));
  for(const a of mineArch){ try{ await inv('archive_delete',{id:a.id}); }catch(e){} }
  const mineTodos=(await inv('todo_list')).filter(t=>/^M15 /.test(t.title||''));
  for(const t of mineTodos){ try{ await inv('todo_delete',{id:t.id}); }catch(e){} }
  const mineInfos=(await inv('info_list')).filter(i=>/^M15 /.test(i.text||''));
  for(const i of mineInfos){ try{ await inv('info_delete',{id:i.id}); }catch(e){} }
  const mineNotes=(await inv('note_list')).filter(n=>/^M15 /.test(n.title||''));
  for(const n of mineNotes){ try{ await inv('note_delete',{id:n.id}); }catch(e){} }
  await sl(1200);
  await closeDialogs();
  // 🔴 开工归零：上一轮要是崩在收尾之前，开关会留在"开"的状态 —— 不归零，
  //    §1「开工只有那行小字」和后面每一条入口断言都会被带成假红。
  const cfg=await inv('config_get');
  // 🔴 2026-10-21：**记住用户开工前的值** —— 以前这里无脑归零、收尾也无脑关成 false，
  //    用户本来是开着的，跑一趟套件就被关掉了。现在收尾按这个值还原。
  const archiveBefore=!!(cfg.archive&&cfg.archive.enabled);
  let reset=false;
  if(cfg.archive && cfg.archive.enabled){
    await inv('config_save',{config:Object.assign({},cfg,{archive:{enabled:false}})});
    reset=true; await sl(700);
  }
  const notes=await inv('note_list'); const todos=await inv('todo_list');
  const infos=await inv('info_list'); const arch=await inv('archive_list');
  const cfg2=await inv('config_get');
  return JSON.stringify({reset:reset, dialogs:await closeDialogs(), archiveBefore:archiveBefore,
    leftArch:arch.filter(a=>/^M15 /.test(a.title||'')).length,
    leftTodos:todos.filter(t=>/^M15 /.test(t.title||'')).length,
    leftInfos:infos.filter(i=>/^M15 /.test(i.text||'')).length,
    leftNotes:notes.filter(n=>/^M15 /.test(n.title||'')).length,
    enabled:cfg2.archive.enabled, archAll:arch.length,
    users:todos.filter(t=>!/^M15 /.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length,rm:!!(t.source&&t.source.sourceRemoved)})),
    notes:notes.filter(n=>!/^M15 /.test(n.title||'')).map(n=>({id:n.id,title:n.title,kind:n.kind,group:n.group,content:n.content})),
    infos:infos.filter(i=>!/^M15 /.test(i.text||'')).map(i=>({id:i.id,text:i.text})),
    cfgAll:{theme:cfg2.theme, uiFont:cfg2.uiFont, bodyFont:cfg2.bodyFont, fontSize:cfg2.fontSize, backupKeep:cfg2.backupKeep,
      shortcuts:cfg2.shortcuts, reminders:cfg2.reminders, homeSticky:cfg2.homeSticky,
      window:{smallPosition:cfg2.window.smallPosition, smallMouseOffset:cfg2.window.smallMouseOffset, closeToTray:cfg2.window.closeToTray}}});
})()
"@
Write-Host ("  清场 + 基线：" + ($pre | ConvertTo-Json -Compress -Depth 5))
# 🔴 2026-10-21：开工前的「启用档案区」值 —— 收尾按它还原（不再无脑关成 false）
$archBefore = [bool]$pre.archiveBefore
# 兜底扫一遍：上一轮要是崩在收尾之前，`notes/_archive/` 里可能留下**没有档案条目**的孤儿文件
# （档案条目被删了、文件还在）。只认 `M15 ` 前缀的标题，用户的东西一个不碰。
$orphanDir = Join-Path $DATA 'notes\_archive'
$orphanGone = @()
if (Test-Path $orphanDir) {
  Get-ChildItem $orphanDir -Filter '*.json' -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $t = ''
    try { $t = ((Get-Content $_.FullName -Raw -Encoding UTF8) | ConvertFrom-Json).title } catch { }
    if ("$t" -like 'M15 *') {
      $orphanGone += $t
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      if (Test-Path "$($_.FullName).bak") { Remove-Item "$($_.FullName).bak" -Force -ErrorAction SilentlyContinue }
    }
  }
}
if (@($orphanGone).Count) { Write-Host ("  notes\_archive\ 里的孤儿清掉：" + (@($orphanGone) -join ' / ')) }
Check '#01 ★ 开场是干净的（没残留弹窗、没有上一轮留下的 `M15 ` 待办 / 信息 / 笔记 / 档案）' ($pre -and [int]$pre.dialogs -eq 0 -and [int]$pre.leftArch -eq 0 -and [int]$pre.leftTodos -eq 0 -and [int]$pre.leftInfos -eq 0 -and [int]$pre.leftNotes -eq 0) ("dialogs=" + $(if ($pre) { $pre.dialogs } else { '?' }) + " 残留 档案/待办/信息/笔记 = " + $(if ($pre) { "$($pre.leftArch)/$($pre.leftTodos)/$($pre.leftInfos)/$($pre.leftNotes)" } else { '?' }))
$usersBase = @($pre.users)
$notesBase = @($pre.notes)
$baseCfg = ($pre.cfgAll | ConvertTo-Json -Depth 8 -Compress)
# 🔴 2026-10-11（v2.19.0）：把「开工时档案库里**已经有的**条数」记下来 —— 下面所有"应该是 0 张卡 /
#    应该回到空状态"的断言一律**跟这个基线比**，不再写死 0。
#    为什么非改不可：用户 2026-10-11 13:03 自己收了一条「档案区测试」进档案库 → 这套 6 条断言
#    全部 +1 变假红（实测 **50/6**，逐条都是同一个原因）。判据要写「前后自比」，别写
#    「用户那边应该长什么样」（§五 的老规矩；`m15` 是最后一个还写死的地方）。
$archBase = if ($pre) { [int]$pre.archAll } else { 0 }
Write-Host ("  开工时档案库里**已经有的**（用户自己的，本套件不碰）：" + $archBase + " 条")
$startStamp = Get-Date
Write-Host ("  你的数据：待办 " + $usersBase.Count + " 条 / 笔记 " + $notesBase.Count + " 篇 / 信息 " + @($pre.infos).Count + " 条（收尾逐条核对）")
Check ('#02 ★ 基线记下了（' + $usersBase.Count + ' 条待办 / ' + $notesBase.Count + ' 篇笔记，逐条带 id+标题+正文）') ($pre -and $usersBase.Count -gt 0 -and $notesBase.Count -gt 0) ("待办 " + $usersBase.Count + " / 笔记 " + $notesBase.Count)
Check '#03 ★ 开工时 `archive.enabled` 是 **false**（这一步之前先归零；上一轮留下的"开"会被记账）' ($pre -and "$($pre.enabled)" -eq 'False') ("config=" + $(if ($pre) { $pre.enabled } else { '?' }) + "（本轮归零过=" + $(if ($pre) { $pre.reset } else { '?' }) + "）")
if ($pre -and $pre.reset) {
  $rdy = ReloadAndWait 7000
  Write-Host ("  归零过 → 重载一次让设置页重新读 config：" + $rdy)
}

# ═════════════════════════ §1 默认没有入口 ═════════════════════════
Write-Host ""
Write-Host "=== §1 【必验①★★】默认没有入口（只有那行小字）==="

Step '1 先造自己的三条测试数据（`M15 ` 前缀，收尾自己删）：待办（带番茄/子任务/象限/时间）+ 信息 + 笔记（带 -[] 标记）'
$made = EvalJson @"
(async()=>{
$H2
  const todo=await inv('todo_create',{title:'$TODO_TITLE'});
  await inv('todo_subtask_add',{id:todo.id, text:'第一步'});
  const two=await inv('todo_subtask_add',{id:todo.id, text:'第二步'});
  const sid=two.subtasks[1].id;
  await inv('todo_subtask_toggle',{id:todo.id, subtaskId:sid, done:true});
  await inv('todo_add_pomodoro',{id:todo.id, mode:'countdown', seconds:1500, note:'第一笔', finish:false});
  await inv('todo_set_quadrant',{id:todo.id, quadrant:'q1'});
  await inv('todo_set_planned',{id:todo.id, plannedAt:'$PLANNED'});
  await inv('todo_set_due',{id:todo.id, dueAt:'$DUE'});
  const info=await inv('info_create',{text:$INFO_JSON, categories:['$INFO_CAT']});
  const note=await inv('note_create',{title:'$NOTE_TITLE', kind:'doc', content:$NOTE_JSON});
  await inv('note_set_group',{noteId:note.id, group:'$NOTE_GROUP'});
  await sl(1800);
  const t=(await inv('todo_list')).find(x=>x.id===todo.id);
  const i=(await inv('info_list')).find(x=>x.id===info.id);
  const n=await inv('note_get',{id:note.id});
  const markers=(await inv('todo_list')).filter(x=>x.source&&x.source.noteId===note.id);
  return JSON.stringify({todoId:todo.id, infoId:info.id, noteId:note.id,
    t: t?{id:t.id,createdAt:t.createdAt,title:t.title,status:t.status,quadrant:t.quadrant,
      plannedAt:t.plannedAt,dueAt:t.dueAt,order:t.order,repeat:t.repeat,
      pomodoros:(t.pomodoros||[]).map(p=>p.mode+'|'+p.seconds+'|'+p.note),
      subtasks:(t.subtasks||[]).map(s=>s.text+'|'+s.done)}:null,
    i: i?{id:i.id,createdAt:i.createdAt,text:i.text,categories:i.categories,kind:i.kind,status:i.status,links:(i.links||[]).length}:null,
    n: n?{id:n.id,title:n.title,content:n.content,group:n.group,createdAt:n.createdAt}:null,
    markerCount:markers.length, markerId:markers.length?markers[0].id:null,
    markerRemoved:markers.length?!!(markers[0].source&&markers[0].source.sourceRemoved):null,
    markerTitle:markers.length?markers[0].title:null});
})()
"@
Write-Host ("  造好：" + ($made | ConvertTo-Json -Compress -Depth 5))
$TODO_ID = $made.todoId; $INFO_ID = $made.infoId; $NOTE_ID = $made.noteId
$tBefore = $made.t; $iBefore = $made.i; $nBefore = $made.n
Check '#04 ★ 待办造好且字段齐（1 笔番茄 / 2 条子任务（第二条已勾）/ q1 / plannedAt / dueAt）' ($made -and $made.t -and @($made.t.pomodoros).Count -eq 1 -and @($made.t.subtasks).Count -eq 2 -and $made.t.quadrant -eq 'q1' -and $made.t.plannedAt -and $made.t.dueAt) ("象限=" + $(if ($made) { $made.t.quadrant } else { '?' }) + " 番茄=" + $(if ($made) { @($made.t.pomodoros).Count } else { '?' }) + " 子任务=" + $(if ($made) { @($made.t.subtasks).Count } else { '?' }))
Check '#05 ★ 信息造好（分类 1 个、正文两行逐字回来）、笔记造好（正文逐字 + 分组 + 里面那行 `-[]` 生出一条待办）' ($made -and $made.i -and @($made.i.categories).Count -eq 1 -and @($made.i.text -split "`n").Count -eq 2 -and $made.n -and $made.n.content -eq $NOTE_CONTENT -and $made.n.group -eq $NOTE_GROUP -and [int]$made.markerCount -eq 1 -and $made.markerTitle -eq $MARK_TEXT) ("info 分类=" + $(if ($made) { @($made.i.categories).Count } else { '?' }) + " info 行数=" + $(if ($made) { @($made.i.text -split "`n").Count } else { '?' }) + " note 正文相同=" + $(if ($made) { $made.n.content -eq $NOTE_CONTENT } else { '?' }) + " note 分组=" + $(if ($made) { $made.n.group } else { '?' }) + " 标记待办=" + $(if ($made) { $made.markerCount } else { '?' }))

Step '2 ★★ 设置里**只有**那行小字：`[data-settings-archive]` 在、`[data-archive-reveal]` 在、**`[data-archive-toggle]` 不在**'
$dflt = EvalJson @"
(async()=>{
$H2
  await setPage();
  const card=bySel('[data-settings-archive]');
  const rev=revealEl();
  return JSON.stringify({card:!!card, reveal:!!rev, revealText:rev?(rev.innerText||'').replace(/\s+/g,' ').slice(0,60):null,
    toggle:!!toggleEl(), checked:toggleEl()?toggleEl().checked:null,
    navArchive:navHas('档案库'), navLabels:Array.from(document.querySelectorAll('nav button')).map(b=>(b.innerText||'').replace(/\s+/g,'')).join('/')});
})()
"@
Write-Host ("  设置页：" + ($dflt | ConvertTo-Json -Compress))
Check '#06 ★ 设置页有 `[data-settings-archive]` 卡片 + 那行小字 `[data-archive-reveal]`（文字里写着"想启用的话点这行字"）' ($dflt -and $dflt.card -and $dflt.reveal -and ("$($dflt.revealText)" -like '*遗忘*')) ("reveal=" + $(if ($dflt) { $dflt.revealText } else { '?' }))
Check '#07 ★★ 开关**没出现**：`[data-archive-toggle]` 在设置页上不存在（"不仔细找就无法启用"）' ($dflt -and $dflt.toggle -eq $false) ("toggle=" + $(if ($dflt) { $dflt.toggle } else { '?' }))
Check '#08 ★★ 侧栏**找不到**「档案库」（七个入口里没有它）' ($dflt -and $dflt.navArchive -eq $false) ("侧栏=" + $(if ($dflt) { $dflt.navLabels } else { '?' }))

Step '3 ★ 「收进档案库」的入口：**信息 / 待办那两颗已按用户要求永久去掉**（2026-10-11 v2.21.1）；**笔记那颗**在启用前不许出现'
$gate = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  // ① 待办：真实鼠标点 ⚙ 打开设置弹窗 → 里面不该有「收进档案库」
  await goPage('执行区');
  let gear=todoGear('$TODO_ID');
  for(let i=0;i<20 && !gear;i++){ await sl(400); gear=todoGear('$TODO_ID'); }
  const gearPt=gear?centerOf(gear):null;
  return JSON.stringify({gearCard:!!todoCard('$TODO_ID'), gearPt:gearPt});
})()
"@
Write-Host ("  待办页：" + ($gate | ConvertTo-Json -Compress))
Write-Host (ClickCoords $gate.gearPt '待办的 ⚙')
Start-Sleep -Milliseconds 1200
$gateTodo = EvalJson @"
(async()=>{
$H2
  const modal=await waitEl('[role="dialog"]',15);
  const out={modal:!!modal, archive:!!todoArchive('$TODO_ID')};
  await closeDialogs();
  return JSON.stringify(out);
})()
"@
Write-Host ("  待办 ⚙ 里：" + ($gateTodo | ConvertTo-Json -Compress))
Check '#09 ★ 待办的 ⚙ 弹窗打开了，但里面**没有** `[data-todo-archive]`（⚠️ 那颗已按用户要求永久去掉，2026-10-11 v2.21.1）' ($gate -and $gate.gearCard -and $gateTodo -and $gateTodo.modal -and $gateTodo.archive -eq $false) ($gateTodo | ConvertTo-Json -Compress)

$gateNote = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await goPage('认知区');
  let row=await ensureNoteRow('$NOTE_ID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NOTE_ID'); }
  return JSON.stringify({row:!!row, pt:row?centerOf(row):null});
})()
"@
Write-Host (ClickCoords $gateNote.pt '笔记列表行')
Start-Sleep -Milliseconds 2000
$gateNote2 = EvalJson @"
(async()=>{
$H2
  await waitEditor();
  return JSON.stringify({editor:!!bySel('.cm-content'), archive:!!noteArchive('$NOTE_ID'),
    title:(bySel('input[placeholder="笔记标题"]')||{}).value||null});
})()
"@
Write-Host ("  笔记面板里：" + ($gateNote2 | ConvertTo-Json -Compress))
Check '#10 ★ 笔记打开了，但顶部**没有** `[data-note-archive]`（编辑器和标题照旧）' ($gateNote2 -and $gateNote2.editor -and $gateNote2.title -eq $NOTE_TITLE -and $gateNote2.archive -eq $false) ($gateNote2 | ConvertTo-Json -Compress)

$gateInfo = EvalJson @"
(async()=>{
$H2
  await goPage('信息区');
  let b=null;
  for(let i=0;i<20 && !b;i++){ b=bySel('[data-info-archive="'+'$INFO_ID'+'"]'); if(!b){ const card=bySel('#info-'+'$INFO_ID'); if(card){ card.scrollIntoView({block:'center'}); } await sl(400);} }
  const shown=(await inv('info_list')).some(x=>x.id==='$INFO_ID');
  return JSON.stringify({inList:shown, archive:!!b, archiveAny:document.querySelectorAll('[data-info-archive]').length});
})()
"@
Write-Host ("  信息区里：" + ($gateInfo | ConvertTo-Json -Compress))
Check '#11 ★ 信息在列表里（说明它确实渲染了），但卡上**没有**任何 `[data-info-archive]`（⚠️ 那颗已按用户要求永久去掉，2026-10-11 v2.21.1）' ($gateInfo -and $gateInfo.inList -and $gateInfo.archive -eq $false -and [int]$gateInfo.archiveAny -eq 0) ($gateInfo | ConvertTo-Json -Compress)

# ═════════════════════════ §2 启用链路 ═════════════════════════
Write-Host ""
Write-Host "=== §2 【必验②★】启用链路（点小字 → 点开关 → 侧栏出现 → 重开还在）==="

Step '4 真实鼠标点设置页那行小字 → 开关出现'
$revPre = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await setPage();
  const rev=revealEl();
  return JSON.stringify({reveal:!!rev, pt:rev?centerOf(rev):null, toggle:!!toggleEl(), navArchive:navHas('档案库')});
})()
"@
Write-Host ("  点之前：" + ($revPre | ConvertTo-Json -Compress))
Write-Host (ClickCoords $revPre.pt '设置页那行小字')
Start-Sleep -Milliseconds 1000
$revPost = EvalJson @"
(async()=>{
$H2
  const t=await waitEl('[data-archive-toggle]',15);
  return JSON.stringify({toggle:!!t, checked:t?t.checked:null, reveal:!!revealEl(), pt:t?centerOf(t):null});
})()
"@
Write-Host ("  点之后：" + ($revPost | ConvertTo-Json -Compress))
Check '#12 ★ 真实鼠标点那行小字 → `[data-archive-toggle]` 出现（且还没勾、那行小字换成了开关）' ($revPre -and $revPre.reveal -and $revPre.toggle -eq $false -and $revPost -and $revPost.toggle -and $revPost.checked -eq $false) ($revPost | ConvertTo-Json -Compress)

Step '5 真实鼠标点开关 → `archive.enabled=true` + 侧栏出现「档案库」'
Write-Host (ClickCoords $revPost.pt '「启用档案区」开关')
Start-Sleep -Milliseconds 1300
$on = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  const t=toggleEl();
  return JSON.stringify({enabled:cfg.archive.enabled, checked:t?t.checked:null, navArchive:navHas('档案库'),
    navLabels:Array.from(document.querySelectorAll('nav button')).map(b=>(b.innerText||'').replace(/\s+/g,'')).join('/'),
    pt:navBtn('档案库')?centerOf(navBtn('档案库')):null});
})()
"@
Write-Host ("  打开后：" + ($on | ConvertTo-Json -Compress))
Check '#13 ★★ 真实鼠标点开关 → `config_get` 里 `archive.enabled=true`，界面 checkbox 也勾上了' ($on -and $on.enabled -eq $true -and $on.checked -eq $true) ($on | ConvertTo-Json -Compress)
Check '#14 ★★ 侧栏出现「档案库」（第七个区：在几个区之后、设置之前）' ($on -and $on.navArchive -eq $true) ("侧栏=" + $(if ($on) { $on.navLabels } else { '?' }))

Step '6 真实鼠标点侧栏「档案库」→ 档案库页（空状态）→ 再关掉页面重开'
Write-Host (ClickCoords $on.pt '侧栏「档案库」')
Start-Sleep -Milliseconds 1500
$page0 = EvalJson @"
(async()=>{
$H2
  let p=bySel('[data-archive-page]');
  for(let i=0;i<15 && !p;i++){ await sl(400); p=bySel('[data-archive-page]'); }
  return JSON.stringify({page:!!p, count:archCount(), empty:!!bySel('[data-archive-empty]'),
    search:!!bySel('[data-archive-search]'),
    filters:Array.from(document.querySelectorAll('[data-archive-filter]')).map(e=>e.getAttribute('data-archive-filter')).join(','),
    cards:archIds().length});
})()
"@
Write-Host ("  档案库页：" + ($page0 | ConvertTo-Json -Compress))
Check '#15 ★ 侧栏点进档案库 → `[data-archive-page]` + 搜索框 + 3 个筛选（2026-10-11 P3 返工后口径改成**按来路**分档：all/own/taken）+ 卡片/计数与开工时一致' ($page0 -and $page0.page -and $page0.search -and $page0.filters -eq 'all,own,taken' -and ($page0.empty -eq ($archBase -eq 0)) -and [int]$page0.count -eq $archBase -and [int]$page0.cards -eq $archBase) ($page0 | ConvertTo-Json -Compress)

$rdy = ReloadAndWait 8000
Write-Host ("  重载：" + $rdy)
$afterRl = EvalJson @"
(async()=>{
$H2
  await goPage('首页');
  const has=navHas('档案库');
  await goPage('档案库');
  let p=bySel('[data-archive-page]');
  for(let i=0;i<15 && !p;i++){ await sl(400); p=bySel('[data-archive-page]'); }
  const cfg=await inv('config_get');
  return JSON.stringify({navArchive:has, page:!!p, enabled:cfg.archive.enabled});
})()
"@
Write-Host ("  重开后：" + ($afterRl | ConvertTo-Json -Compress))
Check '#16 ★★ 关页面重开之后侧栏「档案库」还在、点进去还是档案库页（开关是落盘的）' ($afterRl -and $afterRl.navArchive -and $afterRl.page -and $afterRl.enabled -eq $true) ($afterRl | ConvertTo-Json -Compress)

# ═════════════════════════ §3 收进去 ═════════════════════════
Write-Host ""
Write-Host "=== §3 【必验③★】收进去（信息 / 待办 / 笔记 → 原位真的没了）==="

Step '7 把信息收进档案库（⚠️ 入口已按用户要求去掉 → 这一步改走**后端命令**）'
# 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：信息卡上那颗「收进档案库」**被用户要求去掉了**
#    （他原话：「最难绷反而是信息区，没什么关系但是却有导入档案区的选项」）。
#    ⇒ 这一步不能再点界面（那颗已经不存在了）→ 改**直接调 `archive_put`**。
#    ⚠️ 这不影响这一套要验的东西：**收纳 → 原位没它 → 取回 → 逐字段复原**这套机制照旧全验，
#       只是"信息这一类"的入口从界面换成了命令（界面入口现在只剩**认知区笔记**那一处，
#       它的 UI 流程由 §17 那一步用真实鼠标验）。
#    ⚠️ 顺带把「入口到底有几处」钉在这儿：**信息区 ✗ · 待办 ✗ · 认知区笔记 ✓**。
$iPost = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await inv('archive_put', {kind:'info', sourceId:'$INFO_ID', note:''});
  await sl(900);
  // ⚠️ 档案库那一页**只在自己挂载时读一次**（它不广播 data-changed，也不监听）——
  //    所以"卡片出现了没"必须**离开这一页再回来**（`bounceArch`）。⚠️ 光调 `goPage('档案库')`
  //    在人已经站在这页上时**不会重新挂载**，列表还是旧的 —— 2026-10-11 实测栽在这儿。
  const stillThere=(await inv('info_list')).some(x=>x.id==='$INFO_ID');
  await bounceArch();
  const card=archCard('$INFO_ID');
  return JSON.stringify({stillThere:stillThere,
    card:!!card, kind:archKind('$INFO_ID'),
    title:card?(card.querySelector('[data-archive-title]')||{}).textContent:null,
    at:card?(card.querySelector('[data-archive-at]')||{}).getAttribute('data-archive-at'):null,
    toast:(document.body.innerText||'').indexOf('已收进档案库')>=0});
})()
"@
Write-Host ("  收完后：" + ($iPost | ConvertTo-Json -Compress))
Check '#17 ★★ 信息收进去了：`info_list` 里**真的没了**、档案卡出现且 `data-archive-kind="info"`、卡片标题取正文首行、还盖了收纳时间' ($iPost -and $iPost.stillThere -eq $false -and $iPost.card -and $iPost.kind -eq 'info' -and "$($iPost.title)".StartsWith('M15 信息') -and $iPost.at) ($iPost | ConvertTo-Json -Compress)

Step '8 把待办收进档案库（⚠️ ⚙ 里那颗已按用户要求去掉 → 改走后端命令）'
# 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：待办 ⚙ 里那颗「收进档案库」也**被用户要求去掉了**
#    ⇒ 这一步不再点界面（那颗已经不存在）→ 改**直接调 `archive_put`**。
#    ⚠️ 这条要验的是"待办整条（含番茄/子任务/象限/截止）能收纳、取回时逐字段复原"这套机制，
#       跟入口在哪没关系；界面入口现在只剩**认知区笔记**那一处（step 9 与 step 11 用真实鼠标验）。
#    ⚠️ 顺手把「⚙ 里到底有没有那颗」钉在这儿：**没有**（就是下面这一步"启用了也没有"的断言）。
$tBox = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await inv('archive_put', {kind:'todo', sourceId:'$TODO_ID', note:''});
  await sl(900);
  const modal=null;
  const b=todoArchive('$TODO_ID');
  return JSON.stringify({modal:!!modal, archive:!!b, pt:null});
})()
"@
Write-Host ("  ⚙ 弹窗里：" + ($tBox | ConvertTo-Json -Compress))
Start-Sleep -Milliseconds 600
$tPost = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  const stillThere=(await inv('todo_list')).some(x=>x.id==='$TODO_ID');
  await bounceArch();
  return JSON.stringify({stillThere:stillThere,
    card:!!archCard('$TODO_ID'), kind:archKind('$TODO_ID'), dialogs:document.querySelectorAll('[role="dialog"]').length});
})()
"@
Write-Host ("  收完后：" + ($tPost | ConvertTo-Json -Compress))
Check '#18 ★★ 待办收进去了：`todo_list` 里没了、档案卡 kind="todo"、没有留下弹窗（⚠️ 2026-10-11 起这一步走后端命令，不再开 ⚙ 弹窗）' ($tBox -and $tBox.archive -eq $false -and $tPost -and $tPost.stillThere -eq $false -and $tPost.card -and $tPost.kind -eq 'todo' -and [int]$tPost.dialogs -eq 0) ($tPost | ConvertTo-Json -Compress)

Step '9 真实鼠标点笔记那一行 ⋮ 菜单里的「收进档案库」（文件要挪到 `notes/_archive/`）'
$nPre = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await goPage('认知区');
  let row=await ensureNoteRow('$NOTE_ID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NOTE_ID'); }
  if(row) row.click();
  await sl(1800);
  await waitEditor();
  // 2026-10-11（v2.19.0 · 用户反馈第 12 条）：笔记的「收进档案库」从**编辑区顶部**
  // 挪进了**列表行的 ⋮ 菜单**里 → 先点开那一行的 ⋮ 再找那个按钮。
  // （开菜单用合成 click 就行；真正要"真实鼠标"的是后面那一下收进档案库。）
  const _mb=bySel('[data-note-menu-btn="'+'$NOTE_ID'+'"]');
  if(_mb){ _mb.click(); await sl(500); }
  let b=null;
  for(let i=0;i<20 && !b;i++){ b=noteArchive('$NOTE_ID'); if(!b) await sl(400); }
  return JSON.stringify({row:!!row, editor:!!bySel('.cm-content'), archive:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host ("  笔记面板：" + ($nPre | ConvertTo-Json -Compress))
Write-Host (ClickCoords $nPre.pt '笔记「收进档案库」')
Start-Sleep -Milliseconds 2000
$nPost = EvalJson @"
(async()=>{
$H2
  const list=await inv('note_list');
  const got=await inv('note_get',{id:'$NOTE_ID'});
  await bounceArch();
  return JSON.stringify({stillThere:list.some(x=>x.id==='$NOTE_ID'), get:got?true:false,
    card:!!archCard('$NOTE_ID'), kind:archKind('$NOTE_ID')});
})()
"@
Write-Host ("  收完后：" + ($nPost | ConvertTo-Json -Compress))
$archFile = Join-Path $DATA ("notes\_archive\" + $NOTE_ID + ".json")
$origFile = Join-Path $DATA ("notes\" + $NOTE_ID + ".json")
Write-Host ("  盘上：notes\_archive\<id>.json 在=" + (Test-Path $archFile) + "；原位 notes\<id>.json 在=" + (Test-Path $origFile))
Check '#19 ★★ 笔记收进去了：`note_list` / `note_get` 都找不到它，档案卡 kind="note"' ($nPost -and $nPost.stillThere -eq $false -and $nPost.get -eq $false -and $nPost.card -and $nPost.kind -eq 'note') ($nPost | ConvertTo-Json -Compress)
Check '#20 ★ 笔记文件真的挪到了 `notes/_archive/<id>.json`（原位 `notes/<id>.json` 不在了）' ((Test-Path $archFile) -and -not (Test-Path $origFile)) ("archive 在=" + (Test-Path $archFile) + " 原位在=" + (Test-Path $origFile))

Step '10 档案库页：3 张卡、计数 3、三种来源各一'
$three = EvalJson @"
(async()=>{
$H2
  await goPage('档案库');
  await sl(600);
  const arch=await inv('archive_list');
  return JSON.stringify({count:archCount(), cards:archIds().length, kinds:archKinds(),
    filterAll:!!bySel('[data-archive-filter="all"]'),
    empty:!!bySel('[data-archive-empty]'),
    list:arch.map(a=>({id:a.id,kind:a.kind,title:a.title,note:a.note,snapKeys:a.snapshot?Object.keys(a.snapshot).length:0}))});
})()
"@
Write-Host ("  档案库：" + ($three | ConvertTo-Json -Compress -Depth 4))
$kindsNow = @($three.kinds) -join ' '
Check '#21 ★ 档案库页 = 自己的 3 张卡 + 开工时就有的那些（info / note / todo 各一都在）' ($three -and [int]$three.cards -eq (3 + $archBase) -and [int]$three.count -eq (3 + $archBase) -and $kindsNow -match 'info' -and $kindsNow -match 'note' -and $kindsNow -match 'todo' -and $three.empty -eq $false) ($three | ConvertTo-Json -Compress -Depth 3)

# ═════════════════════════ §4 撤销 ═════════════════════════
Write-Host ""
Write-Host "=== §4 【必验④★】撤销（toast 上的 `[data-toast-action]`，5 秒内）==="

Step '11 再收一条（**笔记**，走认知区行菜单）→ 马上真实鼠标点 toast 上的「撤销」'
# 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：这一步原来点的是**信息卡**那颗「收进档案库」——
#    那颗被用户要求去掉了 ⇒ 改成点**认知区笔记**那颗（`data-note-menu-btn` → `data-note-archive`）。
#    ⚠️ 这样改反而更好：界面上的入口本来就只剩认知区这一处，**"收纳→toast 撤销"这条路就该在这儿验**。
#    （信息那条仍然照旧造出来，后面 §21 的"彻底删掉"要用它。）
$undoMade = EvalJson @"
(async()=>{
$H2
  const info=await inv('info_create',{text:'$UNDO_TEXT', categories:['$INFO_CAT']});
  const note=await inv('note_create',{title:'M15 撤销笔记-收了再撤回', kind:'doc', content:'撤销用的正文'});
  await sl(1200);
  await closeDialogs();
  // 🔴 2026-10-11（P3 返工后修的一条假红）：这一步原来**直接**就去点那一行的 ⋮ 了，
  //    结果菜单是出来了，但那颗「收进档案库」的坐标算在 y≈900（`inView:false`）——
  //    真实鼠标那一下点在菜单外面 → 笔记压根没被收走（`gone:false`）。
  //    现在跟 §9 / §15 / §17 那三步**用同一套动作**：先离开这一页再回来（保证列表是新的）、
  //    点开那一行、等编辑器出来，然后才开 ⋮ 菜单。
  await goPage('首页');
  await sl(400);
  await goPage('认知区');
  await sl(1200);
  let row=noteRow(note.id);
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow(note.id); }
  // ⚠️ 先把这一行滚进视野（这条笔记没分组、排在列表最下面）——**滚完再开菜单**，
  //    否则菜单按"屏幕外那个坐标"定位，量出来的点也在屏幕外，真实鼠标那一下根本点不着。
  if(row){ row.scrollIntoView({block:'center'}); await sl(400); row.click(); await sl(1800); await waitEditor(); }
  let btn=null;
  for(let i=0;i<20 && !btn;i++){ btn=bySel('[data-note-menu-btn="'+note.id+'"]'); if(!btn) await sl(400); }
  if(btn){ btn.scrollIntoView({block:'center'}); await sl(400); btn.click(); await sl(700); }
  let b=null;
  for(let i=0;i<20 && !b;i++){ b=bySel('[data-note-archive="'+note.id+'"]'); if(!b) await sl(400); }
  const pt=centerNoScroll(b);
  return JSON.stringify({id:info.id, noteId:note.id, createdAt:info.createdAt, row:!!row, found:!!b, pt:pt, inView:pt?pt.inView:null});
})()
"@
Write-Host ("  入口：" + ($undoMade | ConvertTo-Json -Compress))
Write-Host (ClickCoords $undoMade.pt '笔记行菜单「收进档案库」（待撤销那条）')
Start-Sleep -Milliseconds 600
$toast = EvalJson @"
(async()=>{
$H2
  const a=toastAction();
  const list=await inv('note_list');
  return JSON.stringify({gone:!list.some(x=>x.id==='$($undoMade.noteId)'), action:!!a,
    label:a?(a.textContent||'').trim():null, pt:a?centerOf(a):null,
    toastText:(document.body.innerText||'').indexOf('已收进档案库')>=0});
})()
"@
Write-Host ("  toast：" + ($toast | ConvertTo-Json -Compress))
Check '#22 ★ 收走之后 toast 上有 `[data-toast-action]`（文字「撤销」），认知区里这条已经没了' ($toast -and $toast.gone -and $toast.action -and "$($toast.label)" -eq '撤销') ($toast | ConvertTo-Json -Compress)
Write-Host (ClickCoords $toast.pt 'toast 上的「撤销」')
Start-Sleep -Milliseconds 1600
$undone = EvalJson @"
(async()=>{
$H2
  const list=await inv('note_list');
  const one=list.find(x=>x.id==='$($undoMade.noteId)');
  const arch=await inv('archive_list');
  return JSON.stringify({back:!!one, text:one?one.title:null, createdAt:one?one.createdAt:null,
    inArch:arch.some(a=>a.id==='$($undoMade.noteId)'), archLen:arch.length});
})()
"@
Write-Host ("  撤销后：" + ($undone | ConvertTo-Json -Compress))
Check '#23 ★★ 真实鼠标点「撤销」→ 东西**回到原位**（`note_list` 里有它、标题与 createdAt 原样）' ($undone -and $undone.back -and $undone.text -eq 'M15 撤销笔记-收了再撤回' -and $undone.createdAt) ($undone | ConvertTo-Json -Compress)
Check '#24 ★★ 撤销后档案库里**没了**（`archive_list` 回到"自己的 3 条 + 开工就有的"）' ($undone -and $undone.inArch -eq $false -and [int]$undone.archLen -eq (3 + $archBase)) ($undone | ConvertTo-Json -Compress)

# ═════════════════════════ §5 取出逐字段复原 ═════════════════════════
Write-Host ""
Write-Host "=== §5 【必验⑤★★】取出字段逐项复原（三种来源各取出一次，逐字段比）==="

Step '12 真实鼠标点信息那条的「取出（回信息区）」→ 逐字段比'
$resInfo = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await bounceArch();
  // 🔴 P3 返工后：面板里的「取出」只对**选中的那一条**渲染 → 先点左边那一行
  const picked=await pickArch('$INFO_ID');
  let b=bySel('[data-archive-restore="'+'$INFO_ID'+'"]');
  for(let i=0;i<20 && !b;i++){ await sl(400); b=bySel('[data-archive-restore="'+'$INFO_ID'+'"]'); }
  return JSON.stringify({picked:picked, found:!!b, pt:b?centerOf(b):null, label:b?(b.textContent||'').trim():null});
})()
"@
Write-Host ("  取出按钮：" + ($resInfo | ConvertTo-Json -Compress))
Write-Host (ClickCoords $resInfo.pt '档案卡「取出（回信息区）」')
Start-Sleep -Milliseconds 1800
$iAfter = EvalJson @"
(async()=>{
$H2
  const one=(await inv('info_list')).find(x=>x.id==='$INFO_ID');
  return JSON.stringify({back:!!one, now:one?{id:one.id,createdAt:one.createdAt,text:one.text,categories:one.categories,kind:one.kind,status:one.status,links:(one.links||[]).length}:null,
    inArch:(await inv('archive_list')).some(a=>a.id==='$INFO_ID'), card:!!archCard('$INFO_ID')});
})()
"@
Write-Host ("  取出后：" + ($iAfter | ConvertTo-Json -Compress))
$iSame = ($iBefore | ConvertTo-Json -Compress -Depth 5) -eq ($iAfter.now | ConvertTo-Json -Compress -Depth 5)
Check '#25 ★★ 信息取出后**逐字段完全相同**（id 原样 / createdAt 原样 / text 两行逐字 / categories / kind / status / links）' ($iAfter -and $iAfter.back -and $iSame) ("开工 " + ($iBefore | ConvertTo-Json -Compress) + "  取出后 " + ($iAfter.now | ConvertTo-Json -Compress))
Check '#26 ★ 取出之后档案里没有它了（卡片消失）' ($iAfter -and $iAfter.inArch -eq $false -and $iAfter.card -eq $false) ($iAfter | ConvertTo-Json -Compress)

Step '13 真实鼠标点待办那条的「取出（回执行区）」→ 逐字段比（番茄 / 子任务 / 象限 / 时间 / 状态 / id）'
$resTodo = EvalJson @"
(async()=>{
$H2
  await pickArch('$INFO_ID');   // 面板只对选中的那条渲染：上一条取走后先随便选一条，再选待办那条
  await pickArch('$TODO_ID');
  let b=bySel('[data-archive-restore="'+'$TODO_ID'+'"]');
  for(let i=0;i<20 && !b;i++){ await sl(400); b=bySel('[data-archive-restore="'+'$TODO_ID'+'"]'); }
  return JSON.stringify({found:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host (ClickCoords $resTodo.pt '档案卡「取出（回执行区）」')
Start-Sleep -Milliseconds 1800
$tAfter = EvalJson @"
(async()=>{
$H2
  const t=(await inv('todo_list')).find(x=>x.id==='$TODO_ID');
  return JSON.stringify({back:!!t, now:t?{id:t.id,createdAt:t.createdAt,title:t.title,status:t.status,quadrant:t.quadrant,
      plannedAt:t.plannedAt,dueAt:t.dueAt,order:t.order,repeat:t.repeat,
      pomodoros:(t.pomodoros||[]).map(p=>p.mode+'|'+p.seconds+'|'+p.note),
      subtasks:(t.subtasks||[]).map(s=>s.text+'|'+s.done)}:null,
    inArch:(await inv('archive_list')).some(a=>a.id==='$TODO_ID')});
})()
"@
Write-Host ("  取出后：" + ($tAfter | ConvertTo-Json -Compress -Depth 5))
$tSame = ($tBefore | ConvertTo-Json -Compress -Depth 5) -eq ($tAfter.now | ConvertTo-Json -Compress -Depth 5)
Check '#27 ★★ 待办取出后**逐字段完全相同**（id / createdAt / quadrant / plannedAt / dueAt / status / order / repeat / title）' ($tAfter -and $tAfter.back -and $tSame) ("开工 " + ($tBefore | ConvertTo-Json -Compress) + "  取出后 " + ($tAfter.now | ConvertTo-Json -Compress))
Check '#28 ★★ 番茄记录**一条不少**（1 笔，mode/seconds/note 全同）' ($tAfter -and @($tAfter.now.pomodoros).Count -eq 1 -and @($tAfter.now.pomodoros)[0] -eq @($tBefore.pomodoros)[0]) ("开工 " + (@($tBefore.pomodoros) -join ' , ') + "  取出后 " + (@($tAfter.now.pomodoros) -join ' , '))
Check '#29 ★★ 子任务**一个不少**且勾选状态原样（第二步仍是已勾）' ($tAfter -and @($tAfter.now.subtasks).Count -eq 2 -and (@($tAfter.now.subtasks) -join ' , ') -eq (@($tBefore.subtasks) -join ' , ')) ("开工 " + (@($tBefore.subtasks) -join ' , ') + "  取出后 " + (@($tAfter.now.subtasks) -join ' , '))

Step '14 真实鼠标点笔记那条的「取出（回认知区）」→ 正文逐字比'
$resNote = EvalJson @"
(async()=>{
$H2
  await pickArch('$INFO_ID');
  await pickArch('$NOTE_ID');
  let b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]');
  for(let i=0;i<20 && !b;i++){ await sl(400); b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]'); }
  return JSON.stringify({found:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host (ClickCoords $resNote.pt '档案卡「取出（回认知区）」')
Start-Sleep -Milliseconds 1800
$nAfter = EvalJson @"
(async()=>{
$H2
  const n=await inv('note_get',{id:'$NOTE_ID'});
  const arch=await inv('archive_list');
  return JSON.stringify({back:!!n, now:n?{id:n.id,title:n.title,content:n.content,group:n.group,createdAt:n.createdAt}:null,
    inArch:arch.some(a=>a.id==='$NOTE_ID'), cards:archIds().length,
    empty:!!bySel('[data-archive-empty]'), count:archCount()});
})()
"@
Write-Host ("  取出后：" + ($nAfter | ConvertTo-Json -Compress -Depth 4))
Write-Host ("  正文逐字相同=" + ($nAfter.now.content -eq $nBefore.content))
Check '#30 ★★ 笔记取出后**正文逐字相同**（含 `-[]` 那行、行尾两个空格）+ `group` / 标题 / createdAt 原样' ($nAfter -and $nAfter.back -and $nAfter.now.content -eq $nBefore.content -and $nAfter.now.group -eq $NOTE_GROUP -and $nAfter.now.title -eq $NOTE_TITLE -and $nAfter.now.createdAt -eq $nBefore.createdAt) ("逐字相同=" + $(if ($nAfter) { $nAfter.now.content -eq $nBefore.content } else { '?' }) + " group=" + $(if ($nAfter) { $nAfter.now.group } else { '?' }))
Write-Host ("  盘上：原位 notes\<id>.json 在=" + (Test-Path $origFile) + "；notes\_archive\<id>.json 在=" + (Test-Path $archFile))
Check '#31 ★ 笔记文件挪回来了（原位在、档案目录里那份不留成孤儿）' ((Test-Path $origFile) -and -not (Test-Path $archFile)) ("原位在=" + (Test-Path $origFile) + " 档案目录在=" + (Test-Path $archFile))
Check '#32 ★★ 三条都取出来了 → 档案库回到开工时的样子（卡片/计数 = 开工条数，空状态按它决定）' ($nAfter -and $nAfter.inArch -eq $false -and [int]$nAfter.cards -eq $archBase -and [int]$nAfter.count -eq $archBase -and ($nAfter.empty -eq ($archBase -eq 0))) ($nAfter | ConvertTo-Json -Compress)

# ═════════════════════════ §6 收纳笔记不再冤标待办 ═════════════════════════
Write-Host ""
Write-Host "=== §6 【必验⑧】收纳笔记不再冤标待办（`source.sourceRemoved` 必须还是 false）==="

Step '15 笔记里 `-[]` 生出来的那条待办：收纳笔记前后 `sourceRemoved` 都要是 false'
$mkPre = EvalJson @"
(async()=>{
$H2
  // 先在执行区把卡片渲染出来再读 DOM（不然在档案库页上读 `[data-todo-id]` 一定是 null）
  await goPage('执行区');
  await sl(600);
  const t=(await inv('todo_list')).find(x=>x.id==='$($made.markerId)');
  const c=todoCard('$($made.markerId)');
  return JSON.stringify({there:!!t, removed:t?!!(t.source&&t.source.sourceRemoved):null,
    title:t?t.title:null, kind:t?t.source.kind:null, noteId:t?t.source.noteId:null,
    domCard:!!c, domRemoved:c?c.getAttribute('data-todo-source-removed'):null});
})()
"@
Write-Host ("  收纳前：" + ($mkPre | ConvertTo-Json -Compress))
Check '#33 ★ 笔记那条 `-[]` 待办确实在（`source.kind="note"`、指向我这篇笔记、sourceRemoved=false），执行区的卡片也没被标' ($mkPre -and $mkPre.there -and $mkPre.removed -eq $false -and $mkPre.kind -eq 'note' -and $mkPre.noteId -eq $NOTE_ID -and $mkPre.domCard -and $mkPre.domRemoved -eq '0') ($mkPre | ConvertTo-Json -Compress)

$mkArc = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await goPage('认知区');
  let row=await ensureNoteRow('$NOTE_ID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NOTE_ID'); }
  if(row){ row.click(); await sl(1800); await waitEditor(); }
  // 2026-10-11（v2.19.0 · 用户反馈第 12 条）：笔记的「收进档案库」挪进了**列表行的 ⋮ 菜单**
  const _mb=bySel('[data-note-menu-btn="'+'$NOTE_ID'+'"]');
  if(_mb){ _mb.click(); await sl(500); }
  let b=null;
  for(let i=0;i<20 && !b;i++){ b=noteArchive('$NOTE_ID'); if(!b) await sl(400); }
  return JSON.stringify({row:!!row, archive:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host ("  笔记「收进档案库」入口：" + ($mkArc | ConvertTo-Json -Compress))
Write-Host (ClickCoords $mkArc.pt '笔记「收进档案库」（§6 再收一次）')
Start-Sleep -Milliseconds 2000
$mkPost = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  const t=(await inv('todo_list')).find(x=>x.id==='$($made.markerId)');
  const c=todoCard('$($made.markerId)');
  return JSON.stringify({there:!!t, removed:t?!!(t.source&&t.source.sourceRemoved):null,
    title:t?t.title:null, inNoteList:(await inv('note_list')).some(n=>n.id==='$NOTE_ID'),
    inArch:(await inv('archive_list')).some(a=>a.id==='$NOTE_ID'),
    domRemoved:c?c.getAttribute('data-todo-source-removed'):null, domCard:!!c});
})()
"@
Write-Host ("  收纳后：" + ($mkPost | ConvertTo-Json -Compress))
Check '#34 ★★ 收纳笔记之后那条待办**还在**、`sourceRemoved` **还是 false**（冤标就是真 bug）' ($mkPost -and $mkPost.there -and $mkPost.removed -eq $false -and $mkPost.domRemoved -eq '0') ($mkPost | ConvertTo-Json -Compress)
Check '#35 ★ 这时候笔记确实在档案库里（`note_list` 没了、`archive_list` 里 kind="note"）—— 说明上一条不是"没生效"混过去的' ($mkPost -and $mkPost.inNoteList -eq $false -and $mkPost.inArch) ($mkPost | ConvertTo-Json -Compress)

Step '16 取出之后仍正常（正文逐字 + 待办仍未被冤标）'
$mkBackPt = EvalJson @"
(async()=>{
$H2
  await bounceArch();
  const picked=await pickArch('$NOTE_ID');
  let b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]');
  for(let i=0;i<20 && !b;i++){ await sl(400); b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]'); }
  return JSON.stringify({picked:picked, found:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host (ClickCoords $mkBackPt.pt '档案卡「取出（回认知区）」')
Start-Sleep -Milliseconds 1800
$mkBack = EvalJson @"
(async()=>{
$H2
  const t=(await inv('todo_list')).find(x=>x.id==='$($made.markerId)');
  const n=await inv('note_get',{id:'$NOTE_ID'});
  return JSON.stringify({there:!!t, removed:t?!!(t.source&&t.source.sourceRemoved):null,
    same:n?n.content===${NOTE_JSON}:null, title:n?n.title:null,
    inArch:(await inv('archive_list')).some(a=>a.id==='$NOTE_ID')});
})()
"@
Write-Host ("  取出后：" + ($mkBack | ConvertTo-Json -Compress))
Check '#36 ★★ 取出之后：正文逐字相同、那条待办仍在且 `sourceRemoved` 仍为 false' ($mkBackPt -and $mkBackPt.found -and $mkBack -and $mkBack.there -and $mkBack.removed -eq $false -and $mkBack.same -eq $true -and $mkBack.inArch -eq $false) ($mkBack | ConvertTo-Json -Compress)

# ═════════════════════════ §7 库里能直接改 ═════════════════════════
Write-Host ""
Write-Host "=== §7 【必验⑥★】库里能直接改（改标题 + 改正文 → 存下 → 重开还在）==="

Step '17 再把笔记收进去（真实鼠标点那一行 ⋮ 菜单里的入口）→ 真实鼠标点**左边那一行**打开面板'
$editArc = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await goPage('认知区');
  let row=await ensureNoteRow('$NOTE_ID');
  for(let i=0;i<25 && !row;i++){ await sl(400); row=noteRow('$NOTE_ID'); }
  if(row){ row.click(); await sl(1800); await waitEditor(); }
  // 2026-10-11（v2.19.0 · 用户反馈第 12 条）：笔记的「收进档案库」挪进了**列表行的 ⋮ 菜单**
  const _mb=bySel('[data-note-menu-btn="'+'$NOTE_ID'+'"]');
  if(_mb){ _mb.click(); await sl(500); }
  let b=null;
  for(let i=0;i<20 && !b;i++){ b=noteArchive('$NOTE_ID'); if(!b) await sl(400); }
  return JSON.stringify({row:!!row, archive:!!b, pt:b?centerOf(b):null});
})()
"@
Write-Host ("  入口：" + ($editArc | ConvertTo-Json -Compress))
Write-Host (ClickCoords $editArc.pt '笔记「收进档案库」（§7 再收一次）')
Start-Sleep -Milliseconds 2000
$editOpen = EvalJson @"
(async()=>{
$H2
  await bounceArch();
  let o=bySel('[data-archive-open="'+'$NOTE_ID'+'"]');
  for(let i=0;i<20 && !o;i++){ await sl(400); o=bySel('[data-archive-open="'+'$NOTE_ID'+'"]'); }
  return JSON.stringify({archived:(await inv('archive_list')).some(a=>a.id==='$NOTE_ID'),
    open:!!o, pt:o?centerOf(o):null, label:o?(o.textContent||'').trim().slice(0,20):null});
})()
"@
Write-Host ("  列表那一行：" + ($editOpen | ConvertTo-Json -Compress))
Write-Host (ClickCoords $editOpen.pt '档案库左边那一行（点开＝选中 → 右边出编辑面板）')
Start-Sleep -Milliseconds 1400
$detail = EvalJson @"
(async()=>{
$H2
  const d=await waitEl('[data-archive-detail="'+'$NOTE_ID'+'"]',15);
  return JSON.stringify({detail:!!d,
    title:(bySel('[data-archive-edit-title]')||{}).value||null,
    body:archBody(),
    noteBox:!!bySel('[data-archive-edit-note]'), savePt:(()=>{const b=bySel('[data-archive-save]'); return b?centerOf(b):null;})()});
})()
"@
Write-Host ("  编辑面板：" + ($detail | ConvertTo-Json -Compress -Depth 3))
Check '#37 ★ 点左边那一行 → 右边出 `[data-archive-detail]`，标题框里是原标题、正文区里是**原来那篇正文**（逐字，行尾空格由 #40 在盘上卡）' ($detail -and $detail.detail -and $detail.title -eq $NOTE_TITLE -and (NormBody $detail.body) -eq (NormBody $NOTE_CONTENT) -and $detail.noteBox) ("标题=" + $(if ($detail) { $detail.title } else { '?' }) + " 正文逐字相同=" + $(if ($detail) { (NormBody $detail.body) -eq (NormBody $NOTE_CONTENT) } else { '?' }))

Step '18 真键盘改标题 + 改正文 → 真实鼠标点「存下」'
Write-Host ("  改标题：" + (TypeInto '[data-archive-edit-title]' $NOTE_NEW_TITLE))
Start-Sleep -Milliseconds 500
Write-Host ("  改正文：" + (TypeIntoEditor '[data-archive-edit-body]' $NOTE_NEW_BODY))
Start-Sleep -Milliseconds 500
$beforeSave = EvalJson @"
(async()=>{
$H2
  return JSON.stringify({title:(bySel('[data-archive-edit-title]')||{}).value||null,
    body:archBody(),
    dirty:!!bySel('[data-archive-dirty]'),
    savePt:(()=>{const b=bySel('[data-archive-save]'); return b?centerOf(b):null;})()});
})()
"@
Write-Host ("  存之前：" + ($beforeSave | ConvertTo-Json -Compress))
Check '#38 真键盘打的字真的进了标题框与 CodeMirror 正文区（不是 `el.value=` 那套假输入）' ($beforeSave -and $beforeSave.title -eq $NOTE_NEW_TITLE -and (NormBody $beforeSave.body) -eq (NormBody $NOTE_NEW_BODY)) ($beforeSave | ConvertTo-Json -Compress)
Write-Host (ClickCoords $beforeSave.savePt '「存下」')
Start-Sleep -Milliseconds 1800
$saved = EvalJson @"
(async()=>{
$H2
  const arch=await inv('archive_list');
  const one=arch.find(a=>a.id==='$NOTE_ID');
  const card=archCard('$NOTE_ID');
  return JSON.stringify({card:!!card,
    cardTitle:card?(card.querySelector('[data-archive-title]')||{}).textContent:null,
    listTitle:one?one.title:null, listSummary:one?one.summary:null,
    snapTitle:one?one.snapshot.title:null, snapContent:one?one.snapshot.content:null,
    summary2:(document.body.innerText||'').indexOf('改好了')>=0});
})()
"@
Write-Host ("  存下后：" + ($saved | ConvertTo-Json -Compress -Depth 3))
Check '#39 ★★ 点「存下」→ 卡片标题变了、`archive_list` 的 title / snapshot.title / snapshot.content 都跟着变' ($saved -and $saved.card -and $saved.cardTitle -eq $NOTE_NEW_TITLE -and $saved.listTitle -eq $NOTE_NEW_TITLE -and $saved.snapTitle -eq $NOTE_NEW_TITLE -and $saved.snapContent -eq $NOTE_NEW_BODY) ($saved | ConvertTo-Json -Compress -Depth 3)

$diskNote = $null
if (Test-Path $archFile) { try { $diskNote = (Get-Content $archFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch { $diskNote = $null } }
Write-Host ("  盘上 notes\_archive\<id>.json：title=" + $(if ($diskNote) { $diskNote.title } else { '(没读到)' }) + " content=" + $(if ($diskNote) { $diskNote.content } else { '(没读到)' }))
Check '#40 ★★ `notes/_archive/<id>.json` 里正文**真的变了**（title/content 都是改过的那份，id / createdAt 没动）' ($diskNote -and $diskNote.content -eq $NOTE_NEW_BODY -and $diskNote.title -eq $NOTE_NEW_TITLE -and $diskNote.id -eq $NOTE_ID -and $diskNote.createdAt -eq $nBefore.createdAt) ("content=" + $(if ($diskNote) { $diskNote.content } else { '?' }) + " createdAt 未变=" + $(if ($diskNote) { $diskNote.createdAt -eq $nBefore.createdAt } else { '?' }))

Step '19 关掉页面重开 → 改过的还在'
$rdy2 = ReloadAndWait 8000
Write-Host ("  重载：" + $rdy2)
$afterEdit = EvalJson @"
(async()=>{
$H2
  await goPage('档案库');
  let o=bySel('[data-archive-open="'+'$NOTE_ID'+'"]');
  for(let i=0;i<20 && !o;i++){ await sl(400); o=bySel('[data-archive-open="'+'$NOTE_ID'+'"]'); }
  const card=archCard('$NOTE_ID');
  if(o) o.click();
  await sl(1200);
  return JSON.stringify({cardTitle:card?(card.querySelector('[data-archive-title]')||{}).textContent:null,
    title:(bySel('[data-archive-edit-title]')||{}).value||null,
    body:archBody(),
    detail:!!bySel('[data-archive-detail]')});
})()
"@
Write-Host ("  重开后：" + ($afterEdit | ConvertTo-Json -Compress))
Check '#41 ★★ 重开页面后改过的标题与正文还在（卡片标题 + 详情框里的值都是新的）' ($afterEdit -and $afterEdit.cardTitle -eq $NOTE_NEW_TITLE -and $afterEdit.title -eq $NOTE_NEW_TITLE -and $afterEdit.body -eq $NOTE_NEW_BODY) ($afterEdit | ConvertTo-Json -Compress)

Step '20 把改过的这篇取出来 → 认知区看到的就该是改过的那份（别"一取出全变回去"）'
$backEdited = EvalJson @"
(async()=>{
$H2
  // 🔴 P3 返工后：上一步重开页面后是"选中态还在、但刷新后要重新点一次那一行" —— 这里先选行再点取出
  await pickArch('$NOTE_ID');
  let b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]');
  for(let i=0;i<20 && !b;i++){ await sl(400); b=bySel('[data-archive-restore="'+'$NOTE_ID'+'"]'); }
  const pt=b?centerOf(b):null;
  if(b) b.click();
  await sl(1800);
  const n=await inv('note_get',{id:'$NOTE_ID'});
  return JSON.stringify({clicked:!!b, back:!!n, title:n?n.title:null, content:n?n.content:null,
    group:n?n.group:null, createdAt:n?n.createdAt:null, inArch:(await inv('archive_list')).some(a=>a.id==='$NOTE_ID')});
})()
"@
Write-Host ("  取出后：" + ($backEdited | ConvertTo-Json -Compress -Depth 3))
Check '#42 ★★ 取出后认知区看到的是**改过的那份**（标题 + 正文），`group` / `createdAt` 一个字没动' ($backEdited -and $backEdited.back -and $backEdited.title -eq $NOTE_NEW_TITLE -and $backEdited.content -eq $NOTE_NEW_BODY -and $backEdited.group -eq $NOTE_GROUP -and $backEdited.createdAt -eq $nBefore.createdAt) ($backEdited | ConvertTo-Json -Compress -Depth 3)

# ═════════════════════════ §8 彻底删掉 ═════════════════════════
Write-Host ""
Write-Host "=== §8 【必验⑦】彻底删掉（二次确认 + backups/ 里新写一份「档案-删除前」）==="

$backupDir = Join-Path $DATA 'backups'
$bkBefore = @()
if (Test-Path $backupDir) { $bkBefore = @(Get-ChildItem $backupDir -Filter '档案-删除前*' -File | ForEach-Object { $_.Name }) }
Write-Host ("  动手前 backups\ 里「档案-删除前」已有 " + $bkBefore.Count + " 份（**不数份数**，只看有没有新写的）：" + ($bkBefore -join ' / '))

Step '21 把那条信息再收进去（⚠️ 入口已去掉 → 改走后端命令）→ 点「彻底删掉」→ 弹二次确认'
# 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：信息卡那颗入口去掉之后，这一步改**直接调 `archive_put`**；
#    后面"点档案卡上的彻底删掉 → 二次确认 → 真删 + 留档"全都是**真实鼠标**，一个字没改。
$delArc = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await inv('archive_put', {kind:'info', sourceId:'$($undoMade.id)', note:''});
  await sl(900);
  const inArch=(await inv('archive_list')).some(a=>a.id==='$($undoMade.id)');
  return JSON.stringify({found:inArch, pt:null});
})()
"@
Write-Host ("  信息入口：" + ($delArc | ConvertTo-Json -Compress))
Start-Sleep -Milliseconds 600
$delPre = EvalJson @"
(async()=>{
$H2
  await bounceArch();
  const picked=await pickArch('$($undoMade.id)');
  let d=bySel('[data-archive-del="'+'$($undoMade.id)'+'"]');
  for(let i=0;i<20 && !d;i++){ await sl(400); d=bySel('[data-archive-del="'+'$($undoMade.id)'+'"]'); }
  return JSON.stringify({archived:(await inv('archive_list')).some(a=>a.id==='$($undoMade.id)'),
    picked:picked, del:!!d, pt:d?centerOf(d):null, label:d?(d.textContent||'').trim():null});
})()
"@
Write-Host ("  删除入口：" + ($delPre | ConvertTo-Json -Compress))
Write-Host (ClickCoords $delPre.pt '编辑面板「彻底删掉」')
Start-Sleep -Milliseconds 1200
$confirm = EvalJson @"
(async()=>{
$H2
  const d=await waitEl('[role="dialog"]',15);
  if(!d) return JSON.stringify({dialog:false});
  const btn=Array.from(d.querySelectorAll('button')).find(x=>(x.textContent||'').trim()==='彻底删掉');
  return JSON.stringify({dialog:true, title:((d.querySelector('h2')||{}).textContent||'').trim(),
    msg:((d.querySelector('p')||{}).textContent||'').replace(/\s+/g,' ').slice(0,20),
    btn:!!btn, pt:btn?centerOf(btn):null,
    stillInArch:(await inv('archive_list')).some(a=>a.id==='$($undoMade.id)')});
})()
"@
Write-Host ("  二次确认：" + ($confirm | ConvertTo-Json -Compress))
Check '#43 ★ 点「彻底删掉」→ 先弹二次确认（`[role="dialog"]`，标题「彻底删掉这一条？」），这时东西**还在**档案里' ($delPre -and $delPre.archived -and $confirm -and $confirm.dialog -and "$($confirm.title)" -like '*彻底删掉这一条*' -and $confirm.btn -and $confirm.stillInArch) ($confirm | ConvertTo-Json -Compress)
Write-Host (ClickCoords $confirm.pt '二次确认里的「彻底删掉」')
Start-Sleep -Milliseconds 1800
$deleted = EvalJson @"
(async()=>{
$H2
  const arch=await inv('archive_list');
  return JSON.stringify({gone:!arch.some(a=>a.id==='$($undoMade.id)'), card:!!archCard('$($undoMade.id)'),
    cards:archIds().length, count:archCount(),
    inInfo:(await inv('info_list')).some(x=>x.id==='$($undoMade.id)'),
    dialogs:document.querySelectorAll('[role="dialog"]').length});
})()
"@
Write-Host ("  删完：" + ($deleted | ConvertTo-Json -Compress))
Check '#44 ★★ 确认后**真删了**：`archive_list` 里没有它、卡片消失、信息区里也没有它（彻底删 ≠ 取出）' ($deleted -and $deleted.gone -and $deleted.card -eq $false -and $deleted.inInfo -eq $false -and [int]$deleted.cards -eq $archBase -and [int]$deleted.dialogs -eq 0) ($deleted | ConvertTo-Json -Compress)

$bkAfter = @()
if (Test-Path $backupDir) { $bkAfter = @(Get-ChildItem $backupDir -Filter '档案-删除前*' -File | ForEach-Object { $_.Name }) }
$bkNew = @($bkAfter | Where-Object { $bkBefore -notcontains $_ })
Write-Host ("  动手后：" + ($bkAfter -join ' / '))
Write-Host ("  新写的那份：" + $(if (@($bkNew).Count) { @($bkNew) -join ' / ' } else { '(没有新的！)' }))
$bkHit = $false; $bkText = ''
foreach ($nm in @($bkNew)) {
  $raw = Get-Content (Join-Path $backupDir $nm) -Raw -Encoding UTF8
  if ($raw -like "*$UNDO_TEXT*" -and $raw -like "*$($undoMade.id)*") { $bkHit = $true; $bkText = $nm }
}
# 判据是"有没有**新写的**"：文件名字典里出现了新成员（满了会"加一份挤掉一份"，**不许数份数**）
$bkLate = @(Get-ChildItem $backupDir -Filter '档案-删除前*' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $startStamp })
Check '#45 ★★ 真删之前**留了档**：`backups/` 里出现了**新写的**「档案-删除前」一份，而且里面就是被删那条（id + 正文都在）' (@($bkNew).Count -gt 0 -and $bkHit) ("新写的=" + $(if (@($bkNew).Count) { @($bkNew) -join ' , ' } else { '(按名字没看出来)' }) + "；本轮新写入时间戳的份数=" + @($bkLate).Count + "；命中被删那条=" + $bkHit + " " + $bkText)

# ═════════════════════════ §9 收尾 ═════════════════════════
Write-Host ""
Write-Host "=== §9 【必验⑨】收尾（开关关回去 + 删净自己的 + 用户数据逐条核对）==="

Step '22 真实鼠标点开关 → 先关掉（入口该消失、数据还在；收尾再还原成开工值）'
$offPre = EvalJson @"
(async()=>{
$H2
  await closeDialogs();
  await setPage();
  const t=toggleEl();
  return JSON.stringify({toggle:!!t, checked:t?t.checked:null, reveal:!!revealEl(), pt:t?centerOf(t):null, navArchive:navHas('档案库')});
})()
"@
Write-Host ("  关之前：" + ($offPre | ConvertTo-Json -Compress))
Write-Host (ClickCoords $offPre.pt '「启用档案区」开关')
Start-Sleep -Milliseconds 1300
$offPost = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  const t=toggleEl();
  const arch=await inv('archive_list');
  return JSON.stringify({enabled:cfg.archive.enabled, checked:t?t.checked:null,
    navArchive:navHas('档案库'), navLabels:Array.from(document.querySelectorAll('nav button')).map(b=>(b.innerText||'').replace(/\s+/g,'')).join('/'),
    archItems:arch.length});
})()
"@
Write-Host ("  关之后：" + ($offPost | ConvertTo-Json -Compress))
Check '#46 ★ 真实鼠标点开关 → `archive.enabled=false`（checkbox 也取消勾选）' ($offPre -and $offPre.toggle -and $offPre.checked -eq $true -and $offPost -and $offPost.enabled -eq $false -and $offPost.checked -eq $false) ($offPost | ConvertTo-Json -Compress)
Check '#47 ★ 关掉之后侧栏「档案库」入口**消失**了（用户划的形态；数据文件不删 —— 不是 bug）' ($offPost -and $offPost.navArchive -eq $false) ("侧栏=" + $(if ($offPost) { $offPost.navLabels } else { '?' }))

Step '23 删净自己造的（档案 / 待办 / 信息 / 笔记 + 回收站与档案目录里的残留），并逐条核对用户数据'
$fix = EvalJson @"
(async()=>{
$H2
  // 先删档案里的（自己前缀），再删原位的；待办先删，免得删笔记时被标成"来源已移除"
  const arch=(await inv('archive_list')).filter(a=>/^M15 /.test(a.title||''));
  for(const a of arch){ try{ await inv('archive_delete',{id:a.id}); }catch(e){} }
  for(const t of (await inv('todo_list')).filter(t=>/^M15 /.test(t.title||''))){ try{ await inv('todo_delete',{id:t.id}); }catch(e){} }
  for(const i of (await inv('info_list')).filter(i=>/^M15 /.test(i.text||''))){ try{ await inv('info_delete',{id:i.id}); }catch(e){} }
  for(const n of (await inv('note_list')).filter(n=>/^M15 /.test(n.title||''))){ try{ await inv('note_delete',{id:n.id}); }catch(e){} }
  await sl(1500);
  await closeDialogs();
  // 🔴 2026-10-21：把「启用档案区」还原成**开工前的值**（用户原本开着就别给他关掉）
  const cfgFix=await inv('config_get');
  const want=$($archBefore.ToString().ToLower());
  if(!!(cfgFix.archive&&cfgFix.archive.enabled)!==want){
    cfgFix.archive={enabled:want};
    await inv('config_save',{config:cfgFix});
    await sl(900);
  }
  const notes=await inv('note_list'); const todos=await inv('todo_list');
  const infos=await inv('info_list'); const cfg=await inv('config_get'); const archLeft=await inv('archive_list');
  return JSON.stringify({leftArch:archLeft.filter(a=>/^M15 /.test(a.title||'')).map(a=>a.title),
    archAll:archLeft.length,
    leftTodos:todos.filter(t=>/^M15 /.test(t.title||'')).map(t=>t.title),
    leftInfos:infos.filter(i=>/^M15 /.test(i.text||'')).map(i=>(i.text||'').slice(0,20)),
    leftNotes:notes.filter(n=>/^M15 /.test(n.title||'')).map(n=>n.title),
    enabled:cfg.archive.enabled,
    users:todos.filter(t=>!/^M15 /.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length,rm:!!(t.source&&t.source.sourceRemoved)})),
    notes:notes.filter(n=>!/^M15 /.test(n.title||'')).map(n=>({id:n.id,title:n.title,kind:n.kind,group:n.group,content:n.content})),
    infos:infos.filter(i=>!/^M15 /.test(i.text||'')).map(i=>({id:i.id,text:i.text})),
    cfgAll:{theme:cfg.theme, uiFont:cfg.uiFont, bodyFont:cfg.bodyFont, fontSize:cfg.fontSize, backupKeep:cfg.backupKeep,
      shortcuts:cfg.shortcuts, reminders:cfg.reminders, homeSticky:cfg.homeSticky,
      window:{smallPosition:cfg.window.smallPosition, smallMouseOffset:cfg.window.smallMouseOffset, closeToTray:cfg.window.closeToTray}}});
})()
"@
Write-Host ("  收尾：" + ($fix | ConvertTo-Json -Compress -Depth 4))
Check '#48 ★ 自己造的 `M15 ` 数据清干净了（档案 / 待办 / 信息 / 笔记 四边都一条不剩）' ($fix -and @($fix.leftArch).Count -eq 0 -and @($fix.leftTodos).Count -eq 0 -and @($fix.leftInfos).Count -eq 0 -and @($fix.leftNotes).Count -eq 0) ("剩 档案 " + (@($fix.leftArch) -join '/') + " 待办 " + (@($fix.leftTodos) -join '/') + " 信息 " + (@($fix.leftInfos) -join '/') + " 笔记 " + (@($fix.leftNotes) -join '/'))
Check ('#49 ★ `archive.enabled` 收尾**还原成开工前的值**（开工时是 ' + $archBefore + '），且档案库里没有留下自己的条目') ($fix -and "$($fix.enabled)" -eq "$archBefore" -and [int]$fix.archAll -eq $archBase) ("enabled=" + $(if ($fix) { $fix.enabled } else { '?' }) + " / 开工 " + $archBefore + " archive 剩 " + $(if ($fix) { $fix.archAll } else { '?' }) + " 条（开工时就有 " + $archBase + " 条）")

# 笔记文件：notes/ 与 notes/_archive/ 两边都不该留下我这篇
$noteLeft = @()
$archLeft = @()
foreach ($dir in @((Join-Path $DATA 'notes'), (Join-Path $DATA 'notes\_archive'), (Join-Path $DATA 'notes\_trash'))) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Filter '*.json' -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $t = ''
    try { $t = ((Get-Content $_.FullName -Raw -Encoding UTF8) | ConvertFrom-Json).title } catch { }
    if ("$t" -like 'M15 *') {
      if ($_.DirectoryName -like '*_archive') { $archLeft += $t } elseif ($_.DirectoryName -like '*_trash') { $noteLeft += ("回收站:" + $t) } else { $noteLeft += $t }
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      if (Test-Path "$($_.FullName).bak") { Remove-Item "$($_.FullName).bak" -Force -ErrorAction SilentlyContinue }
    }
  }
}
Write-Host ("  笔记文件残留（已清）：" + $(if (@($noteLeft).Count) { @($noteLeft) -join ' / ' } else { '(无)' }) + "；档案目录残留（已清）：" + $(if (@($archLeft).Count) { @($archLeft) -join ' / ' } else { '(无)' }))
# 清完再扫一遍：三个目录里都不许再有 `M15 ` 前缀的笔记文件（**用户自己那几篇一个都不许动**）
$m15Left = @()
foreach ($dir in @((Join-Path $DATA 'notes'), (Join-Path $DATA 'notes\_archive'), (Join-Path $DATA 'notes\_trash'))) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Filter '*.json' -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $t = ''
    try { $t = ((Get-Content $_.FullName -Raw -Encoding UTF8) | ConvertFrom-Json).title } catch { }
    if ("$t" -like 'M15 *') { $m15Left += ($_.Directory.Name + '/' + $t) }
  }
}
$userNoteFiles = @()
foreach ($dir in @((Join-Path $DATA 'notes'), (Join-Path $DATA 'notes\_archive'))) {
  if (-not (Test-Path $dir)) { continue }
  $userNoteFiles += @(Get-ChildItem $dir -Filter '*.json' -File | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object { $_.Name })
}
Write-Host ("  再扫一遍 `M15 ` 前缀的笔记文件：" + $(if (@($m15Left).Count) { @($m15Left) -join ' / ' } else { '(无)' }) + "；notes 里剩下的文件：" + (@($userNoteFiles) -join ' / '))
Check '#50 ★ `notes/` / `notes/_archive/` / `notes/_trash/` 里都不留 `M15 ` 前缀的笔记文件（用户自己的笔记文件照旧在）' (@($m15Left).Count -eq 0) ("还剩 " + (@($m15Left) -join ' / '))

$uBase = (@($usersBase) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)|$($_.rm)" }) -join ' ; '
$uEnd = (@($fix.users) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)|$($_.rm)" }) -join ' ; '
Check ('#51 ★★ 你的 ' + $usersBase.Count + ' 条待办一条没动（逐条按 id + 标题 + 状态 + 番茄数 + sourceRemoved 核对）') ($fix -and $uBase -eq $uEnd -and $usersBase.Count -eq @($fix.users).Count) ("开工 " + $usersBase.Count + " 条 / 收尾 " + @($fix.users).Count + " 条")
$nBase = (@($notesBase) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.kind)|$($_.group)|$($_.content)" }) -join ' ; '
$nEnd = (@($fix.notes) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.kind)|$($_.group)|$($_.content)" }) -join ' ; '
Check ('#52 ★★ 你的 ' + $notesBase.Count + ' 篇笔记一条没动（逐条按 id + 标题 + 类型 + 分组 + 正文逐字核对）') ($fix -and $nBase -eq $nEnd -and $notesBase.Count -eq @($fix.notes).Count) ("开工 " + $notesBase.Count + " 篇 / 收尾 " + @($fix.notes).Count + " 篇")
$iBase = (@($pre.infos) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.text)" }) -join ' ; '
$iEnd = (@($fix.infos) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.text)" }) -join ' ; '
Check ('#53 ★ 你的信息区也没动（开工 ' + @($pre.infos).Count + ' 条 / 收尾 ' + @($fix.infos).Count + ' 条，逐条按 id + 正文核对）') ($fix -and $iBase -eq $iEnd -and @($pre.infos).Count -eq @($fix.infos).Count) ("开工 " + @($pre.infos).Count + " / 收尾 " + @($fix.infos).Count)
$endCfg = ($fix.cfgAll | ConvertTo-Json -Depth 8 -Compress)
Check '#54 别的设置（主题 / 字号 / 快捷键 / 提醒 / 首页卡片 / 小窗那几项）与开工时一模一样' ($fix -and $baseCfg -eq $endCfg -and [bool]$endCfg) ("开工 " + $baseCfg)
# ⚠️ 2026-10-06 改：这条原来写死"用户数据里**本来就有一条** `sourceRemoved=true` 的待办（`1高数复习，紧`）"当金丝雀，
#    可那条待办后来不存在了（现在那条同名的是 manual 来源）→ **断言写死了用户数据的样子 = 假红**
#    （第五节那条教训：别在断言里写死"用户数据长什么样"）。
#    改成**自己前后比对**：开工时有哪些 `sourceRemoved=true` 的，收尾时必须一条不少、id 也一致。
$rmBase = @($usersBase | Where-Object { $_.rm -eq $true })
$rmKept = @($fix.users | Where-Object { $_.rm -eq $true })
$rmBaseIds = (@($rmBase) | Sort-Object id | ForEach-Object { $_.id }) -join ' ; '
$rmKeptIds = (@($rmKept) | Sort-Object id | ForEach-Object { $_.id }) -join ' ; '
Check ('#55 ★ `sourceRemoved=true` 的待办一条没少（开工 ' + @($rmBase).Count + ' 条 / 收尾 ' + @($rmKept).Count + ' 条）—— 证明本轮**没有**跑 `todo_purge_removed`（跑了就会把它们删掉）') ($rmBaseIds -eq $rmKeptIds) ("开工：" + $(if ($rmBaseIds) { $rmBaseIds } else { '(无)' }) + " / 收尾：" + $(if ($rmKeptIds) { $rmKeptIds } else { '(无)' }))

# 最终的残留弹窗检查（收工前一定要干净，否则下一轮的第一步会被吃掉点击）
$finalDialogs = EvalJson @"
(async()=>{
$H2
  const d=await closeDialogs();
  return JSON.stringify({dialogs:d, navArchive:navHas('档案库'),
    reveal:!!revealEl(), toggle:!!toggleEl()});
})()
"@
Write-Host ("  收工前：" + ($finalDialogs | ConvertTo-Json -Compress))
Check '#56 ★ 收工时页面上没有残留弹窗（下一轮第一步不会被吃掉点击）' ($finalDialogs -and [int]$finalDialogs.dialogs -eq 0) ($finalDialogs | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "======================"
Write-Host ("M15 隐藏档案库（默认没入口 + 收/取/改/删）：通过 " + $pass + "，失败 " + $fail)
if ($fail -gt 0) { exit 1 }
