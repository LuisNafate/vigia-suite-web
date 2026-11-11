import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  md5Hex, sha256Hex, compareVersions, validateManifest, resolveFirmwareUrl, inspectEspImage,
  parsePartitionTable, checkReleaseImages, classifyProbe, verifyInstalledFirmware, parseJsonLine,
  usbBridgeInfo, releasesForChip, latestRelease,
} from '../pc-lab/firmware-core.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function espImage(chipId = 0, size = 64) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xe9; bytes[1] = 3; bytes[12] = chipId & 0xff; bytes[13] = chipId >> 8;
  return bytes;
}

function partitionTable(entries) {
  const bytes = new Uint8Array(0xc00).fill(0xff);
  const view = new DataView(bytes.buffer);
  entries.forEach((entry, index) => {
    const base = index * 32;
    bytes[base] = 0xaa; bytes[base + 1] = 0x50; bytes[base + 2] = entry.type; bytes[base + 3] = entry.subtype;
    view.setUint32(base + 4, entry.offset, true); view.setUint32(base + 8, entry.size, true);
    bytes.set(new TextEncoder().encode(entry.label), base + 12);
    view.setUint32(base + 28, 0, true);
  });
  return bytes;
}

function sampleRelease(overrides = {}) {
  return {
    version: '0.4.0-arduino', channel: 'stable', protocol: 2, chip: 'ESP32', minFlashSize: '4MB',
    flash: { mode: 'keep', freq: 'keep', size: 'keep' },
    files: [
      { type: 'bootloader', path: '0.4.0-arduino/bootloader.bin', offset: 0x1000, size: 64, sha256: 'a'.repeat(64) },
      { type: 'partition-table', path: '0.4.0-arduino/partitions.bin', offset: 0x8000, size: 0xc00, sha256: 'b'.repeat(64) },
      { type: 'otadata', path: '0.4.0-arduino/boot_app0.bin', offset: 0xe000, size: 0x2000, sha256: 'c'.repeat(64) },
      { type: 'app', path: '0.4.0-arduino/vigia-sensor.bin', offset: 0x10000, size: 64, sha256: 'd'.repeat(64) },
    ],
    ...overrides,
  };
}

test('md5Hex coincide con node:crypto en vectores RFC y datos aleatorios', () => {
  assert.equal(md5Hex(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  for (const size of [1, 55, 56, 63, 64, 65, 1000, 4096 + 7]) {
    const data = randomBytes(size);
    assert.equal(md5Hex(new Uint8Array(data)), createHash('md5').update(data).digest('hex'), `tamaño ${size}`);
  }
});

test('sha256Hex usa Web Crypto y coincide con node:crypto', async () => {
  const data = new Uint8Array(randomBytes(3000));
  assert.equal(await sha256Hex(data), sha(data));
});

test('compareVersions ignora el sufijo de compilación', () => {
  assert.equal(compareVersions('0.4.0-arduino', '0.4.0-arduino'), 0);
  assert.equal(compareVersions('0.3.9', '0.4.0-arduino'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
});

test('validateManifest acepta un manifiesto correcto', () => {
  const result = validateManifest({ schema: 'vigia-firmware-manifest/1', latest: '0.4.0-arduino', releases: [sampleRelease()] });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('validateManifest rechaza rutas peligrosas, solapamientos, chips y hashes inválidos', () => {
  const bad = sampleRelease({ chip: 'ESP32-S3' });
  bad.files[0].path = '../evil.bin';
  bad.files[1].offset = 0x1000;
  bad.files[2].sha256 = 'xyz';
  const result = validateManifest({ schema: 'vigia-firmware-manifest/1', latest: '9.9.9', releases: [bad] });
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /chip no soportado/);
  assert.match(text, /ruta no permitida/);
  assert.match(text, /se solapan/);
  assert.match(text, /SHA-256 inválido/);
  assert.match(text, /latest/);
});

test('validateManifest rechaza protocolo distinto y archivos fuera de la flash', () => {
  const release = sampleRelease({ protocol: 1 });
  release.files[3].size = 0x400000;
  const result = validateManifest({ schema: 'vigia-firmware-manifest/1', releases: [release] });
  assert.match(result.errors.join('\n'), /protocolo 1/);
  assert.match(result.errors.join('\n'), /excede la flash/);
});

test('resolveFirmwareUrl sólo permite rutas del mismo origen y directorio', () => {
  const manifest = 'https://vigia.example/firmware/manifest.json';
  assert.equal(resolveFirmwareUrl('0.4.0/app.bin', manifest), 'https://vigia.example/firmware/0.4.0/app.bin');
  assert.throws(() => resolveFirmwareUrl('https://evil.example/app.bin', manifest), /Origen no permitido/);
  assert.throws(() => resolveFirmwareUrl('../app.js', manifest), /fuera del directorio/);
});

test('inspectEspImage detecta imágenes de otro chip', () => {
  assert.equal(inspectEspImage(espImage(0), 'ESP32').ok, true);
  assert.match(inspectEspImage(espImage(9), 'ESP32').reason, /otro chip/);
  assert.match(inspectEspImage(new Uint8Array(64), 'ESP32').reason, /0xE9/);
});

test('parsePartitionTable y checkReleaseImages validan que la app quepa en su partición', () => {
  const table = partitionTable([
    { type: 1, subtype: 2, offset: 0x9000, size: 0x5000, label: 'nvs' },
    { type: 0, subtype: 0x10, offset: 0x10000, size: 0x300000, label: 'app0' },
  ]);
  assert.equal(parsePartitionTable(table).length, 2);
  const release = sampleRelease();
  const files = new Map([
    [release.files[0].path, espImage(0)], [release.files[1].path, table],
    [release.files[2].path, new Uint8Array(0x2000)], [release.files[3].path, espImage(0)],
  ]);
  assert.deepEqual(checkReleaseImages(release, files), { ok: true, problems: [] });
  release.files[3].size = 0x400000;
  assert.match(checkReleaseImages(release, files).problems.join(), /no cabe/);
  files.set(release.files[3].path, espImage(5));
  assert.match(checkReleaseImages(release, files).problems.join(), /otro chip/);
});

test('classifyProbe distingue los estados del dispositivo', () => {
  assert.equal(classifyProbe({ openError: { name: 'NetworkError', message: 'Failed to open serial port.' } }).state, 'port-busy');
  assert.equal(classifyProbe({ openError: { name: 'SecurityError' } }).state, 'connection-error');
  assert.equal(classifyProbe({ events: [{ type: 'pong', protocol: 2 }, { type: 'ready', protocol: 2, firmware: '0.4.0-arduino' }], latestVersion: '0.4.0-arduino' }).state, 'vigia-ready');
  assert.equal(classifyProbe({ events: [{ type: 'ready', protocol: 2, firmware: '0.3.0' }], latestVersion: '0.4.0-arduino' }).state, 'vigia-outdated');
  assert.equal(classifyProbe({ events: [{ type: 'pong', protocol: 1 }] }).state, 'vigia-incompatible');
  assert.equal(classifyProbe({ events: [{ type: 'other' }], rawBytes: 120 }).state, 'unknown-firmware');
  assert.equal(classifyProbe({ rawBytes: 300, textLines: ['rst:0x10 (RTCWDT_RTC_RESET),boot:0x13', 'flash read err, 1000'] }).state, 'no-firmware');
  assert.equal(classifyProbe({ rawBytes: 300, textLines: ['E (45) esp_image: image at 0x10000 has invalid magic byte', 'invalid header: 0xffffffff'] }).state, 'no-firmware');
  assert.equal(classifyProbe({ rawBytes: 0 }).state, 'no-response');
});

test('verifyInstalledFirmware exige VIGIA/2 y la versión exacta', () => {
  assert.equal(verifyInstalledFirmware([{ type: 'ready', protocol: 2, firmware: '0.4.0-arduino' }], '0.4.0-arduino').ok, true);
  assert.equal(verifyInstalledFirmware([{ type: 'pong', protocol: 2 }], '0.4.0-arduino').ok, false);
  assert.equal(verifyInstalledFirmware([{ type: 'ready', protocol: 2, firmware: '0.3.0' }], '0.4.0-arduino').ok, false);
  assert.equal(verifyInstalledFirmware([], '0.4.0-arduino').ok, false);
});

test('utilidades: parseJsonLine, usbBridgeInfo, releasesForChip, latestRelease', () => {
  assert.equal(parseJsonLine('ets Jun  8 2016 00:22:57'), null);
  assert.deepEqual(parseJsonLine('{"type":"pong","protocol":2}'), { type: 'pong', protocol: 2 });
  assert.equal(usbBridgeInfo(0x10c4).vendor, 'Silicon Labs');
  assert.equal(usbBridgeInfo(0x1234), null);
  const manifest = { latest: '0.4.0-arduino', releases: [sampleRelease(), sampleRelease({ version: '0.5.0', chip: 'ESP32', channel: 'beta' })] };
  assert.deepEqual(releasesForChip(manifest, 'ESP32').map(release => release.version), ['0.4.0-arduino']);
  assert.equal(latestRelease(manifest).version, '0.4.0-arduino');
});
