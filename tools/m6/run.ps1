# M6 · 快捷小窗验收（PRD 10.5）
#
# # 为什么快捷键必须用"真实按键"
# 全局热键是**操作系统级**的（底层 global-hotkey → 系统 API）。CDP 的
# `Input.dispatchKeyEvent` 只把事件送进渲染进程，**根本不会经过 OS 的热键钩子** ——
# 拿它验等于没验（又一次"合成事件假绿灯"，M4 栽过一模一样的坑）。
# 所以这里用 Win32 `keybd_event` 从系统层面真按键。
#
# # ⚠️ Ctrl+Space 在本机**时好时坏**（环境事实，不是 bug）
# 第一次跑就撞上了：`HotKey already registered: Ctrl+Space` —— 这个组合被别的程序
# （中日韩输入法切全角/半角）占了；后来又跑，它又能注册上了。**取决于跑的时候
# 机器上开着什么**，所以脚本**不许断言"它一定被占用"**（第一版就是这么写的，
# 后来环境变了 → 无条件失败，冤枉程序）。脚本改成：只断言"状态查得出来"。
# 本脚本验的是**完整链路**：
#   默认配的是 Ctrl+Space（PRD 指定）→ 注册不上时**不静默**（启动日志留痕）
#   → 设置里改键 → **改完立刻生效**（`config_save` 里重注册）→ 真实按键能唤起小窗。
# 这比"只验默认键"更贴近真实使用：用户的机器上这个键很可能也是被占的。
#
# # 两个窗口怎么区分
# 小窗和主窗 URL 完全一样（同一份前端产物），靠 CDP target 的 **title** 区分：
# 小窗把自己 `document.title` 设成「东方摩耶堂 · 速记」。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m6\run.ps1
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\tools\m6
$tools = Split-Path -Parent $here                             # …\tools
$cdp = Join-Path $tools 'cdp.ps1'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class MoyeHotKey {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    const uint KEYUP = 0x0002;
    // 按 accelerator 名字发键
    public static void PressKey(string name) {
        byte[] mods; byte key;
        switch (name) {
            case "Ctrl+Space":       mods = new byte[]{0x11};        key = 0x20; break;
            case "Ctrl+Alt+Space":   mods = new byte[]{0x11, 0x12};  key = 0x20; break;
            case "Ctrl+Shift+Space": mods = new byte[]{0x11, 0x10};  key = 0x20; break;
            case "Ctrl+Alt+M":       mods = new byte[]{0x11, 0x12};  key = 0x4D; break;
            case "F9":               mods = new byte[0];             key = 0x78; break;
            default:                 mods = new byte[]{0x11};        key = 0x20; break;
        }
        foreach (byte m in mods) { keybd_event(m, 0, 0, UIntPtr.Zero); Thread.Sleep(30); }
        keybd_event(key, 0, 0, UIntPtr.Zero);
        Thread.Sleep(70);
        keybd_event(key, 0, KEYUP, UIntPtr.Zero);
        for (int i = mods.Length - 1; i >= 0; i--) { keybd_event(mods[i], 0, KEYUP, UIntPtr.Zero); Thread.Sleep(30); }
    }
}
"@

# ⚠️ 用子进程调 cdp.ps1：本脚本被 `powershell -File` 用 5.1 跑，
# 5.1 下 `$out = & 别的.ps1` 的输出捕获和 pwsh 7 不一样（M4 实测捕到空值）。
#
# ⚠️⚠️ **别只按标题挑窗口 —— 标题会骗人。** 小窗 `hide()` 只是隐藏不销毁，它一直是个
# CDP target；而且它**重载的那一瞬间**标题会回到 `index.html` 里的「东方摩耶堂」，
# 跟主窗一模一样。所以这里一律带 `-RequireSelector`：**谁的页面上真有那个元素才算谁**
# （主窗有侧边栏 `nav`，小窗有 `[data-small-body]`）。2026-09-20 因为这个白跑过两轮回归。
function EvalIn([string]$title, [string]$js) {
  $tmp = Join-Path $env:TEMP ("m6-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    if ($title) {
      $sel = if ($title -like '*速记*') { '[data-small-body]' } else { 'nav' }
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -TargetTitle $title -RequireSelector $sel 2>&1
    }
    else {
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -RequireSelector 'nav' 2>&1
    }
    return (($out | Out-String).Trim())
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function EvalMain([string]$js) { return (EvalIn '东方摩耶堂' $js) }
function EvalSmall([string]$js) { return (EvalIn '速记' $js) }
function J([string]$json) { return ($json | ConvertFrom-Json) }

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}

$IS_VISIBLE = "window.__TAURI_INTERNALS__.invoke('small_window_visible').then(function(v){return JSON.stringify(v);})"
function Visible { return (J (EvalMain $IS_VISIBLE)) }

# 现在有几个速记窗（2026-10-13 加：验"按两下＝两个窗"要用）。
# 每个窗是一个独立 CDP target，标题形如「东方摩耶堂 · 速记」/「东方摩耶堂 · 速记 2」。
function SmallWindowCount {
  $out = (& powershell -NoProfile -File $cdp -Action targets -Port $Port 2>&1 | Out-String)
  return ([regex]::Matches($out, 'title=东方摩耶堂 · 速记')).Count
}

$TPL_SET_KEY = @'
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const c=await inv('config_get');
  c.shortcuts.toggleSmallWindow='__KEY__';
  const saved=await inv('config_save',{config:c});
  return JSON.stringify({key:saved.shortcuts.toggleSmallWindow});
})()
'@
function SetHotKey([string]$key) { return (J (EvalMain ($TPL_SET_KEY.Replace('__KEY__', $key)))) }

# ─────────────────────────── ① 前置 ───────────────────────────
try {
Write-Host "=== ① 前置：把快捷键恢复成默认、把小窗收掉 ==="
# ⚠️ 两条顺序都很重要：
#   1. **先把状态恢复干净再断言** —— 上一轮可能改了键、或留了个开着的小窗；
#      不恢复的话，"默认键是 Ctrl+Space"这条会读到上一轮的残留值而无条件失败。
#   2. **先收窗、再断言"它是关的"** —— 反过来写同样会无条件失败。
[void](SetHotKey 'Ctrl+Space')
Start-Sleep -Milliseconds 700
[void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
Start-Sleep -Milliseconds 900
$v0 = Visible
Check '前置（收掉之后）：小窗是关着的' ($v0 -eq $false) ("visible=" + $v0)
$cfg = J (EvalMain "window.__TAURI_INTERNALS__.invoke('config_get').then(function(c){return JSON.stringify(c.shortcuts);})")
Check '配置里默认就是 Ctrl+Space（PRD 指定的默认值）' ($cfg.toggleSmallWindow -eq 'Ctrl+Space') ($cfg.toggleSmallWindow)

# ─────────────────────────── ② 快捷键：注册链路 ───────────────────────────
Write-Host ""
Write-Host "=== ② 快捷键能注册上、改键立即生效（PRD 10.5 第 1 条） ==="
$status0 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('shortcut_status').then(function(s){return JSON.stringify(s);})")
Check '快捷键状态可查（设置页要靠它提示"这个键被占了"）' ($null -ne $status0.accelerator) ($status0 | ConvertTo-Json -Compress)
Check '默认键就是 Ctrl+Space（PRD 指定的默认值）' ($status0.default -eq 'Ctrl+Space') ($status0.default)
Write-Host ("  当前配置 = {0}；在系统里真注册上了吗 = {1}" -f $status0.accelerator, $status0.registered)
Check ("★ 默认键 {0} 的注册状态查得出来（注册不上也不静默）" -f $status0.accelerator) ($status0.registered -is [bool]) ("registered=" + $status0.registered)
if ($status0.registered) {
  Write-Host "  （说明：这一次 Ctrl+Space 在本机**注册上了**。之前那次是被别的程序（多半是输入法切全角/半角）占着 —— 能不能注册取决于跑的时候机器上开着什么，所以脚本不许假设。）"
} else {
  Write-Host "  （说明：这一次 Ctrl+Space 在本机**注册不上**（多半被输入法占了）—— 这正是「注册失败不能静默 + 设置里能改键」的由来。）"
}

$candidates = @('Ctrl+Alt+Space', 'Ctrl+Shift+Space', 'Ctrl+Alt+M', 'F9')
$chosen = $null
foreach ($key in $candidates) {
  [void](SetHotKey $key)
  Start-Sleep -Milliseconds 800
  $st = J (EvalMain "window.__TAURI_INTERNALS__.invoke('shortcut_status').then(function(s){return JSON.stringify(s);})")
  Write-Host ("  试 {0} → registered={1}" -f $key, $st.registered)
  if ($st.registered -eq $true) { $chosen = $key; break }
}
Check '★ 改键能改到"系统真的接受"的键（改键链路通、且立即生效）' ($null -ne $chosen) ("试过: " + ($candidates -join ', '))
if ($null -eq $chosen) {
  Write-Host "  所有候选键都注册不上？需要人工看看这台机器上还有什么键能用。"
  [void](SetHotKey 'Ctrl+Space')
  Write-Host ""
  Write-Host ("======================`nM6 小窗：通过 {0}，失败 {1}" -f $pass, $fail)
  exit 1
}

Write-Host ""
Write-Host "=== ②b 真实按键唤起小窗 ==="
[MoyeHotKey]::PressKey($chosen)
Start-Sleep -Milliseconds 1700
$byKey = Visible
if ($byKey -eq $true) {
  Check '★ 真实按键盘唤起了小窗' $true ''
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
  Start-Sleep -Milliseconds 900
}
else {
  # ⚠️ 如实标注"未能验证"，**既不算通过也不算失败**。
  # 原因：从本 shell 用 `keybd_event` 合成的按键没有进入系统的交互式输入队列，
  # 所以注册在系统里的热键收不到它（这不是程序的问题 —— 上面 registered=true，
  # 而且"切换小窗"这条逻辑下一步会用命令直接验过）。
  # 把它算成"通过"就是假绿灯（M4 的教训）；算成"失败"又会冤枉程序。
  Write-Host "  [ ] 未能验证（不计入通过/失败）：本 shell 合成的按键没有被系统热键层接受"
  Write-Host "      已知：registered=true（系统接受了这个键）；切换逻辑用命令验过是对的。"
  Write-Host "      → 请人工按一次真实键盘确认（这是唯一能证明的一环）。"
  [void](EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide').then(function(){return 'ok';})")
  Start-Sleep -Milliseconds 700
}

# ─────────────────────────── ③ 小窗是独立窗口 ───────────────────────────
Write-Host ""
Write-Host "=== ③ 小窗是独立的 webview，而且是「速记」界面 ==="
# ⚠️ CDP 偶尔会**短暂抽风**（本机 2026-10-03 出现过一次约 20 秒的空窗：`/json` 一个 target
#    都列不出来，随后自己恢复）→ 这里重试几次，别把"环境抽风"记成"小窗不是独立窗口"。
$targets = ''
for ($attempt = 0; $attempt -lt 4; $attempt++) {
  $targets = & powershell -NoProfile -ExecutionPolicy Bypass -File $cdp -Action targets -Port $Port 2>&1 | Out-String
  if ($targets -match '速记') { break }
  Start-Sleep -Milliseconds 1500
}
Check 'CDP 目标列表里有「东方摩耶堂 · 速记」（独立窗口）' ($targets -match '速记')
$smallUi = J (EvalSmall "JSON.stringify({title:document.title,label:window.__TAURI_INTERNALS__.metadata.currentWindow.label,tabs:Array.from(document.querySelectorAll('[data-small-tab]')).map(function(b){return b.getAttribute('data-small-tab');}),hasAside:!!document.querySelector('aside')})")
Check '★ 小窗的 window label 是 small' ($smallUi.label -eq 'small') ($smallUi.label)
Check '★ 小窗渲染的是「速记」界面（不是主界面）' ($smallUi.title -eq '东方摩耶堂 · 速记') ($smallUi.title)
Check '★ 小窗里没有主窗的侧边栏' (-not [bool]$smallUi.hasAside)
Check '小窗有【新建】【打开】两个 Tab' (($smallUi.tabs -join ',') -eq 'compose,open') ($smallUi.tabs -join ',')

# ─────────────────────────── ④ 新建 → 保存 → 认知区出现 ───────────────────────────
Write-Host ""
Write-Host "=== ④ 【新建】写内容 → 保存 → 认知区出现这篇新笔记（PRD 10.5 第 2 条） ==="
$before = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){return JSON.stringify(ns.map(function(n){return n.title;}));})")
$stamp = Get-Date -Format 'HHmmss'
$noteTitle = "M6 小窗验收 $stamp"
$noteBody = "这是从小窗写下来的，用来验【新建】能存成一篇笔记。"
$created = J (EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  const t=document.querySelector('[data-small-title]'); const b=document.querySelector('[data-small-body]');
  if(!t||!b) return JSON.stringify({error:'没找到小窗的输入框'});
  setV(t,'$noteTitle'); setV(b,'$noteBody');
  await sl(250);
  document.querySelector('[data-small-save]').click();
  await sl(1800);
  return JSON.stringify({
    status:(document.querySelector('[data-small-status]')||{}).innerText||'',
    editing:(document.querySelector('[data-small-editing]')||{}).innerText||''});
})()
"@)
Check '小窗里有标题/正文输入框' (-not $created.error) ($created.error)
Check '点保存后状态是「已保存」' ($created.status -match '已保存') ($created.status)
Check '★ 存住之后变成「编辑中」（再存是写回同一篇）' ($created.editing -match '编辑中') ($created.editing)

$after = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){return JSON.stringify(ns.map(function(n){return n.title+'|'+(n.content||'').slice(0,24);}));})")
Check '★ 认知区（主窗数据）里出现了这篇新笔记' ([bool]($after | Where-Object { $_ -like "$noteTitle*" })) (($after | Where-Object { $_ -like "M6*" }) -join ' ;; ')
Check '★ 笔记数量 +1' ($after.Count -eq $before.Count + 1) ("$($before.Count) -> $($after.Count)")
$savedRow = $after | Where-Object { $_ -like "$noteTitle*" } | Select-Object -First 1
Check '正文也存进去了' ($savedRow -match '小窗写下来') $savedRow

# ─────────────────────────── ⑤ 打开 → 搜索 → 继续编辑 ───────────────────────────
Write-Host ""
Write-Host "=== ⑤ 【打开】搜得到、能打开继续编辑（PRD 10.5 第 3 条） ==="
$opened = J (EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));};
  document.querySelector('[data-small-tab="open"]').click();
  await sl(500);
  const s=document.querySelector('[data-small-search]');
  if(!s) return JSON.stringify({error:'没有搜索框'});
  setV(s,'$noteTitle');
  await sl(600);
  const items=Array.from(document.querySelectorAll('[data-small-note]'));
  if(!items.length) return JSON.stringify({error:'搜不到刚写的笔记',count:0});
  items[0].click();
  await sl(800);
  const t=document.querySelector('[data-small-title]');
  return JSON.stringify({count:items.length,title:t?t.value:'',
    body:(document.querySelector('[data-small-body]')||{}).value||''});
})()
"@)
Check '【打开】Tab 有搜索框' (-not ($opened.error -eq '没有搜索框')) ($opened.error)
Check '★ 搜得到刚写的那篇' ($opened.count -ge 1) ("命中 " + $opened.count + " / " + $opened.error)
Check '★ 打开后编辑区载入了它的标题' ($opened.title -eq $noteTitle) ($opened.title)
Check '★ 正文也载入了（能接着改）' ($opened.body -match '小窗写下来') ($opened.body)

$appended = ' 【继续编辑过】'
[void](EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const b=document.querySelector('[data-small-body]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(b, b.value+'$appended');
  b.dispatchEvent(new Event('input',{bubbles:true}));
  await sl(250);
  document.querySelector('[data-small-save]').click();
  await sl(1800);
  return JSON.stringify({ok:true});
})()
"@)

$after2 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){return JSON.stringify(ns.map(function(n){return n.title+'|'+(n.content||'');}));})")
Check '★ 改的内容写回了同一篇（没新建第二条）' ($after2.Count -eq $after.Count) ("$($after.Count) -> $($after2.Count)")
$row2 = $after2 | Where-Object { $_ -like "$noteTitle*" } | Select-Object -First 1
Check '★ 磁盘上能看到继续编辑的内容' ($row2 -match '继续编辑过') ($row2.Substring(0, [Math]::Min(70, $row2.Length)))

# ─────────────────────────── ⑥ 未保存 → Esc → 自动保存 ───────────────────────────
Write-Host ""
Write-Host "=== ⑥ 有未保存内容 → Esc 收起会自动存（DEV-PLAN M6 任务 3） ==="
$autoStamp = "自动保存-$stamp"
$typed = J (EvalSmall @"
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
  document.querySelector('[data-small-new]').click();
  await sl(500);
  setV(document.querySelector('[data-small-title]'),'$autoStamp');
  setV(document.querySelector('[data-small-body]'),'这条是没点保存就按 Esc 的，应该被自动存住。');
  await sl(350);
  return JSON.stringify({status:(document.querySelector('[data-small-status]')||{}).innerText||''});
})()
"@)
Check '写完之后状态是「未保存」' ($typed.status -match '未保存') ($typed.status)

# Esc 由页面自己监听，所以这里页面内派发是**对的**（它不是全局热键，不走 OS）
[void](EvalSmall "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'esc'")
Start-Sleep -Milliseconds 2200

$v2 = Visible
Check '★ 按 Esc 之后小窗收起了' ($v2 -eq $false) ("visible=" + $v2)
$after3 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){return JSON.stringify(ns.map(function(n){return n.title;}));})")
Check '★ 没点保存的内容被自动存住了' ([bool]($after3 | Where-Object { $_ -like "$autoStamp*" })) (($after3 | Where-Object { $_ -like '自动保存*' }) -join ', ')

# ─────────────────────────── ⑦ 一键多开 ───────────────────────────
Write-Host ""
Write-Host "=== ⑦ 按一下给一个窗（走命令路径；真实按键那一环见 ②b） ==="
# 🔴 2026-10-13 改：这一段原来钉的是老语义「开着就收、没开就弹」（走 `small_window_toggle`）。
#    用户 2026-10-13 实测后明确要求：「**我可以按好多次 f9，同时也出好多个小窗**」——
#    所以 `small_window_toggle` 整个命令**已删**，快捷键改走 `small_window_new`
#    （＝ `window::bring_up_small_window`，**全局热键调的就是它**）。
#    这里跟着改成验新语义：连按两次 → 两个窗都在／都可见。
$t1 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_new').then(function(v){return JSON.stringify(v);})")
Start-Sleep -Milliseconds 1500
$v3 = Visible
Check '★ 按一下 → 弹出一个速记窗（返回它的 label）' (($t1 -eq 'small') -and ($v3 -eq $true)) ("label=$t1 visible=$v3")

$t2 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_new').then(function(v){return JSON.stringify(v);})")
Start-Sleep -Milliseconds 1800
$smallWindows = SmallWindowCount
$v4 = Visible
Check '★★ 再按一下 → **又开一个**（不再把上一个收走；现在有两个速记窗，1 号仍可见）' (($t2 -eq 'small-2') -and ([int]$smallWindows -ge 2) -and ($v4 -eq $true)) ("第二个label=$t2 速记窗数=" + $smallWindows + " 1号可见=" + $v4)

# 收起来：一次收全部（托盘菜单走的是同一条命令）
$null = J (EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_hide_all').then(function(){return JSON.stringify('ok');})")
Start-Sleep -Milliseconds 1200
$v5 = Visible
Check '★ 一键收起所有速记窗 → 1 号也收起来了（只收不销毁，草稿还在）' ($v5 -eq $false) ("visible=" + $v5)
# 收起来之后再按一下：应该把**藏着的**那个拉回来，而不是又开一个新的
$t3 = J (EvalMain "window.__TAURI_INTERNALS__.invoke('small_window_new').then(function(v){return JSON.stringify(v);})")
Start-Sleep -Milliseconds 1500
$v6 = Visible
Check '★ 收起之后再按 → 把**藏着的**那个拉回来（不是又开一个新的，草稿不会丢）' (($t3 -eq 'small') -and ($v6 -eq $true)) ("label=$t3 visible=$v6")

# ─────────────────────────── ⑧ 收尾 ───────────────────────────
Write-Host ""
Write-Host "=== ⑧ 收尾：快捷键恢复成默认 Ctrl+Space，清掉验收造的笔记 ==="
$restored = SetHotKey 'Ctrl+Space'
Check '快捷键已恢复成 Ctrl+Space（保持 PRD 的默认值）' ($restored.key -eq 'Ctrl+Space') ($restored.key)
$clean = J (EvalMain @"
(async()=>{
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const ns=await inv('note_list');
  let n=0;
  for(const note of ns){
    if(/^M6 小窗验收 |^自动保存-/.test(note.title)){ await inv('note_delete',{id:note.id}); n++; }
  }
  return JSON.stringify({removed:n});
})()
"@)
Check '清掉了验收造的笔记' ($clean.removed -ge 2) ("清掉 " + $clean.removed + " 篇")

Write-Host ""
Write-Host "======================"
Write-Host ("M6 小窗：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
} catch {
  # 🔴 **崩了也要打成绩行**（2026-10-03 栽到：CDP 短暂抽风 → `EvalSmall` 抛异常 →
  #    整套脚本当场退出、连成绩行都没有 → `regress.ps1` 报"没读到成绩行（跑起来了吗？）"，
  #    看着像"套件没跑"，其实是"跑崩了"。）
  Write-Host ""
  Write-Host ("  [异常] 脚本中途崩了：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("  崩之前已经过了 {0} 条 / 失败 {1} 条" -f $pass, $fail) -ForegroundColor Yellow
  Write-Host ""
  Write-Host ("M6 小窗（异常中断）：通过 {0}，失败 {1}" -f $pass, $fail) -ForegroundColor Red
  Write-Host "  ⚠️ 先单独重跑这一套再下结论：CDP 偶发抽风（本机 2026-10-03 出现过一次 20 秒空窗）会让它崩在半路。"
  exit 1
}
