import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { AiTariffReview, ImportIssue, ImportOptions, JobView } from '../../api/types';
import { Icon } from '../../components/Icon';
import { fmtDate, fmtNum } from '../../lib/format';

/** KALANLAR 6.18: inceleme arka plan işidir; `loading` süren işi (`job`, yoklama anı `at`) taşır, ilk yanıta dek yok. */
export type AiState =
  | { s: 'idle' }
  | { s: 'loading'; job?: JobView; at?: number }
  | { s: 'done'; r: AiTariffReview; key: string }
  | { s: 'off' }
  | { s: 'error'; e: unknown };

/** Karar etiketi `tariffImport:ai.verdict.<karar>` anahtarından gelir. */
export const VERDICT_TONE: Record<AiTariffReview['verdict'], 'green' | 'yellow' | 'red'> = {
  ok: 'green',
  caution: 'yellow',
  reject: 'red',
};

export const optsKey = (o: ImportOptions) =>
  JSON.stringify({ c: o.convertLbToKg ? 1 : 0, cur: o.currency ?? null, ...(o.numberFormat ? { n: o.numberFormat } : {}), ...(o.discountUnit ? { d: o.discountUnit } : {}), ...(o.openBandMode ? { o: o.openBandMode } : {}) });
export const isOutlier = (r: number) => r < 0.5 || r > 2;
export const fmtRatio = (r: number) => `×${fmtNum(r, 2, r < 0.1 ? 3 : 2)}`;
export const fmtD = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : v);

function rowsText(rows: number[]): string {
  const shown = rows.slice(0, 12).join(', ');
  return rows.length > 12 ? `${shown} … (+${fmtNum(rows.length - 12)})` : shown;
}

export function IssueList({ items, className }: { items: ImportIssue[]; className?: string }) {
  const { t } = useTranslation('tariffImport');
  return (
    <ul className={`iw-issues${className ? ` ${className}` : ''}`}>
      {items.map((it, i) => (
        <li key={`${it.code}-${i}`} className={`iw-issue ${it.severity}`}>
          <Icon name={it.severity === 'error' ? 'err' : it.severity === 'warning' ? 'warn' : 'info'} />
          <div className="iw-issue-tx">
            <b>{it.title}</b>
            {it.detail && <p>{it.detail}</p>}
            {it.suggestion && (
              <p className="iw-sg">
                <span>{t('issues.suggestion')}</span> {it.suggestion}
              </p>
            )}
            {it.rows && it.rows.length > 0 && (
              <p className="iw-rows">
                {t('issues.rows', { count: it.rows.length, formatted: fmtNum(it.rows.length) })}: <span className="mono">{rowsText(it.rows)}</span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Ayrıntı bölümü: başlık satırı + sağda kısa durum; içerik kapalı başlar */
export function Detail({ title, meta, open, children }: { title: string; meta?: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details className="iw-d" open={open || undefined}>
      <summary>
        <Icon name="chev" className="tfh-chev" />
        <span className="grow">{title}</span>
        {meta && <span className="iw-d-m">{meta}</span>}
      </summary>
      <div className="iw-d-b">{children}</div>
    </details>
  );
}

/** Draft expired or belongs to someone else → server answers 404. */
export const isExpired = (e: unknown) => e instanceof ApiError && e.status === 404;

/** per-kg band label: (71, 99) → "71–99 kg"; very large upper bound → "300+ kg" */
export function bandText(lo: number, hi: number, unit = 'kg'): string {
  const a = fmtNum(lo > 0 ? Math.floor(lo) + 1 : 0, 0, 3);
  return hi >= 9999 ? `${a}+ ${unit}` : `${a}–${fmtNum(hi, 0, 3)} ${unit}`;
}
