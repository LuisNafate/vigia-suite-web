import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNvdClient, memoryStore, MIN_INTERVAL_MS, RATE_LIMIT_BACKOFF_MS, CACHE_TTL_MS } from '../pc-lab/nvd-client.js';

// Ninguna prueba consulta a NVD: fetch, el reloj y las esperas son simulados.
const URL_A = 'https://services.nvd.nist.gov/rest/json/cves/2.0?cveIds=CVE-2021-44228';
const URL_B = 'https://services.nvd.nist.gov/rest/json/cves/2.0?cveIds=CVE-2022-0001';
const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => { throw new Error('sin cuerpo'); } });

function harness(responses, options = {}) {
  let clock = 1_000_000;
  const sleeps = [];
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, at: clock });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init) : next;
  };
  const client = createNvdClient({ fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, ...options });
  return { client, calls, sleeps, advance: ms => { clock += ms; }, now: () => clock };
}

test('respeta 6 s entre peticiones: nunca más de 5 en una ventana de 30 s', async () => {
  const urls = Array.from({ length: 12 }, (_, index) => `${URL_A}&n=${index}`);
  const h = harness(urls.map(() => ok({ vulnerabilities: [] })));
  for (const url of urls) await h.client.get(url);
  assert.equal(MIN_INTERVAL_MS, 6000);
  assert.equal(h.calls.length, 12);
  for (let index = 1; index < h.calls.length; index += 1) assert.ok(h.calls[index].at - h.calls[index - 1].at >= 6000);
  for (const call of h.calls) assert.ok(h.calls.filter(other => other.at >= call.at && other.at < call.at + 30000).length <= 5);
});

test('las peticiones simultáneas a la misma URL se agrupan en una sola', async () => {
  const h = harness([ok({ vulnerabilities: [1] })]);
  const [a, b] = await Promise.all([h.client.get(URL_A), h.client.get(URL_A)]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(a.data, b.data);
});

test('envía sólo la URL pública: sin credenciales, referer ni clave de API', async () => {
  const h = harness([ok({ vulnerabilities: [] })]);
  await h.client.get(URL_A);
  const { init } = h.calls[0];
  assert.deepEqual(init.headers, { Accept: 'application/json' });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
});

test('la caché indica cuándo se consultó, caduca a las 24 h y se puede forzar la actualización', async () => {
  const h = harness([ok({ v: 1 }), ok({ v: 2 }), ok({ v: 3 })]);
  const first = await h.client.get(URL_A);
  assert.equal(first.fromCache, false);
  h.advance(60_000);
  const cached = await h.client.get(URL_A);
  assert.deepEqual([cached.fromCache, cached.fetchedAt, cached.data.v, h.calls.length], [true, first.fetchedAt, 1, 1]);
  const forced = await h.client.get(URL_A, { force: true });
  assert.deepEqual([forced.fromCache, forced.data.v, h.calls.length], [false, 2, 2]);
  h.advance(CACHE_TTL_MS + 1);
  const expired = await h.client.get(URL_A);
  assert.deepEqual([expired.fromCache, expired.data.v, h.calls.length], [false, 3, 3]);
});

test('HTTP 429: espera 30 s y reintenta una vez', async () => {
  const waits = [];
  const h = harness([fail(429), ok({ v: 'ok' })], { onWait: info => waits.push(info) });
  const result = await h.client.get(URL_A);
  assert.equal(result.data.v, 'ok');
  assert.equal(h.calls.length, 2);
  assert.ok(waits.some(info => info.reason === 'rate_limited' && info.ms === RATE_LIMIT_BACKOFF_MS));
  assert.ok(h.calls[1].at - h.calls[0].at >= RATE_LIMIT_BACKOFF_MS);
});

test('HTTP 429 repetido termina en un error de frecuencia, sin reintentos infinitos', async () => {
  const h = harness([fail(429), fail(429), ok({})]);
  await assert.rejects(h.client.get(URL_A), error => error.kind === 'rate_limited' && error.status === 429);
  assert.equal(h.calls.length, 2);
});

test('HTTP 503 se reintenta una vez; 403, 404 y 500 no', async () => {
  const unavailable = harness([fail(503), ok({ v: 1 })]);
  assert.equal((await unavailable.client.get(URL_A)).data.v, 1);
  for (const [status, kind] of [[403, 'forbidden'], [404, 'bad_request'], [500, 'http']]) {
    const h = harness([fail(status), ok({})]);
    await assert.rejects(h.client.get(URL_A), error => error.kind === kind && error.status === status);
    assert.equal(h.calls.length, 1, `HTTP ${status} no se reintenta`);
  }
});

test('una respuesta que no es JSON es un error de formato', async () => {
  const h = harness([{ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }]);
  await assert.rejects(h.client.get(URL_A), error => error.kind === 'format');
});

test('sin conexión: error sin caché; con una copia guardada se entrega marcada como sin conexión', async () => {
  const offline = harness([new TypeError('Failed to fetch')]);
  await assert.rejects(offline.client.get(URL_A), error => error.kind === 'offline');

  const store = memoryStore();
  // Copia caducada (más de 24 h): se intenta NVD y, al fallar la red, se entrega la copia con su fecha original.
  const old = 1_000_000 - CACHE_TTL_MS - 1;
  await store.put({ url: URL_B, data: { v: 'guardada' }, fetchedAt: old });
  const h = harness([new TypeError('Failed to fetch')], { store });
  const result = await h.client.get(URL_B);
  assert.equal(h.calls.length, 1);
  assert.deepEqual([result.data.v, result.fromCache, result.stale, result.offline, result.fetchedAt], ['guardada', true, true, true, old]);
});

test('tiempo agotado: la petición se cancela y se informa', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('abortada', 'AbortError'))));
  const client = createNvdClient({ fetchImpl, timeoutMs: 20, minIntervalMs: 0 });
  await assert.rejects(client.get(URL_A), error => error.kind === 'timeout');
});

test('un error de una consulta no bloquea las siguientes', async () => {
  const h = harness([fail(500), ok({ v: 'siguiente' })]);
  await assert.rejects(h.client.get(URL_A));
  assert.equal((await h.client.get(URL_B)).data.v, 'siguiente');
});
