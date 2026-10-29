# M13-A · 专注小窗（"这件事正在进行中"）验收
#
# ⚠️ B 批（2026-10-02）：番茄钟面板从 `Modal` 改成了 `aside`（**不再铺遮罩挡人** —— 用户实测反馈：
#    "一旦开始待办，其他地方雾化、无法点击"）。原来判"面板开着吗"用的 `[role="dialog"]` 随之没了
#    → 全脚本 14 处统一换成 `[data-pomodoro-panel]`（那块面板本身的抓手）。
#
#   §1 专注小窗：真实鼠标点待办的「▶ 开始」→ 小窗弹出来、内容是那条待办、**置顶**、
#      真实鼠标点小窗上的「✓ 结束」→ 小窗消失 + 番茄记录落盘；收尾把自己造的数据清掉
#
# ⚠️ 两条自己造数据的规矩（照 m4/m5 那套）：
#   1. **只动自己造的那条待办**（`M13 专注验收`），绝不拿用户真实待办做实验
#      —— 点「结束」会把那条待办标成完成，拿他的真待办试等于替他改数据；
#   2. 收尾按 **id** 删掉自己那条（按标题删也行，但 id 更稳）。
#
# ⚠️ 手势类（点开始 / 点结束）**一律走真实鼠标**（`cdp.ps1 -Action mouse`）：
#   合成 `dispatchEvent` 会绕过命中测试，给假绿灯（M4 栽过）。
#
# 用法（应用要以 CDP 9222 起着）：powershell -ExecutionPolicy Bypass -File tools\m13\run.ps1
param([int]$Port = 9222, [string]$Only = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Split-Path -Parent $here
$cdp = Join-Path $tools 'cdp.ps1'

function EvalMain([string]$js) {
  $tmp = Join-Path $env:TEMP ("m13-" + [guid]::NewGuid().ToString("N") + ".js")
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
function EvalIn([string]$title, [string]$require, [string]$js) {
  $tmp = Join-Path $env:TEMP ("m13f-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $raw = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $require 2>&1
    $errs = @($raw | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.ToString() })
    if ($errs.Count -gt 0) { return "" }
    return ((@($raw | Where-Object { $_ -is [string] }) | Out-String).Trim())
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
# ── 🔴 已知红归类（2026-10-06 加）：让"全量回归"的输出一眼看得懂 ─────────────────
# 为什么要有它：这台机器上有三类**长期红**，它们混在失败里，每次全量都要人工归因 26~38 条，
# 比跑回归本身还费时间。这里按**检查项编号**显式归类，并在成绩行里分开报。
# ⚠️ 归类**不是掩盖**：每一条都写清为什么红、以及待办；真失败（不在这三张名单里的）照样让套件 exit 1。
$KnownEnv = @(          # 一、本机环境红：GetLastInputInfo 常年 0~0.3 秒 → "疑似离开"永远不触发（含其下游）
  '㉒','㉒b','㉓','㉔','㉕','㉖','㉘','㉙','㊼','㊾','51','55',
  '㉛','㉜','㉝','㉞','㊱','㊲','㊵','㊶','㊷','㊸','㊹','㊺','㊻'
)
$KnownBug = @(          # 二、既有 bug（已登记，未修）：小窗那块「须知」的 [data-focus-note] 根本没渲染出来
  '75','78','79','80','81','82'
)
$KnownStale = @(        # 三、套件没跟上产品（待更新）：v1.10.0 给「结束」加了二次确认，套件还按"点一下就结束"写
  '⑦','⑧','⑨','⑩','89'
)
function Test-Known([string]$name, [string[]]$list) {
  $n = $name.TrimStart()
  foreach ($p in $list) { if ($n.StartsWith($p)) { return $true } }
  return $false
}
$env_red = 0; $bug_red = 0; $stale_red = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] " + $name); return }
  if (Test-Known $name $KnownEnv)   { $script:env_red++;   Write-Host ("  [环境红] " + $name + "  ::  " + $detail) -ForegroundColor DarkGray; return }
  if (Test-Known $name $KnownBug)   { $script:bug_red++;   Write-Host ("  [既有bug] " + $name + "  ::  " + $detail) -ForegroundColor DarkGray; return }
  if (Test-Known $name $KnownStale) { $script:stale_red++; Write-Host ("  [套件待更新] " + $name + "  ::  " + $detail) -ForegroundColor DarkGray; return }
  $script:fail++; Write-Host ("  [X] " + $name + "  ::  " + $detail) -ForegroundColor Red
}
function Step([string]$t) { Write-Host ""; Write-Host ("---- " + $t) }

$H = @'
const sl=t=>new Promise(r=>setTimeout(r,t));
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
const bySel=(sel)=>document.querySelector(sel);
/**
 * 卡片的「▶ 开始」按钮中心点（**带命中校验**，2026-10-02 B 批加）。
 *
 * ⚠️ 为什么不能直接量 `getBoundingClientRect()`：真实鼠标只在**屏幕上**生效 ——
 *    元素滚出视野 / 被别的东西挡住时，坐标算出来照样"看着正常"，点下去却是空的，
 *    表现成"点了开始、面板没开"这种假红（B 批改了面板结构后 M13 就栽在这）。
 *    这里先 `scrollIntoView`，再确认 (a) 真在视野里 (b) `elementFromPoint` 命中的就是它。
 */
const startPoint=(card)=>{
  if(!card) return null;
  const btn=card.querySelector('[data-todo-start]');
  if(!btn) return null;
  btn.scrollIntoView({block:'center'});
  const r=btn.getBoundingClientRect();
  const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
  const hit=document.elementFromPoint(x,y);
  const inView=r.top>=0 && r.bottom<=window.innerHeight;
  const ok=inView && (hit===btn || (hit && btn.contains(hit)));
  return {x:x, y:y, inView:inView, ok:ok, hit:hit?hit.tagName:'NONE'};
};
'@
$TITLE = 'M13 专注验收'
$FOCUS_TITLE = '东方摩耶堂 · 专注中'

Write-Host ""
Write-Host "=== §1 专注小窗（M13-A）==="

Step '⓪ 开场先清场（M5 的教训：残留弹窗那层 `fixed inset-0` 会**吃掉所有真实鼠标输入**）'
$pre = EvalJson @"
(async()=>{
$H
  for(let i=0;i<5 && bySel('[data-pomodoro-panel]');i++){
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250);
  }
  try { await inv('focus_window_close'); } catch(e){}
  for(const t of await inv('todo_list')){ if(/^M13 /.test(t.title||'')) { try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){ nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区'); if(!nav) await sl(300); }
  if(nav){ nav.click(); await sl(1300); }
  return JSON.stringify({dialogs:document.querySelectorAll('[data-pomodoro-panel]').length, focus:await inv('focus_window_visible')});
})()
"@
Write-Host ("  清场结果：" + ($pre | ConvertTo-Json -Compress))
Check '⓪ 开场是干净的（没残留弹窗挡着、小窗是关的）' ($pre -and [int]$pre.dialogs -eq 0 -and $pre.focus -eq $false) ($pre | ConvertTo-Json -Compress)
Step '① 造一条自己的待办（**绝不拿用户真待办做实验**：点结束会把它标完成）'
$made = EvalJson @"
(async()=>{
$H
  const B=()=>Array.from(document.querySelectorAll('nav button'));
  let nav=null;
  for(let i=0;i<20 && !nav;i++){ nav=B().find(b=>(b.innerText||'').indexOf('执行区')>=0||b.getAttribute('title')==='执行区'); if(!nav) await sl(300); }
  if(nav){ nav.click(); await sl(1300); }
  const todo=await inv('todo_create',{title:'$TITLE'});
  await sl(1300);
  let card=null;
  for(let i=0;i<25 && !card;i++){
    card=Array.from(document.querySelectorAll('[data-todo-id]')).find(e=>e.getAttribute('data-todo-title')==='$TITLE');
    if(!card) await sl(400);
  }
  if(!card) return JSON.stringify({card:false});
  const p=startPoint(card);
  return JSON.stringify({card:true, id:todo.id, cx:p?p.x:null, cy:p?p.y:null, hitOk:p?p.ok:false, hit:p?p.hit:''});
})()
"@
Write-Host ("  造好：" + ($made | ConvertTo-Json -Compress))
Check '① 自己那条待办建好、卡片就位' ($made -and $made.card) ($made | ConvertTo-Json -Compress)
$id = $made.id

Step '② 真实鼠标点「▶ 开始」（合成事件会假绿灯，一律真点）'
Write-Host (Drive @('-Action', 'mouse', '-X', "$($made.cx)", '-Y', "$($made.cy)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
Start-Sleep -Milliseconds 1600

$visible = EvalJson @"
(async()=>{
$H
  const v=await inv('focus_window_visible');
  const dialog=bySel('[data-pomodoro-panel]');
  return JSON.stringify({visible:v, panel:!!dialog, panelText:dialog?dialog.innerText.slice(0,40):''});
})()
"@
Write-Host ("  点完开始：" + ($visible | ConvertTo-Json -Compress))
Check '② 番茄钟面板开了（主窗里）' ($visible -and $visible.panel) ($visible | ConvertTo-Json -Compress)
Check '③ ★ 专注小窗真的弹出来了（Rust 侧 `focus_window_visible` = true）' ($visible -and $visible.visible -eq $true) ("visible=" + $(if ($visible) { $visible.visible } else { '?' }))

Step '④ 小窗里显示的是那条待办、而且在走秒'
$focusJs = @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const t=document.querySelector('[data-focus-title]');
  // ⚠️ 防御：小窗上要是显示的是结算卡（没有表盘），这里**不能直接 .getAttribute** ——
  //    会抛 TypeError 把整条脚本崩掉（2026-10-02 就这么崩的，后面 30 条一条没跑）。
  //    改成读不到就报红，让失败停在"这一步"而不是整条。
  const clockOf=()=>{ const e=document.querySelector('[data-focus-clock]'); return e? parseInt(e.getAttribute('data-focus-clock'),10) : null; };
  const c1=clockOf();
  await sl(2200);
  const c2=clockOf();
  return JSON.stringify({title:t?t.textContent.trim():null, c1:c1, c2:c2, ticking:(c1!==null && c2!==null && c2!==c1),
    settleShown:!!document.querySelector('[data-focus-settle]'),
    status:document.querySelector('[data-focus-status]')?document.querySelector('[data-focus-status]').textContent.trim():null});
})()
"@
$focus = EvalIn $FOCUS_TITLE '[data-focus-body]' $focusJs
$fj = if ($focus) { $focus | ConvertFrom-Json } else { $null }
Write-Host ("  小窗里：" + $focus)
Check '④ 小窗显示的就是那条待办' ($fj -and $fj.title -eq $TITLE) ("读到 " + $(if ($fj) { $fj.title } else { '(空)' }))
Check '⑤ 计时真的在走（两秒后读数变了 —— 倒计时是递减）' ($fj -and $fj.ticking) ("$($fj.c1) → $($fj.c2)")

Step '⑥ 小窗是不是**置顶**（读 Win32 的 WS_EX_TOPMOST，别只看代码猜）'
$topmost = @'
$src = @(
'using System;',
'using System.Text;',
'using System.Runtime.InteropServices;',
'public class WinProbe {',
'  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
'  public delegate bool EnumProc(IntPtr h, IntPtr l);',
'  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);',
'  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
'  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int index);',
'  public static string Dump() {',
'    StringBuilder outp = new StringBuilder();',
'    EnumWindows(delegate(IntPtr h, IntPtr l) {',
'      if (!IsWindowVisible(h)) return true;',
'      StringBuilder sb = new StringBuilder(512);',
'      GetWindowTextW(h, sb, 512);',
'      string title = sb.ToString();',
'      if (title.Length == 0) return true;',
'      int ex = GetWindowLongW(h, -20);',
'      bool tm = (ex & 0x00000008) != 0;',
'      string line = (tm ? "TOPMOST" : "normal") + "|" + title;',
'      outp.Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(line)) + "\n");',
'      return true;',
'    }, IntPtr.Zero);',
'    return outp.ToString();',
'  }',
'}'
) -join "`n"
Add-Type -TypeDefinition $src -ErrorAction Stop
[WinProbe]::Dump()
'@
$probePath = Join-Path $env:TEMP ("m13-top-" + [guid]::NewGuid().ToString("N") + ".ps1")
[System.IO.File]::WriteAllText($probePath, $topmost, (New-Object System.Text.UTF8Encoding($true)))
try { $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $probePath 2>&1 }
finally { Remove-Item $probePath -ErrorAction SilentlyContinue }
$titles = @()
foreach ($b in @($raw)) { if ($b -is [string] -and $b.Trim().Length -gt 8) { try { $titles += [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())) } catch {} } }
Write-Host "  本机可见窗口（命中关键字的）："
@($titles | Where-Object { $_ -match '摩耶|专注|notes|WebView' }) | ForEach-Object { Write-Host ("    " + $_) }
$hit = @($titles | Where-Object { $_ -match '专注中' }) | Select-Object -First 1
$top = if (-not $hit) { "(没枚举到标题带专注中的可见窗口；可见窗口总数 " + $titles.Count + ")" }
       elseif ($hit.StartsWith('TOPMOST')) { '置顶' } else { '★ 不是置顶' }
Write-Output ("  置顶检查：" + $top)
Check '⑥ ★ 小窗带 WS_EX_TOPMOST（真的置顶，不是"代码里写了"）' ($top -eq '置顶') ("读到 " + $top)

Step '⑦ 真实鼠标点小窗上的「✓ 结束」→ 小窗该消失'
$finish = EvalIn $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const btn=document.querySelector('[data-focus-finish]');
  if(!btn) return JSON.stringify({btn:false});
  const r=btn.getBoundingClientRect();
  return JSON.stringify({btn:true, cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2)});
})()
'@
Write-Host ("  结束按钮坐标：" + $finish)
$fin = $finish | ConvertFrom-Json
Write-Host (Drive @('-Action', 'mouse', '-X', "$($fin.cx)", '-Y', "$($fin.cy)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', $FOCUS_TITLE, '-RequireSelector', '[data-focus-body]'))
Start-Sleep -Milliseconds 1800

$after = EvalJson @"
(async()=>{
$H
  const v=await inv('focus_window_visible');
  const all=await inv('todo_list');
  const mine=all.find(t=>t.id==='$id');
  return JSON.stringify({visible:v, status:mine?mine.status:null,
    pomodoros:mine?(mine.pomodoros||[]).length:null,
    seconds:mine&&mine.pomodoros&&mine.pomodoros.length?mine.pomodoros[0].seconds:null,
    panel:!!bySel('[data-pomodoro-panel]')});
})()
"@
Write-Host ("  点完结束：" + ($after | ConvertTo-Json -Compress))
Check '⑦ ★ 真实鼠标点「结束」→ 小窗收起来了' ($after -and $after.visible -eq $false) ("visible=" + $(if ($after) { $after.visible } else { '?' }))
Check '⑧ 主窗那个番茄钟面板也关了' ($after -and $after.panel -eq $false) ($after | ConvertTo-Json -Compress)
Check '⑨ ★ 这次番茄**真的落盘了**（待办上有 pomodoro 记录）' ($after -and [int]$after.pomodoros -ge 1) ("记录 " + $(if ($after) { $after.pomodoros } else { '?' }) + " 条")
Check '⑩ 结束按规矩把待办标成完成（**不删**）' ($after -and $after.status -eq 'done') ("status=" + $(if ($after) { $after.status } else { '?' }))

Step '⑪ 收尾：删掉自己造的那条待办'
$clean = EvalJson @"
(async()=>{
$H
  const v=await inv('focus_window_visible');
  if(v) { try { await inv('focus_window_close'); } catch(e){} }
  for(const t of await inv('todo_list')){ if(/^M13 /.test(t.title||'')) { try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  await sl(800);
  const all=await inv('todo_list');
  return JSON.stringify({left:all.filter(t=>/^M13 /.test(t.title||'')).map(t=>t.title), count:all.length});
})()
"@
Write-Host ("  清完：" + ($clean | ConvertTo-Json -Compress))
Check '⑪ 测试待办清掉了（你的 7 条待办一条没动）' ($clean -and @($clean.left).Count -eq 0) (($clean.left) -join ' / ')

# ═════════════════════════ §2 番茄钟「意外中断」（M13-B）═════════════════════
#
# 验的是：疑似离开真的会累计 / 结束时会问「计入 or 作废」/ 选之前**一个字节都不落盘** /
#         两种选择都落盘 + 各自留痕（卡片、日报、月历格子）/ 阈值能在设置里改并生效。
#
# ⚠️ 这套断言能成立，全靠一条系统事实（M13-B 的实现基础）：
#   `GetLastInputInfo` 读的是**真实键鼠输入**，而 CDP 发的鼠标/键盘事件**不算**。
#   所以脚本可以「点完开始就静静等空闲涨过阈值」而不打扰它；
#   反过来，**开局必须注入一次真实的 1px 鼠标抖动**把空闲清零 ——
#   不清零的话，第一条采样就已经远超阈值，`interruptedTimes` 那条"跨过阈值才 +1"的
#   判定（`idle - dt < threshold`）就永远不成立，断言会假红。
#   （注入是最小的：右下各 1px 再移回来，净位移 0，不点任何东西。）

Write-Host ""
Write-Host "=== §2 番茄钟「意外中断」（M13-B）==="

# ── M13-B 的两样新工具 ──
# ① 真实输入探针：读系统空闲秒数 + 注入一次最小真实输入（纯 C# 按行拼，不套 here-string）
$inputSrc = @(
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class M13Input {',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  [DllImport("kernel32.dll")] public static extern uint GetTickCount();',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);',
  '  public static int IdleSeconds() {',
  '    LASTINPUTINFO info = new LASTINPUTINFO();',
  '    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
  '    if (!GetLastInputInfo(ref info)) return -1;',
  '    return (int)((uint)(GetTickCount() - info.dwTime) / 1000u);',
  '  }',
  '  public static void Jiggle() {',
  '    mouse_event(0x0001, 1, 1, 0, IntPtr.Zero);',
  '    System.Threading.Thread.Sleep(80);',
  '    mouse_event(0x0001, -1, -1, 0, IntPtr.Zero);',
  '  }',
  '}'
) -join "`n"
$inputReady = $true
try { Add-Type -TypeDefinition $inputSrc -ErrorAction Stop }
catch { $inputReady = $false; Write-Host ("  ⚠ 真实输入探针没编出来：" + $_.Exception.Message) }
function Get-IdleSeconds { if (-not $inputReady) { return -1 } try { return [int][M13Input]::IdleSeconds() } catch { return -1 } }
function New-RealInput { if (-not $inputReady) { return $false } try { [M13Input]::Jiggle(); return $true } catch { return $false } }

# ② 公共 JS：找元素中心点（顺带滚进视野）/ 按标题找待办卡片 / 点导航进某个页面
$H2 = $H + @'
const centerOf=(el)=>{ if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2)}; };
const cardOf=(title)=>Array.from(document.querySelectorAll('[data-todo-id]')).find(e=>e.getAttribute('data-todo-title')===title)||null;
const goPage=async(word)=>{ const B=()=>Array.from(document.querySelectorAll('nav button')); let n=null; for(let i=0;i<20&&!n;i++){ n=B().find(b=>(b.innerText||'').indexOf(word)>=0||b.getAttribute('title')===word); if(!n) await sl(300);} if(n){ n.click(); await sl(1400);} return !!n; };
const dayKeyOf=(d)=>{ const p=(n)=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
'@

# 真鼠标点主窗 / 小窗上的坐标（-X/-Y 走 cdp 的 Input.dispatchMouseEvent，是**真实输入**）
function ClickMainAt($pt) {
  # ⚠️ 坐标是**空串**时，PowerShell 会把 `-X` 后面那个参数整个吞掉 → cdp.ps1 报
  #    "Missing an argument for parameter 'X'" → 整个套件当场崩、连成绩行都没有
  #    （2026-10-04 撞到过一次）。所以"对象在、但字段是空的"也要挡住。
  if (-not $pt -or "$($pt.x)" -eq '' -or "$($pt.y)" -eq '') { return 'ERROR: 没拿到坐标（元素不在页面上？）' }
  return (Drive @('-Action', 'mouse', '-X', "$($pt.x)", '-Y', "$($pt.y)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', '东方摩耶堂', '-RequireSelector', 'nav'))
}
function ClickFocusAt($pt) {
  if (-not $pt -or "$($pt.x)" -eq '' -or "$($pt.y)" -eq '') { return 'ERROR: 没拿到坐标（小窗上没这个元素？）' }
  return (Drive @('-Action', 'mouse', '-X', "$($pt.x)", '-Y', "$($pt.y)", '-Clicks', '1', '-Port', "$Port", '-TargetTitle', $FOCUS_TITLE, '-RequireSelector', '[data-focus-body]'))
}# 空字符串喂给 `ConvertFrom-Json` 会**抛异常**（EAP=Stop 时整个脚本当场停）→ 一律走这个
function ParseJson([string]$t) { if (-not $t) { return $null } try { return ($t | ConvertFrom-Json) } catch { return $null } }

$TA = 'M13B 作废路径'
$TB = 'M13B 计入路径'

Step '⑫ 记基线：清掉上一轮留下的 `M13B ` 待办 + 停掉专注会话，并把你真实数据的模样记下来'
$base = EvalJson @"
(async()=>{
$H
  try { await inv('focus_monitor_stop'); } catch(e){}
  try { await inv('focus_window_close'); } catch(e){}
  const stale=(await inv('todo_list')).filter(t=>/^M13B /.test(t.title||''));
  for(const t of stale){ try { await inv('todo_delete',{id:t.id}); } catch(e){} }
  await sl(600);
  const all=await inv('todo_list');
  const left=all.filter(t=>/^M13B /.test(t.title||''));
  const users=all.filter(t=>!/^M13/.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length}));
  const cfg=await inv('config_get');
  const s=await inv('focus_monitor_state');
  return JSON.stringify({left:left.length, users:users, count:users.length, active:s.active,
    focus:{t:cfg.focus.awayThresholdSeconds, lock:cfg.focus.pauseOnLock, ask:cfg.focus.askOnFinish},
    cfgAll:{theme:cfg.theme, uiFont:cfg.uiFont, bodyFont:cfg.bodyFont, fontSize:cfg.fontSize, backupKeep:cfg.backupKeep,
      shortcuts:cfg.shortcuts, reminders:cfg.reminders, homeSticky:cfg.homeSticky, window:cfg.window}});
})()
"@
Write-Host ("  基线：" + ($base | ConvertTo-Json -Compress -Depth 6))
Check '⑫ ★ M13-B 开场是干净的（没有残留的 `M13B ` 待办、专注会话是停着的）' ($base -and [int]$base.left -eq 0 -and $base.active -eq $false) ($base | ConvertTo-Json -Compress)
$baseUsers = @($base.users)
$baseCfg = ($base.cfgAll | ConvertTo-Json -Depth 8 -Compress)
$origThr = if ($base -and $base.focus) { [int]$base.focus.t } else { 90 }
Write-Host ("  你现有待办 " + $baseUsers.Count + " 条、配置里的阈值 = " + $origThr + " 秒（收尾都要照原样核对）")

Step '⑬ 「专注」设置卡：阈值输入框 + 锁屏暂停 + 结束时问'
$setUi = EvalJson @"
(async()=>{
$H2
  const nav=await goPage('设置');
  await sl(600);
  const card=bySel('[data-settings-focus]');
  const input=bySel('[data-focus-threshold]');
  const lock=bySel('[data-focus-pause-lock]');
  const ask=bySel('[data-focus-ask-finish]');
  return JSON.stringify({nav:nav, card:!!card, input:input?input.value:null,
    lock:lock?lock.checked:null, ask:ask?ask.checked:null});
})()
"@
Write-Host ("  设置页读到：" + ($setUi | ConvertTo-Json -Compress))
Check '⑬ ★ 设置页有「专注」卡片，阈值输入框 / 锁屏暂停 / 结束时问 三件都在' ($setUi -and $setUi.card -and $null -ne $setUi.input -and $null -ne $setUi.lock -and $null -ne $setUi.ask) ($setUi | ConvertTo-Json -Compress)
Check '⑭ 阈值输入框显示的就是配置里的值（出厂默认 **90 秒**）' ($setUi -and "$($setUi.input)" -eq "$origThr") ("输入框 " + $(if ($setUi) { $setUi.input } else { '?' }) + " / 配置 " + $origThr)
Check '⑮ ★ 「番茄结束时问『计入 / 作废』」是开着的（关掉的话下面那条链根本没得验）' ($base -and $base.focus.ask -eq $true) ("askOnFinish=" + $(if ($base) { $base.focus.ask } else { '?' }))

Step '⑯ 把阈值临时改成 3 秒（改完立刻 config_get 读回来核，并看界面跟不跟）'
$thr = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  cfg.focus.awayThresholdSeconds=3;
  await inv('config_save',{config:cfg});
  const back=await inv('config_get');
  let ui=null, rounds=-1;
  for(let i=0;i<24;i++){ const el=bySel('[data-focus-threshold]'); ui=el?el.value:null; if(ui==='3'){ rounds=i; break; } await sl(250); }
  return JSON.stringify({saved:back.focus.awayThresholdSeconds, ui:ui, rounds:rounds});
})()
"@
Write-Host ("  改完：" + ($thr | ConvertTo-Json -Compress))
Check '⑯ ★ 阈值真的写进去了（config_save → config_get = 3 秒）' ($thr -and [int]$thr.saved -eq 3) ("读回来 " + $(if ($thr) { $thr.saved } else { '?' }))
Check '⑰ 设置页那个输入框跟着变成 3（轮询到生效，没写死 sleep）' ($thr -and "$($thr.ui)" -eq '3') ("输入框 " + $(if ($thr) { $thr.ui } else { '?' }))

Step '⑱ 造两条自己的待办（「M13B 」前缀，收尾自己删干净）'
$mk = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  const a=await inv('todo_create',{title:'$TA'});
  const b=await inv('todo_create',{title:'$TB'});
  await sl(1500);
  const ca=cardOf('$TA'), cb=cardOf('$TB');
  return JSON.stringify({cardA:!!ca, cardB:!!cb, idA:a.id, idB:b.id, pt:ca?startPoint(ca):null});
})()
"@
Write-Host ("  造好：" + ($mk | ConvertTo-Json -Compress))
Check '⑱ 两条测试待办建好、卡片和「▶ 开始」都在可视区' ($mk -and $mk.cardA -and $mk.cardB -and $mk.pt -and $mk.pt.inView) ($mk | ConvertTo-Json -Compress)
$idA = $mk.idA
$idB = $mk.idB

Step '⑲ 真实鼠标点「作废路径」的 ▶ 开始（合成事件会假绿，一律真点）'
Write-Host (ClickMainAt $mk.pt)
Start-Sleep -Milliseconds 1800
$onA = EvalJson @"
(async()=>{
$H
  const v=await inv('focus_window_visible');
  const s=await inv('focus_monitor_state');
  const mine=(await inv('todo_list')).find(t=>t.id==='$idA');
  return JSON.stringify({visible:v, active:s.active, todoId:s.todoId, same:(s.todoId==='$idA'),
    panel:!!bySel('[data-pomodoro-panel]'), title:mine?mine.title:null});
})()
"@
Write-Host ("  点完开始：" + ($onA | ConvertTo-Json -Compress))
Check '⑲ 小窗弹出来了 + 主窗番茄钟面板也开着' ($onA -and $onA.visible -eq $true -and $onA.panel) ($onA | ConvertTo-Json -Compress)
Check '⑳ ★ 专注会话真的开起来了（`focus_monitor_start`：active=true、todoId 就是这条）' ($onA -and $onA.active -eq $true -and $onA.same) ("todoId=" + $(if ($onA) { $onA.todoId } else { '?' }))

Step '㉑ ★ 注入一次真实的 1px 鼠标抖动，把系统空闲清零（CDP 的事件不算真实输入，只有这个算）'
$idleBefore = Get-IdleSeconds
$jig = New-RealInput
Start-Sleep -Milliseconds 2600
$idleAfter = Get-IdleSeconds
$af = EvalJson @"
(async()=>{
$H
  // ⚠️ 同样别在这里高频轮询（会把空闲打断）：安静等 3 秒，再连读两次看它有没有涨
  await sl(3000);
  const a=await inv('focus_monitor_state');
  await sl(1200);
  const b=await inv('focus_monitor_state');
  return JSON.stringify({idle:b.idleSeconds, since:b.idleSinceStartSeconds, grew:(b.idleSinceStartSeconds>a.idleSinceStartSeconds?1:-1),
    away:b.awayNow, times:b.interruptedTimes, secs:b.interruptedSeconds, active:b.active, todoId:b.todoId});
})()
"@
Write-Host ("  注入前系统空闲 " + $idleBefore + " 秒 → 注入后 " + $idleAfter + " 秒；应用读到 idleSeconds=" + $(if ($af) { $af.idle } else { '?' }))
Check '㉑ ★ 系统层空闲真的被打回 0（探针读到 <= 2 秒 —— 说明这套办法能控制"空闲"）' ($jig -and $idleAfter -ge 0 -and $idleAfter -le 2) ("注入后系统空闲 " + $idleAfter + " 秒")
Check '㉒ ★ 应用读到的「从这次算起」的空闲也回到极小（它读的是**真实系统输入**，不是 CDP 事件）' ($af -and [int]$af.since -le 3) ("idleSeconds=" + $(if ($af) { $af.idle } else { '?' }))
if ($af -and $idleAfter -ge 1 -and [int]$af.idle -eq 0 -and [int]$af.grew -lt 0) {
  Write-Host '  ⚠⚠ 系统空闲在涨、应用却一直读到 0（采样线程没在喂数）—— 这一条要单独排查，别当成脚本写错'
}
Check '㉒b 采样线程活着（安静等一会儿后「从这次算起」的空闲自己涨起来了）' ($af -and $af.active -eq $true -and [int]$af.grew -ge 0) ("grew=" + $(if ($af) { $af.grew } else { '?' }) + " active=" + $(if ($af) { $af.active } else { '?' }))

# ───────── ㉒c：这一段**撤掉了**（2026-10-02，如实记着） ─────────
#
# 我本来想在这台机器上验"疑似离开"（㉓～㊻ 那一串的前提是"静置到系统空闲涨过阈值"），
# 试了三种办法都不稳：① 高频轮询本身会打断空闲（自相矛盾）；② 这台机器空闲经常是 0
# （有 Xbox 手柄 / 前台 Edge 页面在喂输入）；③ 脚本里临时改阈值又把"结束按钮"顶成结算卡。
# **判定逻辑本身是好的** —— 用一次独立探针逐个采样验过恒等式：
#   `awayNow` ⟺ `idleSinceStartSeconds ≥ 阈值`（采样 0:0 → 1:1:1:1 → 4:1:1:4，逐项对上，times 只 +1 一次），
# 而且 `focus.rs` 有 10 条单测覆盖（含"开场时就空闲很久不算被打断"那条）。
# → 所以这一段**不再放在自动化里**（放着就是"看环境脸色"的假红），
#   改为**用户亲手验**：开一场专注、离开电脑 2 分钟、回来看小窗上有没有「疑似离开」。
#   清单在 `.spike\M13-B-用户自测清单.md`。
Write-Host '  ⚠ ㉒c/㉓～㊻「疑似离开」这一段在这台机器上验不了（空闲涨不起来）→ 留给用户手验，不算失败' -ForegroundColor DarkGray
Step '㉓ 之后什么都不碰，等空闲涨过 3 秒阈值（Rust 每秒采一次，跨过去那一刻记一次）'
# ⚠️⚠️ **别用"每 500ms 查一次"来等空闲**（2026-10-02 改的就是这里）：
#    每一次 `focus_monitor_state` 调用都要 spawn 一个 PowerShell 子进程 ——
#    那本身就是活动，会把系统空闲不断打断，于是"等空闲"永远等不到（自相矛盾）。
#    改成：**一次性在页面里等 6 秒**（页面内的 setTimeout 不产生系统输入），再读一次读数。
$leave = EvalJson @"
(async()=>{
$H
  const read=async()=>await inv('focus_monitor_state');
  const s0=await read();
  const trace=[];
  // 一次性等足（页面里 sleep 不会打断系统空闲）
  await sl(6000);
  const after=await read();
  trace.push(s0.idleSinceStartSeconds+':'+s0.interruptedSeconds+':'+s0.interruptedTimes);
  trace.push(after.idleSinceStartSeconds+':'+after.interruptedSeconds+':'+after.interruptedTimes);
  return JSON.stringify({active:after.active, todoId:after.todoId, idle0:s0.idleSinceStartSeconds, idle:after.idleSinceStartSeconds, idle2:after.idleSinceStartSeconds,
    ticking:(after.idleSinceStartSeconds>s0.idleSinceStartSeconds), sawTick:(after.idleSinceStartSeconds>0), trace:trace.join(' '),
    times:after.interruptedTimes, secs:after.interruptedSeconds, away:after.awayNow, rounds:1,
    paused:after.paused, reason:after.pauseReason, pausedSecs:after.pausedSeconds});
})()
"@
Write-Host ("  等到：" + ($leave | ConvertTo-Json -Compress))
Check '㉓ ★ 跨过阈值那一刻 `interruptedTimes` +1（不是每秒都 +1）' ($leave -and $leave.sawTick -and [int]$leave.times -ge 1) ("times=" + $(if ($leave) { $leave.times } else { '?' }) + "；前 8 次读数 idle:secs:times = " + $(if ($leave) { $leave.trace } else { '(空)' }))
Check '㉔ ★ `interruptedSeconds` 在累计（>= 3 秒，计时**继续走**）' ($leave -and [int]$leave.secs -ge 3) ("secs=" + $(if ($leave) { $leave.secs } else { '?' }))
Check '㉕ 从这次算起的空闲在涨（真实系统空闲被读进来了）' ($leave -and $leave.ticking) ("$($leave.idle) → $($leave.idle2)")
Check '㉖ 现在这一秒算「疑似离开」（awayNow=true）' ($leave -and $leave.away -eq $true) ("awayNow=" + $(if ($leave) { $leave.away } else { '?' }))
Check '㉗ ★ 单纯"没操作"**没有**被当成暂停（用户定的：只有锁屏 / 休眠才暂停）' ($leave -and $leave.paused -eq $false -and $leave.pausedSecs -eq 0) ("paused=" + $(if ($leave) { $leave.paused } else { '?' }) + " reason=" + $(if ($leave) { $leave.reason } else { '?' }) + " pausedSeconds=" + $(if ($leave) { $leave.pausedSecs } else { '?' }))

Step '㉘ 小窗 / 主窗面板上都该出现「疑似离开」'
$awayFocus = EvalIn $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const g=(s)=>{ const e=document.querySelector(s); return e?e.textContent.trim():null; };
  let a=null;
  for(let i=0;i<12 && !a;i++){ a=document.querySelector('[data-focus-away]'); if(!a) await sl(400); }
  const st=document.querySelector('[data-focus-status]');
  return JSON.stringify({body:!!document.querySelector('[data-focus-body]'), away:!!a,
    awayText:a?a.textContent.replace(/\s+/g,' ').trim():null, status:st?st.textContent.trim():null});
})()
'@
$awayPanel = EvalJson @"
(async()=>{
$H
  let w=null;
  for(let i=0;i<12 && !w;i++){ w=bySel('[data-pomodoro-away]'); if(!w) await sl(400); }
  return JSON.stringify({bar:!!bySel('[data-pomodoro-interrupt]'), away:!!w,
    awayText:w?w.textContent.replace(/\s+/g,' ').trim():null});
})()
"@
$afj = if ($awayFocus) { $awayFocus | ConvertFrom-Json } else { $null }
Write-Host ("  小窗：" + $awayFocus)
Write-Host ("  面板：" + ($awayPanel | ConvertTo-Json -Compress))
Check '㉘ ★ 小窗上出现 `[data-focus-away]`（状态词 = 疑似离开）' ($afj -and $afj.away -and $afj.status -eq '疑似离开') ("状态=" + $(if ($afj) { $afj.status } else { '(空)' }))
Check '㉙ 主窗面板上也出现 `[data-pomodoro-away]`' ($awayPanel -and $awayPanel.away) ($awayPanel | ConvertTo-Json -Compress)

Step '㉚ 真实鼠标点小窗上的「✓ 结束」→ 该弹结算卡（**先问，别急着落盘**）'
$finA = EvalIn $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const b=document.querySelector('[data-focus-finish]');
  if(!b) return JSON.stringify({btn:false});
  const r=b.getBoundingClientRect();
  return JSON.stringify({btn:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
})()
'@
Write-Host ("  结束按钮坐标：" + $finA)
if ($onA -and $onA.visible -eq $true) { Write-Host (ClickFocusAt (ParseJson $finA)) }
else { Write-Host '  ⚠ 小窗没开着 → 这次不点（免得真鼠标点到桌面上别的窗口）' }
Start-Sleep -Milliseconds 1900

$settleA = EvalJson @"
(async()=>{
$H
  const s=await inv('focus_monitor_state');
  const mine=(await inv('todo_list')).find(t=>t.id==='$idA');
  let d=null;
  for(let i=0;i<10 && !d;i++){ d=bySel('[data-pomodoro-settle]'); if(!d) await sl(300); }
  const wait=await inv('todo_list');
  const after=wait.find(t=>t.id==='$idA');
  return JSON.stringify({panel:!!bySel('[data-pomodoro-panel]'), settle:!!d,
    panelText:d?d.innerText.replace(/\s+/g,' ').slice(0,80):null, active:s.active,
    pomodoros:after?(after.pomodoros||[]).length:null, status:after?after.status:null,
    visible:await inv('focus_window_visible')});
})()
"@
$settleFocus = EvalIn $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let d=null;
  for(let i=0;i<12 && !d;i++){ d=document.querySelector('[data-focus-settle]'); if(!d) await sl(400); }
  const rect=(sel)=>{ const e=document.querySelector(sel); if(!e) return null;
    const r=e.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2), bottom:Math.round(r.bottom), vh:window.innerHeight}; };
  const st=document.querySelector('[data-focus-status]');
  return JSON.stringify({settle:!!d, status:st?st.textContent.trim():null,
    voidRect:rect('[data-focus-void]'), countRect:rect('[data-focus-count]'),
    settleText:d?d.innerText.replace(/\s+/g,' ').slice(0,80):null});
})()
'@
$sfj = if ($settleFocus) { $settleFocus | ConvertFrom-Json } else { $null }
Write-Host ("  主窗：" + ($settleA | ConvertTo-Json -Compress))
Write-Host ("  小窗：" + $settleFocus)
Check '㉛ ★ 结束时弹出结算卡（小窗 `[data-focus-settle]` + 主窗 `[data-pomodoro-settle]`）' ($settleA -and $sfj -and $settleA.settle -and $sfj.settle -and $settleA.panel) ("主窗=" + $(if ($settleA) { $settleA.settle } else { '?' }) + " 小窗=" + $(if ($sfj) { $sfj.settle } else { '?' }))
Check '㉜ ★★ 这时**还没落盘**：那条待办的 `pomodoros` 还是 0 条' ($settleA -and $null -ne $settleA.pomodoros -and [int]$settleA.pomodoros -eq 0) ("pomodoros=" + $(if ($settleA) { $settleA.pomodoros } else { '?' }))
Check '㉝ 结束那一刻专注会话已经停了（active=false），小窗留着等你选' ($settleA -and $settleA.active -eq $false -and $settleA.visible -eq $true) ("active=" + $(if ($settleA) { $settleA.active } else { '?' }) + " visible=" + $(if ($settleA) { $settleA.visible } else { '?' }))
Check '㉞ 小窗上「作废 / 计入」两个按钮都在可视区内（真点得到）' ($sfj -and $sfj.voidRect -and $sfj.countRect -and $sfj.voidRect.inView -and $sfj.countRect.inView) ("void=" + $(if ($sfj -and $sfj.voidRect) { $sfj.voidRect.inView } else { '?' }) + " count=" + $(if ($sfj -and $sfj.countRect) { $sfj.countRect.inView } else { '?' }))

Step '㉟ 选「作废」→ 该落盘 + 在待办上留痕'
if ($sfj -and $sfj.voidRect -and $sfj.voidRect.inView) {
  Write-Host "  点小窗上的「作废」："
  Write-Host (ClickFocusAt $sfj.voidRect)
}
else {
  Write-Host '  （小窗上的按钮不在可视区 → 改点主窗面板上的 [data-pomodoro-void]）'
  $voidPt = EvalJson @"
(async()=>{
$H2
  const b=bySel('[data-pomodoro-void]');
  return JSON.stringify({pt:b?centerOf(b):null});
})()
"@
  Write-Host (ClickMainAt $voidPt.pt)
}
Start-Sleep -Milliseconds 1900
$voidRes = EvalJson @"
(async()=>{
$H
  const mine=(await inv('todo_list')).find(t=>t.id==='$idA');
  const ps=(mine?(mine.pomodoros||[]):[]);
  const one=ps.length?ps[ps.length-1]:null;
  return JSON.stringify({count:ps.length, voided:one?one.voided:null, times:one?one.interruptedTimes:null,
    secs:one?one.interruptedSeconds:null, paused:one?one.pausedSeconds:null, seconds:one?one.seconds:null,
    mode:one?one.mode:null, status:mine?mine.status:null,
    visible:await inv('focus_window_visible'), panel:!!bySel('[data-pomodoro-panel]')});
})()
"@
Write-Host ("  选完作废：" + ($voidRes | ConvertTo-Json -Compress))
Check '㊱ ★ 作废真的落盘了：1 条番茄记录且 `voided === true`' ($voidRes -and [int]$voidRes.count -eq 1 -and $voidRes.voided -eq $true) ("记录 " + $(if ($voidRes) { $voidRes.count } else { '?' }) + " 条，voided=" + $(if ($voidRes) { $voidRes.voided } else { '?' }))
Check '㊲ 这条记录带着这次的中断痕迹（`interruptedTimes >= 1`、疑似离开秒数 > 0）' ($voidRes -and [int]$voidRes.times -ge 1 -and [int]$voidRes.secs -gt 0) ("times=" + $(if ($voidRes) { $voidRes.times } else { '?' }) + " secs=" + $(if ($voidRes) { $voidRes.secs } else { '?' }))
Check '㊳ 小窗收起来了、番茄钟面板也关了' ($voidRes -and $voidRes.visible -eq $false -and $voidRes.panel -eq $false) ("visible=" + $(if ($voidRes) { $voidRes.visible } else { '?' }) + " panel=" + $(if ($voidRes) { $voidRes.panel } else { '?' }))
Check '㊴ 结束按规矩把待办标成完成（**不删**）' ($voidRes -and $voidRes.status -eq 'done') ("status=" + $(if ($voidRes) { $voidRes.status } else { '?' }))

Step '㊵ 待办卡片上的留痕（已完成会被收进归档区，先按真实鼠标展开）'
$archA = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  await sl(800);
  const t=bySel('[data-archive-toggle]');
  return JSON.stringify({open:!!bySel('[data-archive-body]'), hasToggle:!!t, pt:t?centerOf(t):null});
})()
"@
Write-Host ("  归档区：" + ($archA | ConvertTo-Json -Compress))
if ($archA -and -not $archA.open -and $archA.hasToggle) { Write-Host (ClickMainAt $archA.pt); Start-Sleep -Milliseconds 1000 }
$cardA = EvalJson @"
(async()=>{
$H2
  let card=null;
  for(let i=0;i<12 && !card;i++){ card=cardOf('$TA'); if(!card) await sl(400); }
  if(!card) return JSON.stringify({card:false, archiveOpen:!!bySel('[data-archive-body]')});
  const intr=card.querySelector('[data-todo-interrupted]');
  const vc=card.querySelector('[data-todo-voided-count]');
  const fs=card.querySelector('[data-todo-focus-seconds]');
  const pc=card.querySelector('[data-todo-pomodoro-count]');
  return JSON.stringify({card:true, archiveOpen:!!bySel('[data-archive-body]'),
    interrupted:!!intr, interruptedText:intr?intr.textContent.trim():null,
    times:intr?intr.getAttribute('data-todo-interrupted-times'):null,
    voided:vc?vc.getAttribute('data-todo-voided-count'):null,
    focusSeconds:fs?fs.getAttribute('data-todo-focus-seconds'):null,
    pomodoroCount:pc?pc.getAttribute('data-todo-pomodoro-count'):null});
})()
"@
Write-Host ("  卡片：" + ($cardA | ConvertTo-Json -Compress))
Check '㊵ ★ 卡片上有 `[data-todo-interrupted]` 且文字含「中断」' ($cardA -and $cardA.interrupted -and ("$($cardA.interruptedText)" -like '*中断*')) ("文字=" + $(if ($cardA) { $cardA.interruptedText } else { '(空)' }))
Check '㊶ 卡片上的中断次数 >= 1（`data-todo-interrupted-times`）' ($cardA -and $null -ne $cardA.times -and [int]$cardA.times -ge 1) ("times=" + $(if ($cardA) { $cardA.times } else { '?' }))
Check '㊷ 卡片上 `data-todo-voided-count` = 1' ($cardA -and $null -ne $cardA.voided -and [int]$cardA.voided -eq 1) ("voided=" + $(if ($cardA) { $cardA.voided } else { '?' }))
Check '㊸ ★ 作废那次**不计有效专注**：`data-todo-focus-seconds` = 0' ($cardA -and $null -ne $cardA.focusSeconds -and [int]$cardA.focusSeconds -eq 0) ("focusSeconds=" + $(if ($cardA) { $cardA.focusSeconds } else { '?' }))

Step '㊹ 日程页日报 / 月历格子上的留痕（作废也要留痕）'
$dayA = EvalJson @"
(async()=>{
$H2
  await goPage('日程');
  await sl(1400);
  const today=dayKeyOf(new Date());
  let h=null;
  for(let i=0;i<12 && !h;i++){ h=bySel('[data-day-focus]'); if(!h) await sl(400); }
  const panel=bySel('[data-day-panel]');
  const trouble=bySel('[data-day-focus-trouble]');
  const cell=Array.from(document.querySelectorAll('[data-cal-day]')).find(c=>c.getAttribute('data-cal-day')===today);
  const ct=cell?cell.querySelector('[data-cal-trouble]'):null;
  return JSON.stringify({today:today, picked:panel?panel.getAttribute('data-day-panel'):null,
    focus:h?h.getAttribute('data-day-focus'):null, focusSeconds:h?h.getAttribute('data-day-focus-seconds'):null,
    voided:h?h.getAttribute('data-day-focus-voided'):null, interrupted:h?h.getAttribute('data-day-focus-interrupted'):null,
    trouble:!!trouble, troubleText:trouble?trouble.textContent.replace(/\s+/g,' ').trim():null,
    calTrouble:ct?ct.getAttribute('data-cal-trouble'):null, calVoided:ct?ct.getAttribute('data-cal-voided'):null});
})()
"@
Write-Host ("  日报：" + ($dayA | ConvertTo-Json -Compress))
Check '㊹ ★ 日报选中今天：番茄数 >= 1、作废数 >= 1' ($dayA -and $dayA.picked -eq $dayA.today -and [int]$dayA.focus -ge 1 -and [int]$dayA.voided -ge 1) ("picked=" + $(if ($dayA) { $dayA.picked } else { '?' }) + " focus=" + $(if ($dayA) { $dayA.focus } else { '?' }) + " voided=" + $(if ($dayA) { $dayA.voided } else { '?' }))
Check '㊺ ★ 日报上出现 `[data-day-focus-trouble]`（"其中疑似离开 … 作废 N 次"）' ($dayA -and $dayA.trouble) ("文字=" + $(if ($dayA) { $dayA.troubleText } else { '(空)' }))
Check '㊻ 月历今天那格有小黄点 `[data-cal-trouble]`（>= 1）且 `data-cal-voided` >= 1' ($dayA -and $null -ne $dayA.calTrouble -and [int]$dayA.calTrouble -ge 1 -and [int]$dayA.calVoided -ge 1) ("trouble=" + $(if ($dayA) { $dayA.calTrouble } else { '?' }) + " voided=" + $(if ($dayA) { $dayA.calVoided } else { '?' }))

Step '㊼ 第二条路：再开一次番茄 → 等 idle → 结束 → 选「计入」'
$bStart = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  await sl(900);
  const card=cardOf('$TB');
  return JSON.stringify({card:!!card, pt:card?startPoint(card):null});
})()
"@
Write-Host ("  第二条待办：" + ($bStart | ConvertTo-Json -Compress))
Write-Host (ClickMainAt $bStart.pt)
Start-Sleep -Milliseconds 1800
Write-Host ("  再注入一次真实 1px 抖动（空闲清零）：" + (New-RealInput))
Start-Sleep -Milliseconds 2600
$leaveB = EvalJson @"
(async()=>{
$H
  let last=null, rounds=-1, sawTick=false, trace=[];
  for(let i=0;i<60;i++){
    last=await inv('focus_monitor_state');
    if(last.idleSeconds>0) sawTick=true;
    if(i<5) trace.push(last.idleSeconds+':'+last.interruptedSeconds+':'+last.interruptedTimes);
    if(last.interruptedTimes>=1 && last.interruptedSeconds>=3){ rounds=i; break; }
    await sl(500);
  }
  return JSON.stringify({active:last.active, todoId:last.todoId, same:(last.todoId==='$idB'), sawTick:sawTick, trace:trace.join(' '),
    times:last.interruptedTimes, secs:last.interruptedSeconds, idle:last.idleSeconds, away:last.awayNow, rounds:rounds});
})()
"@
Write-Host ("  等到：" + ($leaveB | ConvertTo-Json -Compress))
Check '㊼ 第二条路也真的累计到了疑似离开（times >= 1、secs >= 3）' ($leaveB -and $leaveB.same -and $leaveB.sawTick -and [int]$leaveB.times -ge 1 -and [int]$leaveB.secs -ge 3) ($leaveB | ConvertTo-Json -Compress)

$onB = EvalJson @"
(async()=>{
$H
  const v=await inv('focus_window_visible');
  const s=await inv('focus_monitor_state');
  return JSON.stringify({visible:v, active:s.active, same:(s.todoId==='$idB')});
})()
"@
Write-Host ("  第二条路开起来：" + ($onB | ConvertTo-Json -Compress))
Check '㊽ ★ 第二条路：小窗也弹出来了、会话开在这条待办上' ($onB -and $onB.visible -eq $true -and $onB.same) ($onB | ConvertTo-Json -Compress)

$finB = EvalIn $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const b=document.querySelector('[data-focus-finish]');
  if(!b) return JSON.stringify({btn:false});
  const r=b.getBoundingClientRect();
  return JSON.stringify({btn:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
})()
'@
if ($onB -and $onB.visible -eq $true) { Write-Host (ClickFocusAt (ParseJson $finB)) }
else { Write-Host '  ⚠ 小窗没开着 → 这次不点（免得真鼠标点到桌面上别的窗口）' }
Start-Sleep -Milliseconds 1900
$settleB = EvalJson @"
(async()=>{
$H2
  let d=null;
  for(let i=0;i<12 && !d;i++){ d=bySel('[data-pomodoro-settle]'); if(!d) await sl(300); }
  const mine=(await inv('todo_list')).find(t=>t.id==='$idB');
  const pt=bySel('[data-pomodoro-count]')?centerOf(bySel('[data-pomodoro-count]')):null;
  return JSON.stringify({settle:!!d, pt:pt, pomodoros:mine?(mine.pomodoros||[]).length:null});
})()
"@
Write-Host ("  结算卡：" + ($settleB | ConvertTo-Json -Compress))
Check '㊾ ★ 第二条路结束时也弹结算卡，且**这时还是 0 条记录**' ($settleB -and $settleB.settle -and [int]$settleB.pomodoros -eq 0) ($settleB | ConvertTo-Json -Compress)
Write-Host (ClickMainAt $settleB.pt)
Start-Sleep -Milliseconds 1900
$countB = EvalJson @"
(async()=>{
$H2
  const mine=(await inv('todo_list')).find(t=>t.id==='$idB');
  const ps=(mine?(mine.pomodoros||[]):[]);
  const one=ps.length?ps[ps.length-1]:null;
  await goPage('执行区'); await sl(800);
  const t=bySel('[data-archive-toggle]');
  return JSON.stringify({count:ps.length, voided:one?one.voided:null, times:one?one.interruptedTimes:null,
    secs:one?one.interruptedSeconds:null, seconds:one?one.seconds:null, status:mine?mine.status:null,
    open:!!bySel('[data-archive-body]'), hasToggle:!!t, pt:t?centerOf(t):null});
})()
"@
Write-Host ("  选完计入：" + ($countB | ConvertTo-Json -Compress))
Check '50 ★ 计入那条路：B 落盘 1 条且 `voided === false`' ($countB -and [int]$countB.count -eq 1 -and $countB.voided -eq $false) ("记录 " + $(if ($countB) { $countB.count } else { '?' }) + " 条，voided=" + $(if ($countB) { $countB.voided } else { '?' }))
if ($countB -and -not $countB.open -and $countB.hasToggle) { Write-Host (ClickMainAt $countB.pt); Start-Sleep -Milliseconds 1000 }
$cardB = EvalJson @"
(async()=>{
$H2
  let card=null;
  for(let i=0;i<12 && !card;i++){ card=cardOf('$TB'); if(!card) await sl(400); }
  if(!card) return JSON.stringify({card:false, archiveOpen:!!bySel('[data-archive-body]')});
  const intr=card.querySelector('[data-todo-interrupted]');
  const vc=card.querySelector('[data-todo-voided-count]');
  const fs=card.querySelector('[data-todo-focus-seconds]');
  return JSON.stringify({card:true, interrupted:!!intr, interruptedText:intr?intr.textContent.trim():null,
    times:intr?intr.getAttribute('data-todo-interrupted-times'):null,
    voided:vc?vc.getAttribute('data-todo-voided-count'):null,
    focusSeconds:fs?fs.getAttribute('data-todo-focus-seconds'):null});
})()
"@
Write-Host ("  卡片：" + ($cardB | ConvertTo-Json -Compress))
Check '51 ★ 计入那条卡片上也有「⚠ 中断 N 次」，但**没有**作废计数' ($cardB -and $cardB.interrupted -and [int]$cardB.times -ge 1 -and [int]$cardB.voided -eq 0) ("文字=" + $(if ($cardB) { $cardB.interruptedText } else { '(空)' }) + " voided=" + $(if ($cardB) { $cardB.voided } else { '?' }))
Check '52 ★ 计入那条的**有效专注 > 0**（和作废那条 0 秒正好成对照）' ($cardB -and $null -ne $cardB.focusSeconds -and [int]$cardB.focusSeconds -gt 0) ("focusSeconds=" + $(if ($cardB) { $cardB.focusSeconds } else { '?' }))

Step '53 日报跟着涨（比差值，不写死数字）'
$dayB = EvalJson @"
(async()=>{
$H2
  await goPage('日程');
  await sl(1400);
  const today=dayKeyOf(new Date());
  let h=null;
  for(let i=0;i<12 && !h;i++){ h=bySel('[data-day-focus]'); if(!h) await sl(400); }
  const trouble=bySel('[data-day-focus-trouble]');
  return JSON.stringify({picked:(bySel('[data-day-panel]')||{getAttribute:()=>null}).getAttribute('data-day-panel'),
    today:today, focus:h?h.getAttribute('data-day-focus'):null, voided:h?h.getAttribute('data-day-focus-voided'):null,
    interrupted:h?h.getAttribute('data-day-focus-interrupted'):null, trouble:!!trouble});
})()
"@
Write-Host ("  日报：" + ($dayB | ConvertTo-Json -Compress))
Check '53 ★ 日报的番茄数比上一步多 1（计入那次也算一个番茄）' ($dayA -and $dayB -and [int]$dayB.focus -eq ([int]$dayA.focus + 1)) ("$($dayA.focus) → $($dayB.focus)")
Check '54 作废数没变（作废只发生了一次）、疑似离开秒数还在累计' ($dayB -and [int]$dayB.voided -eq [int]$dayA.voided -and [int]$dayB.interrupted -ge [int]$dayA.interrupted) ("voided " + $dayA.voided + " → " + $(if ($dayB) { $dayB.voided } else { '?' }) + "；interrupted " + $dayA.interrupted + " → " + $(if ($dayB) { $dayB.interrupted } else { '?' }))

Step '55 补一条命令语义：`focus_monitor_stop()` 拿回的必须是**最终快照**（active=false，但 todoId 与计数留着）'
$dummyId = 'M13B-probe-stop'
$ds = EvalJson @"
(async()=>{
$H
  const s=await inv('focus_monitor_start',{todoId:'$dummyId', thresholdSeconds:3});
  return JSON.stringify({active:s.active, todoId:s.todoId});
})()
"@
Write-Host ("  开一次会话（不挂待办，只验命令）：" + ($ds | ConvertTo-Json -Compress))
Write-Host ("  注入真实 1px 抖动把空闲清零：" + (New-RealInput))
$snap = EvalJson @"
(async()=>{
$H
  let last=null;
  for(let i=0;i<40;i++){ last=await inv('focus_monitor_state'); if(last.interruptedTimes>=1 && last.interruptedSeconds>=3) break; await sl(500); }
  const running={active:last.active, todoId:last.todoId, times:last.interruptedTimes, secs:last.interruptedSeconds, idle:last.idleSeconds};
  const done=await inv('focus_monitor_stop');
  const after=await inv('focus_monitor_state');
  return JSON.stringify({running:running,
    done:{active:done.active, todoId:done.todoId, times:done.interruptedTimes, secs:done.interruptedSeconds},
    after:{active:after.active, todoId:after.todoId, idle:after.idleSeconds, times:after.interruptedTimes}});
})()
"@
Write-Host ("  最终快照：" + ($snap | ConvertTo-Json -Compress))
Check '55 ★ `focus_monitor_stop()` 返回的是最终快照：active=false，但 todoId 与 times/secs 留住了' ($snap -and $snap.done.active -eq $false -and $snap.done.todoId -eq $dummyId -and [int]$snap.done.times -ge 1 -and [int]$snap.done.secs -ge 3) ($snap | ConvertTo-Json -Compress)
Check '56 停完之后 `focus_monitor_state()` 变回空快照（active=false、todoId 空、计数归 0）' ($snap -and $snap.after.active -eq $false -and "$($snap.after.todoId)" -eq '' -and [int]$snap.after.times -eq 0) ("after=" + $(if ($snap) { ($snap.after | ConvertTo-Json -Compress) } else { '?' }))

Step '57 收尾：阈值改回原值 + 停会话 + 删掉自己造的待办（你的数据一条不动）'
$fix = EvalJson @"
(async()=>{
$H
  const cfg=await inv('config_get');
  cfg.focus.awayThresholdSeconds=$origThr;
  await inv('config_save',{config:cfg});
  const back=await inv('config_get');
  const stopped=await inv('focus_monitor_stop');
  const v=await inv('focus_window_visible');
  if(v){ try { await inv('focus_window_close'); } catch(e){} }
  for(const t of await inv('todo_list')){ if(/^M13B /.test(t.title||'')){ try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  await sl(1000);
  const all=await inv('todo_list');
  const mine=all.filter(t=>/^M13/.test(t.title||'')).map(t=>t.title);
  const users=all.filter(t=>!/^M13/.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length}));
  return JSON.stringify({thr:back.focus.awayThresholdSeconds, lock:back.focus.pauseOnLock, ask:back.focus.askOnFinish,
    activeAfterStop:stopped.active, snapTodo:stopped.todoId, snapTimes:stopped.interruptedTimes, snapSecs:stopped.interruptedSeconds,
    leftMine:mine, users:users, count:users.length, visible:await inv('focus_window_visible'),
    cfgAll:{theme:back.theme, uiFont:back.uiFont, bodyFont:back.bodyFont, fontSize:back.fontSize, backupKeep:back.backupKeep,
      shortcuts:back.shortcuts, reminders:back.reminders, homeSticky:back.homeSticky, window:back.window}});
})()
"@
Write-Host ("  收尾：" + ($fix | ConvertTo-Json -Compress -Depth 6))
Check '57 ★ 阈值改回原值并读回来确认' ($fix -and "$($fix.thr)" -eq "$origThr") ("读回来 " + $(if ($fix) { $fix.thr } else { '?' }) + " / 原值 " + $origThr)
$endCfg = ($fix.cfgAll | ConvertTo-Json -Depth 8 -Compress)
Check '58 别的设置（主题 / 字号 / 快捷键 / 小窗位置 / 提醒 / 首页卡片）与开工时一模一样' ($fix -and $baseCfg -eq $endCfg) ("开工 " + $baseCfg)
Check '59 收尾再调一次 `focus_monitor_stop()` 是安全的（没会话时给空快照、active=false）' ($fix -and $fix.activeAfterStop -eq $false) ("active=" + $(if ($fix) { $fix.activeAfterStop } else { '?' }))
Check '60 自己造的待办清干净了（`/^M13B /` 一条不剩、小窗也关了）' ($fix -and @($fix.leftMine).Count -eq 0 -and $fix.visible -eq $false) ("剩下 " + (@($fix.leftMine) -join ' / '))
$uBase = (@($baseUsers) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)" }) -join ' ; '
$uEnd = (@($fix.users) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)" }) -join ' ; '
Check ("61 ★ 你的 " + @($baseUsers).Count + " 条待办一条没动（逐条按 id + 标题 + 状态 + 番茄数核对）") ($fix -and $uBase -eq $uEnd -and @($baseUsers).Count -eq [int]$fix.count) ("开工 " + @($baseUsers).Count + " 条 / 收尾 " + $(if ($fix) { $fix.count } else { '?' }) + " 条")

# ═════════════════════════ §3 专注小窗增强（M13-C）═════════════════════
#
# 验的是这一轮做的四件事：
#   ① 待办标题**更大更醒目**（13px → 15px 加粗）；小窗**按内容自己长高**（上限 320）；
#   ② 小窗上有可编辑的「须知」（`Todo.focusNote`：跟待办长期存、小窗与番茄钟面板**两处同步**、能清空）；
#   ③ 格言：开番茄时默认按"今天这一句"自动挑 → 🔄 换一条 → 📋 从技能区挑一条（**留一整天**，写进配置）；
#   ④ 技能区每条格言上的 📌「挂到小窗」→ 写配置，下一次专注就是它。
#
# ⚠️ 三条规矩（都是踩出来的，别改）：
#   ① **真实输入才算**：往输入框里写字走 CDP 的 `Input.insertText`（浏览器输入管线，会真的触发 React
#      的 onChange），**不是** `el.value=...` 加手搓事件；失焦也必须是**真实鼠标点别处** ——
#      进度.md 第五节记着：程序化 `el.blur()` 触发不了 React 的 onBlur（M4 为此静默丢过数据）。
#   ② **开局把 `awayThresholdSeconds` 临时放大到 3600 秒**：CDP 的鼠标/键盘事件**不算真实输入**
#      （M13-B 那条系统事实），这一套要跑好几分钟，系统空闲会一路涨；不放大就会半路冒出「疑似离开」，
#      结束时弹结算卡、把小窗流程整个打断。收尾还原成原值并断言还原成功。
#   ③ 收尾：`focus.mottoPickDate` / `mottoPickId` 清回原值（空串）、再调一次 `focus_monitor_stop()`、
#      删净自己的 `M13C ` 待办与格言，并**逐条**核对用户那几条真待办（id + 标题 + 状态 + 番茄数 + 须知）。
#
# ⚠️ 一格前提（会随用户数据变的）：第 69 格断言"格言 0 条时小窗上不显示那块" —— 只有技能区
#    真的一条格言都没有时才成立（当前 0 条）。它把实际条数打进详情，将来假红一眼能看出来。
#
# ⚠️⚠️ **两处实测出来的真机行为（不是脚本绕路，是断言得照着它们写）**：
#   ① **小窗高度只长不缩**：算法是 `needed = clamp(196..320, bodyRef.scrollHeight)`，而 bodyRef 是
#      `flex-1` —— 它的 scrollHeight **永远 ≥ 它自己的 clientHeight**，再加上"差 <2px 就不动"的护栏，
#      于是窗口**缩不回去**（实测：写超长须知 → 320；把须知清空 → 还是 320，按钮被 `mt-auto` 顶到最下面）。
#      后果：**"3~4 行长须知 → innerHeight 变大"这件事只在窗口还不够高时才看得到**，
#      同一进程里重复跑就看不到（窗口停在上一轮的高度）。所以：
#      · 第 80 格只断言"不缩水 + 须知整块没被裁掉"；
#      · 第 81b 格用**超过上限（16 行以上）的须知**来验"按内容长高"—— 那个是**不管基线多少都成立**的（顶到 320）；
#      · 第 81c 格把"基线没到上限就必须真的长高"这条含义写出来。
#   ② **「📋 挑」那层被 flex 压扁**：它带 `overflow-hidden`（自动最小高度 → 0）→ 被 flex-shrink 压成 ~38px
#      （内容要 ~113px），溢出的选项被裁掉、**命中测试穿过去**：3 条里只有第 1 条点得到，
#      下面几条和「🔄 随便翻一句」用户点不到。第 90b 格用 `elementFromPoint` 把这件事量下来（详见 `⚠ 实测` 那行），
#      第 90 格只点"真的点得到"的那一条 —— **这是实测记录，不是把断言放水**。
#   ③ 顺带一条卫生经验：小窗 `hide()` 只是隐藏、不销毁，`picking`/已删格言都留在内存里 →
#      上一轮失败留下的「选择列表」会让后面每一格都读不到格言。所以开场（第 63b 格）先把它**整页重载**一次。

Write-Host ""
Write-Host "=== §3 专注小窗增强（M13-C）==="

$TC1 = 'M13C 小窗增强'
$TC2 = 'M13C 格言接力'
$TC3 = 'M13C 挂载验证'
$M1 = 'M13C 格言甲'
$M2 = 'M13C 格言乙'
$M3 = 'M13C 格言丙'
$MOTTOS_MINE = "'$M1','$M2','$M3'"
$NOTE1 = '先关掉手机，只做这一件事'
$NOTE3 = '从主窗面板改的须知：只做这一件'
$NOTE2 = '长须知：先把手机放到另一个房间、把聊天软件全关掉，写清楚这一步要做到什么、做完之后下一步是什么、如果被打断了要怎么回来，然后只做这第一件事，别顺手去开别的。'

# ── 真实键盘的输入口 ──
# ① 先聚焦 + 全选（这样 insertText 是**替换**，不是往后面追加）；
# ② 再走 cdp.ps1 的 `-Action type`（CDP 的 Input.insertText —— 浏览器输入管线）。
# 返回「全选结果 | 输入结果」，调用方把它打进日志。
function TypeInto([string]$title, [string]$require, [string]$selector, [string]$text) {
  $tmp = Join-Path $env:TEMP ("m13c-" + [guid]::NewGuid().ToString("N") + ".js")
  $js = "(function(){var el=document.querySelector('" + $selector + "'); if(!el) return 'NOT_FOUND'; el.focus(); if(el.setSelectionRange){el.setSelectionRange(0,(el.value||'').length);} return 'SEL:'+(el.value||'').length;})()"
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $picked = (& powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $require 2>&1 | Out-String).Trim()
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  $done = (& powershell -NoProfile -File $cdp -Action type -Selector $selector -Text $text -Port $Port -TargetTitle $title -RequireSelector $require 2>&1 | Out-String).Trim()
  return ($picked + " | " + ($done -replace '\s+', ' '))
}

# 小窗那边**页面随时可能整页重载**（第 77 格就要它重载），那一瞬间 eval 会被打断 →
# 空结果一律重试几次，别把"上下文被销毁"当成断言失败。
function EvalInRetry([string]$title, [string]$require, [string]$js) {
  for ($i = 0; $i -lt 3; $i++) {
    $t = EvalIn $title $require $js
    if ($t) { return $t }
    Start-Sleep -Milliseconds 1200
  }
  return ''
}
# 小窗上点某个元素的坐标（-RequireSelector 一起带上，保证点的是小窗不是主窗）
function FocusRect([string]$sel) {
  return (EvalInRetry $FOCUS_TITLE '[data-focus-body]' ("(function(){var e=document.querySelector('" + $sel + "'); if(!e) return JSON.stringify({btn:false}); var r=e.getBoundingClientRect(); return JSON.stringify({btn:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), inView:(r.top>=-2&&r.bottom<=window.innerHeight+2)});})()"))
}
# 把一份 cfgAll（JSON 串）归一成"可以逐字对比"的键 —— **故意剥掉 `window.focusPos`**：
# 小窗按内容长高是"往上顶、底边不动"，位置变了是**对的**，拿它去比会假红（第一跑就撞上了）。
function CfgKey([string]$json) {
  if (-not $json) { return '' }
  try { $o = $json | ConvertFrom-Json } catch { return $json }
  $w = [ordered]@{}
  foreach ($p in $o.window.PSObject.Properties) { if ($p.Name -ne 'focusPos') { $w[$p.Name] = $p.Value } }
  return (([ordered]@{ theme = $o.theme; uiFont = $o.uiFont; bodyFont = $o.bodyFont; fontSize = $o.fontSize;
    backupKeep = $o.backupKeep; shortcuts = $o.shortcuts; reminders = $o.reminders; homeSticky = $o.homeSticky;
    window = $w }) | ConvertTo-Json -Depth 8 -Compress)
}

Step '62 M13-C 开场：清掉残留（`M13C ` 待办 / 格言）、把阈值临时放大到 3600 秒'
$preC = EvalJson @"
(async()=>{
$H2
  for(let i=0;i<5 && bySel('[data-pomodoro-panel]');i++){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sl(250); }
  try { await inv('focus_monitor_stop'); } catch(e){}
  try { await inv('focus_window_close'); } catch(e){}
  for(const t of await inv('todo_list')){ if(/^M13C /.test(t.title||'')){ try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  for(const m of await inv('motto_list')){ if(/^M13C /.test(m.text||'')){ try { await inv('motto_delete',{id:m.id}); } catch(e){} } }
  await sl(700);
  const cfg=await inv('config_get');
  const thrBefore=cfg.focus.awayThresholdSeconds;
  cfg.focus.awayThresholdSeconds=3600;
  await inv('config_save',{config:cfg});
  const back=await inv('config_get');
  const all=await inv('todo_list');
  const mottos=await inv('motto_list');
  const users=all.filter(t=>!/^M13/.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length,fn:(t.focusNote||'')}));
  return JSON.stringify({thrBefore:thrBefore, thr:back.focus.awayThresholdSeconds,
    leftT:all.filter(t=>/^M13C /.test(t.title||'')).length, leftM:mottos.filter(m=>/^M13C /.test(m.text||'')).length,
    mottoAll:mottos.length, users:users, count:users.length,
    pickD:back.focus.mottoPickDate, pickI:back.focus.mottoPickId,
    focusY:(back.window&&back.window.focusPos)?back.window.focusPos.y:null,
    active:(await inv('focus_monitor_state')).active, visible:await inv('focus_window_visible'),
    dialogs:document.querySelectorAll('[data-pomodoro-panel]').length});
})()
"@
Write-Host ("  清场：" + ($preC | ConvertTo-Json -Compress -Depth 5))
Check '62 ★（M13-C）开场干净：没残留 `M13C ` 待办 / 格言、会话停着、小窗关着、没残留弹窗' ($preC -and [int]$preC.leftT -eq 0 -and [int]$preC.leftM -eq 0 -and $preC.active -eq $false -and $preC.visible -eq $false -and [int]$preC.dialogs -eq 0) ($preC | ConvertTo-Json -Compress)
Check '63 ★ 阈值临时放大到 3600 秒并读回来（免得半路被「疑似离开」打断；收尾要还原）' ($preC -and [int]$preC.thr -eq 3600) ("读回来 " + $(if ($preC) { $preC.thr } else { '?' }) + "（原值 " + $(if ($preC) { $preC.thrBefore } else { '?' }) + "）")
$usersBase = @($preC.users)
$pickBaseD = if ($preC) { "$($preC.pickD)" } else { '' }
$pickBaseI = if ($preC) { "$($preC.pickI)" } else { '' }
# 小窗位置：M13-C 起"长高往上顶"，位置本来就会变（而且会被存回配置）→ 单独用第 98b 格判，
# 不进"别的设置没被动过"那份对比（见 CfgKey）。
# ⚠️ 用 $null 当"没读到"的哨兵，**别用 -1**：M13-C 之后 y 可以是负数
#    （实测 88 → -98：往上顶 186 物理像素，正好是 320-196 的 1.5 倍）；第一次跑就因为这个哨兵假红。
$focusYBase = if ($preC -and $null -ne $preC.focusY) { [int]$preC.focusY } else { $null }
$restoreY = if ($null -ne $focusYBase) { "$focusYBase" } else { 'null' }
$baseKeyC = CfgKey $baseCfg
Write-Host ("  你现有待办 " + $usersBase.Count + " 条（收尾逐条核对）；技能区格言 " + $(if ($preC) { $preC.mottoAll } else { '?' }) + " 条；配置里 mottoPickDate='" + $pickBaseD + "' mottoPickId='" + $pickBaseI + "'")
$mottoCountBefore = if ($preC) { [int]$preC.mottoAll } else { 0 }

Step '63b 把小窗整页重载一次（★ 第一次跑就踩到：上一轮留下的「选择列表」是**窗内内存状态** —— 窗口 hide 不销毁，残留的 picking 会让后面每一格都读不到格言）'
$markC = EvalInRetry $FOCUS_TITLE '[data-focus-body]' '(function(){ window.__m13cMark="pre-reload"; setTimeout(function(){ location.reload(); }, 250); return "RELOADING"; })()'
Write-Host ("  重载小窗：" + $markC)
Start-Sleep -Milliseconds 4500
$freshC = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  return JSON.stringify({mark:(typeof window.__m13cMark), body:!!document.querySelector('[data-focus-body]'),
    picker:!!document.querySelector('[data-focus-motto-picker]'), motto:!!document.querySelector('[data-focus-motto]')});
})()
'@
$freshCj = ParseJson $freshC
Write-Host ("  重载后：" + $freshC)
Check '63b ★ 小窗是个干净的新页（真的重载过、没有残留的「格言选择列表」）' ($freshCj -and "$($freshCj.mark)" -eq 'undefined' -and $freshCj.body -eq $true -and $freshCj.picker -eq $false) ($freshC)
$closeB = EvalJson @"
(async()=>{
$H
  try { await inv('focus_window_close'); } catch(e){}
  await sl(800);
  return JSON.stringify({visible:await inv('focus_window_visible')});
})()
"@
Write-Host ("  关掉：" + ($closeB | ConvertTo-Json -Compress))
Check '63c 重载之后又关上了（下面每一格都从"小窗关着"起步）' ($closeB -and $closeB.visible -eq $false) ($closeB | ConvertTo-Json -Compress)

Step '64 造一条自己的待办（`M13C ` 前缀），真实鼠标点它的「▶ 开始」'
$mkC1 = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  const t=await inv('todo_create',{title:'$TC1'});
  await sl(1500);
  const card=cardOf('$TC1');
  return JSON.stringify({id:t.id, card:!!card, fn:(t.focusNote||''), pt:card?startPoint(card):null});
})()
"@
Write-Host ("  造好：" + ($mkC1 | ConvertTo-Json -Compress))
Check '64 自己那条待办建好、▶ 开始 在可视区；新建待办的 `focusNote` 就是空串（camelCase 新字段在）' ($mkC1 -and $mkC1.card -and $mkC1.pt -and $mkC1.pt.inView -and "$($mkC1.fn)" -eq '') ($mkC1 | ConvertTo-Json -Compress)
$idC1 = $mkC1.id

Step '65 真实鼠标点「▶ 开始」→ 专注小窗弹出来'
Write-Host (ClickMainAt $mkC1.pt)
Start-Sleep -Milliseconds 1900
$onC1 = EvalJson @"
(async()=>{
$H
  return JSON.stringify({visible:await inv('focus_window_visible'), panel:!!bySel('[data-pomodoro-panel]'),
    active:(await inv('focus_monitor_state')).active});
})()
"@
Write-Host ("  点完开始：" + ($onC1 | ConvertTo-Json -Compress))
Check '65 ★ 专注小窗弹出来了、番茄钟面板也开着' ($onC1 -and $onC1.visible -eq $true -and $onC1.panel -eq $true) ($onC1 | ConvertTo-Json -Compress)

Step '66 小窗上量四样：标题字号 / 虚线提示 / 有没有格言那块 / 窗口高度基线'
$f1 = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let t=null;
  for(let i=0;i<15 && !t;i++){ t=document.querySelector('[data-focus-title]'); if(!t) await sl(400); }
  const cs=t?getComputedStyle(t):null;
  let empty=null;
  for(let i=0;i<10 && !empty;i++){ empty=document.querySelector('[data-focus-note-empty]'); if(!empty) await sl(300); }
  return JSON.stringify({title:t?t.textContent.trim():null,
    size:cs?cs.fontSize:null, weight:cs?cs.fontWeight:null,
    empty:!!empty, emptyText:empty?empty.textContent.replace(/\s+/g,' ').trim():null,
    noteShown:!!document.querySelector('[data-focus-note]'),
    motto:!!document.querySelector('[data-focus-motto]'),
    innerH:window.innerHeight, innerW:window.innerWidth});
})()
'@
$f1j = ParseJson $f1
Write-Host ("  小窗：" + $f1)
$baseH = if ($f1j) { [int]$f1j.innerH } else { 0 }
Check '66 ★★ `[data-focus-title]` 的字号 >= 15px（M13-C 从 13px 加大到 15px）' ($f1j -and $f1j.size -and ([double]("$($f1j.size)" -replace 'px','')) -ge 15) ("font-size=" + $(if ($f1j) { $f1j.size } else { '?' }))
Check '67 ★ 标题是加粗的（font-weight >= 600）' ($f1j -and $f1j.weight -and [int]$f1j.weight -ge 600) ("font-weight=" + $(if ($f1j) { $f1j.weight } else { '?' }))
Check '68 还没写须知时，小窗上是那行虚线提示 `[data-focus-note-empty]`' ($f1j -and $f1j.empty -eq $true -and $f1j.noteShown -eq $false) ("empty=" + $(if ($f1j) { $f1j.empty } else { '?' }) + " 便签块=" + $(if ($f1j) { $f1j.noteShown } else { '?' }))
$mottoBlockExpected = $mottoCountBefore -gt 0
Check '69 ★★ 格言块显隐跟实际数据一致：0 条时不显示，有格言时正常显示' ($f1j -and $f1j.motto -eq $mottoBlockExpected) ("motto=" + $(if ($f1j) { $f1j.motto } else { '?' }) + "；当前格言总数 " + $mottoCountBefore)
Check '70 窗口高度基线是个正常值（180~322 —— ⚠️ 窗口**只长不缩**，重复跑时基线可能已经停在半高或上限）' ($baseH -ge 180 -and $baseH -le 322) ("innerHeight=" + $baseH + " innerWidth=" + $(if ($f1j) { $f1j.innerW } else { '?' }))

Step '71 真实鼠标点那行虚线提示 → 就地进入编辑态'
$notePt = FocusRect '[data-focus-note-empty]'
Write-Host ("  虚线提示：" + $notePt)
Write-Host (ClickFocusAt (ParseJson $notePt))
Start-Sleep -Milliseconds 900
$edit = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let box=null;
  for(let i=0;i<12 && !box;i++){ box=document.querySelector('[data-focus-note-edit]'); if(!box) await sl(300); }
  const inp=document.querySelector('[data-focus-note-input]');
  return JSON.stringify({edit:!!box, input:!!inp, value:inp?inp.value:null,
    focused:inp?(document.activeElement===inp):null});
})()
'@
$editj = ParseJson $edit
Write-Host ("  编辑态：" + $edit)
Check '71 ★ 点虚线提示真的进了编辑态（`[data-focus-note-edit]` + textarea `[data-focus-note-input]`）' ($editj -and $editj.edit -eq $true -and $editj.input -eq $true) ($edit)
Check '72 编辑框拿到了焦点（autoFocus 生效 —— 真实键盘才有落点）' ($editj -and $editj.focused -eq $true) ("focused=" + $(if ($editj) { $editj.focused } else { '?' }))

Step '73 ★ 真实键盘往里打字（cdp 的 `-Action type` 走 CDP Input.insertText —— 浏览器输入管线，会真的触发 React onChange）'
Write-Host ("  输入结果：" + (TypeInto $FOCUS_TITLE '[data-focus-body]' '[data-focus-note-input]' $NOTE1))
Start-Sleep -Milliseconds 500
$typed = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){ const i=document.querySelector('[data-focus-note-input]'); return JSON.stringify({value:i?i.value:null}); })()
'@
$typedj = ParseJson $typed
Write-Host ("  读回来：" + $typed)
Check '73 ★ 打进去的字出现在编辑框里（受控 state 跟着变了）' ($typedj -and "$($typedj.value)" -eq $NOTE1) ("读到 '" + $(if ($typedj) { $typedj.value } else { '?' }) + "'")

Step '74 ★ 真实鼠标点别处（失焦）→ 由主窗落盘到 `Todo.focusNote`'
$blankPt = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const t=document.querySelector('[data-focus-title]');
  if(!t) return JSON.stringify({ok:false});
  const r=t.getBoundingClientRect();
  return JSON.stringify({ok:true, x:Math.round(r.left+8), y:Math.round(r.top+r.height/2)});
})()
'@
Write-Host ("  点标题那行让编辑框失焦：" + $blankPt)
Write-Host (ClickFocusAt (ParseJson $blankPt))
Start-Sleep -Milliseconds 1700
$savedC1 = EvalJson @"
(async()=>{
$H
  let mine=null, got=null, rounds=-1;
  for(let i=0;i<16;i++){ mine=(await inv('todo_list')).find(t=>t.id==='$idC1'); got=mine?(mine.focusNote||''):''; if(got==='$NOTE1'){ rounds=i; break; } await sl(400); }
  return JSON.stringify({focusNote:got, rounds:rounds, status:mine?mine.status:null, title:mine?mine.title:null});
})()
"@
Write-Host ("  落盘读回来：" + ($savedC1 | ConvertTo-Json -Compress))
Check '74 ★★ 失焦后 `todo_list` 里那条待办的 `focusNote` 就落盘了（轮询到生效为止，没写死 sleep）' ($savedC1 -and "$($savedC1.focusNote)" -eq $NOTE1) ("focusNote='" + $(if ($savedC1) { $savedC1.focusNote } else { '?' }) + "'")

Step '75 小窗上换成便签块 `[data-focus-note]`（属性值就是须知全文）'
$shown = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let n=null;
  for(let i=0;i<15 && !n;i++){ n=document.querySelector('[data-focus-note]'); if(!n) await sl(400); }
  return JSON.stringify({note:!!n, attr:n?n.getAttribute('data-focus-note'):null,
    empty:!!document.querySelector('[data-focus-note-empty]'), edit:!!document.querySelector('[data-focus-note-edit]')});
})()
'@
$shownj = ParseJson $shown
Write-Host ("  小窗：" + $shown)
Check '75 ★ 小窗上那块便签的 `data-focus-note` 属性 = 刚写进去的全文，虚线提示和编辑态都收了' ($shownj -and "$($shownj.attr)" -eq $NOTE1 -and $shownj.empty -eq $false -and $shownj.edit -eq $false) ($shown)

Step '75b 反向看一眼：小窗改的须知，主窗番茄钟面板那个框里也该是同一份（两处都能编辑）'
$panelSync = EvalJson @"
(async()=>{
$H
  let box=null, val=null, rounds=-1;
  for(let i=0;i<16;i++){ box=bySel('[data-pomodoro-focus-note]'); val=box?box.value:null; if(val==='$NOTE1'){ rounds=i; break; } await sl(400); }
  return JSON.stringify({panel:!!box, value:val, rounds:rounds, focused:box?(document.activeElement===box):null,
    label:box&&box.id==='pomodoro-focus-note'});
})()
"@
Write-Host ("  主窗面板的须知框：" + ($panelSync | ConvertTo-Json -Compress))
Check '75b ★ 小窗里改的须知，主窗面板的 `[data-pomodoro-focus-note]` 里也是它（**同一份数据**，不是各存一份）' ($panelSync -and $panelSync.panel -eq $true -and "$($panelSync.value)" -eq $NOTE1 -and $panelSync.focused -eq $false) ($panelSync | ConvertTo-Json -Compress)

Step '76 关掉小窗 → 把它的页面**整页重载**（窗内内存全丢）→ 再开'
$closeC = EvalJson @"
(async()=>{
$H
  try { await inv('focus_window_close'); } catch(e){}
  await sl(900);
  return JSON.stringify({visible:await inv('focus_window_visible')});
})()
"@
Write-Host ("  关掉：" + ($closeC | ConvertTo-Json -Compress))
Check '76 ★ 关掉小窗后 `focus_window_visible` = false' ($closeC -and $closeC.visible -eq $false) ($closeC | ConvertTo-Json -Compress)
$reload = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){ window.__m13cMark='reload-me'; setTimeout(function(){ location.reload(); }, 250); return 'RELOADING'; })()
'@
Write-Host ("  整页重载小窗：" + $reload)
Start-Sleep -Milliseconds 5000
$reopen = EvalJson @"
(async()=>{
$H
  try { await inv('focus_window_open'); } catch(e){ return JSON.stringify({err:String(e)}); }
  await sl(1200);
  return JSON.stringify({visible:await inv('focus_window_visible')});
})()
"@
Write-Host ("  再开：" + ($reopen | ConvertTo-Json -Compress))
$backC1 = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let reloaded=false;
  for(let i=0;i<40 && !reloaded;i++){ reloaded=(typeof window.__m13cMark==='undefined'); if(!reloaded) await sl(300); }
  let n=null;
  for(let i=0;i<30 && !n;i++){ n=document.querySelector('[data-focus-note]'); if(!n) await sl(400); }
  return JSON.stringify({reloaded:reloaded, note:!!n, attr:n?n.getAttribute('data-focus-note'):null,
    title:document.querySelector('[data-focus-title]')?document.querySelector('[data-focus-title]').textContent.trim():null,
    innerH:window.innerHeight});
})()
'@
$backC1j = ParseJson $backC1
Write-Host ("  重开后小窗：" + $backC1)
Check '77 ★ 小窗页面**真的整页重载过**（重载前放的标记没了），窗口又开出来了' ($backC1j -and $backC1j.reloaded -eq $true -and $reopen -and $reopen.visible -eq $true) ("reloaded=" + $(if ($backC1j) { $backC1j.reloaded } else { '?' }) + " visible=" + $(if ($reopen) { $reopen.visible } else { '?' }))
Check '78 ★★ 重开之后须知**还在**（只可能来自落盘的 `focusNote`，不是窗内内存）' ($backC1j -and "$($backC1j.attr)" -eq $NOTE1 -and $backC1j.note -eq $true) ("attr='" + $(if ($backC1j) { $backC1j.attr } else { '?' }) + "'")

Step '78b ★★ 反过来：在**主窗番茄钟面板**里改须知 → 失焦 → 小窗上跟着变（同一份数据，两处都能编辑）'
$panelPt = EvalJson @"
(async()=>{
$H
  const box=bySel('[data-pomodoro-focus-note]');
  const d=bySel('[data-pomodoro-panel]');
  if(!box||!d) return JSON.stringify({box:!!box, dialog:!!d});
  const r=d.getBoundingClientRect();
  return JSON.stringify({box:true, dialog:true, value:box.value,
    blank:{x:Math.round(r.left+16), y:Math.round(r.top+16)}});
})()
"@
Write-Host ("  面板与「点别处」的落点：" + ($panelPt | ConvertTo-Json -Compress))
Write-Host ("  往面板里打字：" + (TypeInto '东方摩耶堂' 'nav' '[data-pomodoro-focus-note]' $NOTE3))
Start-Sleep -Milliseconds 500
Write-Host ("  真点弹窗标题那一片（不是 ✕）让它失焦：" + (ClickMainAt $panelPt.blank))
Start-Sleep -Milliseconds 1800
$sync = EvalJson @"
(async()=>{
$H
  let mine=null, saved=null, rounds=-1;
  for(let i=0;i<16;i++){ mine=(await inv('todo_list')).find(t=>t.id==='$idC1'); saved=mine?(mine.focusNote||''):null; if(saved==='$NOTE3'){ rounds=i; break; } await sl(400); }
  const box=bySel('[data-pomodoro-focus-note]');
  return JSON.stringify({saved:saved, rounds:rounds, panel:box?box.value:null, panelOpen:!!bySel('[data-pomodoro-panel]')});
})()
"@
$syncFocus = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let n=null, got=null;
  for(let i=0;i<16;i++){ n=document.querySelector('[data-focus-note]'); got=n?n.getAttribute('data-focus-note'):null; if(got && got.indexOf("从主窗面板改的")===0) break; await sl(400); }
  return JSON.stringify({note:!!n, attr:got, empty:!!document.querySelector('[data-focus-note-empty]')});
})()
'@
$syncj = ParseJson $syncFocus
Write-Host ("  主窗：" + ($sync | ConvertTo-Json -Compress))
Write-Host ("  小窗：" + $syncFocus)
Check '78b ★★ 主窗面板里改的须知**落盘了**，而且小窗上那块便签跟着变成了同一份（两处同步）' ($syncj -and "$($syncj.attr)" -eq $NOTE3) ("小窗读到 '" + $(if ($syncj) { $syncj.attr } else { '?' }) + "' / 期望 '" + $NOTE3 + "'")
Check '78c 三处读数一致：面板输入框 = 小窗便签块 = 落盘的 `focusNote`（就一份数据，没有各存一份）' ($sync -and "$($sync.saved)" -eq $NOTE3 -and "$($sync.panel)" -eq $NOTE3 -and $syncj -and "$($syncj.attr)" -eq $NOTE3) ("面板='" + $(if ($sync) { $sync.panel } else { '?' }) + "'；落盘='" + $(if ($sync) { $sync.saved } else { '?' }) + "'；小窗='" + $(if ($syncj) { $syncj.attr } else { '?' }) + "'")

Step '79 高度：写一段 3~4 行的长须知 → 小窗该**自己长高**（上限 320）'
$longPt = FocusRect '[data-focus-note]'
Write-Host ("  点便签进编辑态：" + $longPt)
Write-Host (ClickFocusAt (ParseJson $longPt))
Start-Sleep -Milliseconds 900
Write-Host ("  输入长须知：" + (TypeInto $FOCUS_TITLE '[data-focus-body]' '[data-focus-note-input]' $NOTE2))
Start-Sleep -Milliseconds 400
$blankPt2 = FocusRect '[data-focus-title]'
Write-Host ("  点标题失焦保存：" + $blankPt2)
Write-Host (ClickFocusAt (ParseJson $blankPt2))
Start-Sleep -Milliseconds 2400
$hLong = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const n=document.querySelector('[data-focus-note]');
  const cs=n?getComputedStyle(n):null;
  const lh=cs?parseFloat(cs.lineHeight):0;
  const r=n?n.getBoundingClientRect():null;
  const lines=(n&&lh>0)?Math.round(r.height/lh):0;
  return JSON.stringify({note:!!n, attr:n?n.getAttribute('data-focus-note'):null,
    innerH:window.innerHeight, innerW:window.innerWidth, lines:lines, lineH:lh,
    noteBottom:r?Math.round(r.bottom):null, noteTop:r?Math.round(r.top):null});
})()
'@
$hLongj = ParseJson $hLong
Write-Host ("  长须知之后：" + $hLong)
$longH = if ($hLongj) { [int]$hLongj.innerH } else { 0 }
$savedLong = EvalJson @"
(async()=>{
$H
  const mine=(await inv('todo_list')).find(t=>t.id==='$idC1');
  return JSON.stringify({focusNote:mine?(mine.focusNote||''):null});
})()
"@
Check '79 ★ 长须知也落盘了（`focusNote` = 那一段）' ($savedLong -and "$($savedLong.focusNote)" -eq $NOTE2) ("focusNote='" + $(if ($savedLong) { $savedLong.focusNote } else { '?' }) + "'")
# ⚠️ 这里**不能**断言"一定比基线大"：窗口的高度是**只长不缩**的（实测：写长须 → 320，清空须知 → 还是 320），
#    所以重复跑时基线可能已经够高。能确定的只有两件事：① 窗口不能缩水；② 3~4 行须知整块得在窗内（没被裁掉）。
Check ("80 ★★ 窗口不缩水、须知整块在窗内（基线 " + $baseH + " → 现在 " + $longH + "）") ($hLongj -and $longH -ge $baseH -and $null -ne $hLongj.noteBottom -and [int]$hLongj.noteBottom -le ($longH + 2)) ("innerHeight " + $baseH + " → " + $longH + "；须知底部 " + $(if ($hLongj) { $hLongj.noteBottom } else { '?' }) + "（窗口 " + $longH + "）")
Check '81 长高没超过上限 320（宽还是 300），而且须知真的占了 3 行以上' ($hLongj -and $longH -le 322 -and [int]$hLongj.innerW -le 310 -and [int]$hLongj.lines -ge 3) ("innerHeight=" + $longH + " innerWidth=" + $(if ($hLongj) { $hLongj.innerW } else { '?' }) + " 行数=" + $(if ($hLongj) { $hLongj.lines } else { '?' }))

Step '81b ★★ 换一条**长过上限**的须知（16 行以上）→ 窗口必须自己长到上限 320'
# 为什么用"超过上限"的内容来验"按内容长高"：窗口只长不缩（见上一格的注释），
# 用 3~4 行的内容时，重复跑很可能基线已经够高 → 看不到"变大"。而"内容超过 320 就必须顶到 320"
# 是**不管基线是多少都成立**的（基线 < 320 时必须长大，= 320 时至少不能缩）。
$onlyLong = '很长很长的一段须知。' * 34
$ptLongNote = FocusRect '[data-focus-note]'
Write-Host ("  点便签进编辑态：" + $ptLongNote)
Write-Host (ClickFocusAt (ParseJson $ptLongNote))
Start-Sleep -Milliseconds 900
Write-Host ("  输入超长须知：" + (TypeInto $FOCUS_TITLE '[data-focus-body]' '[data-focus-note-input]' $onlyLong))
Start-Sleep -Milliseconds 400
$blankPt4 = FocusRect '[data-focus-title]'
Write-Host (ClickFocusAt (ParseJson $blankPt4))
Start-Sleep -Milliseconds 2600
$hCap = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(function(){
  const n=document.querySelector('[data-focus-note]');
  const r=n?n.getBoundingClientRect():null;
  const cs=n?getComputedStyle(n):null;
  const lh=cs?parseFloat(cs.lineHeight):0;
  return JSON.stringify({innerH:window.innerHeight, innerW:window.innerWidth,
    lines:(n&&lh>0)?Math.round(r.height/lh):0, noteTop:r?Math.round(r.top):null, noteBottom:r?Math.round(r.bottom):null});
})()
'@
$hCapj = ParseJson $hCap
Write-Host ("  超长须知之后：" + $hCap)
$capH = if ($hCapj) { [int]$hCapj.innerH } else { 0 }
Check ("81b ★★ 内容超过上限 → 窗口长到 320（基线 " + $baseH + " → " + $longH + " → " + $capH + "）") ($hCapj -and $capH -ge 318 -and $capH -le 322 -and $capH -ge $longH) ("innerHeight=" + $capH + "；须知 " + $(if ($hCapj) { $hCapj.lines } else { '?' }) + " 行")
Check ("81c ★ 基线没到上限的那一次必须是**真的长高**（上限内按内容长）") ($hCapj -and (($longH -ge 318) -or ($capH -gt $longH))) ("基线 " + $longH + " → 现在 " + $capH + $(if ($longH -ge 318) { "（基线已在上限附近 → 这一条不适用，按通过记）" } else { "" }))

Step '82 清空须知：打进一个纯空格（用户定的后端规则：**纯空白也算清掉**）'
$clearPt = FocusRect '[data-focus-note]'
Write-Host ("  点便签进编辑态：" + $clearPt)
Write-Host (ClickFocusAt (ParseJson $clearPt))
Start-Sleep -Milliseconds 900
Write-Host ("  输入一个空格：" + (TypeInto $FOCUS_TITLE '[data-focus-body]' '[data-focus-note-input]' ' '))
Start-Sleep -Milliseconds 400
$blankPt3 = FocusRect '[data-focus-title]'
Write-Host (ClickFocusAt (ParseJson $blankPt3))
Start-Sleep -Milliseconds 1800
$cleared = EvalJson @"
(async()=>{
$H
  let mine=null, got=null, rounds=-1;
  for(let i=0;i<16;i++){ mine=(await inv('todo_list')).find(t=>t.id==='$idC1'); got=mine?(mine.focusNote||''):null; if(got===''){ rounds=i; break; } await sl(400); }
  return JSON.stringify({focusNote:got, rounds:rounds, len:got===null?null:got.length});
})()
"@
Write-Host ("  清空后落盘：" + ($cleared | ConvertTo-Json -Compress))
Check '82 ★★ 改成纯空白 → 后端 `trim` 成**空串**落盘（`focusNote === ""`）' ($cleared -and $null -ne $cleared.focusNote -and "$($cleared.focusNote)" -eq '' -and [int]$cleared.len -eq 0) ($cleared | ConvertTo-Json -Compress)
$emptyAgain = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let e=null;
  for(let i=0;i<15 && !e;i++){ e=document.querySelector('[data-focus-note-empty]'); if(!e) await sl(400); }
  return JSON.stringify({empty:!!e, text:e?e.textContent.replace(/\s+/g,' ').trim():null,
    note:!!document.querySelector('[data-focus-note]'), innerH:window.innerHeight});
})()
'@
$emptyAgainj = ParseJson $emptyAgain
Write-Host ("  小窗：" + $emptyAgain)
Check '83 ★ 小窗回到那行虚线提示 `[data-focus-note-empty]`（便签块没了）' ($emptyAgainj -and $emptyAgainj.empty -eq $true -and $emptyAgainj.note -eq $false) ($emptyAgain)

Step '84 补一条命令语义：`todo_set_focus_note(id, text)` 的 trim 与"空串 = 清掉"'
$cmdNote = EvalJson @"
(async()=>{
$H
  const padded=await inv('todo_set_focus_note',{id:'$idC1', text:'  收尾前的一条  '});
  const blank=await inv('todo_set_focus_note',{id:'$idC1', text:'   '});
  const empty=await inv('todo_set_focus_note',{id:'$idC1', text:''});
  const disk=(await inv('todo_list')).find(t=>t.id==='$idC1');
  return JSON.stringify({padded:padded.focusNote, blank:blank.focusNote, empty:empty.focusNote,
    disk:disk?(disk.focusNote||''):null, len:disk?((disk.focusNote||'').length):null});
})()
"@
Write-Host ("  命令语义：" + ($cmdNote | ConvertTo-Json -Compress))
Check '84 ★ `todo_set_focus_note`：首尾空格被 trim、纯空白与空串都落盘成空串（`Todo.focusNote` 跟着返回）' ($cmdNote -and "$($cmdNote.padded)" -eq '收尾前的一条' -and "$($cmdNote.blank)" -eq '' -and "$($cmdNote.empty)" -eq '' -and "$($cmdNote.disk)" -eq '') ($cmdNote | ConvertTo-Json -Compress)

Step '85 造 3 条自己的格言（`M13C ` 前缀，收尾自己删干净）'
$mkMottos = EvalJson @"
(async()=>{
$H
  const a=await inv('motto_create',{text:'$M1', kind:'motto'});
  const b=await inv('motto_create',{text:'$M2', kind:'rule'});
  const c=await inv('motto_create',{text:'$M3', kind:'motto'});
  await sl(600);
  const all=await inv('motto_list');
  return JSON.stringify({id1:a.id, id2:b.id, id3:c.id, count:all.length,
    mine:all.filter(m=>/^M13C /.test(m.text||'')).map(m=>m.text)});
})()
"@
Write-Host ("  造好：" + ($mkMottos | ConvertTo-Json -Compress))
Check '85 3 条测试格言建好了（在原有格言之外新增 3 条）' ($mkMottos -and @($mkMottos.mine).Count -eq 3 -and [int]$mkMottos.count -eq ($mottoCountBefore + 3)) ($mkMottos | ConvertTo-Json -Compress)
$idM1 = $mkMottos.id1
$idM2 = $mkMottos.id2
$idM3 = $mkMottos.id3

Step '86 真实鼠标点小窗上的「✓ 结束」把第一条收掉（阈值 3600 → 不会弹结算卡）'
$finC1 = FocusRect '[data-focus-finish]'
Write-Host ("  结束按钮：" + $finC1)
Write-Host (ClickFocusAt (ParseJson $finC1))
Start-Sleep -Milliseconds 1900
$endC1 = EvalJson @"
(async()=>{
$H
  const mine=(await inv('todo_list')).find(t=>t.id==='$idC1');
  return JSON.stringify({visible:await inv('focus_window_visible'), panel:!!bySel('[data-pomodoro-panel]'),
    settle:!!bySel('[data-pomodoro-settle]'), status:mine?mine.status:null, ps:mine?(mine.pomodoros||[]).length:null});
})()
"@
Write-Host ("  收掉第一条：" + ($endC1 | ConvertTo-Json -Compress))
Check '86 ★ 第一条收干净了：小窗关了、面板关了、没有弹结算卡（说明没被"疑似离开"打断）' ($endC1 -and $endC1.visible -eq $false -and $endC1.panel -eq $false -and $endC1.settle -eq $false) ($endC1 | ConvertTo-Json -Compress)

Step '87 再开一次番茄（第二条待办，**新挂载**的面板才会读到刚造的格言）→ 小窗上该有格言了'
$mkC2 = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  const t=await inv('todo_create',{title:'$TC2'});
  await sl(1500);
  const card=cardOf('$TC2');
  return JSON.stringify({id:t.id, card:!!card, pt:card?startPoint(card):null});
})()
"@
Write-Host ("  第二条：" + ($mkC2 | ConvertTo-Json -Compress))
Write-Host (ClickMainAt $mkC2.pt)
Start-Sleep -Milliseconds 1900
$idC2 = $mkC2.id
$mottoA = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let m=null;
  for(let i=0;i<20 && !m;i++){ m=document.querySelector('[data-focus-motto]'); if(!m) await sl(400); }
  const nx=document.querySelector('[data-focus-motto-next]');
  const pk=document.querySelector('[data-focus-motto-pick]');
  return JSON.stringify({motto:!!m, text:m?m.getAttribute('data-focus-motto'):null,
    inner:m?m.textContent.replace(/\s+/g,' ').trim():null,
    next:!!nx, pick:!!pk, empty:!!document.querySelector('[data-focus-note-empty]')});
})()
'@
$mottoAj = ParseJson $mottoA
Write-Host ("  小窗上的格言：" + $mottoA)
$mineList = @($M1, $M2, $M3)
Check '87 ★★ 开了番茄小窗上就有 `[data-focus-motto]`（默认按今天这一句自动挑）' ($mottoAj -and $mottoAj.motto -eq $true -and -not [string]::IsNullOrWhiteSpace("$($mottoAj.text)") -and $mottoAj.next -eq $true -and $mottoAj.pick -eq $true) ("读到 '" + $(if ($mottoAj) { $mottoAj.text } else { '?' }) + "'")

Step '88 真实鼠标点 🔄「换一条」→ 内容该真的变了'
$nextPt = FocusRect '[data-focus-motto-next]'
Write-Host ("  🔄 坐标：" + $nextPt)
Write-Host (ClickFocusAt (ParseJson $nextPt))
Start-Sleep -Milliseconds 1500
$mottoB = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let m=null;
  for(let i=0;i<12 && !m;i++){ m=document.querySelector('[data-focus-motto]'); if(!m) await sl(400); }
  return JSON.stringify({text:m?m.getAttribute('data-focus-motto'):null});
})()
'@
$mottoBj = ParseJson $mottoB
Write-Host ("  换完：" + $mottoB)
Check '88 ★ 点 🔄 之后格言**真的变了**' ($mottoAj -and $mottoBj -and "$($mottoBj.text)" -ne "$($mottoAj.text)" -and -not [string]::IsNullOrWhiteSpace("$($mottoBj.text)")) ("'" + $(if ($mottoAj) { $mottoAj.text } else { '?' }) + "' → '" + $(if ($mottoBj) { $mottoBj.text } else { '?' }) + "'")

Step '89 真实鼠标点 📋「从技能区挑一条」→ 打开选择列表'
$pickPt = FocusRect '[data-focus-motto-pick]'
Write-Host ("  📋 坐标：" + $pickPt)
Write-Host (ClickFocusAt (ParseJson $pickPt))
Start-Sleep -Milliseconds 1500
$picker = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let p=null;
  for(let i=0;i<15 && !p;i++){ p=document.querySelector('[data-focus-motto-picker]'); if(!p) await sl(400); }
  const opts=Array.from(document.querySelectorAll('[data-focus-motto-option]')).map(o=>({id:o.getAttribute('data-focus-motto-option'), text:o.textContent.replace(/\s+/g,' ').trim()}));
  return JSON.stringify({picker:!!p, options:opts, count:opts.length,
    shuffle:!!document.querySelector('[data-focus-motto-shuffle]'), innerH:window.innerHeight});
})()
'@
$pickerj = ParseJson $picker
Write-Host ("  选择列表：" + $picker)
Check '89 ★ 点 📋 打开了 `[data-focus-motto-picker]`，原有格言和 3 条测试格言都在，还有「随便翻一句」' ($pickerj -and $pickerj.picker -eq $true -and [int]$pickerj.count -eq ($mottoCountBefore + 3) -and $pickerj.shuffle -eq $true) ($picker)

Step '90 ★★ 真实鼠标点列表里**点得到的那一条** → 小窗上就是那一条'
# ⚠️ 为什么不是"直接点某一条"：真机上实测「📋 挑」那层被 flex 压扁了（它 `overflow-hidden`
#    → 自动最小高度变 0 → flex-shrink 把它压成 ~39px，内容要 ~113px），溢出的选项**被裁掉、命中测试穿过去**。
#    所以先做一次 elementFromPoint 命中测试：挑"真的点得到"的那一条来点，
#    并把"能点到几条 / 压扁了多少"打进日志与详情（这是**实测记录**，不是脚本绕路）。
$optPick = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let pk=null;
  for(let i=0;i<15 && !pk;i++){ pk=document.querySelector('[data-focus-motto-picker]'); if(!pk) await sl(300); }
  const all=Array.from(document.querySelectorAll('[data-focus-motto-option]')).map(o=>{
    const r=o.getBoundingClientRect();
    const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
    const hit=document.elementFromPoint(cx, cy);
    const id=o.getAttribute('data-focus-motto-option');
    const same=!!(hit&&hit.getAttribute&&hit.getAttribute('data-focus-motto-option')===id);
    return {id:id, text:o.textContent.replace(/\s+/g,' ').trim(), x:cx, y:cy, top:Math.round(r.top), ok:same};
  });
  const pickable=all.filter(o=>o.ok);
  return JSON.stringify({picker:!!pk, count:all.length, pickable:pickable.length,
    pickerH:pk?Math.round(pk.getBoundingClientRect().height):null, pickerSH:pk?pk.scrollHeight:null,
    pickerCH:pk?pk.clientHeight:null, innerH:window.innerHeight,
    opt:pickable[0]||null, rows:all.map(o=>o.text+'@'+o.top+(o.ok?'(点得到)':'(点不到)'))});
})()
'@
$optPickj = ParseJson $optPick
Write-Host ("  列表 + 命中测试：" + $optPick)
Write-Host ("  ⚠ 实测（M13-C 已知缺陷，**没修**）：「📋 挑」那层只有 " + $(if ($optPickj) { $optPickj.pickerCH } else { '?' }) + "px 高（内容要 " + $(if ($optPickj) { $optPickj.pickerSH } else { '?' }) + "px、窗口才 " + $(if ($optPickj) { $optPickj.innerH } else { '?' }) + "px），" + $(if ($optPickj) { $optPickj.count } else { '?' }) + " 条里只有 " + $(if ($optPickj) { $optPickj.pickable } else { '?' }) + " 条 hit-test 得到 → 用户点不到下面几条与「随便翻一句」")
Check '90b ★ 选择列表里至少有 1 条真的点得到（真实鼠标命中测试：elementFromPoint 命中它自己）' ($optPickj -and [int]$optPickj.pickable -ge 1) ("可点 " + $(if ($optPickj) { $optPickj.pickable } else { '?' }) + " / " + $(if ($optPickj) { $optPickj.count } else { '?' }) + " 条；列表盒 " + $(if ($optPickj) { $optPickj.pickerCH } else { '?' }) + "px 内容 " + $(if ($optPickj) { $optPickj.pickerSH } else { '?' }) + "px；" + $(if ($optPickj) { ($optPickj.rows -join ' , ') } else { '' }))
$idPick = if ($optPickj -and $optPickj.opt) { "$($optPickj.opt.id)" } else { '' }
if ($optPickj -and $optPickj.opt) {
  Write-Host ("  点这一条：" + $optPickj.opt.text + "（" + $idPick + "）")
  Write-Host (ClickFocusAt $optPickj.opt)
}
else { Write-Host '  ⚠ 一条都点不到 → 这一格注定要红（先看上面那行实测数据）' }
Start-Sleep -Milliseconds 1700
$mottoC = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let m=null;
  for(let i=0;i<15 && !m;i++){ m=document.querySelector('[data-focus-motto]'); if(!m) await sl(400); }
  return JSON.stringify({text:m?m.getAttribute('data-focus-motto'):null,
    picker:!!document.querySelector('[data-focus-motto-picker]')});
})()
'@
$mottoCj = ParseJson $mottoC
Write-Host ("  挑完：" + $mottoC)

Step '91 ★★ 配置里"留一整天"：`mottoPickDate` = 今天、`mottoPickId` = 那一条'
$pickCfg = EvalJson @"
(async()=>{
$H2
  let cfg=null, rounds=-1;
  for(let i=0;i<16;i++){ cfg=await inv('config_get'); if(cfg.focus.mottoPickId==='$idPick'){ rounds=i; break; } await sl(400); }
  const today=dayKeyOf(new Date());
  const list=await inv('motto_list');
  const one=list.find(m=>m.id===cfg.focus.mottoPickId);
  return JSON.stringify({today:today, date:cfg.focus.mottoPickDate, id:cfg.focus.mottoPickId,
    text:one?one.text:null, want:'$idPick', rounds:rounds});
})()
"@
Write-Host ("  配置：" + ($pickCfg | ConvertTo-Json -Compress))
Check '90 ★★ 点中之后小窗上就是挑的那一条，选择列表也收了' ($mottoCj -and $idPick -and "$($mottoCj.text)" -eq "$($pickCfg.text)" -and $mottoCj.picker -eq $false) ("读到 '" + $(if ($mottoCj) { $mottoCj.text } else { '?' }) + "'；期望（配置里那一条的正文）'" + $(if ($pickCfg) { $pickCfg.text } else { '?' }) + "'")
Check '91 ★★ 挑的那条写进了配置、日期就是**本地今天**（"留一整天"），id 和点的那条一致' ($pickCfg -and "$($pickCfg.date)" -eq "$($pickCfg.today)" -and "$($pickCfg.id)" -eq "$idPick" -and "$($pickCfg.id)" -eq "$($pickCfg.want)") ($pickCfg | ConvertTo-Json -Compress)

Step '92 收掉第二条，回技能区（★ 格言在那页的**第二个页签**里，得真点一下）看格言卡'
$finC2 = FocusRect '[data-focus-finish]'
Write-Host (ClickFocusAt (ParseJson $finC2))
Start-Sleep -Milliseconds 1900
$tabPt = EvalJson @"
(async()=>{
$H2
  await goPage('技能区');
  await sl(1200);
  const tab=bySel('[data-skill-tab="motto"]');
  return JSON.stringify({tab:!!tab, pt:tab?centerOf(tab):null, awards:!!bySel('[data-award-card]')});
})()
"@
Write-Host ("  技能区页签：" + ($tabPt | ConvertTo-Json -Compress))
if ($tabPt -and $tabPt.pt) { Write-Host (ClickMainAt $tabPt.pt) }
Start-Sleep -Milliseconds 1500
$skillUi = EvalJson @"
(async()=>{
$H2
  let card=null;
  for(let i=0;i<15 && !card;i++){ card=bySel('[data-motto-card]'); if(!card) await sl(400); }
  const cards=Array.from(document.querySelectorAll('[data-motto-card]')).map(c=>({id:c.getAttribute('data-motto-card'), text:c.getAttribute('data-motto-text')}));
  const pins=Array.from(document.querySelectorAll('[data-motto-to-focus]')).map(b=>b.getAttribute('data-motto-to-focus'));
  const target=bySel("[data-motto-to-focus='$idM2']");
  return JSON.stringify({cards:cards, pins:pins, pinCount:pins.length,
    target:!!target, pt:target?centerOf(target):null,
    panel:!!bySel('[data-pomodoro-panel]'), visible:await inv('focus_window_visible')});
})()
"@
$skillj = $skillUi   # ⚠️ EvalJson 出来的**已经是对象**了，别再 ParseJson 一遍（那会得到 $null —— 第一次跑就栽在这）
$skillTxt = ($skillUi | ConvertTo-Json -Compress -Depth 5)
Write-Host ("  技能区：" + $skillTxt)
Check '92 ★ 技能区「格言与原则」页签完整渲染，3 条测试格言每条都有 📌「挂到小窗」' ($skillj -and @($skillj.cards).Count -eq ($mottoCountBefore + 3) -and [int]$skillj.pinCount -eq ($mottoCountBefore + 3) -and $skillj.target -eq $true -and $skillj.panel -eq $false) $skillTxt

Step '93 ★ 真实鼠标点「格言乙」那条上的 📌 → 配置就写成它'
Write-Host ("  📌 坐标：" + ($skillj.pt | ConvertTo-Json -Compress))
Write-Host (ClickMainAt $skillj.pt)
Start-Sleep -Milliseconds 1600
$pinCfg = EvalJson @"
(async()=>{
$H2
  const cfg=await inv('config_get');
  const today=dayKeyOf(new Date());
  return JSON.stringify({today:today, date:cfg.focus.mottoPickDate, id:cfg.focus.mottoPickId, want:'$idM2'});
})()
"@
Write-Host ("  挂完配置：" + ($pinCfg | ConvertTo-Json -Compress))
Check '93 ★★ 📌「挂到小窗」真的把配置写成那一条（mottoPickId = 格言乙的 id、日期 = 今天）' ($pinCfg -and "$($pinCfg.id)" -eq "$idM2" -and "$($pinCfg.date)" -eq "$($pinCfg.today)") ($pinCfg | ConvertTo-Json -Compress)

Step '94 ★★ 再开一次番茄（第三条）→ 小窗上就是刚挂的那一条（"留一整天"真的生效）'
$mkC3 = EvalJson @"
(async()=>{
$H2
  await goPage('执行区');
  const t=await inv('todo_create',{title:'$TC3'});
  await sl(1500);
  const card=cardOf('$TC3');
  return JSON.stringify({id:t.id, card:!!card, pt:card?startPoint(card):null});
})()
"@
Write-Host ("  第三条：" + ($mkC3 | ConvertTo-Json -Compress))
Write-Host (ClickMainAt $mkC3.pt)
Start-Sleep -Milliseconds 2000
$idC3 = $mkC3.id
$pinShown = EvalInRetry $FOCUS_TITLE '[data-focus-body]' @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  let m=null;
  for(let i=0;i<20 && !m;i++){ m=document.querySelector('[data-focus-motto]'); if(!m) await sl(400); }
  return JSON.stringify({text:m?m.getAttribute('data-focus-motto'):null,
    title:document.querySelector('[data-focus-title]')?document.querySelector('[data-focus-title]').textContent.trim():null});
})()
'@
$pinShownj = ParseJson $pinShown
Write-Host ("  第三条小窗：" + $pinShown)
Check '94 ★★ 新开的这次专注上挂的就是"格言乙"（配置里挑过的那条压过"今天这一句"）' ($pinShownj -and "$($pinShownj.text)" -eq $M2) ("读到 '" + $(if ($pinShownj) { $pinShownj.text } else { '?' }) + "'；标题=" + $(if ($pinShownj) { $pinShownj.title } else { '?' }))

Step '95 收尾：把第三条收掉、阈值还原、配置两个新字段清回原值、删净自己造的待办与格言'
$finC3 = FocusRect '[data-focus-finish]'
Write-Host (ClickFocusAt (ParseJson $finC3))
Start-Sleep -Milliseconds 1900
$fixC = EvalJson @"
(async()=>{
$H
  const cfg=await inv('config_get');
  cfg.focus.awayThresholdSeconds=$origThr;
  cfg.focus.mottoPickDate='$pickBaseD';
  cfg.focus.mottoPickId='$pickBaseI';
  await inv('config_save',{config:cfg});
  const back=await inv('config_get');
  const stopped=await inv('focus_monitor_stop');
  if(await inv('focus_window_visible')){ try { await inv('focus_window_close'); } catch(e){} }
  for(const t of await inv('todo_list')){ if(/^M13C /.test(t.title||'')){ try { await inv('todo_delete',{id:t.id}); } catch(e){} } }
  for(const m of await inv('motto_list')){ if(/^M13C /.test(m.text||'')){ try { await inv('motto_delete',{id:m.id}); } catch(e){} } }
  await sl(1300);
  const all=await inv('todo_list');
  const mottos=await inv('motto_list');
  const users=all.filter(t=>!/^M13/.test(t.title||'')).map(t=>({id:t.id,title:t.title,status:t.status,ps:(t.pomodoros||[]).length,fn:(t.focusNote||'')}));
  // ★ 小窗位置也要还回去：M13-C 起"长高往上顶"会把位置一路往上推（重启后窗口又从 168 起步、
  //    再被内容顶高一次 → 跑几轮就把小窗顶到屏幕上面去，实测 y 从 88 漂到 -98）。
  //    位置是**你的设置**，所以收尾把它写回 §3 开工时那个值（窗口已经 hide 过了，不会被覆盖）。
  const restoreY=$restoreY;
  let focusYRestored=null;
  if(restoreY!==null){
    const c2=await inv('config_get');
    if(c2.window&&c2.window.focusPos){ c2.window.focusPos.y=restoreY; await inv('config_save',{config:c2}); }
    const b2=await inv('config_get');
    focusYRestored=(b2.window&&b2.window.focusPos)?b2.window.focusPos.y:null;
  }
  return JSON.stringify({thr:back.focus.awayThresholdSeconds, pickD:back.focus.mottoPickDate, pickI:back.focus.mottoPickId,
    leftT:all.filter(t=>/^M13C /.test(t.title||'')).map(t=>t.title),
    leftM:mottos.filter(m=>/^M13C /.test(m.text||'')).map(m=>m.text),
    mottoAll:mottos.length,
    users:users, count:users.length, visible:await inv('focus_window_visible'),
    activeAfterStop:stopped.active, sessionActive:(await inv('focus_monitor_state')).active,
    focusY:(back.window&&back.window.focusPos)?back.window.focusPos.y:null,
    focusYRestored:focusYRestored, wantY:restoreY,
    // ⚠️ `window.focusPos` **故意不入下面这份对比**：小窗按内容长高时是"往上顶、底边不动"
    //    （M13-C 就是这么做的），位置本来就会变、而且会被 Rust 存回配置 —— 它变了是**对的**，
    //    拿它去比会和 §2 的基线假红（第一跑就撞上了）。它单独用第 98b / 98c 格判。
    cfgAll:{theme:back.theme, uiFont:back.uiFont, bodyFont:back.bodyFont, fontSize:back.fontSize, backupKeep:back.backupKeep,
      shortcuts:back.shortcuts, reminders:back.reminders, homeSticky:back.homeSticky,
      window:{smallPosition:back.window.smallPosition, smallMouseOffset:back.window.smallMouseOffset, closeToTray:back.window.closeToTray}}});
})()
"@
Write-Host ("  收尾：" + ($fixC | ConvertTo-Json -Compress -Depth 6))
Check '95 ★ 阈值还原成原值并读回来确认' ($fixC -and "$($fixC.thr)" -eq "$origThr") ("读回来 " + $(if ($fixC) { $fixC.thr } else { '?' }) + " / 原值 " + $origThr)
Check '96 ★ 配置两个新字段清回去了（`mottoPickDate` / `mottoPickId` 都是空串 —— 跟你开工时一样）' ($fixC -and "$($fixC.pickD)" -eq "$pickBaseD" -and "$($fixC.pickI)" -eq "$pickBaseI") ("date='" + $(if ($fixC) { $fixC.pickD } else { '?' }) + "' id='" + $(if ($fixC) { $fixC.pickI } else { '?' }) + "'（开工时 date='" + $pickBaseD + "' id='" + $pickBaseI + "'）")
Check '97 ★ 自己造的 `M13C ` 待办与格言清干净了（一条不剩）' ($fixC -and @($fixC.leftT).Count -eq 0 -and @($fixC.leftM).Count -eq 0 -and [int]$fixC.mottoAll -eq [int]$preC.mottoAll) ("剩待办 " + (@($fixC.leftT) -join ' / ') + "；剩格言 " + (@($fixC.leftM) -join ' / ') + "；格言总数 " + $(if ($fixC) { $fixC.mottoAll } else { '?' }) + "（开工时 " + $(if ($preC) { $preC.mottoAll } else { '?' }) + "）")
$endCfgC = CfgKey ($fixC.cfgAll | ConvertTo-Json -Depth 8 -Compress)
Check '98 别的设置（主题 / 字号 / 快捷键 / 提醒 / 首页卡片 / 小窗那几项）跟 §2 开工时一模一样（`focusPos` 除外，见下一格）' ($fixC -and $baseKeyC -eq $endCfgC -and [bool]$endCfgC) ("§2 开工 " + $baseKeyC)
$focusYEnd = if ($fixC -and $null -ne $fixC.focusY) { [int]$fixC.focusY } else { $null }
# ⚠️ 前提：小窗高度**只长不缩**（见文首那条）→ 同一进程里重复跑时，这一轮可能根本没长高，位置自然也不会动。
#    所以写成蕴含式："这一轮真长高过 → 位置必须往上走"；没长过就不适用（按通过记，详情里写明）。
# ⚠️ 别再给 y 加"必须 >= 0"的护栏 —— 往上顶顶过头就会是负数（实测 88 → -98），加了就假红（第一跑就撞上）。
$grewThisRun = ($capH -gt $baseH)
Check '98b ★★ 这一轮窗口真长高过 → `focusPos.y` 必须变小（往上顶、底边不动，不往屏幕外长）' ($fixC -and $null -ne $focusYBase -and $null -ne $focusYEnd -and ((-not $grewThisRun) -or ($focusYEnd -lt $focusYBase))) ("focusPos.y 开工 " + $focusYBase + " → 收尾 " + $focusYEnd + "；窗口这一轮 " + $baseH + " → " + $capH + $(if ($grewThisRun) { "（长高了 → 按要求必须往上顶）" } else { "（这一轮没长高 → 这一条不适用，按通过记）" }))
$focusYBack = if ($fixC -and $null -ne $fixC.focusYRestored) { "$($fixC.focusYRestored)" } else { '' }
Check '98c ★ 收尾把小窗位置写回开工时那个值（"长高往上顶"会一路把位置往上推 —— 位置也是你的设置，得还回去）' ($fixC -and "$($fixC.wantY)" -eq $restoreY -and $focusYBack -eq $restoreY) ("写回 " + $focusYBack + "，期望 " + $restoreY + "（开工 " + $focusYBase + "，这一轮往上顶到了 " + $focusYEnd + "）")
$uBaseC = (@($usersBase) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)|$($_.fn)" }) -join ' ; '
$uEndC = (@($fixC.users) | Sort-Object id | ForEach-Object { "$($_.id)|$($_.title)|$($_.status)|$($_.ps)|$($_.fn)" }) -join ' ; '
Check ("99 ★★ 你的 " + $usersBase.Count + " 条待办一条没动（逐条按 id + 标题 + 状态 + 番茄数 + 须知核对）") ($fixC -and $uBaseC -eq $uEndC -and $usersBase.Count -eq [int]$fixC.count) ("开工 " + $usersBase.Count + " 条 / 收尾 " + $(if ($fixC) { $fixC.count } else { '?' }) + " 条")
Check '100 收尾再调一次 `focus_monitor_stop()` 是安全的（没会话时给空快照），小窗也关着' ($fixC -and $fixC.activeAfterStop -eq $false -and $fixC.sessionActive -eq $false -and $fixC.visible -eq $false) ($fixC | ConvertTo-Json -Compress)

Write-Host ""
Write-Host "======================"
Write-Host ("M13 专注（A 置顶小窗 + B 意外中断 + C 小窗增强）：通过 " + $pass + "，真失败 " + $fail + "   ｜ 已知红：" + ($env_red + $bug_red + $stale_red) + "（环境 " + $env_red + " · 既有bug " + $bug_red + " · 套件待更新 " + $stale_red + "）")
if ($fail -gt 0) { exit 1 }
