/**
 * 05-B10 (uçtan uca, sahte SDK): PDF okuma işi seçilen taşıyıcının etkin tarifelerindeki ek ücret kodlarını isteme koyar ve
 * modelin uydurduğu kodu basılı adla tarifeye hizalar. Başka taşıyıcının tarifesi isteme girmez; aynı dosya başka taşıyıcıyla
 * ayrı iştir.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tariffPayload } from './fixtures.ts';
import { getApp, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

const systems: string[] = [];
let nextText = '';
vi.mock('@anthropic-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    static RateLimitError = actual.default.RateLimitError;
    static AuthenticationError = actual.default.AuthenticationError;
    beta = {
      messages: {
        stream: (params: { system: string }) => {
          systems.push(params.system);
          return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: nextText }] }) };
        },
      },
    };
  }
  return { ...actual, default: FakeAnthropic };
});

describe('05-B10: PDF okumada taşıyıcının tarife ek ücret kodları', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  let arasId = '';
  let otherId = '';
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    app = await getApp();
    auth = (await registerCompany(app)).auth;
    const carrier = async (code: string, name: string) => {
      const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code, name } });
      expect(c.statusCode, c.body).toBe(201);
      return c.json().carrier.id as string;
    };
    arasId = await carrier('aras', 'Aras kod');
    otherId = await carrier('mng', 'MNG kod');
    const t = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: auth,
      payload: tariffPayload(arasId, { surcharges: [{ code: 'MOBIL_BOLGE', name: 'Mobil Bölge Hizmeti', kind: 'FIXED', amount: 25 }] }),
    });
    expect(t.statusCode, t.body).toBe(201);
    const o = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: auth,
      payload: tariffPayload(otherId, { surcharges: [{ code: 'BASKA_KOD', name: 'Başka Ücret', kind: 'FIXED', amount: 5 }] }),
    });
    expect(o.statusCode, o.body).toBe(201);
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  async function pdfOf(track: string) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ['FATURA KOD-1', `${track} 20.10.2026 Mobil Bolge Hizmeti 25,00 125,00`].forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 11, font }));
    return Buffer.from(await doc.save());
  }

  it('istemde yalnız seçilen taşıyıcının kodları; modelin kodu basılı adla tarifenin koduna döner', async () => {
    const track = uniq('7948');
    const blank = { shipDate: null, service: null, destCountry: null, actualKg: null, billedKg: null, dimL: null, dimW: null, dimH: null, billedDivisor: null, baseAmount: null, discountAmount: null, fuelAmount: null, reference: null, currency: 'TRY' };
    nextText = JSON.stringify({
      invoiceNo: 'KOD-1',
      invoiceDate: '2026-10-27',
      currency: 'TRY',
      amountsIncludeVat: false,
      lines: [{ ...blank, trackingNo: track, netAmount: 125, surcharges: [{ code: 'MOBILE_ZONE_SERVICE', name: 'Mobil Bölge Hizmeti', amount: 25 }] }],
    });
    const pdf = await pdfOf(track);
    const send = (carrierId: string) => {
      const form = multipart([
        { name: 'carrierId', value: carrierId },
        { name: 'file', filename: 'fatura.pdf', contentType: 'application/pdf', data: pdf },
      ]);
      return viaJob(app, { method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    };
    const p = await send(arasId);
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().aiLines[0].surcharges).toEqual([{ code: 'MOBIL_BOLGE', name: 'Mobil Bölge Hizmeti', amount: 25 }]);
    const sys = systems.at(-1)!;
    expect(sys).toContain('MOBIL_BOLGE ("Mobil Bölge Hizmeti")');
    expect(sys).not.toContain('BASKA_KOD');
    // aynı dosya başka taşıyıcıyla: ayrı iş, istemde onun kodu (önbellek anahtarı istemle değişir: yeni çağrı)
    const before = systems.length;
    const q = await send(otherId);
    expect(q.statusCode, q.body).toBe(200);
    expect(systems.length).toBe(before + 1);
    expect(systems.at(-1)).toContain('BASKA_KOD ("Başka Ücret")');
    expect(q.json().aiLines[0].surcharges[0].code).toBe('MOBILE_ZONE_SERVICE');
  });
});
