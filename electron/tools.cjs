'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const { KEY_PREFIX, parseKeyBundle } = require('./crypto-keys.cjs');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '$RECYCLE.BIN',
  'System Volume Information'
]);

/**
 * Scans USB drives, extra directories, keyVault, and authorizedKeys
 * to return a unified list of available .ecloudkey bundles and local keys.
 */
function scanAllAvailableKeys({
  usbDrives = [],
  extraDirs = [],
  keyVault = {},
  authorizedKeys = []
} = {}) {
  const byKeyId = new Map();
  const authMap = new Map();

  if (Array.isArray(authorizedKeys)) {
    for (const ak of authorizedKeys) {
      if (ak && ak.keyId) {
        authMap.set(ak.keyId, ak);
      }
    }
  }

  const candidateDirs = [];
  const seenCandidateDirs = new Set();

  if (Array.isArray(usbDrives)) {
    for (const u of usbDrives) {
      if (!u || !u.root) continue;
      const driveName = u.drive || u.root;
      const roots = [u.root, path.join(u.root, 'Esteban-Cloud-Kit')];
      for (const dir of roots) {
        const norm = path.resolve(dir);
        const tagKey = `usb::${driveName}::${norm}`;
        if (!seenCandidateDirs.has(tagKey)) {
          seenCandidateDirs.add(tagKey);
          candidateDirs.push({ dir: norm, isUsb: true, drive: driveName });
        }
      }
    }
  }

  if (Array.isArray(extraDirs)) {
    for (const dir of extraDirs) {
      if (!dir || typeof dir !== 'string') continue;
      const norm = path.resolve(dir);
      const tagKey = `dir::${norm}`;
      if (!seenCandidateDirs.has(tagKey)) {
        seenCandidateDirs.add(tagKey);
        candidateDirs.push({ dir: norm, isUsb: false, drive: null });
      }
    }
  }

  for (const candidate of candidateDirs) {
    let entries;
    try {
      if (!fs.existsSync(candidate.dir)) continue;
      const st = fs.statSync(candidate.dir);
      if (!st.isDirectory()) continue;
      entries = fs.readdirSync(candidate.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.ecloudkey')) continue;

      const fullPath = path.join(candidate.dir, entry.name);
      let rawText;
      let bundle;
      try {
        rawText = fs.readFileSync(fullPath, 'utf8');
        bundle = parseKeyBundle(rawText);
      } catch {
        continue;
      }

      const meta = bundle.meta || {};
      const keyId = meta.keyId || entry.name;

      let record = byKeyId.get(keyId);
      if (!record) {
        record = {
          keyId,
          bundle,
          fileName: entry.name,
          locations: [],
          usbLocations: []
        };
        byKeyId.set(keyId, record);
      }

      if (!record.locations.includes(fullPath)) {
        record.locations.push(fullPath);
      }

      if (candidate.isUsb) {
        const existsUsb = record.usbLocations.some((ul) => ul.filePath === fullPath);
        if (!existsUsb) {
          record.usbLocations.push({
            drive: candidate.drive,
            filePath: fullPath,
            fileName: entry.name
          });
        }
      }
    }
  }

  const results = [];

  for (const [keyId, record] of byKeyId.entries()) {
    const bundle = record.bundle;
    const meta = bundle.meta || {};
    const vaultEntry = keyVault && keyVault[keyId] ? keyVault[keyId] : null;
    const authEntry = authMap.get(keyId) || null;
    const primaryPath = record.locations[0] || '';
    const fileName = primaryPath ? path.basename(primaryPath) : record.fileName;

    const shareIds =
      (Array.isArray(vaultEntry?.shareIds) && vaultEntry.shareIds.length > 0
        ? vaultEntry.shareIds
        : null) ||
      (Array.isArray(authEntry?.shareIds) && authEntry.shareIds.length > 0
        ? authEntry.shareIds
        : null) ||
      ['*'];

    const isTotal = shareIds.includes('*');
    const bundleJson = JSON.stringify(bundle, null, 2);
    const clipboardString =
      KEY_PREFIX + Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');

    results.push({
      keyId,
      label: vaultEntry?.label || authEntry?.label || meta.label || fileName,
      nodeName: meta.nodeName || vaultEntry?.nodeName || '',
      tailscaleIp: meta.tailscaleIp || '',
      lanIp: meta.lanIp || '',
      port: Number(meta.port) || 4789,
      permissions: meta.permissions || authEntry?.permissions || 'rw',
      shareIds,
      isTotal,
      createdAt: meta.createdAt || authEntry?.createdAt || '',
      passphrase: vaultEntry?.passphrase || '',
      primaryPath,
      fileName,
      locations: record.locations,
      usbLocations: record.usbLocations,
      bundleJson,
      clipboardString,
      isLocalHostKey: Boolean(authEntry && !authEntry.revoked),
      revoked: Boolean(authEntry && authEntry.revoked)
    });
  }

  // Include any key in authorizedKeys that didn't have a .ecloudkey file on disk yet
  for (const [keyId, authEntry] of authMap.entries()) {
    if (byKeyId.has(keyId)) continue;
    const vaultEntry = keyVault && keyVault[keyId] ? keyVault[keyId] : null;
    const shareIds =
      (Array.isArray(vaultEntry?.shareIds) && vaultEntry.shareIds.length > 0
        ? vaultEntry.shareIds
        : null) ||
      (Array.isArray(authEntry?.shareIds) && authEntry.shareIds.length > 0
        ? authEntry.shareIds
        : null) ||
      ['*'];

    const isTotal = shareIds.includes('*');
    let bundleJson = vaultEntry?.bundleJson || '';
    let clipboardString = vaultEntry?.clipboardString || '';
    if (!clipboardString && vaultEntry?.bundle) {
      try {
        bundleJson = bundleJson || JSON.stringify(vaultEntry.bundle, null, 2);
        clipboardString =
          KEY_PREFIX + Buffer.from(JSON.stringify(vaultEntry.bundle), 'utf8').toString('base64');
      } catch {
        // ignore
      }
    }

    results.push({
      keyId,
      label: vaultEntry?.label || authEntry.label || keyId,
      nodeName: vaultEntry?.nodeName || authEntry.nodeName || '',
      tailscaleIp: vaultEntry?.tailscaleIp || '',
      lanIp: vaultEntry?.lanIp || '',
      port: Number(vaultEntry?.port) || 4789,
      permissions: authEntry.permissions || vaultEntry?.permissions || 'rw',
      shareIds,
      isTotal,
      createdAt: authEntry.createdAt || vaultEntry?.createdAt || '',
      passphrase: vaultEntry?.passphrase || '',
      primaryPath: '',
      fileName: '',
      locations: [],
      usbLocations: [],
      bundleJson,
      clipboardString,
      isLocalHostKey: Boolean(!authEntry.revoked),
      revoked: Boolean(authEntry.revoked)
    });
  }

  results.sort((a, b) => {
    if (a.isLocalHostKey !== b.isLocalHostKey) {
      return a.isLocalHostKey ? -1 : 1;
    }
    if (a.revoked !== b.revoked) {
      return a.revoked ? 1 : -1;
    }
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  return results;
}

/**
 * Tests TCP connectivity to host:port within timeoutMs.
 */
function checkTcpPort(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const numericPort = Number(port);
    const startTime = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      const latencyMs = Math.max(0, Date.now() - startTime);
      finish({ port: numericPort, open: true, latencyMs });
    });

    socket.once('timeout', () => {
      finish({ port: numericPort, open: false, latencyMs: null, error: 'TIMEOUT' });
    });

    socket.once('error', (err) => {
      finish({
        port: numericPort,
        open: false,
        latencyMs: null,
        error: err && (err.code || err.message) ? String(err.code || err.message) : 'ERROR'
      });
    });

    try {
      socket.connect(numericPort, host);
    } catch (err) {
      finish({
        port: numericPort,
        open: false,
        latencyMs: null,
        error: err && err.message ? err.message : 'CONNECT_ERROR'
      });
    }
  });
}

function fetchPeerAppInfo(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = http.get(
      {
        hostname: host,
        port: Number(port) || 4789,
        path: '/api/info',
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish({
              app: parsed.app,
              version: parsed.version,
              nodeName: parsed.nodeName
            });
          } catch {
            finish(null);
          }
        });
      }
    );

    req.once('timeout', () => {
      req.destroy();
      finish(null);
    });

    req.once('error', () => {
      finish(null);
    });
  });
}

/**
 * Probes key services on a peer (Esteban Cloud HTTP, SMB, RDP, SSH) and queries /api/info.
 */
async function diagnosePeerConnection({ host, port = 4789, timeoutMs = 2000 } = {}) {
  if (!host || typeof host !== 'string' || !host.trim()) {
    throw new Error('Se requiere un host o dirección IP válida.');
  }
  const cleanHost = host.trim();
  const cloudPort = Number(port) || 4789;

  const targets = [
    { port: cloudPort, service: 'Esteban Cloud (HTTP/WebDAV/Chat)' },
    { port: 445, service: 'Compartición Windows SMB (\\\\IP\\)' },
    { port: 3389, service: 'Escritorio Remoto Windows (RDP)' },
    { port: 22, service: 'OpenSSH Server (SFTP/SSH)' }
  ];

  const [probeResults, appInfo] = await Promise.all([
    Promise.all(
      targets.map(async (t) => {
        const res = await checkTcpPort(cleanHost, t.port, timeoutMs);
        return {
          ...res,
          service: t.service
        };
      })
    ),
    fetchPeerAppInfo(cleanHost, cloudPort, timeoutMs)
  ]);

  return {
    host: cleanHost,
    timestamp: new Date().toISOString(),
    online: Boolean(probeResults.some((p) => p.open)),
    appInfo,
    ports: probeResults
  };
}

/**
 * Walks shared folders to provide fast search, largest file rankings, and duplicate detection.
 */
function scanSharedStorage({
  shares = [],
  query = '',
  maxFiles = 1500,
  topLimit = 25
} = {}) {
  const allFiles = [];
  let totalScannedBytes = 0;

  const walkShareDir = (share, currentDir, depth) => {
    if (depth > 5 || allFiles.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (allFiles.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walkShareDir(share, path.join(currentDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const fullPath = path.join(currentDir, entry.name);
        let st;
        try {
          st = fs.statSync(fullPath);
        } catch {
          continue;
        }
        const relPath = path.relative(share.path, fullPath);
        totalScannedBytes += st.size;
        allFiles.push({
          name: entry.name,
          relPath,
          fullPath,
          shareId: share.id,
          shareName: share.name,
          size: st.size,
          mtime: st.mtime.toISOString(),
          ext: path.extname(entry.name).toLowerCase()
        });
      }
    }
  };

  if (Array.isArray(shares)) {
    for (const share of shares) {
      if (!share || !share.path || share.enabled === false) continue;
      if (allFiles.length >= maxFiles) break;
      try {
        if (fs.existsSync(share.path) && fs.statSync(share.path).isDirectory()) {
          walkShareDir(share, share.path, 0);
        }
      } catch {
        continue;
      }
    }
  }

  const cleanQuery = String(query || '').trim().toLowerCase();
  let matches;
  if (cleanQuery) {
    matches = allFiles
      .filter(
        (f) =>
          f.name.toLowerCase().includes(cleanQuery) ||
          f.relPath.toLowerCase().includes(cleanQuery)
      )
      .slice(0, 100);
  } else {
    matches = [...allFiles]
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
      .slice(0, 50);
  }

  const largestFiles = [...allFiles]
    .sort((a, b) => b.size - a.size)
    .slice(0, topLimit);

  const dupGroups = new Map();
  for (const file of allFiles) {
    if (file.size <= 1024) continue;
    const key = `${file.name.toLowerCase()}::${file.size}`;
    let group = dupGroups.get(key);
    if (!group) {
      group = [];
      dupGroups.set(key, group);
    }
    group.push(file);
  }

  const potentialDuplicates = [];
  for (const [key, files] of dupGroups.entries()) {
    if (files.length >= 2) {
      const size = files[0].size;
      const count = files.length;
      potentialDuplicates.push({
        key,
        name: files[0].name,
        size,
        count,
        wastedBytes: size * (count - 1),
        files
      });
    }
  }
  potentialDuplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);

  return {
    totalScannedFiles: allFiles.length,
    totalScannedBytes,
    matches,
    largestFiles,
    potentialDuplicates
  };
}

/**
 * Streams a file and computes both SHA-256 and MD5 in uppercase hex.
 */
function computeFileHashSummary(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof filePath !== 'string') {
      return reject(new Error('Ruta de archivo inválida.'));
    }
    let st;
    try {
      st = fs.statSync(filePath);
      if (!st.isFile()) {
        return reject(new Error('La ruta especificada no es un archivo.'));
      }
    } catch (err) {
      return reject(err);
    }

    const sha256 = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      sha256.update(chunk);
      md5.update(chunk);
    });

    stream.on('error', (err) => {
      reject(err);
    });

    stream.on('end', () => {
      resolve({
        filePath,
        fileName: path.basename(filePath),
        size: st.size,
        sha256: sha256.digest('hex').toUpperCase(),
        md5: md5.digest('hex').toUpperCase(),
        mtime: st.mtime.toISOString()
      });
    });
  });
}

/**
 * Pure Node fast recursive folder sync with optional mirror deletion.
 */
function runFolderSync({ sourceDir, targetDir, mirror = false } = {}) {
  if (!sourceDir || typeof sourceDir !== 'string' || !fs.existsSync(sourceDir)) {
    throw new Error('La carpeta de origen no existe.');
  }
  const srcStatRoot = fs.statSync(sourceDir);
  if (!srcStatRoot.isDirectory()) {
    throw new Error('La ruta de origen no es un directorio.');
  }
  if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('Debes especificar una carpeta de destino válida.');
  }

  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedSource.toLowerCase() === resolvedTarget.toLowerCase()) {
    throw new Error('La carpeta de origen y destino no pueden ser la misma.');
  }

  const startTime = Date.now();
  fs.mkdirSync(resolvedTarget, { recursive: true });

  let filesCopied = 0;
  let filesSkipped = 0;
  let filesDeleted = 0;
  let bytesCopied = 0;

  const SKIP_SYNC_DIRS = new Set(['.git', 'node_modules']);

  const countAndRemoveTargetTree = (dirPath) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        countAndRemoveTargetTree(full);
      } else {
        try {
          fs.unlinkSync(full);
          filesDeleted += 1;
        } catch {
          // ignore
        }
      }
    }
    try {
      fs.rmdirSync(dirPath);
    } catch {
      // ignore
    }
  };

  const syncRecursive = (srcCurrent, dstCurrent) => {
    fs.mkdirSync(dstCurrent, { recursive: true });
    const srcEntries = fs.readdirSync(srcCurrent, { withFileTypes: true });
    const srcNames = new Set();

    for (const entry of srcEntries) {
      if (SKIP_SYNC_DIRS.has(entry.name)) continue;
      srcNames.add(entry.name);

      const srcPath = path.join(srcCurrent, entry.name);
      const dstPath = path.join(dstCurrent, entry.name);

      if (entry.isDirectory()) {
        syncRecursive(srcPath, dstPath);
      } else if (entry.isFile()) {
        const srcStat = fs.statSync(srcPath);
        let shouldCopy = true;
        if (fs.existsSync(dstPath)) {
          try {
            const dstStat = fs.statSync(dstPath);
            if (
              dstStat.isFile() &&
              dstStat.size === srcStat.size &&
              Math.abs(srcStat.mtimeMs - dstStat.mtimeMs) <= 1000
            ) {
              shouldCopy = false;
            }
          } catch {
            shouldCopy = true;
          }
        }

        if (shouldCopy) {
          fs.copyFileSync(srcPath, dstPath);
          try {
            fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime);
          } catch {
            // ignore utimes issues on restricted FS
          }
          filesCopied += 1;
          bytesCopied += srcStat.size;
        } else {
          filesSkipped += 1;
        }
      }
    }

    if (mirror) {
      let dstEntries = [];
      try {
        dstEntries = fs.readdirSync(dstCurrent, { withFileTypes: true });
      } catch {
        dstEntries = [];
      }
      for (const dstEntry of dstEntries) {
        if (SKIP_SYNC_DIRS.has(dstEntry.name)) continue;
        if (!srcNames.has(dstEntry.name)) {
          const orphanPath = path.join(dstCurrent, dstEntry.name);
          if (dstEntry.isDirectory()) {
            countAndRemoveTargetTree(orphanPath);
          } else {
            try {
              fs.unlinkSync(orphanPath);
              filesDeleted += 1;
            } catch {
              // ignore
            }
          }
        }
      }
    }
  };

  syncRecursive(resolvedSource, resolvedTarget);

  return {
    ok: true,
    sourceDir,
    targetDir,
    mirror: Boolean(mirror),
    filesCopied,
    filesSkipped,
    filesDeleted,
    bytesCopied,
    durationMs: Math.max(0, Date.now() - startTime),
    completedAt: new Date().toISOString()
  };
}

/**
 * Persistent or in-memory clipboard history store (max 30 items).
 */
class ClipboardHistoryStore {
  constructor(filePath = null, maxItems = 30) {
    this.filePath = filePath;
    this.maxItems = maxItems;
    this.items = [];
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.items = parsed.slice(0, this.maxItems);
        }
      }
    } catch {
      this.items = [];
    }
  }

  _save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch {
      // ignore disk write error
    }
  }

  addItem({ text, senderNode = 'Local', pinned = false } = {}) {
    const cleanText = String(text ?? '').trim();
    if (!cleanText) return null;

    if (this.items.length > 0 && this.items[0].text === cleanText) {
      this.items[0].createdAt = new Date().toISOString();
      this.items[0].senderNode = senderNode || this.items[0].senderNode || 'Local';
      if (pinned) {
        this.items[0].pinned = true;
      }
      this._save();
      return this.items[0];
    }

    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'),
      text: cleanText,
      senderNode: String(senderNode || 'Local'),
      createdAt: new Date().toISOString(),
      pinned: Boolean(pinned)
    };

    this.items.unshift(item);
    if (this.items.length > this.maxItems) {
      this.items = this.items.slice(0, this.maxItems);
    }
    this._save();
    return item;
  }

  listItems() {
    return [...this.items];
  }

  removeItem(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) {
      this._save();
    }
    return this.items;
  }

  clear() {
    this.items = this.items.filter((item) => Boolean(item.pinned));
    this._save();
    return this.items;
  }
}

module.exports = {
  scanAllAvailableKeys,
  checkTcpPort,
  diagnosePeerConnection,
  scanSharedStorage,
  computeFileHashSummary,
  runFolderSync,
  ClipboardHistoryStore
};
