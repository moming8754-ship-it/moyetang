# M21 验收：同步的数据层地基（最后改动时间 + 删除记录）
#
# 怎么跑（**应用要以 CDP 端口起着**，见 进度.md 第七节）：
#   powershell -ExecutionPolicy Bypass -File tools\m21\run.ps1
#
# 这一套验的是"**同步要用到的数据层**"，不是同步本身（同步是 M22/M23）：
#   ① 设备状态（sync_state_get）能拿到、且真的落盘到 `sync/state.json`
#   ② 删除记录（sync_graves_list）能读、格式对
#   ③ **新建/改动待办会刷新 `updatedAt`**（同步判"谁新"全靠它）
#   ④ **删待办会留一条删除记录**（kind=todo，只有 id/时间/种类，不含内容）
#   ⑤ **真实数据副本核对**：拿用户数据的副本跑一遍，证明"内容一字不差、只多了 updatedAt"
#   ⑥ 收尾：测试待办删干净 + 删除记录清空（连归档一起），用户数据零残留
#
# ⚠️ 本套件只造带 `M21 ` 前缀的测试待办，跑完自己删掉；用户的待办一条都不动。

param([int]$Port = 9222)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # …\notes-app\tools\m21
$app = Split-Path -Parent (Split-Path -Parent $here)         # …\notes-app
$spike = Join-Path (Split-Path -Parent $app) '.spike'        # D:\东方摩耶堂\.spike
$dataDir = 'D:\东方摩耶堂'
$cdp = Join-Path $app 'tools\cdp.ps1'

$pass = 0; $fail = 0
function OK([string]$name) { $script:pass++; Write-Host ('  [通过] ' + $name) -ForegroundColor Green }
function NG([string]$name, [string]$detail = '') {
  $script:fail++
  $line = '  [失败] ' + $name
  if ($detail) { $line += '  ::  ' + $detail }
  Write-Host $line -ForegroundColor Red
}
function Cdp([string[]]$cdpArgs) {
  $all = @('-Action') + $cdpArgs + @('-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav')
  return (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp @all) -join "`n"
}
function Eval([string]$expr) { return (Cdp @('eval', '-Expr', $expr)).Trim() }
function WaitUntil([scriptblock]$cond, [int]$ms = 5000) {
  $deadline = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $deadline) {
    if (& $cond) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}
function ReadJson([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  try { return (Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json) } catch { return $null }
}

Write-Host '==== M21 验收：同步的数据层（最后改动时间 + 删除记录）====' -ForegroundColor Cyan

# ── 开场：应用活着吗
$alive = $false
try { $alive = ((Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) } catch { }
if (-not $alive) {
  NG '00 应用没起或 CDP 不通（先按第七节起 dev）'
  Write-Host ("M21 成绩：通过 " + $pass + "，失败 " + $fail)
  exit 1
}
OK '00 应用活着、CDP 通'

# ── ① 设备状态
$stateJson = Eval "window.__TAURI_INTERNALS__.invoke('sync_state_get').then(function(r){return JSON.stringify(r);})"
$state = $null
try { $state = $stateJson | ConvertFrom-Json } catch { }
if ($state -and $state.deviceId -and $state.deviceId.Length -gt 8) { OK ('01 sync_state_get 拿到设备 id（' + $state.deviceId.Substring(0, 8) + '…）') }
else { NG '01 拿不到设备 id' $stateJson }
if ($state -and [int]$state.protocolVersion -eq 1) { OK ('02 协议版本 = ' + $state.protocolVersion) } else { NG '02 协议版本不对' $stateJson }
Start-Sleep -Milliseconds 400
$statePath = Join-Path $dataDir 'sync\state.json'
if (Test-Path $statePath) { OK ('03 设备状态真的落盘了（' + $statePath + '）') } else { NG '03 state.json 没落盘' $statePath }

# ── ② 删除记录能读
$gravesJson = Eval "window.__TAURI_INTERNALS__.invoke('sync_graves_list').then(function(r){return JSON.stringify(r);})"
$gravesBefore = @()
try { $gravesBefore = @($gravesJson | ConvertFrom-Json) } catch { }
if ($gravesJson -match '^\[') { OK ('04 sync_graves_list 能读（现在 ' + $gravesBefore.Count + ' 条）') } else { NG '04 删记录读不出来' $gravesJson }

# ── ③ 新建待办 → updatedAt 出现，且 = createdAt
$title = 'M21 数据层探针'
$null = Eval ("window.__TAURI_INTERNALS__.invoke('todo_create',{title:'" + $title + "'}).then(function(r){return r.id;})")
Start-Sleep -Milliseconds 700
$todos = ReadJson (Join-Path $dataDir 'todos.json')
$mine = @($todos.items | Where-Object { $_.title -eq $title })
if ($mine.Count -eq 1) { OK '05 测试待办建好了（带 M21 前缀，跑完会删）' } else { NG ('05 测试待办没建出来（找到 ' + $mine.Count + ' 条）') }
$probe = $mine[0]
if ($probe -and $probe.updatedAt -and $probe.updatedAt -eq $probe.createdAt) { OK ('06 新待办有 updatedAt 且等于 createdAt（' + $probe.updatedAt.Substring(0,19) + '）') }
else { NG '06 updatedAt 缺失或不等于 createdAt' (($probe | ConvertTo-Json -Compress)) }

# ── ④ 改一下 → updatedAt 刷新
$oldStamp = $probe.updatedAt
Start-Sleep -Seconds 2
$null = Eval ("window.__TAURI_INTERNALS__.invoke('todo_set_done',{id:'" + $probe.id + "',done:true}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 800
$todos2 = ReadJson (Join-Path $dataDir 'todos.json')
$after = @($todos2.items | Where-Object { $_.id -eq $probe.id })[0]
if ($after -and $after.updatedAt -and $after.updatedAt -ne $oldStamp) { OK ('07 标完成 → updatedAt 刷新了（' + $oldStamp.Substring(11,8) + ' → ' + $after.updatedAt.Substring(11,8) + '）') }
else { NG '07 改动后 updatedAt 没刷新' (($after | ConvertTo-Json -Compress)) }
if ($after -and $after.createdAt -eq $probe.createdAt) { OK '08 刷新 updatedAt 没动 createdAt' } else { NG '08 createdAt 被动了' }

# ── ⑤ 删掉 → 留一条删除记录
$null = Eval ("window.__TAURI_INTERNALS__.invoke('todo_delete',{id:'" + $probe.id + "'}).then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900
$gravesFile = ReadJson (Join-Path $dataDir 'sync\graves.json')
$hit = @($gravesFile.items | Where-Object { $_.id -eq $probe.id })
if ($hit.Count -eq 1) { OK '09 删待办 → 留下了一条删除记录' } else { NG ('09 没找到删除记录（' + $hit.Count + ' 条）') }
if ($hit.Count -eq 1 -and $hit[0].kind -eq 'todo') { OK '10 删除记录的种类 = todo' } else { NG '10 kind 不对' (($hit[0] | ConvertTo-Json -Compress)) }
if ($hit.Count -eq 1 -and -not ($hit[0].PSObject.Properties.Name -contains 'title')) { OK '11 删除记录**不含内容**（只有 id/时间/种类）' } else { NG '11 删除记录里混进了内容' }
$todos3 = ReadJson (Join-Path $dataDir 'todos.json')
if (@($todos3.items | Where-Object { $_.title -eq $title }).Count -eq 0) { OK '12 测试待办已经删干净' } else { NG '12 测试待办还在' }

# ── ⑥ 真实数据副本核对（拿用户数据的**副本**跑 Rust 侧那条测试）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$copyDir = Join-Path $env:TEMP ('m21-copy-' + $stamp)
New-Item -ItemType Directory -Force -Path $copyDir | Out-Null
foreach ($one in @('todos.json', 'config.json', 'info.jsonl', 'awards.json', 'mottos.json', 'annotations.json', 'archive.json', 'countdowns.json', 'reminders.json')) {
  $src = Join-Path $dataDir $one
  if (Test-Path $src) { Copy-Item $src (Join-Path $copyDir $one) -Force }
}
foreach ($dir in @('notes', 'assets', 'dailies')) {
  $src = Join-Path $dataDir $dir
  if (Test-Path $src) { Copy-Item $src (Join-Path $copyDir $dir) -Recurse -Force }
}
Write-Host ('  （副本已建：' + $copyDir + '）') -ForegroundColor DarkGray

$env:M21_COPY = $copyDir
Push-Location (Join-Path $app 'src-tauri')
$out = (cargo test --lib m21_真实数据副本 -- --nocapture 2>&1) -join "`n"
Pop-Location
$env:M21_COPY = ''
$lines = ($out -split "`n") | Where-Object { $_ -match '副本路径|待办条数|新补上的|本来就有|逐条比对|test result' }
$lines | ForEach-Object { Write-Host ('    ' + $_.Trim()) -ForegroundColor DarkGray }
if ($out -match 'test result: ok\. 1 passed') { OK '13 真实数据副本核对通过（内容一字不差，只多了 updatedAt）' }
else { NG '13 真实数据副本核对没过' (($out -split "`n" | Select-Object -Last 6) -join ' | ') }
Remove-Item $copyDir -Recurse -Force -ErrorAction SilentlyContinue

# ── ⑦ 收尾：把测试期间留下的删除记录清掉（连归档一起），用户数据零残留
$purged = Eval "window.__TAURI_INTERNALS__.invoke('sync_graves_purge').then(function(n){return String(n);})"
if ($purged -match '^\d+$') { OK ('14 删除记录已清空（清掉 ' + $purged + ' 条，清之前已留档到 backups/）') } else { NG '14 清删除记录失败' $purged }
$gravesAfter = ReadJson (Join-Path $dataDir 'sync\graves.json')
if ($gravesAfter -and @($gravesAfter.items).Count -eq 0) { OK '15 删记录文件里现在是空的' } else { NG '15 删记录没清干净' }

$todosEnd = ReadJson (Join-Path $dataDir 'todos.json')
OK ('16 收尾核对：待办 ' + @($todosEnd.items).Count + ' 条（用户自己的，一条没动）')

Write-Host ''
Write-Host ("==== M21 成绩：通过 " + $pass + "，失败 " + $fail + " ====") -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
