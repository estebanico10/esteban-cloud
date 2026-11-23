'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
const QRCode = require('qrcode');

const { ConfigStore } = require('./config-store.cjs');
const { generateKeyBundle, decryptKeyBundle } = require('./crypto-keys.cjs');
const { EstebanCloudServer } = require('./server.cjs');
const { checkEnvironment, MountManager, syncSshAuthorizedKeys, launchElevatedInstaller } = require('./system-tools.cjs');
const { locateInstallerExe, exportPendriveKit } = require('./kit-exporter.cjs');
const {
  compareSemver,
  findLatestLocalRelease,
  getDefaultUpdateDirs,
  fetchGitHubLatestRelease,
  selectBestUpdateCandidate,
  downloadFileWithProgress,
  buildSelfUpdateLauncherCmd
} = require('./updater.cjs');
const { ChatStore, detectMime } = require('./chat-store.cjs');
const {
  DEFAULT_THRESHOLDS,
  getLocalMetrics,
  runDiskSpeedBenchmark,
  aggregateGlobalMetrics
} = require('./metrics.cjs');

// Prevent duplicate instances competing for port 4789 (EADDRINUSE)
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateCheckInFlight = false;
let stagedUpdate = null; // { version, fileName, installerExe, sha256, sourceLabel }
const alertCooldowns = new Map(); // alertKey -> nextAllowedMs

const store = new ConfigStore();
const chatStore = new ChatStore();

function normalizeMetricsShape(m) {
  if (!m) return null;
  const disks = (m.disks || []).map((d) => ({
    ...d,
    drive: d.drive || d.deviceId || '',
    label: d.label !== undefined ? d.label : (d.volumeName || ''),
    fs: d.fs || d.fileSystem || ''
  }));
  const memory = m.memory || m.ram || { totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0 };
  return {
    ...m,
    memory,
    ram: memory,
    disks
  };
}

function sendWindowsNotification(title, body) {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body, icon: loadBrandNativeImage(64) });
    n.on('click', () => showWindow());
    n.show();
  } catch {
    // ignore OS notification error
  }
}

const server = new EstebanCloudServer(store, {
  onLog: (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:log', entry);
    }
  },
  onUpdateNotice: async ({ fromUrl }) => {
    await runAutoUpdateCycle({ priorityUrl: fromUrl, trigger: 'peer-push' });
  },
  chatStore,
  onChatEvent: (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:chatEvent', { ...evt, totalUnread: chatStore.getTotalUnread() });
    }
    if (evt && evt.type === 'incoming-message' && evt.message) {
      const preview = evt.message.text
        ? evt.message.text.slice(0, 90)
        : (evt.message.attachments && evt.message.attachments.length
          ? `Adjunto: ${evt.message.attachments[0].name}`
          : 'Nuevo mensaje');
      sendWindowsNotification(`Mensaje de ${evt.senderNode || 'Equipo remoto'}`, preview);
    }
  },
  getMetricsFn: async () => {
    const raw = await getLocalMetrics({ thresholds: store.data.metricThresholds || DEFAULT_THRESHOLDS });
    return normalizeMetricsShape(raw);
  }
});
const mountManager = new MountManager({
  onLog: (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:log', entry);
    }
  }
});

// Active unlocked client sessions kept ONLY in RAM
const clientSessions = new Map(); // sessionId -> { baseUrl, keyId, label, permissions, token, host, shares }

function getScriptsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts');
  }
  return path.join(__dirname, '..', 'scripts');
}

function loadBrandNativeImage(size) {
  try {
    const png = path.join(__dirname, '..', 'build', 'icon.png');
    if (fs.existsSync(png)) {
      const img = nativeImage.createFromBuffer(fs.readFileSync(png));
      if (!img.isEmpty()) {
        return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
      }
    }
  } catch {
    // Fallback below
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#0d1117"/>
    <path d="M8 22h15a5 5 0 0 0 .5-9.97A7 7 0 0 0 10.2 10.5 5.5 5.5 0 0 0 8 22z" fill="#38bdf8"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTrayIcon() {
  return loadBrandNativeImage(32);
}

function refreshTrayMenu() {
  if (!tray) return;
  const mountCount = mountManager.listMounts().length;
  tray.setToolTip(
    server.running
      ? `Esteban Cloud · Activo en puerto ${server.boundPort}`
      : 'Esteban Cloud · Servidor detenido'
  );
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Esteban Cloud', click: () => showWindow() },
    { label: server.running ? `● Servidor activo (puerto ${server.boundPort})` : '○ Servidor detenido', enabled: false },
    { label: `Unidades montadas: ${mountCount}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Salir por completo',
      click: async () => {
        isQuitting = true;
        await mountManager.unmountAll();
        await server.stop();
        app.quit();
      }
    }
  ]));
}

function setupTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  try { app.focus({ steal: true }); } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 650,
    center: true,
    show: true,
    backgroundColor: '#090d14',
    title: 'Esteban Cloud',
    icon: loadBrandNativeImage(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged && fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.data.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function httpJsonRequest(targetUrl, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : {}; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: json !== null ? json : raw });
        } else {
          reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Tiempo de espera agotado al conectar con el equipo remoto.')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resolveReachableBaseUrl(hostInfo, token, overrideBaseUrl) {
  const candidates = [];
  if (overrideBaseUrl) {
    const trimmed = String(overrideBaseUrl).trim().replace(/\/$/, '');
    if (!/^https?:\/\/.+/i.test(trimmed)) {
      throw new Error('La URL manual debe comenzar con http:// o https:// (o déjala vacía para detección automática por Tailscale).');
    }
    candidates.push(trimmed);
  } else {
    const port = Number(hostInfo.port) || 4789;
    if (hostInfo.tailscaleIp) candidates.push(`http://${hostInfo.tailscaleIp}:${port}`);
    if (hostInfo.tailscaleDns) candidates.push(`http://${hostInfo.tailscaleDns}:${port}`);
    if (hostInfo.lanIp) candidates.push(`http://${hostInfo.lanIp}:${port}`);
    candidates.push(`http://127.0.0.1:${port}`);
  }

  let lastErr = new Error('No se encontró dirección alcanzable en la llave.');
  for (const baseUrl of candidates) {
    try {
      const res = await httpJsonRequest(`${baseUrl}/api/shares`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4500
      });
      return { baseUrl, sharesResponse: res.data };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function buildFullState() {
  const env = await checkEnvironment();
  const cfg = store.getPublicConfig();
  const status = server.getStatus();
  const port = status.port || cfg.port || 4789;
  const tailscaleUrl = env.tailscale.ip ? `http://${env.tailscale.ip}:${port}` : '';
  const lanUrl = env.lanIp ? `http://${env.lanIp}:${port}` : '';

  let tailscaleQr = '';
  let lanQr = '';
  try {
    if (tailscaleUrl) tailscaleQr = await QRCode.toDataURL(tailscaleUrl, { margin: 1, width: 170, color: { dark: '#eef2f7', light: '#0d1117' } });
    if (lanUrl) lanQr = await QRCode.toDataURL(lanUrl, { margin: 1, width: 170, color: { dark: '#eef2f7', light: '#0d1117' } });
  } catch {
    // ignore QR failure
  }

  const usbInstallerDirs = [];
  for (const d of (env.usbDrives || [])) {
    usbInstallerDirs.push(d.root, path.join(d.root, 'Esteban-Cloud-Kit'), path.join(d.root, 'CODE', 'ESTEBAN CLOUD', 'release'));
  }
  const installerInfo = locateInstallerExe({ appRootDir: path.join(__dirname, '..'), extraDirs: usbInstallerDirs });
  const hostedUpdate = findLatestLocalRelease(getDefaultUpdateDirs(cfg.updateShareDir, path.join(__dirname, '..')));

  return {
    appVersion: app.getVersion(),
    config: cfg,
    server: status,
    env,
    installerInfo,
    hostedUpdate: hostedUpdate ? {
      version: hostedUpdate.version,
      fileName: hostedUpdate.fileName,
      size: hostedUpdate.size,
      sourceDir: hostedUpdate.sourceDir
    } : null,
    urls: { tailscaleUrl, lanUrl, tailscaleQr, lanQr },
    mounts: mountManager.listMounts(),
    totalUnread: chatStore.getTotalUnread(),
    activeClientSessions: Array.from(clientSessions.entries()).map(([id, s]) => ({
      sessionId: id,
      baseUrl: s.baseUrl,
      keyId: s.keyId,
      label: s.label,
      nodeName: s.nodeName,
      permissions: s.permissions,
      shares: s.shares
    }))
  };
}

function registerIpc() {
  ipcMain.handle('cloud:getState', async () => buildFullState());

  ipcMain.handle('cloud:updateSettings', async (_e, patch) => {
    const prevPort = store.data.port;
    const prevBind = store.data.bindMode;
    const updated = store.updateSettings(patch || {});

    if (patch && patch.startWithWindows !== undefined) {
      try {
        app.setLoginItemSettings({ openAtLogin: Boolean(patch.startWithWindows), args: ['--minimized'] });
      } catch {
        // Ignore in dev if unsupported
      }
    }

    if (server.running && (updated.port !== prevPort || updated.bindMode !== prevBind)) {
      await server.stop();
      const env = await checkEnvironment();
      const host = updated.bindMode === 'tailscale' && env.tailscale.ip ? env.tailscale.ip : '0.0.0.0';
      await server.start({ host, port: updated.port });
    }
    return buildFullState();
  });

  ipcMain.handle('cloud:startServer', async () => {
    const env = await checkEnvironment();
    const host = store.data.bindMode === 'tailscale' && env.tailscale.ip ? env.tailscale.ip : '0.0.0.0';
    await server.start({ host, port: store.data.port });
    refreshTrayMenu();
    return buildFullState();
  });

  ipcMain.handle('cloud:stopServer', async () => {
    await server.stop();
    refreshTrayMenu();
    return buildFullState();
  });

  ipcMain.handle('shares:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar carpeta para compartir',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('shares:add', async (_e, { name, folderPath, mode }) => {
    store.addShare({ name, folderPath, mode });
    return buildFullState();
  });

  ipcMain.handle('shares:update', async (_e, { id, patch }) => {
    store.updateShare(id, patch);
    return buildFullState();
  });

  ipcMain.handle('shares:remove', async (_e, id) => {
    store.removeShare(id);
    return buildFullState();
  });

  ipcMain.handle('shares:openLocal', async (_e, folderPath) => {
    if (folderPath && fs.existsSync(folderPath)) {
      await shell.openPath(folderPath);
    }
  });

  ipcMain.handle('keys:generate', async (_e, { label, permissions, shareIds, passphrase }) => {
    const env = await checkEnvironment();
    const hostInfo = {
      nodeName: store.data.nodeName,
      tailscaleIp: env.tailscale.ip,
      tailscaleDns: env.tailscale.dnsName,
      lanIp: env.lanIp,
      port: store.data.port,
      sshUser: env.userName
    };
    const result = generateKeyBundle({ label, permissions, shareIds, hostInfo, passphrase });
    store.addKeyRecord(result.hostRecord);
    const sshSync = syncSshAuthorizedKeys(store.data.keys);
    return {
      keyId: result.keyId,
      bundleJson: result.bundleJson,
      clipboardString: result.clipboardString,
      suggestedFileName: `${String(label || 'llave').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${result.keyId}.ecloudkey`,
      sshSync,
      state: await buildFullState()
    };
  });

  ipcMain.handle('keys:pickSaveFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir carpeta o pendrive donde guardar la llave encriptada',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('keys:saveToLocations', async (_e, { fileName, bundleJson, directories }) => {
    const cleanName = path.basename(String(fileName || 'esteban-cloud.ecloudkey'));
    const saved = [];
    const errors = [];
    for (const dir of (directories || [])) {
      try {
        const destDir = path.resolve(dir);
        fs.mkdirSync(destDir, { recursive: true });
        const full = path.join(destDir, cleanName);
        fs.writeFileSync(full, bundleJson, 'utf8');
        saved.push(full);
      } catch (err) {
        errors.push({ dir, error: err.message });
      }
    }
    return { saved, errors };
  });

  ipcMain.handle('keys:copyText', async (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('keys:revoke', async (_e, keyId) => {
    store.revokeKey(keyId);
    syncSshAuthorizedKeys(store.data.keys);
    return buildFullState();
  });

  ipcMain.handle('keys:delete', async (_e, keyId) => {
    store.deleteKey(keyId);
    syncSshAuthorizedKeys(store.data.keys);
    return buildFullState();
  });

  // Client (bidirectional) operations
  ipcMain.handle('client:pickKeyFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar llave encriptada (.ecloudkey)',
      filters: [{ name: 'Llave Esteban Cloud', extensions: ['ecloudkey', 'json', 'txt'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf8');
    return { filePath, content };
  });

  ipcMain.handle('client:scanUsbKeys', async () => {
    const env = await checkEnvironment();
    const found = [];
    for (const d of env.usbDrives) {
      const scanDirs = [d.root, path.join(d.root, 'Esteban-Cloud-Kit')];
      for (const dir of scanDirs) {
        try {
          if (!fs.existsSync(dir)) continue;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.ecloudkey')) {
              found.push({ drive: d.drive, label: d.label, fileName: e.name, filePath: path.join(dir, e.name) });
            }
          }
        } catch {
          // ignore unreadable drive
        }
      }
    }
    return found;
  });

  ipcMain.handle('kit:pickInstaller', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar instalador Esteban-Cloud-Setup-*.exe',
      filters: [{ name: 'Instalador Windows', extensions: ['exe'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('kit:exportToPendrive', async (_e, { targetDir, installerPath, keyFileName, keyBundleJson, createZip }) => {
    const env = await checkEnvironment();
    const extraInstallerDirs = [];
    for (const d of (env.usbDrives || [])) {
      extraInstallerDirs.push(d.root, path.join(d.root, 'Esteban-Cloud-Kit'), path.join(d.root, 'CODE', 'ESTEBAN CLOUD', 'release'));
    }
    const res = await exportPendriveKit({
      targetDir,
      installerPath,
      scriptsDir: getScriptsDir(),
      appRootDir: path.join(__dirname, '..'),
      extraInstallerDirs,
      appVersion: app.getVersion(),
      nodeName: store.data.nodeName,
      keyFileName,
      keyBundleJson,
      createZip: Boolean(createZip)
    });
    return res;
  });

  ipcMain.handle('client:unlockAndConnect', async (_e, { bundleText, filePath, passphrase, overrideBaseUrl, saveBookmark }) => {
    let raw = bundleText;
    if (!raw && filePath) {
      raw = fs.readFileSync(filePath, 'utf8');
    }
    const payload = decryptKeyBundle(raw, passphrase);
    const { baseUrl, sharesResponse } = await resolveReachableBaseUrl(payload.host || {}, payload.token, overrideBaseUrl);
    const sessionId = `sess-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    clientSessions.set(sessionId, {
      baseUrl,
      keyId: payload.keyId,
      label: payload.label,
      nodeName: sharesResponse.nodeName || (payload.host && payload.host.nodeName) || 'Nodo remoto',
      permissions: (sharesResponse.key && sharesResponse.key.permissions) || payload.permissions,
      token: payload.token,
      host: payload.host || {},
      shares: sharesResponse.shares || []
    });

    if (saveBookmark) {
      store.savePeer({
        label: payload.label,
        nodeName: sharesResponse.nodeName || (payload.host && payload.host.nodeName),
        tailscaleIp: payload.host && payload.host.tailscaleIp,
        lanIp: payload.host && payload.host.lanIp,
        port: payload.host && payload.host.port,
        keyId: payload.keyId,
        keyFilePath: filePath || ''
      });
    }

    // Automatically check/push updates when connecting to a peer
    const newSess = clientSessions.get(sessionId);
    if (newSess) {
      runAutoUpdateCycle({ priorityUrl: newSess.baseUrl, trigger: 'peer-connect' }).catch(() => {});
      notifyPeerOfLocalUpdate(newSess).catch(() => {});
    }

    return {
      sessionId,
      session: {
        sessionId,
        baseUrl,
        keyId: payload.keyId,
        label: payload.label,
        nodeName: sharesResponse.nodeName || (payload.host && payload.host.nodeName) || 'Nodo remoto',
        permissions: (sharesResponse.key && sharesResponse.key.permissions) || payload.permissions,
        shares: sharesResponse.shares || []
      },
      state: await buildFullState()
    };
  });

  ipcMain.handle('client:disconnect', async (_e, sessionId) => {
    clientSessions.delete(sessionId);
    return buildFullState();
  });

  ipcMain.handle('client:listFiles', async (_e, { sessionId, shareId, relPath }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const q = `?share=${encodeURIComponent(shareId)}&path=${encodeURIComponent(relPath || '')}`;
    const res = await httpJsonRequest(`${sess.baseUrl}/api/files${q}`, {
      headers: { Authorization: `Bearer ${sess.token}` }
    });
    return res.data;
  });

  ipcMain.handle('client:mkdir', async (_e, { sessionId, shareId, relPath, name }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const res = await httpJsonRequest(`${sess.baseUrl}/api/mkdir`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ share: shareId, path: relPath || '', name })
    });
    return res.data;
  });

  ipcMain.handle('client:deleteItem', async (_e, { sessionId, shareId, relPath }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const q = `?share=${encodeURIComponent(shareId)}&path=${encodeURIComponent(relPath || '')}`;
    const res = await httpJsonRequest(`${sess.baseUrl}/api/file${q}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sess.token}` }
    });
    return res.data;
  });

  ipcMain.handle('client:downloadFile', async (_e, { sessionId, shareId, relPath, fileName }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar archivo descargado',
      defaultPath: fileName || path.basename(relPath)
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };
    const dest = saveRes.filePath;
    const u = new URL(`${sess.baseUrl}/api/download?share=${encodeURIComponent(shareId)}&path=${encodeURIComponent(relPath)}`);
    const lib = u.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = lib.request(u, { method: 'GET', headers: { Authorization: `Bearer ${sess.token}` } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    return { canceled: false, savedPath: dest };
  });

  ipcMain.handle('client:uploadFiles', async (_e, { sessionId, shareId, relPath }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivos para subir al equipo remoto',
      properties: ['openFile', 'multiSelections']
    });
    if (pick.canceled || !pick.filePaths.length) return { canceled: true, uploaded: [] };
    const uploaded = [];
    for (const filePath of pick.filePaths) {
      const name = path.basename(filePath);
      const u = new URL(`${sess.baseUrl}/api/upload?share=${encodeURIComponent(shareId)}&path=${encodeURIComponent(relPath || '')}&name=${encodeURIComponent(name)}`);
      const lib = u.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const req = lib.request(u, {
          method: 'POST',
          headers: { Authorization: `Bearer ${sess.token}` }
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve();
            else reject(new Error(`Error subiendo ${name}: HTTP ${res.statusCode}`));
          });
        });
        req.on('error', reject);
        fs.createReadStream(filePath).pipe(req);
      });
      uploaded.push(name);
    }
    return { canceled: false, uploaded };
  });

  ipcMain.handle('client:renameItem', async (_e, { sessionId, shareId, from, to }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const res = await httpJsonRequest(`${sess.baseUrl}/api/rename`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ share: shareId, from, to })
    });
    return res.data;
  });

  ipcMain.handle('client:mountDrive', async (_e, { sessionId, driveLetter }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const mounted = await mountManager.mountWebDav({
      driveLetter: driveLetter || 'Z:',
      label: `EstebanCloud-${sess.nodeName}`,
      baseUrl: sess.baseUrl,
      keyId: sess.keyId,
      token: sess.token
    });
    refreshTrayMenu();
    return { mounted, state: await buildFullState() };
  });

  ipcMain.handle('client:unmountDrive', async (_e, driveLetter) => {
    await mountManager.unmount(driveLetter);
    refreshTrayMenu();
    return buildFullState();
  });

  ipcMain.handle('system:launchTailscale', async () => {
    const candidates = [
      'C:\\Program Files\\Tailscale\\tailscale-ipn.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale-ipn.exe'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        await shell.openPath(c);
        return { ok: true };
      }
    }
    await shell.openExternal('https://tailscale.com/download/windows');
    return { ok: false };
  });

  ipcMain.handle('client:openDrive', async (_e, driveLetter) => {
    const p = driveLetter.endsWith('\\') ? driveLetter : `${driveLetter}\\`;
    await shell.openPath(p);
  });

  ipcMain.handle('client:removePeer', async (_e, id) => {
    store.removePeer(id);
    return buildFullState();
  });

  ipcMain.handle('system:installDependencies', async (_e, opts) => {
    const scriptPath = path.join(getScriptsDir(), 'install-dependencies.ps1');
    const res = await launchElevatedInstaller(scriptPath, {
      port: store.data.port,
      installOpenSsh: Boolean(opts && opts.installOpenSsh),
      disableSleep: Boolean(opts && opts.disableSleep)
    });
    return { ...res, state: await buildFullState() };
  });

  ipcMain.handle('system:openScriptsFolder', async () => {
    await shell.openPath(getScriptsDir());
  });

  ipcMain.handle('system:openExternal', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

async function checkUpdatesCore({ priorityUrl } = {}) {
  const currentVersion = app.getVersion();
  const repo = String(store.data.updateGithubRepo || 'estebanico10/esteban-cloud').trim() || 'estebanico10/esteban-cloud';
  const releaseUrl = `https://github.com/${repo}/releases`;
  const env = await checkEnvironment();

  const peerUrls = new Set();
  if (priorityUrl && /^https?:\/\//i.test(priorityUrl.trim())) {
    peerUrls.add(priorityUrl.trim().replace(/\/$/, ''));
  }
  if (store.data.updateServerUrl && /^https?:\/\//i.test(store.data.updateServerUrl.trim())) {
    peerUrls.add(store.data.updateServerUrl.trim().replace(/\/$/, ''));
  }
  for (const sess of clientSessions.values()) {
    if (sess.baseUrl) peerUrls.add(sess.baseUrl.replace(/\/$/, ''));
  }
  for (const p of (store.data.savedPeers || [])) {
    const port = Number(p.port) || 4789;
    if (p.tailscaleIp) peerUrls.add(`http://${p.tailscaleIp}:${port}`);
    if (p.lanIp) peerUrls.add(`http://${p.lanIp}:${port}`);
  }
  for (const tp of (env.tailscale.peers || [])) {
    if (tp.online && tp.ip && tp.os === 'windows') {
      peerUrls.add(`http://${tp.ip}:${store.data.port || 4789}`);
    }
  }

  const candidates = [];
  const checkedSources = [];

  const localLatest = findLatestLocalRelease(getDefaultUpdateDirs(store.data.updateShareDir, path.join(__dirname, '..')));
  if (localLatest) {
    const label = `Carpeta local (${localLatest.sourceDir})`;
    checkedSources.push(label);
    candidates.push({
      version: localLatest.version,
      fileName: localLatest.fileName,
      size: localLatest.size,
      sha256: localLatest.sha256,
      sourceType: 'local',
      sourceLabel: label,
      localPath: localLatest.fullPath,
      downloadUrl: '',
      releaseUrl
    });
  }

  const peerPromise = Promise.all(
    Array.from(peerUrls).map(async (baseUrl) => {
      try {
        const res = await httpJsonRequest(`${baseUrl}/api/updates/latest`, { timeout: 3500 });
        if (res.data && res.data.available && res.data.version) {
          return { baseUrl, info: res.data };
        }
      } catch {
        // peer offline or older version
      }
      return null;
    })
  );

  const githubPromise = store.data.enableGithubUpdates !== false
    ? fetchGitHubLatestRelease(repo, { timeout: 6500 }).catch(() => null)
    : Promise.resolve(null);

  const [peerChecks, ghRelease] = await Promise.all([peerPromise, githubPromise]);

  for (const hit of peerChecks.filter(Boolean)) {
    const label = `Equipo ${hit.info.hostNode || hit.baseUrl} (${hit.baseUrl})`;
    checkedSources.push(label);
    candidates.push({
      version: hit.info.version,
      fileName: hit.info.fileName,
      size: hit.info.size,
      sha256: hit.info.sha256,
      sourceType: 'peer',
      sourceLabel: label,
      localPath: '',
      downloadUrl: `${hit.baseUrl}${hit.info.downloadPath || '/api/updates/download'}`,
      releaseUrl
    });
  }

  if (ghRelease && ghRelease.version) {
    const label = `GitHub Releases (${repo})`;
    checkedSources.push(label);
    candidates.push({
      version: ghRelease.version,
      fileName: ghRelease.fileName,
      size: ghRelease.size,
      sha256: ghRelease.sha256,
      sourceType: 'github',
      sourceLabel: label,
      localPath: '',
      downloadUrl: ghRelease.downloadUrl,
      releaseUrl: ghRelease.htmlUrl || releaseUrl
    });
  }

  const bestCandidate = selectBestUpdateCandidate(candidates);
  if (bestCandidate) {
    const isNewer = compareSemver(bestCandidate.version, currentVersion) > 0;
    return {
      currentVersion,
      repo,
      releaseUrl: bestCandidate.releaseUrl || releaseUrl,
      status: isNewer ? 'update-available' : 'up-to-date',
      latestVersion: bestCandidate.version,
      sourceType: bestCandidate.sourceType,
      sourceLabel: bestCandidate.sourceLabel,
      fileName: bestCandidate.fileName,
      size: bestCandidate.size,
      sha256: bestCandidate.sha256,
      localPath: bestCandidate.localPath,
      downloadUrl: bestCandidate.downloadUrl,
      stagedPath: stagedUpdate && stagedUpdate.version === bestCandidate.version ? stagedUpdate.installerExe : '',
      checkedSources,
      message: isNewer
        ? `Nueva versión v${bestCandidate.version} disponible desde ${bestCandidate.sourceLabel}.`
        : `Tienes la versión más reciente (v${currentVersion}). Última publicada: v${bestCandidate.version} (${bestCandidate.sourceLabel}).`
    };
  }

  return {
    currentVersion,
    repo,
    releaseUrl,
    status: 'no-release',
    latestVersion: null,
    checkedSources,
    message: 'No se encontraron instaladores en GitHub Releases, equipos de Tailscale ni carpeta local.'
  };
}

async function applyInstallerAndRestart(installerExe) {
  const installedAppExe = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs',
    'Esteban Cloud',
    'Esteban Cloud.exe'
  );
  const updaterCmd = path.join(os.tmpdir(), `esteban-cloud-selfupdate-${Date.now()}.cmd`);
  fs.writeFileSync(updaterCmd, buildSelfUpdateLauncherCmd(installerExe, installedAppExe), 'utf8');

  isQuitting = true;
  await mountManager.unmountAll();
  await server.stop();

  const child = spawn('cmd.exe', ['/c', updaterCmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  setTimeout(() => app.quit(), 250);
  return { ok: true, installerExe };
}

async function runAutoUpdateCycle({ priorityUrl, trigger = 'timer' } = {}) {
  if (updateCheckInFlight || isQuitting) return null;
  if (!store.data.autoCheckUpdates && trigger === 'timer') return null;
  updateCheckInFlight = true;
  try {
    const info = await checkUpdatesCore({ priorityUrl });
    if (!info || info.status !== 'update-available') return info;

    let readyPath = info.localPath || '';
    if ((info.sourceType === 'peer' || info.sourceType === 'github') && info.downloadUrl && store.data.autoDownloadUpdates) {
      if (stagedUpdate && stagedUpdate.version === info.latestVersion && fs.existsSync(stagedUpdate.installerExe)) {
        readyPath = stagedUpdate.installerExe;
      } else {
        const cleanName = path.basename(String(info.fileName || `Esteban-Cloud-Setup-${info.latestVersion}.exe`));
        const destPath = path.join(os.tmpdir(), cleanName);
        server.log('info', `Pre-descargando actualización automática v${info.latestVersion} desde ${info.sourceLabel}...`);
        const dl = await downloadFileWithProgress(info.downloadUrl, destPath, {
          expectedSha256: info.sha256,
          onProgress: (p) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cloud:updateProgress', { stage: 'downloading', ...p });
            }
          }
        });
        readyPath = dl.destPath;
        stagedUpdate = {
          version: info.latestVersion,
          fileName: cleanName,
          installerExe: dl.destPath,
          sha256: dl.sha256,
          sourceLabel: info.sourceLabel
        };
        server.log('info', `Actualización v${info.latestVersion} descargada y verificada por SHA-256.`);
      }
    }

    const updatedInfo = { ...info, stagedPath: readyPath };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:updateAvailable', updatedInfo);
    }

    // Auto-install only when explicitly enabled, app is packaged, and NO remote drives are currently mounted
    if (readyPath && store.data.autoInstallWhenIdle && app.isPackaged && mountManager.listMounts().length === 0) {
      server.log('info', `Sin discos montados en uso: aplicando actualización v${info.latestVersion} automáticamente...`);
      await applyInstallerAndRestart(readyPath);
      return updatedInfo;
    }

    if (Notification.isSupported()) {
      try {
        new Notification({
          title: `Esteban Cloud v${info.latestVersion} lista`,
          body: readyPath
            ? 'Paquete descargado y verificado (SHA-256). Abre Esteban Cloud para instalarlo en 1 clic.'
            : `Nueva versión disponible desde ${info.sourceLabel}.`
        }).show();
      } catch {
        // ignore notification errors
      }
    }
    return updatedInfo;
  } catch (err) {
    server.log('error', `Error en ciclo de auto-actualización: ${err.message}`);
    return null;
  } finally {
    updateCheckInFlight = false;
  }
}

async function notifyPeerOfLocalUpdate(sess) {
  const localLatest = findLatestLocalRelease(getDefaultUpdateDirs(store.data.updateShareDir, path.join(__dirname, '..')));
  if (!localLatest) return { peer: sess.nodeName, ok: false, reason: 'Sin instalador local para enviar.' };

  const env = await checkEnvironment();
  const port = server.boundPort || store.data.port || 4789;
  const selfUrl = env.tailscale.ip ? `http://${env.tailscale.ip}:${port}` : (env.lanIp ? `http://${env.lanIp}:${port}` : '');

  // Try native v0.1.6+ push notification first
  try {
    await httpJsonRequest(`${sess.baseUrl}/api/updates/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUrl: selfUrl, version: localLatest.version }),
      timeout: 5000
    });
    server.log('info', `Aviso push v${localLatest.version} enviado a ${sess.nodeName}.`);
    return { peer: sess.nodeName, ok: true, mode: 'push-notify', version: localLatest.version };
  } catch {
    // Fallback for peers running <= v0.1.5: upload the Setup exe to their first RW share
    const rwShare = (sess.shares || []).find((s) => s.effectiveMode === 'rw');
    if (!rwShare) {
      return { peer: sess.nodeName, ok: false, reason: 'El equipo remoto no acepta push y no tiene carpeta RW para subir el instalador.' };
    }
    await httpJsonRequest(`${sess.baseUrl}/api/mkdir`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ share: rwShare.id, path: '', name: 'Actualizacion-Esteban-Cloud' })
    }).catch(() => {});

    const u = new URL(`${sess.baseUrl}/api/upload?share=${encodeURIComponent(rwShare.id)}&path=${encodeURIComponent('Actualizacion-Esteban-Cloud')}&name=${encodeURIComponent(localLatest.fileName)}`);
    const lib = u.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = lib.request(u, { method: 'POST', headers: { Authorization: `Bearer ${sess.token}` } }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      fs.createReadStream(localLatest.fullPath).pipe(req);
    });
    server.log('info', `Paquete ${localLatest.fileName} enviado a ${sess.nodeName}/${rwShare.name}/Actualizacion-Esteban-Cloud`);
    return {
      peer: sess.nodeName,
      ok: true,
      mode: 'uploaded-package',
      version: localLatest.version,
      destination: `${rwShare.name}/Actualizacion-Esteban-Cloud/${localLatest.fileName}`
    };
  }
}

  ipcMain.handle('updates:check', async () => checkUpdatesCore());

  ipcMain.handle('updates:pushToConnectedPeers', async () => {
    const sessions = Array.from(clientSessions.values());
    if (!sessions.length) {
      throw new Error('No hay equipos conectados en "Conectar (Cliente)" en este momento. Nota: los equipos con v0.1.6+ también buscan y descargan automáticamente desde este equipo cada 15 minutos sin necesidad de empujar manualmente.');
    }
    const results = [];
    for (const sess of sessions) {
      try {
        results.push(await notifyPeerOfLocalUpdate(sess));
      } catch (err) {
        results.push({ peer: sess.nodeName, ok: false, reason: err.message });
      }
    }
    return { results };
  });

  ipcMain.handle('updates:downloadAndInstall', async (_e, candidate) => {
    if (!candidate || (!candidate.downloadUrl && !candidate.localPath && !candidate.stagedPath)) {
      throw new Error('No hay un paquete de actualización válido para descargar.');
    }

    const sendProgress = (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:updateProgress', p);
      }
    };

    let installerExe = '';
    if (candidate.stagedPath && fs.existsSync(candidate.stagedPath)) {
      installerExe = candidate.stagedPath;
    } else if ((candidate.sourceType === 'peer' || candidate.sourceType === 'github') && candidate.downloadUrl) {
      const cleanName = path.basename(String(candidate.fileName || `Esteban-Cloud-Setup-${candidate.latestVersion || 'new'}.exe`));
      const destPath = path.join(os.tmpdir(), cleanName);
      sendProgress({ stage: 'downloading', percent: 0, received: 0, total: candidate.size || 0 });
      const dl = await downloadFileWithProgress(candidate.downloadUrl, destPath, {
        expectedSha256: candidate.sha256,
        onProgress: (p) => sendProgress({ stage: 'downloading', ...p })
      });
      installerExe = dl.destPath;
    } else if (candidate.localPath && fs.existsSync(candidate.localPath)) {
      installerExe = candidate.localPath;
    } else {
      throw new Error('No se encontró el archivo de instalación.');
    }

    sendProgress({ stage: 'installing', percent: 100 });
    return applyInstallerAndRestart(installerExe);
  });

  // ===== GLOBAL METRICS & OVERLOAD ALERTS =====
  async function collectGlobalMetrics({ includeDiskBench = false, notifyOverload = false } = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(store.data.metricThresholds || {}) };
    const env = await checkEnvironment();
    const rawLocal = await getLocalMetrics({ includeDiskBench, thresholds });
    const localMetrics = normalizeMetricsShape(rawLocal);

    const port = store.data.port || 4789;
    const peers = (env.tailscale.peers || []).filter((p) => p.ip && p.os === 'windows');
    const peerResults = await Promise.all(
      peers.map(async (p) => {
        const baseUrl = `http://${p.ip}:${port}`;
        if (!p.online) {
          return { nodeName: p.hostName || p.ip, ip: p.ip, online: false, latencyMs: null, version: '', metrics: null, error: 'Equipo apagado o sin Tailscale' };
        }
        const t0 = Date.now();
        try {
          const res = await httpJsonRequest(`${baseUrl}/api/metrics`, { timeout: 3500 });
          const latencyMs = Date.now() - t0;
          return {
            nodeName: (res.data && res.data.nodeName) || p.hostName || p.ip,
            ip: p.ip,
            online: true,
            latencyMs,
            version: (res.data && res.data.version) || '',
            metrics: normalizeMetricsShape(res.data && res.data.metrics),
            error: ''
          };
        } catch (err) {
          return {
            nodeName: p.hostName || p.ip,
            ip: p.ip,
            online: true,
            latencyMs: Date.now() - t0,
            version: '',
            metrics: null,
            error: `Sin métricas remotas (actualiza ese equipo a v0.2.0): ${err.message}`
          };
        }
      })
    );

    const aggregated = aggregateGlobalMetrics(localMetrics, peerResults, env.tailscale);
    // Ensure local node carries local IP & version and normalized shape
    if (aggregated.nodes && aggregated.nodes[0]) {
      aggregated.nodes[0].ip = env.tailscale.ip || env.lanIp || '127.0.0.1';
      aggregated.nodes[0].version = app.getVersion();
      aggregated.nodes[0].latencyMs = 0;
      aggregated.nodes[0].metrics = localMetrics;
    }

    if (notifyOverload && aggregated.busyNodes && aggregated.busyNodes.length > 0) {
      const now = Date.now();
      for (const bn of aggregated.busyNodes) {
        const key = `${bn.nodeName}:${bn.busyReason}`;
        const nextAllowed = alertCooldowns.get(key) || 0;
        if (now >= nextAllowed) {
          alertCooldowns.set(key, now + 5 * 60 * 1000);
          sendWindowsNotification(`Alerta de carga en ${bn.nodeName}`, bn.busyReason);
        }
      }
    }

    return { ...aggregated, thresholds };
  }

  ipcMain.handle('metrics:getGlobal', async (_e, opts) => {
    return collectGlobalMetrics({ includeDiskBench: Boolean(opts && opts.includeDiskBench), notifyOverload: false });
  });

  ipcMain.handle('metrics:runDiskBenchmark', async () => {
    await runDiskSpeedBenchmark();
    return collectGlobalMetrics({ includeDiskBench: false, notifyOverload: false });
  });

  ipcMain.handle('metrics:updateThresholds', async (_e, patch) => {
    const merged = { ...DEFAULT_THRESHOLDS, ...(store.data.metricThresholds || {}), ...(patch || {}) };
    store.updateSettings({ metricThresholds: merged });
    return collectGlobalMetrics({ includeDiskBench: false, notifyOverload: false });
  });

  // Background overload watcher every 45 seconds
  setInterval(() => {
    if (!isQuitting) {
      collectGlobalMetrics({ includeDiskBench: false, notifyOverload: true }).catch(() => {});
    }
  }, 45 * 1000);

  // ===== P2P CHAT & MESSAGING =====
  async function resolvePeerChatUrl(chat) {
    if (!chat) return '';
    if (chat.peerUrl && /^https?:\/\//i.test(chat.peerUrl)) return chat.peerUrl.replace(/\/$/, '');
    if (!chat.peerNode) return '';
    const env = await checkEnvironment();
    const target = chat.peerNode.toLowerCase();
    const port = store.data.port || 4789;
    const tp = (env.tailscale.peers || []).find((p) => (p.hostName || '').toLowerCase() === target || (p.ip || '') === chat.peerNode);
    if (tp && tp.ip) return `http://${tp.ip}:${port}`;
    const sp = (store.data.savedPeers || []).find((p) => (p.nodeName || '').toLowerCase() === target);
    if (sp && sp.tailscaleIp) return `http://${sp.tailscaleIp}:${sp.port || port}`;
    return '';
  }

  async function resolveSelfUrl() {
    const env = await checkEnvironment();
    const port = server.boundPort || store.data.port || 4789;
    return env.tailscale.ip ? `http://${env.tailscale.ip}:${port}` : (env.lanIp ? `http://${env.lanIp}:${port}` : '');
  }

  ipcMain.handle('chat:list', async () => {
    return { chats: chatStore.listChats(), totalUnread: chatStore.getTotalUnread() };
  });

  ipcMain.handle('chat:create', async (_e, payload) => {
    const chat = chatStore.createChat(payload || {});
    return { chat, chats: chatStore.listChats(), totalUnread: chatStore.getTotalUnread() };
  });

  ipcMain.handle('chat:delete', async (_e, chatId) => {
    let peerUrl = '';
    try {
      const existing = chatStore.getChat(chatId);
      peerUrl = await resolvePeerChatUrl(existing.chat);
    } catch {}
    chatStore.deleteChat(chatId);
    if (peerUrl) {
      httpJsonRequest(`${peerUrl}/api/chat/delete-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
        timeout: 3500
      }).catch(() => {});
    }
    return { chats: chatStore.listChats(), totalUnread: chatStore.getTotalUnread() };
  });

  ipcMain.handle('chat:getMessages', async (_e, chatId) => {
    chatStore.markRead(chatId);
    const data = chatStore.getChat(chatId);
    return { ...data, totalUnread: chatStore.getTotalUnread() };
  });

  ipcMain.handle('chat:pickAttachments', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar imágenes o archivos para enviar en el chat',
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return [];
    return res.filePaths.map((fp) => {
      const st = fs.statSync(fp);
      const name = path.basename(fp);
      const mime = detectMime(name);
      const isImage = mime.startsWith('image/');
      let previewDataUrl = '';
      if (isImage && st.size <= 8 * 1024 * 1024) {
        try {
          previewDataUrl = `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`;
        } catch {}
      }
      return { filePath: fp, name, size: st.size, mime, isImage, previewDataUrl };
    });
  });

  ipcMain.handle('chat:sendMessage', async (_e, { chatId, text, format = 'markdown', attachmentFiles = [] }) => {
    const { chat } = chatStore.getChat(chatId);
    const savedAtts = [];
    const wireAtts = [];

    for (const item of (attachmentFiles || [])) {
      let buf = null;
      if (item.base64) {
        buf = Buffer.from(item.base64, 'base64');
      } else if (item.filePath && fs.existsSync(item.filePath)) {
        buf = fs.readFileSync(item.filePath);
      }
      if (!buf) continue;
      const saved = chatStore.saveAttachment({
        fileName: item.name || (item.filePath ? path.basename(item.filePath) : 'archivo'),
        mime: item.mime,
        buffer: buf
      });
      savedAtts.push(saved);
      if (buf.length <= 24 * 1024 * 1024) {
        wireAtts.push({ id: saved.id, name: saved.name, mime: saved.mime, base64: buf.toString('base64') });
      }
    }

    const msg = chatStore.addMessage({
      chatId,
      senderNode: store.data.nodeName,
      text: text || '',
      format,
      attachments: savedAtts,
      incoming: false
    });

    let deliveryStatus = 'local-only';
    const peerUrl = await resolvePeerChatUrl(chat);
    const selfUrl = await resolveSelfUrl();

    if (chat.type === 'group') {
      const env = await checkEnvironment();
      const port = store.data.port || 4789;
      const targets = (env.tailscale.peers || []).filter((p) => p.online && p.ip && p.os === 'windows');
      let okCount = 0;
      await Promise.all(targets.map(async (tp) => {
        try {
          await httpJsonRequest(`http://${tp.ip}:${port}/api/chat/receive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: msg.id,
              chatId: chat.id,
              chatTitle: chat.title,
              chatType: 'group',
              senderNode: store.data.nodeName,
              senderUrl: selfUrl,
              text: msg.text,
              format: msg.format,
              createdAt: msg.createdAt,
              attachments: wireAtts
            }),
            timeout: 15000
          });
          okCount += 1;
        } catch {}
      }));
      deliveryStatus = okCount > 0 ? `delivered:${okCount}` : 'queued-local';
    } else if (peerUrl) {
      try {
        await httpJsonRequest(`${peerUrl}/api/chat/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: msg.id,
            chatId: chat.id,
            chatTitle: chat.title,
            chatType: chat.type || 'direct',
            senderNode: store.data.nodeName,
            senderUrl: selfUrl,
            text: msg.text,
            format: msg.format,
            createdAt: msg.createdAt,
            attachments: wireAtts
          }),
          timeout: 15000
        });
        deliveryStatus = 'delivered';
      } catch (err) {
        deliveryStatus = `local-saved (${err.message})`;
      }
    }

    return {
      message: msg,
      deliveryStatus,
      messages: chatStore.getChat(chatId).messages,
      chats: chatStore.listChats(),
      totalUnread: chatStore.getTotalUnread()
    };
  });

  ipcMain.handle('chat:getAttachmentDataUrl', async (_e, attachmentId) => {
    const { meta, filePath } = chatStore.getAttachmentInfo(attachmentId);
    const buf = fs.readFileSync(filePath);
    return { dataUrl: `data:${meta.mime};base64,${buf.toString('base64')}`, mime: meta.mime, name: meta.name };
  });

  ipcMain.handle('chat:downloadAttachment', async (_e, { attachmentId, fileName }) => {
    const { meta, filePath } = chatStore.getAttachmentInfo(attachmentId);
    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar archivo del chat',
      defaultPath: fileName || meta.name
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };
    fs.copyFileSync(filePath, saveRes.filePath);
    return { canceled: false, savedPath: saveRes.filePath };
  });

  ipcMain.handle('chat:deleteAttachment', async (_e, { chatId, messageId, attachmentId }) => {
    const { chat } = chatStore.getChat(chatId);
    chatStore.deleteAttachment(chatId, messageId, attachmentId);
    const peerUrl = await resolvePeerChatUrl(chat);
    if (peerUrl) {
      httpJsonRequest(`${peerUrl}/api/chat/delete-attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, messageId, attachmentId }),
        timeout: 3500
      }).catch(() => {});
    }
    return { messages: chatStore.getChat(chatId).messages, chats: chatStore.listChats() };
  });

  ipcMain.handle('chat:deleteMessage', async (_e, { chatId, messageId }) => {
    const { chat } = chatStore.getChat(chatId);
    chatStore.deleteMessage(chatId, messageId);
    const peerUrl = await resolvePeerChatUrl(chat);
    if (peerUrl) {
      httpJsonRequest(`${peerUrl}/api/chat/delete-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, messageId }),
        timeout: 3500
      }).catch(() => {});
    }
    return { messages: chatStore.getChat(chatId).messages, chats: chatStore.listChats() };
  });
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  registerIpc();
  setupTray();
  createWindow();

  if (store.data.startWithWindows && app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--minimized'] });
    } catch {
      // ignore
    }
  }

  if (process.argv.includes('--minimized') && store.data.minimizeToTray && mainWindow) {
    mainWindow.hide();
  }

  if (store.data.autoStartServer) {
    try {
      const env = await checkEnvironment();
      const host = store.data.bindMode === 'tailscale' && env.tailscale.ip ? env.tailscale.ip : '0.0.0.0';
      await server.start({ host, port: store.data.port });
      refreshTrayMenu();
    } catch (err) {
      server.log('error', `No se pudo iniciar automáticamente: ${err.message}`);
    }
  }

  // Automatic background update check (12s after startup + every 15 minutes)
  setTimeout(() => {
    runAutoUpdateCycle({ trigger: 'startup' }).catch(() => {});
  }, 12000);
  setInterval(() => {
    runAutoUpdateCycle({ trigger: 'timer' }).catch(() => {});
  }, 15 * 60 * 1000);
});

app.on('before-quit', async () => {
  isQuitting = true;
  await mountManager.unmountAll();
  await server.stop();
});

app.on('window-all-closed', () => {
  if (!store.data.minimizeToTray) {
    app.quit();
  }
});
