/**
 * Mesaj 5 Y2: "İncele" (güveni düşük) satırlar listede süzülür ve nedeni kısa kodla gelir. Güven `pricing` kaydındadır;
 * fark çıkan (DIFF) da uyumlu çıkan (MATCH, ör. hizmeti tarifeden farklı) da sayılır, eski satır (pricing yok) kesin sayılır.
 * `reviewCode` tutar taşımaz: fiyat izni olmayan kişi de alır, yanıtta para anahtarı kalmaz.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMoneyKeys } from './helpers.ts';
import { ROLE, authHeader, buildHubApp, createCompany, insertCarrier, insertInvoice, prisma, type Actor } from './hub/harness.ts';

let app: FastifyInstance;
let a: Actor;
let invoiceId: string;

type Line = { trackingNo: string; status: string; confidence: string; reviewCode: string | null };

beforeAll(async () => {
  app = await buildHubApp({ stripMoney: true });
  a = await createCompany('İncele Süzgeci');
  const c = await insertCarrier(a.companyId, 'ups', 'UPS');
  const inv = await insertInvoice(a, {
    carrierId: c.id,
    invoiceNo: 'INC-1',
    date: '2026-10-20',
    lines: [
      { tracking: 'INC-MATCH-LOW', status: 'MATCH', net: 50, expected: 50, diff: 0, low: true },
      { tracking: 'INC-DIFF-LOW', status: 'DIFF', net: 80, expected: 60, diff: 20, diffTypes: ['PRICE'], low: true },
      { tracking: 'INC-MATCH', status: 'MATCH', net: 40, expected: 40, diff: 0 },
      { tracking: 'INC-DIFF', status: 'DIFF', net: 70, expected: 50, diff: 20, diffTypes: ['WEIGHT'] },
      { tracking: 'INC-UNMATCHED', status: 'UNMATCHED', net: 30 },
    ],
  });
  invoiceId = inv.id;
  // Kodu core'un yazdığı gibi `pricing` içine koy (harness yalnız güveni yazar)
  const set = async (trackingNo: string, reviewCode: string) => {
    const l = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId, trackingNo } });
    await prisma.invoiceLine.update({ where: { id: l.id }, data: { pricing: { ...(l.pricing as object), reviewCode } } });
  };
  await set('INC-MATCH-LOW', 'SERVICE');
  await set('INC-DIFF-LOW', 'FUEL_RATE');
  // kesin satırda eski bir kod kalmış olsa da yanıta girmez (kod yalnız güveni düşük satırda anlamlı)
  await set('INC-DIFF', 'EXTREME_RATE');
});
afterAll(async () => {
  await app.close();
});

const get = async (query: string, perms: readonly string[] = ROLE.ADMIN) => {
  const r = await app.inject({ method: 'GET', url: `/api/invoices/${invoiceId}/lines${query}`, headers: authHeader(a, perms) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Line[]; total: number };
};

describe('İncele süzgeci ve nedeni', () => {
  it('review=true yalnız güveni düşük satırları döner (DIFF ve MATCH); kod satırda', async () => {
    const all = await get('');
    expect(all.total).toBe(5);
    const codes = Object.fromEntries(all.items.map((l) => [l.trackingNo, l.reviewCode]));
    expect(codes).toEqual({ 'INC-MATCH-LOW': 'SERVICE', 'INC-DIFF-LOW': 'FUEL_RATE', 'INC-MATCH': null, 'INC-DIFF': null, 'INC-UNMATCHED': null });

    const review = await get('?review=true');
    expect(review.total).toBe(2);
    expect(review.items.map((l) => [l.trackingNo, l.status, l.confidence, l.reviewCode])).toEqual([
      ['INC-MATCH-LOW', 'MATCH', 'LOW', 'SERVICE'],
      ['INC-DIFF-LOW', 'DIFF', 'LOW', 'FUEL_RATE'],
    ]);
    expect((await get('?review=1')).total).toBe(2);
    expect((await get('?review=false')).total).toBe(5);
  });

  it('öbür süzgeçlerle birlikte çalışır', async () => {
    expect((await get('?review=true&status=MATCH')).items.map((l) => l.trackingNo)).toEqual(['INC-MATCH-LOW']);
    expect((await get('?review=true&status=DIFF')).items.map((l) => l.trackingNo)).toEqual(['INC-DIFF-LOW']);
    expect((await get('?review=true&decision=OPEN')).total).toBe(2);
    expect((await get('?review=true&decision=VERIFIED')).total).toBe(0);
  });

  it('fiyat izni olmayan: süzgeç ve kod çalışır, yanıtta para anahtarı yok', async () => {
    const r = await get('?review=true', ROLE.NO_PRICES);
    expect(r.items.map((l) => [l.trackingNo, l.reviewCode])).toEqual([
      ['INC-MATCH-LOW', 'SERVICE'],
      ['INC-DIFF-LOW', 'FUEL_RATE'],
    ]);
    // `surcharges` (içindeki tutar süzülür) ve `ourChargeableKg` (kg) bugünkü açık alanlardır; sözcük denetimine takılırlar
    expect(findMoneyKeys(r).filter((k) => !/\.(surcharges|ourChargeableKg)$/.test(k))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/"(netAmount|expectedAmount|diffAmount|pricing)"/);
  });

  it('geçersiz değer 400', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/invoices/${invoiceId}/lines?review=evet`, headers: authHeader(a, ROLE.ADMIN) });
    expect(r.statusCode).toBe(400);
  });
});
