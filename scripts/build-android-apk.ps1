#Requires -Version 5.1
<#
.SYNOPSIS
  Compila y firma el APK nativo de Android (Esteban-Cloud-<version>.apk)
  usando aapt2 + javac + d8 + zipalign + apksigner (Android SDK 34 + OpenJDK 17).
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AndroidAppDir = "$ProjectRoot\android-app"
$ReleaseDir = "$ProjectRoot\release"
New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null

$pkg = Get-Content "$ProjectRoot\package.json" -Raw | ConvertFrom-Json
$ver = $pkg.version

$toolsRoot = "$env:LOCALAPPDATA\EstebanCloudBuildTools"
$javac = (Get-ChildItem "$toolsRoot\jdk17" -Recurse -Filter "javac.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$java = (Get-ChildItem "$toolsRoot\jdk17" -Recurse -Filter "java.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$keytool = (Get-ChildItem "$toolsRoot\jdk17" -Recurse -Filter "keytool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$aapt2 = (Get-ChildItem "$toolsRoot\build-tools" -Recurse -Filter "aapt2.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$zipalign = (Get-ChildItem "$toolsRoot\build-tools" -Recurse -Filter "zipalign.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$d8Jar = (Get-ChildItem "$toolsRoot\build-tools" -Recurse -Filter "d8.jar" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$apksignerJar = (Get-ChildItem "$toolsRoot\build-tools" -Recurse -Filter "apksigner.jar" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$androidJar = (Get-ChildItem "$toolsRoot\platforms" -Recurse -Filter "android.jar" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName

if (-not ($javac -and $aapt2 -and $d8Jar -and $apksignerJar -and $androidJar)) {
  throw "Faltan herramientas de compilación Android en $toolsRoot."
}

$buildWork = "$toolsRoot\apk-build-work"
Remove-Item -Recurse -Force $buildWork -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$buildWork\compiled_res", "$buildWork\gen", "$buildWork\classes", "$buildWork\dex" -Force | Out-Null

Write-Host "[APK 1/5] Compilando recursos Android con aapt2..." -ForegroundColor Cyan
$resFiles = Get-ChildItem "$AndroidAppDir\res" -Recurse -File
foreach ($rf in $resFiles) {
  & $aapt2 compile $rf.FullName -o "$buildWork\compiled_res"
  if ($LASTEXITCODE -ne 0) { throw "aapt2 compile falló en $($rf.FullName)" }
}

$flatFiles = (Get-ChildItem "$buildWork\compiled_res" -Filter "*.flat").FullName
$linkArgs = @(
  "link",
  "-o", "$buildWork\unaligned.apk",
  "-I", $androidJar,
  "--manifest", "$AndroidAppDir\AndroidManifest.xml",
  "--java", "$buildWork\gen",
  "-A", "$AndroidAppDir\assets",
  "--min-sdk-version", "24",
  "--target-sdk-version", "34",
  "--version-code", "5",
  "--version-name", $ver,
  "--auto-add-overlay"
) + $flatFiles

& $aapt2 @linkArgs
if ($LASTEXITCODE -ne 0) { throw "aapt2 link falló." }

Write-Host "[APK 2/5] Compilando código Java con javac (OpenJDK 17)..." -ForegroundColor Cyan
$javaSources = @((Get-ChildItem "$AndroidAppDir\src" -Recurse -Filter "*.java").FullName) + @((Get-ChildItem "$buildWork\gen" -Recurse -Filter "*.java").FullName)
& $javac -source 1.8 -target 1.8 -encoding UTF-8 -bootclasspath $androidJar -classpath $androidJar -d "$buildWork\classes" @javaSources
if ($LASTEXITCODE -ne 0) { throw "javac falló." }

Write-Host "[APK 3/5] Generando bytecode Dalvik (classes.dex) con d8..." -ForegroundColor Cyan
$classFiles = (Get-ChildItem "$buildWork\classes" -Recurse -Filter "*.class").FullName
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 24 --output "$buildWork\dex" @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 falló." }

# Insert classes.dex into unaligned.apk using JDK jar.exe
$jarExe = (Get-ChildItem "$toolsRoot\jdk17" -Recurse -Filter "jar.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
& $jarExe uf "$buildWork\unaligned.apk" -C "$buildWork\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar uf classes.dex falló." }

Write-Host "[APK 4/5] Alineando APK con zipalign..." -ForegroundColor Cyan
& $zipalign -f -p 4 "$buildWork\unaligned.apk" "$buildWork\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign falló." }

Write-Host "[APK 5/5] Firmando APK (v1 + v2 + v3) con apksigner..." -ForegroundColor Cyan
$keystore = "$toolsRoot\esteban-cloud-release.jks"
$ksPass = "EstebanCloud2026!"
if (-not (Test-Path $keystore)) {
  & $keytool -genkeypair -v -keystore $keystore -alias estebancloud -keyalg RSA -keysize 2048 -validity 10000 -storepass $ksPass -keypass $ksPass -dname "CN=Esteban Nicola, OU=Esteban Cloud, O=estebanico.com, L=Quito, C=EC"
}

$finalApk = "$ReleaseDir\Esteban-Cloud-$ver.apk"
$latestAliasApk = "$ReleaseDir\Esteban-Cloud.apk"
& $java -jar $apksignerJar sign --ks $keystore --ks-key-alias estebancloud --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --out $finalApk "$buildWork\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner sign falló." }

& $java -jar $apksignerJar verify --verbose $finalApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify falló." }

Copy-Item $finalApk $latestAliasApk -Force
$apkSha = (Get-FileHash $finalApk -Algorithm SHA256).Hash
$apkSize = (Get-Item $finalApk).Length
Write-Host "APK_BUILD_OK PATH=$finalApk SIZE=$apkSize SHA256=$apkSha" -ForegroundColor Green
