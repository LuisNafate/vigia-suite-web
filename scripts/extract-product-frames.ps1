param([Parameter(Mandatory=$true)][string]$InputVideo)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$output = Join-Path $workspace 'pc-lab\product-sequence'
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) { $ffmpeg = Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter ffmpeg.exe -Recurse -ErrorAction Stop | Select-Object -First 1 -ExpandProperty FullName }
if (-not (Test-Path -LiteralPath $InputVideo)) { throw "No existe el video: $InputVideo" }
$desktop = Join-Path $output 'desktop'; $mobile = Join-Path $output 'mobile'
New-Item -ItemType Directory -Force -Path $desktop,$mobile | Out-Null
& $ffmpeg -y -i $InputVideo -fps_mode passthrough -c:v libwebp -quality 80 -compression_level 6 (Join-Path $desktop 'frame-%04d.webp')
if ($LASTEXITCODE -ne 0) { throw 'Falló la secuencia de escritorio.' }
& $ffmpeg -y -i $InputVideo -vf 'scale=768:-2:flags=lanczos' -fps_mode passthrough -c:v libwebp -quality 76 -compression_level 6 (Join-Path $mobile 'frame-%04d.webp')
if ($LASTEXITCODE -ne 0) { throw 'Falló la secuencia móvil.' }
Write-Host "Secuencias creadas en $output"
