'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { generateKeyBundle, decryptKeyBundle, verifyTokenHash } = require('../electron/crypto-keys.cjs');
const { ConfigStore } = require('../electron/config-store.cjs');
const { EstebanCloudServer, safeResolvePath } = require('../electron/server.cjs');
const { exportPendriveKit } = require('../electron/kit-exporter.cjs');
const {
  turboDownloadFile,
  selectFastestBaseUrl,
  httpAgent,
  httpsAgent
} = require('../electron/turbo-transfer.cjs');
const {
  compareSemver,
  downloadFileWithProgress,
  parseGitHubReleaseAsset,
  fetchGitHubLatestRelease,
  selectBestUpdateCandidate
} = require('../electron/updater.cjs');

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    r.on('error', reject);
    if (body !== null) r.write(body);
    r.end();
  });
}

test('crypto-keys: AES-256-GCM + Ed25519 encrypt/decrypt and tamper detection', () => {
  const gen = generateKeyBundle({
    label: 'Pendrive Test',
    permissions: 'rw',
    shareIds: ['*'],
    hostInfo: { nodeName: 'PRO-NICOLA', tailscaleIp: '100.64.0.10', lanIp: '192.168.1.7', port: 4789 },
    passphrase: 'mi-clave-super-segura'
  });

  assert.match(gen.keyId, /^EC-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(gen.hostRecord.sshPublicKey.startsWith('ssh-ed25519 '));
  assert.ok(gen.clipboardString.startsWith('ECLOUD1:'));
  assert.equal(gen.hostRecord.token, undefined, 'Host record must never store plaintext token');

  const dec1 = decryptKeyBundle(gen.bundleJson, 'mi-clave-super-segura');
  const dec2 = decryptKeyBundle(gen.clipboardString, 'mi-clave-super-segura');
  assert.equal(dec1.keyId, gen.keyId);
  assert.equal(dec2.token, dec1.token);
  assert.ok(verifyTokenHash(dec1.token, gen.hostRecord.tokenHash));

  assert.throws(() => decryptKeyBundle(gen.bundleJson, 'clave-incorrecta'), /incorrecta/i);

  const tampered = JSON.parse(gen.bundleJson);
  tampered.ciphertext = Buffer.from('tampered-data').toString('base64');
  assert.throws(() => decryptKeyBundle(tampered, 'mi-clave-super-segura'));
});

test('safeResolvePath blocks path traversal', () => {
  const root = path.join(os.tmpdir(), 'ec-root-check');
  assert.ok(safeResolvePath(root, 'sub/file.txt').startsWith(path.resolve(root)));
  assert.throws(() => safeResolvePath(root, '../../etc/passwd'));
  assert.throws(() => safeResolvePath(root, '..\\..\\Windows\\win.ini'));
});

test('EstebanCloudServer end-to-end: PWA, unlock, RW/RO, traversal, revocation, WebDAV', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteban-cloud-test-'));
  const shareRwDir = path.join(tmpDir, 'EstebanShare');
  const shareRoDir = path.join(tmpDir, 'AimeShare');
  fs.mkdirSync(shareRwDir, { recursive: true });
  fs.mkdirSync(shareRoDir, { recursive: true });
  fs.writeFileSync(path.join(shareRwDir, 'hola.txt'), 'Hola Esteban Cloud!', 'utf8');
  fs.writeFileSync(path.join(shareRoDir, 'doc.txt'), 'Solo lectura', 'utf8');

  const store = new ConfigStore(path.join(tmpDir, 'config.json'));
  store.data.shares = [];
  const s1 = store.addShare({ name: 'Esteban Nicola', folderPath: shareRwDir, mode: 'rw' });
  const s2 = store.addShare({ name: 'Aime Nicola', folderPath: shareRoDir, mode: 'ro' });

  const rwKey = generateKeyBundle({
    label: 'Esteban RW',
    permissions: 'rw',
    shareIds: ['*'],
    hostInfo: { nodeName: 'TEST-NODE', port: 0 },
    passphrase: 'pass-esteban'
  });
  const roKey = generateKeyBundle({
    label: 'Aime RO',
    permissions: 'ro',
    shareIds: [s2.id],
    hostInfo: { nodeName: 'TEST-NODE', port: 0 },
    passphrase: 'pass-aime'
  });
  store.addKeyRecord(rwKey.hostRecord);
  store.addKeyRecord(roKey.hostRecord);

  const rwPayload = decryptKeyBundle(rwKey.bundleJson, 'pass-esteban');
  const roPayload = decryptKeyBundle(roKey.bundleJson, 'pass-aime');

  const srv = new EstebanCloudServer(store);
  const { port } = await srv.start({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Mobile PWA & manifest
    const pwa = await req(`${base}/`);
    assert.equal(pwa.status, 200);
    assert.match(pwa.text, /Esteban Cloud/);
    const manifest = await req(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);

    // 2. Unauthenticated blocked
    const unauth = await req(`${base}/api/shares`);
    assert.equal(unauth.status, 401);

    // 3. Unlock via encrypted bundle (Android PWA flow)
    const unlockRes = await req(`${base}/api/auth/unlock-bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle: rwKey.clipboardString, passphrase: 'pass-esteban' })
    });
    assert.equal(unlockRes.status, 200);
    assert.equal(unlockRes.json.shares.length, 2);
    const cookie = (unlockRes.headers['set-cookie'] || [])[0].split(';')[0];

    // 4. List + Range download via session cookie
    const listRes = await req(`${base}/api/files?share=${s1.id}`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.items[0].name, 'hola.txt');

    const rangeRes = await req(`${base}/api/download?share=${s1.id}&path=hola.txt`, {
      headers: { Cookie: cookie, Range: 'bytes=0-3' }
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.text, 'Hola');

    // 5. Upload, mkdir, delete on RW share
    const upRes = await req(`${base}/api/upload?share=${s1.id}&path=&name=subido.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rwPayload.token}` },
      body: 'Contenido subido remotamente'
    });
    assert.equal(upRes.status, 201);
    assert.equal(fs.readFileSync(path.join(shareRwDir, 'subido.txt'), 'utf8'), 'Contenido subido remotamente');

    const mkdirRes = await req(`${base}/api/mkdir`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rwPayload.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ share: s1.id, path: '', name: 'NuevaCarpeta' })
    });
    assert.equal(mkdirRes.status, 201);
    assert.ok(fs.existsSync(path.join(shareRwDir, 'NuevaCarpeta')));

    const delRes = await req(`${base}/api/file?share=${s1.id}&path=subido.txt`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${rwPayload.token}` }
    });
    assert.equal(delRes.status, 200);
    assert.ok(!fs.existsSync(path.join(shareRwDir, 'subido.txt')));

    // 6. RO key restricted to s2 only and cannot write
    const roShares = await req(`${base}/api/shares`, { headers: { Authorization: `Bearer ${roPayload.token}` } });
    assert.equal(roShares.json.shares.length, 1);
    assert.equal(roShares.json.shares[0].id, s2.id);

    const roWrite = await req(`${base}/api/upload?share=${s2.id}&path=&name=nope.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${roPayload.token}` },
      body: 'blocked'
    });
    assert.equal(roWrite.status, 403);

    // 7. Path traversal blocked
    const trav = await req(`${base}/api/download?share=${s1.id}&path=../../config.json`, {
      headers: { Authorization: `Bearer ${rwPayload.token}` }
    });
    assert.equal(trav.status, 403);

    // 8. WebDAV (for rclone mount Z:)
    const basicAuth = 'Basic ' + Buffer.from(`${rwPayload.keyId}:${rwPayload.token}`).toString('base64');
    const davOpt = await req(`${base}/webdav/`, { method: 'OPTIONS', headers: { Authorization: basicAuth } });
    assert.equal(davOpt.status, 200);

    const davProp = await req(`${base}/webdav/`, { method: 'PROPFIND', headers: { Authorization: basicAuth, Depth: '1' } });
    assert.equal(davProp.status, 207);
    assert.match(davProp.text, /Esteban%20Nicola/);

    const davPut = await req(`${base}/webdav/Esteban%20Nicola/dav-file.txt`, {
      method: 'PUT',
      headers: { Authorization: basicAuth },
      body: 'Escrito via WebDAV!'
    });
    assert.equal(davPut.status, 201);
    assert.equal(fs.readFileSync(path.join(shareRwDir, 'dav-file.txt'), 'utf8'), 'Escrito via WebDAV!');

    const davDel = await req(`${base}/webdav/Esteban%20Nicola/dav-file.txt`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth }
    });
    assert.equal(davDel.status, 204);

    // 9. Instant revocation blocks token immediately
    store.revokeKey(rwKey.keyId);
    const afterRevoke = await req(`${base}/api/shares`, { headers: { Authorization: `Bearer ${rwPayload.token}` } });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await srv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('kit-exporter: builds self-contained Pendrive Kit with installer, scripts, launchers and encrypted key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteban-cloud-kit-test-'));
  const fakeInstaller = path.join(tmpDir, 'Esteban-Cloud-Setup-0.1.2.exe');
  const fakeScripts = path.join(tmpDir, 'scripts');
  const fakeUsb = path.join(tmpDir, 'USB_Drive');
  fs.mkdirSync(fakeScripts, { recursive: true });
  fs.mkdirSync(fakeUsb, { recursive: true });
  fs.writeFileSync(fakeInstaller, 'FAKE-EXE-CONTENT', 'utf8');
  fs.writeFileSync(path.join(fakeScripts, 'install-dependencies.ps1'), 'Write-Output OK', 'utf8');

  try {
    const gen = generateKeyBundle({
      label: 'Kit USB',
      permissions: 'rw',
      shareIds: ['*'],
      hostInfo: { nodeName: 'PRO-NICOLA', port: 4789 },
      passphrase: 'clave-kit-segura'
    });

    const res = await exportPendriveKit({
      targetDir: fakeUsb,
      installerPath: fakeInstaller,
      scriptsDir: fakeScripts,
      appVersion: '0.1.2',
      nodeName: 'PRO-NICOLA',
      keyFileName: 'Kit_USB.ecloudkey',
      keyBundleJson: gen.bundleJson,
      createZip: true
    });

    assert.ok(fs.existsSync(path.join(res.kitDir, 'Esteban-Cloud-Setup-0.1.2.exe')));
    assert.ok(fs.existsSync(path.join(res.kitDir, '1-INSTALAR-ESTEBAN-CLOUD.cmd')));
    assert.ok(fs.existsSync(path.join(res.kitDir, '2-INSTALAR-DEPENDENCIAS-ADMIN.cmd')));
    assert.ok(fs.existsSync(path.join(res.kitDir, 'scripts', 'install-dependencies.ps1')));
    assert.ok(fs.existsSync(path.join(res.kitDir, 'Kit_USB.ecloudkey')));
    assert.ok(fs.existsSync(path.join(res.kitDir, 'LEEME-PENDRIVE.txt')));
    assert.ok(fs.existsSync(res.zipPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('self-hosted updater: serves latest Setup exe with SHA-256 verification and semver compare', async () => {
  assert.equal(compareSemver('0.1.10', '0.1.5'), 1);
  assert.equal(compareSemver('0.1.5', '0.1.5'), 0);
  assert.equal(compareSemver('0.1.4', '0.1.5'), -1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteban-cloud-upd-test-'));
  const relDir = path.join(tmpDir, 'release');
  fs.mkdirSync(relDir, { recursive: true });
  const fakePayload = Buffer.from('ESTEBAN-CLOUD-FAKE-INSTALLER-9.9.9-PAYLOAD');
  fs.writeFileSync(path.join(relDir, 'Esteban-Cloud-Setup-9.9.9.exe'), fakePayload);

  const store = new ConfigStore(path.join(tmpDir, 'config.json'));
  store.data.updateShareDir = relDir;
  const rwKey = generateKeyBundle({ label: 'Updater RW', permissions: 'rw', shareIds: ['*'], hostInfo: {}, passphrase: 'pass-upd-rw' });
  const roKey = generateKeyBundle({ label: 'Updater RO', permissions: 'ro', shareIds: ['*'], hostInfo: {}, passphrase: 'pass-upd-ro' });
  store.addKeyRecord(rwKey.hostRecord);
  store.addKeyRecord(roKey.hostRecord);
  const rwTok = decryptKeyBundle(rwKey.bundleJson, 'pass-upd-rw').token;
  const roTok = decryptKeyBundle(roKey.bundleJson, 'pass-upd-ro').token;

  let notifiedPayload = null;
  const srv = new EstebanCloudServer(store, {
    onUpdateNotice: (info) => { notifiedPayload = info; }
  });
  const { port } = await srv.start({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${port}`;

  try {
    const latest = await req(`${base}/api/updates/latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.json.available, true);
    assert.equal(latest.json.version, '9.9.9');
    assert.equal(latest.json.fileName, 'Esteban-Cloud-Setup-9.9.9.exe');
    assert.ok(latest.json.sha256 && latest.json.sha256.length === 64);

    const dest = path.join(tmpDir, 'downloaded.exe');
    const dl = await downloadFileWithProgress(`${base}${latest.json.downloadPath}`, dest, {
      expectedSha256: latest.json.sha256
    });
    assert.equal(dl.sha256, latest.json.sha256);
    assert.deepEqual(fs.readFileSync(dest), fakePayload);

    // Reject tampered/wrong SHA-256
    await assert.rejects(
      () => downloadFileWithProgress(`${base}${latest.json.downloadPath}`, path.join(tmpDir, 'bad.exe'), {
        expectedSha256: '0'.repeat(64)
      }),
      /SHA-256/i
    );

    // Authenticated push notification: unauth 401, RO 403, RW 202
    const unauthPush = await req(`${base}/api/updates/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUrl: 'http://100.64.0.99:4789', version: '9.9.9' })
    });
    assert.equal(unauthPush.status, 401);

    const roPush = await req(`${base}/api/updates/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${roTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUrl: 'http://100.64.0.99:4789', version: '9.9.9' })
    });
    assert.equal(roPush.status, 403);

    const rwPush = await req(`${base}/api/updates/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rwTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUrl: 'http://100.64.0.99:4789', version: '9.9.9' })
    });
    assert.equal(rwPush.status, 202);
    assert.equal(notifiedPayload.version, '9.9.9');

    // Trusted mesh broadcast endpoint (/api/updates/mesh-broadcast) works without session token from mesh/localhost
    notifiedPayload = null;
    const meshPush = await req(`${base}/api/updates/mesh-broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUrl: 'http://100.64.0.99:4789', version: '9.9.10' })
    });
    assert.equal(meshPush.status, 202);
    assert.equal(notifiedPayload.version, '9.9.10');
    assert.equal(notifiedPayload.autoTriggered, true);
  } finally {
    await srv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('github releases updater: parses release, follows 302 redirect, verifies SHA-256 and selects highest semver', async () => {
  const crypto = require('node:crypto');
  const payload = Buffer.from('GITHUB-RELEASE-BINARY-ESTEBAN-CLOUD-0.3.0');
  const sha = crypto.createHash('sha256').update(payload).digest('hex').toUpperCase();

  // Candidate selection rules: higher SemVer wins across sources; ties prefer local > peer > github
  const pick1 = selectBestUpdateCandidate([
    { version: '0.2.0', sourceType: 'local' },
    { version: '0.2.1', sourceType: 'github' }
  ]);
  assert.equal(pick1.sourceType, 'github');
  assert.equal(pick1.version, '0.2.1');

  const pickTie = selectBestUpdateCandidate([
    { version: '0.2.1', sourceType: 'github' },
    { version: '0.2.1', sourceType: 'peer' },
    { version: '0.2.1', sourceType: 'local' }
  ]);
  assert.equal(pickTie.sourceType, 'local');

  // Native digest parsing
  const parsedNative = parseGitHubReleaseAsset({
    tag_name: 'v0.3.0',
    html_url: 'https://github.com/estebanico10/esteban-cloud/releases/tag/v0.3.0',
    assets: [
      {
        name: 'Esteban-Cloud-Setup-0.3.0.exe',
        size: payload.length,
        digest: `sha256:${sha.toLowerCase()}`,
        browser_download_url: 'https://example.test/download/setup.exe'
      }
    ]
  });
  assert.equal(parsedNative.version, '0.3.0');
  assert.equal(parsedNative.sha256, sha);

  // Mock GitHub API + 302 redirect + SHA256SUMS.txt companion file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteban-cloud-gh-test-'));
  const mockServer = http.createServer((request, response) => {
    const addr = mockServer.address();
    const origin = `http://127.0.0.1:${addr.port}`;
    if (request.url === '/repos/estebanico10/esteban-cloud/releases/latest') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        tag_name: 'v0.3.0',
        html_url: `${origin}/release-page`,
        body: 'Notas de la versión',
        assets: [
          {
            name: 'Esteban-Cloud-Setup-0.3.0.exe',
            size: payload.length,
            browser_download_url: `${origin}/redirect-asset`
          },
          {
            name: 'SHA256SUMS.txt',
            size: 120,
            browser_download_url: `${origin}/sums`
          }
        ]
      }));
      return;
    }
    if (request.url === '/sums') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`${sha}  Esteban-Cloud-Setup-0.3.0.exe\n`);
      return;
    }
    if (request.url === '/redirect-asset') {
      response.writeHead(302, { Location: `${origin}/final-cdn/Esteban-Cloud-Setup-0.3.0.exe` });
      response.end();
      return;
    }
    if (request.url === '/final-cdn/Esteban-Cloud-Setup-0.3.0.exe') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) });
      response.end(payload);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const rel = await fetchGitHubLatestRelease('estebanico10/esteban-cloud', { apiBaseUrl: apiBase });
    assert.equal(rel.version, '0.3.0');
    assert.equal(rel.sha256, sha);
    assert.equal(rel.fileName, 'Esteban-Cloud-Setup-0.3.0.exe');

    const dest = path.join(tmpDir, 'gh-setup.exe');
    const dl = await downloadFileWithProgress(rel.downloadUrl, dest, { expectedSha256: rel.sha256 });
    assert.equal(dl.sha256, sha);
    assert.deepEqual(fs.readFileSync(dest), payload);
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('electron/main.cjs: syntax valid and background timer functions are in top-level module scope', () => {
  const vm = require('node:vm');
  const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
  const code = fs.readFileSync(mainPath, 'utf8');

  // 1. Valid JS syntax check
  new vm.Script(code, { filename: 'main.cjs' });

  // 2. Verify critical functions called from top-level timers/callbacks are defined outside registerIpc()
  const regStart = code.indexOf('function registerIpc()');
  assert.ok(regStart > 0, 'registerIpc must exist');
  let depth = 0;
  let regEnd = -1;
  for (let i = code.indexOf('{', regStart); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) {
        regEnd = i;
        break;
      }
    }
  }
  assert.ok(regEnd > regStart, 'registerIpc closing brace found');
  const insideRegisterIpc = code.slice(regStart, regEnd + 1);

  for (const fnName of [
    'checkUpdatesCore',
    'applyInstallerAndRestart',
    'runAutoUpdateCycle',
    'broadcastUpdateToAllMeshPeers',
    'syncLocalReleaseToKitsAndMesh',
    'collectGlobalMetrics'
  ]) {
    assert.ok(
      !insideRegisterIpc.includes(`function ${fnName}`),
      `${fnName} must NOT be nested inside registerIpc()`
    );
    assert.ok(
      code.includes(`function ${fnName}`),
      `${fnName} must be defined at top level in main.cjs`
    );
  }
});

test('turbo-transfer: 8-stream parallel HTTP Range reconstruction (18 MB) & LAN route preference', async (t) => {
  const crypto = require('node:crypto');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-turbo-test-'));
  const totalBytes = 18 * 1024 * 1024;
  const payload = crypto.randomBytes(totalBytes);
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

  const rangeHeadersSeen = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/shares') {
      const body = JSON.stringify({ nodeName: 'TEST-HOST', key: { permissions: 'rw' }, shares: [{ id: 's1', name: 'Videos' }] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.url.startsWith('/api/download')) {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': totalBytes, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        rangeHeadersSeen.push(range);
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match && match[1] ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? Math.min(parseInt(match[2], 10), totalBytes - 1) : totalBytes - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': (end - start) + 1
        });
        return res.end(payload.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Length': totalBytes });
      return res.end(payload);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    try { httpAgent.destroy(); } catch {}
    try { httpsAgent.destroy(); } catch {}
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Test selectFastestBaseUrl prefers LAN over DNS/Tailscale when both respond
  const routeRes = await selectFastestBaseUrl(
    { lanIp: '127.0.0.1', tailscaleDns: 'localhost', port },
    'test-token',
    '',
    port
  );
  assert.equal(routeRes.baseUrl, baseUrl);
  assert.equal(routeRes.routeType, 'lan');
  assert.equal(routeRes.shares.length, 1);

  // 2. Test 8-stream parallel HTTP Range download & byte-exact SHA-256 reconstruction
  const destPath = path.join(tmpDir, 'reconstructed.mov');
  const progressEvents = [];
  const dlRes = await turboDownloadFile({
    baseUrl,
    token: 'test-token',
    shareId: 's1',
    relPath: 'video.mov',
    destPath,
    fileSize: 0,
    concurrency: 8,
    minParallelBytes: 4 * 1024 * 1024,
    onProgress: (p) => progressEvents.push(p)
  });

  assert.equal(dlRes.ok, true);
  assert.equal(dlRes.parallelStreams, 8);
  assert.equal(rangeHeadersSeen.length, 8);
  assert.ok(progressEvents.some((p) => p.status === 'completed' && p.percent === 100));

  const downloadedBuf = fs.readFileSync(destPath);
  assert.equal(downloadedBuf.length, totalBytes);
  const actualSha = crypto.createHash('sha256').update(downloadedBuf).digest('hex');
  assert.equal(actualSha, expectedSha);
});
