// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkConfig, readYaml } from '../../tools/monitoring/check-config';

const original = readYaml('infra/monitoring/compose.yaml');
const prometheus = readYaml('infra/monitoring/prometheus.yml');
const lock = JSON.parse(readFileSync('infra/monitoring/images.lock.json', 'utf8'));

describe('監視基盤の配備前安全検査', () => {
  it('バージョン固定・内部通信・読み取り専用・保持設定を満たす', () => {
    expect(checkConfig(original, prometheus, lock)).toEqual([]);
  });
  it.each([
    ['ports', ['9090:9090']], ['network_mode', 'host'], ['privileged', true],
    ['cap_add', ['SYS_ADMIN']], ['pid', 'host'], ['user', '0:0'], ['read_only', false],
    ['env_file', '.env'], ['devices', ['/dev/md0:/dev/md0']],
    ['image', 'quay.io/prometheus/prometheus:latest'],
  ])('危険な追加・変更を拒否: %s', (key, value) => {
    const compose = structuredClone(original) as { services: { prometheus: Record<string, unknown> } };
    compose.services.prometheus[key] = value;
    expect(checkConfig(compose, prometheus, lock).length).toBeGreaterThan(0);
  });
  it('書き込み可能なホストマウントと固定データパスを拒否', () => {
    const compose = structuredClone(original) as { services: Record<string, { volumes: { source: string; read_only?: boolean }[] }> };
    compose.services['node-exporter']!.volumes[0]!.read_only = false;
    expect(checkConfig(compose, prometheus, lock)).toContain('Node Exporter: ホストマウントは所定の読み取り専用パスに限定');
    compose.services.prometheus!.volumes[1]!.source = '/mnt/md0/metrics';
    expect(checkConfig(compose, prometheus, lock).length).toBeGreaterThan(1);
  });
  it('外部収集と収集間隔の変更を拒否', () => {
    const config = structuredClone(prometheus) as { global: { scrape_interval: string }; scrape_configs: { static_configs: { targets: string[] }[] }[] };
    config.scrape_configs[0]!.static_configs[0]!.targets = ['example.com:9100'];
    expect(checkConfig(original, config, lock)).toContain('収集対象は専用内部ネットワーク内の 2 件のみ');
    config.global.scrape_interval = '1s';
    expect(checkConfig(original, config, lock).length).toBeGreaterThan(0);
  });
  it('内部ネットワーク制限の解除と書き込みAPIの有効化を拒否', () => {
    const compose = structuredClone(original) as { networks: { monitoring: { internal: boolean } }; services: { prometheus: { command: string[] } } };
    compose.services.prometheus.command.push('--web.enable-admin-api');
    expect(checkConfig(compose, prometheus, lock)).toContain('Prometheus: フラグが承認済みの範囲外');
    compose.networks.monitoring.internal = false;
    expect(checkConfig(compose, prometheus, lock).length).toBeGreaterThan(0);
  });
});
