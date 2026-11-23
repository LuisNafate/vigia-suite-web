// Vulnerabilidades documentadas (NVD): presentación. La lógica de datos está en nvd-core.js y la comunicación en
// nvd-client.js. Esta vista no lee el inventario del sensor: sólo envía lo que la persona escribe o elige.
import * as nvd from './nvd-core.js';
import { createNvdClient, memoryStore } from './nvd-client.js';
import { openNvdStore } from './nvd-store.js';

const $ = selector => document.querySelector(selector);
const ui = {
  modes: [...document.querySelectorAll('[data-nvd-mode]')], form: $('#nvdForm'), query: $('#nvdQuery'), queryLabel: $('#nvdQueryLabel'),
  hint: $('#nvdHint'), exactOption: $('#nvdExactOption'), exact: $('#nvdExact'), rejectedOption: $('#nvdRejectedOption'), noRejected: $('#nvdNoRejected'),
  search: $('#nvdSearch'), refresh: $('#nvdRefresh'), status: $('#nvdStatus'), fetched: $('#nvdFetched'),
  cpePanel: $('#nvdCpePanel'), cpeTable: $('#nvdCpeTable'), cpeCounter: $('#nvdCpeCounter'), cpeMore: $('#nvdCpeMore'),
  resultsPanel: $('#nvdResultsPanel'), resultsTitle: $('#nvdResultsTitle'), counter: $('#nvdCounter'), selection: $('#nvdSelection'),
  table: $('#nvdTable'), more: $('#nvdMore'), applicabilityHead: $('#nvdApplicabilityHead'), detail: $('#nvdDetail'),
  severity: $('#nvdFilterSeverity'), version: $('#nvdFilterVersion'), statusFilter: $('#nvdFilterStatus'), sort: $('#nvdSort'), text: $('#nvdFilterText'),
};
if (!ui.form) throw new Error('La vista NVD no está en esta página.');

const MODES = Object.freeze({
  cve: { label: 'Identificador CVE', placeholder: 'CVE-2021-44228', hint: 'Escribe un identificador con la forma CVE-AAAA-NNNN.' },
  keyword: { label: 'Palabras clave', placeholder: 'apache log4j', hint: 'NVD busca las palabras en la descripción vigente de cada CVE. No escribas datos personales ni direcciones de tus dispositivos.' },
  cpe: { label: 'Producto o fabricante', placeholder: 'openssl 1.1.1', hint: 'Primero busca el producto en el diccionario CPE y después elige la versión exacta para consultar sus CVE.' },
});
const PENDING = new Set(['Received', 'Awaiting Analysis', 'Undergoing Analysis']);

const state = {
  mode: 'cve', client: null, busy: false,
  // Última consulta de CVE: urlFor(startIndex) reconstruye cada página para «Cargar más» y «Actualizar».
  cves: [], cvePages: [], cveNext: null, cveTotal: null, urlFor: null, cpe: null,
  cpes: [], cpeNext: null, cpeTotal: null, cpeQuery: '',
  lastResponse: null,
};

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const dateLabel = ms => (ms === null ? 'No disponible' : new Date(ms).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }));
const dayLabel = ms => (ms === null ? '—' : new Date(ms).toLocaleDateString('es-MX', { dateStyle: 'medium' }));
const setStatus = (text, kind = 'info') => { ui.status.textContent = text; ui.status.dataset.kind = kind; };

function setMode(mode) {
  state.mode = mode;
  ui.modes.forEach(button => button.classList.toggle('active', button.dataset.nvdMode === mode));
  ui.queryLabel.textContent = MODES[mode].label;
  ui.query.placeholder = MODES[mode].placeholder;
  ui.hint.textContent = MODES[mode].hint;
  ui.exactOption.hidden = mode !== 'keyword';
  ui.rejectedOption.hidden = mode === 'cve';
}

function severityTag(metric) {
  if (!metric) return '<span class="nvd-severity unscored">Sin puntuación CVSS</span>';
  const score = metric.score === null ? 'sin valor' : metric.score.toFixed(1);
  return `<span class="nvd-severity ${(metric.severity ?? 'unscored').toLowerCase()}">${escapeHtml(metric.severity ? nvd.severityLabel(metric.severity) : 'Sin severidad')} · ${escapeHtml(score)}</span><small class="cell-detail">CVSS ${escapeHtml(metric.version)} · ${escapeHtml(metric.source ?? 'fuente no informada')}</small>`;
}

function filteredCves() {
  const text = ui.text.value.trim().toLowerCase();
  const items = state.cves.filter(({ item }) => {
    const metric = item.primaryMetric;
    if (ui.severity.value === 'unscored' ? metric?.severity : ui.severity.value !== 'all' && metric?.severity !== ui.severity.value) return false;
    if (ui.version.value === 'none' ? item.metrics.length : ui.version.value !== 'all' && !item.metrics.some(m => m.version === ui.version.value)) return false;
    if (ui.statusFilter.value === 'active' && item.rejected) return false;
    if (ui.statusFilter.value === 'rejected' && !item.rejected) return false;
    if (ui.statusFilter.value === 'pending' && !PENDING.has(item.status)) return false;
    return !text || item.id.toLowerCase().includes(text) || (item.description ?? '').toLowerCase().includes(text);
  });
  const by = { published: entry => entry.item.published ?? -Infinity, modified: entry => entry.item.lastModified ?? -Infinity, score: entry => entry.item.primaryMetric?.score ?? -Infinity };
  const key = by[ui.sort.value];
  return key ? [...items].sort((a, b) => key(b) - key(a)) : items;
}

function renderCves() {
  ui.resultsPanel.hidden = false;
  ui.applicabilityHead.hidden = !state.cpe;
  const visible = filteredCves();
  const total = state.cveTotal === null ? 'total no informado' : `${state.cveTotal} en NVD`;
  ui.counter.textContent = `${visible.length} de ${state.cves.length} cargadas · ${total}`;
  ui.selection.textContent = state.cpe ? `Producto elegido: ${state.cpe.title ?? state.cpe.cpeName} (${state.cpe.cpeName}). Se muestran las CVE en las que NVD lo marca como vulnerable.` : '';
  const columns = state.cpe ? 6 : 5;
  if (!state.cves.length) ui.table.innerHTML = `<tr class="empty-row"><td colspan="${columns}">NVD no devolvió vulnerabilidades para esta consulta.</td></tr>`;
  else if (!visible.length) ui.table.innerHTML = `<tr class="empty-row"><td colspan="${columns}">Ningún resultado cargado coincide con los filtros.</td></tr>`;
  else ui.table.innerHTML = visible.map(({ item, applicability }) => `<tr>
    <td><button class="link-button nvd-open" type="button" data-nvd-open="${escapeHtml(item.id)}">${escapeHtml(item.id)}</button><small class="cell-detail nvd-summary">${escapeHtml(item.description ?? 'Descripción no disponible')}</small></td>
    <td>${severityTag(item.primaryMetric)}</td>
    <td>${escapeHtml(nvd.statusLabel(item.status))}${item.kev ? '<small class="cell-detail">En el catálogo KEV de CISA</small>' : ''}</td>
    <td>${escapeHtml(dayLabel(item.published))}</td><td>${escapeHtml(dayLabel(item.lastModified))}</td>
    ${state.cpe ? `<td><span class="nvd-applicability ${applicability.status}">${escapeHtml(nvd.APPLICABILITY_LABELS[applicability.status])}</span></td>` : ''}</tr>`).join('');
  ui.more.hidden = state.cveNext === null;
}

function renderCpes() {
  ui.cpePanel.hidden = false;
  ui.cpeCounter.textContent = `${state.cpes.length} cargados · ${state.cpeTotal ?? 'total no informado'} en NVD`;
  ui.cpeTable.innerHTML = state.cpes.length ? state.cpes.map((item, index) => `<tr>
    <td><strong>${escapeHtml(item.title ?? nvd.productLabel(item.cpeName))}</strong>${item.deprecated ? `<small class="cell-detail">Entrada obsoleta${item.deprecatedBy.length ? `; reemplazada por ${escapeHtml(item.deprecatedBy.join(', '))}` : ''}</small>` : ''}</td>
    <td>${escapeHtml(item.version === '*' ? 'Cualquiera' : item.version === '-' ? 'Sin versión' : item.version)}</td>
    <td><code>${escapeHtml(item.cpeName)}</code></td>
    <td><button class="secondary" type="button" data-nvd-cpe="${index}">Ver CVE</button></td></tr>`).join('')
    : '<tr class="empty-row"><td colspan="4">NVD no encontró productos con esas palabras.</td></tr>';
  ui.cpeMore.hidden = state.cpeNext === null;
}

function fetchedText(response) {
  if (!response) return '';
  const when = dateLabel(response.fetchedAt);
  if (response.offline) return `Sin conexión con NVD: se muestran datos guardados el ${when}. Usa «Actualizar desde NVD» cuando vuelva la red.`;
  return response.fromCache ? `Datos guardados en este navegador, consultados el ${when}.` : `Consultado en NVD el ${when}.`;
}

async function request(url, { force = false } = {}) {
  state.busy = true;
  ui.search.disabled = true; ui.refresh.disabled = true; ui.more.disabled = true; ui.cpeMore.disabled = true;
  setStatus('Consultando NVD…', 'loading');
  try {
    const response = await state.client.get(url, { force });
    state.lastResponse = response;
    ui.fetched.textContent = fetchedText(response);
    return response;
  } finally {
    state.busy = false;
    ui.search.disabled = false; ui.refresh.disabled = !state.urlFor && !state.cpeQuery; ui.more.disabled = false; ui.cpeMore.disabled = false;
  }
}

function showError(error) {
  const message = error?.kind ? error.message : `No se pudo completar la consulta: ${error?.message ?? error}`;
  setStatus(message, 'error');
}

function addCves(parsed, startIndex) {
  if (startIndex === 0) { state.cves = []; state.cvePages = []; }
  const known = new Set(state.cves.map(entry => entry.item.id));
  parsed.items.filter(item => !known.has(item.id)).forEach(item => state.cves.push({ item, applicability: state.cpe ? nvd.applicabilityFor(item, state.cpe.cpeName) : null }));
  state.cvePages.push(startIndex);
  state.cveNext = parsed.page.nextStartIndex;
  state.cveTotal = parsed.page.totalResults;
}

async function loadCves(startIndex = 0, { force = false } = {}) {
  const response = await request(state.urlFor(startIndex), { force });
  const parsed = nvd.parseCveResponse(response.data);
  addCves(parsed, startIndex);
  renderCves();
  const skipped = parsed.skipped ? ` ${parsed.skipped} registro(s) sin identificador válido se omitieron.` : '';
  setStatus(state.cves.length ? `${state.cves.length} vulnerabilidad(es) cargada(s).${skipped}` : `Sin resultados en NVD para esta consulta.${skipped}`, state.cves.length ? 'done' : 'empty');
  return parsed;
}

async function loadCpes(startIndex = 0, { force = false } = {}) {
  const response = await request(nvd.cpeSearchUrl(state.cpeQuery, { startIndex }), { force });
  const parsed = nvd.parseCpeResponse(response.data);
  if (startIndex === 0) state.cpes = [];
  state.cpes.push(...parsed.items.filter(item => !state.cpes.some(known => known.cpeName === item.cpeName)));
  state.cpeNext = parsed.page.nextStartIndex;
  state.cpeTotal = parsed.page.totalResults;
  renderCpes();
  setStatus(state.cpes.length ? 'Elige el producto y la versión exactos para ver sus CVE.' : 'NVD no encontró productos con esas palabras.', state.cpes.length ? 'done' : 'empty');
}

function resetResults() {
  state.cves = []; state.cveNext = null; state.cveTotal = null; state.urlFor = null; state.cpe = null;
  ui.resultsPanel.hidden = true; ui.table.innerHTML = ''; ui.counter.textContent = ''; ui.more.hidden = true;
  ui.detail.hidden = true; ui.detail.innerHTML = ''; delete ui.detail.dataset.cve;
}

async function search(event) {
  event?.preventDefault();
  if (state.busy) return;
  const text = ui.query.value;
  const options = { exact: ui.exact.checked, noRejected: ui.noRejected.checked };
  try {
    if (state.mode === 'cpe') {
      nvd.cpeSearchUrl(text); // valida antes de limpiar los resultados anteriores
      resetResults();
      state.cpeQuery = text;
      await loadCpes(0);
      return;
    }
    const urlFor = state.mode === 'cve' ? () => nvd.cveByIdUrl(text) : startIndex => nvd.cveByKeywordUrl(text, { ...options, startIndex });
    urlFor(0);
    resetResults();
    state.cpeQuery = ''; ui.cpePanel.hidden = true;
    state.urlFor = urlFor;
    ui.resultsTitle.textContent = state.mode === 'cve' ? 'Vulnerabilidad' : 'Vulnerabilidades por palabra clave';
    const parsed = await loadCves(0);
    if (state.mode === 'cve' && parsed.items.length === 1) openDetail(parsed.items[0].id);
    if (state.mode === 'cve' && !parsed.items.length) setStatus(`NVD no tiene un registro con el identificador ${nvd.normalizeCveId(text)}.`, 'empty');
  } catch (error) { showError(error); }
}

async function selectCpe(index) {
  const cpe = state.cpes[index];
  if (!cpe || state.busy) return;
  const noRejected = ui.noRejected.checked;
  state.cpe = cpe;
  state.urlFor = startIndex => nvd.cveByCpeUrl(cpe.cpeName, { noRejected, startIndex });
  ui.resultsTitle.textContent = 'Vulnerabilidades del producto elegido';
  ui.detail.hidden = true;
  try { await loadCves(0); ui.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (error) { showError(error); }
}

async function refresh() {
  if (state.busy) return;
  try {
    if (state.urlFor) {
      const pages = state.cvePages.length ? [...state.cvePages] : [0];
      for (const startIndex of pages) await loadCves(startIndex, { force: true });
      const open = ui.detail.dataset.cve;
      if (open && !ui.detail.hidden) openDetail(open);
    } else if (state.cpeQuery) await loadCpes(0, { force: true });
  } catch (error) { showError(error); }
}

const list = (items, render, empty) => (items.length ? `<ul class="nvd-list">${items.map(render).join('')}</ul>` : `<p class="empty-copy">${escapeHtml(empty)}</p>`);

function configurationHtml(configuration, index) {
  const nodes = configuration.nodes.map(node => `<li><strong>${node.negate ? 'No debe cumplirse' : node.operator === 'AND' ? 'Todos estos' : 'Cualquiera de estos'}</strong><ul class="nvd-list">${node.matches.map(match => `<li>${escapeHtml(nvd.productLabel(match.criteria))} · ${escapeHtml(nvd.rangeLabel(match))} · ${match.vulnerable === true ? 'vulnerable' : match.vulnerable === false ? 'plataforma o requisito (no vulnerable por sí solo)' : 'vulnerabilidad no indicada'}<small class="cell-detail"><code>${escapeHtml(match.criteria)}</code></small></li>`).join('')}</ul></li>`).join('');
  const how = configuration.operator === 'AND' ? 'Se deben cumplir todos los grupos a la vez' : 'Basta con cualquiera de los grupos';
  return `<li><h4>Configuración ${index + 1} · ${how}</h4><ul class="nvd-list">${nodes}</ul></li>`;
}

function openDetail(id) {
  const entry = state.cves.find(candidate => candidate.item.id === id);
  if (!entry) return;
  const { item, applicability } = entry;
  ui.detail.dataset.cve = id;
  const metrics = item.metrics.length ? `<div class="table-wrap"><table><thead><tr><th>VERSIÓN</th><th>PUNTUACIÓN</th><th>SEVERIDAD</th><th>FUENTE</th><th>TIPO</th><th>VECTOR</th></tr></thead><tbody>${item.metrics.map(metric => `<tr><td>CVSS ${escapeHtml(metric.version)}</td><td>${metric.score === null ? 'Sin valor' : metric.score.toFixed(1)}</td><td>${escapeHtml(metric.severity ? nvd.severityLabel(metric.severity) : 'Sin severidad')}</td><td>${escapeHtml(metric.source ?? 'No informada')}</td><td>${escapeHtml(metric.type === 'Primary' ? 'Principal (NVD)' : metric.type === 'Secondary' ? 'Secundaria (CNA)' : 'No informado')}</td><td><code>${escapeHtml(metric.vector ?? '—')}</code></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-copy">Sin métricas CVSS publicadas. No se interpreta como riesgo bajo.</p>';
  const affected = list(item.affected, product => `<li>${escapeHtml([product.vendor, product.product].filter(Boolean).join(' · '))}${product.versions.length ? `<small class="cell-detail">${escapeHtml(product.versions.map(v => `${v.version ?? ''}${v.lessThan ? ` hasta antes de ${v.lessThan}` : ''}${v.lessThanOrEqual ? ` hasta ${v.lessThanOrEqual} incluida` : ''}${v.status ? ` (${v.status})` : ''}`).join('; '))}</small>` : ''}${product.source ? `<small class="cell-detail">Fuente: ${escapeHtml(product.source)}</small>` : ''}</li>`, 'La CNA no publicó datos de productos afectados.');
  ui.detail.innerHTML = `
    <div class="panel-heading"><div><p class="overline">DETALLE · DATOS DE NVD</p><h2>${escapeHtml(item.id)}</h2></div><button class="ghost" type="button" id="nvdDetailClose">Cerrar</button></div>
    <div class="history-tags">${item.rejected ? '<span class="history-tag legacy">Rechazada</span>' : ''}${item.kev ? '<span class="history-tag nvd-kev">Catálogo KEV de CISA</span>' : ''}${item.tags.map(tag => `<span class="history-tag">${escapeHtml(tag)}</span>`).join('')}</div>
    <p class="nvd-description">${escapeHtml(item.description ?? 'NVD no incluye una descripción para este registro.')}</p>
    <div class="history-detail-grid">
      <dl class="history-facts">
        <div><dt>Estado en NVD</dt><dd>${escapeHtml(nvd.statusLabel(item.status))}</dd></div>
        <div><dt>Publicada</dt><dd>${escapeHtml(dateLabel(item.published))}</dd></div>
        <div><dt>Última modificación</dt><dd>${escapeHtml(dateLabel(item.lastModified))}</dd></div>
        <div><dt>Puntuación principal</dt><dd>${item.primaryMetric ? `${escapeHtml(item.primaryMetric.score?.toFixed(1) ?? 'sin valor')} · ${escapeHtml(item.primaryMetric.severity ? nvd.severityLabel(item.primaryMetric.severity) : 'sin severidad')} · CVSS ${escapeHtml(item.primaryMetric.version)}` : 'Sin puntuación CVSS'}</dd></div>
        <div><dt>Debilidades (CWE)</dt><dd>${escapeHtml(item.weaknesses.join(', ') || 'No informadas')}</dd></div>
        ${item.kev ? `<div><dt>KEV: añadida / fecha límite</dt><dd>${escapeHtml(item.kev.added)} / ${escapeHtml(item.kev.dueDate ?? '—')}</dd></div>` : ''}
      </dl>
      <div>${applicability ? `<h4>Aplicabilidad para ${escapeHtml(state.cpe.title ?? state.cpe.cpeName)}</h4><p><span class="nvd-applicability ${applicability.status}">${escapeHtml(nvd.APPLICABILITY_LABELS[applicability.status])}</span></p>${applicability.requirements.length ? `<p class="history-help">Requiere además: ${escapeHtml(applicability.requirements.join('; '))}.</p>` : ''}<p class="history-help">Comprobación local de los rangos y condiciones publicados por NVD; no confirma que tu equipo concreto sea vulnerable.</p>` : '<p class="history-help">Para comprobar versiones y condiciones, busca tu producto en «Producto (CPE)» y elige su versión.</p>'}</div>
    </div>
    <h3>Puntuaciones CVSS</h3>${metrics}
    <h3>Productos y configuraciones afectados según NVD</h3>${item.configurations.length ? `<ul class="nvd-list nvd-configurations">${item.configurations.map(configurationHtml).join('')}</ul>` : '<p class="empty-copy">NVD todavía no publicó configuraciones para esta CVE.</p>'}
    <h3>Productos afectados según la CNA</h3>${affected}
    <h3>Referencias (${item.references.length})</h3>${list(item.references, ref => `<li><a href="${escapeHtml(ref.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ref.url)}</a><small class="cell-detail">${escapeHtml([ref.source, ...ref.tags].filter(Boolean).join(' · '))}</small></li>`, 'Sin referencias publicadas.')}
    <p class="history-help"><a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(item.id)}" target="_blank" rel="noopener noreferrer">Abrir el registro en nvd.nist.gov</a> · ${escapeHtml(fetchedText(state.lastResponse))}</p>`;
  ui.detail.hidden = false;
  ui.detail.querySelector('#nvdDetailClose').addEventListener('click', () => { ui.detail.hidden = true; });
  ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function start() {
  let store = memoryStore();
  try { store = await openNvdStore(); } catch { /* sin IndexedDB: la caché dura mientras la página esté abierta */ }
  state.client = createNvdClient({
    store,
    onWait: ({ reason, ms }) => setStatus(reason === 'interval'
      ? `Esperando ${Math.ceil(ms / 1000)} s para respetar el límite de frecuencia de NVD…`
      : reason === 'rate_limited' ? `NVD limitó la frecuencia (HTTP 429). Se reintentará en ${Math.ceil(ms / 1000)} s…`
        : `NVD no está disponible (HTTP 503). Se reintentará en ${Math.ceil(ms / 1000)} s…`, 'loading'),
  });
  ui.modes.forEach(button => button.addEventListener('click', () => setMode(button.dataset.nvdMode)));
  ui.form.addEventListener('submit', search);
  ui.refresh.addEventListener('click', refresh);
  ui.more.addEventListener('click', () => state.cveNext !== null && loadCves(state.cveNext).catch(showError));
  ui.cpeMore.addEventListener('click', () => state.cpeNext !== null && loadCpes(state.cpeNext).catch(showError));
  ui.cpeTable.addEventListener('click', event => { const button = event.target.closest('[data-nvd-cpe]'); if (button) selectCpe(Number(button.dataset.nvdCpe)); });
  ui.table.addEventListener('click', event => { const button = event.target.closest('[data-nvd-open]'); if (button) openDetail(button.dataset.nvdOpen); });
  [ui.severity, ui.version, ui.statusFilter, ui.sort].forEach(control => control.addEventListener('change', renderCves));
  ui.text.addEventListener('input', renderCves);
  setMode('cve');
  window.VigiaNvd = Object.freeze({ isReady: () => Boolean(state.client) });
}

start();
