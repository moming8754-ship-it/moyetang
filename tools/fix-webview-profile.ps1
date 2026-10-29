# 桌面版打不开时的一键急救（症状：双击后闪一下 / 事件日志 0xc0000409 /
# stderr 里 "failed to create webview: 0x800700AA 请求的资源在使用中"）。
#
# 原理：WebView2 的 profile 目录一旦坏掉，创建 webview 就失败；release 版 panic=abort
#       直接退出，坏目录没人清 → 之后每次启动都失败。把目录**改名**（不删）后，
#       下次启动会用全新 profile 自动重建，一次就活。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\fix-webview-profile.ps1
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'com.dongfangmoyetang.notes'
if (-not (Test-Path $base)) { Write-Output "没有 $base，跳过（没用过桌面版？）"; exit 0 }

Get-Process -EA 0 | Where-Object { $_.ProcessName -like '东方摩耶堂-桌面版-*' } | Stop-Process -Force
Start-Sleep -Milliseconds 800

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in @('EBWebView-Desktop-v2', 'webview')) {
  $dir = Join-Path $base $name
  if (Test-Path $dir) {
    Rename-Item $dir "$name.repair-$stamp"
    Write-Output "已改名：$name -> $name.repair-$stamp（数据没删，只是不再复用）"
  }
}
Remove-Item (Join-Path $base '.webview-starting') -Force -EA 0
Write-Output '完成。重新双击 东方摩耶堂-桌面版-v2.24.3-免安装.exe 即可。'