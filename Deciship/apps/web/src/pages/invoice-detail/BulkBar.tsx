import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { invoices } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { BulkDecideFilter, BulkDecideResult, Decision } from '../../api/types';
import { toast } from '../../components/Toast';
import { Button, errorMessage } from '../../components/ui';
import { fmtNum } from '../../lib/format';
import { ReasonModal } from './LineDialogs';
import { decideBody, selectedCount, skippedSummary, undoBody, type Selection } from './bulk';

/**
 * Seçim çubuğu (Mesaj 14 Parça D): "N satır seçildi · İtiraz listesine ekle · Uyumlu say · Seçimi kaldır". Tek birincil eylem
 * "İtiraz listesine ekle"; "Uyumlu say" gerekçe ister. Başarıda "Geri al" eylemli bildirim çıkar. Telefonda alta yapışır (CSS).
 */
export function BulkBar({
  invoiceId,
  selection,
  filter,
  canSelectAll,
  total,
  eligible,
  reviewFilter,
  onSelectAll,
  onClear,
}: {
  invoiceId: string;
  selection: Selection;
  /** Listenin süzgeci: `filter` kipinde sunucuya bununla gider. */
  filter: BulkDecideFilter;
  /** Sayfadaki bütün uygun satırlar seçili ve süzgeçte başka satırlar var. */
  canSelectAll: boolean;
  /** Süzgecin toplam satır sayısı. */
  total: number;
  /** 10-B14: süzgeçte kararı değişebilecek satır sayısı (eski sunucuda null): "tümünü seç" bunu söyler. */
  eligible?: number | null;
  /** "İncele" süzgeci: bu satırlar itiraz listesine toplu girmez, birincil eylem "Uyumlu say" olur. */
  reviewFilter?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('invoiceDetail');
  const qc = useQueryClient();
  const [reasonOpen, setReasonOpen] = useState(false);
  const count = selectedCount(selection);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const skippedLine = (r: BulkDecideResult) => {
    const skipped = skippedSummary(r.skipped);
    const reasons = skipped.keys.map((k) => t(`bulk.skip.${k}`)).join(', ');
    return { reasons, text: skipped.total > 0 ? t('bulk.toast.skipped', { count: skipped.total, n: fmtNum(skipped.total), reasons }) : undefined };
  };

  // Geri al yalnız bu işlemin kararını açar (`undoOf`): arada başkasının verdiği karar kalır, atlananlarda söylenir.
  const undo = (r: BulkDecideResult) => {
    invoices
      .decideMany(invoiceId, undoBody(r))
      .then((u) => toast.ok(t('bulk.toast.undone'), skippedLine(u).text))
      .catch((e) => toast.err(t('bulk.failed'), errorMessage(e)))
      .finally(refresh);
  };

  const announce = (r: BulkDecideResult) => {
    const { reasons, text: skippedText } = skippedLine(r);
    if (r.changed === 0) {
      toast.info(skippedText ?? t('bulk.toast.skipped', { count: 0, n: fmtNum(0), reasons }));
      return;
    }
    const key = r.decision === 'ACCEPTED' ? 'bulk.toast.accepted' : 'bulk.toast.verified';
    toast.ok(t(key, { count: r.changed, n: fmtNum(r.changed) }), skippedText, {
      action: { label: t('bulk.undo'), onClick: () => undo(r) },
    });
  };

  const run = useMutation({
    mutationFn: (v: { decision: Decision; reason?: string }) => invoices.decideMany(invoiceId, decideBody(selection, v.decision, filter, v.reason)),
    // hatayı bu bileşen söyler (genel "işlem başarısız" bildirimi yerine)
    meta: { silent: true },
    onSuccess: (r) => {
      setReasonOpen(false);
      announce(r);
      refresh();
      onClear();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SELECTION_CHANGED') {
        // süzgecin sonucu seçim anından beri değişti: liste yenilenir, seçim bırakılır
        setReasonOpen(false);
        refresh();
        toast.info(t('bulk.changed'));
        onClear();
      } else {
        toast.err(t('bulk.failed'), errorMessage(e));
      }
    },
  });

  const all = selection.mode === 'filter';
  // 10-B14: "tümünü seç" süzgecin toplamını değil, kararı değişecek satırları sayar (sunucu biliyorsa)
  const known = all && selection.eligible != null;
  return (
    <>
      <div className="bulk-bar" role="region" aria-label={t('bulk.selected', { count, n: fmtNum(count) })}>
        <div className="bulk-info">
          <span className="bulk-count" role="status">
            {known
              ? t('bulk.allSelectedEligible', { count, n: fmtNum(count) })
              : all
                ? t('bulk.allSelected', { count, n: fmtNum(count) })
                : t('bulk.selected', { count, n: fmtNum(count) })}
          </span>
          {canSelectAll && (
            <button type="button" className="link-btn bulk-all" onClick={onSelectAll}>
              {eligible != null
                ? t('bulk.selectAllEligible', { count: eligible, n: fmtNum(eligible) })
                : t('bulk.selectAll', { count: total, n: fmtNum(total) })}
            </button>
          )}
        </div>
        <div className="bulk-acts">
          {/* "İncele" satırı itiraz listesine toplu girmez (sunucu `review` sayar): o süzgeçte düğme yok, "Uyumlu say" birincil */}
          {!reviewFilter && (
            <Button small loading={run.isPending && !reasonOpen} disabled={run.isPending} onClick={() => run.mutate({ decision: 'VERIFIED' })}>
              {t('bulk.verify')}
            </Button>
          )}
          <Button small kind={reviewFilter ? undefined : 'secondary'} disabled={run.isPending} onClick={() => setReasonOpen(true)}>
            {t('bulk.accept')}
          </Button>
          <Button small kind="plain" disabled={run.isPending} onClick={onClear}>
            {t('bulk.clear')}
          </Button>
        </div>
      </div>
      {reasonOpen && (
        <ReasonModal
          trackingNo={t('bulk.selected', { count, n: fmtNum(count) })}
          title={t('bulk.reasonTitle', { count, n: fmtNum(count) })}
          loading={run.isPending}
          onClose={() => setReasonOpen(false)}
          onSubmit={(reason) => run.mutate({ decision: 'ACCEPTED', reason })}
        />
      )}
    </>
  );
}
