// Instalador de firmware de Vigía Suite desde el navegador (Web Serial + esptool-js).
// Sólo instala binarios oficiales publicados junto a esta web y verificados por SHA-256.
import { ESPLoader, Transport } from './vendor/esptool-js-0.7.0/bundle.js';
import * as fw from './firmware-core.js';

const MANIFEST_URL = new URL('firmware/manifest.json', document.baseURI).href;
const SENSOR_BAUD = 115200;
const ROM_BAUD = 115200;
// Se instala a la velocidad del cargador ROM. Subir a 460800 obliga a reabrir el puerto en Windows,
// lo que reinicia placas con auto-reset (CP210x) y vuelve el proceso frágil; la ganancia de tiempo no compensa.
const FLASH_BAUD = 115200;
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);

const ui = {
  support: $('#fwSupport'), steps: [...document.querySelectorAll('[data-fw-step]')],
  portLabel: $('#fwPortLabel'), usbChip: $('#fwUsbChip'), deviceFirmware: $('#fwDeviceFirmware'), chipLabel: $('#fwChipLabel'),
  deviceState: $('#fwDeviceState'), selectPort: $('#fwSelectPort'), probe: $('#fwProbe'), use: $('#fwUseButton'),
  reinstall: $('#fwReinstallButton'),
  releaseTitle: $('#fwReleaseTitle'), releaseSelect: $('#fwReleaseSelect'), releaseChip: $('#fwReleaseChip'),
  releaseProtocol: $('#fwReleaseProtocol'), releaseBuild: $('#fwReleaseBuild'), releaseSize: $('#fwReleaseSize'),
  releaseFiles: $('#fwReleaseFiles'), integrity: $('#fwIntegrity'),
  confirmPanel: $('#fwConfirmPanel'), confirmSummary: $('#fwConfirmSummary'), consent: $('#fwConsent'),
  install: $('#fwInstallButton'), cancel: $('#fwCancelButton'),
  progressPanel: $('#fwProgressPanel'), progressTitle: $('#fwProgressTitle'), progress: $('#fwProgress'),
  progressText: $('#fwProgressText'), retry: $('#fwRetryButton'), driverHelp: $('#fwDriverHelp'),
  driverHint: $('#fwDriverHint'), log: $('#fwLog'),
};

const state = {
  port: null, manifest: null, release: null, files: null, verifiedFor: null, probe: null,
  busy: false, lost: false, retryAction: null,
};

window.VigiaInstaller = Object.freeze({ isBusy: () => state.busy });

function log(message) {
  const line = `[${new Date().toLocaleTimeString('es-MX', { hour12: false })}] ${message}`;
  ui.log.textContent += `\n${line}`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setOutput(element, kind, text) {
  element.dataset.state = kind;
  element.textContent = text;
}

function setStep(name, status) {
  const order = ui.steps.map(step => step.dataset.fwStep);
  const target = order.indexOf(name);
  ui.steps.forEach((step, index) => {
    step.classList.toggle('done', index < target || (index === target && status === 'done'));
    step.classList.toggle('active', index === target && status !== 'done');
    step.classList.toggle('error', index === target && status === 'error');
  });
}

function setBusy(busy) {
  state.busy = busy;
  ui.selectPort.disabled = busy || !supported();
  ui.probe.disabled = busy || !state.port;
  ui.releaseSelect.disabled = busy || !state.manifest;
  // Los archivos se descargan y verifican al pulsar Instalar; aquí sólo se exige consentimiento y una versión elegida.
  ui.install.disabled = busy || !ui.consent.checked || !state.release || !state.port;
  ui.cancel.disabled = busy;
}

function supported() {
  return 'serial' in navigator && window.isSecureContext && Boolean(globalThis.crypto?.subtle);
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function portDescription(port) {
  const info = port?.getInfo?.() || {};
  const bridge = fw.usbBridgeInfo(info.usbVendorId);
  const ids = info.usbVendorId !== undefined
    ? `VID ${info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')} · PID ${(info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    : 'sin identificador USB';
  return { info, bridge, ids };
}

function showDriverHint(bridge) {
  ui.driverHint.replaceChildren();
  if (!bridge?.driverUrl) return;
  const paragraph = document.createElement('p');
  paragraph.className = 'fw-note';
  paragraph.append(`Tu placa usa un puente ${bridge.chip}. Controlador oficial: `);
  const link = document.createElement('a');
  link.href = bridge.driverUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = `${bridge.driverName} (${bridge.vendor})`;
  paragraph.append(link, '.');
  ui.driverHint.append(paragraph);
}

// ---------- Catálogo de firmware ----------

async function loadManifest() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 404) throw new Error('Todavía no hay firmware publicado en esta versión de la web.');
    if (!response.ok) throw new Error(`No se pudo leer el catálogo (HTTP ${response.status}).`);
    const manifest = await response.json();
    const validation = fw.validateManifest(manifest);
    if (!validation.ok) throw new Error(`Catálogo inválido: ${validation.errors.join(' ')}`);
    const releases = fw.releasesForChip(manifest, 'ESP32');
    if (!releases.length) throw new Error('El catálogo no contiene firmware estable para ESP32.');
    state.manifest = manifest;
    ui.releaseSelect.replaceChildren(...releases.map(release => {
      const option = document.createElement('option');
      option.value = release.version;
      option.textContent = `${release.version}${release.version === manifest.latest ? ' (recomendada)' : ''}`;
      return option;
    }));
    ui.releaseSelect.value = manifest.latest && releases.some(r => r.version === manifest.latest) ? manifest.latest : releases[0].version;
    selectRelease(ui.releaseSelect.value);
    log(`Catálogo cargado: ${releases.length} versión(es) para ESP32.`);
  } catch (error) {
    state.manifest = null;
    ui.releaseTitle.textContent = 'Firmware no disponible';
    setOutput(ui.integrity, 'error', error.message);
    log(error.message);
  } finally {
    setBusy(state.busy);
  }
}

function selectRelease(version) {
  const release = state.manifest?.releases.find(item => item.version === version) || null;
  state.release = release;
  state.files = null;
  state.verifiedFor = null;
  ui.confirmPanel.hidden = true;
  if (!release) return;
  const total = release.files.reduce((sum, file) => sum + file.size, 0);
  ui.releaseTitle.textContent = `Vigía Sensor ${release.version}`;
  ui.releaseChip.textContent = `${release.chip} · flash ≥ ${release.minFlashSize}`;
  ui.releaseProtocol.textContent = `VIGIA/${release.protocol}`;
  ui.releaseBuild.textContent = release.build ? `${release.build.core} · arduino-cli ${release.build.arduinoCli}` : '—';
  ui.releaseSize.textContent = formatBytes(total);
  ui.releaseFiles.replaceChildren(...release.files.map(file => {
    const item = document.createElement('li');
    item.textContent = `0x${file.offset.toString(16).padStart(5, '0')} · ${file.path.split('/').pop()} · ${formatBytes(file.size)} · SHA-256 ${file.sha256}`;
    return item;
  }));
  setOutput(ui.integrity, 'idle', 'La integridad se comprueba antes de instalar.');
}

async function downloadAndVerify(release) {
  if (state.files && state.verifiedFor === release.version) return state.files;
  setOutput(ui.integrity, 'working', 'Descargando y verificando archivos oficiales…');
  const files = new Map();
  for (const file of release.files) {
    const url = fw.resolveFirmwareUrl(file.path, MANIFEST_URL);
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`No se pudo descargar ${file.path} (HTTP ${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== file.size) throw new Error(`${file.path}: tamaño ${bytes.length} B, se esperaban ${file.size} B.`);
    const digest = await fw.sha256Hex(bytes);
    if (digest !== file.sha256) throw new Error(`${file.path}: el SHA-256 no coincide. Instalación bloqueada.`);
    files.set(file.path, bytes);
    log(`Verificado ${file.path}: ${digest}`);
  }
  const coherence = fw.checkReleaseImages(release, files);
  if (!coherence.ok) throw new Error(`Imágenes incoherentes: ${coherence.problems.join(' ')}`);
  state.files = files;
  state.verifiedFor = release.version;
  setOutput(ui.integrity, 'ok', `Integridad verificada: ${release.files.length} archivos con SHA-256 correcto, imágenes para ${release.chip}.`);
  return files;
}

// ---------- Sesión serial de texto (sondeo y verificación) ----------

async function openSession(port) {
  await port.open({ baudRate: SENSOR_BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  const decoder = new TextDecoder();
  const session = { events: [], textLines: [], rawBytes: 0 };
  let buffer = '';
  const loop = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        session.rawBytes += value.length;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = (lines.pop() ?? '').slice(-4096);
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = fw.parseJsonLine(line);
          if (event) { session.events.push(event); log(`< ${line.trim()}`); }
          else if (session.textLines.length < 200) session.textLines.push(line.trim());
        }
      }
    } catch (error) {
      if (!session.closing) log(`Lectura interrumpida: ${error.message}`);
    } finally {
      reader.releaseLock();
    }
  })();
  session.send = async command => { await writer.write(encoder.encode(`${command}\n`)); log(`> ${command}`); };
  // `since` permite ignorar eventos anteriores (por ejemplo, un `ready` previo a un reinicio).
  session.waitFor = async (predicate, timeoutMs, since = 0) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = session.events.slice(since).find(predicate);
      if (found) return found;
      if (state.lost) throw new Error('El dispositivo se desconectó.');
      await sleep(50);
    }
    return null;
  };
  // Reinicio por EN con DTR/RTS (circuito auto-reset de NodeMCU). No toca la flash.
  session.resetBoard = async () => {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  };
  session.close = async () => {
    session.closing = true;
    try { await reader.cancel(); } catch {}
    try { await loop; } catch {}
    try { writer.releaseLock(); } catch {}
    try { await port.close(); } catch (error) { log(`Aviso al cerrar el puerto: ${error.message}`); }
  };
  return session;
}

async function releaseAppConnection(port) {
  const app = window.VigiaApp;
  if (!app?.isConnected?.()) return;
  if (app.isBusy()) throw new Error('Vigía Suite está ejecutando un análisis. Espera a que termine.');
  if (app.currentPort() === port) {
    log('El puerto estaba conectado al panel; se libera para el instalador.');
    await app.disconnect();
  }
}

// ---------- Sondeo del dispositivo ----------

async function probeDevice() {
  if (!state.port || state.busy) return;
  setBusy(true);
  state.lost = false;
  ui.use.hidden = true;
  ui.confirmPanel.hidden = true;
  setStep('check', 'active');
  setOutput(ui.deviceState, 'working', 'Comprobando el firmware actual (el ESP32 se reiniciará; la memoria no se modifica)…');
  let result;
  let session;
  try {
    await releaseAppConnection(state.port);
    try {
      session = await openSession(state.port);
    } catch (error) {
      result = fw.classifyProbe({ openError: error });
    }
    if (session) {
      await sleep(300);
      await session.send('PING');
      const pong = await session.waitFor(event => event.type === 'pong', 1500);
      let mark = session.events.length;
      await session.resetBoard();
      let ready = await session.waitFor(event => event.type === 'ready', 6000, mark);
      if (!ready && pong?.protocol === fw.SUPPORTED_PROTOCOL) {
        mark = session.events.length;
        await session.send('REBOOT');
        ready = await session.waitFor(event => event.type === 'ready', 6000, mark);
      }
      if (ready || pong) {
        mark = session.events.length;
        await session.send('INFO');
        await session.waitFor(event => event.type === 'identity', 2500, mark);
      }
      result = fw.classifyProbe({ events: session.events, rawBytes: session.rawBytes, textLines: session.textLines, latestVersion: state.manifest?.latest });
    }
  } catch (error) {
    result = { state: 'connection-error', detail: error.message };
  } finally {
    if (session) await session.close();
    setBusy(false);
  }
  state.probe = result;
  log(`Resultado: ${result.state} — ${result.detail}`);
  renderProbe(result);
}

function renderProbe(result) {
  const identity = result.identity;
  ui.deviceFirmware.textContent = result.firmware ? `Vigía ${result.firmware}` : ({
    'vigia-ready': 'Vigía (versión no informada)', 'vigia-incompatible': 'Vigía de otro protocolo',
    'unknown-firmware': 'Desconocido', 'no-firmware': 'Sin aplicación válida', 'no-response': 'Sin respuesta',
  })[result.state] || '—';
  if (identity?.chip) ui.chipLabel.textContent = `${identity.chip} · ${identity.board || ''} · ${identity.mac || ''}`.trim();
  const canInstall = Boolean(state.release);
  ui.reinstall.hidden = true;
  ui.confirmPanel.hidden = true;
  switch (result.state) {
    case 'vigia-ready':
      setOutput(ui.deviceState, 'ok', `${result.detail} No necesitas reinstalar: pulsa «Usar Vigía Suite».`);
      ui.use.hidden = false;
      ui.reinstall.hidden = !canInstall;
      setStep('check', 'done');
      break;
    case 'vigia-outdated':
      setOutput(ui.deviceState, 'warn', `${result.detail} Hay una versión más reciente (${state.manifest.latest}). Puedes usarla así o actualizar.`);
      ui.use.hidden = false;
      setStep('check', 'done');
      if (canInstall) offerInstall('update');
      break;
    case 'vigia-incompatible':
    case 'unknown-firmware':
    case 'no-firmware':
      setOutput(ui.deviceState, 'warn', `${result.detail} Puedes instalar Vigía Sensor.`);
      setStep('check', 'done');
      if (canInstall) offerInstall('install');
      break;
    case 'no-response':
      setOutput(ui.deviceState, 'warn', `${result.detail} Si es una placa nueva, la instalación identificará el chip antes de escribir.`);
      setStep('check', 'done');
      if (canInstall) offerInstall('install');
      break;
    case 'port-busy':
      setOutput(ui.deviceState, 'error', `${result.detail} Cierra el otro programa y pulsa «Comprobar de nuevo».`);
      setStep('check', 'error');
      break;
    default:
      setOutput(ui.deviceState, 'error', `${result.detail} Revisa el cable y el controlador USB.`);
      setStep('check', 'error');
      ui.driverHelp.open = true;
  }
  if (!canInstall && !['vigia-ready', 'vigia-outdated', 'port-busy', 'connection-error'].includes(result.state)) {
    setOutput(ui.integrity, 'error', 'No hay firmware oficial publicado; no es posible instalar todavía.');
  }
}

function offerInstall(mode) {
  const release = state.release;
  const { bridge, ids } = portDescription(state.port);
  ui.confirmSummary.textContent = `${mode === 'reinstall' ? 'Reinstalar' : mode === 'update' ? 'Actualizar a' : 'Instalar'} Vigía Sensor ${release.version} (VIGIA/${release.protocol}) en el puerto ${bridge?.chip || 'USB'} (${ids}). Firmware compilado para ${release.chip}.`;
  ui.install.textContent = mode === 'reinstall' ? 'Reinstalar firmware' : mode === 'update' ? `Actualizar a ${release.version}` : 'Instalar firmware';
  ui.consent.checked = false;
  ui.confirmPanel.hidden = false;
  ui.confirmPanel.classList.toggle('fw-optional', mode === 'reinstall');
  setBusy(false);
}

// ---------- Instalación ----------

function setProgress(title, percent, text) {
  ui.progressPanel.hidden = false;
  ui.progressTitle.textContent = title;
  if (percent === null) ui.progress.removeAttribute('value'); else ui.progress.value = Math.max(0, Math.min(100, percent));
  if (text) ui.progressText.textContent = text;
}

function explainFlashError(error) {
  const message = String(error?.message || error);
  if (state.lost || /lost|disconnect|device has been/i.test(message)) return 'Se perdió la conexión USB durante la operación. Reconecta el cable y reintenta.';
  if (/Failed to open|already open|NetworkError/i.test(message)) return 'El puerto está ocupado por otro programa. Ciérralo y reintenta.';
  if (/Failed to connect|Timeout|timed out|sync/i.test(message)) return 'El ESP32 no entró en modo de carga. Reintenta; si persiste, mantén presionado el botón BOOT al iniciar la instalación.';
  if (/MD5/i.test(message)) return 'La verificación de lo escrito en la flash falló. Reintenta la instalación.';
  if (/stream stopped|noise|corruption|Invalid head|checksum/i.test(message)) {
    return 'El ESP32 dejó de responder durante la escritura (interrupción USB o de alimentación). Conecta la placa directamente a un puerto USB de la computadora, sin hub ni extensión, con un cable de datos corto, y reintenta.';
  }
  return message;
}

async function installFirmware() {
  if (state.busy || !state.port || !state.release || !ui.consent.checked) return;
  const release = state.release;
  setBusy(true);
  state.lost = false;
  ui.retry.hidden = true;
  ui.use.hidden = true;
  ui.reinstall.hidden = true;
  ui.confirmPanel.hidden = true;
  setStep('install', 'active');
  let transport;
  let loader;
  let wroteFlash = false;
  try {
    await releaseAppConnection(state.port);
    setProgress('Verificando firmware oficial…', null, 'Comprobando tamaño y SHA-256 de cada archivo.');
    const files = await downloadAndVerify(release);

    setProgress('Entrando en modo de carga…', null, 'El ESP32 se reiniciará en su cargador ROM. No desconectes el cable.');
    transport = new Transport(state.port, false);
    loader = new ESPLoader({
      transport, baudrate: FLASH_BAUD, romBaudrate: ROM_BAUD,
      terminal: { clean() {}, writeLine: line => log(line), write: text => { if (text.trim()) log(text.trim()); } },
    });
    const description = await loader.main('default_reset');
    ui.chipLabel.textContent = description;
    log(`Chip identificado: ${description}`);
    if (loader.chip.CHIP_NAME !== release.chip) throw new Error(`Este firmware es para ${release.chip} y la placa es ${loader.chip.CHIP_NAME}. Instalación cancelada.`);
    if (loader.secureDownloadMode) throw new Error('El chip está en Secure Download Mode; no se puede instalar desde el navegador.');
    let detected;
    try { detected = typeof loader.detectFlashSize === 'function' ? await loader.detectFlashSize() : undefined; } catch { detected = undefined; }
    if (detected && fw.flashSizeBytes(detected) && fw.flashSizeBytes(detected) < fw.flashSizeBytes(release.minFlashSize)) {
      throw new Error(`La flash detectada (${detected}) es menor que la requerida (${release.minFlashSize}).`);
    }
    log(`Flash detectada: ${detected || 'no informada'}`);

    const ordered = [...release.files].sort((a, b) => a.offset - b.offset);
    const total = ordered.reduce((sum, file) => sum + file.size, 0);
    const before = ordered.map((_, index) => ordered.slice(0, index).reduce((sum, file) => sum + file.size, 0));
    setProgress('Instalando firmware…', 0, 'Escribiendo y verificando cada región con MD5.');
    wroteFlash = true;
    await loader.writeFlash({
      fileArray: ordered.map(file => ({ data: files.get(file.path), address: file.offset })),
      flashMode: release.flash.mode, flashFreq: release.flash.freq, flashSize: release.flash.size,
      eraseAll: false, compress: true,
      reportProgress: (index, written, size) => {
        const share = size ? written / size : 1;
        const percent = ((before[index] + share * ordered[index].size) / total) * 100;
        setProgress('Instalando firmware…', percent, `${ordered[index].path.split('/').pop()} en 0x${ordered[index].offset.toString(16)} · ${Math.round(percent)} %`);
      },
      calculateMD5Hash: fw.md5Hex,
    });
    log('Escritura completada y verificada con MD5 por el ESP32.');
    await loader.after('hard_reset');
    await transport.disconnect();
    transport = null;
    setStep('install', 'done');
    await verifyInstallation(release);
  } catch (error) {
    const friendly = explainFlashError(error);
    log(`Error: ${error?.message || error}`);
    setProgress(wroteFlash ? 'La instalación no terminó' : 'No se instaló nada', ui.progress.value, friendly);
    setOutput(ui.deviceState, 'error', wroteFlash
      ? `${friendly} El ESP32 puede no arrancar hasta completar una instalación; reintentar es seguro.`
      : friendly);
    setStep('install', 'error');
    ui.retry.hidden = false;
    state.retryAction = 'install';
  } finally {
    if (transport) { try { await transport.disconnect(); } catch {} }
    setBusy(false);
  }
}

async function verifyInstallation(release) {
  setStep('verify', 'active');
  setProgress('Verificando el arranque…', 100, 'Esperando que el sensor responda con VIGIA/2.');
  let session;
  let result;
  try {
    session = await openSession(state.port);
    const mark = session.events.length;
    await session.resetBoard();
    await session.waitFor(event => event.type === 'ready', 8000, mark);
    const afterReady = session.events.length;
    await session.send('PING');
    await session.waitFor(event => event.type === 'pong', 2000, afterReady);
    result = fw.verifyInstalledFirmware(session.events.slice(mark), release.version);
  } catch (error) {
    result = { ok: false, detail: `No se pudo verificar: ${explainFlashError(error)}` };
  } finally {
    if (session) await session.close();
  }
  log(`Verificación: ${result.detail}`);
  if (result.ok) {
    setStep('verify', 'done');
    setProgress('Instalación verificada', 100, result.detail);
    setOutput(ui.deviceState, 'ok', `${result.detail} Ya puedes usar Vigía Suite.`);
    ui.deviceFirmware.textContent = `Vigía ${release.version}`;
    ui.use.hidden = false;
    state.probe = { state: 'vigia-ready', firmware: release.version };
  } else {
    setStep('verify', 'error');
    setProgress('Instalación sin verificar', 100, result.detail);
    setOutput(ui.deviceState, 'error', `${result.detail} No se considera exitosa. Puedes comprobar de nuevo o reintentar.`);
    ui.retry.hidden = false;
    state.retryAction = 'verify';
  }
}

// ---------- Eventos de la interfaz ----------

async function selectPort() {
  if (state.busy || !supported()) return;
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: fw.SERIAL_FILTERS });
  } catch (error) {
    if (error.name === 'NotFoundError') {
      setOutput(ui.deviceState, 'warn', 'No se seleccionó ningún puerto. Si tu placa no aparece, revisa la guía del controlador USB.');
      ui.driverHelp.open = true;
    } else {
      setOutput(ui.deviceState, 'error', `No se pudo solicitar el puerto: ${error.message}`);
    }
    return;
  }
  state.port = port;
  state.probe = null;
  const { bridge, ids } = portDescription(port);
  ui.portLabel.textContent = `Autorizado · ${ids}`;
  ui.usbChip.textContent = bridge ? bridge.chip : 'Desconocido';
  ui.deviceFirmware.textContent = '—';
  ui.chipLabel.textContent = 'Sin identificar';
  showDriverHint(bridge);
  setStep('port', 'done');
  log(`Puerto elegido por el usuario: ${ids} (${bridge?.chip || 'desconocido'}).`);
  await probeDevice();
}

function supportCheck() {
  if (!('serial' in navigator)) {
    setOutput(ui.support, 'error', 'Este navegador no permite acceder a puertos USB (Web Serial). Usa Chrome o Edge en una computadora.');
  } else if (!window.isSecureContext) {
    setOutput(ui.support, 'error', 'La instalación requiere HTTPS o localhost.');
  } else if (!globalThis.crypto?.subtle) {
    setOutput(ui.support, 'error', 'El navegador no ofrece Web Crypto para verificar el firmware.');
  } else {
    setOutput(ui.support, 'ok', 'Navegador compatible: Web Serial y verificación SHA-256 disponibles.');
  }
}

ui.selectPort.addEventListener('click', selectPort);
ui.probe.addEventListener('click', probeDevice);
ui.releaseSelect.addEventListener('change', () => {
  selectRelease(ui.releaseSelect.value);
  if (state.probe && !['port-busy', 'connection-error'].includes(state.probe.state)) renderProbe(state.probe);
});
ui.reinstall.addEventListener('click', () => { ui.reinstall.hidden = true; offerInstall('reinstall'); });
ui.consent.addEventListener('change', () => setBusy(state.busy));
ui.install.addEventListener('click', installFirmware);
ui.cancel.addEventListener('click', () => { ui.confirmPanel.hidden = true; ui.consent.checked = false; log('Instalación cancelada por el usuario.'); });
ui.retry.addEventListener('click', () => {
  ui.retry.hidden = true;
  if (state.retryAction === 'verify') { verifyInstallation(state.release).catch(error => log(error.message)); return; }
  offerInstall('install');
});
ui.use.addEventListener('click', async () => {
  if (state.busy || !state.port) return;
  window.VigiaApp?.showView('inicio');
  await window.VigiaApp?.connectPort(state.port);
});
navigator.serial?.addEventListener('disconnect', event => {
  if (event.target !== state.port) return;
  state.lost = true;
  log('El ESP32 se desconectó.');
  if (!state.busy) setOutput(ui.deviceState, 'warn', 'El ESP32 se desconectó. Reconéctalo y vuelve a elegir el puerto.');
});

supportCheck();
setBusy(false);
loadManifest();
