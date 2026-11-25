import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueries, useQuery } from '@tanstack/react-query';
import { PLAN_EARLY_ACCESS, PRODUCTS, PRODUCT_KEYS, isCompanyConfirmed, type HubAlert, type HubKpi, type HubLeader, type HubOverview, type MeResponse, type ProductKey } from '@sellerondata/contracts';
import { ApiError, Empty, ErrorState, Icon, PageHeader, ProductMark, Skel, formatDateRange, formatHubValue, formatPercent, formatRelative, currentLocale, isProductOpen, productHref, useMe } from '@sellerondata/shell';
import { fetchOverview } from '../api/hub.ts';
import { asList, type OrgInvitation, type OrgMember } from '../api/types.ts';
import { PeriodControl } from '../components/Controls.tsx';
import { ToolPicker } from '../components/ToolPicker.tsx';
import { SplitBar, TimeSeriesChart } from '../components/charts.tsx';
import { DeltaBadge, SmartLink, ToolLabel, useKpiDelta } from '../components/values.tsx';
import { canAnalytics, isOrgAdmin, isSetupOpen, isSimpleHub, meProduct, overviewProducts, roleLabelOf } from '../lib/access.ts';
import { setupLayout } from '../lib/setupLayout.ts';
import { daysUntil, usePeriod, type RangeKey } from '../lib/period.ts';
import { useScope } from '../lib/hooks.ts';
import { client } from '../lib/session.ts';

const QUEUE_PREVIEW = 4;
const TONE_RANK: Record<HubAlert['tone'], number> = { bad: 0, warning: 1, info: 2, neutral: 3, good: 4 };

type QueueItem = HubAlert & { product: ProductKey };

/** Önce önem, sonra en yakın son gün, sonra tutar. Farklı para birimleri birbirine karşı sıralanmaz. */
function sortQueue(items: QueueItem[]): QueueItem[] {
  return items
    .map((a, i) => [a, i] as const)
    .sort(([x, xi], [y, yi]) => {
      // Son günü bugün olan her şeyin üstünde.
      const today = Number(!!y.dueAt && daysUntil(y.dueAt) === 0) - Number(!!x.dueAt && daysUntil(x.dueAt) === 0);
      if (today) return today;
      const tone = TONE_RANK[x.tone] - TONE_RANK[y.tone];
      if (tone) return tone;
      if (x.dueAt && y.dueAt && x.dueAt !== y.dueAt) return x.dueAt.localeCompare(y.dueAt);
      if (!!x.dueAt !== !!y.dueAt) return x.dueAt ? -1 : 1;
      const xa = x.amount;
      const ya = y.amount;
      if (xa && ya && xa.currency === ya.currency && typeof xa.value === 'number' && typeof ya.value === 'number' && xa.value !== ya.value) return ya.value - xa.value;
      return xi - yi;
    })
    .map(([a]) => a);
}

/** Baş rakamlar: katalogdaki kimlikler, sonra ürünün önem sırası. En çok üç. */
function pickHeadline(product: ProductKey, kpis: HubKpi[]): HubKpi[] {
  const main = kpis.filter((k) => !k.id.includes(':'));
  const wanted = PRODUCTS[product].hub?.headline ?? [];
  const picked = wanted.flatMap((id) => main.filter((k) => k.id === id));
  for (const k of main) {
    if (picked.length >= 3) break;
    if (!picked.includes(k)) picked.push(k);
  }
  return picked.slice(0, 3);
}

/** Aracı aç: web izni varsa araca, yoksa nedenini söyleyen sayfaya; web'i olmayan araçta Merkez'de o araca süzülmüş Genel Bakış (kural kabukta: `productHref`). */
const toolHref = (me: MeResponse, key: ProductKey) => productHref(me, key);

/** Bantta ikincil düğme: aracın yönetim paneli (Mesaj 15: birincil eylem değil, dışarı götürür). Seçili ya da tek araçta "Yönetim panelini aç"; birden çok araç görünürken araç adı yazılır. */
function OpenToolButton({ me, product, named }: { me: MeResponse; product: ProductKey; named: boolean }) {
  const { t } = useTranslation();
  return (
    <SmartLink href={toolHref(me, product)} className="btn btn-secondary">
      {named ? t('home.openAdminName', { name: PRODUCTS[product].name }) : t('home.openAdmin')}
      <Icon name="arrow" />
    </SmartLink>
  );
}

function periodWord(range: RangeKey, from: string, to: string, t: (k: string) => string, lng: string) {
  return range === 'custom' ? formatDateRange(from, to, lng) : t(`period.last.${range}`).toLocaleLowerCase(lng);
}

export function Home() {
  const { me } = useMe();
  if (me && !me.activeOrg) return <NoOrg />;
  if (isSimpleHub(me)) return <SimpleHome me={me!} />;
  return <ControlRoom me={me!} />;
}

function NoOrg() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader hero title={t('nav.home')} />
      <div className="hub-page hub-wrap">
        <section className="hub-panel lift">
          <Empty icon="building" title={t('home.noOrg.title')}>
            {t('home.noOrg.body')}
          </Empty>
        </section>
      </div>
    </>
  );
}

/** Ana ekran (GB-D09): bantta durum ve dönem, üstte baş rakamlar, sonra Bekleyenler, en altta kaçış ve araçlar. */
function ControlRoom({ me }: { me: MeResponse }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const scope = useScope();
  const { range, from, to, setRange } = usePeriod();
  const allProducts = overviewProducts(me);
  // Seçili araç adreste: ?tool=deciship. "Tümü" yok: seçim yoksa, izni olmayan ya da bilinmeyen değerde ilk açık araç.
  const [params] = useSearchParams();
  const toolParam = params.get('tool');
  const picked = allProducts.find((p) => p.key === toolParam)?.key ?? allProducts[0]?.key ?? null;
  // Başlangıç kararı görünen bütün araçların kurulumuna bakar: her görünen aracın overview'ı alınır (aynı anahtar, seçili araçla paylaşılır).
  const allResults = useQueries({
    queries: allProducts.map((p) => ({
      queryKey: [...scope, 'overview', p.key, from, to],
      queryFn: () => fetchOverview(p.key, from, to),
      placeholderData: (prev: HubOverview | undefined) => prev,
    })),
  });
  const products = allProducts.filter((p) => p.key === picked);
  const results = products.map((p) => allResults[allProducts.indexOf(p)]!);

  const queue = useMemo(() => {
    const items: QueueItem[] = [];
    results.forEach((r, i) => {
      for (const a of r.data?.alerts ?? []) items.push({ ...a, product: products[i]!.key });
    });
    return sortQueue(items);
    // sonuçlar her çizimde yeni dizi; veri değişimi yeterli
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join()]);

  const loading = results.some((r) => r.isPending);
  const failed = results.filter((r) => r.isError).length;
  // İlk gün: boş rakam ve "bekleyen iş yok" yerine başlangıç sayfası (Merkez kurulumu + araç kurulumları); kural `setupLayout`.
  const layout = setupLayout({
    admin: isOrgAdmin(me),
    companyConfirmed: isCompanyConfirmed(me.activeOrg),
    tools: allProducts.map((p, i) => ({ key: p.key, setupOpen: isSetupOpen(allResults[i]!.data), pending: allResults[i]!.isPending })),
  });
  if (layout.view === 'start') return <StartPage me={me} tools={allProducts.map((p, i) => ({ key: p.key, result: allResults[i]! }))} />;
  if (layout.view === 'loading') return <HomeLoading />;

  const status = loading ? null : failed ? t('home.statusFailed') : queue.length === 0 ? t('home.statusClear') : t('home.status', { count: queue.length });
  const leaders = results.flatMap((r, i) => (r.data?.leaders?.length ? [{ product: products[i]!.key, items: r.data.leaders }] : []));
  const single = products.length <= 1;
  const hrefFor = (key: ProductKey | null) => {
    const next = new URLSearchParams(params);
    if (key) next.set('tool', key);
    else next.delete('tool');
    const qs = next.toString();
    return qs ? `?${qs}` : '/home';
  };
  const period = periodWord(range, from, to, t, lng);

  return (
    <>
      <PageHeader
        hero
        title={t('nav.home')}
        sub={
          <>
            {status ?? <Skel w={220} h={14} />}
            <ToolPicker onBand withAll={false} allowed={allProducts.map((p) => p.key)} current={picked} hrefFor={hrefFor} />
          </>
        }
        actions={
          <>
            <PeriodControl range={range} from={from} to={to} onChange={setRange} />
            {products[0] && <OpenToolButton me={me} product={products[0].key} named={!single} />}
          </>
        }
      />
      <div className="hub-page hub-wrap">
        {products.length === 0 && <NoToolYet me={me} />}
        {products.map((p, i) => (
          <Headline key={p.key} product={p.key} result={results[i]!} me={me} period={period} lift={i === 0} single={single} />
        ))}

        <AttentionQueue items={queue} single={single} loading={loading} failed={results.flatMap((r, i) => (r.isError ? [PRODUCTS[products[i]!.key].name] : []))} />

        <div className="hub-cols">
          {loading ? <LeadersSkeleton /> : leaders.length > 0 ? <Leaders groups={leaders} single={single} /> : null}
          <ToolsList me={me} />
        </div>

        {products.map((p, i) => (
          <ToolDetail key={p.key} product={p.key} data={results[i]!.data} busy={results[i]!.isPlaceholderData} single={single} />
        ))}
      </div>
    </>
  );
}

function NoToolYet({ me }: { me: MeResponse }) {
  const { t } = useTranslation();
  return (
    <section className="hub-panel lift">
      <Empty
        icon="users"
        title={t('home.noTool.title')}
        actions={
          isOrgAdmin(me) ? (
            <Link className="btn btn-primary" to="/account/team">
              {t('home.noTool.action')}
            </Link>
          ) : undefined
        }
      >
        {t('home.noTool.body')}
      </Empty>
    </section>
  );
}

type OverviewResult = { data?: HubOverview; error: unknown; isPending: boolean; isError: boolean; isPlaceholderData: boolean; refetch: () => unknown };

/** Baş rakamlar (GB-D09 `.kpis`): bandın altına binen beyaz pano. Her rakam araçtaki listesine gider. */
function Headline({ product, result, me, period, lift, single }: { product: ProductKey; result: OverviewResult; me: MeResponse; period: string; lift: boolean; single: boolean }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const def = PRODUCTS[product];
  const delta = useKpiDelta();
  const mp = meProduct(me, product);
  const { data, isPending, isError, error, refetch, isPlaceholderData } = result;

  if (isError && error instanceof ApiError && error.status === 403) return null;

  const headId = `hub-kpi-${product}`;
  const head = (
    <div className="hub-lift-h">
      <h2 id={headId}>
        <ProductMark product={product} size={20} />
        <span>
          <b>{def.name}</b> · {period}
        </span>
        {/* Deneme turu (Y122): sayılar araçtaki örnek veriden; not başlığın yanında, ekran okuyucu da başlıkla okur. */}
        {data?.sample && <span className="tag hub-tag is-info">{t('home.sampleData')}</span>}
      </h2>
      {!single && (
        <SmartLink href={toolHref(me, product)} className="hub-arrow-link">
          {t('home.openAdmin')}
        </SmartLink>
      )}
      {mp && canAnalytics(mp) && (
        <Link to={`/analytics/${product}`} className="hub-arrow-link">
          {t('home.toAnalytics')}
          <Icon name="arrow" size={14} />
        </Link>
      )}
    </div>
  );
  const cls = `hub-panel hub-report${lift ? ' lift' : ''}`;

  if (isPending) {
    return (
      <section className={cls} aria-labelledby={headId} aria-busy="true">
        {head}
        <div className="hub-figures">
          {[0, 1, 2].map((i) => (
            <div className={`hub-figure${i === 0 ? ' is-lead' : ''}`} key={i}>
              <div className="hub-figure-link is-static">
                <Skel w={150} h={12} />
                <Skel w={160} h={40} />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (isError) {
    return (
      <section className={cls} aria-labelledby={headId}>
        {head}
        <div className="hub-report-error">
          <ErrorState error={error} onRetry={() => refetch()} title={t('home.sectionError', { name: def.name })} />
        </div>
      </section>
    );
  }
  if (!data) return null;

  const figures = pickHeadline(product, data.kpis);
  const lead = figures[0];
  const siblings = lead ? data.kpis.filter((k) => k.id.startsWith(`${lead.id}:`)) : [];

  if (!lead || lead.value === null) {
    return (
      <section className={cls} aria-labelledby={headId}>
        {head}
        <div className="hub-report-empty">
          <Empty compact icon="chart" title={t('home.noData.title')}>
            {t('home.noData.body')}
          </Empty>
        </div>
      </section>
    );
  }

  return (
    <section className={`${cls}${isPlaceholderData ? ' is-busy' : ''}`} aria-labelledby={headId}>
      {head}
      <div className="hub-figures">
        {figures.map((k, i) => {
          const content = (
            <>
              <span className="hub-lead-label">{k.label}</span>
              <span className={`${i === 0 ? 'hub-hero' : 'hub-figure-value'}${k.tone === 'bad' ? ' is-bad' : ''}`}>{formatHubValue(k, lng)}</span>
              <span className="hub-lead-delta">
                {typeof k.previous === 'number' && <span className="hub-lead-prev">{t('home.previous', { value: formatHubValue({ value: k.previous, format: k.format, currency: k.currency }, lng) })}</span>}
                <DeltaBadge delta={delta(k)} />
              </span>
            </>
          );
          return (
            <div key={k.id} className={`hub-figure${i === 0 ? ' is-lead' : ''}`} title={k.hint}>
              {k.href ? (
                <SmartLink href={k.href} className="hub-figure-link">
                  {content}
                </SmartLink>
              ) : (
                <div className="hub-figure-link is-static">{content}</div>
              )}
              {i === 0 && siblings.length > 0 && (
                <ul className="hub-siblings">
                  {siblings.map((s) => (
                    <li key={s.id} title={s.hint}>
                      <SmartLink href={s.href ?? ''} className="row">
                        <span className="who">{s.label}</span>
                        <b>{formatHubValue(s, lng)}</b>
                        <DeltaBadge delta={delta(s)} />
                      </SmartLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Sayfanın altı: seyir, para nereye gitti, kalan sayılar. */
function ToolDetail({ product, data, busy, single }: { product: ProductKey; data?: HubOverview; busy: boolean; single: boolean }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const delta = useKpiDelta();
  if (!data) return null;
  const figures = pickHeadline(product, data.kpis);
  const lead = figures[0];
  if (!lead || lead.value === null) return null;
  const rest = data.kpis.filter((k) => !figures.includes(k) && !k.id.startsWith(`${lead.id}:`));
  if (!lead.trend?.length && !data.split && !rest.length) return null;
  const titleId = `hub-detail-${product}`;
  return (
    <section className={`hub-sec${busy ? ' is-busy' : ''}`} aria-labelledby={titleId}>
      <div className="hub-sec-h">
        {/* Seyir başlığı bölüm adıdır; grafiğin üstünde tekrar yazılmaz. */}
        <h2 id={titleId}>{lead.trend?.length ? t('home.detail.trend', { name: lead.label }) : t('home.detail.title')}</h2>
        {!single && <ToolLabel product={product} />}
      </div>
      <div className="hub-panel hub-report hub-report-grid">
        <div className="hub-lead">
          {lead.trend && lead.trend.length > 0 && (
            <>
              <TimeSeriesChart series={lead.trend} chart="line" format={lead.format} currency={lead.currency} height={176} label={lead.label} />
            </>
          )}
          {data.split && (
            <div className="hub-report-split">
              <div className="hub-split-title">
                <span>{data.split.title}</span>
                <b>{formatHubValue(data.split.total, lng)}</b>
              </div>
              <SplitBar split={data.split} />
            </div>
          )}
        </div>
        <div className="hub-ledger">
          {rest.map((k) => {
            const body = (
              <>
                <span className="hub-ledger-label" title={k.hint}>
                  {k.label}
                </span>
                <span className={`hub-ledger-value${k.tone === 'bad' ? ' is-bad' : ''}`}>{formatHubValue(k, lng)}</span>
                <span className="hub-ledger-delta">
                  <DeltaBadge delta={delta(k)} />
                </span>
              </>
            );
            return k.href ? (
              <SmartLink key={k.id} href={k.href} className="hub-ledger-row is-link">
                {body}
              </SmartLink>
            ) : (
              <div key={k.id} className="hub-ledger-row">
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Bölüm başlığı (GB-D09 `.sec-h`): başlık solda, kısa not ya da bağlantı sağda. */
function SecHead({ id, title, children }: { id: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="hub-sec-h">
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  );
}

function LeadersSkeleton() {
  return (
    <section className="hub-sec hub-topleak" aria-busy="true">
      <div className="hub-sec-h">
        <Skel w={220} h={20} />
      </div>
      <div className="hub-skel-stack">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skel key={i} h={18} />
        ))}
      </div>
    </section>
  );
}

/** En çok kaçıran (GB-D09 `.lead`): `label` başına ilk üç kalem. Çubuk, kalemin toplam içindeki payıdır. */
function Leaders({ groups, single }: { groups: { product: ProductKey; items: HubLeader[] }[]; single: boolean }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  return (
    <section className="hub-sec hub-topleak" aria-labelledby="hub-topleak-title">
      <SecHead id="hub-topleak-title" title={t('home.leaders.title')} />
      {groups.map((g) => {
        const labels = [...new Set(g.items.map((l) => l.label))];
        return (
          <div key={g.product} className="hub-topleak-tool">
            {!single && <ToolLabel product={g.product} />}
            {labels.map((label) => (
              <div key={label} className="hub-topleak-group">
                <h3>{label}</h3>
                <ol>
                  {g.items
                    .filter((l) => l.label === label)
                    .slice(0, 3)
                    .map((l) => {
                      const share = l.share !== undefined ? formatPercent(l.share, lng, 0) : undefined;
                      const body = (
                        <>
                          <span className="name">{l.name}</span>
                          <span className="bar" aria-hidden="true" title={share}>
                            {l.share !== undefined && <i style={{ width: `${Math.max(1, Math.min(100, l.share))}%` }} />}
                          </span>
                          <span className="amt">
                            {formatHubValue(l.value, lng)}
                            {share && <span className="sr-only"> ({t('home.leaders.share', { share })})</span>}
                          </span>
                        </>
                      );
                      return <li key={l.id}>{l.href ? <SmartLink href={l.href} className="row is-link">{body}</SmartLink> : <div className="row">{body}</div>}</li>;
                    })}
                </ol>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function DueBadge({ dueAt }: { dueAt: string }) {
  const { t } = useTranslation();
  const days = daysUntil(dueAt);
  const text = days < 0 ? t('home.queue.overdue') : days === 0 ? t('home.queue.dueToday') : t('home.queue.dueIn', { count: days });
  return <span className={`tag hub-tag${days <= 5 ? ' is-warn' : ''}`}>{text}</span>;
}

/** Bekleyenler (GB-D09 `.q`): en ciddisi ve son günü en yakını üstte. Satır araca gider; karar orada verilir. */
function AttentionQueue({ items, single, loading, failed }: { items: QueueItem[]; single: boolean; loading: boolean; failed: string[] }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, QUEUE_PREVIEW);
  return (
    <section className="hub-sec hub-queue" aria-labelledby="hub-queue-title">
      <SecHead id="hub-queue-title" title={t('home.queue.title')}>
        {!loading && items.length > 0 && <p>{t('home.queue.byToday')}</p>}
      </SecHead>
      {loading ? (
        <div className="hub-queue-list">
          {[0, 1, 2, 3].map((i) => (
            <div className="hub-queue-row" key={i}>
              <span className="hub-queue-main">
                <Skel w="60%" />
                <Skel w="80%" h={10} />
              </span>
              <Skel w={72} />
            </div>
          ))}
        </div>
      ) : items.length === 0 && failed.length > 0 ? (
        // Veri gelmediyse "bekleyen yok" denemez: bilinmiyor.
        <p className="hub-sheet-note flush hub-queue-note">
          <Icon name="warn" size={14} /> {t('home.queue.unknown', { names: failed.join(', ') })}
        </p>
      ) : items.length === 0 ? (
        <Empty compact good icon="check" title={t('home.queue.emptyTitle')}>
          {t('home.queue.emptyBody')}
        </Empty>
      ) : (
        <>
          <ul className="hub-queue-list">
            {shown.map((a) => {
              const body = (
                <>
                  <span className="hub-queue-main">
                    <b>{a.title}</b>
                    {a.body && <span>{a.body}</span>}
                    {(!single || (a.at && !a.dueAt)) && (
                      <span className="hub-queue-meta">
                        {!single && <ToolLabel product={a.product} />}
                        {a.at && !a.dueAt && <time dateTime={a.at}>{formatRelative(a.at, lng)}</time>}
                      </span>
                    )}
                  </span>
                  <span className="hub-queue-side">
                    {a.amount && <span className={`hub-queue-amount${a.tone === 'bad' ? ' is-bad' : ''}`}>{formatHubValue(a.amount, lng)}</span>}
                    {a.dueAt && <DueBadge dueAt={a.dueAt} />}
                  </span>
                  {a.href && (
                    <span className="hub-queue-action">
                      <span className="hub-queue-action-text">{a.actionLabel ?? t('home.queue.open')}</span>
                      <Icon name="arrow" size={14} />
                    </span>
                  )}
                </>
              );
              return (
                <li key={`${a.product}-${a.id}`}>
                  {a.href ? (
                    <SmartLink href={a.href} className={`hub-queue-row is-link tone-${a.tone}`}>
                      {body}
                    </SmartLink>
                  ) : (
                    <div className={`hub-queue-row tone-${a.tone}`}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {items.length > QUEUE_PREVIEW && (
            <div className="hub-table-more">
              <button type="button" className="link-btn" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                {all ? t('widget.showLess') : t('widget.showAll', { count: items.length })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Yükleniyor: başlangıç kararı araçların overview'ına bağlıyken nötr iskelet; normal sayfa bir an görünüp kaybolmaz. */
function HomeLoading() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader hero title={t('nav.home')} sub={<Skel w={220} h={14} />} />
      <div className="hub-page hub-wrap">
        <section className="hub-panel lift" aria-busy="true">
          <div className="hub-skel-stack pad">
            <Skel w={200} h={20} />
            <Skel h={14} />
            <Skel h={14} />
          </div>
        </section>
      </div>
    </>
  );
}

type StartStep = { id: string; label: string; hint?: string; done: boolean; href: string };

/** İlerleme çubuğu: sayaç yalnız zorunlu adımları sayar (baştan tamam gelen isteğe bağlı adım sahte ilerleme göstermesin). */
function StartBar({ done, total, color }: { done: number; total: number; color?: string }) {
  const { t } = useTranslation();
  return (
    <span className="hub-start-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('home.start.progressLabel', { done, total })}>
      <i style={{ width: `${total ? (done / total) * 100 : 0}%`, ...(color ? { background: color } : {}) }} />
    </span>
  );
}

/** Başlangıç satırı: işaret, ad ve kısa açıklama, git düğmesi. Birincil düğme yalnız sayfanın sıradaki adımında. */
function StartRow({ step, n, next, primary }: { step: StartStep; n: number; next: boolean; primary: boolean }) {
  const { t } = useTranslation();
  return (
    <li className={step.done ? 'is-done' : next ? 'is-next' : undefined}>
      <span className="mark" aria-hidden="true">
        {step.done ? <Icon name="check" size={14} /> : n}
      </span>
      <span className="text">
        <b>{step.label}</b>
        {step.hint && <small className="hint">{step.hint}</small>}
        {step.done && <span className="sr-only">{t('home.start.doneLabel')}</span>}
      </span>
      <SmartLink href={step.href} className={primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}>
        {step.done ? t('home.start.review') : t('home.start.go')}
      </SmartLink>
    </li>
  );
}

/**
 * İlk gün (tuval "Merkez ve Araç Kurulumu" bölüm 1): üstte Merkez kurulumu (yalnız yönetici), altında araç kurulumları.
 * Sayfanın tek birincil eylemi: Merkez'in eksik zorunlu adımı, yoksa kurulumu açık ilk araç.
 */
function StartPage({ me, tools }: { me: MeResponse; tools: { key: ProductKey; result: OverviewResult }[] }) {
  const { t } = useTranslation();
  const admin = isOrgAdmin(me);
  const confirmed = isCompanyConfirmed(me.activeOrg);
  const hubPending = admin && !confirmed;
  const primaryTool = hubPending ? null : (tools.find((x) => isSetupOpen(x.result.data))?.key ?? null);
  return (
    <>
      {/* Menü ve sekme "Genel Bakış" der: başlık da. */}
      <PageHeader hero title={t('nav.home')} sub={admin ? t('home.start.sub') : t('home.start.subTools')} />
      <div className="hub-page hub-wrap">
        {admin && <HubSetup confirmed={confirmed} />}
        <ToolSetups me={me} tools={tools} primary={primaryTool} lift={!admin} />
      </div>
    </>
  );
}

/** Merkez kurulumu: zorunlu firma onayı (Hesap `companyConfirmedAt`), isteğe bağlı ekip. Ekip adımını Merkez kendi hesaplar. */
function HubSetup({ confirmed }: { confirmed: boolean }) {
  const { t } = useTranslation();
  const scope = useScope();
  const members = useQuery({ queryKey: [...scope, 'members'], queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  const invites = useQuery({ queryKey: [...scope, 'invitations'], queryFn: async () => asList<OrgInvitation>(await client.get('/api/account/org/invitations')) });
  const teamDone = (members.data?.length ?? 0) > 1 || (invites.data?.length ?? 0) > 0;
  // Onaydan sonra Genel Bakış'a dönülür (`next`); onaylıysa sayfa yalnız düzenleme içindir.
  const company: StartStep = { id: 'company', label: t('home.start.company'), hint: t('home.start.companyHint'), done: confirmed, href: confirmed ? '/account/company' : '/account/company?next=/home' };
  const team: StartStep = { id: 'team', label: t('home.start.team'), hint: t('home.start.teamHint'), done: teamDone, href: '/account/team' };
  const done = confirmed ? 1 : 0;
  return (
    <section className="hub-panel lift hub-start" aria-labelledby="hub-start-hub">
      <div className="hub-lift-h">
        <h2 id="hub-start-hub">
          <b>{t('home.start.hubTitle')}</b>
        </h2>
        <span className="hub-start-note">{t('home.start.hubNote')}</span>
        <span className="hub-start-count" aria-label={t('home.start.progressLabel', { done, total: 1 })}>
          {done}/1
        </span>
      </div>
      <StartBar done={done} total={1} />
      <ol className="hub-start-list">
        <StartRow step={company} n={1} next={!confirmed} primary={!confirmed} />
      </ol>
      <h3 className="hub-start-group">{t('home.start.optionalGroup')}</h3>
      <ol className="hub-start-list" start={2}>
        <StartRow step={team} n={2} next={confirmed && !teamDone} primary={false} />
      </ol>
    </section>
  );
}

/** Araç kurulumları: görünen her açık araç için ilerleme ve aracın kendi sihirbazına bağlantı; yakında gelenler soluk. Adımlar aracın overview `setup`'ından. */
function ToolSetups({ me, tools, primary, lift }: { me: MeResponse; tools: { key: ProductKey; result: OverviewResult }[]; primary: ProductKey | null; lift: boolean }) {
  const { t } = useTranslation();
  const soon = PRODUCT_KEYS.filter((k) => !isProductOpen(me, k));
  return (
    <section className={`hub-panel hub-start${lift ? ' lift' : ''}`} aria-labelledby="hub-start-tools">
      <div className="hub-lift-h">
        <h2 id="hub-start-tools">
          <b>{t('home.start.toolsTitle')}</b>
        </h2>
        <span className="hub-start-note">{t('home.start.toolsNote')}</span>
      </div>
      <ul className="hub-start-tools">
        {tools.map((x) => (
          <li key={x.key}>
            <ToolSetupRow product={x.key} result={x.result} primary={x.key === primary} />
          </li>
        ))}
        {soon.map((key) => (
          <li key={key}>
            <div className="hub-tool-row is-soon">
              <ProductMark product={key} size={40} />
              <span className="hub-tool-text">
                <b>{PRODUCTS[key].name}</b>
                <small>{t('common.soon')}</small>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bir aracın kurulum kartı: "n/m adım · Sıradaki: …", çubuk ve sıradaki adıma (yoksa sihirbaza) bağlantı. Araç adı ve adımı overview'dan gelir. */
function ToolSetupRow({ product, result, primary }: { product: ProductKey; result: OverviewResult; primary: boolean }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const def = PRODUCTS[product];
  const setup = result.data?.setup;
  let line: ReactNode;
  let progress: ReactNode = null;
  let action: ReactNode = null;
  if (result.isPending) {
    line = <Skel w={180} h={12} />;
  } else if (result.isError || !result.data) {
    line = t('home.sectionError', { name: def.name });
  } else if (!setup) {
    // Kurulumu bu kişiye açık olmayan araç: adım bilinmez, aracın kısa tanımı.
    line = def.tagline[locale];
  } else {
    const steps = setup.steps?.length ? setup.steps : [{ id: 'setup', label: setup.label || t('home.start.setupFallback', { name: def.name }), done: false, href: setup.href, required: true }];
    const required = steps.filter((s) => s.required);
    const total = required.length;
    const done = required.filter((s) => s.done).length;
    const next = required.find((s) => !s.done);
    const open = isSetupOpen(result.data);
    line = !open ? t('home.start.toolDone') : next ? t('home.start.toolProgressNext', { done, total, next: next.label }) : t('home.start.toolProgress', { done, total });
    progress = <StartBar done={open ? done : total} total={total} color={def.color} />;
    action = (
      <SmartLink href={open ? (next?.href ?? setup.href) : setup.href} className={primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}>
        {open ? t('home.start.toolAction') : t('home.start.review')}
      </SmartLink>
    );
  }
  return (
    <div className="hub-tool-row">
      <ProductMark product={product} size={40} />
      <span className="hub-tool-text">
        <b>{def.name}</b>
        <small>{line}</small>
        {progress}
      </span>
      {action}
    </div>
  );
}

/** Ekip özeti (GB-D09 `.team-sum`): yalnız yönetici görür. Plan araç satırında, Abonelik menüde. */
function TeamSummary() {
  const { t } = useTranslation();
  const scope = useScope();
  const members = useQuery({ queryKey: [...scope, 'members'], queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  const invites = useQuery({ queryKey: [...scope, 'invitations'], queryFn: async () => asList<OrgInvitation>(await client.get('/api/account/org/invitations')) });
  const active = members.data?.filter((m) => m.status === 'ACTIVE').length;
  const suspended = members.data?.filter((m) => m.status === 'SUSPENDED').length ?? 0;
  // Hesap'a ulaşılamadıysa iskelet kalmaz: değer yok çizgisi. Nedeni kabuğun uyarısı söyler.
  const pending = (q: { isError: boolean }, w: number) => (q.isError ? <span title={t('common.loadFailed', { ns: 'shell' })}>—</span> : <Skel w={w} />);
  return (
    <p className="hub-team-sum">
      <span>
        {t('home.company.team')}: <b>{active === undefined ? pending(members, 48) : t('home.company.people', { count: active })}</b>
      </span>
      {suspended > 0 && (
        <span>
          {t('home.company.suspended')}: <b>{suspended}</b>
        </span>
      )}
      <Link to="/account/team?tab=invites" className="hub-team-sum-inv">
        {t('home.company.invites')}: <b>{invites.data === undefined ? pending(invites, 24) : invites.data.length}</b>
      </Link>
      <Link to="/account/team" className="hub-arrow-link">
        {t('nav.team')}
        <Icon name="arrow" size={14} />
      </Link>
    </p>
  );
}

/** Araçlar (GB-D09 `.tool`): açık olan araca gider, yakında gelenler soluk durur. Rozet planı söyler. */
function ToolsList({ me }: { me: MeResponse }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  return (
    <section className="hub-sec hub-tools" aria-labelledby="hub-tools-title">
      <SecHead id="hub-tools-title" title={t('home.tools.title')} />
      <ul>
        {PRODUCT_KEYS.map((key) => {
          const def = PRODUCTS[key];
          if (!isProductOpen(me, key)) {
            return (
              <li key={key}>
                <div className="hub-tool-row is-soon">
                  <ProductMark product={key} size={40} />
                  <span className="hub-tool-text">
                    <b>{def.name}</b>
                    <small>{def.tagline[locale]}</small>
                  </span>
                  <span className="tag hub-tag">{t('common.soon')}</span>
                </div>
              </li>
            );
          }
          const p = meProduct(me, key);
          const role = roleLabelOf(p, locale);
          const plan = p?.subscription?.plan;
          return (
            <li key={key}>
              <SmartLink href={toolHref(me, key)} className="hub-tool-row is-link">
                <ProductMark product={key} size={40} />
                <span className="hub-tool-text">
                  <b>{def.name}</b>
                  <small>{role ? t('home.tools.yourRole', { role }) : t('home.tools.noRole')}</small>
                </span>
                {plan && <span className="tag hub-tag is-info">{plan === PLAN_EARLY_ACCESS ? t('plan.earlyAccess') : plan}</span>}
              </SmartLink>
            </li>
          );
        })}
      </ul>
      {isOrgAdmin(me) && <TeamSummary />}
    </section>
  );
}

/** Ölçüm gibi web'de işi olmayan rol: sade Merkez. Yanlış ekranda aramaz, nereye gideceğini okur. */
function SimpleHome({ me }: { me: MeResponse }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const roles = me.products.filter((p) => p.role);
  const mobileRole = roles[0];
  const org = me.activeOrg!;
  return (
    <>
      {/* Menü ve sekme "Genel Bakış" der: başlık da aynısını söyler, selamlama alt satırda. */}
      <PageHeader hero title={t('nav.home')} sub={t('simple.greeting', { name: me.person.name.split(' ')[0] })} />
      <div className="hub-page hub-wrap hub-narrow">
        {mobileRole ? (
          <section className="hub-panel lift hub-mobile" aria-labelledby="hub-mobile-title">
            <span className="hub-mobile-ic">
              <Icon name="phone" size={24} />
            </span>
            <div>
              <h2 id="hub-mobile-title">{t('simple.mobileTitle')}</h2>
              <p>{t('simple.mobileBody', { role: roleLabelOf(mobileRole, locale), tool: PRODUCTS[mobileRole.key].name })}</p>
              <ol className="hub-steps">
                <li>{t('simple.step1')}</li>
                <li>{t('simple.step2')}</li>
                <li>{t('simple.step3')}</li>
              </ol>
              <p className="hub-app-slot">
                <Icon name="info" size={16} />
                <span>{t('simple.appSlot')}</span>
              </p>
            </div>
          </section>
        ) : (
          <section className="hub-panel lift">
            <Empty icon="lock" title={t('simple.noRoleTitle')}>
              {t('simple.noRoleBody')}
            </Empty>
          </section>
        )}
        <section className="hub-sec hub-kv" aria-labelledby="hub-you-title">
          <SecHead id="hub-you-title" title={t('simple.you')} />
          <div className="hub-kv-row static">
            <span>{t('simple.company')}</span>
            <b>{org.name}</b>
          </div>
          <div className="hub-kv-row static">
            <span>{t('simple.companyRole')}</span>
            <b>{t(`team.orgRoles.${org.orgRole}`)}</b>
          </div>
          {roles.map((p) => (
            <div className="hub-kv-row static" key={p.key}>
              <span>{PRODUCTS[p.key].name}</span>
              <b>{roleLabelOf(p, locale)}</b>
            </div>
          ))}
          <Link to="/account/security" className="hub-kv-row">
            <span>{t('nav.security')}</span>
            <Icon name="chevr" />
          </Link>
          <Link to="/account/profile" className="hub-kv-row">
            <span>{t('nav.profile')}</span>
            <Icon name="chevr" />
          </Link>
        </section>
      </div>
    </>
  );
}
