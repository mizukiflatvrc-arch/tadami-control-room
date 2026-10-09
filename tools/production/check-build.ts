import { readFileSync, readdirSync } from 'node:fs';

// Defense in depth, not a general-purpose secret scanner. Context allowlisting
// and disabled Vite environment exposure remain the primary protections.
const denied = ['TCR_PROMETHEUS_', 'http://prometheus:9090', 'PRIVATE-BUILD-SENTINEL', 'do-not-publish-secret'];
for (const entry of readdirSync('dist-web', { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = `${entry.parentPath}/${entry.name}`;
  if (entry.name.endsWith('.map') || entry.name.startsWith('.env')) throw new Error('非公開ファイルが UI 成果物にあります');
  if (!/\.(js|html|css|json|txt)$/.test(entry.name)) continue;
  const contents = readFileSync(path, 'utf8');
  if (denied.some((value) => contents.includes(value))) throw new Error('バックエンド設定または検査用秘密値が UI 成果物にあります');
}
console.log('本番 UI 成果物の設定・検査用秘密値・source map 検査 PASS');
