import { useCallback, useEffect, useRef, useState } from 'react';
import { MONITORING } from '../../config/monitoring';
import type { MonitoringProvider } from '../../data/monitoring-provider';
import { requestSnapshot } from '../../data/request-snapshot';
import type { MonitoringSnapshot } from '../../domain/monitoring';

type State = { snapshot: MonitoringSnapshot | null; loading: boolean; error: string | null };

export function useMonitoring(provider: MonitoringProvider) {
  const [state, setState] = useState<State>({ snapshot: null, loading: true, error: null });
  const [now, setNow] = useState(() => Date.now());
  const actions = useRef({ refresh: () => {}, restart: () => {} });

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let generation = 0;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const cancel = () => {
      generation += 1;
      clearTimeout(poll);
      controller?.abort();
      busy = false;
    };
    const request = async () => {
      if (busy || disposed || document.hidden) return;
      clearTimeout(poll);
      busy = true;
      const current = ++generation;
      controller = new AbortController();
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const snapshot = await requestSnapshot(provider, controller.signal);
        if (!disposed && current === generation) setState({ snapshot, loading: false, error: null });
      } catch (error) {
        if (!disposed && current === generation) {
          setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : '監視データを取得できません' }));
        }
      } finally {
        if (!disposed && current === generation) {
          busy = false;
          if (!document.hidden) poll = setTimeout(() => { void request(); }, MONITORING.pollMs);
        }
      }
    };
    actions.current = {
      refresh: () => { void request(); },
      restart: () => { cancel(); void request(); },
    };
    const visibility = () => {
      if (document.hidden) {
        cancel();
        setState((prev) => ({ ...prev, loading: false }));
      } else {
        setNow(Date.now());
        void request();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    const clock = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    void request();
    return () => {
      disposed = true;
      cancel();
      clearInterval(clock);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [provider]);

  return {
    ...state, now,
    refresh: useCallback(() => actions.current.refresh(), []),
    restart: useCallback(() => actions.current.restart(), []),
  };
}
