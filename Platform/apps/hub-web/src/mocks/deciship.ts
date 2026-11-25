// Yalnız VITE_MOCK=1. DeciShip `platform/*` uçlarının örnek yanıtları.
// Şekil gerçek uçtan alındı: Deciship apps/api/src/services/hub/{overview,analytics,datasets,activity,links}.ts.
// Etiketler gerçek sözlükten (deciship-labels.json). Sapma test/deciship-contract.test.mjs (npm test) ile yakalanır.
// Sayılar örnektir ama tek bir örnek veri kümesinden hesaplanır, bu yüzden birbirini tutar.
import type {
  HubActivityItem,
  HubActivityPage,
  HubAiCall,
  HubAiCallPage,
  HubAiCallStatus,
  HubAiUsage,
  HubAlert,
  HubAnalytics,
  HubColumn,
  HubDatasetDef,
  HubDatasetList,
  HubDatasetPage,
  HubFilterDef,
  HubKpi,
  HubOverview,
  HubRow,
  HubSection,
  HubSeries,
  HubWidget,
  Locale,
} from '@sellerondata/contracts';
import { HUB_AI_MEMBER_NONE } from '@sellerondata/contracts';
import labels from './deciship-labels.json' with { type: 'json' };

const P = {
  reports: 'deciship.reports.view',
  invoices: 'deciship.invoices.view',
  export: 'deciship.data.export',
  measurements: 'deciship.measurements.view_all',
  prices: 'deciship.prices.view',
  settings: 'deciship.settings.manage',
} as const;

type Entry = string | { one: string; other: string };
const DICT = labels as Record<Locale, Record<string, Entry>>;

export type MockCtx = { locale: Locale; can: (permission: string) => boolean; empty: boolean; now?: Date };
type Ctx = MockCtx & { t: (key: string, params?: Record<string, string | number>) => string; today: string };

function ctxOf(c: MockCtx): Ctx {
  const dict = DICT[c.locale];
  const plurals = new Intl.PluralRules(c.locale === 'en' ? 'en' : 'tr');
  const t: Ctx['t'] = (key, params) => {
    const entry = dict[key];
    if (entry === undefined) return key;
    const text = typeof entry === 'string' ? entry : plurals.select(Number(params?.count ?? params?.days ?? 0)) === 'one' ? entry.one : entry.other;
    return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
  };
  return { ...c, t, today: isoDay(c.now ?? new Date()) };
}

// ---------- örnek veri kümesi ----------

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const shift = (iso: string, days: number) => isoDay(new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY));
const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Carrier = { id: string; code: string; name: string; active: boolean };
type Line = {
  id: string;
  invoiceId: string;
  rowIndex: number;
  tracking: string;
  status: 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF';
  types: string[];
  decision: 'OPEN' | 'VERIFIED' | 'ACCEPTED';
  decidedDays: number | null;
  low: boolean;
  pak: boolean;
  net: number;
  expected: number | null;
  diff: number | null;
  country: string | null;
  service: string | null;
  shipDate: string;
  ourKg: number | null;
  billedKg: number;
  /** Geçerli itiraz satırı (services/disputes.ts): gönderilmiş paketteki talep ve sonucu. Gönderilmediyse null. */
  dispute: { outcome: 'PENDING' | 'RECOVERED' | 'REJECTED'; claimed: number; recovered: number | null } | null;
};
type Invoice = { id: string; no: string; date: string; carrier: Carrier; currency: string; lines: Line[]; sentOn: string | null; resultOn: string | null };
type DisputeStatus = 'NONE' | 'SENT' | 'CLOSED';
/** Etkin tur yoksa İşlendi; etkin turda sonuçsuz satır varsa gönderildi, yoksa kapandı. */
const disputeStatus = (i: Invoice): DisputeStatus => (!i.sentOn ? 'NONE' : i.lines.some((l) => l.dispute?.outcome === 'PENDING') ? 'SENT' : 'CLOSED');
type Measurement = { id: string; tracking: string; method: string; dims: [number, number, number]; kg: number; userId: string; at: string; photos: number; version: number; packaging: 'OWN' | 'PAK' | 'ENVELOPE' };
type Tariff = { id: string; name: string; carrierId: string; service: string; divisor: number; from: string; to: string; rates: number; countries: number; active: boolean; isDefault: boolean; currency: string; discount: number; fuel: number };

const CARRIERS: Carrier[] = [
  { id: 'car-aras', code: 'aras', name: 'Aras Kargo', active: true },
  { id: 'car-dhl', code: 'dhl', name: 'DHL Express', active: true },
  { id: 'car-fedex', code: 'fedex', name: 'FedEx', active: true },
  { id: 'car-ups', code: 'ups', name: 'UPS', active: true },
];
const INVOICING = [CARRIERS[2]!, CARRIERS[0]!, CARRIERS[3]!, CARRIERS[2]!];
const SERVICES: Record<string, string[]> = { fedex: ['FedEx International Economy', 'FedEx International Priority'], aras: ['Aras Yurt İçi'], ups: ['UPS Express Saver'] };
const COUNTRIES = ['DE', 'FR', 'NL', 'GB', 'US', 'TR'];
const TYPES = ['DIMENSION', 'WEIGHT', 'PRICE', 'SURCHARGE', 'DUPLICATE'];
const METHODS = ['LIDAR', 'AR', 'PRESET', 'REFERENCE', 'MANUAL'];
const USERS = [
  { id: 'm5', name: 'Mehmet Demir' },
  { id: 'm7', name: 'Murat Koç' },
  { id: 'm6', name: 'Ayşe Yılmaz' },
];

type World = { invoices: Invoice[]; lines: Line[]; measurements: Measurement[]; tariffs: Tariff[] };
let cached: { day: string; world: World } | null = null;

function world(today: string): World {
  if (cached?.day === today) return cached.world;
  const invoices: Invoice[] = [];
  const lines: Line[] = [];
  for (let i = 0; i < 70; i++) {
    const age = 1 + i * 3;
    const date = shift(today, -age);
    const carrier = INVOICING[i % INVOICING.length]!;
    const currency = carrier.code === 'ups' && i % 12 === 2 ? 'USD' : 'TRY';
    const scale = currency === 'USD' ? 1 / 32 : 1;
    const no = carrier.code === 'fedex' ? `9-${482 - i}-${11735 + i * 7}` : carrier.code === 'aras' ? `71-${2209 - i}` : `U-${3188 - i}`;
    const id = `inv-${i}`;
    const count = 14 + Math.floor(noise(i + 1) * 26);
    // Her 13 faturadan biri: fiyat farkı oranı yüksek, "tarifesi şüpheli" görünür.
    const suspect = i % 13 === 3;
    const own: Line[] = [];
    for (let j = 0; j < count; j++) {
      const s = i * 1000 + j;
      const roll = noise(s);
      const status: Line['status'] = suspect ? (roll < 0.55 ? 'MATCH' : roll < 0.95 ? 'DIFF' : 'UNMATCHED') : roll < 0.74 ? 'MATCH' : roll < 0.87 ? 'DIFF' : roll < 0.96 ? 'UNMATCHED' : 'NO_TARIFF';
      const net = round2((160 + noise(s + 1) * 720) * scale);
      let diff: number | null = null;
      let expected: number | null = null;
      let types: string[] = [];
      let decision: Line['decision'] = 'OPEN';
      let decidedDays: number | null = null;
      let low = false;
      if (status === 'DIFF') {
        diff = round2(Math.min(net * 0.55, (24 + noise(s + 2) * 300) * scale));
        expected = round2(net - diff);
        const pick = noise(s + 3);
        types = [suspect ? 'PRICE' : TYPES[Math.min(4, Math.floor(pick * pick * 6))]!];
        low = noise(s + 4) < 0.1;
        const d = noise(s + 5);
        decision = age > 24 ? (d < 0.45 ? 'VERIFIED' : d < 0.62 ? 'ACCEPTED' : 'OPEN') : d < 0.74 ? 'OPEN' : d < 0.92 ? 'VERIFIED' : 'ACCEPTED';
        if (decision !== 'OPEN') decidedDays = round2(1 + noise(s + 6) * 7);
      } else if (status === 'MATCH') {
        expected = net;
        diff = 0;
      }
      const services = SERVICES[carrier.code]!;
      const line: Line = {
        id: `line-${i}-${j}`,
        invoiceId: id,
        rowIndex: j + 1,
        tracking: `7948${String(10000000 + s * 37).slice(-8)}`,
        status,
        types,
        decision,
        decidedDays,
        low,
        pak: status === 'UNMATCHED' && noise(s + 7) < 0.2,
        net,
        expected,
        diff,
        country: noise(s + 8) < 0.06 ? null : carrier.code === 'aras' ? 'TR' : COUNTRIES[Math.floor(noise(s + 9) * 5)]!,
        service: services[Math.floor(noise(s + 10) * services.length)]!,
        shipDate: shift(date, -1 - Math.floor(noise(s + 11) * 6)),
        ourKg: status === 'UNMATCHED' ? null : round2(1 + noise(s + 12) * 20),
        billedKg: round2(1 + noise(s + 13) * 22),
        dispute: null,
      };
      own.push(line);
      lines.push(line);
    }
    // İtiraz: 10 günden eski faturaların çoğunda liste gönderilmiş; sonuçlar yaşla gelir (kısmi geri alma dahil).
    let sentOn: string | null = null;
    let resultOn: string | null = null;
    const listed = own.filter((l) => l.status === 'DIFF' && l.decision === 'VERIFIED' && (l.diff ?? 0) > 0);
    if (age >= 10 && listed.length && noise(i + 500) < 0.8) {
      sentOn = shift(date, 2 + Math.floor(noise(i + 501) * 4));
      for (const l of listed) {
        const r = noise(i * 1000 + l.rowIndex + 502);
        const claimed = l.diff!;
        const outcome = age >= 30 ? (r < 0.55 ? 'RECOVERED' : r < 0.75 ? 'REJECTED' : 'PENDING') : r < 0.25 ? 'RECOVERED' : 'PENDING';
        l.dispute = { outcome, claimed, recovered: outcome === 'RECOVERED' ? (r < 0.35 ? claimed : round2(claimed * 0.6)) : null };
      }
      if (listed.some((l) => l.dispute!.outcome !== 'PENDING')) resultOn = shift(sentOn, Math.min(age - 8, 5 + Math.floor(noise(i + 503) * 10)));
    }
    invoices.push({ id, no, date, carrier, currency, lines: own, sentOn, resultOn });
  }
  const measurements: Measurement[] = [];
  for (let d = 0; d < 210; d++) {
    const weekday = new Date(`${shift(today, -d)}T00:00:00.000Z`).getUTCDay();
    const n = weekday === 0 ? 0 : weekday === 6 ? 6 + Math.floor(noise(d + 900) * 8) : 22 + Math.floor(noise(d + 901) * 28);
    for (let k = 0; k < n; k++) {
      const s = d * 500 + k;
      const m = noise(s + 20);
      const method = METHODS[m < 0.38 ? 0 : m < 0.6 ? 1 : m < 0.82 ? 2 : m < 0.92 ? 3 : 4]!;
      const u = noise(s + 21);
      measurements.push({
        id: `mea-${d}-${k}`,
        tracking: `7948${String(20000000 + s * 41).slice(-8)}`,
        method,
        dims: [20 + Math.floor(noise(s + 22) * 40), 15 + Math.floor(noise(s + 23) * 30), 10 + Math.floor(noise(s + 24) * 25)],
        kg: round2(0.5 + noise(s + 25) * 18),
        userId: USERS[u < 0.55 ? 0 : u < 0.93 ? 1 : 2]!.id,
        at: new Date(Date.parse(`${shift(today, -d)}T08:00:00.000Z`) + noise(s + 26) * 9 * 3_600_000).toISOString(),
        photos: noise(s + 27) < 0.02 ? 0 : 1 + Math.floor(noise(s + 28) * 3),
        version: noise(s + 29) < 0.04 ? 2 : 1,
        // örnek veri: birkaç gönderi taşıyıcı poşeti / zarfıyla
        packaging: ((p) => (p < 0.05 ? 'PAK' : p < 0.07 ? 'ENVELOPE' : 'OWN'))(noise(s + 30)),
      });
    }
  }
  const tariffs: Tariff[] = [
    { id: 'tar-aras', name: 'Aras Desi 2026', carrierId: 'car-aras', service: 'Aras Yurt İçi', divisor: 3000, from: shift(today, -60), to: shift(today, 55), rates: 96, countries: 1, active: true, isDefault: true, currency: 'TRY', discount: 12, fuel: 8 },
    { id: 'tar-fedex', name: 'FedEx International Economy 2026', carrierId: 'car-fedex', service: 'FedEx International Economy', divisor: 5000, from: shift(today, -120), to: shift(today, 180), rates: 412, countries: 148, active: true, isDefault: true, currency: 'TRY', discount: 38, fuel: 25 },
    { id: 'tar-ups', name: 'UPS Express Saver', carrierId: 'car-ups', service: 'UPS Express Saver', divisor: 5000, from: shift(today, -350), to: shift(today, 9), rates: 388, countries: 120, active: true, isDefault: true, currency: 'TRY', discount: 30, fuel: 22 },
  ];
  const w = { invoices, lines, measurements, tariffs };
  cached = { day: today, world: w };
  return w;
}

// ---------- bağlantılar: links.ts ile birebir ----------

const deciship = {
  settings: '/deciship/settings',
  invoice: (id: string, tab = 'DIFF') => `/deciship/invoices/${id}?tab=${tab}`,
  invoiceLine: (invoiceId: string, lineId: string, status: string) => `/deciship/invoices/${invoiceId}?tab=${status}&line=${lineId}`,
  measurement: (id: string) => `/deciship/measurements?id=${id}`,
  measurementsBy: (userId: string, p?: Period) => `/deciship/measurements?userId=${userId}${p ? `&from=${p.from}&to=${p.to}` : ''}`,
  tariff: (id: string) => `/deciship/tariffs/${id}`,
  tariffs: (carrierId?: string) => `/deciship/tariffs${carrierId ? `?carrier=${carrierId}` : ''}`,
  setup: '/deciship/setup',
  invoices: '/deciship/invoices',
  disputes: '/deciship/disputes',
  invoiceUpload: '/deciship/invoices/upload',
  measurements: '/deciship/measurements',
};

function dataLink(ctx: Ctx, dataset: string, filters: Record<string, string | string[] | undefined | null>, p?: Period): string | undefined {
  if (!ctx.can(P.invoices)) return undefined;
  if (dataset === 'measurements' && !ctx.can(P.measurements)) return undefined;
  const q = new URLSearchParams();
  // Çoklu seçim gerçek uçtaki gibi tekrarlanan süzgeç (`filter.decision=OPEN&filter.decision=VERIFIED`).
  for (const [k, v] of Object.entries(filters)) for (const one of Array.isArray(v) ? v : [v]) if (one) q.append(`filter.${k}`, one);
  if (p) {
    q.append('filter.from', p.from);
    q.append('filter.to', p.to);
  }
  const s = q.toString();
  return `/data/deciship/${dataset}${s ? `?${s}` : ''}`;
}

// ---------- dönem ----------

type Period = { from: string; to: string; days: number };
const period = (from: string, to: string): Period => ({ from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1 });
const previous = (p: Period) => period(shift(p.from, -p.days), shift(p.from, -1));
const bucketSize = (days: number) => (days <= 62 ? 1 : days <= 200 ? 7 : 30);

function bucketize(p: Period, value: (iso: string) => number, opts: { cumulative?: boolean; today?: string; round?: (n: number) => number } = {}) {
  const size = bucketSize(p.days);
  const round = opts.round ?? ((n: number) => n);
  const points: { x: string; y: number | null }[] = [];
  let running = 0;
  for (let i = 0; i < p.days; i += size) {
    const x = shift(p.from, i);
    if (opts.today && x > opts.today) {
      points.push({ x, y: null });
      continue;
    }
    let total = 0;
    for (let d = 0; d < size && i + d < p.days; d++) total += value(shift(p.from, i + d));
    running += total;
    points.push({ x, y: round(opts.cumulative ? running : total) });
  }
  return points;
}

// ---------- ölçüler ----------

type Measures = { lines: number; match: number; diff: number; unmatched: number; noTariff: number; open: number; billed: number; overcharge: number; verified: number; estimated: number; recovered: number; disputePending: number };
const emptyMeasures = (): Measures => ({ lines: 0, match: 0, diff: 0, unmatched: 0, noTariff: 0, open: 0, billed: 0, overcharge: 0, verified: 0, estimated: 0, recovered: 0, disputePending: 0 });

function addLine(m: Measures, l: Line) {
  m.lines++;
  m.billed += l.net;
  // İtiraz: satırın geçerli itiraz sonucundan (metrics.ts EFFECTIVE_DISPUTE_LINE), karardan bağımsız.
  if (l.dispute?.outcome === 'RECOVERED') m.recovered += l.dispute.recovered ?? 0;
  if (l.dispute?.outcome === 'PENDING') m.disputePending += l.dispute.claimed;
  if (l.status === 'MATCH') m.match++;
  if (l.status === 'UNMATCHED') m.unmatched++;
  if (l.status === 'NO_TARIFF') m.noTariff++;
  if (l.status === 'DIFF') {
    m.diff++;
    if (l.decision === 'OPEN') m.open++;
    if (l.decision !== 'ACCEPTED') {
      if (l.low) m.estimated += l.diff ?? 0;
      else m.overcharge += l.diff ?? 0;
    }
    if (l.decision === 'VERIFIED' && !l.low) m.verified += l.diff ?? 0;
  }
}
function sealed(m: Measures): Measures {
  return { ...m, billed: round2(m.billed), overcharge: round2(m.overcharge), verified: round2(m.verified), estimated: round2(m.estimated), recovered: round2(m.recovered), disputePending: round2(m.disputePending) };
}
const coverage = (m: Measures) => (m.lines ? Math.round(((m.lines - m.unmatched) / m.lines) * 1000) / 10 : null);

function invoicesIn(ctx: Ctx, p: Period): Invoice[] {
  if (ctx.empty) return [];
  return world(ctx.today).invoices.filter((i) => i.date >= p.from && i.date <= p.to);
}
function totals(invoices: Invoice[], currency?: string): Measures & { count: number } {
  const m = emptyMeasures();
  const list = currency ? invoices.filter((i) => i.currency === currency) : invoices;
  for (const i of list) for (const l of i.lines) addLine(m, l);
  return { ...sealed(m), count: list.length };
}
function primaryOf(invoices: Invoice[]) {
  const set = new Set(invoices.map((i) => i.currency));
  const primary = 'TRY';
  set.delete(primary);
  return { primary, others: [...set].sort() };
}
function measurementsIn(ctx: Ctx, p: Period): Measurement[] {
  if (ctx.empty) return [];
  return world(ctx.today).measurements.filter((m) => m.at.slice(0, 10) >= p.from && m.at.slice(0, 10) <= p.to);
}

const TTK_DAYS = 8;
function deadlines(ctx: Ctx) {
  if (ctx.empty) return [];
  const out: { id: string; no: string; carrier: string; currency: string; diff: number; overcharge: number; estimated: number; daysLeft: number; lastDay: string; date: string }[] = [];
  for (const i of world(ctx.today).invoices) {
    // İtirazı gönderilmiş faturanın süresi işlemez (metrics.ts upcomingDeadlines).
    if (i.sentOn) continue;
    const lastDay = shift(i.date, TTK_DAYS);
    if (lastDay < ctx.today) continue;
    const t = totals([i]);
    if (!t.diff) continue;
    out.push({ id: i.id, no: i.no, carrier: i.carrier.name, currency: i.currency, diff: t.diff, overcharge: t.overcharge, estimated: t.estimated, daysLeft: Math.round((Date.parse(lastDay) - Date.parse(ctx.today)) / DAY), lastDay, date: i.date });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
function tariffStatus(ctx: Ctx) {
  if (ctx.empty) return [];
  const { tariffs } = world(ctx.today);
  return CARRIERS.map((c) => {
    const tariff = tariffs.find((t) => t.carrierId === c.id && t.isDefault) ?? null;
    return { carrier: c, tariff, daysLeft: tariff ? Math.round((Date.parse(tariff.to) - Date.parse(ctx.today)) / DAY) : null };
  });
}
const formatDay = (iso: string, locale: Locale) =>
  locale === 'en'
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
    : new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const countryName = (code: string, locale: Locale) => new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------- overview ----------

/** Bekleyenler'deki "karar bekliyor" satırlarının toplamı: rakam ve kuyruk aynı sayıyı söyler (gerçek uç gibi). */
const queueOpen = (list: Invoice[]) => list.flatMap((i) => i.lines).filter((l) => l.status === 'DIFF' && l.decision === 'OPEN').length;

export function overview(from: string, to: string, base: MockCtx): HubOverview {
  const ctx = ctxOf(base);
  const { t } = ctx;
  const money = ctx.can(P.prices);
  const p = period(from, to);
  const prev = previous(p);
  const invoices = invoicesIn(ctx, p);
  const prevInvoices = invoicesIn(ctx, prev);
  const all = totals(invoices);
  const prevAll = totals(prevInvoices);
  const { primary, others } = primaryOf(invoices);
  const cur = totals(invoices, primary);
  const prevCur = totals(prevInvoices, primary);
  const measured = measurementsIn(ctx, p);
  const prevMeasured = measurementsIn(ctx, prev);
  const hasAnything = all.count > 0 || measured.length > 0;
  const due = deadlines(ctx);

  const overchargeSeries = (list: Invoice[], pp: Period, today?: string) => {
    const byDay = new Map<string, number>();
    for (const i of list) if (i.currency === primary) byDay.set(i.date, (byDay.get(i.date) ?? 0) + totals([i]).overcharge);
    return bucketize(pp, (d) => byDay.get(d) ?? 0, { cumulative: true, today, round: round2 });
  };

  const kpis: HubKpi[] = [];
  if (money) {
    const trend: HubSeries[] = [
      { id: 'current', label: t('common.thisPeriod'), role: 'current', points: overchargeSeries(invoices, p, ctx.today) },
      { id: 'previous', label: t('common.previousPeriod'), role: 'previous', points: overchargeSeries(prevInvoices, prev) },
    ];
    kpis.push({
      id: 'overcharge',
      label: t('kpi.overcharge'),
      hint: all.count ? t('kpi.overcharge.hint') : t('kpi.overcharge.noInvoices'),
      value: hasAnything ? cur.overcharge : null,
      format: 'money',
      currency: primary,
      previous: prevCur.count ? prevCur.overcharge : null,
      goodDirection: 'down',
      tone: cur.overcharge > 0 ? 'bad' : 'neutral',
      href: '/analytics/deciship',
      trend,
    });
  }
  kpis.push(
    { id: 'diffs', label: t('kpi.diffs'), hint: t('kpi.diffs.hint'), value: hasAnything ? all.diff : null, format: 'number', previous: prevAll.diff, goodDirection: 'down', tone: all.diff > 0 ? 'warning' : 'neutral', href: dataLink(ctx, 'invoice-lines', { status: 'DIFF' }, p) },
    { id: 'deadlines', label: t('kpi.deadlines'), hint: t('kpi.deadlines.hint'), value: due.length, format: 'number', goodDirection: 'none', tone: due.length ? 'warning' : 'neutral', href: dataLink(ctx, 'invoices', { deadline: 'soon' }) },
  );
  // Baş rakamın diğer para birimleri: "süresi yaklaşan" üçüncü sırada kalır (overview.ts).
  if (money) {
    for (const c of others) {
      const o = totals(invoices, c);
      const po = totals(prevInvoices, c);
      kpis.push({ id: `overcharge:${c}`, label: t('kpi.overchargeIn', { currency: c }), hint: t('kpi.overchargeIn.hint'), value: o.overcharge, format: 'money', currency: c, previous: po.count ? po.overcharge : null, goodDirection: 'down', tone: o.overcharge > 0 ? 'bad' : 'neutral', href: `/analytics/deciship?filter.currency=${c}` });
    }
  }
  kpis.push(
    { id: 'open', label: t('kpi.open'), value: queueOpen(invoices), format: 'number', previous: queueOpen(prevInvoices), goodDirection: 'down', tone: queueOpen(invoices) > 0 ? 'warning' : 'neutral', href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'OPEN' }, p) },
    { id: 'coverage', label: t('kpi.coverage'), hint: t('kpi.coverage.hint'), value: coverage(all), format: 'percent', previous: coverage(prevAll), goodDirection: 'up', href: dataLink(ctx, 'invoice-lines', { status: 'UNMATCHED' }, p) },
  );
  if (money) {
    kpis.push({ id: 'verified', label: t('kpi.verified'), hint: t('kpi.verified.hint'), value: cur.verified, format: 'money', currency: primary, previous: prevCur.count ? prevCur.verified : null, goodDirection: 'none', href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'VERIFIED', ...(others.length ? { currency: primary } : {}) }, p) });
    // İtiraz: fatura ayına göre (Pano ile aynı küme), baş para biriminde.
    kpis.push(
      { id: 'recovered', label: t('kpi.recovered'), hint: t('kpi.recovered.hint'), value: cur.recovered, format: 'money', currency: primary, previous: prevCur.count ? prevCur.recovered : null, goodDirection: 'up', tone: cur.recovered > 0 ? 'good' : 'neutral', href: deciship.disputes },
      { id: 'disputePending', label: t('kpi.disputePending'), hint: t('kpi.disputePending.hint'), value: cur.disputePending, format: 'money', currency: primary, previous: prevCur.count ? prevCur.disputePending : null, goodDirection: 'none', tone: cur.disputePending > 0 ? 'warning' : 'neutral', href: `${deciship.disputes}?status=SENT` },
    );
    if (cur.estimated > 0 || prevCur.estimated > 0) {
      kpis.push({ id: 'estimated', label: t('kpi.estimated'), hint: t('kpi.estimated.hint'), value: cur.estimated, format: 'money', currency: primary, previous: prevCur.count ? prevCur.estimated : null, goodDirection: 'down', tone: cur.estimated > 0 ? 'warning' : 'neutral', href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', confidence: 'LOW', ...(others.length ? { currency: primary } : {}) }, p) });
    }
  }
  kpis.push(
    { id: 'measured', label: t('kpi.measured'), value: measured.length, format: 'number', previous: prevMeasured.length, goodDirection: 'up', href: dataLink(ctx, 'measurements', {}, p) },
    { id: 'invoices', label: t('kpi.invoices'), value: all.count, format: 'number', previous: prevAll.count, goodDirection: 'none', href: dataLink(ctx, 'invoices', {}, p) },
  );

  const alerts: HubAlert[] = due.slice(0, 5).map((d) => {
    const when = t('alert.deadline.ttk', { carrier: d.carrier, date: formatDay(d.lastDay, ctx.locale) });
    const estimatedOnly = d.overcharge <= 0;
    const alert: HubAlert = {
      id: `deadline:${d.id}`,
      tone: d.daysLeft <= 2 ? 'bad' : 'warning',
      title: t('alert.deadline.title', { carrier: d.carrier, invoice: d.no, count: d.diff }),
      body: estimatedOnly && money ? `${when} ${t('alert.deadline.estimated')}` : when,
      dueAt: d.lastDay,
      href: deciship.invoice(d.id),
      actionLabel: t('alert.openInvoice'),
      at: `${d.date}T09:00:00.000Z`,
    };
    if (money) alert.amount = { value: estimatedOnly ? d.estimated : d.overcharge, format: 'money', currency: d.currency };
    return alert;
  });
  if (due.length > 5) alerts.push({ id: 'deadline-more', tone: 'warning', title: t('alert.deadline.more', { count: due.length - 5 }), href: dataLink(ctx, 'invoices', { deadline: 'soon' }), actionLabel: t('alert.seeInvoices') });

  const currencies = [...new Set(invoices.map((i) => i.currency))].sort();
  const many = currencies.length > 1;
  for (const currency of currencies) {
    const ls = invoices.filter((i) => i.currency === currency).flatMap((i) => i.lines);
    const amount = (value: number) => (money ? { amount: { value: round2(value), format: 'money' as const, currency } } : {});
    const curParam = many ? { currency } : {};
    // Kuyruklar para birimi başınadır: birden çok kuyruk varsa başlık hangisi olduğunu söyler, toplamı KPI verir.
    const queueTitle = (title: string) => (many ? t('alert.inCurrency', { title, currency }) : title);
    const open = ls.filter((l) => l.status === 'DIFF' && l.decision === 'OPEN');
    if (open.length) alerts.push({ id: `open:${currency}`, tone: 'warning', title: queueTitle(t('alert.open.title', { count: open.length })), body: t('alert.open.body'), ...amount(open.reduce((a, l) => a + (l.low ? 0 : (l.diff ?? 0)), 0)), href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', decision: 'OPEN', ...curParam }, p), actionLabel: t('alert.seeLines') });
    const unmatched = ls.filter((l) => l.status === 'UNMATCHED' && !l.pak);
    if (unmatched.length) alerts.push({ id: `unmatched:${currency}`, tone: 'warning', title: queueTitle(t('alert.unmatched.title', { count: unmatched.length })), body: t('alert.unmatched.body'), ...amount(unmatched.reduce((a, l) => a + l.net, 0)), href: dataLink(ctx, 'invoice-lines', { status: 'UNMATCHED', scope: 'in', ...curParam }, p), actionLabel: t('alert.seeLines') });
    const noTariff = ls.filter((l) => l.status === 'NO_TARIFF' && !l.pak);
    if (noTariff.length) alerts.push({ id: `no-tariff:${currency}`, tone: 'warning', title: queueTitle(t('alert.noTariff.title', { count: noTariff.length })), body: t('alert.noTariff.body'), ...amount(noTariff.reduce((a, l) => a + l.net, 0)), href: dataLink(ctx, 'invoice-lines', { status: 'NO_TARIFF', scope: 'in', ...curParam }, p), actionLabel: t('alert.seeLines') });
  }
  for (const s of tariffStatus(ctx)) {
    if (!s.tariff) alerts.push({ id: `tariff-none:${s.carrier.id}`, tone: 'warning', title: t('alert.tariff.none.title', { carrier: s.carrier.name }), body: t('alert.tariff.none.body'), href: deciship.tariffs(s.carrier.id), actionLabel: t('alert.seeTariffs') });
    else if (s.daysLeft != null && s.daysLeft <= 30) alerts.push({ id: `tariff-expiry:${s.tariff.id}`, tone: s.daysLeft < 0 ? 'bad' : 'warning', title: t('alert.tariff.soon.title', { tariff: s.tariff.name, days: s.daysLeft }), body: t('alert.tariff.soon.body'), href: deciship.tariff(s.tariff.id), actionLabel: t('alert.openTariff') });
  }
  const noPhoto = measured.filter((m) => m.photos === 0).length;
  if (ctx.can(P.measurements) && noPhoto > 0) alerts.push({ id: 'no-photo', tone: 'info', title: t('alert.photos.title', { count: noPhoto }), body: t('alert.photos.body'), href: dataLink(ctx, 'measurements', { photos: 'none' }, p), actionLabel: t('alert.seeMeasurements') });

  const out: HubOverview = { product: 'deciship', from, to, kpis, alerts };
  if (money && cur.count) {
    const ls = invoices.filter((i) => i.currency === primary).flatMap((i) => i.lines);
    const billed = (test: (l: Line) => boolean) => round2(ls.filter(test).reduce((a, l) => a + l.net, 0));
    const link = (filters: Record<string, string | string[]>) => dataLink(ctx, 'invoice-lines', { ...filters, ...(others.length ? { currency: primary } : {}) }, p);
    const accepted = billed((l) => l.status === 'DIFF' && l.decision === 'ACCEPTED');
    // Gerçek uç gibi (overview.ts buildSplit): "Fark var" uyumlu sayılanları dışarıda bırakır, bağlantısı da öyle süzer; her parçanın açıklaması var.
    out.split = {
      title: others.length ? t('split.titleIn', { currency: primary }) : t('split.title'),
      total: { value: cur.billed, format: 'money', currency: primary },
      parts: [
        { key: 'match', label: t('split.match'), value: billed((l) => l.status === 'MATCH'), tone: 'good', href: link({ status: 'MATCH' }), note: t('split.match.note') },
        { key: 'diff', label: t('split.diff'), value: billed((l) => l.status === 'DIFF' && l.decision !== 'ACCEPTED'), tone: 'bad', href: link({ status: 'DIFF', decision: ['OPEN', 'VERIFIED'] }), note: t('split.diff.note') },
        ...(accepted > 0 ? [{ key: 'accepted', label: t('split.accepted'), value: accepted, tone: 'info' as const, href: link({ status: 'DIFF', decision: 'ACCEPTED' }), note: t('split.accepted.note') }] : []),
        { key: 'unmatched', label: t('split.unmatched'), value: billed((l) => l.status === 'UNMATCHED'), tone: 'warning', href: link({ status: 'UNMATCHED' }), note: t('split.unmatched.note') },
        { key: 'noTariff', label: t('split.noTariff'), value: billed((l) => l.status === 'NO_TARIFF'), tone: 'neutral', href: link({ status: 'NO_TARIFF' }), note: t('split.noTariff.note') },
      ],
    };
  }
  if (money && cur.count) {
    // En çok kaçıran: taşıyıcı ve fark türü, grup başına ilk 3. Tutar birincil para biriminde.
    const leak = invoices.filter((i) => i.currency === primary).flatMap((i) => i.lines.map((l) => ({ l, carrier: i.carrier }))).filter(({ l }) => l.status === 'DIFF' && l.decision !== 'ACCEPTED' && !l.low);
    const over = (l: Line) => Math.max(0, l.diff ?? 0);
    const totalLeak = leak.reduce((a, { l }) => a + over(l), 0) || 1;
    const top = (key: (x: (typeof leak)[number]) => string, nameOf: (k: string) => string) => {
      const map = new Map<string, number>();
      for (const x of leak) map.set(key(x), (map.get(key(x)) ?? 0) + over(x.l));
      return [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0]))).slice(0, 3);
    };
    // Gerçek uç gibi (overview.ts buildLeaders): grup adı `leader.*`, kimlik `carrier:<taşıyıcı kimliği>` / `type:<tür>`,
    // bağlantı o taşıyıcıya ya da türe süzer; pay bir ondalık.
    const carrierById = new Map(invoices.map((i) => [i.carrier.id, i.carrier.name]));
    const inCurrency = others.length ? { currency: primary } : {};
    const typeName = (k: string) => t(`diffType.${k}`);
    out.leaders = [
      ...top((x) => x.carrier.id, (id) => carrierById.get(id) ?? id).map(([id, value]) => ({ id: `carrier:${id}`, label: t('leader.carrier'), name: carrierById.get(id) ?? id, value: { value: round2(value), format: 'money' as const, currency: primary }, share: Math.round((value / totalLeak) * 1000) / 10, href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', carrier: id, ...inCurrency }, p) })),
      ...top((x) => x.l.types[0] ?? 'PRICE', typeName).map(([k, value]) => ({ id: `type:${k}`, label: t('leader.type'), name: typeName(k), value: { value: round2(value), format: 'money' as const, currency: primary }, share: Math.round((value / totalLeak) * 1000) / 10, href: dataLink(ctx, 'invoice-lines', { status: 'DIFF', diff: k, ...inCurrency }, p) })),
    ];
  }
  if (ctx.can(P.settings)) {
    // Gerçek uç (overview.ts setupSteps): adımlar firmanın verisinden, kurulumu yapabilecek kişiye her zaman gelir.
    // Örnek veri kümesinde hepsi yapılmış; boş firmada test kancası (`sod_mock_setup_done`) yapılanları söyler.
    const marked = (typeof localStorage === 'undefined' ? '' : (localStorage.getItem('sod_mock_setup_done') ?? '')).split(',');
    const done = (id: string) => !ctx.empty || marked.includes(id);
    const wizard = (step: string) => `${deciship.setup}?adim=${step}`;
    // Gerçek uç `completed`i tek kuraldan verir (sihirbaz tamam ya da zorunlu adımlar veride). Test kancası sihirbaz bayrağını canlandırır.
    const completed = !ctx.empty || (typeof localStorage !== 'undefined' && !!localStorage.getItem('sod_mock_setup_flag_done'));
    out.setup = {
      completed,
      href: deciship.setup,
      label: completed ? '' : t('setup.label'),
      steps: [
        { id: 'carriers', label: t('setup.step.carriers'), done: done('carriers'), href: wizard('tasiyicilar'), required: true },
        { id: 'tariffs', label: t('setup.step.tariffs'), done: done('tariffs'), href: wizard('tarifeler'), required: true },
        { id: 'measure-rules', label: t('setup.step.measureRules'), done: done('measure-rules'), href: wizard('olcum'), required: true },
        { id: 'first-measurement', label: t('setup.step.firstMeasurement'), done: done('first-measurement'), href: deciship.measurements, required: true },
        { id: 'first-invoice', label: t('setup.step.firstInvoice'), done: done('first-invoice'), href: deciship.invoiceUpload, required: true },
        // Yeni firmaya açılan örnek koliler adımı kendiliğinden tamamlamaz (onboarding.ts presetsReady).
        { id: 'box-presets', label: t('setup.step.boxPresets'), done: done('box-presets'), href: wizard('koliler'), required: false },
      ],
    };
  }
  return plain(out);
}

// ---------- analytics ----------

const emptyWidget = (ctx: Ctx, id: string, title: string, body: string, extra: { href?: string; actionLabel?: string } = {}): HubWidget => ({ kind: 'empty', id, title: ctx.t(title), body: ctx.t(body), ...extra });
const withPrev = (k: HubKpi, prev: number | null | undefined, compare: boolean): HubKpi => (compare ? { ...k, previous: prev ?? null } : k);

function breakdown<K>(ctx: Ctx, entries: [K, number][], label: (k: K) => string, href: (k: K) => string | undefined, keyOf: (k: K) => string, limit = 8) {
  const positive = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || keyOf(a[0]).localeCompare(keyOf(b[0])));
  const total = positive.reduce((a, [, v]) => a + v, 0);
  const shown = positive.slice(0, limit);
  const rest = positive.slice(limit).reduce((a, [, v]) => a + v, 0);
  const items: { key: string; label: string; value: number; share: number; href?: string }[] = shown.map(([k, value]) => {
    const h = href(k);
    return { key: keyOf(k), label: label(k), value: round2(value), share: pct(value, total) ?? 0, ...(h ? { href: h } : {}) };
  });
  if (rest > 0) items.push({ key: '_other', label: ctx.t('common.other'), value: round2(rest), share: pct(rest, total) ?? 0 });
  return items;
}

type LineFilter = { carriers: string[]; service?: string; country?: string; tracking?: string; currency: string | null };

function filteredLines(list: Invoice[], f: LineFilter): Line[] {
  const out: Line[] = [];
  for (const i of list) {
    if (f.carriers.length && !f.carriers.includes(i.carrier.id)) continue;
    if (f.currency && i.currency !== f.currency) continue;
    for (const l of i.lines) {
      if (f.service && l.service !== f.service) continue;
      if (f.country && l.country !== f.country) continue;
      if (f.tracking && !l.tracking.includes(f.tracking)) continue;
      out.push(l);
    }
  }
  return out;
}

export function analytics(from: string, to: string, compare: boolean, filters: Record<string, string[]>, base: MockCtx): HubAnalytics {
  const ctx = ctxOf(base);
  const { t } = ctx;
  const money = ctx.can(P.prices);
  const p = period(from, to);
  const prev = previous(p);
  const invoices = invoicesIn(ctx, p);
  const { primary, others } = primaryOf(invoices);
  const all = [primary, ...others];
  const currency = money ? (filters.currency?.[0]?.toUpperCase() ?? primary) : null;
  const multi = money && all.length > 1;
  const f: LineFilter = { carriers: filters.carrier ?? [], service: filters.service?.[0], country: filters.country?.[0]?.trim().toUpperCase() || undefined, tracking: filters.tracking?.[0]?.trim() || undefined, currency };
  const narrowed = Boolean(f.carriers.length || f.service || f.country || f.tracking);
  const services = [...new Set(invoices.flatMap((i) => i.lines.map((l) => l.service)).filter((s): s is string => !!s))].sort();
  const filterDefs: HubFilterDef[] = [
    { id: 'carrier', kind: 'select', multiple: true, label: t('filter.carrier'), options: CARRIERS.map((c) => ({ value: c.id, label: c.name })) },
    { id: 'service', kind: 'select', label: t('filter.service'), options: services.map((s) => ({ value: s, label: s })) },
    { id: 'country', kind: 'text', label: t('filter.country') },
    { id: 'tracking', kind: 'text', label: t('filter.tracking') },
  ];
  if (multi) filterDefs.unshift({ id: 'currency', kind: 'select', label: t('filter.currency'), options: all.map((c) => ({ value: c, label: c })) });
  const head = { product: 'deciship', from, to, filters: filterDefs, ...(compare ? { compare: { from: prev.from, to: prev.to } } : {}) };
  if (ctx.empty) {
    return plain({ ...head, sections: [{ id: 'start', title: t('section.start'), widgets: [emptyWidget(ctx, 'start', 'empty.start.title', 'empty.start.body', { href: ctx.can(P.settings) ? deciship.setup : deciship.invoices, actionLabel: t('empty.start.action') })] }] });
  }
  const carrierName = (id: string) => CARRIERS.find((c) => c.id === id)?.name ?? id;
  const filterCurrency = multi ? currency : null;
  const lineLink = (q: Record<string, string | null | undefined>) => dataLink(ctx, 'invoice-lines', { ...q, ...(filterCurrency ? { currency: filterCurrency } : {}) }, p);
  const lines = filteredLines(invoices, f);
  const prevInvoices = invoicesIn(ctx, prev);
  const prevLines = compare ? filteredLines(prevInvoices, f) : null;
  const measure = (ls: Line[]) => {
    const m = emptyMeasures();
    ls.forEach((l) => addLine(m, l));
    return sealed(m);
  };
  const total = measure(lines);
  const prevTotal = prevLines ? measure(prevLines) : null;
  const moneyAttrs = money ? ({ format: 'money', currency: currency! } as const) : ({ format: 'number' } as const);
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const val = (ls: Line[]) => (money ? measure(ls).overcharge : measure(ls).diff);
  const group = <K,>(ls: Line[], key: (l: Line) => K) => {
    const map = new Map<K, Line[]>();
    for (const l of ls) map.set(key(l), [...(map.get(key(l)) ?? []), l]);
    return [...map.entries()];
  };
  const diffs = lines.filter((l) => l.status === 'DIFF');

  // bölüm 1: fazla ödeme
  const headOver = money
    ? { id: 'overcharge', title: t('section.overcharge'), description: multi ? t('section.overcharge.descIn', { currency: currency! }) : t('section.overcharge.desc') }
    : { id: 'diffs', title: t('section.diffs'), description: t('section.diffs.desc') };
  const prevMoney = (v: number | undefined) => (prevTotal?.lines ? (v ?? null) : null);
  let over: HubSection;
  if (!total.lines) {
    over = { ...headOver, widgets: [narrowed ? emptyWidget(ctx, 'no-lines', 'empty.filter.title', 'empty.filter.body') : emptyWidget(ctx, 'no-lines', 'empty.period.title', 'empty.period.body')] };
  } else {
    const items: HubKpi[] = [];
    if (money) {
      items.push(
        withPrev({ id: 'billed', label: t('kpi.billed'), value: total.billed, format: 'money', currency: currency!, goodDirection: 'none' }, prevMoney(prevTotal?.billed), compare),
        withPrev({ id: 'overcharge', label: t('kpi.overcharge'), hint: t('kpi.overcharge.hint'), value: total.overcharge, format: 'money', currency: currency!, goodDirection: 'down', tone: total.overcharge > 0 ? 'bad' : 'neutral' }, prevMoney(prevTotal?.overcharge), compare),
        withPrev({ id: 'verified', label: t('kpi.verified'), hint: t('kpi.verified.hint'), value: total.verified, format: 'money', currency: currency!, goodDirection: 'none', href: lineLink({ status: 'DIFF', decision: 'VERIFIED' }) }, prevMoney(prevTotal?.verified), compare),
        withPrev({ id: 'recovered', label: t('kpi.recovered'), hint: t('kpi.recovered.hint'), value: total.recovered, format: 'money', currency: currency!, goodDirection: 'up', tone: total.recovered > 0 ? 'good' : 'neutral', href: deciship.disputes }, prevMoney(prevTotal?.recovered), compare),
        withPrev({ id: 'disputePending', label: t('kpi.disputePending'), hint: t('kpi.disputePending.hint'), value: total.disputePending, format: 'money', currency: currency!, goodDirection: 'none', tone: total.disputePending > 0 ? 'warning' : 'neutral', href: `${deciship.disputes}?status=SENT` }, prevMoney(prevTotal?.disputePending), compare),
      );
      if (total.estimated > 0 || (prevTotal?.estimated ?? 0) > 0) items.push(withPrev({ id: 'estimated', label: t('kpi.estimated'), hint: t('kpi.estimated.hint'), value: total.estimated, format: 'money', currency: currency!, goodDirection: 'down', tone: total.estimated > 0 ? 'warning' : 'neutral', href: lineLink({ status: 'DIFF', confidence: 'LOW' }) }, prevMoney(prevTotal?.estimated), compare));
    }
    items.push(
      withPrev({ id: 'lines', label: t('kpi.lines'), value: total.lines, format: 'number', goodDirection: 'none', href: lineLink({}) }, prevTotal?.lines, compare),
      withPrev({ id: 'diffs', label: t('kpi.diffs'), hint: t('kpi.diffs.hint'), value: total.diff, format: 'number', goodDirection: 'down', tone: total.diff > 0 ? 'warning' : 'neutral', href: lineLink({ status: 'DIFF' }) }, prevTotal?.diff, compare),
      withPrev({ id: 'diff-rate', label: t('kpi.diffRate'), value: pct(total.diff, total.lines), format: 'percent', goodDirection: 'down' }, prevTotal ? pct(prevTotal.diff, prevTotal.lines) : null, compare),
    );
    const dayValue = (ls: Line[]) => {
      const byDay = new Map<string, number>();
      const prevById = new Map(prevInvoices.map((i) => [i.id, i]));
      for (const l of ls) {
        const inv = invoiceById.get(l.invoiceId) ?? prevById.get(l.invoiceId);
        if (!inv) continue;
        const m = emptyMeasures();
        addLine(m, l);
        byDay.set(inv.date, (byDay.get(inv.date) ?? 0) + (money ? m.overcharge : m.diff));
      }
      return byDay;
    };
    const cur = dayValue(lines);
    const series = (id: string, label: string, role: 'current' | 'previous', pp: Period, map: Map<string, number>, today?: string): HubSeries => ({ id, label: t(label), role, points: money ? bucketize(pp, (d) => map.get(d) ?? 0, { cumulative: true, today, round: round2 }) : bucketize(pp, (d) => map.get(d) ?? 0, { today }) });
    const carriersGrouped = group(lines, (l) => invoiceById.get(l.invoiceId)!.carrier.id);
    const top = diffs.filter((l) => !l.low && l.decision !== 'ACCEPTED' && (l.diff ?? 0) > 0).sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0)).slice(0, 10);
    const topInvoices = invoices
      .map((i) => ({ i, m: measure(lines.filter((l) => l.invoiceId === i.id)) }))
      .filter((x) => x.m.overcharge > 0)
      .sort((a, b) => b.m.overcharge - a.m.overcharge)
      .slice(0, 10);
    const widgets: HubWidget[] = [
      { kind: 'kpis', id: 'overcharge-kpis', items },
      {
        kind: 'timeseries',
        id: money ? 'overcharge-trend' : 'diff-trend',
        title: money ? t('widget.overTrend') : t('widget.diffTrend'),
        description: money ? t('widget.overTrend.desc') : t('widget.diffTrend.desc'),
        chart: money ? 'area' : 'bar',
        ...moneyAttrs,
        series: [series('current', 'common.thisPeriod', 'current', p, cur, ctx.today), ...(prevLines ? [series('previous', 'common.previousPeriod', 'previous', prev, dayValue(prevLines))] : [])],
      },
      {
        kind: 'breakdown',
        id: 'diff-types',
        title: t('widget.types'),
        description: money ? t('widget.types.desc') : t('widget.types.descCount'),
        ...moneyAttrs,
        items: breakdown(ctx, group(diffs, (l) => l.types[0] ?? 'PRICE').map(([k, ls]) => [k, val(ls)] as [string, number]), (k) => t(`diffType.${k}`), (k) => lineLink({ status: 'DIFF', diff: k }), (k) => k),
      },
      {
        kind: 'breakdown',
        id: 'by-carrier',
        title: t('widget.byCarrier'),
        ...moneyAttrs,
        items: breakdown(ctx, group(diffs, (l) => invoiceById.get(l.invoiceId)!.carrier.id).map(([k, ls]) => [k, val(ls)] as [string, number]), carrierName, (k) => lineLink({ status: 'DIFF', carrier: k }), (k) => k),
      },
      {
        kind: 'table',
        id: 'carrier-rates',
        title: t('widget.carrierRates'),
        description: t('widget.carrierRates.desc'),
        columns: [
          { id: 'carrier', label: t('col.carrier'), format: 'text' },
          { id: 'lines', label: t('col.lines'), format: 'number' },
          { id: 'diff', label: t('col.diffLines'), format: 'number' },
          { id: 'diffRate', label: t('col.diffRate'), format: 'percent' },
          ...(money
            ? ([
                { id: 'billed', label: t('col.billed'), format: 'money', currency: currency! },
                { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
                { id: 'overchargeRate', label: t('col.overchargeRate'), format: 'percent' },
              ] as HubColumn[])
            : []),
        ],
        rows: carriersGrouped
          .map(([id, ls]) => ({ id, m: measure(ls) }))
          .sort((a, b) => (money ? b.m.overcharge - a.m.overcharge : b.m.diff - a.m.diff))
          .map(({ id, m }) => {
            const href = lineLink({ carrier: id });
            return { id, ...(href ? { href } : {}), cells: { carrier: carrierName(id), lines: m.lines, diff: m.diff, diffRate: pct(m.diff, m.lines), ...(money ? { billed: m.billed, overcharge: m.overcharge, overchargeRate: pct(m.overcharge, m.billed) } : {}) } };
          }),
      },
      {
        kind: 'breakdown',
        id: 'by-country',
        title: t('widget.byCountry'),
        ...moneyAttrs,
        items: breakdown(ctx, group(diffs, (l) => l.country).map(([k, ls]) => [k, val(ls)] as [string | null, number]), (k) => (k ? countryName(k, ctx.locale) : t('common.unspecified')), (k) => (k ? lineLink({ status: 'DIFF', country: k }) : undefined), (k) => k ?? '_none'),
      },
      {
        kind: 'breakdown',
        id: 'by-service',
        title: t('widget.byService'),
        ...moneyAttrs,
        items: breakdown(ctx, group(diffs, (l) => l.service).map(([k, ls]) => [k, val(ls)] as [string | null, number]), (k) => k ?? t('common.unspecified'), (k) => (k ? lineLink({ status: 'DIFF', service: k }) : undefined), (k) => k ?? '_none'),
      },
    ];
    if (money) {
      const seeInvoices = ctx.can(P.invoices);
      widgets.push(
        {
          kind: 'table',
          id: 'top-shipments',
          title: t('widget.topShipments'),
          columns: [
            { id: 'tracking', label: t('col.tracking'), format: 'text' },
            { id: 'carrier', label: t('col.carrier'), format: 'text' },
            { id: 'invoice', label: t('col.invoice'), format: 'text' },
            { id: 'country', label: t('col.country'), format: 'text' },
            { id: 'type', label: t('col.diffType'), format: 'text' },
            { id: 'billed', label: t('col.billed'), format: 'money', currency: currency! },
            { id: 'expected', label: t('col.expected'), format: 'money', currency: currency! },
            { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
          ],
          rows: top.map((l) => {
            const inv = invoiceById.get(l.invoiceId)!;
            return { id: l.id, ...(seeInvoices ? { href: deciship.invoiceLine(l.invoiceId, l.id, l.status) } : {}), cells: { tracking: l.tracking, carrier: inv.carrier.name, invoice: inv.no, country: l.country, type: l.types.map((d) => t(`diffType.${d}`)).join(', '), billed: l.net, expected: l.expected, overcharge: l.diff } };
          }),
        },
        {
          kind: 'table',
          id: 'top-invoices',
          title: t('widget.topInvoices'),
          columns: [
            { id: 'invoice', label: t('col.invoice'), format: 'text' },
            { id: 'carrier', label: t('col.carrier'), format: 'text' },
            { id: 'date', label: t('col.date'), format: 'date' },
            { id: 'lines', label: t('col.lines'), format: 'number' },
            { id: 'diff', label: t('col.diffLines'), format: 'number' },
            { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
          ],
          rows: topInvoices.map(({ i, m }) => ({ id: i.id, ...(seeInvoices ? { href: deciship.invoice(i.id) } : {}), cells: { invoice: i.no, carrier: i.carrier.name, date: i.date, lines: m.lines, diff: m.diff, overcharge: m.overcharge } })),
        },
      );
    }
    over = { ...headOver, widgets };
  }

  // bölüm 2: kararlar
  const sections: HubSection[] = [over];
  if (total.diff) {
    const decisions = ['OPEN', 'VERIFIED', 'ACCEPTED'] as const;
    const decided = diffs.filter((l) => l.decidedDays != null);
    const avg = (ls: Line[]) => (ls.length ? round2(ls.reduce((a, l) => a + (l.decidedDays ?? 0), 0) / ls.length) : null);
    const widgets: HubWidget[] = [
      {
        kind: 'kpis',
        id: 'decision-kpis',
        items: [
          withPrev({ id: 'open', label: t('kpi.open'), value: total.open, format: 'number', goodDirection: 'down', tone: total.open > 0 ? 'warning' : 'neutral', href: lineLink({ status: 'DIFF', decision: 'OPEN' }) }, prevTotal?.open, compare),
          withPrev({ id: 'decision-days', label: t('kpi.decisionDays'), hint: t('kpi.decisionDays.hint'), value: avg(decided), format: 'duration_days', goodDirection: 'down' }, prevLines ? avg(prevLines.filter((l) => l.status === 'DIFF' && l.decidedDays != null)) : null, compare),
        ],
      },
      {
        kind: 'breakdown',
        id: 'decision-lines',
        title: t('widget.decisionLines'),
        format: 'number',
        items: breakdown(ctx, decisions.map((k) => [k, diffs.filter((l) => l.decision === k).length] as [string, number]), (k) => t(`decision.${k}`), (k) => lineLink({ status: 'DIFF', decision: k }), (k) => k),
      },
    ];
    if (money) {
      widgets.push({
        kind: 'table',
        id: 'decision-summary',
        title: t('widget.decisionTable'),
        description: t('widget.decisionTable.desc'),
        columns: [
          { id: 'decision', label: t('col.decision'), format: 'text' },
          { id: 'lines', label: t('col.lines'), format: 'number' },
          { id: 'overcharge', label: t('col.overcharge'), format: 'money', currency: currency! },
          { id: 'estimated', label: t('col.estimated'), format: 'money', currency: currency! },
        ],
        rows: decisions.map((k) => {
          const ls = diffs.filter((l) => l.decision === k);
          const m = measure(ls);
          const href = lineLink({ status: 'DIFF', decision: k });
          return { id: k, ...(href ? { href } : {}), cells: { decision: t(`decision.${k}`), lines: ls.length, overcharge: m.overcharge, estimated: m.estimated } };
        }),
      });
    }
    sections.push({ id: 'decisions', title: t('section.decisions'), description: t('section.decisions.desc'), widgets });
  }

  // bölüm 3: ölçüm
  const measured = measurementsIn(ctx, p);
  const prevMeasured = compare ? measurementsIn(ctx, prev) : null;
  const headMeasure = { id: 'measure', title: t('section.measure'), description: t('section.measure.desc') };
  if (!measured.length) sections.push({ ...headMeasure, widgets: [emptyWidget(ctx, 'no-measurements', 'empty.measure.title', 'empty.measure.body')] });
  else {
    const seePeople = ctx.can(P.measurements);
    const noPhoto = measured.filter((m) => m.photos === 0).length;
    const items: HubKpi[] = [
      withPrev({ id: 'measured', label: t('kpi.measured'), value: measured.length, format: 'number', goodDirection: 'up', href: dataLink(ctx, 'measurements', {}, p) }, prevMeasured?.length, compare),
      withPrev({ id: 'coverage', label: t('kpi.coverage'), hint: t('kpi.coverage.hint'), value: coverage(total), format: 'percent', goodDirection: 'up', href: lineLink({ status: 'UNMATCHED' }) }, prevTotal ? coverage(prevTotal) : null, compare),
    ];
    if (seePeople) items.push({ id: 'no-photo', label: t('kpi.noPhoto'), value: noPhoto, format: 'number', goodDirection: 'down', href: dataLink(ctx, 'measurements', { photos: 'none' }, p) });
    const perDay = (list: Measurement[]) => {
      const map = new Map<string, number>();
      for (const m of list) map.set(m.at.slice(0, 10), (map.get(m.at.slice(0, 10)) ?? 0) + 1);
      return map;
    };
    const days = perDay(measured);
    const prevDays = prevMeasured ? perDay(prevMeasured) : null;
    const widgets: HubWidget[] = [
      { kind: 'kpis', id: 'measure-kpis', items },
      {
        kind: 'timeseries',
        id: 'measured-trend',
        title: t('widget.measureTrend'),
        chart: 'bar',
        format: 'number',
        series: [
          { id: 'current', label: t('common.thisPeriod'), role: 'current', points: bucketize(p, (d) => days.get(d) ?? 0, { today: ctx.today }) },
          ...(prevDays ? [{ id: 'previous', label: t('common.previousPeriod'), role: 'previous' as const, points: bucketize(prev, (d) => prevDays.get(d) ?? 0) }] : []),
        ],
      },
      {
        kind: 'breakdown',
        id: 'methods',
        title: t('widget.methods'),
        format: 'number',
        items: breakdown(ctx, METHODS.map((k) => [k, measured.filter((m) => m.method === k).length] as [string, number]), (k) => t(`method.${k}`), (k) => dataLink(ctx, 'measurements', { method: k }, p), (k) => k),
      },
    ];
    if (seePeople) {
      widgets.push({
        kind: 'table',
        id: 'operators',
        title: t('widget.operators'),
        columns: [
          { id: 'name', label: t('col.person'), format: 'text' },
          { id: 'count', label: t('col.parcels'), format: 'number' },
          { id: 'noPhoto', label: t('col.noPhoto'), format: 'number' },
          { id: 'corrected', label: t('col.corrected'), format: 'number' },
          { id: 'manualShare', label: t('col.manualShare'), format: 'percent' },
          { id: 'last', label: t('col.lastMeasurement'), format: 'datetime' },
        ],
        rows: USERS.map((u) => {
          const own = measured.filter((m) => m.userId === u.id);
          return { id: u.id, href: deciship.measurementsBy(u.id, p), cells: { name: u.name, count: own.length, noPhoto: own.filter((m) => m.photos === 0).length, corrected: own.filter((m) => m.version > 1).length, manualShare: pct(own.filter((m) => m.method === 'MANUAL').length, own.length), last: own.map((m) => m.at).sort().at(-1) ?? null } };
        }).filter((r) => (r.cells.count as number) > 0),
      });
    }
    sections.push({ ...headMeasure, widgets });
  }

  // bölüm 4: tarife sağlığı
  const tariffWidgets: HubWidget[] = [];
  if (money && total.lines) {
    const checked = lines.filter((l) => l.status !== 'NO_TARIFF').length;
    tariffWidgets.push({
      kind: 'kpis',
      id: 'tariff-kpis',
      items: [
        { id: 'tariff-ok', label: t('kpi.tariffOk'), hint: t('kpi.tariffOk.hint'), value: pct(checked - lines.filter((l) => l.types.includes('PRICE')).length, checked), format: 'percent', goodDirection: 'up' },
        { id: 'tariff-unchecked', label: t('kpi.tariffUnchecked'), value: total.noTariff, format: 'number', goodDirection: 'down' },
      ],
    });
    tariffWidgets.push({
      kind: 'table',
      id: 'tariff-deviations',
      title: t('widget.deviations'),
      description: t('widget.deviations.desc'),
      columns: [
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'country', label: t('col.country'), format: 'text' },
        { id: 'zone', label: t('col.zone'), format: 'text' },
        { id: 'service', label: t('col.service'), format: 'text' },
        { id: 'lines', label: t('col.lines'), format: 'number' },
        { id: 'deviation', label: t('col.deviation'), format: 'percent' },
        { id: 'status', label: t('col.status'), format: 'text' },
      ],
      rows: [
        { id: 'dev-1', carrier: 'car-fedex', country: 'DE', zone: 'E', service: 'FedEx International Economy', lines: 42, deviation: 6.8, status: 'health.pricier' },
        { id: 'dev-2', carrier: 'car-ups', country: 'GB', zone: '4', service: 'UPS Express Saver', lines: 18, deviation: -3.2, status: 'health.cheaper' },
      ].map((r) => {
        const href = lineLink({ carrier: r.carrier, country: r.country, service: r.service });
        return { id: r.id, ...(href ? { href } : {}), cells: { carrier: carrierName(r.carrier), country: countryName(r.country, ctx.locale), zone: r.zone, service: r.service, lines: r.lines, deviation: r.deviation, status: t(r.status) } };
      }),
    });
  }
  const suspects = invoices
    .map((i) => ({ i, compared: i.lines.filter((l) => l.status === 'MATCH' || l.status === 'DIFF').length, priceDiff: i.lines.filter((l) => l.types.includes('PRICE')).length }))
    .filter((s) => s.compared >= 5 && s.priceDiff / s.compared > 0.3)
    .sort((a, b) => b.priceDiff - a.priceDiff)
    .slice(0, 5);
  if (suspects.length) {
    const seeInvoices = ctx.can(P.invoices);
    tariffWidgets.push({
      kind: 'table',
      id: 'tariff-suspects',
      title: t('widget.suspect'),
      description: t('widget.suspect.desc'),
      columns: [
        { id: 'invoice', label: t('col.invoice'), format: 'text' },
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'date', label: t('col.date'), format: 'date' },
        { id: 'compared', label: t('col.compared'), format: 'number' },
        { id: 'priceDiff', label: t('col.priceDiffs'), format: 'number' },
      ],
      rows: suspects.map((s) => ({ id: s.i.id, ...(seeInvoices ? { href: deciship.invoice(s.i.id) } : {}), cells: { invoice: s.i.no, carrier: s.i.carrier.name, date: s.i.date, compared: s.compared, priceDiff: s.priceDiff } })),
    });
  }
  const status = tariffStatus(ctx).filter((s) => !f.carriers.length || f.carriers.includes(s.carrier.id));
  if (status.length) {
    tariffWidgets.push({
      kind: 'table',
      id: 'tariff-status',
      title: t('widget.tariffStatus'),
      description: t('widget.tariffStatus.desc'),
      columns: [
        { id: 'carrier', label: t('col.carrier'), format: 'text' },
        { id: 'tariff', label: t('col.tariff'), format: 'text' },
        { id: 'to', label: t('col.to'), format: 'date' },
        { id: 'daysLeft', label: t('col.daysLeft'), format: 'number' },
        { id: 'noTariff', label: t('col.noTariff'), format: 'number' },
      ],
      rows: status.map((s) => ({ id: s.carrier.id, href: s.tariff ? deciship.tariff(s.tariff.id) : deciship.tariffs(s.carrier.id), cells: { carrier: s.carrier.name, tariff: s.tariff?.name ?? null, to: s.tariff?.to ?? null, daysLeft: s.daysLeft, noTariff: lines.filter((l) => l.status === 'NO_TARIFF' && invoiceById.get(l.invoiceId)!.carrier.id === s.carrier.id).length } })),
    });
  }
  if (tariffWidgets.length) sections.push({ id: 'tariffs', title: t('section.tariffs'), description: t('section.tariffs.desc'), widgets: tariffWidgets });
  return plain({ ...head, sections });
}

// ---------- veri setleri ----------

export type DatasetParams = { page: number; pageSize: number; q: string; sort?: string; dir?: string; filters: Record<string, string[]> };

const sel = (ctx: Ctx, id: string, label: string, options: { value: string; label: string }[], multiple = false): HubFilterDef => ({ id, kind: 'select', label: ctx.t(label), options, ...(multiple ? { multiple } : {}) });
const txt = (ctx: Ctx, id: string, label: string): HubFilterDef => ({ id, kind: 'text', label: ctx.t(label) });
const STATUSES = ['MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF'] as const;
const DECISIONS = ['OPEN', 'VERIFIED', 'ACCEPTED'] as const;
const DIFF_TYPES = ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE', 'PACKAGING'] as const;
const DISPUTE_STATUSES = ['NONE', 'SENT', 'CLOSED'] as const;
const DIM_METHODS = ['LIDAR', 'AR', 'REFERENCE', 'MANUAL', 'PRESET'] as const;
const GROUPS = ['invoice', 'measurement', 'tariff', 'carrier', 'settings', 'export'] as const;
const DATASET_IDS = ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log'];
const BOX_PRESETS = [
  { id: 'bp1', name: 'K1', l: 30, w: 20, h: 15, active: true, measurements: 412 },
  { id: 'bp2', name: 'K2', l: 40, w: 30, h: 25, active: true, measurements: 268 },
  { id: 'bp3', name: 'K3', l: 50, w: 40, h: 30, active: true, measurements: 94 },
  { id: 'bp4', name: 'Eski koli', l: 60, w: 40, h: 40, active: false, measurements: 0 },
];
const DESI_DIVISOR = 5000;

export function datasetDefs(base: MockCtx): HubDatasetList {
  const ctx = ctxOf(base);
  const { t } = ctx;
  const money = ctx.can(P.prices);
  const carriers = CARRIERS.map((c) => ({ value: c.id, label: c.name }));
  const currencyOptions = ctx.empty ? [] : ['TRY', 'USD'].map((c) => ({ value: c, label: c }));
  const people = USERS.map((u) => ({ value: u.id, label: u.name }));
  const multiCurrency = currencyOptions.length > 1 && money;
  const active = () => sel(ctx, 'active', 'filter.active', [{ value: 'yes', label: t('filter.active.yes') }, { value: 'no', label: t('filter.active.no') }]);
  const defs: (Omit<HubDatasetDef, 'label' | 'description' | 'exportable'> & { requires?: string })[] = [
    {
      id: 'invoices',
      filters: [
        sel(ctx, 'carrier', 'filter.carrier', carriers, true),
        ...(multiCurrency ? [sel(ctx, 'currency', 'filter.currency', currencyOptions)] : []),
        sel(ctx, 'deadline', 'filter.deadline', [{ value: 'soon', label: t('filter.deadline.soon') }]),
        sel(ctx, 'dispute', 'filter.dispute', DISPUTE_STATUSES.map((v) => ({ value: v, label: t(`disputeStatus.${v}`) }))),
        txt(ctx, 'from', 'filter.from'),
        txt(ctx, 'to', 'filter.to'),
      ],
    },
    {
      id: 'invoice-lines',
      filters: [
        sel(ctx, 'carrier', 'filter.carrier', carriers, true),
        sel(ctx, 'status', 'filter.status', STATUSES.map((v) => ({ value: v, label: t(`status.${v}`) }))),
        sel(ctx, 'decision', 'filter.decision', DECISIONS.map((v) => ({ value: v, label: t(`decision.${v}`) }))),
        sel(ctx, 'diff', 'filter.diff', DIFF_TYPES.map((v) => ({ value: v, label: t(`diffType.${v}`) }))),
        ...(money ? [sel(ctx, 'confidence', 'filter.confidence', (['HIGH', 'LOW'] as const).map((v) => ({ value: v, label: t(`confidence.${v}`) })))] : []),
        sel(ctx, 'scope', 'filter.scope', [
          { value: 'in', label: t('filter.scope.in') },
          { value: 'pak', label: t('filter.scope.pak') },
        ]),
        ...(multiCurrency ? [sel(ctx, 'currency', 'filter.currency', currencyOptions)] : []),
        txt(ctx, 'country', 'filter.country'),
        txt(ctx, 'service', 'filter.service'),
        txt(ctx, 'from', 'filter.from'),
        txt(ctx, 'to', 'filter.to'),
      ],
    },
    {
      id: 'measurements',
      requires: P.measurements,
      filters: [
        sel(ctx, 'method', 'filter.method', DIM_METHODS.map((v) => ({ value: v, label: t(`method.${v}`) }))),
        sel(ctx, 'user', 'filter.user', people),
        sel(ctx, 'photos', 'filter.photos', [
          { value: 'none', label: t('filter.photos.none') },
          { value: 'some', label: t('filter.photos.some') },
        ]),
        txt(ctx, 'from', 'filter.from'),
        txt(ctx, 'to', 'filter.to'),
      ],
    },
    { id: 'tariffs', filters: [sel(ctx, 'carrier', 'filter.carrier', carriers, true), active()] },
    { id: 'carriers', filters: [active()] },
    { id: 'box-presets', filters: ctx.can(P.settings) ? [active()] : [] },
    { id: 'audit-log', requires: P.reports, filters: [sel(ctx, 'group', 'filter.group', GROUPS.map((g) => ({ value: g, label: t(`group.${g}`) })))] },
  ];
  const datasets: HubDatasetDef[] = defs
    .filter((d) => !d.requires || ctx.can(d.requires))
    .map(({ id, filters }) => ({ id, label: t(`dataset.${id}`), description: t(`dataset.${id}.desc`), filters, exportable: ctx.can(P.export) }));
  return { product: 'deciship', datasets };
}

type Spec = { columns: HubColumn[]; rows: HubRow[]; sortKeys: Record<string, (r: HubRow) => string | number | null> };

function moneyCols(single: string | undefined, forExport: boolean, defs: { id: string; label: string; sortable?: boolean }[]): HubColumn[] {
  return defs.map((d) => (single && !forExport ? { ...d, format: 'money' as const, currency: single, align: 'right' as const } : { ...d, format: forExport ? ('money' as const) : ('number' as const), align: 'right' as const }));
}

function specFor(id: string, ctx: Ctx, p: DatasetParams, forExport: boolean): Spec | null {
  const { t } = ctx;
  const money = ctx.can(P.prices);
  const f = p.filters;
  const w: World = ctx.empty ? { invoices: [], lines: [], measurements: [], tariffs: [] } : world(ctx.today);
  const q = p.q.trim().toLocaleLowerCase(ctx.locale);
  const has = (...v: (string | null | undefined)[]) => !q || v.some((x) => x?.toLocaleLowerCase(ctx.locale).includes(q));
  const inRange = (d: string) => (!f.from?.[0] || d >= f.from[0]) && (!f.to?.[0] || d <= f.to[0]);
  const byKey = (k: string) => (r: HubRow) => r.cells[k] ?? null;

  if (id === 'invoices') {
    const due = new Set(deadlines(ctx).map((d) => d.id));
    const list = w.invoices.filter((i) => (!f.carrier?.length || f.carrier.includes(i.carrier.id)) && (!f.currency?.[0] || i.currency === f.currency[0].toUpperCase()) && inRange(i.date) && (!f.deadline?.[0] || due.has(i.id)) && (!f.dispute?.[0] || disputeStatus(i) === f.dispute[0]) && has(i.no, i.carrier.name));
    const currencies = new Set(list.map((i) => i.currency));
    const single = currencies.size === 1 ? [...currencies][0] : undefined;
    const columns: HubColumn[] = [
      { id: 'no', label: t('col.invoice'), format: 'text', sortable: true },
      { id: 'carrier', label: t('col.carrier'), format: 'text', sortable: true },
      { id: 'date', label: t('col.date'), format: 'date', sortable: true },
      { id: 'lines', label: t('col.lines'), format: 'number', sortable: true },
      { id: 'match', label: t('col.match'), format: 'number' },
      { id: 'diff', label: t('col.diff'), format: 'number', sortable: true },
      { id: 'unmatched', label: t('col.unmatched'), format: 'number', sortable: true },
      { id: 'noTariff', label: t('col.noTariff'), format: 'number' },
      { id: 'lastDay', label: t('col.lastDay'), format: 'date' },
      { id: 'dispute', label: t('col.dispute'), format: 'text' },
      { id: 'sentOn', label: t('col.sentOn'), format: 'date' },
      ...(money
        ? [
            ...(single && !forExport ? [] : [{ id: 'currency', label: t('col.currency'), format: 'text' as const }]),
            ...moneyCols(single, forExport, [
              { id: 'billed', label: t('col.billed'), sortable: true },
              { id: 'overcharge', label: t('col.overcharge'), sortable: true },
              { id: 'verified', label: t('col.verified'), sortable: true },
              { id: 'recovered', label: t('col.recovered') },
              { id: 'estimated', label: t('col.estimated') },
            ]),
          ]
        : []),
    ];
    const rows: HubRow[] = list.map((i) => {
      const m = totals([i]);
      return {
        id: i.id,
        href: deciship.invoice(i.id, 'ALL'),
        cells: {
          no: i.no,
          carrier: i.carrier.name,
          date: i.date,
          lines: m.lines,
          match: m.match,
          diff: m.diff,
          unmatched: m.unmatched,
          noTariff: m.noTariff,
          lastDay: m.diff > 0 ? shift(i.date, TTK_DAYS) : null,
          dispute: t(`disputeStatus.${disputeStatus(i)}`),
          sentOn: i.sentOn,
          ...(money ? { currency: i.currency, billed: m.billed, overcharge: m.overcharge, verified: m.verified, recovered: m.recovered, estimated: m.estimated } : {}),
        },
      };
    });
    return { columns, rows, sortKeys: Object.fromEntries(['no', 'carrier', 'date', 'lines', 'diff', 'unmatched', ...(money ? ['billed', 'overcharge', 'verified'] : [])].map((k) => [k, byKey(k)])) };
  }
  if (id === 'invoice-lines') {
    const byId = new Map(w.invoices.map((i) => [i.id, i]));
    const list = w.lines.filter((l) => {
      const i = byId.get(l.invoiceId)!;
      if (!inRange(i.date)) return false;
      if (f.carrier?.length && !f.carrier.includes(i.carrier.id)) return false;
      if (f.currency?.[0] && i.currency !== f.currency[0].toUpperCase()) return false;
      if (f.status?.length && !f.status.includes(l.status)) return false;
      if (f.decision?.length && !f.decision.includes(l.decision)) return false;
      if (f.diff?.length && !l.types.some((x) => f.diff!.includes(x))) return false;
      if (f.scope?.[0] === 'pak' && !l.pak) return false;
      if (f.scope?.[0] === 'in' && l.pak) return false;
      if (money && f.confidence?.[0] === 'LOW' && !l.low) return false;
      if (money && f.confidence?.[0] === 'HIGH' && l.low) return false;
      if (f.country?.[0] && l.country !== f.country[0].trim().toUpperCase()) return false;
      if (f.service?.[0] && l.service !== f.service[0].trim()) return false;
      return has(l.tracking, i.no);
    });
    const currencies = new Set(list.map((l) => byId.get(l.invoiceId)!.currency));
    const single = currencies.size === 1 ? [...currencies][0] : undefined;
    const columns: HubColumn[] = [
      { id: 'tracking', label: t('col.tracking'), format: 'text', sortable: true },
      { id: 'carrier', label: t('col.carrier'), format: 'text', sortable: true },
      { id: 'invoice', label: t('col.invoice'), format: 'text', sortable: true },
      { id: 'date', label: t('col.shipDate'), format: 'date', sortable: true },
      { id: 'country', label: t('col.country'), format: 'text', sortable: true },
      { id: 'service', label: t('col.service'), format: 'text' },
      { id: 'status', label: t('col.status'), format: 'text', sortable: true },
      { id: 'types', label: t('col.diffType'), format: 'text' },
      { id: 'decision', label: t('col.decision'), format: 'text', sortable: true },
      { id: 'disputeOutcome', label: t('col.disputeOutcome'), format: 'text' },
      ...(money ? moneyCols(single, forExport, [{ id: 'recovered', label: t('col.recovered') }]) : []),
      { id: 'ourKg', label: t('col.ourKg'), format: 'number' },
      { id: 'billedKg', label: t('col.billedKg'), format: 'number', sortable: true },
      ...(money
        ? [
            ...(single && !forExport ? [] : [{ id: 'currency', label: t('col.currency'), format: 'text' as const }]),
            ...moneyCols(single, forExport, [
              { id: 'net', label: t('col.billed'), sortable: true },
              { id: 'expected', label: t('col.expected'), sortable: true },
              { id: 'diffAmount', label: t('col.diff'), sortable: true },
            ]),
            { id: 'confidence', label: t('col.confidence'), format: 'text' as const },
          ]
        : []),
    ];
    const rows: HubRow[] = list.map((l) => {
      const i = byId.get(l.invoiceId)!;
      return {
        id: l.id,
        href: deciship.invoiceLine(l.invoiceId, l.id, l.status),
        cells: {
          tracking: l.tracking,
          carrier: i.carrier.name,
          invoice: i.no,
          date: l.shipDate,
          country: l.country ? countryName(l.country, ctx.locale) : null,
          service: l.service,
          status: t(`status.${l.status}`),
          types: l.types.map((d) => t(`diffType.${d}`)).join(', ') || null,
          decision: l.status === 'DIFF' ? t(`decision.${l.decision}`) : null,
          disputeOutcome: l.dispute ? t(`disputeOutcome.${l.dispute.outcome}`) : null,
          ourKg: l.ourKg,
          billedKg: l.billedKg,
          ...(money ? { currency: i.currency, recovered: l.dispute?.recovered ?? null, net: l.net, expected: l.expected, diffAmount: l.diff, confidence: l.status === 'DIFF' ? t(l.low ? 'confidence.LOW' : 'confidence.HIGH') : null } : {}),
        },
      };
    });
    return { columns, rows, sortKeys: Object.fromEntries(['tracking', 'carrier', 'invoice', 'date', 'country', 'status', 'decision', 'billedKg', ...(money ? ['net', 'expected', 'diffAmount'] : [])].map((k) => [k, byKey(k)])) };
  }
  if (id === 'measurements') {
    if (!ctx.can(P.measurements)) return null;
    const list = w.measurements.filter((m) => inRange(m.at.slice(0, 10)) && (!f.method?.length || f.method.includes(m.method)) && (!f.user?.length || f.user.includes(m.userId)) && (f.photos?.[0] !== 'none' || m.photos === 0) && (f.photos?.[0] !== 'some' || m.photos > 0) && has(m.tracking));
    const name = (uid: string) => USERS.find((u) => u.id === uid)?.name ?? null;
    return {
      columns: [
        { id: 'tracking', label: t('col.tracking'), format: 'text', sortable: true },
        { id: 'method', label: t('col.method'), format: 'text', sortable: true },
        { id: 'dims', label: t('col.dims'), format: 'text' },
        { id: 'kg', label: t('col.kg'), format: 'number', sortable: true },
        { id: 'desi', label: t('col.desi'), format: 'number' },
        { id: 'by', label: t('col.measuredBy'), format: 'text' },
        { id: 'at', label: t('col.time'), format: 'datetime', sortable: true },
        { id: 'photos', label: t('col.photos'), format: 'number' },
        { id: 'version', label: t('col.version'), format: 'number' },
        { id: 'packaging', label: t('col.packaging'), format: 'text' },
      ],
      rows: list.map((m) => ({ id: m.id, href: deciship.measurement(m.id), cells: { tracking: m.tracking, method: t(`method.${m.method}`), dims: m.dims.join(' × '), kg: m.kg, desi: round2((Math.ceil(m.dims[0]) * Math.ceil(m.dims[1]) * Math.ceil(m.dims[2])) / 3000), by: name(m.userId), at: m.at, photos: m.photos, version: m.version, packaging: t(`packaging.${m.packaging}`) } })),
      sortKeys: Object.fromEntries(['tracking', 'method', 'kg', 'at'].map((k) => [k, byKey(k)])),
    };
  }
  if (id === 'tariffs') {
    const name = (cid: string) => CARRIERS.find((c) => c.id === cid)?.name ?? cid;
    const list = w.tariffs.filter((r) => (!f.carrier?.length || f.carrier.includes(r.carrierId)) && (!f.active?.[0] || (f.active[0] === 'yes') === r.active) && has(r.name, r.service, name(r.carrierId)));
    return {
      columns: [
        { id: 'name', label: t('col.tariff'), format: 'text', sortable: true },
        { id: 'carrier', label: t('col.carrier'), format: 'text', sortable: true },
        { id: 'service', label: t('col.service'), format: 'text' },
        { id: 'divisor', label: t('col.divisor'), format: 'number' },
        { id: 'from', label: t('col.from'), format: 'date', sortable: true },
        { id: 'to', label: t('col.to'), format: 'date', sortable: true },
        { id: 'rates', label: t('col.rates'), format: 'number' },
        { id: 'countries', label: t('col.countries'), format: 'number' },
        { id: 'active', label: t('col.active'), format: 'text' },
        { id: 'default', label: t('col.default'), format: 'text' },
        ...(money
          ? ([
              { id: 'currency', label: t('col.currency'), format: 'text' },
              { id: 'discount', label: t('col.discount'), format: 'percent' },
              { id: 'fuel', label: t('col.fuel'), format: 'percent' },
            ] as HubColumn[])
          : []),
      ],
      rows: list.map((r) => ({ id: r.id, href: deciship.tariff(r.id), cells: { name: r.name, carrier: name(r.carrierId), service: r.service, divisor: r.divisor, from: r.from, to: r.to, rates: r.rates, countries: r.countries, active: t(r.active ? 'common.yes' : 'common.no'), default: t(r.isDefault ? 'common.yes' : 'common.no'), ...(money ? { currency: r.currency, discount: r.discount, fuel: r.fuel } : {}) } })),
      sortKeys: Object.fromEntries(['name', 'carrier', 'from', 'to'].map((k) => [k, byKey(k)])),
    };
  }
  if (id === 'carriers') {
    const list = (ctx.empty ? [] : CARRIERS).filter((c) => (!f.active?.[0] || (f.active[0] === 'yes') === c.active) && has(c.name, c.code));
    return {
      columns: [
        { id: 'name', label: t('col.carrier'), format: 'text', sortable: true },
        { id: 'code', label: t('col.code'), format: 'text', sortable: true },
        { id: 'active', label: t('col.active'), format: 'text' },
        { id: 'tariffs', label: t('col.tariffs'), format: 'number' },
        { id: 'invoices', label: t('col.invoices'), format: 'number' },
        { id: 'lastInvoice', label: t('col.lastInvoice'), format: 'date' },
      ],
      rows: list.map((c) => {
        const own = w.invoices.filter((i) => i.carrier.id === c.id);
        return { id: c.id, href: deciship.tariffs(c.id), cells: { name: c.name, code: c.code, active: t(c.active ? 'common.yes' : 'common.no'), tariffs: w.tariffs.filter((x) => x.carrierId === c.id).length, invoices: own.length, lastInvoice: own.map((i) => i.date).sort().at(-1) ?? null } };
      }),
      sortKeys: Object.fromEntries(['name', 'code'].map((k) => [k, byKey(k)])),
    };
  }
  if (id === 'box-presets') {
    const manager = ctx.can(P.settings);
    const wanted = f.active?.[0];
    const list = (ctx.empty ? [] : BOX_PRESETS).filter((b) => (manager ? !wanted || (wanted === 'yes') === b.active : b.active && wanted !== 'no') && has(b.name));
    const seesUse = ctx.can(P.measurements);
    return {
      columns: [
        { id: 'name', label: t('col.boxPreset'), format: 'text', sortable: true },
        { id: 'lengthCm', label: t('col.lengthCm'), format: 'number', sortable: true },
        { id: 'widthCm', label: t('col.widthCm'), format: 'number', sortable: true },
        { id: 'heightCm', label: t('col.heightCm'), format: 'number', sortable: true },
        { id: 'desi', label: t('col.desi'), format: 'number' },
        { id: 'active', label: t('col.active'), format: 'text' },
        ...(seesUse ? [{ id: 'measurements', label: t('col.presetMeasurements'), format: 'number' as const }] : []),
        { id: 'sortOrder', label: t('col.sortOrder'), format: 'number', sortable: true, hiddenByDefault: true },
      ],
      rows: list.map((b, i) => ({
        id: b.id,
        ...(manager ? { href: deciship.settings } : {}),
        cells: { name: b.name, lengthCm: b.l, widthCm: b.w, heightCm: b.h, desi: round2((Math.ceil(b.l) * Math.ceil(b.w) * Math.ceil(b.h)) / DESI_DIVISOR), active: t(b.active ? 'common.yes' : 'common.no'), ...(seesUse ? { measurements: b.measurements } : {}), sortOrder: i },
      })),
      sortKeys: Object.fromEntries(['name', 'lengthCm', 'widthCm', 'heightCm', 'sortOrder'].map((k) => [k, byKey(k)])),
    };
  }
  if (id === 'audit-log') {
    if (!ctx.can(P.reports)) return null;
    const list = activityItems(ctx).filter((a) => (!f.group?.[0] || a.group === f.group[0]) && has(a.item.actor, a.item.action, a.item.target));
    return {
      columns: [
        { id: 'at', label: t('col.time'), format: 'datetime', sortable: true },
        { id: 'actor', label: t('col.actor'), format: 'text' },
        { id: 'action', label: t('col.action'), format: 'text' },
        { id: 'target', label: t('col.target'), format: 'text' },
      ],
      rows: list.map(({ item }) => ({ id: item.id, ...(item.href ? { href: item.href } : {}), cells: { at: item.at, actor: item.actor, action: item.action, target: item.target ?? null } })),
      sortKeys: { at: byKey('at') },
    };
  }
  return null;
}

function sorted(spec: Spec, p: DatasetParams, locale: Locale): HubRow[] {
  const key = p.sort ? spec.sortKeys[p.sort] : undefined;
  if (!key) return spec.rows;
  const dir = p.dir === 'asc' ? 1 : -1;
  return [...spec.rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), locale)) * dir;
  });
}

export function datasetPage(id: string, p: DatasetParams, base: MockCtx): HubDatasetPage | 'forbidden' | null {
  const ctx = ctxOf(base);
  if (!DATASET_IDS.includes(id)) return null;
  const spec = specFor(id, ctx, p, false);
  if (!spec) return 'forbidden';
  const rows = sorted(spec, p, ctx.locale);
  const start = (p.page - 1) * p.pageSize;
  const columnIds = new Set(spec.columns.map((c) => c.id));
  const trimmed = rows.slice(start, start + p.pageSize).map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => columnIds.has(k))) }));
  // Tutarlar öne: API'ye iletilen sıra. Kolon kümesi aynı (sözleşme testi).
  const isAmount = (c: HubColumn) => c.align === 'right' && c.format === 'number';
  // Gerçek uç gibi: karışık sayfada `currencyCell`, seçilmeyen sütunlar `hiddenByDefault`.
  const withFlags = spec.columns.map((c) => ({ ...c, ...(isAmount(c) && spec.columns.some((x) => x.id === 'currency') ? { currencyCell: 'currency' } : {}), ...(c.id === 'match' || c.id === 'noTariff' ? { hiddenByDefault: true } : {}) }));
  const columns = [...withFlags.slice(0, 2), ...withFlags.slice(2).filter(isAmount), ...withFlags.slice(2).filter((c) => !isAmount(c))];
  return { id, columns, rows: trimmed, page: p.page, pageSize: p.pageSize, total: rows.length };
}

export function datasetCsv(id: string, p: DatasetParams, base: MockCtx): string | 'forbidden' | null {
  const ctx = ctxOf(base);
  if (!DATASET_IDS.includes(id)) return null;
  const spec = specFor(id, ctx, p, true);
  if (!spec) return 'forbidden';
  const rows = sorted(spec, p, ctx.locale);
  const sep = ctx.locale === 'tr' ? ';' : ',';
  const lines = [spec.columns.map((c) => c.label).join(sep), ...rows.map((r) => spec.columns.map((c) => r.cells[c.id] ?? '').join(sep))];
  return `\uFEFF${lines.join('\r\n')}`;
}

// ---------- etkinlik ----------

function activityItems(ctx: Ctx): { group: string; item: HubActivityItem }[] {
  if (ctx.empty) return [];
  const { t } = ctx;
  const w = world(ctx.today);
  const out: { group: string; item: HubActivityItem }[] = [];
  const actors = ['Selin Aydın', 'Elif Şahin', 'Zeynep Arslan', 'Can Yıldız'];
  w.invoices.slice(0, 40).forEach((i, n) => {
    const at = (h: number) => new Date(Date.parse(`${i.date}T09:00:00.000Z`) + h * 3_600_000).toISOString();
    out.push({ group: 'invoice', item: { id: `a-imp-${i.id}`, at: at(1 + (n % 5)), actor: actors[n % 2]!, action: t('activity.invoice.import'), target: `${i.carrier.name} ${i.no}`, href: deciship.invoice(i.id, 'ALL') } });
    const decided = i.lines.find((l) => l.status === 'DIFF' && l.decision !== 'OPEN');
    if (decided) out.push({ group: 'invoice', item: { id: `a-dec-${decided.id}`, at: at(24 + (n % 7)), actor: actors[2]!, action: t(`activity.invoiceLine.decision.${decided.decision}`), target: decided.tracking, href: deciship.invoiceLine(i.id, decided.id, decided.status) } });
    // İtiraz izleri faturaya yazılır (services/disputes.ts audit 'Invoice'): hedef fatura, bağlantı fatura.
    const on = (day: string, h: number) => new Date(Date.parse(`${day}T09:00:00.000Z`) + h * 3_600_000).toISOString();
    const invoiceTarget = { target: `${i.carrier.name} ${i.no}`, href: deciship.invoice(i.id, 'ALL') };
    if (i.sentOn) out.push({ group: 'invoice', item: { id: `a-dsp-${i.id}`, at: on(i.sentOn, 2), actor: actors[3]!, action: t('activity.dispute.send'), ...invoiceTarget } });
    if (i.resultOn) {
      const outcomes = new Set(i.lines.map((l) => l.dispute?.outcome));
      if (outcomes.has('RECOVERED')) out.push({ group: 'invoice', item: { id: `a-dsr-${i.id}`, at: on(i.resultOn, 3), actor: actors[3]!, action: t('activity.dispute.recovered'), ...invoiceTarget } });
      if (outcomes.has('REJECTED')) out.push({ group: 'invoice', item: { id: `a-dsj-${i.id}`, at: on(i.resultOn, 4), actor: actors[3]!, action: t('activity.dispute.rejected'), ...invoiceTarget } });
    }
  });
  w.measurements
    .filter((m) => m.version > 1)
    .slice(0, 20)
    .forEach((m) => {
      out.push({ group: 'measurement', item: { id: `a-cor-${m.id}`, at: m.at, actor: USERS.find((u) => u.id === m.userId)!.name, action: t('activity.measurement.correct'), target: m.tracking, href: deciship.measurement(m.id) } });
    });
  w.tariffs.forEach((r, n) => {
    out.push({ group: 'tariff', item: { id: `a-tar-${r.id}`, at: new Date(Date.parse(`${ctx.today}T09:00:00.000Z`) - (n * 11 + 30) * 3_600_000).toISOString(), actor: actors[1]!, action: t('activity.tariff.update'), target: r.name, href: deciship.tariff(r.id) } });
  });
  out.push({ group: 'export', item: { id: 'a-exp-1', at: new Date(Date.parse(`${ctx.today}T09:00:00.000Z`) - 20 * 3_600_000).toISOString(), actor: actors[3]!, action: t('activity.data.export'), target: t('dataset.invoice-lines'), href: dataLink(ctx, 'invoice-lines', {}) } });
  return out.sort((a, b) => b.item.at.localeCompare(a.item.at));
}

export function activityPage(page: number, pageSizeRaw: number | undefined, base: MockCtx): HubActivityPage {
  const ctx = ctxOf(base);
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 25));
  const all = activityItems(ctx);
  return plain({ items: all.slice((page - 1) * pageSize, page * pageSize).map((a) => a.item), page, pageSize, total: all.length });
}

export const MAX_EXPORT_ROWS = 100_000;
export function tooLargeMessage(base: MockCtx, total: number): string {
  return ctxOf(base).t('err.exportTooLarge', { total, max: MAX_EXPORT_ROWS });
}

// ---------- yapay zekâ kullanımı (Mesaj 6) ve ayrıntılı döküm ----------
// Tek örnek çağrı listesinden hesaplanır: özet (`aiUsage`), döküm (`aiCalls`) ve Excel aynı satırları sayar.
// `localStorage.sod_mock_ai_usage`: `exhausted` bu ay hak dolu, `none` uç yok (404), `empty` bu ay hiç kullanım yok.

/** Örnek firma 6 ay önce açıldı: seçilebilir en eski ay (`firstPeriod`; gerçek uçta en çok 12 ay geri). */
const AI_HISTORY = 6;
/** Ay geriye göre hacim; 0: o ay hiç kullanım yok ("kullanım yok" ayı). */
const AI_VOLUME = [1, 1.2, 0.9, 0.6, 0.8, 0, 0.3];
const AI_FREE = 500;
const AI_MODEL = 'claude-sonnet-5-5';
const AI_FALLBACK_MODEL = 'claude-opus-5';
const HOUR = 3_600_000;
/** Örnek firmanın saat dilimi İstanbul (UTC+3, yaz saati yok): ay ve gün sınırı oradan. */
const TZ_SHIFT = 3 * HOUR;

type AiKindSpec = { kind: string; perDay: number; input: [number, number]; output: [number, number]; cache: number; seconds: [number, number]; people: (string | null)[]; record: 'invoice' | 'mapping' | 'tariff' | null };
const AI_KINDS: AiKindSpec[] = [
  { kind: 'INVOICE_PDF', perDay: 3, input: [15_000, 25_000], output: [2_400, 4_400], cache: 0.5, seconds: [18, 65], people: ['m5', 'm5', 'm7', null], record: 'invoice' },
  { kind: 'SCALE_READ', perDay: 7, input: [1_800, 2_050], output: [12, 80], cache: 0, seconds: [2, 4], people: ['m6', 'm6', 'm7'], record: null },
  { kind: 'INVOICE_MAPPING', perDay: 0.8, input: [5_200, 7_000], output: [700, 1_000], cache: 0.3, seconds: [7, 12], people: ['m5', 'm7'], record: 'mapping' },
  { kind: 'TARIFF_PDF_EXTRACT', perDay: 0.35, input: [34_000, 46_000], output: [6_000, 8_200], cache: 0.6, seconds: [75, 110], people: ['m5'], record: 'tariff' },
  { kind: 'TARIFF_REVIEW', perDay: 0.25, input: [7_800, 10_000], output: [900, 1_500], cache: 0.6, seconds: [9, 16], people: ['m5'], record: 'tariff' },
];
/** `kind` süzgecinin geçerli değerleri: gerçek sözlükteki bütün türler (örnek veride görünmeyen tarama dahil). */
export const AI_CALL_KINDS = [...AI_KINDS.map((k) => k.kind), 'TARIFF_PDF_DISCOVER'];

type AiRow = {
  id: string;
  at: number;
  memberId: string | null;
  kind: string;
  record: { kind: 'invoice' | 'tariff'; id: string; name: string } | null;
  status: HubAiCallStatus;
  estimated: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  durationMs: number;
  servedModel: string | null;
  cost: number;
  rate: number;
  priceVersion: string;
};
type AiForce = { status: HubAiCallStatus; estimated?: boolean; memberId: string | null };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const periodOfMs = (ms: number) => new Date(ms + TZ_SHIFT).toISOString().slice(0, 7);
const periodParts = (p: string) => p.split('-').map(Number) as [number, number];
const addMonths = (p: string, n: number) => {
  const [y, m] = periodParts(p);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
/** `b` ayı `a` ayından kaç ay sonra. */
const monthsAfter = (a: string, b: string) => {
  const [ya, ma] = periodParts(a);
  const [yb, mb] = periodParts(b);
  return (yb - ya) * 12 + (mb - ma);
};
/** Ayın ilk anı (İstanbul gece yarısı), UTC ms. */
const monthStartMs = (p: string) => {
  const [y, m] = periodParts(p);
  return Date.UTC(y, m - 1, 1) - TZ_SHIFT;
};
const aiMode = () => (typeof localStorage === 'undefined' ? '' : (localStorage.getItem('sod_mock_ai_usage') ?? ''));
const lerp = ([a, b]: [number, number], r: number) => a + (b - a) * r;

function aiWindow(ctx: Ctx, now: Date) {
  const current = periodOfMs(now.getTime());
  // Boş (yeni) firma bu ay açıldı: seçilebilir tek ay bu ay.
  return { current, first: ctx.empty ? current : addMonths(current, -AI_HISTORY) };
}

/** Geçerli biçimde ve seçilebilir pencerede mi (gerçek uç dışını 400 VALIDATION ile reddeder). */
export function aiPeriodOk(period: string, base: MockCtx): boolean {
  if (!PERIOD_RE.test(period)) return false;
  const w = aiWindow(ctxOf(base), base.now ?? new Date());
  return period <= w.current && period >= w.first;
}

const aiCache = new Map<string, AiRow[]>();

function aiDraft(k: AiKindSpec, at: number, s: number, env: { rate: number; priceVersion: string; invoices: Invoice[]; tariffs: Tariff[] }, force?: AiForce): Omit<AiRow, 'id'> {
  const r = noise(s + 2);
  const status: HubAiCallStatus =
    force?.status ??
    (k.kind === 'SCALE_READ' ? (r < 0.04 ? 'refused' : 'ok') : k.kind === 'INVOICE_PDF' ? (r < 0.03 ? 'truncated' : r < 0.05 ? 'failed' : r < 0.07 ? 'refused' : 'ok') : r < 0.02 ? 'failed' : 'ok');
  const failed = status === 'failed';
  const input = failed ? 0 : Math.round(lerp(k.input, noise(s + 3)));
  const fullOut = Math.round(lerp(k.output, noise(s + 4)));
  const output = failed ? 0 : status === 'refused' ? Math.min(fullOut, 20 + Math.round(noise(s + 4) * 30)) : status === 'truncated' ? Math.round(fullOut * 0.7) : fullOut;
  const cacheRead = !failed && noise(s + 5) < k.cache ? Math.round(input * 0.6) : 0;
  const cacheWrite = !failed && !cacheRead && noise(s + 6) < k.cache * 0.4 ? Math.round(input * 0.4) : 0;
  // Fiyat tablosu (USD / 1M token): giren 3, çıkan 15, önbellekten okunan 0,3, önbelleğe yazılan 3,75; kur satır yazılırkenki.
  const usd = (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000;
  const memberId = force ? force.memberId : (k.people[Math.floor(noise(s + 8) * k.people.length)] ?? null);
  let record: AiRow['record'] = null;
  if (k.record && noise(s + 12) >= 0.05) {
    if (k.record === 'tariff') {
      const t = env.tariffs[Math.floor(noise(s + 11) * env.tariffs.length)]!;
      record = { kind: 'tariff', id: t.id, name: `${t.name}.pdf` };
    } else {
      const inv = env.invoices[Math.floor(noise(s + 11) * env.invoices.length)]!;
      record = { kind: 'invoice', id: inv.id, name: k.record === 'mapping' ? `${inv.carrier.code}_fatura_${inv.no}.xlsx` : `${inv.carrier.code.toUpperCase()}_${inv.no}.pdf` };
    }
  }
  return {
    at,
    memberId,
    kind: k.kind,
    record,
    status,
    estimated: force?.estimated ?? (status === 'truncated' && noise(s + 9) < 0.6),
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    durationMs: failed ? 60_000 : Math.round(lerp(k.seconds, noise(s + 7)) * 1000),
    servedModel: failed ? null : noise(s + 10) < 0.03 ? AI_FALLBACK_MODEL : AI_MODEL,
    cost: round2(usd * env.rate),
    rate: env.rate,
    priceVersion: env.priceVersion,
  };
}

function aiRows(period: string, ctx: Ctx, now: Date, mode: string): AiRow[] {
  const { current } = aiWindow(ctx, now);
  const back = monthsAfter(period, current);
  if (ctx.empty || back < 0 || back > AI_HISTORY || (mode === 'empty' && back === 0)) return [];
  const key = `${period}|${mode}|${ctx.today}|${Math.floor(now.getTime() / 60_000)}`;
  const hit = aiCache.get(key);
  if (hit) return hit;
  const volume = AI_VOLUME[back] ?? 0;
  const start = monthStartMs(period);
  const end = Math.min(monthStartMs(addMonths(period, 1)), now.getTime());
  const { invoices, tariffs } = world(ctx.today);
  // Kur her ay biraz değişir; fiyat tablosu özeti satırın fiyatlandığı tablonun ayı.
  const env = { rate: Math.round((34.2 - back * 0.35) * 10) / 10, priceVersion: addMonths(period, back === 0 ? -1 : 0), invoices, tariffs };
  const seedBase = Number(period.replace('-', ''));
  const rows: Omit<AiRow, 'id'>[] = [];
  if (volume > 0) {
    const days = Math.ceil((end - start) / DAY);
    for (let d = 0; d < days; d++) {
      const dayStart = start + d * DAY;
      const weekday = new Date(dayStart + TZ_SHIFT).getUTCDay();
      if (weekday === 0) continue;
      const dayFactor = weekday === 6 ? 0.4 : 1;
      AI_KINDS.forEach((k, ki) => {
        const s0 = seedBase * 1_000 + d * 37 + ki * 7_919;
        const n = Math.floor(k.perDay * volume * dayFactor + noise(s0));
        for (let i = 0; i < n; i++) {
          const s = s0 * 13 + i * 101;
          const at = Math.round(dayStart + (8 + noise(s + 1) * 10) * HOUR);
          if (at < end) rows.push(aiDraft(k, at, s, env));
        }
      });
    }
  }
  if (back === 0) {
    // Bu ayın en yeni satırlarında her sonuç görünsün (ay başında da): yarıda kalan (tahmini), okunamayan, başarısız, silinmiş kişi.
    const pin = (minutesAgo: number, kind: string, s: number, force: AiForce) => {
      const at = Math.max(start + 60_000, now.getTime() - minutesAgo * 60_000);
      rows.push(aiDraft(AI_KINDS.find((k) => k.kind === kind)!, at, s, env, force));
    };
    pin(35, 'INVOICE_PDF', 91_001, { status: 'truncated', estimated: true, memberId: 'm5' });
    pin(95, 'SCALE_READ', 91_002, { status: 'refused', memberId: 'm6' });
    pin(170, 'INVOICE_PDF', 91_003, { status: 'failed', memberId: 'm7' });
    pin(260, 'INVOICE_MAPPING', 91_004, { status: 'ok', memberId: null });
  }
  if (back === 0 && mode === 'exhausted') {
    // Dolu hâl: başarılı çağrıların toplamı aylık hakkı aşar (512,35 ₺ / 500 ₺).
    const ok = rows.reduce((a, r) => a + (r.status === 'ok' ? r.cost : 0), 0) || 1;
    for (const r of rows) r.cost = round2((r.cost * 512.35) / ok);
  }
  rows.sort((a, b) => b.at - a.at);
  const out = rows.map((r, i) => ({ ...r, id: `ai-${period}-${String(rows.length - i).padStart(4, '0')}` }));
  aiCache.set(key, out);
  return out;
}

const aiPerson = (ctx: Ctx, memberId: string | null) => (memberId ? (USERS.find((u) => u.id === memberId)?.name ?? ctx.t('aiUsage.member.unknown')) : ctx.t('aiUsage.member.unknown'));

/** Gerçek uç gibi: kayıt adı ve bağlantısı yalnız kişi o kaydı görebiliyorsa; para alanları yalnız fiyat izniyle. */
function aiCallView(r: AiRow, ctx: Ctx, money: boolean): HubAiCall {
  const seeRecord = !!r.record && (r.record.kind === 'invoice' ? ctx.can(P.invoices) : ctx.can('deciship.tariffs.view'));
  const href = r.record ? (r.record.kind === 'invoice' ? deciship.invoice(r.record.id, 'ALL') : deciship.tariff(r.record.id)) : undefined;
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    memberId: r.memberId,
    person: aiPerson(ctx, r.memberId),
    kind: r.kind,
    label: ctx.t(`aiUsage.kind.${r.kind}`),
    ...(seeRecord ? { record: r.record!.name, href } : {}),
    status: r.status,
    errorCode: r.status === 'ok' ? null : r.status === 'refused' ? 'AI_REFUSED' : r.status === 'truncated' ? 'AI_TRUNCATED' : 'AI_UNAVAILABLE',
    estimated: r.estimated,
    tokens: { ...r.tokens },
    durationMs: r.durationMs,
    model: AI_MODEL,
    servedModel: r.servedModel,
    ...(money ? { amount: r.cost } : {}),
    deducted: r.status === 'ok',
    ...(money ? { priceVersion: r.priceVersion, priceUsdRate: r.rate } : {}),
  } as HubAiCall;
}

const sumOf = (rows: AiRow[], f: (r: AiRow) => number) => rows.reduce((a, r) => a + f(r), 0);
const deductedOf = (rows: AiRow[]) => round2(sumOf(rows, (r) => (r.status === 'ok' ? r.cost : 0)));
/** Önceki sonuçtan gelen ücretsiz işlemler listede yok; sayısı satırlardan türetilir (yaklaşık %4, çoğu m5, kalanı m6). */
const cachedOf = (rows: AiRow[], memberId?: string | null) => {
  const total = Math.round(rows.length * 0.04);
  if (memberId === undefined) return total;
  return memberId === 'm5' ? Math.ceil(total * 0.7) : memberId === 'm6' ? total - Math.ceil(total * 0.7) : 0;
};

/**
 * `GET /api/deciship/platform/ai-usage[?period=YYYY-MM]` yanıtı (dönem verilmezse bu ay). `none`: null (uç 404 versin).
 * Para alanları (`*Amount`, `byKind[].amount`, `byMember[].amount`, `previous.usedAmount`) yalnız fiyat izni olana gider.
 * Tür ve kişi tutarları haktan düşen (başarılı) çağrıların toplamıdır: toplamları `usedAmount`.
 */
export function aiUsage(base: MockCtx, period?: string): HubAiUsage | null {
  const mode = aiMode();
  if (mode === 'none') return null;
  const ctx = ctxOf(base);
  const now = base.now ?? new Date();
  const { current, first } = aiWindow(ctx, now);
  const p = period ?? current;
  const rows = aiRows(p, ctx, now, mode);
  const money = ctx.can(P.prices);
  const used = deductedOf(rows);
  const tokensOf = (list: AiRow[]) => sumOf(list, (r) => r.tokens.total);
  const kinds = AI_KINDS.map((k) => ({ kind: k.kind, list: rows.filter((r) => r.kind === k.kind) })).filter((k) => k.list.length > 0);
  kinds.sort((a, b) => tokensOf(b.list) - tokensOf(a.list));
  const memberIds = [...new Set(rows.map((r) => r.memberId))];
  const members = memberIds.map((id) => ({ id, list: rows.filter((r) => r.memberId === id) })).sort((a, b) => tokensOf(b.list) - tokensOf(a.list));
  const status = (s: HubAiCallStatus) => rows.filter((r) => r.status === s).length;
  // Geçen ayın aynı süresi: bu ay seçiliyse geçen ayın başından bugünkü ana kadar, geçmiş ay seçiliyse önceki ayın tamamı.
  const prevP = addMonths(p, -1);
  const prevFrom = monthStartMs(prevP);
  const prevTo = p === current ? Math.min(monthStartMs(p), prevFrom + (now.getTime() - monthStartMs(p))) : monthStartMs(p);
  const prevRows = aiRows(prevP, ctx, now, mode).filter((r) => r.at < prevTo);
  const months = Array.from({ length: monthsAfter(first, current) + 1 }, (_, i) => {
    const mp = addMonths(current, -i);
    return { period: mp, calls: aiRows(mp, ctx, now, mode).length };
  });
  return plain({
    product: 'deciship',
    period: p,
    periodStart: new Date(monthStartMs(p)).toISOString(),
    resetsAt: new Date(monthStartMs(addMonths(p, 1))).toISOString(),
    currency: 'TRY',
    enforced: true,
    ...(money ? { freeAmount: AI_FREE, creditAmount: 0, allowanceAmount: AI_FREE, usedAmount: used, remainingAmount: Math.max(0, round2(AI_FREE - used)) } : {}),
    usedPct: Math.round((used / AI_FREE) * 100),
    exhausted: used >= AI_FREE,
    tokens: {
      input: sumOf(rows, (r) => r.tokens.input),
      output: sumOf(rows, (r) => r.tokens.output),
      cacheRead: sumOf(rows, (r) => r.tokens.cacheRead),
      cacheWrite: sumOf(rows, (r) => r.tokens.cacheWrite),
      total: tokensOf(rows),
    },
    calls: rows.length,
    cachedCalls: cachedOf(rows),
    durationMs: sumOf(rows, (r) => r.durationMs),
    byKind: kinds.map((k) => ({ kind: k.kind, label: ctx.t(`aiUsage.kind.${k.kind}`), calls: k.list.length, tokens: tokensOf(k.list), ...(money ? { amount: deductedOf(k.list) } : {}), durationMs: sumOf(k.list, (r) => r.durationMs) })),
    estimatedCalls: rows.filter((r) => r.estimated).length,
    byMember: members.map((m) => ({ memberId: m.id, name: aiPerson(ctx, m.id), calls: m.list.length, cachedCalls: cachedOf(rows, m.id), tokens: tokensOf(m.list), ...(money ? { amount: deductedOf(m.list) } : {}) })),
    statusCounts: { ok: status('ok'), refused: status('refused'), truncated: status('truncated'), failed: status('failed') },
    previous: { period: prevP, from: new Date(prevFrom).toISOString(), to: new Date(prevTo).toISOString(), calls: prevRows.length, tokens: tokensOf(prevRows), ...(money ? { usedAmount: deductedOf(prevRows) } : {}) },
    months,
    firstPeriod: first,
  }) as unknown as HubAiUsage;
}

export type AiCallsQuery = { period?: string; kind?: string; member?: string; page: number; pageSize: number };

function aiFiltered(q: Omit<AiCallsQuery, 'page' | 'pageSize'>, ctx: Ctx, now: Date, mode: string) {
  const p = q.period ?? aiWindow(ctx, now).current;
  let rows = aiRows(p, ctx, now, mode);
  if (q.kind) rows = rows.filter((r) => r.kind === q.kind);
  if (q.member) rows = rows.filter((r) => (q.member === HUB_AI_MEMBER_NONE ? r.memberId === null : r.memberId === q.member));
  return { period: p, rows };
}

/** `GET /api/deciship/platform/ai-usage/calls`: en yeni önce. `none`: null (uç 404 versin). Süzgeç ve dönem denetimi işleyicide. */
export function aiCalls(q: AiCallsQuery, base: MockCtx): HubAiCallPage | null {
  const mode = aiMode();
  if (mode === 'none') return null;
  const ctx = ctxOf(base);
  const { period: p, rows } = aiFiltered(q, ctx, base.now ?? new Date(), mode);
  const money = ctx.can(P.prices);
  const page: HubAiCallPage = {
    product: 'deciship',
    period: p,
    currency: 'TRY',
    page: q.page,
    pageSize: q.pageSize,
    total: rows.length,
    items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((r) => aiCallView(r, ctx, money)),
  };
  return plain(page);
}

/**
 * `GET …/ai-usage/calls/export`: gerçek uçtaki dosya adı (isteğin dilinde). İçerik yalnız örnek: taklit gerçek xlsx üretmez,
 * satırları sekmeyle ayrılmış metin olarak yazar (dosya adı ve indirme akışı denensin diye).
 */
export function aiCallsExport(q: Omit<AiCallsQuery, 'page' | 'pageSize'>, base: MockCtx): { name: string; body: string } | null {
  const mode = aiMode();
  if (mode === 'none') return null;
  const ctx = ctxOf(base);
  const { period: p, rows } = aiFiltered(q, ctx, base.now ?? new Date(), mode);
  const name = base.locale === 'en' ? `deciship-ai-usage-${p}.xlsx` : `deciship-yapay-zeka-${p}.xlsx`;
  const body = rows.map((r) => [new Date(r.at).toISOString(), aiPerson(ctx, r.memberId), ctx.t(`aiUsage.kind.${r.kind}`), r.tokens.input, r.tokens.output, r.status].join('\t')).join('\n');
  return { name, body };
}

/**
 * Döküm ve Excel sorgusu (gerçek uç gibi): dönem biçimi ve penceresi, bilinen tür, `none` ya da bilinen kişi, sayfa 1+,
 * sayfa boyu 1..200. Geçersizse null (işleyici 400 VALIDATION döner).
 */
export function aiCallsParams(url: URL, base: MockCtx): AiCallsQuery | null {
  const sp = url.searchParams;
  const period = sp.get('period') || undefined;
  const kind = sp.get('kind') || undefined;
  const member = sp.get('member') || undefined;
  const page = sp.has('page') ? Number(sp.get('page')) : 1;
  const pageSize = sp.has('pageSize') ? Number(sp.get('pageSize')) : 50;
  if (period && !aiPeriodOk(period, base)) return null;
  if (kind && !AI_CALL_KINDS.includes(kind)) return null;
  if (member && member !== HUB_AI_MEMBER_NONE && !USERS.some((u) => u.id === member)) return null;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) return null;
  return { period, kind, member, page, pageSize };
}
