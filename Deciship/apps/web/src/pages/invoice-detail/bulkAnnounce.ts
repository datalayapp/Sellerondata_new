import type { TFunction } from 'i18next';
import { toast } from '../../components/Toast';
import { fmtNum } from '../../lib/format';
import { bulkStale, type BulkOutcome } from './recalc';

/**
 * Toplu uygulama işi bitince bilgi iletisi (pencere ve sayfa bandı aynı metni kullanır). `t`: `invoiceDetail` ad alanı.
 * Durdurulmuş ya da başarısız işte yazılan fatura sayısı varsa "N fatura güncellendi, kalanı durduruldu" söylenir;
 * başarısız işe ayrıca "bazı faturalar güncellenmiş olabilir" uyarısı eklenir. K4: önizlemeden sonra değiştiği için
 * geçirilmeyen fatura varsa ayrı cümleyle söylenir (liste ve "Yeniden önizle" penceresi `useRecalcFlow` `showStale`).
 */
export function announceBulkOutcome(t: TFunction, o: BulkOutcome, scope: 'tariff' | 'settings'): void {
  if (o.kind === 'applied') {
    const inDispute = o.result.skipped?.inDispute ?? 0;
    const stale = bulkStale(o.result).count;
    toast.ok(
      t(`recalc.done.${scope}Bulk`),
      [
        t('recalc.done.bulkBody', { invoices: t('recalc.units.invoices', { count: o.result.invoices, n: fmtNum(o.result.invoices) }) }),
        inDispute > 0 ? t('recalc.done.bulkSkipped', { n: fmtNum(inDispute) }) : '',
        stale > 0 ? t('recalc.staleDone.toast', { count: stale, n: fmtNum(stale) }) : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  } else if (o.kind === 'appliedStopped') {
    toast.info(t('common:jobs.stopped'), t('recalc.done.bulkStopped', { n: fmtNum(o.written) }));
  } else if (o.kind === 'applyFailed') {
    const parts = [o.message, o.written > 0 ? t('recalc.done.bulkStopped', { n: fmtNum(o.written) }) : '', t('recalc.failedPartial')];
    toast.err(t('recalc.failed'), parts.filter(Boolean).join(' '));
  }
}
