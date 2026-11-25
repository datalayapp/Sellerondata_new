/**
 * K36 (kullanıcı kararı 2026-11-14) içe aktarmada, sunucu tarafı (bağımsız inceleme bulguları):
 * - Tablo faturası: "1.500" ağırlık seçimi yalnız ağırlığı belirler (`weightFormat`); tutarlar ve öbür sütunlar değişmez.
 *   Seçimsiz içe aktarma onayla da geçmez (409 `WEIGHT_FORMAT_REQUIRED`). Seçim taşıyıcının kayıtlı eşlemesine yazılmaz.
 * - PDF faturası: yapay zekâ "1.500"ı düz sayı döndürür; metinde iki türlü basılı ağırlıklı satır seçilmeden alınmaz
 *   (409 `PDF_WEIGHT_CHOICE_REQUIRED`, onayla da geçmez), seçilince alınır ve bayrak yazılmaz.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

let nextText = '';
vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: nextText }] }) }) } };
  }
  return { ...actual, default: FakeAnthropic };
});

type Auth = { authorization: string };

const MAPPING = {
  trackingNo: 'Takip No',
  netAmount: 'Tutar',
  actualKg: 'Kg',
  surchargeColumns: [],
  chargePairs: [],
  amountsIncludeVat: false,
  vatPct: 20,
  desiAsWeight: false,
};

describe('K36: "1.500" ağırlık içe aktarmada', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let carrierId = '';
  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app)).auth;
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'aras', name: 'Aras K36' } });
    expect(c.statusCode, c.body).toBe(201);
    carrierId = c.json().carrier.id;
  });

  async function previewTable(
    // inceleme örneği: Türkçe tutarlar, karışık yazılmış ağırlıklar (biçim dosyadan anlaşılmıyor)
    rows: string[][] = [
      ['1.234,56', '0.5'],
      ['125,50', '1.500'],
      ['980,00', '2.25'],
    ],
  ) {
    const csv = ['Takip No;Tutar;Kg', ...rows.map(([amt, kg], i) => `${uniq('7948')}${i};${amt};${kg}`)].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    return p.json() as { fileId: string; suggestedMapping: Record<string, unknown> };
  }
  const verify = (fileId: string, mapping: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/verify', headers: auth, payload: { fileId, carrierId, mapping } });
  const create = (fileId: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId, carrierId, invoiceNo: uniq('K36-'), invoiceDate: '2026-10-15', currency: 'TRY', ...extra },
    });

  it('tablo: seçimsiz onayla da alınmaz; "1,5 kg" seçilince yalnız ağırlık değişir, tutar 1234,56 kalır', async () => {
    const { fileId } = await previewTable();
    const v = await verify(fileId, MAPPING);
    expect(v.statusCode, v.body).toBe(200);
    const d = v.json().diagnostics;
    expect(d.weightAmbiguity).toEqual({ sample: '1.500', rows: 1, decimal: 1.5, thousands: 1500 });
    expect(d.verification.issues.join()).toMatch(/Ağırlık yazımı belli değil/);

    const refused = await create(fileId, { mapping: MAPPING, acknowledgeIssues: true });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('WEIGHT_FORMAT_REQUIRED');
    // sayı biçimi ipucu da soruyu cevaplamaz (yapay zekânın ya da kayıtlı eşlemenin `numberFormat`ı)
    const hinted = await create(fileId, { mapping: { ...MAPPING, numberFormat: 'en' }, acknowledgeIssues: true });
    expect(hinted.json().error?.code).toBe('WEIGHT_FORMAT_REQUIRED');

    const chosen = { ...MAPPING, weightFormat: 'en' };
    const ok = await create(fileId, { mapping: chosen, acknowledgeIssues: true, saveMapping: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const id = ok.json().invoice.id as string;
    const lines = await inCompany(auth, () =>
      prisma.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { rowIndex: 'asc' }, select: { netAmount: true, actualKg: true } }),
    );
    expect(lines.map((l) => Number(l.netAmount))).toEqual([1234.56, 125.5, 980]);
    expect(lines.map((l) => Number(l.actualKg))).toEqual([0.5, 1.5, 2.25]);

    // seçim dosya başınadır: taşıyıcının kayıtlı eşlemesine yazılmaz, sonraki dosyada yine sorulur
    const carrier = await inCompany(auth, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierId }, select: { defaultMapping: true } }));
    expect(carrier.defaultMapping).toMatchObject({ actualKg: 'Kg' });
    expect(carrier.defaultMapping).not.toHaveProperty('weightFormat');
    const next = await previewTable();
    expect(next.suggestedMapping).not.toHaveProperty('weightFormat');
    const again = await create(next.fileId, { mapping: next.suggestedMapping, acknowledgeIssues: true });
    expect(again.json().error?.code).toBe('WEIGHT_FORMAT_REQUIRED');
  });

  it('tablo: "1.500 kg" seçimi 1500 okur; kayıtlı eşlemeyi elle yazmak da seçimi saklamaz', async () => {
    const { fileId } = await previewTable();
    const ok = await create(fileId, { mapping: { ...MAPPING, weightFormat: 'tr' }, acknowledgeIssues: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const lines = await inCompany(auth, () =>
      prisma.invoiceLine.findMany({ where: { invoiceId: ok.json().invoice.id }, orderBy: { rowIndex: 'asc' }, select: { netAmount: true, actualKg: true } }),
    );
    expect(lines.map((l) => [Number(l.netAmount), Number(l.actualKg)])).toEqual([
      [1234.56, 0.5],
      [125.5, 1500],
      [980, 2.25],
    ]);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/deciship/carriers/${carrierId}`,
      headers: auth,
      payload: { defaultMapping: { ...MAPPING, weightFormat: 'en' } },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const carrier = await inCompany(auth, () => prisma.carrier.findFirstOrThrow({ where: { id: carrierId }, select: { defaultMapping: true } }));
    expect(carrier.defaultMapping).not.toHaveProperty('weightFormat');
  });

  it('PDF: basılı "1.500" kg satırı seçilmeden alınmaz (onayla da); seçilince alınır, bayrak yazılmaz', async () => {
    const tracks = [uniq('7948'), uniq('7948')];
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ['FATURA PDF-K36', `${tracks[0]} 20.10.2026 1.500 100,00`, `${tracks[1]} 20.10.2026 2,5 200,00`].forEach((r, i) =>
      page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }),
    );
    const pdf = Buffer.from(await doc.save());
    const blank = {
      shipDate: null,
      service: null,
      destCountry: null,
      billedKg: null,
      dimL: null,
      dimW: null,
      dimH: null,
      billedDivisor: null,
      baseAmount: null,
      discountAmount: null,
      fuelAmount: null,
      surcharges: [],
      reference: null,
      currency: null,
    };
    nextText = JSON.stringify({
      invoiceNo: 'PDF-K36',
      invoiceDate: '2026-10-20',
      currency: 'TRY',
      weightUnit: 'kg',
      amountsIncludeVat: false,
      lines: [
        { ...blank, trackingNo: tracks[0], actualKg: 1.5, netAmount: 100 },
        { ...blank, trackingNo: tracks[1], actualKg: 2.5, netAmount: 200 },
      ],
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
      ]);
      const p = await viaJob(app, { method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
      expect(p.statusCode, p.body).toBe(200);
      const preview = p.json();
      const row0 = preview.aiLines[0].rowIndex as number;
      // önizleme satırı işaretler (bayrak değil; `unverified` sayılmaz)
      expect(preview.pdfCheck.rows).toEqual([{ rowIndex: row0, codes: [], weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } } }]);
      expect(preview.pdfCheck.unverified).toBe(0);

      const body = { fileId: preview.fileId, carrierId, invoiceNo: uniq('PDFK36-'), invoiceDate: '2026-10-20', currency: 'TRY', lines: preview.aiLines };
      for (const extra of [{}, { acknowledgeIssues: true }]) {
        const refused = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { ...body, ...extra } });
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json().error.code).toBe('PDF_WEIGHT_CHOICE_REQUIRED');
        expect(refused.json().error.details.rows).toEqual([{ rowIndex: row0, weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } } }]);
      }
      // kullanıcı "1.500 kg" seçti: satır 1500 kg ile gelir ve seçim bildirilir
      const lines = preview.aiLines.map((l: { rowIndex: number }, i: number) => (i === 0 ? { ...l, actualKg: 1500 } : l));
      const ok = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { ...body, lines, pdfWeightConfirmed: [row0] } });
      expect(ok.statusCode, ok.body).toBe(201);
      const saved = await inCompany(auth, () =>
        prisma.invoiceLine.findMany({ where: { invoiceId: ok.json().invoice.id }, orderBy: { rowIndex: 'asc' }, select: { actualKg: true, parseFlags: true } }),
      );
      expect(saved.map((l) => Number(l.actualKg))).toEqual([1500, 2.5]);
      // PDF bayrağı yok (seçim bayrak değildir); 1500 kg koli için olağan dışı olduğundan eski `WEIGHT_RANGE` kuralı işaretler
      expect(saved.map((l) => l.parseFlags)).toEqual([['WEIGHT_RANGE'], []]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('PDF: tutar "2.000 TL" / "1.500 TL" yazılı, ağırlık tek türlü basılı satır sorulmaz, eskisi gibi alınır', async () => {
    const tracks = [uniq('7948'), uniq('7948')];
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ['FATURA PDF-K36B', `${tracks[0]} 2 kg 2.000 TL`, `${tracks[1]} 1,5 kg 1.500 TL`].forEach((r, i) =>
      page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }),
    );
    const pdf = Buffer.from(await doc.save());
    const blank = {
      shipDate: null,
      service: null,
      destCountry: null,
      billedKg: null,
      dimL: null,
      dimW: null,
      dimH: null,
      billedDivisor: null,
      baseAmount: null,
      discountAmount: null,
      fuelAmount: null,
      surcharges: [],
      reference: null,
      currency: null,
    };
    nextText = JSON.stringify({
      invoiceNo: 'PDF-K36B',
      invoiceDate: '2026-10-20',
      currency: 'TRY',
      weightUnit: 'kg',
      amountsIncludeVat: false,
      lines: [
        { ...blank, trackingNo: tracks[0], actualKg: 2, netAmount: 2000 },
        { ...blank, trackingNo: tracks[1], actualKg: 1.5, netAmount: 1500 },
      ],
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
      ]);
      const p = await viaJob(app, { method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
      expect(p.statusCode, p.body).toBe(200);
      const preview = p.json();
      expect(preview.pdfCheck.rows.filter((r: { weightAmbiguity?: unknown }) => r.weightAmbiguity)).toEqual([]);
      const ok = await app.inject({
        method: 'POST',
        url: '/api/deciship/invoices',
        headers: auth,
        payload: { fileId: preview.fileId, carrierId, invoiceNo: uniq('PDFK36B-'), invoiceDate: '2026-10-20', currency: 'TRY', lines: preview.aiLines },
      });
      expect(ok.statusCode, ok.body).toBe(201);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // kullanıcı kararı 2026-11-14: biçim kanıtı olmayan dosyada virgüllü "1,500" de sorulur (eskiden sessizce 1,5)
  it('tablo: kanıtsız dosyada "1,500" kg seçimsiz alınmaz; seçim yalnız ağırlığa', async () => {
    const { fileId } = await previewTable([
      ['100', '1,500'],
      ['200', '2'],
    ]);
    const v = await verify(fileId, MAPPING);
    expect(v.json().diagnostics.weightAmbiguity).toEqual({ sample: '1,500', rows: 1, decimal: 1.5, thousands: 1500 });
    const refused = await create(fileId, { mapping: MAPPING, acknowledgeIssues: true });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('WEIGHT_FORMAT_REQUIRED');
    const ok = await create(fileId, { mapping: { ...MAPPING, weightFormat: 'en' }, acknowledgeIssues: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const lines = await inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId: ok.json().invoice.id }, orderBy: { rowIndex: 'asc' }, select: { netAmount: true, actualKg: true } }));
    expect(lines.map((l) => [Number(l.netAmount), Number(l.actualKg)])).toEqual([
      [100, 1500],
      [200, 2],
    ]);
  });
});
