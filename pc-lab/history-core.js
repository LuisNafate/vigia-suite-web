// Lógica pura del historial de Vigía Suite (sin DOM ni IndexedDB), compartida por history.js y las pruebas.
// El modelo lógico es equivalente al de Android (HistoryModels.kt): mismos campos, estados y criterios de comparación.

export const HISTORY_SCHEMA = 'vigia-history/1';
export const LEGACY_WEB_HISTORY_KEY = 'vigia-suite-analysis-history-v1';
export const RETENTION_KEY = 'vigia-suite-history-retention-v1';
export const STATUS = Object.freeze({ COMPLETE: 'complete', PARTIAL: 'partial', LEGACY: 'legacy' });
export const SOURCE = Object.freeze({ LIVE: 'live', LEGACY: 'legacy' });
export const LEVELS = Object.freeze(['BAJO', 'MEDIO', 'ALTO']);
export const RETENTION_COUNT_OPTIONS = Object.freeze([20, 50, 100, 0]);
export const RETENTION_AGE_OPTIONS = Object.freeze([30, 90, 365, 0]);
// 100 evaluaciones sin límite de antigüedad: conserva al menos las 20 sesiones que ya guardaba la versión anterior.
export const DEFAULT_RETENTION = Object.freeze({ maxCount: 100, maxAgeDays: 0 });
export const BLE_ADDRESS_TYPES = Object.freeze(['public', 'random', 'public_identity', 'random_identity']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

const intOrNull = (value, min, max) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
};
// Campos de una observación del sensor: sólo un número JSON entero. Un texto como "0" no es un modo válido y no debe
// convertirse en «red abierta» (mismo criterio que el parser de Android y que el panel, que compara con === 0).
const observedInt = (value, min, max) => (typeof value === 'number' ? intOrNull(value, min, max) : null);
const boolOrNull = value => (typeof value === 'boolean' ? value : null);
const textOrNull = value => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text && text !== '—' ? text : null;
};

/** Normaliza una MAC/BSSID a AA:BB:CC:DD:EE:FF. Devuelve null si no es válida (no se inventa). */
export function normalizeMac(value) {
  const text = String(value ?? '').trim().toUpperCase().replaceAll('-', ':');
  return MAC_RE.test(text) ? text : null;
}

/** Observación Wi-Fi con los campos que entrega el evento wifi_ap de VIGIA/2. SSID '' = oculto; null = no informado. */
export function normalizeWifiObservation(raw = {}) {
  return {
    ssid: typeof raw.ssid === 'string' ? raw.ssid : null,
    bssid: normalizeMac(raw.bssid),
    channel: observedInt(raw.channel, 1, 196),
    rssi: observedInt(raw.rssi, -127, 20),
    auth: observedInt(raw.auth, 0, 255),
  };
}

/** Observación BLE con los campos del evento ble_device de VIGIA/2. */
export function normalizeBleObservation(raw = {}) {
  const addressType = BLE_ADDRESS_TYPES.includes(raw.address_type ?? raw.addressType) ? (raw.address_type ?? raw.addressType) : 'unknown';
  const manufacturer = raw.manufacturer_id ?? raw.manufacturerId;
  const services = typeof raw.services === 'string' ? raw.services.trim() : '';
  return {
    name: typeof raw.name === 'string' ? raw.name : null,
    address: normalizeMac(raw.address),
    addressType,
    rssi: observedInt(raw.rssi, -127, 20),
    connectable: boolOrNull(raw.connectable),
    manufacturerId: intOrNull(manufacturer, 0, 0xffff),
    services: services || null,
  };
}

function sensorFrom(raw = {}) {
  const protocolText = textOrNull(raw.protocol);
  const protocolMatch = protocolText && /(\d+)$/.exec(protocolText);
  return {
    board: textOrNull(raw.board),
    chip: textOrNull(raw.chip),
    mac: normalizeMac(raw.mac),
    firmware: textOrNull(raw.firmware),
    protocol: protocolMatch ? Number(protocolMatch[1]) : null,
  };
}

const levelFor = score => (score >= 60 ? 'ALTO' : score >= 30 ? 'MEDIO' : 'BAJO');

/**
 * Construye una evaluación completa a partir del informe actual de app.js.
 * La puntuación y el nivel se copian tal cual: el historial no recalcula ni modifica la fórmula existente.
 */
export function buildAssessment({ id, createdAt, origin = 'web', status = STATUS.COMPLETE, sensor = {}, score, level,
  wifiNetworks = [], bleDevices = [], wifiTruncated = null, bleTruncated = null, bleFailed = null }) {
  const created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!id) throw new Error('La evaluación necesita un identificador.');
  if (!Number.isFinite(created)) throw new Error('La evaluación necesita una fecha válida.');
  const safeScore = intOrNull(score, 0, 100);
  if (safeScore === null) throw new Error('La puntuación debe estar entre 0 y 100.');
  if (![STATUS.COMPLETE, STATUS.PARTIAL].includes(status)) throw new Error(`Estado de evaluación no válido: ${status}`);
  const wifi = wifiNetworks.map(normalizeWifiObservation);
  const ble = bleDevices.map(normalizeBleObservation);
  return {
    assessment: {
      schema: HISTORY_SCHEMA, id: String(id), createdAt: created, origin, source: SOURCE.LIVE, status,
      sensor: sensorFrom(sensor), score: safeScore, level: LEVELS.includes(level) ? level : levelFor(safeScore),
      wifiCount: wifi.length, bleCount: ble.length,
      wifiOpen: wifi.filter(item => item.auth === 0).length,
      bleNearby: ble.filter(item => item.rssi !== null && item.rssi >= -65).length,
      wifiTruncated: boolOrNull(wifiTruncated), bleTruncated: boolOrNull(bleTruncated), bleFailed: boolOrNull(bleFailed),
      hasObservations: true,
    },
    wifi, ble,
  };
}

export function legacyWebId(raw) {
  return `legacy-web-${Date.parse(raw?.createdAt)}-${raw?.score}`;
}

/**
 * Convierte un registro de localStorage (resumen sin observaciones) en una evaluación histórica.
 * No se inventan observaciones: hasObservations=false y los campos ausentes quedan en null.
 */
export function legacyWebRecordToAssessment(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('registro vacío o con formato desconocido');
  const created = Date.parse(raw.createdAt);
  if (!Number.isFinite(created)) throw new Error('fecha inválida');
  const score = intOrNull(raw.score, 0, 100);
  if (score === null) throw new Error('puntuación fuera de rango');
  if (!LEVELS.includes(raw.level)) throw new Error('nivel desconocido');
  const wifi = raw.wifi || {};
  const bluetooth = raw.bluetooth || {};
  return {
    schema: HISTORY_SCHEMA, id: legacyWebId(raw), createdAt: created, origin: 'web', source: SOURCE.LEGACY, status: STATUS.LEGACY,
    sensor: sensorFrom(raw.sensor), score, level: raw.level,
    wifiCount: intOrNull(wifi.total, 0, 10000), bleCount: intOrNull(bluetooth.total, 0, 10000),
    wifiOpen: intOrNull(wifi.open, 0, 10000), bleNearby: intOrNull(bluetooth.nearby, 0, 10000),
    wifiTruncated: null, bleTruncated: null, bleFailed: boolOrNull(bluetooth.scanFailed),
    hasObservations: false,
  };
}

/** Valida y convierte todos los registros antiguos; los rechazados se informan y se conservan en el origen. */
export function prepareLegacyMigration(rawList) {
  if (!Array.isArray(rawList)) return { records: [], rejected: [{ index: -1, reason: 'el historial anterior no es una lista' }] };
  const records = [];
  const rejected = [];
  const seen = new Set();
  rawList.forEach((raw, index) => {
    try {
      const record = legacyWebRecordToAssessment(raw);
      if (seen.has(record.id)) return;
      seen.add(record.id);
      records.push(record);
    } catch (error) { rejected.push({ index, reason: error.message }); }
  });
  return { records, rejected };
}

/** Quita del respaldo de localStorage los registros antiguos que el usuario eliminó del historial. */
export function removeFromLegacyBackup(rawList, deletedIds) {
  const ids = new Set(deletedIds);
  return Array.isArray(rawList) ? rawList.filter(raw => !ids.has(legacyWebId(raw))) : [];
}

export function normalizeRetention(raw = {}) {
  return {
    maxCount: RETENTION_COUNT_OPTIONS.includes(Number(raw.maxCount)) ? Number(raw.maxCount) : DEFAULT_RETENTION.maxCount,
    maxAgeDays: RETENTION_AGE_OPTIONS.includes(Number(raw.maxAgeDays)) ? Number(raw.maxAgeDays) : DEFAULT_RETENTION.maxAgeDays,
  };
}

/** Identificadores que exceden la política de conservación (0 = sin límite). */
export function selectExpired(assessments, policy, now = Date.now()) {
  const { maxCount, maxAgeDays } = normalizeRetention(policy);
  const sorted = [...assessments].sort((a, b) => b.createdAt - a.createdAt);
  const expired = new Set();
  if (maxAgeDays > 0) sorted.filter(item => now - item.createdAt > maxAgeDays * DAY_MS).forEach(item => expired.add(item.id));
  if (maxCount > 0) sorted.slice(maxCount).forEach(item => expired.add(item.id));
  return sorted.filter(item => expired.has(item.id)).map(item => item.id);
}

/**
 * wifi_auth_mode_t de ESP-IDF v5.5.5 (núcleo Arduino-ESP32 3.3.12 del firmware 0.5.0; el firmware envía el valor
 * sin traducir). El número del modo no es un orden de seguridad: cada modo tiene una familia y, dentro de las
 * familias personal y empresarial, un nivel de cifrado (2 = sólo TKIP, 3 = TKIP/CCMP mixto, 4 = WPA2,
 * 5 = transición WPA2/WPA3, 6 = WPA3, 7 = WPA3 Suite B de 192 bits). WAPI y DPP no tienen nivel comparable.
 * Debe coincidir con HistoryLogic.AUTH_MODES de Android (tests/fixtures/auth-change-cases.json).
 */
const AUTH_MODES = Object.freeze({
  0: { family: 'open', level: null }, // OPEN
  1: { family: 'wep', level: null }, // WEP
  2: { family: 'personal', level: 2 }, // WPA_PSK
  3: { family: 'personal', level: 4 }, // WPA2_PSK
  4: { family: 'personal', level: 3 }, // WPA_WPA2_PSK
  5: { family: 'enterprise', level: 4 }, // ENTERPRISE = WPA2_ENTERPRISE
  6: { family: 'personal', level: 6 }, // WPA3_PSK
  7: { family: 'personal', level: 5 }, // WPA2_WPA3_PSK
  8: { family: 'wapi', level: null }, // WAPI_PSK
  9: { family: 'owe', level: null }, // OWE
  10: { family: 'enterprise', level: 7 }, // WPA3_ENT_192
  11: { family: 'personal', level: 6 }, // WPA3_EXT_PSK (mismo resultado que WPA3_PSK según Espressif)
  12: { family: 'personal', level: 6 }, // WPA3_EXT_PSK_MIXED_MODE (ídem)
  13: { family: 'dpp', level: null }, // DPP
  14: { family: 'enterprise', level: 6 }, // WPA3_ENTERPRISE
  15: { family: 'enterprise', level: 5 }, // WPA2_WPA3_ENTERPRISE
  16: { family: 'enterprise', level: 2 }, // WPA_ENTERPRISE
});
export function authMode(auth) { return Number.isInteger(auth) ? AUTH_MODES[auth] ?? null : null; }

const withCredentialsAndCcmp = mode => mode.family === 'dpp' || (mode.level ?? 0) >= 4;
const compareLevels = (from, to) => (to < from ? 'weaker' : to > from ? 'stronger' : 'equivalent');

/**
 * Cómo cambia la protección de un BSSID que pasa del modo `before` al modo `after`:
 * 'weaker', 'stronger', 'equivalent' o 'unknown'. Sólo se declara un debilitamiento con evidencia técnica:
 * pérdida de cifrado (abierta), cifrado roto (WEP), pérdida de credenciales (OWE frente a WPA2 o superior), un nivel menor dentro de la
 * misma familia, o volver a admitir TKIP. Modos desconocidos y esquemas que no se ordenan entre sí (personal frente
 * a empresarial con el mismo cifrado, WAPI, DPP) quedan en 'unknown'.
 */
export function authProtectionChange(before, after) {
  const from = authMode(before);
  const to = authMode(after);
  if (!from || !to) return 'unknown';
  if (before === after) return 'equivalent';
  // Abierta (sin cifrado) < WEP (cifrado roto) < cualquier otro modo conocido.
  if (to.family === 'open') return 'weaker';
  if (from.family === 'open') return 'stronger';
  if (to.family === 'wep') return 'weaker';
  if (from.family === 'wep') return 'stronger';
  // OWE cifra con CCMP sin autenticar. Frente a un modo con credenciales y cifrado igual o mejor (WPA2 o superior,
  // DPP) es más débil; frente a WPA/TKIP o WAPI se gana cifrado y se pierden credenciales, y no se juzga.
  if (to.family === 'owe') return withCredentialsAndCcmp(from) ? 'weaker' : 'unknown';
  if (from.family === 'owe') return withCredentialsAndCcmp(to) ? 'stronger' : 'unknown';
  if (from.level === null || to.level === null) return 'unknown';
  if (from.family === to.family) return compareLevels(from.level, to.level);
  // Personal frente a empresarial: sólo es comparable cuando uno admite TKIP (nivel 2-3) y el otro no.
  if (to.level <= 3 && from.level >= 4) return 'weaker';
  if (from.level <= 3 && to.level >= 4) return 'stronger';
  return 'unknown';
}
export function isAuthDowngrade(before, after) { return authProtectionChange(before, after) === 'weaker'; }

// Sólo una dirección BLE pública (tipo 0) es un identificador estable. Las aleatorias y las resolubles (RPA)
// cambian con el tiempo, así que nunca se emparejan entre evaluaciones.
export function isStableBleAddress(observation) {
  return observation.addressType === 'public' && observation.address !== null;
}

function strongestByKey(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const current = map.get(key);
    if (!current || (item.rssi ?? -999) > (current.rssi ?? -999)) map.set(key, item);
  }
  return map;
}

/**
 * Compara dos evaluaciones. La más antigua es la referencia, sin importar el orden de los argumentos.
 * Wi-Fi: la identidad de una red es su BSSID. Un BSSID igual con otro SSID es un cambio de nombre, no una red nueva.
 * BLE: sólo se emparejan direcciones públicas; las aleatorias se cuentan, nunca se dan por el mismo dispositivo.
 */
export function compareAssessments(left, right) {
  const [before, after] = left.assessment.createdAt <= right.assessment.createdAt ? [left, right] : [right, left];
  const warnings = [];
  const a = before.assessment;
  const b = after.assessment;
  const detailed = a.hasObservations && b.hasObservations;
  if (!a.hasObservations || !b.hasObservations) warnings.push('Una de las evaluaciones es histórica y sólo conserva el resumen: no se pueden comparar redes ni dispositivos individuales.');
  if (a.wifiTruncated || b.wifiTruncated) warnings.push('El inventario Wi-Fi alcanzó el límite de 32 redes del sensor: una red «desaparecida» puede no haberse informado.');
  if (a.bleTruncated || b.bleTruncated) warnings.push('El inventario BLE alcanzó el límite de 32 dispositivos del sensor.');
  if (a.bleFailed || b.bleFailed) warnings.push('El escaneo Bluetooth falló en una de las evaluaciones: la comparación BLE no es representativa.');
  if (a.status === STATUS.PARTIAL || b.status === STATUS.PARTIAL) warnings.push('Una de las evaluaciones quedó incompleta.');

  const result = {
    before: a, after: b, detailed, warnings,
    score: { before: a.score, after: b.score, delta: b.score - a.score },
    wifi: { added: [], removed: [], channelChanged: [], authChanged: [], renamed: [], ssidReuse: [], unchanged: 0, unidentified: 0 },
    ble: { compared: false, added: [], removed: [], persistent: 0, unmatchedBefore: 0, unmatchedAfter: 0 },
  };
  if (!detailed) return result;

  const oldWifi = strongestByKey(before.wifi, item => item.bssid);
  const newWifi = strongestByKey(after.wifi, item => item.bssid);
  result.wifi.unidentified = before.wifi.filter(item => !item.bssid).length + after.wifi.filter(item => !item.bssid).length;
  const knownSsids = new Set([...oldWifi.values()].map(item => item.ssid).filter(Boolean));
  for (const [bssid, current] of newWifi) {
    const previous = oldWifi.get(bssid);
    if (!previous) {
      result.wifi.added.push(current);
      if (current.ssid && knownSsids.has(current.ssid)) result.wifi.ssidReuse.push(current);
      continue;
    }
    let changed = false;
    if (previous.channel !== null && current.channel !== null && previous.channel !== current.channel) {
      result.wifi.channelChanged.push({ bssid, before: previous, after: current }); changed = true;
    }
    if (previous.auth !== null && current.auth !== null && previous.auth !== current.auth) {
      const protection = authProtectionChange(previous.auth, current.auth);
      result.wifi.authChanged.push({ bssid, before: previous, after: current, protection, downgrade: protection === 'weaker' }); changed = true;
    }
    if (previous.ssid !== null && current.ssid !== null && previous.ssid !== current.ssid) {
      result.wifi.renamed.push({ bssid, before: previous, after: current }); changed = true;
    }
    if (!changed) result.wifi.unchanged += 1;
  }
  for (const [bssid, previous] of oldWifi) if (!newWifi.has(bssid)) result.wifi.removed.push(previous);

  if (!a.bleFailed && !b.bleFailed) {
    result.ble.compared = true;
    const oldBle = strongestByKey(before.ble.filter(isStableBleAddress), item => item.address);
    const newBle = strongestByKey(after.ble.filter(isStableBleAddress), item => item.address);
    result.ble.unmatchedBefore = before.ble.filter(item => !isStableBleAddress(item)).length;
    result.ble.unmatchedAfter = after.ble.filter(item => !isStableBleAddress(item)).length;
    for (const [address, current] of newBle) {
      if (oldBle.has(address)) result.ble.persistent += 1; else result.ble.added.push(current);
    }
    for (const [address, previous] of oldBle) if (!newBle.has(address)) result.ble.removed.push(previous);
  }
  return result;
}

/** Hallazgos de una comparación con la misma severidad en Web y Android. */
export function comparisonFindings(result) {
  const findings = [];
  const downgrades = result.wifi.authChanged.filter(change => change.downgrade);
  const newOpen = result.wifi.added.filter(item => item.auth === 0);
  if (downgrades.length) findings.push({ severity: 'high', title: `${downgrades.length} red(es) redujeron su protección`, detail: 'El mismo BSSID anuncia ahora una protección más débil (menos cifrado, cifrado heredado o sin credenciales). Verifica la configuración del punto de acceso.' });
  if (result.wifi.ssidReuse.length) findings.push({ severity: 'medium', title: `${result.wifi.ssidReuse.length} BSSID nuevo(s) con un SSID ya conocido`, detail: 'Puede ser un AP adicional, una red mesh o un AP no autorizado. Valida ubicación y propietario antes de concluir.' });
  if (newOpen.length) findings.push({ severity: 'medium', title: `${newOpen.length} red(es) abierta(s) nueva(s)`, detail: 'Aparecieron redes sin cifrado que no estaban en la evaluación anterior.' });
  const unrated = result.wifi.authChanged.filter(change => change.protection === 'unknown').length;
  const otherAuth = result.wifi.authChanged.length - downgrades.length - unrated;
  if (otherAuth) findings.push({ severity: 'info', title: `${otherAuth} cambio(s) de autenticación sin pérdida de protección`, detail: 'El BSSID mantiene o mejora su cifrado.' });
  if (unrated) findings.push({ severity: 'info', title: `${unrated} cambio(s) de autenticación sin calificar`, detail: 'El modo no es reconocido o los dos modos no se ordenan entre sí (personal y empresarial con el mismo cifrado, WAPI o DPP). Revísalo manualmente.' });
  if (result.wifi.channelChanged.length) findings.push({ severity: 'info', title: `${result.wifi.channelChanged.length} red(es) cambiaron de canal`, detail: 'Es habitual cuando el AP elige canal automáticamente.' });
  if (result.wifi.renamed.length) findings.push({ severity: 'info', title: `${result.wifi.renamed.length} red(es) cambiaron de nombre`, detail: 'Mismo BSSID con otro SSID: se trata como la misma red reconfigurada, no como una red nueva.' });
  return findings;
}
