// Vista NVD en un navegador real con respuestas simuladas: nunca consulta a NVD. Se omite sin Edge/Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findBrowser, withBrowser } from './browser-harness.mjs';

const skip = typeof WebSocket !== 'function' ? 'Requiere Node 22 o posterior (WebSocket global).'
  : findBrowser() ? false : 'No se encontró Edge ni Chrome (define VIGIA_TEST_BROWSER para ejecutar esta prueba).';
const fixture = JSON.parse(await readFile(new URL('./fixtures/nvd-cases.json', import.meta.url), 'utf8'));
const ANY = ':*:*:*:*:*:*:*';
const cpeResponse = { resultsPerPage: 2, startIndex: 0, totalResults: 2, format: 'NVD_CPE', version: '2.0', timestamp: '2026-11-23T10:00:00.000', products: [
  { cpe: { deprecated: false, cpeName: `cpe:2.3:a:apache:log4j:2.14.1${ANY}`, cpeNameId: 'X1', titles: [{ title: 'Apache Software Foundation Log4j 2.14.1', lang: 'en' }] } },
  { cpe: { deprecated: false, cpeName: `cpe:2.3:a:apache:log4j:2.15.0${ANY}`, cpeNameId: 'X2', titles: [{ title: 'Apache Software Foundation Log4j 2.15.0', lang: 'en' }] } },
] };
const B = 'https://services.nvd.nist.gov/rest/json';
const routes = {
  [`${B}/cves/2.0?cveIds=CVE-2021-44228`]: fixture.responses['cve-log4j'],
  [`${B}/cpes/2.0?keywordSearch=apache%20log4j&resultsPerPage=20&startIndex=0`]: cpeResponse,
  [`${B}/cves/2.0?cpeName=cpe:2.3:a:apache:log4j:2.14.1:%2A:%2A:%2A:%2A:%2A:%2A:%2A&isVulnerable&resultsPerPage=20&startIndex=0`]: fixture.responses['cve-log4j'],
  [`${B}/cves/2.0?keywordSearch=sin%20resultados&resultsPerPage=20&startIndex=0`]: fixture.responses['cve-empty'],
  [`${B}/cves/2.0?keywordSearch=sin%20metricas&resultsPerPage=20&startIndex=0`]: fixture.responses['cve-no-metrics'],
};

// Sustituye fetch sólo para NVD. window.__nvdOffline simula la pérdida de red.
const FAKE_NVD = `(() => {
  const routes = ${JSON.stringify(routes)};
  const realFetch = window.fetch.bind(window);
  window.__nvdRequests = [];
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('${B}')) return realFetch(input, init);
    window.__nvdRequests.push({ url, headers: init && init.headers, credentials: init && init.credentials, at: performance.now() });
    if (window.__nvdOffline) throw new TypeError('Failed to fetch');
    const body = routes[url];
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('', { status: 404 });
  };
})();`;

const text = selector => `document.querySelector(${JSON.stringify(selector)}).textContent`;

test('vista NVD: CVE, detalle, producto CPE, aplicabilidad, sin resultados, caché y sin conexión', { skip, timeout: 120000 }, async () => {
  await withBrowser({}, async page => {
    await page.addInitScript(FAKE_NVD);
    await page.goto('/dashboard.html');
    await page.waitFor(`window.VigiaNvd?.isReady()`);
    await page.evaluate(`document.querySelector('[data-view-target="nvd"]').click()`);
    assert.match(await page.evaluate(text('.nvd-notice')), /This product uses the NVD API but is not endorsed or certified by the NVD\./);

    // 1. Identificador CVE → detalle completo.
    await page.evaluate(`document.querySelector('#nvdQuery').value = ' cve-2021-44228 '; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`!document.querySelector('#nvdDetail').hidden`);
    const detail = await page.evaluate(text('#nvdDetail'));
    for (const fragment of ['CVE-2021-44228', 'Analizada', 'CVSS 3.1', '10.0', 'Crítica', 'CVSS 2.0', 'Principal (NVD)', 'Secundaria (CNA)', 'CWE-917', 'Catálogo KEV de CISA',
      'Se deben cumplir todos los grupos a la vez', 'anteriores a 2.15.0', 'plataforma o requisito', 'Apache Software Foundation · Apache Log4j2', 'Referencias (2)', 'Consultado en NVD el'])
      assert.ok(detail.includes(fragment), `el detalle debería incluir «${fragment}»`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#nvdDetail a')].every(a => /^https?:/.test(a.href) && a.rel.includes('noopener'))`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('#nvdDetail a[href^="javascript"]').length`), 0);

    // 2. La misma consulta se sirve desde la caché de IndexedDB, sin otra petición.
    await page.evaluate(`document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`/Datos guardados en este navegador/.test(${text('#nvdFetched')})`);
    assert.equal(await page.evaluate('window.__nvdRequests.length'), 1);

    // 3. Producto: búsqueda CPE, selección explícita y aplicabilidad por versión.
    await page.evaluate(`document.querySelector('[data-nvd-mode="cpe"]').click(); document.querySelector('#nvdQuery').value = 'apache log4j'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`!document.querySelector('#nvdCpePanel').hidden && document.querySelectorAll('[data-nvd-cpe]').length === 2`, 20000);
    assert.match(await page.evaluate(text('#nvdStatus')), /Elige el producto/);
    await page.evaluate(`document.querySelector('[data-nvd-cpe="0"]').click()`);
    await page.waitFor(`/Afecta al producto elegido según NVD/.test(${text('#nvdTable')})`, 20000);
    assert.equal(await page.evaluate(`document.querySelectorAll('#nvdTable [data-nvd-open]').length`), 1);
    assert.match(await page.evaluate(text('#nvdSelection')), /log4j:2\.14\.1/);
    await page.evaluate(`document.querySelector('[data-nvd-open="CVE-2021-44228"]').click()`);
    await page.waitFor(`/Aplicabilidad para Apache Software Foundation Log4j 2\\.14\\.1/.test(${text('#nvdDetail')})`);

    // 4. Filtros sobre los resultados cargados.
    await page.evaluate(`{ const s = document.querySelector('#nvdFilterSeverity'); s.value = 'LOW'; s.dispatchEvent(new Event('change')); }`);
    assert.match(await page.evaluate(text('#nvdTable')), /Ningún resultado cargado coincide/);
    await page.evaluate(`{ const s = document.querySelector('#nvdFilterSeverity'); s.value = 'all'; s.dispatchEvent(new Event('change')); }`);

    // 5. Sin resultados y CVE sin métricas (nunca «Baja»).
    await page.evaluate(`document.querySelector('[data-nvd-mode="keyword"]').click(); document.querySelector('#nvdQuery').value = 'sin resultados'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`/Sin resultados en NVD/.test(${text('#nvdStatus')})`, 20000);
    assert.match(await page.evaluate(text('#nvdTable')), /NVD no devolvió vulnerabilidades/);
    await page.evaluate(`document.querySelector('#nvdQuery').value = 'sin metricas'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`document.querySelectorAll('#nvdTable [data-nvd-open]').length === 1`, 20000);
    const row = await page.evaluate(text('#nvdTable'));
    assert.match(row, /Sin puntuación CVSS/);
    assert.match(row, /Pendiente de análisis/);
    assert.doesNotMatch(row, /Baja/);

    // 6. Una MAC no se envía y un CVE mal escrito no llega a NVD.
    const before = await page.evaluate('window.__nvdRequests.length');
    await page.evaluate(`document.querySelector('#nvdQuery').value = 'router 04:B2:47:82:60:1C'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`/No se envían direcciones MAC/.test(${text('#nvdStatus')})`);
    await page.evaluate(`document.querySelector('[data-nvd-mode="cve"]').click(); document.querySelector('#nvdQuery').value = 'CVE-21-1'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`/CVE-AAAA-NNNN/.test(${text('#nvdStatus')})`);
    assert.equal(await page.evaluate('window.__nvdRequests.length'), before);

    // 7. Sin conexión: «Actualizar desde NVD» conserva los datos guardados y lo indica.
    await page.evaluate(`document.querySelector('#nvdQuery').value = 'CVE-2021-44228'; document.querySelector('#nvdSearch').click()`);
    await page.waitFor(`!document.querySelector('#nvdDetail').hidden && /Datos guardados/.test(${text('#nvdFetched')})`, 20000);
    await page.evaluate(`window.__nvdOffline = true; document.querySelector('#nvdRefresh').click()`);
    await page.waitFor(`/Sin conexión con NVD: se muestran datos guardados/.test(${text('#nvdFetched')})`, 20000);
    assert.match(await page.evaluate(text('#nvdTable')), /CVE-2021-44228/);

    // Ninguna petición incluyó el inventario del sensor, credenciales ni una clave.
    const requests = await page.evaluate('window.__nvdRequests');
    assert.ok(requests.every(request => request.credentials === 'omit' && !JSON.stringify(request.headers).includes('apiKey')));
    assert.ok(requests.every(request => !/ssid|bssid|address|rssi/i.test(request.url)));
    // Entre dos peticiones a NVD pasan al menos 6 s: el control de frecuencia también actúa en el navegador.
    for (let index = 1; index < requests.length; index += 1) assert.ok(requests[index].at - requests[index - 1].at >= 5990, `intervalo ${index}`);
    assert.ok(requests.length >= 5);
  });
});
