import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../pc-lab/history-core.js';

const ap = (bssid, extra = {}) => ({ type: 'wifi_ap', ssid: 'Casa', rssi: -60, channel: 6, auth: 3, bssid, ...extra });
const ble = (address, extra = {}) => ({ type: 'ble_device', name: '', address, address_type: 'public', rssi: -70, connectable: false, manufacturer_id: -1, manufacturer_data: '', services: '', tx_power: 127, ...extra });
const record = (id, createdAt, wifiNetworks = [], bleDevices = [], extra = {}) =>
  core.buildAssessment({ id, createdAt, score: 10, level: 'BAJO', wifiNetworks, bleDevices, ...extra });

test('buildAssessment conserva los campos del protocolo y marca lo desconocido como null', () => {
  const result = core.buildAssessment({
    id: 'a1', createdAt: '2026-11-19T10:00:00.000Z', status: 'complete', score: 42, level: 'MEDIO',
    sensor: { board: 'nodemcu-esp32s', chip: 'ESP32', mac: '04:b2:47:82:60:1c', firmware: '0.5.0-arduino', protocol: 2 },
    wifiNetworks: [ap('aa:bb:cc:dd:ee:01', { ssid: '', auth: 0 }), ap('AA:BB:CC:DD:EE:02', { rssi: 'x', channel: 99999 })],
    bleDevices: [ble('11:22:33:44:55:66', { rssi: -50, manufacturer_id: 76, services: ' fd44 ' })],
    wifiTruncated: false, bleTruncated: true, bleFailed: false,
  });
  assert.equal(result.assessment.createdAt, Date.parse('2026-11-19T10:00:00.000Z'));
  assert.deepEqual(result.assessment.sensor, { board: 'nodemcu-esp32s', chip: 'ESP32', mac: '04:B2:47:82:60:1C', firmware: '0.5.0-arduino', protocol: 2 });
  assert.equal(result.assessment.wifiCount, 2);
  assert.equal(result.assessment.wifiOpen, 1);
  assert.equal(result.assessment.bleNearby, 1);
  assert.equal(result.assessment.bleTruncated, true);
  assert.equal(result.assessment.hasObservations, true);
  assert.deepEqual(result.wifi[0], { ssid: '', bssid: 'AA:BB:CC:DD:EE:01', channel: 6, rssi: -60, auth: 0 });
  assert.equal(result.wifi[1].rssi, null, 'un RSSI no numérico se guarda como desconocido');
  assert.equal(result.wifi[1].channel, null, 'un canal fuera de rango se guarda como desconocido');
  assert.deepEqual(result.ble[0], { name: '', address: '11:22:33:44:55:66', addressType: 'public', rssi: -50, connectable: false, manufacturerId: 76, services: 'fd44' });
  assert.equal(Object.keys(result.wifi[0]).includes('password'), false);
});

test('buildAssessment no inventa la identidad del sensor ni acepta datos inválidos', () => {
  const result = core.buildAssessment({ id: 'x', createdAt: Date.now(), score: 0, level: 'BAJO', sensor: { firmware: '—', protocol: 'Pendiente' } });
  assert.deepEqual(result.assessment.sensor, { board: null, chip: null, mac: null, firmware: null, protocol: null });
  const ble0 = core.normalizeBleObservation({ address: 'zz', address_type: 'otro', manufacturer_id: -1 });
  assert.equal(ble0.address, null);
  assert.equal(ble0.addressType, 'unknown');
  assert.equal(ble0.manufacturerId, null);
  assert.equal(ble0.connectable, null);
  assert.throws(() => core.buildAssessment({ id: 'x', createdAt: 'no', score: 1 }), /fecha/);
  assert.throws(() => core.buildAssessment({ id: 'x', createdAt: 1, score: 101 }), /puntuación/);
  assert.throws(() => core.buildAssessment({ id: 'x', createdAt: 1, score: 1, status: 'legacy' }), /Estado/);
  assert.throws(() => core.buildAssessment({ createdAt: 1, score: 1 }), /identificador/);
});

test('comparación Wi-Fi: nuevas, desaparecidas, canal, autenticación y cambio de nombre por BSSID', () => {
  const before = record('a', 1000, [
    ap('AA:AA:AA:AA:AA:01'), ap('AA:AA:AA:AA:AA:02', { channel: 1 }), ap('AA:AA:AA:AA:AA:03', { auth: 3 }),
    ap('AA:AA:AA:AA:AA:04', { ssid: 'Oficina' }), ap('AA:AA:AA:AA:AA:05', { ssid: 'Vieja' }),
  ]);
  const after = record('b', 2000, [
    ap('AA:AA:AA:AA:AA:01'), ap('AA:AA:AA:AA:AA:02', { channel: 11 }), ap('AA:AA:AA:AA:AA:03', { auth: 0 }),
    ap('AA:AA:AA:AA:AA:04', { ssid: 'Oficina-5' }), ap('AA:AA:AA:AA:AA:06', { ssid: 'Nueva', auth: 0 }),
    ap('AA:AA:AA:AA:AA:07', { ssid: 'Casa' }),
  ]);
  // El orden de los argumentos no importa: la más antigua es la referencia.
  const result = core.compareAssessments(after, before);
  assert.equal(result.before.id, 'a');
  assert.equal(result.detailed, true);
  assert.deepEqual(result.wifi.added.map(item => item.bssid), ['AA:AA:AA:AA:AA:06', 'AA:AA:AA:AA:AA:07']);
  assert.deepEqual(result.wifi.removed.map(item => item.bssid), ['AA:AA:AA:AA:AA:05']);
  assert.deepEqual(result.wifi.channelChanged.map(change => [change.bssid, change.before.channel, change.after.channel]), [['AA:AA:AA:AA:AA:02', 1, 11]]);
  assert.equal(result.wifi.authChanged.length, 1);
  assert.equal(result.wifi.authChanged[0].downgrade, true);
  // Mismo BSSID con otro SSID: es la misma red renombrada, no una red nueva ni una desaparecida.
  assert.deepEqual(result.wifi.renamed.map(change => change.bssid), ['AA:AA:AA:AA:AA:04']);
  assert.equal(result.wifi.unchanged, 1);
  assert.deepEqual(result.wifi.ssidReuse.map(item => item.bssid), ['AA:AA:AA:AA:AA:07']);
  const findings = core.comparisonFindings(result);
  assert.equal(findings[0].severity, 'high');
  assert.ok(findings.some(item => /abierta/.test(item.title)));
});

test('comparación Wi-Fi tolera observaciones incompletas sin inventar cambios', () => {
  const before = record('a', 1, [ap('AA:AA:AA:AA:AA:01', { channel: null, auth: 'x' }), ap('sin-bssid')]);
  const after = record('b', 2, [ap('aa:aa:aa:aa:aa:01', { channel: 6, auth: 3 }), ap(undefined)]);
  const result = core.compareAssessments(before, after);
  assert.equal(result.wifi.channelChanged.length, 0, 'un canal desconocido no cuenta como cambio');
  assert.equal(result.wifi.authChanged.length, 0, 'una autenticación desconocida no cuenta como cambio');
  assert.equal(result.wifi.unchanged, 1);
  assert.equal(result.wifi.unidentified, 2, 'las redes sin BSSID válido no se emparejan');
  assert.equal(result.wifi.added.length + result.wifi.removed.length, 0);
});

test('comparación BLE: sólo empareja direcciones públicas, nunca aleatorias ni resolubles', () => {
  const before = record('a', 1, [], [
    ble('11:11:11:11:11:11'), ble('22:22:22:22:22:22'),
    ble('33:33:33:33:33:33', { address_type: 'random' }), ble('44:44:44:44:44:44', { address_type: 'public_identity' }),
  ]);
  const after = record('b', 2, [], [
    ble('11:11:11:11:11:11'), ble('55:55:55:55:55:55'),
    ble('33:33:33:33:33:33', { address_type: 'random' }), ble('44:44:44:44:44:44', { address_type: 'public_identity' }),
  ]);
  const result = core.compareAssessments(before, after);
  assert.equal(result.ble.compared, true);
  assert.equal(result.ble.persistent, 1);
  assert.deepEqual(result.ble.added.map(item => item.address), ['55:55:55:55:55:55']);
  assert.deepEqual(result.ble.removed.map(item => item.address), ['22:22:22:22:22:22']);
  // Aunque la dirección aleatoria coincida, no se afirma que sea el mismo dispositivo físico.
  assert.equal(result.ble.unmatchedBefore, 2);
  assert.equal(result.ble.unmatchedAfter, 2);
});

test('comparación con evaluaciones históricas, truncadas o con BLE fallido advierte y no compara de más', () => {
  const legacy = { assessment: core.legacyWebRecordToAssessment({ createdAt: '2026-11-01T00:00:00Z', score: 5, level: 'BAJO', wifi: { total: 3 }, bluetooth: { total: 1 } }), wifi: [], ble: [] };
  const live = record('b', Date.parse('2026-11-02T00:00:00Z'), [ap('AA:AA:AA:AA:AA:01')], [], { wifiTruncated: true });
  const summaryOnly = core.compareAssessments(legacy, live);
  assert.equal(summaryOnly.detailed, false);
  assert.equal(summaryOnly.wifi.added.length, 0, 'sin observaciones no se declaran redes nuevas');
  assert.ok(summaryOnly.warnings.some(text => /histórica/.test(text)));
  assert.ok(summaryOnly.warnings.some(text => /32 redes/.test(text)));
  const failed = core.compareAssessments(record('a', 1, [], [ble('11:11:11:11:11:11')]), record('c', 3, [], [], { bleFailed: true, status: 'partial' }));
  assert.equal(failed.ble.compared, false);
  assert.equal(failed.ble.removed.length, 0, 'un BLE fallido no se interpreta como dispositivos desaparecidos');
  assert.ok(failed.warnings.some(text => /incompleta/.test(text)));
});

test('isAuthDowngrade sólo juzga modos conocidos', () => {
  assert.equal(core.isAuthDowngrade(3, 0), true);
  assert.equal(core.isAuthDowngrade(6, 3), true);
  assert.equal(core.isAuthDowngrade(3, 6), false);
  assert.equal(core.isAuthDowngrade(3, 42), false);
});

test('migración de localStorage: conserva resúmenes, evita duplicados y rechaza registros dañados', () => {
  const original = { schema: 'vigia-suite-report/1', createdAt: '2026-11-10T12:00:00.000Z', score: 33, level: 'MEDIO',
    sensor: { board: 'nodemcu-esp32s', chip: 'ESP32', mac: '', firmware: '—', protocol: 'VIGIA/2' },
    wifi: { total: 7, open: 2, legacy: 0, hidden: 1 }, bluetooth: { total: 4, nearby: 1, scanFailed: false } };
  const { records, rejected } = core.prepareLegacyMigration([original, { ...original }, { createdAt: 'mal', score: 1, level: 'BAJO' }, null, { createdAt: '2026-11-11T00:00:00Z', score: 3, level: 'OTRO' }]);
  assert.equal(records.length, 1, 'el duplicado exacto se importa una sola vez');
  assert.equal(rejected.length, 3);
  const [item] = records;
  assert.equal(item.id, core.legacyWebId(original));
  assert.equal(item.status, 'legacy');
  assert.equal(item.hasObservations, false);
  assert.equal(item.wifiCount, 7);
  assert.equal(item.bleCount, 4);
  assert.deepEqual(item.sensor, { board: 'nodemcu-esp32s', chip: 'ESP32', mac: null, firmware: null, protocol: 2 });
  assert.equal(item.wifiTruncated, null);
  assert.deepEqual(core.prepareLegacyMigration('{}').records, []);
  assert.equal(core.prepareLegacyMigration('{}').rejected.length, 1);
  assert.deepEqual(core.removeFromLegacyBackup([original, { ...original, score: 40 }], [item.id]).map(entry => entry.score), [40]);
});

test('política de conservación por cantidad y antigüedad', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  const items = Array.from({ length: 6 }, (_, index) => ({ id: `e${index}`, createdAt: now - index * 20 * day }));
  assert.deepEqual(core.selectExpired(items, { maxCount: 0, maxAgeDays: 0 }, now), []);
  assert.deepEqual(core.selectExpired(items, { maxCount: 20, maxAgeDays: 30 }, now), ['e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(core.selectExpired(items, { maxCount: 0, maxAgeDays: 90 }, now), ['e5']);
  assert.deepEqual(core.normalizeRetention({ maxCount: 7, maxAgeDays: 'x' }), core.DEFAULT_RETENTION);
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, createdAt: now - index }));
  assert.deepEqual(core.selectExpired(many, { maxCount: 20, maxAgeDays: 0 }, now), ['m20', 'm21', 'm22', 'm23', 'm24']);
});

test('la clave del historial anterior coincide con la que usa app.js', async () => {
  const app = await readFile(new URL('../pc-lab/app.js', import.meta.url), 'utf8');
  assert.match(app, new RegExp(`HISTORY_KEY = '${core.LEGACY_WEB_HISTORY_KEY}'`));
});
