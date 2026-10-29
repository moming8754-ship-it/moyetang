# M23 验收：手机端同步界面（手输「地址 + 6 位短码」）
#
# ⚠️⚠️ 这套件**故意不跑"真同步一次"**（下一个改它的人请注意，别"补上"）：
#   本套件跑在**用户的真实数据目录**上（dev 版就是他的数据）。手机端与电脑端是同一个进程、同一份数据，
#   让它"自己跟自己同步"会按协议判出大量"同一分钟都改过"的冲突 → **在他数据里生成一堆冲突副本** ——
#   那是**污染用户数据**（协议里的"两份都留"是给两台设备准备的）。
#   所以这里只验到"**请求真的打到了电脑、并被正确鉴权**"：
#     ① 假地址 → 友好报错（连不上），界面**不崩**
#     ② 真地址 + **错短码** → 电脑明确拒绝，且**数据一个字节没动**（前后比对文件大小与时间）
#     ③ 电脑端面板**显示 6 位短码**（手机手输要用它）
#   真正的"走通 + 看账单"由两处覆盖：① Rust 侧端到端（两个临时数据目录，`sync_e2e` 8 条）；
#     ② **用户的真机验收**（手机装 APK，跟电脑真同步一次）。
#
# 用法（应用要以 CDP 9222 起着）：
#   powershell -ExecutionPolicy Bypass -File tools\m23\run.ps1

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

# ⚠️ 参数不能叫 `$args`（PowerShell 保留变量，会让 cdp.ps1 收不到参数 → 整套假红），用 $Argv
function Cdp() { param([string[]]$Argv) return (& powershell -NoProfile -ExecutionPolicy Bypass -File $cdp @Argv -Port $Port 2>&1) }
# ⚠️ cdp.ps1 的诊断行走 stderr，合并 2>&1 后不能取"最后一行"，必须滤掉
function EvalRaw([string[]]$cdpArgs) {
  $lines = @(Cdp $cdpArgs | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -ne '' -and $_ -notmatch '^(url|title|id)=' })
  if ($lines.Count -eq 0) { return '' }
  return $lines[$lines.Count - 1]
}
function EvalMain([string]$expr, [string]$require = 'nav') { EvalRaw @('-Action', 'eval', '-Expr', $expr, '-TargetTitle', '东方摩耶堂', '-RequireSelector', $require) }
function MouseClick([string]$selector, [string]$require) {
  $null = EvalMain ("(function(){var b=document.querySelector('" + $selector + "'); if(!b) return 'NO'; b.scrollIntoView({block:'center'}); return 'OK';})()") $require
  Start-Sleep -Milliseconds 400
  Cdp @('-Action', 'mouse', '-Selector', $selector, '-TargetTitle', '东方摩耶堂', '-RequireSelector', $require) | Out-Null
}
# 往受控输入框填值（React 只认"原生 setter + input 事件"，直接改 .value 它收不到）
function FillInput([string]$selector, [string]$value, [string]$require) {
  $expr = "(function(){var el=document.querySelector('" + $selector + "'); if(!el) return 'NO';" +
    "var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;" +
    "set.call(el,'" + $value + "'); el.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';})()"
  return (EvalMain $expr $require)
}
function OpenMobile {
  $null = EvalMain "sessionStorage.setItem('dsh-mobile-preview','1');'ok'"
  $null = EvalMain "location.reload();'ok'"
  Start-Sleep -Seconds 4
  for ($i = 0; $i -lt 10; $i++) {
    if ((EvalMain "!!document.querySelector('[data-mobile-shell]')" '[data-mobile-shell]') -match 'true') { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
function CloseMobile {
  $null = EvalMain "sessionStorage.removeItem('dsh-mobile-preview');location.reload();'ok'" '[data-mobile-shell]'
  Start-Sleep -Seconds 4
  for ($i = 0; $i -lt 10; $i++) {
    if ((EvalMain "!!document.querySelector('nav')") -match 'true') { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
function GoSettings {
  for ($i = 0; $i -lt 6; $i++) {
    if ((EvalMain "!!document.querySelector('[data-settings-sync]')") -match 'true') { return $true }
    Cdp @('-Action', 'mouse', '-Selector', 'nav [data-nav-icon="settings"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') | Out-Null
    Start-Sleep -Milliseconds 800
    $null = EvalMain "sessionStorage.removeItem('dsh-mobile-preview');'ok'"
  }
  return ((EvalMain "!!document.querySelector('[data-settings-sync]')") -match 'true')
}

Write-Host '=== M23 手机端同步界面 ===' -ForegroundColor Cyan

# ── §1 电脑端：同步面板要能出码，而且**显示 6 位短码**
$null = EvalMain "sessionStorage.removeItem('dsh-mobile-preview');location.reload();'ok'"
Start-Sleep -Seconds 4
Check '01 电脑版基线：不是手机布局' ((EvalMain "!!document.querySelector('[data-mobile-shell]')") -match 'false') ''

$ok = GoSettings
Check '02 进得了设置页（同步分组在）' $ok
if ($ok) {
  MouseClick '[data-sync-start]' 'nav'
  Start-Sleep -Seconds 2
  $addr = (EvalMain "(document.querySelector('[data-sync-address]')||{}).textContent||''").Trim()
  $code = (EvalMain "(document.querySelector('[data-sync-shortcode]')||{}).textContent||''").Trim()
  $qr = (EvalMain "(document.querySelector('[data-sync-qr] svg')||{}).outerHTML||''")
  Check '03 点「开始同步」→ 真二维码出来了' ($qr.Length -gt 500) ('svg 长度 ' + $qr.Length)
  Check ('04 电脑端**显示了 6 位短码**（手机手输要用）：' + $code) ($code -match '^\d{6}$') ('读到 ' + $code)
  Check ('05 地址长得对（局域网 IP:端口）：' + $addr) ($addr -match '^\d+\.\d+\.\d+\.\d+:\d+$') ('读到 ' + $addr)
}

# ── §2 手机端：同步页能打开
$mob = OpenMobile
Check '06 打开手机布局预览' $mob
if ($mob) {
  # 🩹 P1-2（2026-10-06）：更多面板里那格「同步电脑」原来是**死按钮**（M18 留下的 `return`，点了没反应），
  #    而且写着"扫码（M23 才做）"这种过期文案 —— 现在必须能点进设置页。
  MouseClick '[data-mobile-tab=more]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 700
  $syncCell = (EvalMain "((document.querySelector('[data-mobile-more-item=sync]')||{}).innerText||'').replace(/\s+/g,' ')" '[data-mobile-shell]').Trim()
  MouseClick '[data-mobile-more-item=sync]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 900
  $jumped = (EvalMain "!!document.querySelector('[data-mset-row=sync]')" '[data-mobile-shell]') -match 'true'
  Check '06b 更多面板里的「同步电脑」点得动（不再是点了没反应的死按钮）' $jumped $syncCell
  Check '06c 那格里不再写过期文案（"扫码（M23 才做）"）' ($syncCell -notmatch 'M23') $syncCell
  $rowVal = (EvalMain "((document.querySelector('[data-mset-row=sync]')||{}).innerText||'').replace(/\s+/g,' ')" '[data-mobile-shell]').Trim()
  Check '06d 设置页那行「同步电脑」是真状态（不写死"还没做过"）' ($rowVal -notmatch '还没做过') $rowVal

  MouseClick '[data-mobile-tab=more]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 700
  MouseClick '[data-mobile-more-item=settings]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 900
  MouseClick '[data-mset-row=sync]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 900
  $hasSync = (EvalMain "!!document.querySelector('[data-msync]')" '[data-mobile-shell]') -match 'true'
  Check '07 「更多 → 设置 → 同步电脑」打开的是**真同步页**（不是 M23 之前的说明）' $hasSync
  # ── P2-A（2026-10-06）：扫码成了主路，手输**折在第一屏**（相机不行时不用再找一层）
  $folded = (EvalMain "(!document.querySelector('[data-msync-addr]')) && (!document.querySelector('[data-msync-code]'))" '[data-mobile-shell]') -match 'true'
  Check '08a 手输那块默认**折着**（扫码为主路，兜底收在同一屏）' $folded
  $hasGo0 = (EvalMain "!!document.querySelector('[data-msync-go]')" '[data-mobile-shell]') -match 'true'
  Check '08b 「开始同步」按钮一开始就在（折起来也不藏它）' $hasGo0
  MouseClick '[data-msync-manual-toggle]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 700
  $hasInputs = (EvalMain "!!document.querySelector('[data-msync-addr]') && !!document.querySelector('[data-msync-code]') && !!document.querySelector('[data-msync-go]')" '[data-mobile-shell]') -match 'true'
  Check '08 点「手输地址和短码」→ 地址框 / 短码框 / 开始同步按钮都在' $hasInputs

  # 扫一扫：**相机不可用**那条路要能确定地验 —— 先在页面里把 `mediaDevices` 抹掉
  # （只影响这一个页面，套件末尾/重载即恢复）。真机的相机路径由用户亲手验。
  $hasScan = (EvalMain "!!document.querySelector('[data-msync-scan]')" '[data-mobile-shell]') -match 'true'
  Check '08c 主路按钮「扫二维码连电脑」在（data-msync-scan）' $hasScan
  $null = EvalMain "try{Object.defineProperty(navigator,'mediaDevices',{value:undefined,configurable:true});}catch(e){};'ok'" '[data-mobile-shell]'
  MouseClick '[data-msync-scan]' '[data-mobile-shell]'
  Start-Sleep -Seconds 2
  $scanOpen = (EvalMain "!!document.querySelector('[data-msscan]') && !!document.querySelector('[data-msscan-video]')" '[data-mobile-shell]') -match 'true'
  Check '08d 点它 → 出取景框（data-msscan / data-msscan-video）' $scanOpen
  $scanErr = ''
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 1000
    $scanErr = (EvalMain "((document.querySelector('[data-msscan-error]')||{}).textContent||'')" '[data-mobile-shell]').Trim()
    if ($scanErr.Length -gt 0) { break }
  }
  $scanBack = (EvalMain "!!document.querySelector('[data-msscan-manual]')" '[data-mobile-shell]') -match 'true'
  Check '08e 相机不可用 → 界面上就地说清楚（不白屏、不崩）' ($scanErr.Length -gt 0) ('提示：' + ($scanErr -replace "`r?`n", ' ').Substring(0, [Math]::Min(60, $scanErr.Length)))
  Check '08f 相机不行时给「改用手机输」的出口（data-msscan-manual）' $scanBack
  if ($scanBack) { MouseClick '[data-msscan-manual]' '[data-mobile-shell]' }
  else { MouseClick '[data-msscan-close]' '[data-mobile-shell]' }
  Start-Sleep -Milliseconds 700
  $scanClosed = (EvalMain "!document.querySelector('[data-msscan]')" '[data-mobile-shell]') -match 'true'
  Check '08g 关掉扫码浮层 → 回到同步页（手输那块还开着）' $scanClosed

  # 扫到码之后：**认一下再连** → 「连这台」→ 只填地址、**不自动开始同步**（P2-A 那三个默认）
  #   相机没法在电脑上自动点 → 走 `dsh:scan-result` 钩子（同一条解析 + 同一个界面，
  #   只把"从相机取像素"那一步换掉；真机相机由用户亲手验，清单在进度.md）。
  MouseClick '[data-msync-scan]' '[data-mobile-shell]'
  Start-Sleep -Seconds 2
  $fakeUri = 'moye-sync://127.0.0.1:9/abcdef0123456789'
  $null = EvalMain "window.dispatchEvent(new CustomEvent('dsh:scan-result',{detail:{text:'$fakeUri'}}));'ok'" '[data-mobile-shell]'
  Start-Sleep -Milliseconds 900
  $foundAddr = (EvalMain "((document.querySelector('[data-msscan-addr]')||{}).textContent||'')" '[data-mobile-shell]').Trim()
  Check ('08h 扫到码 → 先出「认一下再连」，并说清是哪台电脑（' + $foundAddr + '）') ($foundAddr -eq '127.0.0.1:9') ('读到 ' + $foundAddr)
  $goText = (EvalMain "(function(){var b=document.querySelector('[data-msync-go]'); return b ? b.textContent : 'missing';})()" '[data-mobile-shell]').Trim()
  Check '08i 扫到码**没有自动开始同步**（按钮还写着「开始同步」）' ($goText -match '开始同步') ('按钮文字 ' + $goText)
  MouseClick '[data-msscan-go]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 900
  $filled = (EvalMain "((document.querySelector('[data-msync-addr]')||{}).value||'')" '[data-mobile-shell]').Trim()
  $note = (EvalMain "((document.querySelector('[data-msync-scan-note]')||{}).textContent||'')" '[data-mobile-shell]').Trim()
  Check '08j 点「连这台」→ 地址栏填成扫到的那条整 URL（不用再填 6 位短码）' ($filled -like 'moye-sync://127.0.0.1:9*') ('读到 ' + $filled)
  Check '08k 并且如实说明"还要自己按一次开始同步"' ($note.Length -gt 0) ('提示：' + $note)
  $bill0 = (EvalMain "!!document.querySelector('[data-msync-bill]')" '[data-mobile-shell]') -match 'true'
  Check '08l 这一串动作**没有真的同步**（没账单、没动数据）' (-not $bill0)
  # 把假地址清掉，别影响后面几步
  $null = FillInput '[data-msync-addr]' '' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 300

  # ── §3 假地址 → 友好报错，不崩
  $null = FillInput '[data-msync-addr]' '127.0.0.1:9' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 400
  $null = FillInput '[data-msync-code]' '000000' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 300
  $canGo = (EvalMain "(function(){var b=document.querySelector('[data-msync-go]'); return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing';})()" '[data-mobile-shell]').Trim()
  Check ('09a 「开始同步」按钮可点（填了地址才亮）') ($canGo -eq 'enabled') ('按钮状态 ' + $canGo)
  MouseClick '[data-msync-go]' '[data-mobile-shell]'
  Start-Sleep -Seconds 4
  $errText = (EvalMain "(document.querySelector('[data-msync-error]')||{}).textContent||''" '[data-mobile-shell]').Trim()
  $alive = (EvalMain "!!document.querySelector('[data-msync]')" '[data-mobile-shell]') -match 'true'
  Check '09 假地址 → 明确提示「连不上」（不是白屏/不是崩）' ($errText.Length -gt 0 -and $alive) ('提示：' + ($errText -replace "`r?`n", ' ').Substring(0, [Math]::Min(60, $errText.Length)))
  $flat = ($errText -replace "`r?`n", ' ')
  Check ('10 出错时给了排查方向（同一个 WiFi / 电脑点了开始同步 / 地址短码抄错）') ($flat -match 'WiFi' -or $flat -match '同一个' -or $flat -match '电脑上有没有点') ('提示全文：' + $flat)

  # ── §4 真地址 + 错短码 → 电脑明确拒绝，且**数据没动**
  if ($addr -and $code) {
    $before = (Get-Item (Join-Path $dataDir 'todos.json'))
    $bLen = $before.Length; $bTime = $before.LastWriteTime
    $null = FillInput '[data-msync-addr]' $addr '[data-mobile-shell]'
    Start-Sleep -Milliseconds 400
    $null = FillInput '[data-msync-code]' '000000' '[data-mobile-shell]'
    Start-Sleep -Milliseconds 300
    MouseClick '[data-msync-go]' '[data-mobile-shell]'
    Start-Sleep -Seconds 5
    $err2 = (EvalMain "(document.querySelector('[data-msync-error]')||{}).textContent||''" '[data-mobile-shell]').Trim()
    $bill = (EvalMain "!!document.querySelector('[data-msync-bill]')" '[data-mobile-shell]') -match 'true'
    Check '11 真地址 + 错短码 → 请求**真的打到了电脑**并被拒（不是"连不上"）' ($err2.Length -gt 0 -and $err2 -notmatch '连不上') ('提示：' + ($err2 -replace "`r?`n", ' ').Substring(0, [Math]::Min(70, $err2.Length)))
    Check '12 被拒时**不显示账单**（没有假装同步成功）' (-not $bill)
    $after = (Get-Item (Join-Path $dataDir 'todos.json'))
    Check '13 这期间**用户数据一个字节没动**（大小与修改时间都没变）' (($after.Length -eq $bLen) -and ($after.LastWriteTime -eq $bTime)) ('前 ' + $bLen + '@' + $bTime.ToString('HH:mm:ss') + ' / 后 ' + $after.Length + '@' + $after.LastWriteTime.ToString('HH:mm:ss'))
  } else {
    NG '11-13 跳过（§1 没读到地址/短码）' ''
  }

  # 收尾：关掉同步页 → 回电脑版
  MouseClick '[data-msync-close]' '[data-mobile-shell]'
  Start-Sleep -Milliseconds 600
}

# ── §5 收尾：关同步服务 + 清预览开关 + 回电脑版布局
$back = CloseMobile
Check '14 收尾：回到电脑版布局（侧栏回来了）' $back
$ok2 = GoSettings
if ($ok2) {
  MouseClick '[data-sync-cancel]' 'nav'
  Start-Sleep -Seconds 2
  $phase = (EvalMain "((document.querySelector('[data-sync-panel]')||{}).getAttribute ? document.querySelector('[data-sync-panel]').getAttribute('data-sync-phase') : '')||''").Trim()
  Check ('15 取消同步：服务关掉、码作废（phase=' + $phase + '）') ($phase -ne 'waiting')
}

Write-Host ''
Write-Host '======================' -ForegroundColor Cyan
Write-Host ("M23 手机端同步界面：通过 " + $pass + "，失败 " + $fail) -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
