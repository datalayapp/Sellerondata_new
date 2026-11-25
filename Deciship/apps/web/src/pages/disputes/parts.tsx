import { useTranslation } from 'react-i18next';
import type { DeadlineInfo } from '@deciship/core';
import { ApiError } from '../../api/client';
import type { DisputeLineOutcome, DisputeListStatus, DisputeTtk, InvoiceDisputeStatus } from '../../api/types';
import { StatusPill, errorMessage } from '../../components/ui';
import { i18n } from '../../i18n';
import { DISPUTE_ERROR_CODES, deadlineState, type DeadlineState } from '../../lib/disputes';
import { fmtDate, fmtNum } from '../../lib/format';
import type { Tone } from '../../lib/labels';

/** Kapanan itiraz para getirdiyse yeşil, yalnız ret ise nötr: "Kapandı" iyi haber sanılmasın. */
export function ListStatusTag({ status, recovered }: { status: DisputeListStatus; recovered?: number }) {
  const { t } = useTranslation('disputes');
  const tone: Tone = status === 'UNSENT' ? 'yellow' : status === 'SENT' ? 'blue' : recovered === 0 ? 'gray' : 'green';
  return <StatusPill tone={tone}>{t(`listStatus.${status}`)}</StatusPill>;
}

export function InvoiceDisputeTag({ status, recovered }: { status: InvoiceDisputeStatus; recovered?: number }) {
  const { t } = useTranslation('disputes');
  const tone: Tone = status === 'NONE' ? 'gray' : status === 'SENT' ? 'blue' : recovered === 0 ? 'gray' : 'green';
  return <StatusPill tone={tone}>{t(`invoiceStatus.${status}`)}</StatusPill>;
}

const OUTCOME_TONE: Record<DisputeLineOutcome, Tone> = { PENDING: 'blue', RECOVERED: 'green', REJECTED: 'red' };
/** `line`: fatura satırında bekleyen sonuç "İtirazda" diye yazılır ("Karar bekliyor" ile karışmasın). */
export function OutcomeTag({ outcome, small, line }: { outcome: DisputeLineOutcome; small?: boolean; line?: boolean }) {
  const { t } = useTranslation('disputes');
  return (
    <StatusPill tone={OUTCOME_TONE[outcome]} small={small}>
      {line && outcome === 'PENDING' ? t('card.lockedDecision') : t(`outcome.${outcome}`)}
    </StatusPill>
  );
}

const STATE_CLASS: Record<DeadlineState, string> = { onTime: 'ok', late: 'late', open: '', soon: 'soon', today: 'soon', expired: 'over' };

/** "TTK · 10 Kas 2026 · 2 gün kaldı" / "… · zamanında itiraz edildi". */
export function DeadlineLine({ label, info, sentOn, ttkStatus }: { label: string; info: DeadlineInfo; sentOn?: string | null; ttkStatus?: DisputeTtk }) {
  const { t } = useTranslation('disputes');
  const st = deadlineState(info, sentOn, ttkStatus);
  const text =
    st === 'onTime'
      ? t('deadline.onTime')
      : st === 'late'
        ? t('deadline.late')
        : st === 'expired'
          ? t('deadline.expired')
          : st === 'today'
            ? t('deadline.today')
            : t('deadline.daysLeft', { count: info.daysLeft, n: fmtNum(info.daysLeft) });
  return (
    <span className={`dsp-dl ${STATE_CLASS[st]}`} data-state={st}>
      <span className="dsp-dl-k">{label}</span> <span className="num">{fmtDate(info.lastDay)}</span>
      <span className="dsp-dl-s">{text}</span>
    </span>
  );
}

/** İtiraz uçlarının hata metni: bilinen kodlar kendi cümlesiyle, diğerleri sunucunun iletisiyle. */
export function disputeErrorText(e: unknown): string {
  if (e instanceof ApiError && (DISPUTE_ERROR_CODES as readonly string[]).includes(e.code)) return i18n.t(`errors.${e.code}`, { ns: 'disputes' });
  return errorMessage(e);
}
