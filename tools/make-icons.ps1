# 东方摩耶堂 · 图标生成
# 约定：素材是矩形，必须「居中裁剪成正方形」；exe 图标固定=哥尔赞；运行时白天哥尔赞/夜晚美尔巴。
# 用法：powershell -File tools\make-icons.ps1
# ⚠️ 本文件必须保存为「UTF-8 with BOM」：本机 ANSI 是 GB2312，PowerShell 5.1 会把无 BOM 的 UTF-8 中文读成乱码并吃掉换行。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root       = Split-Path -Parent $PSScriptRoot          # notes-app\
$assetsRoot = Split-Path -Parent $root                  # D:\东方摩耶堂\
$iconSrcDir = Join-Path $root 'icon-src'                # 1024 方图（生成 ico 用）
$runtimeDir = Join-Path $root 'src-tauri\icons\runtime' # 256 方图（运行期切图标用，include_bytes! 内嵌）
$publicDir  = Join-Path $root 'public'                  # 前端界面 logo

foreach ($d in @($iconSrcDir, $runtimeDir, $publicDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function New-SquareIcon {
  param(
    [Parameter(Mandatory)][string]$Source,   # 源 jpg
    [Parameter(Mandatory)][string]$OutPath,  # 输出 png
    [Parameter(Mandatory)][int]   $Size      # 输出边长
  )
  $src = [System.Drawing.Image]::FromFile($Source)
  try {
    # 居中裁剪：取短边为正方形边长，各自居中
    $side = [Math]::Min($src.Width, $src.Height)
    $x = [int](($src.Width  - $side) / 2)
    $y = [int](($src.Height - $side) / 2)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $dest = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $srcRect = New-Object System.Drawing.Rectangle($x, $y, $side, $side)
        $g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $g.Dispose() }
      $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
    Write-Host ("  {0,-16} {1}x{2} (裁剪自 {3}x{4}) -> {5}" -f (Split-Path $Source -Leaf), $Size, $Size, $src.Width, $src.Height, (Split-Path $OutPath -Leaf))
  } finally { $src.Dispose() }
}

$dayJpg   = Join-Path $assetsRoot 'day.png'   # 白天 = 哥尔赞（exe 图标固定用它）
$nightJpg = Join-Path $assetsRoot 'night.png'   # 夜晚 = 美尔巴

foreach ($f in @($dayJpg, $nightJpg)) {
  if (-not (Test-Path $f)) { throw "缺少图标素材：$f" }
}

Write-Host '[1/3] 生成 1024 方图（供 tauri icon 出 exe 图标）'
New-SquareIcon -Source $dayJpg   -OutPath (Join-Path $iconSrcDir 'day.png')   -Size 1024
New-SquareIcon -Source $nightJpg -OutPath (Join-Path $iconSrcDir 'night.png') -Size 1024

Write-Host '[2/3] 生成 256 方图（运行期切换窗口/任务栏图标）'
New-SquareIcon -Source $dayJpg   -OutPath (Join-Path $runtimeDir 'day.png')   -Size 256
New-SquareIcon -Source $nightJpg -OutPath (Join-Path $runtimeDir 'night.png') -Size 256

Write-Host '[3/3] 生成界面 logo（前端）'
New-SquareIcon -Source $dayJpg   -OutPath (Join-Path $publicDir 'logo-day.png')   -Size 256
New-SquareIcon -Source $nightJpg -OutPath (Join-Path $publicDir 'logo-night.png') -Size 256

Write-Host '图标生成完成。'
