# 一键开工状态（把 8 次检查压成 1 次工具调用）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File D:\东方摩耶堂\notes-app\tools\check-state.ps1
#
# 为什么：每多一次工具调用，整段上下文都会重发一遍。AI 开工时把版本 / git / 端口 / 数据
# 拆成七八条命令，会白白多烧几倍 token。这里一次输出全部，只留摘要。

$ErrorActionPreference = "SilentlyContinue"
$data = "D:\东方摩耶堂"
$app = Join-Path $data "notes-app"
function Line($k, $v) { "{0,-10} {1}" -f $k, $v }

# ── 版本（四处） ─────────────────────────────
$v4 = @()
try { $v4 += (Get-Content (Join-Path $app "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $v4 += "?" }
try { $v4 += (Get-Content (Join-Path $app "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $v4 += "?" }
try { $v4 += ((Select-String -Path (Join-Path $app "src-tauri\Cargo.toml") -Pattern '^version\s*=' | Select-Object -First 1).Line -replace '.*"([^"]+)".*', '$1') } catch { $v4 += "?" }
try {
  $lock = [System.IO.File]::ReadAllText((Join-Path $app "src-tauri\Cargo.lock"))
  $v4 += [regex]::Match($lock, '(?s)\[\[package\]\]\r?\nname = "notes-app"\r?\nversion = "([^"]+)"').Groups[1].Value
} catch { $v4 += "?" }
Line "version" (($v4 -join " / ") + "  (" + (@($v4 | Select-Object -Unique).Count) + " 种)")

# ── git 三仓 ────────────────────────────────
foreach ($pair in @(@("code", (Join-Path $data "notes-app")), @("data", $data), @("docs", "D:\notes project"))) {
  $repo = $pair[1]
  $head = (& git -C $repo log -1 --format='%h %s' 2>$null | Out-String).Trim()
  if ($head.Length -gt 70) { $head = $head.Substring(0, 70) }
  $dirty = @(& git -C $repo status --porcelain 2>$null).Count
  Line ("git-" + $pair[0]) ("dirty=" + $dirty + "  " + $head)
}

# ── 端口 / 进程 ─────────────────────────────
$vite = "空闲"
try { $null = Invoke-WebRequest "http://localhost:1420/" -UseBasicParsing -TimeoutSec 2; $vite = "在跑" } catch { }
$cdp = "无监听"
if (netstat -ano | Select-String ':9222\s+.*LISTENING') { $cdp = "在听" }
Line "ports" ("1420=" + $vite + "  9222=" + $cdp)
Line "process" ("notes-app=" + @(Get-Process -Name notes-app).Count + " java=" + @(Get-Process -Name java).Count)

# ── 数据 ────────────────────────────────────
function J($path) { [System.IO.File]::ReadAllText($path) | ConvertFrom-Json }
try {
  $t = J (Join-Path $data "todos.json")
  $open = @($t.items | Where-Object { $_.status -eq "open" }).Count
  $todos = @($t.items).Count
} catch { $todos = "?"; $open = "?" }
$notes = @(Get-ChildItem (Join-Path $data "notes") -File -Filter *.json | Where-Object { $_.Name -notlike "*.bak" }).Count
$assets = @(Get-ChildItem (Join-Path $data "assets") -File).Count
$info = @(Get-Content (Join-Path $data "info.jsonl") -Encoding UTF8 | Where-Object { $_.Trim() }).Count
$trash = @(Get-ChildItem (Join-Path $data "notes\_trash") -File).Count
$archFiles = @(Get-ChildItem (Join-Path $data "notes\_archive") -File).Count
try { $archItems = @((J (Join-Path $data "archive.json")).items).Count } catch { $archItems = "?" }
try {
  $aw = J (Join-Path $data "awards.json")
  $awCount = @($aw.items).Count
  $awStamped = @($aw.items | Where-Object { $_.updatedAt }).Count
} catch { $awCount = "?"; $awStamped = "?" }
try { $lastSync = (J (Join-Path $data "sync\state.json")).lastSyncAt } catch { $lastSync = "?" }

Line "data" ("notes=" + $notes + " todos=" + $todos + "(open " + $open + ") assets=" + $assets + " info=" + $info)
Line "archive" ("items=" + $archItems + " files=" + $archFiles + " trash=" + $trash)
Line "awards" ($awCount.ToString() + " 条 / 带 updatedAt " + $awStamped)
Line "sync" ("lastSyncAt=" + $lastSync)

# ── 交付物 ──────────────────────────────────
$apk = @(Get-ChildItem $data -File -Filter "*v*.apk").Count
$exe = @(Get-ChildItem $data -File -Filter "*.exe").Count
Line "deliver" ("apk=" + $apk + "  desktop-exe=" + $exe)
