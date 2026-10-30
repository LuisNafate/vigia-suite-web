const $ = selector => document.querySelector(selector);
const elements = {
  connect: $('#connectButton'), disconnect: $('#disconnectButton'), flash: $('#flashButton'), install: $('#installButton'),
  progress: $('#provisionProgress'), progressText: $('#provisionText'), terminal: $('#terminal'), clear: $('#clearButton'),
  livePill: $('#livePill'), liveText: $('#liveText'), status: $('#statusCopy'), protocol: $('#protocolValue'), port: $('#portValue'),
  riskRing: $('#riskRing'), riskScore: $('#riskScore'), riskLevel: $('#riskLevel'), riskText: $('#riskText'),
  startAnalysis: $('#startAnalysisButton'), rerunAnalysis: $('#rerunAnalysisButton'), analysisProgress: $('#analysisProgress'),
  analysisStage: $('#analysisStage'), analysisScore: $('#analysisScore'), analysisLevel: $('#analysisLevel'), analysisSummary: $('#analysisSummary'),
  findings: $('#findingsList'), recommendations: $('#recommendationsList'), metricNetworks: $('#metricNetworks'),
  metricOpen: $('#metricOpen'), metricHidden: $('#metricHidden'), metricBle: $('#metricBle'),
  exportJson: $('#exportJsonButton'), exportCsv: $('#exportCsvButton'), clearHistory: $('#clearHistoryButton'),
  historyCounter: $('#historyCounter'), historyList: $('#historyList'), wifiAdvice: $('#wifiAdvice'), bleAdvice: $('#bleAdvice'),
  nextActionTitle: $('#nextActionTitle'), nextActionCopy: $('#nextActionCopy'),
  guidanceTitle: $('#guidanceTitle'), guidanceCopy: $('#guidanceCopy'), guidanceAction: $('#guidanceAction'),
  steps: [$('#stepConnect'), $('#stepScan'), $('#stepReview'), $('#stepExport')],
  wifiFilters: [...document.querySelectorAll('[data-wifi-filter]')], bleFilters: [...document.querySelectorAll('[data-ble-filter]')],
  wifiBadge: $('#wifiBadge'), bleBadge: $('#bleBadge'), wifiSummary: $('#wifiSummary'), bleSummary: $('#bleSummary'),
  counter: $('#resultCounter'), table: $('#networkTable'), bleCounter: $('#bleCounter'), bleTable: $('#bleTable'),
  bleVisible: $('#bleVisible'), bleNearby: $('#bleNearby'), bleConnectable: $('#bleConnectable'), blePrivate: $('#blePrivate'),
  detailBoard: $('#detailBoard'), detailChip: $('#detailChip'), detailMac: $('#detailMac'), detailFirmware: $('#detailFirmware'),
  detailHeap: $('#detailHeap'), detailUptime: $('#detailUptime'),
  modules: [...document.querySelectorAll('[data-command]')], tabs: [...document.querySelectorAll('[data-view-target]')],
  views: [...document.querySelectorAll('[data-view]')],
};

let port;
let reader;
let writer;
let keepReading = false;
let lineBuffer = '';
let networks = [];
let bleDevices = [];
let identity = {};
let sensorStatus = {};
let detectedPort = '';
let installPrompt;
let isFlashing = false;
let analysisRunning = false;
let lastCommand = '';
let bleScanFailed = false;
let currentReport = null;
let scanHistory = [];
let wifiFilter = 'all';
let bleFilter = 'all';
const eventWaiters = new Map();
const HISTORY_KEY = 'vigia-suite-analysis-history-v1';
const LOCAL_HELPER_AVAILABLE = ['localhost', '127.0.0.1'].includes(window.location.hostname);

const timestamp = () => new Date().toLocaleTimeString('es-MX', { hour12: false });

function log(message, kind = 'sensor') {
  elements.terminal.textContent += `\n[${timestamp()}] [${kind}] ${message}`;
  elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function showView(name) {
  elements.views.forEach(view => view.classList.toggle('active', view.dataset.view === name));
  elements.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.viewTarget === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setConnected(connected) {
  elements.livePill.classList.toggle('connected', connected);
  elements.liveText.textContent = connected ? 'SENSOR EN LÍNEA' : 'SIN CONEXIÓN';
  elements.connect.disabled = connected;
  elements.flash.disabled = connected || !LOCAL_HELPER_AVAILABLE;
  elements.disconnect.disabled = !connected;
  elements.modules.forEach(button => button.disabled = !connected || analysisRunning);
  elements.startAnalysis.disabled = !connected || analysisRunning;
  elements.rerunAnalysis.disabled = !connected || analysisRunning;
  updateJourney(connected);
}

function updateJourney(connected = Boolean(writer)) {
  const hasResults = networks.length > 0 || bleDevices.length > 0;
  const hasReport = Boolean(currentReport);
  elements.steps.forEach(step => step.classList.remove('active', 'done'));
  if (!connected) elements.steps[0].classList.add('active');
  else { elements.steps[0].classList.add('done'); (hasResults ? elements.steps[2] : elements.steps[1]).classList.add('active'); }
  if (hasResults) { elements.steps[1].classList.add('done'); elements.steps[2].classList.add('done'); }
  if (hasReport) elements.steps[3].classList.add('active');
  if (!connected) {
    elements.nextActionTitle.textContent = 'Conecta el sensor para comenzar';
    elements.nextActionCopy.textContent = 'Después, Vigía medirá Wi-Fi y Bluetooth en una sola evaluación guiada.';
  } else if (!hasResults) {
    elements.nextActionTitle.textContent = 'El sensor está listo';
    elements.nextActionCopy.textContent = 'Inicia la evaluación. Tardará alrededor de 20 segundos y no se conectará a otros dispositivos.';
  } else {
    elements.nextActionTitle.textContent = 'La evaluación está lista';
    elements.nextActionCopy.textContent = 'Abre Resumen para revisar primero los hallazgos prioritarios y guardar el informe.';
  }
}

function authLabel(value) {
  return ({ 0: 'Abierta', 1: 'WEP', 2: 'WPA-PSK', 3: 'WPA2-PSK', 4: 'WPA/WPA2', 5: 'WPA2 Enterprise', 6: 'WPA3-PSK', 7: 'WPA2/WPA3', 8: 'WAPI' })[value] ?? `Modo ${value}`;
}

function signalClass(rssi) { return rssi >= -60 ? 'signal-good' : rssi >= -75 ? 'signal-mid' : 'signal-low'; }
function proximityLabel(rssi) { return rssi >= -55 ? 'Muy cerca' : rssi >= -65 ? 'Cerca' : rssi >= -80 ? 'Media' : 'Lejana'; }
function addressTypeLabel(type) {
  return ({ public: 'Pública', random: 'Aleatoria', public_identity: 'Identidad pública', random_identity: 'Identidad aleatoria' })[type] || 'No informada';
}
function manufacturerLabel(id) {
  return ({ 6: 'Microsoft', 76: 'Apple', 117: 'Samsung', 224: 'Google' })[id] || (id >= 0 ? `ID 0x${id.toString(16).toUpperCase().padStart(4, '0')}` : 'Sin fabricante');
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function renderNetworks() {
  const openCount = networks.filter(network => network.auth === 0).length;
  const visible = networks.filter(network => wifiFilter === 'all' || (wifiFilter === 'open' && network.auth === 0) || (wifiFilter === 'protected' && network.auth !== 0) || (wifiFilter === 'nearby' && network.rssi >= -65));
  elements.counter.textContent = `${visible.length} de ${networks.length} redes`;
  elements.wifiBadge.textContent = networks.length;
  elements.wifiSummary.textContent = networks.length ? `${openCount} abiertas · ${networks.length - openCount} protegidas` : 'Sin resultados.';
  if (!networks.length) {
    elements.table.innerHTML = '<tr class="empty-row"><td colspan="5">No hay redes registradas.</td></tr>';
    elements.wifiAdvice.innerHTML = '<p class="empty-copy">Escanea para recibir recomendaciones contextualizadas.</p>';
    return;
  }
  if (!visible.length) {
    elements.table.innerHTML = '<tr class="empty-row"><td colspan="5">No hay redes que coincidan con este filtro.</td></tr>';
    renderModuleAdvice(); return;
  }
  elements.table.innerHTML = [...visible].sort((a, b) => b.rssi - a.rssi).map(network => `<tr>
    <td>${escapeHtml(network.ssid || '[oculta]')}</td><td class="${signalClass(network.rssi)}">${network.rssi} dBm</td>
    <td>${network.channel}</td><td><span class="security-tag ${network.auth === 0 ? 'open' : ''}">${authLabel(network.auth)}</span></td>
    <td>${escapeHtml(network.bssid)}</td></tr>`).join('');
  renderModuleAdvice();
}

function renderBleDevices() {
  const nearby = bleDevices.filter(device => device.rssi >= -65).length;
  const connectable = bleDevices.filter(device => device.connectable).length;
  const privateAddresses = bleDevices.filter(device => String(device.address_type).includes('random')).length;
  const visible = bleDevices.filter(device => bleFilter === 'all' || (bleFilter === 'nearby' && device.rssi >= -65) || (bleFilter === 'connectable' && device.connectable) || (bleFilter === 'stable' && !String(device.address_type).includes('random')));
  elements.bleCounter.textContent = `${visible.length} de ${bleDevices.length} dispositivos`;
  elements.bleBadge.textContent = bleDevices.length;
  elements.bleVisible.textContent = bleDevices.length; elements.bleNearby.textContent = nearby;
  elements.bleConnectable.textContent = connectable; elements.blePrivate.textContent = privateAddresses;
  elements.bleSummary.textContent = bleDevices.length ? `${nearby} cercanos · ${connectable} conectables · ${privateAddresses} con dirección aleatoria` : 'Sin resultados.';
  if (!bleDevices.length) {
    elements.bleTable.innerHTML = '<tr class="empty-row"><td colspan="7">No hay dispositivos registrados.</td></tr>';
    elements.bleAdvice.innerHTML = '<p class="empty-copy">Escanea para recibir recomendaciones contextualizadas.</p>';
    return;
  }
  if (!visible.length) {
    elements.bleTable.innerHTML = '<tr class="empty-row"><td colspan="7">No hay dispositivos que coincidan con este filtro.</td></tr>';
    renderModuleAdvice(); return;
  }
  elements.bleTable.innerHTML = [...visible].sort((a, b) => b.rssi - a.rssi).map(device => `<tr>
    <td>${escapeHtml(device.name || '[sin nombre]')}</td><td class="${signalClass(device.rssi)}">${device.rssi} dBm</td>
    <td><span class="proximity-tag">${proximityLabel(device.rssi)}</span></td><td>${escapeHtml(device.address)}</td>
    <td>${escapeHtml(addressTypeLabel(device.address_type))}</td><td>${device.connectable ? 'Sí' : 'No'}</td>
    <td><strong>${escapeHtml(manufacturerLabel(device.manufacturer_id))}</strong><small class="cell-detail">${escapeHtml(device.services || 'Sin servicios anunciados')}</small></td></tr>`).join('');
  renderModuleAdvice();
}

function renderModuleAdvice() {
  if (networks.length) {
    const open = networks.filter(item => item.auth === 0);
    const legacy = networks.filter(item => item.auth === 1 || item.auth === 2);
    const channelCounts = networks.reduce((result, item) => ({ ...result, [item.channel]: (result[item.channel] || 0) + 1 }), {});
    const busiest = Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0];
    const wifiItems = [];
    if (legacy.length) wifiItems.push(addFinding('high', 'Cifrado heredado observable', `${legacy.length} red(es) anuncian WEP o WPA. En equipos propios, migra a WPA2-AES o WPA3.`));
    if (open.length) wifiItems.push(addFinding('medium', 'Redes abiertas cercanas', `${open.length} red(es) no anuncian cifrado. No envíes información sensible y valida aislamiento de clientes.`));
    if (busiest && Number(busiest[1]) >= 4) wifiItems.push(addFinding('medium', `Canal ${busiest[0]} congestionado`, `${busiest[1]} redes comparten el canal. Mide en varios horarios antes de cambiar la configuración.`));
    if (!open.length && !legacy.length) wifiItems.push(addFinding('info', 'Configuración básica saludable', 'No se observó cifrado abierto o heredado. Aun así, revisa actualizaciones, contraseña y red de invitados.'));
    elements.wifiAdvice.innerHTML = wifiItems.join('');
  }
  if (bleDevices.length) {
    const nearby = bleDevices.filter(item => item.rssi >= -65);
    const stable = nearby.filter(item => !String(item.address_type).includes('random'));
    const connectable = nearby.filter(item => item.connectable);
    const bleItems = [];
    if (stable.length) bleItems.push(addFinding('medium', 'Identificadores estables cercanos', `${stable.length} dispositivo(s) cercano(s) podrían ser correlacionados en el tiempo. En equipos propios, activa privacidad BLE y actualiza firmware.`));
    if (connectable.length) bleItems.push(addFinding('info', 'Dispositivos conectables', `${connectable.length} dispositivo(s) cercano(s) aceptan conexión. Desactiva modo visible o emparejamiento cuando no se use.`));
    if (!stable.length) bleItems.push(addFinding('info', 'Privacidad de direcciones', 'Los dispositivos cercanos observados usan direcciones aleatorias; esto reduce seguimiento pasivo, pero no garantiza seguridad.'));
    elements.bleAdvice.innerHTML = bleItems.join('');
  }
}

function loadHistory() {
  try { scanHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { scanHistory = []; }
  renderHistory();
}

function renderHistory() {
  elements.historyCounter.textContent = `${scanHistory.length} ${scanHistory.length === 1 ? 'sesión' : 'sesiones'}`;
  elements.clearHistory.disabled = scanHistory.length === 0;
  if (!scanHistory.length) { elements.historyList.innerHTML = '<p class="empty-copy">Aún no hay análisis guardados.</p>'; return; }
  elements.historyList.innerHTML = scanHistory.map(item => `<div class="history-item">
    <time>${escapeHtml(new Date(item.createdAt).toLocaleString('es-MX'))}</time>
    <div><strong>${item.score}/100 · ${escapeHtml(item.level)}</strong><p>${item.wifi.total} redes, ${item.wifi.open} abiertas · ${item.bluetooth.total} BLE, ${item.bluetooth.nearby} cercanos</p></div>
    <span class="risk-chip ${item.level.toLowerCase()}">${escapeHtml(item.level)}</span>
  </div>`).join('');
}

function saveCurrentReport() {
  if (!currentReport) return;
  scanHistory = [{ ...currentReport, wifiNetworks: undefined, bleDevices: undefined }, ...scanHistory].slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(scanHistory));
  renderHistory();
}

function downloadBlob(filename, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function downloadJson() {
  if (!currentReport) return;
  downloadBlob(`vigia-informe-${Date.now()}.json`, 'application/json', JSON.stringify(currentReport, null, 2));
}
function downloadCsv() {
  if (!currentReport) return;
  const rows = [['TIPO','NOMBRE','RSSI','CANAL/DIRECCION','SEGURIDAD/PRIVACIDAD','CONECTABLE','FABRICANTE/SERVICIOS']];
  currentReport.wifiNetworks.forEach(item => rows.push(['Wi-Fi', item.ssid || '[oculta]', item.rssi, item.channel, authLabel(item.auth), '', item.bssid]));
  currentReport.bleDevices.forEach(item => rows.push(['Bluetooth', item.name || '[sin nombre]', item.rssi, item.address, addressTypeLabel(item.address_type), item.connectable ? 'Sí' : 'No', `${manufacturerLabel(item.manufacturer_id)} ${item.services || ''}`]));
  downloadBlob(`vigia-inventario-${Date.now()}.csv`, 'text/csv;charset=utf-8', '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
}

function notifyEvent(type, event) {
  const waiters = eventWaiters.get(type) || [];
  eventWaiters.delete(type);
  waiters.forEach(resolve => resolve(event));
}

function waitForEvent(type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = eventWaiters.get(type) || [];
      eventWaiters.set(type, waiters.filter(item => item !== complete));
      reject(new Error(`Tiempo agotado esperando ${type}`));
    }, timeoutMs);
    const complete = event => { clearTimeout(timer); resolve(event); };
    eventWaiters.set(type, [...(eventWaiters.get(type) || []), complete]);
  });
}

function handleLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return;
  log(line);
  try {
    const event = JSON.parse(line);
    if (event.protocol) elements.protocol.textContent = `VIGIA/${event.protocol}`;
    if (event.type === 'ready') { elements.detailFirmware.textContent = event.firmware; elements.status.textContent = `Firmware ${event.firmware} listo.`; }
    if (event.type === 'pong') elements.status.textContent = 'Enlace validado correctamente.';
    if (event.type === 'identity') {
      identity = event; elements.detailBoard.textContent = event.board; elements.detailChip.textContent = event.chip; elements.detailMac.textContent = event.mac;
      elements.status.textContent = `${event.board} · ${event.chip} · ${event.mac}`;
    }
    if (event.type === 'status') {
      sensorStatus = event; elements.detailHeap.textContent = `${event.heap_free.toLocaleString('es-MX')} bytes`;
      elements.detailUptime.textContent = `${Math.round(event.uptime_ms / 1000)} segundos`;
      elements.status.textContent = `Memoria libre: ${event.heap_free.toLocaleString('es-MX')} bytes · Activo: ${Math.round(event.uptime_ms / 1000)} s`;
    }
    if (event.type === 'wifi_scan_started') { networks = []; renderNetworks(); elements.status.textContent = 'Analizando redes Wi-Fi…'; }
    if (event.type === 'wifi_ap') { networks.push(event); renderNetworks(); }
    if (event.type === 'wifi_scan_finished') { elements.status.textContent = `Wi-Fi finalizado: ${event.count} redes detectadas.`; renderAnalysis(); }
    if (event.type === 'ble_scan_started') { bleDevices = []; bleScanFailed = false; renderBleDevices(); elements.status.textContent = 'Analizando Bluetooth LE…'; }
    if (event.type === 'ble_status') elements.status.textContent = event.ready ? 'Bluetooth LE disponible y listo.' : 'Bluetooth LE no pudo inicializarse.';
    if (event.type === 'ble_device') {
      const existing = bleDevices.findIndex(device => device.address === event.address);
      if (existing >= 0) bleDevices[existing] = event; else bleDevices.push(event);
      renderBleDevices();
    }
    if (event.type === 'ble_scan_finished') {
      bleScanFailed = event.failed === true;
      elements.status.textContent = bleScanFailed ? 'El inventario Bluetooth no pudo completarse.' : `Bluetooth finalizado: ${event.count} dispositivos únicos detectados.`;
      if (bleScanFailed) elements.bleSummary.textContent = 'El firmware reportó un fallo en el módulo BLE.';
      renderAnalysis();
    }
    if (event.type === 'error') {
      elements.status.textContent = `El sensor reportó: ${event.code}`;
      if (event.module === 'ble' || lastCommand === 'SCAN_BLE') { bleScanFailed = true; elements.bleSummary.textContent = 'El módulo BLE requiere revisión de firmware.'; }
      if (lastCommand === 'SCAN_WIFI') notifyEvent('wifi_scan_finished', { type: 'wifi_scan_finished', count: 0, failed: true });
    }
    notifyEvent(event.type, event);
  } catch {
    // Los mensajes del cargador de arranque se conservan solo como telemetría.
  }
}

async function readLoop() {
  const decoder = new TextDecoder(); keepReading = true;
  while (port?.readable && keepReading) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? ''; lines.forEach(handleLine);
      }
    } catch (error) { if (keepReading) log(error.message, 'error'); }
    finally { reader.releaseLock(); reader = undefined; }
  }
}

async function openPort(selectedPort) {
  port = selectedPort;
  await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  writer = port.writable.getWriter(); setConnected(true); elements.port.textContent = 'Puerto autorizado';
  elements.status.textContent = 'Puerto abierto. Validando firmware…'; log('Puerto serial abierto a 115200 8N1', 'web');
  readLoop(); await new Promise(resolve => setTimeout(resolve, 250)); await sendCommand('PING');
}

async function connect(selectedPort) {
  if (!('serial' in navigator)) { elements.status.textContent = 'Web Serial requiere Edge o Chrome en una computadora.'; return; }
  try {
    const chosen = selectedPort || await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x10c4 }, { usbVendorId: 0x1a86 }, { usbVendorId: 0x303a }] });
    await openPort(chosen);
  } catch (error) { elements.status.textContent = `No se pudo abrir el puerto: ${error.message}`; log(error.message, 'error'); await disconnect(false); }
}

async function disconnect(writeLog = true) {
  keepReading = false; try { await reader?.cancel(); } catch {} try { writer?.releaseLock(); } catch {} writer = undefined;
  try { await port?.close(); } catch {} port = undefined; setConnected(false); elements.port.textContent = detectedPort || 'Buscando sensor';
  elements.status.textContent = 'Sensor desconectado.'; if (writeLog) log('Puerto cerrado', 'web');
}

async function sendCommand(command) {
  if (!writer) return;
  lastCommand = command; await writer.write(new TextEncoder().encode(`${command}\n`)); log(`> ${command}`, 'web');
}

async function sendAndWait(command, completionType, timeoutMs = 12000) {
  const completion = waitForEvent(completionType, timeoutMs); await sendCommand(command); return completion;
}

function addFinding(severity, title, detail) {
  return `<div class="finding ${severity}"><span>${severity === 'high' ? 'ALTO' : severity === 'medium' ? 'MEDIO' : 'INFO'}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div>`;
}

function renderAnalysis() {
  const total = networks.length;
  const open = networks.filter(network => network.auth === 0);
  const weak = networks.filter(network => network.auth === 1 || network.auth === 2);
  const hidden = networks.filter(network => !network.ssid);
  const strongOpen = open.filter(network => network.rssi >= -70);
  const channels = networks.reduce((counts, network) => ({ ...counts, [network.channel]: (counts[network.channel] || 0) + 1 }), {});
  const busiest = Object.entries(channels).sort((a, b) => b[1] - a[1])[0];
  const nearbyBle = bleDevices.filter(device => device.rssi >= -65);
  const connectableBle = bleDevices.filter(device => device.connectable);
  const stableNearbyBle = nearbyBle.filter(device => !String(device.address_type).includes('random'));
  const unnamedBle = bleDevices.filter(device => !device.name);
  let score = 0;
  score += Math.min(40, open.length * 3);
  score += Math.min(25, strongOpen.length * 5);
  score += Math.min(25, weak.length * 12);
  if (total && open.length / total >= .25) score += 10;
  if (busiest && Number(busiest[1]) >= 12) score += 5;
  score += Math.min(10, stableNearbyBle.filter(device => device.connectable).length * 2);
  score = Math.min(100, score);
  const level = score >= 60 ? 'ALTO' : score >= 30 ? 'MEDIO' : 'BAJO';
  const hasData = total > 0 || bleDevices.length > 0;

  elements.riskScore.textContent = hasData ? score : '—'; elements.riskLevel.textContent = hasData ? level : 'SIN DATOS';
  elements.analysisScore.textContent = hasData ? score : '—'; elements.analysisLevel.textContent = hasData ? `Riesgo ${level.toLowerCase()}` : 'Sin análisis';
  elements.riskRing.dataset.level = level.toLowerCase();
  elements.metricNetworks.textContent = total; elements.metricOpen.textContent = open.length; elements.metricHidden.textContent = hidden.length; elements.metricBle.textContent = bleDevices.length;

  if (!hasData) {
    elements.guidanceTitle.textContent = 'Ejecuta una evaluación completa';
    elements.guidanceCopy.textContent = 'Conecta el sensor y usa Evaluar mi entorno; no necesitas abrir cada módulo por separado.';
    elements.guidanceAction.textContent = 'Ir al inicio';
    return;
  }
  elements.guidanceTitle.textContent = level === 'ALTO' ? 'Atiende primero los hallazgos marcados como altos' : level === 'MEDIO' ? 'Revisa las exposiciones cercanas y confirma cuáles son tuyas' : 'No hay urgencias evidentes; conserva el informe como referencia';
  elements.guidanceCopy.textContent = level === 'ALTO' ? 'Prioriza cifrado heredado y redes abiertas cercanas antes de revisar observaciones informativas.' : 'La puntuación orienta la revisión, pero no demuestra un ataque ni atribuye propiedad.';
  elements.guidanceAction.textContent = 'Ver redes Wi-Fi';
  elements.riskText.textContent = `${open.length} redes abiertas de ${total}; ${nearbyBle.length} dispositivos BLE cercanos.`;
  elements.analysisSummary.textContent = bleScanFailed
    ? `Se observaron ${total} redes Wi-Fi. El inventario BLE no pudo completarse y no modifica la puntuación.`
    : `Se observaron ${total} redes Wi-Fi y ${bleDevices.length} dispositivos BLE. La puntuación prioriza exposición, cifrado débil y proximidad.`;
  const findings = [];
  if (strongOpen.length) findings.push(addFinding('high', `${strongOpen.length} redes abiertas con señal cercana`, 'Una red abierta no cifra el tráfico radio. Confirma si pertenecen a la organización y si usan aislamiento o portal cautivo.'));
  else if (open.length) findings.push(addFinding('medium', `${open.length} redes abiertas detectadas`, 'La señal es lejana, pero conviene validar su propósito y segmentación.'));
  if (weak.length) findings.push(addFinding('high', `${weak.length} redes con seguridad heredada`, 'WEP o WPA antiguo no ofrecen protección adecuada frente a ataques actuales.'));
  if (hidden.length) findings.push(addFinding('info', `${hidden.length} redes sin SSID visible`, 'Ocultar el nombre no sustituye autenticación ni cifrado; documenta estos puntos de acceso.'));
  if (busiest) findings.push(addFinding('medium', `Canal ${busiest[0]} concentra ${busiest[1]} redes`, 'La congestión puede degradar disponibilidad y producir falsos síntomas de ataque o interferencia.'));
  if (stableNearbyBle.length) findings.push(addFinding('medium', `${stableNearbyBle.length} dispositivos BLE cercanos con identificador estable`, 'Una dirección no aleatoria puede facilitar el seguimiento de presencia. Confirma que sean equipos autorizados y actualizados.'));
  if (connectableBle.length) findings.push(addFinding('info', `${connectableBle.length} dispositivos BLE aceptan conexión`, 'Ser conectable es normal; limita el emparejamiento y desactiva Bluetooth cuando no sea necesario.'));
  if (unnamedBle.length) findings.push(addFinding('info', `${unnamedBle.length} anuncios BLE sin nombre`, 'La ausencia de nombre no implica amenaza. Usa fabricante, servicios y repetición temporal para inventariarlos.'));
  if (bleScanFailed) findings.push(addFinding('medium', 'Inventario Bluetooth incompleto', 'El sensor no pudo iniciar BLE; el resultado Wi-Fi sigue siendo válido, pero el análisis no debe presentarse como cobertura total.'));
  if (!findings.length) findings.push(addFinding('info', 'Sin exposiciones evidentes', 'El inventario no encontró redes abiertas ni cifrado heredado en esta muestra.'));
  elements.findings.innerHTML = findings.join('');

  const recommendations = [];
  if (open.length) recommendations.push(addFinding('high', 'Validar redes abiertas', 'Identifica al propietario, habilita WPA2/WPA3 cuando corresponda y separa invitados de sistemas internos.'));
  if (weak.length) recommendations.push(addFinding('high', 'Retirar cifrado heredado', 'Migra WEP/WPA a WPA2-AES o WPA3 y cambia credenciales compartidas.'));
  if (stableNearbyBle.length) recommendations.push(addFinding('medium', 'Revisar privacidad Bluetooth', 'En equipos propios, habilita direcciones privadas resolubles, instala actualizaciones y elimina emparejamientos obsoletos.'));
  recommendations.push(addFinding('medium', 'Revisar canales 1, 6 y 11', `Redistribuye puntos de acceso si el canal ${busiest?.[0] || 'principal'} muestra saturación persistente.`));
  recommendations.push(addFinding('info', 'Repetir desde otros puntos', 'Este resultado es una fotografía local. Compara mediciones y registra cambios inesperados de BSSID o seguridad.'));
  elements.recommendations.innerHTML = recommendations.join('');
  renderModuleAdvice();
  currentReport = {
    schema: 'vigia-suite-report/1', createdAt: new Date().toISOString(), score, level,
    sensor: { board: identity.board || 'NodeMCU ESP-32S', chip: identity.chip || 'ESP32', mac: identity.mac || '', firmware: elements.detailFirmware.textContent, protocol: elements.protocol.textContent },
    wifi: { total, open: open.length, legacy: weak.length, hidden: hidden.length, busiestChannel: busiest ? Number(busiest[0]) : null, busiestCount: busiest ? Number(busiest[1]) : 0 },
    bluetooth: { total: bleDevices.length, nearby: nearbyBle.length, connectable: connectableBle.length, stableNearby: stableNearbyBle.length, scanFailed: bleScanFailed },
    wifiNetworks: networks.map(item => ({ ...item })), bleDevices: bleDevices.map(item => ({ ...item })),
    disclaimer: 'Observación pasiva local. Un hallazgo no demuestra por sí mismo una vulnerabilidad explotable.'
  };
  elements.exportJson.disabled = false; elements.exportCsv.disabled = false;
  updateJourney();
}

async function runFullAnalysis() {
  if (!writer || analysisRunning) return;
  analysisRunning = true; currentReport = null; elements.exportJson.disabled = true; elements.exportCsv.disabled = true;
  setConnected(true); showView('analisis'); elements.analysisProgress.hidden = false;
  try {
    elements.analysisStage.textContent = 'Validando identidad del sensor…'; await sendAndWait('INFO', 'identity', 4000);
    elements.analysisStage.textContent = 'Midiendo estado y memoria…'; await sendAndWait('STATUS', 'status', 4000);
    elements.analysisStage.textContent = 'Inventariando redes Wi-Fi…'; await sendAndWait('SCAN_WIFI', 'wifi_scan_finished', 15000);
    elements.analysisStage.textContent = 'Inventariando dispositivos Bluetooth…'; await sendAndWait('SCAN_BLE', 'ble_scan_finished', 12000);
    renderAnalysis(); saveCurrentReport(); elements.analysisStage.textContent = 'Análisis finalizado y guardado localmente.';
  } catch (error) {
    log(error.message, 'error'); elements.analysisStage.textContent = 'Análisis parcial: revisa el módulo indicado.'; renderAnalysis();
  } finally {
    setTimeout(() => { elements.analysisProgress.hidden = true; }, 1200);
    analysisRunning = false; setConnected(true);
  }
}

async function refreshDeviceStatus() {
  if (isFlashing || port) return;
  if (!LOCAL_HELPER_AVAILABLE) {
    detectedPort = '';
    elements.flash.disabled = true;
    elements.flash.textContent = 'Firmware: usa versión local';
    elements.flash.title = 'La instalación automática requiere INICIAR-VIGIA.bat en una PC local';
    return;
  }
  try {
    const response = await fetch('/api/status', { cache: 'no-store' }); const data = await response.json(); const device = data.devices?.[0];
    const previousPort = detectedPort; detectedPort = device?.port || ''; elements.port.textContent = device ? `${device.port} detectado` : 'Conecta el ESP32';
    elements.flash.disabled = !device; elements.flash.title = device ? `Instalar firmware en ${device.port}` : 'No se detectó un ESP32 USB';
    if (device && device.port !== previousPort) log(`${device.name} detectado en ${device.port}`, 'sistema');
  } catch (error) { elements.flash.disabled = true; elements.flash.title = 'Inicia Vigía con INICIAR-VIGIA.bat'; }
}

async function flashFirmware() {
  if (!detectedPort || port) return;
  isFlashing = true; elements.flash.disabled = true; elements.connect.disabled = true; elements.progress.hidden = false;
  elements.progressText.textContent = `Instalando firmware en ${detectedPort}…`; elements.status.textContent = 'No desconectes el cable.';
  try {
    const response = await fetch('/api/flash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: detectedPort }) });
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo cargar el firmware');
    elements.status.textContent = 'Firmware instalado. Ya puedes conectar el puerto.'; elements.protocol.textContent = 'VIGIA/1 instalado'; log(data.message, 'sistema');
  } catch (error) { elements.status.textContent = `Falló la preparación: ${error.message}`; log(error.message, 'error'); }
  finally { isFlashing = false; elements.progress.hidden = true; elements.flash.disabled = false; elements.connect.disabled = false; }
}

elements.tabs.forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.viewTarget)));
elements.connect.addEventListener('click', () => connect()); elements.disconnect.addEventListener('click', () => disconnect()); elements.flash.addEventListener('click', flashFirmware);
elements.startAnalysis.addEventListener('click', runFullAnalysis); elements.rerunAnalysis.addEventListener('click', runFullAnalysis);
elements.guidanceAction.addEventListener('click', () => showView(currentReport ? 'wifi' : 'inicio'));
elements.wifiFilters.forEach(button => button.addEventListener('click', () => {
  wifiFilter = button.dataset.wifiFilter; elements.wifiFilters.forEach(item => item.classList.toggle('active', item === button)); renderNetworks();
}));
elements.bleFilters.forEach(button => button.addEventListener('click', () => {
  bleFilter = button.dataset.bleFilter; elements.bleFilters.forEach(item => item.classList.toggle('active', item === button)); renderBleDevices();
}));
elements.exportJson.addEventListener('click', downloadJson); elements.exportCsv.addEventListener('click', downloadCsv);
elements.clearHistory.addEventListener('click', () => { scanHistory = []; localStorage.removeItem(HISTORY_KEY); renderHistory(); });
elements.clear.addEventListener('click', () => { elements.terminal.textContent = `[${timestamp()}] [sistema] Consola limpia.`; });
elements.modules.forEach(button => button.addEventListener('click', async () => { if (!analysisRunning) await sendCommand(button.dataset.command); }));
navigator.serial?.addEventListener('disconnect', () => disconnect());
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; elements.install.hidden = false; });
elements.install.addEventListener('click', async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = undefined; elements.install.hidden = true; } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
setConnected(false); renderNetworks(); renderBleDevices(); renderAnalysis(); loadHistory(); refreshDeviceStatus();
setInterval(() => { if (!port) refreshDeviceStatus(); }, 3000);
(async () => {
  if (!navigator.serial) return;
  const grantedPorts = await navigator.serial.getPorts();
  if (grantedPorts.length) { try { await connect(grantedPorts[0]); } catch {} }
})();
