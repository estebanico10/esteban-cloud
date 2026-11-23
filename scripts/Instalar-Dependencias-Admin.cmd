@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install-dependencies.ps1"
set "LOG=%TEMP%\esteban-cloud-install.log"

echo Solicitando permisos de Administrador (UAC) para instalar dependencias de Esteban Cloud...
powershell.exe -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%PS1%\" -Port 4789 -LogPath \"%LOG%\"'"

echo.
if exist "%LOG%" (
    type "%LOG%"
) else (
    echo No se genero el registro. Verifica si aceptaste UAC.
)
echo.
pause
