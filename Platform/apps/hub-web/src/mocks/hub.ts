// Yalnız VITE_MOCK=1. Araçların Merkez uçları (ARCHITECTURE §7, `/api/<anahtar>/platform/*`) araçtan bağımsız: araç listesi ve
// uç kapıları (`hub.analytics`, `hub.data`, `hub.export`) araç kaydından (`contracts/src/products.ts`), yanıtlar araç başına bir
// sağlayıcıdan. Sağlayıcı seçimi (`hubProvider`):
//   1. Elle yazılmış örnek üretici (bugün yalnız DeciShip, `deciship.ts`): dönem, süzgeç, sayfa ve izne göre değişen örnek veri;
//      gerçek kayda karşı `test/deciship-contract.test.mjs` denetler.
//   2. Aracın gerçek yanıt kaydı (`e2e/fixtures/<anahtar>-real/*.json`, aracın API testi üretir): yanıtlar kayıttan aynen.
//   3. İkisi de yoksa sözleşmenin boş yanıtları (`emptyHub*`).
// Yeni araç = kayıt girdisi + (varsa) kayıt klasörü; bu dosya değişmez. İş kuralı burada yok: kapı yalnız kayıttaki izin.
// Saf modül (msw ve tarayıcı yok): `npm test` doğrudan içe aktarır.
import {
  emptyHubActivityPage,
  emptyHubAnalytics,
  emptyHubDatasetList,
  emptyHubOverview,
  PRODUCTS,
  type HubDatasetPage,
  type HubOverview,
  type Locale,
  type ProductKey,
} from '@sellerondata/contracts';
import { activityPage, analytics, datasetCsv, datasetDefs, datasetPage, overview, tooLargeMessage, type DatasetParams, type MockCtx } from './deciship.ts';

/** Kayıt dosyası: aracın API testinin yazdığı biçim (`{ status, body }`). */
export type Recorded = { status: number; body: unknown };
/** Aracın kayıt klasörü: dosya adı (`overview.tr`, `dataset.invoices.tr` …, `.json` yok) → kayıt. */
export type Recordings = Record<string, Recorded>;

/** Sağlayıcı yanıtı. `body` yoksa hata kodu durumdan: 403 `FORBIDDEN`, 404 `NOT_FOUND`. */
export type HubReply = { status: number; body?: unknown };
export type HubQuery = { from: string; to: string; compare: boolean; filters: Record<string, string[]> };

export type HubProvider = {
  /** Kaynak: `generator` (elle yazılmış örnek), `recorded` (gerçek kayıt), `empty`. */
  source: 'generator' | 'recorded' | 'empty';
  overview(q: HubQuery, ctx: MockCtx): HubReply;
  analytics(q: HubQuery, ctx: MockCtx): HubReply;
  datasets(ctx: MockCtx): HubReply;
  dataset(id: string, p: DatasetParams, ctx: MockCtx): HubReply;
  /** CSV gövdesi ya da hata. */
  datasetCsv(id: string, p: DatasetParams, ctx: MockCtx): { status: 200; csv: string } | HubReply;
  activity(page: number, pageSize: number | undefined, ctx: MockCtx): HubReply;
  /** `EXPORT_TOO_LARGE` metni (test kancası); yoksa sözleşmenin genel metni. */
  tooLargeMessage?(ctx: MockCtx, total: number): string;
};

const ok = (body: unknown): HubReply => ({ status: 200, body });
const NOT_FOUND: HubReply = { status: 404 };
const FORBIDDEN: HubReply = { status: 403 };

/** Merkez uçlarının kapıları, araç kaydından (product-kit `registerHubRoutes` ile aynı eşleme). Kaydında `hub` olmayan araçta kapı yok. */
export function hubPermissions(key: ProductKey): { view: string; data: string; export: string } | null {
  const hub = PRODUCTS[key].hub;
  return hub ? { view: hub.analytics, data: hub.data, export: hub.export } : null;
}

/** Elle yazılmış örnek üreticiler. Yeni araç buraya eklenmez: kayıt klasörü yeter. */
const GENERATORS: Partial<Record<ProductKey, HubProvider>> = {
  deciship: {
    source: 'generator',
    overview: (q, ctx) => ok(overview(q.from, q.to, ctx)),
    analytics: (q, ctx) => ok(analytics(q.from, q.to, q.compare, q.filters, ctx)),
    datasets: (ctx) => ok(datasetDefs(ctx)),
    dataset: (id, p, ctx) => {
      const page = datasetPage(id, p, ctx);
      return page === null ? NOT_FOUND : page === 'forbidden' ? FORBIDDEN : ok(page);
    },
    datasetCsv: (id, p, ctx) => {
      const csv = datasetCsv(id, p, ctx);
      return csv === null ? NOT_FOUND : csv === 'forbidden' ? FORBIDDEN : { status: 200, csv };
    },
    activity: (page, size, ctx) => ok(activityPage(page, size, ctx)),
    tooLargeMessage,
  },
};

/** Boş ama geçerli yanıtlar (sözleşme `emptyHub*`): Merkez o aracı hatasız, boş gösterir. */
export function emptyProvider(key: ProductKey): HubProvider {
  return {
    source: 'empty',
    overview: (q) => ok(emptyHubOverview(key, q)),
    analytics: (q) => ok(emptyHubAnalytics(key, q)),
    datasets: () => ok(emptyHubDatasetList(key)),
    dataset: () => NOT_FOUND,
    datasetCsv: () => NOT_FOUND,
    activity: (page, size) => ok(emptyHubActivityPage(page, size)),
  };
}

const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Kaydın "şimdi"si: araç API testlerinin sabit saati (TagPress `platform/hub/test/scenario.ts` `NOW`). */
const RECORDED_NOW = Date.parse('2026-11-05T09:00:00.000Z');

/**
 * Kayıttaki `<zaman>` yer tutucusu geçerli bir ISO ana çevrilir. API testi koşudan koşuya değişen anı böyle yazar; gerçek uç hiç
 * yer tutucu döndürmez. Ham bırakılırsa Merkez onu tarih olarak okuyamaz ("—"), Etkinlik'te sıralama ve "daha eski kayıtları tutma"
 * sınırı bozulur (`'<' > '2'`: araç akışı bütün öbür kayıtları gizler). Belirlenimci: gövdede geçiş sırasıyla kaydın anından birer
 * saat geriye (kayıtlar yeniden eskiye dizili).
 */
export function fillStamps<T>(body: T): T {
  let k = 0;
  const walk = (v: unknown): unknown => {
    if (v === '<zaman>') return new Date(RECORDED_NOW - k++ * 3_600_000).toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
    return v;
  };
  return walk(body) as T;
}

/**
 * Gerçek kayıttan sağlayıcı. Dosya adları DeciShip kaydının adlarıdır (`Deciship/apps/api/test/hub/hubWebFixtures.test.ts`):
 * `overview.<dil>`, `analytics.<dil>`, `datasets.<dil>`, `dataset.<kimlik>.<dil>`, `activity.<dil>`. İstenen dilin kaydı yoksa
 * Türkçesi. Rol adlı kayıtlar (`overview.measure.tr` gibi) sunulmaz: kapı kayıttaki izinden. Kayıtta olmayan uç boş yanıt (veri
 * kümesi sayfası 404). Yanıt kayıttaki gibidir (yalnız `<zaman>` geçerli ana çevrilir, `fillStamps`): dönem, sayfa ve süzgeç
 * uygulanmaz (örnek veri, iş kuralı kopyalanmaz). İstisnalar:
 * - Etkinlik'in sonraki sayfaları boş: kayıt yalnız ilk sayfadır (aynı kayıtlar ikinci kez gelip "Daha fazla göster" hiç bitmesin).
 * - Boş firma (`ctx.empty`, tohumdaki yeni firma): kayıt verisi dolu bir firmadandır, yeni firmada henüz hiçbir şey yok. Genel
 *   Bakış sözleşmenin boş yanıtı + kayıttaki kurulum listesi, bütün adımları yapılmamış; analiz ve Etkinlik boş; veri kümelerinin
 *   tanımları kayıttan, sayfaları satırsız.
 */
export function recordedProvider(key: ProductKey, files: Recordings): HubProvider {
  const empty = emptyProvider(key);
  const pick = (name: string, locale: Locale): Recorded | undefined => files[`${name}.${locale}`] ?? files[`${name}.tr`];
  const reply = (r: Recorded): HubReply => ({ status: r.status, body: fillStamps(copy(r.body)) });
  /** Boş firmada veri kümesi sayfası: kolonlar kayıttan, satır yok. */
  const page = (r: Recorded, ctx: MockCtx): HubReply => {
    const out = reply(r);
    return ctx.empty && out.status === 200 ? { status: 200, body: { ...(out.body as HubDatasetPage), rows: [], total: 0 } } : out;
  };
  return {
    source: 'recorded',
    overview: (q, ctx) => {
      const r = pick('overview', ctx.locale);
      if (!r) return empty.overview(q, ctx);
      if (!ctx.empty || r.status !== 200) return reply(r);
      const setup = (reply(r).body as HubOverview).setup;
      const fresh = setup && { ...setup, completed: false, ...(setup.steps ? { steps: setup.steps.map((s) => ({ ...s, done: false })) } : {}) };
      return ok({ ...emptyHubOverview(key, q), ...(fresh ? { setup: fresh } : {}) });
    },
    analytics: (q, ctx) => {
      const r = pick('analytics', ctx.locale);
      return r && !ctx.empty ? reply(r) : empty.analytics(q, ctx);
    },
    datasets: (ctx) => {
      const r = pick('datasets', ctx.locale);
      return r ? reply(r) : empty.datasets(ctx);
    },
    dataset: (id, _p, ctx) => {
      const r = pick(`dataset.${id}`, ctx.locale);
      return r ? page(r, ctx) : NOT_FOUND;
    },
    datasetCsv: (id, _p, ctx) => {
      const r = pick(`dataset.${id}`, ctx.locale);
      if (!r) return NOT_FOUND;
      const out = page(r, ctx);
      if (out.status !== 200) return out;
      return { status: 200, csv: pageCsv(out.body as HubDatasetPage, ctx.locale) };
    },
    activity: (pageNo, size, ctx) => {
      const r = pick('activity', ctx.locale);
      if (!r || ctx.empty) return empty.activity(pageNo, size, ctx);
      const first = reply(r);
      if (pageNo <= 1 || first.status !== 200) return first;
      return { status: 200, body: { ...(first.body as object), items: [], page: pageNo } };
    },
  };
}

/** Kayıttaki sayfadan örnek CSV: başlık kolon adları, hücreler olduğu gibi (biçimlendirme yok). */
function pageCsv(page: HubDatasetPage, locale: Locale): string {
  const sep = locale === 'tr' ? ';' : ',';
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";,\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [page.columns.map((c) => cell(c.label)).join(sep), ...page.rows.map((r) => page.columns.map((c) => cell(r.cells[c.id])).join(sep))];
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Aracın sağlayıcısı: örnek üretici, yoksa kayıt (en az bir dosya), yoksa boş yanıtlar. */
export function hubProvider(key: ProductKey, recordings?: Recordings): HubProvider {
  return GENERATORS[key] ?? (recordings && Object.keys(recordings).length ? recordedProvider(key, recordings) : emptyProvider(key));
}

/** Örnek üreticisi olmayan araç: kaydı okunur (tarayıcı yalnız bunların kaydını yükler). */
export const usesRecordings = (key: ProductKey) => GENERATORS[key] === undefined;

/**
 * Glob sonuçlarını (yol → içerik) araç başına kayda böler: `…/fixtures/<anahtar>-real/<ad>.json`. Kayıtta olmayan klasör
 * (`account-real` gibi Hesap kayıtları) araç sayılmaz; çağıran yalnız kayıttaki anahtarları sorar.
 */
export function groupRecordings(entries: Record<string, Recorded>): Partial<Record<string, Recordings>> {
  const out: Partial<Record<string, Recordings>> = {};
  for (const [file, rec] of Object.entries(entries)) {
    const m = /\/([a-z][a-z0-9]*)-real\/([^/]+)\.json$/.exec(file);
    if (!m) continue;
    (out[m[1]!] ??= {})[m[2]!] = rec;
  }
  return out;
}
