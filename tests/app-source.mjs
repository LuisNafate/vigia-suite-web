// Extrae funciones de pc-lab/app.js (script clásico, sin exportaciones) para probarlas tal como están escritas.
import { readFile } from 'node:fs/promises';

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

/**
 * Cálculo de renderAnalysis() desde `const total` hasta el nivel, sin tocar el DOM. Recibe los arrays que app.js
 * guarda en `networks` y `bleDevices` (ya filtrados por withValidFields) y devuelve { score, level }.
 */
export async function loadScoring() {
  const app = await appSource();
  const source = pick(app, /const total = networks\.length;[\s\S]*?const level = [^\n]*/);
  return new Function('networks', 'bleDevices', `${source}; return { score, level };`);
}
