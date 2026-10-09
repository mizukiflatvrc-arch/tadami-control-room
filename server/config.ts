import { z } from 'zod';

const text = z.string().trim().min(1).max(256);
const id = text.regex(/^[a-zA-Z0-9_-]+$/);
const filesystem = z.object({
  id, mountpoint: text, device: text, fstype: text,
}).strict();
const service = z.object({
  id, name: text, expectedState: z.enum(['running', 'stopped']),
}).strict();

export type ServerConfig = {
  prometheusUrl: string;
  authorization?: string;
  port: number;
  listenHost: '127.0.0.1' | '0.0.0.0';
  profile: 'node-exporter-v1';
  host: { id: string; name: string; osLabel: string };
  job: string;
  instance: string;
  cpuRateWindowSeconds: number;
  filesystems: z.infer<typeof filesystem>[];
  services: z.infer<typeof service>[];
};

function json(value: string | undefined): unknown {
  try { return JSON.parse(value ?? 'null'); } catch { return null; }
}

/** Read only server environment variables; never import this module into the UI. */
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const schema = z.object({
    TCR_PROMETHEUS_URL: z.url().refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }),
    TCR_METRIC_PROFILE: z.literal('node-exporter-v1'),
    TCR_HOST_ID: id,
    TCR_HOST_NAME: text,
    TCR_OS_LABEL: text.default('OS 未確認'),
    TCR_PROMETHEUS_JOB: text,
    TCR_PROMETHEUS_INSTANCE: text,
    TCR_CPU_RATE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(3600),
    TCR_API_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
    TCR_API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    TCR_FILESYSTEMS_JSON: z.array(filesystem).min(1).max(32),
    TCR_SERVICES_JSON: z.array(service).max(64),
    TCR_PROMETHEUS_AUTH: z.enum(['none', 'bearer', 'basic']).default('none'),
  });
  const parsed = schema.safeParse({
    ...env,
    TCR_FILESYSTEMS_JSON: json(env.TCR_FILESYSTEMS_JSON),
    TCR_SERVICES_JSON: json(env.TCR_SERVICES_JSON ?? '[]'),
  });
  if (!parsed.success) {
    // Zod errors can contain input values: report field names only.
    throw new Error(`バックエンド設定を確認してください: ${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(', ')}`);
  }
  const data = parsed.data;
  for (const list of [data.TCR_FILESYSTEMS_JSON, data.TCR_SERVICES_JSON]) {
    if (new Set(list.map((item) => item.id)).size !== list.length) throw new Error('監視対象の id が重複しています');
  }
  const fsKeys = data.TCR_FILESYSTEMS_JSON.map((item) => JSON.stringify([item.device, item.mountpoint, item.fstype]));
  if (new Set(fsKeys).size !== fsKeys.length) throw new Error('ファイルシステムの指定が重複しています');
  const credential = (key: string) => {
    const value = env[key];
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`認証設定を確認してください: ${key}`);
    return value;
  };
  let authorization: string | undefined;
  if (data.TCR_PROMETHEUS_AUTH === 'bearer') authorization = `Bearer ${credential('TCR_PROMETHEUS_TOKEN')}`;
  if (data.TCR_PROMETHEUS_AUTH === 'basic') {
    const user = credential('TCR_PROMETHEUS_USERNAME');
    if (user.includes(':')) throw new Error('認証設定を確認してください: TCR_PROMETHEUS_USERNAME');
    authorization = `Basic ${Buffer.from(`${user}:${credential('TCR_PROMETHEUS_PASSWORD')}`).toString('base64')}`;
  }
  return {
    prometheusUrl: data.TCR_PROMETHEUS_URL.replace(/\/+$/, '') + '/',
    authorization, port: data.TCR_API_PORT, listenHost: data.TCR_API_HOST, profile: data.TCR_METRIC_PROFILE,
    host: { id: data.TCR_HOST_ID, name: data.TCR_HOST_NAME, osLabel: data.TCR_OS_LABEL },
    job: data.TCR_PROMETHEUS_JOB, instance: data.TCR_PROMETHEUS_INSTANCE,
    cpuRateWindowSeconds: data.TCR_CPU_RATE_WINDOW_SECONDS,
    filesystems: data.TCR_FILESYSTEMS_JSON, services: data.TCR_SERVICES_JSON,
  };
}
