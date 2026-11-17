import { createContext, useContext, type ReactNode } from 'react';

/** Salt okunur görünüm: alanlar kapalı, değiştiren düğmeler hiç çizilmez (tarifeyi yalnız görme izni, salt okunur abonelik). */
export const TariffReadOnly = createContext(false);
export const useTariffReadOnly = () => useContext(TariffReadOnly);

/** Editor section card: title + one-line plain explanation + optional actions. */
export function Sec({ id, title, desc, actions, children, className }: { id: string; title: string; desc: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const readOnly = useTariffReadOnly();
  return (
    <section className={`card te-sec${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-h`}>
      <div className="card-h">
        <div className="grow">
          <h2 className="tt" id={`${id}-h`}>
            {title}
          </h2>
          <p className="card-desc">{desc}</p>
        </div>
        {actions && !readOnly && <div className="te-sec-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
