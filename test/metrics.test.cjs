'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_THRESHOLDS,
  getLocalMetrics,
  runDiskSpeedBenchmark,
  evaluateAlerts,
  aggregateGlobalMetrics
} = require('../electron/metrics.cjs');

test('DEFAULT_THRESHOLDS exposes expected defaults', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    cpuPercent: 85,
    ramPercent: 88,
    diskPercent: 90,
    diskBusyMBs: 180
  });
});

test('evaluateAlerts stays clean on normal values and ignores removable USB drives', () => {
  const normalMetrics = {
    cpu: { percent: 32.4, cores: 8, model: 'Test CPU' },
    ram: { totalBytes: 16e9, freeBytes: 8e9, usedBytes: 8e9, percent: 50 },
    disks: [
      { deviceId: 'C:', volumeName: 'OS', driveType: 3, isFixed: true, totalBytes: 500e9, freeBytes: 250e9, usedBytes: 250e9, percent: 50 },
      { deviceId: 'F:', volumeName: 'USB', driveType: 2, isFixed: false, totalBytes: 32e9, freeBytes: 1e9, usedBytes: 31e9, percent: 96.9 }
    ],
    storageSummary: { totalBytes: 500e9, freeBytes: 250e9, usedBytes: 250e9, percent: 50 },
    diskSpeed: { readMBs: 420, writeMBs: 310, liveMBs: 12.5, testedAt: null }
  };

  const result = evaluateAlerts(normalMetrics);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.isBusy, false);
  assert.equal(result.busyReason, '');
});

test('evaluateAlerts triggers on high CPU, RAM, fixed disk, and disk I/O with Spanish messages', () => {
  const overloadedMetrics = {
    cpu: { percent: 96.5, cores: 8, model: 'Test CPU' },
    ram: { totalBytes: 16e9, freeBytes: 1.4e9, usedBytes: 14.6e9, percent: 91.2 },
    disks: [
      { deviceId: 'C:', volumeName: 'Windows', driveType: 3, isFixed: true, totalBytes: 1000e9, freeBytes: 40e9, usedBytes: 960e9, percent: 96 },
      { deviceId: 'D:', volumeName: 'Datos', driveType: 3, isFixed: true, totalBytes: 1000e9, freeBytes: 600e9, usedBytes: 400e9, percent: 40 }
    ],
    diskSpeed: { readMBs: 500, writeMBs: 400, liveMBs: 210.4, testedAt: null }
  };

  const result = evaluateAlerts(overloadedMetrics);
  assert.equal(result.isBusy, true);
  assert.equal(result.alerts.length, 4);
  assert.ok(result.busyReason.length > 0);

  const byKind = Object.fromEntries(result.alerts.map((a) => [a.kind, a]));
  assert.equal(byKind.cpu.severity, 'critical');
  assert.equal(byKind.cpu.value, 96.5);
  assert.equal(byKind.cpu.threshold, 85);
  assert.match(byKind.cpu.message, /CPU/i);

  assert.equal(byKind.ram.severity, 'warn');
  assert.equal(byKind.ram.value, 91.2);
  assert.equal(byKind.ram.threshold, 88);
  assert.match(byKind.ram.message, /RAM/i);

  assert.equal(byKind.disk.severity, 'critical');
  assert.equal(byKind.disk.value, 96);
  assert.equal(byKind.disk.threshold, 90);
  assert.match(byKind.disk.message, /Disco C:/i);

  assert.equal(byKind.disk_io.severity, 'warn');
  assert.equal(byKind.disk_io.value, 210.4);
  assert.equal(byKind.disk_io.threshold, 180);
  assert.match(byKind.disk_io.message, /MB\/s/i);
});

test('runDiskSpeedBenchmark returns positive readMBs/writeMBs and cleans up temp file', async () => {
  const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-metrics-bench-'));
  try {
    const res = await runDiskSpeedBenchmark(benchDir);
    assert.equal(typeof res.writeMBs, 'number');
    assert.equal(typeof res.readMBs, 'number');
    assert.ok(res.writeMBs > 0, `expected writeMBs > 0, got ${res.writeMBs}`);
    assert.ok(res.readMBs > 0, `expected readMBs > 0, got ${res.readMBs}`);
    assert.equal(typeof res.testedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(res.testedAt)));

    const leftover = fs.readdirSync(benchDir).filter((f) => f.startsWith('.ec_disk_bench_'));
    assert.deepEqual(leftover, [], 'Temporary benchmark file must be deleted');
  } finally {
    fs.rmSync(benchDir, { recursive: true, force: true });
  }
});

test('getLocalMetrics returns valid CPU, RAM, disks, storageSummary, and diskSpeed', async () => {
  const metrics = await getLocalMetrics({ includeDiskBench: false });

  assert.equal(typeof metrics.nodeName, 'string');
  assert.ok(metrics.nodeName.length > 0);

  assert.equal(typeof metrics.cpu.percent, 'number');
  assert.ok(metrics.cpu.percent >= 0 && metrics.cpu.percent <= 100);
  assert.ok(metrics.cpu.cores >= 1);
  assert.equal(typeof metrics.cpu.model, 'string');

  assert.ok(metrics.ram.totalBytes > 0);
  assert.ok(metrics.ram.freeBytes >= 0);
  assert.ok(metrics.ram.usedBytes >= 0);
  assert.ok(metrics.ram.percent >= 0 && metrics.ram.percent <= 100);

  assert.ok(Array.isArray(metrics.disks));
  if (process.platform === 'win32') {
    assert.ok(metrics.disks.length >= 1, 'Expected at least one Windows logical disk');
    assert.ok(metrics.storageSummary.totalBytes > 0, 'Expected positive fixed storage totalBytes');
  }

  assert.equal(typeof metrics.storageSummary.totalBytes, 'number');
  assert.equal(typeof metrics.storageSummary.freeBytes, 'number');
  assert.equal(typeof metrics.storageSummary.usedBytes, 'number');
  assert.ok(metrics.storageSummary.percent >= 0 && metrics.storageSummary.percent <= 100);

  assert.equal(typeof metrics.diskSpeed.liveMBs, 'number');
  assert.ok(metrics.diskSpeed.liveMBs >= 0);
  assert.ok(metrics.diskSpeed.readMBs > 0, 'Expected cached readMBs from earlier benchmark');
  assert.ok(metrics.diskSpeed.writeMBs > 0, 'Expected cached writeMBs from earlier benchmark');
  assert.ok(Array.isArray(metrics.alerts));
  assert.equal(typeof metrics.isBusy, 'boolean');
  assert.equal(typeof metrics.busyReason, 'string');
});

test('aggregateGlobalMetrics sums storage across nodes and reports busyNodes accurately', () => {
  const GB = 1024 ** 3;

  const localMetrics = {
    nodeName: 'PC-PRINCIPAL',
    cpu: { percent: 20, cores: 8, model: 'Ryzen' },
    ram: { totalBytes: 16 * GB, freeBytes: 8 * GB, usedBytes: 8 * GB, percent: 50 },
    storageSummary: { totalBytes: 1000 * GB, freeBytes: 400 * GB, usedBytes: 600 * GB, percent: 60 },
    diskSpeed: { readMBs: 500, writeMBs: 350, liveMBs: 10, testedAt: '2026-11-23T00:00:00.000Z' },
    alerts: [],
    isBusy: false,
    busyReason: ''
  };

  const peerBusyMetrics = {
    nodeName: 'LAPTOP-ESTEBAN',
    cpu: { percent: 92, cores: 4, model: 'Intel' },
    ram: { totalBytes: 8 * GB, freeBytes: 2 * GB, usedBytes: 6 * GB, percent: 75 },
    storageSummary: { totalBytes: 500 * GB, freeBytes: 100 * GB, usedBytes: 400 * GB, percent: 80 },
    diskSpeed: { readMBs: 300, writeMBs: 200, liveMBs: 15, testedAt: '2026-11-23T00:00:00.000Z' }
  };

  const peerHealthyMetrics = {
    nodeName: 'NAS-CASA',
    cpu: { percent: 8, cores: 4, model: 'N100' },
    ram: { totalBytes: 16 * GB, freeBytes: 12 * GB, usedBytes: 4 * GB, percent: 25 },
    storageSummary: { totalBytes: 2000 * GB, freeBytes: 1500 * GB, usedBytes: 500 * GB, percent: 25 },
    diskSpeed: { readMBs: 200, writeMBs: 150, liveMBs: 5, testedAt: '2026-11-23T00:00:00.000Z' },
    alerts: [],
    isBusy: false,
    busyReason: ''
  };

  const peerResults = [
    {
      nodeName: 'LAPTOP-ESTEBAN',
      ip: '100.64.0.12',
      online: true,
      latencyMs: 14,
      version: '1.2.0',
      metrics: peerBusyMetrics,
      error: null
    },
    {
      nodeName: 'NAS-CASA',
      ip: '100.64.0.15',
      online: true,
      latencyMs: 8,
      version: '1.2.0',
      metrics: peerHealthyMetrics,
      error: null
    },
    {
      nodeName: 'PC-APAGADA',
      ip: '100.64.0.99',
      online: false,
      latencyMs: null,
      version: '',
      metrics: {
        storageSummary: { totalBytes: 999 * GB, freeBytes: 999 * GB, usedBytes: 0, percent: 0 },
        cpu: { percent: 99 },
        ram: { percent: 99 }
      },
      error: 'Sin conexión'
    }
  ];

  const tailscaleInfo = {
    installed: true,
    running: true,
    ip: '100.64.0.10',
    dnsName: 'pc-principal.tailnet.ts.net'
  };

  const global = aggregateGlobalMetrics(localMetrics, peerResults, tailscaleInfo);

  assert.equal(global.nodesTotal, 4);
  assert.equal(global.nodesOnline, 3);
  assert.equal(global.maxPlanDevices, 100);
  assert.equal(global.availableSlots, 96);

  // Local (1000 GB) + Laptop (500 GB) + NAS (2000 GB) = 3500 GB total; offline excluded
  assert.equal(global.globalStorage.totalBytes, 3500 * GB);
  assert.equal(global.globalStorage.freeBytes, 2000 * GB);
  assert.equal(global.globalStorage.usedBytes, 1500 * GB);
  assert.equal(global.globalStorage.percent, 42.9);

  // Average CPU: (20 + 92 + 8) / 3 = 40
  assert.equal(global.avgCpuPercent, 40);
  // Average RAM: (50 + 75 + 25) / 3 = 50
  assert.equal(global.avgRamPercent, 50);

  // Disk speeds sum: read = 500 + 300 + 200 = 1000, write = 350 + 200 + 150 = 700
  assert.equal(global.totalDiskReadMBs, 1000);
  assert.equal(global.totalDiskWriteMBs, 700);

  // Only LAPTOP-ESTEBAN is busy (CPU 92% >= 85%); offline PC-APAGADA is excluded
  assert.equal(global.busyNodes.length, 1);
  assert.equal(global.busyNodes[0].nodeName, 'LAPTOP-ESTEBAN');
  assert.match(global.busyNodes[0].busyReason, /CPU/i);
  assert.equal(global.busyNodes[0].alerts.length, 1);

  // nodes starts with local node followed by all peers
  assert.equal(global.nodes.length, 4);
  assert.equal(global.nodes[0].nodeName, 'PC-PRINCIPAL');
  assert.equal(global.nodes[0].isLocal, true);
  assert.equal(global.nodes[0].ip, '100.64.0.10');
  assert.equal(global.nodes[1].nodeName, 'LAPTOP-ESTEBAN');
  assert.equal(global.nodes[2].nodeName, 'NAS-CASA');
  assert.equal(global.nodes[3].nodeName, 'PC-APAGADA');
  assert.equal(global.nodes[3].online, false);
  assert.equal(global.nodes[3].error, 'Sin conexión');
});
