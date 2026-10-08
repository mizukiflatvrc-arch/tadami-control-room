import type { Health } from '../domain/monitoring';

const HEALTH_LABELS = { normal: '正常', warning: '注意', critical: '異常', unknown: '不明' };
const marks = { normal: '○', warning: '△', critical: '!', unknown: '—' };
export function StatusLabel({ health, label }: { health: Health; label?: string }) {
  return <span className={`status-label status-${health}`}><span aria-hidden="true">{marks[health]}</span> {label ?? HEALTH_LABELS[health]}</span>;
}
