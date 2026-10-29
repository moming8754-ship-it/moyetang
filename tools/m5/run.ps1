# 跑一个 M4 验收步骤：把 _helpers.js 和步骤 .js 拼起来，交给 CDP 在页面里跑
#
# 用法：
#   powershell -File tools\m4\run.ps1 -Step 02-选中出三图标.js
#   powershell -File tools\m4\run.ps1 -List
#
# 为什么要拼 _helpers.js：每个步骤都要"派发真实指针事件 / 合成键盘 / 等元素出现"，
# 抄 14 遍太长。拼接后两段在**同一个 eval** 里，步骤能直接用上面的 const/function。
param(
  [string]$Step = '',
  [switch]$List
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # …\notes-app\tools\m4
$cdp = Join-Path (Split-Path -Parent $here) "cdp.ps1"        # …\notes-app\tools\cdp.ps1

if ($List) {
  Get-ChildItem $here -Filter '*.js' | Where-Object { $_.Name -ne '_helpers.js' } |
    Sort-Object Name | ForEach-Object { Write-Host $_.Name }
  exit 0
}
if (-not $Step) { throw "缺少 -Step（用 -List 看有哪些步骤）" }

$file = Join-Path $here $Step
if (-not (Test-Path $file)) { throw "找不到步骤文件：$file" }

# ⚠️ 不能把多行 JS 直接写进命令行：powershell -File 会把引号/空格拆得乱七八糟
# （试过：报 "Cannot convert value / to type System.Int32"）。从文件读成字符串、
# 再用变量传给 -Expr 才稳。另外本文件带 BOM —— 中文注释不带 BOM 会被 PS 5.1 读成 GB2312。
$helpers = Get-Content -Raw -Encoding UTF8 (Join-Path $here '_helpers.js')
$body = (Get-Content -Raw -Encoding UTF8 $file).TrimEnd()
# 步骤文件本身就是 `(async () => { … })();`，最后的那个分号要去掉才能当表达式用
if ($body.EndsWith(';')) { $body = $body.Substring(0, $body.Length - 1) }

# ⚠️ 必须包一层函数：CDP 的 `Runtime.evaluate` 跑在**页面全局作用域**里，
# 而 `_helpers.js` 里全是顶层 `const $` / `const $$`。第一次跑完这些就留在了全局，
# 第二次再跑同一段就报 `SyntaxError: Identifier '$' has already been declared`。
# 包进 IIFE 后所有声明都是函数作用域的，反复跑互不干扰。
$js = "(function(){`n$helpers`nreturn ($body);`n})()"

# ⚠️ 这个拼好的脚本有十几 KB、几十行，**不能**从命令行传（`powershell -File` 会把长字符串
# 拆得乱七八糟，报 "Cannot process argument transformation on parameter ..."）。
# 落到临时文件再用 -ExprFile 交给 cdp.ps1；文件放 $env:TEMP（项目目录之外），
# 免得惊动 vite 的 watcher。
$tmp = Join-Path $env:TEMP ("m4-step-" + [guid]::NewGuid().ToString("N") + ".js")
[System.IO.File]::WriteAllText($tmp, $js, (New-Object System.Text.UTF8Encoding($false)))
try {
  # ⚠️ 必须显式点名主窗：小窗（`hide()` 只是隐藏、**不销毁**）也是一个 page target，
  #    不点名就可能整场跑在小窗上 —— 症状是每条断言都报"应用没起来：导航栏找不到"，
  #    看着像产品崩了，其实是连错窗口（2026-09-20 真撞上，白跑一轮回归）。
  & $cdp -Action eval -ExprFile $tmp -TargetTitle '东方摩耶堂' -RequireSelector 'nav'
}
finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
