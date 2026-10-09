import { readConfig } from './config';
import { createMonitoringServer } from './app';

try {
  const config = readConfig(process.env);
  const server = createMonitoringServer(config);
  server.on('error', () => {
    console.error('API の起動に失敗しました。ローカルポートの使用状況を確認してください。');
    process.exitCode = 1;
  });
  server.listen(config.port, config.listenHost, () => {
    console.log(`TADAMI API: http://${config.listenHost}:${config.port}（読み取り専用）`);
  });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'バックエンド設定を確認してください');
  process.exitCode = 1;
}
