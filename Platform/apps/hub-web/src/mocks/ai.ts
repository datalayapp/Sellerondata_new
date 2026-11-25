// Yalnız VITE_MOCK=1 ve `npm test`. Yapay zekâ geçidinin Merkez uçlarının sahte hâli (sözleşme `contracts/src/aiSpend.ts`, gerçek uç
// `Platform/apps/ai-api/src/routes/{spend,admin,admin-keys}.ts`) ve Hesap'ın adım artırma ucu (`POST /api/account/operator/step-up`).
// Veri örnektir: firma, gün ve sıra numarasından türeyen sabit çağrılar (aynı gün aynı sayı). İş kuralı (tavan kararı, pay ayırma) yok;
// yalnız sözleşmenin biçimi ve kapıları: firma görünümü OWNER/ADMIN, `scope=platform` ve `/admin/*` platform yöneticisi, değiştiren
// yönetici uçları adım artırma jetonu.
//
// Test kancaları (localStorage):
//   `sod_mock_ai_empty`  hiç çağrı yok (boş durum)
//   `sod_mock_ai_paused` platform durdurulmuş başlar (durdurma bandı)
//   `sod_mock_ai_capped` firmanın aylık hakkı dolmuş (hak bandı)
//   `sod_mock_fail` içinde `ai.summary`, `ai.calls`, `ai.allowance`, `ai.admin` → 500
// Platform yöneticisi: `sod_mock_db` içinde kişinin `platformOperator: true` (e-postası doğrulanmış olmalı; Hesap kuralı).
import { http, HttpResponse } from 'msw';
import {
  AI_CALL_STATUSES,
  AI_LIMIT_DEFAULTS,
  AI_PROVIDERS,
  AI_SPEND_CALL_COLUMNS,
  AI_SPEND_CALLS_PAGE_SIZE,
  AI_SPEND_CALLS_PAGE_SIZE_MAX,
  AI_SPEND_MAX_MONTHS_BACK,
  AI_SPEND_MEMBER_NONE,
  AI_SPEND_PATHS,
  AI_SPEND_PRODUCT,
  AI_SPEND_SECTIONS,
  AI_SPEND_WIDGETS,
  AI_TRY_PER_USD_DEFAULT,
  OPERATOR_STEP_UP_TTL_SECONDS,
  PRODUCTS,
  STEP_UP_HEADER,
  aiCostMicroUsd,
  aiMicrosToAmount,
  aiMicroUsdToMicroTry,
  aiPriceFor,
  aiProductKeys,
  aiPurposeLabel,
  localeFromAcceptLanguage,
  type AiAdminKey,
  type AiAdminLimits,
  type AiAdminOrgRow,
  type AiAdminStatus,
  type AiAllowanceState,
  type AiCallStatus,
  type AiOrgAllowanceView,
  type AiProvider,
  type AiProviderState,
  type AiSpendCallColumn,
  type ApiErrorCode,
  type HubColumn,
  type HubDatasetPage,
  type HubFilterDef,
  type HubKpi,
  type HubSection,
  type HubWidget,
  type Locale,
  type ProductKey,
} from '@sellerondata/contracts';
import { shouldFail, type MockDb, type MockMembership, type MockPerson } from './db.ts';

type AuthCtx = { db: MockDb; person: MockPerson; membership: MockMembership | null };
/** `handlers.ts`'in ortak yardımcıları (döngüsel içe aktarma olmasın diye dışarıdan verilir). */
export type AiMockDeps = {
  authed: (req: Request) => AuthCtx | Response;
  fail: (req: Request, status: number, code: ApiErrorCode, message?: string, details?: unknown) => Response;
  latency: () => Promise<unknown>;
};

const RATE = AI_TRY_PER_USD_DEFAULT;
const STATE_KEY = 'sod_mock_ai';
const DAY_MS = 86_400_000;
const flag = (k: string) => !!localStorage.getItem(k);

// ---------- Metinler (geçidin `spend/text.ts` sözlüğüyle aynı) ----------

const TEXT = {
  tr: {
    'section.overview': 'Genel bakış',
    'section.products': 'Araca göre',
    'section.purposes': 'Amaca göre',
    'section.models': 'Modele göre',
    'section.members': 'Kişiye göre',
    'section.orgs': 'Firmaya göre',
    'widget.daily': 'Günlük harcama',
    'widget.byStatus': 'Sonuca göre çağrılar',
    'widget.byProduct': 'Araçlar',
    'widget.byPurpose': 'Amaçlar',
    'widget.byModel': 'Modeller',
    'widget.byMember': 'Kişiler',
    'widget.byOrg': 'Firmalar',
    'kpi.spend': 'Toplam tutar',
    'kpi.spend_usd': 'Toplam tutar (USD)',
    'kpi.calls': 'Çağrı',
    'kpi.calls.hint': '{ok} başarılı · {failed} başarısız · {cancelled} iptal',
    'kpi.tokens': 'Toplam belirteç',
    'kpi.cache_savings': 'Önbellek tasarrufu',
    'kpi.cap_used': 'Aylık hakkın kullanılan kısmı',
    'kpi.cap_used.hint': 'Bu ay, bütün araçlar',
    'filter.product': 'Araç',
    'filter.purpose': 'Amaç',
    'filter.model': 'Model',
    'filter.status': 'Sonuç',
    'filter.member': 'Kişi',
    'filter.member.none': 'Kişisiz (arka plan işi)',
    'filter.org': 'Firma',
    'status.pending': 'Sürüyor',
    'status.ok': 'Başarılı',
    'status.failed': 'Başarısız',
    'status.cancelled': 'İptal',
    'status.rejected': 'Geçit reddetti',
    'status.interrupted': 'Yarıda kaldı',
    'col.at': 'Zaman',
    'col.product': 'Araç',
    'col.purpose': 'Amaç',
    'col.member': 'Kişi',
    'col.model': 'Model',
    'col.served_model': 'Yanıtı veren model',
    'col.input_tokens': 'Girdi belirteci',
    'col.output_tokens': 'Çıktı belirteci',
    'col.cache_read_tokens': 'Önbellekten okunan',
    'col.cache_write_tokens': 'Önbelleğe yazılan',
    'col.images': 'Görsel',
    'col.amount': 'Tutar',
    'col.status': 'Sonuç',
    'col.estimated': 'Tahmini',
    'col.error_code': 'Hata kodu',
    'col.duration_ms': 'Süre (ms)',
    'col.org': 'Firma',
    'export.file': 'yapay-zeka-harcamasi',
    'export.yes': 'Evet',
    'export.no': 'Hayır',
  },
  en: {
    'section.overview': 'Overview',
    'section.products': 'By tool',
    'section.purposes': 'By purpose',
    'section.models': 'By model',
    'section.members': 'By person',
    'section.orgs': 'By company',
    'widget.daily': 'Daily spend',
    'widget.byStatus': 'Calls by result',
    'widget.byProduct': 'Tools',
    'widget.byPurpose': 'Purposes',
    'widget.byModel': 'Models',
    'widget.byMember': 'People',
    'widget.byOrg': 'Companies',
    'kpi.spend': 'Total spend',
    'kpi.spend_usd': 'Total spend (USD)',
    'kpi.calls': 'Calls',
    'kpi.calls.hint': '{ok} succeeded · {failed} failed · {cancelled} cancelled',
    'kpi.tokens': 'Total tokens',
    'kpi.cache_savings': 'Cache savings',
    'kpi.cap_used': 'Monthly allowance used',
    'kpi.cap_used.hint': 'This month, all tools',
    'filter.product': 'Tool',
    'filter.purpose': 'Purpose',
    'filter.model': 'Model',
    'filter.status': 'Result',
    'filter.member': 'Person',
    'filter.member.none': 'No person (background job)',
    'filter.org': 'Company',
    'status.pending': 'Running',
    'status.ok': 'Succeeded',
    'status.failed': 'Failed',
    'status.cancelled': 'Cancelled',
    'status.rejected': 'Rejected by gateway',
    'status.interrupted': 'Interrupted',
    'col.at': 'Time',
    'col.product': 'Tool',
    'col.purpose': 'Purpose',
    'col.member': 'Person',
    'col.model': 'Model',
    'col.served_model': 'Serving model',
    'col.input_tokens': 'Input tokens',
    'col.output_tokens': 'Output tokens',
    'col.cache_read_tokens': 'Cache read',
    'col.cache_write_tokens': 'Cache write',
    'col.images': 'Images',
    'col.amount': 'Amount',
    'col.status': 'Result',
    'col.estimated': 'Estimated',
    'col.error_code': 'Error code',
    'col.duration_ms': 'Duration (ms)',
    'col.org': 'Company',
    'export.file': 'ai-spend',
    'export.yes': 'Yes',
    'export.no': 'No',
  },
} as const;
type TextKey = keyof (typeof TEXT)['tr'];
const tx = (locale: Locale, key: TextKey, vars: Record<string, string | number> = {}) =>
  TEXT[locale][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

// ---------- Örnek çağrılar ----------

export type MockAiCall = {
  id: string;
  orgId: string;
  memberId: string | null;
  product: ProductKey;
  purpose: string;
  requestedModel: string;
  servedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  images: number;
  costMicroUsd: number;
  status: AiCallStatus;
  estimated: boolean;
  errorCode: string | null;
  durationMs: number | null;
  at: string;
  day: string;
};

/** Kısa kararlı özet (aynı girdi aynı sayı). */
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
function rand(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const oldestDay = (today: string) => {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return utcDay(new Date(Date.UTC(y, m - 1 - AI_SPEND_MAX_MONTHS_BACK, 1)));
};

const cache = new Map<string, MockAiCall[]>();

/** Firmanın örnek çağrıları, en yeni önce (12 ay geriye). Boş firmada (`empty`) ve `sod_mock_ai_empty` ile hiç yok. */
export function orgCalls(db: MockDb, orgId: string, now = new Date()): MockAiCall[] {
  if (flag('sod_mock_ai_empty')) return [];
  const org = db.orgs.find((o) => o.id === orgId);
  if (!org || org.empty) return [];
  const today = utcDay(now);
  const members = db.memberships.filter((m) => m.orgId === orgId && m.status === 'ACTIVE').map((m) => m.id);
  const key = `${orgId}|${today}|${members.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const products = aiProductKeys();
  const out: MockAiCall[] = [];
  for (let day = today, back = 0; day >= oldestDay(today); day = addDays(day, -1), back++) {
    const r = rand(seedOf(`${orgId}:${day}`));
    // Hafta sonu az; bugün saat kadarı.
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    let n = Math.floor(r() * (weekday === 0 || weekday === 6 ? 3 : 8));
    const dayStart = Date.parse(`${day}T06:00:00Z`);
    if (back === 0) n = Math.min(n, Math.max(0, Math.floor((now.getTime() - dayStart) / 3_600_000)));
    for (let i = 0; i < n; i++) {
      const product = products[r() < 0.62 ? 0 : products.length - 1]!;
      const ai = PRODUCTS[product].ai!;
      const purposes = Object.keys(ai.purposes);
      const purpose = purposes[Math.floor(r() * purposes.length)]!;
      const models = [...ai.models];
      const model = models[Math.floor(r() * models.length)]!;
      const roll = r();
      const status: AiCallStatus = roll < 0.86 ? 'ok' : roll < 0.92 ? 'failed' : roll < 0.96 ? 'cancelled' : 'rejected';
      const image = model.includes('image');
      const inputTokens = status === 'rejected' ? 0 : 800 + Math.floor(r() * 9000);
      const outputTokens = status === 'rejected' ? 0 : image ? 1290 : 120 + Math.floor(r() * 2200);
      const cacheReadTokens = status === 'ok' && r() < 0.45 ? Math.floor(r() * 6000) : 0;
      const cacheWriteTokens = status === 'ok' && r() < 0.2 ? Math.floor(r() * 3000) : 0;
      const outputImages = image && status === 'ok' ? 1 : 0;
      const at = new Date(dayStart + Math.floor(r() * 12 * 3_600_000));
      if (at.getTime() > now.getTime()) continue;
      const costMicroUsd =
        status === 'rejected' || status === 'failed'
          ? 0
          : aiCostMicroUsd(
              { inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens: cacheWriteTokens, cacheWrite1hTokens: 0, outputImages },
              aiPriceFor(model).price,
            );
      out.push({
        id: `aic_${orgId}_${day.replaceAll('-', '')}_${i}`,
        orgId,
        memberId: members.length && r() > 0.15 ? members[Math.floor(r() * members.length)]! : null,
        product,
        purpose,
        requestedModel: model,
        servedModel: status === 'rejected' ? null : model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        images: (image ? 1 : 0) + outputImages,
        costMicroUsd,
        status,
        estimated: status === 'cancelled',
        errorCode: status === 'rejected' ? 'sod_org_cap' : status === 'failed' ? 'overloaded_error' : null,
        durationMs: status === 'rejected' ? 0 : 900 + Math.floor(r() * 40_000),
        at: at.toISOString(),
        day,
      });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  cache.set(key, out);
  return out;
}

// ---------- Yönetici durumu (tarayıcı deposunda) ----------

type KeyRow = { last4: string; setBy: string; setAt: string; lastTest: AiAdminKey['lastTest']; state: AiProviderState };
type AiMockState = {
  keys: Partial<Record<AiProvider, KeyRow>>;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  orgCaps: Record<string, number>;
  stepUp: { token: string; personId: string; expiresAt: string } | null;
};

function loadState(now = new Date()): AiMockState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw) as AiMockState;
  } catch {
    /* bozuk kayıt: baştan */
  }
  const setAt = new Date(now.getTime() - 20 * DAY_MS).toISOString();
  const paused = flag('sod_mock_ai_paused');
  return {
    keys: { anthropic: { last4: 'x9Kq', setBy: 'Platform Yöneticisi', setAt, lastTest: { at: setAt, ok: true, httpStatus: 200 }, state: 'ok' } },
    dailyCapUsd: AI_LIMIT_DEFAULTS.platformDailyUsd,
    monthlyCapUsd: AI_LIMIT_DEFAULTS.platformMonthlyUsd,
    paused,
    pausedAt: paused ? new Date(now.getTime() - 3_600_000).toISOString() : null,
    pausedBy: paused ? 'Platform Yöneticisi' : null,
    orgCaps: {},
    stepUp: null,
  };
}
const saveState = (s: AiMockState) => localStorage.setItem(STATE_KEY, JSON.stringify(s));

const usdMicro = (usd: number) => Math.round(usd * 1_000_000);
const tl = (micro: number) => aiMicrosToAmount(aiMicroUsdToMicroTry(micro, RATE));
const amountOf = (micro: number, currency: 'TRY' | 'USD') => (currency === 'USD' ? aiMicrosToAmount(micro) : tl(micro));
const monthOf = (now: Date) => utcDay(now).slice(0, 7);
const sumCost = (rows: MockAiCall[]) => rows.reduce((a, c) => a + c.costMicroUsd, 0);

function orgCapMicro(state: AiMockState, orgId: string): number {
  return usdMicro(state.orgCaps[orgId] ?? AI_LIMIT_DEFAULTS.orgMonthlyUsd);
}

/** Bu ayın firma harcaması (mikro USD). `sod_mock_ai_capped` ile hak dolu sayılır. */
function orgMonthUsed(db: MockDb, orgId: string, now: Date) {
  const month = monthOf(now);
  const rows = orgCalls(db, orgId, now).filter((c) => c.day.startsWith(month));
  return { rows, used: sumCost(rows) };
}

function stateOf(used: number, cap: number, paused: boolean): AiAllowanceState {
  if (paused) return 'paused';
  if (used >= cap) return 'capped';
  return used >= (cap * AI_LIMIT_DEFAULTS.warnPct) / 100 ? 'warn' : 'ok';
}

// ---------- Sorgu ----------

type SpendCtx = {
  scope: 'org' | 'platform';
  orgIds: string[];
  /** Firma görünümünde etkin firma; platformda `org` süzgeci. */
  orgId: string | null;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  filters: { product?: string; purpose?: string; model?: string; status?: string; member?: string };
  currency: 'TRY' | 'USD';
  locale: Locale;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FINAL = AI_CALL_STATUSES.filter((s) => s !== 'pending') as string[];

type Invalid = { invalid: string };

function spendCtx(url: URL, ctx: AuthCtx, locale: Locale, now: Date): SpendCtx | Invalid | 'forbidden' {
  const sp = url.searchParams;
  const scope = sp.get('scope') ?? 'org';
  if (scope !== 'org' && scope !== 'platform') return { invalid: 'scope' };
  let orgIds: string[];
  let orgId: string | null;
  if (scope === 'platform') {
    if (!isOperator(ctx.person)) return 'forbidden';
    if (sp.has('member')) return { invalid: 'member' };
    orgId = sp.get('org') || null;
    orgIds = orgId ? [orgId] : ctx.db.orgs.map((o) => o.id);
  } else {
    if (!ctx.membership || (ctx.membership.orgRole !== 'OWNER' && ctx.membership.orgRole !== 'ADMIN')) return 'forbidden';
    if (sp.has('org')) return { invalid: 'org' };
    orgId = ctx.membership.orgId;
    orgIds = [orgId];
  }
  const currency = (sp.get('currency') ?? 'TRY') as 'TRY' | 'USD';
  if (currency !== 'TRY' && currency !== 'USD') return { invalid: 'currency' };
  if (scope === 'org' && currency === 'USD') return { invalid: 'currency' };
  const today = utcDay(now);
  const from = sp.get('from') || `${today.slice(0, 7)}-01`;
  const to = sp.get('to') || today;
  if (!DAY.test(from) || !DAY.test(to)) return { invalid: 'from' };
  if (to < from) return { invalid: 'to' };
  if (from < oldestDay(today)) return { invalid: 'from' };
  const len = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (len > 366) return { invalid: 'to' };
  const filters: SpendCtx['filters'] = {};
  for (const k of ['product', 'purpose', 'model', 'status', 'member'] as const) {
    const v = sp.get(k);
    if (v) filters[k] = v;
  }
  if (filters.product && !(aiProductKeys() as string[]).includes(filters.product)) return { invalid: 'product' };
  if (filters.status && !FINAL.includes(filters.status)) return { invalid: 'status' };
  return { scope, orgIds, orgId, from, to, prevFrom: addDays(from, -len), prevTo: addDays(from, -1), filters, currency, locale };
}

function matches(c: MockAiCall, f: SpendCtx['filters']) {
  if (f.product && c.product !== f.product) return false;
  if (f.purpose && c.purpose !== f.purpose) return false;
  if (f.model && (c.servedModel ?? c.requestedModel) !== f.model) return false;
  if (f.status && c.status !== f.status) return false;
  if (f.member === AI_SPEND_MEMBER_NONE && c.memberId !== null) return false;
  if (f.member && f.member !== AI_SPEND_MEMBER_NONE && c.memberId !== f.member) return false;
  return true;
}

function windowRows(db: MockDb, s: SpendCtx, from: string, to: string, now: Date, filtered = true): MockAiCall[] {
  return s.orgIds.flatMap((id) => orgCalls(db, id, now)).filter((c) => c.day >= from && c.day <= to && (!filtered || matches(c, s.filters)));
}

const share = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

function group<K extends string>(rows: MockAiCall[], key: (c: MockAiCall) => K) {
  const m = new Map<K, { calls: number; cost: number }>();
  for (const c of rows) {
    const g = m.get(key(c)) ?? { calls: 0, cost: 0 };
    g.calls++;
    g.cost += c.costMicroUsd;
    m.set(key(c), g);
  }
  return m;
}

/** `GET /api/ai/spend/summary` (sözleşmenin bölüm, gösterge ve süzgeç kimlikleri). */
export function spendSummary(db: MockDb, s: SpendCtx, now: Date) {
  const { locale, currency } = s;
  const t = (k: TextKey, v?: Record<string, string | number>) => tx(locale, k, v);
  const platform = s.scope === 'platform';
  const rows = windowRows(db, s, s.from, s.to, now);
  const prev = windowRows(db, s, s.prevFrom, s.prevTo, now);
  const money = (micro: number) => amountOf(micro, currency);
  const total = sumCost(rows);
  const count = (st: AiCallStatus) => rows.filter((c) => c.status === st).length;
  const kpis: HubKpi[] = [
    { id: 'spend', label: t('kpi.spend'), value: money(total), format: 'money', currency, previous: money(sumCost(prev)), goodDirection: 'down' },
    ...(platform
      ? [
          {
            id: 'spend_usd',
            label: t('kpi.spend_usd'),
            value: amountOf(total, 'USD'),
            format: 'money',
            currency: 'USD',
            previous: amountOf(sumCost(prev), 'USD'),
            goodDirection: 'down',
          } as HubKpi,
        ]
      : []),
    {
      id: 'calls',
      label: t('kpi.calls'),
      value: rows.length,
      format: 'number',
      hint: t('kpi.calls.hint', { ok: count('ok'), failed: count('failed') + count('rejected') + count('interrupted'), cancelled: count('cancelled') }),
      goodDirection: 'none',
    },
    {
      id: 'tokens',
      label: t('kpi.tokens'),
      value: rows.reduce((a, c) => a + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens, 0),
      format: 'number',
      goodDirection: 'none',
    },
    {
      id: 'cache_savings',
      label: t('kpi.cache_savings'),
      value: money(
        Math.round(
          rows.reduce((a, c) => {
            const p = aiPriceFor(c.requestedModel).price;
            return a + c.cacheReadTokens * Math.max(0, p.input - p.cacheRead);
          }, 0),
        ),
      ),
      format: 'money',
      currency,
      goodDirection: 'up',
    },
  ];
  if (s.orgId) {
    const state = loadState(now);
    const cap = orgCapMicro(state, s.orgId);
    const used = flag('sod_mock_ai_capped') ? cap : orgMonthUsed(db, s.orgId, now).used;
    const pct = cap > 0 ? Math.round((used / cap) * 1000) / 10 : 0;
    kpis.push({
      id: 'cap_used',
      label: t('kpi.cap_used'),
      hint: t('kpi.cap_used.hint'),
      value: pct,
      format: 'percent',
      tone: pct >= 100 ? 'bad' : pct >= 80 ? 'warning' : 'neutral',
      goodDirection: 'down',
    });
  }
  const days: string[] = [];
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) days.push(d);
  const products = aiProductKeys().filter((p) => rows.some((c) => c.product === p));
  const daily: HubWidget = {
    kind: 'timeseries',
    id: AI_SPEND_WIDGETS.daily,
    title: t('widget.daily'),
    chart: 'bar',
    format: 'money',
    currency,
    series: products.map((p) => {
      const per = group(
        rows.filter((c) => c.product === p),
        (c) => c.day,
      );
      return { id: p, label: PRODUCTS[p].name, points: days.map((d) => ({ x: d, y: money(per.get(d)?.cost ?? 0) })) };
    }),
  };
  const byStatusGroup = group(rows, (c) => c.status);
  const byStatus: HubWidget = {
    kind: 'breakdown',
    id: AI_SPEND_WIDGETS.byStatus,
    title: t('widget.byStatus'),
    format: 'number',
    items: (AI_CALL_STATUSES as readonly AiCallStatus[])
      .filter((st) => byStatusGroup.has(st))
      .map((st) => ({
        key: st,
        label: t(`status.${st}` as TextKey),
        value: byStatusGroup.get(st)!.calls,
        share: share(byStatusGroup.get(st)!.calls, rows.length),
      })),
  };
  const moneyBreakdown = (id: string, title: string, items: { key: string; label: string; cost: number; href?: string }[]): HubWidget => ({
    kind: 'breakdown',
    id,
    title,
    format: 'money',
    currency,
    items: items
      .sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
      .map((i) => ({ key: i.key, label: i.label, value: money(i.cost), share: share(i.cost, total), ...(i.href ? { href: i.href } : {}) })),
  });
  const entries = <K extends string>(m: Map<K, { calls: number; cost: number }>) => [...m.entries()];
  const byProduct = moneyBreakdown(
    AI_SPEND_WIDGETS.byProduct,
    t('widget.byProduct'),
    entries(group(rows, (c) => c.product)).map(([k, v]) => ({
      key: k,
      label: PRODUCTS[k].name,
      cost: v.cost,
      ...(k === 'deciship' ? { href: '/account/billing/ai/deciship' } : {}),
    })),
  );
  const byPurpose = moneyBreakdown(
    AI_SPEND_WIDGETS.byPurpose,
    t('widget.byPurpose'),
    entries(group(rows, (c) => c.purpose)).map(([k, v]) => ({ key: k, label: aiPurposeLabel(k, locale), cost: v.cost })),
  );
  const modelGroup = group(rows, (c) => c.servedModel ?? c.requestedModel);
  const byModel = moneyBreakdown(
    AI_SPEND_WIDGETS.byModel,
    t('widget.byModel'),
    entries(modelGroup).map(([k, v]) => ({ key: k, label: k, cost: v.cost })),
  );
  const whoGroup = group(rows, (c) => (platform ? c.orgId : (c.memberId ?? AI_SPEND_MEMBER_NONE)));
  const orgName = (id: string) => db.orgs.find((o) => o.id === id)?.name ?? '';
  const who = platform
    ? moneyBreakdown(
        AI_SPEND_WIDGETS.byOrg,
        t('widget.byOrg'),
        entries(whoGroup).map(([k, v]) => ({ key: k, label: orgName(k), cost: v.cost })),
      )
    : moneyBreakdown(
        AI_SPEND_WIDGETS.byMember,
        t('widget.byMember'),
        entries(whoGroup).map(([k, v]) => ({ key: k, label: '', cost: v.cost })),
      );
  const sections: HubSection[] = [
    { id: AI_SPEND_SECTIONS.overview, title: t('section.overview'), widgets: [{ kind: 'kpis', id: AI_SPEND_WIDGETS.kpis, items: kpis }, daily, byStatus] },
    { id: AI_SPEND_SECTIONS.products, title: t('section.products'), widgets: [byProduct] },
    { id: AI_SPEND_SECTIONS.purposes, title: t('section.purposes'), widgets: [byPurpose] },
    { id: AI_SPEND_SECTIONS.models, title: t('section.models'), widgets: [byModel] },
    platform
      ? { id: AI_SPEND_SECTIONS.orgs, title: t('section.orgs'), widgets: [who] }
      : { id: AI_SPEND_SECTIONS.members, title: t('section.members'), widgets: [who] },
  ];
  const fp = aiProductKeys().filter((p) => !s.filters.product || p === s.filters.product);
  const models = new Set<string>([...fp.flatMap((p) => [...PRODUCTS[p].ai!.models]), ...modelGroup.keys()]);
  const filters: HubFilterDef[] = [
    { id: 'product', kind: 'select', label: t('filter.product'), options: aiProductKeys().map((p) => ({ value: p, label: PRODUCTS[p].name })) },
    {
      id: 'purpose',
      kind: 'select',
      label: t('filter.purpose'),
      options: fp.flatMap((p) => Object.keys(PRODUCTS[p].ai!.purposes).map((k) => ({ value: k, label: aiPurposeLabel(k, locale) }))),
    },
    { id: 'model', kind: 'select', label: t('filter.model'), options: [...models].sort().map((m) => ({ value: m, label: m })) },
    { id: 'status', kind: 'select', label: t('filter.status'), options: FINAL.map((st) => ({ value: st, label: t(`status.${st}` as TextKey) })) },
    platform
      ? { id: 'org', kind: 'select', label: t('filter.org'), options: [...whoGroup.keys()].map((k) => ({ value: k, label: orgName(k) })) }
      : {
          id: 'member',
          kind: 'select',
          label: t('filter.member'),
          options: [...whoGroup.keys()].map((k) => (k === AI_SPEND_MEMBER_NONE ? { value: k, label: t('filter.member.none') } : { value: k, label: '' })),
        },
  ];
  return { product: AI_SPEND_PRODUCT, from: s.from, to: s.to, compare: { from: s.prevFrom, to: s.prevTo }, filters, sections };
}

const HIDDEN: AiSpendCallColumn[] = ['served_model', 'cache_read_tokens', 'cache_write_tokens', 'estimated', 'error_code', 'duration_ms'];
const RIGHT: AiSpendCallColumn[] = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'images', 'amount', 'duration_ms'];

function callCells(db: MockDb, s: SpendCtx, c: MockAiCall): Record<AiSpendCallColumn, string | number | null> {
  const t = (k: TextKey) => tx(s.locale, k);
  return {
    at: c.at,
    product: PRODUCTS[c.product].name,
    purpose: aiPurposeLabel(c.purpose, s.locale),
    member: c.memberId,
    model: c.requestedModel,
    served_model: c.servedModel,
    input_tokens: c.inputTokens,
    output_tokens: c.outputTokens,
    cache_read_tokens: c.cacheReadTokens,
    cache_write_tokens: c.cacheWriteTokens,
    images: c.images,
    amount: amountOf(c.costMicroUsd, s.currency),
    status: t(`status.${c.status}` as TextKey),
    estimated: c.estimated ? t('export.yes') : t('export.no'),
    error_code: c.errorCode,
    duration_ms: c.durationMs,
    org: db.orgs.find((o) => o.id === c.orgId)?.name ?? c.orgId,
  };
}

/** `GET /api/ai/spend/calls` (`HubDatasetPage`, `id: 'calls'`). */
export function spendCalls(db: MockDb, s: SpendCtx, page: number, pageSize: number, now: Date): HubDatasetPage {
  const cols = AI_SPEND_CALL_COLUMNS.filter((c) => c !== 'org' || s.scope === 'platform');
  const columns: HubColumn[] = cols.map((id) => ({
    id,
    label: tx(s.locale, `col.${id}` as TextKey),
    format: id === 'at' ? 'datetime' : id === 'amount' ? 'money' : RIGHT.includes(id) ? 'number' : 'text',
    ...(id === 'amount' ? { currency: s.currency } : {}),
    ...(RIGHT.includes(id) ? { align: 'right' as const } : {}),
    ...(HIDDEN.includes(id) ? { hiddenByDefault: true } : {}),
  }));
  const all = windowRows(db, s, s.from, s.to, now);
  const rows = all.slice((page - 1) * pageSize, page * pageSize).map((c) => {
    const cells = callCells(db, s, c);
    return { id: c.id, cells: Object.fromEntries(cols.map((k) => [k, cells[k]])) };
  });
  return { id: 'calls', columns, rows, page, pageSize, total: all.length };
}

/** `GET /api/ai/spend/allowance`. */
export function orgAllowance(db: MockDb, orgId: string, now: Date): AiOrgAllowanceView {
  const state = loadState(now);
  const cap = orgCapMicro(state, orgId);
  const { rows, used: realUsed } = orgMonthUsed(db, orgId, now);
  const used = flag('sod_mock_ai_capped') ? cap : realUsed;
  const st = stateOf(used, cap, state.paused);
  const month = monthOf(now);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    period: month,
    periodStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    resetsAt: new Date(Date.UTC(y, m, 1)).toISOString(),
    currency: 'TRY',
    capAmount: tl(cap),
    usedAmount: tl(used),
    remainingAmount: tl(Math.max(0, cap - used)),
    usedPct: cap > 0 ? Math.floor((used / cap) * 100) : 0,
    state: st,
    pausedBy: state.paused ? 'platform' : st === 'capped' ? 'org' : null,
    byProduct: aiProductKeys().map((p) => {
      const pu = sumCost(rows.filter((c) => c.product === p));
      const tcap = PRODUCTS[p].ai?.defaultCapUsd;
      return {
        product: p,
        usedAmount: tl(pu),
        capAmount: tcap ? tl(usdMicro(tcap)) : null,
        state: state.paused ? 'paused' : st === 'capped' ? 'capped' : tcap ? stateOf(pu, usdMicro(tcap), false) : st,
      };
    }),
  };
}

function adminKeys(state: AiMockState): AiAdminKey[] {
  return AI_PROVIDERS.map((p) => {
    const k = state.keys[p];
    return k
      ? { provider: p, state: k.state, last4: k.last4, setBy: k.setBy, setAt: k.setAt, lastTest: k.lastTest }
      : { provider: p, state: 'missing', last4: null, setBy: null, setAt: null, lastTest: null };
  });
}

export function adminLimits(db: MockDb, now: Date): AiAdminLimits {
  const state = loadState(now);
  const today = utcDay(now);
  const month = monthOf(now);
  const all = db.orgs.flatMap((o) => orgCalls(db, o.id, now));
  const orgs: AiAdminOrgRow[] = db.orgs
    .map((o) => {
      const rows = orgCalls(db, o.id, now).filter((c) => c.day.startsWith(month));
      const byProduct: Partial<Record<ProductKey, number>> = {};
      for (const c of rows) byProduct[c.product] = (byProduct[c.product] ?? 0) + c.costMicroUsd;
      const used = sumCost(rows);
      const cap = orgCapMicro(state, o.id);
      return {
        orgId: o.id,
        orgName: o.name,
        usedMicroUsd: used,
        byProduct,
        capMicroUsd: cap,
        capOverridden: state.orgCaps[o.id] !== undefined,
        usedPct: cap > 0 ? Math.floor((used / cap) * 100) : 0,
        state: stateOf(used, cap, state.paused),
      };
    })
    .filter((r) => r.usedMicroUsd > 0 || r.capOverridden)
    .sort((a, b) => b.usedMicroUsd - a.usedMicroUsd || a.orgId.localeCompare(b.orgId));
  const tools: AiAdminLimits['tools'] = {};
  for (const p of aiProductKeys()) {
    const cap = PRODUCTS[p].ai?.defaultCapUsd;
    if (cap) tools[p] = { defaultCapMicroUsd: usdMicro(cap) };
  }
  return {
    platform: {
      dailyCapMicroUsd: usdMicro(state.dailyCapUsd),
      monthlyCapMicroUsd: usdMicro(state.monthlyCapUsd),
      todayUsedMicroUsd: sumCost(all.filter((c) => c.day === today)),
      monthUsedMicroUsd: sumCost(all.filter((c) => c.day.startsWith(month))),
      paused: state.paused,
      pausedAt: state.pausedAt,
      pausedBy: state.pausedBy,
    },
    orgDefaultCapMicroUsd: usdMicro(AI_LIMIT_DEFAULTS.orgMonthlyUsd),
    tools,
    orgs,
    tryPerUsd: RATE,
  };
}

function adminStatus(now: Date): AiAdminStatus {
  const state = loadState(now);
  const providers = Object.fromEntries(AI_PROVIDERS.map((p) => [p, state.keys[p]?.state ?? 'missing'])) as Record<AiProvider, AiProviderState>;
  return {
    available: !state.paused && Object.values(providers).some((s) => s === 'ok'),
    paused: state.paused,
    providers,
    checkedAt: now.toISOString(),
    stalePrices: [],
  };
}

// ---------- İşleyiciler ----------

/** Hesap gibi (`isPlatformOperator`): listede ve e-postası doğrulanmış. */
const isOperator = (p: MockPerson) => p.platformOperator === true && !!p.email && p.emailVerified;

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function aiHandlers({ authed, fail, latency }: AiMockDeps) {
  const localeOf = (req: Request): Locale => localeFromAcceptLanguage(req.headers.get('accept-language'));
  const now = () => new Date();
  const invalid = (req: Request, field: string) => fail(req, 400, 'VALIDATION', undefined, [{ path: field, code: 'invalid_value', message: field }]);

  const withSpend = async (request: Request, failName: string, run: (s: SpendCtx, ctx: AuthCtx, url: URL) => Response) => {
    await latency();
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    const url = new URL(request.url);
    const s = spendCtx(url, ctx, localeOf(request), now());
    if (s === 'forbidden') return fail(request, 403, 'FORBIDDEN');
    if ('invalid' in s) return invalid(request, s.invalid);
    if (shouldFail(failName)) return fail(request, 500, 'INTERNAL');
    return run(s, ctx, url);
  };

  /** Platform yöneticisi kapısı; `stepUp`: değiştiren uç, jeton başlıkta ve süresi içinde olmalı (yoksa `403 STEP_UP_REQUIRED`). */
  const operator = (request: Request, stepUp: boolean): { ctx: AuthCtx; state: AiMockState } | Response => {
    const ctx = authed(request);
    if (ctx instanceof Response) return ctx;
    if (!isOperator(ctx.person)) return fail(request, 403, 'FORBIDDEN');
    if (shouldFail('ai.admin')) return fail(request, 500, 'INTERNAL');
    const state = loadState(now());
    if (stepUp) {
      const token = request.headers.get(STEP_UP_HEADER);
      const s = state.stepUp;
      if (!token || !s || s.token !== token || s.personId !== ctx.person.id || Date.parse(s.expiresAt) <= Date.now())
        return fail(request, 403, 'STEP_UP_REQUIRED');
    }
    return { ctx, state };
  };

  return [
    http.get(AI_SPEND_PATHS.summary, ({ request }) => withSpend(request, 'ai.summary', (s, ctx) => HttpResponse.json(spendSummary(ctx.db, s, now())))),
    http.get(AI_SPEND_PATHS.export, ({ request }) =>
      withSpend(request, 'ai.export', (s, ctx, url) => {
        const format = url.searchParams.get('format') ?? 'xlsx';
        if (format !== 'csv' && format !== 'xlsx') return invalid(request, 'format');
        const page = spendCalls(ctx.db, s, 1, 50_000, now());
        const body = [
          page.columns.map((c) => csvCell(c.label)).join(','),
          ...page.rows.map((r) => page.columns.map((c) => csvCell(r.cells[c.id] ?? null)).join(',')),
        ].join('\n');
        // Örnek: Excel de düz metin (gerçek uç gerçek dosya üretir).
        const name = `${tx(s.locale, 'export.file')}-${s.from}-${s.to}.${format}`;
        return new HttpResponse(body, {
          headers: {
            'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${name}"`,
          },
        });
      }),
    ),
    http.get(AI_SPEND_PATHS.calls, ({ request }) =>
      withSpend(request, 'ai.calls', (s, ctx, url) => {
        const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
        const size = url.searchParams.has('pageSize') ? Number(url.searchParams.get('pageSize')) : AI_SPEND_CALLS_PAGE_SIZE;
        if (!Number.isInteger(page) || page < 1) return invalid(request, 'page');
        if (!Number.isInteger(size) || size < 1 || size > AI_SPEND_CALLS_PAGE_SIZE_MAX) return invalid(request, 'pageSize');
        return HttpResponse.json(spendCalls(ctx.db, s, page, size, now()));
      }),
    ),
    http.get(AI_SPEND_PATHS.allowance, async ({ request }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      if (!ctx.membership || (ctx.membership.orgRole !== 'OWNER' && ctx.membership.orgRole !== 'ADMIN')) return fail(request, 403, 'FORBIDDEN');
      if (shouldFail('ai.allowance')) return fail(request, 500, 'INTERNAL');
      return HttpResponse.json(orgAllowance(ctx.db, ctx.membership.orgId, now()));
    }),

    // ---------- Hesap: adım artırma ----------
    http.post('/api/account/operator/step-up', async ({ request }) => {
      await latency();
      const ctx = authed(request);
      if (ctx instanceof Response) return ctx;
      if (!isOperator(ctx.person)) return fail(request, 403, 'FORBIDDEN');
      const body = (await request.json().catch(() => ({}))) as { password?: unknown };
      if (typeof body.password !== 'string' || !body.password) return invalid(request, 'password');
      if (body.password !== ctx.person.password) return fail(request, 401, 'INVALID_CREDENTIALS');
      const state = loadState(now());
      const token = `mock-step-up-${Math.random().toString(36).slice(2)}`;
      const expiresAt = new Date(Date.now() + OPERATOR_STEP_UP_TTL_SECONDS * 1000).toISOString();
      saveState({ ...state, stepUp: { token, personId: ctx.person.id, expiresAt } });
      return HttpResponse.json({ token, expiresAt });
    }),

    // ---------- Platform yöneticisi ----------
    http.get(AI_SPEND_PATHS.adminKeys, async ({ request }) => {
      await latency();
      const g = operator(request, false);
      if (g instanceof Response) return g;
      return HttpResponse.json({ keys: adminKeys(g.state) });
    }),
    http.put(`${AI_SPEND_PATHS.adminKeys}/:provider`, async ({ request, params }) => {
      await latency();
      const g = operator(request, true);
      if (g instanceof Response) return g;
      const provider = String(params.provider) as AiProvider;
      if (!(AI_PROVIDERS as readonly string[]).includes(provider)) return fail(request, 404, 'NOT_FOUND');
      const body = (await request.json().catch(() => ({}))) as { key?: unknown };
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (key.length < 12 || /\s/.test(key)) return fail(request, 400, 'VALIDATION', undefined, [{ path: 'key', code: 'invalid_format', message: 'key' }]);
      // Örnek: "bad" ile başlayan anahtarı sağlayıcı reddeder, "down" ile başlayana ulaşılamaz. Anahtar saklanmaz; yalnız son 4 hane.
      if (key.startsWith('bad')) return fail(request, 400, 'AI_KEY_REJECTED' as ApiErrorCode);
      if (key.startsWith('down')) return fail(request, 503, 'AI_PROVIDER_UNREACHABLE' as ApiErrorCode);
      const at = now().toISOString();
      const row: KeyRow = { last4: key.slice(-4), setBy: g.ctx.person.name, setAt: at, lastTest: { at, ok: true, httpStatus: 200 }, state: 'ok' };
      const state = { ...g.state, keys: { ...g.state.keys, [provider]: row } };
      saveState(state);
      return HttpResponse.json(adminKeys(state).find((k) => k.provider === provider));
    }),
    http.delete(`${AI_SPEND_PATHS.adminKeys}/:provider`, async ({ request, params }) => {
      await latency();
      const g = operator(request, true);
      if (g instanceof Response) return g;
      const provider = String(params.provider) as AiProvider;
      if (!(AI_PROVIDERS as readonly string[]).includes(provider)) return fail(request, 404, 'NOT_FOUND');
      const keys = { ...g.state.keys };
      delete keys[provider];
      const state = { ...g.state, keys };
      saveState(state);
      return HttpResponse.json(adminKeys(state).find((k) => k.provider === provider));
    }),
    http.post(`${AI_SPEND_PATHS.adminKeys}/:provider/test`, async ({ request, params }) => {
      await latency();
      const g = operator(request, false);
      if (g instanceof Response) return g;
      const provider = String(params.provider) as AiProvider;
      const row = g.state.keys[provider];
      if (!row) return fail(request, 404, 'NOT_FOUND');
      const at = now().toISOString();
      const state = {
        ...g.state,
        keys: { ...g.state.keys, [provider]: { ...row, lastTest: { at, ok: row.state !== 'rejected', httpStatus: row.state === 'rejected' ? 401 : 200 } } },
      };
      saveState(state);
      return HttpResponse.json(adminKeys(state).find((k) => k.provider === provider));
    }),
    http.get(AI_SPEND_PATHS.adminLimits, async ({ request }) => {
      await latency();
      const g = operator(request, false);
      if (g instanceof Response) return g;
      return HttpResponse.json(adminLimits(g.ctx.db, now()));
    }),
    http.patch(AI_SPEND_PATHS.adminLimits, async ({ request }) => {
      await latency();
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as { platformDailyUsd?: unknown; platformMonthlyUsd?: unknown; paused?: unknown };
      const keys = Object.keys(body);
      // Yalnız acil durdurma adım artırmasız (sözleşme).
      const onlyPause = body.paused === true && keys.length === 1;
      const g = operator(request, !onlyPause);
      if (g instanceof Response) return g;
      const usd = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
      if (!keys.length || keys.some((k) => !['platformDailyUsd', 'platformMonthlyUsd', 'paused'].includes(k))) return invalid(request, keys[0] ?? '');
      if (body.platformDailyUsd !== undefined && !usd(body.platformDailyUsd)) return invalid(request, 'platformDailyUsd');
      if (body.platformMonthlyUsd !== undefined && !usd(body.platformMonthlyUsd)) return invalid(request, 'platformMonthlyUsd');
      if (body.paused !== undefined && typeof body.paused !== 'boolean') return invalid(request, 'paused');
      const state = { ...g.state };
      if (typeof body.platformDailyUsd === 'number') state.dailyCapUsd = body.platformDailyUsd;
      if (typeof body.platformMonthlyUsd === 'number') state.monthlyCapUsd = body.platformMonthlyUsd;
      if (typeof body.paused === 'boolean' && body.paused !== state.paused) {
        state.paused = body.paused;
        state.pausedAt = body.paused ? now().toISOString() : null;
        state.pausedBy = body.paused ? g.ctx.person.name : null;
      }
      saveState(state);
      return HttpResponse.json(adminLimits(g.ctx.db, now()));
    }),
    http.put(`${AI_SPEND_PATHS.adminLimits}/orgs/:orgId`, async ({ request, params }) => {
      await latency();
      const g = operator(request, true);
      if (g instanceof Response) return g;
      const orgId = String(params.orgId);
      if (!g.ctx.db.orgs.some((o) => o.id === orgId)) return fail(request, 404, 'NOT_FOUND');
      const body = (await request.json().catch(() => ({}))) as { capUsd?: unknown };
      if (body.capUsd !== null && !(typeof body.capUsd === 'number' && Number.isFinite(body.capUsd) && body.capUsd >= 0 && body.capUsd <= 1_000_000))
        return invalid(request, 'capUsd');
      const orgCaps = { ...g.state.orgCaps };
      if (body.capUsd === null) delete orgCaps[orgId];
      else orgCaps[orgId] = body.capUsd as number;
      saveState({ ...g.state, orgCaps });
      return HttpResponse.json(adminLimits(g.ctx.db, now()));
    }),
    http.get(AI_SPEND_PATHS.adminStatus, async ({ request }) => {
      await latency();
      const g = operator(request, false);
      if (g instanceof Response) return g;
      return HttpResponse.json(adminStatus(now()));
    }),
  ];
}
