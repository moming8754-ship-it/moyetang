# M7 · 备份导出/导入 + 设置收尾 验收
#
# # 为什么导出/导入走命令而不是点界面按钮
# 界面上那两个按钮会弹**系统文件对话框**（`tauri-plugin-dialog`），那是原生窗口、
# 脚本操作不了。所以这里直接调 `backup_export` / `backup_import` ——
# **对话框只负责"选路径"，真正的活儿全在命令里**，命令路径通了功能就是通的。
# 界面元素（按钮在不在、状态显示对不对）单独断言。
#
# # ⚠️ 这个脚本会真的导入一次（= 覆盖数据）
# 但它是**导出 → 改点东西 → 导入回来**的顺序，所以结束时数据回到脚本开始时的样子；
# 而且后端在导入前还会自动留一份 `backups/笔记备份-导入前-*.zip` 作双保险。
# 脚本结尾会核对"笔记数 / 待办数 和开头一致"，对不上就报错。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m7\run.ps1
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\tools\m7
$tools = Split-Path -Parent $here                             # …\tools
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m7-" + [guid]::NewGuid().ToString("N") + ".js")
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

# ─────────────────────────── ① 前置：看清家底 ───────────────────────────
Write-Host "=== ① 前置：记下当前数据规模（结尾要比对） ==="
$before = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const infos=await inv('info_list');
  const info=await inv('app_info');
  return JSON.stringify({
    notes:notes.length, todos:todos.length, infos:infos.length,
    noteTitles:notes.map(n=>n.title), version:info.version, dataDir:info.dataDir,
  });
})()
'@)
Write-Host ("  笔记 {0} 篇 / 待办 {1} 条 / 信息 {2} 条；版本 {3}" -f $before.notes, $before.todos, $before.infos, $before.version)
Check '家底读得出来（笔记数 > 0）' ($before.notes -gt 0) ($before | ConvertTo-Json -Compress)
if ($before.notes -le 0) { Write-Host "  数据是空的，先造点东西再跑这套"; exit 1 }

# ─────────────────────────── ② 关于 / 数据统计 ───────────────────────────
Write-Host ""
Write-Host "=== ② 关于：版本 + 数据统计（PRD §5.5） ==="
$about = J (EvalMain "window.__TAURI_INTERNALS__.invoke('app_info').then(function(v){return JSON.stringify(v);})")
Check '拿得到版本号' ([bool]$about.version) ($about | ConvertTo-Json -Compress)
Check '版本不是全 0 的占位' ($about.version -ne '0.0.0') ($about.version)
Check '★ 信息条数和真实一致' ($about.infoCount -eq $before.infos) ("$($about.infoCount) vs $($before.infos)")
Check '★ 笔记条数和真实一致' ($about.noteCount -eq $before.notes) ("$($about.noteCount) vs $($before.notes)")
Check '★ 待办条数和真实一致' ($about.todoCount -eq $before.todos) ("$($about.todoCount) vs $($before.todos)")
Check '带着数据目录路径' ([bool]$about.dataDir) ($about.dataDir)

# ─────────────────────────── ③ 设置页的三个区块 ───────────────────────────
Write-Host ""
Write-Host "=== ③ 设置页：备份 / 快捷键 / 关于 三个区块 ==="
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
    if(document.querySelector('[data-backup-export]')) break;
    await sl(500);
  }
  return 'ok';
})()
'@)
Start-Sleep -Milliseconds 600
Check '设置页有「导出备份」按钮' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-backup-export]'))")))
Check '设置页有「导入备份」按钮' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-backup-import]'))")))
Check '关于区块显示了版本号' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-about-version]'))")))
Check '关于区块显示了信息条数' ([bool](J (EvalMain "JSON.stringify(!!document.querySelector('[data-about-infos]'))")))
Check '关于区块显示了笔记/待办条数' ((J (EvalMain "JSON.stringify(!!document.querySelector('[data-about-notes]') && !!document.querySelector('[data-about-todos]'))")) -eq $true)
$keyState = J (EvalMain "JSON.stringify((function(){var el=document.querySelector('[data-shortcut-state]');return el?{state:el.getAttribute('data-shortcut-state'),text:el.innerText}:null;})())")
Check '★ 快捷键区块显示了"注册状态"（被占用时用户看得见）' ($null -ne $keyState.state) ($keyState | ConvertTo-Json -Compress)
Check '快捷键有几个候选键按钮' ((J (EvalMain "JSON.stringify(document.querySelectorAll('[data-shortcut-key]').length)")) -ge 3)

# ─────────────────────────── ④ 导出备份 ───────────────────────────
Write-Host ""
Write-Host "=== ④ 导出备份：命令能跑通、zip 真的落盘 ==="
$stamp = Get-Date -Format 'HHmmss'
$dest = Join-Path $env:TEMP ("m7-backup-$stamp.zip")
$exported = J (EvalMain "window.__TAURI_INTERNALS__.invoke('backup_export',{dest:'$($dest -replace '\\','/')'}).then(function(r){return JSON.stringify(r);})")
Check '导出命令返回了结果' ($null -ne $exported.file) ($exported | ConvertTo-Json -Compress)
Check '★ zip 真的写到了指定路径' (Test-Path $dest) ($dest)
if (Test-Path $dest) {
  $size = (Get-Item $dest).Length
  Check '★ zip 不是空文件' ($size -gt 200) ("$size 字节")
  Check '报告里说的文件个数 > 0' ($exported.files -gt 0) ($exported.files)
}

# ─────────────────────────── ⑤ 包内容对不对 ───────────────────────────
Write-Host ""
Write-Host "=== ⑤ 包内容：该带的都在、不该带的不在 ==="
if (-not (Test-Path $dest)) { Write-Host "  没导出成功，跳过"; }
else {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($dest)
  $names = $zip.Entries | ForEach-Object { $_.FullName }
  $zip.Dispose()
  Write-Host ("  条目数 {0}；前几个：{1}" -f $names.Count, (($names | Select-Object -First 4) -join ', '))
  Check '★ 带了 info.jsonl' ([bool]($names -contains 'info.jsonl'))
  Check '★ 带了 todos.json' ([bool]($names -contains 'todos.json'))
  Check '★ 带了 reminders.json' ([bool]($names -contains 'reminders.json'))
  Check '★ 带了 config.json' ([bool]($names -contains 'config.json'))
  Check '★ 带了 notes/ 里的笔记' ([bool]($names | Where-Object { $_ -like 'notes/*.json' }))
  Check '★ 不含回收站 notes/_trash' (-not [bool]($names | Where-Object { $_ -like '*_trash*' }))
  Check '★ 不含 backups/（备份里不装备份）' (-not [bool]($names | Where-Object { $_ -like 'backups/*' }))
  Check '★ 不含 .npm-cache / dist 这类杂物' (-not [bool]($names | Where-Object { $_ -like '*npm-cache*' -or $_ -like 'dist/*' }))
}

# ─────────────────────────── ⑥ 导入：覆盖恢复 ───────────────────────────
Write-Host ""
Write-Host "=== ⑥ 导入备份：恢复而不是合并（先造一条"备份之后新建的"） ==="
$added = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const info=await inv('info_create',{text:'M7 验收：这条是备份之后才建的，导入后应该消失',kind:'text',categories:[],assetPath:null});
  const notes=await inv('note_list');
  return JSON.stringify({infos:notes.length, infoId:info.id});
})()
"@)
$mid = J (EvalMain "window.__TAURI_INTERNALS__.invoke('info_list').then(function(v){return JSON.stringify(v.length);})")
Check '造了一条"备份之后新建的信息"' ($mid -eq ($before.infos + 1)) ("$($before.infos) -> $mid")

$imported = J (EvalMain "window.__TAURI_INTERNALS__.invoke('backup_import',{src:'$($dest -replace '\\','/')'}).then(function(r){return JSON.stringify(r);})")
Check '导入命令返回了结果' ($null -ne $imported.files) ($imported | ConvertTo-Json -Compress)
Check '★ 导入留下了"覆盖前的安全备份"' ([bool]$imported.safetyBackup -and (Test-Path $imported.safetyBackup)) ($imported.safetyBackup)
Check '★ 安全备份不是空文件' ((Test-Path $imported.safetyBackup) -and ((Get-Item $imported.safetyBackup).Length -gt 200))

# 数据要回到导出那一刻
$after = J (EvalMain @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const notes=await inv('note_list');
  const todos=await inv('todo_list');
  const infos=await inv('info_list');
  return JSON.stringify({
    notes:notes.length, todos:todos.length, infos:infos.length,
    noteTitles:notes.map(n=>n.title),
    hasM7Info: infos.some(i=>(i.text||'').indexOf('M7 验收：这条是备份之后')>=0),
  });
})()
'@)
Check '★ 导入后信息条数回到备份那一刻' ($after.infos -eq $before.infos) ("$mid -> $($after.infos)，期望 $($before.infos)")
Check '★ 导入是"恢复"不是"合并"：备份之后新建的那条没了' (-not [bool]$after.hasM7Info)
Check '★ 笔记数也回到备份那一刻' ($after.notes -eq $before.notes) ("$($after.notes) vs $($before.notes)")
Check '★ 待办数也回到备份那一刻' ($after.todos -eq $before.todos) ("$($after.todos) vs $($before.todos)")
$missing = @($before.noteTitles | Where-Object { $after.noteTitles -notcontains $_ })
Check '★ 备份里的每一篇笔记都回来了' ($missing.Count -eq 0) ("缺: " + ($missing -join ', '))

# ─────────────────────────── ⑦ 坏包要被拒绝 ───────────────────────────
Write-Host ""
Write-Host "=== ⑦ 不是备份包的东西要明确报错，不能乱写 ==="
$notZip = Join-Path $env:TEMP ("m7-notzip-$stamp.txt")
Set-Content -Path $notZip -Value "这不是 zip" -Encoding UTF8
$err = EvalMain "window.__TAURI_INTERNALS__.invoke('backup_import',{src:'$($notZip -replace '\\','/')'}).then(function(){return 'NO_ERROR';}).catch(function(e){return 'ERR:'+e;})"
Write-Output ("  " + $err)
Check '★ 拿非 zip 文件去导入会被拒绝并给出原因' ($err -match '^ERR:') $err
Remove-Item $notZip -Force -ErrorAction SilentlyContinue

# 数据没被这个坏包动过
$stillOk = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(v){return JSON.stringify(v.length);})")
Check '★ 坏包没有破坏数据' ($stillOk -eq $before.notes) ("$stillOk vs $($before.notes)")

Write-Host ""
Write-Host "======================"
Write-Host ("M7 备份与设置：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
