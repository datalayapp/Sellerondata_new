// Kullanıcı kararları K2, K3, K43 (denetim 10-B10, 10-B18, 01-B9 seçenek b).
import crypto from 'node:crypto';
import { fmtMoney, withVat } from '@deciship/core';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { tariffForDate } from '../src/services/compare.ts';
import { invoiceVatPct } from '../src/services/evidence.ts';
import { knownPdfVatPct, pdfPreviewValue, readPdfPreview } from '../src/services/invoicePdfCheck.ts';
import { API, disputeCompany, invoiceWithDiffs } from './disputeHelpers.ts';
import { tariffPayload } from './fixtures.ts';
import { getApp, inCompany, issueIdentity, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';
import { heldBy, PERMISSION_SETS } from './routeRules.ts';

type Auth = { authorization: string };
let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

async function newCarrier(auth: Auth) {
  const r = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'generic', name: uniq('Taşıyıcı ') } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

async function newTariff(auth: Auth, carrierId: string, over: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: `${API}/tariffs`, headers: auth, payload: tariffPayload(carrierId, over) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().tariff.id as string;
}

/** Tek satırlık CSV yükler (önizleme + içe aktarma); `extra` içe aktarma gövdesine eklenir. */
async function importCsv(auth: Auth, carrierId: string, extra: Record<string, unknown> = {}, amount = '50,00') {
  const csv = ['Takip No;Desi;Tutar', `7948${String(crypto.randomInt(1e9)).padStart(10, '0')};5;${amount}`].join('\n');
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(preview.statusCode, preview.body).toBe(200);
  return app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    payload: {
      fileId: preview.json().fileId,
      carrierId,
      invoiceNo: uniq('K'),
      invoiceDate: '2026-10-15',
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
      ...extra,
    },
  });
}

describe('K2: yüklemede fatura gününde geçerli tarife, yoksa varsayılan', () => {
  it('kural (saf): geçerli olan; birden çoksa varsayılan, sonra dönemli, sonra en yeni; geçerli yoksa ya da gün yoksa varsayılan', () => {
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const t = (id: string, o: { isDefault?: boolean; active?: boolean; from?: string; to?: string; updated?: string } = {}) => ({
      id,
      active: o.active ?? true,
      isDefault: o.isDefault ?? false,
      validFrom: o.from ? d(o.from) : null,
      validTo: o.to ? d(o.to) : null,
      updatedAt: d(o.updated ?? '2026-01-01'),
    });
    const y2026 = t('2026', { isDefault: true, from: '2026-01-01', to: '2026-12-31' });
    const y2025 = t('2025', { from: '2025-01-01', to: '2025-12-31' });
    const open = t('süresiz', { updated: '2026-06-01' });
    const pasif = t('pasif', { active: false, from: '2024-01-01', to: '2024-12-31' });
    const list = [y2026, y2025, open, pasif];
    expect(tariffForDate(list, d('2025-12-15'))?.id).toBe('2025'); // dönemli, süresizden önce
    expect(tariffForDate(list, d('2025-12-31'))?.id).toBe('2025'); // son gün dahil
    expect(tariffForDate(list, d('2026-03-01'))?.id).toBe('2026'); // varsayılan da geçerli: varsayılan
    expect(tariffForDate([y2026, y2025], d('2024-06-01'))?.id).toBe('2026'); // geçerli yok: varsayılan
    expect(tariffForDate(list, d('2024-06-01'))?.id).toBe('süresiz'); // pasif sayılmaz; süresiz her gün geçerli
    expect(tariffForDate(list, null)?.id).toBe('2026'); // gün yok: varsayılan
    // eşitlikte en son güncellenen
    expect(tariffForDate([t('a', { updated: '2026-01-01' }), t('b', { updated: '2026-02-01' })], d('2026-05-01'))?.id).toBe('b');
    expect(tariffForDate([pasif], d('2024-06-01'))).toBeNull();
  });

  it('tarife verilmeyen içe aktarma: geçmiş dönem faturası o dönemin tarifesiyle, bugünkü varsayılanla değil; geçerli yoksa varsayılan', async () => {
    const admin = await registerCompany(app, uniq('K2 '));
    const carrierId = await newCarrier(admin.auth);
    const t2025 = await newTariff(admin.auth, carrierId, { name: 'Yıl 2025', isDefault: false, validFrom: '2025-01-01', validTo: '2025-12-31' });
    const t2026 = await newTariff(admin.auth, carrierId, { name: 'Yıl 2026', isDefault: true, validFrom: '2026-01-01', validTo: '2026-12-31' });
    const tariffOf = async (invoiceDate: string) => {
      const r = await importCsv(admin.auth, carrierId, { invoiceDate });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().invoice.tariffId as string | null;
    };
    expect(await tariffOf('2025-12-15')).toBe(t2025);
    expect(await tariffOf('2026-10-15')).toBe(t2026);
    expect(await tariffOf('2024-06-01')).toBe(t2026); // o gün geçerli tarife yok: varsayılan
    // istemcinin açık seçimi kurala takılmaz (geçerlilik dışı da olsa)
    const chosen = await importCsv(admin.auth, carrierId, { invoiceDate: '2025-12-15', tariffId: t2026 });
    expect(chosen.json().invoice.tariffId).toBe(t2026);
    // tarifesiz taşıyıcı: tarife yok (fatura dayanaksız), bugünkü gibi
    const bare = await newCarrier(admin.auth);
    const none = await importCsv(admin.auth, bare, { invoiceDate: '2025-12-15' });
    expect(none.statusCode, none.body).toBe(201);
    expect(none.json().invoice).toMatchObject({ tariffId: null, tariff: null });
  });

  it('başlık düzeltmesinde taşıyıcı değişince yeni taşıyıcının fatura gününde geçerli tarifesi', async () => {
    const admin = await registerCompany(app, uniq('K2 düzeltme '));
    const from = await newCarrier(admin.auth);
    await newTariff(admin.auth, from, { name: 'Eski taşıyıcı', isDefault: true });
    const to = await newCarrier(admin.auth);
    const old = await newTariff(admin.auth, to, { name: 'Yeni 2025', isDefault: false, validFrom: '2025-01-01', validTo: '2025-12-31' });
    const cur = await newTariff(admin.auth, to, { name: 'Yeni 2026', isDefault: true, validFrom: '2026-01-01' });
    const r = await importCsv(admin.auth, from, { invoiceDate: '2025-11-20' });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().invoice.id as string;
    const pre = await app.inject({ method: 'POST', url: `${API}/invoices/${id}/recalculate/preview`, headers: admin.auth, payload: { basis: 'pinned', patch: { carrierId: to } } });
    expect(pre.statusCode, pre.body).toBe(200);
    const moved = await app.inject({ method: 'PATCH', url: `${API}/invoices/${id}`, headers: admin.auth, payload: { carrierId: to, token: pre.json().token } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().invoice).toMatchObject({ carrier: { id: to }, tariffId: old });
    expect(cur).not.toBe(old);
  });
});

describe('K3: taşıyıcının kayıtlı sütun eşlemesini yalnız ayar izni (Yönetici) değiştirir', () => {
  it('her izin seti: yükleme izni olan herkes yükler; "Bu eşlemeyi hatırla" yalnız deciship.settings.manage ile yazılır', async () => {
    const admin = await registerCompany(app, uniq('K3 '));
    const uploaders = PERMISSION_SETS.filter((s) => heldBy(s).includes('deciship.invoices.upload'));
    // hazır roller: Yönetici yazar, Denetleyici ve Muhasebe yazamaz; özel roller izin listesine göre
    expect(uploaders.map((s) => s.name)).toEqual(expect.arrayContaining(['ADMIN', 'AUDITOR', 'ACCOUNTING']));
    const seen: Record<string, boolean> = {};
    for (const set of uploaders) {
      const who = await issueIdentity({ companyId: admin.companyId, orgName: admin.orgName, role: set.role, ...(set.perms ? { perms: [...set.perms] } : {}), name: set.name });
      const carrierId = await newCarrier(admin.auth); // her set kendi taşıyıcısında: önceki kayıt karışmaz
      const r = await importCsv(who.auth, carrierId, { saveMapping: true });
      expect(r.statusCode, `${set.name}: ${r.body}`).toBe(201);
      const c = await inCompany(admin.auth, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierId } }));
      const saved = c.defaultMapping != null;
      seen[set.name] = saved;
      expect(saved, set.name).toBe(heldBy(set).includes('deciship.settings.manage'));
      if (saved) expect(c.defaultMapping).toMatchObject({ trackingNo: 'Takip No', netAmount: 'Tutar' });
    }
    expect(seen).toMatchObject({ ADMIN: true, AUDITOR: false, ACCOUNTING: false });
  });

  it('Muhasebe kutu işaretsizken de ve PATCH /carriers ile de değiştiremez; Yönetici kutu işaretsizse yazmaz', async () => {
    const admin = await registerCompany(app, uniq('K3b '));
    const accounting = await issueIdentity({ companyId: admin.companyId, orgName: admin.orgName, role: 'ACCOUNTING', name: 'Muhasebe' });
    const carrierId = await newCarrier(admin.auth);
    expect((await importCsv(admin.auth, carrierId, { saveMapping: false })).statusCode).toBe(201);
    expect((await inCompany(admin.auth, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierId } }))).defaultMapping).toBeNull();
    const patch = await app.inject({ method: 'PATCH', url: `${API}/carriers/${carrierId}`, headers: accounting.auth, payload: { defaultMapping: { trackingNo: 'X', netAmount: 'Y' } } });
    expect(patch.statusCode).toBe(403);
  });
});

describe('K43: itiraz metninde KDV hariç ve KDV dahil tutar', () => {
  it('faturanın KDV oranı (saklanan eşlemeden): "Tutarlar KDV dahil" tablo, oranı bilinen PDF; değilse yok', () => {
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b', amountsIncludeVat: true, vatPct: 20 })).toBe(20);
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b', amountsIncludeVat: true, vatPct: 10 })).toBe(10);
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b', amountsIncludeVat: true })).toBe(20);
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b', amountsIncludeVat: false, vatPct: 20 })).toBeNull();
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b' })).toBeNull();
    expect(invoiceVatPct({ trackingNo: 'a', netAmount: 'b', amountsIncludeVat: true, vatPct: 0 })).toBeNull();
    expect(invoiceVatPct({ source: 'ai', vatPct: 18 })).toBe(18);
    expect(invoiceVatPct({ source: 'ai' })).toBeNull(); // eski PDF faturası
    expect(invoiceVatPct(null)).toBeNull();
    // PDF okuması: belgede oran (KDV sözcüğünün yanında) yazıyorsa o; yazmıyorsa yalnız tutarlar KDV dahil okunduysa
    // kullanılan oran; KDV belirsizse yok (metin kanıtı: inceleme 2026-11-13, pdfInvoiceReview.test.ts)
    const pageTexts = ['KDV %20  20,00', 'KDV %0  0,00'];
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts })).toBe(20);
    expect(knownPdfVatPct({ rawVatPct: null, amountsIncludeVat: true, usedVatPct: 20, vatUnclear: false, pageTexts })).toBe(20);
    expect(knownPdfVatPct({ rawVatPct: null, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts })).toBeNull();
    expect(knownPdfVatPct({ rawVatPct: 20, amountsIncludeVat: true, usedVatPct: 20, vatUnclear: true, pageTexts })).toBeNull();
    expect(knownPdfVatPct({ rawVatPct: 0, amountsIncludeVat: false, usedVatPct: 20, vatUnclear: false, pageTexts })).toBe(0);
    // önizleme kaydı oranı taşır; bozuk değer okunmaz
    expect(readPdfPreview(pdfPreviewValue({ invoiceVatPct: 20 }))?.invoiceVatPct).toBe(20);
    expect(readPdfPreview(pdfPreviewValue({ invoiceVatPct: null }))?.invoiceVatPct).toBeUndefined();
    expect(readPdfPreview({ v: 1, invoiceVatPct: 'yirmi' })?.invoiceVatPct).toBeUndefined();
    expect(readPdfPreview({ v: 1, invoiceVatPct: 500 })?.invoiceVatPct).toBeUndefined();
  });

  it('KDV dahil okunan fatura: satırda faturalanan ve toplam talep iki hâliyle; yanıt KDV dahil toplamı verir', async () => {
    const c = await disputeCompany(app);
    // 132,97 KDV dahil → 110,81 KDV hariç saklanır (denetimdeki Aras örneği); metin 132,97'yi geri yazar
    const csv = ['Takip No;Desi;Tutar'];
    const trackings: string[] = [];
    for (let i = 0; i < 2; i++) {
      const mp = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...mp.headers }, payload: mp.payload });
      expect(m.statusCode, m.body).toBe(201);
      trackings.push(m.json().measurement.trackingNo);
    }
    csv.push(`${trackings[0]};5;132,97`, `${trackings[1]};5;100,01`);
    const form = multipart([
      { name: 'carrierId', value: c.carrierId },
      { name: 'file', filename: 'kdvli.csv', contentType: 'text/csv', data: Buffer.from(csv.join('\n')) },
    ]);
    const preview = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.admin.auth, ...form.headers }, payload: form.payload });
    expect(preview.statusCode, preview.body).toBe(200);
    const inv = await app.inject({
      method: 'POST',
      url: `${API}/invoices`,
      headers: c.admin.auth,
      payload: {
        fileId: preview.json().fileId,
        carrierId: c.carrierId,
        invoiceNo: uniq('KDV'),
        invoiceDate: '2026-10-15',
        currency: 'TRY',
        mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar', amountsIncludeVat: true, vatPct: 20 },
        acknowledgeIssues: true,
      },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    const invoiceId = inv.json().invoice.id as string;
    const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: c.admin.auth })).json().items as { id: string; netAmount: number; status: string }[];
    expect(lines.map((l) => l.netAmount)).toEqual([110.81, 83.34]);
    expect(lines.map((l) => l.status)).toEqual(['DIFF', 'DIFF']);
    for (const l of lines) {
      const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l.id}`, headers: c.admin.auth, payload: { decision: 'VERIFIED' } });
      expect(v.statusCode, v.body).toBe(200);
    }

    const tr = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute?lang=tr`, headers: c.admin.auth });
    expect(tr.statusCode, tr.body).toBe(200);
    const d = tr.json() as { body: string; total: number; vatPct: number; totalInclVat: number };
    expect(d.body).toContain('Faturalanan tutar: 110,81 ₺ (KDV hariç) · KDV dahil (%20): 132,97 ₺');
    expect(d.body).toContain('Faturalanan tutar: 83,34 ₺ (KDV hariç) · KDV dahil (%20): 100,01 ₺');
    expect(d.vatPct).toBe(20);
    expect(d.totalInclVat).toBe(withVat(d.total, 20));
    expect(d.body).toContain(`Toplam talep edilen düzeltme: KDV hariç ${fmtMoney(d.total, 'TRY')}, KDV dahil (%20) ${fmtMoney(d.totalInclVat, 'TRY')}`);
    const en = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute?lang=en`, headers: c.admin.auth });
    expect(en.json().body).toContain('Billed amount: 110.81 TRY (excl. VAT) · incl. VAT (20%): 132.97 TRY');
    expect(en.json().body).toContain('incl. VAT (20%)');
  });

  it('KDV hariç eşlenen fatura: metin yalnız KDV hariç, yanıtta KDV dahil alan yok', async () => {
    const c = await disputeCompany(app);
    const { invoiceId } = await invoiceWithDiffs(app, c, [100]);
    const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute?lang=tr`, headers: c.admin.auth });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().body).not.toContain('KDV dahil');
    expect(r.json().body).toContain('(KDV hariç)');
    expect(r.json()).not.toHaveProperty('vatPct');
    expect(r.json()).not.toHaveProperty('totalInclVat');
  });
});
