// Historial completo de Vigía Suite Web (IndexedDB). Se integra con app.js mediante window.VigiaApp,
// igual que installer.js, y publica window.VigiaHistory para que app.js guarde cada evaluación.
import * as core from './history-core.js';
import { openHistoryDb } from './history-store.js';

const $ = selector => document.querySelector(selector);
const ui = {
  status: $('#historyStatus'), counter: $('#historyViewCounter'), list: $('#historyViewList'), compare: $('#historyCompareButton'),
  maxCount: $('#historyMaxCount'), maxAge: $('#historyMaxAge'), applyRetention: $('#historyRetentionApply'),
  retentionResult: $('#historyRetentionResult'), deleteAll: $('#historyDeleteAll'),
  detail: $('#historyDetail'), comparison: $('#historyComparison'),
  recentList: $('#historyList'), recentCounter: $('#historyCounter'), recentClear: $('#clearHistoryButton'),
};
const state = { store: null, ready: false, assessments: [], selected: new Set(), retention: core.DEFAULT_RETENTION };

const app = () => window.VigiaApp;
const labels = () => app()?.labels || {};
const auth = value => (value === null ? 'No informado' : labels().authLabel?.(value) ?? `Modo ${value}`);
const addressType = value => (value === 'unknown' ? 'No informado' : labels().addressTypeLabel?.(value) ?? value);
const manufacturer = value => (value === null ? 'Sin fabricante' : labels().manufacturerLabel?.(value) ?? String(value));
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const unknown = value => (value === null || value === undefined ? 'No disponible' : value);
const dateLabel = ms => new Date(ms).toLocaleString('es-MX');
const ssidLabel = ssid => (ssid === null ? 'No informado' : ssid === '' ? '[oculta]' : ssid);
const rssiLabel = rssi => (rssi === null ? '—' : `${rssi} dBm`);
const STATUS_LABEL = { complete: 'Completa', partial: 'Incompleta', legacy: 'Histórica · sólo resumen' };

function setStatus(text) { ui.status.textContent = text; }

function readLegacyBackup() {
  try { return JSON.parse(localStorage.getItem(core.LEGACY_WEB_HISTORY_KEY) || '[]'); } catch { return null; }
}

function writeLegacyBackup(list) {
  try {
    if (list.length) localStorage.setItem(core.LEGACY_WEB_HISTORY_KEY, JSON.stringify(list));
    else localStorage.removeItem(core.LEGACY_WEB_HISTORY_KEY);
  } catch {}
}

function readRetention() {
  try { return core.normalizeRetention(JSON.parse(localStorage.getItem(core.RETENTION_KEY) || '{}')); } catch { return core.normalizeRetention(); }
}

// Los resúmenes de localStorage se importan como evaluaciones históricas. El original se conserva como respaldo;
// sólo se retira una entrada cuando el usuario la elimina del historial. La importación es idempotente.
async function migrateLegacy() {
  const raw = readLegacyBackup();
  if (raw === null) return 'No se pudo leer el historial anterior de este navegador; se conserva sin cambios.';
  if (!raw.length) return '';
  const { records, rejected } = core.prepareLegacyMigration(raw);
  const result = await state.store.importLegacy(records);
  if (result.mismatched.length) throw new Error(`la verificación no coincide en ${result.mismatched.length} registro(s); el original se conserva`);
  const parts = [];
  if (result.imported) parts.push(`${result.imported} resumen(es) anterior(es) migrado(s) como evaluaciones históricas`);
  if (rejected.length) parts.push(`${rejected.length} registro(s) con formato no válido se conservan sin migrar`);
  return parts.join(' · ');
}

async function deleteIds(ids) {
  await state.store.deleteAssessments(ids);
  const legacy = ids.filter(id => id.startsWith('legacy-web-'));
  if (legacy.length) {
    const raw = readLegacyBackup();
    if (raw) writeLegacyBackup(core.removeFromLegacyBackup(raw, legacy));
  }
  ids.forEach(id => state.selected.delete(id));
}

async function applyRetention(policy = state.retention) {
  const expired = core.selectExpired(state.assessments, policy);
  if (expired.length) await deleteIds(expired);
  return expired.length;
}

async function refresh() {
  state.assessments = await state.store.listAssessments();
  [...state.selected].forEach(id => { if (!state.assessments.some(item => item.id === id)) state.selected.delete(id); });
  render();
}

function summaryLine(item) {
  const count = value => (value === null ? '—' : value);
  return `${count(item.wifiCount)} redes, ${count(item.wifiOpen)} abiertas · ${count(item.bleCount)} BLE, ${count(item.bleNearby)} cercanos`;
}

function flags(item) {
  const tags = [`<span class="history-tag ${item.status}">${STATUS_LABEL[item.status] || item.status}</span>`];
  if (item.wifiTruncated) tags.push('<span class="history-tag partial">Wi-Fi truncado</span>');
  if (item.bleTruncated) tags.push('<span class="history-tag partial">BLE truncado</span>');
  if (item.bleFailed) tags.push('<span class="history-tag partial">BLE falló</span>');
  return tags.join('');
}

function render() {
  const total = state.assessments.length;
  ui.counter.textContent = `${total} ${total === 1 ? 'evaluación' : 'evaluaciones'}`;
  ui.deleteAll.disabled = !total;
  ui.compare.disabled = state.selected.size !== 2;
  ui.list.innerHTML = total ? state.assessments.map(item => `<div class="history-item history-row${state.selected.has(item.id) ? ' selected' : ''}">
      <label class="history-pick"><input type="checkbox" data-history-pick="${escapeHtml(item.id)}" ${state.selected.has(item.id) ? 'checked' : ''} ${!state.selected.has(item.id) && state.selected.size >= 2 ? 'disabled' : ''} aria-label="Seleccionar para comparar"><time>${escapeHtml(dateLabel(item.createdAt))}</time></label>
      <div><strong>${item.score}/100 · ${escapeHtml(item.level)}</strong><p>${escapeHtml(summaryLine(item))}</p><div class="history-tags">${flags(item)}</div></div>
      <div class="button-row"><button class="secondary" data-history-open="${escapeHtml(item.id)}">Ver detalle</button><button class="ghost" data-history-delete="${escapeHtml(item.id)}">Eliminar</button></div>
    </div>`).join('') : '<p class="empty-copy">Aún no hay evaluaciones guardadas. Ejecuta «Evaluar mi entorno» con el sensor conectado.</p>';

  // Panel compacto del Resumen (existente): últimas cinco evaluaciones.
  ui.recentCounter.textContent = `${total} ${total === 1 ? 'sesión' : 'sesiones'}`;
  ui.recentClear.disabled = !total;
  ui.recentList.innerHTML = total ? state.assessments.slice(0, 5).map(item => `<div class="history-item">
      <time>${escapeHtml(dateLabel(item.createdAt))}</time>
      <div><strong>${item.score}/100 · ${escapeHtml(item.level)}</strong><p>${escapeHtml(summaryLine(item))}</p></div>
      <span class="risk-chip ${escapeHtml(item.level.toLowerCase())}">${escapeHtml(item.level)}</span>
    </div>`).join('') : '<p class="empty-copy">Aún no hay análisis guardados.</p>';
}

function wifiTable(items) {
  if (!items.length) return '<p class="empty-copy">Sin redes registradas en esta evaluación.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>SSID</th><th>RSSI</th><th>CANAL</th><th>SEGURIDAD</th><th>BSSID</th></tr></thead><tbody>${[...items].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)).map(item => `<tr>
    <td>${escapeHtml(ssidLabel(item.ssid))}</td><td>${escapeHtml(rssiLabel(item.rssi))}</td><td>${escapeHtml(item.channel ?? '—')}</td>
    <td><span class="security-tag ${item.auth === 0 ? 'open' : ''}">${escapeHtml(auth(item.auth))}</span></td><td>${escapeHtml(item.bssid ?? 'No informado')}</td></tr>`).join('')}</tbody></table></div>`;
}

function bleTable(items) {
  if (!items.length) return '<p class="empty-copy">Sin dispositivos registrados en esta evaluación.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>NOMBRE</th><th>RSSI</th><th>DIRECCIÓN</th><th>TIPO</th><th>CONEXIÓN</th><th>FABRICANTE / SERVICIOS</th></tr></thead><tbody>${[...items].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)).map(item => `<tr>
    <td>${escapeHtml(item.name || '[sin nombre]')}</td><td>${escapeHtml(rssiLabel(item.rssi))}</td><td>${escapeHtml(item.address ?? 'No informada')}</td>
    <td>${escapeHtml(addressType(item.addressType))}</td><td>${item.connectable === null ? 'No informado' : item.connectable ? 'Sí' : 'No'}</td>
    <td><strong>${escapeHtml(manufacturer(item.manufacturerId))}</strong><small class="cell-detail">${escapeHtml(item.services || 'Sin servicios anunciados')}</small></td></tr>`).join('')}</tbody></table></div>`;
}

async function openDetail(id) {
  const record = await state.store.getAssessment(id);
  if (!record) { setStatus('La evaluación ya no existe.'); await refresh(); return; }
  const { assessment: item, wifi, ble } = record;
  const sensor = item.sensor || {};
  const truncated = value => (value === null ? 'No informado' : value ? 'Sí, se alcanzó el límite del sensor' : 'No');
  ui.detail.innerHTML = `<div class="panel-heading"><div><p class="overline">DETALLE DE LA EVALUACIÓN</p><h2>${escapeHtml(dateLabel(item.createdAt))}</h2></div>
      <div class="button-row"><button class="ghost" data-history-delete="${escapeHtml(item.id)}">Eliminar esta evaluación</button><button class="secondary" data-history-close="detail">Cerrar</button></div></div>
    <div class="history-detail-grid">
      <dl class="history-facts">
        <div><dt>Puntuación</dt><dd>${item.score}/100 · ${escapeHtml(item.level)}</dd></div>
        <div><dt>Estado</dt><dd>${escapeHtml(STATUS_LABEL[item.status] || item.status)}</dd></div>
        <div><dt>Observaciones</dt><dd>${escapeHtml(unknown(item.wifiCount))} Wi-Fi · ${escapeHtml(unknown(item.bleCount))} BLE</dd></div>
        <div><dt>Wi-Fi truncado</dt><dd>${escapeHtml(truncated(item.wifiTruncated))}</dd></div>
        <div><dt>BLE truncado</dt><dd>${escapeHtml(truncated(item.bleTruncated))}</dd></div>
        <div><dt>Escaneo BLE</dt><dd>${item.bleFailed === null ? 'No informado' : item.bleFailed ? 'Falló' : 'Completado'}</dd></div>
      </dl>
      <dl class="history-facts">
        <div><dt>Placa</dt><dd>${escapeHtml(unknown(sensor.board))}</dd></div>
        <div><dt>Chip</dt><dd>${escapeHtml(unknown(sensor.chip))}</dd></div>
        <div><dt>MAC del sensor</dt><dd>${escapeHtml(unknown(sensor.mac))}</dd></div>
        <div><dt>Firmware</dt><dd>${escapeHtml(unknown(sensor.firmware))}</dd></div>
        <div><dt>Protocolo</dt><dd>${sensor.protocol ? `VIGIA/${escapeHtml(sensor.protocol)}` : 'No disponible'}</dd></div>
        <div><dt>Identificador</dt><dd>${escapeHtml(item.id)}</dd></div>
      </dl>
    </div>
    ${item.hasObservations ? `<h3>Redes Wi-Fi (${wifi.length})</h3>${wifiTable(wifi)}<h3>Dispositivos Bluetooth LE (${ble.length})</h3>${bleTable(ble)}`
      : '<p class="analysis-note">Evaluación histórica migrada desde la versión anterior: sólo se guardó el resumen. No existen observaciones individuales y no se reconstruyen.</p>'}`;
  ui.detail.hidden = false;
  ui.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changeRows(rows, render) {
  return rows.length ? `<div class="table-wrap"><table><tbody>${rows.map(render).join('')}</tbody></table></div>` : '<p class="empty-copy">Sin cambios.</p>';
}

function networkCell(item) { return `<td>${escapeHtml(ssidLabel(item.ssid))}<small class="cell-detail">${escapeHtml(item.bssid)}</small></td>`; }

async function openComparison() {
  const [first, second] = await Promise.all([...state.selected].map(id => state.store.getAssessment(id)));
  if (!first || !second) { setStatus('Una de las evaluaciones seleccionadas ya no existe.'); await refresh(); return; }
  const result = core.compareAssessments(first, second);
  const findings = core.comparisonFindings(result);
  const severity = { high: 'ALTO', medium: 'MEDIO', info: 'INFO' };
  const delta = result.score.delta > 0 ? `+${result.score.delta}` : String(result.score.delta);
  const wifi = result.wifi;
  const ble = result.ble;
  ui.comparison.innerHTML = `<div class="panel-heading"><div><p class="overline">COMPARACIÓN</p><h2>${escapeHtml(dateLabel(result.before.createdAt))} → ${escapeHtml(dateLabel(result.after.createdAt))}</h2></div>
      <button class="secondary" data-history-close="comparison">Cerrar</button></div>
    <div class="metrics-panel history-compare-metrics">
      <div class="metric"><span>PUNTUACIÓN</span><strong>${result.score.before} → ${result.score.after}</strong><small>${escapeHtml(delta)} puntos</small></div>
      <div class="metric"><span>REDES NUEVAS</span><strong>${result.detailed ? wifi.added.length : '—'}</strong></div>
      <div class="metric"><span>YA NO VISIBLES</span><strong>${result.detailed ? wifi.removed.length : '—'}</strong></div>
      <div class="metric"><span>SIN CAMBIOS</span><strong>${result.detailed ? wifi.unchanged : '—'}</strong></div>
    </div>
    ${result.warnings.map(text => `<p class="analysis-note">${escapeHtml(text)}</p>`).join('')}
    <p class="history-help">Criterio: una red se identifica por su BSSID. Si el BSSID se mantiene con otro SSID, canal o cifrado, es la misma red con otra configuración. Sólo las direcciones BLE públicas se comparan una a una.</p>
    ${result.detailed ? `
    <div class="finding-list">${findings.length ? findings.map(item => `<div class="finding ${item.severity}"><span>${severity[item.severity]}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div></div>`).join('') : '<p class="empty-copy">No se detectaron cambios relevantes de seguridad entre ambas evaluaciones.</p>'}</div>
    <div class="history-compare-grid">
      <section><h3>Redes nuevas (${wifi.added.length})</h3>${changeRows(wifi.added, item => `<tr>${networkCell(item)}<td>Canal ${escapeHtml(item.channel ?? '—')}</td><td>${escapeHtml(auth(item.auth))}${wifi.ssidReuse.includes(item) ? '<small class="cell-detail">SSID ya conocido con otro BSSID</small>' : ''}</td></tr>`)}</section>
      <section><h3>Dejaron de aparecer (${wifi.removed.length})</h3>${changeRows(wifi.removed, item => `<tr>${networkCell(item)}<td>Canal ${escapeHtml(item.channel ?? '—')}</td><td>${escapeHtml(auth(item.auth))}</td></tr>`)}</section>
      <section><h3>Cambios de canal (${wifi.channelChanged.length})</h3>${changeRows(wifi.channelChanged, change => `<tr>${networkCell(change.after)}<td>${escapeHtml(change.before.channel)} → ${escapeHtml(change.after.channel)}</td></tr>`)}</section>
      <section><h3>Cambios de autenticación (${wifi.authChanged.length})</h3>${changeRows(wifi.authChanged, change => `<tr>${networkCell(change.after)}<td>${escapeHtml(auth(change.before.auth))} → ${escapeHtml(auth(change.after.auth))}${change.downgrade ? '<small class="cell-detail">Protección más débil</small>' : ''}</td></tr>`)}</section>
      <section><h3>Cambios de nombre (${wifi.renamed.length})</h3>${changeRows(wifi.renamed, change => `<tr><td>${escapeHtml(change.bssid)}</td><td>${escapeHtml(ssidLabel(change.before.ssid))} → ${escapeHtml(ssidLabel(change.after.ssid))}</td></tr>`)}</section>
      <section><h3>Bluetooth LE</h3>${ble.compared ? `<p class="history-help">${ble.persistent} dirección(es) pública(s) observadas en ambas · ${ble.unmatchedBefore} → ${ble.unmatchedAfter} anuncios con dirección aleatoria, resoluble o no informada (no se comparan individualmente porque pueden cambiar).</p>
        <h4>Direcciones públicas nuevas (${ble.added.length})</h4>${changeRows(ble.added, item => `<tr><td>${escapeHtml(item.name || '[sin nombre]')}<small class="cell-detail">${escapeHtml(item.address)}</small></td><td>${escapeHtml(manufacturer(item.manufacturerId))}</td></tr>`)}
        <h4>Direcciones públicas no observadas (${ble.removed.length})</h4>${changeRows(ble.removed, item => `<tr><td>${escapeHtml(item.name || '[sin nombre]')}<small class="cell-detail">${escapeHtml(item.address)}</small></td><td>${escapeHtml(manufacturer(item.manufacturerId))}</td></tr>`)}`
        : '<p class="empty-copy">No se compara Bluetooth porque el escaneo falló en una de las evaluaciones.</p>'}</section>
    </div>` : ''}`;
  ui.comparison.hidden = false;
  ui.comparison.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function confirmDelete(id) {
  const item = state.assessments.find(entry => entry.id === id);
  if (!item || !window.confirm(`¿Eliminar la evaluación del ${dateLabel(item.createdAt)} y todas sus observaciones? No se puede deshacer.`)) return;
  try {
    await deleteIds([id]);
    ui.detail.hidden = true; ui.comparison.hidden = true;
    await refresh();
    setStatus('Evaluación eliminada.');
  } catch (error) { setStatus(`No se pudo eliminar: ${error.message}`); }
}

async function requestClearAll() {
  if (!state.assessments.length) return;
  if (!window.confirm(`¿Eliminar las ${state.assessments.length} evaluaciones guardadas en este navegador, con todas sus observaciones? No se puede deshacer.`)) return;
  try {
    await state.store.deleteAll();
    writeLegacyBackup([]);
    state.selected.clear();
    ui.detail.hidden = true; ui.comparison.hidden = true;
    await refresh();
    setStatus('Se eliminó todo el historial de este navegador.');
  } catch (error) { setStatus(`No se pudo eliminar el historial: ${error.message}`); }
}

async function saveReport(report, { status = core.STATUS.COMPLETE, sensor = {} } = {}) {
  if (!state.ready) throw new Error('El historial todavía no está disponible.');
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const record = core.buildAssessment({
    id, createdAt: report.createdAt, origin: 'web', status, sensor, score: report.score, level: report.level,
    wifiNetworks: report.wifiNetworks || [], bleDevices: report.bleDevices || [],
    wifiTruncated: report.wifi?.truncated ?? null, bleTruncated: report.bluetooth?.truncated ?? null,
    bleFailed: report.bluetooth?.scanFailed ?? null,
  });
  await state.store.saveAssessment(record);
  await refresh();
  const removed = await applyRetention();
  if (removed) await refresh();
  setStatus(`Evaluación guardada con ${record.wifi.length} redes y ${record.ble.length} dispositivos BLE.${removed ? ` La política de conservación retiró ${removed} evaluación(es) antigua(s).` : ''}`);
  return id;
}

function populateRetention() {
  const countLabel = value => (value ? `${value} evaluaciones` : 'Sin límite de cantidad');
  const ageLabel = value => (value ? `${value} días` : 'Sin límite de antigüedad');
  ui.maxCount.innerHTML = core.RETENTION_COUNT_OPTIONS.map(value => `<option value="${value}">${countLabel(value)}</option>`).join('');
  ui.maxAge.innerHTML = core.RETENTION_AGE_OPTIONS.map(value => `<option value="${value}">${ageLabel(value)}</option>`).join('');
  ui.maxCount.value = String(state.retention.maxCount);
  ui.maxAge.value = String(state.retention.maxAgeDays);
}

async function applyRetentionFromUi() {
  const policy = core.normalizeRetention({ maxCount: ui.maxCount.value, maxAgeDays: ui.maxAge.value });
  const expired = core.selectExpired(state.assessments, policy);
  if (expired.length && !window.confirm(`Con esta política se eliminarán ${expired.length} evaluación(es) ahora y las siguientes que la excedan. ¿Continuar?`)) {
    populateRetention(); return;
  }
  try {
    if (expired.length) await deleteIds(expired);
    state.retention = policy;
    localStorage.setItem(core.RETENTION_KEY, JSON.stringify(policy));
    await refresh();
    ui.retentionResult.textContent = expired.length ? `Política aplicada: se eliminaron ${expired.length} evaluación(es).` : 'Política guardada. No fue necesario eliminar evaluaciones.';
  } catch (error) { ui.retentionResult.textContent = `No se pudo aplicar la política: ${error.message}`; }
}

ui.list.addEventListener('change', event => {
  const id = event.target.dataset?.historyPick;
  if (!id) return;
  if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
  render();
});
document.addEventListener('click', event => {
  const target = event.target.closest('[data-history-open],[data-history-delete],[data-history-close]');
  if (!target || !state.ready) return;
  if (target.dataset.historyOpen) openDetail(target.dataset.historyOpen).catch(error => setStatus(`No se pudo abrir: ${error.message}`));
  if (target.dataset.historyDelete) confirmDelete(target.dataset.historyDelete);
  if (target.dataset.historyClose) ui[target.dataset.historyClose === 'detail' ? 'detail' : 'comparison'].hidden = true;
});
ui.compare.addEventListener('click', () => openComparison().catch(error => setStatus(`No se pudo comparar: ${error.message}`)));
ui.deleteAll.addEventListener('click', requestClearAll);
ui.applyRetention.addEventListener('click', applyRetentionFromUi);

window.VigiaHistory = Object.freeze({
  isReady: () => state.ready,
  saveReport,
  requestClearAll,
  refresh: () => (state.ready ? refresh() : Promise.resolve()),
});

(async () => {
  state.retention = readRetention();
  populateRetention();
  try {
    state.store = await openHistoryDb();
  } catch (error) {
    setStatus(`El historial detallado no está disponible (${error.message}). Se seguirá guardando sólo el resumen en este navegador.`);
    return;
  }
  let migration = '';
  try { migration = await migrateLegacy(); }
  catch (error) { migration = `La migración del historial anterior falló (${error.message}). Los datos originales siguen intactos.`; }
  state.ready = true;
  await refresh();
  const removed = await applyRetention();
  if (removed) await refresh();
  setStatus([`Historial listo: ${state.assessments.length} evaluación(es) en este navegador.`, migration].filter(Boolean).join(' '));
})();
