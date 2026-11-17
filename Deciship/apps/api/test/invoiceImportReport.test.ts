/**
 * Mesaj 5: CSV/Excel yüklemesinde faturaya alınmayan satırlar (`importReport`, 04-B11), oluşturmada son hesap anı
 * (`calculatedAt`) ve itiraz metnindeki ölçüm kanıtı (04-B8; ölçen kişinin adı metne girmez).
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { API, disputeCompany, trDay } from './disputeHelpers.ts';
import { getApp, inCompany, measurementPayload, multipart, registerCompany, uniq, writeTimeZone } from './helpers.ts';

type Auth = { authorization: string };
let app: FastifyInstance;

beforeAll(async () => {
  app = await getApp();
});

async function upload(auth: Auth, carrierId: string, csv: string) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
  ]);
  const p = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(p.statusCode, p.body).toBe(200);
  return app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    payload: {
      fileId: p.json().fileId,
      carrierId,
      invoiceNo: uniq('F'),
      invoiceDate: trDay(-3),
      currency: 'TRY',
      mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' },
      acknowledgeIssues: true,
    },
  });
}

describe('yükleme raporu (CSV)', () => {
  it('okunamayan ve takip no\'suz satırlar nedeni ve değeriyle faturaya yazılır ve yanıtta döner', async () => {
    const admin = await registerCompany(app, uniq('Rapor '));
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
    const carrierId = c.json().carrier.id as string;
    const t1 = uniq('7948');
    const t2 = uniq('7948');
    const t3 = uniq('7948');
    const csv = [
      'Takip No;Desi;Tutar',
      `${t1};3;100,00`,
      'XYZ-ABC;3;70,00', // takip no'da rakam yok
      `${t2};3;abc`, // tutar okunamadı
      ';0;45,00', // takip no'suz ücret
      `${t3};2;50,00`,
    ].join('\n');
    const before = Date.now();
    const r = await upload(admin.auth, carrierId, csv);
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body).not.toHaveProperty('skipped'); // Y28: eski alan kalktı, sayılar importReport'ta
    expect(body.errors.map((e: { code: string }) => e.code)).toEqual(['BAD_TRACKING', 'BAD_NET']);
    expect(body.importReport).toEqual({
      version: 1,
      source: 'table',
      rowsInFile: 5,
      linesImported: 2,
      skippedCount: 3,
      byReason: { BAD_TRACKING: 1, BAD_NET: 1, NO_TRACKING: 1 },
      skippedRows: [
        { row: 2, reason: 'BAD_TRACKING', trackingRaw: 'XYZ-ABC' },
        { row: 3, reason: 'BAD_NET', trackingRaw: t2, rawNet: 'abc' },
        { row: 4, reason: 'NO_TRACKING', amount: 45 },
      ],
      noTrackingAmount: 45,
    });
    const id = body.invoice.id as string;
    const row = await inCompany(admin.auth, () => prisma.invoice.findFirstOrThrow({ where: { id }, select: { importReport: true, calculatedAt: true } }));
    expect(row.importReport).toEqual(body.importReport);
    expect(row.calculatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const detail = (await app.inject({ method: 'GET', url: `${API}/invoices/${id}`, headers: admin.auth })).json().invoice;
    expect(detail.importReport).toEqual(body.importReport);
    expect(detail.basis.calculatedAt).toBe(row.calculatedAt!.toISOString());
    const log = await inCompany(admin.auth, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'invoice.import' } }));
    expect(log.data).toMatchObject({ lines: 2, skippedRows: 3 });
    expect((log.data as Record<string, unknown>).pdfUnverified).toBeUndefined();
  });

  it('toplam satırı dosya satırı sayılmaz: rowsInFile = alınan + alınmayan', async () => {
    const admin = await registerCompany(app, uniq('Rapor '));
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
    const data = Array.from({ length: 6 }, (_, i) => `${uniq('7948')};3;${10 + i},00`);
    const csv = [
      'Takip No;Desi;Tutar',
      ...data.slice(0, 3),
      'ABC-XYZ;3;70,00', // BAD_TRACKING
      `${uniq('7948')};3;abc`, // BAD_NET
      ';0;45,00', // takip no'suz ücret
      ';0;27,50', // takip no'suz ücret
      ...data.slice(3),
      'TOPLAM;;228,00', // toplam satırı: sessizce atlanır
      ';;', // boş satır
    ].join('\n');
    const r = await upload(admin.auth, c.json().carrier.id, csv);
    expect(r.statusCode, r.body).toBe(201);
    const rep = r.json().importReport;
    expect(rep).toMatchObject({ linesImported: 6, skippedCount: 4, byReason: { BAD_TRACKING: 1, BAD_NET: 1, NO_TRACKING: 2 } });
    expect(rep.rowsInFile).toBe(rep.linesImported + rep.skippedCount);
    expect(rep.rowsInFile).toBe(10);
  });

  it('her satır alınınca rapor boş ama yazılır', async () => {
    const admin = await registerCompany(app, uniq('Rapor '));
    const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: admin.auth, payload: { code: 'aras', name: uniq('Aras ') } });
    const r = await upload(admin.auth, c.json().carrier.id, ['Takip No;Desi;Tutar', `${uniq('7948')};3;100,00`].join('\n'));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport).toEqual({ version: 1, source: 'table', rowsInFile: 1, linesImported: 1, skippedCount: 0, byReason: {}, skippedRows: [] });
  });
});

describe('itiraz metninde ölçüm kanıtı', () => {
  it('ölçüm anı (firma saatiyle), yöntem ve fotoğraf sayısı yazılır; ölçen kişinin adı yazılmaz', async () => {
    const c = await disputeCompany(app);
    const day = trDay(-5);
    const measuredAt = `${day}T11:32:00.000Z`; // İstanbul 14:32
    const make = async (over: Record<string, unknown>, photos: number) => {
      const p = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2, measuredAt, ...over }, photos);
      const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...p.headers }, payload: p.payload });
      expect(m.statusCode, m.body).toBe(201);
      return m.json().measurement.trackingNo as string;
    };
    const withPhotos = await make({ dimMethod: 'LIDAR', weightMethod: 'OCR' }, 2);
    const noPhotos = await make({ dimMethod: 'MANUAL', weightMethod: 'MANUAL' }, 0);
    const r = await upload(c.admin.auth, c.carrierId, ['Takip No;Desi;Tutar', `${withPhotos};5;100,00`, `${noPhotos};5;80,00`].join('\n'));
    expect(r.statusCode, r.body).toBe(201);
    const invoiceId = r.json().invoice.id as string;
    const lines = (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines`, headers: c.admin.auth })).json().items as { id: string; status: string }[];
    expect(lines.map((l) => l.status)).toEqual(['DIFF', 'DIFF']);
    for (const l of lines) {
      const v = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${l.id}`, headers: c.admin.auth, payload: { decision: 'VERIFIED' } });
      expect(v.statusCode, v.body).toBe(200);
    }

    const tr = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute?lang=tr`, headers: c.admin.auth });
    expect(tr.statusCode, tr.body).toBe(200);
    const d = tr.json();
    expect(d).toMatchObject({ lineCount: 2, photoCount: 2, linesWithoutPhoto: 1 });
    const [y, mo, da] = day.split('-');
    expect(d.body).toContain(`Ölçüm kaydımız: ${da}.${mo}.${y} 14:32 · depo çalışanımız tarafından · ölçü: LiDAR, ağırlık: terazi ekranından okundu`);
    expect(d.body).toContain('ölçü: elle (metre), ağırlık: elle girildi');
    expect(d.body).toContain('   Fotoğraf: 2');
    expect(d.body).toContain('Ölçüm fotoğraflarımız (2 adet) ekteki ZIP dosyasındadır.');
    expect(d.body).not.toContain(c.worker.name);

    const en = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute?lang=en`, headers: c.admin.auth });
    expect(en.statusCode, en.body).toBe(200);
    expect(en.json()).toMatchObject({ photoCount: 2, linesWithoutPhoto: 1 });
    expect(en.json().body).toContain('14:32');
    expect(en.json().body).not.toContain(c.worker.name);

    // Silinmiş ölçüm kanıt sayılmaz
    const m = await inCompany(c.admin.auth, () => prisma.measurement.findFirstOrThrow({ where: { trackingNo: withPhotos } }));
    await inCompany(c.admin.auth, () => prisma.measurement.update({ where: { id: m.id }, data: { deletedAt: new Date() } }));
    const after = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/dispute`, headers: c.admin.auth });
    expect(after.json()).toMatchObject({ photoCount: 0, linesWithoutPhoto: 2 });
  });
});

describe('rapor: ölçüm zamanı firmanın saat diliminde', () => {
  it('İstanbul dışı saat dilimli firmada Excel ölçüm saati o dilimde yazılır', async () => {
    const c = await disputeCompany(app);
    // Saat dilimi Merkez'den gelir (Y131): doğrudan yazılır.
    await writeTimeZone(c.admin.companyId, 'Asia/Tokyo');
    const day = trDay(-5);
    const p = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2, measuredAt: `${day}T11:32:00.000Z` }, 1);
    const m = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.worker.auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    const r = await upload(c.admin.auth, c.carrierId, ['Takip No;Desi;Tutar', `${m.json().measurement.trackingNo};5;100,00`].join('\n'));
    expect(r.statusCode, r.body).toBe(201);
    const x = await app.inject({ method: 'GET', url: `${API}/invoices/${r.json().invoice.id}/report.xlsx`, headers: { ...c.admin.auth, 'accept-language': 'tr' } });
    expect(x.statusCode, x.body.slice(0, 200)).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? '')))));
    const [y, mo, da] = day.split('-');
    // Tokyo UTC+9 (yaz saati yok): 11:32Z → 20:32; İstanbul olsaydı 14:32
    expect(cells).toContain(`${da}.${mo}.${y} 20:32`);
    expect(cells.some((v) => v.includes('14:32'))).toBe(false);
  });
});
