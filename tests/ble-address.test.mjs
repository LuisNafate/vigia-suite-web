import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../pc-lab/history-core.js';
import { loadBleLabels, loadFieldFilter, loadLegacyEnterpriseNotice, loadScoring } from './app-source.mjs';

// Los mismos casos se ejecutan en vigia-suite-android (BleAddressEquivalenceTest): las dos apps deben coincidir.
const fixture = JSON.parse(await readFile(new URL('./fixtures/ble-address-cases.json', import.meta.url), 'utf8'));
const B = globalThis.VigiaBleAddress;
const { SCORE_FORMULA_VERSION, addressTypeLabel } = await loadBleLabels();

for (const item of fixture.classification) {
  test(`dirección BLE compartida: ${item.addressType} ${item.address} → ${item.expected}`, () => {
    assert.equal(B.classify(item.addressType, item.address), item.expected, item.why);
  });
}

test('sólo pública y aleatoria estática son identificadores estables', () => {
  assert.deepEqual(Object.keys(fixture.classes).filter(B.isStable), ['public', 'static']);
  assert.deepEqual(Object.keys(fixture.classes).filter(B.isPrivate), ['resolvable', 'non_resolvable', 'resolved_identity']);
  assert.equal(B.isStable('unknown'), false);
  assert.equal(B.isPrivate('unknown'), false, 'una dirección no determinada no se presenta como privada');
});

test('las etiquetas de privacidad usan el subtipo y no afirman que una estática nunca cambie', () => {
  assert.equal(addressTypeLabel('public', '88:8e:68:12:34:56'), 'Pública');
  assert.equal(addressTypeLabel('random', 'c4:12:34:56:78:9a'), 'Aleatoria estática');
  assert.equal(addressTypeLabel('random', '7a:12:34:56:78:9a'), 'Privada resoluble');
  assert.equal(addressTypeLabel('random', '3f:12:34:56:78:9a'), 'Privada no resoluble');
  assert.equal(addressTypeLabel('public_identity', '88:8e:68:12:34:56'), 'Identidad resuelta');
  assert.equal(addressTypeLabel('random', '80:12:34:56:78:9a'), 'No determinada');
  assert.equal(addressTypeLabel(undefined, undefined), 'No determinada');
  assert.doesNotMatch(Object.values(B.LABELS).join(' '), /nunca cambia|permanente/i);
});

const build = (side, id, createdAt) => side.legacy
  ? { assessment: { ...core.legacyWebRecordToAssessment({ createdAt: new Date(createdAt).toISOString(), score: 10, level: 'BAJO', wifi: { total: 0, open: 0 }, bluetooth: { total: side.bleNearby, nearby: side.bleNearby } }), id }, wifi: [], ble: [] }
  : core.buildAssessment({ id, createdAt, score: 10, level: 'BAJO', bleDevices: side.ble.map(device => ({ type: 'ble_device', name: '', ...device })), scoreFormula: side.scoreFormula });

for (const item of fixture.formulaComparisons) {
  test(`comparación entre versiones compartida: ${item.name}`, () => {
    const before = build(item.before, 'a', 1000);
    const after = build(item.after, 'b', 2000);
    const warning = core.formulaWarning(before, after);
    assert.deepEqual(warning ? { kind: warning.kind, delta: warning.delta } : { kind: 'none', delta: 0 }, item.expected);
    const warnings = core.compareAssessments(after, before).warnings.filter(text => /fórmula/.test(text));
    assert.equal(warnings.length, item.expected.kind === 'none' ? 0 : 1);
    if (item.expected.kind === 'possible') assert.doesNotMatch(warnings[0], /comprobado con/, 'una diferencia posible no se presenta como comprobada');
    if (item.expected.kind === 'confirmed') assert.match(warnings[0], /comprobado con sus observaciones guardadas/);
    // La comparación nunca recalcula ni modifica las puntuaciones guardadas.
    assert.deepEqual([before.assessment.score, after.assessment.score], [10, 10]);
  });
}

test('las evaluaciones nuevas guardan la versión 3 y las anteriores quedan como no registradas', () => {
  assert.equal(SCORE_FORMULA_VERSION, 3);
  assert.equal(core.BLE_RULE_SINCE, 3);
  const fresh = core.buildAssessment({ id: 'n', createdAt: 1, score: 2, level: 'BAJO', scoreFormula: SCORE_FORMULA_VERSION });
  assert.equal(fresh.assessment.scoreFormula, 3);
  assert.equal(core.buildAssessment({ id: 'x', createdAt: 1, score: 2, level: 'BAJO' }).assessment.scoreFormula, null, 'sin versión informada no se inventa');
  for (const value of ['3', 3.5, 0, -1, true]) assert.equal(core.buildAssessment({ id: 'x', createdAt: 1, score: 2, level: 'BAJO', scoreFormula: value }).assessment.scoreFormula, null);
  assert.equal(core.legacyWebRecordToAssessment({ createdAt: '2026-11-01T00:00:00Z', score: 4, level: 'BAJO' }).scoreFormula, null);
  // Un registro guardado en IndexedDB antes de esta versión no tiene el campo: se lee como no registrado.
  const stored = core.buildAssessment({ id: 'old', createdAt: 1, score: 4, level: 'BAJO', bleDevices: [{ address: 'c4:12:34:56:78:9a', address_type: 'random', rssi: -50, connectable: true }] });
  delete stored.assessment.scoreFormula;
  assert.equal(core.storedFormula(stored.assessment), null);
  assert.equal(core.mayLackBleRule(stored.assessment), true);
  const result = core.compareAssessments(stored, core.buildAssessment({ id: 'new', createdAt: 2, score: 2, level: 'BAJO', scoreFormula: 3 }));
  assert.equal(result.score.before, 4, 'la puntuación histórica se conserva');
  assert.ok(result.warnings.some(text => /no registra su versión de fórmula/.test(text)));
});

test('el modo 16 sólo genera un aviso informativo y no cambia la puntuación', async () => {
  const notice = await loadLegacyEnterpriseNotice();
  const { WIFI_FIELDS, withValidFields } = await loadFieldFilter();
  const compute = await loadScoring();
  const net = (auth, index) => withValidFields({ type: 'wifi_ap', ssid: `Red${index}`, rssi: -40, channel: index + 1, auth, bssid: `AA:AA:AA:AA:AA:0${index}` }, WIFI_FIELDS);
  assert.equal(notice([net(3, 0), net(5, 1)]), null);
  const result = notice([net(16, 0), net(16, 1), net(3, 2)]);
  assert.equal(result.severity, 'info');
  assert.equal(result.title, '2 red(es) WPA-Enterprise heredado');
  assert.match(result.detail, /no conoce el cifrado/);
  assert.doesNotMatch(result.detail, /usa TKIP|es vulnerable/);
  assert.equal(compute([net(16, 0), net(16, 1)], []).score, 0, 'el modo 16 sigue sin sumar puntos');
  assert.equal(compute([net(16, 0), net(2, 1)], []).score, 12, 'WPA-PSK (2) sigue sumando 12');
});
