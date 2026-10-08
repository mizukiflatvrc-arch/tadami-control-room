import type { MonitoringSnapshot } from '../../domain/monitoring';
import { CpuPanel } from './CpuPanel';
import { MemoryPanel } from './MemoryPanel';
import { StoragePanel } from './StoragePanel';
import { UptimePanel } from './UptimePanel';
import { ServicesPanel } from './ServicesPanel';

export function Dashboard(props: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  return <main id="main" className="dashboard">
    <div className="dashboard-row"><CpuPanel {...props} /><MemoryPanel {...props} /></div>
    <StoragePanel {...props} />
    <div className="dashboard-row lower-row"><UptimePanel {...props} /><ServicesPanel {...props} /></div>
  </main>;
}
