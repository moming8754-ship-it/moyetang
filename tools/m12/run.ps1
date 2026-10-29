# M12 技能区验收（A 奖状 + C 格言）
#
#   §1 技能区外壳：三个 Tab 都在、「奖状与证书」默认选中、另两块如实写"还没做"
#   §2 建一张（**真实键盘**）：只要标题就能建（**没图也能建**）、落盘、墙上有卡、右边出面版
#   §3 改名 + 置顶：改完后端真变了；置顶后**排到最前面那一段**
#   §4 删除：走**二次确认**，删完卡片消失、后端没了、**backups/ 里有留档**
#   §5 收尾：我造的奖状全清掉（连带空的 awards.json），用户别的数据一点不动
#
# 用法（应用要以 CDP 9222 起着）：powershell -ExecutionPolicy Bypass -File tools\m12\run.ps1
#   ⚠️ §2~§5 是一条链（造数据 → 验 → 收尾），拆不开；加 `-Only 1` 只跑外壳那几条（不造数据）。
param([int]$Port = 9222, [string]$Only = '', [string]$DataDir = 'D:\东方摩耶堂')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m12-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
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
function EvalJson([string]$js) {
  $t = EvalMain $js
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}
function Drive([string[]]$argv) {
  $raw = & powershell -NoProfile -File $cdp @argv 2>&1
  $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
  if ($errs.Count -gt 0) { return ("ERROR: " + (($errs -join ' ') -replace '\s+', ' ')) }
  return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
}
$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] " + $name) }
  else { $script:fail++; Write-Host ("  [X] " + $name + "  ::  " + $detail) }
}
function Step([string]$t) { Write-Host ""; Write-Host ("---- " + $t) }
function Want([int]$n) {
  if (-not $Only.Trim()) { return $true }
  $list = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  return ($list -contains $n)
}

$H = @'
const sl=t=>new Promise(r=>setTimeout(r,t));
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
const bySel=(sel)=>document.querySelector(sel);
'@

$TITLE = 'M12 奖状验收'

Write-Host ""
Write-Host "=== §1 技能区外壳 ==="

$shell = EvalJson @"
(async()=>{
$H
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){
    nav=B().find(b=>(b.innerText||'').indexOf('技能区')>=0||b.getAttribute('title')==='技能区');
    if(!nav) await sl(300);
  }
  if(!nav) return JSON.stringify({nav:false});
  nav.click(); await sl(1300);
  const tabs=Array.from(document.querySelectorAll('[data-skill-tab]'));
  const wall=await (async()=>{ for(let i=0;i<20 && !bySel('[data-award-wall],[data-award-empty]');i++) await sl(300);
    return !!bySel('[data-award-wall]') || !!bySel('[data-award-empty]'); })();
  return JSON.stringify({nav:true, tabs:tabs.length,
    keys:tabs.map(t=>t.getAttribute('data-skill-tab')),
    ready:tabs.map(t=>t.getAttribute('data-skill-tab-ready')),
    wall:wall});
})()
"@
Write-Host ("  外壳：" + ($shell | ConvertTo-Json -Compress))
Check '① 导航进得去技能区，奖状墙/空状态出来了' ($shell -and $shell.nav -and $shell.wall) ($shell | ConvertTo-Json -Compress)
Check '② 两个 Tab 都在（奖状 / 格言与原则），技能树永久删除' ($shell -and [int]$shell.tabs -eq 2 -and (@($shell.keys) -join ',') -eq 'awards,motto') ("Tab 数 " + $(if ($shell) { $shell.tabs } else { '?' }) + " / " + $(if ($shell) { @($shell.keys) -join ',' } else { '?' }))
Check '③ 奖状 + 格言两块都能用' `
  ($shell -and $shell.ready[0] -eq '1' -and $shell.ready[1] -eq '1') `
  (($shell.ready) -join ' / ')

if (Want 2) {

Write-Host ""
Write-Host "=== §2 建一张（真实键盘；没图也能建）==="

$before = EvalJson @"
(async()=>{
$H
  return JSON.stringify({count:(await inv('award_list')).length});
})()
"@
Write-Host ("  建之前：" + ($before | ConvertTo-Json -Compress))

$openAdd = EvalJson @"
(async()=>{
$H
  const btn=bySel('[data-award-add]');
  if(!btn) return JSON.stringify({ok:false});
  btn.click(); await sl(600);
  const input=bySel('[data-award-add-input]');
  if(!input) return JSON.stringify({ok:false, input:false});
  input.focus();
  return JSON.stringify({ok:true, focused:document.activeElement===input});
})()
"@
Write-Host ("  打开输入框：" + ($openAdd | ConvertTo-Json -Compress))
Check '④ 点「＋ 添加一张」冒出输入框并聚焦' ($openAdd -and $openAdd.ok -and $openAdd.focused) ($openAdd | ConvertTo-Json -Compress)

Write-Host (Drive @('-Action', 'type', '-Selector', 'input[data-award-add-input]', '-Text', $TITLE, '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1200
$made = EvalJson @"
(async()=>{
$H
  const all=await inv('award_list');
  const mine=all.find(a=>a.title==='$TITLE');
  let card=null;
  for(let i=0;i<20 && !card;i++){ card=bySel('[data-award-title="$TITLE"]'); if(!card) await sl(300); }
  return JSON.stringify({exists:!!mine, id:mine?mine.id:null, count:all.length,
    hasImage:mine?!!mine.assetPath:null, pinned:mine?mine.pinned:null,
    card:!!card, hasImageAttr:card?card.getAttribute('data-award-has-image'):null,
    panel:card?!!bySel('[data-award-panel]'):false});
})()
"@
Write-Host ("  建完之后：" + ($made | ConvertTo-Json -Compress))
Check '⑤ 只要一个标题就建成了，而且真落盘了' ($made -and $made.exists) ($made | ConvertTo-Json -Compress)
Check '⑥ ★ 没图也能建（`assetPath` 是空的）' ($made -and $made.hasImage -eq $false -and $made.hasImageAttr -eq '0') ("hasImage=" + $(if ($made) { $made.hasImageAttr } else { '?' }))
Check '⑦ 墙上出现了那张卡，右边也出了详情面板' ($made -and $made.card) ($made | ConvertTo-Json -Compress)

Write-Host ""
Write-Host ""
$id = $made.id   # ⚠️ 必须在这儿就赋值：§2b 也要用它（原来只在 §3 赋，插一段就断了）
Write-Host "=== §2b 图片：拖进来那条路（系统级拖放没法伪造，所以用现成的 dsh:file-drop 钩子）==="

# 先造一张真的 PNG（随便一个合法文件头；这里只验"路径 → assets/ → 挂到奖状上"这条链）
$png = Join-Path $env:TEMP ("m12-award-" + [guid]::NewGuid().ToString("N") + ".png")
$head = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
$bytes = New-Object byte[] 256
[Array]::Copy($head, $bytes, $head.Length)
[System.IO.File]::WriteAllBytes($png, $bytes)
$pngJs = $png -replace '\\', '/'

$imported = EvalJson @"
(async()=>{
$H
  window.dispatchEvent(new CustomEvent('dsh:file-drop',{detail:{paths:['$pngJs']}}));
  await sl(2200);
  const all=await inv('award_list');
  const mine=all.find(a=>a.id==='$id');
  const card=bySel('[data-award-card="$id"]');
  return JSON.stringify({assetPath:mine?mine.assetPath:null,
    hasImageAttr:card?card.getAttribute('data-award-has-image'):null});
})()
"@
Write-Host ("  拖图之后：" + ($imported | ConvertTo-Json -Compress))
Check '⑧ 图片进了 assets/ 并挂到了这张奖状上' ($imported -and $imported.assetPath -and $imported.assetPath -like 'assets/*') ("assetPath=" + $(if ($imported) { $imported.assetPath } else { '?' }))
Check '⑨ 卡片也跟着变成"有图"' ($imported -and $imported.hasImageAttr -eq '1') ("hasImageAttr=" + $(if ($imported) { $imported.hasImageAttr } else { '?' }))

$imageFile = Join-Path (Join-Path $DataDir 'assets') (($imported.assetPath -split '/')[-1])
Check '⑩ 那个图片文件真的落在数据目录的 assets/ 里了' (Test-Path $imageFile -PathType Leaf) $imageFile

# "去掉图"：只解除引用，**原图不删**（M4 那条约定）
$cleared = EvalJson @"
(async()=>{
$H
  bySel('[data-award-clear-image]').click(); await sl(1000);
  const all=await inv('award_list');
  const mine=all.find(a=>a.id==='$id');
  return JSON.stringify({assetPath:mine?mine.assetPath:null});
})()
"@
Write-Host ("  去掉图之后：" + ($cleared | ConvertTo-Json -Compress))
Check '⑪ 「去掉图」只解除引用（后端 assetPath 变空）' ($cleared -and -not $cleared.assetPath) ($cleared | ConvertTo-Json -Compress)
Check '⑫ ★ 原图**不删**（`assets/` 里还在 —— 和 M4 那条约定一致）' (Test-Path $imageFile -PathType Leaf) $imageFile

# 这张图是我造的孤儿，收尾时连文件一起清掉
if (Test-Path $png) { Remove-Item $png -Force }
Write-Host "=== §3 改名 + 置顶 ==="

$id = $made.id
# ⚠️ 先 JS 聚焦并**整段选中**，再用真实键盘打字 —— `Input.insertText` 会替换掉选区，
#    这样测的是"真打字 → 真回车 → 提交"，而不是把 value 直接塞进去
$focusTitle = EvalJson @"
(async()=>{
$H
  const input=bySel('[data-award-field="title"]');
  if(!input) return JSON.stringify({ok:false});
  input.focus(); input.select();
  return JSON.stringify({ok:document.activeElement===input, selLen:input.selectionEnd-input.selectionStart});
})()
"@
Write-Host ("  聚焦标题框：" + ($focusTitle | ConvertTo-Json -Compress))
Write-Host (Drive @('-Action', 'type', '-Selector', 'input[data-award-field="title"]', '-Text', ($TITLE + '（改过名）'), '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1200
$renamed = EvalJson @"
(async()=>{
$H
  const all=await inv('award_list');
  const mine=all.find(a=>a.id==='$id');
  return JSON.stringify({title:mine?mine.title:null});
})()
"@
Write-Host ("  改名后：" + ($renamed | ConvertTo-Json -Compress))
Check '⑩ 真实键盘改名 + 回车 → 后端标题真的变了（**正好替换**，不是接在后面）' `
  ($renamed -and $renamed.title -eq ($TITLE + '（改过名）')) ("后端是 " + $(if ($renamed) { $renamed.title } else { '?' }))

$pinned = EvalJson @"
(async()=>{
$H
  bySel('[data-award-pin]').click(); await sl(900);
  const card=bySel('[data-award-card="$id"]');
  const sections=Array.from(document.querySelectorAll('[data-award-section]')).map(s=>s.getAttribute('data-award-section'));
  const all=await inv('award_list');
  const mine=all.find(a=>a.id==='$id');
  return JSON.stringify({backendPinned:mine?mine.pinned:null,
    cardPinned:card?card.getAttribute('data-award-pinned'):null,
    firstSection:sections.length?sections[0]:null});
})()
"@
Write-Host ("  置顶后：" + ($pinned | ConvertTo-Json -Compress))
Check '⑪ 点 📌 置顶 → 后端和卡片都标上了' ($pinned -and $pinned.backendPinned -eq $true -and $pinned.cardPinned -eq '1') ($pinned | ConvertTo-Json -Compress)
Check '⑫ ★ 置顶的那张排到了最前面那一段（📌 置顶）' ($pinned -and $pinned.firstSection -eq '📌 置顶') ("第一段是 " + $(if ($pinned) { $pinned.firstSection } else { '?' }))

Write-Host ""
Write-Host "=== §4 删除（二次确认 + 留档）==="

$delStart = EvalJson @"
(async()=>{
$H
  bySel('[data-award-delete]').click(); await sl(700);
  const dialog=bySel('[role="dialog"]');
  const text=dialog?dialog.innerText:'';
  return JSON.stringify({dialog:!!dialog, text:text.slice(0,60)});
})()
"@
Write-Host ("  点删除之后：" + ($delStart | ConvertTo-Json -Compress))
Check '⑬ 点删除**先弹二次确认**，不是直接删' ($delStart -and $delStart.dialog) ($delStart | ConvertTo-Json -Compress)

$archivesBefore = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter '奖状-删除前*' -ErrorAction SilentlyContinue).Count
# 记下"开始删"的时刻：后面看有没有**新写**的留档（不看份数，理由见 ⑮ 那条注释）
$awardArchMark = Get-Date

$confirmed = EvalJson @"
(async()=>{
$H
  const dialog=bySel('[role="dialog"]');
  if(!dialog) return JSON.stringify({ok:false});
  const btn=Array.from(dialog.querySelectorAll('button')).find(b=>(b.innerText||'').trim()==='删除');
  if(!btn) return JSON.stringify({ok:false, why:'找不到确认按钮'});
  btn.click(); await sl(1400);
  const all=await inv('award_list');
  return JSON.stringify({left:all.length, stillThere:all.some(a=>a.id==='$id'),
    card:!!bySel('[data-award-card="$id"]')});
})()
"@
Write-Host ("  确认删除后：" + ($confirmed | ConvertTo-Json -Compress))
Check '⑭ 确认之后真的删掉了（后端没了、卡片也没了）' ($confirmed -and $confirmed.stillThere -eq $false -and $confirmed.card -eq $false) ($confirmed | ConvertTo-Json -Compress)

$archivesAfter = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter '奖状-删除前*' -ErrorAction SilentlyContinue)
# ⚠️ 判据是"**新写了一份**"，不是"份数 +1"：
#    留档每族有上限，满了就是"加一份挤掉一份"，份数会原地不动 —— 2026-09-26 格言那条就这么假红过（前 36 → 后 36，其实新档真写了）。
$awardFresh = @($archivesAfter | Where-Object { $_.LastWriteTime -ge $awardArchMark })
Check '⑮ ★ 删之前留了档（backups/ 里**新写了一份**「奖状-删除前」）' ($awardFresh.Count -ge 1) ("新写 " + $awardFresh.Count + " 份；份数 " + $archivesBefore + " → " + $archivesAfter.Count + "（份数受上限影响，不作判据）")

Write-Host ""
Write-Host ""
Write-Host "=== §5 格言与原则（M12-C）==="

$motto = EvalJson @"
(async()=>{
$H
  const tab=Array.from(document.querySelectorAll('[data-skill-tab]')).find(t=>t.getAttribute('data-skill-tab')==='motto');
  if(!tab) return JSON.stringify({tab:false});
  tab.click(); await sl(1300);
  const wall=await (async()=>{ for(let i=0;i<20 && !bySel('[data-motto-wall],[data-motto-empty]');i++) await sl(300);
    return !!bySel('[data-motto-wall]') || !!bySel('[data-motto-empty]'); })();
  const tabs=Array.from(document.querySelectorAll('[data-skill-tab]')).map(t=>t.getAttribute('data-skill-tab-ready'));
  return JSON.stringify({tab:true, wall:wall, ready:tabs});
})()
"@
Write-Host ("  格言 Tab：" + ($motto | ConvertTo-Json -Compress))
Check '⑯ 技能区里多出「格言与原则」这一块，而且它也是能用的' ($motto -and $motto.tab -and $motto.wall -and $motto.ready[1] -eq '1') ($motto | ConvertTo-Json -Compress)

# 真实键盘写一句（默认类别 = 原则）
$focusAdd = EvalJson @"
(async()=>{
$H
  const input=bySel('[data-motto-add-input]');
  if(!input) return JSON.stringify({ok:false});
  input.focus();
  return JSON.stringify({ok:document.activeElement===input});
})()
"@
Write-Host ("  聚焦写句子的框：" + ($focusAdd | ConvertTo-Json -Compress))
Write-Host (Drive @('-Action', 'type', '-Selector', 'input[data-motto-add-input]', '-Text', 'M12 格言验收甲', '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1200
$mk1 = EvalJson @"
(async()=>{
$H
  const all=await inv('motto_list');
  const mine=all.find(m=>m.text==='M12 格言验收甲');
  let card=null;
  for(let i=0;i<20 && !card;i++){ card=bySel('[data-motto-text="M12 格言验收甲"]'); if(!card) await sl(300); }
  return JSON.stringify({exists:!!mine, id:mine?mine.id:null, kind:mine?mine.kind:null, card:!!card});
})()
"@
Write-Host ("  写完之后：" + ($mk1 | ConvertTo-Json -Compress))
Check '⑰ 真实键盘写一句 + 回车 → 落盘、墙上出卡' ($mk1 -and $mk1.exists -and $mk1.card) ($mk1 | ConvertTo-Json -Compress)
Check '⑱ 默认算「原则」（自己定下的规矩）' ($mk1 -and $mk1.kind -eq 'rule') ("kind=" + $(if ($mk1) { $mk1.kind } else { '?' }))

# 切成「格言」再写一条
$mk2 = EvalJson @"
(async()=>{
$H
  bySel('[data-motto-add-kind="motto"]').click(); await sl(400);
  const input=bySel('[data-motto-add-input]');
  input.focus();
  return JSON.stringify({ok:document.activeElement===input});
})()
"@
Write-Host (Drive @('-Action', 'type', '-Selector', 'input[data-motto-add-input]', '-Text', 'M12 格言验收乙', '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1200
$mk2b = EvalJson @"
(async()=>{
$H
  const all=await inv('motto_list');
  const mine=all.find(m=>m.text==='M12 格言验收乙');
  return JSON.stringify({exists:!!mine, id:mine?mine.id:null, kind:mine?mine.kind:null, count:all.length});
})()
"@
Write-Host ("  第二条：" + ($mk2b | ConvertTo-Json -Compress))
Check '⑲ 切成「格言」再写一条 → 那条的类别是格言' ($mk2b -and $mk2b.exists -and $mk2b.kind -eq 'motto') ($mk2b | ConvertTo-Json -Compress)

# 点句子 → 就地编辑 → 真实键盘改名
$open = EvalJson @"
(async()=>{
$H
  const btn=bySel('[data-motto-open="$($mk1.id)"]');
  if(!btn) return JSON.stringify({ok:false});
  btn.click(); await sl(700);
  const area=bySel('[data-motto-edit-text="$($mk1.id)"]');
  if(!area) return JSON.stringify({ok:false, area:false});
  area.focus(); area.select();
  return JSON.stringify({ok:true, focused:document.activeElement===area});
})()
"@
Write-Host ("  点句子进编辑：" + ($open | ConvertTo-Json -Compress))
Check '⑳ 点句子=就地变成编辑框（不退出去、不跳页）' ($open -and $open.ok -and $open.focused) ($open | ConvertTo-Json -Compress)

Write-Host (Drive @('-Action', 'type', '-Selector', 'textarea[data-motto-edit-text]', '-Text', 'M12 格言验收甲（改过）', '-Enter', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1200
$renamed = EvalJson @"
(async()=>{
$H
  const all=await inv('motto_list');
  const mine=all.find(m=>m.id==='$($mk1.id)');
  return JSON.stringify({text:mine?mine.text:null});
})()
"@
Write-Host ("  改完之后：" + ($renamed | ConvertTo-Json -Compress))
Check '㉑ 真实键盘改名 + 回车 → 后端那一句真的变了' ($renamed -and $renamed.text -eq 'M12 格言验收甲（改过）') ("后端是 " + $(if ($renamed) { $renamed.text } else { '?' }))

# 筛选
$filtered = EvalJson @"
(async()=>{
$H
  bySel('[data-motto-filter="motto"]').click(); await sl(700);
  const cards=Array.from(document.querySelectorAll('[data-motto-card]'));
  const kinds=cards.map(c=>c.getAttribute('data-motto-kind'));
  bySel('[data-motto-filter="all"]').click(); await sl(500);
  return JSON.stringify({shown:cards.length, kinds:kinds, hasMine:cards.some(c=>c.getAttribute('data-motto-text')==='M12 格言验收乙')});
})()
"@
Write-Host ("  筛选「格言」：" + ($filtered | ConvertTo-Json -Compress))
Check '㉒ 点「格言」只剩格言那一条（我写的那条乙在，甲被筛掉）' ($filtered -and $filtered.hasMine -and -not (@($filtered.kinds) -contains 'rule')) ($filtered | ConvertTo-Json -Compress)

# 随便翻一句
$spot = EvalJson @"
(async()=>{
$H
  const before=bySel('[data-motto-spotlight]').getAttribute('data-motto-spotlight');
  bySel('[data-motto-random]').click(); await sl(700);
  const after=bySel('[data-motto-spotlight]').getAttribute('data-motto-spotlight');
  const label=bySel('[data-motto-spot-label]').textContent.trim();
  const back=!!bySel('[data-motto-back-today]');
  return JSON.stringify({before:before, after:after, changed:before!==after, label:label, back:back});
})()
"@
Write-Host ("  随便翻一句：" + ($spot | ConvertTo-Json -Compress))
Check '㉓ 「随便翻一句」真的换了一条（而且给回"回到今天这一句"的口子）' ($spot -and $spot.changed -and $spot.back) ($spot | ConvertTo-Json -Compress)

# 删除（二次确认 + 留档）
$archivesBefore = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter '格言-删除前*' -ErrorAction SilentlyContinue).Count
# 记下"开始删"的时刻：后面看有没有**新写**的留档（不看份数，理由见 ⑮ 那条注释）
$mottoArchMark = Get-Date
$delOpen = EvalJson @"
(async()=>{
$H
  bySel('[data-motto-del="$($mk1.id)"]').click(); await sl(700);
  const dialog=bySel('[role="dialog"]');
  return JSON.stringify({dialog:!!dialog, text:dialog?dialog.innerText.slice(0,50):''});
})()
"@
Write-Host ("  点删除：" + ($delOpen | ConvertTo-Json -Compress))
Check '㉔ 删除先弹二次确认' ($delOpen -and $delOpen.dialog) ($delOpen | ConvertTo-Json -Compress)

$delDone = EvalJson @"
(async()=>{
$H
  const dialog=bySel('[role="dialog"]');
  if(!dialog) return JSON.stringify({ok:false});
  const btn=Array.from(dialog.querySelectorAll('button')).find(b=>(b.innerText||'').trim()==='删除');
  if(!btn) return JSON.stringify({ok:false, why:'找不到确认按钮'});
  btn.click(); await sl(1400);
  const all=await inv('motto_list');
  return JSON.stringify({left:all.length, stillThere:all.some(m=>m.id==='$($mk1.id)')});
})()
"@
Write-Host ("  确认删除后：" + ($delDone | ConvertTo-Json -Compress))
Check '㉕ 确认后真删了（后端没了）' ($delDone -and $delDone.stillThere -eq $false) ($delDone | ConvertTo-Json -Compress)
$archivesAfter = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter '格言-删除前*' -ErrorAction SilentlyContinue).Count
$mottoFresh = @(Get-ChildItem (Join-Path $DataDir 'backups') -Filter '格言-删除前*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $mottoArchMark })
Check '㉖ ★ 删之前留了档（backups/ 里**新写了一份**「格言-删除前」）' ($mottoFresh.Count -ge 1) ("新写 " + $mottoFresh.Count + " 份；份数 " + $archivesBefore + " → " + $archivesAfter + "（份数受上限影响，不作判据）")

Write-Host ""
Write-Host "=== §6 收尾：清掉本轮造的东西 ==="

$clean = EvalJson @"
(async()=>{
$H
  const all=await inv('award_list');
  for(const a of all){ if(/^M12 /.test(a.title||'')) { try { await inv('award_delete',{id:a.id}); } catch(e){} } }
  // M12-C：格言那块的测试数据也在这里一起清
  for(const m of await inv('motto_list')){ if(/^M12 /.test(m.text||'')) { try { await inv('motto_delete',{id:m.id}); } catch(e){} } }
  await sl(800);
  return JSON.stringify({left:(await inv('award_list')).map(a=>a.title),
                         mottoLeft:(await inv('motto_list')).map(m=>m.text)});
})()
"@
Write-Host ("  清完之后：" + ($clean | ConvertTo-Json -Compress))
$leftover = @($clean.left | Where-Object { $_ -match '^M12 ' })
Check '㉗ 我造的奖状 + 格言全清掉了' ($leftover.Count -eq 0 -and @($clean.mottoLeft | Where-Object { $_ -match '^M12 ' }).Count -eq 0) `
  ((($clean.left) -join ' / ') + "  ｜  " + (($clean.mottoLeft) -join ' / '))

# M12-C：格言一件都没有了 → 空 mottos.json 也收掉
$mottosFile = Join-Path $DataDir 'mottos.json'
if (@($clean.mottoLeft).Count -eq 0 -and (Test-Path $mottosFile)) {
  $raw2 = Get-Content -Raw -Encoding UTF8 $mottosFile
  if ($raw2 -match '"items"\s*:\s*\[\s*\]') {
    Remove-Item $mottosFile -Force
    if (Test-Path "$mottosFile.bak") { Remove-Item "$mottosFile.bak" -Force }
    Write-Host "  mottos.json 里是空的（我建的），已删掉"
  }
}

# 一件都没有了 → 把我触发创建的那个空 awards.json 也收掉（不留垃圾）
$awardsFile = Join-Path $DataDir 'awards.json'
if ($clean.left.Count -eq 0 -and (Test-Path $awardsFile)) {
  $raw = Get-Content -Raw -Encoding UTF8 $awardsFile
  if ($raw -match '"items"\s*:\s*\[\s*\]') {
    Remove-Item $awardsFile -Force
    if (Test-Path "$awardsFile.bak") { Remove-Item "$awardsFile.bak" -Force }
    Write-Host "  awards.json 里是空的（我建的），已删掉"
  }
}
# 2026-10-06 修（假红）：原来断言"awards.json 不存在" —— 可用户自己可能有真奖状（M12 那轮就撞上过
# 他的「模型小佬」），那条必红。改成"**我造的**奖状一条不剩"，并且"文件若还在，里面必须非空"。
$awardsLeft = -2
if (Test-Path $awardsFile) {
  try { $awardsLeft = @((Get-Content -Raw -Encoding UTF8 $awardsFile | ConvertFrom-Json).items).Count } catch { $awardsLeft = -1 }
}
# ⚠️ `$clean.left` 是"剩下的**全部**"（含用户自己的真奖状）→ 不能拿它当"我剩的"。
# 改成按**标题**找我自己造的那张（$TITLE），用户的奖状一律不碰、也不对它下断言。
$mineLeft = 0
if (Test-Path $awardsFile) {
  try { $mineLeft = @((Get-Content -Raw -Encoding UTF8 $awardsFile | ConvertFrom-Json).items | Where-Object { $_.title -eq $TITLE }).Count } catch { $mineLeft = -1 }
}
Check '㉘ 收尾干净（我造的奖状全没了；用户自己的那张不动）' ($mineLeft -eq 0) ("我剩=" + $mineLeft + " 文件里共=" + $awardsLeft)

}

Write-Host ""
Write-Host "======================"
Write-Host ("M12 技能区（奖状 + 格言）：通过 " + $pass + "，失败 " + $fail)
if ($fail -gt 0) { exit 1 }
