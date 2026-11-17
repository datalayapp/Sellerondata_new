import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PRODUCT_KEYS, type HubAiUsage, type ProductKey } from '@sellerondata/contracts';
import { Link } from 'react-router';
import { ApiError, ErrorState, Icon, ProductMark, Skel, Tag, currentLocale, formatMoney, formatNumber, isProductOpen, useMe } from '@sellerondata/shell';
import { fetchAiUsage } from '../api/hub.ts';
import { asList, type OrgSubscription } from '../api/types.ts';
import { useScope } from '../lib/hooks.ts';
import { client } from '../lib/session.ts';

/** "6 dk 12 sn" / "45 sn" / "1 sa 5 dk". Birim adları sözlükten gelir. */
export function formatDuration(ms: number, unit: { hour: string; minute: string; second: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${unit.hour}`);
  if (m || h) parts.push(`${m} ${unit.minute}`);
  if (!h && (s || !m)) parts.push(`${s} ${unit.second}`);
  return parts.join(' ');
}

/** 'YYYY-MM' ayının ilk günü, UTC (saat dilimi kayması ay adını bozmasın). `offset` ay kaydırır. */
const monthStart = (period: string, offset = 0) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + offset, 1));
};

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' };
const isAbsent = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);

function Card({ product }: { product: ProductKey }) {
  const locale = currentLocale();
  const scope = useScope();
  const q = useQuery({
    queryKey: [...scope, 'ai-usage', product],
    queryFn: () => fetchAiUsage(product),
    // Yetki yok ya da uç yok: yeniden denemenin anlamı yok.
    retry: (n, err) => !isAbsent(err) && n < 2,
  });
  if (q.isPending) {
    return (
      <section className="d9-sec" aria-busy="true">
        <Skel h={28} w={260} />
        <div style={{ marginTop: 16 }}>
          <Skel h={72} />
        </div>
      </section>
    );
  }
  if (q.isError) {
    if (isAbsent(q.error)) return null;
    return (
      <section className="d9-sec">
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </section>
    );
  }
  return <CardBody product={product} u={q.data} locale={locale} />;
}

function CardBody({ product, u, locale }: { product: ProductKey; u: HubAiUsage; locale: string }) {
  const { t } = useTranslation();
  const unit = { hour: t('aiUsage.unit.hour'), minute: t('aiUsage.unit.minute'), second: t('aiUsage.unit.second') };
  const money = (v: number) => formatMoney(v, u.currency, locale);
  // Fiyat izni olmayan kişiye `*Amount` alanları gelmez: tutar satırları gizlenir.
  const showMoney = typeof u.allowanceAmount === 'number' && typeof u.usedAmount === 'number';
  const tag = locale === 'en' ? 'en-GB' : 'tr-TR';
  const month = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthStart(u.period));
  const resetDay = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(monthStart(u.period, 1));
  const pct = Math.min(100, Math.max(0, u.usedPct));
  const fill = u.exhausted ? 'var(--danger)' : pct >= 80 ? 'var(--warning)' : 'var(--primary)';
  const compact = (n: number) => formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1 });
  const titleId = `hub-ai-${product}`;
  const th: CSSProperties = { padding: 8 };
  return (
    <section className="d9-sec" aria-labelledby={titleId}>
      <div className="d9-sec-h">
        <h2 id={titleId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProductMark product={product} size={28} />
          <span>{t('aiUsage.title')}</span>
        </h2>
        <span>{t('aiUsage.period', { month })}</span>
      </div>

      <div style={{ paddingTop: 16 }}>
        <div style={{ ...ROW, justifyContent: 'space-between' }}>
          <span style={ROW}>
            {showMoney && <b>{t('aiUsage.used', { used: money(u.usedAmount), allowance: money(u.allowanceAmount) })}</b>}
            {u.exhausted && <Tag tone="red">{t('aiUsage.exhausted')}</Tag>}
            {!u.enforced && <Tag tone="gray">{t('aiUsage.notEnforced')}</Tag>}
          </span>
          {showMoney && <span>{t('aiUsage.remaining', { amount: money(u.remainingAmount) })}</span>}
        </div>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('aiUsage.title')} style={{ height: 10, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', marginTop: 10 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: fill }} />
        </div>
      </div>

      <dl className="d9-kv" style={{ marginTop: 8 }}>
        <div className="d9-kv-row" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <dd style={{ margin: 0 }}>
            {[t('aiUsage.tokens', { count: compact(u.tokens.total) }), t('aiUsage.calls', { count: formatNumber(u.calls, locale) }), t('aiUsage.duration', { time: formatDuration(u.durationMs, unit) })].join(' · ')}
            {u.cachedCalls > 0 && <small style={{ display: 'block', fontWeight: 400 }}>{t('aiUsage.cached', { count: formatNumber(u.cachedCalls, locale) })}</small>}
            {(u.estimatedCalls ?? 0) > 0 && <small style={{ display: 'block', fontWeight: 400 }}>{t('aiUsage.estimated', { count: formatNumber(u.estimatedCalls ?? 0, locale) })}</small>}
          </dd>
        </div>
      </dl>

      <p className="d9-note" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
        <span>{t('aiUsage.resets', { date: resetDay })}</span>
        {u.exhausted && <span>{t('aiUsage.exhaustedNote')}</span>}
        {showMoney && u.creditAmount > 0 && <span>{t('aiUsage.credit', { amount: money(u.creditAmount) })}</span>}
        {showMoney && <span>{t('aiUsage.freeNote', { amount: money(u.freeAmount) })}</span>}
      </p>

      {u.byKind.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', fontWeight: 600 }}>{t('aiUsage.details')}</summary>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
              <thead>
                <tr style={{ textAlign: 'right', color: 'var(--text-2)' }}>
                  <th scope="col" style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>{t('aiUsage.col.kind')}</th>
                  <th scope="col" style={th}>{t('aiUsage.col.calls')}</th>
                  <th scope="col" style={th}>{t('aiUsage.col.tokens')}</th>
                  <th scope="col" style={th}>{t('aiUsage.col.duration')}</th>
                  {showMoney && <th scope="col" style={th}>{t('aiUsage.col.amount')}</th>}
                </tr>
              </thead>
              <tbody>
                {u.byKind.map((k) => (
                  <tr key={k.kind} style={{ textAlign: 'right', borderTop: '1px solid var(--border)' }}>
                    <th scope="row" style={{ ...th, textAlign: 'left', fontWeight: 500, paddingLeft: 0 }}>{k.label}</th>
                    <td style={th}>{formatNumber(k.calls, locale)}</td>
                    <td style={th}>{compact(k.tokens)}</td>
                    <td style={th}>{formatDuration(k.durationMs, unit)}</td>
                    {showMoney && <td style={th}>{typeof k.amount === 'number' ? money(k.amount) : ''}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Kişiye göre: sunucu token sırasıyla verir (tutar sırası değil); eski sunucuda alan yok */}
            {(u.byMember?.length ?? 0) > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420, marginTop: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'right', color: 'var(--text-2)' }}>
                    <th scope="col" style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>{t('aiUsage.col.member')}</th>
                    <th scope="col" style={th}>{t('aiUsage.col.calls')}</th>
                    <th scope="col" style={th}>{t('aiUsage.col.tokens')}</th>
                    {showMoney && <th scope="col" style={th}>{t('aiUsage.col.amount')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {u.byMember!.map((m) => (
                    <tr key={m.memberId ?? ''} style={{ textAlign: 'right', borderTop: '1px solid var(--border)' }}>
                      <th scope="row" style={{ ...th, textAlign: 'left', fontWeight: 500, paddingLeft: 0, overflowWrap: 'anywhere' }}>{m.name}</th>
                      <td style={th}>{formatNumber(m.calls, locale)}</td>
                      <td style={th}>{compact(m.tokens)}</td>
                      {showMoney && <td style={th}>{typeof m.amount === 'number' ? money(m.amount) : ''}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      )}

      {/* Ayrıntılı döküm: aynı ay, tek tek işlemler (Abonelik → Yapay zekâ kullanımı). */}
      <p style={{ margin: '8px 0 0' }}>
        <Link className="aiu-card-link" to={`/account/billing/ai/${product}?period=${encodeURIComponent(u.period)}`}>
          {t('aiUsage.page.detailsLink')}
          <Icon name="arrow" size={16} />
        </Link>
      </p>
    </section>
  );
}

/** Aboneliği etkin ve kullanılabilir her ürün için bir kart (abonelik listesi `Billing` ile aynı sorgu anahtarı: önbellekten gelir). */
export function AiUsageSection() {
  const scope = useScope();
  const { me } = useMe();
  const subs = useQuery({ queryKey: [...scope, 'subscriptions'], queryFn: async () => asList<OrgSubscription>(await client.get('/api/account/org/subscriptions')) });
  const products = PRODUCT_KEYS.filter((k) => isProductOpen(me, k) && subs.data?.some((s) => s.product === k && s.status === 'ACTIVE'));
  return (
    <>
      {products.map((p) => (
        <Card key={p} product={p} />
      ))}
    </>
  );
}
