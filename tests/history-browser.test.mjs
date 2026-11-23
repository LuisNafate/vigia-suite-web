// Pruebas del historial en un navegador real (IndexedDB nativo). Se omiten si no hay Edge/Chrome instalado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, withBrowser } from './browser-harness.mjs';
import { FAKE_SERIAL } from './fake-sensor.mjs';

const skip = typeof WebSocket !== 'function' ? 'Requiere Node 22 o posterior (WebSocket global).'
  : findBrowser() ? false : 'No se encontró Edge ni Chrome (define VIGIA_TEST_BROWSER para ejecutar esta prueba).';

// Página mínima del mismo origen que ejecuta los escenarios de history-store.js.
const STORE_PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { openHistoryDb } from './history-store.js';
import * as core from './history-core.js';
const ap = (bssid, extra = {}) => ({ ssid: 'Casa', rssi: -60, channel: 6, auth: 3, bssid, ...extra });
const ble = (address, extra = {}) => ({ name: 'Sensor', address, address_type: 'public', rssi: -50, connectable: true, manufacturer_id: 76, services: 'fd44' , ...extra });
const count = (db, name) => new Promise(resolve => { const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => resolve(r.result); });
window.run = async () => {
  const out = {};
  const store = await openHistoryDb({ name: 'vigia-test-' + Math.random() });
  const a = core.buildAssessment({ id: 'A', createdAt: 1000, score: 20, level: 'BAJO', wifiNetworks: [ap('AA:AA:AA:AA:AA:01'), ap('AA:AA:AA:AA:AA:02', { ssid: '' })], bleDevices: [ble('11:11:11:11:11:11')] });
  const b = core.buildAssessment({ id: 'B', createdAt: 2000, score: 40, level: 'MEDIO', status: 'partial', wifiNetworks: [ap('AA:AA:AA:AA:AA:03')], bleDevices: [], bleFailed: true });
  await store.saveAssessment(a); await store.saveAssessment(b);
  out.order = (await store.listAssessments()).map(item => item.id);
  const detailA = await store.getAssessment('A');
  out.detailA = { wifi: detailA.wifi, ble: detailA.ble, status: detailA.assessment.status };
  out.detailB = { wifi: (await store.getAssessment('B')).wifi.map(item => item.bssid), status: (await store.getAssessment('B')).assessment.status };
  out.missing = await store.getAssessment('nada');
  try { await store.saveAssessment({ ...a, wifi: [ap('FF:FF:FF:FF:FF:FF')] }); out.duplicate = 'guardado'; }
  catch (error) { out.duplicate = error.name; }
  out.wifiRowsAfterDuplicate = await count(store.db, 'wifiObservations');
  await store.deleteAssessments(['A']);
  out.afterDelete = { list: (await store.listAssessments()).map(item => item.id), wifi: await count(store.db, 'wifiObservations'), ble: await count(store.db, 'bleObservations') };
  const legacy = core.prepareLegacyMigration([{ createdAt: '2026-11-01T00:00:00Z', score: 12, level: 'BAJO', wifi: { total: 4, open: 1 }, bluetooth: { total: 2, nearby: 1 } }]).records;
  out.import1 = await store.importLegacy(legacy);
  out.import2 = await store.importLegacy(legacy);
  out.legacyDetail = await store.getAssessment(legacy[0].id).then(item => ({ hasObservations: item.assessment.hasObservations, wifi: item.wifi.length }));
  await store.deleteAll();
  out.afterClear = { list: (await store.listAssessments()).length, wifi: await count(store.db, 'wifiObservations'), ble: await count(store.db, 'bleObservations') };
  try { await openHistoryDb({ indexedDB: null }); out.noIdb = 'abierto'; } catch (error) { out.noIdb = error.message; }
  store.close();
  return out;
};
window.ready = true;
</script>`;

// Siembra el historial antiguo de localStorage y abre el dashboard real.
const LEGACY = [
  { schema: 'vigia-suite-report/1', createdAt: '2026-11-10T12:00:00.000Z', score: 33, level: 'MEDIO', sensor: { board: 'nodemcu-esp32s', chip: 'ESP32', mac: '04:B2:47:82:60:1C', firmware: '0.5.0-arduino', protocol: 'VIGIA/2' }, wifi: { total: 7, open: 2 }, bluetooth: { total: 4, nearby: 1, scanFailed: false } },
  { schema: 'vigia-suite-report/1', createdAt: '2026-11-09T12:00:00.000Z', score: 5, level: 'BAJO', sensor: {}, wifi: { total: 2, open: 0 }, bluetooth: { total: 0, nearby: 0, scanFailed: true } },
  { createdAt: 'fecha-dañada', score: 'x' },
];
const SEED_PAGE = `<!doctype html><meta charset="utf-8"><script>
localStorage.setItem('vigia-suite-analysis-history-v1', ${JSON.stringify(JSON.stringify(LEGACY))});
location.replace('/dashboard.html');
</script>`;

test('history-store guarda, asocia, consulta y elimina evaluaciones en IndexedDB', { skip, timeout: 60000 }, async () => {
  await withBrowser({ '/__store.html': STORE_PAGE }, async page => {
    await page.goto('/__store.html');
    await page.waitFor('window.ready === true');
    const out = await page.evaluate('window.run()');
    assert.deepEqual(out.order, ['B', 'A'], 'la más reciente primero');
    assert.deepEqual(out.detailA.wifi.map(item => item.bssid), ['AA:AA:AA:AA:AA:01', 'AA:AA:AA:AA:AA:02']);
    assert.equal(out.detailA.wifi[1].ssid, '', 'el SSID oculto se conserva como cadena vacía');
    assert.deepEqual(out.detailA.ble, [{ name: 'Sensor', address: '11:11:11:11:11:11', addressType: 'public', rssi: -50, connectable: true, manufacturerId: 76, services: 'fd44' }]);
    assert.deepEqual(out.detailB, { wifi: ['AA:AA:AA:AA:AA:03'], status: 'partial' }, 'cada evaluación conserva sólo sus observaciones');
    assert.equal(out.missing, null);
    assert.equal(out.duplicate, 'ConstraintError', 'un identificador repetido se rechaza');
    assert.equal(out.wifiRowsAfterDuplicate, 3, 'la transacción fallida no deja observaciones huérfanas');
    assert.deepEqual(out.afterDelete, { list: ['B'], wifi: 1, ble: 0 }, 'eliminar una evaluación borra sus observaciones');
    assert.deepEqual(out.import1, { imported: 1, existing: 0, mismatched: [] });
    assert.deepEqual(out.import2, { imported: 0, existing: 1, mismatched: [] }, 'la migración repetida no duplica');
    assert.deepEqual(out.legacyDetail, { hasObservations: false, wifi: 0 });
    assert.deepEqual(out.afterClear, { list: 0, wifi: 0, ble: 0 });
    assert.match(out.noIdb, /IndexedDB/);
  });
});

test('el dashboard migra localStorage, guarda evaluaciones completas, compara y elimina', { skip, timeout: 90000 }, async () => {
  await withBrowser({ '/__seed.html': SEED_PAGE }, async page => {
    await page.goto('/__seed.html');
    await page.waitFor(`document.querySelector('#historyStatus')?.textContent.startsWith('Historial listo')`);
    const status = await page.evaluate(`document.querySelector('#historyStatus').textContent`);
    assert.match(status, /2 evaluación\(es\)/);
    assert.match(status, /2 resumen\(es\) anterior\(es\) migrado\(s\)/);
    assert.match(status, /1 registro\(s\) con formato no válido se conservan/);
    assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('vigia-suite-analysis-history-v1')).length`), 3, 'el original se conserva');

    // Recargar no duplica: la migración es idempotente.
    await page.goto('/dashboard.html');
    await page.waitFor(`document.querySelector('#historyStatus')?.textContent.startsWith('Historial listo')`);
    assert.equal(await page.evaluate(`document.querySelector('#historyViewCounter').textContent`), '2 evaluaciones');

    // Guardar dos evaluaciones con el mismo formato que produce app.js.
    await page.evaluate(`(async () => {
      const base = { schema: 'vigia-suite-report/1', level: 'BAJO', wifi: { truncated: false }, bluetooth: { scanFailed: false, truncated: false } };
      await window.VigiaHistory.saveReport({ ...base, createdAt: '2026-11-18T10:00:00.000Z', score: 10,
        wifiNetworks: [{ ssid: 'Casa', bssid: 'AA:AA:AA:AA:AA:01', channel: 1, rssi: -50, auth: 3 }, { ssid: 'Taller', bssid: 'AA:AA:AA:AA:AA:02', channel: 6, rssi: -70, auth: 3 }],
        bleDevices: [{ name: '', address: 'aa:bb:cc:dd:ee:ff', address_type: 'random', rssi: -60, connectable: false, manufacturer_id: -1, services: '' }] },
        { status: 'complete', sensor: { board: 'nodemcu-esp32s', chip: 'ESP32', mac: '04:B2:47:82:60:1C', firmware: null, protocol: 2 } });
      await window.VigiaHistory.saveReport({ ...base, createdAt: '2026-11-19T10:00:00.000Z', score: 45, level: 'MEDIO',
        wifiNetworks: [{ ssid: 'Casa', bssid: 'AA:AA:AA:AA:AA:01', channel: 11, rssi: -52, auth: 0 }, { ssid: '<b>Nueva</b>', bssid: 'AA:AA:AA:AA:AA:03', channel: 6, rssi: -40, auth: 0 }],
        bleDevices: [{ name: '', address: 'aa:bb:cc:dd:ee:ff', address_type: 'random', rssi: -60, connectable: false, manufacturer_id: -1, services: '' }] },
        { status: 'complete', sensor: {} });
    })()`);
    assert.equal(await page.evaluate(`document.querySelector('#historyViewCounter').textContent`), '4 evaluaciones');
    assert.equal(await page.evaluate(`document.querySelectorAll('#historyList .history-item').length`), 4, 'el panel del Resumen muestra el historial nuevo');

    // Detalle de la evaluación más reciente.
    await page.evaluate(`document.querySelector('[data-history-open]').click()`);
    await page.waitFor(`!document.querySelector('#historyDetail').hidden`);
    const detail = await page.evaluate(`document.querySelector('#historyDetail').innerHTML`);
    assert.match(detail, /Redes Wi-Fi \(2\)/);
    assert.match(detail, /&lt;b&gt;Nueva&lt;\/b&gt;/, 'el SSID se escapa al mostrarlo');
    assert.match(detail, /No disponible/, 'la identidad desconocida se muestra como no disponible');

    // Comparación de las dos evaluaciones completas.
    // La lista se vuelve a dibujar tras cada selección: se consulta de nuevo antes de cada clic.
    await page.evaluate(`(() => { const pick = index => document.querySelectorAll('[data-history-pick]')[index].click(); pick(0); pick(1); document.querySelector('#historyCompareButton').click(); })()`);
    await page.waitFor(`!document.querySelector('#historyComparison').hidden`);
    const comparison = await page.evaluate(`document.querySelector('#historyComparison').textContent`);
    assert.match(comparison, /Redes nuevas \(1\)/);
    assert.match(comparison, /Dejaron de aparecer \(1\)/);
    assert.match(comparison, /Cambios de canal \(1\)/);
    assert.match(comparison, /Cambios de autenticación \(1\)/);
    assert.match(comparison, /redujeron su protección/);
    assert.match(comparison, /0 → 1 anuncios con dirección aleatoria|1 → 1 anuncios con dirección aleatoria/);
    assert.match(comparison, /Direcciones públicas nuevas \(0\)/, 'la dirección aleatoria repetida no se da por el mismo dispositivo');

    // Eliminar una evaluación histórica también la retira del respaldo de localStorage.
    await page.evaluate(`window.confirm = () => true`);
    const legacyId = await page.evaluate(`[...document.querySelectorAll('[data-history-delete]')].map(b => b.dataset.historyDelete).find(id => id.startsWith('legacy-web-'))`);
    await page.evaluate(`document.querySelector('[data-history-delete="${legacyId}"]').click()`);
    await page.waitFor(`document.querySelector('#historyViewCounter').textContent === '3 evaluaciones'`);
    assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('vigia-suite-analysis-history-v1')).length`), 2);

    // Política de conservación: máximo 20 no elimina nada; eliminar todo pide confirmación y vacía ambos almacenes.
    await page.evaluate(`document.querySelector('#historyMaxCount').value = '20'; document.querySelector('#historyRetentionApply').click()`);
    await page.waitFor(`document.querySelector('#historyRetentionResult').textContent.includes('Política guardada')`);
    await page.evaluate(`window.confirm = () => false; document.querySelector('#historyDeleteAll').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#historyViewCounter').textContent`), '3 evaluaciones', 'cancelar no borra');
    await page.evaluate(`window.confirm = () => true; document.querySelector('#clearHistoryButton').click()`);
    await page.waitFor(`document.querySelector('#historyViewCounter').textContent === '0 evaluaciones'`);
    assert.equal(await page.evaluate(`localStorage.getItem('vigia-suite-analysis-history-v1')`), null);
  });
});

async function runSimulatedAnalysis(page) {
  // Si algo falla, el error incluye el estado y la consola serial de la página para diagnosticarlo.
  const diagnose = async promise => {
    try { await promise; } catch (error) {
      const context = await page.evaluate(`JSON.stringify({ status: document.querySelector('#statusCopy').textContent, stage: document.querySelector('#analysisStage').textContent, terminal: document.querySelector('#terminal').textContent.slice(-800) })`).catch(() => '');
      throw new Error(`${error.message}\n${context}`);
    }
  };
  await page.goto('/dashboard.html');
  await diagnose(page.waitFor(`document.querySelector('#historyStatus')?.textContent.startsWith('Historial listo')`));
  await page.evaluate(`document.querySelector('#connectButton').click()`);
  await diagnose(page.waitFor(`document.querySelector('#liveText').textContent === 'SENSOR EN LÍNEA'`));
  await diagnose(page.waitFor(`document.querySelector('#protocolValue').textContent === 'VIGIA/2'`));
  await diagnose(page.waitFor(`(window.__commands || []).includes('PING') && /Enlace validado/.test(document.querySelector('#statusCopy').textContent)`));
  await page.evaluate(`document.querySelector('#startAnalysisButton').click()`);
  await diagnose(page.waitFor(`/Análisis finalizado/.test(document.querySelector('#analysisStage').textContent)`, 20000));
}

test('flujo completo con sensor simulado: VIGIA/2, puntuación sin cambios y evaluación guardada con identidad', { skip, timeout: 90000 }, async () => {
  await withBrowser({}, async page => {
    await page.addInitScript(FAKE_SERIAL(false));
    await runSimulatedAnalysis(page);
    assert.deepEqual(await page.evaluate('window.__commands'), ['PING', 'INFO', 'STATUS', 'SCAN_WIFI', 'SCAN_BLE'], 'la secuencia de comandos del análisis no cambió');
    // Fórmula existente: 1 abierta (3) + abierta cercana (5) + WEP (12) + 33 % abiertas (10) + BLE público conectable cercano (2) = 32.
    assert.equal(await page.evaluate(`document.querySelector('#riskScore').textContent`), '32');
    assert.equal(await page.evaluate(`document.querySelector('#analysisLevel').textContent`), 'Riesgo medio');
    assert.equal(await page.evaluate(`document.querySelector('#analysisStage').textContent`), 'Análisis finalizado y guardado localmente.');
    assert.equal(await page.evaluate(`document.querySelector('#metricNetworks').textContent`), '3');
    await page.waitFor(`document.querySelector('#historyViewCounter').textContent === '1 evaluación'`);
    await page.evaluate(`document.querySelector('[data-history-open]').click()`);
    await page.waitFor(`!document.querySelector('#historyDetail').hidden`);
    const detail = await page.evaluate(`document.querySelector('#historyDetail').textContent`);
    for (const text of ['32/100 · MEDIO', 'Completa', '3 Wi-Fi · 1 BLE', 'Sí, se alcanzó el límite del sensor', 'nodemcu-esp32s', '04:B2:47:82:60:1C', '0.5.0-arduino', 'VIGIA/2', 'AA:AA:AA:AA:AA:03', '[oculta]', 'WEP', '11:22:33:44:55:66', 'Apple'])
      assert.ok(detail.includes(text), `el detalle debería incluir «${text}»`);
    assert.equal(await page.evaluate(`localStorage.getItem('vigia-suite-analysis-history-v1')`), null, 'con IndexedDB ya no se escriben resúmenes en localStorage');
  });
});

test('flujo con BLE fallido: la evaluación se guarda como incompleta', { skip, timeout: 90000 }, async () => {
  await withBrowser({}, async page => {
    await page.addInitScript(FAKE_SERIAL(true));
    await runSimulatedAnalysis(page);
    await page.waitFor(`document.querySelector('#historyViewCounter').textContent === '1 evaluación'`);
    const list = await page.evaluate(`document.querySelector('#historyViewList').textContent`);
    assert.match(list, /Incompleta/);
    assert.match(list, /BLE falló/);
    assert.match(list, /Wi-Fi truncado/);
  });
});

test('sin IndexedDB se conserva el comportamiento anterior: resumen en localStorage', { skip, timeout: 90000 }, async () => {
  await withBrowser({}, async page => {
    await page.addInitScript(`Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });`);
    await page.addInitScript(FAKE_SERIAL(false));
    await page.goto('/dashboard.html');
    await page.waitFor(`/no está disponible/.test(document.querySelector('#historyStatus').textContent)`);
    await page.evaluate(`document.querySelector('#connectButton').click()`);
    await page.waitFor(`/Enlace validado/.test(document.querySelector('#statusCopy').textContent)`);
    await page.evaluate(`document.querySelector('#startAnalysisButton').click()`);
    await page.waitFor(`document.querySelector('#analysisStage').textContent === 'Análisis finalizado y guardado localmente.'`, 20000);
    const saved = await page.evaluate(`JSON.parse(localStorage.getItem('vigia-suite-analysis-history-v1'))`);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].score, 32);
    assert.equal(saved[0].wifiNetworks, undefined, 'el resumen no incluye observaciones, como antes');
    assert.equal(await page.evaluate(`document.querySelector('#historyCounter').textContent`), '1 sesión');
  });
});

test('si IndexedDB rechaza la escritura, el resumen se guarda en localStorage y se migra después', { skip, timeout: 90000 }, async () => {
  await withBrowser({}, async page => {
    await page.addInitScript(`const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) { if (window.__failAdd) throw new DOMException('Cuota agotada', 'QuotaExceededError'); return add.apply(this, args); };`);
    await page.addInitScript(FAKE_SERIAL(false));
    await page.goto('/dashboard.html');
    await page.waitFor(`document.querySelector('#historyStatus')?.textContent.startsWith('Historial listo')`);
    await page.evaluate(`window.__failAdd = true; document.querySelector('#connectButton').click()`);
    await page.waitFor(`/Enlace validado/.test(document.querySelector('#statusCopy').textContent)`);
    await page.evaluate(`document.querySelector('#startAnalysisButton').click()`);
    await page.waitFor(`document.querySelector('#analysisStage').textContent === 'Análisis finalizado y guardado localmente.'`, 20000);
    assert.match(await page.evaluate(`document.querySelector('#terminal').textContent`), /No se pudo guardar la evaluación completa: Cuota agotada/);
    assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('vigia-suite-analysis-history-v1')).length`), 1);
    // Al recargar con el almacenamiento sano, el resumen pasa a IndexedDB como evaluación histórica.
    await page.goto('/dashboard.html');
    await page.waitFor(`document.querySelector('#historyStatus')?.textContent.startsWith('Historial listo')`);
    assert.match(await page.evaluate(`document.querySelector('#historyStatus').textContent`), /1 resumen\(es\) anterior\(es\) migrado/);
    assert.match(await page.evaluate(`document.querySelector('#historyViewList').textContent`), /Histórica · sólo resumen/);
  });
});
