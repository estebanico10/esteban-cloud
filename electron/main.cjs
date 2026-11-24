'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification, powerSaveBlocker } = require('electron');
const QRCode = require('qrcode');

const { ConfigStore, defaultConfigDir } = require('./config-store.cjs');
const { generateKeyBundle, decryptKeyBundle } = require('./crypto-keys.cjs');
const { EstebanCloudServer } = require('./server.cjs');
const { checkEnvironment, MountManager, syncSshAuthorizedKeys, launchElevatedInstaller } = require('./system-tools.cjs');
const {
  selectFastestBaseUrl,
  optimizeTailscaleDirectPath,
  turboDownloadFile,
  turboUploadBatch
} = require('./turbo-transfer.cjs');
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
const {
  scanAllAvailableKeys,
  diagnosePeerConnection,
  scanSharedStorage,
  computeFileHashSummary,
  runFolderSync,
  ClipboardHistoryStore,
  captureLocalScreenJpeg,
  listTopProcesses,
  killLocalProcess,
  executeQuickSystemAction,
  saveAirDropFile,
  EncryptedVaultStore,
  encryptFileForUsb,
  decryptFileFromUsb,
  convertImageFile,
  scanGitProjects,
  gitQuickCommitPush
} = require('./tools.cjs');

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

// Prevent any unexpected error from showing a blocking native Windows dialog box
process.on('uncaughtException', (err) => {
  try {
    console.error('[EstebanCloud uncaughtException]', err);
    if (typeof server !== 'undefined' && server && server.log) {
      server.log('error', `Excepción controlada: ${err && err.message ? err.message : String(err)}`);
    }
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[EstebanCloud unhandledRejection]', reason);
  } catch {}
});

const store = new ConfigStore();
const chatStore = new ChatStore();
const clipboardStore = new ClipboardHistoryStore(path.join(defaultConfigDir(), 'clipboard-history.json'));
const vaultStore = new EncryptedVaultStore(path.join(defaultConfigDir(), 'secret-vault.json'));
let keepAwakeBlockerId = null;

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
  },
  onClipboardPush: ({ text, senderNode }) => {
    try { clipboard.writeText(text); } catch {}
    clipboardStore.addItem({ text, senderNode: senderNode || 'Equipo remoto' });
    sendWindowsNotification(`Portapapeles recibido de ${senderNode || 'Equipo remoto'}`, text.slice(0, 95));
  },
  getClipboardItemsFn: () => clipboardStore.listItems(),
  onAirDropReceive: async ({ fileName, dataBase64, senderNode }) => {
    const saved = saveAirDropFile({ fileName, dataBase64, senderNode });
    sendWindowsNotification(`AirDrop recibido de ${senderNode || 'Equipo remoto'}`, `${saved.fileName} guardado en Descargas\\EstebanCloud-AirDrop`);
    return saved;
  },
  onScreenCapture: async () => captureLocalScreenJpeg({ maxWidth: 1280, quality: 72 }),
  onListProcesses: async () => listTopProcesses({ limit: 15 }),
  onKillProcess: async (pid) => killLocalProcess(pid),
  onSystemAction: async (action, payload) => executeQuickSystemAction(action, payload),
  onVaultList: () => vaultStore.listItems(),
  onVaultUpsert: (item) => vaultStore.upsertItem(item),
  onVaultDelete: (id) => { vaultStore.deleteItem(id); return true; }
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
  try { mainWindow.moveTop(); } catch {}
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  try { app.focus({ steal: true }); } catch {}
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 400);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 650,
    center: true,
    show: !process.argv.includes('--minimized'),
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

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--minimized')) {
      showWindow();
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
  const best = await selectFastestBaseUrl(hostInfo, token, overrideBaseUrl, 4789);
  return {
    baseUrl: best.baseUrl,
    sharesResponse: best.sharesResponse,
    routeInfo: {
      routeType: best.routeType,
      latencyMs: best.latencyMs,
      relay: best.relay,
      curAddr: best.curAddr,
      baseUrl: best.baseUrl,
      candidates: best.candidates
    }
  };
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
  const localKeysDir = path.join(defaultConfigDir(), 'keys');
  const detectedKeys = scanAllAvailableKeys({
    usbDrives: env.usbDrives || [],
    extraDirs: [localKeysDir],
    keyVault: cfg.keyVault || {},
    authorizedKeys: cfg.keys || []
  });

  return {
    appVersion: app.getVersion(),
    config: cfg,
    server: status,
    env,
    installerInfo,
    detectedKeys,
    clipboardHistory: clipboardStore.listItems(),
    keepAwake: keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId),
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
      shares: s.shares,
      routeInfo: s.routeInfo || null
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
    const suggestedFileName = `${String(label || 'llave').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${result.keyId}.ecloudkey`;
    try {
      const localKeysDir = path.join(defaultConfigDir(), 'keys');
      fs.mkdirSync(localKeysDir, { recursive: true });
      fs.writeFileSync(path.join(localKeysDir, suggestedFileName), result.bundleJson, 'utf8');
      store.saveKeyVaultEntry({
        keyId: result.keyId,
        passphrase,
        label,
        nodeName: store.data.nodeName,
        permissions,
        shareIds,
        fileName: suggestedFileName
      });
    } catch {}
    const sshSync = syncSshAuthorizedKeys(store.data.keys);
    return {
      keyId: result.keyId,
      bundleJson: result.bundleJson,
      clipboardString: result.clipboardString,
      suggestedFileName,
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
    try {
      const localKeysDir = path.join(defaultConfigDir(), 'keys');
      fs.mkdirSync(localKeysDir, { recursive: true });
      const backupName = filePath ? path.basename(filePath) : `${String(payload.label || 'llave').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${payload.keyId}.ecloudkey`;
      if (filePath && fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, path.join(localKeysDir, backupName));
      }
      store.saveKeyVaultEntry({
        keyId: payload.keyId,
        passphrase,
        label: payload.label,
        nodeName: (payload.host && payload.host.nodeName) || '',
        permissions: payload.permissions || 'rw',
        shareIds: payload.shareIds || ['*'],
        fileName: backupName
      });
    } catch {}
    const { baseUrl, sharesResponse, routeInfo } = await resolveReachableBaseUrl(payload.host || {}, payload.token, overrideBaseUrl);
    const sessionId = `sess-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nodeName = sharesResponse.nodeName || (payload.host && payload.host.nodeName) || 'Nodo remoto';
    const permissions = (sharesResponse.key && sharesResponse.key.permissions) || payload.permissions;
    const shares = sharesResponse.shares || [];
    clientSessions.set(sessionId, {
      baseUrl,
      overrideBaseUrl: overrideBaseUrl || '',
      keyId: payload.keyId,
      label: payload.label,
      nodeName,
      permissions,
      token: payload.token,
      host: payload.host || {},
      shares,
      routeInfo
    });

    if (saveBookmark) {
      store.savePeer({
        label: payload.label,
        nodeName,
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
        nodeName,
        permissions,
        shares,
        routeInfo
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

  ipcMain.handle('client:downloadFile', async (_e, { sessionId, shareId, relPath, fileName, fileSize, size }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar archivo descargado (Motor Turbo 8x)',
      defaultPath: fileName || path.basename(relPath)
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };
    const dest = saveRes.filePath;
    const dlResult = await turboDownloadFile({
      baseUrl: sess.baseUrl,
      token: sess.token,
      shareId,
      relPath,
      destPath: dest,
      fileSize: Number(fileSize || size) || 0,
      concurrency: 8,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cloud:transferProgress', {
            ...p,
            routeType: (sess.routeInfo && sess.routeInfo.routeType) || 'unknown',
            nodeName: sess.nodeName
          });
        }
      }
    });
    server.log('info', `Descarga Turbo (${dlResult.parallelStreams}x streams · ${dlResult.speedMBs} MB/s): ${fileName || path.basename(relPath)}`);
    return { canceled: false, savedPath: dest, ...dlResult };
  });

  ipcMain.handle('client:uploadFiles', async (_e, { sessionId, shareId, relPath }) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivos para subir al equipo remoto (Motor Turbo)',
      properties: ['openFile', 'multiSelections']
    });
    if (pick.canceled || !pick.filePaths.length) return { canceled: true, uploaded: [] };
    const upResult = await turboUploadBatch({
      baseUrl: sess.baseUrl,
      token: sess.token,
      shareId,
      remoteDir: relPath || '',
      filePaths: pick.filePaths,
      concurrency: 4,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cloud:transferProgress', {
            ...p,
            routeType: (sess.routeInfo && sess.routeInfo.routeType) || 'unknown',
            nodeName: sess.nodeName
          });
        }
      }
    });
    server.log('info', `Subida Turbo (${upResult.speedMBs} MB/s): ${upResult.uploaded.join(', ')}`);
    return { canceled: false, uploaded: upResult.uploaded, speedMBs: upResult.speedMBs };
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
    if (sess.routeInfo && sess.routeInfo.routeType === 'tailscale-relay') {
      optimizeTailscaleDirectPath(sess.baseUrl).catch(() => {});
    }
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

  ipcMain.handle('client:optimizeRoute', async (_e, { sessionId, remountDriveLetter } = {}) => {
    const sess = clientSessions.get(sessionId);
    if (!sess) throw new Error('Sesión remota no activa.');
    const prevBase = sess.baseUrl;
    if (sess.host && sess.host.tailscaleIp) {
      await optimizeTailscaleDirectPath(sess.host.tailscaleIp).catch(() => {});
    }
    await optimizeTailscaleDirectPath(prevBase).catch(() => {});
    const best = await resolveReachableBaseUrl(sess.host || {}, sess.token, sess.overrideBaseUrl || '');
    sess.baseUrl = best.baseUrl;
    sess.routeInfo = best.routeInfo;
    sess.shares = (best.sharesResponse && best.sharesResponse.shares) || sess.shares;

    const remounted = [];
    const activeMounts = mountManager.listMounts();
    for (const m of activeMounts) {
      const cleanPrev = String(prevBase || '').replace(/\/$/, '').toLowerCase();
      const matchesSession = remountDriveLetter
        ? m.drive.toUpperCase() === String(remountDriveLetter).toUpperCase()
        : (m.url.toLowerCase().startsWith(cleanPrev) || m.label.toLowerCase().includes(String(sess.nodeName || '').toLowerCase().slice(0, 12)));
      if (matchesSession) {
        await mountManager.unmount(m.drive);
        await new Promise((r) => setTimeout(r, 600));
        const nextMount = await mountManager.mountWebDav({
          driveLetter: m.drive,
          label: m.label,
          baseUrl: sess.baseUrl,
          keyId: sess.keyId,
          token: sess.token
        });
        remounted.push(nextMount);
      }
    }
    refreshTrayMenu();
    server.log('info', `Ruta optimizada para ${sess.nodeName}: ${sess.routeInfo.routeType} (${sess.baseUrl}, ${sess.routeInfo.latencyMs}ms)`);
    return {
      baseUrl: sess.baseUrl,
      routeInfo: sess.routeInfo,
      remounted,
      state: await buildFullState()
    };
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

  registerUpdatesMetricsAndChatIpc();
}

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

    // Zero-touch auto-install: unmount any active remote drives cleanly, install silently (/S), and restart
    if (readyPath && store.data.autoInstallWhenIdle && app.isPackaged) {
      server.log('info', `Aplicando actualización automática v${info.latestVersion} y reiniciando...`);
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

async function broadcastUpdateToAllMeshPeers() {
  const localLatest = findLatestLocalRelease(getDefaultUpdateDirs(store.data.updateShareDir, path.join(__dirname, '..')));
  const env = await checkEnvironment();
  const port = server.boundPort || store.data.port || 4789;
  const selfUrl = env.tailscale.ip ? `http://${env.tailscale.ip}:${port}` : (env.lanIp ? `http://${env.lanIp}:${port}` : '');
  const versionToAnnounce = localLatest ? localLatest.version : app.getVersion();

  const results = [];
  const notifiedUrls = new Set();

  // 1. Active client sessions (authenticated push + legacy file upload fallback)
  for (const sess of clientSessions.values()) {
    try {
      results.push(await notifyPeerOfLocalUpdate(sess));
      if (sess.baseUrl) notifiedUrls.add(sess.baseUrl.replace(/\/$/, ''));
    } catch (err) {
      results.push({ peer: sess.nodeName, ok: false, reason: err.message });
    }
  }

  // 2. All online Windows peers in Tailscale mesh + savedPeers (zero-config mesh broadcast)
  const targetPeers = [];
  for (const tp of (env.tailscale.peers || [])) {
    if (tp.online && tp.ip && tp.os === 'windows') {
      targetPeers.push({ name: tp.hostName || tp.ip, baseUrl: `http://${tp.ip}:${port}` });
    }
  }
  for (const sp of (store.data.savedPeers || [])) {
    const spPort = Number(sp.port) || 4789;
    if (sp.tailscaleIp) targetPeers.push({ name: sp.nodeName || sp.label || sp.tailscaleIp, baseUrl: `http://${sp.tailscaleIp}:${spPort}` });
  }

  for (const t of targetPeers) {
    const cleanBase = t.baseUrl.replace(/\/$/, '');
    if (notifiedUrls.has(cleanBase)) continue;
    notifiedUrls.add(cleanBase);
    try {
      await httpJsonRequest(`${cleanBase}/api/updates/mesh-broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromUrl: selfUrl, version: versionToAnnounce }),
        timeout: 4000
      });
      server.log('info', `Broadcast automático v${versionToAnnounce} entregado a ${t.name} (${cleanBase}).`);
      results.push({ peer: t.name, ok: true, mode: 'push-notify', version: versionToAnnounce });
    } catch (err) {
      results.push({ peer: t.name, ok: false, reason: err.message });
    }
  }

  return results;
}

let lastSyncedReleaseSha = '';
async function syncLocalReleaseToKitsAndMesh() {
  try {
    const localLatest = findLatestLocalRelease(getDefaultUpdateDirs(store.data.updateShareDir, path.join(__dirname, '..')));
    if (!localLatest || !localLatest.sha256) return;
    if (localLatest.sha256 === lastSyncedReleaseSha) return;
    lastSyncedReleaseSha = localLatest.sha256;

    // Auto-sync new installer to connected USB Pendrive Kits (E:\Esteban-Cloud-Kit, F:\Esteban-Cloud-Kit, etc.)
    const env = await checkEnvironment();
    const kitDirs = ['E:\\CODE\\ESTEBAN CLOUD\\release'];
    for (const d of (env.usbDrives || [])) {
      kitDirs.push(path.join(d.root, 'Esteban-Cloud-Kit'));
    }
    for (const dir of kitDirs) {
      try {
        if (!fs.existsSync(dir) || path.resolve(dir).toLowerCase() === path.resolve(localLatest.sourceDir).toLowerCase()) continue;
        const targetExe = path.join(dir, localLatest.fileName);
        if (!fs.existsSync(targetExe)) {
          for (const f of fs.readdirSync(dir)) {
            if (/^Esteban-Cloud-Setup-\d+\.\d+\.\d+\.exe$/i.test(f) && f !== localLatest.fileName) {
              try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
          }
          fs.copyFileSync(localLatest.fullPath, targetExe);
          server.log('info', `Instalador ${localLatest.fileName} sincronizado automáticamente en ${dir}`);
        }
      } catch {
        // ignore read-only or disconnected USB
      }
    }

    // Automatically broadcast to all online Tailscale peers
    await broadcastUpdateToAllMeshPeers();

    // And if this machine itself is running an older version than localLatest, trigger self-update
    if (compareSemver(localLatest.version, app.getVersion()) > 0) {
      runAutoUpdateCycle({ trigger: 'watcher' }).catch(() => {});
    }
  } catch {
    // ignore background watcher errors
  }
}

// ===== GLOBAL METRICS & OVERLOAD ALERTS (TOP-LEVEL HELPERS) =====
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
          error: `Sin métricas remotas (actualiza ese equipo a v0.2.0+): ${err.message}`
        };
      }
    })
  );

  const aggregated = aggregateGlobalMetrics(localMetrics, peerResults, env.tailscale);
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

function registerUpdatesMetricsAndChatIpc() {
  ipcMain.handle('updates:check', async () => checkUpdatesCore());

  ipcMain.handle('updates:pushToConnectedPeers', async () => {
    const results = await broadcastUpdateToAllMeshPeers();
    if (!results.length) {
      throw new Error('No se detectaron otros equipos Windows en línea en Tailscale en este momento. Cuando se enciendan, se actualizarán automáticamente desde este equipo o desde GitHub Releases.');
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

  // ===== KEY VAULT & POWER TOOLS IPC =====
  ipcMain.handle('keys:readClipboardText', async () => clipboard.readText());

  ipcMain.handle('keys:savePassphrase', async (_e, { keyId, passphrase, label, nodeName }) => {
    store.saveKeyVaultEntry({ keyId, passphrase, label, nodeName });
    return buildFullState();
  });

  ipcMain.handle('keys:syncToAllUsb', async (_e, keyId) => {
    const env = await checkEnvironment();
    const localKeysDir = path.join(defaultConfigDir(), 'keys');
    const allKeys = scanAllAvailableKeys({
      usbDrives: env.usbDrives || [],
      extraDirs: [localKeysDir],
      keyVault: store.data.keyVault || {},
      authorizedKeys: store.data.keys || []
    });
    const target = allKeys.find((k) => k.keyId === keyId);
    if (!target || !target.bundleJson) {
      throw new Error('No se encontró el archivo .ecloudkey de esta llave para sincronizar.');
    }
    const cleanFileName = target.fileName && target.fileName.endsWith('.ecloudkey')
      ? target.fileName
      : `${String(target.label || 'llave').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${target.keyId}.ecloudkey`;

    const saved = [];
    fs.mkdirSync(localKeysDir, { recursive: true });
    const localDest = path.join(localKeysDir, cleanFileName);
    fs.writeFileSync(localDest, target.bundleJson, 'utf8');
    saved.push(localDest);

    for (const d of (env.usbDrives || [])) {
      const kitDir = path.join(d.root, 'Esteban-Cloud-Kit');
      const targetDir = fs.existsSync(kitDir) ? kitDir : d.root;
      try {
        const dest = path.join(targetDir, cleanFileName);
        fs.writeFileSync(dest, target.bundleJson, 'utf8');
        saved.push(dest);
      } catch {}
    }
    return { saved, state: await buildFullState() };
  });

  ipcMain.handle('tools:runFolderSync', async (_e, { id, label, sourceDir, targetDir, mirror, saveProfile }) => {
    const result = await runFolderSync({ sourceDir, targetDir, mirror: Boolean(mirror) });
    if (saveProfile || id) {
      store.saveSyncProfile({ id, label, sourceDir, targetDir, mirror: Boolean(mirror), lastResult: result });
    }
    return { result, state: await buildFullState() };
  });

  ipcMain.handle('tools:deleteSyncProfile', async (_e, id) => {
    store.removeSyncProfile(id);
    return buildFullState();
  });

  ipcMain.handle('tools:pickFileForHash', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivo para verificar SHA-256 / MD5',
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return computeFileHashSummary(res.filePaths[0]);
  });

  ipcMain.handle('tools:computeFileHash', async (_e, filePath) => {
    return computeFileHashSummary(filePath);
  });

  ipcMain.handle('tools:scanSharedStorage', async (_e, { query = '' } = {}) => {
    return scanSharedStorage({ shares: store.data.shares || [], query });
  });

  ipcMain.handle('tools:diagnosePeer', async (_e, { host, port } = {}) => {
    return diagnosePeerConnection({ host, port: Number(port) || store.data.port || 4789 });
  });

  ipcMain.handle('tools:launchRdp', async (_e, host) => {
    const cleanHost = String(host || '').trim().replace(/[^a-zA-Z0-9._:-]/g, '');
    if (!cleanHost) throw new Error('Dirección IP o host inválido.');
    const child = spawn('mstsc.exe', [`/v:${cleanHost}`], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, host: cleanHost };
  });

  ipcMain.handle('tools:openSmbShare', async (_e, host) => {
    const cleanHost = String(host || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
    if (!cleanHost) throw new Error('Dirección IP o host inválido.');
    const unc = `\\\\${cleanHost}`;
    const child = spawn('explorer.exe', [unc], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, unc };
  });

  ipcMain.handle('tools:pushMeshClipboard', async (_e, { text } = {}) => {
    const cleanText = String(text || '');
    if (!cleanText.trim()) throw new Error('El texto para enviar al portapapeles está vacío.');
    try { clipboard.writeText(cleanText); } catch {}
    clipboardStore.addItem({ text: cleanText, senderNode: store.data.nodeName });

    const env = await checkEnvironment();
    const port = store.data.port || 4789;
    const targets = new Set();
    for (const tp of (env.tailscale.peers || [])) {
      if (tp.online && tp.ip && tp.os === 'windows') targets.add(`http://${tp.ip}:${port}`);
    }
    for (const sp of (store.data.savedPeers || [])) {
      if (sp.tailscaleIp) targets.add(`http://${sp.tailscaleIp}:${sp.port || port}`);
    }

    const deliveredTo = [];
    await Promise.all(Array.from(targets).map(async (baseUrl) => {
      try {
        const res = await httpJsonRequest(`${baseUrl}/api/tools/clipboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanText, senderNode: store.data.nodeName }),
          timeout: 3500
        });
        deliveredTo.push((res.data && res.data.nodeName) || baseUrl);
      } catch {}
    }));

    return { deliveredTo, state: await buildFullState() };
  });

  ipcMain.handle('tools:deleteClipboardItem', async (_e, id) => {
    clipboardStore.removeItem(id);
    return buildFullState();
  });

  ipcMain.handle('tools:setKeepAwake', async (_e, enabled) => {
    if (enabled) {
      if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
        keepAwakeBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      }
    } else if (keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = null;
    }
    return buildFullState();
  });

  ipcMain.handle('tools:openAirDropFolder', async () => {
    const dir = path.join(os.homedir(), 'Downloads', 'EstebanCloud-AirDrop');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('tools:sendAirDropFiles', async (_e, { peerUrl } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivos para enviar por AirDrop',
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, sent: [] };

    const sent = [];
    for (const fp of res.filePaths) {
      const fileName = path.basename(fp);
      const dataBase64 = fs.readFileSync(fp).toString('base64');
      if (!peerUrl || peerUrl === 'local') {
        const saved = saveAirDropFile({ fileName, dataBase64, senderNode: store.data.nodeName });
        sent.push(saved);
      } else {
        const cleanUrl = String(peerUrl).replace(/\/$/, '');
        const remoteRes = await httpJsonRequest(`${cleanUrl}/api/tools/airdrop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName, dataBase64, senderNode: store.data.nodeName }),
          timeout: 30000
        });
        sent.push(remoteRes.data);
      }
    }
    return { canceled: false, sent };
  });

  ipcMain.handle('tools:fetchRemoteScreen', async (_e, { peerUrl } = {}) => {
    if (!peerUrl || peerUrl === 'local') {
      const snap = await captureLocalScreenJpeg({ maxWidth: 1280, quality: 72 });
      return { ok: true, nodeName: store.data.nodeName, ...snap };
    }
    const cleanUrl = String(peerUrl).replace(/\/$/, '');
    const res = await httpJsonRequest(`${cleanUrl}/api/tools/screen`, { timeout: 10000 });
    return res.data;
  });

  ipcMain.handle('tools:fetchRemoteProcesses', async (_e, { peerUrl } = {}) => {
    if (!peerUrl || peerUrl === 'local') {
      const processes = await listTopProcesses({ limit: 15 });
      return { ok: true, nodeName: store.data.nodeName, processes };
    }
    const cleanUrl = String(peerUrl).replace(/\/$/, '');
    const res = await httpJsonRequest(`${cleanUrl}/api/tools/processes`, { timeout: 8000 });
    return res.data;
  });

  ipcMain.handle('tools:killRemoteProcess', async (_e, { peerUrl, pid } = {}) => {
    if (!peerUrl || peerUrl === 'local') {
      return killLocalProcess(pid);
    }
    const cleanUrl = String(peerUrl).replace(/\/$/, '');
    const res = await httpJsonRequest(`${cleanUrl}/api/tools/kill-process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
      timeout: 6000
    });
    return res.data;
  });

  ipcMain.handle('tools:runRemoteSystemAction', async (_e, { peerUrl, action, payload } = {}) => {
    if (!peerUrl || peerUrl === 'local' || action === 'wake-on-lan') {
      return executeQuickSystemAction(action, payload || {});
    }
    const cleanUrl = String(peerUrl).replace(/\/$/, '');
    const res = await httpJsonRequest(`${cleanUrl}/api/tools/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload: payload || {} }),
      timeout: 8000
    });
    return res.data;
  });

  ipcMain.handle('tools:vaultList', async () => vaultStore.listItems());

  ipcMain.handle('tools:vaultUpsert', async (_e, item) => {
    const saved = vaultStore.upsertItem(item || {});
    return { item: saved, items: vaultStore.listItems() };
  });

  ipcMain.handle('tools:vaultDelete', async (_e, id) => {
    vaultStore.deleteItem(id);
    return { items: vaultStore.listItems() };
  });

  ipcMain.handle('tools:vaultSyncPeers', async () => {
    const env = await checkEnvironment();
    const port = store.data.port || 4789;
    const targets = new Set();
    for (const tp of (env.tailscale.peers || [])) {
      if (tp.online && tp.ip && tp.os === 'windows') targets.add(`http://${tp.ip}:${port}`);
    }
    const localItems = vaultStore.listItems();
    let syncedPeers = 0;
    for (const baseUrl of targets) {
      try {
        const remote = await httpJsonRequest(`${baseUrl}/api/tools/vault`, { timeout: 4000 });
        for (const rItem of (remote.data && remote.data.items) || []) {
          vaultStore.upsertItem(rItem);
        }
        for (const lItem of localItems) {
          await httpJsonRequest(`${baseUrl}/api/tools/vault`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lItem),
            timeout: 4000
          });
        }
        syncedPeers += 1;
      } catch {}
    }
    return { syncedPeers, items: vaultStore.listItems() };
  });

  ipcMain.handle('tools:pickAndEncryptFileUsb', async (_e, { passphrase } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivo para cifrar con AES-256-GCM (.ecloudenc)',
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const out = encryptFileForUsb({ filePath: res.filePaths[0], passphrase });
    return { canceled: false, ...out };
  });

  ipcMain.handle('tools:pickAndDecryptFileUsb', async (_e, { passphrase } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivo cifrado (.ecloudenc) para descifrar',
      filters: [{ name: 'Archivo Cifrado Esteban Cloud', extensions: ['ecloudenc'] }, { name: 'Todos', extensions: ['*'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const out = decryptFileFromUsb({ filePath: res.filePaths[0], passphrase });
    return { canceled: false, ...out };
  });

  ipcMain.handle('tools:pickAndConvertImage', async (_e, { outputFormat = 'png', maxWidth = 0 } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar imagen para convertir / redimensionar',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'ico'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const out = await convertImageFile({ inputPath: res.filePaths[0], outputFormat, maxWidth: Number(maxWidth) || 0 });
    return { canceled: false, ...out };
  });

  ipcMain.handle('tools:scanGitProjects', async () => {
    const rootDirs = [
      path.join(os.homedir(), 'Esteban Nicola', 'Apps', 'MY APPS'),
      'E:\\CODE'
    ];
    return scanGitProjects({ rootDirs });
  });

  ipcMain.handle('tools:gitQuickCommitPush', async (_e, { repoDir, message } = {}) => {
    return gitQuickCommitPush({ repoDir, message });
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

  // Automatic background update check + local release watcher & mesh broadcast (8s after startup + every 3 minutes)
  setTimeout(() => {
    syncLocalReleaseToKitsAndMesh().catch(() => {});
    runAutoUpdateCycle({ trigger: 'startup' }).catch(() => {});
  }, 8000);
  setInterval(() => {
    syncLocalReleaseToKitsAndMesh().catch(() => {});
  }, 45 * 1000);
  setInterval(() => {
    runAutoUpdateCycle({ trigger: 'timer' }).catch(() => {});
  }, 3 * 60 * 1000);
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
