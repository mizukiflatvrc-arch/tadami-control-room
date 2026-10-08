export const MONITORING = {
  pollMs: 5_000,
  timeoutMs: 3_000,
  staleMs: 30_000,
  historyStepMs: 15_000,
  historyPoints: 61,
  thresholds: { cpu: [80, 95], memory: [80, 95], storage: [80, 90] },
} as const;
