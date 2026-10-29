# M18 验收套件：手机外壳与导航（v2.1.0）
#
# 怎么跑（应用必须带 CDP 端口起着）：
#   cd D:\东方摩耶堂\notes-app
#   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
#   npm run tauri dev
#   powershell -ExecutionPolicy Bypass -File tools\m18\run.ps1
#
# 思路：手机版**不能每次都让用户装机验**。所以 M18 做了个"强制手机布局"开关
# （`src\mobile\platform.ts` 的 `isMobilePreview()`，**只在开发模式生效**）：
# 往 localStorage 塞 `dsh-mobile-preview=1` → reload → 手机外壳就渲染在一个
# **360×800 的框**里，于是普通桌面窗口里也能用真鼠标点、能截图。
#
# ⚠️ 本套件**结束时必须清掉那个开关**，否则后面的套件全都看到手机布局（污染整条回归）。
# ⚠️ 交互一律走 `-Action mouse`（真实输入）；合成 click 会给出假绿。

$ErrorActionPreference = 'Continue'
$root = 'D:\东方摩耶堂\notes-app'
$cdp = Join-Path $root 'tools\cdp.ps1'
$spike = 'D:\东方摩耶堂\.spike'
$pass = 0
$fail = 0

function OK($m) { $script:pass++; Write-Host ('  [通过] ' + $m) -ForegroundColor Green }
function NG($m, $detail = '') {
  $script:fail++
  Write-Host ('  [失败] ' + $m) -ForegroundColor Red
  if ($detail) { Write-Host ('         ' + $detail) -ForegroundColor DarkGray }
}
function Cdp() {
  param([string[]]$Argv)
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp @Argv 2>&1
  return ($out | Out-String)
}

# ── 自检：CDP 通不通（连不上就别往下跑，免得报一堆假失败）──────────────
$probe = Cdp @('-Action', 'eval', '-Expr', '1+1', '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav')
if ($probe -notmatch '2') {
  Write-Host '  [致命] CDP 连不上（应用没带 --remote-debugging-port=9222 起来？）' -ForegroundColor Red
  Write-Host ('         ' + ($probe -replace "`r?`n", ' ').Substring(0, [Math]::Min(160, $probe.Length)))
  exit 1
}
Write-Host '  [自检] CDP 通 ✓'

# ── 读状态的 JS（放 .spike，**别放项目目录**，否则会惊动 vite 的 watcher）──
$stateJs = Join-Path $spike 'm18-state.js'
@'
JSON.stringify({
  frame: !!document.querySelector('[data-mobile-frame]'),
  shell: !!document.querySelector('[data-mobile-shell]'),
  hasNav: !!document.querySelector('nav'),
  tabs: Array.prototype.map.call(document.querySelectorAll('[data-mobile-tab]'), function (e) { return e.getAttribute('data-mobile-tab'); }),
  title: (document.querySelector('[data-mobile-title]') || {}).textContent || '',
  zone: (document.querySelector('[data-mobile-zone]') || { getAttribute: function () { return ''; } }).getAttribute('data-mobile-zone') || '',
  moreItems: Array.prototype.map.call(document.querySelectorAll('[data-mobile-more-item]'), function (e) { return e.getAttribute('data-mobile-more-item'); })
})
'@ | Set-Content -Path $stateJs -Encoding UTF8

function State([string]$require) {
  $raw = Cdp @('-Action', 'eval', '-ExprFile', $stateJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', $require)
  $line = ($raw -split "`n" | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
  if (-not $line) { return $null }
  try { return ($line | ConvertFrom-Json) } catch { return $null }
}

# ── ① 电脑版基线：开关没开时**绝不能**是手机布局 ──────────────────────
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '① 电脑版基线：没有手机框、没有手机外壳' }
else { NG '① 电脑版基线' ('state=' + ($s | ConvertTo-Json -Compress)) }

# ── ② 打开开关并重载 ────────────────────────────────────────────────
Cdp @('-Action', 'eval', '-Expr', "sessionStorage.setItem('dsh-mobile-preview','1');location.reload();'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') | Out-Null
Start-Sleep -Seconds 4
$s = State '[data-mobile-shell]'
if ($s -and $s.frame) { OK '② 开关打开后出现 360×800 手机框' } else { NG '② 手机框没出现' (($s | ConvertTo-Json -Compress)) }
if ($s -and $s.shell) { OK '③ 手机外壳已渲染（data-mobile-shell）' } else { NG '③ 手机外壳没渲染' }

# ── ④ 底栏 6 格且顺序对 ─────────────────────────────────────────────
$want = @('home', 'info', 'cognition', 'todo', 'schedule', 'more')
$got = if ($s) { @($s.tabs) } else { @() }
if (($got -join ',') -eq ($want -join ',')) { OK ('④ 底栏 6 格且顺序正确：' + ($got -join ' / ')) }
else { NG '④ 底栏格子不对' ('期望 ' + ($want -join ',') + ' 实际 ' + ($got -join ',')) }

# ── ⑤⑩ 依次真鼠标点 5 个区，标题要跟着变 ─────────────────────────────
$cases = @(
  @{ sel = 'info';      label = '信息区' },
  @{ sel = 'cognition'; label = '认知区' },
  @{ sel = 'todo';      label = '执行区' },
  @{ sel = 'schedule';  label = '日程' },
  @{ sel = 'home';      label = '首页' }
)
$idx = 5
foreach ($c in $cases) {
  Cdp @('-Action', 'mouse', '-Selector', ('[data-mobile-tab="' + $c.sel + '"]'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 700
  $st = State '[data-mobile-shell]'
  $titleOk = $st -and ($st.title -replace '\s', '') -eq $c.label
  $zoneOk = $st -and ($st.zone -eq $c.sel)
  if ($titleOk -and $zoneOk) { OK ('⑤ 真鼠标点「' + $c.label + '」→ 标题与内容区都跟着变') }
  else { NG ('⑤ 点「' + $c.label + '」没跟上') ('title=' + $st.title + ' zone=' + $st.zone) }
  $idx++
}

# ── ⑪ 「更多」面板：4 个入口 ─────────────────────────────────────────
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab="more"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
$more = if ($s) { @($s.moreItems) } else { @() }
# 🔴 2026-10-11（v2.22.1）修一条**顺序耦合的假红**：这里原来把 4 个入口**写死**（含 archive），
#    可档案区是「设置里开了才有入口」的（用户反馈 B4 就是这么要求的）—— 而**全量回归里 m15 排在
#    m18 前面，m15 收尾会把 `archive.enabled` 关回去** → 这一条在全量里必红、单跑却绿（因为用户自己开着）。
#    现在**按当前 config 决定该有几个**（跟前几个会话修 m14 / m15 同一套规矩：判据别写死
#    「用户那边长什么样」，要跟着当时的状态自比）。
$archRaw = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return 'ARCH:'+c.archive.enabled;})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
$archOn = ($archRaw -match 'ARCH:true')
$wantMore = if ($archOn) { @('skill', 'archive', 'settings', 'sync') } else { @('skill', 'settings', 'sync') }
if (($more -join ',') -eq ($wantMore -join ',')) { OK ('⑥ 「更多」入口对（档案区' + $(if ($archOn) { '开着' } else { '关着' }) + ' → ' + ($wantMore -join '/') + '）') }
else { NG '⑥ 「更多」入口不对' ('实际 ' + ($more -join ',') + '  期望 ' + ($wantMore -join ',')) }

# ── ⑫ 从「更多」里点进技能区 ────────────────────────────────────────
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-more-item="skill"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
if ($s -and ($s.title -replace '\s', '') -eq '技能区' -and $s.zone -eq 'skill' -and (@($s.moreItems).Count -eq 0)) {
  OK '⑦ 从「更多」点进技能区 → 切过去了，面板也收起了'
} else { NG '⑦ 更多面板里点技能区没生效' ($s | ConvertTo-Json -Compress) }

# ── ⑬ 截图存档 ──────────────────────────────────────────────────────
$shot = Join-Path $spike 'm18-手机外壳-强预览.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('⑧ 截图已存：' + $shot) } else { NG '⑧ 截图没生成' }

# ── ⑭ 收尾：**必须清掉开关**，否则污染整条回归 ──────────────────────
Cdp @('-Action', 'eval', '-Expr', "sessionStorage.removeItem('dsh-mobile-preview');location.reload();'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Seconds 4
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell -and $s.hasNav) { OK '⑨ 收尾：开关已清、回到电脑版布局（侧栏回来了）' }
else { NG '⑨ 收尾没回到电脑版' (($s | ConvertTo-Json -Compress)) }

Write-Host ''
Write-Host ('  M18 成绩：通过 ' + $pass + ' / 失败 ' + $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
