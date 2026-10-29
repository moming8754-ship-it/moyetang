# M9 · **真实输入**验收（键盘 / 鼠标）
#
# 为什么单开一个：M9 那七项里有几个交互是"**打字 + 回车**"——
# 快捷语法（M9-9）和子任务输入框（M9-2）。这类东西用 `dispatchEvent` 合成事件验**会假绿**：
# 合成事件绕过输入法、绕过浏览器的输入管线，React 的 `onChange`/`onKeyDown` 照样被触发，
# 但真实打字时可能完全是另一回事（M4 就栽在"合成 dblclick 全绿、真双击用不了"上）。
#
# 所以这里一律走 **CDP 的真实输入通道**：
#   - 打字：`cdp.ps1 -Action type -Selector … -Text …`（`Input.insertText`，进真实输入管线）
#   - 回车：同一个命令的 `-Enter`（`Input.dispatchKeyEvent`，rawKeyDown/char/keyUp 三连）
#   - 点击：`cdp.ps1 -Action mouse -Selector … -Clicks 1`（真的按下/抬起鼠标）
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -ExecutionPolicy Bypass -File tools\m9\realgesture.ps1
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\tools\m9
$tools = Split-Path -Parent $here                             # …\tools
$cdp = Join-Path $tools 'cdp.ps1'

# ⚠️ 用**子进程**调 cdp.ps1（5.1 下 `$out = & 别的.ps1` 的输出捕获行为不一样，M4 实测捕到空值）
function Eval([string]$js) {
  $tmp = Join-Path $env:TEMP ("m9-rg-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle '东方摩耶堂' -RequireSelector 'nav' 2>&1
    return (($out | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}

<#
  真实输入（键盘 / 鼠标）。
  ⚠️ `cdp.ps1` 找不到元素时是 `throw`，而本脚本 `$ErrorActionPreference = 'Stop'` ——
     不包一层的话，一次"元素不在"就把整场验收掀掉、连成绩行都不打（M5 手势脚本踩过）。
     这里把异常和 stderr 都收成返回值，交给调用方断言。
#>
function Drive([string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & powershell -NoProfile -File $cdp @argv 2>&1
    $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
    if ($errs.Count -gt 0) { return ("ERROR: " + (($errs -join ' ') -replace '\s+', ' ')) }
    return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
  } catch {
    return ("ERROR: " + $_.Exception.Message)
  } finally {
    $ErrorActionPreference = $prev
  }
}
function TypeInto([string]$sel, [string]$text, [switch]$Enter) {
  $argv = @('-Action', 'type', '-Selector', $sel, '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav')
  if ($text) { $argv += @('-Text', $text) }
  if ($Enter) { $argv += '-Enter' }
  return (Drive $argv)
}
function RealClick([string]$sel) {
  return (Drive @('-Action', 'mouse', '-Selector', $sel, '-Clicks', '1', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
}
function J([string]$json) { return ($json | ConvertFrom-Json) }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}

$stamp = Get-Date -Format 'HHmmss'

# ─────────────────────────── 准备 ───────────────────────────
Write-Host "=== 准备：清弹窗、进执行区、清掉上次残留 ==="
$prep = J (Eval @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<4 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sl(250);
  }
  // 清掉上一次跑剩的 M9 手势* 待办（脚本崩在中途时收尾跑不到）
  let cleaned=0;
  for(const t of await inv('todo_list')){ if(/^M9 手势/.test(t.title||'')){ await inv('todo_delete',{id:t.id}); cleaned++; } }
  let tries=0, input=null;
  while(tries<12 && !input){
    tries++;
    const nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区');
    if(nav){ nav.click(); await sl(700); }
    input=document.querySelector('[data-todo-new-input]');
    if(!input) await sl(400);
  }
  return JSON.stringify({cleaned:cleaned, tries:tries, ready:!!input,
    dialogLeft:!!document.querySelector('[role="dialog"]')});
})()
'@)
if (-not $prep.ready) { Write-Host "  执行区没渲染出来（连不上应用？）"; exit 1 }
Write-Host ("  清掉残留 {0} 条；执行区就绪（重试 {1} 次）" -f $prep.cleaned, $prep.tries)
Check '★ 前置：屏幕上没有残留弹窗（它会吃掉所有真实鼠标输入）' (-not $prep.dialogLeft)

# ─────────────────── ① 真实键盘打字 → 快捷语法实时回显 ───────────────────
Write-Host ""
Write-Host "=== ① 真实键盘往「加一条」里敲快捷语法 ==="
$typed = TypeInto '[data-todo-new-input]' 'M9 手势-快捷 !明天'
Write-Host ("  " + $typed)
Check '  真实键盘敲进去了（没有报错）' ($typed -notmatch '^ERROR') ($typed)

Start-Sleep -Milliseconds 500
$hint = J (Eval @'
JSON.stringify((function(){
  const box=document.querySelector('[data-todo-new-input]');
  const h=document.querySelector('[data-quick-hint]');
  return {value:box?box.value:'', hint:h?(h.innerText||'').replace(/\n/g,' '):'', at:h?h.getAttribute('data-quick-hint-time'):''};
})())
'@)
$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
Check '★ 真实打字之后输入框里是完整的原文' ($hint.value -eq 'M9 手势-快捷 !明天') ($hint.value)
Check '★ **真实键盘输入**也触发了实时回显（React onChange 真的收到了）' ([bool]$hint.hint) ($hint.hint)
Check '  回显里解析出的时间就是明天' ([bool]($hint.at -like "$tomorrow*")) ("$($hint.at) / 期望 $tomorrow")

# ─────────────────── ② 真实回车 → 建出待办（标题干净、时间对） ───────────────────
Write-Host ""
Write-Host "=== ② 真实回车（不是合成 keydown） → 待办建出来 ==="
$entered = TypeInto '[data-todo-new-input]' '' -Enter
Write-Host ("  " + $entered)
Check '  真实回车送进去了（没有报错）' ($entered -notmatch '^ERROR') ($entered)
Start-Sleep -Milliseconds 1200

$made = J (Eval @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const all=await inv('todo_list');
  const hit=all.filter(function(t){return (t.title||'').indexOf('M9 手势-快捷')===0;});
  const t=hit[0]||{};
  const d=t.plannedAt?new Date(t.plannedAt):null;
  const p=n=>String(n).padStart(2,'0');
  return JSON.stringify({count:hit.length, id:t.id||'', title:t.title||'', plannedAt:t.plannedAt||'',
    localDate:d?(d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())):'',
    inputLeft:(document.querySelector('[data-todo-new-input]')||{}).value||''});
})()
'@)
Check '★ 真实回车之后待办真的建出来了（而且只建了一条）' ($made.count -eq 1) ("建了 " + $made.count + " 条")
Check '★ 标题里没有 "!明天"' ($made.title -eq 'M9 手势-快捷') ($made.title)
Check '★ 设定时间落到了明天' ($made.localDate -eq $tomorrow) ("$($made.plannedAt) → $($made.localDate)")
Check '  建完之后输入框清空了' ($made.inputLeft -eq '') ("left='" + $made.inputLeft + "'")

# ─────────────────── ③ 真实鼠标开 ⚙ + 真实键盘加子任务 ───────────────────
Write-Host ""
Write-Host "=== ③ 真实鼠标点 ⚙ → 真实键盘敲一条子任务 → 真实回车 ==="
$sub = J (Eval "window.__TAURI_INTERNALS__.invoke('todo_create',{title:'M9 手势-子任务 $stamp'}).then(function(t){return JSON.stringify({id:t.id});})")
Start-Sleep -Milliseconds 900
$gear = RealClick "[data-todo-gear='$($sub.id)']"
Start-Sleep -Milliseconds 900
$opened = J (Eval "JSON.stringify({open:!!document.querySelector('[data-subtask-input]')})")
Check '★ 真实鼠标点 ⚙ 能打开设置面板' ([bool]$opened.open) ($gear)

if ($opened.open) {
  $ok = TypeInto '[data-subtask-input]' '真实键盘敲的一步' -Enter
  Write-Host ("  " + $ok)
  Check '  真实键盘敲子任务没报错' ($ok -notmatch '^ERROR') ($ok)
  Start-Sleep -Milliseconds 1200

  $subState = J (Eval @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const t=(await inv('todo_list')).filter(function(x){return x.id==='$($sub.id)';})[0]||{};
  const subs=t.subtasks||[];
  const first=subs[0]||{};
  const box=first.id?document.querySelector('[data-subtask-check="'+first.id+'"]'):null;
  return JSON.stringify({count:subs.length, text:first.text||'', done:!!first.done,
    id:first.id||'', hasCheckbox:!!box});
})()
"@)
  Check '★ 真实回车把子任务加上了（走的是输入框的 Enter）' ($subState.count -eq 1) ("子任务 " + $subState.count + " 条")
  Check '  子任务的文字就是真实敲进去的那串' ($subState.text -eq '真实键盘敲的一步') ($subState.text)

  # ④ 真实鼠标勾子任务
  if ($subState.hasCheckbox) {
    $clicked = RealClick "[data-subtask-check='$($subState.id)']"
    Start-Sleep -Milliseconds 1000
    $toggled = J (Eval "window.__TAURI_INTERNALS__.invoke('todo_list').then(function(ts){var t=ts.filter(function(x){return x.id==='$($sub.id)';})[0]||{};var s=(t.subtasks||[])[0]||{};return JSON.stringify({done:!!s.done});})")
    Check '★ 真实鼠标点一下子任务的勾选框 → 磁盘上 done=true' ([bool]$toggled.done) ("$clicked / done=" + $toggled.done)
  } else {
    Check '★ 真实鼠标点一下子任务的勾选框 → 磁盘上 done=true' $false '⚙ 里没有子任务的勾选框'
  }
}

# ─────────────────── ⑤ 收尾 ───────────────────
Write-Host ""
Write-Host "=== 收尾：清掉这一轮造的 M9 手势* 待办 ==="
[void](Eval @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  for(let i=0;i<4 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sl(250);
  }
  return 'ok';
})()
'@)
$clean = J (Eval @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  let n=0;
  for(const t of await inv('todo_list')){ if(/^M9 /.test(t.title||'')){ await inv('todo_delete',{id:t.id}); n++; } }
  const left=(await inv('todo_list')).map(function(t){return t.title;});
  return JSON.stringify({removed:n, left:left});
})()
'@)
Write-Host ("  删掉 {0} 条测试待办" -f $clean.removed)
Check '★ 用户自己的待办一条没动' (-not [bool](@($clean.left) | Where-Object { $_ -match '^M9 ' })) (($clean.left) -join ' / ')

Write-Host ""
Write-Host "======================"
Write-Host ("M9 真实输入：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
