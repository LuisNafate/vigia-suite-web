param(
    [int]$Port = 4173,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $workspace "pc-lab"
$firmwareSketch = Join-Path $workspace "firmware\arduino\VigiaSensor"
$firmwareBuild = Join-Path $workspace "build\firmware"
$firmwareWork = Join-Path $workspace "build\arduino-work-final"
$arduinoCli = Join-Path $env:LOCALAPPDATA "Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$esp32PackageRoot = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\hardware\esp32"
$esp32Libraries = (Get-ChildItem -LiteralPath $esp32PackageRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1 |
    ForEach-Object { Join-Path $_.FullName "libraries" })
$firmwareBoard = "esp32:esp32:esp32:PartitionScheme=huge_app"
$listener = [System.Net.HttpListener]::new()
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

function Get-VigiaDevices {
    @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FriendlyName -match '\((COM\d+)\)' -and
            ($_.InstanceId -match 'VID_10C4&PID_EA60|VID_1A86&PID_7523|VID_1A86&PID_55D4|VID_303A')
        } |
        ForEach-Object {
            [pscustomobject]@{
                port = [regex]::Match($_.FriendlyName, '\((COM\d+)\)').Groups[1].Value
                name = $_.FriendlyName
                instanceId = $_.InstanceId
            }
        })
}

function Send-JsonResponse {
    param($Context, $Data, [int]$StatusCode = 200)
    $json = $Data | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = "application/json; charset=utf-8"
    $Context.Response.Headers["Cache-Control"] = "no-store"
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.OutputStream.Close()
}

function Invoke-FirmwareInstall {
    param([string]$SerialPort)
    if (-not (Test-Path -LiteralPath $arduinoCli)) {
        throw "No se encontró Arduino CLI. Instala o repara Arduino IDE 2."
    }
    if ($SerialPort -notmatch '^COM\d{1,3}$') {
        throw "El puerto solicitado no es válido."
    }
    $allowedPorts = @(Get-VigiaDevices | ForEach-Object port)
    if ($SerialPort -notin $allowedPorts) {
        throw "El puerto $SerialPort no corresponde a un ESP32 USB detectado."
    }

    New-Item -ItemType Directory -Force -Path $firmwareBuild | Out-Null
    $firmwareBinary = Join-Path $firmwareBuild "VigiaSensor.ino.bin"
    $latestSourceWrite = (Get-ChildItem -LiteralPath $firmwareSketch -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1).LastWriteTimeUtc
    $needsCompile = -not (Test-Path -LiteralPath $firmwareBinary) -or
        (Get-Item -LiteralPath $firmwareBinary).LastWriteTimeUtc -lt $latestSourceWrite

    if ($needsCompile) {
        $compileOutput = & $arduinoCli compile `
            --jobs 2 `
            --fqbn $firmwareBoard `
            --libraries $esp32Libraries `
            --build-path $firmwareWork `
            --output-dir $firmwareBuild `
            $firmwareSketch 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            throw "La compilación del firmware falló: $compileOutput"
        }
    }

    $uploadOutput = & $arduinoCli upload `
        --port $SerialPort `
        --fqbn $firmwareBoard `
        --input-dir $firmwareBuild `
        $firmwareSketch 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "La carga al ESP32 falló. Cierra el Monitor Serie de Arduino y vuelve a intentar. $uploadOutput"
    }
    return "Firmware Vigía Sensor 0.3 instalado correctamente en $SerialPort."
}

Write-Host "Vigía Suite disponible en $prefix"
Write-Host "Conecta el ESP32, pulsa Preparar ESP32 y después Conectar ESP32."
Write-Host "Presiona Ctrl+C para detenerlo."

if (-not $NoBrowser) {
    $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if (Test-Path -LiteralPath $edge) {
        Start-Process -FilePath $edge -ArgumentList $prefix
    } else {
        Start-Process $prefix
    }
}

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".js" = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".svg" = "image/svg+xml"
    ".png" = "image/png"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $requestPath = $context.Request.Url.AbsolutePath

        if ($requestPath -eq "/api/status" -and $context.Request.HttpMethod -eq "GET") {
            Send-JsonResponse $context ([pscustomobject]@{
                ok = $true
                devices = @(Get-VigiaDevices)
                firmware = "0.3.0"
                arduinoCli = (Test-Path -LiteralPath $arduinoCli)
            })
            continue
        }

        if ($requestPath -eq "/api/flash" -and $context.Request.HttpMethod -eq "POST") {
            try {
                $reader = [System.IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
                $payload = $reader.ReadToEnd() | ConvertFrom-Json
                $reader.Close()
                $message = Invoke-FirmwareInstall -SerialPort ([string]$payload.port)
                Send-JsonResponse $context ([pscustomobject]@{ ok = $true; message = $message })
            } catch {
                Send-JsonResponse $context ([pscustomobject]@{ ok = $false; message = $_.Exception.Message }) 500
            }
            continue
        }

        if ($context.Request.HttpMethod -ne "GET") {
            $context.Response.StatusCode = 405
            $context.Response.Close()
            continue
        }

        $relativePath = $requestPath.TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = "index.html" }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $webRoot $relativePath))
        $rootPath = [System.IO.Path]::GetFullPath($webRoot)

        if (-not $candidate.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $context.Response.StatusCode = 404
            $context.Response.Close()
            continue
        }

        $bytes = [System.IO.File]::ReadAllBytes($candidate)
        $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
        $contentType = $mimeTypes[$extension]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $context.Response.ContentType = $contentType
        $context.Response.Headers["Cache-Control"] = if ($extension -eq ".html") { "no-store" } else { "no-cache" }
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.OutputStream.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
