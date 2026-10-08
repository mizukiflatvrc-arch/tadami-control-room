import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { buildQueries } from '../../server/prometheus/queries';
import { fixtureConfig } from './config';
import { fixtureResponse, type FixtureScenario } from './responses';

export function createFixturePrometheusServer(scenario: () => FixtureScenario = () => 'normal') {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const kind = url.pathname === '/api/v1/query' ? 'instant' : url.pathname === '/api/v1/query_range' ? 'range' : null;
    const now = Number(url.searchParams.get(kind === 'range' ? 'end' : 'time')) * 1000;
    const query = kind && Number.isFinite(now) ? buildQueries(fixtureConfig, now).find((item) => item.kind === kind && item.expression === url.searchParams.get('query')) : undefined;
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || !query) {
      response.statusCode = 400;
      response.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'Unsupported fixture query' }));
    } else response.end(JSON.stringify(fixtureResponse(query, scenario())));
  });
}

export async function listenLocal(server: Server, port = 0): Promise<string> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ローカルサーバーの起動に失敗しました');
  return `http://127.0.0.1:${address.port}/`;
}
export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
