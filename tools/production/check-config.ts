import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readYaml } from '../monitoring/check-config';

const common = {
  image: z.string(),
  build: z.object({ context: z.literal('../..'), dockerfile: z.literal('infra/web/Dockerfile'), target: z.enum(['web', 'api']) }).strict(),
  platform: z.literal('linux/amd64'), user: z.literal('1000:1000'), read_only: z.literal(true),
  cap_drop: z.tuple([z.literal('ALL')]), security_opt: z.tuple([z.literal('no-new-privileges:true')]),
  init: z.literal(true), restart: z.literal('unless-stopped'), pids_limit: z.number().int().min(1).max(64),
  cpus: z.number().positive().max(1), stop_grace_period: z.literal('10s'),
  logging: z.object({ driver: z.literal('json-file'), options: z.object({ 'max-size': z.literal('10m'), 'max-file': z.literal('3') }).strict() }).strict(),
  healthcheck: z.object({ test: z.array(z.string()).min(4), interval: z.literal('30s'), timeout: z.literal('5s'), retries: z.literal(3), start_period: z.literal('10s') }).strict(),
};
const schema = z.object({
  name: z.literal('tadami-web'),
  services: z.object({
    web: z.object({
      ...common, mem_limit: z.literal('128m'),
      environment: z.object({ TCR_WEB_HOST: z.literal('0.0.0.0'), TCR_WEB_PORT: z.literal('8080') }).strict(),
      ports: z.tuple([z.literal('127.0.0.1:18080:8080')]), networks: z.tuple([z.literal('frontend')]),
      depends_on: z.object({ 'monitoring-api': z.object({ condition: z.literal('service_healthy') }).strict() }).strict(),
    }).strict(),
    'monitoring-api': z.object({
      ...common, mem_limit: z.literal('256m'),
      environment: z.object({ TCR_API_HOST: z.literal('0.0.0.0'), TCR_API_PORT: z.literal('8787') }).strict(),
      env_file: z.tuple([z.object({ path: z.literal('./api.env'), required: z.literal(true) }).strict()]),
      networks: z.tuple([z.literal('frontend'), z.literal('monitoring')]),
    }).strict(),
  }).strict(),
  networks: z.object({
    frontend: z.object({ driver: z.literal('bridge'), internal: z.literal(true), attachable: z.literal(false), enable_ipv6: z.literal(false) }).strict(),
    monitoring: z.object({ external: z.literal(true), name: z.literal('tadami-monitoring_monitoring') }).strict(),
  }).strict(),
}).strict();

export function checkWebConfig(value: unknown): string[] {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => `構成を確認: ${issue.path.join('.')}`);
  const errors: string[] = [];
  for (const [name, service] of Object.entries(parsed.data.services)) {
    const target = name === 'web' ? 'web' : 'api';
    if (service.build.target !== target || !service.image.startsWith(`tadami-control-room-${target}:`)
      || !service.image.includes('${TCR_RELEASE:?')) errors.push(`${name}: 固定リリースとビルド対象を確認`);
    if (JSON.stringify(service.healthcheck.test).includes('prometheus')) errors.push(`${name}: healthcheck はローカルのみ`);
  }
  return errors;
}

export function checkDockerfile(value: string): string[] {
  const errors: string[] = [];
  const bases = [...value.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  if (bases.length !== 4 || bases.some((base) => base !== 'node:22.23.2-bookworm-slim')) errors.push('Node 基底イメージのバージョンを確認');
  if ((value.match(/^USER 1000:1000$/gm) ?? []).length !== 2) errors.push('本番実行ユーザーを確認');
  if (/^COPY\s+\.\s|\.env|^ADD\s|^VOLUME\s|--import tsx|npm run (dev|preview)/m.test(value)) errors.push('不要なコンテキスト・マウント・開発サーバーを確認');
  if (!value.includes('npm ci --omit=dev --ignore-scripts') || !value.includes('npm run build:production')) errors.push('本番依存・本番ビルドを確認');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = [...checkWebConfig(readYaml('infra/web/compose.yaml')), ...checkDockerfile(readFileSync('infra/web/Dockerfile', 'utf8'))];
  if (errors.length) { errors.forEach((error) => console.error(error)); process.exitCode = 1; }
  else console.log('Web 配備静的検査 PASS（YAML・権限・ポート・ネットワーク。Docker 実行検証ではない）');
}
