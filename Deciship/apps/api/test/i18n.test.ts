/**
 * İsteğin dili (Accept-Language, oturum dili) ve kayıtlı Türkçe metnin okurken çevrilmesi; veritabanı ister. Metin
 * tablosu, kaynak kod taraması ve saf çeviri denetimleri veritabanısız `i18nText.test.ts`'te (hızlı grup).
 */
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { isFxMissingNote, isPakNote, readTariffFile, parseTariffImport } from '@deciship/core';
import { errorMessage } from '@sellerondata/contracts';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { MESSAGES } from '../src/i18n/messages.ts';
import { companyFixture, tariffPayload, type Fixture } from './fixtures.ts';
import { getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const EN = { 'accept-language': 'en' };
const TR_CHARS = /[ğüşıöçĞÜŞİÖÇ]/;

describe('fatura satırı dökümü', () => {
  it('gerçek fatura: EN liste ve satır düzeltme yanıtı İngilizce; kayıt Türkçe kalır', async () => {
    const app = await getApp();
    const admin = await registerCompany(app, uniq('Döküm '));
    const carrier = (await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: admin.auth, payload: { code: 'aras', name: 'Aras' } })).json().carrier.id as string;
    const tariff = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: admin.auth,
      payload: tariffPayload(carrier, { discountPct: 38, fuelPct: 25, surcharges: [], zones: [{ country: '*', zone: 'A' }], rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'A', weightUpto: i + 1, price: (i + 1) * 10 })), overflow: [{ zone: 'A', perUnit: 10 }] }),
    });
    expect(tariff.statusCode, tariff.body).toBe(201);
    const p = measurementPayload({ lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 6 });
    const tracking = (await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...admin.auth, ...p.headers }, payload: p.payload })).json().measurement.trackingNo as string;
    const form = multipart([{ name: 'carrierId', value: carrier }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from(`Takip No;Desi;Tutar\n${tracking};6;500`) }]);
    const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...admin.auth, ...form.headers }, payload: form.payload });
    const invoice = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: admin.auth, payload: { fileId: preview.json().fileId, carrierId: carrier, invoiceNo: uniq('F'), invoiceDate: '2026-10-15', currency: 'TRY', mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' }, acknowledgeIssues: true } });
    expect(invoice.statusCode, invoice.body).toBe(201);
    const id = invoice.json().invoice.id as string;
    const labels = (l: { breakdown: { label: string }[] }) => l.breakdown.map((b) => b.label);

    const list = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines`, headers: { ...admin.auth, ...EN } });
    const line = list.json().items[0];
    expect(labels(line)).toEqual([expect.stringMatching(/^Tariff price \(Zone A, /), 'Discount 38%', 'Fuel 25%']);

    const patched = await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${line.id}`, headers: { ...admin.auth, ...EN }, payload: { note: 'x' } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(labels(patched.json().line)).toEqual(labels(line));

    const stored = await inCompany(admin.auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id } }));
    expect((stored.breakdown as { label: string }[]).map((b) => b.label)).toEqual([expect.stringMatching(/^Tarife fiyatı \(Bölge A, /), 'İndirim %38', 'Yakıt %25']);
  });
});

describe('Accept-Language', () => {
  let app: FastifyInstance;
  let f: Fixture;
  beforeAll(async () => {
    app = await getApp();
    f = await companyFixture(app);
  });
  const get = (url: string, headers: Record<string, string> = EN) => app.inject({ method: 'GET', url, headers: { ...f.admin.auth, ...headers } });

  it('başlık yoksa ya da desteklenmiyorsa oturumun dili (burada Türkçe); en, en-US, kalıplı başlık İngilizce', async () => {
    const carrier = crypto.randomUUID();
    const msg = async (headers: Record<string, string>) => (await app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${carrier}`, headers: { ...f.admin.auth, ...headers }, payload: {} })).json().error;
    expect(await msg({})).toEqual({ code: 'NOT_FOUND', message: MESSAGES['carrier.notFound'].tr });
    expect(await msg({ 'accept-language': 'tr-TR' })).toMatchObject({ message: MESSAGES['carrier.notFound'].tr });
    expect(await msg({ 'accept-language': 'de' })).toMatchObject({ message: MESSAGES['carrier.notFound'].tr });
    for (const lang of ['en', 'en-US', 'en-US,en;q=0.9']) {
      expect(await msg({ 'accept-language': lang }), lang).toEqual({ code: 'NOT_FOUND', message: MESSAGES['carrier.notFound'].en });
    }
  });

  it('ilk açılış kuralı (karar 2026-11-12): başlıkta desteklenen dil, yoksa oturumun dili, o da yoksa İngilizce', async () => {
    const carrier = crypto.randomUUID();
    const enSession = (await f.admin.token({ locale: 'en' })).auth;
    const msg = async (auth: Record<string, string>, headers: Record<string, string>) =>
      (await app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${carrier}`, headers: { ...auth, ...headers }, payload: {} })).json().error.message;
    expect(await msg(enSession, {})).toBe(MESSAGES['carrier.notFound'].en);
    expect(await msg(enSession, { 'accept-language': 'de-DE' })).toBe(MESSAGES['carrier.notFound'].en);
    expect(await msg(enSession, { 'accept-language': 'de-DE,tr;q=0.5' })).toBe(MESSAGES['carrier.notFound'].tr);
    // Oturum yok, başlık yok ya da desteklenmiyor: İngilizce (eskiden Türkçe).
    const anon = async (headers: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/deciship/carriers', headers })).json().error.message;
    expect(await anon({})).toBe(errorMessage('UNAUTHORIZED', 'en'));
    expect(await anon({ 'accept-language': 'fr' })).toBe(errorMessage('UNAUTHORIZED', 'en'));
    expect(await anon({ 'accept-language': 'tr-TR' })).toBe(errorMessage('UNAUTHORIZED', 'tr'));
  });

  it('eşzamanlı isteklerde dil karışmaz', async () => {
    const url = `/api/deciship/tariffs/${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const lang = i % 2 ? 'en' : 'tr';
        const r = await app.inject({ method: 'GET', url, headers: { ...f.admin.auth, 'accept-language': lang } });
        return r.json().error.message === (lang === 'en' ? MESSAGES['invoice.tariffNotFound'].en : MESSAGES['invoice.tariffNotFound'].tr);
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it('doğrulama ayrıntısı, gövde hatası, olmayan sayfa çevrilir', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: { ...f.admin.auth, ...EN }, payload: { fileId: 'x', carrierId: 'y', invoiceNo: 'z', invoiceDate: 'dün' } });
    expect(bad.json().error.code).toBe('VALIDATION');
    expect(bad.json().error.message).toMatch(/^[A-Z][a-z ]+: /);
    expect(bad.json().error.details).toContainEqual({ path: 'invoiceDate', message: 'Invalid date' });
    const trBad = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: f.admin.auth, payload: { fileId: 'x', carrierId: 'y', invoiceNo: 'z', invoiceDate: 'dün' } });
    expect(trBad.json().error.details).toContainEqual({ path: 'invoiceDate', message: 'Geçersiz tarih' });

    const broken = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: { ...f.admin.auth, ...EN, 'content-type': 'application/json' }, payload: '{bozuk' });
    expect(broken.json().error.message).toBe(MESSAGES['err.validation'].en);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/yok', headers: EN })).json().error.message).toBe(MESSAGES['err.pageNotFound'].en);
    // Saat dilimi bu uçtan yazılmaz (Y131: tek yazarı Merkez); gönderilirse tanınmayan alan olarak reddedilir.
    const tz = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: { ...f.admin.auth, ...EN }, payload: { timeZone: 'Europe/Paris' } });
    expect(tz.statusCode, tz.body).toBe(400);
    expect(tz.json().error.code).toBe('VALIDATION');
  });

  it('kayıtlı Türkçe not okurken isteğin dilinde; veritabanı Türkçe kalır', async () => {
    const lines = async (headers: Record<string, string>) => (await get(`/api/deciship/invoices/${f.invoiceId}/lines`, headers)).json().items as { id: string; note: string | null; status: string; breakdown: { label: string }[] }[];
    const tr = await lines({});
    const en = await lines(EN);
    const withLabels = tr.find((l) => l.breakdown?.length);
    expect(withLabels).toBeDefined();
    const enLine = en.find((l) => l.id === withLabels!.id)!;
    expect(JSON.stringify(enLine.breakdown)).not.toMatch(TR_CHARS);
    expect(enLine.breakdown.map((b) => b.label)).not.toEqual(withLabels!.breakdown.map((b) => b.label));
    const stored = await inCompany(f.companyId, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: withLabels!.id } }));
    expect(JSON.stringify(stored.breakdown)).toBe(JSON.stringify(withLabels!.breakdown));
  });

  it('istemci not desenleri iki dilde de tanır (web LinePanel: kur ve pak)', async () => {
    const line = await inCompany(f.companyId, () => prisma.invoiceLine.findFirstOrThrow({ where: { id: f.lineId } }));
    const original = line.note;
    const note = 'Kur alınamadı (TRY→USD, 2026-10-15) — TCMB yanıt vermedi';
    await inCompany(f.companyId, () => prisma.invoiceLine.update({ where: { id: f.lineId }, data: { note, noteManual: true } }));
    const read = async (headers: Record<string, string>) => ((await get(`/api/deciship/invoices/${f.invoiceId}/lines`, headers)).json().items as { id: string; note: string }[]).find((l) => l.id === f.lineId)!.note;
    const en = await read(EN);
    expect(en).not.toBe(note);
    expect(en).not.toMatch(TR_CHARS);
    expect(isFxMissingNote(en)).toBe(true);
    expect(isFxMissingNote(await read({}))).toBe(true);
    await inCompany(f.companyId, () => prisma.invoiceLine.update({ where: { id: f.lineId }, data: { note: 'Pak/zarf gönderi: ölçüm karşılaştırılmaz', noteManual: true } }));
    expect(isPakNote(await read({})) === isPakNote(await read(EN))).toBe(true);
    await inCompany(f.companyId, () => prisma.invoiceLine.update({ where: { id: f.lineId }, data: { note: original, noteManual: false } }));
  });

  it('Excel raporu isteğin dilinde: sayfa, başlık, durum; tutarlar aynı', async () => {
    const load = async (headers: Record<string, string>) => {
      const r = await get(`/api/deciship/invoices/${f.invoiceId}/report.xlsx`, headers);
      expect(r.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.rawPayload as never);
      return { wb, disposition: r.headers['content-disposition'] as string };
    };
    const en = await load(EN);
    const tr = await load({});
    expect(en.wb.worksheets.map((s) => s.name)).toEqual(['Summary', 'Discrepancies', 'All lines', 'Unmatched']);
    expect(tr.wb.worksheets.map((s) => s.name)).toEqual(['Özet', 'Farklar', 'Tüm satırlar', 'Eşleşmeyenler']);
    expect(en.disposition).toContain('deciship-invoice-');
    expect(tr.disposition).toContain('deciship-fatura-');
    const header = en.wb.getWorksheet('All lines')!.getRow(1).values as string[];
    expect(header).toContain('Tracking no.');
    expect(JSON.stringify(header)).not.toMatch(TR_CHARS);
    const cellsOf = (wb: ExcelJS.Workbook, name: string, col: number) => {
      const out: unknown[] = [];
      wb.getWorksheet(name)!.eachRow((row, n) => {
        if (n > 1) out.push(row.getCell(col).value);
      });
      return out;
    };
    expect(cellsOf(en.wb, 'All lines', 18)).toEqual(cellsOf(tr.wb, 'Tüm satırlar', 18));
    const summary = JSON.stringify(en.wb.getWorksheet('Summary')!.getSheetValues());
    expect(summary).toContain('Invoice comparison report');
    expect(summary).toContain('Overcharge');
  });

  it('PDF raporu İngilizce üretilir', async () => {
    const r = await get(`/api/deciship/invoices/${f.invoiceId}/report.pdf`);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.headers['content-disposition']).toContain('deciship-invoice-');
  });

  it('tarife şablonu İngilizce üretilir ve geri okunur: sayfa ve satırlar aynı tarife', async () => {
    const full = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: f.admin.auth,
      payload: tariffPayload(f.carrierId, {
        isDefault: false,
        zones: [{ country: 'DE', zone: 'A' }],
        rates: [
          { zone: 'A', weightUpto: 1, price: 10 },
          { zone: 'A', weightUpto: 2.5, price: 20 },
          { zone: 'A', weightUpto: 99, price: 3, perKg: true },
        ],
        overflow: [{ zone: 'A', perUnit: 2 }],
        surcharges: [{ code: 'FUEL', name: 'Fuel', kind: 'PCT', amount: 5 }],
        countryAdjustments: [{ country: 'DE', pct: -5, source: 'manual' }],
      }),
    });
    expect(full.statusCode, full.body).toBe(201);
    const id = full.json().tariff.id as string;
    const en = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${id}`);
    const tr = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${id}`, {});
    expect(en.headers['content-disposition']).toContain('deciship-tariff-template.xlsx');
    expect(tr.headers['content-disposition']).toContain('deciship-tarife-sablonu.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(en.rawPayload as never);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Prices', 'Zones', 'Surcharges', 'Instructions']);
    const parse = async (buf: Buffer) => parseTariffImport(await readTariffFile('t.xlsx', new Uint8Array(buf)), {});
    const [pe, pt] = await Promise.all([parse(en.rawPayload), parse(tr.rawPayload)]);
    const rates = (p: Awaited<ReturnType<typeof parse>>) => p.rates.map((r) => [r.zone, r.weightUpto, r.price, !!r.perKg]);
    expect(rates(pe)).toEqual(rates(pt));
    expect(pe.overflow).toEqual(pt.overflow);
    expect(pe.zones).toEqual(pt.zones);
    expect(pe.surcharges).toEqual(pt.surcharges);
    expect(pe.rates.length).toBe(3);
  });

  it('itiraz metni: dil istekle seçilir, seçilmezse isteğin dili', async () => {
    const invoice = (await get(`/api/deciship/invoices/${f.invoiceId}/lines`, {})).json().items as { id: string; status: string }[];
    const diff = invoice.find((l) => l.status === 'DIFF');
    if (diff) await app.inject({ method: 'PATCH', url: `/api/deciship/invoice-lines/${diff.id}`, headers: f.admin.auth, payload: { decision: 'VERIFIED' } });
    const dispute = async (q: string, headers: Record<string, string>) => get(`/api/deciship/invoices/${f.invoiceId}/dispute${q}`, headers);
    const asEn = await dispute('', EN);
    if (asEn.statusCode === 400) {
      expect(asEn.json().error.message).toBe(MESSAGES['dispute.noDiffLines'].en);
      return;
    }
    expect(asEn.statusCode, asEn.body).toBe(200);
    expect(asEn.json().subject).not.toMatch(TR_CHARS);
    const forced = await dispute('?lang=tr', EN);
    const plain = await dispute('', {});
    expect(forced.json().subject).toBe(plain.json().subject);
    expect((await dispute('?lang=en', {})).json().subject).toBe(asEn.json().subject);
  });

  it('tarife sürüm etiketi kayıtta dilden bağımsız, okurken çevrilir', async () => {
    const versions = async (headers: Record<string, string>) => (await get(`/api/deciship/tariffs/${f.tariffId}/versions`, headers)).json().items as { label: string }[];
    expect((await versions({}))[0]!.label).toBe(MESSAGES['version.edit'].tr);
    expect((await versions(EN))[0]!.label).toBe(MESSAGES['version.edit'].en);
    const adj = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${f.tariffId}/country-adjustments`, headers: f.admin.auth, payload: { country: 'DE', pct: -5, source: 'manual' } });
    expect(adj.statusCode, adj.body).toBe(200);
    expect((await versions({}))[0]!.label).toMatch(/Almanya.*uygulanmadan önceki sürüm/);
    expect((await versions(EN))[0]!.label).toMatch(/^Version before applying .*Germany/);
  });

  it('fatura önizleme ve tarife içe aktarma denetimleri İngilizce; ayar sayfası kaynağı', async () => {
    const form = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: Buffer.from('Takip No;Desi;Tutar\n;3;x\n') },
    ]);
    const preview = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...f.admin.auth, ...form.headers, ...EN }, payload: form.payload });
    expect(preview.statusCode, preview.body).toBe(200);
    const diag = JSON.stringify(preview.json().diagnostics);
    expect(diag).not.toMatch(/[ğşıİ]/);

    const empty = multipart([
      { name: 'carrierId', value: f.carrierId },
      { name: 'file', filename: 'f.exe', contentType: 'application/octet-stream', data: Buffer.from('MZ\x90\x00') },
    ]);
    const bad = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...f.admin.auth, ...empty.headers, ...EN }, payload: empty.payload });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).not.toMatch(TR_CHARS);

    const tariffFile = multipart([{ name: 'file', filename: 't.csv', contentType: 'text/csv', data: Buffer.from('Weight;A\n1;10\n2;abc\n') }]);
    const imp = await app.inject({ method: 'POST', url: `/api/deciship/tariffs/${f.tariffId}/import`, headers: { ...f.admin.auth, ...tariffFile.headers, ...EN }, payload: tariffFile.payload });
    expect(imp.statusCode, imp.body).toBe(200);
    const checks = imp.json().checks as { title: string }[];
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c.title, c.title).not.toMatch(/[ğşıİ]/);

    const settings = await get('/api/deciship/settings');
    expect(settings.json().fxSource).not.toMatch(TR_CHARS);
    const health = await get(`/api/deciship/invoices/${f.invoiceId}/tariff-health`);
    expect(health.statusCode).toBe(200);
    expect(JSON.stringify(health.json()).replaceAll('Değişti', '')).not.toMatch(/[ğşıİ]/);
  });

  it('görüntü servisi kapalıyken kod ve yerelleşmiş mesaj', async () => {
    const img = multipart([{ name: 'image', filename: 's.jpg', contentType: 'image/jpeg', data: Buffer.from('x') }]);
    const r = await app.inject({ method: 'POST', url: '/api/deciship/vision/reference/detect', headers: { ...f.admin.auth, ...img.headers, ...EN }, payload: img.payload });
    expect(r.json().error).toEqual({ code: 'VISION_UNAVAILABLE', message: MESSAGES['vision.unavailable'].en });
  });

  it('firma adı boşsa bile ayar yanıtı dile göre kırılmaz', async () => {
    const reg = await registerCompany(app, 'Dil Firması');
    const r = await app.inject({ method: 'GET', url: '/api/deciship/me', headers: { ...reg.auth, ...EN } });
    expect(r.statusCode).toBe(200);
    expect(r.json().company.name).toBe('Dil Firması');
  });
});
