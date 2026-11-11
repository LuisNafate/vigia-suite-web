// Verifica que pc-lab/firmware/manifest.json sea válido y coincida byte a byte con los binarios publicados.
// Uso: node scripts/verify-firmware.mjs   (código de salida 1 si algo no coincide)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateManifest, sha256Hex, checkReleaseImages } from '../pc-lab/firmware-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firmwareDir = path.join(root, 'pc-lab', 'firmware');
const manifestPath = path.join(firmwareDir, 'manifest.json');

export async function verifyPublishedFirmware() {
  if (!existsSync(manifestPath)) return { ok: true, skipped: true, messages: ['No hay manifiesto publicado todavía.'] };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const messages = [];
  const validation = validateManifest(manifest);
  if (!validation.ok) return { ok: false, messages: validation.errors };
  for (const release of manifest.releases) {
    const files = new Map();
    for (const file of release.files) {
      const absolute = path.resolve(firmwareDir, file.path);
      if (!absolute.startsWith(firmwareDir + path.sep)) { messages.push(`${file.path}: fuera del directorio de firmware.`); continue; }
      if (!existsSync(absolute)) { messages.push(`${file.path}: no existe.`); continue; }
      const bytes = new Uint8Array(await readFile(absolute));
      if (bytes.length !== file.size) messages.push(`${file.path}: tamaño ${bytes.length}, manifiesto ${file.size}.`);
      const digest = await sha256Hex(bytes);
      if (digest !== file.sha256) messages.push(`${file.path}: SHA-256 ${digest} no coincide con ${file.sha256}.`);
      files.set(file.path, bytes);
    }
    const coherence = checkReleaseImages(release, files);
    messages.push(...coherence.problems.map(problem => `${release.version}: ${problem}`));
  }
  return { ok: messages.length === 0, messages: messages.length ? messages : [`${manifest.releases.length} release(s) verificadas.`] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyPublishedFirmware();
  for (const message of result.messages) console.log(message);
  process.exitCode = result.ok ? 0 : 1;
}
