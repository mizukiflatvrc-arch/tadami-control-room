import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { NODE_HOST_MOUNTS, ROOT_PROBE_DIR } from './host-mount-policy';

type MountInfo = {
  device: string; root: string; target: string; options: string[]; propagation: string[];
  fstype: string; source: string;
};

const inspectSchema = z.tuple([z.object({
  Config: z.object({ Cmd: z.array(z.string()), Labels: z.object({
    'com.docker.compose.project': z.literal('tadami-monitoring'),
    'com.docker.compose.service': z.literal('node-exporter'),
  }) }),
  State: z.object({ Running: z.literal(true), Pid: z.number().int().positive() }),
  Mounts: z.array(z.object({
    Type: z.literal('bind'), Source: z.string(), Destination: z.string(),
    RW: z.literal(false), Propagation: z.literal('rprivate'),
  })).length(NODE_HOST_MOUNTS.length),
  HostConfig: z.object({ Mounts: z.array(z.object({
    Type: z.literal('bind'), Source: z.string(), Target: z.string(), ReadOnly: z.literal(true),
    BindOptions: z.object({
      Propagation: z.literal('rprivate'), CreateMountpoint: z.literal(false).optional(),
      NonRecursive: z.boolean().optional(), ReadOnlyForceRecursive: z.boolean().optional(),
      ReadOnlyNonRecursive: z.literal(false).optional(),
    }),
  })).length(NODE_HOST_MOUNTS.length) }),
})]);

const decodePath = (value: string) => value.replace(/\\(040|011|012|134)/g,
  (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
const within = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

function parseMountInfo(contents: string): MountInfo[] {
  if (!contents.trim()) throw new Error('mountinfo が空です');
  const ids = new Set<string>();
  return contents.trim().split('\n').map((line, index) => {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf('-');
    const [id, parent, device, rawRoot, rawTarget, options] = fields;
    if (separator < 6 || fields.length !== separator + 4 || !id || !/^\d+$/.test(id)
      || !parent || !/^\d+$/.test(parent) || !device || !/^\d+:\d+$/.test(device)
      || !rawRoot || !rawTarget || !options || ids.has(id)) {
      throw new Error(`mountinfo の ${index + 1} 行目が不正です`);
    }
    ids.add(id);
    const root = decodePath(rawRoot);
    const target = decodePath(rawTarget);
    if (![root, target].every((path) => path.startsWith('/') && posix.normalize(path) === path)) {
      throw new Error(`mountinfo の ${index + 1} 行目のパスが不正です`);
    }
    return {
      device, root, target, options: options.split(','), propagation: fields.slice(6, separator),
      fstype: fields[separator + 1]!, source: decodePath(fields[separator + 2]!),
    };
  });
}

/** Reads supplied snapshots only. Never queries Docker, probes a host, or changes mounts. */
export function checkHostMounts(inspect: unknown, containerMountInfo: string, hostMountInfo: string): string[] {
  const parsed = inspectSchema.safeParse(inspect);
  if (!parsed.success) return ['inspect: Node Exporter の識別・稼働状態・読み取り専用・private な 7 件の bind を確認'];
  let mounts: MountInfo[];
  let hostMounts: MountInfo[];
  try {
    mounts = parseMountInfo(containerMountInfo);
    hostMounts = parseMountInfo(hostMountInfo);
  } catch (error) {
    return [error instanceof Error ? error.message : 'mountinfo を解析できません'];
  }
  const errors: string[] = [];
  const must = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
  const container = parsed.data[0];
  must(container.Config.Cmd.includes('--collector.filesystem.mount-points-include=^/$'),
    'inspect: 容量収集がホスト / のみに限定されていません');
  for (const expected of NODE_HOST_MOUNTS) {
    const actual = container.Mounts.filter((mount) => mount.Destination === expected.target);
    const requested = container.HostConfig.Mounts.filter((mount) => mount.Target === expected.target);
    must(actual.length === 1 && actual[0]?.Source === expected.source
      && requested.length === 1 && requested[0]?.Source === expected.source,
    `inspect: ${expected.target} の bind 元が不一致・重複・欠落`);
    const options = requested[0]?.BindOptions;
    must(expected.recursive === 'disabled' ? options?.NonRecursive === true
      : options?.ReadOnlyForceRecursive === true && options.NonRecursive !== true,
    `inspect: ${expected.target} の recursive 設定が不一致`);
    must(mounts.filter((mount) => mount.target === expected.target).length === 1,
      `mountinfo: ${expected.target} が欠落または多重マウント`);
  }
  const hostTargets = mounts.filter((mount) => within(mount.target, '/host'));
  const targets = new Set<string>();
  const dockerArea = /(?:^|\/)(?:var\/lib\/(?:docker|containerd|containers)|run\/(?:docker|containerd))(?:\/|$)/;
  for (const mount of hostTargets) {
    must(!targets.has(mount.target), `mountinfo: ${mount.target} が多重マウント`);
    targets.add(mount.target);
    must(mount.options.includes('ro') && !mount.options.includes('rw'),
      `mountinfo: ${mount.target} は読み取り専用ではありません`);
    must(!mount.propagation.some((flag) => /^(shared|master|propagate_from):/.test(flag)),
      `mountinfo: ${mount.target} は private ではありません`);
    must(NODE_HOST_MOUNTS.some((expected) => expected.target === '/host/sys'
      ? within(mount.target, expected.target) : mount.target === expected.target),
      `mountinfo: ${mount.target} は許可していないホストマウント`);
    const metadataTypes = within(mount.target, '/host/proc') ? ['proc']
      : within(mount.target, '/host/sys') ? ['sysfs', 'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs', 'pstore', 'efivarfs', 'bpf', 'fusectl', 'configfs'] : null;
    must(metadataTypes === null || metadataTypes.includes(mount.fstype),
      `mountinfo: ${mount.target} に proc/sys 以外のファイルシステムが露出`);
    must(mount.target === '/host/root' || !within(mount.target, '/host/root'),
      `mountinfo: ${mount.target} は probe 配下の不要な子マウント`);
    must(![mount.root, mount.target, mount.source].some((path) => dockerArea.test(path))
      && !['overlay', 'nsfs'].includes(mount.fstype),
    `mountinfo: ${mount.target} に Docker 管理領域・runtime マウントが露出`);
  }
  // The statfs probe must refer to exactly the same filesystem/subtree as the host's /.
  const roots = hostMounts.filter((mount) => mount.target === '/');
  const hostRoot = roots[0];
  const probe = mounts.find((mount) => mount.target === '/host/root');
  must(roots.length === 1 && !!hostRoot && !!probe && probe.device === hostRoot.device
    && probe.fstype === hostRoot.fstype && probe.source === hostRoot.source
    && probe.root === posix.join(hostRoot.root, ROOT_PROBE_DIR),
  'probe: ホスト / と同じファイルシステム・専用ディレクトリではありません');
  must(!hostMounts.some((mount) => mount.target !== '/'
    && (within(ROOT_PROBE_DIR, mount.target) || within(mount.target, ROOT_PROBE_DIR))),
  'probe: ホスト側の probe・親・子に別マウントがあります');
  for (const target of ['/proc', '/sys']) {
    const reference = hostMounts.filter((mount) => mount.target === target);
    for (const expected of NODE_HOST_MOUNTS.filter((mount) => within(mount.source, target))) {
      const actual = mounts.find((mount) => mount.target === expected.target);
      must(reference.length === 1 && !!actual && actual.device === reference[0]?.device
        && actual.root === posix.join(reference[0]!.root, posix.relative(target, expected.source))
        && actual.fstype === reference[0]?.fstype,
      `mountinfo: ${expected.target} がホストの ${expected.source} と不一致`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length !== 3) {
    console.error('使用方法: node --import tsx tools/monitoring/check-host-mounts.ts <inspect.json> <node.mountinfo> <host.mountinfo>');
    process.exitCode = 1;
  } else {
    try {
      const errors = checkHostMounts(JSON.parse(readFileSync(paths[0]!, 'utf8')),
        readFileSync(paths[1]!, 'utf8'), readFileSync(paths[2]!, 'utf8'));
      if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
      else console.log('ホストマウントの保存済みスナップショット検査: PASS（採取時点のみ。NVMe 所在・空ディレクトリ・権限・収集値は別途確認）');
    } catch (error) {
      console.error(error instanceof Error ? error.message : '検証ファイルを読み込めません');
      process.exitCode = 1;
    }
  }
}
