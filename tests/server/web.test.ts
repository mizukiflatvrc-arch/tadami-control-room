// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../../server/web';
import { createMonitoringServer } from '../../server/app';
import { closeServer, createFixturePrometheusServer, listenLocal } from '../../fixtures/prometheus/http-server';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import { validateSnapshot } from '../../src/domain/validation';

const servers: Server[] = [];
const directories: string[] = [];
async function start(server: Server) { servers.push(server); return listenLocal(server); }
function root() {
  const path = mkdtempSync(join(tmpdir(), 'tcr-web-'));
  directories.push(path);
  mkdirSync(join(path, 'assets'));
  writeFileSync(join(path, 'index.html'), '<h1>本番 UI</h1>');
  writeFileSync(join(path, 'assets', 'app.js'), 'console.log("test")');
  writeFileSync(join(path, '.env'), 'PRIVATE-SENTINEL');
  writeFileSync(join(path, 'assets', 'app.js.map'), 'PRIVATE-SENTINEL');
  symlinkSync(join(path, '.env'), join(path, 'secret.txt'));
  return path;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('本番静的配信と固定 API proxy', () => {
  it('同一オリジンで静的 UI と API 契約を維持し検証用応答の種別も保存する', async () => {
    const upstream = await start(createFixturePrometheusServer());
    const api = await start(createMonitoringServer({ ...fixtureConfig, prometheusUrl: upstream }, { provenance: 'fixture' }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    const html = await fetch(web);
    expect(await html.text()).toContain('本番 UI');
    expect(html.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const response = await fetch(`${web}api/monitoring/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-tadami-data-origin')).toBe('fixture');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const snapshot = validateSnapshot(await response.json(), Date.now());
    expect(snapshot.cpu.value!.usagePercent).toBeCloseTo(20);
    expect(JSON.stringify(snapshot)).not.toContain(upstream);
  });
  it('任意 URL・管理経路・要求本文・書き込み・隠しファイルを転送も配信もしない', async () => {
    const received = vi.fn();
    const api = await start(createServer((_, response) => { received(); response.end('{}'); }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    for (const path of ['api/v1/query?query=up', 'api/admin', '.env', 'assets/app.js.map', 'secret.txt', '%2eenv', 'assets/%2e%2e/.env', '//example.invalid']) {
      expect((await fetch(`${web}${path}`)).status).toBe(404);
    }
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await fetch(`${web}api/monitoring/snapshot`, { method })).status).toBe(405);
    }
    for (const query of ['?query=up', '?url=http://example.invalid']) {
      expect((await fetch(`${web}api/monitoring/snapshot${query}`)).status).toBe(400);
    }
    expect(received).not.toHaveBeenCalled();
    const response = await fetch(`${web}assets/app.js`);
    expect(response.headers.get('content-type')).toContain('javascript');
  });
  it('GET の本文と空クエリーを raw HTTP でも拒否する', async () => {
    const received = vi.fn();
    const api = await start(createServer((_, response) => { received(); response.end('{}'); }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    for (const [path, headers, body] of [
      ['/api/monitoring/snapshot?', {}, ''],
      ['/api/monitoring/snapshot', { 'Content-Length': '1' }, 'x'],
      ['/api/monitoring/snapshot', { 'Transfer-Encoding': 'chunked' }, 'x'],
    ] as const) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const pending = request(web, { path, method: 'GET', headers }, (response) => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        pending.on('error', reject); pending.end(body);
      });
      expect(status).toBe(400);
    }
    expect(received).not.toHaveBeenCalled();
  });
  it('ブラウザーの資格情報を転送せず、API の 503 を維持する', async () => {
    const api = await start(createServer((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers['x-forwarded-host']).toBeUndefined();
      response.writeHead(503, { 'Content-Type': 'application/json', 'X-Tadami-Data-Origin': 'prometheus' });
      response.end('{"error":{"code":"BUSY"}}');
    }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    const response = await fetch(`${web}api/monitoring/snapshot`, { headers: { Authorization: 'Bearer PRIVATE-SENTINEL', Cookie: 'token=PRIVATE-SENTINEL', 'X-Forwarded-Host': 'other.invalid' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'BUSY' } });
  });
  it('API 切断でも静的 UI を配信し、エラーに接続先を含めない', async () => {
    const web = await start(createWebServer({ root: root(), apiOrigin: 'http://127.0.0.1:1' }));
    const response = await fetch(`${web}api/monitoring/snapshot`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_FAILURE' } });
    expect((await fetch(web)).status).toBe(200);
  });
  it('proxy の期限・同時要求上限を守る', async () => {
    const api = await start(createServer(() => {}));
    const web = await start(createWebServer({ root: root(), apiOrigin: api, proxyTimeoutMs: 200 }));
    const requests = [fetch(`${web}api/monitoring/snapshot`), fetch(`${web}api/monitoring/snapshot`), fetch(`${web}api/monitoring/snapshot`)];
    const results = await Promise.all(requests);
    expect(results.map((response) => response.status).sort()).toEqual([503, 504, 504]);
  });
  it.each(['redirect', 'html', 'oversize'])('不正な上流応答を拒否: %s', async (kind) => {
    const api = await start(createServer((_, response) => {
      if (kind === 'redirect') { response.writeHead(302, { Location: 'http://example.invalid/PRIVATE-SENTINEL' }); response.end(); }
      else if (kind === 'html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>PRIVATE-SENTINEL</html>'); }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(2 * 1024 * 1024 + 1)); }
    }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    const response = await fetch(`${web}api/monitoring/snapshot`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_FAILURE' } });
  });
  it('ブラウザー切断時は API 取得も中止する', async () => {
    let received: () => void = () => {};
    let disconnected: () => void = () => {};
    const ready = new Promise<void>((resolve) => { received = resolve; });
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    const api = await start(createServer((_, response) => { response.on('close', disconnected); received(); }));
    const web = await start(createWebServer({ root: root(), apiOrigin: api }));
    const controller = new AbortController();
    const pending = fetch(`${web}api/monitoring/snapshot`, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await assertion;
    await closed;
  });
});
