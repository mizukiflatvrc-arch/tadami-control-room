import { MONITORING } from '../config/monitoring';
import { validateSnapshot } from '../domain/validation';
import type { Clock } from '../lib/clock';
import { systemClock } from '../lib/clock';
import type { MonitoringProvider } from './monitoring-provider';

export async function requestSnapshot(provider: MonitoringProvider, signal: AbortSignal, clock: Clock = systemClock) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new DOMException('取得を中止しました', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      reject(new Error('取得がタイムアウトしました（3 秒）'));
      controller.abort();
    }, MONITORING.timeoutMs);
  });
  try {
    const value = await Promise.race([interrupted, provider.getSnapshot(controller.signal)]);
    return validateSnapshot(value, clock());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
