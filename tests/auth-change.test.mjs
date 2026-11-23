import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../pc-lab/history-core.js';

// Los mismos casos se ejecutan en vigia-suite-android (AuthChangeEquivalenceTest): las dos apps deben coincidir.
const fixture = JSON.parse(await readFile(new URL('./fixtures/auth-change-cases.json', import.meta.url), 'utf8'));
const CODES = { W: 'weaker', S: 'stronger', '=': 'equivalent', '?': 'unknown' };
const OPPOSITE = { weaker: 'stronger', stronger: 'weaker', equivalent: 'equivalent', unknown: 'unknown' };

const ap = (bssid, auth) => ({ type: 'wifi_ap', ssid: 'Casa', rssi: -60, channel: 6, auth, bssid });
const record = (id, createdAt, wifiNetworks) => core.buildAssessment({ id, createdAt, score: 10, level: 'BAJO', wifiNetworks });

for (const item of fixture.cases) {
  test(`autenticación compartida: ${item.before} → ${item.after} (${item.expected})`, () => {
    assert.equal(core.authProtectionChange(item.before, item.after), item.expected, item.why);
    assert.equal(core.isAuthDowngrade(item.before, item.after), item.expected === 'weaker');
  });
}

test('la matriz compartida de los modos 0-16 coincide en todas las combinaciones', () => {
  assert.equal(fixture.matrix.rows.length, 17);
  fixture.matrix.rows.forEach((row, before) => {
    assert.equal(row.length, 17);
    [...row].forEach((code, after) => assert.equal(core.authProtectionChange(before, after), CODES[code], `${before} → ${after}`));
  });
});

test('la clasificación es coherente en los dos sentidos y no sigue el número del modo', () => {
  for (let before = 0; before <= 16; before += 1) {
    for (let after = 0; after <= 16; after += 1) {
      assert.equal(core.authProtectionChange(after, before), OPPOSITE[core.authProtectionChange(before, after)], `${before} ↔ ${after}`);
    }
  }
  assert.equal(core.authProtectionChange(5, 16), 'weaker', 'WPA2-Enterprise (5) a WPA-Enterprise (16)');
  assert.equal(core.authProtectionChange(9, 2), 'unknown', 'OWE (9) a WPA-PSK (2)');
});

test('un modo que no es un entero del enum nunca se califica', () => {
  for (const value of ['3', 3.5, true, undefined, -1, 17, 255]) {
    assert.equal(core.authProtectionChange(value, 0), 'unknown', String(value));
    assert.equal(core.authProtectionChange(3, value), 'unknown', String(value));
  }
});

test('la comparación separa debilitamientos, mejoras y cambios sin calificar', () => {
  const before = record('a', 1000, [
    ap('AA:AA:AA:AA:AA:01', 5), ap('AA:AA:AA:AA:AA:02', 3), ap('AA:AA:AA:AA:AA:03', 3), ap('AA:AA:AA:AA:AA:04', 8), ap('AA:AA:AA:AA:AA:05', 6),
  ]);
  const after = record('b', 2000, [
    ap('AA:AA:AA:AA:AA:01', 16), ap('AA:AA:AA:AA:AA:02', 5), ap('AA:AA:AA:AA:AA:03', 6), ap('AA:AA:AA:AA:AA:04', 3), ap('AA:AA:AA:AA:AA:05', 11),
  ]);
  const result = core.compareAssessments(before, after);
  assert.deepEqual(result.wifi.authChanged.map(change => [change.bssid.slice(-2), change.protection, change.downgrade]), [
    ['01', 'weaker', true], ['02', 'unknown', false], ['03', 'stronger', false], ['04', 'unknown', false], ['05', 'equivalent', false],
  ]);
  const findings = core.comparisonFindings(result);
  assert.deepEqual(findings.filter(item => /autenticación|protección/.test(item.title)).map(item => [item.severity, item.title]), [
    ['high', '1 red(es) redujeron su protección'],
    ['info', '2 cambio(s) de autenticación sin pérdida de protección'],
    ['info', '2 cambio(s) de autenticación sin calificar'],
  ]);
});

test('un cambio sólo entre modos no comparables no se presenta como mejora ni como debilitamiento', () => {
  const result = core.compareAssessments(record('a', 1000, [ap('AA:AA:AA:AA:AA:01', 14)]), record('b', 2000, [ap('AA:AA:AA:AA:AA:01', 6)]));
  const titles = core.comparisonFindings(result).map(item => item.title);
  assert.deepEqual(titles, ['1 cambio(s) de autenticación sin calificar']);
});
