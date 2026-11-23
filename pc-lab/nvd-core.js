// Lógica pura de la consulta a NVD (CVE API 2.0 y CPE API 2.0): validación de entradas, URL, normalización de
// respuestas y aplicabilidad de un CPE. Sin DOM ni red. Debe interpretar los datos igual que NvdModels.kt de Android;
// tests/fixtures/nvd-cases.json (copia idéntica en los dos repositorios) lo comprueba.
//
// Documentación consultada (nvd.nist.gov/developers, noviembre de 2026): las fechas usan ISO-8601 en UTC; cveId está
// marcado como obsoleto en favor de cveIds; keywordExactMatch, noRejected e isVulnerable se envían sin valor;
// isVulnerable requiere cpeName; las métricas CVSS v2 llevan baseSeverity fuera de cvssData y v3.x/v4.0 dentro.

export const NVD_BASE = 'https://services.nvd.nist.gov/rest/json';
export const CVE_ENDPOINT = `${NVD_BASE}/cves/2.0`;
export const CPE_ENDPOINT = `${NVD_BASE}/cpes/2.0`;
export const PAGE_SIZE = 20;
export const MAX_KEYWORD_LENGTH = 120;
/** Aviso que los Términos de uso de la API piden mostrar de forma visible. */
export const NVD_NOTICE = 'This product uses the NVD API but is not endorsed or certified by the NVD.';

const CVE_ID = /^CVE-\d{4}-\d{4,19}$/;
// Una MAC o un BSSID no identifican un producto ni su versión: no se envían a NVD aunque se escriban como búsqueda.
const HARDWARE_ADDRESS = /(^|[^0-9a-f])[0-9a-f]{2}([:-][0-9a-f]{2}){5}([^0-9a-f]|$)/i;
const SEVERITIES = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
// Orden de preferencia para la puntuación principal: la versión de CVSS más reciente; con la misma versión, Primary.
const METRIC_KEYS = Object.freeze([['cvssMetricV40', '4.0'], ['cvssMetricV31', '3.1'], ['cvssMetricV30', '3.0'], ['cvssMetricV2', '2.0']]);

export class NvdInputError extends Error {
  constructor(message) { super(message); this.name = 'NvdInputError'; this.kind = 'invalid_input'; }
}
export class NvdFormatError extends Error {
  constructor(message) { super(message); this.name = 'NvdFormatError'; this.kind = 'format'; }
}

/** Percent-encoding de un valor de consulta: sólo se dejan sin codificar A-Z a-z 0-9 - _ . ~ y «:». */
export function encodeQueryValue(value) {
  return [...new TextEncoder().encode(String(value))].map(byte => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~:]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export function normalizeCveId(text) {
  const id = String(text ?? '').trim().toUpperCase();
  return CVE_ID.test(id) ? id : null;
}

/** Texto de búsqueda limpio o un NvdInputError con el motivo. */
export function cleanKeyword(text) {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!value) throw new NvdInputError('Escribe al menos una palabra.');
  if (value.length > MAX_KEYWORD_LENGTH) throw new NvdInputError(`La búsqueda admite hasta ${MAX_KEYWORD_LENGTH} caracteres.`);
  if (HARDWARE_ADDRESS.test(value)) throw new NvdInputError('No se envían direcciones MAC, BSSID ni direcciones BLE a NVD: no identifican un producto ni su versión.');
  return value;
}

/** Divide un nombre CPE 2.3 en sus 13 campos respetando los «:» escapados con «\». null si no es válido. */
export function splitCpe(name) {
  if (typeof name !== 'string') return null;
  const parts = [];
  let current = '';
  for (let index = 0; index < name.length; index += 1) {
    const char = name[index];
    if (char === '\\' && index + 1 < name.length) { current += char + name[index + 1]; index += 1; continue; }
    if (char === ':') { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  if (parts.length !== 13 || parts[0].toLowerCase() !== 'cpe' || parts[1] !== '2.3' || !/^[aoh*-]$/i.test(parts[2])) return null;
  if (parts.some(part => part === '')) return null;
  return parts;
}
export const isCpeName = name => splitCpe(name) !== null;

const startIndexOf = value => (Number.isInteger(value) && value >= 0 ? value : 0);
const page = startIndex => `resultsPerPage=${PAGE_SIZE}&startIndex=${startIndexOf(startIndex)}`;

export function cveByIdUrl(text) {
  const id = normalizeCveId(text);
  if (!id) throw new NvdInputError('El identificador debe tener la forma CVE-AAAA-NNNN (por ejemplo, CVE-2021-44228).');
  return `${CVE_ENDPOINT}?cveIds=${id}`;
}

export function cveByKeywordUrl(text, { exact = false, noRejected = false, startIndex = 0 } = {}) {
  const keyword = cleanKeyword(text);
  return `${CVE_ENDPOINT}?keywordSearch=${encodeQueryValue(keyword)}${exact ? '&keywordExactMatch' : ''}${noRejected ? '&noRejected' : ''}&${page(startIndex)}`;
}

export function cpeSearchUrl(text, { startIndex = 0 } = {}) {
  return `${CPE_ENDPOINT}?keywordSearch=${encodeQueryValue(cleanKeyword(text))}&${page(startIndex)}`;
}

/** CVE en las que el CPE seleccionado figura como vulnerable (isVulnerable), con los rangos de versión de NVD. */
export function cveByCpeUrl(cpeName, { noRejected = false, startIndex = 0 } = {}) {
  if (!isCpeName(cpeName)) throw new NvdInputError('Selecciona un producto de la lista de CPE.');
  return `${CVE_ENDPOINT}?cpeName=${encodeQueryValue(cpeName)}&isVulnerable${noRejected ? '&noRejected' : ''}&${page(startIndex)}`;
}

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const bool = value => (typeof value === 'boolean' ? value : null);
const list = value => (Array.isArray(value) ? value : []);

/** Fecha de NVD (UTC sin zona, p. ej. 2021-12-10T10:15:09.143) en milisegundos, o null. */
export function parseNvdDate(value) {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.test(raw)) return null;
  const withMillis = raw.replace(/(\.\d{3})\d+/, '$1');
  const millis = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(withMillis) ? withMillis : `${withMillis}Z`);
  return Number.isFinite(millis) ? millis : null;
}

function normalizeMetric(raw, keyVersion) {
  const data = raw?.cvssData ?? {};
  const score = typeof data.baseScore === 'number' && data.baseScore >= 0 && data.baseScore <= 10 ? data.baseScore : null;
  const severityRaw = keyVersion === '2.0' ? raw?.baseSeverity : data.baseSeverity;
  const severity = typeof severityRaw === 'string' && SEVERITIES.includes(severityRaw.toUpperCase()) ? severityRaw.toUpperCase() : null;
  if (score === null && severity === null) return null;
  return {
    version: text(data.version) ?? keyVersion,
    source: text(raw?.source),
    type: raw?.type === 'Primary' || raw?.type === 'Secondary' ? raw.type : null,
    score,
    severity,
    vector: text(data.vectorString),
  };
}

/** Métricas CVSS de la más reciente a la más antigua; con la misma versión, Primary antes que Secondary. */
export function normalizeMetrics(metrics) {
  const result = [];
  for (const [key, version] of METRIC_KEYS) {
    const entries = list(metrics?.[key]).map(raw => normalizeMetric(raw, version)).filter(Boolean);
    entries.sort((a, b) => (a.type === 'Primary' ? 0 : 1) - (b.type === 'Primary' ? 0 : 1));
    result.push(...entries);
  }
  return result;
}

function normalizeMatch(raw) {
  const criteria = text(raw?.criteria);
  if (!criteria || !isCpeName(criteria)) return null;
  return {
    criteria,
    vulnerable: bool(raw.vulnerable),
    versionStartIncluding: text(raw.versionStartIncluding),
    versionStartExcluding: text(raw.versionStartExcluding),
    versionEndIncluding: text(raw.versionEndIncluding),
    versionEndExcluding: text(raw.versionEndExcluding),
  };
}

const operatorOf = value => (value === 'AND' ? 'AND' : 'OR');

function normalizeConfiguration(raw) {
  const nodes = list(raw?.nodes).map(node => ({
    operator: operatorOf(node?.operator),
    negate: node?.negate === true,
    matches: list(node?.cpeMatch).map(normalizeMatch).filter(Boolean),
  })).filter(node => node.matches.length);
  return nodes.length ? { operator: operatorOf(raw?.operator), negate: raw?.negate === true, nodes } : null;
}

function safeUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function normalizeAffected(raw) {
  return list(raw).flatMap(entry => list(entry?.affectedData).map(item => ({
    source: text(entry?.source),
    vendor: text(item?.vendor),
    product: text(item?.product),
    versions: list(item?.versions).map(version => ({
      version: text(version?.version),
      status: text(version?.status),
      lessThan: text(version?.lessThan),
      lessThanOrEqual: text(version?.lessThanOrEqual),
    })).filter(version => version.version || version.lessThan || version.lessThanOrEqual),
  }))).filter(item => item.vendor || item.product);
}

/** Registro CVE normalizado, o null si no trae un identificador válido. Nada se completa por suposición. */
export function normalizeCve(raw) {
  const id = normalizeCveId(raw?.id);
  if (!id || id !== String(raw.id).trim()) return null;
  const descriptions = list(raw.descriptions).filter(item => text(item?.value));
  const description = text((descriptions.find(item => item.lang === 'en') ?? descriptions[0])?.value);
  const status = text(raw.vulnStatus);
  const metrics = normalizeMetrics(raw.metrics);
  const references = [];
  for (const item of list(raw.references)) {
    const url = safeUrl(item?.url);
    if (url && !references.some(ref => ref.url === url)) references.push({ url, source: text(item?.source), tags: list(item?.tags).filter(tag => typeof tag === 'string') });
  }
  const weaknesses = [...new Set(list(raw.weaknesses).flatMap(item => list(item?.description)).map(item => text(item?.value)).filter(Boolean))];
  const tags = [...new Set(list(raw.cveTags).flatMap(item => list(item?.tags)).filter(tag => typeof tag === 'string'))];
  return {
    id,
    status,
    rejected: status !== null && /^reject/i.test(status),
    published: parseNvdDate(raw.published),
    lastModified: parseNvdDate(raw.lastModified),
    description,
    metrics,
    primaryMetric: metrics[0] ?? null,
    weaknesses,
    tags,
    references,
    configurations: list(raw.configurations).map(normalizeConfiguration).filter(Boolean),
    affected: normalizeAffected(raw.affected),
    kev: text(raw.cisaExploitAdd) ? { added: text(raw.cisaExploitAdd), dueDate: text(raw.cisaActionDue), action: text(raw.cisaRequiredAction), name: text(raw.cisaVulnerabilityName) } : null,
  };
}

function pageOf(json) {
  const total = Number.isInteger(json.totalResults) && json.totalResults >= 0 ? json.totalResults : null;
  const startIndex = Number.isInteger(json.startIndex) && json.startIndex >= 0 ? json.startIndex : 0;
  const resultsPerPage = Number.isInteger(json.resultsPerPage) && json.resultsPerPage >= 0 ? json.resultsPerPage : 0;
  const next = startIndex + resultsPerPage;
  return { totalResults: total, startIndex, resultsPerPage, nextStartIndex: total !== null && resultsPerPage > 0 && next < total ? next : null };
}

export function parseCveResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.vulnerabilities)) throw new NvdFormatError('La respuesta de NVD no tiene el formato de la CVE API 2.0.');
  const items = json.vulnerabilities.map(entry => normalizeCve(entry?.cve));
  return { page: pageOf(json), items: items.filter(Boolean), skipped: items.filter(item => !item).length, timestamp: parseNvdDate(json.timestamp) };
}

export function parseCpeResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.products)) throw new NvdFormatError('La respuesta de NVD no tiene el formato de la CPE API 2.0.');
  const items = json.products.map(entry => {
    const cpe = entry?.cpe;
    const parts = splitCpe(cpe?.cpeName);
    if (!parts) return null;
    const titles = list(cpe.titles).filter(item => text(item?.title));
    return {
      cpeName: cpe.cpeName,
      cpeNameId: text(cpe.cpeNameId),
      title: text((titles.find(item => item.lang === 'en') ?? titles[0])?.title),
      vendor: parts[3], product: parts[4], version: parts[5],
      deprecated: cpe.deprecated === true,
      deprecatedBy: list(cpe.deprecatedBy).map(item => text(item?.cpeName)).filter(isCpeName),
      lastModified: parseNvdDate(cpe.lastModified),
    };
  });
  return { page: pageOf(json), items: items.filter(Boolean), skipped: items.filter(item => !item).length, timestamp: parseNvdDate(json.timestamp) };
}

/**
 * Compara versiones: -1, 0 o 1, o null si no se pueden ordenar con certeza. Sólo se ordenan versiones formadas por
 * números separados por . - _ (2.15 = 2.15.0); con letras (2.0-beta9, 1.1.1k) sólo se reconoce la igualdad exacta.
 */
export function compareVersions(a, b) {
  const left = text(a);
  const right = text(b);
  if (!left || !right) return null;
  if (left.toLowerCase() === right.toLowerCase()) return 0;
  const tokens = value => value.split(/[._-]/);
  const x = tokens(left);
  const y = tokens(right);
  if (![...x, ...y].every(token => /^\d+$/.test(token))) return null;
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = BigInt(x[index] ?? '0') - BigInt(y[index] ?? '0');
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

const hasWildcard = value => /(^|[^\\])[*?]/.test(value) && value !== '*';
const unquote = value => value.replace(/\\(.)/g, '$1').toLowerCase();

/** true, false o null (no se puede decidir) para un campo CPE de un criterio frente al del producto elegido. */
function componentMatches(criteria, name) {
  if (criteria === '*') return true;
  if (hasWildcard(criteria)) return null;
  if (criteria === '-') return name === '-' ? true : name === '*' ? null : false;
  if (name === '*' || name === '-' || hasWildcard(name)) return name === '-' ? false : null;
  return unquote(criteria) === unquote(name);
}

const RANGE_FIELDS = ['versionStartIncluding', 'versionStartExcluding', 'versionEndIncluding', 'versionEndExcluding'];

/** Si un cpeMatch de NVD incluye el producto elegido: true, false o null (no se puede comprobar). */
export function matchApplies(match, cpeName) {
  const criteria = splitCpe(match.criteria);
  const name = splitCpe(cpeName);
  if (!criteria || !name) return null;
  let unknown = false;
  for (const index of [2, 3, 4, 6, 7, 8, 9, 10, 11, 12]) {
    const result = componentMatches(criteria[index], name[index]);
    if (result === false) return false;
    if (result === null) unknown = true;
  }
  const hasRange = RANGE_FIELDS.some(field => match[field]);
  const version = name[5];
  if (!hasRange) {
    const result = componentMatches(criteria[5], version);
    if (result === false) return false;
    return result === null || unknown ? null : true;
  }
  if (version === '*' || version === '-' || hasWildcard(version)) return null;
  const checks = [
    [match.versionStartIncluding, order => order >= 0],
    [match.versionStartExcluding, order => order > 0],
    [match.versionEndIncluding, order => order <= 0],
    [match.versionEndExcluding, order => order < 0],
  ];
  for (const [bound, accept] of checks) {
    if (!bound) continue;
    const order = compareVersions(version, bound);
    if (order === null) { unknown = true; continue; }
    if (!accept(order)) return false;
  }
  return unknown ? null : true;
}

/** Descripción legible del rango de versiones de un cpeMatch. */
export function rangeLabel(match) {
  const parts = [];
  if (match.versionStartIncluding) parts.push(`desde ${match.versionStartIncluding} (incluida)`);
  if (match.versionStartExcluding) parts.push(`posteriores a ${match.versionStartExcluding}`);
  if (match.versionEndIncluding) parts.push(`hasta ${match.versionEndIncluding} (incluida)`);
  if (match.versionEndExcluding) parts.push(`anteriores a ${match.versionEndExcluding}`);
  if (parts.length) return parts.join(', ');
  const version = splitCpe(match.criteria)?.[5];
  if (version === '*') return 'todas las versiones';
  if (version === '-') return 'sin versión aplicable';
  return `versión ${unquote(version ?? '')}`;
}

/** «vendor product» de un criterio CPE, sin escapes. */
export function productLabel(cpeName) {
  const parts = splitCpe(cpeName);
  return parts ? `${unquote(parts[3])} ${unquote(parts[4])}`.replace(/_/g, ' ') : cpeName;
}

/**
 * Aplicabilidad de una CVE para el CPE elegido según las configuraciones de NVD:
 * - applies: un criterio vulnerable incluye el producto y la configuración no exige nada más.
 * - conditional: lo incluye, pero la configuración (AND) exige además otra plataforma o componente.
 * - uncertain: no se pudo comprobar (versión con letras, comodines o versión no indicada en el CPE).
 * - not_matched: NVD la devolvió, pero ningún criterio vulnerable incluye el producto elegido.
 * - no_configurations: NVD todavía no publicó configuraciones (p. ej., pendiente de análisis).
 * requirements enumera las condiciones adicionales de las configuraciones condicionales.
 */
export function applicabilityFor(cve, cpeName) {
  if (!cve.configurations.length) return { status: 'no_configurations', requirements: [] };
  const outcomes = cve.configurations.map(configuration => {
    let direct = false;
    let uncertain = false;
    const others = [];
    configuration.nodes.forEach(node => {
      const results = node.matches.filter(match => match.vulnerable === true).map(match => matchApplies(match, cpeName));
      const hit = !node.negate && results.includes(true);
      if (hit) direct = true;
      else {
        if (!node.negate && results.includes(null)) uncertain = true;
        others.push(node);
      }
    });
    if (!direct) return { status: uncertain ? 'uncertain' : 'not_matched', requirements: [] };
    if (configuration.operator !== 'AND' || others.length === 0) return { status: 'applies', requirements: [] };
    const requirements = others.map(node => `${node.negate ? 'no ' : ''}${node.matches.map(match => `${productLabel(match.criteria)} (${rangeLabel(match)})`).join(node.operator === 'AND' ? ' y ' : ' o ')}`);
    return { status: 'conditional', requirements };
  });
  for (const status of ['applies', 'conditional', 'uncertain']) {
    const found = outcomes.filter(item => item.status === status);
    if (found.length) return { status, requirements: [...new Set(found.flatMap(item => item.requirements))] };
  }
  return { status: 'not_matched', requirements: [] };
}

export const SEVERITY_LABELS = Object.freeze({ CRITICAL: 'Crítica', HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja', NONE: 'Ninguna (CVSS 0)' });
/** Una CVE sin métrica nunca se presenta como baja. */
export const severityLabel = severity => SEVERITY_LABELS[severity] ?? 'Sin puntuación CVSS';

const STATUS_LABELS = Object.freeze({
  Received: 'Recibida', 'Awaiting Analysis': 'Pendiente de análisis', 'Undergoing Analysis': 'En análisis', Analyzed: 'Analizada',
  Modified: 'Modificada', Deferred: 'Diferida', Rejected: 'Rechazada',
});
export const statusLabel = status => (status === null ? 'Estado no informado' : STATUS_LABELS[status] ?? status);

export const APPLICABILITY_LABELS = Object.freeze({
  applies: 'Afecta al producto elegido según NVD',
  conditional: 'Afecta sólo si se cumplen otras condiciones',
  uncertain: 'No se pudo comprobar la versión',
  not_matched: 'NVD la asocia, pero ningún criterio vulnerable incluye el producto elegido',
  no_configurations: 'NVD aún no publicó productos afectados',
});
