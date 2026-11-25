import { useTranslation } from 'react-i18next';
import type { HubAiCall } from '@sellerondata/contracts';
import { ActionMenu, Button, SlideOver, Tag, formatDate, formatMoney, formatNumber, type Tone } from '@sellerondata/shell';
import { formatDuration } from '../../components/AiUsageCard.tsx';
import { SmartLink } from '../../components/values.tsx';

/*
 * Yapay zekâ kullanımı sayfasının parçaları: ay seçici, sonuç rozeti, tek işlemin ayrıntı paneli.
 * Dönem 'YYYY-MM' takvim ayıdır (firmanın saat dilimi); ay adları UTC'de yazılır ki saat dilimi ayı kaydırmasın.
 */

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const tagOf = (locale: string) => (locale === 'en' ? 'en-GB' : 'tr-TR');
const monthDate = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
};

/** 'YYYY-MM' ayını `n` ay kaydırır. */
export function addMonths(period: string, n: number): string {
  const d = monthDate(period);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
}

/** "Kasım 2026" / "November 2026". */
export function monthLabel(period: string, locale: string): string {
  return new Intl.DateTimeFormat(tagOf(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate(period));
}

/** İki takvim günü ('YYYY-MM-DD') arası, ay adıyla: "1–13 Kasım" / "1–13 November". */
export function dayRangeLabel(from: string, to: string, locale: string): string {
  const f = new Intl.DateTimeFormat(tagOf(locale), { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  return from >= to ? f.format(a) : f.formatRange(a, b);
}

export type MonthOption = { period: string; calls?: number };

/**
 * "‹ Kasım 2026 ›": oklar önceki ve sonraki aya geçer (sınırda kapalı), ayın adı seçilebilir ayların listesini açar
 * (yeniden eskiye). Liste kabuğun `ActionMenu`'sü: ekrandan taşmaz, ↑/↓ gezinir, Esc kapatıp odağı düğmeye döndürür.
 * Düğmenin genişliği sabit (CSS `.aiu-month-menu`): ay adı ve ay sayısı yeri değiştirmez.
 */
export function MonthPicker({ value, months, onChange }: { value: string; months: MonthOption[]; onChange: (period: string) => void }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const idx = months.findIndex((m) => m.period === value);
  const newer = idx > 0 ? months[idx - 1] : undefined;
  const older = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : undefined;
  const items = months.map((m) => {
    const hints = [m.period === value ? t('aiUsage.page.monthSelected') : '', m.calls === 0 ? t('aiUsage.page.monthEmpty') : ''].filter(Boolean);
    return { label: monthLabel(m.period, lng), hint: hints.length ? hints.join(' · ') : undefined, onSelect: () => m.period !== value && onChange(m.period) };
  });
  return (
    <div className="aiu-month" role="group" aria-label={t('aiUsage.page.month')}>
      <Button
        kind="secondary"
        icon="chevl"
        aria-label={t('aiUsage.page.prevMonth')}
        title={older ? monthLabel(older.period, lng) : undefined}
        disabled={!older}
        onClick={() => older && onChange(older.period)}
      />
      <ActionMenu className="aiu-month-menu" label={monthLabel(value, lng)} items={items} />
      <Button
        kind="secondary"
        icon="chevr"
        aria-label={t('aiUsage.page.nextMonth')}
        title={newer ? monthLabel(newer.period, lng) : undefined}
        disabled={!newer}
        onClick={() => newer && onChange(newer.period)}
      />
    </div>
  );
}

const STATUS_TONE: Record<HubAiCall['status'], Tone> = { ok: 'green', refused: 'red', truncated: 'yellow', failed: 'red' };

/** Sonuç rozeti: Başarılı / Okunamadı / Yarıda kaldı / Başarısız; çıkan token tahminiyse "· tahmini". */
export function StatusTag({ call }: { call: Pick<HubAiCall, 'status' | 'estimated'> }) {
  const { t } = useTranslation();
  const text = t(`aiUsage.page.status.${call.status}`);
  return (
    <Tag tone={STATUS_TONE[call.status]} small>
      {call.estimated ? `${text} · ${t('aiUsage.page.status.estimated')}` : text}
    </Tag>
  );
}

/** Kayda bağlantı (araçtaki sayfa). Satır tıklamasını tetiklemez. */
export function RecordLink({ call }: { call: Pick<HubAiCall, 'record' | 'href'> }) {
  if (!call.record) return <span className="aiu-muted">—</span>;
  if (!call.href) return <span>{call.record}</span>;
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <SmartLink href={call.href} className="aiu-rec">
        {call.record}
      </SmartLink>
    </span>
  );
}

/** Tek işlemin ayrıntısı: sağdan açılan panel. Para ve fiyat satırları yalnız yanıtta varsa (fiyat izni). */
export function CallDrawer({ call, currency, onClose }: { call: HubAiCall; currency: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const unit = { hour: t('aiUsage.unit.hour'), minute: t('aiUsage.unit.minute'), second: t('aiUsage.unit.second') };
  const num = (n: number) => formatNumber(n, lng);
  const when = formatDate(call.at, lng, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const hasMoney = typeof call.amount === 'number';
  const priceText =
    typeof call.priceVersion === 'string'
      ? [
          call.priceVersion,
          typeof call.priceUsdRate === 'number'
            ? t('aiUsage.page.drawer.rate', { rate: formatNumber(call.priceUsdRate, lng, { maximumFractionDigits: 2 }) })
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const kv = (label: string, value: string) => (
    <div key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <SlideOver
      title={call.label}
      description={
        <span className="aiu-drawer-sub">
          {when} · {call.person}
          {call.record && (
            <>
              {' · '}
              {call.href ? <SmartLink href={call.href}>{call.record}</SmartLink> : call.record}
            </>
          )}
        </span>
      }
      onClose={onClose}
    >
      <div className="aiu-drawer">
        <div>
          <StatusTag call={call} />
        </div>
        <dl className="aiu-kv">
          {kv(t('aiUsage.page.drawer.input'), num(call.tokens.input))}
          {kv(t('aiUsage.page.drawer.output'), num(call.tokens.output))}
          {kv(t('aiUsage.page.drawer.cacheRead'), num(call.tokens.cacheRead))}
          {kv(t('aiUsage.page.drawer.cacheWrite'), num(call.tokens.cacheWrite))}
          {kv(t('aiUsage.page.drawer.total'), num(call.tokens.total))}
          {kv(t('aiUsage.page.drawer.duration'), formatDuration(call.durationMs, unit))}
        </dl>
        <hr className="aiu-hr" />
        <dl className="aiu-kv">
          {kv(t('aiUsage.page.drawer.model'), call.model)}
          {kv(t('aiUsage.page.drawer.servedModel'), call.servedModel ?? t('aiUsage.page.drawer.noResponse'))}
          {call.errorCode && kv(t('aiUsage.page.drawer.errorCode'), call.errorCode)}
          {priceText && kv(t('aiUsage.page.drawer.price'), priceText)}
        </dl>
        {hasMoney && (
          <>
            <hr className="aiu-hr" />
            <p className="aiu-drawer-total">
              <span>{t('aiUsage.page.drawer.cost')}</span>
              <b>{formatMoney(call.amount, currency, lng)}</b>
            </p>
          </>
        )}
        {call.estimated && <p className="aiu-hint">{t('aiUsage.page.drawer.estimatedNote')}</p>}
        {!call.deducted && <p className="aiu-hint">{t('aiUsage.page.drawer.notDeductedNote')}</p>}
      </div>
    </SlideOver>
  );
}
