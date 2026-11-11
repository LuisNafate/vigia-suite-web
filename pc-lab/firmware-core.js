// Lógica pura del instalador de firmware de Vigía Suite.
// No accede al DOM ni al puerto serial para poder probarse con `node --test`.

export const MANIFEST_SCHEMA = 'vigia-firmware-manifest/1';
export const SUPPORTED_PROTOCOL = 2;
export const ESP_IMAGE_MAGIC = 0xe9;
export const CHIP_IDS = Object.freeze({ ESP32: 0 });
const FLASH_SIZES = Object.freeze({ '1MB': 0x100000, '2MB': 0x200000, '4MB': 0x400000, '8MB': 0x800000, '16MB': 0x1000000 });
const FILE_TYPES = new Set(['bootloader', 'partition-table', 'otadata', 'app']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_PATH_RE = /^[0-9A-Za-z._-]+(?:\/[0-9A-Za-z._-]+)*$/;

export const USB_BRIDGES = Object.freeze({
  0x10c4: {
    chip: 'Silicon Labs CP210x',
    vendor: 'Silicon Labs',
    driverUrl: 'https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers',
    driverName: 'CP210x Universal Windows Driver',
  },
  0x1a86: {
    chip: 'WCH CH340 / CH9102',
    vendor: 'WCH (Nanjing Qinheng Microelectronics)',
    driverUrl: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html',
    driverName: 'CH341SER',
  },
  0x303a: {
    chip: 'USB nativo de Espressif',
    vendor: 'Espressif',
    driverUrl: null,
    driverName: null,
  },
});

export const SERIAL_FILTERS = Object.freeze(Object.keys(USB_BRIDGES).map(id => ({ usbVendorId: Number(id) })));

export function usbBridgeInfo(usbVendorId) {
  return USB_BRIDGES[usbVendorId] || null;
}

export function flashSizeBytes(size) {
  return FLASH_SIZES[size] ?? null;
}

export function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('El navegador no ofrece Web Crypto; abre Vigía Suite en HTTPS o localhost.');
  return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

// MD5 (RFC 1321). esptool-js lo usa para comparar la imagen con el hash que calcula el ESP32
// después de escribir la flash. Web Crypto no implementa MD5, por eso se incluye aquí.
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

export function md5Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bytes.length / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let index = 0; index < 64; index++) {
      let f, g;
      if (index < 16) { f = (b & c) | (~b & d); g = index; }
      else if (index < 32) { f = (d & b) | (~d & c); g = (5 * index + 1) % 16; }
      else if (index < 48) { f = b ^ c ^ d; g = (3 * index + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * index) % 16; }
      const next = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[index] + words[g]) >>> 0;
      b = (b + ((sum << MD5_S[index]) | (sum >>> (32 - MD5_S[index])))) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((value, index) => out.setUint32(index * 4, value, true));
  return toHex(new Uint8Array(out.buffer));
}

export function compareVersions(left, right) {
  const parse = value => String(value).split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

function fail(errors, message) { errors.push(message); }

// Valida la estructura del manifiesto. No descarga nada: solo decide si es seguro intentarlo.
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['El manifiesto no es un objeto JSON.'] };
  if (manifest.schema !== MANIFEST_SCHEMA) fail(errors, `Esquema no soportado: ${manifest.schema}`);
  if (!Array.isArray(manifest.releases)) fail(errors, 'El manifiesto no contiene releases.');
  const versions = new Set();
  for (const release of manifest.releases || []) {
    const label = release?.version || '(sin versión)';
    if (!VERSION_RE.test(release?.version || '')) fail(errors, `Versión inválida: ${label}`);
    if (versions.has(release?.version)) fail(errors, `Versión duplicada: ${label}`);
    versions.add(release?.version);
    if (!(release?.chip in CHIP_IDS)) fail(errors, `${label}: chip no soportado (${release?.chip}).`);
    if (release?.protocol !== SUPPORTED_PROTOCOL) fail(errors, `${label}: protocolo ${release?.protocol} no compatible.`);
    const flashBytes = flashSizeBytes(release?.minFlashSize);
    if (!flashBytes) fail(errors, `${label}: minFlashSize inválido.`);
    const flash = release?.flash || {};
    for (const key of ['mode', 'freq', 'size']) if (typeof flash[key] !== 'string' || !flash[key]) fail(errors, `${label}: flash.${key} ausente.`);
    if (!Array.isArray(release?.files) || release.files.length === 0) { fail(errors, `${label}: no declara archivos.`); continue; }
    const ranges = [];
    let apps = 0;
    for (const file of release.files) {
      const name = file?.path || '(sin ruta)';
      if (!SAFE_PATH_RE.test(file?.path || '') || String(file?.path).split('/').some(part => part === '..' || part === '.')) fail(errors, `${label}: ruta no permitida (${name}).`);
      if (!FILE_TYPES.has(file?.type)) fail(errors, `${label}: tipo de archivo desconocido en ${name}.`);
      if (file?.type === 'app') apps++;
      if (!Number.isInteger(file?.offset) || file.offset < 0 || file.offset % 0x1000 !== 0) fail(errors, `${label}: offset inválido en ${name}.`);
      if (!Number.isInteger(file?.size) || file.size <= 0) fail(errors, `${label}: tamaño inválido en ${name}.`);
      if (!SHA256_RE.test(file?.sha256 || '')) fail(errors, `${label}: SHA-256 inválido en ${name}.`);
      if (Number.isInteger(file?.offset) && Number.isInteger(file?.size)) {
        if (flashBytes && file.offset + file.size > flashBytes) fail(errors, `${label}: ${name} excede la flash mínima.`);
        ranges.push([file.offset, file.offset + file.size, name]);
      }
    }
    if (apps !== 1) fail(errors, `${label}: debe existir exactamente una imagen de aplicación.`);
    ranges.sort((x, y) => x[0] - y[0]);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index][0] < ranges[index - 1][1]) fail(errors, `${label}: ${ranges[index - 1][2]} y ${ranges[index][2]} se solapan.`);
    }
  }
  if (manifest.latest && !versions.has(manifest.latest)) fail(errors, `latest (${manifest.latest}) no existe en releases.`);
  return { ok: errors.length === 0, errors };
}

export function releasesForChip(manifest, chipName) {
  return (manifest?.releases || [])
    .filter(release => release.chip === chipName && release.channel === 'stable')
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function latestRelease(manifest) {
  const releases = manifest?.releases || [];
  return releases.find(release => release.version === manifest.latest) || null;
}

// Resuelve la URL del binario y exige que sea del mismo origen que el manifiesto.
export function resolveFirmwareUrl(path, manifestUrl) {
  const base = new URL(manifestUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`Origen no permitido para ${path}.`);
  const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  if (!url.pathname.startsWith(directory)) throw new Error(`Ruta fuera del directorio de firmware: ${path}.`);
  return url.href;
}

// Comprueba la cabecera de una imagen ESP (bootloader o aplicación) antes de escribirla.
export function inspectEspImage(bytes, chipName) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return { ok: false, reason: 'Imagen demasiado corta.' };
  if (bytes[0] !== ESP_IMAGE_MAGIC) return { ok: false, reason: 'La imagen no tiene la firma 0xE9 de Espressif.' };
  const chipId = bytes[12] | (bytes[13] << 8);
  const expected = CHIP_IDS[chipName];
  if (expected === undefined) return { ok: false, reason: `Chip ${chipName} no soportado.` };
  if (chipId !== expected) return { ok: false, reason: `La imagen está compilada para otro chip (id ${chipId}).` };
  return { ok: true, segments: bytes[1], chipId };
}

// Interpreta la tabla de particiones binaria de ESP-IDF (entradas de 32 bytes, magia 0xAA 0x50).
export function parsePartitionTable(bytes) {
  const entries = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 32 <= bytes.length; offset += 32) {
    if (bytes[offset] === 0xaa && bytes[offset + 1] === 0x50) {
      const label = new TextDecoder().decode(bytes.subarray(offset + 12, offset + 28)).replace(/\0.*$/s, '');
      entries.push({ type: bytes[offset + 2], subtype: bytes[offset + 3], offset: view.getUint32(offset + 4, true), size: view.getUint32(offset + 8, true), label });
    } else if (bytes[offset] === 0xeb && bytes[offset + 1] === 0xeb) {
      continue; // Entrada MD5 de la propia tabla.
    } else {
      break;
    }
  }
  return entries;
}

// Verifica que los archivos de una release sean coherentes entre sí antes de flashear.
export function checkReleaseImages(release, filesByPath) {
  const problems = [];
  for (const file of release.files) {
    const bytes = filesByPath.get(file.path);
    if (!bytes) { problems.push(`Falta ${file.path}.`); continue; }
    if (file.type === 'bootloader' || file.type === 'app') {
      const image = inspectEspImage(bytes, release.chip);
      if (!image.ok) problems.push(`${file.path}: ${image.reason}`);
    }
  }
  const tableFile = release.files.find(file => file.type === 'partition-table');
  const appFile = release.files.find(file => file.type === 'app');
  if (tableFile && appFile && filesByPath.get(tableFile.path)) {
    const partitions = parsePartitionTable(filesByPath.get(tableFile.path));
    if (!partitions.length) problems.push('La tabla de particiones está vacía o dañada.');
    const target = partitions.find(entry => entry.type === 0 && entry.offset === appFile.offset);
    if (!target) problems.push(`Ninguna partición de aplicación comienza en 0x${appFile.offset.toString(16)}.`);
    else if (appFile.size > target.size) problems.push(`La aplicación (${appFile.size} B) no cabe en ${target.label} (${target.size} B).`);
  }
  return { ok: problems.length === 0, problems };
}

export function parseJsonLine(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  try { const value = JSON.parse(text); return value && typeof value.type === 'string' ? value : null; } catch { return null; }
}

const VIGIA_EVENTS = new Set(['ready', 'pong', 'identity', 'status', 'ble_status', 'error', 'restarting']);

// Mensajes de la ROM del ESP32 cuando no hay una aplicación válida en la flash.
const NO_APP_RE = /invalid header|flash read err|waiting for download|no bootable app|ota data|image (?:is )?invalid/i;

// Clasifica lo observado al sondear un puerto. Nunca asume "sin firmware" por falta de respuesta.
export function classifyProbe({ openError = null, events = [], rawBytes = 0, textLines = [], latestVersion = null } = {}) {
  if (openError) {
    const name = openError.name || '';
    const busy = name === 'NetworkError' || name === 'InvalidStateError';
    return {
      state: busy ? 'port-busy' : 'connection-error',
      detail: busy
        ? 'El puerto está ocupado por otra aplicación o pestaña (Monitor Serie, otra ventana de Vigía).'
        : `No se pudo abrir el puerto: ${openError.message || name}`,
    };
  }
  const vigia = events.filter(event => VIGIA_EVENTS.has(event.type));
  const protocols = new Set(vigia.map(event => event.protocol).filter(value => value !== undefined));
  const ready = vigia.find(event => event.type === 'ready');
  const identity = vigia.find(event => event.type === 'identity');
  const firmware = ready?.firmware || null;
  const answered = vigia.some(event => event.type === 'pong' || event.type === 'identity' || event.type === 'ready');
  if (answered && protocols.size && !protocols.has(SUPPORTED_PROTOCOL)) {
    return { state: 'vigia-incompatible', firmware, protocol: [...protocols][0], identity, detail: `Firmware Vigía con protocolo VIGIA/${[...protocols][0]}; esta versión de la web requiere VIGIA/${SUPPORTED_PROTOCOL}.` };
  }
  if (answered && protocols.has(SUPPORTED_PROTOCOL)) {
    const outdated = Boolean(firmware && latestVersion && compareVersions(firmware, latestVersion) < 0);
    return {
      state: outdated ? 'vigia-outdated' : 'vigia-ready',
      firmware, protocol: SUPPORTED_PROTOCOL, identity,
      detail: firmware ? `Firmware Vigía ${firmware} (VIGIA/${SUPPORTED_PROTOCOL}).` : `Firmware Vigía compatible (VIGIA/${SUPPORTED_PROTOCOL}); versión no informada.`,
    };
  }
  if (textLines.some(line => NO_APP_RE.test(line))) {
    return { state: 'no-firmware', detail: 'El ESP32 arranca, pero no encuentra una aplicación válida en su memoria.' };
  }
  if (rawBytes > 0) return { state: 'unknown-firmware', detail: 'El dispositivo envía datos, pero no responde al protocolo VIGIA.' };
  return { state: 'no-response', detail: 'El dispositivo no respondió. Puede no tener firmware, estar detenido o usar otra velocidad.' };
}

// Verificación posterior a la instalación: sólo es éxito si el sensor arranca con la versión esperada.
export function verifyInstalledFirmware(events, expectedVersion) {
  const ready = events.find(event => event.type === 'ready');
  const pong = events.find(event => event.type === 'pong');
  const protocolOk = [ready, pong].some(event => event?.protocol === SUPPORTED_PROTOCOL);
  if (!protocolOk) return { ok: false, detail: 'El sensor no respondió con el protocolo VIGIA/2 después de reiniciar.' };
  if (!ready) return { ok: false, detail: 'El sensor responde, pero no se pudo leer la versión al arrancar.' };
  if (ready.firmware !== expectedVersion) return { ok: false, detail: `El sensor arrancó con ${ready.firmware}, se esperaba ${expectedVersion}.` };
  return { ok: true, detail: `Firmware ${ready.firmware} verificado (VIGIA/${SUPPORTED_PROTOCOL}).` };
}
