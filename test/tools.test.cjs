'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { generateKeyBundle } = require('../electron/crypto-keys.cjs');
const {
  scanAllAvailableKeys,
  checkTcpPort,
  diagnosePeerConnection,
  scanSharedStorage,
  computeFileHashSummary,
  runFolderSync,
  ClipboardHistoryStore,
  buildWakeOnLanPacket,
  saveAirDropFile,
  EncryptedVaultStore,
  encryptFileForUsb,
  decryptFileFromUsb
} = require('../electron/tools.cjs');

test('scanAllAvailableKeys discovers .ecloudkey bundles on USB/extraDirs and enriches from keyVault/authorizedKeys', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-keys-test-'));
  try {
    const usbRoot = path.join(tmpDir, 'usbE');
    const usbKitDir = path.join(usbRoot, 'Esteban-Cloud-Kit');
    const extraDir = path.join(tmpDir, 'extraKeys');
    fs.mkdirSync(usbKitDir, { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });

    const generated = generateKeyBundle({
      label: 'Llave Principal USB',
      permissions: 'rw',
      shareIds: ['*'],
      hostInfo: {
        nodeName: 'PC-ESTEBAN',
        tailscaleIp: '100.88.1.10',
        lanIp: '192.168.1.50',
        port: 4789
      },
      passphrase: 'mi-clave-secreta-123'
    });

    const usbFilePath = path.join(usbKitDir, `${generated.keyId}.ecloudkey`);
    const extraFilePath = path.join(extraDir, `${generated.keyId}.ecloudkey`);
    fs.writeFileSync(usbFilePath, generated.bundleJson, 'utf8');
    fs.writeFileSync(extraFilePath, generated.bundleJson, 'utf8');

    const keyVault = {
      [generated.keyId]: {
        keyId: generated.keyId,
        label: 'Llave Principal USB',
        passphrase: 'mi-clave-secreta-123',
        shareIds: ['*'],
        nodeName: 'PC-ESTEBAN'
      },
      'EC-MEM0-ONLY': {
        keyId: 'EC-MEM0-ONLY',
        label: 'Llave Solo Memoria',
        passphrase: 'pass-memoria-999',
        shareIds: ['share-docs']
      }
    };

    const authorizedKeys = [
      generated.hostRecord,
      {
        keyId: 'EC-MEM0-ONLY',
        label: 'Llave Solo Memoria',
        permissions: 'ro',
        shareIds: ['share-docs'],
        createdAt: '2025-01-01T00:00:00.000Z',
        revoked: false
      }
    ];

    const keys = scanAllAvailableKeys({
      usbDrives: [{ drive: 'E:', root: usbRoot }],
      extraDirs: [extraDir],
      keyVault,
      authorizedKeys
    });

    assert.equal(keys.length, 2);

    const diskKey = keys.find((k) => k.keyId === generated.keyId);
    assert.ok(diskKey, 'Debería encontrar la llave generada en disco');
    assert.equal(diskKey.passphrase, 'mi-clave-secreta-123');
    assert.equal(diskKey.isTotal, true);
    assert.equal(diskKey.isLocalHostKey, true);
    assert.equal(diskKey.revoked, false);
    assert.ok(diskKey.clipboardString.startsWith('ECLOUD1:'));
    assert.equal(diskKey.locations.length, 2);
    assert.equal(diskKey.usbLocations.length, 1);
    assert.equal(diskKey.usbLocations[0].drive, 'E:');

    const memKey = keys.find((k) => k.keyId === 'EC-MEM0-ONLY');
    assert.ok(memKey, 'Debería incluir llaves en authorizedKeys sin archivo en disco');
    assert.equal(memKey.passphrase, 'pass-memoria-999');
    assert.equal(memKey.isTotal, false);
    assert.deepEqual(memKey.locations, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('checkTcpPort and diagnosePeerConnection probe local ephemeral HTTP server', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          app: 'Esteban Cloud',
          version: '2.0.0',
          nodeName: 'TEST-NODE'
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const tcpRes = await checkTcpPort('127.0.0.1', port, 1500);
    assert.equal(tcpRes.port, port);
    assert.equal(tcpRes.open, true);
    assert.equal(typeof tcpRes.latencyMs, 'number');

    const diag = await diagnosePeerConnection({
      host: '127.0.0.1',
      port,
      timeoutMs: 1200
    });
    assert.equal(diag.host, '127.0.0.1');
    assert.equal(diag.online, true);
    assert.ok(diag.appInfo);
    assert.equal(diag.appInfo.app, 'Esteban Cloud');
    assert.equal(diag.appInfo.nodeName, 'TEST-NODE');
    assert.equal(diag.ports.length, 4);
    const cloudPortEntry = diag.ports.find((p) => p.port === port);
    assert.ok(cloudPortEntry);
    assert.equal(cloudPortEntry.open, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('scanSharedStorage and computeFileHashSummary index files, detect duplicates, and hash files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-storage-test-'));
  try {
    const shareA = path.join(tmpDir, 'shareA');
    const shareB = path.join(tmpDir, 'shareB');
    fs.mkdirSync(path.join(shareA, 'sub'), { recursive: true });
    fs.mkdirSync(shareB, { recursive: true });

    const dupContent = Buffer.alloc(2048, 'A');
    const uniqueContent = Buffer.from('Archivo unico de prueba para hash', 'utf8');

    const dupPath1 = path.join(shareA, 'backup.zip');
    const dupPath2 = path.join(shareB, 'backup.zip');
    const uniquePath = path.join(shareA, 'sub', 'notas.txt');

    fs.writeFileSync(dupPath1, dupContent);
    fs.writeFileSync(dupPath2, dupContent);
    fs.writeFileSync(uniquePath, uniqueContent);

    const shares = [
      { id: 's1', name: 'Carpeta A', path: shareA },
      { id: 's2', name: 'Carpeta B', path: shareB }
    ];

    const scanAll = scanSharedStorage({ shares, query: '' });
    assert.equal(scanAll.totalScannedFiles, 3);
    assert.equal(scanAll.totalScannedBytes, 2048 * 2 + uniqueContent.length);
    assert.equal(scanAll.largestFiles[0].size, 2048);
    assert.equal(scanAll.potentialDuplicates.length, 1);
    assert.equal(scanAll.potentialDuplicates[0].count, 2);
    assert.equal(scanAll.potentialDuplicates[0].wastedBytes, 2048);

    const scanFiltered = scanSharedStorage({ shares, query: 'notas' });
    assert.equal(scanFiltered.matches.length, 1);
    assert.equal(scanFiltered.matches[0].name, 'notas.txt');

    const hashSummary = await computeFileHashSummary(uniquePath);
    assert.equal(hashSummary.fileName, 'notas.txt');
    assert.equal(hashSummary.size, uniqueContent.length);
    assert.match(hashSummary.sha256, /^[0-9A-F]{64}$/);
    assert.match(hashSummary.md5, /^[0-9A-F]{32}$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runFolderSync performs incremental sync and mirror deletion, and ClipboardHistoryStore manages items', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-sync-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    const dstDir = path.join(tmpDir, 'dst');
    fs.mkdirSync(path.join(srcDir, 'nested'), { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hola mundo');
    fs.writeFileSync(path.join(srcDir, 'nested', 'b.txt'), 'segundo archivo');
    fs.writeFileSync(path.join(dstDir, 'orphan.txt'), 'debe borrarse en mirror');

    // First sync without mirror
    const res1 = runFolderSync({ sourceDir: srcDir, targetDir: dstDir, mirror: false });
    assert.equal(res1.ok, true);
    assert.equal(res1.filesCopied, 2);
    assert.equal(res1.filesDeleted, 0);
    assert.ok(fs.existsSync(path.join(dstDir, 'orphan.txt')));

    // Second sync with mirror: true (should skip 2 unchanged files and delete 1 orphan file)
    const res2 = runFolderSync({ sourceDir: srcDir, targetDir: dstDir, mirror: true });
    assert.equal(res2.ok, true);
    assert.equal(res2.filesCopied, 0);
    assert.equal(res2.filesSkipped, 2);
    assert.equal(res2.filesDeleted, 1);
    assert.equal(fs.existsSync(path.join(dstDir, 'orphan.txt')), false);

    // ClipboardHistoryStore test
    const clipFile = path.join(tmpDir, 'clipboard.json');
    const store = new ClipboardHistoryStore(clipFile, 30);

    const item1 = store.addItem({ text: '  texto 1  ', senderNode: 'Nodo-A', pinned: true });
    assert.equal(item1.text, 'texto 1');
    assert.equal(item1.pinned, true);

    const item2 = store.addItem({ text: 'texto 2', senderNode: 'Nodo-B', pinned: false });
    assert.equal(store.listItems().length, 2);

    // Deduplicate top item
    store.addItem({ text: 'texto 2', senderNode: 'Nodo-B' });
    assert.equal(store.listItems().length, 2);

    // Clear removes non-pinned items only
    store.clear();
    const afterClear = store.listItems();
    assert.equal(afterClear.length, 1);
    assert.equal(afterClear[0].id, item1.id);

    // Reload from disk verifies persistence
    const storeReloaded = new ClipboardHistoryStore(clipFile, 30);
    assert.equal(storeReloaded.listItems().length, 1);

    storeReloaded.removeItem(item1.id);
    assert.equal(storeReloaded.listItems().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildWakeOnLanPacket builds a valid 102-byte Magic Packet and rejects invalid MAC addresses', () => {
  const pkt = buildWakeOnLanPacket('AA:BB:CC:DD:EE:FF');
  assert.ok(Buffer.isBuffer(pkt));
  assert.equal(pkt.length, 102);

  // First 6 bytes must be 0xFF
  for (let i = 0; i < 6; i += 1) {
    assert.equal(pkt[i], 0xff);
  }

  // Next 16 repetitions of 6 bytes must equal AA BB CC DD EE FF
  const expectedMac = Buffer.from('AABBCCDDEEFF', 'hex');
  for (let rep = 0; rep < 16; rep += 1) {
    const slice = pkt.subarray(6 + rep * 6, 6 + (rep + 1) * 6);
    assert.deepEqual(slice, expectedMac);
  }

  // Dash-separated format also works
  const pktDash = buildWakeOnLanPacket('11-22-33-44-55-66');
  assert.equal(pktDash.length, 102);

  assert.throws(() => buildWakeOnLanPacket('invalid-mac'), /MAC/i);
});

test('saveAirDropFile writes base64 payload and avoids filename collisions with -(1)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-airdrop-test-'));
  try {
    const payload1 = Buffer.from('Contenido AirDrop 1', 'utf8');
    const payload2 = Buffer.from('Contenido AirDrop 2 distinto', 'utf8');

    const res1 = saveAirDropFile({
      fileName: '../reporte.txt',
      dataBase64: payload1.toString('base64'),
      senderNode: 'EstebanPcDELL',
      targetDir: tmpDir
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.fileName, 'reporte.txt');
    assert.equal(res1.size, payload1.length);
    assert.equal(res1.senderNode, 'EstebanPcDELL');
    assert.deepEqual(fs.readFileSync(res1.savedPath), payload1);

    // Second file with same name should be saved as reporte-(1).txt
    const res2 = saveAirDropFile({
      fileName: 'reporte.txt',
      dataBase64: `data:text/plain;base64,${payload2.toString('base64')}`,
      senderNode: 'Celular',
      targetDir: tmpDir
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.fileName, 'reporte-(1).txt');
    assert.equal(res2.size, payload2.length);
    assert.deepEqual(fs.readFileSync(res2.savedPath), payload2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('EncryptedVaultStore encrypts secrets and notes at rest with AES-256-GCM and supports CRUD + P2P sync', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-vault-test-'));
  try {
    const vaultFile = path.join(tmpDir, 'secret-vault.json');
    const vault = new EncryptedVaultStore(vaultFile);

    const created = vault.upsertItem({
      title: 'Licencia Windows 11 Pro',
      category: 'license',
      username: 'esteban@visualcorp.com',
      secret: 'XXXXX-YYYYY-ZZZZZ-12345',
      notes: 'Nota super confidencial en bóveda'
    });

    assert.ok(created.id);
    assert.equal(created.title, 'Licencia Windows 11 Pro');
    assert.equal(created.secret, 'XXXXX-YYYYY-ZZZZZ-12345');

    // Verify on-disk file does NOT contain plaintext secret or notes
    const rawDiskText = fs.readFileSync(vaultFile, 'utf8');
    assert.equal(rawDiskText.includes('XXXXX-YYYYY-ZZZZZ-12345'), false);
    assert.equal(rawDiskText.includes('Nota super confidencial en bóveda'), false);
    assert.equal(rawDiskText.includes('ECVAULT1:'), true);

    // Reload from disk and verify listItems decrypts accurately
    const reloaded = new EncryptedVaultStore(vaultFile);
    const items = reloaded.listItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, created.id);
    assert.equal(items[0].secret, 'XXXXX-YYYYY-ZZZZZ-12345');
    assert.equal(items[0].notes, 'Nota super confidencial en bóveda');

    // Update existing item
    reloaded.upsertItem({
      id: created.id,
      title: 'Licencia Windows 11 Enterprise',
      category: 'license',
      username: 'esteban@visualcorp.com',
      secret: 'NUEVO-SERIAL-99999',
      notes: 'Actualizada'
    });
    assert.equal(reloaded.listItems().length, 1);
    assert.equal(reloaded.listItems()[0].secret, 'NUEVO-SERIAL-99999');

    // Test exportEncryptedJson & importEncryptedJson into second vault instance
    const exportedJson = reloaded.exportEncryptedJson();
    const peerVault = new EncryptedVaultStore(path.join(tmpDir, 'peer-vault.json'));
    const importRes = peerVault.importEncryptedJson(exportedJson);
    assert.equal(importRes.ok, true);
    assert.equal(importRes.mergedCount, 1);
    assert.equal(peerVault.listItems()[0].secret, 'NUEVO-SERIAL-99999');

    // Delete item
    reloaded.deleteItem(created.id);
    assert.equal(reloaded.listItems().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('encryptFileForUsb and decryptFileFromUsb round-trip a file and reject wrong passphrases', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecloud-usbcrypto-test-'));
  try {
    const srcFile = path.join(tmpDir, 'contrato-privado.txt');
    const encFile = path.join(tmpDir, 'contrato-privado.txt.ecloudenc');
    const decFile = path.join(tmpDir, 'contrato-restaurado.txt');
    const originalData = Buffer.from(
      'Contrato confidencial de Esteban Cloud cifrado con PBKDF2 + AES-256-GCM.',
      'utf8'
    );
    fs.writeFileSync(srcFile, originalData);

    const encRes = encryptFileForUsb({
      filePath: srcFile,
      passphrase: 'Clave-USB-Segura-2026',
      outputPath: encFile
    });
    assert.equal(encRes.ok, true);
    assert.equal(encRes.outputPath, encFile);
    assert.ok(fs.existsSync(encFile));

    // Verify encrypted file starts with magic header ECENC1 and hides plaintext
    const rawEncrypted = fs.readFileSync(encFile);
    assert.equal(rawEncrypted.subarray(0, 6).toString('ascii'), 'ECENC1');
    assert.equal(rawEncrypted.includes(Buffer.from('Contrato confidencial')), false);

    // Wrong passphrase must fail authentication tag verification
    assert.throws(
      () =>
        decryptFileFromUsb({
          filePath: encFile,
          passphrase: 'Clave-Incorrecta-000',
          outputPath: decFile
        }),
      /contraseña|incorrecta|alterado/i
    );

    // Correct passphrase restores exact original bytes
    const decRes = decryptFileFromUsb({
      filePath: encFile,
      passphrase: 'Clave-USB-Segura-2026',
      outputPath: decFile
    });
    assert.equal(decRes.ok, true);
    assert.equal(decRes.outputPath, decFile);
    assert.equal(decRes.size, originalData.length);
    assert.deepEqual(fs.readFileSync(decFile), originalData);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
