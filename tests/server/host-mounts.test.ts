// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkHostMounts } from '../../tools/monitoring/check-host-mounts';
import { NODE_HOST_MOUNTS, ROOT_PROBE_DIR } from '../../tools/monitoring/host-mount-policy';

const hostMountInfo = [
  '1 0 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '2 1 0:5 / /proc rw,nosuid - proc proc rw',
  '3 1 0:6 / /sys rw,nosuid - sysfs sysfs rw',
].join('\n');
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
      '15 13 0:8 / /host/root/run/docker/netns/a rw - nsfs nsfs rw',
      '16 13 0:9 / /host/root/var/lib/docker/rootfs/overlayfs/a rw,relatime - overlay overlay rw',
      '17 13 0:10 / /host/root/run/docker/netns/b rw - nsfs nsfs rw',
    ].join('\n')}`;
    const errors = checkHostMounts(inspect, mounts, hostMountInfo);
    expect(errors.filter((error) => error.includes('読み取り専用ではありません'))).toHaveLength(3);
    expect(errors.filter((error) => error.includes('Docker 管理領域'))).toHaveLength(3);
  });
  it.each([...NODE_HOST_MOUNTS.map((mount) => mount.target), '/host/sys/fs/cgroup'])('%s の実マウント rw を拒否', (target) => {
    const mounts = nodeMountInfo.replace(`${target} ro,`, `${target} rw,`);
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain(`mountinfo: ${target} は読み取り専用ではありません`);
  });
  it.each(['shared:4', 'master:4', 'propagate_from:4'])('実際の伝播状態 %s を拒否', (flag) => {
    const mounts = nodeMountInfo.replace('/host/root ro,relatime -', `/host/root ro,relatime ${flag} -`);
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('mountinfo: /host/root は private ではありません');
  });
  it('probe の子マウントは ro でも拒否し、未知のホストマウントも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 13 0:8 / /host/root/child ro - tmpfs tmpfs rw\n16 10 0:9 / /host/extra ro - tmpfs tmpfs rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('mountinfo: /host/root/child は probe 配下の不要な子マウント');
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('mountinfo: /host/extra は許可していないホストマウント');
  });
  it('別名で露出した Docker 管理領域も ro でも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 12 259:2 /var/lib/docker /host/sys/alias ro - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('mountinfo: /host/sys/alias に Docker 管理領域・runtime マウントが露出');
  });
  it('proc/sys 経由の一般ファイルシステム露出を ro でも拒否する', () => {
    const mounts = `${nodeMountInfo}\n15 12 259:2 /custom-data-root /host/sys/alias ro - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('mountinfo: /host/sys/alias に proc/sys 以外のファイルシステムが露出');
  });
  it.each(['259:3', '/wrong-probe', '/dev/other'])('probe の FS・ディレクトリ不一致 %s を拒否', (replacement) => {
    const mounts = nodeMountInfo.split('\n').map((line) => line.includes('/host/root')
      ? line.replace(replacement.startsWith('/dev') ? '/dev/nvme0n1p2' : replacement.startsWith('/') ? ROOT_PROBE_DIR : '259:2', replacement) : line).join('\n');
    expect(checkHostMounts(inspect, mounts, hostMountInfo)).toContain('probe: ホスト / と同じファイルシステム・専用ディレクトリではありません');
  });
  it.each(['/var', ROOT_PROBE_DIR, `${ROOT_PROBE_DIR}/child`])('ホスト側の probe 関連別マウント %s を拒否', (target) => {
    const host = `${hostMountInfo}\n4 1 259:2 / ${target} rw - ext4 /dev/nvme0n1p2 rw`;
    expect(checkHostMounts(inspect, nodeMountInfo, host)).toContain('probe: ホスト側の probe・親・子に別マウントがあります');
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
    expect(checkHostMounts(inspect, wrongFile, hostMountInfo)).toContain('mountinfo: /host/proc/stat がホストの /proc/stat と不一致');
  });
  it('起動時に容量収集の許可リストが変更された構成を拒否する', () => {
    const modified = structuredClone(inspect);
    modified[0]!.Config.Cmd = ['--collector.filesystem.mount-points-include=.*'];
    expect(checkHostMounts(modified, nodeMountInfo, hostMountInfo)).toContain('inspect: 容量収集がホスト / のみに限定されていません');
  });
});
