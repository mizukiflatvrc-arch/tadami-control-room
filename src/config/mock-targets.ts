// All hardware sizes, mount points and service names below are fictional fixtures.
export const MOCK_HOST = { id: 'tadami', name: 'tadami', osLabel: 'Ubuntu 24.04.5 LTS' };
export const MOCK_FILESYSTEMS = [
  { id: 'root', mountpoint: '/', sizeGiB: 256, usedPercent: 34.2 },
  { id: 'data', mountpoint: '/srv/data', sizeGiB: 2048, usedPercent: 62.8 },
  { id: 'backup', mountpoint: '/srv/backup', sizeGiB: 4096, usedPercent: 21.5 },
];
export const MOCK_SERVICES = [
  { id: 'web', name: 'Web サーバー', expectedState: 'running' },
  { id: 'files', name: 'ファイル共有', expectedState: 'running' },
  { id: 'metrics', name: 'メトリクス収集', expectedState: 'running' },
  { id: 'backup', name: '定期バックアップ', expectedState: 'stopped' },
] as const;
