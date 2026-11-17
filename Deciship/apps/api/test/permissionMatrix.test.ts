import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { loadMemberAccess } from '../src/lib/access.ts';
import { companyFixture, tariffPayload, type Fixture } from './fixtures.ts';
import { closePermissions, customRoleKey, validateRolePermissions } from '@sellerondata/contracts';
import { findMoneyKeys, getApp, getAuthority, inCompany, issueIdentity, measurementPayload, multipart, registerCompany, type Identity, type Part } from './helpers.ts';
import {
  ALL_PERMISSIONS,
  BROKEN_NO_PRICE,
  heldBy,
  NO_PRICE_MAX,
  PERMISSION_SETS,
  permitted,
  READ_ONLY_EXEMPT,
  ROUTE_RULES,
  type PermissionSet,
} from './routeRules.ts';

type Route = { key: string; method: string; path: string; url: string };

/** Yol listesi Fastify'dan gelir: yeni uç bu testlere kendiliğinden girer. */
function apiRoutes(app: FastifyInstance): Route[] {
  return app.routeTable
    .filter((r) => r.url.startsWith(API_PREFIX))
    .map((r) => {
      const relative = r.url.slice(API_PREFIX.length);
      return { key: `${r.method} ${relative}`, method: r.method, path: relative, url: r.url };
    });
}

/** Parametreleri rastgele kimlikle doldurur: izin verilen uçta 404/400 döner, veri değişmez. */
const withRandomIds = (url: string) => url.replace(/:[A-Za-z]+/g, () => crypto.randomUUID());

function inject(app: FastifyInstance, method: string, url: string, headers: Record<string, string>) {
  return app.inject({ method: method as 'GET', url, headers, ...(method === 'GET' ? {} : { payload: {} }) });
}

/** Zorunlu sorgu parametresi olan okuma uçları. */
const GET_QUERY: Record<string, (f: Fixture) => string> = {
  'GET /measurements/check': (f) => `tracking=${f.measurement.trackingNo}`,
};
/** Gerçek kayıtla da 200 olmayan okumalar. Sebep yanında. */
const GET_STATUS: Record<string, number[]> = {
  // fikstürdeki belge kayıtlı ama dosyası diskte yok
  'GET /tariff-documents/:documentId/file': [404],
  // Mesaj 7: fikstürde arka plan işi yok (iş kimliği rastgele); dolu hâli jobs.test.ts içinde
  'GET /jobs/:jobId': [404],
  // fikstürde doğrulanmış satır yok; dolu liste invoices.test.ts içinde
  'GET /invoices/:id/dispute': [400],
  // aynı neden: kanıt ZIP'i de itiraz listesindeki satırlardan (dolu ZIP evidenceZip.test.ts içinde)
  'GET /invoices/:id/dispute/evidence.zip': [400],
};
/** Başarı için fikstürde olmayan kaynak isteyen ya da kuyruktaki iş kimliğiyle çalışan yazmalar. */
const WRITE_MAY_404 = new Set<string>([
  // fikstürdeki belgenin dosyası diskte yok: bu da doğru yanıt (reviewFindings.test.ts)
  'POST /tariff-documents/:documentId/scan',
  // Mesaj 7: fikstürde arka plan işi yok, iş kimliği rastgele
  'POST /jobs/:jobId/cancel',
  // Mesaj 7 (R1): vazgeçme kişiye bağlı; fikstür dosyasını yönetici yükledi, başka üyeye 404 (fileCleanup.test.ts sınar)
  'DELETE /invoices/preview/:fileId',
  // Y95: tazeleme de kişiye bağlı; fikstürde üyenin açık önizlemesi yok (fileCleanup.test.ts sınar)
  'POST /invoices/preview/:fileId/keep',
]);
/** Görüntü ve yapay zekâ servisi testte kapalıdır: 5xx yetki sorunu değildir. */
const EXTERNAL_SERVICE = new Set<string>(['POST /tariff-imports/:draftId/review']);
/**
 * Y83: yalnız arka planda yürüyen uçlar. İstek `?async=1` ile gider: yanıt 400 ASYNC_REQUIRED değil, ucun kendisinden
 * (iş başlatma, kayıt araması) gelsin. Yapay zekâ taraması (`scan` `mode: 'ai'`) burada değil: matris kod taramasını dener.
 */
const ASYNC_ONLY = new Set<string>([
  'POST /tariff-documents/:documentId/extract',
  // KALANLAR 6.18
  'POST /tariff-imports/:draftId/review',
  'POST /tariffs/:id/recompare-invoices/preview',
  'POST /tariffs/:id/recompare-invoices',
  'POST /settings/recompare-invoices/preview',
  'POST /settings/recompare-invoices',
]);
const asyncUrl = (route: Route, url: string) => (ASYNC_ONLY.has(route.key) ? `${url}?async=1` : url);

const setNames = PERMISSION_SETS.map((set) => [set.name, set] as const);

/**
 * İçeriği izne göre değişen okumaların beklenen durumu (kural tablosu yalnız kapıyı söyler). Fatura kaynağı dosyası fatura
 * ve fiyat iznini, fotoğraf bütün ölçümleri görmeyi ya da kendi ölçümünü (setin üyesi fikstürün ölçen çalışanıysa),
 * Merkez veri seti kendi iznini ister.
 */
function contentStatus(route: Route, url: string, f: Fixture, held: readonly string[], isMeasurer: boolean): number[] | undefined {
  const has = (perm: string) => held.includes(perm);
  if (route.key === 'GET /files/:id') {
    if (url.endsWith(f.invoiceFileId)) return has('deciship.invoices.view') && has('deciship.prices.view') ? [200] : [404];
    return has('deciship.measurements.view_all') || (has('deciship.measurements.capture') && isMeasurer) ? [200] : [404];
  }
  if (route.path.startsWith('/platform/datasets/:id')) {
    const dataset = url.split('/platform/datasets/')[1]!.split('/')[0];
    const need = dataset === 'measurements' ? 'deciship.measurements.view_all' : dataset === 'audit-log' ? 'deciship.reports.view' : null;
    if (need && !has(need)) return [403];
  }
  return undefined;
}

describe('izin setleri', () => {
  it('her set Hesap kurallarına uyar (bağımlılık kapalı); fiyatsız en geniş set gerçekten en geniş; bozuk set geçersiz', () => {
    expect(PERMISSION_SETS.filter((set) => !validateRolePermissions('deciship', heldBy(set)).ok).map((set) => set.name)).toEqual([]);
    expect(NO_PRICE_MAX).not.toContain('deciship.prices.view');
    expect(validateRolePermissions('deciship', NO_PRICE_MAX).ok).toBe(true);
    for (const perm of ALL_PERMISSIONS.filter((p) => !NO_PRICE_MAX.includes(p))) {
      expect(closePermissions('deciship', [...NO_PRICE_MAX, perm]), perm).toContain('deciship.prices.view');
    }
    // v1 para sızıntısı kuralı: fatura görme ve dışa aktarma fiyat izni gerektirir (Hesap zorunlu tutar)
    expect(validateRolePermissions('deciship', BROKEN_NO_PRICE).ok).toBe(false);
    for (const perm of ['deciship.invoices.view', 'deciship.data.export'] as const) expect(closePermissions('deciship', [perm])).toContain('deciship.prices.view');
    // her izin en az bir sette, setler tekrarsız
    for (const perm of ALL_PERMISSIONS) expect(PERMISSION_SETS.some((set) => heldBy(set).includes(perm)), perm).toBe(true);
    expect(PERMISSION_SETS.length).toBeGreaterThanOrEqual(15);
  });
});

describe('izin matrisi: her uç × her izin seti', () => {
  let app: FastifyInstance;
  let routes: Route[];
  beforeAll(async () => {
    app = await getApp();
    routes = apiRoutes(app);
  });

  it('yol listesi ve kural tablosu birebir aynı: tabloda olmayan yeni uç bu testi kırar', () => {
    const actual = routes.map((r) => r.key).sort();
    const expected = Object.keys(ROUTE_RULES).sort();
    expect(actual.filter((k) => !expected.includes(k)), 'kural tablosunda olmayan uçlar').toEqual([]);
    expect(expected.filter((k) => !actual.includes(k)), 'artık var olmayan uçlar').toEqual([]);
    expect(routes.length).toBeGreaterThan(50);
  });

  it('kancasız rota yok, her rota tek yöntemli, herkese açık uçlar yalnız ikisi', () => {
    const entries = app.routeTable.filter((r) => r.url.startsWith(API_PREFIX));
    const open = entries.filter((r) => !r.guarded).map((r) => `${r.method} ${r.url.slice(API_PREFIX.length)}`).sort();
    expect(open).toEqual(['GET /health', 'POST /internal/events']);
    expect(entries.filter((r) => r.methodCount > 1 && !(r.methodCount === 2 && r.method === 'GET'))).toEqual([]);
    expect(Object.entries(ROUTE_RULES).filter(([, rule]) => rule === 'public').map(([k]) => k).sort()).toEqual(open);
  });

  it.each(setNames)('%s: izni olmayan uçlardan 403 FORBIDDEN alır', async (_name, set) => {
    const { auth } = await registerSetMember(app, set);
    const held = heldBy(set);
    const wrong: string[] = [];
    for (const route of routes) {
      const rule = ROUTE_RULES[route.key];
      if (!rule || rule === 'public' || permitted(rule, held)) continue;
      const res = await inject(app, route.method, withRandomIds(route.url), auth);
      if (res.statusCode !== 403 || res.json().error.code !== 'FORBIDDEN') wrong.push(`${route.key} yasak ama ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
  });

  it.each(setNames)('%s: izni olan uca firmanın gerçek kaydıyla girer: okuma 200, yazma yetki ya da kayıt hatası almaz', async (_name, set) => {
    const f = await companyFixture(app);
    const held = heldBy(set);
    const { member, isMeasurer } = await fixtureMember(f, set);
    const allowed = routes.filter((r) => {
      const rule = ROUTE_RULES[r.key];
      return rule && rule !== 'public' && permitted(rule, held);
    });
    expect(allowed.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    let succeeded = 0;

    for (const route of allowed.filter((r) => r.method === 'GET')) {
      for (const url of fillParams(route, f)) {
        const res = await app.inject({ method: 'GET', url: url + (GET_QUERY[route.key] ? `?${GET_QUERY[route.key]!(f)}` : ''), headers: member.auth });
        const expected = contentStatus(route, url, f, held, isMeasurer) ?? GET_STATUS[route.key] ?? [200];
        if (expected.includes(res.statusCode)) succeeded++;
        else wrong.push(`${route.key} ${url} → ${res.statusCode} ${res.body.slice(0, 100)}`);
      }
    }

    // Yazmalar kayıt silmeden önce, silmeler alttan üste: üst kayıt silinince alt kayda 404 olmasın.
    const order = (r: Route) => (r.method !== 'DELETE' ? 0 : r.path.startsWith('/invoices') || r.path.startsWith('/measurements') ? 1 : r.path.startsWith('/tariffs') ? 2 : 3);
    for (const route of allowed.filter((r) => r.method !== 'GET').sort((a, b) => order(a) - order(b))) {
      for (const url of fillParams(route, f)) {
        const res = await app.inject({ method: route.method as 'POST', url: asyncUrl(route, url), headers: member.auth, payload: validBody(route, f) as object });
        const notFoundIsFine = WRITE_MAY_404.has(route.key);
        const contentRefused = contentStatus(route, url, f, held, isMeasurer)?.includes(res.statusCode) ?? false;
        const refused = !contentRefused && (res.statusCode === 401 || res.statusCode === 403 || (res.statusCode === 404 && !notFoundIsFine) || res.statusCode >= 500);
        const unavailable = EXTERNAL_SERVICE.has(route.key) && res.statusCode >= 500;
        if (refused && !unavailable) wrong.push(`${route.key} → ${res.statusCode} ${res.body.slice(0, 100)}`);
        if (res.statusCode < 300) succeeded++;
      }
    }
    expect(wrong).toEqual([]);
    expect(succeeded).toBeGreaterThan(0);
  }, 120_000);

  it('erişimsiz üye (üründe rolü yok): her uçtan 403 NO_PRODUCT_ACCESS', async () => {
    const authority = await getAuthority();
    const token = await authority.accessToken({ orgId: crypto.randomUUID(), membershipId: crypto.randomUUID(), role: null });
    const wrong: string[] = [];
    for (const route of routes) {
      if (ROUTE_RULES[route.key] === 'public') continue;
      const res = await inject(app, route.method, withRandomIds(route.url), authority.bearer(token));
      if (res.statusCode !== 403 || res.json().error.code !== 'NO_PRODUCT_ACCESS') wrong.push(`${route.key} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('özel rol jetonu: yetki rol adından değil izin listesinden; liste katalogla kesişir', async () => {
    const f = await companyFixture(app);
    const as = (role: string, perms?: string[]) => issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role, ...(perms ? { perms } : {}) });
    const status = async (who: Identity, url: string) => (await app.inject({ method: 'GET', url: `/api/deciship${url}`, headers: who.auth })).statusCode;
    // Yönetici adı, ölçüm izni: ayar ve fatura kapalı
    const narrowedAdmin = await as('ADMIN', ['deciship.measurements.capture']);
    expect(await status(narrowedAdmin, '/settings/onboarding')).toBe(403);
    expect(await status(narrowedAdmin, '/invoices')).toBe(403);
    expect(await status(narrowedAdmin, '/box-presets')).toBe(200);
    // Ölçüm adı, fatura ve fiyat izni: faturalar açık, tutarlar görünür
    const widenedMeasure = await as('MEASURE', ['deciship.invoices.view', 'deciship.prices.view']);
    const lines = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${f.invoiceId}/lines`, headers: widenedMeasure.auth });
    expect(lines.statusCode, lines.body).toBe(200);
    expect(lines.json().items[0].netAmount).toEqual(expect.any(Number));
    // başka aracın ve bilinmeyen izin yetki vermez
    const foreign = await as(customRoleKey(crypto.randomUUID()), ['orderloom.orders.write', 'deciship.settings', 'settings.manage', 'deciship.invoices.view.extra']);
    for (const url of ['/invoices', '/settings/onboarding', '/tariffs', '/measurements']) expect(await status(foreign, url), url).toBe(403);
    expect(await status(foreign, '/me')).toBe(200);
  });

  it('katalogda olmayan rol: yalnız session uçları (hiçbir izni yok)', async () => {
    const stranger = await issueIdentity({ role: 'UYDURMA' });
    const wrong: string[] = [];
    for (const route of routes) {
      const rule = ROUTE_RULES[route.key];
      if (!rule || rule === 'public' || rule === 'session') continue;
      const res = await inject(app, route.method, withRandomIds(route.url), stranger.auth);
      if (res.statusCode !== 403) wrong.push(`${route.key} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('kimliksiz istek: her uçtan 401, gövde okunmadan (bozuk gövde 400 vermez, alan adı sızmaz)', async () => {
    const wrong: string[] = [];
    for (const route of routes) {
      if (ROUTE_RULES[route.key] === 'public') continue;
      const url = withRandomIds(route.url);
      const res = await inject(app, route.method, url, {});
      if (res.statusCode !== 401 || res.json().error.code !== 'UNAUTHORIZED') wrong.push(`${route.key} → ${res.statusCode}`);
      if (route.method !== 'GET') {
        const broken = await app.inject({ method: route.method as 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{bozuk' });
        if (broken.statusCode !== 401) wrong.push(`${route.key} bozuk gövde → ${broken.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('READ_ONLY abonelik: her yazma ucu 403 READ_ONLY, okuma çalışır, istisnalar tablodaki kadar', async () => {
    const admin = await registerCompany(app);
    const readOnly = await admin.token({ status: 'READ_ONLY' });
    const canceled = await admin.token({ status: 'CANCELED' });
    const wrong: string[] = [];
    for (const route of routes) {
      if (ROUTE_RULES[route.key] === 'public') continue;
      const url = withRandomIds(route.url);
      for (const session of [readOnly, canceled]) {
        const res = await inject(app, route.method, url, session.auth);
        const code = res.statusCode === 403 ? res.json().error.code : null;
        if (route.method === 'GET' || READ_ONLY_EXEMPT.has(route.key)) {
          if (code) wrong.push(`${route.key} okunmalı ama ${code}`);
        } else if (code !== 'READ_ONLY') {
          wrong.push(`${route.key} → ${res.statusCode} ${code}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('uç içi izinler: silinenler, başkasının ölçümü, ölçüm tarihi', async () => {
    const f = await companyFixture(app);
    const accounting = await issueIdentity({ companyId: f.companyId, role: 'ACCOUNTING' });
    const auditor = await issueIdentity({ companyId: f.companyId, role: 'AUDITOR' });
    const otherWorker = await issueIdentity({ companyId: f.companyId, role: 'MEASURE' });
    const get = (url: string, auth: { authorization: string }) => app.inject({ method: 'GET', url, headers: auth });

    // silinenler listesi: yalnız measurements.manage
    expect((await get('/api/deciship/measurements?deleted=true', f.worker.auth)).statusCode).toBe(403);
    expect((await get('/api/deciship/measurements?deleted=true', accounting.auth)).statusCode).toBe(403);
    expect((await get('/api/deciship/measurements?deleted=true', auditor.auth)).statusCode).toBe(200);

    // başkasının ölçümü: measurements.view_all görür, yalnız ölçüm izni 404
    const url = `/api/deciship/measurements/${f.measurement.id}`;
    expect((await get(url, accounting.auth)).statusCode).toBe(200);
    expect((await get(url, otherWorker.auth)).statusCode).toBe(404);
    const onlyMine = await get(`/api/deciship/measurements?userId=${f.worker.userId}`, otherWorker.auth);
    expect(onlyMine.json().items).toEqual([]);

    // düzeltme: görmek yetmez, yönetme izni gerekir
    expect((await app.inject({ method: 'PATCH', url, headers: accounting.auth, payload: { weightKg: 3 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers: otherWorker.auth, payload: { weightKg: 3 } })).statusCode).toBe(404);
    // ölçüm tarihi yalnız yönetme izniyle değişir, kendi ölçümünde de
    const when = '2026-01-02T03:04:05.000Z';
    const own = await app.inject({ method: 'PATCH', url, headers: f.worker.auth, payload: { weightKg: 3, measuredAt: when } });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().measurement.measuredAt).not.toBe(when);
    const managed = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${own.json().measurement.id}`, headers: auditor.auth, payload: { measuredAt: when } });
    expect(managed.json().measurement.measuredAt).toBe(when);

    // hazır koli: pasif olanı yalnız ayar yetkisi görür
    await app.inject({ method: 'PATCH', url: `/api/deciship/box-presets/${f.presetId}`, headers: f.admin.auth, payload: { active: false } });
    const names = async (auth: { authorization: string }) => (await get('/api/deciship/box-presets', auth)).json().items.map((b: { id: string }) => b.id);
    expect(await names(f.admin.auth)).toContain(f.presetId);
    expect(await names(auditor.auth)).not.toContain(f.presetId);
  });

  it('Y123: muhasebe fatura yükler, başlığı düzeltir (önce/sonra önizlemesiyle) ve siler; karar, onay ve öbür önizleme kipleri kapalı', async () => {
    const f = await companyFixture(app);
    const accounting = await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: 'ACCOUNTING', name: 'Muhasebe' });
    const call = (method: string, url: string, payload?: object) =>
      app.inject({ method: method as 'POST', url: `/api/deciship${url}`, headers: accounting.auth, ...(payload ? { payload } : {}) });
    const forbidden = (r: { statusCode: number; json: () => { error?: { code?: string } } }) => [r.statusCode, r.json().error?.code];

    // önizleme: yalnız düzenleme penceresinin kipi (sabit dayanak + değişiklik, satır seçimi yok)
    const preview = `/invoices/${f.invoiceId}/recalculate/preview`;
    // boş ya da etkisiz değişiklik (bugünkü tarih) tam "Yeniden karşılaştır" önizlemesi olurdu: kapalı
    for (const body of [{ basis: 'pinned' }, { basis: 'tariff' }, { basis: 'rules' }, { basis: 'pinned', patch: {}, lineIds: [f.lineId] }, {}, { basis: 'pinned', patch: {} }, { basis: 'pinned', patch: { invoiceDate: '2026-10-15' } }]) {
      expect(forbidden(await call('POST', preview, body)), JSON.stringify(body)).toEqual([403, 'FORBIDDEN']);
    }
    const before = await inCompany(f.admin.auth, () => prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }));
    const p = await call('POST', preview, { basis: 'pinned', patch: { invoiceDate: '2026-10-16' } });
    expect(p.statusCode, p.body).toBe(200);
    // önizleme hiçbir şey yazmaz
    expect(await inCompany(f.admin.auth, () => prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }))).toEqual(before);

    // başlık düzeltme: hesabı değiştiren alan önizlemenin token'ıyla, hesabı değiştirmeyen alan doğrudan
    const saved = await call('PATCH', `/invoices/${f.invoiceId}`, { invoiceDate: '2026-10-16', token: p.json().token });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().invoice.invoiceDate.slice(0, 10)).toBe('2026-10-16');
    const renamed = await call('PATCH', `/invoices/${f.invoiceId}`, { invoiceNo: `${before.invoiceNo}-M` });
    expect(renamed.statusCode, renamed.body).toBe(200);

    // karar, toplu karar, yeniden karşılaştırma ve önizlemenin onayı karar izninde kalır
    expect(forbidden(await call('PATCH', `/invoice-lines/${f.lineId}`, { decision: 'VERIFIED' }))).toEqual([403, 'FORBIDDEN']);
    expect(forbidden(await call('POST', `/invoices/${f.invoiceId}/lines/decide`, { decision: 'VERIFIED', lineIds: [f.lineId] }))).toEqual([403, 'FORBIDDEN']);
    expect(forbidden(await call('POST', `/invoices/${f.invoiceId}/recompare`, {}))).toEqual([403, 'FORBIDDEN']);
    expect(forbidden(await call('POST', `/invoices/${f.invoiceId}/recalculate`, { basis: 'pinned', token: p.json().token }))).toEqual([403, 'FORBIDDEN']);
    // tarife ve taşıyıcı yönetimi yok
    expect(forbidden(await call('POST', '/carriers', { code: 'ups', name: 'UPS' }))).toEqual([403, 'FORBIDDEN']);
    expect(forbidden(await call('POST', '/tariffs', tariffPayload(f.carrierId)))).toEqual([403, 'FORBIDDEN']);

    // yükleme: önizleme + içe aktarma
    // fikstür faturasında olmayan takip no: aynı gönderi başka faturada olsaydı içe aktarma 409 INVOICE_OVERLAP ile onay isterdi
    const csv = ['Takip No;Desi;Tutar', `7948${String(crypto.randomInt(1e9)).padStart(10, '0')};5;50`].join('\n');
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'muhasebe.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const up = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...accounting.auth, ...form.headers }, payload: form.payload });
    expect(up.statusCode, up.body).toBe(200);
    const created = await call('POST', '/invoices', {
      fileId: up.json().fileId,
      carrierId: f.carrierId,
      invoiceNo: `M-${crypto.randomUUID().slice(0, 8)}`,
      invoiceDate: '2026-10-20',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    });
    expect(created.statusCode, created.body).toBe(201);

    // silme
    const del = await call('DELETE', `/invoices/${created.json().invoice.id}`);
    expect(del.statusCode, del.body).toBe(204);
  });

  it('Y123: kararı verilmiş satırın sonucunu değiştiren başlık düzeltmesi karar izni ister (muhasebe 403, hiçbir şey yazılmaz; denetleyici geçer)', async () => {
    const f = await companyFixture(app);
    const member = (role: string) => issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role, name: `Rol ${role}` });
    const accounting = await member('ACCOUNTING');
    const auditor = await member('AUDITOR');
    const as = (auth: { authorization: string }) => (method: string, url: string, payload?: object) =>
      app.inject({ method: method as 'POST', url: `/api/deciship${url}`, headers: auth, ...(payload ? { payload } : {}) });
    // aynı taşıyıcıya daha ucuz ikinci tarife: tarife değişince ölçülmüş satırın beklenen tutarı ve farkı değişir
    const cheaper = await as(f.admin.auth)('POST', '/tariffs', tariffPayload(f.carrierId, { isDefault: false, rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'TR', weightUpto: i + 1, price: (i + 1) * 7 })) }));
    expect(cheaper.statusCode, cheaper.body).toBe(201);
    const tariffId = cheaper.json().tariff.id as string;
    const editWith = async (call: ReturnType<typeof as>) => {
      const p = await call('POST', `/invoices/${f.invoiceId}/recalculate/preview`, { basis: 'pinned', patch: { tariffId } });
      expect(p.statusCode, p.body).toBe(200);
      return { preview: p.json() as { token: string; frozenChanged: number }, saved: await call('PATCH', `/invoices/${f.invoiceId}`, { tariffId, token: p.json().token }) };
    };
    const snapshot = () =>
      inCompany(f.admin.auth, async () =>
        JSON.stringify({
          invoice: await prisma.invoice.findFirstOrThrow({ where: { id: f.invoiceId } }),
          lines: await prisma.invoiceLine.findMany({ where: { invoiceId: f.invoiceId }, orderBy: { rowIndex: 'asc' } }),
        }),
      );

    // kararlı satır yok: muhasebe düzeltir; sonra eski tarifeye döner (yine kararlı satır yok)
    const free = await editWith(as(accounting.auth));
    expect(free.preview.frozenChanged).toBe(0);
    expect(free.saved.statusCode, free.saved.body).toBe(200);
    const back = await as(accounting.auth)('POST', `/invoices/${f.invoiceId}/recalculate/preview`, { basis: 'pinned', patch: { tariffId: f.tariffId } });
    expect(back.statusCode, back.body).toBe(200);
    expect((await as(accounting.auth)('PATCH', `/invoices/${f.invoiceId}`, { tariffId: f.tariffId, token: back.json().token })).statusCode).toBe(200);

    // ölçülmüş fark satırı itiraz listesinde (denetleyicinin kararı): muhasebenin tarife değişikliği 403, hiçbir şey yazılmaz
    const verified = await as(auditor.auth)('PATCH', `/invoice-lines/${f.lineId}`, { decision: 'VERIFIED' });
    expect(verified.statusCode, verified.body).toBe(200);
    const before = await snapshot();
    const refused = await editWith(as(accounting.auth));
    expect(refused.preview.frozenChanged).toBeGreaterThan(0);
    expect(refused.saved.statusCode, refused.saved.body).toBe(403);
    expect(refused.saved.json().error).toMatchObject({ code: 'DECIDED_LINES_CHANGE', message: 'Bu değişiklik kararı verilmiş satırların tutarını değiştirir; fark kararı verebilen biri yapmalı.' });
    expect(await snapshot()).toBe(before);

    // denetleyici (karar izni) eskisi gibi düzeltir; satırın kararı kalır, tutarı değişir
    const ok = await editWith(as(auditor.auth));
    expect(ok.saved.statusCode, ok.saved.body).toBe(200);
    const line = await inCompany(f.admin.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: f.lineId } }));
    expect(line.decision).toBe('VERIFIED');
    expect(line.tariffRevisionId).not.toBeNull();
  });

  it('sıfırlama ucu ENABLE_DATA_RESET=true değilse yoktur', async () => {
    const authority = await getAuthority();
    const before = process.env.ENABLE_DATA_RESET;
    delete process.env.ENABLE_DATA_RESET;
    const closed = await buildApp({ identity: authority.authOptions });
    await closed.ready();
    try {
      expect(closed.routeTable.some((r) => r.url.endsWith('/settings/data/reset'))).toBe(false);
      const admin = await registerCompany(app);
      const r = await closed.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: admin.auth, payload: { confirm: true } });
      expect(r.statusCode).toBe(404);
    } finally {
      process.env.ENABLE_DATA_RESET = before;
      await closed.close();
    }
  });

  it('kaynak kodda rol adı yok, yönetici denetimi yok, izin rol adından türetilmez (geliştirme tohumu hariç)', () => {
    const SRC = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.includes('generated') && !f.endsWith('seed.ts'));
    const found: string[] = [];
    // Özel roller: izin rol adından katalogla türetilmez (`permissionsOf`, `can(ürün, rol, izin)`, `rolePermissions`); yerel üye
    // kaydının izinleri `lib/access.ts` `memberPermissions`, isteğinki `req.auth.permissions`. `.role` ile karşılaştırma da yok.
    const RULE = /'(ADMIN|AUDITOR|ACCOUNTING|MEASURE|WORKER)'|requireAdmin|isAdmin|\.role\s*[!=]==|\brole\s*[!=]==|WORKER_WEB_FORBIDDEN|JWT_SECRET|jwtSecret|\bpermissionsOf\(|\brolePermissions\(|\bcan\(\s*'deciship'|\bproductRole\(|isValidProductRole/g;
    // `Member.permissions` (TEXT[] NULL): Prisma liste alanında NULL ile boş listeyi ayırmaz, alan yalnız ham SQL ile okunur
    // ve yazılır (lib/access.ts `loadMemberAccess`, identity.ts). Prisma üye çağrısında `permissions` geçmemeli.
    const PRISMA_MEMBER_CALL = /\.member\.\w+\(([\s\S]*?)\);/g;
    for (const f of files) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      for (const m of text.matchAll(RULE)) found.push(`${f}: ${m[0]}`);
      for (const m of text.matchAll(PRISMA_MEMBER_CALL)) if (/\bpermissions\b/.test(m[1]!)) found.push(`${f}: Prisma üye çağrısında permissions`);
    }
    expect(found).toEqual([]);
  });
});

const permsOf = (set: PermissionSet) => (set.perms ? { perms: [...set.perms] } : {});

/** Yeni firmada setin üyesi. Hazır Yönetici (eski jeton) firmanın kendi yöneticisidir. */
async function registerSetMember(app: FastifyInstance, set: PermissionSet) {
  const admin = await registerCompany(app);
  if (set.role === 'ADMIN' && !set.perms) return admin;
  const member = await issueIdentity({ companyId: admin.companyId, orgName: admin.orgName, role: set.role, ...permsOf(set) });
  await app.inject({ method: 'GET', url: '/api/deciship/me', headers: member.auth });
  return member;
}

/**
 * Fikstür firmasında setin üyesi. Ölçüm yapıp bütün ölçümleri görmeyen set fikstürün ölçen çalışanı olarak girer (aynı üyelik
 * ve epoch, jeton setin rolüyle): kendi ölçümüne ve fotoğrafına girebildiği sınansın.
 */
async function fixtureMember(f: Fixture, set: PermissionSet): Promise<{ member: { auth: { authorization: string } }; isMeasurer: boolean }> {
  const held = heldBy(set);
  if (set.role === 'ADMIN' && !set.perms) return { member: f.admin, isMeasurer: false };
  if (held.includes('deciship.measurements.capture') && !held.includes('deciship.measurements.view_all')) {
    return { member: await f.worker.token({ role: set.role, ...permsOf(set) }), isMeasurer: true };
  }
  return { member: await issueIdentity({ companyId: f.companyId, orgName: f.admin.orgName, role: set.role, ...permsOf(set), name: 'Rol Kişi' }), isMeasurer: false };
}

/** Bir yolun parametrelerini verilen firmanın kayıtlarıyla doldurur. Tanınmayan parametre testi kırar. */
function fillParams(route: Route, f: Fixture): string[] {
  const idFor = (p: string): string[] => {
    if (p === 'id') {
      // Merkez veri setinin kimliği firma kaydı değil: tüm setler gezilir, yanıtta başka firma görünmemeli.
      if (route.path.startsWith('/platform/datasets')) return ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log'];
      if (route.path.startsWith('/measurements')) return [f.measurement.id];
      if (route.path.startsWith('/box-presets')) return [f.presetId];
      if (route.path.startsWith('/files')) return [f.photoId, f.invoiceFileId];
      if (route.path.startsWith('/carriers')) return [f.carrierId];
      if (route.path.startsWith('/tariffs')) return [f.tariffId];
      if (route.path.startsWith('/invoices')) return [f.invoiceId];
      if (route.path.startsWith('/invoice-lines')) return [f.lineId];
      if (route.path.startsWith('/disputes')) return [f.disputeId];
      if (route.path.startsWith('/dispute-results')) return [f.disputeResultId];
    }
    if (p === 'versionId') return [f.versionId];
    if (p === 'documentId') return [f.documentId];
    if (p === 'draftId') return [f.draftId];
    if (p === 'jobId') return [crypto.randomUUID()];
    // Önizleme dosyası: fikstürün faturaya bağlı dosyası (silinmez, 204; başka firmanınki 404)
    if (p === 'fileId') return [f.invoiceFileId];
    throw new Error(`${route.key}: ":${p}" için firma kaydı tanımlı değil. fillParams'a ekleyin.`);
  };
  const params = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
  let urls = [route.url];
  for (const p of params) urls = urls.flatMap((u) => idFor(p).map((id) => u.replace(`:${p}`, id)));
  return urls;
}

/** Gövde doğrulaması kayıt aramasından önce çalışan uçlar için geçerli gövde: yanıt gerçekten kayıt aramasından gelsin. */
function validBody(route: Route, attacker: Fixture): unknown {
  switch (route.key) {
    case 'PUT /tariffs/:id':
      return tariffPayload(attacker.carrierId);
    case 'POST /tariffs/:id/quote':
      return { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 1 };
    case 'POST /tariffs/:id/country-adjustments':
      return { country: 'DE', pct: 5 };
    case 'POST /tariff-documents/:documentId/scan':
      return { mode: 'code' };
    case 'POST /tariff-documents/:documentId/extract':
      return { sectionIds: ['c1'], target: { tariffId: attacker.tariffId } };
    case 'POST /tariff-imports/:draftId/apply':
      return { acknowledged: true };
    // Y123: yükleme izni yalnız başlık düzeltmenin önizlemesine girer (boş değişiklik = hiçbir alan değişmedi)
    // (en az bir alan gerçekten değişmeli: fikstür faturası 2026-10-15 tarihli)
    case 'POST /invoices/:id/recalculate/preview':
      return { basis: 'pinned', patch: { invoiceDate: '2026-10-16' } };
    // İtiraz uçları kaydı gövdeden önce arar; geçerli gövde yine de verilir ki yanıt kayıt aramasından gelsin.
    case 'POST /invoices/:id/disputes':
      return { sentOn: '2026-10-20', channel: 'EMAIL' };
    case 'POST /disputes/:id/resend':
      return { version: 1, sentOn: '2026-10-20', channel: 'EMAIL' };
    case 'POST /disputes/:id/withdraw':
    case 'POST /dispute-results/:id/revert':
      return { version: 1, reason: 'deneme' };
    case 'POST /disputes/:id/results':
      return { version: 1, kind: 'REJECTED', resultOn: '2026-10-20', reason: 'deneme', lines: [{ disputeLineId: crypto.randomUUID() }] };
    default:
      return {};
  }
}

describe('firmalar arası izolasyon: her uç, A jetonu, B kaydı', () => {
  let app: FastifyInstance;
  let routes: Route[];
  let A: Fixture;
  let B: Fixture;
  let bIds: string[];

  /** B firmasının kayıtları: işlem öncesi ve sonrası aynı kalmalı. */
  const snapshot = () =>
    inCompany(B.companyId, async () =>
      JSON.stringify({
        company: await prisma.company.findMany({ select: { name: true, settings: true, updatedAt: true } }),
        carriers: await prisma.carrier.findMany({ orderBy: { id: 'asc' } }),
        tariffs: await prisma.tariff.findMany({ orderBy: { id: 'asc' } }),
        rates: await prisma.tariffRate.count(),
        versions: await prisma.tariffVersion.count(),
        invoices: await prisma.invoice.findMany({ orderBy: { id: 'asc' } }),
        lines: await prisma.invoiceLine.findMany({ orderBy: { id: 'asc' } }),
        measurements: await prisma.measurement.findMany({ orderBy: { id: 'asc' } }),
        presets: await prisma.boxPreset.findMany({ orderBy: { id: 'asc' } }),
        drafts: await prisma.tariffImportDraft.count(),
        documents: await prisma.tariffDocument.count(),
        files: await prisma.file.count(),
        disputes: await prisma.dispute.findMany({ orderBy: { id: 'asc' } }),
        disputeLines: await prisma.disputeLine.findMany({ orderBy: { id: 'asc' } }),
        disputeResults: await prisma.disputeResult.findMany({ orderBy: { id: 'asc' } }),
        disputeResultLines: await prisma.disputeResultLine.count(),
      }),
    );

  beforeAll(async () => {
    app = await getApp();
    routes = apiRoutes(app);
    A = await companyFixture(app);
    B = await companyFixture(app);
    bIds = [B.companyId, B.admin.userId, B.worker.userId, B.carrierId, B.tariffId, B.versionId, B.measurement.id, B.photoId, B.invoiceId, B.invoiceFileId, B.lineId, B.presetId, B.draftId, B.documentId, B.disputeId, B.disputeResultId];
  });

  it('kimlik taşıyan her yol: B kaydı → 403/404, B verisi değişmez', async () => {
    const before = await snapshot();
    const leaks: string[] = [];
    let checked = 0;
    for (const route of routes) {
      if (!route.url.includes(':')) continue;
      const isHubDataset = route.path.startsWith('/platform/');
      for (const url of fillParams(route, isHubDataset ? A : B)) {
        const res = await app.inject({ method: route.method as 'POST', url: asyncUrl(route, url), headers: A.admin.auth, ...(route.method === 'GET' ? {} : { payload: validBody(route, A) as object }) });
        checked++;
        if (isHubDataset) {
          // firmanın kendi verisi döner (ya da veri seti yoksa 404), B görünmez
          if (res.statusCode >= 500) leaks.push(`${url} → ${res.statusCode}`);
          for (const id of bIds) if (res.body.includes(id)) leaks.push(`${url}: ${id}`);
          continue;
        }
        if (res.statusCode !== 403 && res.statusCode !== 404) leaks.push(`${route.key} → ${res.statusCode} ${res.body.slice(0, 100)}`);
        if (bIds.some((id) => id !== url.split('/').pop() && res.body.includes(id))) leaks.push(`${route.key} yanıtında B kimliği`);
      }
    }
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThan(25);
    expect(await snapshot()).toBe(before);
  });

  it('kimlik taşımayan her yol: A yanıtında B kaydı görünmez', async () => {
    const before = await snapshot();
    const leaks: string[] = [];
    for (const route of routes) {
      if (route.url.includes(':') || ROUTE_RULES[route.key] === 'public') continue;
      const res = await inject(app, route.method, route.url, A.admin.auth);
      for (const id of bIds) if (res.body.includes(id)) leaks.push(`${route.key}: ${id}`);
      expect(res.statusCode, `${route.key} ${res.body.slice(0, 80)}`).toBeLessThan(500);
    }
    expect(leaks).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('sorgu ve gövdedeki B kimliği: süzgeç boş döner, yazma reddedilir', async () => {
    const before = await snapshot();
    const csv = () => Buffer.from('Takip No;Tutar\n1;2');
    const carrierPart = (id: string): Part[] => [{ name: 'carrierId', value: id }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: csv() }];
    const mapping = { trackingNo: 'Takip No', netAmount: 'Tutar' };
    const refused: [string, string, unknown][] = [
      ['POST', '/api/deciship/invoices', { fileId: B.invoiceFileId, carrierId: A.carrierId, invoiceNo: 'Y1', invoiceDate: '2026-10-15', mapping }],
      ['POST', '/api/deciship/invoices', { fileId: A.invoiceFileId, carrierId: B.carrierId, invoiceNo: 'Y2', invoiceDate: '2026-10-15', mapping }],
      ['POST', '/api/deciship/invoices/preview/verify', { fileId: B.invoiceFileId, carrierId: A.carrierId, mapping }],
      ['POST', '/api/deciship/invoices/preview/ai-mapping', { fileId: B.invoiceFileId, carrierId: A.carrierId }],
      ['POST', '/api/deciship/tariffs', tariffPayload(B.carrierId)],
      ['PATCH', `/api/deciship/invoices/${A.invoiceId}`, { carrierId: B.carrierId }],
      ['PATCH', `/api/deciship/invoices/${A.invoiceId}`, { tariffId: B.tariffId }],
      ['PATCH', `/api/deciship/invoice-lines/${A.lineId}`, { measurementId: B.measurement.id }],
      ['POST', `/api/deciship/tariffs/${A.tariffId}/versions/${B.versionId}/restore`, {}],
      ['POST', `/api/deciship/tariffs/${A.tariffId}/country-adjustments`, { country: 'DE', pct: 5, invoiceId: B.invoiceId, source: 'invoice' }],
    ];
    const wrong: string[] = [];
    for (const [method, url, payload] of refused) {
      const res = await app.inject({ method: method as 'POST', url, headers: A.admin.auth, payload: payload as object });
      if (![400, 403, 404].includes(res.statusCode)) wrong.push(`${method} ${url} → ${res.statusCode} ${res.body.slice(0, 100)}`);
      for (const id of bIds) if (res.body.includes(id)) wrong.push(`${method} ${url} yanıtında ${id}`);
    }
    for (const url of ['/api/deciship/invoices/preview', '/api/deciship/invoices/samples', '/api/deciship/tariff-imports']) {
      const form = multipart(carrierPart(B.carrierId));
      const res = await app.inject({ method: 'POST', url, headers: { ...A.admin.auth, ...form.headers }, payload: form.payload });
      if (res.statusCode !== 404) wrong.push(`${url} → ${res.statusCode} ${res.body.slice(0, 100)}`);
    }
    const template = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/template.xlsx?tariffId=${B.tariffId}`, headers: A.admin.auth });
    if (template.statusCode !== 404) wrong.push(`template.xlsx → ${template.statusCode}`);
    expect(wrong).toEqual([]);

    const empty = async (url: string) => (await app.inject({ method: 'GET', url, headers: A.admin.auth })).json();
    expect((await empty(`/api/deciship/tariffs?carrierId=${B.carrierId}`)).items).toEqual([]);
    expect((await empty(`/api/deciship/invoices?carrierId=${B.carrierId}`)).items).toEqual([]);
    expect((await empty(`/api/deciship/measurements?userId=${B.worker.userId}`)).items).toEqual([]);
    expect((await empty(`/api/deciship/measurements?q=${B.measurement.trackingNo}`)).items).toEqual([]);
    expect(await empty(`/api/deciship/measurements/check?tracking=${B.measurement.trackingNo}`)).toEqual({ exists: false });

    // B'nin kolisi ölçümde kullanılamaz, B'nin clientId'si ele verilmez
    const withPreset = measurementPayload({ boxPresetId: B.presetId });
    const m = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...A.admin.auth, ...withPreset.headers }, payload: withPreset.payload });
    expect(m.json().measurement.boxPresetId).toBeNull();
    // clientId firmaya ve kişiye bağlıdır: B'nin değeri A için sıradan yeni kayıttır, var olduğu anlaşılmaz.
    const dup = measurementPayload({ clientId: B.measurement.clientId });
    const c = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...A.admin.auth, ...dup.headers }, payload: dup.payload });
    expect(c.statusCode).toBe(201);
    expect(c.body.includes(B.measurement.id)).toBe(false);

    expect(await snapshot()).toBe(before);
  });

  it('imzalı dosya bağlantısı başka firmaya ve başka dosyaya taşınamaz', async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${A.measurement.id}`, headers: A.admin.auth });
    const signed = new URL(detail.json().measurement.photos[0].url);
    const t = signed.searchParams.get('t')!;
    expect((await app.inject({ method: 'GET', url: signed.pathname + signed.search })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${B.photoId}?t=${t}` })).statusCode).toBe(404);
  });
});

describe('para sızıntısı: fiyat izni olmayan izin setleri', () => {
  /** Faturadaki gerçek tutarlar ve para alanlarının metin biçimleri: anahtar adı değişse de yakalansın. */
  const FORBIDDEN_TEXT = /invoiceLines|invoiceStatus|overcharge|verifiedTotal|billedTotal|expectedTotal|INVOICE_SOURCE/i;
  /**
   * Fatura ya da rapor görme izni olan sette fatura bilgisi (sayılar, durum) meşrudur, tutar değil: tutar alanının adı tırnak
   * içinde (anahtar ya da değer) geçmemeli. Pencere kimliği gibi parça eşleşmeleri (`overcharge-kpis`) tutar değildir.
   */
  const MONEY_TEXT = /"(overcharge|overchargeTotal|verifiedTotal|billedTotal|expectedTotal)"/i;
  /**
   * İkili yanıt (XLSX, PDF, ZIP, görsel): `stripMoney` işlemez, yalnız bunlar fiyatsız kişiye açık olabilir. Fotoğraf, ölçüm
   * kartı, boş tarife şablonu (doldurulmuşu fiyat izni ister), yapay zekâ dökümü (fiyat sütunları izne göre: services/hub/aiCalls.ts).
   */
  const PRICE_FREE_BINARY = new Set(['GET /reference-card.pdf', 'GET /files/:id', 'GET /tariffs/template.xlsx', 'GET /platform/ai-usage/calls/export']);
  /**
   * `findMoneyKeys` sözcük parçasıyla da yakalar (`charge`); bunlar tutar değildir, uygulamanın `stripMoney` kuralı da bırakır:
   * ağırlık (kg), kalem sayısı, eşleme sütun adları, ek ücret kalemleri (içindeki tutar alanı süzülür, iç anahtarlar yine denetlenir).
   */
  const NOT_MONEY = /\.(ourChargeableKg|surchargeCount|surchargeColumns|surcharges)$/;
  const isBinary = (type: string) => !type.includes('json') && !type.startsWith('text/');

  /**
   * Hepsi fikstürün ölçen çalışanının üyeliğiyle: kendi faturalı ölçümü de sınanır. `strict`: fatura görme izni yok, fatura
   * bilgisi de görünmemeli. Bozuk set Hesap'ın üretmediği jetondur (fiyat dışında her izin): sunucunun ikinci katını sınar.
   */
  const CASES = [
    { name: 'MEASURE (hazır rol, eski jeton)', perms: undefined },
    { name: 'fiyatsız en geniş geçerli set (özel rol)', perms: NO_PRICE_MAX },
    { name: 'bağımlılığı bozuk: fiyat dışında her izin', perms: BROKEN_NO_PRICE },
  ] as const;

  it.each(CASES.map((c) => [c.name, c] as const))('%s: girebildiği her uçta para yok (JSON, CSV, XLSX, PDF, dosya); girememesi gerekenler 403/404', async (_name, c) => {
    const app = await getApp();
    const f = await companyFixture(app);
    const routes = apiRoutes(app);
    const held: readonly string[] = c.perms ?? heldBy({ name: 'MEASURE', role: 'MEASURE' });
    // Özel rol jetonu bir üst epoch'la: jeton eşitlemesi yerel kaydı (rol + izin listesi) jetondan yazar, imzalı bağlantı da
    // gerçek hayattaki gibi yerel kayıttaki listeye göre karar verir (eski epoch'ta kayıt MEASURE/NULL kalırdı).
    const session = c.perms ? await f.worker.token({ role: customRoleKey(crypto.randomUUID()), perms: [...c.perms], epoch: f.worker.epoch + 1 }) : f.worker;
    if (c.perms) {
      expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: session.auth })).statusCode).toBe(200);
      const [row] = await inCompany(f.companyId, () => loadMemberAccess(f.companyId, [f.worker.userId]));
      expect(row).toMatchObject({ epoch: f.worker.epoch + 1, permissions: [...c.perms] });
    }
    const auth = session.auth;
    // Fatura ve rapor görme izni yoksa fatura bilgisi hiç görünmez; varsa yalnız tutar görünmez.
    const seesInvoices = held.includes('deciship.invoices.view');
    const sweepText = seesInvoices || held.includes('deciship.reports.view') ? MONEY_TEXT : FORBIDDEN_TEXT;
    const ownText = seesInvoices ? MONEY_TEXT : FORBIDDEN_TEXT;
    const moneyKeys = (body: unknown) => findMoneyKeys(body).filter((k) => !NOT_MONEY.test(k));
    const wrong: string[] = [];
    let visited = 0;

    for (const route of routes) {
      const rule = ROUTE_RULES[route.key];
      if (!rule || rule === 'public') continue;
      const urls = route.url.includes(':') ? fillParams(route, f) : [route.url];
      for (const url of urls) {
        const safe = route.method === 'GET';
        if (!permitted(rule, held)) {
          const res = await app.inject({ method: route.method as 'GET', url, headers: auth, ...(safe ? {} : { payload: {} }) });
          if (res.statusCode !== 403) wrong.push(`${route.key} → ${res.statusCode}`);
          continue;
        }
        // yazma uçları aşağıda ayrı denenir (ölçüm değişmesin)
        if (!safe) continue;
        const res = await app.inject({ method: 'GET', url: url + (GET_QUERY[route.key] ? `?${GET_QUERY[route.key]!(f)}` : ''), headers: auth });
        visited++;
        const type = String(res.headers['content-type'] ?? '');
        if (type.includes('json') && res.statusCode === 200) {
          const money = moneyKeys(res.json());
          if (money.length) wrong.push(`${route.key}: ${money.join(', ')}`);
        }
        if (res.statusCode === 200 && isBinary(type) && !PRICE_FREE_BINARY.has(route.key)) wrong.push(`${route.key}: fiyatlı ikili dosya (${type})`);
        if (res.body && !isBinary(type) && sweepText.test(res.body)) wrong.push(`${route.key}: yasak metin`);
      }
    }
    expect(visited).toBeGreaterThanOrEqual(7);
    expect(wrong).toEqual([]);

    // faturalı kendi ölçümü: fatura bağlantısı var (yöneticide), fiyatsız kişiye tutarı yansımaz
    const adminView = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${f.measurement.id}`, headers: f.admin.auth });
    expect(adminView.json().measurement.invoiceLines.length).toBeGreaterThan(0);
    const mine = await app.inject({ method: 'GET', url: `/api/deciship/measurements/${f.measurement.id}`, headers: auth });
    expect(mine.statusCode).toBe(200);
    expect(moneyKeys(mine.json())).toEqual([]);
    expect(mine.body).not.toMatch(ownText);

    // dosya: fatura kaynağı (fiyatlı) yok, kendi fotoğrafı var; fotoğraf bağlantısı imzası faturaya işlemez
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${f.invoiceFileId}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${f.photoId}`, headers: auth })).statusCode).toBe(200);
    const photoUrl = new URL(mine.json().measurement.photos[0].url);
    expect((await app.inject({ method: 'GET', url: `/api/deciship/files/${f.invoiceFileId}${photoUrl.search}` })).statusCode).toBe(404);
    // fatura ayrıntısını görebilen (bozuk set) imzalı kaynak bağlantısı alır; bağlantı fiyat izni olmadan açılmaz
    const detail = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${f.invoiceId}`, headers: auth });
    if (seesInvoices) {
      // yerel kayıt fatura görür ama fiyat görmez: 404'ün tek nedeni fiyat izni (files.ts `sourceOk`)
      const [row] = await inCompany(f.companyId, () => loadMemberAccess(f.companyId, [f.worker.userId]));
      expect(row!.permissions).toContain('deciship.invoices.view');
      expect(row!.permissions).not.toContain('deciship.prices.view');
      const signed = new URL(detail.json().invoice.fileUrl as string);
      expect(signed.searchParams.get('t')).toBeTruthy();
      expect((await app.inject({ method: 'GET', url: signed.pathname + signed.search })).statusCode).toBe(404);
      const adminSigned = new URL((await app.inject({ method: 'GET', url: `/api/deciship/invoices/${f.invoiceId}`, headers: f.admin.auth })).json().invoice.fileUrl as string);
      expect((await app.inject({ method: 'GET', url: adminSigned.pathname + adminSigned.search })).statusCode).toBe(200);
    } else {
      expect(detail.statusCode).toBe(403);
    }
    // rapor dosyaları, itiraz metni ve kanıt ZIP'i: dışa aktarma izni olsa bile fiyatsız 403
    for (const report of ['report.xlsx', 'report.pdf', 'dispute', 'dispute/evidence.zip']) {
      const res = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${f.invoiceId}/${report}`, headers: auth });
      expect([res.statusCode, res.json().error?.code], report).toEqual([403, 'FORBIDDEN']);
    }
    // doldurulmuş tarife şablonu (fiyatlı XLSX) da kapalı
    const template = await app.inject({ method: 'GET', url: `/api/deciship/tariffs/template.xlsx?tariffId=${f.tariffId}`, headers: auth });
    expect(template.statusCode).toBe(403);

    // CSV: dışa aktarma açıksa bile para sütunu yok (sütunların para biçimi yöneticinin veri seti tanımından)
    if (held.includes('deciship.data.export')) {
      let moneyColumns = 0;
      for (const id of ['invoices', 'invoice-lines', 'measurements', 'tariffs', 'carriers', 'box-presets', 'audit-log']) {
        const def = await app.inject({ method: 'GET', url: `/api/deciship/platform/datasets/${id}`, headers: f.admin.auth });
        const labels = (def.json().columns as { label: string; format?: string; currencyCell?: string }[])
          .filter((col) => col.format === 'money' || col.currencyCell)
          .map((col) => col.label);
        moneyColumns += labels.length;
        const csv = await app.inject({ method: 'GET', url: `/api/deciship/platform/datasets/${id}/export`, headers: auth });
        if (csv.statusCode !== 200) continue;
        const header = csv.body.replace(/^\uFEFF/, '').split(/\r?\n/)[0]!.split(/[;,]/).map((h) => h.replace(/^"|"$/g, ''));
        for (const label of labels) if (header.includes(label)) wrong.push(`${id}.csv: para sütunu ${label}`);
        if (MONEY_TEXT.test(csv.body)) wrong.push(`${id}.csv: yasak metin`);
      }
      expect(moneyColumns, 'yöneticide para sütunu yoksa denetim boş kalır').toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    }

    // yazma yanıtları
    const created = measurementPayload();
    const post = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...created.headers }, payload: created.payload });
    expect(post.statusCode).toBe(201);
    const patch = await app.inject({ method: 'PATCH', url: `/api/deciship/measurements/${f.measurement.id}`, headers: auth, payload: { weightKg: 2.5 } });
    expect(patch.statusCode).toBe(200);
    for (const r of [post, patch]) {
      expect(moneyKeys(r.json())).toEqual([]);
      expect(r.body).not.toMatch(ownText);
    }

    // ayarlar: para yok; yalnız ölçüm izni olan yalnız ölçüm için gerekenleri görür
    const settings = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: auth });
    expect(findMoneyKeys(settings.json())).toEqual([]);
    // Ayar yöneticisi (yalnız bozuk sette fiyatsız) firmanın para birimi kodunu ayar formunda görür: kod tutar değildir.
    if (!held.includes('deciship.settings.manage')) expect(settings.json()).not.toHaveProperty('currency');
    if (!c.perms) {
      expect(Object.keys(settings.json()).sort()).toEqual(['dataResetEnabled', 'desiDivisor', 'name', 'requiredBoxPhotos', 'scaleAiRead', 'warnEdgeCm', 'warnWeightKg']);
    }
  }, 120_000);

  it('süzme izne bağlı, role değil: fiyat izni olan muhasebe tutarları görür', async () => {
    const app = await getApp();
    const f = await companyFixture(app);
    const accounting = await issueIdentity({ companyId: f.companyId, role: 'ACCOUNTING' });
    const lines = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${f.invoiceId}/lines`, headers: accounting.auth });
    expect(lines.statusCode).toBe(200);
    expect(lines.json().items[0].netAmount).toEqual(expect.any(Number));
    // katalogda olmayan rol hiçbir izin taşımaz: oturum uçları da para vermez
    const stranger = await issueIdentity({ companyId: f.companyId, role: 'UYDURMA' });
    const settings = await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: stranger.auth });
    expect(settings.statusCode).toBe(200);
    expect(findMoneyKeys(settings.json())).toEqual([]);
    expect(settings.json()).not.toHaveProperty('currency');
  });
});
