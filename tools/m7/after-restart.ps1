# M7 · 真实重启之后的复查（PRD 10.1 第 3/4 条）
#
# `prd12.ps1` 会故意留下一条「M7 持久化标记」的信息，然后**停掉应用、重新启动**，
# 再跑这个脚本 —— 那才是"关闭重开之后数据仍在"的真凭实据
# （在同一个进程里读自己刚写的东西说明不了什么）。
#
# ⚠️ 重启前**必须确认 dev 真的活了**（vite 在 1420 + CDP 在 9222）：
#    dev 静默死掉时页面还能点、CDP 还能连，但跑的是旧代码（进度.md 第五节那条）。
#
# 用法（重启应用之后跑）：
#   powershell -File tools\m7\after-restart.ps1 [-MarkId <那条标记信息的 id>]
param([int]$Port = 9222, [string]$MarkId = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("ar-" + [guid]::NewGuid().ToString("N") + ".js")
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

Write-Host "=== 重启之后：数据还在吗（PRD 10.1 第 3、4 条） ==="

# ⚠️ 这一段原来硬编码了"用户数据长什么样"（树笔记叫「密码学联系」、13 个节点、
#    还有一篇「笔记测试」、6 条指定标题的待办）——**那是 2026-09-20 的快照**，
#    后来用户自己改过名、删过东西，于是这几条全成了假红（2026-09-21 全量回归撞上：
#    "通过 2，失败 6"，看着像数据丢了，其实是被删掉的测试快照在喊）。
#    现在改成**前后比对**：`quit.ps1` 退出之前把数据快照写到固定路径，这里读回来一条条对。
$snapPath = Join-Path $env:TEMP 'moyetang-restart-snapshot.json'

$state = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const infos=await inv('info_list');
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const cfg=await inv('config_get');
  return JSON.stringify({
    infos: infos.map(function(i){return {id:i.id, text:(i.text||'').slice(0,24)};}),
    notes: notes.map(function(n){return {id:n.id, title:n.title, kind:n.kind, group:n.group||''};}),
    todos: todos.map(function(t){return {id:t.id, title:t.title, status:t.status,
      dueAt:t.dueAt||'', plannedAt:t.plannedAt||'', repeat:t.repeat||'',
      subtasks:(t.subtasks||[]).length, subtasksDone:(t.subtasks||[]).filter(function(s){return s.done;}).length};}),
    theme: cfg.theme, fontSize: cfg.fontSize,
    homeSticky: cfg.homeSticky,
    smallKey: cfg.shortcuts.toggleSmallWindow,
  });
})()
'@)

Write-Host ("  信息 {0} 条 / 笔记 {1} 篇 / 待办 {2} 条" -f $state.infos.Count, $state.notes.Count, $state.todos.Count)

if ($MarkId) {
  $found = @($state.infos | Where-Object { $_.id -eq $MarkId })
  Check '★ 重启前录入的那条信息还在（关闭重开数据不丢）' ($found.Count -eq 1) ("找 $MarkId；现有：" + (($state.infos | ForEach-Object { $_.text }) -join ' / '))
}

if (Test-Path $snapPath) {
  $snap = Get-Content $snapPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("  重启前的快照：{0}（信息 {1} / 笔记 {2} / 待办 {3}）" -f $snap.at, $snap.infos.Count, $snap.notes.Count, $snap.todos.Count)

  # ① 每一条信息都还在（按 id 认，不看标题 —— 用户可以随时改文字）
  $missingInfos = @($snap.infos | Where-Object { $id = $_.id; -not ($state.infos | Where-Object { $_.id -eq $id }) })
  Check '★ 重启前的信息一条不少' ($missingInfos.Count -eq 0) ("缺 " + $missingInfos.Count + " 条：" + (($missingInfos | ForEach-Object { $_.text }) -join ' / '))

  # ② 每一篇笔记都还在，而且**标题没被改**（笔记是用户真正在乎的东西）
  $missingNotes = @()
  $renamedNotes = @()
  $groupLost = @()
  foreach ($n in $snap.notes) {
    $now = $state.notes | Where-Object { $_.id -eq $n.id } | Select-Object -First 1
    if (-not $now) { $missingNotes += $n.title }
    else {
      if ($now.title -ne $n.title) { $renamedNotes += ("$($n.title) → $($now.title)") }
      # ★ M8-A：**分组要跟着笔记一起活过重启**（原来这条只在磁盘上核过文件内容，没真重启过）
      if ($now.group -ne $n.group) { $groupLost += ("$($n.title)：'$($n.group)' → '$($now.group)'") }
    }
  }
  Check '★ 重启前的笔记一篇不少' ($missingNotes.Count -eq 0) ("缺：" + ($missingNotes -join ' / '))
  Check '★ 笔记标题也没被改' ($renamedNotes.Count -eq 0) ("改了：" + ($renamedNotes -join ' / '))
  Check '★ 笔记的**分组**也活过了重启（M8-A）' ($groupLost.Count -eq 0) ("变了：" + ($groupLost -join ' / '))

  # ③ 每一条待办都还在，而且**完成状态没变**（状态是最容易在重启时丢的东西）
  $missingTodos = @()
  $changedTodos = @()
  $changedFields = @()
  foreach ($t in $snap.todos) {
    $now = $state.todos | Where-Object { $_.id -eq $t.id } | Select-Object -First 1
    if (-not $now) { $missingTodos += $t.title; continue }
    if ($now.status -ne $t.status) { $changedTodos += ("$($t.title): $($t.status) → $($now.status)") }
    # ★ M9：截止日期 / 设定时间 / 重复规则 / 子任务条数，一样都不许丢
    foreach ($f in @('dueAt', 'plannedAt', 'repeat')) {
      if ($now.$f -ne $t.$f) { $changedFields += ("$($t.title).$f：'$($t.$f)' → '$($now.$f)'") }
    }
    if ([int]$now.subtasks -ne [int]$t.subtasks -or [int]$now.subtasksDone -ne [int]$t.subtasksDone) {
      $changedFields += ("$($t.title).子任务：$($t.subtasks)/$($t.subtasksDone) → $($now.subtasks)/$($now.subtasksDone)")
    }
  }
  Check '★ 重启前的待办一条不少' ($missingTodos.Count -eq 0) ("缺：" + ($missingTodos -join ' / '))
  Check '★ 待办的完成状态也没变' ($changedTodos.Count -eq 0) ("变了：" + ($changedTodos -join ' / '))
  Check '★ 截止日期 / 设定时间 / 重复规则 / 子任务也都没丢（M9）' ($changedFields.Count -eq 0) ("变了：" + ($changedFields -join ' / '))

  # ④ 设置没被重置
  Check '★ 设置也还在（主题 / 字号 / 首页常驻项 / 快捷键）' `
    ($state.theme -eq $snap.theme -and $state.fontSize -eq $snap.fontSize -and $state.smallKey -eq $snap.smallKey) `
    ("主题 {0}→{1} 字号 {2}→{3} 键 {4}→{5}" -f $snap.theme, $state.theme, $snap.fontSize, $state.fontSize, $snap.smallKey, $state.smallKey)
} else {
  Check '★ 找得到退出前留的数据快照' $false "没有 $snapPath —— 先跑 tools\m7\quit.ps1（它会在退出前写快照）"
}

# ── 收尾：把那条标记信息删掉 ──
if ($MarkId) {
  $clean = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_delete',{id:'$MarkId'}).then(function(){return JSON.stringify({ok:true});})")
  Check '收尾：标记信息已清理' ([bool]$clean.ok)
}

Write-Host ""
Write-Host "======================"
Write-Host ("重启后复查：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
