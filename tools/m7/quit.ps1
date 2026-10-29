# M7 · PRD 10.8-3 后半：真的点「退出」→ 程序**真的**退出
#
# ⚠️ 这个脚本会把应用关掉（这正是它要验的事），所以单独一个文件，
#    而且必须放在最后跑：跑完要重新 `npm run tauri dev`，
#    再跑 `tools\m7\after-restart.ps1`，才凑齐 PRD 说的
#    「点 quit → 二次确认 → 退出；**再次打开数据完整**」。
#
# 为什么不"意思一下"就算了：quit 走的是 Rust 侧 `app.exit(0)`。
# 「点了没反应」在界面上和「退出了」长得一模一样
# （M6 真踩过：命令是同步 fn、在主线程上等窗口，整块卡死，点什么都像没反应），
# 所以只有**看到进程真的消失**才算验过。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\quit.ps1
param([int]$Port = 9222, [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7quit-" + [guid]::NewGuid().ToString("N") + ".js")
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

Write-Host "=== PRD 10.8-3：点 quit → 二次确认 → 真的退出 ==="

$before = @(Get-Process notes-app -ErrorAction SilentlyContinue)
Check '  退出之前应用是活着的（记下进程号）' ($before.Count -ge 1) ("进程数 " + $before.Count)
$pids = ($before | ForEach-Object { $_.Id }) -join ','
Write-Host ("  notes-app.exe 进程号：{0}" -f $pids)

# 退出前先记一笔数据，好让"再次打开数据完整"有据可查
$markText = "M7 退出前留痕 " + (Get-Date -Format 'HHmmss')
$marked = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_create',{text:'$markText',kind:'text',categories:[],assetPath:null}).then(function(v){return JSON.stringify({id:v.id,text:v.text});})")
Check '  退出前录了一条信息（重启后要复查它还在）' ([bool]$marked.id) ($marked | ConvertTo-Json -Compress)

# ★ 退出之前把**当前数据存一份快照**（信息/笔记/待办/设置）。
#   `after-restart.ps1` 读它来一条条比对 —— 这样"重启后数据完整"就永远是**前后对比**，
#   而不是拿一份写死的旧快照去比（原来那份是 2026-09-20 的，用户后来改了名、删了东西，
#   于是整段变成假红：2026-09-21 全量回归里"通过 2，失败 6"看着像数据丢了）。
$snapPath = Join-Path $env:TEMP 'moyetang-restart-snapshot.json'
$snap = EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const infos=await inv('info_list');
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const cfg=await inv('config_get');
  return JSON.stringify({
    at:new Date().toISOString(),
    infos: infos.map(function(i){return {id:i.id, text:(i.text||'').slice(0,24)};}),
    // 笔记除了标题，还比 **分组**（M8-A）—— "重启后分组还在"就是靠这一条验的
    notes: notes.map(function(n){return {id:n.id, title:n.title, kind:n.kind, group:n.group||''};}),
    // 待办除了标题/状态，还比 M9 那几样：截止日期、设定时间、重复规则、子任务条数
    todos: todos.map(function(t){return {id:t.id, title:t.title, status:t.status,
      dueAt:t.dueAt||'', plannedAt:t.plannedAt||'', repeat:t.repeat||'',
      subtasks:(t.subtasks||[]).length, subtasksDone:(t.subtasks||[]).filter(function(s){return s.done;}).length};}),
    theme: cfg.theme, fontSize: cfg.fontSize,
    homeSticky: cfg.homeSticky,
    smallKey: cfg.shortcuts.toggleSmallWindow,
  });
})()
"@
if ($snap) {
  # ⚠️ 一律用 `UTF8Encoding($false)`（不带 BOM）写 JSON —— PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
  #    ConvertFrom-Json 读得动，但别的工具（serde_json）读不动，统一规矩省得踩。
  [System.IO.File]::WriteAllText($snapPath, $snap, (New-Object System.Text.UTF8Encoding($false)))
  $snapCounts = J $snap
  Check '★ 退出前把数据快照留好了（重启后拿它一条条比对）' (Test-Path $snapPath) ("$snapPath：信息 " + $snapCounts.infos.Count + " / 笔记 " + $snapCounts.notes.Count + " / 待办 " + $snapCounts.todos.Count)
} else {
  Check '★ 退出前把数据快照留好了（重启后拿它一条条比对）' $false "取快照失败"
}

# ⚠️ 点"退出"会让进程当场消失 —— 如果直接等 eval 的返回值，很可能永远等不到。
#    所以让页面 **400ms 后再点**，脚本先拿到"已安排"的答复再走。
$scheduled = J (EvalMain @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  for(let i=0;i<3 && document.querySelector('[role="dialog"]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  const nav=B().find(b=>(b.innerText||'').indexOf('首页')>=0||b.getAttribute('title')==='首页');
  if(nav){ nav.click(); await sl(900); }
  const quit=B().find(b=>(b.innerText||'').indexOf('quit')>=0||b.getAttribute('title')==='退出程序');
  if(!quit) return JSON.stringify({error:'界面上找不到 quit 入口'});
  quit.click();
  await sl(700);
  const dlg=document.querySelector('[role="dialog"]');
  if(!dlg) return JSON.stringify({error:'点了 quit 没有二次确认弹窗'});
  const ok=B().find(b=>(b.innerText||'').trim()==='退出');
  if(!ok) return JSON.stringify({error:'确认框里没有「退出」按钮'});
  setTimeout(function(){ ok.click(); }, 400);
  return JSON.stringify({scheduled:true, dialogTitle:(dlg.innerText||'').split('\n')[0].trim()});
})()
'@)
Check '  二次确认里点了「退出」' ([bool]$scheduled.scheduled) ($scheduled.error)
Write-Host ("  确认框写的是：「{0}」" -f $scheduled.dialogTitle)

$gone = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (@(Get-Process notes-app -ErrorAction SilentlyContinue).Count -eq 0) { $gone = $true; break }
}
Check '★ 进程真的消失了（不是"点了没反应"）' $gone ("等了 $($i + 1) 秒还在：" + ((@(Get-Process notes-app -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) -join ','))

Write-Host ""
Write-Host ("  退出前留的那条信息是：「{0}」（id={1}）" -f $markText, $marked.id)
Write-Host "  下一步：重新 npm run tauri dev，再跑 tools\m7\after-restart.ps1 验「再次打开数据完整」"
Write-Host ""
Write-Host "======================"
Write-Host ("PRD 10.8-3 真退出：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
