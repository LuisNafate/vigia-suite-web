import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyPublishedFirmware } from '../scripts/verify-firmware.mjs';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const idsIn = html => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
const selectorsIn = source => [...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]);

test('dashboard.html contiene todos los elementos que usan app.js, installer.js e history.js', async () => {
  const ids = idsIn(await read('pc-lab/dashboard.html'));
  for (const file of ['pc-lab/app.js', 'pc-lab/installer.js', 'pc-lab/history.js']) {
    const missing = selectorsIn(await read(file)).filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `${file} referencia ids inexistentes`);
  }
});

test('dashboard.html no repite ids', async () => {
  const html = await read('pc-lab/dashboard.html');
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(all.filter((id, index) => all.indexOf(id) !== index), []);
});

test('installer.js se carga como módulo y app.js expone la API para el instalador', async () => {
  const html = await read('pc-lab/dashboard.html');
  assert.match(html, /<script type="module" src="installer.js"><\/script>/);
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="installer.js"'), 'app.js debe cargarse antes que installer.js');
  const app = await read('pc-lab/app.js');
  for (const name of ['isConnected', 'isBusy', 'currentPort', 'disconnect', 'connectPort', 'showView']) assert.match(app, new RegExp(`${name}:`));
  assert.match(app, /grantedPorts\.length === 1/, 'no debe autoconectarse al primero de varios puertos');
});

test('el instalador sólo importa esptool-js desde la copia local verificada', async () => {
  const installer = await read('pc-lab/installer.js');
  const imports = [...installer.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports.sort(), ['./firmware-core.js', './vendor/esptool-js-0.7.0/bundle.js']);
  const vendor = JSON.parse(await read('pc-lab/vendor/esptool-js-0.7.0/VENDOR.json'));
  const bundle = await readFile(new URL('../pc-lab/vendor/esptool-js-0.7.0/bundle.js', import.meta.url));
  assert.equal(createHash('sha256').update(bundle).digest('hex'), vendor.sha256, 'bundle.js fue modificado');
  const { ESPLoader, Transport } = await import('../pc-lab/vendor/esptool-js-0.7.0/bundle.js');
  assert.equal(typeof ESPLoader, 'function');
  assert.equal(typeof Transport, 'function');
});

test('el instalador nunca flashea sin consentimiento ni borra toda la flash', async () => {
  const installer = await read('pc-lab/installer.js');
  assert.match(installer, /if \(state\.busy \|\| !state\.port \|\| !state\.release \|\| !ui\.consent\.checked\) return;/);
  assert.match(installer, /eraseAll: false/);
  assert.doesNotMatch(installer, /eraseFlash\(/);
  assert.match(installer, /loader\.chip\.CHIP_NAME !== release\.chip/);
});

test('el botón Instalar no depende de archivos que sólo se verifican al pulsarlo', async () => {
  const installer = await read('pc-lab/installer.js');
  const line = installer.match(/ui\.install\.disabled = ([^;]+);/)[1];
  assert.doesNotMatch(line, /state\.files/);
  assert.match(line, /ui\.consent\.checked/);
});

test('el atributo hidden prevalece sobre los display de los paneles del instalador', async () => {
  const css = await read('pc-lab/styles.css');
  assert.match(css, /\.view \[hidden\] \{ display: none !important; \}/);
});

test('el service worker no cachea firmware ni la API local', async () => {
  const sw = await read('pc-lab/service-worker.js');
  assert.match(sw, /startsWith\('\/firmware\/'\)/);
  assert.match(sw, /startsWith\('\/api\/'\)/);
  assert.match(sw, /'\/installer\.js'/);
});

test('el firmware publicado coincide con su manifiesto', async () => {
  const result = await verifyPublishedFirmware();
  assert.ok(result.ok, result.messages.join('\n'));
});

test('macLabel muestra la MAC real tanto del firmware nuevo como del antiguo', async () => {
  const app = await read('pc-lab/app.js');
  const source = app.match(/function macLabel\(value\) \{[\s\S]*?^\}/m)[0];
  const macLabel = new Function(`${source}; return macLabel;`)();
  // 0.5.0: ya llega en notacion estandar.
  assert.equal(macLabel('04:B2:47:82:60:1C'), '04:B2:47:82:60:1C');
  assert.equal(macLabel('04:b2:47:82:60:1c'), '04:B2:47:82:60:1C');
  // <=0.4.0: 12 hex con los bytes invertidos.
  assert.equal(macLabel('1C608247B204'), '04:B2:47:82:60:1C');
  // Valores vacios o inesperados se dejan pasar sin inventar nada.
  assert.equal(macLabel(undefined), '');
  assert.equal(macLabel('no-aplica'), 'no-aplica');
});

test('authLabel muestra los modos 0-16 del núcleo 3.3.12 y nunca presenta un valor inválido como abierta', async () => {
  const app = await read('pc-lab/app.js');
  const table = app.match(/const AUTH_LABELS = \[[\s\S]*?\];/)[0];
  const source = app.match(/function authLabel\(value\) \{[\s\S]*?^\}/m)[0];
  const authLabel = new Function(`${table}; ${source}; return authLabel;`)();
  assert.deepEqual(Array.from({ length: 17 }, (_, mode) => authLabel(mode)), [
    'Abierta', 'WEP', 'WPA-PSK', 'WPA2-PSK', 'WPA/WPA2', 'WPA2 Enterprise', 'WPA3-PSK', 'WPA2/WPA3', 'WAPI',
    'OWE', 'WPA3 Enterprise 192 bits', 'WPA3-PSK (EXT)', 'WPA3-PSK mixto (EXT)', 'DPP', 'WPA3 Enterprise', 'WPA2/WPA3 Enterprise', 'WPA Enterprise',
  ]);
  assert.equal(authLabel(17), 'Modo 17 no reconocido');
  for (const invalid of [undefined, null, '0', '3', 0.5, -1, 256, true, NaN]) assert.equal(authLabel(invalid), 'No informada', String(invalid));
});

test('el filtro «protegidas» no incluye redes sin autenticación informada', async () => {
  const app = await read('pc-lab/app.js');
  assert.match(app, /wifiFilter === 'protected' && Number\.isInteger\(network\.auth\) && network\.auth !== 0/);
});

test('history.js se carga como módulo después de app.js y el service worker lo incluye', async () => {
  const html = await read('pc-lab/dashboard.html');
  assert.match(html, /<script type="module" src="history.js"><\/script>/);
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="history.js"'));
  assert.match(html, /data-view="historial"/);
  assert.match(html, /data-view-target="historial"/);
  const sw = await read('pc-lab/service-worker.js');
  for (const file of ['/history.js', '/history-core.js', '/history-store.js']) assert.ok(sw.includes(`'${file}'`), `${file} falta en el service worker`);
  const app = await read('pc-lab/app.js');
  assert.match(app, /labels: Object\.freeze\(\{ authLabel, addressTypeLabel, manufacturerLabel \}\)/);
});

test('el historial no envía datos fuera del navegador', async () => {
  for (const file of ['pc-lab/history.js', 'pc-lab/history-core.js', 'pc-lab/history-store.js']) {
    const source = await read(file);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|nvd\.nist/i, `${file} no debe hacer peticiones de red`);
  }
});

test('la puntuación de app.js no cambió con el historial', async () => {
  const app = await read('pc-lab/app.js');
  const source = app.match(/let score = 0;[\s\S]*?score = Math\.min\(100, score\);/)[0];
  const compute = new Function('open', 'strongOpen', 'weak', 'total', 'busiest', 'stableNearbyBle', `${source}; return score;`);
  const many = n => Array.from({ length: n }, () => ({ connectable: true }));
  assert.equal(compute(many(2), many(1), many(1), 8, ['6', 3], many(0)), 2 * 3 + 5 + 12 + 10);
  assert.equal(compute(many(20), many(10), many(5), 30, ['6', 12], many(9)), 100);
  assert.equal(compute([], [], [], 4, ['1', 13], many(3)), 5 + 6);
});
