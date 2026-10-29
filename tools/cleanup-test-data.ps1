# 把验收脚本留下的测试数据清干净（**每个套件都会造东西，跑完回归必用**）
#
# 为什么要有这个脚本：M4~M9 的验收脚本都会造笔记 / 待办 / 信息 / 图片，
# 虽然每套自己也会清一部分，但**跑一遍全量回归下来一定会留**（有的步骤故意把数据留在那儿
# 给下一步用）。手工清既慢又容易漏，更容易**手一抖删到用户的真数据**。
#
# 规矩（和 `tools/` 里所有脚本一致）：
#   ① 只删**按名字认得出来的**测试数据（`M4 `/`M5 `/`M7 `/`M71 `/`M73 `/`M8 `/`M9 ` 开头）；
#   ② 用户自己的东西**一律不动**（打印出来让你能核对）；
#   ③ **绝不用** `todo_purge_removed`（它会按"来源已失效"批量删，连用户的都删 —— 见进度.md 第五节的事故记录）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\cleanup-test-data.ps1
#   powershell -ExecutionPolicy Bypass -File tools\cleanup-test-data.ps1 -WhatIfOnly   # 只看会删什么，不动手
param(
  [int]$Port = 9222,
  [string]$DataDir = 'D:\东方摩耶堂',
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cdp = Join-Path $here 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("clean-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle '东方摩耶堂' -RequireSelector 'nav' 2>&1
    return (($out | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}

# ── ① 清待办 / 笔记 / 信息（走 App 自己的命令，保证应用内存里的状态也是对的）──
$dry = if ($WhatIfOnly) { 'true' } else { 'false' }
$report = EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const dry = $dry;
  /**
   * 测试数据的判据（2026-10-02 改过一次，别再退回"手写清单"）。
   *
   * 🔴 原来这里是一串手写前缀 `['M4 ','M5 ',…,'M13 ','M15 ']` —— 它**跟不上**：
   *    M13 的脚本还会造 `M13B …` / `M13C …`，带空格的前缀匹配不到，于是那些测试待办
   *    一直留在用户执行区里（2026-10-02 真留了一条 `M13C 小窗增强`）。
   *    现在用**通用规则**：`M` + 数字 开头就算测试品（`M4 ` / `M13B` / `M13C` / `M71` 全覆盖）。
   *    ⚠️ 用户自己的标题是中文开头（"1高数复习" / "测试2" / "手动添加"），**不会误伤**。
   *    ⚠️ 以后新套件造数据**一律用 `M<里程碑>…` 开头的标题**，就自动被这里认出来。
   */
  const EXTRA=['笔记来的甲','笔记来的乙','笔记来的丙','手工建的丁','树里冒出来的待办','这条会随笔记一起失去来源','自动保存-'];
  const isTest = (t)=>{
    const s = (t || '').trim();
    if (/^M\d/.test(s)) return true;        // M4 / M13B / M13C / M71 …
    // ⚠️ 2026-10-03 补：V2 打磨轮三套验收用的是 `M-A批 `/`M-B批 `/`M-C批 `，不匹配 ^M\d
    //    → 测试品清不掉（真发生过：用户执行区里留着 3 条 `M-C批 提醒与提示音`）
    if (/^M-[A-Za-z0-9]*批/.test(s)) return true;
    return EXTRA.some(function(x){return s.indexOf(x)===0;});
  };
  const done={todos:[],notes:[],infos:[]};
  const keep={todos:[],notes:[],infos:[]};
  for(const t of await inv('todo_list')){
    if(isTest(t.title)){ done.todos.push(t.title); if(!dry) await inv('todo_delete',{id:t.id}); }
    else keep.todos.push(t.title);
  }
  for(const n of await inv('note_list')){
    if(isTest(n.title)){ done.notes.push(n.title); if(!dry) await inv('note_delete',{id:n.id}); }
    else keep.notes.push(n.title);
  }
  for(const i of await inv('info_list')){
    if(isTest(i.text)){ done.infos.push((i.text||'').slice(0,26)); if(!dry) await inv('info_delete',{id:i.id}); }
    else keep.infos.push((i.text||'').slice(0,26));
  }
  await new Promise(r=>setTimeout(r,1200));
  return JSON.stringify({deleted:done, kept:keep});
})()
"@
$j = $report | ConvertFrom-Json

Write-Host "=== 删掉的测试待办（$($j.deleted.todos.Count)） ==="
$j.deleted.todos | ForEach-Object { "   $_" }
Write-Host "=== 删掉的测试笔记（$($j.deleted.notes.Count)） ==="
$j.deleted.notes | ForEach-Object { "   $_" }
Write-Host "=== 删掉的测试信息（$($j.deleted.infos.Count)） ==="
$j.deleted.infos | ForEach-Object { "   $_" }
Write-Host ""
Write-Host "=== 保留下来的（用户自己的，一个都没动） ==="
Write-Host ("   待办：" + (($j.kept.todos) -join ' / '))
Write-Host ("   笔记：" + (($j.kept.notes) -join ' / '))
Write-Host ("   信息：" + (($j.kept.infos) -join ' / '))

# ── ② 回收站里"我删进去的"测试笔记也要清（用户自己删的留着）──
# 🔴 判据必须跟上面 ① 那半**同一套**（2026-10-06 修）：
#    这里原来是一张**手写前缀表**（`M4 `…`M15 `），于是 `M-D批 认知区分组探针` 这类测试笔记
#    在回收站里**永远清不掉** —— 实测用户的回收站里攒了 13 篇（手工清完才发现）。
#    现在统一成通用规则；新增套件造数据一律用 `M<里程碑>…` 开头就自动被认出来。
$isTestTitle = {
  param([string]$t)
  $s = ($t).Trim()
  if ($s -match '^M\d') { return $true }                 # M4 / M13B / M71 / M19 …
  if ($s -match '^M-[A-Za-z0-9]*批') { return $true }     # M-A批 / M-D批 …
  # 老套件里那些不带 M 前缀的固定名字（跟 ① 的 EXTRA 保持一致）
  foreach ($p in @('笔记来的甲', '笔记来的乙', '笔记来的丙', '手工建的丁', '树里冒出来的待办', '这条会随笔记一起失去来源', '自动保存-')) {
    if ($s.StartsWith($p)) { return $true }
  }
  return $false
}
$trashDir = Join-Path $DataDir 'notes\_trash'
$trashRemoved = @()
$trashKept = @()
if (Test-Path $trashDir) {
  Get-ChildItem $trashDir -Filter '*.json' | Where-Object { $_.Name -notlike '*.bak' } | ForEach-Object {
    $raw = Get-Content $_.FullName -Raw -Encoding UTF8
    $title = ''
    try { $title = ($raw | ConvertFrom-Json).title } catch { }
    $isTest = & $isTestTitle $title
    if ($isTest) {
      $trashRemoved += $title
      if (-not $WhatIfOnly) {
        Remove-Item $_.FullName -Force
        if (Test-Path "$($_.FullName).bak") { Remove-Item "$($_.FullName).bak" -Force }
      }
    } else {
      $trashKept += $title
    }
  }
}
Write-Host ""
Write-Host ("=== 回收站：清掉测试笔记 {0} 篇，保留 {1} 篇（你自己的）===" -f $trashRemoved.Count, $trashKept.Count)
$trashKept | ForEach-Object { "   留着：$_" }

# ── ③ 图片：**只删文件名以 M 开头的**（2026-10-02 第二次堵漏，这条规则别再改） ──
#
# 🔴🔴 **这个坑我连踩两次，写清楚免得下次又"修"回去**：
#   ① 第一版规则 = "白名单两张 + 其余只留被引用的" → 把用户 09-28 拖进来的
#      `assets\067efe34-…jpg`（他自己的 216939 字节哥尔赞原图，`info` 记录他早删了）当孤儿删了；
#   ② 第二版规则 = "只删今天写的" → **我恢复那张图时，文件时间戳变成了今天**，
#      下一次清理又把它当"今天造的"删了 —— 我的修复被自己的恢复动作绕过去了。
#
# 🔴🔴 **现在的规则**：**只删文件名以 `M` 开头的图** —— 各验收套件造的图都是这个形状
#    （`M5-…` / `M9-…` / `M13-…`）。**其余一律不碰**，不管它多旧、有没有被引用、是不是孤儿。
#    理由：这脚本是给"回归刚造出来的数据"收尾的，**没资格判断用户的图是不是垃圾**；
#    而任何"按时间"的判据都会被 恢复 / 复制 / 同步 这类动作骗到，**按名字前缀才真正认得出**。
#    ⚠️ 以后哪套验收脚本要往 `assets/` 写图，**文件名必须以 `M<里程碑>-` 开头**；
#      不这么写，它造的图不会被清掉（会留一张，但**不会删错** —— 这个方向的错可以接受）。
$assetDir = Join-Path $DataDir 'assets'
if (Test-Path $assetDir) {
  # 被任何地方引用的都算"在用"（现存笔记 / 回收站里的笔记 / 档案库 / 奖状 / 格言）
  $keep = New-Object System.Collections.Generic.HashSet[string]
  $refSources = @()
  $refSources += @(Get-ChildItem (Join-Path $DataDir 'notes\*.json') -ErrorAction SilentlyContinue)
  $refSources += @(Get-ChildItem (Join-Path $trashDir '*.json') -ErrorAction SilentlyContinue)
  foreach ($extra in @('awards.json', 'archive.json', 'mottos.json')) {
    $p = Join-Path $DataDir $extra
    if (Test-Path $p) { $refSources += @(Get-Item $p) }
  }
  foreach ($f in $refSources) {
    $raw = Get-Content $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $raw) { continue }
    [regex]::Matches($raw, 'assets/([0-9a-fA-F\-]+\.(png|jpg|jpeg|gif|webp))') | ForEach-Object { [void]$keep.Add($_.Groups[1].Value) }
  }

  $sumBefore = (Get-ChildItem $assetDir -File | Measure-Object Length -Sum).Sum
  # ★ 判据只有一条：**文件名以 M 开头**（= 测试造的）；被引用的照样保护
  $orphans = @(Get-ChildItem $assetDir -File | Where-Object { $_.Name -like 'M*' -and -not $keep.Contains($_.Name) })
  $protected = @(Get-ChildItem $assetDir -File | Where-Object { $orphans -notcontains $_ })
  if (-not $WhatIfOnly) { $orphans | ForEach-Object { Remove-Item $_.FullName -Force } }
  $sumAfter = (Get-ChildItem $assetDir -File | Measure-Object Length -Sum).Sum
  $freed = [math]::Round(($sumBefore - $sumAfter) / 1KB)
  Write-Host ""
  Write-Host ("=== 图片：清掉测试造的 {0} 个（{1} KB），保护 {2} 个（不是测试品的一律不碰）===" -f $orphans.Count, $freed, $protected.Count)
  Get-ChildItem $assetDir -File | ForEach-Object {
    $why = if ($keep.Contains($_.Name)) { '被引用' } elseif ($_.Name -like 'M*') { '★ 测试造的（已删）' } else { '不是测试品' }
    "   {0,-12} {1}" -f $why, $_.Name
  }
}
if ($WhatIfOnly) { Write-Host "（-WhatIfOnly：只是看了一眼，什么都没删）" }
else { Write-Host "清理完成。⚠️ 跑回归之前记得先想清楚：**这些数据本来就是回归造出来的**，删掉不影响任何验收证据。" }
