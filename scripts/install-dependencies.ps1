param(
    [int]$Port = 4789,
    [switch]$InstallOpenSsh,
    [switch]$DisableSleepAC,
    [string]$LogPath = "$env:TEMP\esteban-cloud-install.log"
)

$ErrorActionPreference = 'Continue'

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    if ($LogPath) {
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    }
}

if ($LogPath) {
    Set-Content -Path $LogPath -Value "" -Encoding UTF8
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Log "ERROR: Este instalador requiere permisos de Administrador (UAC)."
    exit 1
}

Write-Log "Iniciando instalacion de dependencias para Esteban Cloud (puerto $Port)..."

function Ensure-WingetPackage {
    param([string]$Id, [string]$Label, [string]$CheckCmd, [string]$CheckPath)
    $already = $false
    if ($CheckCmd -and (Get-Command $CheckCmd -ErrorAction SilentlyContinue)) { $already = $true }
    if ($CheckPath -and (Test-Path $CheckPath)) { $already = $true }
    if ($already) {
        Write-Log "$Label ya esta instalado."
        return
    }
    Write-Log "Instalando $Label ($Id) via winget..."
    $out = & winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements 2>&1
    Write-Log ("winget ($Id) exit={0}" -f $LASTEXITCODE)
    foreach ($l in ($out | Select-Object -Last 6)) {
        if ($l) { Write-Log "  $l" }
    }
}

Ensure-WingetPackage -Id 'Tailscale.Tailscale' -Label 'Tailscale (tunel cifrado WireGuard)' -CheckCmd 'tailscale' -CheckPath 'C:\Program Files\Tailscale\tailscale.exe'
Ensure-WingetPackage -Id 'Rclone.Rclone' -Label 'rclone (montaje de unidades remotas)' -CheckCmd 'rclone'
Ensure-WingetPackage -Id 'WinFsp.WinFsp' -Label 'WinFsp (driver de disco virtual Windows)' -CheckPath 'C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll'

if ($InstallOpenSsh) {
    Write-Log "Verificando OpenSSH Server..."
    $sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
    if (-not $sshd) {
        Write-Log "Instalando capacidad Windows OpenSSH.Server..."
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    }
    $sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
    if ($sshd) {
        Set-Service -Name sshd -StartupType Automatic
        Start-Service -Name sshd
        Write-Log "OpenSSH Server (sshd) activo y en inicio automatico."
    }
}

Write-Log "Configurando regla de Firewall para Esteban Cloud (solo Tailscale 100.64.0.0/10 y redes privadas LAN)..."
$ruleName = "EstebanCloud-TCP-$Port"
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -Name $ruleName `
    -DisplayName "Esteban Cloud (Tailscale y LAN - TCP $Port)" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress @('100.64.0.0/10', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '127.0.0.1') `
    -Profile Any | Out-Null
Write-Log "Regla de Firewall '$ruleName' creada correctamente."

if ($DisableSleepAC) {
    Write-Log "Desactivando suspension automatica cuando la PC esta enchufada (AC)..."
    & powercfg /change standby-timeout-ac 0 | Out-Null
    Write-Log "Suspension automatica en corriente (AC) desactivada."
}

Write-Log "ESTEBAN_CLOUD_SETUP_OK"
