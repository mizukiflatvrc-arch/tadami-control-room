import type { ServerConfig } from '../../server/config';

/** Fictional configuration. This is never imported by the production backend entry. */
export const fixtureConfig: ServerConfig = {
  prometheusUrl: 'http://127.0.0.1:0/', port: 8787, profile: 'node-exporter-v1',
  host: { id: 'fixture-host', name: 'API 検証ホスト', osLabel: 'OS 未確認（フィクスチャ）' },
  job: 'fixture-node', instance: 'example.invalid:9100', cpuRateWindowSeconds: 60,
  filesystems: [
    { id: 'root-example', device: '/dev/example-root', mountpoint: '/', fstype: 'ext4' },
    { id: 'data-example', device: '/dev/example-data', mountpoint: '/srv/example', fstype: 'xfs' },
  ],
  services: [{ id: 'service-example', name: '確認待ちサービス（検証用）', expectedState: 'running' }],
};
