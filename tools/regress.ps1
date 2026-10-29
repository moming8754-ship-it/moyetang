# 全量回归一把梭：把 M4 / M5 / M6 / M7 / M7.1 / M8 / M9 / M10.2 / M11 / M12 / M13 几套验收一次跑完
#
# 为什么要有这个脚本：
# 各套脚本的运行方式不一样 —— `m6`~`m9` 是「一个 run.ps1 从头跑到尾」，
# 而 **`m4` / `m5` 是「一步一个 .js、用 run.ps1 -Step 调」**（14 步 / 7 步）。
# 每次改完代码要手工敲十几条命令、还得自己盯着哪一步红了，很容易漏跑或看漏。
# 这里把两种都统一起来，最后打一张成绩表。
#
# 用法（应用要以 CDP 端口起着，见进度.md 第七节）：
#   powershell -ExecutionPolicy Bypass -File tools\regress.ps1
#   powershell -ExecutionPolicy Bypass -File tools\regress.ps1 -Only m9,m8
#   powershell -ExecutionPolicy Bypass -File tools\regress.ps1 -Log D:\东方摩耶堂\backups\regress.log
#
# ⚠️ 两件它**不**做的事（得手动）：
#   ① `tools/m7/quit.ps1` 会真把应用关掉 → 单独跑，关掉之后要重启应用才能接着跑
#      `tools/m7/after-restart.ps1`；
#   ② 它**不会**替你重启应用。跑到一半把应用关了/重启了，后面的套件会一律报
#      "连不上 CDP" 那种假失败。
param(
  [int]$Port = 9222,
  [string]$Only = '',
  [string]$Log = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\notes-app\tools
$app = Split-Path -Parent $here                               # …\notes-app

if (-not $Log) {
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
  $Log = Join-Path $app "backups\regress-$stamp.log"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
"=== 全量回归 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（端口 $Port） ===" |
  Out-File -Encoding UTF8 $Log

function Want([string]$name) {
  if (-not $Only.Trim()) { return $true }
  $list = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  return ($list -contains $name)
}

$script:rows = @()

function Add-Row([string]$name, [int]$passed, [int]$failed, [string]$note = '') {
  $script:rows += [pscustomobject]@{ 套件 = $name; 通过 = $passed; 失败 = $failed; 备注 = $note }
  $color = if ($failed -gt 0) { 'Red' } else { 'Green' }
  Write-Host ("  {0,-28} 通过 {1,4}  失败 {2,3}  {3}" -f $name, $passed, $failed, $note) -ForegroundColor $color
}

<#
  跑一个子进程并**同时收下 stdout 和 stderr**。

  ⚠️ 为什么不能直接 `$out = & powershell ... 2>&1`：
     子脚本的 stderr（比如 `cdp.ps1` 报的"页面里报错：TypeError…"）在 `$ErrorActionPreference='Stop'`
     下会被 PowerShell 包成 ErrorRecord 并**当成终止错误抛出来** —— 于是一个步骤红了，
     整个回归脚本当场退出，后面的套件一条都不跑（2026-09-21 真踩到：m5 第一步之后就没了）。
     所以这里临时把 EAP 调成 Continue，并且**把非字符串记录（ErrorRecord）单独拎出来**，
     免得它们混进 stdout 文本里把 JSON 解析弄坏。

  ⚠️ 顺带记一笔：这个注释块一开始手滑写成了 JS 的 `/** … */` ——
     PowerShell 里那是**除法符号**，整个脚本解析出一堆莫名其妙的错（"& 不允许使用"）。
     PS 的块注释要用尖括号包起来的井号；**块注释里不能再写出结束标记**，
     否则注释会在那儿提前结束、后面的中文被当成命令（写这段时又踩了一次）。
#>
function Invoke-Child([string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & powershell @argv 2>&1
  } finally {
    $ErrorActionPreference = $prev
  }
  $strings = @($raw | Where-Object { $_ -is [string] })
  $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
  return [pscustomobject]@{
    text = ($strings | Out-String)
    err  = ($errs -join "`n")
  }
}

# ── ① 一套 run.ps1 从头跑到尾的（自己会打印"通过 N，失败 M"） ──
function Invoke-Suite([string]$name, [string]$rel) {
  Write-Host ""
  Write-Host "---- $name ----" -ForegroundColor Cyan
  "`n---- $name ($rel) ----" | Out-File -Append -Encoding UTF8 $Log
  $r = Invoke-Child @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here $rel), '-Port', "$Port")
  $text = $r.text
  $text | Out-File -Append -Encoding UTF8 $Log
  if ($r.err) { "`n[stderr]`n$($r.err)" | Out-File -Append -Encoding UTF8 $Log }
  # 脚本自己的收尾那行：`M9 执行区增强：通过 92，失败 0`
  $m = [regex]::Match($text, '通过\s*(\d+)\s*[/，,]\s*(?:真)?失败\s*(\d+)')
  if ($m.Success) {
    Add-Row $name ([int]$m.Groups[1].Value) ([int]$m.Groups[2].Value)
  } else {
    # 没匹配到就可能是整场没跑起来（连不上 CDP 之类）—— 如实标出来，别当成功
    Add-Row $name 0 0 '★ 没读到成绩行（跑起来了吗？）'
  }
  # 顺手把它自己报的失败条目打出来
  ($text -split "`r?`n" | Where-Object { $_ -match '\[X\]' }) | ForEach-Object {
    Write-Host "      $_" -ForegroundColor Red
  }
  if ($r.err) { Write-Host "      [stderr] $($r.err -split "`r?`n" | Select-Object -First 1)" -ForegroundColor DarkYellow }
}

# ── ② 一步一个 .js 的（m4 / m5）：逐个调 run.ps1 -Step，再解析每步的 JSON ──
function Invoke-Steps([string]$name, [string]$dir) {
  Write-Host ""
  Write-Host "---- $name（逐步） ----" -ForegroundColor Cyan
  "`n---- $name（逐步，$dir） ----" | Out-File -Append -Encoding UTF8 $Log
  $steps = Get-ChildItem (Join-Path $here $dir) -Filter '*.js' |
    Where-Object { $_.Name -ne '_helpers.js' } | Sort-Object Name
  $totalPass = 0
  $totalFail = 0
  foreach ($step in $steps) {
    $r = Invoke-Child @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here "$dir\run.ps1"), '-Step', $step.Name)
    $text = $r.text
    "`n>>> $($step.Name)" | Out-File -Append -Encoding UTF8 $Log
    $text | Out-File -Append -Encoding UTF8 $Log
    if ($r.err) { "[stderr]`n$($r.err)" | Out-File -Append -Encoding UTF8 $Log }
    # 步骤最后 `return report({...})` → cdp 会把那个 JSON 打回来。取第一个 `{` 开始的那一段。
    $json = $null
    $start = $text.IndexOf('{')
    if ($start -ge 0) {
      try { $json = $text.Substring($start) | ConvertFrom-Json } catch { $json = $null }
    }
    if ($null -eq $json -or $null -eq $json.passed) {
      Write-Host ("  {0,-34} ★ 没读到结果（这一步没跑起来？）" -f $step.Name) -ForegroundColor Red
      if ($r.err) { Write-Host "      [stderr] $(($r.err -split "`r?`n")[0])" -ForegroundColor DarkYellow }
      Add-Row "$name / $($step.Name)" 0 0 '★ 没读到结果'
      continue
    }
    $totalPass += [int]$json.passed
    $totalFail += [int]$json.failed
    $mark = if ($json.failed -gt 0) { 'Red' } else { 'Gray' }
    Write-Host ("  {0,-34} {1,3} 通过 / {2} 失败" -f $step.Name, $json.passed, $json.failed) -ForegroundColor $mark
    foreach ($r in @($json.results | Where-Object { -not $_.ok })) {
      Write-Host ("      [X] {0}  ::  {1}" -f $r.name, $r.detail) -ForegroundColor Red
    }
  }
  Add-Row $name $totalPass $totalFail "$($steps.Count) 步"
}

Write-Host "=== 全量回归开始（日志：$Log） ===" -ForegroundColor Cyan

# ── 🔴 基线保命（2026-10-05）：**每轮回归开始前先清掉"强制手机布局"开关** ─────────
# `m18`/`m19` 套件会往 localStorage 塞 `dsh-mobile-preview=1`（手机外壳预览）。
# localStorage **是持久化的**：应用关掉重开它还在 → 后面的套件会在"手机布局"里找元素，
# 于是出现"行 0 / 应有 7"这类**假红**（v2d 就被这么坑过一轮）。
# 这里不管三七二十一先清一遍再 reload，保证整套回归跑在**电脑版基线**上。
$cdpPath = Join-Path $here 'cdp.ps1'
if (Test-Path $cdpPath) {
  $clr = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdpPath -Action eval -Expr "sessionStorage.removeItem('dsh-mobile-preview');'cleared'" -TargetTitle '东方摩耶堂' -RequireSelector 'nav' 2>&1
  if (($clr | Out-String) -match 'cleared') {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $cdpPath -Action eval -Expr "location.reload();'reloaded'" -TargetTitle '东方摩耶堂' -RequireSelector 'nav' 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    Write-Host '  [基线] 已清掉手机布局开关并重载（防止 m18/m19 残留污染）' -ForegroundColor DarkGray
  } else {
    Write-Host '  [基线] 应用没起或 CDP 不通 —— 没清开关（后面的套件可能因此假红）' -ForegroundColor Yellow
  }
}

if (Want 'v2f')   { Invoke-Suite 'V2打磨F 倒计时' 'v2f\run.ps1' }
if (Want 'v2d')   { Invoke-Suite 'V2打磨D 分组+线分层' 'v2d\run.ps1' }
if (Want 'v2e')   { Invoke-Suite 'V2打磨E 桌面挂件' 'v2e\run.ps1' }
if (Want 'v2c')   { Invoke-Suite 'V2打磨C 提示音/多条提醒/工作提示' 'v2c\run.ps1' }
if (Want 'v2b')   { Invoke-Suite 'V2打磨B 专注面板不挡人' 'v2b\run.ps1' }
if (Want 'v2a')   { Invoke-Suite 'V2打磨A 粘图/显图/toc' 'v2a\run.ps1' }
if (Want 'm15')   { Invoke-Suite 'M15 隐藏档案库' 'm15\run.ps1' }
if (Want 'm14')   { Invoke-Suite 'M14 认知区增强（目录+批注）' 'm14\run.ps1' }
if (Want 'm13')   { Invoke-Suite 'M13-A/B 专注（置顶小窗 + 意外中断）' 'm13\run.ps1' }
if (Want 'm12')   { Invoke-Suite 'M12-A 技能区·奖状' 'm12\run.ps1' }
if (Want 'm11')   { Invoke-Suite 'M11 日程（日历+一周七列）' 'm11\run.ps1' }
if (Want 'm10.2') { Invoke-Suite 'M10.2 V1 收尾（字号+版本号）' 'm10.2\run.ps1' }
if (Want 'm9')   { Invoke-Suite 'M9 执行区增强'  'm9\run.ps1' }
if (Want 'm8')   { Invoke-Suite 'M8 分组+折叠'   'm8\run.ps1' }
if (Want 'm7.1') { Invoke-Suite 'M7.1 反馈修复'  'm7.1\run.ps1' }
if (Want 'm6')   { Invoke-Suite 'M6 快捷小窗'    'm6\run.ps1' }
if (Want 'm7')   {
  Invoke-Suite 'M7 PRD 10.1+10.2' 'm7\prd12.ps1'
  Invoke-Suite 'M7 PRD 10.6/10.5-4/10.8' 'm7\prd.ps1'
  Invoke-Suite 'M7 PRD 补漏'      'm7\prd-gaps.ps1'
  Invoke-Suite 'M7 备份+设置'     'm7\run.ps1'
  Invoke-Suite 'M7 字体/回收站'   'm7\polish.ps1'
}
if (Want 'm5') { Invoke-Steps 'M5 执行区' 'm5' }
if (Want 'm4') { Invoke-Steps 'M4 树状图' 'm4' }
if (Want 'm5g') {
  Write-Host ""
  Write-Host "---- M5 真实手势 ----" -ForegroundColor Cyan
  $r = Invoke-Child @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'm5\realgesture.ps1'), '-Port', "$Port")
  $r.text | Out-File -Append -Encoding UTF8 $Log
  if ($r.err) { "[stderr]`n$($r.err)" | Out-File -Append -Encoding UTF8 $Log }
  $m = [regex]::Match($r.text, '通过\s*(\d+)\s*[/，,]\s*(?:真)?失败\s*(\d+)')
  if ($m.Success) { Add-Row 'M5 真实手势' ([int]$m.Groups[1].Value) ([int]$m.Groups[2].Value) }
  else { Add-Row 'M5 真实手势' 0 0 '★ 没读到成绩行' }
}
if (Want 'm9g') {
  Write-Host ""
  Write-Host "---- M9 真实输入（键盘/鼠标） ----" -ForegroundColor Cyan
  $r = Invoke-Child @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'm9\realgesture.ps1'), '-Port', "$Port")
  $r.text | Out-File -Append -Encoding UTF8 $Log
  if ($r.err) { "[stderr]`n$($r.err)" | Out-File -Append -Encoding UTF8 $Log }
  $m = [regex]::Match($r.text, '通过\s*(\d+)\s*[/，,]\s*(?:真)?失败\s*(\d+)')
  if ($m.Success) { Add-Row 'M9 真实输入' ([int]$m.Groups[1].Value) ([int]$m.Groups[2].Value) }
  else { Add-Row 'M9 真实输入' 0 0 '★ 没读到成绩行' }
}
if (Want 'm4g') {
  Write-Host ""
  Write-Host "---- M4 真实手势 ----" -ForegroundColor Cyan
  $r = Invoke-Child @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'm4\realgesture.ps1'), '-Port', "$Port")
  $r.text | Out-File -Append -Encoding UTF8 $Log
  if ($r.err) { "[stderr]`n$($r.err)" | Out-File -Append -Encoding UTF8 $Log }
  $m = [regex]::Match($r.text, '通过\s*(\d+)\s*[/，,]\s*(?:真)?失败\s*(\d+)')
  if ($m.Success) { Add-Row 'M4 真实手势' ([int]$m.Groups[1].Value) ([int]$m.Groups[2].Value) }
  else { Add-Row 'M4 真实手势' 0 0 '★ 没读到成绩行' }
}

# M18（v2.1.0）：手机外壳与导航 —— **放最后跑**：它会把自己切到手机布局再切回来，
# 万一哪次清算没干净，也不会连累前面的套件。
if (Want 'm18') { Invoke-Suite 'M18 手机外壳与导航' 'm18\run.ps1' }
if (Want 'm19') { Invoke-Suite 'M19 手机版八个区' 'm19\run.ps1' }
if (Want 'm22') { Invoke-Suite 'M22 电脑端同步入口' 'm22\run.ps1' }
if (Want 'm23') { Invoke-Suite 'M23 手机端同步界面' 'm23\run.ps1' }
if (Want 'm21') { Invoke-Suite 'M21 同步数据层（最后改动时间 + 删除记录）' 'm21\run.ps1' }

Write-Host ""
Write-Host "======================= 成绩表 =======================" -ForegroundColor Cyan
$script:rows | Format-Table -AutoSize | Out-String | Write-Host
$sumPass = ($script:rows | Measure-Object -Property 通过 -Sum).Sum
$sumFail = ($script:rows | Measure-Object -Property 失败 -Sum).Sum
Write-Host ("合计：通过 {0}，失败 {1}" -f $sumPass, $sumFail) -ForegroundColor $(if ($sumFail -gt 0) { 'Red' } else { 'Green' })
"`n=== 合计：通过 $sumPass，失败 $sumFail ===" | Out-File -Append -Encoding UTF8 $Log
Write-Host "日志：$Log"
if ($sumFail -gt 0) { exit 1 }
