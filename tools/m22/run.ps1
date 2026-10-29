# M22 验收：电脑端「同步入口」（四种状态 + 令牌闸门 + 端口开关）
#
# 为什么要这套：M22 的东西**几乎全是"看不见的"** —— 临时服务、一次性令牌、二维码、端口生命周期。
# 光看界面"出来一张码"不能说明任何问题，所以这里逐条验，而且**顺序很重要**：
#   ① 平时：设置页有「同步」分组、能点
#   ② 点「开始同步」→ **代码生成的 SVG 二维码真的渲染出来**（不是空图、不是图片顶替）
#   ③ 二维码内容 = moye-sync://<局域网IP>:<随机高位端口>/<令牌>
#   ④ 那一刻**端口真的在监听**，而且**只绑在那个局域网地址上**（不是 0.0.0.0）
#   ⑤ ⚠️ **倒计时要在"等人连"这个阶段读** —— 手机一连上界面就换成日志了
#   ⑥ 拿**错令牌** → 403；拿**对令牌** → 200（模拟手机；令牌从界面上那张码的属性读）
#   ⑦ 界面如实切到「已连上」（+逐项日志）—— M22 只到这一步，**不许假装同步成功**
#   ⑧ 点「取消」→ 回到 idle、二维码作废、**端口不再监听**
#   ⑨ 同步前快照真的落在 backups\sync-pre\<时间戳>\（且含 todos.json）
#
# ⚠️ 三条本项目的坑（这套件一次全踩过，写在这儿给下一个改它的人）：
#   1. **多行 `-Expr` 拿不到返回值** → 复杂 JS 一律写 `.spike\*.js` 用 `-ExprFile`；
#   2. **真实鼠标只在屏幕上有效** → 点之前先 `scrollIntoView`（按钮不在视野里会点空）；
#   3. **开发中改前端会 HMR 重置页面** → 每次动作前用 `GoSettings` 重新确保在设置页。
#
# 用法（应用要以 CDP 9222 起着，见 进度.md 第七节）：
#   powershell -ExecutionPolicy Bypass -File tools\m22\run.ps1

param([int]$Port = 9222)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent (Split-Path -Parent $here)
$spike = Join-Path (Split-Path -Parent $app) '.spike'
$cdp = Join-Path (Split-Path -Parent $here) 'cdp.ps1'
$dataDir = 'D:\东方摩耶堂'

$pass = 0; $fail = 0
function OK($m) { $script:pass++; Write-Host ("  [v] " + $m) -ForegroundColor Green }
function NG($m, $d = '') { $script:fail++; Write-Host ("  [X] " + $m + "  ::  " + $d) -ForegroundColor Red }
function Check($m, $ok, $d = '') { if ($ok) { OK $m } else { NG $m $d } }

# ⚠️ 参数**不能**叫 `$args`：那是 PowerShell 的保留自动变量，`@args` 展开的是空数组，
#    结果 cdp.ps1 一个参数都没收到、退回默认动作（只打 url=/title=）→ 整套件全假红。
#    照 m19 的写法用 `$Argv`。
function Cdp() {
  param([string[]]$Argv)
  return (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp @Argv -Port $Port 2>&1)
}
# ⚠️ cdp.ps1 会把 `url=…` / `title=…` 这类诊断写到 **stderr**；套件里合并了 2>&1，
#    所以**不能取"最后一行"**（会取到诊断行）——必须把这些行滤掉再取最后一个非空行。
function EvalRaw([string[]]$cdpArgs) {
  $lines = @(Cdp $cdpArgs | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -ne '' -and $_ -notmatch '^(url|title|id)=' })
  if ($lines.Count -eq 0) { return '' }
  return $lines[$lines.Count - 1]
}
function EvalMain([string]$expr) { EvalRaw @('-Action', 'eval', '-Expr', $expr, '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') }
function EvalFile([string]$file) { EvalRaw @('-Action', 'eval', '-ExprFile', $file, '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') }
function MouseClick([string]$selector, [string]$require) {
  $null = EvalMain ("(function(){var b=document.querySelector('" + $selector + "'); if(!b) return 'NO'; b.scrollIntoView({block:'center'}); return 'OK';})()")
  Start-Sleep -Milliseconds 450
  Cdp @('-Action', 'mouse', '-Selector', $selector, '-TargetTitle', '东方摩耶堂', '-RequireSelector', $require) | Out-Null
}
# ⚠️ 开发中改前端会 HMR 重置页面 → 每次动作前都重新确保"在设置页"
function GoSettings {
  for ($i = 0; $i -lt 5; $i++) {
    if ((EvalMain "!!document.querySelector('[data-settings-sync]')") -match 'true') { return $true }
    Cdp @('-Action', 'mouse', '-Selector', 'nav [data-nav-icon="settings"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') | Out-Null
    Start-Sleep -Milliseconds 900
  }
  return ((EvalMain "!!document.querySelector('[data-settings-sync]')") -match 'true')
}

Write-Host "`n§1 平时状态" -ForegroundColor Yellow
$null = GoSettings
$s = EvalMain "JSON.stringify({sync: !!document.querySelector('[data-settings-sync]'), start: !!document.querySelector('[data-sync-start]'), phase: (document.querySelector('[data-sync-panel]')||{}).getAttribute ? document.querySelector('[data-sync-panel]').getAttribute('data-sync-phase') : 'none'})"
Check '① 设置页里有「同步」分组' ($s -match '"sync":true') $s
Check '② 平时是 idle，且有「开始同步」按钮' ($s -match '"start":true' -and $s -match '"phase":"idle"') $s

Write-Host "`n§2 点「开始同步」→ 出二维码" -ForegroundColor Yellow
$null = GoSettings
MouseClick '[data-sync-start]' '[data-sync-start]'
Start-Sleep -Seconds 2
$info = (EvalFile (Join-Path $spike 'm22-read-qr.js')) | ConvertFrom-Json
Check '③ 二维码渲染出来了（真是 <svg>，不是空图）' ($info.ok -and $info.hasSvg -and $info.svgLen -gt 400) ("hasSvg=" + $info.hasSvg + " svgLen=" + $info.svgLen)
Check '④ 二维码内容 = moye-sync://<IP>:<端口>/<令牌>' ($info.text -match '^moye-sync://\d+\.\d+\.\d+\.\d+:\d{4,5}/[0-9a-f]{64}$') $info.text
Check '⑤ 状态进到 waiting（等手机来连）' ($info.phase -eq 'waiting') $info.phase
# 🩹 P1-2（2026-10-06）：出码这一屏必须有**一眼看得见**的「结束这次同步」按钮，
#    而且不许再写"手机端在 M23，做完才能真同步"那种过期文案。
$p12 = (EvalMain "JSON.stringify({end:!!document.querySelector('[data-sync-end]'), endText:((document.querySelector('[data-sync-end]')||{}).textContent||''), m23:(((document.querySelector('[data-sync-panel]')||{}).innerText||'').indexOf('M23'))>=0})")
Check '⑤b 出码这一屏有「结束这次同步」按钮（P1-2：任何时候都有出口）' ($p12 -match '"end":true' -and $p12 -match '结束这次同步') $p12
Check '⑤c 面板里不再有过期文案（"手机端在 M23"）' ($p12 -match '"m23":false') $p12
$parts = $info.text -replace '^moye-sync://', ''
$ipPort = ($parts -split '/')[0]
$qrIp = ($ipPort -split ':')[0]
$qrPort = [int](($ipPort -split ':')[1])
$token = ($parts -split '/')[1]
Check ('⑥ 端口是随机高位端口（' + $qrPort + '）') ($qrPort -ge 20000 -and $qrPort -le 60000) $qrPort
Check ('⑦ 地址是局域网 IP（' + $qrIp + '），不是 0.0.0.0 / 公网') ($qrIp -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') $qrIp

Write-Host "`n§3 端口真的开着（只绑局域网网卡）+ 倒计时在走" -ForegroundColor Yellow
$listen = Get-NetTCPConnection -LocalPort $qrPort -State Listen -ErrorAction SilentlyContinue
Check ('⑧ 那一刻端口 ' + $qrPort + ' 真的在监听') ($null -ne $listen) ($listen | ConvertTo-Json -Compress)
if ($listen) {
  $bound = @($listen | ForEach-Object { $_.LocalAddress } | Select-Object -Unique)
  Check '⑨ 只绑在局域网地址上（没有 0.0.0.0 那种全网卡暴露）' (@($bound | Where-Object { $_ -eq '0.0.0.0' }).Count -eq 0) ($bound -join ',')
}
$c1 = EvalMain "(document.querySelector('[data-sync-countdown]')||{}).textContent||'none'"
Start-Sleep -Seconds 3
$c2 = EvalMain "(document.querySelector('[data-sync-countdown]')||{}).textContent||'none'"
Check ('⑩ 倒计时真的在走（' + $c1 + ' → ' + $c2 + '）') ($c1 -match '^\d\d:\d\d$' -and $c2 -match '^\d\d:\d\d$' -and $c1 -ne $c2) ($c1 + ' -> ' + $c2)
$snapRel = $info.snap
$snapFull = Join-Path $dataDir $snapRel
Check ('⑪ 同步前快照真的落在磁盘上（' + $snapRel + '）') (-not [string]::IsNullOrEmpty($snapRel) -and (Test-Path $snapFull)) $snapFull
if (Test-Path $snapFull) { Check '⑫ 快照里有 todos.json（真的拷了数据）' (Test-Path (Join-Path $snapFull 'todos.json')) '' }

Write-Host "`n§4 令牌闸门（拿错 403 / 拿对 200 → 模拟手机连上）" -ForegroundColor Yellow
$wrong = $null
try { $wrong = (Invoke-WebRequest ("http://" + $ipPort + "/hello?token=deadbeef") -UseBasicParsing -TimeoutSec 5).StatusCode } catch { $wrong = $_.Exception.Response.StatusCode.value__ }
Check '⑬ 拿错令牌 → 403（闸门有效）' ("$wrong" -eq '403') "status=$wrong"
$right = 'ERR'
try { $right = (Invoke-WebRequest ("http://" + $ipPort + "/hello?token=" + $token) -UseBasicParsing -TimeoutSec 5).Content } catch { $right = 'ERR:' + $_.Exception.Message }
Check '⑭ 拿对令牌 → 200 + 本机应用信息（手机连上时看到的就是这个）' ($right -match '"ok":true' -and $right -match '东方摩耶堂') $right
Start-Sleep -Milliseconds 1200
$conn = EvalMain "JSON.stringify({phase:(document.querySelector('[data-sync-panel]')||{}).getAttribute('data-sync-phase'), log:!!document.querySelector('[data-sync-log]')})"
Check '⑮ 界面如实切到「已连上」（connected + 逐项日志）' ($conn -match '"phase":"connected"' -and $conn -match '"log":true') $conn

# 🩹 P1-2：连上之后仍然要留着出口（以前只有 waiting/connected 两屏有取消，其它阶段直接卡死）
$endConn = (EvalMain "JSON.stringify({end:!!document.querySelector('[data-sync-end]'), text:((document.querySelector('[data-sync-end]')||{}).textContent||''), cancel:!!document.querySelector('[data-sync-cancel]')})")
Check '⑮b 连上这一屏也有「结束这次同步」按钮（P1-2）' ($endConn -match '"end":true' -and $endConn -match '结束这次同步' -and $endConn -match '"cancel":true') $endConn

Write-Host "`n§5 取消 → 服务关掉、端口释放、码作废" -ForegroundColor Yellow
MouseClick '[data-sync-cancel]' '[data-sync-cancel]'
Start-Sleep -Seconds 2
$after = EvalMain "JSON.stringify({phase:(document.querySelector('[data-sync-panel]')||{}).getAttribute('data-sync-phase'), qr:!!document.querySelector('[data-sync-qr]'), start:!!document.querySelector('[data-sync-start]')})"
Check '⑯ 取消后回到 idle、二维码作废、按钮回来' ($after -match '"phase":"idle"' -and $after -match '"qr":false' -and $after -match '"start":true') $after
Start-Sleep -Seconds 1
$still = Get-NetTCPConnection -LocalPort $qrPort -State Listen -ErrorAction SilentlyContinue
Check ('⑰ 端口 ' + $qrPort + ' 已经不再监听（服务真关了）') ($null -eq $still) ($still | ConvertTo-Json -Compress)

# 🩹 P1-2：一轮结束后要留个交代（不然用户刚看到"同步完成"、下一秒界面什么都不剩）
# ⚠️ 老坑：inline `-Expr` 太长（约 220 字符以上）会被 `powershell -File` 拆坏 → 一律拆成几条短的
$lastRes = (EvalMain "((document.querySelector('[data-sync-last-result]')||{}).getAttribute?document.querySelector('[data-sync-last-result]').getAttribute('data-sync-last-result'):'none')").Trim()
$lastTxt = (EvalMain "((document.querySelector('[data-sync-last-result]')||{}).textContent||'').replace(/\s+/g,' ')").Trim()
Check '⑰b 结束之后面板留着交代（"上一次同步：已取消"）' ($lastRes -eq 'cancel' -and $lastTxt -match '已取消') ($lastRes + ' | ' + $lastTxt)

$shot = Join-Path $spike 'm22-同步区块.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-settings-sync]') | Out-Null
if (Test-Path $shot) { OK ('⑱ 截图已存：' + $shot) } else { NG '⑱ 截图没生成' }

Write-Host ''
Write-Host '======================'
Write-Host ("M22 同步入口：通过 " + $pass + "，失败 " + $fail)
if ($fail -gt 0) { exit 1 }
