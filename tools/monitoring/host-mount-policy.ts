/** The probe must be an empty, trusted directory on the host's / filesystem. */
export const ROOT_PROBE_DIR = '/var/lib/tadami-control-room/node-exporter-root-probe';

export const NODE_HOST_MOUNTS = [
  { source: '/proc/stat', target: '/host/proc/stat', recursive: 'disabled' },
  { source: '/proc/meminfo', target: '/host/proc/meminfo', recursive: 'disabled' },
  { source: '/proc/diskstats', target: '/host/proc/diskstats', recursive: 'disabled' },
  { source: '/proc/mdstat', target: '/host/proc/mdstat', recursive: 'disabled' },
  { source: '/proc/1/mountinfo', target: '/host/proc/1/mountinfo', recursive: 'disabled' },
  { source: '/sys', target: '/host/sys', recursive: 'readonly' },
  { source: ROOT_PROBE_DIR, target: '/host/root', recursive: 'disabled' },
] as const;
