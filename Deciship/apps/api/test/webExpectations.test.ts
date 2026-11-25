/**
 * Web'in beklediği API davranışları: tarife İndirim sütunu, PDF yüklemede aiAvailable, satır karar süzgeci.
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, measurementPayload, multipart, uniq } from './helpers.ts';

const API = '/api/deciship';
let app: FastifyInstance;
let f: Fixture;
beforeAll(async () => {
  app = await getApp();
  f = await companyFixture(app);
});

type Check = { severity: string; code: string; title: string };
const CSV = (header: string, rows: string[]) => Buffer.from([header, ...rows].join('\n'));
async function draft(data: Buffer, filename = 'tarife.csv', contentType = 'text/csv') {
  const form = multipart([{ name: 'file', filename, contentType, data }]);
  const r = await app.inject({ method: 'POST', url: `${API}/tariffs/${f.tariffId}/import`, headers: { ...f.admin.auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json() as { draftId: string; checks: Check[]; canApply: boolean; zones: unknown; rates: { zone: string }[] };
}
const apply = (id: string) => app.inject({ method: 'POST', url: `${API}/tariff-imports/${id}/apply`, headers: f.admin.auth, payload: { options: {}, acknowledged: true } });
const discount = async () => (await app.inject({ method: 'GET', url: `${API}/tariffs/${f.tariffId}`, headers: f.admin.auth })).json().tariff.discountPct as number;

describe('tarife İndirim sütunu', () => {
  it('sütun bölge sayılmaz, tek değer tarifeye yazılır; bilgi olarak söylenir', async () => {
    const d = await draft(CSV('Ağırlık;TR;İndirim %', ['1;10;38', '2;20;']));
    expect(new Set(d.rates.map((r) => r.zone))).toEqual(new Set(['TR']));
    expect(d.checks.map((c) => c.code)).not.toContain('NO_DISCOUNT');
    const r = await apply(d.draftId);
    expect(r.statusCode, r.body).toBe(200);
    expect(await discount()).toBe(38);
  });

  it('indirim sütunu yoksa sessiz geçmez: uyarı, onay ister; mevcut indirim korunur', async () => {
    const d = await draft(CSV('Ağırlık;TR', ['1;10', '2;20']));
    const w = d.checks.find((c) => c.code === 'NO_DISCOUNT')!;
    expect(w.severity).toBe('warning');
    expect(w.title).toMatch(/indirim/i);
    const noAck = await app.inject({ method: 'POST', url: `${API}/tariff-imports/${d.draftId}/apply`, headers: f.admin.auth, payload: { options: {} } });
    expect(noAck.json().error.code).toBe('ACK_REQUIRED');
  });

  it('karışık ya da geçersiz indirim uygulanamaz', async () => {
    const mixed = await draft(CSV('Ağırlık;TR;İndirim', ['1;10;38', '2;20;40']));
    expect(mixed.checks.find((c) => c.code === 'MIXED_DISCOUNT')?.severity).toBe('error');
    expect(mixed.canApply).toBe(false);
    const bad = await draft(CSV('Ağırlık;TR;Discount', ['1;10;150']));
    expect(bad.checks.find((c) => c.code === 'INVALID_DISCOUNT')?.severity).toBe('error');
  });

  it('şablon: tarifenin indirimi sütunda gelir, geri okunur', async () => {
    const r = await app.inject({ method: 'GET', url: `${API}/tariffs/template.xlsx?tariffId=${f.tariffId}`, headers: f.admin.auth });
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as never);
    const sheet = wb.worksheets[0]!;
    const head = sheet.getRow(1).values as unknown[];
    const col = head.findIndex((h) => typeof h === 'string' && /ndirim/.test(h));
    expect(col).toBeGreaterThan(1);
    const d = await draft(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), 'sablon.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(new Set(d.rates.map((x) => x.zone)).size).toBeGreaterThan(0);
    expect(d.rates.every((x) => !/ndirim/.test(x.zone))).toBe(true);
    expect(d.checks.map((c) => c.code)).not.toContain('NO_DISCOUNT');
  });
});

describe('PDF yükleme: aiAvailable', () => {
  it('anahtar yokken false, varken true', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    const get = async () => (await app.inject({ method: 'GET', url: `${API}/tariff-documents/${f.documentId}`, headers: f.admin.auth })).json().aiAvailable;
    try {
      process.env.ANTHROPIC_API_KEY = '';
      expect(await get()).toBe(false);
      process.env.ANTHROPIC_API_KEY = 'anahtar';
      expect(await get()).toBe(true);
    } finally {
      process.env.ANTHROPIC_API_KEY = before ?? '';
    }
  });
});

describe('satır ucu: birden çok karar süzgeci', () => {
  it('OPEN,VERIFIED uyumlu sayılanı getirmez; geçersiz değer 400; acceptedLines sayısı', async () => {
    const c = await companyFixture(app);
    const raws = [uniq('D'), uniq('D'), uniq('D')];
    for (const trackingRaw of raws) {
      const p = measurementPayload({ trackingRaw, lengthCm: 30, widthCm: 20, heightCm: 15, weightKg: 2 });
      await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...c.admin.auth, ...p.headers }, payload: p.payload });
    }
    const form = multipart([{ name: 'carrierId', value: c.carrierId }, { name: 'file', filename: 'f.csv', contentType: 'text/csv', data: CSV('Takip No;Desi;Tutar', raws.map((x) => `${x};5;900`)) }]);
    const prev = await app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...c.admin.auth, ...form.headers }, payload: form.payload });
    const inv = await app.inject({ method: 'POST', url: `${API}/invoices`, headers: c.admin.auth, payload: { fileId: prev.json().fileId, carrierId: c.carrierId, invoiceNo: uniq('F'), invoiceDate: '2026-10-15', currency: 'TRY', mapping: { trackingNo: 'Takip No', billedKg: 'Desi', netAmount: 'Tutar' }, acknowledgeIssues: true } });
    const id = inv.json().invoice.id as string;
    const list = async (q: string) => app.inject({ method: 'GET', url: `${API}/invoices/${id}/lines?status=DIFF${q}`, headers: c.admin.auth });
    const all = (await list('')).json().items as { id: string }[];
    expect(all).toHaveLength(3);
    await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${all[0]!.id}`, headers: c.admin.auth, payload: { decision: 'ACCEPTED', reason: 'kabul edildi' } });
    await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${all[1]!.id}`, headers: c.admin.auth, payload: { decision: 'VERIFIED' } });
    const ok = (await list('&decision=OPEN,VERIFIED')).json();
    expect(ok.total).toBe(2);
    expect(ok.items.map((l: { id: string }) => l.id)).not.toContain(all[0]!.id);
    expect((await list('&decision=ACCEPTED')).json().total).toBe(1);
    expect((await list('&decision=OPEN,YOK')).statusCode).toBe(400);
    const totals = (await app.inject({ method: 'GET', url: `${API}/invoices/${id}`, headers: c.admin.auth })).json().invoice.totals;
    expect(totals.diff).toBe(3);
    expect(totals.acceptedLines).toBe(1);
  });
});
