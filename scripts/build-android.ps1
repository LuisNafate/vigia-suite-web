param([switch]$Install)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$jdkRoot = Join-Path $workspace ".tooling\jdk17"
$gradle = Join-Path $workspace ".tooling\gradle-8.13\bin\gradle.bat"
$sdkRoot = Join-Path $workspace ".android-sdk"
$apk = Join-Path $workspace "app\build\outputs\apk\debug\app-debug.apk"

if (-not (Test-Path -LiteralPath $gradle) -or -not (Test-Path -LiteralPath (Join-Path $jdkRoot "bin\java.exe"))) {
    & (Join-Path $PSScriptRoot "bootstrap-android.ps1")
}

$env:JAVA_HOME = $jdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:Path = "$(Join-Path $jdkRoot 'bin');$(Join-Path $sdkRoot 'platform-tools');$env:Path"

Push-Location $workspace
try {
    & $gradle :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "La compilación Android falló." }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $apk)) { throw "No se generó el APK esperado." }
Write-Host "APK listo: $apk"

if ($Install) {
    $adb = Join-Path $sdkRoot "platform-tools\adb.exe"
    $deviceLines = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' })
    if ($deviceLines.Count -eq 0) {
        throw "No hay un celular autorizado por USB. Activa Depuración USB, conéctalo y acepta la autorización."
    }
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "Android rechazó la instalación del APK." }
    Write-Host "Vigía Suite instalada en el celular conectado."
}
