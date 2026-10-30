param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$tooling = Join-Path $workspace ".tooling"
$jdkRoot = Join-Path $tooling "jdk17"
$gradleRoot = Join-Path $tooling "gradle-8.13"
$sdkRoot = Join-Path $workspace ".android-sdk"
$commandLineRoot = Join-Path $sdkRoot "cmdline-tools\latest"

New-Item -ItemType Directory -Force -Path $tooling, $sdkRoot | Out-Null

function Get-AndExpandZip {
    param(
        [string]$Uri,
        [string]$Archive,
        [string]$Destination
    )
    if ($Force -or -not (Test-Path -LiteralPath $Destination)) {
        $temporary = "$Destination.extracting"
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $temporary | Out-Null
        Write-Host "Descargando $Uri"
        Invoke-WebRequest -Uri $Uri -OutFile $Archive -UseBasicParsing
        Expand-Archive -LiteralPath $Archive -DestinationPath $temporary -Force
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        Get-ChildItem -LiteralPath $temporary | ForEach-Object {
            Move-Item -LiteralPath $_.FullName -Destination $Destination -Force
        }
        Remove-Item -LiteralPath $temporary -Recurse -Force
        Remove-Item -LiteralPath $Archive -Force
    }
}

if ($Force -or -not (Test-Path -LiteralPath (Join-Path $jdkRoot "bin\java.exe"))) {
    $jdkArchive = Join-Path $tooling "jdk17.zip"
    $jdkExtract = Join-Path $tooling "jdk17-extract"
    if (Test-Path -LiteralPath $jdkRoot) { Remove-Item -LiteralPath $jdkRoot -Recurse -Force }
    Get-AndExpandZip `
        -Uri "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse" `
        -Archive $jdkArchive `
        -Destination $jdkExtract
    $actualJdk = Get-ChildItem -LiteralPath $jdkExtract -Directory | Select-Object -First 1
    Move-Item -LiteralPath $actualJdk.FullName -Destination $jdkRoot
    Remove-Item -LiteralPath $jdkExtract -Recurse -Force
}

if ($Force -or -not (Test-Path -LiteralPath (Join-Path $gradleRoot "bin\gradle.bat"))) {
    $gradleArchive = Join-Path $tooling "gradle.zip"
    $gradleExtract = Join-Path $tooling "gradle-extract"
    if (Test-Path -LiteralPath $gradleRoot) { Remove-Item -LiteralPath $gradleRoot -Recurse -Force }
    Get-AndExpandZip `
        -Uri "https://services.gradle.org/distributions/gradle-8.13-bin.zip" `
        -Archive $gradleArchive `
        -Destination $gradleExtract
    Move-Item -LiteralPath (Join-Path $gradleExtract "gradle-8.13") -Destination $gradleRoot
    Remove-Item -LiteralPath $gradleExtract -Recurse -Force
}

if ($Force -or -not (Test-Path -LiteralPath (Join-Path $commandLineRoot "bin\sdkmanager.bat"))) {
    $sdkArchive = Join-Path $tooling "android-command-line-tools.zip"
    $sdkExtract = Join-Path $tooling "android-tools-extract"
    if (Test-Path -LiteralPath $commandLineRoot) { Remove-Item -LiteralPath $commandLineRoot -Recurse -Force }
    Get-AndExpandZip `
        -Uri "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip" `
        -Archive $sdkArchive `
        -Destination $sdkExtract
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $commandLineRoot) | Out-Null
    Move-Item -LiteralPath (Join-Path $sdkExtract "cmdline-tools") -Destination $commandLineRoot
    Remove-Item -LiteralPath $sdkExtract -Recurse -Force
}

$env:JAVA_HOME = $jdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:Path = "$(Join-Path $jdkRoot 'bin');$(Join-Path $gradleRoot 'bin');$(Join-Path $commandLineRoot 'bin');$env:Path"

$sdkManager = Join-Path $commandLineRoot "bin\sdkmanager.bat"
$yes = (1..20 | ForEach-Object { "y" }) -join "`n"
$yes | & $sdkManager --sdk_root=$sdkRoot --licenses | Out-Null
& $sdkManager --sdk_root=$sdkRoot "platform-tools" "platforms;android-36" "build-tools;35.0.0"

$localProperties = "sdk.dir=$($sdkRoot.Replace('\', '\\'))`r`n"
Set-Content -LiteralPath (Join-Path $workspace "local.properties") -Value $localProperties -Encoding ASCII

Push-Location $workspace
try {
    & (Join-Path $gradleRoot "bin\gradle.bat") wrapper --gradle-version 8.13 --distribution-type bin
} finally {
    Pop-Location
}

Write-Host "Entorno Android listo. Ejecuta .\gradlew.bat assembleDebug"

