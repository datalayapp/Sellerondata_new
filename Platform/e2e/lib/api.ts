// API istemcisi: web (çerez + CSRF başlığı) ve mobil (Bearer) gerçek akışları. Sahte yanıt yok.
import fs from 'node:fs';
import path from 'node:path';
import { request, type APIRequestContext, type APIResponse, type Browser, type BrowserContext } from '@playwright/test';
import { APP, SAMPLES, uniq } from './sys.ts';

export const PASSWORD = 'E2e-Sifre-12345!';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what} -> ${status}: ${body.slice(0, 400)}`);
  }
}

async function json<T>(what: string, r: APIResponse, ok = true): Promise<T> {
  const text = await r.text();
  if (ok && !r.ok()) throw new ApiFailure(r.status(), text, what);
  return (text ? JSON.parse(text) : null) as T;
}

export type Me = {
  person: { id: string; name: string; email: string | null; phone: string | null; locale: string };
  activeOrg: { id: string; name: string; orgRole: string; membershipId: string; companyConfirmedAt?: string | null } | null;
  orgs: { id: string; name: string; orgRole: string; status: string }[];
  products: { key: string; role: string; permissions: string[]; subscription: { status: string; plan: string } }[];
};

/** Tarayıcı istemcisinin aynısı: çerez saklar, `X-SOD-CSRF` ve Origin gönderir. */
export class WebApi {
  orgId: string | null = null;
  private constructor(readonly ctx: APIRequestContext) {}

  static async create(locale = 'tr') {
    const ctx = await request.newContext({ baseURL: APP, extraHTTPHeaders: { 'X-SOD-CSRF': '1', Origin: APP, 'Accept-Language': locale } });
    return new WebApi(ctx);
  }
  private headers(extra?: Record<string, string>) {
    return { ...(this.orgId ? { 'X-SOD-Org': this.orgId } : {}), ...extra };
  }
  async post<T = unknown>(url: string, data?: unknown) {
    return json<T>(`POST ${url}`, await this.ctx.post(url, { data: data ?? {}, headers: this.headers() }));
  }
  async patch<T = unknown>(url: string, data: unknown) {
    return json<T>(`PATCH ${url}`, await this.ctx.patch(url, { data, headers: this.headers() }));
  }
  async del<T = unknown>(url: string) {
    return json<T>(`DELETE ${url}`, await this.ctx.delete(url, { headers: this.headers() }));
  }
  async get<T = unknown>(url: string) {
    return json<T>(`GET ${url}`, await this.ctx.get(url, { headers: this.headers() }));
  }
  raw() {
    return this.ctx;
  }
  async me() {
    const me = await this.get<Me>('/api/account/me');
    this.orgId = me.activeOrg?.id ?? null;
    return me;
  }
  async login(identifier: string, password = PASSWORD) {
    await this.post('/api/account/auth/login', { identifier, password, client: 'web' });
    return this.me();
  }
  async dispose() {
    await this.ctx.dispose();
  }
}

export type Owner = { api: WebApi; me: Me; email: string; password: string; name: string; orgName: string };

export async function registerOwner(opts: { orgName?: string; name?: string; email?: string; locale?: string } = {}): Promise<Owner> {
  const api = await WebApi.create(opts.locale ?? 'tr');
  const email = opts.email ?? `${uniq('sahip')}@e2e.sellerondata.test`;
  const orgName = opts.orgName ?? `E2E Lojistik ${uniq('')}`;
  const name = opts.name ?? 'Selin Sahip';
  await api.post('/api/account/auth/register', { orgName, name, email, password: PASSWORD, country: 'TR', locale: opts.locale ?? 'tr' });
  const me = await api.me();
  return { api, me, email, password: PASSWORD, name, orgName };
}

/**
 * Merkez kurulumu: firma bilgilerini Merkez › Firma'nın "Onayla" düğmesinin çağırdığı uçla onaylar (`PATCH /api/account/org`,
 * `confirmCompany: true`; KARARLAR "Merkez kurulumu ve araç kurulumu"). Yeni firma onaysız başlar: onaylanmadan Merkez başlangıç
 * sayfasını gösterir, DeciShip sihirbazı "Önce firma bilgileri"nde durur ve DeciShip kurulumu tamam sayılmaz. DeciShip onayı
 * `org.updated` olayıyla öğrenir; bu yüzden DeciShip'in kendi kopyası onaylı olana kadar beklenir. Arayüzdeki akışı
 * `10-site-kayit` (Merkez'den) ve `30-kurulum-fatura` (DeciShip'ten "Merkez'de onayla") sınar; diğer senaryolar bununla başlar.
 */
export async function confirmCompany(api: WebApi): Promise<Me> {
  const org = await api.patch<{ companyConfirmedAt: string | null }>('/api/account/org', { confirmCompany: true });
  if (!org.companyConfirmedAt) throw new Error('firma onayı yazılmadı');
  const deadline = Date.now() + 20_000;
  for (;;) {
    const s = await api.get<{ company: { confirmed?: boolean } }>('/api/deciship/settings/onboarding');
    if (s.company.confirmed === true) break;
    if (Date.now() > deadline) throw new Error('DeciShip firma onayını 20 sn içinde almadı (org.updated olayı)');
    await new Promise((r) => setTimeout(r, 250));
  }
  return api.me();
}

/** Bu API oturumunun çerezleriyle gerçek tarayıcı bağlamı açar (kullanıcı zaten girmiş). */
export async function browserFor(browser: Browser, api: WebApi, locale = 'tr-TR'): Promise<BrowserContext> {
  const storageState = await api.ctx.storageState();
  return browser.newContext({ baseURL: APP, storageState, locale, timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 } });
}

/** Mobil istemci: gövdede jeton, `Authorization: Bearer`, CSRF yok, çerez yok. */
export class MobileApi {
  private constructor(
    private ctx: APIRequestContext,
    public accessToken: string,
    public refreshToken: string,
  ) {}

  static async login(identifier: string, password: string) {
    const ctx = await request.newContext({ baseURL: APP, extraHTTPHeaders: { 'Accept-Language': 'tr' } });
    const r = await ctx.post('/api/account/auth/login', { data: { identifier, password, client: 'mobile' } });
    const body = await json<{ accessToken: string; refreshToken: string }>('mobil giriş', r);
    return new MobileApi(ctx, body.accessToken, body.refreshToken);
  }
  private auth() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
  /** Sonucu olduğu gibi döner: durum kodu sınanır. */
  async get(url: string) {
    const r = await this.ctx.get(url, { headers: this.auth() });
    const text = await r.text();
    return { status: r.status(), body: text ? JSON.parse(text) : null, text };
  }
  /** Sonucu olduğu gibi döner (ör. başka cihazın oturumunu kapatma: DELETE /me/sessions/:id). */
  async del(url: string) {
    const r = await this.ctx.delete(url, { headers: this.auth() });
    const text = await r.text();
    return { status: r.status(), body: text ? JSON.parse(text) : null, text };
  }
  /**
   * Bugünkü telefon uygulaması gibi gönderim anını (`sentAt`) ekler: sunucu cihaz saati farkını ölçer, kabul aralığı dışındaki
   * ölçüm anını `400 MEASURED_AT_INVALID` ile reddeder (eski uygulamada sessizce alış anına çekerdi; test bunu fark etmezdi).
   */
  async postMeasurement(data: Record<string, unknown>) {
    const body = { sentAt: new Date().toISOString(), ...data };
    const r = await this.ctx.post('/api/deciship/measurements', { headers: this.auth(), multipart: { data: JSON.stringify(body) } });
    const text = await r.text();
    return { status: r.status(), body: text ? JSON.parse(text) : null, text };
  }
  async refresh() {
    const r = await this.ctx.post('/api/account/auth/refresh', { data: { refreshToken: this.refreshToken, client: 'mobile' } });
    const text = await r.text();
    const body = text ? JSON.parse(text) : null;
    if (r.ok()) {
      this.accessToken = body.accessToken;
      this.refreshToken = body.refreshToken;
    }
    return { status: r.status(), body };
  }
  async dispose() {
    await this.ctx.dispose();
  }
}

// ---------- örnek veri ----------
type SeedMeasurement = {
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  dimMethod: string;
  weightMethod: string;
  measuredAt: string;
};

export function sampleMeasurements(): SeedMeasurement[] {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, 'seed-measurements.json'), 'utf8'));
}

const DAY_MS = 86_400_000;
/** Örnek ölçümlerin en yenisi bugünden en az bu kadar gün önceye düşer (Merkez'in son 30 günü ölçümleri kapsar). */
const SAMPLE_NEWEST_DAYS_AGO = 2;
let measuredShift: number | null = null;

/**
 * KALANLAR 6.28: örnek ölçüm anları (`seed-measurements.json`, Ekim 2026) gönderilmeden şimdiye taşınır. Sunucu 730 günden eski
 * ölçüm anını kabul etmez (`Deciship/apps/api/src/services/measurementOrder.ts`); sabit tarih 2028-10'dan sonra kırılırdı.
 * Kaydırma tam gün: ölçümlerin sırası, aralıkları ve firmanın saatindeki saatleri aynı kalır (aynı takip no'nun yeniden
 * ölçümünde hangisinin güncel olduğu değişmez, tutarlar değişmez). Fatura karşılaştırması ölçüm anına bakmaz, en yeni ölçümü
 * alır; fatura ve dönem tarihleri dosyadaki gibi kalır (`SAMPLE_PERIOD`). Koşu boyunca tek kaydırma (gece yarısını geçen koşu).
 */
export function sampleMeasuredAt(iso: string): string {
  if (measuredShift === null) {
    const newest = Math.max(...sampleMeasurements().map((m) => Date.parse(m.measuredAt)));
    measuredShift = (Math.floor((Date.now() - newest) / DAY_MS) - SAMPLE_NEWEST_DAYS_AGO) * DAY_MS;
  }
  return new Date(Date.parse(iso) + measuredShift).toISOString();
}

export function sampleFile(name: string) {
  return path.join(SAMPLES, 'invoices', name);
}

/**
 * README'deki örnek: FedEx 9-482-11735 (varsayılan ayar). Ölçümler ve tarife olmadan satırlar eşleşmez. Fazla ödeme kesin
 * farklardır; #5288'in aynı dosyadaki ikinci satırı (mükerrer 1.120,00) "İncele" sayılır, fazla ödemeye girmez (KALANLAR 1.8).
 */
export const FEDEX_INVOICE = { file: 'fedex-9-482-11735.csv', no: '9-482-11735', date: '2026-10-27', lines: 18, match: 13, diff: 4, unmatched: 1, overcharge: 611.2, review: 1120 };

/**
 * Örnek faturanın dönemi: fatura tarihinin takvim ayı (Merkez özel aralığı, Pano ayı). Fatura ve sevk tarihleri dosyadaki
 * gibi sabittir (CSV/XLSX; tarife geçerliliği `seed-tariffs.json` 2026): geçmiş dönem sunucuda her zaman sorgulanır. Pano ay
 * listesi son 12 ay ve "son verinin ayı"dır; içinde bulunulan ayda faturası olmayan firmada bu ay listede kalır
 * (`Deciship/apps/web/src/pages/Dashboard.tsx` `latestInvoiceMonth`). Yalnız ölçüm anları şimdiye taşınır (`sampleMeasuredAt`).
 */
export const SAMPLE_PERIOD = (() => {
  const month = FEDEX_INVOICE.date.slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = `${month}-01`;
  const to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const query = `from=${from}&to=${to}`;
  /** `month`: Pano `#month` değeri; `query`: platform uçları; `hub`: Merkez adresi (`/home?…`). */
  return { month, from, to, query, hub: `range=custom&${query}` };
})();

export function measurementBody(m: SeedMeasurement) {
  return {
    clientId: uniq('e2e-olcum-'),
    trackingRaw: m.trackingRaw,
    lengthCm: m.lengthCm,
    widthCm: m.widthCm,
    heightCm: m.heightCm,
    weightKg: m.weightKg,
    dimMethod: m.dimMethod,
    weightMethod: m.weightMethod,
    measuredAt: sampleMeasuredAt(m.measuredAt),
    photoKinds: [],
  };
}

/** Ölçümleri mobil gibi gönderir (Bearer). Örnek faturanın karşılaştırılması bu kayıtlara bakar. */
export async function loadMeasurements(identifier: string, password: string) {
  const mobile = await MobileApi.login(identifier, password);
  let n = 0;
  for (const m of sampleMeasurements()) {
    const r = await mobile.postMeasurement(measurementBody(m));
    if (r.status >= 300) throw new Error(`ölçüm ${m.trackingRaw}: ${r.status} ${r.text}`);
    n += 1;
  }
  await mobile.dispose();
  return n;
}

export async function addCarrierAndTariff(api: WebApi, code = 'fedex') {
  const seed = (JSON.parse(fs.readFileSync(path.join(SAMPLES, 'seed-tariffs.json'), 'utf8')) as { code: string; name: string; tariffs: Record<string, unknown>[] }[]).find((c) => c.code === code)!;
  const { carrier } = await api.post<{ carrier: { id: string } }>('/api/deciship/carriers', { code, name: seed.name });
  const { tariff } = await api.post<{ tariff: { id: string } }>('/api/deciship/tariffs', { ...seed.tariffs[0], carrierId: carrier.id });
  return { carrierId: carrier.id, tariffId: tariff.id };
}

/** Faturayı arayüzün çağırdığı uçlarla yükler: önizleme + içe aktarma. */
export async function uploadInvoice(api: WebApi, carrierId: string, inv = FEDEX_INVOICE, suffix = '') {
  const file = fs.readFileSync(sampleFile(inv.file));
  const pv = await api.ctx.post('/api/deciship/invoices/preview', {
    headers: api.orgId ? { 'X-SOD-Org': api.orgId } : {},
    multipart: { carrierId, file: { name: inv.file, mimeType: 'text/csv', buffer: file } },
  });
  const preview = await json<{ fileId: string; suggestedMapping: unknown }>('fatura önizleme', pv);
  const created = await api.post<{ invoice: { id: string } }>('/api/deciship/invoices', {
    fileId: preview.fileId,
    carrierId,
    invoiceNo: inv.no + suffix,
    invoiceDate: inv.date,
    currency: 'TRY',
    mapping: preview.suggestedMapping,
    acknowledgeIssues: true,
  });
  return created.invoice.id;
}

/** Tam kurulu firma: Merkez'de onaylı firma bilgileri, taşıyıcı, tarife, ölçümler, fatura. Kurulum sihirbazı dışındaki senaryolar bununla başlar. */
export async function provisionDeciship(owner: Owner) {
  owner.me = await confirmCompany(owner.api);
  const { carrierId, tariffId } = await addCarrierAndTariff(owner.api);
  await loadMeasurements(owner.email, owner.password);
  const invoiceId = await uploadInvoice(owner.api, carrierId);
  return { carrierId, tariffId, invoiceId };
}

export type InvoiceSummary = { id: string; lines?: number; totals?: { lines: number; match: number; diff: number; unmatched: number; overchargeTotal?: number } };
