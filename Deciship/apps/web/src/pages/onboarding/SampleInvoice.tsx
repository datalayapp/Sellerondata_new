import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { invoices } from '../../api/endpoints';
import type { InvoiceListItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Tag } from '../../components/ui';
import { fmtDate, fmtNum } from '../../lib/format';
import { TariffHealthPanel } from '../invoice-detail/TariffHealth';
import type { StepCtx } from './Onboarding';

/**
 * Kurulumda yüklenen örnek fatura (Faturalar listesinde görünmez): okunan satır sayısı ve tarife uyumu.
 * `compared`: taşıyıcının tarifesi var ve fatura onunla karşılaştırıldı → tarife uyumu (sapmalar + tek tıkla ülke istisnası).
 * Tarife yokken yalnız okunan satır sayısı gösterilir ("Tarife yok" kurulumun bu aşamasında normaldir).
 */
export function SampleInvoice({ invoice, compared, onRemove }: { invoice: InvoiceListItem; compared: boolean; onRemove?: () => void }) {
  const { t } = useTranslation('onboarding');
  const totals = invoice.totals;
  return (
    <li className="ob-inv">
      <div className="ob-inv-h">
        <span className="grow">
          <b className="mono">{invoice.invoiceNo}</b>
          <span className="t3 s13">
            {' '}
            · {invoice.carrier.name} · {fmtDate(invoice.invoiceDate)}
          </span>
        </span>
        <Tag tone="gray" small>
          {t('sample.badge')}
        </Tag>
        {onRemove && (
          <button type="button" className="link-btn" onClick={onRemove}>
            <Icon name="trash" /> {t('sample.remove')}
          </button>
        )}
      </div>
      {totals &&
        // örnekte ölçüm eşleşmesi / fazla ödeme anlamsız: yalnız okunan satır ve tarifeyle karşılaştırma durumu
        (compared ? (
          <div className="ob-inv-stats">
            <span>{t('sample.linesRead', { count: totals.lines, n: fmtNum(totals.lines) })}</span>
            <Tag tone="green">{t('sample.compared')}</Tag>
          </div>
        ) : (
          <div className="ob-inv-stats">
            <span>{t('sample.linesRead', { count: totals.lines, n: fmtNum(totals.lines) })}</span>
            <span className="t3 s13">{t('sample.willCompare')}</span>
          </div>
        ))}
      {compared && <TariffHealthPanel invoiceId={invoice.id} compact />}
    </li>
  );
}

/**
 * Örnek faturalar tarifeden önce yüklendiyse satırları hiçbir tarifeyle hesaplanmamıştır: taşıyıcının tarifesi eklenince bu faturaları
 * bir kez yeniden karşılaştırır (her fatura bu sayfa açıkken en çok bir kez). Karşılaştırma sürerken true döner.
 */
export function useCompareSampleInvoices(ctx: StepCtx, withTariff: Set<string>): boolean {
  const qc = useQueryClient();
  const tried = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const todo = ctx.status.invoices.filter((i) => withTariff.has(i.carrier.id) && (i.linesWithoutTariff ?? 0) > 0 && !tried.current.has(i.id));
  const key = todo.map((i) => i.id).join(',');
  useEffect(() => {
    if (!todo.length) return;
    for (const i of todo) tried.current.add(i.id);
    setBusy(true);
    (async () => {
      for (const i of todo) await invoices.recompare(i.id).catch(() => undefined);
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setBusy(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return busy;
}
