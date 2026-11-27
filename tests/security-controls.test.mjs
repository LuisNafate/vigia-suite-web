import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadHistorySummaryNormalizer } from './app-source.mjs';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('el respaldo histórico acepta sólo resúmenes íntegros producidos por Vigía', async () => {
  const normalize = await loadHistorySummaryNormalizer();
  const valid = {
    createdAt: '2026-11-27T12:00:00.000Z', score: 32, level: 'MEDIO',
    wifi: { total: 3, open: 1 }, bluetooth: { total: 2, nearby: 1 },
  };
  assert.deepEqual(normalize(valid), valid);
  const payload = '<img src=x onerror="globalThis.__xss=true">';
  for (const malformed of [
    { ...valid, score: payload },
    { ...valid, level: payload },
    { ...valid, createdAt: payload },
    { ...valid, wifi: { ...valid.wifi, total: payload } },
    { ...valid, bluetooth: { ...valid.bluetooth, nearby: payload } },
    { ...valid, wifi: { total: 1, open: 2 } },
    { ...valid, bluetooth: { total: 1, nearby: 2 } },
  ]) assert.equal(normalize(malformed), null);
});

test('el historial de respaldo usa nodos de texto y no plantillas HTML dinámicas', async () => {
  const app = await read('pc-lab/app.js');
  const render = app.match(/function renderHistory\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
  assert.match(render, /replaceChildren\(\)/);
  assert.match(render, /textContent/);
  assert.doesNotMatch(render, /innerHTML/);
});

test('Vercel aplica una CSP restrictiva y encabezados defensivos', async () => {
  const config = JSON.parse(await read('pc-lab/vercel.json'));
  const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /connect-src 'self' https:\/\/services\.nvd\.nist\.gov/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /'unsafe-inline'|'unsafe-eval'|\*/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Strict-Transport-Security'], 'max-age=63072000; includeSubDomains; preload');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /serial=\(self\)/);
});

test('las páginas cumplen la CSP sin scripts, estilos ni eventos en línea', async () => {
  for (const file of ['pc-lab/index.html', 'pc-lab/dashboard.html']) {
    const html = await read(file);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file}: script en línea`);
    assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, `${file}: estilo en línea`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${file}: evento en línea`);
  }
});
