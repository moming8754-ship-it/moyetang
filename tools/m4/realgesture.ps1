# M4 · 真实鼠标手势验收（**不能用合成事件替代的那一半**）
#
# 为什么单独有这么一个脚本：
# M4 出过一个"整套 JS 脚本全绿、用户却完全用不了"的 bug ——
# **真实双击节点进不了编辑态**（`setPointerCapture` 把 click/dblclick 的目标改道到了画布容器）。
# 而 `tools/m4/*.js` 里的 `dblClick()` 是用 `dispatchEvent(new MouseEvent('dblclick'))`
# **直接派发到节点元素上**的：绕过了浏览器的命中测试、指针捕获和焦点处理，
# 于是节点自己的 `onDoubleClick` 照样触发 → 假绿灯。
#
# 所以：**手势类交互（双击 / 拖拽）必须用 `cdp.ps1 -Action mouse` 走真实输入验一遍。**
# 那才是"浏览器把事件送到谁手上"的真实答案。
#
# 用法（应用要以 CDP 端口起着）：
#   powershell -File tools\m4\realgesture.ps1
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path       # …\tools\m4
$tools = Split-Path -Parent $here                             # …\tools
$cdp = Join-Path $tools 'cdp.ps1'

# ⚠️ 这里用**子进程**调 cdp.ps1（不是 `& $cdp`）：
# 本脚本是被 `powershell -File` 用 Windows PowerShell 5.1 跑的，
# 而 5.1 下 `$out = & 别的.ps1` 对输出流的捕获行为跟 pwsh 7 不一样（实测捕到空值，
# 于是 JSON 解析出个空对象、count=0，白白排查一轮）。子进程走 stdout，最稳。
function Eval([string]$js) {
  # ⚠️ 多行 JS 走文件（-ExprFile），不走命令行：长字符串会被 `powershell -File` 拆坏。
  # 文件放 $env:TEMP（项目目录之外）——放进项目里会惊动 vite 的 watcher。
  $tmp = Join-Path $env:TEMP ("m4-realgesture-" + [guid]::NewGuid().ToString("N") + ".js")
  [System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
  try {
    # ⚠️ 空返回要重试：前端 HMR 触发**整页重载**时会瞬间销毁并重建执行上下文，
    #    这期间的 `Runtime.evaluate` 会返回 undefined —— 表现是"脚本什么都没说、
    #    下一步拿着空 JSON 说节点数=0"，看着像产品坏了，其实只是赶上了那一刻。
    for ($i = 0; $i -lt 3; $i++) {
      $out = & powershell -NoProfile -File $cdp -Action eval -ExprFile $tmp -Port $Port -RequireSelector 'nav' 2>&1
      $text = (($out | Out-String).Trim())
      if ($text) { return $text }
      Start-Sleep -Milliseconds 700
    }
    return ''
  }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
function Mouse([string]$selectorArg) {
  $out = & powershell -NoProfile -File $cdp -Action mouse -Selector $selectorArg -Port $Port -RequireSelector 'nav' 2>&1
  return (($out | Out-String).Trim())
}
function MouseAt([int]$x, [int]$y, [int]$clicks) {
  $out = & powershell -NoProfile -File $cdp -Action mouse -X $x -Y $y -Clicks $clicks -Port $Port -RequireSelector 'nav' 2>&1
  return (($out | Out-String).Trim())
}

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host ("  [v] {0}" -f $name) }
  else { $script:fail++; Write-Host ("  [X] {0}  ::  {1}" -f $name, $detail) }
}

# 按**文字**取节点，别按数组下标：`spots` 是按布局的阅读顺序（y 排序）来的，
# 布局一变下标指的东西就变了，脚本会"点错节点"却看不出来。
function SpotByText($spots, [string]$text) {
  foreach ($s in $spots) { if ($s.text -eq $text) { return $s } }
  return $null
}

Write-Host "=== 准备：进认知区、打开「M4 验收树」并铺一个最小结构 ==="
# ⚠️ 这个脚本**会重排那篇测试笔记**（只留「中心主题」+ 两个节点），这样每次跑都是确定的结构。
# 它动的是 `M4 验收树`（验收测试数据），不碰用户自己的笔记。
$NOTE_TITLE = 'M4 验收树'
$setup = @'
(async()=>{
  const sl=t=>new Promise(r=>setTimeout(r,t));
  const B=()=>Array.from(document.querySelectorAll('button'));
  const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a||{});
  const TITLE='__TITLE__';
  const cards=()=>Array.from(document.querySelectorAll('[data-node-id]'));

  // ── 1) 先把数据铺好（这一步不依赖界面）
  const notes=await inv('note_list');
  const note=notes.filter(n=>n.title===TITLE)[0];
  if(!note) return JSON.stringify({error:'\u627e\u4e0d\u5230\u6d4b\u8bd5\u7b14\u8bb0\uff1a'+TITLE});
  for(const child of (note.root.children||[])){
    await inv('note_tree_remove',{noteId:note.id,nodeId:child.id});
  }
  await inv('note_tree_add_child',{noteId:note.id,parentId:note.root.id,text:'\u624b\u52bfA'});
  await inv('note_tree_add_child',{noteId:note.id,parentId:note.root.id,text:'\u624b\u52bfB'});
  await inv('note_tree_ensure_root',{noteId:note.id});   // 幂等且会广播 → 界面重新拉数据

  // ── 2) 再确保界面停在"认知区 + 这篇笔记"的画布上（**带重试**）
  //
  // ⚠️ 别假设点一次就到位：改前端源码时 vite 的 HMR 有时会**整页重载**，
  // 而 `view` 是 Zustand 的内存状态，一重载就回首页 —— 表现就是
  // "脚本明明点了导航，读 DOM 时却一个节点都没有"（这坑骗过一次）。
  // 所以循环重试到画布真的出现为止。
  //
  // ⚠️⚠️ 判断条件必须是"**画布上是这篇笔记**"，不能是"画布上有节点"：
  //    2026-09-20 踩到了 —— 上一套脚本（`14-长文字不截断.js`）结束时把界面留在了
  //    它自己的长文字笔记上，画布上**明明有 20 个节点**，于是这个循环一次都没进、
  //    导航也没点，接着按文字找「手势A」自然找不到，报的却是"节点不在"。
  //    现在改成：**画布上出现「手势A」**才算就位。
  const searchBox=document.querySelector('input[placeholder^="搜索标题"]');
  if(searchBox && searchBox.value){
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(searchBox,'');
    searchBox.dispatchEvent(new Event('input',{bubbles:true}));
    await sl(500);
  }
  const hasTarget=()=>cards().some(c=>c.getAttribute('data-node-text')==='\u624b\u52bfA');
  let tries=0;
  while(!hasTarget() && tries<10){
    tries++;
    // 侧边栏"收起"时导航文字挪到了 title 上，两种都要试
    const nav=B().find(b=>(b.innerText||'').indexOf('\u8ba4\u77e5\u533a')>=0||b.getAttribute('title')==='\u8ba4\u77e5\u533a');
    if(nav){ nav.click(); await sl(900); }
    const li=B().filter(b=>(b.innerText||'').indexOf(TITLE)>=0)[0];
    if(li){ li.click(); await sl(900); }
    else { await sl(600); }
  }

  // ⚠️ 拖拽/双击之前必须把视口**归位**（点右下角那个 ⌖）。
  //
  // 坑在哪：画布的**缩放和平移是跨笔记保留的**。上一次跑完要是留在"缩小 + 平移"的状态，
  // 节点可能被画布容器的 `overflow-hidden` 裁到可视区外 —— 这时
  // `getBoundingClientRect()` 照样给得出一个"看着合理"的坐标，但真实鼠标事件
  // 打在那个点上已经落在画布外面了，于是拖拽**静默失效**。
  // M5 验收时真踩到了：目标节点算出来 y=244，而画布可视区是从 250 开始的。
  const fit=Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('title')||'').indexOf('回到 1:1')>=0);
  if(fit){ fit.click(); await sl(900); }

  const spots=cards().map(c=>{const r=c.getBoundingClientRect();return {id:c.getAttribute('data-node-id'),text:c.getAttribute('data-node-text'),x:Math.round(r.left+r.width/2),y:Math.round(r.top+14)};});
  return JSON.stringify({count:spots.length,spots,tries,当前页:document.body.innerText.slice(20,46).replace(/\n/g,'|')});
})()
'@
$setup = $setup.Replace('__TITLE__', $NOTE_TITLE)
$raw = Eval $setup
Write-Host ("  [调试] 准备阶段返回：" + $raw.Substring(0, [Math]::Min(400, $raw.Length)))
$info = $raw | ConvertFrom-Json
Check '画布起来了（铺好最小结构）' ($info.count -ge 3) ("节点数=$($info.count)")
if ($info.count -lt 3) { Write-Host "没铺好结构，先看看上面的调试输出"; exit 1 }

Write-Host ""
Write-Host "=== ① 真实双击 → 进编辑态（这就是当初那个 bug） ==="
$n1 = SpotByText $info.spots '手势A'
Check '按文字找到了「手势A」' ($null -ne $n1) (($info.spots | ForEach-Object { $_.text }) -join ' | ')
# 先确保没有残留编辑框
[void](Eval "(async()=>{const ta=document.querySelector('[data-tree-canvas] textarea'); if(ta){ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));} await new Promise(r=>setTimeout(r,700)); return 'ok';})()")
[void](MouseAt $n1.x $n1.y 2)
Start-Sleep -Milliseconds 900
$r1 = Eval "var ta=document.querySelector('[data-tree-canvas] textarea'); JSON.stringify({open:!!ta,value:ta&&ta.value,focused:document.activeElement===ta})" | ConvertFrom-Json
Check '真实双击节点 → 出现编辑框' $r1.open ("点=$($n1.x),$($n1.y)")
Check '编辑框里是原来的文字' ($r1.value -eq $n1.text) ("期望「$($n1.text)」，实际「$($r1.value)」")
Check '编辑框拿到了焦点' $r1.focused

Write-Host ""
Write-Host "=== ② 真实双击另一个节点（换一个位置再验一次） ==="
[void](Eval "(async()=>{const ta=document.querySelector('[data-tree-canvas] textarea'); if(ta){ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));} await new Promise(r=>setTimeout(r,700)); return 'ok';})()")
$n2 = SpotByText $info.spots '中心主题'
[void](MouseAt $n2.x $n2.y 2)
Start-Sleep -Milliseconds 900
$r2 = Eval "JSON.stringify({open:!!document.querySelector('[data-tree-canvas] textarea')})" | ConvertFrom-Json
Check '第一个节点也能双击编辑' $r2.open ("点=$($n2.x),$($n2.y)")
[void](Eval "(async()=>{const ta=document.querySelector('[data-tree-canvas] textarea'); if(ta){ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));} await new Promise(r=>setTimeout(r,700)); return 'ok';})()")

Write-Host ""
Write-Host "=== ③ 真实拖拽 → 调层级（把指针捕获挪到"开始拖"之后，拖也必须还能用） ==="
function ReadTree() {
  # 锁定「M4 验收树」这一篇：按 kind 取第一篇可能取到别的树笔记，前后对比就白比了
  $js = "window.__TAURI_INTERNALS__.invoke('note_list').then(function(ns){var n=ns.filter(function(x){return x.title==='M4 \u9a8c\u6536\u6811';})[0]; return window.__TAURI_INTERNALS__.invoke('note_get',{id:n.id}).then(function(g){return JSON.stringify(g.root);});})"
  return (Eval $js | Out-String).Trim()
}
$before = ReadTree
$src = SpotByText $info.spots '手势B'   # 拖它
$dst = SpotByText $info.spots '手势A'   # 拖到它的中间 → 落点是"变成它的子节点"
Check '按文字找到了「手势B」和「手势A」' ($null -ne $src -and $null -ne $dst) ("src=" + ($src.text) + " dst=" + ($dst.text))
# cdp.ps1 的拖拽走 -Selector/-ToSelector；uuid 以数字开头，CSS 里必须加引号
$sel = "[data-node-id='$($src.id)']"
$sel2 = "[data-node-id='$($dst.id)']"
$drag = & powershell -NoProfile -File $cdp -Action mouse -Selector $sel -ToSelector $sel2 -Port $Port -RequireSelector 'nav' 2>&1
Write-Host ("  " + (($drag | Out-String).Trim()))
Start-Sleep -Milliseconds 1200
$after = ReadTree
Check '真实拖拽没有把树弄坏' ($after.Length -gt 0 -and $after.StartsWith('{')) ("前 60 字：" + $after.Substring(0, [Math]::Min(60, $after.Length)))
$changed = ($before -ne $after)
Check '真实拖拽真的改变了层级' $changed ("结构变化=" + $changed)

# 拖完立刻撤销，确认真实手势也进了撤销栈、而且能还原
$undoJs = "(function(){var b=Array.from(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='\u21b6';})[0]; if(!b) return 'NO_BUTTON'; if(b.disabled) return 'DISABLED'; b.click(); return 'CLICKED';})()"
$undoResult = (Eval $undoJs | Out-String).Trim()
Check '拖拽这一步进了撤销栈（↶ 可点）' ($undoResult -eq 'CLICKED') $undoResult
Start-Sleep -Milliseconds 1500
$restored = ReadTree
Check '撤销之后结构和拖之前一模一样' ($restored -eq $before) ("还原=" + ($restored -eq $before))

Write-Host ""
Write-Host "======================"
Write-Host ("真实手势：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
