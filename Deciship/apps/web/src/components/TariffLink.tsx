import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useHoldsPermission } from '../auth/AuthContext';

/** Tarife ekranına bağlantı. Tarifeleri görme izni olmayan kişi ölü bağlantı görmez, yalnız adı okur. */
export function TariffLink({ id, title, children }: { id: string; title?: string; children: ReactNode }) {
  const can = useHoldsPermission('deciship.tariffs.view');
  return can ? (
    <Link to={`/tariffs/${id}`} title={title}>
      {children}
    </Link>
  ) : (
    <>{children}</>
  );
}
