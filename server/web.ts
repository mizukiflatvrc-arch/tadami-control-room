import { createServer } from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const SNAPSHOT = '/api/monitoring/snapshot';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

/** Static build artifacts + one fixed proxy endpoint. No Vite, SSR or host mounts. */
export function createWebServer(options: { root: string; apiOrigin: string; proxyTimeoutMs?: number }) {
  const upstream = new URL(SNAPSHOT, options.apiOrigin);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password) throw new Error('Web 配信設定が不正です');
  const files = new Map<string, { path: string; size: number }>();
  const scan = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      // Hidden files, source maps and symlinks are never public.
      if (entry.name.startsWith('.') || entry.name.endsWith('.map') || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path, relative);
      else if (entry.isFile()) files.set(relative, { path, size: statSync(path).size });
    }
  };
  scan(options.root);
  const index = files.get('/index.html');
  if (!index) throw new Error('本番 UI ビルドがありません');
  files.set('/', index);
  let active = 0;
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const send = (status: number, code: string) => {
      if (response.destroyed) return;
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: { code } }));
    };
    const target = request.url ?? '';
    // Exact raw paths prevent URL normalization, encoded aliases and open proxies.
    const pathname = target.split('?')[0]!;
    const isApi = pathname === SNAPSHOT;
    if (isApi) response.setHeader('X-Tadami-Data-Origin', 'prometheus');
    if (!isApi && !files.has(pathname)) { request.resume(); send(404, 'NOT_FOUND'); return; }
    if (request.method !== 'GET') {
      request.resume(); response.setHeader('Allow', 'GET'); send(405, 'METHOD_NOT_ALLOWED'); return;
    }
    if ((isApi && target !== SNAPSHOT) || request.headers['transfer-encoding'] ||
      (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      request.resume(); send(400, 'PARAMETERS_NOT_ALLOWED'); return;
    }
    if (!isApi) {
      const file = files.get(pathname)!;
      response.setHeader('Content-Type', MIME[extname(file.path)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', file.size);
      const stream = createReadStream(file.path);
      stream.on('error', () => { response.destroy(); });
      response.on('close', () => stream.destroy());
      stream.pipe(response);
      return;
    }
    if (active >= 2) { send(503, 'BUSY'); return; }
    active += 1;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.on('close', cancel);
    const timeout = setTimeout(cancel, options.proxyTimeoutMs ?? 4000);
    try {
      // Never forward browser cookies, credentials, Host or proxy headers.
      const result = await fetch(upstream, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!result.headers.get('content-type')?.includes('application/json') || !result.body) {
        await result.body?.cancel().catch(() => undefined);
        throw new Error('Invalid response');
      }
      const reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error('Response too large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (response.destroyed) return;
      response.statusCode = result.status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Keep fixture provenance intact so ApiProvider can reject a mistaken target.
      const origin = result.headers.get('x-tadami-data-origin');
      if (origin) response.setHeader('X-Tadami-Data-Origin', origin);
      else response.removeHeader('X-Tadami-Data-Origin');
      response.end(Buffer.concat(chunks));
    } catch {
      send(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FAILURE');
    } finally {
      clearTimeout(timeout);
      response.off('close', cancel);
      active -= 1;
    }
  });
}
