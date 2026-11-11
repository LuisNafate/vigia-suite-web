import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyPublishedFirmware } from '../scripts/verify-firmware.mjs';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const idsIn = html => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
const selectorsIn = source => [...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]);

test('dashboard.html contiene todos los elementos que usan app.js e installer.js', async () => {
  const ids = idsIn(await read('pc-lab/dashboard.html'));
  for (const file of ['pc-lab/app.js', 'pc-lab/installer.js']) {
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
