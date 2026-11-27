// Extrae funciones de pc-lab/app.js (script clásico, sin exportaciones) para probarlas tal como están escritas.
import { readFile } from 'node:fs/promises';
// app.js usa globalThis.VigiaBleAddress, que ble-address.js publica antes de que se cargue app.js.
import '../pc-lab/ble-address.js';

const appSource = () => readFile(new URL('../pc-lab/app.js', import.meta.url), 'utf8');
const pick = (source, pattern) => {
  const match = source.match(pattern);
  if (!match) throw new Error(`app.js ya no contiene ${pattern}`);
  return match[0];
};

/** withValidFields() y sus rangos, tal como los usa handleLine al recibir wifi_ap y ble_device. */
export async function loadFieldFilter() {
  const app = await appSource();
  const source = [/const WIFI_FIELDS = .*;/, /const BLE_FIELDS = .*;/, /function withValidFields\(event, fields\) \{[\s\S]*?^\}/m]
    .map(pattern => pick(app, pattern)).join('\n');
  return new Function(`${source}; return { WIFI_FIELDS, BLE_FIELDS, withValidFields };`)();
}

/** Validador del respaldo histórico de localStorage, antes de que sus datos lleguen al DOM. */
export async function loadHistorySummaryNormalizer() {
  const app = await appSource();
  const source = [/const HISTORY_LEVELS = .*;/, /const historyInteger = .*;/,
    /function normalizeHistorySummary\(raw\) \{[\s\S]*?^\}/m].map(pattern => pick(app, pattern)).join('\n');
  return new Function(`${source}; return normalizeHistorySummary;`)();
}

/**
 * Cálculo de renderAnalysis() desde `const total` hasta el nivel, sin tocar el DOM. Recibe los arrays que app.js
 * guarda en `networks` y `bleDevices` (ya filtrados por withValidFields) y devuelve { score, level }.
 */
export async function loadScoring() {
  const app = await appSource();
  const source = pick(app, /const total = networks\.length;[\s\S]*?const level = [^\n]*/);
  const ble = pick(app, /const bleAddress = .*;/);
  return new Function('networks', 'bleDevices', `${ble}\n${channelSource(app)}\n${source}; return { score, level };`);
}

/** Etiqueta de privacidad y clasificación BLE que usa app.js (SCORE_FORMULA_VERSION incluida). */
export async function loadBleLabels() {
  const app = await appSource();
  const source = [/const SCORE_FORMULA_VERSION = .*;/, /const bleAddress = .*;/, /const bleClass = .*;/, /function addressTypeLabel\(type, address\) \{.*\}/]
    .map(pattern => pick(app, pattern)).join('\n');
  return new Function(`${source}; return { SCORE_FORMULA_VERSION, addressTypeLabel, bleClass };`)();
}

/** legacyEnterpriseNotice(): aviso informativo del modo 16, sin puntos. */
export async function loadLegacyEnterpriseNotice() {
  const app = await appSource();
  return new Function(`${pick(app, /function legacyEnterpriseNotice\(list\) \{[\s\S]*?^\}/m)}; return legacyEnterpriseNotice;`)();
}

const channelSource = app => [/const CONGESTION_SCORE_NETWORKS = .*;/, /const CHANNEL_ADVICE_NETWORKS = .*;/,
  /function busiestChannel\(list\) \{[\s\S]*?^\}/m, /function channelNotices\(busiest\) \{[\s\S]*?^\}/m].map(pattern => pick(app, pattern)).join('\n');

/** busiestChannel() y channelNotices(): umbrales de canal de la puntuación, los hallazgos y los consejos. */
export async function loadChannelNotices() {
  const app = await appSource();
  return new Function(`${channelSource(app)}; return { CONGESTION_SCORE_NETWORKS, CHANNEL_ADVICE_NETWORKS, busiestChannel, channelNotices };`)();
}
