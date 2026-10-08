import { GiB } from '../domain/metrics';

const timeFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function time(value: string | number | null | undefined): string {
  return value == null ? '—' : timeFormat.format(new Date(value));
}
export function dateTime(value: string | number | null | undefined): string {
  return value == null ? '—' : `${dateFormat.format(new Date(value))} ${time(value)}`;
}
export function percent(value: number | null): string {
  return value == null ? '—' : value.toFixed(1);
}
export function gib(value: number): string {
  return (value / GiB).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
export function duration(seconds: number): { days: string; hours: string; minutes: string } {
  return {
    days: String(Math.floor(seconds / 86400)).padStart(2, '0'),
    hours: String(Math.floor(seconds / 3600) % 24).padStart(2, '0'),
    minutes: String(Math.floor(seconds / 60) % 60).padStart(2, '0'),
  };
}
