import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFieldFilter, loadScoring } from './app-source.mjs';

// Los mismos casos se ejecutan en vigia-suite-android (RiskScoreEquivalenceTest): las dos apps deben coincidir.
const fixture = JSON.parse(await readFile(new URL('./fixtures/scoring-cases.json', import.meta.url), 'utf8'));

test('los casos compartidos cubren las reglas de la fórmula', () => {
  assert.ok(fixture.cases.length >= 10);
  assert.ok(fixture.cases.some(item => /12 redes en un canal/.test(item.name)));
});

for (const item of fixture.cases) {
  test(`puntuación compartida: ${item.name}`, async () => {
    const { WIFI_FIELDS, BLE_FIELDS, withValidFields } = await loadFieldFilter();
    const compute = await loadScoring();
    // Igual que handleLine: cada evento pasa por withValidFields antes de guardarse.
    const networks = item.wifi.map(ap => withValidFields({ type: 'wifi_ap', ...ap }, WIFI_FIELDS));
    const bleDevices = item.ble.map(device => withValidFields({ type: 'ble_device', ...device }, BLE_FIELDS));
    assert.deepEqual(compute(networks, bleDevices), item.expected, item.why);
  });
}
