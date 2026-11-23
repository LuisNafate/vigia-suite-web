// Ejecuta páginas de pc-lab en un Edge/Chrome sin interfaz mediante el protocolo DevTools.
// No usa dependencias: servidor http de Node + WebSocket global (Node >= 22).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../pc-lab/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function findBrowser() {
  const candidates = [
    process.env.VIGIA_TEST_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find(path => path && existsSync(path)) || null;
}

function startServer(extraPages) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (extraPages[path]) { response.writeHead(200, { 'content-type': TYPES['.html'] }); response.end(extraPages[path]); return; }
    const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) { response.writeHead(403); response.end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
    this.opened = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

/** Abre un navegador sin interfaz y entrega { origin, page } para navegar y evaluar código. */
export async function withBrowser(extraPages, run) {
  const browser = findBrowser();
  const server = await startServer(extraPages);
  const profile = await mkdtemp(join(tmpdir(), 'vigia-browser-test-'));
  // Sin componentes ni red en segundo plano: el perfil temporal queda pequeño y se borra rápido.
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disable-sync',
    '--disable-default-apps', '--disable-features=Translate,OptimizationHints,MediaRouter',
    // Los runners Ubuntu 24.04 de CI bloquean el sandbox de Chrome con AppArmor.
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let page;
  let browserSocketUrl;
  try {
    let port;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { await sleep(100); }
    }
    if (!port) throw new Error('El navegador no abrió el puerto de depuración.');
    browserSocketUrl = `ws://127.0.0.1:${port}${(await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[1].trim()}`;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = new Cdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await page.opened;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = {
      origin,
      evaluate: expression => page.evaluate(expression),
      addInitScript: source => page.send('Page.addScriptToEvaluateOnNewDocument', { source }),
      raw: (method, params) => page.send(method, params),
      async goto(path) { await page.send('Page.navigate', { url: origin + path }); await sleep(300); },
      async waitFor(expression, timeoutMs = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          try { if (await page.evaluate(expression)) return; } catch {}
          await sleep(100);
        }
        throw new Error(`Tiempo agotado esperando: ${expression}`);
      },
    };
    return await run(api);
  } finally {
    page?.close();
    // msedge.exe puede relanzarse en otro proceso: matar el hijo no basta. Browser.close cierra la instancia real.
    if (browserSocketUrl) {
      const browserCdp = new Cdp(browserSocketUrl);
      try { await browserCdp.opened; await Promise.race([browserCdp.send('Browser.close'), sleep(3000)]); } catch {}
      browserCdp.close();
    }
    child.kill();
    server.closeAllConnections();
    server.close();
    await Promise.race([exited, sleep(3000)]);
    await sleep(1500);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
  }
}
