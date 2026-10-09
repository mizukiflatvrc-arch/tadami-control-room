// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHostMounts } from '../../tools/monitoring/check-host-mounts';
import { NODE_HOST_MOUNTS, ROOT_PROBE_DIR } from '../../tools/monitoring/host-mount-policy';

const hostMountInfo = [
  '1 0 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '2 1 0:5 / /proc rw,nosuid - proc proc rw',
  '3 1 0:6 / /sys rw,nosuid - sysfs sysfs rw',
].join('\n');
const hostNamespaceMount = '4 1 0:4 mnt:[4026532410] /run/snapd/ns/canonical-livepatch.mnt rw - nsfs nsfs rw';
const nodeMountInfo = [
  '10 0 0:99 / / ro,relatime - overlay overlay rw',
  ...NODE_HOST_MOUNTS.filter((mount) => mount.source.startsWith('/proc/')).map((mount, index) =>
    `${20 + index} 10 0:5 ${mount.source.slice('/proc'.length)} ${mount.target} ro,nosuid - proc proc rw`),
  '12 10 0:6 / /host/sys ro,nosuid - sysfs sysfs rw',
  `13 10 259:2 ${ROOT_PROBE_DIR} /host/root ro,relatime - ext4 /dev/nvme0n1p2 rw`,
  '14 12 0:7 / /host/sys/fs/cgroup ro,nosuid - cgroup2 cgroup rw',
].join('\n');
const inspect = [{
  Config: { Cmd: ['--collector.filesystem.mount-points-include=^/$'], Labels: { 'com.docker.compose.project': 'tadami-monitoring', 'com.docker.compose.service': 'node-exporter' } },
  State: { Running: true, Pid: 1234 },
  Mounts: NODE_HOST_MOUNTS.map((mount) => ({
    Type: 'bind', Source: String(mount.source), Destination: mount.target, RW: false, Propagation: 'rprivate',
  })),
  HostConfig: { Mounts: NODE_HOST_MOUNTS.map((mount) => ({
    Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: true,
    BindOptions: {
      Propagation: 'rprivate', CreateMountpoint: false,
      NonRecursive: mount.recursive === 'disabled', ReadOnlyForceRecursive: mount.recursive === 'readonly',
    },
  })) },
}];

describe('保存済みの Node Exporter ホストマウント検査', () => {
  it('private・全子マウント ro・同一 root FS の専用 probe を確認する（superblock rw は許可）', () => {
    expect(checkHostMounts(inspect, nodeMountInfo, hostMountInfo)).toEqual([]);
  });
  it('inspect が RW=false でも報告された 3 件の rw 子マウントを拒否する', () => {
    const mounts = `${nodeMountInfo}\n${[
      '15 13 0:8 net:[4026532411] /host/root/run/docker/netns/a rw - nsfs nsfs rw',
      '16 13 0:9 / /host/root/var/lib/docker/rootfs/overlayfs/a rw,relatime - overlay overlay rw',
      '17 13 0:10 net:[4026532412] /host/root/run/docker/netns/b rw - nsfs nsfs rw',
    ].join('\n')}`;
    const errors = checkHostMounts(inspect, mounts, `${hostMountInfo}\n${hostNamespaceMount}`);
    expect(errors.filter((error) => error.includes('読み取り専用ではありません'))).toHaveLength(3);
    expect(errors.filter((error) => error.includes('Docker 管理領域'))).toHaveLength(3);
  });
  it.each([...NODE_HOST_MOUNTS.map((mount) => mount.target), '/host/sys/fs/cgroup'])('%s の実マウント rw を拒否', (target) => {
    const mounts = nodeMountInfo.replace(`${target} ro,`, `${target} rw,`);
    const line = mounts.split('\n').findIndex((entry) => entry.includes(` ${target} `)) + 1;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining(`node.mountinfo の ${line} 行目`));
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining(`${target} は読み取り専用ではありません`));
  });
  it.each(['shared:4', 'master:4', 'propagate_from:4'])('実際の伝播状態 %s を拒否', (flag) => {
    const mounts = nodeMountInfo.replace('/host/root ro,relatime -', `/host/root ro,relatime ${flag} -`);
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('/host/root は private ではありません'));
  });
  it('probe の子マウントは ro でも拒否し、未知のホストマウントも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 13 0:8 / /host/root/child ro - tmpfs tmpfs rw\n16 10 0:9 / /host/extra ro - tmpfs tmpfs rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('/host/root/child は probe 配下の不要な子マウント'));
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('/host/extra は許可していないホストマウント'));
  });
  it('別名で露出した Docker 管理領域も ro でも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 12 259:2 /var/lib/docker /host/sys/alias ro - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('/host/sys/alias に Docker 管理領域・runtime マウントが露出'));
  });
  it('proc/sys 経由の一般ファイルシステム露出を ro でも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 12 259:2 /custom-data-root /host/sys/alias ro - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('/host/sys/alias に proc/sys 以外のファイルシステムが露出'));
  });
  it.each(['259:3', '/wrong-probe', '/dev/other'])('probe の FS・ディレクトリ不一致 %s を拒否', (replacement) => {
    const mounts = nodeMountInfo.split('\n').map((line) => line.includes('/host/root')
      ? line.replace(replacement.startsWith('/dev') ? '/dev/nvme0n1p2' : replacement.startsWith('/') ? ROOT_PROBE_DIR : '259:2', replacement) : line).join('\n');
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContainEqual(expect.stringContaining('probe: ホスト / と同じファイルシステム・専用ディレクトリではありません'));
  });
  it.each(['/var', ROOT_PROBE_DIR, `${ROOT_PROBE_DIR}/child`])('ホスト側の probe 関連別マウント %s を拒否', (target) => {
    const host = `${hostMountInfo}\n4 1 259:2 / ${target} rw - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, nodeMountInfo, host)).toContainEqual(expect.stringContaining('probe: ホスト側の probe・親・子に別マウントがあります'));
  });
  it.each(NODE_HOST_MOUNTS.map((_, index) => index))('inspect のマウント %i の recursive 強制・非再帰指定の欠落を拒否', (index) => {
    const modified = structuredClone(inspect);
    modified[0]!.HostConfig.Mounts[index]!.BindOptions.NonRecursive = false;
    modified[0]!.HostConfig.Mounts[index]!.BindOptions.ReadOnlyForceRecursive = false;
    expect(checkHostMounts(modified, nodeMountInfo, hostMountInfo).some((error) => error.includes('recursive 設定'))).toBe(true);
  });
  it('旧 / 全体の bind と停止したコンテナの inspect を拒否する', () => {
    const modified = structuredClone(inspect);
    modified[0]!.Mounts.at(-1)!.Source = '/';
    expect(checkHostMounts(modified, nodeMountInfo, hostMountInfo).length).toBeGreaterThan(0);
    modified[0]!.State.Running = false;
    expect(checkHostMounts(modified, nodeMountInfo, hostMountInfo).length).toBeGreaterThan(0);
  });
  it('空・壊れた mountinfo、必要マウント欠落、多重マウントを拒否する', () => {
    for (const mounts of ['', 'invalid', nodeMountInfo.split('\n').filter((line) => !line.includes('/host/root')).join('\n'),
      `${nodeMountInfo}\n15 10 259:2 ${ROOT_PROBE_DIR} /host/root ro - ext4 /dev/nvme0n1p2 rw`]) {
      expect(checkHostMounts(inspect, mounts, hostMountInfo).length).toBeGreaterThan(0);
    }
  });
  it('mountinfo のエスケープされたスペースを解析する', () => {
    const mounts = `${nodeMountInfo}\n15 12 0:6 /space\\040dir /host/sys/space\\040dir ro - sysfs sysfs rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toEqual([]);
  });
  it('proc 全体の共有や proc の別ファイルへの差し替えを拒否する', () => {
    const broadProc = `${nodeMountInfo}\n25 10 0:5 / /host/proc ro - proc proc rw`;
    expect(checkHostMounts(inspect, broadProc, hostMountInfo).length).toBeGreaterThan(0);
    const wrongFile = nodeMountInfo.replace('0:5 /stat /host/proc/stat', '0:5 /1/root /host/proc/stat');
    expect(checkHostMounts(inspect, wrongFile, hostMountInfo)).toContainEqual(expect.stringContaining('/host/proc/stat がホストの /proc/stat と不一致'));
  });
  it('起動時に容量収集の許可リストが変更された構成を拒否する', () => {
    const modified = structuredClone(inspect);
    modified[0]!.Config.Cmd = ['--collector.filesystem.mount-points-include=.*'];
    expect(checkHostMounts(modified, nodeMountInfo, hostMountInfo)).toContain('inspect: 容量収集がホスト / のみに限定されていません');
  });

  describe.each(['host.mountinfo', 'node.mountinfo'] as const)('%s の特殊 root とパス検証', (file) => {
    const base = file === 'host.mountinfo' ? hostMountInfo : nodeMountInfo;
    const nextLine = base.split('\n').length + 1;
    const audit = (snapshot: string) => file === 'host.mountinfo'
      ? checkHostMounts(inspect, nodeMountInfo, snapshot) : checkHostMounts(inspect, snapshot, hostMountInfo);

    it.each(['mnt', 'net', 'pid', 'pid_for_children', 'user', 'uts', 'ipc', 'cgroup', 'time', 'time_for_children'])(
      'nsfs の %s:[inode] を root として認識する', (type) => {
        expect(audit(`${base}\n30 1 0:4 ${type}:[4026532410] /run/snapd/ns/canonical-livepatch.mnt rw - nsfs nsfs rw\n`)).toEqual([]);
      });

    it.each(['ext4', 'tmpfs', 'proc', 'nsfs.fake'])('fstype=%s では特殊 root を認めない（source=nsfs でも拒否）', (fstype) => {
      const errors = audit(`${base}\n30 1 0:4 mnt:[4026532410] /run/snapd/ns/livepatch.mnt rw - ${fstype} nsfs rw`);
      expect(errors).toEqual([expect.stringContaining(`${file} の ${nextLine} 行目のパスが不正です`)]);
      expect(errors[0]).toContain(`fstype="${fstype}"`);
    });

    it.each(['relative', '../root', '/safe/../root', '/safe/./root', '/safe//root',
      'unknown:[123]', 'mnt:[]', 'mnt:[abc]', 'mnt:[-1]', 'mnt:[1]/child', '../mnt:[1]', 'mnt:[1]/../root',
      '/bad\\057path', '/bad\u0000path', '/bad\tpath', '/bad\\path'])(
      '不正な root %s を nsfs でも拒否する', (root) => {
        expect(audit(`${base}\n30 1 0:4 ${root} /run/ns/test rw - nsfs nsfs rw`))
          .toEqual([expect.stringContaining(`${file} の ${nextLine} 行目のパスが不正です`)]);
      });

    it.each(['mnt:[123]', 'relative', '../host', '/host/sys/../extra', '/host//sys', '/host/./sys',
      '/host\\057sys', '/host/\u0000sys', '/host/\tsys'])(
      '不正な target %s を特殊 root でも拒否する', (target) => {
        expect(audit(`${base}\n30 1 0:4 mnt:[123] ${target} ro - nsfs nsfs rw`))
          .toEqual([expect.stringContaining(`${file} の ${nextLine} 行目のパスが不正です`)]);
      });

    it.each(['\\040', '\\011', '\\012', '\\134'])('正当なパスの escape %s を維持する', (escape) => {
      expect(audit(`${base}\n30 1 0:6 /name${escape}part /host/sys/name${escape}part ro - sysfs sysfs rw`)).toEqual([]);
    });

    it.each(['30 1 0:4 mnt:[123] /run/ns/test ro - nsfs nsfs',
      '30 1 0:4 mnt:[123] /run/ns/test ro - nsfs nsfs rw extra',
      '30 1 bad mnt:[123] /run/ns/test ro - nsfs nsfs rw',
      '30 1 0:4 mnt:[123] /run/ns/test ro nsfs nsfs rw',
      '30 1 0:4 mnt:[123] /run/ns/test ro - nsfs  rw',
      '30 1 0:4 mnt:[123] /run/ns/test ro -  nsfs rw',
      '', base.split('\n')[0]!])('空行・壊れたフィールド・重複 ID を拒否する: %s', (line) => {
      expect(audit(`${base}\n${line}\n`)).toEqual([expect.stringContaining(`${file} の ${nextLine} 行目が不正です`)]);
    });

    it('先頭の空行を削除せず 1 行目として拒否する', () => {
      expect(audit(`\n${base}`)).toEqual([`${file} の 1 行目が不正です`]);
    });
  });

  it.each(['/host', '/host/extra', '/host/sys/alias', '/host/root/run/docker/netns/test'])(
    '特殊 root の nsfs が %s に露出すれば ro でも拒否する', (target) => {
      for (const option of ['ro', 'rw']) {
        const mounts = `${nodeMountInfo}\n30 12 0:4 net:[4026532410] ${target} ${option} - nsfs nsfs rw`;
        const errors = checkHostMounts(inspect, mounts, `${hostMountInfo}\n${hostNamespaceMount}`);
        expect(errors).toContain(`node.mountinfo の 10 行目（fstype="nsfs"）: ${target} に Docker 管理領域・runtime マウントが露出`);
        if (option === 'rw') expect(errors).toContainEqual(expect.stringContaining('読み取り専用ではありません'));
        if (target === '/host/sys/alias') expect(errors).toContainEqual(expect.stringContaining('proc/sys 以外のファイルシステムが露出'));
        else expect(errors).toContainEqual(expect.stringContaining('許可していないホストマウント'));
      }
    });

  it('ホストの正常な nsfs があっても probe・親・子の別マウントは拒否する', () => {
    const host = `${hostMountInfo}\n30 1 0:4 mnt:[123] ${ROOT_PROBE_DIR}/child rw - nsfs nsfs rw`;
    expect(checkHostMounts(inspect, nodeMountInfo, host)).toEqual([
      'probe: ホスト側の probe・親・子に別マウントがあります（host.mountinfo の 4 行目（fstype="nsfs"））',
    ]);
  });

  it('CLI は host.mountinfo の 29 行目の nsfs を許容し、別の fstype なら診断して終了コード 1 を返す', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tcr-mountinfo-'));
    const paths = ['inspect.json', 'node.mountinfo', 'host.mountinfo'].map((name) => join(directory, name));
    const host = [hostMountInfo, ...Array.from({ length: 25 }, (_, index) =>
      `${4 + index} 1 0:8 / /run/test-${index} rw - tmpfs tmpfs rw`),
    '29 1 0:4 mnt:[4026532410] /run/snapd/ns/canonical-livepatch.mnt rw - nsfs nsfs rw'].join('\n');
    try {
      writeFileSync(paths[0]!, JSON.stringify(inspect));
      writeFileSync(paths[1]!, nodeMountInfo);
      writeFileSync(paths[2]!, `${host}\n`);
      const run = () => spawnSync(process.execPath,
        ['--import', 'tsx', 'tools/monitoring/check-host-mounts.ts', ...paths], { encoding: 'utf8', timeout: 10_000 });
      const valid = run();
      expect(valid.error).toBeUndefined();
      expect(valid.status).toBe(0);
      expect(valid.stdout).toContain('PASS');
      writeFileSync(paths[2]!, host.replace('- nsfs nsfs rw', '- ext4 nsfs rw'));
      const invalid = run();
      expect(invalid.error).toBeUndefined();
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('host.mountinfo の 29 行目のパスが不正です');
      expect(invalid.stderr).toContain('fstype="ext4"');
      expect(invalid.stderr).toContain('root="mnt:[4026532410]"');
      expect(invalid.stderr).toContain('target="/run/snapd/ns/canonical-livepatch.mnt"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
