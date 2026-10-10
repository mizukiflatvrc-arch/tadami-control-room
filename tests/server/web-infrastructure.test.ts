// @vitest-environment node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkDockerfile, checkWebConfig } from '../../tools/production/check-config';
import { readYaml } from '../../tools/monitoring/check-config';
import { readConfig } from '../../server/config';

const original = readYaml('infra/web/compose.yaml');
type Compose = { services: Record<string, Record<string, unknown>>; networks: Record<string, Record<string, unknown>> };

describe('Web コンテナの権限・通信境界', () => {
  it('監視基盤を別プロジェクトとして維持し API のみ接続する', () => {
    expect(checkWebConfig(original)).toEqual([]);
    expect(checkDockerfile(readFileSync('infra/web/Dockerfile', 'utf8'))).toEqual([]);
  });
  it.each([
    ['user', '0:0'], ['cap_add', ['NET_ADMIN']], ['privileged', true], ['network_mode', 'host'],
    ['pid', 'host'], ['devices', ['/dev/dri']], ['read_only', false], ['security_opt', []],
    ['volumes', ['/var/run/docker.sock:/var/run/docker.sock', '/tmp/.X11-unix:/tmp/.X11-unix', '/:/host']],
    ['ports', ['0.0.0.0:18080:8080']], ['ports', ['127.0.0.1:18080:8080']], ['ports', ['127.0.0.1:9090:9090']],
    ['networks', ['frontend', 'monitoring']], ['mem_limit', '4g'], ['cpus', 4], ['logging', { driver: 'none' }],
    ['environment', { TCR_WEB_HOST: '0.0.0.0', TCR_WEB_PORT: '8080', VITE_PROMETHEUS_URL: 'http://prometheus:9090' }],
  ])('Web への危険な設定を拒否: %s', (key, value) => {
    const compose = structuredClone(original) as Compose;
    compose.services.web![key] = value;
    expect(checkWebConfig(compose).length).toBeGreaterThan(0);
  });
  it('API のホスト公開と外部接続追加を拒否', () => {
    const compose = structuredClone(original) as Compose;
    compose.services['monitoring-api']!.ports = ['127.0.0.1:8787:8787'];
    expect(checkWebConfig(compose).length).toBeGreaterThan(0);
    delete compose.services['monitoring-api']!.ports;
    compose.networks.frontend!.internal = false;
    expect(checkWebConfig(compose).length).toBeGreaterThan(0);
    compose.networks.frontend!.internal = true;
    compose.networks.monitoring!.name = 'default';
    expect(checkWebConfig(compose).length).toBeGreaterThan(0);
  });
  it('タグ再利用・秘密ファイル COPY・開発サーバーを検知する', () => {
    const compose = structuredClone(original) as Compose;
    compose.services.web!.image = 'tadami-control-room-web:latest';
    expect(checkWebConfig(compose).length).toBeGreaterThan(0);
    const recipe = readFileSync('infra/web/Dockerfile', 'utf8');
    for (const addition of ['COPY . .', 'COPY .env.server .', 'CMD npm run dev', 'VOLUME /tmp']) {
      expect(checkDockerfile(`${recipe}\n${addition}\n`).length).toBeGreaterThan(0);
    }
  });
  it('実測設定候補を読み取り、必須項目の欠落時は秘密値を表示せず起動拒否する', () => {
    const env = parseEnv(readFileSync('infra/web/api.env.example', 'utf8'));
    const config = readConfig(env);
    expect(config.host.name).toBe('tadami');
    expect(config.filesystems).toEqual([{ id: 'root', device: '/dev/nvme0n1p2', mountpoint: '/', fstype: 'ext4' }]);
    expect(config.services).toEqual([]);
    for (const field of ['TCR_PROMETHEUS_URL', 'TCR_METRIC_PROFILE', 'TCR_HOST_ID', 'TCR_HOST_NAME', 'TCR_PROMETHEUS_JOB', 'TCR_PROMETHEUS_INSTANCE', 'TCR_CPU_RATE_WINDOW_SECONDS', 'TCR_FILESYSTEMS_JSON']) {
      const incomplete: NodeJS.ProcessEnv = { ...env, TCR_PROMETHEUS_TOKEN: 'PRIVATE-SENTINEL' };
      delete incomplete[field];
      expect(() => readConfig(incomplete)).toThrow(`バックエンド設定を確認してください: ${field}`);
    }
  });
});
