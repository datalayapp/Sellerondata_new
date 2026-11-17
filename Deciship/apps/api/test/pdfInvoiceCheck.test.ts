/**
 * Mesaj 5 (04-B11, 04-B12): PDF fatura satırları PDF'in kendi metniyle denetlenir. Tutmayan satır işaretlenir, fatura
 * yine yüklenir (onay kapısı yok); takip no'suz satırlar yükleme raporuna girer; yeniden karşılaştırma PDF bayraklarını
 * silmez. Yapay zekâ sahte SDK ile (gerçek çağrı yok); PDF metni pdf-lib ile üretilir.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { m } from '../src/i18n/index.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

let nextText = '';

vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: nextText }] }) }),
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

const API = '/api/deciship';
type Auth = { authorization: string };

const blank = {
  shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
  billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], currency: null, reference: null,
};
const aiLine = (trackingNo: string, netAmount: number) => ({ ...blank, trackingNo, netAmount });

/** Metin katmanlı PDF: her satır bir metin satırı. */
async function textPdf(rows: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  rows.forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}

/** Taranmış belge gibi: metin yok, yalnız çizim. */
async function scannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 40, y: 600, width: 300, height: 120 });
  return Buffer.from(await doc.save());
}

const PDF_ROWS = [
  'FATURA 9-482-11735',
  '794812345305 20.10.2026 1.642,50',
  '794812345306 21.10.2026 250,00',
  '794812345307 22.10.2026 100,00',
];

let app: FastifyInstance;
let auth: Auth;
let companyId: string;
let carrierId: string;

beforeAll(async () => {
  app = await getApp();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const admin = await registerCompany(app, uniq('PDF '));
  auth = admin.auth;
  companyId = admin.companyId;
  const c = await app.inject({ method: 'POST', url: `${API}/carriers`, headers: auth, payload: { code: 'fedex', name: uniq('FedEx ') } });
  expect(c.statusCode, c.body).toBe(201);
  carrierId = c.json().carrier.id;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

// Mesaj 6: aynı PDF aynı firmada önceki okumayı ücretsiz alır. Testler aynı dosyayı farklı sahte yanıtla yeniden okur.
beforeEach(() => inCompany(companyId, () => prisma.aiResultCache.deleteMany({})));

/** `extra`: Y20 alanları (`vatPct`, `weightUnit`); verilmezse yanıtta hiç yok (Y20 öncesi yanıt / önbellek gibi). */
async function preview(pdf: Buffer, lines: object[], amountsIncludeVat = false, extra: Record<string, unknown> = {}) {
  nextText = JSON.stringify({ invoiceNo: '9-482-11735', invoiceDate: '2026-10-27', currency: 'TRY', amountsIncludeVat, ...extra, lines });
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
  ]);
  // Y83: PDF okuma yalnız arka planda; `viaJob` işin sonucunu eski yanıt biçiminde verir
  const r = await viaJob(app, { method: 'POST', url: `${API}/invoices/preview`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

function importPdf(fileId: string, lines: unknown[]) {
  return app.inject({
    method: 'POST',
    url: `${API}/invoices`,
    headers: auth,
    // aynı takip no'ları her testte yeniden yüklenir: çakışma uyarısı bu dosyanın konusu değil
    payload: { fileId, carrierId, invoiceNo: uniq('P'), invoiceDate: '2026-10-27', currency: 'TRY', lines, confirmOverlap: true },
  });
}

async function linesOf(invoiceId: string, query = '') {
  const r = await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}/lines?pageSize=100${query}`, headers: auth });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as { id: string; rowIndex: number; trackingNo: string; parseFlags: string[] }[];
}

const pdfFlags = (flags: string[]) => flags.filter((f) => f.startsWith('PDF_'));

describe('PDF satırları PDF metniyle denetlenir', () => {
  it('önizleme: tutmayan takip no ve tutar işaretlenir; takip no\'suz ücret satırı sayılır', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [
      aiLine('794812345305', 1642.5),
      aiLine('794812345399', 100), // metinde yok
      aiLine('794812345306', 999.99), // tutar metinde yok
      aiLine('', 45), // takip no'suz ücret
      aiLine('', 0), // ücret değil, sayılmaz
    ]);
    expect(p.aiLines.map((l: { trackingNo: string }) => l.trackingNo)).toEqual(['794812345305', '794812345399', '794812345306']);
    expect(p.pdfCheck).toEqual({
      method: 'text',
      checked: 3,
      unverified: 2,
      // Y23: satır no yapay zekâ çıktısındaki sıra (0 tabanlı; ekranda +1), takip no'suz satırlarla aynı ölçek
      rows: [
        { rowIndex: 1, codes: ['PDF_TRACKING_UNVERIFIED'] },
        { rowIndex: 2, codes: ['PDF_AMOUNT_UNVERIFIED'] },
      ],
    });
    expect(p.aiSkipped).toEqual({ count: 1, amount: 45 });
  });

  it('yükleme: sunucu saklanan PDF\'i kendisi denetler; tutmayan satırla fatura yine yüklenir (409 yok), rapor yazılır', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [
      aiLine('794812345305', 1642.5),
      aiLine('794812345399', 100),
      aiLine('794812345306', 999.99),
      aiLine('', 45),
      aiLine('', 0),
    ]);
    // Kullanıcı 2. satırın takip no'sunu PDF'teki değere düzeltti: sunucu düzeltilmiş değeri denetler, satır temiz çıkar.
    const sent = p.aiLines.map((l: { trackingNo: string }) => (l.trackingNo === '794812345399' ? { ...l, trackingNo: '794812345307' } : l));
    const r = await importPdf(p.fileId, sent);
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body.skipped).toBeUndefined();
    expect(body.importReport).toEqual({
      version: 1,
      source: 'pdf',
      rowsInFile: 4, // alınan 3 + takip no'suz 1 (tutarı 0 olan satır sayılmaz)
      linesImported: 3,
      skippedCount: 1,
      byReason: { NO_TRACKING: 1 },
      skippedRows: [{ row: 4, reason: 'NO_TRACKING', amount: 45 }],
      noTrackingAmount: 45,
      pdfCheck: { method: 'text', checked: 3, unverified: 1 },
    });
    const invoiceId = body.invoice.id as string;

    const lines = await linesOf(invoiceId);
    const byTracking = new Map(lines.map((l) => [l.trackingNo, l]));
    expect(pdfFlags(byTracking.get('794812345305')!.parseFlags)).toEqual([]);
    expect(pdfFlags(byTracking.get('794812345307')!.parseFlags)).toEqual([]);
    expect(pdfFlags(byTracking.get('794812345306')!.parseFlags)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    // "Kontrol edilecek": sert bayrak, süzgeçte ve sayıda görünür
    const flagged = await linesOf(invoiceId, '&flagged=true');
    expect(flagged.map((l) => l.trackingNo)).toContain('794812345306');
    const detail = (await app.inject({ method: 'GET', url: `${API}/invoices/${invoiceId}`, headers: auth })).json().invoice;
    expect(detail.totals.flaggedLines).toBeGreaterThanOrEqual(1);

    // Faturada saklanır; son hesap anı oluşturmada yazılır
    const row = await inCompany(companyId, () => prisma.invoice.findFirstOrThrow({ where: { id: invoiceId }, select: { importReport: true, calculatedAt: true } }));
    expect(row.importReport).toEqual(body.importReport);
    expect(row.calculatedAt).toBeInstanceOf(Date);

    // Denetim kaydı sayıyı taşır
    const log = await inCompany(companyId, () => prisma.auditLog.findFirstOrThrow({ where: { entityId: invoiceId, action: 'invoice.import' } }));
    expect(log.data).toMatchObject({ pdfUnverified: 1, skippedRows: 1 });

    // Yeniden karşılaştırma okuma bayraklarını tazeler; PDF bayrağını silmez
    const rc = await app.inject({ method: 'POST', url: `${API}/invoices/${invoiceId}/recompare`, headers: auth });
    expect(rc.statusCode, rc.body).toBe(200);
    const after = await linesOf(invoiceId);
    expect(pdfFlags(after.find((l) => l.trackingNo === '794812345306')!.parseFlags)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    expect(after.filter((l) => pdfFlags(l.parseFlags).length).map((l) => l.trackingNo)).toEqual(['794812345306']);
    // Bayrak "Kontrol ettim" ile kapanır ama silinmez
    const line306 = after.find((l) => l.trackingNo === '794812345306')!;
    const chk = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${line306.id}`, headers: auth, payload: { parseChecked: true } });
    expect(chk.statusCode, chk.body).toBe(200);
    expect(chk.json().line.parseFlags).toContain('PDF_AMOUNT_UNVERIFIED');
    expect((await linesOf(invoiceId, '&flagged=true')).map((l) => l.trackingNo)).not.toContain('794812345306');
  });

  it('istemcinin gönderdiği satırlar da denetlenir: metinde olmayan elle eklenmiş satır işaretlenir', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5)]);
    const r = await importPdf(p.fileId, [...p.aiLines, { rowIndex: 10000, trackingNo: '794899999999', netAmount: 12.34, surcharges: [] }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfCheck).toEqual({ method: 'text', checked: 2, unverified: 1 });
    const lines = await linesOf(r.json().invoice.id);
    expect(pdfFlags(lines.find((l) => l.trackingNo === '794899999999')!.parseFlags)).toEqual(['PDF_TRACKING_UNVERIFIED', 'PDF_AMOUNT_UNVERIFIED']);
    expect(pdfFlags(lines.find((l) => l.trackingNo === '794812345305')!.parseFlags)).toEqual([]);
    // önizlemede takip no'suz satır yoktu
    expect(r.json().importReport).toMatchObject({ skippedCount: 0, byReason: {} });
    expect(r.json().importReport.noTrackingAmount).toBeUndefined();
  });

  it('KDV dahil basılmış tutar da bulunur (net × 1,2 ± 1 kuruş)', async () => {
    // yapay zekâ "yalnız KDV dahil basılı" dedi: satır neti 1.642,50 / 1,2 = 1.368,75; metinde KDV dahil hâli var
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5), aiLine('', 60)], true);
    expect(p.aiLines[0].netAmount).toBe(1368.75);
    expect(p.pdfCheck).toMatchObject({ method: 'text', checked: 1, unverified: 0, rows: [] });
    // takip no'suz satırın tutarı da aynı KDV kuralıyla net
    expect(p.aiSkipped).toEqual({ count: 1, amount: 50 });
  });

  it('yinelenen satır no: bayrak başka satıra geçmez (satırlar sırayla numaralanır)', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5)]);
    const r = await importPdf(p.fileId, [
      { rowIndex: 1, trackingNo: '794812345305', netAmount: 1642.5, surcharges: [] },
      { rowIndex: 1, trackingNo: '794812345306', netAmount: 999.99, surcharges: [] },
    ]);
    expect(r.statusCode, r.body).toBe(201);
    const lines = await linesOf(r.json().invoice.id);
    // Y23 (inceleme 6): yedek numaralama da yeni ölçekte (0 tabanlı; ekranda +1)
    expect(lines.map((l) => l.rowIndex)).toEqual([0, 1]);
    expect(pdfFlags(lines.find((l) => l.trackingNo === '794812345305')!.parseFlags)).toEqual([]);
    expect(pdfFlags(lines.find((l) => l.trackingNo === '794812345306')!.parseFlags)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });

  it('gerçek PDF metninde yakınlık: alt satırın tutarı bu satırınki sayılmaz (pdfjs satır sonlarını taşır)', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 250), aiLine('794812345306', 250), aiLine('794812345307', 100)]);
    expect(p.pdfCheck.rows).toEqual([{ rowIndex: 0, codes: ['PDF_AMOUNT_UNVERIFIED'] }]);
  });

  it('sınırlar PDF okunmadan: 5.000 satır üstü 400 VALIDATION, boş liste 400 NO_LINES', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5)]);
    const many = Array.from({ length: 5001 }, (_, i) => ({ trackingNo: `7948${i}`, netAmount: 1, surcharges: [] }));
    const big = await importPdf(p.fileId, many);
    expect(big.statusCode, big.body.slice(0, 200)).toBe(400);
    expect(big.json().error.code).toBe('VALIDATION');
    const empty = await importPdf(p.fileId, []);
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().error.code).toBe('NO_LINES');
    // 5.000 satır kabul edilir
    const ok = await importPdf(p.fileId, many.slice(0, 5000));
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(201);
  }, 120_000);

  it('metin katmanı yoksa (taranmış PDF) denetim yapılmaz, satır işaretlenmez', async () => {
    const p = await preview(await scannedPdf(), [aiLine('794812345305', 1642.5)]);
    expect(p.pdfCheck).toEqual({ method: 'none', checked: 0, unverified: 0, rows: [] });
    expect(p.aiSkipped).toEqual({ count: 0 });
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfCheck).toEqual({ method: 'none', checked: 0, unverified: 0 });
    const lines = await linesOf(r.json().invoice.id);
    expect(lines.flatMap((l) => pdfFlags(l.parseFlags))).toEqual([]);
  });

  it('saklanan dosya okunamazsa yükleme durmaz: denetim "none", önizleme kaydı yoksa takip no\'suz sayı yazılmaz', async () => {
    const file = await inCompany(companyId, async () => {
      const member = await prisma.member.findFirstOrThrow({ where: { companyId } });
      return prisma.file.create({
        data: { companyId, kind: 'INVOICE_SOURCE', mime: 'application/pdf', size: 1, path: `yok/${uniq('f')}.pdf`, sha256: uniq('s'), createdById: member.id },
      });
    });
    const r = await importPdf(file.id, [{ trackingNo: '794812345305', netAmount: 10, surcharges: [] }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport).toEqual({
      version: 1,
      source: 'pdf',
      rowsInFile: 1,
      linesImported: 1,
      skippedCount: 0,
      byReason: {},
      skippedRows: [],
      pdfCheck: { method: 'none', checked: 0, unverified: 0 },
    });
  });
});

describe('Y20: KDV oranı ve ağırlık birimi PDF\'ten okunur; okunmadıysa varsayım rapora yazılır', () => {
  // KDV dahil basılı tutarlar: %18 ile 1.180,00 → net 1.000,00; 590,00 → net 500,00
  const VAT_ROWS = ['FATURA 9-482-11735 KDV %18', '794812345305 20.10.2026 1.180,00', '794812345306 21.10.2026 590,00'];

  it('okunan oran (%18) nete çevirmede ve metin denetiminde kullanılır; varsayım yok', async () => {
    const p = await preview(await textPdf(VAT_ROWS), [aiLine('794812345305', 1180), aiLine('794812345306', 590)], true, { vatPct: 18, weightUnit: 'kg' });
    expect(p.aiLines.map((l: { netAmount: number }) => l.netAmount)).toEqual([1000, 500]);
    expect(p.pdfCheck).toMatchObject({ method: 'text', checked: 2, unverified: 0 });
    expect(p.warning).not.toContain(m('invoice.pdfVatAssumed', { pct: 20 }, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    // içe aktarma da önizleme kaydındaki %18 ile denetler (sabit %20 ile 1.000 × 1,2 = 1.200 metinde yok, işaretlenirdi)
    expect(r.json().importReport.pdfCheck).toEqual({ method: 'text', checked: 2, unverified: 0 });
    expect(r.json().importReport.pdfRead).toBeUndefined();
  });

  it('oran okunmadıysa %20 varsayılır: önizlemede uyarı, kayıtta ve içe aktarma raporunda not', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5)], true);
    expect(p.aiLines[0].netAmount).toBe(1368.75);
    expect(p.warning).toContain(m('invoice.pdfVatAssumed', { pct: 20 }, 'tr'));
    const file = await inCompany(companyId, () => prisma.file.findFirstOrThrow({ where: { id: p.fileId }, select: { preview: true } }));
    expect(file.preview).toMatchObject({ read: { vatPct: 20, weightUnit: 'kg', vatAssumed: true } });
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    // satırda ölçü yok: ölçü birimi varsayımı notu yok, yalnız kullanılan birim (cm)
    expect(r.json().importReport.pdfRead).toEqual({ vatPct: 20, weightUnit: 'kg', dimUnit: 'cm', vatAssumed: true });
  });

  it('lb okunduysa ağırlıklar kg\'a çevrilir (CSV ile aynı kural); raporda çeviri notu', async () => {
    const lb = { ...aiLine('794812345305', 1642.5), actualKg: 10, billedKg: 12.5 };
    const p = await preview(await textPdf(PDF_ROWS), [lb], false, { weightUnit: 'lb' });
    expect(p.aiLines[0]).toMatchObject({ actualKg: 4.536, billedKg: 5.67 });
    expect(p.warning).toContain(m('invoice.pdfWeightLb', undefined, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfRead).toEqual({ vatPct: 20, weightUnit: 'lb', dimUnit: 'cm' });
  });

  it('birim okunmadıysa kg varsayılır (ağırlık varsa not); KDV hariç tutarda oran notu yok', async () => {
    const kg = { ...aiLine('794812345305', 1642.5), actualKg: 2.5 };
    const p = await preview(await textPdf(PDF_ROWS), [kg]);
    expect(p.aiLines[0].actualKg).toBe(2.5);
    expect(p.warning).toContain(m('invoice.pdfWeightAssumed', undefined, 'tr'));
    expect(p.warning).not.toContain(m('invoice.pdfVatAssumed', { pct: 20 }, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfRead).toEqual({ vatPct: 20, weightUnit: 'kg', dimUnit: 'cm', weightAssumed: true });
  });
});

describe('Y31: yapay zekânın atladığı satır PDF metninden yakalanır', () => {
  it('okunmayan takip no önizlemede uyarı, içe aktarma raporunda "okunmamış olabilir"; fatura yine yüklenir', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5), aiLine('794812345306', 250)]);
    expect(p.warning).toContain(m('invoice.pdfMissed', { count: 1, list: '794812345307' }, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport).toMatchObject({ skippedCount: 0, linesImported: 2, pdfMissed: { count: 1, trackings: ['794812345307'] } });
    // Kullanıcı eksik satırı eklediyse rapor temiz (içe aktarma gönderilen satırlarla yeniden bakar)
    const p2 = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5), aiLine('794812345306', 250)]);
    const r2 = await importPdf(p2.fileId, [...p2.aiLines, { rowIndex: 10000, trackingNo: '794812345307', netAmount: 100, surcharges: [] }]);
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().importReport.pdfMissed).toBeUndefined();
  });

  it('hepsi okunduysa ya da metin katmanı yoksa aday yok (fatura no "9-482-11735" aday değil)', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5), aiLine('794812345306', 250), aiLine('794812345307', 100)]);
    expect(p.warning).toBe(m('invoice.aiReadWarning', undefined, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.pdfMissed).toBeUndefined();
    const s = await preview(await scannedPdf(), [aiLine('794812345305', 1642.5)]);
    const rs = await importPdf(s.fileId, s.aiLines);
    expect(rs.statusCode, rs.body).toBe(201);
    expect(rs.json().importReport.pdfMissed).toBeUndefined();
  });
});

describe('Y23: alınmayan satırın no\'su faturaya alınan satırlarla aynı ölçekte', () => {
  it('satır no yapay zekâ çıktısındaki sıra: alınan satırlar 1, 3, 4; takip no\'suz satır 2', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5), aiLine('', 45), aiLine('794812345306', 250), aiLine('794812345307', 100)]);
    expect(p.aiLines.map((l: { rowIndex: number }) => l.rowIndex)).toEqual([0, 2, 3]);
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().importReport.skippedRows).toEqual([{ row: 2, reason: 'NO_TRACKING', amount: 45 }]);
    // ekranda ve raporda görünen no `rowIndex + 1`
    const lines = await linesOf(r.json().invoice.id);
    expect(lines.map((l) => l.rowIndex + 1).sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });
});

describe('Y20 incelemesi: yanlış okunan oran, ölçü birimi, yedek satır no', () => {
  it('oran 10 okundu ama metinde "KDV %20": önizlemede uyarı, içe aktarmada bütün satırlar PDF_VAT_UNCLEAR ("İncele")', async () => {
    // KDV dahil 1.200,00; model %10 dedi → net 1.090,91 ve tutar denetimi 1.090,91 × 1,10 = 1.200,00'ı bulur (temiz görünür)
    const rows = ['FATURA 9-482-11735 KDV %20', '794812345305 20.10.2026 1.200,00'];
    const p = await preview(await textPdf(rows), [aiLine('794812345305', 1200)], true, { vatPct: 10 });
    expect(p.aiLines[0].netAmount).toBe(1090.91);
    expect(p.pdfCheck).toMatchObject({ unverified: 0 });
    expect(p.pdfReview).toMatchObject({ vatUnclear: true });
    expect(p.warning).toContain(m('invoice.pdfVatRateUnverified', { pct: 10 }, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.statusCode, r.body).toBe(201);
    const lines = await linesOf(r.json().invoice.id);
    expect(lines.every((l) => l.parseFlags.includes('PDF_VAT_UNCLEAR'))).toBe(true);
    expect(r.json().importReport.pdfRead).toMatchObject({ vatPct: 10, vatUnverified: true });
  });

  it('ölçüler inç okunduysa cm\'ye çevrilir (× 2,54), raporda not; okunmadıysa cm varsayımı notu', async () => {
    const box = { ...aiLine('794812345305', 1642.5), dimL: 10, dimW: 5, dimH: 2 };
    const p = await preview(await textPdf(PDF_ROWS), [box], false, { dimUnit: 'in', weightUnit: 'kg' });
    expect(p.aiLines[0].dims).toEqual({ l: 25.4, w: 12.7, h: 5.08 });
    expect(p.warning).toContain(m('invoice.pdfDimIn', undefined, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.json().importReport.pdfRead).toMatchObject({ dimUnit: 'in' });
    // başka bayt (önbellek bir önceki okumayı vermesin)
    const q = await preview(await textPdf([...PDF_ROWS, 'Sayfa 1']), [box]);
    expect(q.aiLines[0].dims).toEqual({ l: 10, w: 5, h: 2 });
    expect(q.warning).toContain(m('invoice.pdfDimAssumed', undefined, 'tr'));
  });

  it('tanınmayan ağırlık birimi (oz): ağırlık kullanılmaz, uyarı ve rapor notu', async () => {
    const oz = { ...aiLine('794812345305', 1642.5), actualKg: 16 };
    const p = await preview(await textPdf(PDF_ROWS), [oz], false, { weightUnit: 'oz' });
    expect(p.aiLines[0].actualKg).toBeUndefined();
    expect(p.warning).toContain(m('invoice.pdfWeightUnusable', undefined, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.json().importReport.pdfRead).toMatchObject({ weightUnusable: true });
  });

  it('lb okundu ama değer zaten kg yazılmış (PDF\'te "10 lb"): ikinci kez çevrilmez, raporda not', async () => {
    const rows = ['FATURA 9-482-11735', '794812345305 20.10.2026 10 lb 1.642,50'];
    const p = await preview(await textPdf(rows), [{ ...aiLine('794812345305', 1642.5), actualKg: 4.54 }], false, { weightUnit: 'lb' });
    expect(p.aiLines[0].actualKg).toBe(4.54);
    expect(p.warning).toContain(m('invoice.pdfWeightKept', { count: 1 }, 'tr'));
    const r = await importPdf(p.fileId, p.aiLines);
    expect(r.json().importReport.pdfRead).toMatchObject({ weightUnit: 'lb', weightKeptLines: 1 });
  });

  it('satır no\'suz gönderilen satır verilenlerin en büyüğünden sonra numaralanır (çakışmaz)', async () => {
    const p = await preview(await textPdf(PDF_ROWS), [aiLine('794812345305', 1642.5)]);
    const r = await importPdf(p.fileId, [
      { rowIndex: 12000, trackingNo: '794812345305', netAmount: 1642.5, surcharges: [] },
      { trackingNo: '794812345306', netAmount: 250, surcharges: [] },
    ]);
    expect(r.statusCode, r.body).toBe(201);
    expect((await linesOf(r.json().invoice.id)).map((l) => l.rowIndex).sort((a, b) => a - b)).toEqual([12000, 12001]);
  });
});
