/**
 * Y96: büyük PDF faturanın gruplu okuması, veritabanısız. Yapay zekâ çağrısı sahte (`ai.ts` işlevleri); sahte çağrı gerçek
 * `meteredCall`'ın 2. adımını (kişi başı dakika sınırı, `origin: 'job'` değilse) gerçek `assertAiRate` ile yapar.
 * Denenen: dakika sınırı istek başına bir kez sayılır (grup başına değil), kesme dosya çalışanında (gerçek worker),
 * şifreli belge kesilmez, taranmış belgede `review.sliceUnchecked`. Uçtan uca hâli `jobKinds.test.ts`.
 */
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCallContext } from '../src/services/aiMeter.ts';

const calls: { kind: 'single' | 'part'; pages: number[] | null; origin: string | undefined }[] = [];
vi.mock('../src/services/ai.ts', async (orig) => {
  const actual = await orig<typeof import('../src/services/ai.ts')>();
  const { assertAiRate } = await import('../src/services/aiMeter.ts');
  const data = (pages: number[]) => ({
    invoiceNo: pages.includes(1) ? 'F-1' : null,
    invoiceDate: null,
    currency: null,
    amountsIncludeVat: false,
    lines: pages.map((p) => ({
      trackingNo: `77${p}0012345`, shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null,
      billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], netAmount: p, currency: null, reference: null,
    })),
  });
  return {
    ...actual,
    readInvoicePdf: async (_pdf: Buffer, ctx: AiCallContext) => {
      if (ctx.origin !== 'job') assertAiRate(ctx);
      calls.push({ kind: 'single', pages: null, origin: ctx.origin });
      return { data: data([]), usageId: null, cached: false, usage: null };
    },
    readInvoicePdfPart: async (part: Buffer, o: { pages: number[] }, ctx: AiCallContext) => {
      if (ctx.origin !== 'job') assertAiRate(ctx);
      // parça gerçekten kesilmiş PDF ve istenen sayfa sayısında
      expect((await PDFDocument.load(part)).getPageCount()).toBe(o.pages.length);
      calls.push({ kind: 'part', pages: o.pages, origin: ctx.origin });
      return { data: data(o.pages), usageId: null, cached: false, usage: null };
    },
  };
});

const { readInvoicePdfAll } = await import('../src/services/invoicePdfRead.ts');
const { closeFileWorkers, readPdfText } = await import('../src/lib/fileWorkers.ts');

const KEYS = ['API_RATE_LIMIT', 'AI_RATE_PDF_PER_MIN', 'PDF_INVOICE_PAGES_PER_CALL', 'FILE_WORKER_MODE'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let member = 0;
const ctx = (): AiCallContext => ({ companyId: 'A', memberId: `m${++member}`, kind: 'INVOICE_PDF', limits: {}, origin: 'request' });

async function textPdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage([400, 300]).drawText(`Sayfa ${i} takip 77${i}0012345 tutar ${i},00 TL gonderi satiri`, { x: 20, y: 150, size: 10, font });
  return Buffer.from(await doc.save());
}

beforeEach(() => {
  calls.length = 0;
  Object.assign(process.env, { API_RATE_LIMIT: 'on', AI_RATE_PDF_PER_MIN: '2', PDF_INVOICE_PAGES_PER_CALL: '5' });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => closeFileWorkers());

describe('Y96: eski eşzamanlı yolda dakika sınırı istek başına bir kez', () => {
  it('12 sayfa, 3 grup, sınır 2/dk: okuma yarıda 429 almaz; aynı kişinin 3. isteği 429', async () => {
    const pdf = await textPdf(12);
    const pageTexts = (await readPdfText(pdf, { companyId: 'A' })).pages;
    const c = ctx();
    const r = await readInvoicePdfAll(pdf, pageTexts, c);
    expect(calls.map((x) => x.pages)).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]);
    expect(r.data.lines).toHaveLength(12);
    expect(r.review.sliceUnchecked).toBeUndefined();
    // gruplar sınırı yeniden saymadı; istek bir isabet: ikinci istek geçer, üçüncüsü 429
    expect(calls.every((x) => x.origin === 'job')).toBe(true);
    await readInvoicePdfAll(pdf, pageTexts, c);
    await expect(readInvoicePdfAll(pdf, pageTexts, c)).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it('kesme gerçek dosya çalışanında (thread) da aynı sonuç', async () => {
    process.env.FILE_WORKER_MODE = 'thread';
    const pdf = await textPdf(7);
    const pageTexts = (await readPdfText(pdf, { companyId: 'A' })).pages;
    const r = await readInvoicePdfAll(pdf, pageTexts, ctx());
    expect(calls.map((x) => x.pages)).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
    expect(r.parts).toBe(2);
  });

  it('arka plan işinde (origin job) sınır burada sayılmaz', async () => {
    process.env.AI_RATE_PDF_PER_MIN = '1';
    const pdf = await textPdf(6);
    const pageTexts = (await readPdfText(pdf, { companyId: 'A' })).pages;
    const c = { ...ctx(), origin: 'job' as const };
    await readInvoicePdfAll(pdf, pageTexts, c);
    await readInvoicePdfAll(pdf, pageTexts, c);
    expect(calls.filter((x) => x.kind === 'part')).toHaveLength(4);
  });
});

describe('Y96: kesilemeyen ve taranmış belge', () => {
  it('şifreli (yalnız sahip parolalı) belge kesilmez: tek çağrı', async () => {
    const pdf = fs.readFileSync(new URL('./pdf-fixtures/encrypted-rc4-12p.pdf', import.meta.url));
    const r = await readInvoicePdfAll(pdf, Array.from({ length: 12 }, () => ''), ctx());
    expect(calls.map((x) => x.kind)).toEqual(['single']);
    expect(r.parts).toBe(1);
  });

  it('sayfa sayısı tutmuyorsa kesilmez: tek çağrı', async () => {
    const pdf = await textPdf(6);
    await readInvoicePdfAll(pdf, Array.from({ length: 7 }, () => ''), ctx());
    expect(calls.map((x) => x.kind)).toEqual(['single']);
  });

  it('taranmış (metinsiz) belge gruplarla okunur, kesme metinle denetlenemedi: review.sliceUnchecked', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage([300, 300]);
    const pdf = Buffer.from(await doc.save());
    const r = await readInvoicePdfAll(pdf, Array.from({ length: 6 }, () => ''), ctx());
    expect(calls.map((x) => x.pages)).toEqual([[1, 2, 3, 4, 5], [6]]);
    expect(r.review.sliceUnchecked).toBe(true);
  });
});
