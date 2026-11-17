/**
 * DENETIM-2 01-B8: satırların para birimi birbirinden ya da faturanınkinden farklıysa toplamlar farklı paraları topluyordu.
 * İçe aktarma: okuma kontrolü sert bayrak (`CURRENCY_MISMATCH`) koyar, kullanıcı onaylamadan içe aktarmaz (409
 * MAPPING_UNVERIFIED). Başlık düzeltmesi: satırlarda kendi para birimi yazılıysa ve yenisiyle çelişiyorsa 409 CURRENCY_CONFLICT.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';
import { patchInvoice } from './recalcHelpers.ts';

// PDF faturası yapay zekâyla okunur: sahte SDK (gerçek çağrı yok), yanıt `nextText`
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
  shipDate: 'Tarih',
  currency: 'Para Birimi',
  surchargeColumns: [],
  chargePairs: [],
  amountsIncludeVat: false,
  vatPct: 20,
  desiAsWeight: false,
};

describe('01-B8: karışık para birimi (uçtan uca)', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let carrierId = '';
  beforeAll(async () => {
    app = await getApp();
    auth = (await registerCompany(app)).auth;
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: 'FedEx karışık' } });
    expect(c.statusCode, c.body).toBe(201);
    carrierId = c.json().carrier.id;
  });

  async function upload(currencies: (string | null)[], mapping: Record<string, unknown> = MAPPING) {
    const csv = ['Takip No;Tarih;Tutar;Para Birimi', ...currencies.map((c, i) => `${uniq('7948')}${i};15.10.2026;${100 + i};${c ?? ''}`)].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const p = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(p.statusCode, p.body).toBe(200);
    const fileId = p.json().fileId as string;
    const verify = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview/verify', headers: auth, payload: { fileId, carrierId, mapping } });
    expect(verify.statusCode, verify.body).toBe(200);
    const create = (currency: string, acknowledgeIssues = false) =>
      app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { fileId, carrierId, invoiceNo: uniq('CUR-'), invoiceDate: '2026-10-15', currency, mapping, acknowledgeIssues } });
    return { verification: verify.json().diagnostics.verification as { verdict: string; issues: string[]; flagCounts: Record<string, number> }, create };
  }

  const flagsOf = (invoiceId: string) =>
    inCompany(auth, () => prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { rowIndex: 'asc' }, select: { parseFlags: true, currency: true } }));

  it('iki para birimli tablo: önizleme bayrak gösterir; içe aktarma onaysız 409, onayla yüklenir ve azınlık satırı bayraklı', async () => {
    const u = await upload(['USD', 'USD', 'EUR', 'USD']);
    expect(u.verification.verdict).toBe('check');
    expect(u.verification.flagCounts.CURRENCY_MISMATCH).toBe(1);
    expect(u.verification.issues).toContain('1 satır faturanın para biriminde değil (1 EUR; fatura USD). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.');
    const refused = await u.create('USD');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('MAPPING_UNVERIFIED');
    expect(refused.json().error.details.flagCounts.CURRENCY_MISMATCH).toBe(1);
    const ok = await u.create('USD', true);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await flagsOf(ok.json().invoice.id)).map((l) => l.parseFlags)).toEqual([[], [], ['CURRENCY_MISMATCH'], []]);
  });

  it('satırların hepsi USD, fatura TRY seçildi: önizlemede sorun yok ama içe aktarma faturanın para birimiyle denetler (409)', async () => {
    const u = await upload(['USD', 'USD']);
    expect(u.verification.verdict).toBe('ok');
    const refused = await u.create('TRY');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.details.issues).toContain('2 satır faturanın para biriminde değil (2 USD; fatura TRY). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.');
    expect((await u.create('USD')).statusCode).toBe(201);
  });

  it('onayla yüklenen faturada "Yeniden karşılaştır" bayrağı faturanın para birimine göre korur', async () => {
    const u = await upload(['USD', 'USD']);
    const created = await u.create('TRY', true);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().invoice.id as string;
    expect((await flagsOf(id)).map((l) => l.parseFlags)).toEqual([['CURRENCY_MISMATCH'], ['CURRENCY_MISMATCH']]);
    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect((await flagsOf(id)).map((l) => l.parseFlags)).toEqual([['CURRENCY_MISMATCH'], ['CURRENCY_MISMATCH']]);
  });

  it('başlıkta para birimi değişimi: satırlarda yazılı para birimiyle çelişirse 409 CURRENCY_CONFLICT (önizleme ve kayıt)', async () => {
    const u = await upload(['USD', 'USD', null]);
    const created = await u.create('USD');
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().invoice.id as string;
    const preview = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recalculate/preview`, headers: auth, payload: { basis: 'pinned', patch: { currency: 'TRY' } } });
    expect(preview.statusCode, preview.body).toBe(409);
    expect(preview.json().error).toMatchObject({ code: 'CURRENCY_CONFLICT', message: '2 satırda para birimi USD yazılı; faturanın para birimi TRY yapılamaz (toplamlar farklı para birimlerini toplardı). Para birimi yanlış okunduysa faturayı doğru para birimiyle yeniden yükleyin.' });
    const en = await app.inject({ method: 'PATCH', url: `/api/deciship/invoices/${id}`, headers: { ...auth, 'accept-language': 'en' }, payload: { currency: 'TRY' } });
    expect(en.statusCode, en.body).toBe(409);
    expect(en.json().error).toMatchObject({ code: 'CURRENCY_CONFLICT', message: '2 lines have USD written on them; the invoice currency cannot be changed to TRY (totals would add up different currencies). If the currency was read wrongly, upload the invoice again with the right currency.' });
    const inv = await inCompany(auth, () => prisma.invoice.findFirstOrThrow({ where: { id }, select: { currency: true } }));
    expect(inv.currency).toBe('USD');
    // aynı para birimi (küçük harf) değişiklik değildir; satırlarla uyumlu
    const same = await app.inject({ method: 'PATCH', url: `/api/deciship/invoices/${id}`, headers: auth, payload: { currency: 'usd' } });
    expect(same.statusCode, same.body).toBe(200);
  });

  it('yazım farkları (TL, ₺, tl, Türk Lirası) TRY faturada yanlış alarm değildir; satır TRY olarak saklanır', async () => {
    const u = await upload(['TL', '₺', 'tl', 'Türk Lirası', 'TRY', null]);
    expect(u.verification.verdict).toBe('ok');
    const created = await u.create('TRY');
    expect(created.statusCode, created.body).toBe(201);
    const lines = await flagsOf(created.json().invoice.id);
    expect(lines.map((l) => l.parseFlags)).toEqual([[], [], [], [], [], []]);
    expect(lines.map((l) => l.currency)).toEqual(['TRY', 'TRY', 'TRY', 'TRY', 'TRY', null]);
  });

  it('tanınmayan para birimi yazımı (sütunun öbür satırları USD) sessizce USD sayılmaz: bayrak ve onay', async () => {
    const u = await upload(['USD', 'USD', 'Fr.']);
    expect(u.verification.flagCounts.CURRENCY_MISMATCH).toBe(1);
    const refused = await u.create('USD');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.details.issues).toContain('1 satır faturanın para biriminde değil (1 FR.; fatura USD). Toplamlar farklı para birimlerini toplardı; bu satırları ayrı bir faturada yükleyin.');
  });

  it('başlık satırların para birimine düzeltilince "para birimi farklı" bayrağı hemen kalkar', async () => {
    const u = await upload(['USD', 'USD']);
    const created = await u.create('TRY', true);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().invoice.id as string;
    expect((await flagsOf(id)).map((l) => l.parseFlags)).toEqual([['CURRENCY_MISMATCH'], ['CURRENCY_MISMATCH']]);
    const r = await patchInvoice(app, auth, id, { currency: 'USD' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await flagsOf(id)).map((l) => l.parseFlags)).toEqual([[], []]);
  });

  it('PDF faturası: yapay zekânın satıra yazdığı "TL", "₺" TRY sayılır (bayrak yok, TRY saklanır); "USD" satırı bayraklı', async () => {
    const tracks = [uniq('7948'), uniq('7948'), uniq('7948')];
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ['FATURA PDF-CUR', ...tracks.map((t, i) => `${t} 20.10.2026 ${100 + i},00`)].forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
    const pdf = Buffer.from(await doc.save());
    const blank = { shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null, billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, surcharges: [], reference: null };
    nextText = JSON.stringify({
      invoiceNo: 'PDF-CUR',
      invoiceDate: '2026-10-27',
      currency: 'TRY',
      amountsIncludeVat: false,
      lines: [
        { ...blank, trackingNo: tracks[0], netAmount: 100, currency: 'TL' },
        { ...blank, trackingNo: tracks[1], netAmount: 101, currency: '₺' },
        { ...blank, trackingNo: tracks[2], netAmount: 102, currency: 'USD' },
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
      expect(preview.aiLines.map((l: { currency?: string }) => l.currency)).toEqual(['TRY', 'TRY', 'USD']);
      // eski istemci ham yazımı gönderse de sunucu çevirir
      const sent = preview.aiLines.map((l: object, i: number) => (i === 0 ? { ...l, currency: 'tl' } : l));
      const body = { fileId: preview.fileId, carrierId, invoiceNo: uniq('PDFC-'), invoiceDate: '2026-10-27', currency: 'TRY', lines: sent };
      // 01-B8: tablo yolundaki gibi onay kapısı (aynı sorun metni); "TL"/"₺" satırları sayılmaz
      const gate = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: body });
      expect(gate.statusCode, gate.body).toBe(409);
      expect(gate.json().error.code).toBe('MAPPING_UNVERIFIED');
      const details = gate.json().error.details;
      expect(details).toMatchObject({ verdict: 'check', flaggedRows: 1, flagCounts: { CURRENCY_MISMATCH: 1 } });
      expect(details.issues).toEqual([expect.stringContaining('1 USD')]);
      expect(details.examples).toEqual([{ rowIndex: preview.aiLines[2].rowIndex, trackingNo: tracks[2], codes: ['CURRENCY_MISMATCH'] }]);
      const r = await app.inject({ method: 'POST', url: '/api/deciship/invoices', headers: auth, payload: { ...body, acknowledgeIssues: true } });
      expect(r.statusCode, r.body).toBe(201);
      const lines = await flagsOf(r.json().invoice.id);
      expect(lines.map((l) => l.currency)).toEqual(['TRY', 'TRY', 'USD']);
      expect(lines.map((l) => l.parseFlags.includes('CURRENCY_MISMATCH'))).toEqual([false, false, true]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('satırlarda para birimi yazılı değilse başlıktan değiştirilebilir (önizleme açılır)', async () => {
    const u = await upload([null, null], { ...MAPPING, currency: undefined });
    const created = await u.create('USD');
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().invoice.id as string;
    const preview = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recalculate/preview`, headers: auth, payload: { basis: 'pinned', patch: { currency: 'TRY' } } });
    expect(preview.statusCode, preview.body).toBe(200);
  });
});
