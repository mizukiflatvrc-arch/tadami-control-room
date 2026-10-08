export const GiB = 1024 ** 3;

export function usagePercent(total: number, available: number): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0 || available < 0 || available > total) return null;
  return ((total - available) / total) * 100;
}
