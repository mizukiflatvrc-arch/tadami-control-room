import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const imageLock = z.object({
  verifiedAt: z.string(), registry: z.literal('https://quay.io/v2/'), platform: z.literal('linux/amd64'),
  images: z.object({
    prometheus: z.object({ repository: z.literal('quay.io/prometheus/prometheus'), tag: z.literal('v3.13.4'), channel: z.literal('LTS'), indexDigest: digest, amd64Digest: digest, release: z.string().url() }).strict(),
    'node-exporter': z.object({ repository: z.literal('quay.io/prometheus/node-exporter'), tag: z.literal('v1.12.1'), channel: z.literal('stable'), indexDigest: digest, amd64Digest: digest, release: z.string().url() }).strict(),
  }).strict(),
}).strict();
const mount = z.object({
  type: z.literal('bind'), source: z.string(), target: z.string(), read_only: z.boolean().optional(),
  bind: z.object({ create_host_path: z.literal(false), propagation: z.enum(['rprivate', 'rslave']).optional() }).strict(),
}).strict();
const service = z.object({
  image: z.string(), platform: z.literal('linux/amd64'), user: z.literal('65534:65534'),
  read_only: z.literal(true), cap_drop: z.tuple([z.literal('ALL')]),
  security_opt: z.tuple([z.literal('no-new-privileges:true')]),
  restart: z.literal('unless-stopped'), init: z.literal(true), pids_limit: z.number().int().positive().max(128),
  mem_limit: z.enum(['1g', '128m']), cpus: z.number().positive().max(1),
  stop_grace_period: z.literal('60s').optional(), command: z.array(z.string()), volumes: z.array(mount),
  networks: z.tuple([z.literal('monitoring')]),
  logging: z.object({ driver: z.literal('json-file'), options: z.object({ 'max-size': z.literal('10m'), 'max-file': z.literal('3') }).strict() }).strict(),
}).strict();
const composeSchema = z.object({
  name: z.literal('tadami-monitoring'), services: z.object({ prometheus: service, 'node-exporter': service }).strict(),
  networks: z.object({ monitoring: z.object({ driver: z.literal('bridge'), internal: z.literal(true), attachable: z.literal(false), enable_ipv6: z.literal(false) }).strict() }).strict(),
}).strict();
const scrape = z.object({
  job_name: z.string(), scheme: z.literal('http'), metrics_path: z.literal('/metrics'),
  follow_redirects: z.literal(false), honor_labels: z.literal(false), honor_timestamps: z.literal(false),
  sample_limit: z.number().positive().max(10000), body_size_limit: z.enum(['5MB', '10MB']),
  label_limit: z.literal(30).optional(), label_name_length_limit: z.literal(200).optional(), label_value_length_limit: z.literal(512).optional(),
  static_configs: z.tuple([z.object({ targets: z.tuple([z.string()]), labels: z.object({ instance: z.string() }).strict() }).strict()]),
}).strict();
const prometheusSchema = z.object({
  global: z.object({ scrape_interval: z.literal('15s'), scrape_timeout: z.literal('10s'), evaluation_interval: z.literal('15s') }).strict(),
  scrape_configs: z.tuple([scrape, scrape]),
}).strict();

export function readYaml(path: string): unknown {
  const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error(`YAML 構文を確認してください: ${path}`);
  return doc.toJS({ maxAliasCount: 0 });
}

/** Static policy checks only: no shell, sockets, containers or target-host probes. */
export function checkConfig(compose: unknown, prometheus: unknown, lock: unknown): string[] {
  const errors: string[] = [];
  const c = composeSchema.safeParse(compose);
  const p = prometheusSchema.safeParse(prometheus);
  const l = imageLock.safeParse(lock);
  for (const [label, result] of [['Compose', c], ['Prometheus', p], ['イメージロック', l]] as const) {
    if (!result.success) errors.push(`${label}: 許可しない構成または必須設定の欠落 (${result.error.issues.map((issue) => issue.path.join('.')).join(', ')})`);
  }
  if (!c.success || !p.success || !l.success) return errors;
  const must = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
  for (const [name, svc] of Object.entries(c.data.services)) {
    const entry = l.data.images[name as keyof typeof l.data.images];
    must(svc.image === `${entry.repository}:${entry.tag}@${entry.indexDigest}`, `${name}: イメージ固定がロックと不一致`);
    must(new Set(svc.command.map((flag) => flag.split('=')[0])).size === svc.command.length, `${name}: 重複フラグ`);
  }
  const prom = c.data.services.prometheus;
  must(JSON.stringify([...prom.command].sort()) === JSON.stringify([
    '--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus',
    '--storage.tsdb.retention.time=7d', '--storage.tsdb.retention.size=1GB',
    '--web.listen-address=0.0.0.0:9090', '--query.timeout=5s', '--query.max-concurrency=4',
  ].sort()), 'Prometheus: フラグが承認済みの範囲外');
  must(prom.volumes.length === 2 && prom.volumes[0]?.source === './prometheus.yml'
    && prom.volumes[0]?.target === '/etc/prometheus/prometheus.yml' && prom.volumes[0]?.read_only === true
    && prom.volumes[1]?.source === '${TCR_PROMETHEUS_DATA_DIR:?OS用NVMe上の専用ディレクトリを確認して指定してください}'
    && prom.volumes[1]?.target === '/prometheus' && !prom.volumes[1]?.read_only
    && prom.volumes.every((volume) => volume.bind.propagation !== 'rslave'),
  'Prometheus: マウント先・読み取り権限・必須データパスを確認');
  const node = c.data.services['node-exporter'];
  const required = ['--web.listen-address=0.0.0.0:9100', '--web.disable-exporter-metrics',
    '--path.procfs=/host/proc', '--path.sysfs=/host/sys', '--path.rootfs=/host/root', '--collector.disable-defaults',
    ...['cpu', 'meminfo', 'diskstats', 'filesystem', 'stat', 'time', 'mdadm'].map((name) => `--collector.${name}`)];
  must(required.every((flag) => node.command.includes(flag)) && node.command.length === required.length + 2
    && node.command.some((flag) => flag.startsWith('--collector.filesystem.mount-points-exclude=^/') && flag.endsWith('($$|/)'))
    && node.command.some((flag) => flag.startsWith('--collector.filesystem.fs-types-exclude=^(') && flag.endsWith(')$$')),
  'Node Exporter: collector・パス・除外式を確認');
  const hostMounts = [
    { source: '/proc', target: '/host/proc', propagation: 'rprivate' },
    { source: '/sys', target: '/host/sys', propagation: 'rprivate' },
    { source: '/', target: '/host/root', propagation: 'rslave' },
  ];
  must(node.volumes.length === hostMounts.length && hostMounts.every((expected, index) => {
    const volume = node.volumes[index];
    return volume?.source === expected.source && volume.target === expected.target
      && volume.read_only === true && volume.bind.propagation === expected.propagation;
  }), 'Node Exporter: ホストマウントは所定の読み取り専用パス・伝播モードに限定');
  const jobs = p.data.scrape_configs;
  must(jobs[0].job_name === 'tadami-node' && jobs[0].static_configs[0].targets[0] === 'node-exporter:9100'
    && jobs[0].static_configs[0].labels.instance === 'tadami'
    && jobs[1].job_name === 'tadami-prometheus' && jobs[1].static_configs[0].targets[0] === 'localhost:9090'
    && jobs[1].static_configs[0].labels.instance === 'tadami-prometheus', '収集対象は専用内部ネットワーク内の 2 件のみ');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkConfig(readYaml('infra/monitoring/compose.yaml'), readYaml('infra/monitoring/prometheus.yml'),
    JSON.parse(readFileSync('infra/monitoring/images.lock.json', 'utf8')));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('監視基盤の静的安全検査: PASS（通信・Docker 操作なし。実機条件は導入前に確認）');
}
