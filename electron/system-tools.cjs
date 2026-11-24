'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, ...opts }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      });
    });
  });
}

function getNetworkAddresses() {
  const ifaces = os.networkInterfaces();
  let lanIp = '';
  let tailscaleIp = '';
  const all = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      all.push({ name, address: addr.address });
      // Tailscale CGNAT range 100.64.0.0/10 -> 100.64.x.x - 100.127.x.x
      const parts = addr.address.split('.').map(Number);
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
        if (!tailscaleIp) tailscaleIp = addr.address;
      } else if (!lanIp) {
        lanIp = addr.address;
      }
    }
  }
  return { lanIp, tailscaleIp, all };
}

async function commandExists(cmd) {
  const res = await execFileAsync('where.exe', [cmd]);
  if (res.ok && res.stdout) {
    return res.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}

async function detectRclone() {
  let exe = await commandExists('rclone');
  if (!exe) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidates = [
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'rclone.exe'),
      'C:\\Program Files\\rclone\\rclone.exe',
      'C:\\rclone\\rclone.exe'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        exe = c;
        break;
      }
    }
  }
  return { installed: Boolean(exe), path: exe || '' };
}

async function detectTailscale() {
  let exe = await commandExists('tailscale');
  if (!exe) {
    const candidates = [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        exe = c;
        break;
      }
    }
  }
  const net = getNetworkAddresses();
  if (!exe) {
    return { installed: false, running: false, ip: net.tailscaleIp || '', dnsName: '', peers: [] };
  }
  const status = await execFileAsync(exe, ['status', '--json'], { timeout: 6000 });
  if (!status.ok || !status.stdout) {
    return { installed: true, exe, running: Boolean(net.tailscaleIp), ip: net.tailscaleIp || '', dnsName: '', peers: [] };
  }
  try {
    const data = JSON.parse(status.stdout);
    const selfIps = (data.Self && data.Self.TailscaleIPs) || [];
    const ip4 = selfIps.find((ip) => !ip.includes(':')) || net.tailscaleIp || '';
    const dnsName = data.Self && data.Self.DNSName ? String(data.Self.DNSName).replace(/\.$/, '') : '';
    const peers = Object.values(data.Peer || {}).map((p) => ({
      hostName: p.HostName || '',
      dnsName: p.DNSName ? String(p.DNSName).replace(/\.$/, '') : '',
      ip: ((p.TailscaleIPs || []).find((ip) => !ip.includes(':'))) || '',
      online: Boolean(p.Online),
      os: p.OS || '',
      curAddr: p.CurAddr || '',
      relay: p.Relay || '',
      isDirect: Boolean(p.CurAddr)
    }));
    return {
      installed: true,
      exe,
      running: data.BackendState === 'Running',
      backendState: data.BackendState || '',
      ip: ip4,
      dnsName,
      peers
    };
  } catch {
    return { installed: true, exe, running: Boolean(net.tailscaleIp), ip: net.tailscaleIp || '', dnsName: '', peers: [] };
  }
}

async function detectWinFsp() {
  const paths = [
    'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll',
    'C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return { installed: true, path: p };
  }
  return { installed: false, path: '' };
}

async function detectOpenSshServer() {
  const res = await execFileAsync('powershell.exe', [
    '-NoProfile', '-Command',
    "$s = Get-Service -Name sshd -ErrorAction SilentlyContinue; if ($s) { Write-Output ($s.Status.ToString() + '|' + $s.StartType.ToString()) }"
  ]);
  if (res.ok && res.stdout) {
    const [status, startType] = res.stdout.split('|');
    return { installed: true, running: status === 'Running', status, startType };
  }
  return { installed: false, running: false, status: 'NotInstalled', startType: '' };
}

async function detectRemovableDrives() {
  const psScript = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$map = @{}",
    "Get-Disk | Where-Object { $_.BusType -eq 'USB' } | Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object {",
    "  $dl = $_.DriveLetter.ToString() + ':'",
    "  $v = Get-Volume -DriveLetter $_.DriveLetter",
    "  if ($v) { $map[$dl] = [PSCustomObject]@{ DeviceID=$dl; VolumeName=$v.FileSystemLabel; FreeSpace=$v.SizeRemaining; Size=$v.Size; Kind='USB' } }",
    "}",
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object {",
    "  if ($_.DeviceID -and -not $map.ContainsKey($_.DeviceID)) {",
    "    $map[$_.DeviceID] = [PSCustomObject]@{ DeviceID=$_.DeviceID; VolumeName=$_.VolumeName; FreeSpace=$_.FreeSpace; Size=$_.Size; Kind='Removable' }",
    "  }",
    "}",
    "@($map.Values | Sort-Object DeviceID) | ConvertTo-Json -Compress"
  ].join('; ');

  const res = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript]);
  if (!res.ok || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter(Boolean).map((d) => ({
      drive: d.DeviceID,
      root: `${d.DeviceID}\\`,
      label: d.VolumeName || 'Disco USB',
      freeBytes: Number(d.FreeSpace || 0),
      sizeBytes: Number(d.Size || 0)
    }));
  } catch {
    return [];
  }
}

async function checkEnvironment() {
  const [tailscale, rclone, winfsp, sshd, usbDrives] = await Promise.all([
    detectTailscale(),
    detectRclone(),
    detectWinFsp(),
    detectOpenSshServer(),
    detectRemovableDrives()
  ]);
  const net = getNetworkAddresses();
  return {
    hostName: os.hostname(),
    userName: os.userInfo().username,
    lanIp: net.lanIp,
    tailscale,
    rclone,
    winfsp,
    sshd,
    usbDrives
  };
}

class MountManager {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.mounts = new Map(); // driveLetter -> { drive, label, url, pid, proc, startedAt }
  }

  listMounts() {
    return Array.from(this.mounts.values()).map(({ proc, ...rest }) => rest);
  }

  async mountWebDav({ driveLetter, label, baseUrl, keyId, token }) {
    const rclone = await detectRclone();
    if (!rclone.installed) {
      throw new Error('rclone no está instalado. Usa el botón "Instalar dependencias" primero.');
    }
    const rcloneExe = rclone.path;
    const winfsp = await detectWinFsp();
    if (!winfsp.installed) {
      throw new Error('WinFsp no está instalado. Usa el botón "Instalar dependencias" primero.');
    }

    const cleanDrive = String(driveLetter || 'Z:').trim().toUpperCase().replace(/\\+$/, '');
    const normalizedDrive = cleanDrive.endsWith(':') ? cleanDrive : `${cleanDrive}:`;

    if (this.mounts.has(normalizedDrive)) {
      throw new Error(`La unidad ${normalizedDrive} ya está montada por Esteban Cloud.`);
    }

    const obs = await execFileAsync(rcloneExe, ['obscure', token]);
    if (!obs.ok || !obs.stdout) {
      throw new Error('No se pudo preparar la credencial cifrada para rclone.');
    }

    const webdavUrl = `${baseUrl.replace(/\/$/, '')}/webdav/`;
    const volName = String(label || 'EstebanCloud').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 28) || 'EstebanCloud';
    const args = [
      'mount', ':webdav:', normalizedDrive,
      '--webdav-url', webdavUrl,
      '--webdav-vendor', 'other',
      '--webdav-user', keyId || 'esteban-cloud',
      '--webdav-pass', obs.stdout,
      '--vfs-cache-mode', 'full',
      '--vfs-cache-max-size', '20G',
      '--vfs-cache-max-age', '24h',
      '--vfs-read-chunk-size', '16M',
      '--vfs-read-chunk-size-limit', '256M',
      '--vfs-read-chunk-streams', '8',
      '--buffer-size', '64M',
      '--vfs-read-ahead', '128M',
      '--transfers', '16',
      '--checkers', '32',
      '--vfs-fast-fingerprint',
      '--vfs-write-back', '1s',
      '--no-modtime',
      '--attr-timeout', '30s',
      '--dir-cache-time', '60s',
      '--network-mode',
      '--volname', volName,
      '--no-console'
    ];

    const proc = spawn(rcloneExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = {
      drive: normalizedDrive,
      label: volName,
      url: webdavUrl,
      pid: proc.pid,
      proc,
      startedAt: new Date().toISOString()
    };
    this.mounts.set(normalizedDrive, entry);

    let errBuf = '';
    proc.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) {
        errBuf += msg + '\n';
        this.onLog({ ts: new Date().toISOString(), level: 'info', message: `[rclone ${normalizedDrive}] ${msg}` });
      }
    });
    proc.on('exit', (code) => {
      this.mounts.delete(normalizedDrive);
      this.onLog({ ts: new Date().toISOString(), level: 'info', message: `Unidad ${normalizedDrive} desmontada (exit=${code}).` });
    });

    // Wait briefly to confirm it didn't immediately crash
    await new Promise((r) => setTimeout(r, 1400));
    if (!this.mounts.has(normalizedDrive)) {
      throw new Error(`rclone no pudo montar ${normalizedDrive}: ${errBuf || 'error desconocido'}`);
    }

    return { drive: normalizedDrive, label: volName, url: webdavUrl, pid: proc.pid };
  }

  async unmount(driveLetter) {
    const clean = String(driveLetter || '').trim().toUpperCase();
    const normalized = clean.endsWith(':') ? clean : `${clean}:`;
    const entry = this.mounts.get(normalized);
    if (!entry) return false;
    try {
      entry.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.mounts.delete(normalized);
    return true;
  }

  async unmountAll() {
    for (const drive of Array.from(this.mounts.keys())) {
      await this.unmount(drive);
    }
  }
}

function syncSshAuthorizedKeys(keys) {
  try {
    const sshDir = path.join(os.homedir(), '.ssh');
    const authFile = path.join(sshDir, 'authorized_keys');
    fs.mkdirSync(sshDir, { recursive: true });
    let existing = '';
    if (fs.existsSync(authFile)) {
      existing = fs.readFileSync(authFile, 'utf8');
    }
    const preserved = existing
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.includes('# esteban-cloud:'));

    const managed = (keys || [])
      .filter((k) => !k.revoked && k.sshPublicKey)
      .map((k) => `${k.sshPublicKey} # esteban-cloud:${k.keyId}`);

    const out = [...preserved, ...managed].join('\n') + (preserved.length || managed.length ? '\n' : '');
    fs.writeFileSync(authFile, out, 'utf8');
    return { ok: true, count: managed.length, path: authFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function launchElevatedInstaller(scriptPath, { port = 4789, installOpenSsh = false, disableSleep = false } = {}) {
  return new Promise((resolve) => {
    const logPath = path.join(os.tmpdir(), 'esteban-cloud-install.log');
    try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch {}
    const psArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', `"${scriptPath}"`,
      '-Port', String(port),
      '-LogPath', `"${logPath}"`
    ];
    if (installOpenSsh) psArgs.push('-InstallOpenSsh');
    if (disableSleep) psArgs.push('-DisableSleepAC');

    const cmd = `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '${psArgs.join(' ')}'`;
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, timeout: 600000 }, (error, stdout, stderr) => {
      let log = '';
      try {
        if (fs.existsSync(logPath)) log = fs.readFileSync(logPath, 'utf8');
      } catch {}
      resolve({
        ok: !error && log.includes('ESTEBAN_CLOUD_SETUP_OK'),
        log,
        error: error ? (stderr || error.message) : '',
        logPath
      });
    });
  });
}

module.exports = {
  getNetworkAddresses,
  checkEnvironment,
  detectRemovableDrives,
  MountManager,
  syncSshAuthorizedKeys,
  launchElevatedInstaller
};
