import { createServer } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixturePrometheusServer, closeServer, listenLocal } from '../../fixtures/prometheus/http-server';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import type { FixtureScenario } from '../../fixtures/prometheus/responses';

// Isolated local test only. No Docker, .env files or tadami access.
console.log('本番形式のローカル結合検証: 架空の HTTP 応答のみ（実 Prometheus への接続試験ではありません）');
const missing = spawnSync(process.execPath, ['dist-server/api.js'], { env: {}, encoding: 'utf8', timeout: 5000 });
if (missing.status !== 1 || !missing.stderr.includes('バックエンド設定')) throw new Error('設定不足時の起動拒否に失敗しました');
const directory = mkdtempSync(join(tmpdir(), 'tcr-production-test-'));
const apiRoot = join(directory, 'api');
const webRoot = join(directory, 'web');
for (const root of [apiRoot, webRoot]) {
  mkdirSync(root);
  cpSync('dist-server', join(root, 'dist-server'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
}
// API: only its actual runtime dependency. Web: no node_modules at all.
mkdirSync(join(apiRoot, 'node_modules'));
cpSync('node_modules/zod', join(apiRoot, 'node_modules/zod'), { recursive: true });
cpSync('dist-web', join(webRoot, 'dist-web'), { recursive: true });
const children: ChildProcess[] = [];
let scenario: FixtureScenario = 'normal';
const upstream = createFixturePrometheusServer(() => scenario);
const control = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/error') scenario = 'error';
  else if (request.method === 'POST' && request.url === '/normal') scenario = 'normal';
  else response.statusCode = 404;
  response.end();
});
async function launch(entry: 'api' | 'web', cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [`dist-server/${entry}.js`], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${entry}: 起動期限を超えました`)); }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${entry}: 起動失敗 (${code})`)); });
    child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
  });
}
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => {
    child.once('exit', () => resolve()); child.kill('SIGTERM');
  })));
  await Promise.all([upstream, control].filter((server) => server.listening).map(closeServer));
  rmSync(directory, { recursive: true, force: true });
};
try {
  const prometheusUrl = await listenLocal(upstream);
  await launch('api', apiRoot, {
    NODE_ENV: 'production', TCR_API_PORT: '5182', TCR_API_HOST: '127.0.0.1',
    TCR_PROMETHEUS_URL: prometheusUrl, TCR_METRIC_PROFILE: fixtureConfig.profile,
    TCR_HOST_ID: fixtureConfig.host.id, TCR_HOST_NAME: fixtureConfig.host.name, TCR_OS_LABEL: fixtureConfig.host.osLabel,
    TCR_PROMETHEUS_JOB: fixtureConfig.job, TCR_PROMETHEUS_INSTANCE: fixtureConfig.instance,
    TCR_CPU_RATE_WINDOW_SECONDS: '60', TCR_FILESYSTEMS_JSON: JSON.stringify(fixtureConfig.filesystems), TCR_SERVICES_JSON: '[]',
  });
  await launch('web', webRoot, { NODE_ENV: 'production', TCR_WEB_HOST: '127.0.0.1', TCR_WEB_PORT: '5180', TCR_WEB_API_ORIGIN: 'http://127.0.0.1:5182' });
  await listenLocal(control, 5181);
} catch (error) { await stop(); throw error; }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
