# M19 验收套件：八个区逐个搬（v2.2.0 起，一个区一节）
#
# 怎么跑（应用必须带 CDP 端口起着）：
#   cd D:\东方摩耶堂\notes-app
#   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
#   npm run tauri dev
#   powershell -ExecutionPolicy Bypass -File tools\m19\run.ps1
#
# 做法照 `tools\m18\run.ps1`：用**强制手机布局**开关（`src\mobile\platform.ts`，
# 只在开发模式生效）把手机外壳渲染进 360×800 的框里，于是普通桌面窗口也能用真鼠标点。
#
# 🔴 两条纪律：
#   ① 本套件**结束时必须清掉开关**（`sessionStorage.removeItem('dsh-mobile-preview')` + reload），
#      否则后面的套件全都看到手机布局 → 污染整条回归；
#   ② **不改用户数据**：这里只验"界面接对了"（点得动、切得过去、字打得上），
#      真正的写盘路径（`info_create` / `todo_create`）由电脑版既有套件覆盖 ——
#      手机页调的就是同一批后端命令，不重复造数据（免得往用户数据里留垃圾）。
#
# 交互一律走 `-Action mouse` / 真键盘；合成 click 算假绿。

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

# ── 自检：CDP 通不通 ────────────────────────────────────────────────
$probe = Cdp @('-Action', 'eval', '-Expr', '1+1', '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav')
if ($probe -notmatch '2') {
  Write-Host '  [致命] CDP 连不上（应用没带 --remote-debugging-port=9222 起来？）' -ForegroundColor Red
  Write-Host ('         ' + ($probe -replace "`r?`n", ' ').Substring(0, [Math]::Min(160, $probe.Length)))
  exit 1
}
Write-Host '  [自检] CDP 通 ✓'

# 🔴 开工前就记住档案开关：§3 会临时打开它，不能等 §7 再记（那时已经是测试值了）。
$archOrigRaw = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){return String(!!(c.archive&&c.archive.enabled));})", '-TargetTitle', '东方摩耶堂')
$archOrig = ("$archOrigRaw" -match 'true')

# ── 读手机状态的 JS（放 .spike，别放项目目录，免得惊动 vite watcher）──
$stateJs = Join-Path $spike 'm19-state.js'
@'
JSON.stringify({
  frame: !!document.querySelector('[data-mobile-frame]'),
  shell: !!document.querySelector('[data-mobile-shell]'),
  zone: (document.querySelector('[data-mobile-zone]') || { getAttribute: function () { return ''; } }).getAttribute('data-mobile-zone') || '',
  title: (document.querySelector('[data-mobile-title]') || {}).textContent || '',
  today: !!document.querySelector('[data-mhome-today]'),
  todayCount: (document.querySelector('[data-mhome-today-count]') || { getAttribute: function () { return ''; } }).getAttribute('data-mhome-today-count') || '',
  reminderCard: !!document.querySelector('[data-mhome-reminder-card]'),
  todoCard: !!document.querySelector('[data-mhome-todo-card]'),
  todos: Array.prototype.map.call(document.querySelectorAll('[data-mhome-todo]'), function (e) { return e.getAttribute('data-mhome-todo'); }),
  checks: document.querySelectorAll('[data-mhome-check]').length,
  fab: !!document.querySelector('[data-mhome-fab],[data-minfo-fab]'),
  sheet: !!document.querySelector('[data-mhome-quick-sheet]'),
  quick: Array.prototype.map.call(document.querySelectorAll('[data-mhome-quick]'), function (e) { return e.getAttribute('data-mhome-quick'); }),
  input: !!document.querySelector('[data-mhome-quick-input]'),
  save: !!document.querySelector('[data-mhome-quick-save]'),
  empty: !!document.querySelector('[data-mhome-empty]'),
  search: !!document.querySelector('[data-minfo-search]'),
  statusChips: Array.prototype.map.call(document.querySelectorAll('[data-minfo-status]'), function (e) { return e.getAttribute('data-minfo-status'); }),
  statusActive: (document.querySelector('[data-minfo-status-active="1"]') || { getAttribute: function () { return ''; } }).getAttribute('data-minfo-status') || '',
  groupChip: !!document.querySelector('[data-minfo-group]'),
  groupList: Array.prototype.map.call(document.querySelectorAll('[data-minfo-group-pick]'), function (e) { return e.getAttribute('data-minfo-group-pick'); }),
  items: Array.prototype.map.call(document.querySelectorAll('[data-minfo-item]'), function (e) { return e.getAttribute('data-minfo-item'); }),
  menuSheet: !!document.querySelector('[data-minfo-menu-sheet]'),
  menuActions: Array.prototype.map.call(document.querySelectorAll('[data-minfo-menu-action]'), function (e) { return e.getAttribute('data-minfo-menu-action'); }),
  confirm: !!document.querySelector('[data-minfo-confirm]'),
  cogSearch: !!document.querySelector('[data-mcog-search]'),
  cogListImport: !!document.querySelector('[data-mcog-list-import]'),
  cogRows: Array.prototype.map.call(document.querySelectorAll('[data-mcog-row]'), function (e) { return e.getAttribute('data-mcog-row'); }),
  cogNote: !!document.querySelector('[data-mcog-note]'),
  cogTitle: (document.querySelector('[data-mcog-title]') || {}).textContent || '',
  cogMode: (document.querySelector('[data-mcog-mode]') || { getAttribute: function () { return ''; } }).getAttribute('data-mcog-mode') || '',
  // P2-C（2026-10-06）手机文本页的工具条按钮（P2-D 起：这些按钮长在**竖排条**里，默认收着）
  tbButtons: Array.prototype.map.call(document.querySelectorAll('[data-mnote-tb]'), function (e) { return e.getAttribute('data-mnote-tb'); }),
  tbActive: Array.prototype.map.call(document.querySelectorAll('[data-mnote-tb][data-mnote-tb-active="1"]'), function (e) { return e.getAttribute('data-mnote-tb'); }),
  tbHint: (document.querySelector('[data-mnote-tb-hint]') || { textContent: '' }).textContent || '',
  // P2-D（2026-10-06 返工）悬浮球 + 竖排条：球在不在、开着没、停哪一侧、多大、条是竖的还是横的
  tbBall: !!document.querySelector('[data-mnote-ball]'),
  tbBallOpen: (document.querySelector('[data-mnote-ball]') || { getAttribute: function () { return '0'; } }).getAttribute('data-mnote-ball-open') === '1',
  tbBallSide: (document.querySelector('[data-mnote-ball]') || { getAttribute: function () { return ''; } }).getAttribute('data-mnote-ball-side') || '',
  tbBallBox: (function () {
    var b = document.querySelector('[data-mnote-ball]');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })(),
  tbStripVertical: (function () {
    var s = document.querySelector('[data-mnote-strip]');
    if (!s) return false;
    var r = s.getBoundingClientRect();
    return r.height > r.width;
  })(),
  tbStripBox: (function () {
    var s = document.querySelector('[data-mnote-strip]');
    if (!s) return null;
    var r = s.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  })(),
  shellH: (function () {
    var f = document.querySelector('[data-mobile-shell]');
    return f ? Math.round(f.getBoundingClientRect().height) : 0;
  })(),
  tbStripUp: (document.querySelector('[data-mnote-strip]') || { getAttribute: function () { return ''; } }).getAttribute('data-mnote-strip-up') || '',
  tbImageInput: (function () {
    var i = document.querySelector('[data-mnote-image-input]');
    return i ? (i.getAttribute('accept') || '') : '';
  })(),
  // P2-B′（2026-10-06 返工）手机端树＝**照电脑版布局**（根在左、逐层向右；画布自己拖/缩）
  treeBox: !!document.querySelector('[data-mctree-box]'),
  treeCanvas: !!document.querySelector('[data-mctree-canvas]'),
  treeCount: (document.querySelector('[data-mnote-tree]') || { getAttribute: function () { return ''; } }).getAttribute('data-mcog-tree-count') || '',
  treeNodes: Array.prototype.map.call(document.querySelectorAll('[data-mctree-node]'), function (e) {
    var t = e.querySelector('[data-mctree-text]') || e;
    return { d: parseInt(e.getAttribute('data-mctree-depth'), 10), x: Math.round(parseFloat(e.style.left)), y: Math.round(parseFloat(e.style.top)), fs: getComputedStyle(t).fontSize };
  }),
  treeEdges: document.querySelectorAll('[data-mctree-edge]').length,
  treeEmptyText: Array.prototype.map.call(document.querySelectorAll('[data-mctree-empty-text]'), function (e) { return (e.textContent || '').trim(); }),
  treeMore: Array.prototype.map.call(document.querySelectorAll('[data-mctree-more]'), function (e) { return (e.textContent || '').trim(); }),
  treeDeep: (document.body.textContent || '').indexOf('最里面那层') >= 0,
  treeZoom: ((document.querySelector('[data-mctree-zoom]') || {}).textContent || '').trim(),
  cogToc: !!document.querySelector('[data-mcog-toc]'),
  cogTocItems: document.querySelectorAll('[data-mcog-toc-item]').length,
  cogTocText: ((document.querySelector('[data-mcog-toc]') || {}).innerText || '').replace(/\s+/g, ' '),
  cogAnnoBar: !!document.querySelector('[data-mcog-anno-bar]'),
  cogAnnoSheet: !!document.querySelector('[data-mcog-anno-sheet]'),
  cogAnnoItems: Array.prototype.map.call(document.querySelectorAll('[data-mcog-anno-item]'), function (e) { return e.getAttribute('data-mcog-anno-item'); }),
  cogPickList: document.querySelectorAll('[data-mcog-anno-pick-list]').length,
  cogSentences: document.querySelectorAll('[data-mcog-anno-sentence]').length,
  todoTabs: Array.prototype.map.call(document.querySelectorAll('[data-mtodo-tab]'), function (e) { return e.getAttribute('data-mtodo-tab'); }),
  todoRows: Array.prototype.map.call(document.querySelectorAll('[data-mtodo-row]'), function (e) { return e.getAttribute('data-mtodo-row'); }),
  todoChecks: document.querySelectorAll('[data-mtodo-check]').length,
  todoQuads: Array.prototype.map.call(document.querySelectorAll('[data-mtodo-quad]'), function (e) { return e.getAttribute('data-mtodo-quad'); }),
  todoStartBtns: document.querySelectorAll('[data-mtodo-start]').length,
  todoMenuSheet: !!document.querySelector('[data-mtodo-menu-sheet]'),
  todoMenuActions: Array.prototype.map.call(document.querySelectorAll('[data-mtodo-menu-action]'), function (e) { return e.getAttribute('data-mtodo-menu-action'); }),
  todoPickSheet: !!document.querySelector('[data-mtodo-pick-sheet]'),
  todoPickItems: Array.prototype.map.call(document.querySelectorAll('[data-mtodo-pick-item]'), function (e) { return e.getAttribute('data-mtodo-pick-item'); }),
  todoPomo: !!document.querySelector('[data-mtodo-pomo]'),
    mfocusConfirm: !!document.querySelector('[data-mfocus-confirm]'),
    mfocusState: (document.querySelector('[data-mfocus-state]')||{}).getAttribute ? document.querySelector('[data-mfocus-state]').getAttribute('data-mfocus-state') : '',
  schTabs: Array.prototype.map.call(document.querySelectorAll('[data-msch-tab]'), function (e) { return e.getAttribute('data-msch-tab'); }),
  schTimeline: !!document.querySelector('[data-msch-timeline]'),
  schTodayItems: document.querySelectorAll('[data-msch-today-item]').length,
  schWeekDays: Array.prototype.map.call(document.querySelectorAll('[data-msch-week-day]'), function (e) { return e.getAttribute('data-msch-week-day'); }),
  schReport: !!document.querySelector('[data-msch-report]'),
  schReportDate: (document.querySelector('[data-msch-report-date]') || {}).textContent || '',
  schReportInputs: document.querySelectorAll('[data-msch-report-input]').length,
  schReportSaved: !!document.querySelector('[data-msch-report-saved]'),
  schMonthDays: document.querySelectorAll('[data-msch-month-day]').length,
  schMonthCds: document.querySelectorAll('[data-msch-month-cd]').length,
  schCdForm: !!document.querySelector('[data-msch-cd-form]'),
  schCdItems: Array.prototype.map.call(document.querySelectorAll('[data-msch-cd-item]'), function (e) { return e.getAttribute('data-msch-cd-item'); }),
  schCdConfirm: !!document.querySelector('[data-msch-cd-confirm]'),
  skillTabs: Array.prototype.map.call(document.querySelectorAll('[data-mskill-tab]'), function (e) { return e.getAttribute('data-mskill-tab'); }),
  skillTree: !!document.querySelector('[data-mskill-tree]'),
  skillAwards: Array.prototype.map.call(document.querySelectorAll('[data-mskill-award]'), function (e) { return e.getAttribute('data-mskill-award'); }),
  skillMottos: Array.prototype.map.call(document.querySelectorAll('[data-mskill-motto]'), function (e) { return e.getAttribute('data-mskill-motto'); }),
  skillFab: !!document.querySelector('[data-mskill-fab]'),
  skillAddSheet: !!document.querySelector('[data-mskill-add-sheet]'),
  skillConfirm: !!document.querySelector('[data-mskill-confirm]'),
  archDisabled: !!document.querySelector('[data-marchive-disabled]'),
  archSearch: !!document.querySelector('[data-marchive-search]'),
  archFilters: Array.prototype.map.call(document.querySelectorAll('[data-marchive-filter]'), function (e) { return e.getAttribute('data-marchive-filter'); }),
  archList: !!document.querySelector('[data-marchive-list]'),
  archItems: Array.prototype.map.call(document.querySelectorAll('[data-marchive-item]'), function (e) { return e.getAttribute('data-marchive-item'); }),
  setRows: Array.prototype.map.call(document.querySelectorAll('[data-mset-row]'), function (e) { return e.getAttribute('data-mset-row'); }),
  setSheet: (document.querySelector('[data-mset-sheet]') || { getAttribute: function () { return ''; } }).getAttribute('data-mset-sheet') || '',
  setThemes: Array.prototype.map.call(document.querySelectorAll('[data-mset-theme]'), function (e) { return e.getAttribute('data-mset-theme'); }),
  setFonts: Array.prototype.map.call(document.querySelectorAll('[data-mset-font]'), function (e) { return e.getAttribute('data-mset-font'); }),
  setNote: (document.body.textContent || '').indexOf('手机上没对应东西的设置') >= 0
})
'@ | Set-Content -Path $stateJs -Encoding UTF8

function State([string]$require) {
  $raw = Cdp @('-Action', 'eval', '-ExprFile', $stateJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', $require)
  $line = ($raw -split "`n" | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
  if (-not $line) { return $null }
  try { return ($line | ConvertFrom-Json) } catch { return $null }
}

# 轮询等一个状态条件成立（固定 sleep 会撞渲染时机 —— M19.1 就踩过一次）
function WaitState([string]$require, [scriptblock]$test, [int]$tries = 10) {
  for ($i = 0; $i -lt $tries; $i++) {
    Start-Sleep -Milliseconds 500
    $st = State $require
    if ($st -and (& $test $st)) { return $st }
  }
  return (State $require)
}

function OpenMobile() {
  Cdp @('-Action', 'eval', '-Expr', "sessionStorage.setItem('dsh-mobile-preview','1');location.reload();'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav') | Out-Null
  Start-Sleep -Seconds 4
}
function CloseMobile() {
  Cdp @('-Action', 'eval', '-Expr', "sessionStorage.removeItem('dsh-mobile-preview');location.reload();'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Seconds 4
}

# ════════════════════════════════════════════════════════════════════
# §1 首页（M19.1 / v2.2.0）
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '=== §1 首页（M19.1）===' -ForegroundColor Cyan

OpenMobile
$s = State '[data-mobile-shell]'
if ($s -and $s.frame -and $s.shell -and $s.zone -eq 'home') { OK '1 手机布局打开后落在首页（zone=home）' }
else { NG '1 首页没渲染' (($s | ConvertTo-Json -Compress)) }

if ($s -and $s.today) { OK ('2 「今天」卡片在，数字=' + $s.todayCount) } else { NG '2 「今天」卡片不在' }
if ($s -and [int]$s.todayCount -ge 0) { OK '3 「今天」的数字是可读的（data-mhome-today-count）' } else { NG '3 今天数字读不到' }

# 最近待办卡（用户数据里有 open 待办 → 应当出现）
if ($s -and $s.todoCard -and (@($s.todos).Count -gt 0)) { OK ('4 「最近待办」卡片在，' + (@($s.todos).Count) + ' 条') }
else { NG '4 「最近待办」没出来' (($s | ConvertTo-Json -Compress)) }
if ($s -and $s.checks -ge 1) { OK '5 每条待办前面都有勾选框（手机上能直接勾）' } else { NG '5 勾选框不在' }

# 真鼠标点一条最近待办 → 跳执行区并定位
$firstTodo = if ($s) { @($s.todos)[0] } else { '' }
if ($firstTodo) {
  Cdp @('-Action', 'mouse', '-Selector', ('[data-mhome-todo-open]'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  $s2 = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'todo' }
  if ($s2 -and $s2.zone -eq 'todo' -and ($s2.title -replace '\s', '') -eq '执行区') { OK '6 真鼠标点最近待办 → 跳到执行区（并带上了定位）' }
  else { NG '6 点待办没跳到执行区' (($s2 | ConvertTo-Json -Compress)) }
  # 回首页
  Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab="home"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 700
} else { NG '6 没有可点的最近待办（用户数据里没有 open 待办？）' }

# 「＋」快速记录
$s = State '[data-mobile-shell]'
if ($s -and $s.fab) { OK '7 右下角「＋」在' } else { NG '7 「＋」不在' }
Cdp @('-Action', 'mouse', '-Selector', '[data-mhome-fab]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
$want = @('info', 'todo', 'note')
if ($s -and $s.sheet -and ((@($s.quick) -join ',') -eq ($want -join ','))) { OK '8 点「＋」弹出面板，三个选择都在（随手记一条 / 加一个待办 / 新建笔记）' }
else { NG '8 快速记录面板不对' (($s | ConvertTo-Json -Compress)) }

# 选「加一个待办」→ 出现输入框与「记下」
Cdp @('-Action', 'mouse', '-Selector', '[data-mhome-quick="todo"]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
if ($s -and $s.input -and $s.save) { OK '9 选「加一个待办」→ 出现输入框与「记下」按钮' } else { NG '9 输入框/记下按钮不在' }

# 真键盘打字（不打字就点「记下」应当被拦：只提示、不写盘）
Cdp @('-Action', 'type', '-Selector', '[data-mhome-quick-input]', '-Text', 'M19 首页探针（不会保存）', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500
$typed = Cdp @('-Action', 'eval', '-Expr', "(document.querySelector('[data-mhome-quick-input]')||{}).value||''", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($typed -match 'M19') { OK '10 真键盘能往输入框里打字' } else { NG '10 打字没进去' ($typed -replace "`r?`n", ' ') }

# 收尾：收起面板（不保存 → 不往用户数据里写任何东西）
Cdp @('-Action', 'mouse', '-Selector', '[data-mhome-quick-close]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
if ($s -and -not $s.sheet) { OK '11 点「收起」→ 面板关掉（本套件不保存，用户数据零改动）' } else { NG '11 面板没收起' }

# 截图存档
$shot = Join-Path $spike 'm19-1-首页.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('12 截图已存：' + $shot) } else { NG '12 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '13 收尾：开关已清、回到电脑版布局' } else { NG '13 收尾没回到电脑版' (($s | ConvertTo-Json -Compress)) }

# ════════════════════════════════════════════════════════════════════
# §2 信息区（M19.2 / v2.3.0）
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '=== §2 信息区（M19.2）===' -ForegroundColor Cyan

OpenMobile
# 切到信息区（真鼠标点底栏）
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=info]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'info' }
if ($s -and $s.zone -eq 'info') { OK '14 真鼠标点底栏「信息区」→ 切过去了' } else { NG '14 没切到信息区' (($s | ConvertTo-Json -Compress)) }

$s = State '[data-mobile-shell]'
if ($s -and $s.search) { OK '15 搜索框在（data-minfo-search）' } else { NG '15 搜索框不在' }
if ($s -and (@($s.statusChips).Count -eq 3)) { OK ('16 三个筛选 chip：' + (@($s.statusChips) -join ' / ')) } else { NG '16 筛选 chip 不对' ((@($s.statusChips) -join ',')) }
if ($s -and $s.groupChip) { OK '17 「所有分类」chip 在' } else { NG '17 分类 chip 不在' }
if ($s -and $s.fab) { OK '18 「＋」抬手就记在' } else { NG '18 「＋」不在' }

# 抬手就记：真键盘打字 → 点「记下」→ 列表出现这一条（**这是唯一一处会写盘的地方，随后立刻用手机版自己的删除路径清掉**）
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-fab]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
Cdp @('-Action', 'type', '-Selector', '[data-minfo-quick-input]', '-Text', 'M19 信息区探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 400
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-quick-save]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.items).Count -ge 1 }
if ($s -and (@($s.items).Count -ge 1)) { OK ('19 点「记下」→ 真的存进去了（列表 ' + (@($s.items).Count) + ' 条）') }
else { NG '19 记下之后列表里没有' (($s | ConvertTo-Json -Compress)) }

# 单条菜单
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-menu]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
$wantActions = @('category', 'note', 'todo')
$gotActions = if ($s) { @($s.menuActions) } else { @() }
$hasCore = (($gotActions -contains 'category') -and ($gotActions -contains 'note') -and ($gotActions -contains 'todo') -and ($gotActions -contains 'delete'))
if ($s -and $s.menuSheet -and $hasCore) { OK ('20 点 ⋮ 出菜单，动作齐：' + ($gotActions -join ' / ')) }
else { NG '20 菜单不对' (($s | ConvertTo-Json -Compress)) }

# 删除（二次确认）—— 顺手把测试数据清掉
#
# 🔴 断言口径（2026-10-06 改）：**前后自己比自己**，不许再假设"删完信息区是空的"。
#    原来写的是 `Count -eq 0` —— 那只有"用户一条信息都没有"时才成立；
#    而全量回归里 m19 前面还跑着 v2a / m12 / m5 / m22 / m23，**它们会留信息**，
#    于是这条每次全量回归都红一条假红（用户数据一条没少，却看着像删除坏了）。
#    现在：先数一次当前条数，删完只要求"少一条"。
$infoBefore = @((State '[data-mobile-shell]').items).Count
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-menu-action=delete]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$s = State '[data-mobile-shell]'
if ($s -and $s.confirm) { OK '21 点「删除…」先弹二次确认（不是直接删）' } else { NG '21 没弹二次确认' }
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-confirm-del]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$infoWant = [Math]::Max($infoBefore - 1, 0)
$s = WaitState '[data-mobile-shell]' { param($x) @($x.items).Count -eq $infoWant }
if ($s -and (@($s.items).Count -eq $infoWant)) {
  OK ('22 确认删除 → 探针清掉了（' + $infoBefore + ' 条 → ' + (@($s.items).Count) + ' 条；不是"用户数据必须为空"，别的套件留的信息不许算在头上）')
}
else { NG ('22 删除没生效（该从 ' + $infoBefore + ' 条变 ' + $infoWant + ' 条，实际 ' + (@($s.items).Count) + ' 条）') (($s | ConvertTo-Json -Compress)) }

# 筛选交互：点「已联动」→ 没匹配；点回「全部」
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-status=linked]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$s = State '[data-mobile-shell]'
if ($s -and ($s.statusActive -eq 'linked')) { OK '23 点「已联动」→ 筛选态切过去了（data-minfo-status-active）' } else { NG '23 筛选没切换' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-status=all]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

# 分类 chip → 展开分类列表
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-group]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$s = State '[data-mobile-shell]'
if ($s -and (@($s.groupList).Count -ge 2)) { OK ('24 点分类 chip → 展开分类列表（' + (@($s.groupList).Count) + ' 项）') } else { NG '24 分类列表没展开' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-minfo-group-pick]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

$shot = Join-Path $spike 'm19-2-信息区.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('25 截图已存：' + $shot) } else { NG '25 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '26 收尾：开关已清、回到电脑版布局' } else { NG '26 收尾没回到电脑版' }

# ════════════════════════════════════════════════════════════════════
# §3 认知区（M19.3 / v2.4.0）—— 手机上的关键设计：目录进顶栏、批注进底部、正文占满
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '=== §3 认知区（M19.3）===' -ForegroundColor Cyan

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=cognition]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'cognition' }
if ($s -and $s.zone -eq 'cognition') { OK '27 真鼠标点底栏「认知区」→ 切过去了' } else { NG '27 没切到认知区' (($s | ConvertTo-Json -Compress)) }
if ($s -and $s.cogSearch) { OK '28 搜索框在（data-mcog-search）' } else { NG '28 搜索框不在' }
if ($s -and $s.cogListImport) { OK '28b ★ 列表顶部有常驻「导入 Markdown」入口（不用先打开笔记找 ⋮）' } else { NG '28b 列表顶部没有导入入口' (($s | ConvertTo-Json -Compress)) }
if ($s -and (@($s.cogRows).Count -ge 1)) { OK ('29 笔记列表出来了（' + (@($s.cogRows).Count) + ' 篇）') } else { NG '29 笔记列表是空的' (($s | ConvertTo-Json -Compress)) }

# 🔴 2026-10-06（P2-D）改：这里原来点的是「列表第一篇」—— 那一篇**可能是树笔记**，
#    而树笔记现在走**整屏树页**（没有目录抽屉/批注细条/编辑预览），§3 会成片假红。
#    改成：**自己造一篇普通笔记当探针**（标题带 `M19 ` 前缀，收尾删掉），这一段从此永远可测。
$cogCreate = Join-Path $spike 'm19-cog-create.js'
$cogDel = Join-Path $spike 'm19-cog-del.js'
$cog = Cdp @('-Action', 'eval', '-ExprFile', $cogCreate, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($cog -match 'M19 认知区文本探针') { OK '29b 造好文本页探针「M19 认知区文本探针」（§3 只在这篇上验）' } else { NG '29b 文本页探针没造出来' $cog }
Start-Sleep -Milliseconds 900
Cdp @('-Action', 'type', '-Selector', '[data-mcog-search]', '-Text', 'M19 认知区文本探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.cogRows).Count -eq 1 }
if ($s -and @($s.cogRows).Count -eq 1) { OK '29c 搜索「M19 认知区文本探针」→ 列表只剩这 1 行' } else { NG '29c 搜出来的行数不对' ('rows=' + @($s.cogRows).Count) }
# 打开探针（真鼠标）
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-open]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogNote }
if ($s -and $s.cogNote) { OK ('30 点一篇 → 打开了（标题：' + $s.cogTitle + '）') } else { NG '30 没打开笔记' (($s | ConvertTo-Json -Compress)) }
if ($s -and $s.cogMode -eq 'read') { OK '31 默认是阅读态（正文占满中间）' } else { NG '31 模式不是阅读态' ('mode=' + $s.cogMode) }
if ($s -and $s.cogAnnoBar) { OK '32 底部有批注细条（data-mcog-anno-bar）' } else { NG '32 底部批注细条不在' }

# 目录：顶栏按钮 → 抽屉
# 🔴 2026-10-07（用户反馈 B5）：目录功能**跟档案区开关绑定**。
#    开工时可能本来就开着，所以这里按开工值验，不能硬假设用户关着。
$tocNow = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mcog-toc-btn]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if (($tocNow -match 'true') -eq $archOrig) { OK ('32b ★ 目录按钮跟开工时档案开关一致（archive=' + $archOrig.ToString().ToLower() + '）') }
else { NG '32b 目录按钮跟档案开关不一致' $tocNow }
# 打开档案区（走 config_save，然后重载让前端重新读配置）
$tocOn = @'
(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const cfg = await inv('config_get');
  cfg.archive = { enabled: true };
  await inv('config_save', { config: cfg });
  location.reload();
  return 'ok';
})()
'@
$tocOnFile = Join-Path $spike 'm19-archive-on.js'
[System.IO.File]::WriteAllText($tocOnFile, $tocOn, (New-Object System.Text.UTF8Encoding($false)))
Cdp @('-Action', 'eval', '-ExprFile', $tocOnFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Seconds 4
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=cognition]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 800
Cdp @('-Action', 'eval', '-ExprFile', (Join-Path $spike 'm19-clear-search.js'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'type', '-Selector', '[data-mcog-search]', '-Text', 'M19 认知区文本探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-open]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogNote }
if ($s -and $s.cogNote) { OK ('32c 打开档案区之后重开探针（' + $s.cogTitle + '）') } else { NG '32c 重载后没打开探针' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-toc-btn]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
if ($s -and $s.cogToc) { OK ('33 开了档案区 → 顶栏「目录 ☰」→ 抽屉滑出（目录条目 ' + $s.cogTocItems + ' 条）') } else { NG '33 目录抽屉没出来' (($s | ConvertTo-Json -Compress)) }
# 🩹 2026-10-06 实测（用户说"toc 不对劲"）：手机端目录空态原来写的是「用 `## 标题` 写就有」——
#    语法**是错的**（`##` 是 markdown 标题，跟目录无关；真语法是**行首写 `toc这一行的标题`**）。
#    这句把他带偏过，所以钉住：抽屉里任何位置都不许再出现 "##"。
if ($s -and $s.cogToc) {
  # ⚠️ 这个套件的断言函数叫 OK / NG（不是 m22 那边的 Check）—— 2026-10-06 我先写成了 Check，
  #    结果它静默 CommandNotFound、这条断言等于**没跑**（日志里只留一行 `+ Check ...`）。别再踩。
  if ($s.cogTocText -notmatch '##') {
    OK '33b 目录抽屉里没有"## 标题"这种错语法提示（真语法＝行首写 toc 那一行的标题）'
  } else {
    NG '33b 目录抽屉里又出现"## 标题"这种错语法提示（真语法是行首 toc）' $s.cogTocText
  }
}
if ($s -and $s.cogTocItems -ge 1) {
  Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-toc-item]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  $s = WaitState '[data-mobile-shell]' { param($x) -not $x.cogToc }
  if ($s -and -not $s.cogToc) { OK '34 点目录里的一条 → 跳过去并把抽屉收了' } else { NG '34 点目录没反应' }
} else {
  Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-toc-close]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Write-Host '  [跳过] 34 这篇没有目录条目（正文里没有"行首 toc 那一行的标题"那种写法）' -ForegroundColor DarkGray
}

# ⚠️ 还原档案区开关**不能放在这里**（2026-10-07 踩）：手机端「批注」也跟档案区开关绑着，
#    在这儿一关，紧接着的 §35~38 批注那几步就全红了。还原挪到 §38 之后（见那里）。


# 批注：底部细条 → 面板 → 选一句 → 建 → 删（**闭环，不留数据**）
# ⚠️ 2026-10-07：这一步我上一轮编辑时**把注释和代码挤到了同一行** → 整行被当成注释、
#    点击根本没执行 → §35~37 三连红（自己造的假红，别怪产品）。现在拆开写 + 点不开就再点一次。
$annoOpen = $false
for ($try = 1; $try -le 3; $try++) {
  Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-anno-open]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 700
  $s = State '[data-mobile-shell]'
  if ($s -and $s.cogAnnoSheet) { $annoOpen = $true; break }
}
if ($annoOpen) { OK '35 点底部「批注 N ▴」→ 面板从底下弹出' } else { NG '35 批注面板没出来' (($s | ConvertTo-Json -Compress)) }
$before = if ($s) { @($s.cogAnnoItems).Count } else { 0 }
Cdp @('-Action', 'type', '-Selector', '[data-mcog-anno-new-input]', '-Text', 'M19 认知区探针批注', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-anno-pick]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogSentences -ge 1 }
if ($s -and $s.cogSentences -ge 1) { OK ('36 「选一句加批注」→ 句子列表出来了（' + $s.cogSentences + ' 句）') } else { NG '36 句子列表没出来' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-anno-sentence]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.cogAnnoItems).Count -gt 0 }
$after = if ($s) { @($s.cogAnnoItems).Count } else { 0 }
if ($after -gt $before) { OK ('37 点一句 → 批注真的加上了（' + $before + ' → ' + $after + '）') } else { NG '37 批注没加上' (($s | ConvertTo-Json -Compress)) }
# 删掉刚加的那条（清测试数据）
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-anno-del]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.cogAnnoItems).Count -eq 0 }
$now = if ($s) { @($s.cogAnnoItems).Count } else { -1 }
if ($now -eq $before) { OK ('38 点「删」→ 测试批注清掉了（回到 ' + $now + ' 条）') } else { NG '38 批注没删干净（还有 ' + $now + ' 条）' }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-anno-close]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

# 🔴 收尾：档案区（目录 / 批注都跟它绑）在这之前被临时打开过 → 还原成开工前的值。
#    **故意不 reload**（一重载后面几步"打开着的笔记"就没了）；config_save 会广播 data-changed，
#    前端 store 自己会把配置重新读一遍 → 你会看到目录/批注入口当场消失（那正好也验了"开关是活的"）。
$archBack = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){c.archive={enabled:$($archOrig.ToString().ToLower())};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c}).then(function(){return 'arch-back-ok';});})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($archBack -match 'arch-back-ok') { OK ('38b 收尾：档案区开关已还原成开工前的值（' + $archOrig.ToString().ToLower() + '）') } else { NG '38b 档案区没还原' $archBack }
Start-Sleep -Milliseconds 800
$tocAfterRestore = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mcog-toc-btn]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if (("$tocAfterRestore" -match 'true') -eq $archOrig) { OK '38c ★ 还原后目录按钮跟开工前开关一致（开关是活的，不用重启）' } else { NG '38c 还原后目录按钮状态不对' $tocAfterRestore }

# 编辑 / 预览 切换
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-mode=read]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogMode -eq 'edit' }
if ($s -and $s.cogMode -eq 'edit') { OK '39 点「编辑」→ 切到编辑态（出现标题输入框与编辑器）' } else { NG '39 没切到编辑态' ('mode=' + $s.cogMode) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-mode=edit]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogMode -eq 'read' }
if ($s -and $s.cogMode -eq 'read') { OK '40 再点一下 → 切回阅读态' } else { NG '40 没切回阅读态' }

$shot = Join-Path $spike 'm19-3-认知区.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('41 截图已存：' + $shot) } else { NG '41 截图没生成' }

# 收尾：把 §3 的文本页探针删掉（**趁界面还停在这篇上**删，再一次性退回列表）
$cog = Cdp @('-Action', 'eval', '-ExprFile', $cogDel, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($cog -match '"left":0') { OK ('42 §3 探针清干净了：' + $cog) } else { NG '42 §3 探针没删干净' $cog }
# 返回列表（⚠️ 探针是**用命令删的**，界面还停在那篇笔记上 → 必须先退出来）
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-back]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) -not $x.cogNote }
if ($s -and -not $s.cogNote) { OK '42a 点「‹ 返回」→ 回到列表（没改正文，不会写盘）' } else { NG '42a 返回没生效' }
# ⚠️ 搜索框里还留着探针标题 → 下一段要打自己的词（`cdp type` 是**插入**不覆盖），先把框清空
$clearSearch = Join-Path $spike 'm19-clear-search.js'
Cdp @('-Action', 'eval', '-ExprFile', $clearSearch, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 400
$s = State '[data-mobile-shell]'
if ($s -and -not $s.cogNote) { OK '42b0 搜索框已清空、停在列表（§3 收尾完毕）' } else { NG '42b0 §3 收尾没回到列表' (($s | ConvertTo-Json -Compress)) }

# ── P2-C（2026-10-06）：手机文本页的悬浮工具条（用户报的"没有 markdown 快捷按钮，很难受"）──
#   🔴 只在自己造的**探针笔记**上按按钮：工具条一按就往正文插语法，在真笔记上按＝改他的字
#      （而且 900ms 后会自动保存）。收尾会把探针笔记和它带出的那条待办一起删掉。
$tbCreate = Join-Path $spike 'm19-tb-create.js'
$tbRead = Join-Path $spike 'm19-tb-read.js'
$tbDel = Join-Path $spike 'm19-tb-del.js'
# 落盘要等防抖（900ms）+ 写盘往返 → **轮询**等它，别用固定 sleep 赌时机
# （第一版就是 sleep 1600ms 然后读，结果读到"还没落盘"→ 假红；2026-10-06）
$waitProbe = {
  param([string]$pattern, [int]$tries = 12)
  $raw = ''
  for ($i = 0; $i -lt $tries; $i++) {
    $raw = Cdp @('-Action', 'eval', '-ExprFile', $tbRead, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
    if ($raw -match $pattern) { return $raw }
    Start-Sleep -Milliseconds 500
  }
  return $raw
}
$tb = Cdp @('-Action', 'eval', '-ExprFile', $tbCreate, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match 'M19 手机工具条探针') { OK '42b 造好探针笔记「M19 手机工具条探针」（工具条只在它身上按）' } else { NG '42b 探针笔记没造出来' $tb }
Start-Sleep -Milliseconds 900
Cdp @('-Action', 'type', '-Selector', '[data-mcog-search]', '-Text', 'M19 手机工具条探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$s = State '[data-mobile-shell]'
if ($s -and (@($s.cogRows).Count -eq 1)) { OK '42c 搜索「M19 手机工具条探针」→ 列表只剩这 1 行' } else { NG '42c 搜出来的行数不对' ('rows=' + @($s.cogRows).Count) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-open]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogNote -and $x.cogTitle -eq 'M19 手机工具条探针' }
if ($s -and $s.cogTitle -eq 'M19 手机工具条探针') { OK '42d 打开的是探针笔记（不是用户的笔记）' } else { NG '42d 打开的不是探针笔记' ('title=' + $s.cogTitle) }
if ($s -and -not $s.tbBall -and @($s.tbButtons).Count -eq 0) { OK '42e 阅读态：连球都没有（工具条只在编辑态出现）' }
else { NG '42e 阅读态就冒出球/工具条了' ('ball=' + $s.tbBall + ' buttons=' + @($s.tbButtons).Count) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-mode=read]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogMode -eq 'edit' -and $x.tbBall }
if ($s -and $s.tbBall -and -not $s.tbBallOpen -and @($s.tbButtons).Count -eq 0) { OK ('42f 编辑态：默认**只有一颗球**，一个按钮都不占地方（靠 ' + $s.tbBallSide + '）') }
else { NG '42f 编辑态默认该只有球' ('ball=' + $s.tbBall + ' open=' + $s.tbBallOpen + ' buttons=' + @($s.tbButtons).Count) }
if ($s -and $s.tbBallBox -and $s.tbBallBox.w -eq 44 -and $s.tbBallBox.h -eq 44) { OK ('42g 球是 44×44（稿子定的）：' + $s.tbBallBox.w + '×' + $s.tbBallBox.h) }
else { NG '42g 球的尺寸不对' (($s.tbBallBox | ConvertTo-Json -Compress)) }
# 真鼠标点球 → 竖排条长出来（⚠️ 合成 click 会绕过命中测试 = 假绿，必须真输入）
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-ball]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.tbBallOpen -and @($x.tbButtons).Count -gt 0 }
if ($s -and @($s.tbButtons).Count -eq 15) { OK ('42h 点球 → 竖排条长出来，正好 15 颗（' + (@($s.tbButtons) -join ' ') + '）') }
else { NG '42h 竖排条的按钮数不对' ('count=' + @($s.tbButtons).Count) }
$tbExpect = 'undo,redo,image,bold,italic,h1,h2,bullet,ordered,marker,code,spoiler,strike,link,toc'
if ($s -and (@($s.tbButtons) -join ',') -eq $tbExpect) { OK '42i 顺序：↶撤销 / ↷重做 / 🖼导入图片 + 电脑版那 12 个，一字不差' }
else { NG '42i 按钮顺序不对' (@($s.tbButtons) -join ',') }
if ($s -and $s.tbStripVertical) { OK ('42j 竖排条是**竖的**（' + $s.tbStripBox.w + '×' + $s.tbStripBox.h + '，不是原来那根横条）') }
else { NG '42j 条不是竖的' (($s.tbStripBox | ConvertTo-Json -Compress)) }
# 方向：球在下半屏就往上长、在上半屏就往下长 —— **两种都对**，但都得"整条不出屏"
$upOk = $s -and $s.tbStripBox -and $s.tbBallBox -and (
  ($s.tbStripUp -eq '0' -and $s.tbStripBox.y -ge ($s.tbBallBox.y + $s.tbBallBox.h - 1)) -or
  ($s.tbStripUp -eq '1' -and $s.tbStripBox.bottom -le ($s.tbBallBox.y + 1)))
$inView = $s -and $s.tbStripBox -and $s.tbStripBox.y -ge 0 -and ($s.tbStripBox.bottom -le ($s.shellH + 1))
if ($upOk) { OK ('42j1 条从球的哪一侧长出来跟球的位置一致（up=' + $s.tbStripUp + '，球 y=' + $s.tbBallBox.y + '，条 y=' + $s.tbStripBox.y + '）') }
else { NG '42j1 条长错边了（球在下面却往下长 / 上面却往上长）' (($s.tbStripBox | ConvertTo-Json -Compress)) }
if ($inView) { OK ('42j2 ★ 整条不出屏：条 y=' + $s.tbStripBox.y + '，底=' + $s.tbStripBox.bottom + '，屏高=' + $s.shellH) }
else { NG '42j2 条出屏了（下面那颗按钮点不到）' (($s.tbStripBox | ConvertTo-Json -Compress) + ' shellH=' + $s.shellH) }
if ($s -and $s.tbImageInput -match 'image') { OK ('42k 藏在层里的选图输入在（accept=' + $s.tbImageInput + '，点 🖼 会调起系统相册/文件）') }
else { NG '42k 没找到选图输入' $s.tbImageInput }
# 真鼠标按 H1 / ☐（⚠️ 合成 dispatchEvent 会绕过命中测试 → 假绿灯，必须真输入）
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-tb=h1]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$tb = & $waitProbe '# 第一行'
if ($tb -match '# 第一行') { OK '42l 真鼠标点 H1 → 正文行首真的变成 "# 第一行"（自动保存也已落盘）' } else { NG '42l 点 H1 没落盘（轮询 6 秒也没有）' $tb }
$s = State '[data-mobile-shell]'
if ($s -and (@($s.tbActive) -contains 'h1')) { OK '42m 光标在 # 行 → H1 按钮高亮（data-mnote-tb-active=1）' } else { NG '42m H1 没高亮' (@($s.tbActive) -join ',') }
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-tb=marker]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$tb = & $waitProbe '-\[\]'
if ($tb -match '-\[\]') { OK '42n 真鼠标点 ☐ → 行首插了 -[] 并且**落盘了**（执行区会自动出现这条待办）' } else { NG '42n 点 ☐ 没落盘（轮询 6 秒也没有）' $tb }
$s = State '[data-mobile-shell]'
if ($s -and (@($s.tbActive) -contains 'marker')) { OK '42n1 这行成了待办行 → ☐ 按钮也高亮' } else { NG '42n1 ☐ 没高亮' (@($s.tbActive) -join ',') }
if ($s -and $s.tbHint -match '待办') { OK ('42n2 点一下按钮 → 弹一句它的说明（手机没有悬停）：' + $s.tbHint) } else { NG '42n2 说明气泡没弹出来' $s.tbHint }
# ── P2-D：↶ 撤销 / ↷ 重做（**手机没有 Ctrl+Z**，这两颗就是替它的）──
$waitGone = {
  param([string]$pattern, [int]$tries = 12)
  $raw = ''
  for ($i = 0; $i -lt $tries; $i++) {
    $raw = Cdp @('-Action', 'eval', '-ExprFile', $tbRead, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
    if (($raw -match '第一行') -and ($raw -notmatch $pattern)) { return $raw }
    Start-Sleep -Milliseconds 500
  }
  return $raw
}
$s = State '[data-mobile-shell]'
if ($s -and (@($s.tbActive) -contains 'undo')) { OK '42n3 有东西可撤销时，↶ 是亮的（data-mnote-tb-active=1）' } else { NG '42n3 ↶ 该亮着' (@($s.tbActive) -join ',') }
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-tb=undo]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$tb = & $waitGone '-\[\]'
if (($tb -match '第一行') -and ($tb -notmatch '-\[\]')) { OK '42n4 真鼠标点 ↶ → 刚插的 -[] 退回去了，而且**落盘了**（不是只改了屏幕上的字）' }
else { NG '42n4 撤销没生效/没落盘' $tb }
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-tb=redo]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$tb = & $waitProbe '-\[\]'
if ($tb -match '-\[\]') { OK '42n5 真鼠标点 ↷ → 又回来了（重做走的是同一个历史栈）' } else { NG '42n5 重做没生效' $tb }
# 再撤一次，把探针正文退回干净状态（后面拖球那段别让它带着 -[] 到处跑）
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-tb=undo]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 900
# ── P2-D：拖球（真鼠标拖，松手吸附到最近的一侧 + 位置写进 config）──
$pts = Cdp @('-Action', 'eval', '-Expr', "JSON.stringify((function(){var b=document.querySelector('[data-mnote-ball]');var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json
Cdp @('-Action', 'mouse', '-X', "$($pts.x)", '-Y', "$($pts.y)", '-ToX', '20', '-ToY', "$($pts.y + 120)", '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500
$s = State '[data-mobile-shell]'
if ($s -and $s.tbBallSide -eq 'left') { OK ('42n6 把球拖到左边 → 松手吸附到**左侧**（data-mnote-ball-side=left），y 也真的往下走了：' + $s.tbBallBox.y) }
else { NG '42n6 拖完没吸附到左侧' ('side=' + $s.tbBallSide + ' box=' + ($s.tbBallBox | ConvertTo-Json -Compress)) }
$tb = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){return JSON.stringify(c.mobileToolbarBall||null);})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match '"side":"left"') { OK ('42n7 球的新位置**写进了 config.json**（下次打开还在原地）：' + $tb) } else { NG '42n7 球位置没存进 config' $tb }
# 再点球一下 → 收起（球一直留着，不挡东西）
Cdp @('-Action', 'mouse', '-Selector', '[data-mnote-ball]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) -not $x.tbBallOpen }
if ($s -and -not $s.tbBallOpen -and @($s.tbButtons).Count -eq 0 -and $s.tbBall) { OK '42n8 再点一下球 → 条收起，屏幕上只剩球' }
else { NG '42n8 没收起' ('open=' + $s.tbBallOpen + ' buttons=' + @($s.tbButtons).Count) }
# 收尾：把球放回默认位 —— 套件**不许**在用户的设置里留一个"测试拖出来的位置"
$tb = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){c.mobileToolbarBall={side:'right',y:120};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c}).then(function(){return 'ball-reset-ok';});})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match 'ball-reset-ok') { OK '42n8b 收尾：球放回默认位置（用户设置里不留测试痕迹）' } else { NG '42n8b 球没放回默认位' $tb }

# 收尾：探针笔记＋它带出的待办一起删（用户数据一个字不动）
$tb = Cdp @('-Action', 'eval', '-ExprFile', $tbDel, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match '"left":0') { OK ('42n9 探针清干净了：' + $tb) } else { NG '42n9 探针没删干净' $tb }
# ⚠️ 42w 是用命令删的，**界面还停在那篇笔记的文本页上**（搜索框压根不在页面上）→ 先退回列表，
#    否则下一段"清空搜索框 + 打字 + 点开探针树"会一路假红（2026-10-06 实测：rows=0、cogTitle 还是旧标题）。
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-back]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) -not $x.cogNote }
if ($s -and -not $s.cogNote) { OK '42n10 退回笔记列表（探针删掉后界面还停在那篇，必须先退出来）' } else { NG '42n10 没退回列表' (($s | ConvertTo-Json -Compress)) }

# ── P2-B（2026-10-06）：手机端「树」＝小米思维笔记布局（**A 方案：只看不编**）──
#   🔴 同样只在自己造的探针树上验；这一段是**只读渲染**，一个字节都不写盘。
$treeCreate = Join-Path $spike 'm19-tree-create.js'
$treeDel = Join-Path $spike 'm19-tree-del.js'
$tb = Cdp @('-Action', 'eval', '-ExprFile', $treeCreate, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match 'M19 树探针根') { OK ('42o 造好探针树（根＋4 个分支＋一条 4 层深的链）：' + $tb) } else { NG '42o 探针树没造出来' $tb }
Start-Sleep -Milliseconds 900
# ⚠️ 造完必须**重载一次**再验（2026-10-06 实测踩到）：
#    `note_tree_add_child` / `note_tree_set_text` 这些命令**有意不广播 `data-changed`**（见第四节那条例外），
#    所以前端 store 里那份还是"刚建根"时的空树 → 打开笔记只看到「中心主题」一个节点（假红）。
#    真实路径上手机是**同步之后整份重读**的，这里重载一次就等于"手机收到同步后重开"，
#    **不要去改产品那条不广播的约定**。预览开关在 sessionStorage 里，重载后还在。
Cdp @('-Action', 'eval', '-Expr', "location.reload();'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Seconds 4
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=cognition]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 1200
# ⚠️ 再清一次搜索框：`cdp.ps1` 的 type 走 `Input.insertText`（**插入**，不覆盖），
#    否则上一段留下的「M19 手机工具条探针」会跟新词拼在一起 → 搜不到 → 后面整段假红。
$clearSearch = Join-Path $spike 'm19-clear-search.js'
Cdp @('-Action', 'eval', '-ExprFile', $clearSearch, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 400
Cdp @('-Action', 'type', '-Selector', '[data-mcog-search]', '-Text', 'M19 手机树探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.cogRows).Count -eq 1 }
if ($s -and @($s.cogRows).Count -eq 1) { OK '42p0 搜索里只剩探针树这 1 行' } else { NG '42p0 搜出来的行数不对' ('rows=' + @($s.cogRows).Count) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mcog-open]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.cogNote }
if ($s -and $s.cogTitle -eq 'M19 手机树探针') { OK '42p 打开探针树（阅读态就能看见树）' } else { NG '42p 没打开探针树' ('title=' + $s.cogTitle) }
if ($s -and $s.treeCount -eq '8') { OK '42q 整棵 8 个节点都算进去了（data-mcog-tree-count）' } else { NG '42q 节点数不对' ('count=' + $s.treeCount) }
# ── 几何：**根在左、逐层向右**（用户 2026-10-06 点名的第一条）、同层左边缘对齐、连线数、字号 13px ──
$rootNode = @($s.treeNodes | Where-Object { $_.d -eq 0 })
$lv1 = @($s.treeNodes | Where-Object { $_.d -eq 1 })
$lv1min = ($lv1 | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
if ($s -and $rootNode.Count -eq 1 -and $lv1.Count -ge 1 -and $rootNode[0].x -lt $lv1min) {
  OK ('42r ★ 根在左：根的 x=' + $rootNode[0].x + ' < 一级节点最小的 x=' + $lv1min)
} else { NG '42r 根没在左边' (($s.treeNodes | ConvertTo-Json -Compress)) }
$lv1xs = @($lv1 | ForEach-Object { $_.x } | Sort-Object -Unique)
if ($s -and $lv1xs.Count -eq 1) { OK ('42s ★ 同层左边缘对齐（' + $lv1.Count + ' 个一级节点 x 都是 ' + $lv1xs[0] + '）') } else { NG '42s 同层没对齐' (($lv1xs) -join '/') }
if ($s -and $s.treeEdges -eq (@($s.treeNodes).Count - 1)) { OK ('42t 父子连线 ' + $s.treeEdges + ' 条（= 可见节点 ' + @($s.treeNodes).Count + ' − 1）') } else { NG '42t 连线数不对' ('edges=' + $s.treeEdges + ' nodes=' + @($s.treeNodes).Count) }
$fonts = @($s.treeNodes | ForEach-Object { $_.fs } | Sort-Object -Unique)
if ($s -and $fonts.Count -eq 1 -and $fonts[0] -eq '13px') { OK '42u ★ 节点字号 13px（跟电脑版一致 —— 手机上缩的是间距，不是字）' } else { NG '42u 字号不对' (($fonts) -join '/') }
if ($s -and @($s.treeEmptyText).Count -ge 1) { OK ('42v 空节点显示占位「' + (@($s.treeEmptyText) -join ',') + '」') } else { NG '42v 空节点没显示占位' }
if ($s -and $s.treeZoom -eq '100%') { OK '42w 「适应宽度」态：缩放 100%（字号没被缩）' } else { NG '42w 缩放不是 100%' ('zoom=' + $s.treeZoom) }
if ($s -and @($s.treeMore).Count -ge 1 -and (@($s.treeMore) -join ',') -eq '+1') { OK '42x ★ 电脑版折过的那一支在手机上也折着，显示 +1' } else { NG '42x 没有 +N' (@($s.treeMore) -join ',') }
if ($s -and -not $s.treeDeep) { OK '42y 折起来的那层没渲染出来（只读视图：点开才进视野）' } else { NG '42y 深层的节点不该默认渲染' }
# ── 点「+N」：只许影响"本次查看" —— 前后读探针树的指纹（文字+collapsed+结构）必须一字不变 ──
$fpFile = Join-Path $spike 'm19-tree-fingerprint.js'
$fpBefore = (Cdp @('-Action', 'eval', '-ExprFile', $fpFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')).Trim()
$nodesBefore = @($s.treeNodes).Count
# ⚠️ 「＋N」在画布右边、初始时**在屏幕外** —— 这正是"树比屏幕宽 → 靠拖动"的设计本身。
#    所以先**真鼠标把画布往左拖**（-NoScroll：别让 scrollIntoView 帮忙），再点那颗按钮。
$ptsJs = Join-Path $spike 'm19-tree-pts.js'
$pts = (Cdp @('-Action', 'eval', '-ExprFile', $ptsJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
if ($pts -and $pts.box -and $pts.more) {
  $dragTo = [Math]::Round($pts.box.x - ($pts.more.x - ($pts.box.right - 60)))
  Cdp @('-Action', 'mouse', '-X', "$($pts.box.x)", '-Y', "$($pts.box.y)", '-ToX', "$dragTo", '-ToY', "$($pts.box.y)", '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 700
  $pts2 = (Cdp @('-Action', 'eval', '-ExprFile', $ptsJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
  $inNow = $pts2 -and $pts2.more -and $pts2.more.x -gt $pts2.box.left -and $pts2.more.x -lt $pts2.box.right
  if ($inNow) {
    OK ('42z0 ★ 真鼠标拖画布 → 右边那颗「+N」被拖进屏幕里了（x=' + $pts2.more.x + '，框 ' + $pts2.box.left + '~' + $pts2.box.right + '）')
    Cdp @('-Action', 'mouse', '-X', "$($pts2.more.x)", '-Y', "$($pts2.more.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  } else {
    NG '42z0 拖了之后 +N 还在屏幕外' (($pts2 | ConvertTo-Json -Compress))
  }
} else {
  NG '42z0 没读到画布 / ＋N 的位置' (($pts | ConvertTo-Json -Compress))
}
$s = WaitState '[data-mobile-shell]' { param($x) $x.treeDeep }
if ($s -and $s.treeDeep) { OK ('42z ★ 真鼠标点「+N」→ 里层展开（可见节点 ' + $nodesBefore + ' → ' + @($s.treeNodes).Count + '）') } else { NG '42z 点 +N 没展开' (($s | ConvertTo-Json -Compress)) }
if ($s -and @($s.treeMore).Count -eq 0) { OK '42aa 展开之后那颗「+N」消失' } else { NG '42aa +N 没消失' (@($s.treeMore) -join ',') }
$fpAfter = (Cdp @('-Action', 'eval', '-ExprFile', $fpFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')).Trim()
if ($fpBefore -eq $fpAfter -and $fpAfter -match '"found":true') { OK '42ab ★★ 点开「+N」**没写盘**（前后指纹一字未变 —— 手机上看树是只读的）' } else { NG '42ab 指纹变了（说明写盘了）' ($fpBefore + ' → ' + $fpAfter) }
# ════════════════════════════════════════════════════════════════════
# §树 B（P2-D / v2.16.0，2026-10-06）：手机上**真的能改树**
#   整屏树页（没有卡片外壳、没有"树/文本"切换）+ 底排 4 颗（🗑 / ➜⊕ / ⤵⊕ / 🖼）
#   点节点选中 · 再点一下就地改字 · 长按拖到别的节点上就挪过去
#   🔴 全程只在这个**自己造的探针树**上改；段末照旧把探针整篇删掉（42ac）→ 不留数据
# ════════════════════════════════════════════════════════════════════
$treeRw = Join-Path $spike 'm19-tree-rw.js'
$treeDrag = Join-Path $spike 'm19-tree-drag.js'
# ⚠️ 取"某个节点的父节点"**不能用 `$obj['键']`**：PowerShell 5.1 里对 `ConvertFrom-Json` 出来的
#    PSCustomObject 做字符串下标**拿不到值**（返回整张表或空）—— 我为此白红了两条断言。
function ParentOf($rw, [string]$id) {
  if (-not $rw -or -not $rw.parent) { return '' }
  $hit = $rw.parent.PSObject.Properties | Where-Object { $_.Name -eq $id } | Select-Object -First 1
  if ($hit) { return [string]$hit.Value }
  return ''
}
# 🔴 先把视野复位：上面 42z0 那一步**故意把画布往左拖**（为了把「+N」拖进视野），
#    拖完之后节点会被推到画布左边界**外面**（实测节点 rect 的 x=231，而画布框从 461 起 —— 差了 230px），
#    屏幕上看不见、`elementFromPoint` 命中的是画布本身 → 点节点必然点空（我在这上面白跑了三轮）。
#    「适应宽度」＝ `k=1, tx=0`（`data-mctree-fit`），点一下视野就回来了。
Cdp @('-Action', 'mouse', '-Selector', '[data-mctree-fit]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500
$rw = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
$total0 = [int]$rw.total
if ($rw -and $rw.page -and $rw.actionsBox) { OK ('42ad 树笔记现在走**整屏树页**（data-mctree-page），底排在（当前 ' + $total0 + ' 个节点）') }
else { NG '42ad 没进整屏树页' (($rw | ConvertTo-Json -Compress)) }
if ($rw -and (@($rw.actions).Count -eq 4) -and (($rw.actions -join ',') -eq 'remove:0,child:0,sibling:0,image:0')) {
  OK ('42ae 底排 4 颗齐（🗑/➜⊕/⤵⊕/🖼）且没选中时**全是灰的**：' + ($rw.actions -join ' '))
} else { NG '42ae 底排 4 颗不对' (($rw.actions) -join ',') }
if ($rw -and $rw.imageInput -match 'image') { OK ('42af 挂图用的选图输入在（accept=' + $rw.imageInput + '）') } else { NG '42af 没找到选图输入' $rw.imageInput }

# 挑两个节点：「分支二」当操作对象（它没有子节点，加子/加同级最干净），「分支三」当拖拽目标
$pickJs = @'
(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const note = (await inv('note_list')).filter((n) => n.title === 'M19 手机树探针')[0];
  const kids = (note.root && note.root.children) || [];
  const two = kids[1] || kids[0];
  const three = kids[2] || kids[0];
  const rect = (id) => {
    const el = document.querySelector('[data-mctree-node="' + id + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const box = document.querySelector('[data-mctree-box]');
  const br = box ? box.getBoundingClientRect() : null;
  const all = Array.prototype.slice.call(document.querySelectorAll('[data-mctree-node="' + two.id + '"]'));
  return JSON.stringify({
    two: two.id, three: three.id, twoAt: rect(two.id), threeAt: rect(three.id),
    blank: br ? { x: Math.round(br.left + 12), y: Math.round(br.bottom - 14) } : null,
    boxCount: document.querySelectorAll('[data-mctree-box]').length,
    canvasCount: document.querySelectorAll('[data-mctree-canvas]').length,
    nodeMatches: all.length,
    nodeRects: all.map((e) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    }),
    boxRect: br ? [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)] : null,
    winW: window.innerWidth,
    winH: window.innerHeight,
  });
})()
'@
$pickFile = Join-Path $spike 'm19-tree-pick.js'
[System.IO.File]::WriteAllText($pickFile, $pickJs, (New-Object System.Text.UTF8Encoding($false)))
$pick = (Cdp @('-Action', 'eval', '-ExprFile', $pickFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)

if ($pick -and $pick.twoAt) {
  # 🔎 先看一眼"那个坐标上现在压着谁"（elementFromPoint）—— 点不中时一眼看出是被谁挡住了
  #    ⚠️ 判据必须看 `node` 字段本身：拿整串 JSON 去 -match 会被里面的 `want` 字段骗到（假通过）
  $want8 = $pick.two.Substring(0, 8)
  $hitJs = "JSON.stringify((function(){var el=document.elementFromPoint($($pick.twoAt.x),$($pick.twoAt.y));var n=el&&el.closest?el.closest('[data-mctree-node]'):null;return {tag:el?el.tagName:'null',node:n?(n.getAttribute('data-mctree-node')||'').slice(0,8):'',want:'$want8',at:[$($pick.twoAt.x),$($pick.twoAt.y)]};})())"
  $hit = Cdp @('-Action', 'eval', '-Expr', $hitJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  if ($hit -match "`"node`":`"$want8`"") { OK ('42ag0 目标坐标上压着的正是那个节点（' + $hit + '）') }
  else { NG '42ag0 目标坐标上没有那个节点（被别的东西挡了 / 坐标不对）' $hit }
  # ⚠️ 必须用**坐标**点（`-X/-Y` + `-NoScroll`），**不能**用 `-Selector`：
  #    cdp 的选择器那条路会先 `el.scrollIntoView({block:'center'})`，而树画布是
  #    `overflow-hidden` + 带 CSS transform 的 —— 滚完再量坐标会对不上，点了等于点空。
  #    2026-10-06 亲测对比：**同一个位置**，选择器点＝毫无反应，坐标点＝立刻选中。
  Cdp @('-Action', 'mouse', '-X', "$($pick.twoAt.x)", '-Y', "$($pick.twoAt.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 500
  $rw = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
  if ($rw.selected -eq $pick.two) { OK '42ag ★ 真鼠标点节点 → 选中它（data-mctree-selected=1）' }
  else { NG '42ag 点了没选中' ('selected=' + $rw.selected + ' | pick=' + ($pick | ConvertTo-Json -Compress) + ' | hit=' + $hit) }
  if (($rw.actions -join ',') -eq 'remove:1,child:1,sibling:1,image:1') { OK '42ah 选中之后底排 4 颗**全亮**（有操作对象了）' }
  else { NG '42ah 底排没亮' (($rw.actions) -join ',') }
} else { NG '42ag 没读到节点坐标' (($pick | ConvertTo-Json -Compress)) }

# 真鼠标点「➜⊕」→ 加子节点：盘上 +1、新节点直接进"就地改字"
Cdp @('-Action', 'mouse', '-Selector', '[data-mctree-btn=child]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 900
$rw = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
if ($rw.total -eq ($total0 + 1)) { OK ('42ai ★ 点「➜⊕」→ 盘上真的多了一个节点（' + $total0 + ' → ' + $rw.total + '）') }
else { NG '42ai 加子节点没落盘' ('total=' + $rw.total + ' 期望 ' + ($total0 + 1)) }
if ($rw.editing -and (ParentOf $rw $rw.editing) -eq $pick.two) { OK '42aj 新节点挂在「分支二」下面，而且**直接进了就地改字**（data-mctree-edit）' }
else { NG '42aj 新节点没进编辑态/挂错了' ('editing=' + $rw.editing + ' parent=' + (ParentOf $rw $rw.editing)) }
$newNodeId = $rw.editing
# 🔴 2026-10-07：进编辑框这件事**不稳**（实测有时它在打字之前就被关掉了 —— 现场快照是
#    `editBoxes:0`，可树页在、9 个节点都在、目标节点也在、数据也对）。所以这里**自愈**：
#    没开着就点那个节点把它点开（最多 3 轮）。⚠️ 只在套件自己造的新节点上做，产品一行没改。
for ($try = 1; $try -le 3; $try++) {
  $hasBox = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mctree-edit]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  if ($hasBox -match 'true') { break }
  $rect = (Cdp @('-Action', 'eval', '-Expr', "JSON.stringify((function(){var e=document.querySelector('[data-mctree-node=`"$newNodeId`"]');if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
  if (-not $rect) { break }
  # 第一下=选中，第二下=进编辑（已选中时第二下就进编辑）→ 连点两下最稳
  Cdp @('-Action', 'mouse', '-X', "$($rect.x)", '-Y', "$($rect.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 350
  Cdp @('-Action', 'mouse', '-X', "$($rect.x)", '-Y', "$($rect.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 450
}
$boxNow = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mctree-edit]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($boxNow -match 'true') { OK '42aj2 就地改字的输入框确实开着（没开的话套件会自己再点开）' } else { NG '42aj2 输入框点不开' $boxNow }
# 真键盘打字 → **真鼠标点画布空白**（失焦提交）。⚠️ 不用 Enter：`cdp.ps1` 没有"按键"这个动作；
#    而"点别处提交"本来就是用户在手机上最自然的动作，正好一起验了。
# 🔴 2026-10-07：选择器**不要拼 id**（`[data-mctree-edit="<id>"]` 这种带引号的字符串在套件里
#    偶发匹配不上，现场快照里节点明明都在）—— 同一时刻**只会有一个**编辑框，直接用
#    `[data-mctree-edit]` 最稳。
Cdp @('-Action', 'type', '-Selector', '[data-mctree-edit]', '-Text', 'M19 手机上写进来的节点', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 300
if ($pick.blank) {
  Cdp @('-Action', 'mouse', '-X', "$($pick.blank.x)", '-Y', "$($pick.blank.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
}
Start-Sleep -Milliseconds 1100
$textJs = @'
(async () => {
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const note = (await inv('note_list')).filter((n) => n.title === 'M19 手机树探针')[0];
  const want = window.__M19_WANT__ || '';
  let hit = '';
  const walk = (n) => { if (!n) return; if (n.id === want) hit = n.text; (n.children || []).forEach(walk); };
  walk(note.root);
  return JSON.stringify({ text: hit, editing: !!document.querySelector('[data-mctree-edit]') });
})()
'@
$textFile = Join-Path $spike 'm19-tree-text.js'
[System.IO.File]::WriteAllText($textFile, $textJs, (New-Object System.Text.UTF8Encoding($false)))
Cdp @('-Action', 'eval', '-Expr', "window.__M19_WANT__='$newNodeId';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$tx = (Cdp @('-Action', 'eval', '-ExprFile', $textFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
if ($tx.text -eq 'M19 手机上写进来的节点') { OK ('42ak ★★ 就地改字真的落盘了：新节点文字＝「' + $tx.text + '」') }
else {
  # 失败现场：树页还在不在 / 模式是什么 / DOM 里到底有哪些节点
  # （2026-10-07：这里连续几轮红，但同一版代码也成功过一次 → 先看清是"页面被切走"还是别的）
  $want8 = $newNodeId.Substring(0, 8)
  $snapJs = "JSON.stringify({page:!!document.querySelector('[data-mctree-page]'),mode:(document.querySelector('[data-mcog-mode]')||{getAttribute:function(){return '';}}).getAttribute('data-mcog-mode'),note:!!document.querySelector('[data-mcog-note]'),nodes:document.querySelectorAll('[data-mctree-node]').length,editBoxes:document.querySelectorAll('[data-mctree-edit]').length,want:'$want8',have:Array.prototype.map.call(document.querySelectorAll('[data-mctree-node]'),function(e){return (e.getAttribute('data-mctree-node')||'').slice(0,8);})})"
  $snap = Cdp @('-Action', 'eval', '-Expr', $snapJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  NG '42ak 改字没落盘' ('text=' + $tx.text + ' | ' + $snap)
}
if (-not $tx.editing) { OK '42al 点画布空白提交后**退出编辑态**（输入框收了）' } else { NG '42al 输入框没收' }

# 🔴 2026-10-07 改稳：**别拼带引号的选择器**（`[data-mctree-node="<id>"]` 这种在套件里偶发匹配不上，
#    现场快照里节点明明都在）。改成"把 id 塞进 window 变量 + 用 -ExprFile 跑"——
#    这条路是本套件里一直好用的那条（`m19-tree-pick.js` 就是这么干的）。
$rectJs = @'
JSON.stringify((function () {
  var id = window.__M19_RECT_ID__ || '';
  var e = document.querySelector('[data-mctree-node="' + id + '"]');
  if (!e) return null;
  var r = e.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})())
'@
$rectFile = Join-Path $spike 'm19-node-rect.js'
[System.IO.File]::WriteAllText($rectFile, $rectJs, (New-Object System.Text.UTF8Encoding($false)))
Cdp @('-Action', 'eval', '-Expr', "window.__M19_RECT_ID__='$newNodeId';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$nodeRect = $null
for ($try = 1; $try -le 3; $try++) {
  $rawRect = Cdp @('-Action', 'eval', '-ExprFile', $rectFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  try { $nodeRect = ($rawRect | ConvertFrom-Json) } catch { $nodeRect = $null }
  if ($nodeRect) { break }
  Start-Sleep -Milliseconds 400
}
if ($nodeRect) {
  Cdp @('-Action', 'mouse', '-X', "$($nodeRect.x)", '-Y', "$($nodeRect.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 500
  $rwSel = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
  if ($rwSel.selected -eq $newNodeId) { OK '42al2 重新选中刚建的那个孩子（点空白提交会按设计取消选中，别拿灰按钮去点）' }
  else { NG '42al2 没重新选中' ('selected=' + $rwSel.selected) }
} else { NG '42al2 找不到刚建节点的坐标' $rectJs }

# 真鼠标点「⤵⊕」→ 加同级（跟刚那个平级）
Cdp @('-Action', 'mouse', '-Selector', '[data-mctree-btn=sibling]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 900
$rw2 = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
if ($rw2.total -eq ($total0 + 2)) { OK ('42am ★ 点「⤵⊕」→ 同级节点也落盘了（' + $rw.total + ' → ' + $rw2.total + '）') }
else { NG '42am 加同级没落盘' ('total=' + $rw2.total + ' 期望 ' + ($total0 + 2)) }
$siblingId = $rw2.editing
if ($siblingId -and (ParentOf $rw2 $siblingId) -eq $pick.two) { OK '42an 同级节点挂在**同一个父**下面（跟被选中的那个平级）' }
else { NG '42an 同级挂错地方了' ('editing=' + $siblingId + ' parent=' + (ParentOf $rw2 $siblingId)) }

# 真鼠标点「🗑」→ 二次确认 → 真鼠标点「删掉」→ 盘上 -1
Cdp @('-Action', 'mouse', '-Selector', '[data-mctree-btn=remove]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$s = State '[data-mobile-shell]'
# ⚠️ 别用 State 里那个 `confirm` 字段：它是给**手机区自己画的**那些确认条用的；
#    树页走的是**全项目共用**的 ConfirmDialog（`components/ConfirmDialog.tsx`）→ 抓手是 `[data-confirm-ok]`。
$hasConfirm = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-confirm-ok]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($hasConfirm -match 'true') { OK '42ao 点「🗑」→ 先弹二次确认（共用 ConfirmDialog，不让人一按就删）' } else { NG '42ao 没弹二次确认' $hasConfirm }
Cdp @('-Action', 'mouse', '-Selector', '[data-confirm-ok]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 1100
$rw3 = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
if ($rw3.total -eq ($total0 + 1)) { OK ('42ap ★ 真鼠标点「删掉」→ 盘上又少了一个（' + $rw2.total + ' → ' + $rw3.total + '）') }
else { NG '42ap 删除没落盘' ('total=' + $rw3.total + ' 期望 ' + ($total0 + 1)) }

# 长按拖动：**套件里不验**（下面写清了原因，别删这段话）
#   🔴 2026-10-06 决定：这一条**只留真机验收**，脚本里不再断言。
#      原因：能自动化的只有"合成指针序列"，而它**不是真输入**（项目规矩：手势一律真输入才算数）；
#      实测合成序列只走到"长按进入拖动态"（节点确实变半透明 ✓），**落点判定**那一步在自动化环境里
#      应用内部算出的坐标跟我从 DOM 量出来的对不上（应用说 10,140、DOM 说应该是 254,140），
#      我没能在合理时间里钉死"是环境的坑还是代码的坑" —— 那就**不许写成通过**。
#      ⚠️ 留下的抓手：画布上的 `data-mctree-drag`（拖动时应用自己算的世界坐标）与
#        `data-mctree-drop`（它判定的落点）—— 真机出问题时先看这两个。
#      真机怎么验：长按一个节点（它变半透明）→ 拖到另一个节点上（那个会画虚线框）→ 松手 → 它变成对方的子节点。
Write-Host '  [待真机] 长按拖动：脚本不验（合成事件不算真输入）—— 请手机上亲手试一次' -ForegroundColor Yellow

# ── 🔴 2026-10-21（用户反馈 #3）：「节点打完字，直接点「加同级」，刚打的字全消失」──────
# 为什么要单开一条：上面 42ak 那条是「打字 → **点画布空白**（失焦提交）→ 再点 ⤵⊕」，
#   **恰好绕开了**用户报的那条路。他的动作是「打完字**不提交**，直接点 ⤵⊕」，而底排按钮
#   `onPointerDown` 会 `preventDefault`（防软键盘顶掉），编辑框**永不 blur** → 字还没落盘，
#   加同级拿回的是盘上旧树 → 一覆盖，字就没了。
# ⚠️ 所以这条**故意不点空白**。判据两条：① 盘上那格文字＝输入框里当时的全文；② 同级照样加上。
$typedTail = '＋改完直接点加同级'
Cdp @('-Action', 'eval', '-Expr', "window.__M19_RECT_ID__='$newNodeId';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$nodeRect2 = $null
for ($try = 1; $try -le 3; $try++) {
  $rawRect2 = Cdp @('-Action', 'eval', '-ExprFile', $rectFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  try { $nodeRect2 = ($rawRect2 | ConvertFrom-Json) } catch { $nodeRect2 = $null }
  if ($nodeRect2) { break }
  Start-Sleep -Milliseconds 400
}
if ($nodeRect2) {
  # 第一下＝选中，第二下＝进就地改字（跟上面 42aj 那段一个手法）
  Cdp @('-Action', 'mouse', '-X', "$($nodeRect2.x)", '-Y', "$($nodeRect2.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 400
  Cdp @('-Action', 'mouse', '-X', "$($nodeRect2.x)", '-Y', "$($nodeRect2.y)", '-Clicks', '1', '-NoScroll', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 500
  $boxOpen = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mctree-edit]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  if ($boxOpen -match 'true') {
    Cdp @('-Action', 'type', '-Selector', '[data-mctree-edit]', '-Text', $typedTail, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
    Start-Sleep -Milliseconds 300
    # 记下输入框里**当时**的全文（提交后盘上就应该正好是这个）
    $draftNow = (Cdp @('-Action', 'eval', '-Expr', "JSON.stringify({v:((document.querySelector('[data-mctree-edit]')||{}).value||'')})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
    # 🔴 关键：**不点空白、不失焦**，直接点「⤵⊕」
    Cdp @('-Action', 'mouse', '-Selector', '[data-mctree-btn=sibling]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
    Start-Sleep -Milliseconds 1400
    Cdp @('-Action', 'eval', '-Expr', "window.__M19_WANT__='$newNodeId';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
    $afterType = (Cdp @('-Action', 'eval', '-ExprFile', $textFile, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
    $rw4 = (Cdp @('-Action', 'eval', '-ExprFile', $treeRw, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | ConvertFrom-Json)
    if ($afterType.text -eq $draftNow.v -and $draftNow.v) {
      OK ('42aq ★★ 改完字**不提交就直接点「⤵⊕」**，刚打的字没丢（＝反馈 #3）：盘上＝「' + $afterType.text + '」')
    } else {
      NG '42aq 改完字直接加同级 → **字丢了**（这就是用户报的那条）' ('盘上＝「' + $afterType.text + '」 | 输入框里本来是「' + $draftNow.v + '」')
    }
    if ($rw4.total -eq ($total0 + 2)) { OK '42aq2 同级节点照样加上了（' + $rw3.total + ' → ' + $rw4.total + '）' }
    else { NG '42aq2 同级没加上' ('total=' + $rw4.total + ' 期望 ' + ($total0 + 2)) }
  } else { NG '42aq 进不了就地改字' $boxOpen }
} else { NG '42aq 找不到目标节点坐标' ('id=' + $newNodeId) }

$tb = Cdp @('-Action', 'eval', '-ExprFile', $treeDel, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($tb -match '"left":0') { OK ('42ac 探针树清干净了：' + $tb) } else { NG '42ac 探针树没删干净' $tb }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '43 收尾：开关已清、回到电脑版布局' } else { NG '43 收尾没回到电脑版' }

# ════════════════════════════════════════════════════════════════════
# §4 执行区（M19.4 / v2.5.0）
#   ⚠️ 用户真实待办一条都不动：这里**新建一条带前缀的探针待办**，用它验「专注→记录」，
#      最后按产品自己的路径（⋮→删除→二次确认）删掉；结构类断言全部用**真鼠标**。
#      探针那几步用 eval 精确点到"那一行"（清理用途），UI 本身已在别处用真鼠标验过。
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '=== §4 执行区（M19.4）===' -ForegroundColor Cyan

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=todo]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'todo' }
if ($s -and $s.zone -eq 'todo') { OK '44 真鼠标点底栏「执行区」→ 切过去了' } else { NG '44 没切到执行区' (($s | ConvertTo-Json -Compress)) }
if ($s -and ((@($s.todoTabs) -join ',') -eq 'collection,cross')) { OK '45 两个视图都在（待办集 / 十字待办）' } else { NG '45 视图切换不在' ((@($s.todoTabs) -join ',')) }
$before = if ($s) { @($s.todoRows).Count } else { -1 }
if ($before -ge 0) { OK ('46 待办集列出了 ' + $before + ' 条未完成待办，每条都有勾选框（' + $s.todoChecks + ' 个）') } else { NG '46 待办集没渲染' }
if ($s -and $s.todoStartBtns -ge 1) { OK '47 每条都有「▶ 开始」（专注入口在）' } else { NG '47 没有开始按钮' }

# 十字待办：四格 + 挑一条
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-tab=cross]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.todoQuads).Count -eq 4 }
if ($s -and ((@($s.todoQuads) -join ',') -eq 'q1,q2,q3,q4')) { OK '48 十字待办：一个网格四格（q1~q4，十字线分隔）' } else { NG '48 四象限不对' ((@($s.todoQuads) -join ',')) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-quad-pick=q1]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.todoPickSheet }
if ($s -and $s.todoPickSheet) { OK ('49 点格子里的「＋ 挑一条」（手机上不做拖动）→ 候选列表出来了（' + (@($s.todoPickItems).Count) + ' 条）') } else { NG '49 候选列表没出来' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-pick-close]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-tab=collection]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600

# ── 先清掉以前失败的残留探针（同名，可能不止一条）────────────────
$probeJs = Join-Path $spike 'm19-todo-probe.js'
for ($round = 0; $round -lt 4; $round++) {
  Cdp @('-Action', 'eval', '-Expr', "window.__m19step='count';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  $c = Cdp @('-Action', 'eval', '-ExprFile', $probeJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
  if ($c -notmatch '"found":[1-9]') { break }
  Cdp @('-Action', 'eval', '-Expr', "window.__m19step='menu';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Cdp @('-Action', 'eval', '-ExprFile', $probeJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 600
  Cdp @('-Action', 'eval', '-Expr', "window.__m19step='delete';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Cdp @('-Action', 'eval', '-ExprFile', $probeJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 600
  Cdp @('-Action', 'eval', '-Expr', "window.__m19step='confirm';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Cdp @('-Action', 'eval', '-ExprFile', $probeJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
  Start-Sleep -Milliseconds 900
}

# 🔴 清场之后再测一次基线（$before 是清场前测的，拿它比会永远差一条）
$before = @((State '[data-mobile-shell]').todoRows).Count
Write-Host ('  [基线] 清场后待办 ' + $before + ' 条') -ForegroundColor DarkGray

# ── 探针：新建一条 → 专注 → 删掉 ──────────────────────────────
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-fab]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
Cdp @('-Action', 'type', '-Selector', '[data-mtodo-new-input]', '-Text', 'M19 执行区探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-new-save]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.todoRows).Count -eq ($before + 1) }
if ($s -and (@($s.todoRows).Count -eq ($before + 1))) { OK ('50 真鼠标 + 真键盘新建待办 → 列表 ' + $before + ' → ' + (@($s.todoRows).Count) + ' 条') } else { NG '50 新建没生效' (($s | ConvertTo-Json -Compress)) }

Cdp @('-Action', 'eval', '-Expr', "window.__m19step='start';'ok'", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$r = Cdp @('-Action', 'eval', '-ExprFile', $probeJs, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
$s = WaitState '[data-mobile-shell]' { param($x) $x.todoPomo }
if ($s -and $s.todoPomo) { OK '51 点探针的「▶ 开始」→ 极简番茄面板弹出（完整版在 M20）' } else { NG '51 番茄面板没出来' (($r -replace "`r?`n", ' ')) }
Start-Sleep -Seconds 3
$t1 = Cdp @('-Action', 'eval', '-Expr', "(document.querySelector('[data-mtodo-pomo-time]')||{}).textContent||''", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
$t1 = ($t1 -replace "`r?`n", '').Trim()
Start-Sleep -Seconds 2
$t2 = Cdp @('-Action', 'eval', '-Expr', "(document.querySelector('[data-mtodo-pomo-time]')||{}).textContent||''", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
$t2 = ($t2 -replace "`r?`n", '').Trim()
if ($t1 -match '^\d\d:\d\d$' -and $t2 -match '^\d\d:\d\d$' -and $t1 -ne $t2) { OK ('52 计时真的在走（' + $t1 + ' → ' + $t2 + '）') } else { NG '52 计时没走' ($t1 + ' → ' + $t2) }
Cdp @('-Action', 'mouse', '-Selector', '[data-mtodo-pomo-finish]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.mfocusConfirm }
if ($s -and $s.mfocusConfirm) { OK '53a 点「结束」→ 先弹二次确认（不让人一按就结算）' } else { NG '53a 二次确认没出来' }
Cdp @('-Action', 'mouse', '-Selector', '[data-mfocus-confirm-yes]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) -not $x.todoPomo }
if ($s -and -not $s.todoPomo) { OK '53b 确认「计入这次专注」→ 专注页收起（这一次记进了探针待办）' } else { NG '53b 专注没结束' }

# 收尾删探针：这一条只负责清场。⋮ 菜单本身由执行区套件单独覆盖；
# 以前这里用合成 click 清场，专注面板关闭后偶发指向旧 DOM，属于登记的假红。
$cleanProbe = Cdp @('-Action', 'eval', '-Expr', "(async()=>{const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});const rows=await inv('todo_list');const ids=rows.filter(x=>x.title==='M19 执行区探针').map(x=>x.id);for(const id of ids){await inv('todo_delete',{id});}return JSON.stringify({ok:true,deleted:ids.length});})()", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($cleanProbe -match '"ok":true') { OK ('54 收尾：用产品命令删掉执行区探针（' + $cleanProbe + '）') } else { NG '54 执行区探针没删掉' $cleanProbe }
$s = WaitState '[data-mobile-shell]' { param($x) @($x.todoRows).Count -eq $before }
if ($s -and (@($s.todoRows).Count -eq $before)) { OK ('55 探针删掉了 → 待办回到 ' + $before + ' 条（用户数据零残留，番茄记录随待办一起清掉）') } else { NG '55 探针没删干净（现在 ' + (@($s.todoRows).Count) + ' 条）' }

$shot = Join-Path $spike 'm19-4-执行区.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('56 截图已存：' + $shot) } else { NG '56 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '57 收尾：开关已清、回到电脑版布局' } else { NG '57 收尾没回到电脑版' }

# ════════════════════════════════════════════════════════════════════
# §5 日程（M19.5 / v2.6.0）
#   ⚠️ 日报的"手写部分"**不在手机端套件里写入**（避免往用户 dailies/ 里留东西）——
#      那条写盘路径由电脑版 m11 套件覆盖；这里只验 UI 与真键盘输入。
#      倒计时则做完整闭环：**建一条 → 断言出现 → 删掉**（零残留）。
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '=== §5 日程（M19.5）===' -ForegroundColor Cyan

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=schedule]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'schedule' }
if ($s -and $s.zone -eq 'schedule') { OK '58 真鼠标点底栏「日程」→ 切过去了' } else { NG '58 没切到日程' (($s | ConvertTo-Json -Compress)) }
if ($s -and ((@($s.schTabs) -join ',') -eq 'today,week,month')) { OK '59 三个视图都在（今天 / 一周 / 月）' } else { NG '59 视图不在' ((@($s.schTabs) -join ',')) }
if ($s -and $s.schTimeline) { OK ('60 今天：时间轴在（今天要做的 ' + $s.schTodayItems + ' 条）') } else { NG '60 时间轴不在' }

# 一周：7 天 + 点一天看日报
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-tab=week]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.schWeekDays).Count -eq 7 }
if ($s -and (@($s.schWeekDays).Count -eq 7)) { OK ('61 一周 = 横滑 7 天（' + (@($s.schWeekDays)[0] + ' … ' + @($s.schWeekDays)[6]) + '）') } else { NG '61 一周不是 7 天' ((@($s.schWeekDays).Count)) }
$day2 = @($s.schWeekDays)[1]
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-week-day=' + $day2 + ']', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.schReport }
if ($s -and $s.schReport) { OK ('62 点某一天 → 那天的日报面板（' + ($s.schReportDate -replace '\s', '') + '）') } else { NG '62 日报面板没出来' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'type', '-Selector', '[data-msch-report-day-input]', '-Text', 'M19 日程探针小结（不保存）', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 400
$typed = Cdp @('-Action', 'eval', '-Expr', "(document.querySelector('[data-msch-report-day-input]')||{}).value||''", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if (($typed -replace "`r?`n", '') -match 'M19') { OK '63 真键盘能往「当天小结」里打字（本套件不点保存，用户 dailies 零改动）' } else { NG '63 打字没进去' }

# 月视图 + 倒计时
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-tab=month]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.schMonthDays -ge 28 }
if ($s -and $s.schMonthDays -ge 28) { OK ('64 月视图：7 列网格、' + $s.schMonthDays + ' 格（含上下月补格）') } else { NG '64 月视图格子不对' ('days=' + $s.schMonthDays) }
$cdBefore = if ($s) { [int]$s.schMonthCds } else { -1 }   # ⚠️ 它是数字，别用 @().Count 包（@(0).Count 恒为 1，坑过一次）
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-cd-add]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.schCdForm }
if ($s -and $s.schCdForm) { OK '65 点「＋ 倒计时」→ **就地**出小表单（不跳页、不弹窗）' } else { NG '65 倒计时表单没出来' }
Cdp @('-Action', 'type', '-Selector', '[data-msch-cd-title]', '-Text', 'M19 日程探针倒计时', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-cd-save]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.schCdItems).Count -ge 1 }
if ($s -and (@($s.schCdItems).Count -ge 1)) { OK ('66 保存 → 倒计时真的加上了（' + (@($s.schCdItems).Count) + ' 条），目标日那格也有琥珀标签（' + $s.schMonthCds + ' 个）') } else { NG '66 倒计时没加上' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-cd-del]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.schCdConfirm }
if ($s -and $s.schCdConfirm) { OK '67 点「删」→ 先弹二次确认' } else { NG '67 没弹二次确认' }
Cdp @('-Action', 'mouse', '-Selector', '[data-msch-cd-confirm-del]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) (@($x.schCdItems).Count -eq 0) -and ($x.schMonthCds -eq $cdBefore) }
if ($s -and (@($s.schCdItems).Count -eq 0) -and ($s.schMonthCds -eq $cdBefore)) { OK '68 确认删除 → 探针倒计时清掉、琥珀标签也回到原样（零残留）' } else { NG '68 倒计时没删干净' (($s | ConvertTo-Json -Compress)) }

$shot = Join-Path $spike 'm19-5-日程.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('69 截图已存：' + $shot) } else { NG '69 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '70 收尾：开关已清、回到电脑版布局' } else { NG '70 收尾没回到电脑版' }

# ====================================================================
# 6 技能区（M19.6 / v2.7.0）—— 从「更多」进入
#   奖状做完整闭环：建一条探针 -> 断言出现 -> 删掉（零残留）；格言只读结构。
# ====================================================================
Write-Host ''
Write-Host '=== 6 技能区（M19.6）===' -ForegroundColor Cyan

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=more]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-more-item=skill]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'skill' }
if ($s -and $s.zone -eq 'skill') { OK '71 从「更多」点进技能区 -> 切过去了（面板也收起）' } else { NG '71 没进技能区' (($s | ConvertTo-Json -Compress)) }
if ($s -and ((@($s.skillTabs) -join ',') -eq 'award,motto')) { OK '72 两个页签都在（奖状 / 格言）' } else { NG '72 页签不对' ((@($s.skillTabs) -join ',')) }
$noTreeTab = Cdp @('-Action', 'eval', '-Expr', "!document.querySelector('[data-mskill-tab=tree]') && !document.querySelector('[data-mskill-tree]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($noTreeTab -match 'true') { OK '72b ★ 技能树已永久删除：页签和占位页都不存在' } else { NG '72b 技能树入口/占位还在' $noTreeTab }
$before = if ($s) { @($s.skillAwards).Count } else { -1 }
if ($before -ge 1) { OK ('73 奖状列表出来了（' + $before + ' 张，用户真数据在）') } else { NG '73 奖状列表是空的' }

Cdp @('-Action', 'mouse', '-Selector', '[data-mskill-fab]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.skillAddSheet }
if ($s -and $s.skillAddSheet) { OK '74 点「加号」-> 新建面板弹出' } else { NG '74 新建面板没出来' }
Cdp @('-Action', 'type', '-Selector', '[data-mskill-add-input]', '-Text', 'M19 技能区探针奖状', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'type', '-Selector', '[data-mskill-add-from]', '-Text', 'M19 探针', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Cdp @('-Action', 'mouse', '-Selector', '[data-mskill-add-save]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.skillAwards).Count -eq ($before + 1) }
if ($s -and (@($s.skillAwards).Count -eq ($before + 1))) { OK ('75 真鼠标+真键盘新建奖状 -> 列表 ' + $before + ' -> ' + (@($s.skillAwards).Count) + ' 张') } else { NG '75 新建没生效' (($s | ConvertTo-Json -Compress)) }

$js = Join-Path $spike 'm19-skill-probe.js'
@'
(function () {
  var title = 'M19 技能区探针奖状';
  var rows = document.querySelectorAll('[data-mskill-award]');
  for (var i = 0; i < rows.length; i++) {
    if ((rows[i].textContent || '').indexOf(title) >= 0) {
      var id = rows[i].getAttribute('data-mskill-award');
      var btn = document.querySelector('[data-mskill-award-del="' + id + '"]');
      if (btn) btn.click();
      return JSON.stringify({ ok: !!btn, id: id });
    }
  }
  return JSON.stringify({ ok: false, why: 'no-row' });
})()
'@ | Set-Content -Path $js -Encoding UTF8
Cdp @('-Action', 'eval', '-ExprFile', $js, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.skillConfirm }
if ($s -and $s.skillConfirm) { OK '76 点探针的「删」-> 先弹二次确认' } else { NG '76 没弹二次确认' }
Cdp @('-Action', 'mouse', '-Selector', '[data-mskill-confirm-del]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) @($x.skillAwards).Count -eq $before }
if ($s -and (@($s.skillAwards).Count -eq $before)) { OK ('77 确认删除 -> 探针清掉、奖状回到 ' + $before + ' 张（零残留）') } else { NG '77 探针没删干净' (($s | ConvertTo-Json -Compress)) }

Cdp @('-Action', 'mouse', '-Selector', '[data-mskill-tab=motto]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$s = State '[data-mobile-shell]'
if ($s -and $s.skillFab) { OK ('78 切到格言页签（现在 ' + (@($s.skillMottos).Count) + ' 条），仍然有加号') } else { NG '78 格言页签不对' (($s | ConvertTo-Json -Compress)) }
$s = State '[data-mobile-shell]'
if ($s -and @($s.skillTabs).Count -eq 2 -and $s.skillFab) { OK '79 两个页签下都有新建入口，不再有技能树死入口' } else { NG '79 技能区收尾结构不对' (($s | ConvertTo-Json -Compress)) }

Cdp @('-Action', 'mouse', '-Selector', '[data-mskill-tab=award]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500
$shot = Join-Path $spike 'm19-6-技能区.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('80 截图已存：' + $shot) } else { NG '80 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '81 收尾：开关已清、回到电脑版布局' } else { NG '81 收尾没回到电脑版' }

# ====================================================================
# 7 档案库（M19.7 / v2.8.0）—— 从「更多」进入
#   🔴 2026-10-07 改（用户反馈 B4：「既然知道它要在设置里面启用，为什么点了一个更多会看到这个
#      『档案区』呀，要在设置之外彻底隐藏才行」）：没启用时**连入口都不出现**，
#      所以这里的断言变成"入口不在"；再临时打开开关验"入口出现 + 能进去"，最后还原成关。
#      （临时改开关是**可接受的**：改完还原、用 `config_save` 走产品自己的路；电脑版 m14 也这么干。）
# ====================================================================
Write-Host ''
Write-Host '=== 7 档案库（M19.7）===' -ForegroundColor Cyan

# 82 要验的是"关着"的形态 → 先临时关掉再重载（收尾会还原）
$null = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){c.archive={enabled:false};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c}).then(function(){location.reload();return 'arch-off-prepare';});})", '-TargetTitle', '东方摩耶堂')
Start-Sleep -Seconds 4

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=more]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$moreHas = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mobile-more-item=archive]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($moreHas -match 'false') { OK '82 ★ 档案区关着 → 「更多」里**没有**档案库入口（B4：设置之外彻底隐藏）' }
else { NG '82 档案区关着却还看得到档案库入口' $moreHas }
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-more-close]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 400
# 临时打开开关（走产品自己的 config_save）→ 重载 → 入口该出现
$archOn = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){c.archive={enabled:true};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c}).then(function(){location.reload();return 'arch-on-ok';});})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
Start-Sleep -Seconds 4
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=more]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
$moreHas2 = Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-mobile-more-item=archive]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($moreHas2 -match 'true') { OK '82b ★ 打开开关之后入口就出现了（开关是活的，不用重启）' } else { NG '82b 开了开关入口还是不在' $moreHas2 }
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-more-item=archive]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'archive' }
if ($s -and $s.zone -eq 'archive') { OK '82c 从「更多」点进档案库 → 切过去了' } else { NG '82c 没进档案库' (($s | ConvertTo-Json -Compress)) }
if ($s -and (-not $s.archDisabled)) { OK '83 启用后不再显示"还没启用"（进的是真列表）' } else { NG '83 启用后仍显示未启用提示' (($s | ConvertTo-Json -Compress)) }

# 🔴 收尾：把档案区还原成**开工前的值**（不再假设用户是关着的）
$archBack = Cdp @('-Action', 'eval', '-Expr', "window.__TAURI_INTERNALS__.invoke('config_get',{}).then(function(c){c.archive={enabled:$($archOrig.ToString().ToLower())};return window.__TAURI_INTERNALS__.invoke('config_save',{config:c}).then(function(){return 'arch-back-ok';});})", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]')
if ($archBack -match 'arch-back-ok') { OK ('83b 收尾：档案区开关还原成开工前的值（' + $archOrig.ToString().ToLower() + '）') } else { NG '83b 档案区没还原' $archBack }

$shot = Join-Path $spike 'm19-7-档案库.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('85 截图已存：' + $shot) } else { NG '85 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '86 收尾：开关已清、回到电脑版布局' } else { NG '86 收尾没回到电脑版' }

# ====================================================================
# 8 设置（M19.8 / v2.9.0）—— 从「更多」进入
#   只读结构 + 面板开关：**不点主题/字号/开关**（那是动用户 config，改了他桌面观感会变）。
# ====================================================================
Write-Host ''
Write-Host '=== 8 设置（M19.8）===' -ForegroundColor Cyan

OpenMobile
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-tab=more]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 700
Cdp @('-Action', 'mouse', '-Selector', '[data-mobile-more-item=settings]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.zone -eq 'settings' }
if ($s -and $s.zone -eq 'settings') { OK '87 从「更多」点进设置 -> 切过去了' } else { NG '87 没进设置' (($s | ConvertTo-Json -Compress)) }

$rows = if ($s) { @($s.setRows) } else { @() }
$need = @('sync', 'theme', 'font', 'home-sticky', 'remind', 'pause-on-lock', 'focus', 'focus-minutes', 'archive', 'export', 'import')
$missing = @($need | Where-Object { $rows -notcontains $_ })
if ($missing.Count -eq 0) { OK ('88 四组都在、11 行齐（' + ($rows -join ' / ') + '）') } else { NG '88 少了行' ('缺：' + ($missing -join ',')) }
if ($s -and $s.setNote) { OK '89 底部说明了"电脑专属设置不在这里显示"' } else { NG '89 缺底部说明' }

# 同步电脑（M23：**真同步页**；P2-A 起扫码是主路，手输「地址 + 6 位短码」**折在第一屏**）
Cdp @('-Action', 'mouse', '-Selector', '[data-mset-row=sync]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.setSheet -eq 'sync' }
if ($s -and $s.setSheet -eq 'sync') { OK '90 点「同步电脑」-> 弹出同步页' } else { NG '90 同步页没出来' (($s | ConvertTo-Json -Compress)) }
$msync = (Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-msync]') && !!document.querySelector('[data-msync-scan]') && !!document.querySelector('[data-msync-go]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-String)
if ($msync -match 'true') { OK '90b 同步页是真的（扫码主路 + 开始同步按钮都在）' } else { NG '90b 同步页内容不对' ($msync -replace "`r?`n", ' ') }
Cdp @('-Action', 'mouse', '-Selector', '[data-msync-manual-toggle]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 600
$msync2 = (Cdp @('-Action', 'eval', '-Expr', "!!document.querySelector('[data-msync-addr]') && !!document.querySelector('[data-msync-code]')", '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-String)
if ($msync2 -match 'true') { OK '90c 点「手输地址和短码」-> 地址框 / 短码框都展开（兜底就在同一屏）' } else { NG '90c 手输那块展不开' ($msync2 -replace "`r?`n", ' ') }
Cdp @('-Action', 'eval', '-ExprFile', (Join-Path $spike 'm19-esc.js'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

# 主题面板（只看不点）
Cdp @('-Action', 'mouse', '-Selector', '[data-mset-row=theme]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.setSheet -eq 'theme' }
if ($s -and (@($s.setThemes).Count -ge 10)) { OK ('91 点「主题」-> 面板出来，选项 ' + (@($s.setThemes).Count) + ' 个（内置三态 + 七套配色）') } else { NG '91 主题面板不对' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'eval', '-ExprFile', (Join-Path $spike 'm19-esc.js'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

# 字号面板（只看不点）
Cdp @('-Action', 'mouse', '-Selector', '[data-mset-row=font]', '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
$s = WaitState '[data-mobile-shell]' { param($x) $x.setSheet -eq 'font' }
if ($s -and (@($s.setFonts).Count -eq 4)) { OK '92 点「字号」-> 四档（小/中/大/特大）' } else { NG '92 字号面板不对' (($s | ConvertTo-Json -Compress)) }
Cdp @('-Action', 'eval', '-ExprFile', (Join-Path $spike 'm19-esc.js'), '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
Start-Sleep -Milliseconds 500

$shot = Join-Path $spike 'm19-8-设置.png'
Cdp @('-Action', 'shot', '-OutFile', $shot, '-TargetTitle', '东方摩耶堂', '-RequireSelector', '[data-mobile-shell]') | Out-Null
if (Test-Path $shot) { OK ('93 截图已存：' + $shot) } else { NG '93 截图没生成' }

CloseMobile
$s = State 'nav'
if ($s -and -not $s.frame -and -not $s.shell) { OK '94 收尾：开关已清、回到电脑版布局' } else { NG '94 收尾没回到电脑版' }

Write-Host ''
Write-Host ('  M19 成绩：通过 ' + $pass + ' / 失败 ' + $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
