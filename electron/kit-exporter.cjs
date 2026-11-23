'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 180000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? error.message : ''
      });
    });
  });
}

function findNewestInstallerInDir(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return null;
    const files = fs.readdirSync(dirPath)
      .filter((f) => /^Esteban-Cloud-Setup-.*\.exe$/i.test(f))
      .map((f) => {
        const full = path.join(dirPath, f);
        return { full, name: f, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch {
    return null;
  }
}

function locateInstallerExe({ customPath, appRootDir, extraDirs = [] } = {}) {
  if (customPath && fs.existsSync(customPath) && fs.statSync(customPath).isFile()) {
    return {
      found: true,
      path: path.resolve(customPath),
      name: path.basename(customPath),
      size: fs.statSync(customPath).size
    };
  }

  const searchDirs = [
    appRootDir ? path.join(appRootDir, 'release') : null,
    path.join(os.homedir(), 'Esteban Nicola', 'Apps', 'MY APPS', 'Esteban Cloud', 'release'),
    path.join(os.homedir(), 'Downloads'),
    ...(Array.isArray(extraDirs) ? extraDirs : [])
  ].filter(Boolean);

  let best = null;
  for (const dir of searchDirs) {
    const hit = findNewestInstallerInDir(dir);
    if (hit && (!best || hit.mtime > best.mtime)) {
      best = hit;
    }
  }
  if (best) {
    return { found: true, path: best.full, name: best.name, size: best.size };
  }
  return { found: false, path: '', name: '', size: 0 };
}

function buildOneClickCmd(installerFileName) {
  const safeName = installerFileName || 'Esteban-Cloud-Setup.exe';
  return `@echo off
setlocal
title Esteban Cloud — Instalador Todo-en-Uno (Kit Pendrive)
set "KIT_DIR=%~dp0"
set "SETUP=%KIT_DIR%${safeName}"

echo ============================================================
echo   ESTEBAN CLOUD — Kit Pendrive Todo-en-Uno
echo   Hecho por Esteban Nicola - https://estebanico.com
echo ============================================================
echo.

if not exist "%SETUP%" (
    echo [ERROR] No se encontro el instalador: %SETUP%
    pause
    exit /b 1
)

echo [1/2] Instalando Esteban Cloud en este equipo...
"%SETUP%" /S
if errorlevel 1 (
    echo [AVISO] La instalacion silenciosa devolvio un codigo distinto de 0. Abriendo asistente normal...
    start "" /wait "%SETUP%"
) else (
    echo [OK] Esteban Cloud instalado correctamente.
)

echo.
set "INSTALLED_EXE=%LOCALAPPDATA%\\Programs\\Esteban Cloud\\Esteban Cloud.exe"
if exist "%INSTALLED_EXE%" (
    echo [2/2] Abriendo Esteban Cloud...
    start "" "%INSTALLED_EXE%"
    echo.
    echo Listo! Dentro de Esteban Cloud:
    echo   - Si aun no tienes Tailscale/rclone/WinFsp, pulsa "Instalador 1-clic".
    echo   - Para conectar con tu llave del pendrive, ve a "Conectar (Cliente)" -> "Buscar llaves en USB".
) else (
    echo [AVISO] No se encontro %INSTALLED_EXE%. Ejecuta manualmente %SETUP%.
)
echo.
pause
`;
}

function buildDepsCmd() {
  return `@echo off
setlocal
set "KIT_DIR=%~dp0"
set "PS1=%KIT_DIR%scripts\\install-dependencies.ps1"
set "LOG=%TEMP%\\esteban-cloud-install.log"

echo Solicitando permisos de Administrador (UAC) para instalar Tailscale, rclone, WinFsp y Firewall...
powershell.exe -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"%PS1%\\" -Port 4789 -LogPath \\"%LOG%\\"'"

echo.
if exist "%LOG%" (
    type "%LOG%"
) else (
    echo No se genero el registro. Verifica si aceptaste UAC.
)
echo.
pause
`;
}

function buildReadmeTxt({ appVersion, installerName, keyFileName, nodeName }) {
  return `ESTEBAN CLOUD — KIT PENDRIVE TODO-EN-UNO (v${appVersion || '0.1.2'})
Hecho por Esteban Nicola · https://estebanico.com
Exportado desde: ${nodeName || os.hostname()}
Fecha: ${new Date().toISOString()}

CONTENIDO DE ESTE PAQUETE
-------------------------
1. 1-INSTALAR-ESTEBAN-CLOUD.cmd    -> Doble clic para instalar y abrir Esteban Cloud en cualquier PC Windows.
2. 2-INSTALAR-DEPENDENCIAS-ADMIN.cmd -> Instala Tailscale, rclone, WinFsp y Firewall en 1 clic (con UAC).
3. ${installerName || '(Instalador Setup .exe)'} -> Instalador oficial local de Esteban Cloud.
4. scripts\\install-dependencies.ps1 -> Script PowerShell auditable de dependencias.
${keyFileName ? `5. ${keyFileName} -> Llave encriptada (requiere tu frase de paso secreta; nunca incluye la frase).\n` : ''}
COMO USARLO EN OTRA PC (CASA, TRABAJO O VIAJE)
----------------------------------------------
Paso 1: Conecta este pendrive y haz doble clic en "1-INSTALAR-ESTEBAN-CLOUD.cmd".
Paso 2: Si esa PC no tiene Tailscale/rclone/WinFsp, haz clic en "Instalador 1-clic" dentro de la app
        (o doble clic en "2-INSTALAR-DEPENDENCIAS-ADMIN.cmd") e inicia sesion en Tailscale.
Paso 3: En Esteban Cloud ve a "Conectar (Cliente)" -> pulsa "Buscar llaves en USB" -> ingresa tu frase de paso
        -> pulsa "Montar como disco Z:" o usa el explorador remoto integrado.

COMO USARLO EN ANDROID
----------------------
1. Instala Tailscale en Android e inicia sesion con tu cuenta.
2. Abre en Chrome la URL de Tailscale (o escanea el QR en Esteban Cloud) y carga el archivo .ecloudkey.
3. En Chrome toca el menu -> "Agregar a pantalla de inicio" para usar Esteban Cloud como app.

SEGURIDAD
---------
- El archivo .ecloudkey esta cifrado con PBKDF2-SHA256 + AES-256-GCM.
- Si pierdes este pendrive, abre Esteban Cloud en tu PC principal -> "Llaves y Pendrive" -> "Revocar".
`;
}

async function exportPendriveKit({
  targetDir,
  installerPath,
  scriptsDir,
  appRootDir,
  extraInstallerDirs = [],
  appVersion,
  nodeName,
  keyFileName,
  keyBundleJson,
  createZip = false
}) {
  if (!targetDir) throw new Error('Debes elegir un pendrive o carpeta destino.');
  const installer = locateInstallerExe({ customPath: installerPath, appRootDir, extraDirs: extraInstallerDirs });
  if (!installer.found) {
    throw new Error('No se encontró el instalador Esteban-Cloud-Setup-*.exe. Selecciónalo manualmente o compílalo con npm run dist:win.');
  }

  const destRoot = path.resolve(targetDir);
  const kitFolderName = 'Esteban-Cloud-Kit';
  const kitDir = path.join(destRoot, kitFolderName);
  const kitScriptsDir = path.join(kitDir, 'scripts');

  fs.mkdirSync(kitScriptsDir, { recursive: true });

  const filesCreated = [];

  // 1. Copy Windows Setup installer
  const destInstaller = path.join(kitDir, installer.name);
  fs.copyFileSync(installer.path, destInstaller);
  filesCreated.push(destInstaller);

  // 2. Copy PowerShell dependency scripts
  if (scriptsDir && fs.existsSync(scriptsDir)) {
    for (const entry of fs.readdirSync(scriptsDir)) {
      const src = path.join(scriptsDir, entry);
      if (fs.statSync(src).isFile()) {
        const dst = path.join(kitScriptsDir, entry);
        fs.copyFileSync(src, dst);
        filesCreated.push(dst);
      }
    }
  }

  // 3. Write 1-click launcher scripts
  const cmd1 = path.join(kitDir, '1-INSTALAR-ESTEBAN-CLOUD.cmd');
  fs.writeFileSync(cmd1, buildOneClickCmd(installer.name), 'utf8');
  filesCreated.push(cmd1);

  const cmd2 = path.join(kitDir, '2-INSTALAR-DEPENDENCIAS-ADMIN.cmd');
  fs.writeFileSync(cmd2, buildDepsCmd(), 'utf8');
  filesCreated.push(cmd2);

  // 4. Optional encrypted key bundle (.ecloudkey)
  let savedKeyName = '';
  if (keyBundleJson) {
    savedKeyName = path.basename(String(keyFileName || 'llave.ecloudkey'));
    const keyDest = path.join(kitDir, savedKeyName);
    fs.writeFileSync(keyDest, keyBundleJson, 'utf8');
    filesCreated.push(keyDest);
  }

  // 5. Write clear README
  const readmePath = path.join(kitDir, 'LEEME-PENDRIVE.txt');
  fs.writeFileSync(readmePath, buildReadmeTxt({
    appVersion,
    installerName: installer.name,
    keyFileName: savedKeyName,
    nodeName
  }), 'utf8');
  filesCreated.push(readmePath);

  // 6. Optional single-file .zip archive
  let zipPath = '';
  if (createZip) {
    zipPath = path.join(destRoot, `Esteban-Cloud-Kit-v${appVersion || '0.1.2'}.zip`);
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
    const ps = `Compress-Archive -Path '${kitDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    const res = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps]);
    if (!res.ok) {
      throw new Error(`La carpeta del kit se creó en ${kitDir}, pero falló al comprimir ZIP: ${res.stderr || res.error}`);
    }
    filesCreated.push(zipPath);
  }

  return {
    kitDir,
    zipPath,
    installerName: installer.name,
    installerSize: installer.size,
    keyIncluded: Boolean(savedKeyName),
    keyFileName: savedKeyName,
    filesCreated
  };
}

module.exports = {
  locateInstallerExe,
  exportPendriveKit
};
