import type { ReactNode } from 'react';

export function Panel({ number, title, detail, status, children, className = '' }: {
  number: string; title: string; detail?: string; status?: ReactNode; children: ReactNode; className?: string;
}) {
  const id = `panel-${number}`;
  return <section className={`panel ${className}`} aria-labelledby={id}>
    <div className="panel-heading">
      <h2 id={id}><span className="panel-number">{number}</span>{title}</h2>
      {detail && <span className="panel-detail">{detail}</span>}
      {status && <div className="panel-status">{status}</div>}
    </div>
    {children}
  </section>;
}
