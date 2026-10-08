import { createServer as createViteServer } from 'vite';
import { createMonitoringServer } from '../server/app';
import { fixtureConfig } from '../fixtures/prometheus/config';
import { closeServer, createFixturePrometheusServer, listenLocal } from '../fixtures/prometheus/http-server';

// One explicit local fixture stack. This entry never reads .env.server or connects to tadami.
const upstream = createFixturePrometheusServer();
const url = await listenLocal(upstream);
const api = createMonitoringServer({ ...fixtureConfig, prometheusUrl: url }, { provenance: 'fixture' });
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
try {
  await listenLocal(api, 8787);
  vite = await createViteServer({
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    define: { 'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('api-fixture') },
  });
  await vite.listen();
  console.log('API 検証データ（模擬）: http://127.0.0.1:5174/');
} catch (error) {
  await vite?.close();
  await closeServer(api).catch(() => undefined);
  await closeServer(upstream);
  throw error;
}
const stop = async () => {
  await vite?.close();
  await Promise.all([closeServer(api), closeServer(upstream)]);
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
