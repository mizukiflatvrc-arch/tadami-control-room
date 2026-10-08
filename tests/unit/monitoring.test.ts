import { describe, expect, it } from 'vitest';
import { MONITORING } from '../../src/config/monitoring';
import { createFixture } from '../../src/data/mock/fixtures';
import { SCENARIOS } from '../../src/data/mock/scenarios';
import { combineHealth, qualityAt, serviceHealth, summarize, thresholdHealth } from '../../src/domain/health';
import { GiB, usagePercent } from '../../src/domain/metrics';
import { validateSnapshot } from '../../src/domain/validation';
import { dateTime, duration, gib } from '../../src/lib/format';

const now = Date.parse('2026-10-08T12:00:00.000Z');

describe('使用率と判定', () => {
  it.each([
    [79.9, 'normal'], [80, 'warning'], [80.1, 'warning'], [94.9, 'warning'], [95, 'critical'], [95.1, 'critical'],
    [null, 'unknown'], [NaN, 'unknown'], [Infinity, 'unknown'], [-1, 'unknown'], [101, 'unknown'],
  ] as const)('%s の判定は %s', (value, expected) => {
    expect(thresholdHealth(value, MONITORING.thresholds.cpu)).toBe(expected);
  });
  it('ストレージは 90% で異常になる', () => {
    expect(thresholdHealth(89.9, MONITORING.thresholds.storage)).toBe('warning');
    expect(thresholdHealth(90, MONITORING.thresholds.storage)).toBe('critical');
  });
  it('利用可能量に基づく使用率と無効値を扱う', () => {
    expect(usagePercent(32 * GiB, 8 * GiB)).toBe(75);
    for (const [total, available] of [[0, 0], [1, 2], [1, -1], [Infinity, 1], [1, NaN]]) {
      expect(usagePercent(total!, available!)).toBeNull();
    }
  });
  it('期待停止は正常、期待稼働から停止は注意、failed は異常', () => {
    const snapshot = createFixture(now);
    expect(serviceHealth(snapshot.services[3]!)).toBe('normal');
    expect(serviceHealth(createFixture(now, 'service-stopped').services[0]!)).toBe('warning');
    expect(serviceHealth(createFixture(now, 'service-failed').services[0]!)).toBe('critical');
    const unexpectedRunning = snapshot.services[3]!;
    unexpectedRunning.state.value = 'running';
    expect(serviceHealth(unexpectedRunning)).toBe('critical');
  });
  it('総合判定は異常、欠損、注意、正常の順で優先する', () => {
    expect(combineHealth(['normal', 'warning'])).toBe('warning');
    expect(combineHealth(['warning', 'unknown'])).toBe('unknown');
    expect(combineHealth(['critical', 'unknown'])).toBe('critical');
    expect(summarize(createFixture(now, 'mixed'), now)).toEqual({ health: 'critical', incomplete: true });
    expect(summarize(createFixture(now), now, true).health).toBe('unknown');
  });
});

describe('鮮度と境界検証', () => {
  it('取得時刻が新しくても観測値が古ければ更新遅延', () => {
    const snapshot = validateSnapshot(createFixture(now, 'stale'), now);
    expect(snapshot.fetchedAt).toBe(new Date(now).toISOString());
    expect(qualityAt(snapshot.cpu, now)).toBe('stale');
    expect(summarize(snapshot, now).health).toBe('unknown');
  });
  it('観測後 30 秒を超えると stale になる', () => {
    const { cpu } = createFixture(now);
    expect(qualityAt(cpu, now + 30_000)).toBe('fresh');
    expect(qualityAt(cpu, now + 30_001)).toBe('stale');
  });
  it('未来の観測時刻、NaN、ゼロ容量を欠損に変換する', () => {
    const fixture = createFixture(now);
    fixture.cpu.observedAt = new Date(now + 60_000).toISOString();
    fixture.memory.value!.totalBytes = 0;
    fixture.filesystems[0]!.capacity.value!.freeBytes = NaN;
    const snapshot = validateSnapshot(fixture, now);
    expect(snapshot.cpu.value).toBeNull();
    expect(snapshot.memory.quality).toBe('unavailable');
    expect(snapshot.filesystems[0]!.capacity.value).toBeNull();
    expect(snapshot.filesystems).toHaveLength(3);
  });
  it('容量関係の不整合と不明なサービス状態を欠損にする', () => {
    const fixture = createFixture(now);
    fixture.filesystems[0]!.capacity.value!.availableBytes = 9999 * GiB;
    const raw = { ...fixture, services: [{ ...fixture.services[0], state: { ...fixture.services[0]!.state, value: 'bogus' } }] };
    const snapshot = validateSnapshot(raw, now);
    expect(snapshot.filesystems[0]!.capacity.value).toBeNull();
    expect(snapshot.services[0]!.state.value).toBeNull();
  });
  it('不正な構造、未来の取得時刻、重複識別子は取得失敗とする', () => {
    expect(() => validateSnapshot({}, now)).toThrow();
    expect(() => validateSnapshot({ ...createFixture(now), fetchedAt: new Date(now + 60_000).toISOString() }, now)).toThrow();
    const fixture = createFixture(now);
    fixture.services[1]!.id = fixture.services[0]!.id;
    expect(() => validateSnapshot(fixture, now)).toThrow();
  });
  it('履歴を最大 61 点に制限し、不正値を線の欠損として残す', () => {
    const fixture = createFixture(now);
    fixture.history.cpu[10]!.value = Infinity;
    fixture.history.cpu.unshift({ at: new Date(now - 999_000).toISOString(), value: 20 });
    fixture.history.cpu.push({ at: new Date(now + 99_000).toISOString(), value: 20 });
    const result = validateSnapshot(fixture, now);
    expect(result.history.cpu).toHaveLength(61);
    expect(result.history.cpu[10]!.value).toBeNull();
  });
});

describe('モックと日本語書式', () => {
  it('同じ時刻・シードで再現でき、履歴と現在値が一致する', () => {
    const a = createFixture(now, 'normal', 42);
    expect(a).toEqual(createFixture(now, 'normal', 42));
    expect(a.cpu.value!.usagePercent).toBe(a.history.cpu.at(-1)!.value);
    expect(createFixture(now, 'normal', 43).cpu).not.toEqual(a.cpu);
  });
  it.each(SCENARIOS)('$label の fixture は契約に適合する', ({ id }) => {
    const fixture = createFixture(now, id);
    const validated = validateSnapshot(fixture, now);
    expect(validated.source).toBe('mock');
    expect(validated.history.cpu.length).toBeLessThanOrEqual(61);
    for (const fs of validated.filesystems) {
      if (!fs.capacity.value) continue;
      expect(fs.capacity.value.availableBytes).toBeLessThanOrEqual(fs.capacity.value.freeBytes);
    }
  });
  it('JST と GiB、日・時間・分を表示する', () => {
    expect(dateTime(now)).toBe('2026/10/08 21:00:00');
    expect(gib(32 * GiB)).toBe('32.0');
    expect(duration(12 * 86400 + 8 * 3600 + 32 * 60)).toEqual({ days: '12', hours: '08', minutes: '32' });
  });
});
