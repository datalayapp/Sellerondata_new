import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { measurements } from '../../api/endpoints';
import type { DimMethod } from '../../api/types';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../components/ui';
import { DIM_METHOD_LABEL } from '../../lib/labels';
import { i18n } from '../../i18n';


/** Yöntem bilgidir, durum değil: düz metin. Satırda renk yalnız durumda. */
export function MethodPill({ method }: { method: DimMethod }) {
  return <span className="t2">{DIM_METHOD_LABEL[method] ?? method}</span>;
}

/** Everything a measurement change can affect: lists, the panel, matched invoices and the dashboard. */
export function invalidateAfterMeasurementChange(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['measurements'] });
  qc.invalidateQueries({ queryKey: ['measurement'] });
  qc.invalidateQueries({ queryKey: ['invoice'] });
  qc.invalidateQueries({ queryKey: ['invoices'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
}

/** POST /measurements/:id/restore with its own toasts — also used from the "Geri al" toast after the panel is gone. */
export async function restoreMeasurement(qc: QueryClient, id: string): Promise<boolean> {
  try {
    await measurements.restore(id);
    toast.ok(i18n.t('measurements:toast.restored'), i18n.t('measurements:toast.recompare'));
    invalidateAfterMeasurementChange(qc);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NEWER_EXISTS') {
      toast.err(i18n.t('measurements:toast.restoreFailed'), i18n.t('measurements:toast.newerExists'));
    } else {
      toast.err(i18n.t('measurements:toast.restoreFailed'), errorMessage(e));
    }
    return false;
  }
}
