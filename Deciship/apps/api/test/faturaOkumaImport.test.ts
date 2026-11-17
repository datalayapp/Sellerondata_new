/**
 * KALANLAR 1.3, 1.4, 1.6, 1.13, 5.19 uçtan uca (önizleme → okuma kontrolü → içe aktarma):
 * - 1.4: taşıyıcının kayıtlı eşlemesindeki `numberFormat: 'en'` Türkçe dosyada "2.010,00"ı 2,01 okumaz.
 * - 1.3: "KDV; Toplam Fiyat" dosyasında toplam KDV dahil tanınır, net KDV hariç yazılır.
 * - 1.6: çok sayfalı Excel'de okunmayan gönderi sayfası onay ister (409 `MAPPING_UNVERIFIED`), ileti sayfayı adıyla söyler.
 * - 1.13: bilimsel yazıma dönmüş takip no'lu dosya onayla da alınmaz (400 `TRACKING_SCIENTIFIC`).
 * - 5.19: Excel'in sayıya çevirdiği uzun takip no tek uyarı, onayla alınır; değer düzeltilmez.
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';

type Auth = { authorization: string };

describe('fatura okuma: gerçek dosya tuzakları', () => {
  let app: FastifyInstance;
  let auth: Auth;

  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app)).auth;
  });

  async function carrier(code: string, name: string) {
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code, name } });
    expect(c.statusCode, c.body).toBe(201);
    return c.json().carrier.id as string;
  }

  async function preview(carrierId: string, filename: string, data: Buffer, contentType = 'text/csv') {
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename, contentType, data },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    return p.json() as {
      fileId: string;
      mappingSource: string;
      suggestedMapping: Record<string, unknown>;
      diagnostics: { numberFormat: string; numberFormatSource: string; sheets?: unknown; verification: { verdict: string; issues: string[] } };
    };
  }

  const create = (carrierId: string, fileId: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId, carrierId, invoiceNo: uniq('OKU-'), invoiceDate: '2026-11-05', currency: 'TRY', ...extra },
    });

  const netsOf = (invoiceId: string) =>
    inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' }, select: { netAmount: true } })).then((ls) =>
      ls.map((l) => Number(l.netAmount)),
    );

  it('1.4: kayıtlı "en" sayı biçimi Türkçe dosyanın kanıtını ezmez', async () => {
    const carrierId = await carrier('yurtici', 'Yurtiçi 1.4');
    const mapping = { trackingNo: 'Takip No', netAmount: 'Tutar', surchargeColumns: [], chargePairs: [], amountsIncludeVat: false, vatPct: 20, desiAsWeight: false, numberFormat: 'en' };
    const patch = await app.inject({ method: 'PATCH', url: `/api/deciship/carriers/${carrierId}`, headers: auth, payload: { defaultMapping: mapping } });
    expect(patch.statusCode, patch.body).toBe(200);
    const csv = ['Takip No;Tutar', `${uniq('6200')}1;2.010,00`, `${uniq('6200')}2;150,50`].join('\n');
    const p = await preview(carrierId, 'yk.csv', Buffer.from(csv));
    expect(p.mappingSource).toBe('saved');
    expect(p.suggestedMapping.numberFormat).toBe('en');
    expect(p.diagnostics).toMatchObject({ numberFormat: 'tr', numberFormatSource: 'detected', verification: { verdict: 'ok' } });
    const ok = await create(carrierId, p.fileId, { mapping: p.suggestedMapping });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await netsOf(ok.json().invoice.id)).toEqual([2010, 150.5]);
  });

  it('1.3: "KDV; Toplam Fiyat" KDV dahil tanınır; net KDV hariç yazılır', async () => {
    const carrierId = await carrier('mng', 'MNG 1.3');
    const mngCsv = () => ['Gönderi No;Desi;KDV;Toplam Fiyat', `${uniq('5710')}1;10;20,00;120,00`, `${uniq('5710')}2;7;28,26;169,56`].join('\n');
    const csv = mngCsv();
    const p = await preview(carrierId, 'mng.csv', Buffer.from(csv));
    expect(p.suggestedMapping).toMatchObject({ netAmount: 'Toplam Fiyat', amountsIncludeVat: true, vatPct: 20 });
    expect(p.diagnostics.verification.verdict).toBe('ok');
    const ok = await create(carrierId, p.fileId, { mapping: p.suggestedMapping });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await netsOf(ok.json().invoice.id)).toEqual([100, 141.3]);

    // aynı dosya KDV hariç sayılırsa okuma kontrolü sorar; onaysız alınmaz
    const again = await preview(carrierId, 'mng2.csv', Buffer.from(mngCsv()));
    const wrong = { ...again.suggestedMapping, amountsIncludeVat: false };
    const v = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/verify', headers: auth, payload: { fileId: again.fileId, carrierId, mapping: wrong } });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().diagnostics.verification.issues.join('\n')).toContain('tutarlar KDV dahil görünüyor');
    const refused = await create(carrierId, again.fileId, { mapping: wrong });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MAPPING_UNVERIFIED');
  });

  it('1.6: okunmayan gönderi sayfası adıyla söylenir ve onay ister', async () => {
    const carrierId = await carrier('generic', 'Genel 1.6');
    const wb = new ExcelJS.Workbook();
    const headers = ['Takip No', 'Tarih', 'Desi', 'Tutar'];
    const a = wb.addWorksheet('Yurtiçi');
    a.addRow(headers);
    for (let i = 0; i < 6; i++) a.addRow([`${uniq('7948')}${i}`, '05.11.2026', '3', '100,00']);
    const b = wb.addWorksheet('Yurtdışı');
    b.addRow(headers);
    for (let i = 0; i < 4; i++) b.addRow([`${uniq('7949')}${i}`, '05.11.2026', '3', '200,00']);
    const p = await preview(carrierId, 'fatura.xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(p.diagnostics.sheets).toEqual({ read: 'Yurtiçi', unread: [{ name: 'Yurtdışı', rows: 4, invoiceLike: true }] });
    expect(p.diagnostics.verification.issues.join('\n')).toContain('Okunmayan sayfada gönderi satırı var: "Yurtdışı" (4 satır). Yalnız "Yurtiçi" sayfası okundu');
    const refused = await create(carrierId, p.fileId, { mapping: p.suggestedMapping });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MAPPING_UNVERIFIED');
    expect(refused.json().error.details.issues.join('\n')).toContain('"Yurtdışı" (4 satır)');
    const ok = await create(carrierId, p.fileId, { mapping: p.suggestedMapping, acknowledgeIssues: true });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await netsOf(ok.json().invoice.id)).toHaveLength(6);
  });

  it('1.13: bilimsel yazıma dönmüş takip no onayla da alınmaz; ileti ne yapılacağını söyler', async () => {
    const carrierId = await carrier('aras', 'Aras 1.13');
    const csv = ['Takip No;Tarih;Tutar', '1,23457E+11;05.11.2026;100,00', '7,94612E+11;05.11.2026;50,00', `${uniq('7948')}1;05.11.2026;20,00`].join('\n');
    const p = await preview(carrierId, 'bozuk.csv', Buffer.from(csv));
    expect(p.diagnostics.verification.issues.join('\n')).toContain('Takip no Excel\'de bozulmuş: 2 satırda bilimsel yazıma dönmüş (ör. "1,23457E+11")');
    const refused = await create(carrierId, p.fileId, { mapping: p.suggestedMapping, acknowledgeIssues: true });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'TRACKING_SCIENTIFIC', details: { count: 2, sample: '1,23457E+11' } });
    expect(refused.json().error.message).toContain('Veri > Metinden/CSV\'den');
    const en = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: { ...auth, 'accept-language': 'en' },
      payload: { fileId: p.fileId, carrierId, invoiceNo: uniq('OKU-'), invoiceDate: '2026-11-05', currency: 'TRY', mapping: p.suggestedMapping, acknowledgeIssues: true },
    });
    expect(en.json().error.message).toContain('Tracking numbers were damaged by Excel: on 2 rows');
  });

  it('5.19: Excel sayıya çevirmiş uzun takip no önizlemede tek uyarı, onay ister; değer düzeltilmeden alınır', async () => {
    const carrierId = await carrier('generic', 'Genel 5.19');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fatura');
    ws.addRow(['Takip No', 'Tarih', 'Desi', 'Tutar']);
    // 19 haneli, 15. haneden sonrası sıfır (Excel'in sakladığı biçim); firmalar arası çakışmasın diye rastgele baş.
    const base = 1e18 + Math.floor(Math.random() * 9e3) * 1e14;
    const nums = [base, base + 1e14];
    for (const n of nums) ws.addRow([n, '05.11.2026', '3', '100,00']);
    const p = await preview(carrierId, 'uzun.xlsx', Buffer.from(await wb.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const warn = 'Takip numaraları Excel\'de sayıya çevrilmiş görünüyor; son haneler bozulmuş olabilir. Dosyayı CSV olarak dışa aktarın ya da sütunu Metin yapın.';
    expect(p.diagnostics.verification.issues.filter((i) => i === warn)).toHaveLength(1);
    const refused = await create(carrierId, p.fileId, { mapping: p.suggestedMapping });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MAPPING_UNVERIFIED');
    const ok = await create(carrierId, p.fileId, { mapping: p.suggestedMapping, acknowledgeIssues: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const lines = await inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId: ok.json().invoice.id }, orderBy: { rowIndex: 'asc' }, select: { trackingNo: true } }));
    expect(lines.map((l) => l.trackingNo)).toEqual(nums.map((n) => n.toFixed(0)));
  });
});
