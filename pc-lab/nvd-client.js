// Comunicación HTTP con NVD: un único solicitante en serie, control de frecuencia, deduplicación, tiempo de espera,
// reintentos ante 429/503 y caché local. No conoce el DOM ni el formato de los datos (eso es nvd-core.js).
//
// Límite público sin clave (nvd.nist.gov/developers/start-here): 5 peticiones en una ventana móvil de 30 s, y NVD
// recomienda esperar unos 6 s entre peticiones. Con 6 s entre el inicio de dos peticiones nunca se superan 5 en 30 s.
// Desde el navegador sólo se leen las cabeceras expuestas por CORS: «message» y «Retry-After» no están disponibles.

export const MIN_INTERVAL_MS = 6000;
export const TIMEOUT_MS = 30000;
export const RATE_LIMIT_BACKOFF_MS = 30000;
export const UNAVAILABLE_BACKOFF_MS = 10000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class NvdRequestError extends Error {
  /** kind: rate_limited, forbidden, bad_request, http, timeout, offline, format. */
  constructor(kind, message, status = null) { super(message); this.name = 'NvdRequestError'; this.kind = kind; this.status = status; }
}

const MESSAGES = Object.freeze({
  rate_limited: 'NVD limitó la frecuencia de consultas (HTTP 429). Espera unos segundos y vuelve a intentarlo.',
  forbidden: 'NVD rechazó la consulta (HTTP 403). Puede deberse al límite de frecuencia; espera 30 s antes de reintentar.',
  bad_request: 'NVD no aceptó los parámetros de la consulta (HTTP 404).',
  unavailable: 'NVD no está disponible temporalmente (HTTP 503). Vuelve a intentarlo más tarde.',
  timeout: 'NVD no respondió a tiempo. Revisa la conexión y vuelve a intentarlo.',
  offline: 'No hay conexión con NVD. Comprueba la red; las consultas guardadas siguen disponibles.',
  format: 'La respuesta de NVD no es JSON válido.',
});
export const errorMessage = (kind, status) => MESSAGES[kind] ?? `NVD respondió con un error HTTP ${status}.`;

/** Almacén en memoria con la misma interfaz que nvd-store.js (pruebas y navegadores sin IndexedDB). */
export function memoryStore() {
  const entries = new Map();
  return {
    async get(url) { return entries.get(url) ?? null; },
    async put(entry) { entries.set(entry.url, entry); },
    async clear() { entries.clear(); },
    async count() { return entries.size; },
  };
}

/**
 * get(url, { force }) → { data, fetchedAt, fromCache, stale, offline }.
 * - Sin force, una respuesta guardada hace menos de ttlMs se entrega sin consultar a NVD.
 * - Si NVD no está disponible (sin red o tiempo agotado) y hay una copia guardada, se entrega marcada como stale.
 * onWait({ reason, ms }) informa a la interfaz de cada espera (frecuencia o reintento).
 */
export function createNvdClient({
  fetchImpl = (...args) => globalThis.fetch(...args), store = memoryStore(), now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), minIntervalMs = MIN_INTERVAL_MS, timeoutMs = TIMEOUT_MS,
  ttlMs = CACHE_TTL_MS, onWait = () => {},
} = {}) {
  const inFlight = new Map();
  let queue = Promise.resolve();
  let lastStart = -Infinity;

  async function throttle() {
    const wait = lastStart + minIntervalMs - now();
    if (wait > 0) { onWait({ reason: 'interval', ms: wait }); await sleep(wait); }
    lastStart = now();
  }

  async function once(url) {
    await throttle();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch {
      throw new NvdRequestError(timedOut ? 'timeout' : 'offline', errorMessage(timedOut ? 'timeout' : 'offline'));
    } finally { clearTimeout(timer); }
    if (response.ok) {
      try { return await response.json(); } catch { throw new NvdRequestError('format', errorMessage('format'), response.status); }
    }
    const kind = response.status === 429 ? 'rate_limited' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'bad_request'
      : response.status === 503 ? 'unavailable' : 'http';
    throw new NvdRequestError(kind, errorMessage(kind, response.status), response.status);
  }

  async function fetchWithRetry(url) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await once(url); } catch (error) {
        const retryable = (error.kind === 'rate_limited' || error.kind === 'unavailable') && attempt < 1;
        if (!retryable) throw error;
        const ms = error.kind === 'rate_limited' ? RATE_LIMIT_BACKOFF_MS : UNAVAILABLE_BACKOFF_MS;
        onWait({ reason: error.kind, ms });
        await sleep(ms);
      }
    }
  }

  async function load(url, force) {
    const cached = await store.get(url).catch(() => null);
    if (!force && cached && now() - cached.fetchedAt < ttlMs) return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, stale: false, offline: false };
    // Una sola petición a la vez: el orden de llegada se respeta y el intervalo se mide entre peticiones reales.
    const run = queue.then(() => fetchWithRetry(url));
    queue = run.catch(() => {});
    try {
      const data = await run;
      const entry = { url, data, fetchedAt: now() };
      await store.put(entry).catch(() => {});
      return { data, fetchedAt: entry.fetchedAt, fromCache: false, stale: false, offline: false };
    } catch (error) {
      if (cached && (error.kind === 'offline' || error.kind === 'timeout')) {
        return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, offline: true, error };
      }
      throw error;
    }
  }

  return {
    get(url, { force = false } = {}) {
      const key = `${force ? 'force:' : ''}${url}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const promise = load(url, force).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
  };
}
