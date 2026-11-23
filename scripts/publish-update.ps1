#Requires -Version 5.1
<#
.SYNOPSIS
  Pipeline 100% automatizado para probar, compilar, instalar, sincronizar en USB (E:/F:),
  publicar en GitHub Releases (estebanico10/esteban-cloud) y notificar a la malla Tailscale.
#>
param(
  [switch]$SkipGitPush
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$pkg = Get-Content "$ProjectRoot\package.json" -Raw | ConvertFrom-Json
$ver = $pkg.version
Write-Host "=== [1/6] Ejecutando pruebas automatizadas (v$ver) ===" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw "Las pruebas fallaron." }

Write-Host "=== [2/6] Compilando instalador NSIS Esteban-Cloud-Setup-$ver.exe ===" -ForegroundColor Cyan
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw "La compilación falló." }

$exePath = "$ProjectRoot\release\Esteban-Cloud-Setup-$ver.exe"
$sumsPath = "$ProjectRoot\release\SHA256SUMS.txt"
if (-not (Test-Path $exePath)) { throw "No se encontró $exePath" }

$sha = (Get-FileHash $exePath -Algorithm SHA256).Hash
"$sha  Esteban-Cloud-Setup-$ver.exe" | Set-Content -Path $sumsPath -Encoding ascii
Get-ChildItem "$ProjectRoot\release\Esteban-Cloud-Setup-*.exe*" | Where-Object { $_.Name -notlike "*$ver*" } | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Compilado OK: SHA-256 = $sha" -ForegroundColor Green

Write-Host "=== [3/6] Instalando silenciosamente v$ver en este equipo ===" -ForegroundColor Cyan
Get-Process -Name "Esteban Cloud" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$proc = Start-Process -FilePath $exePath -ArgumentList "/S" -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "El instalador devolvió código $($proc.ExitCode)" }

Write-Host "=== [4/6] Sincronizando E:\CODE\ESTEBAN CLOUD y Kits USB (E:, F:) ===" -ForegroundColor Cyan
if (Test-Path "E:\CODE\ESTEBAN CLOUD") {
  robocopy $ProjectRoot "E:\CODE\ESTEBAN CLOUD" /MIR /XD node_modules dist release .git /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  New-Item -ItemType Directory -Path "E:\CODE\ESTEBAN CLOUD\release" -Force | Out-Null
  Get-ChildItem "E:\CODE\ESTEBAN CLOUD\release\Esteban-Cloud-Setup-*.exe*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "*$ver*" } | Remove-Item -Force -ErrorAction SilentlyContinue
  Copy-Item $exePath "E:\CODE\ESTEBAN CLOUD\release\Esteban-Cloud-Setup-$ver.exe" -Force
  Copy-Item $sumsPath "E:\CODE\ESTEBAN CLOUD\release\SHA256SUMS.txt" -Force
}

foreach ($kitRoot in @("E:\Esteban-Cloud-Kit", "F:\Esteban-Cloud-Kit")) {
  if (Test-Path $kitRoot) {
    Get-ChildItem "$kitRoot\Esteban-Cloud-Setup-*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "*$ver*" } | Remove-Item -Force -ErrorAction SilentlyContinue
    Copy-Item $exePath "$kitRoot\Esteban-Cloud-Setup-$ver.exe" -Force
    $cmdPath = "$kitRoot\1-INSTALAR-ESTEBAN-CLOUD.cmd"
    if (Test-Path $cmdPath) {
      $cmdContent = (Get-Content $cmdPath -Raw) -replace 'Esteban-Cloud-Setup-\d+\.\d+\.\d+\.exe', "Esteban-Cloud-Setup-$ver.exe"
      Set-Content -Path $cmdPath -Value $cmdContent -Encoding ascii
    }
    Write-Host "Kit sincronizado: $kitRoot" -ForegroundColor Green
  }
}

if (-not $SkipGitPush) {
  Write-Host "=== [5/6] Subiendo a GitHub y publicando Release v$ver ===" -ForegroundColor Cyan
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  git add -A
  $status = git status --porcelain
  if ($status) {
    git commit -m "release: Esteban Cloud v$ver (actualizacion automatizada)"
  }
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push falló." }

  $notes = @"
## Esteban Cloud v$ver

Actualización automática publicada por **Esteban Nicola** ([estebanico.com](https://estebanico.com)).

### Verificación SHA-256
- ``Esteban-Cloud-Setup-$ver.exe``: ``SHA-256: $sha``
"@
  gh release view "v$ver" >$null 2>&1
  if ($LASTEXITCODE -eq 0) {
    gh release upload "v$ver" $exePath $sumsPath --clobber
  } else {
    gh release create "v$ver" $exePath $sumsPath --title "Esteban Cloud v$ver" --notes $notes --latest
  }
  if ($LASTEXITCODE -ne 0) { throw "gh release falló." }
  $ErrorActionPreference = $prevEap
}

Write-Host "=== [6/6] Iniciando Esteban Cloud v$ver y anunciando en la malla Tailscale ===" -ForegroundColor Cyan
$lnk = "$env:USERPROFILE\Desktop\Esteban Cloud.lnk"
if (Test-Path $lnk) {
  Start-Process explorer.exe -ArgumentList "`"$lnk`""
} else {
  Start-Process "$env:LOCALAPPDATA\Programs\Esteban Cloud\Esteban Cloud.exe"
}
Write-Host "Despliegue automatizado v$ver completado con éxito." -ForegroundColor Green
