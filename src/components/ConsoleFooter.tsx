import { DATA_LABELS, type DataMode } from '../config/data-source';

export function ConsoleFooter({ mode }: { mode: DataMode }) {
  return <footer className="console-footer"><span><strong>{DATA_LABELS[mode].label}</strong> · {DATA_LABELS[mode].detail}</span><span>更新間隔 5 秒 <span className="divider">/</span> 時刻 JST <span className="divider">/</span> <span className="mono">TCR β0.2</span></span></footer>;
}
