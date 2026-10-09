import { createWebServer } from './web';

try {
  const host = process.env.TCR_WEB_HOST ?? '127.0.0.1';
  const port = Number(process.env.TCR_WEB_PORT ?? '18080');
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Web 配信設定が不正です');
  }
  const server = createWebServer({ root: 'dist-web', apiOrigin: process.env.TCR_WEB_API_ORIGIN ?? 'http://monitoring-api:8787' });
  server.on('error', () => { console.error('Web 配信の起動に失敗しました'); process.exitCode = 1; });
  server.listen(port, host, () => { console.log(`TADAMI Web: http://${host}:${port}`); });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  console.error('Web 配信設定と本番 UI ビルドを確認してください');
  process.exitCode = 1;
}
