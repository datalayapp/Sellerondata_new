/**
 * İtiraz yanıtlarında para gizleme: fiyat izni olmayan (katalogda henüz yok, `ROLE.NO_PRICES` = muhasebe − prices.view)
 * itirazı görür ve yönetir ama hiçbir tutar almaz. Uygulamanın son güvencesi `stripMoney` açık (src/app.ts ile aynı kanca).
 * Durum, sayı, tarih, dekont no ve sürüm kalır: arayüz tutarsız da çalışır.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestOf, trDay } from './disputeHelpers.ts';
import { findMoneyKeys } from './helpers.ts';
import { ROLE, authHeader, buildHubApp, createCompany, insertCarrier, insertInvoice, type Actor } from './hub/harness.ts';

let app: FastifyInstance;
let a: Actor;
let invoiceId: string;

beforeAll(async () => {
  app = await buildHubApp({ stripMoney: true });
  a = await createCompany('İtiraz Para Gizleme');
  const c = await insertCarrier(a.companyId, 'ups', 'UPS');
  const line = (net: number, diff: number) => ({ status: 'DIFF' as const, net, expected: net - diff, diff, diffTypes: ['PRICE'], decision: 'VERIFIED' as const });
  invoiceId = (await insertInvoice(a, { carrierId: c.id, invoiceNo: 'PG-1', date: trDay(-2), lines: [line(100, 30), line(60, 12.4)] })).id;
});
afterAll(async () => {
  await app.close();
});

const req = (method: 'GET' | 'POST', url: string, perms: readonly string[], payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: authHeader(a, perms), ...(payload === undefined ? {} : { payload: payload as object }) });

describe('fiyat izni olmayan itirazı yönetir, tutar görmez', () => {
  it('gönderme, sonuç, okumalar: para anahtarı yok; durum, sayı, dekont no ve sürüm var', async () => {
    const sent = await req('POST', `/invoices/${invoiceId}/disputes`, ROLE.NO_PRICES, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, authHeader(a, ROLE.NO_PRICES), invoiceId, '/api'), reference: 'K-9' });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(findMoneyKeys(sent.json())).toEqual([]);
    const round = sent.json().dispute.active;
    expect(round).toMatchObject({ round: 1, version: 1, ttk: 'ON_TIME', reference: 'K-9' });
    expect(round.lines.map((l: Record<string, unknown>) => Object.keys(l).sort())).toEqual([
      ['id', 'invoiceLineId', 'lineNo', 'outcome', 'resultId', 'trackingNo'],
      ['id', 'invoiceLineId', 'lineNo', 'outcome', 'resultId', 'trackingNo'],
    ]);
    // etkin tur varken gönderilebilir = yeniden göndermede pakete girecek satırlar
    expect(sent.json().dispute).toMatchObject({ status: 'SENT', sendableLineCount: 2 });
    expect(sent.json().dispute).not.toHaveProperty('sendableAmount');
    expect(sent.json().dispute).toHaveProperty('unsentLineCount');
    expect(sent.json().dispute).not.toHaveProperty('unsentAmount');

    // tutarı bilmeden dekont girilemez (tutar zorunlu); ret girilir
    const rej = await req('POST', `/disputes/${round.id}/results`, ROLE.NO_PRICES, { version: 1, kind: 'REJECTED', resultOn: trDay(0), reason: 'Taşıyıcı kabul etmedi', lines: [{ disputeLineId: round.lines[1].id }] });
    expect(rej.statusCode, rej.body).toBe(200);
    expect(findMoneyKeys(rej.json())).toEqual([]);
    const rec = await req('POST', `/disputes/${round.id}/results`, ROLE.ADMIN, { version: 2, kind: 'RECOVERED', resultOn: trDay(0), creditNoteNo: 'AD-55', lines: [{ disputeLineId: round.lines[0].id, amount: 25 }] });
    expect(rec.statusCode, rec.body).toBe(200);
    // fiyat izni olan tutarları görür
    expect(rec.json().dispute.active.sums).toMatchObject({ recoveredAmount: 25, rejectedAmount: 12.4, shortfallAmount: 5 });

    const detail = await req('GET', `/invoices/${invoiceId}`, ROLE.NO_PRICES);
    expect(findMoneyKeys(detail.json())).toEqual([]);
    const d = detail.json().invoice.dispute;
    expect(d.status).toBe('CLOSED');
    expect(d.active.results.map((r: { kind: string; creditNoteNo: string | null }) => [r.kind, r.creditNoteNo])).toEqual([['RECOVERED', 'AD-55'], ['REJECTED', null]]);
    expect(d.active.lines.map((l: { outcome: string }) => l.outcome)).toEqual(['RECOVERED', 'REJECTED']);
    expect(d.active.version).toBe(3);

    const lines = await req('GET', `/invoices/${invoiceId}/lines`, ROLE.NO_PRICES);
    // Satır nesnesinin kendisi bu testin konusu değil (ek ücret dökümü başka sözleşme): itiraz alanı süzülür.
    expect(findMoneyKeys(lines.json().items.map((l: { dispute: unknown }) => l.dispute))).toEqual([]);
    expect(lines.json().items.map((l: { dispute: unknown }) => l.dispute)).toEqual([{ outcome: 'RECOVERED' }, { outcome: 'REJECTED' }]);

    const list = await req('GET', '/invoices', ROLE.NO_PRICES);
    expect(findMoneyKeys(list.json())).toEqual([]);
    expect(list.json().items[0]).toMatchObject({ disputeStatus: 'CLOSED', disputeSums: {} });

    const disputes = await req('GET', '/disputes', ROLE.NO_PRICES);
    expect(disputes.statusCode).toBe(200);
    expect(findMoneyKeys(disputes.json())).toEqual([]);
    expect(disputes.json().summary.counts).toEqual({ UNSENT: 0, SENT: 0, CLOSED: 1, ALL: 1 });
    expect(disputes.json().items[0]).toMatchObject({ status: 'CLOSED', lineCount: 2, resolvedCount: 2, ttkStatus: 'ON_TIME', channel: 'EMAIL' });
    expect(disputes.json().summary.byCurrency).toEqual([{ currency: 'TRY' }]);

    const dash = await req('GET', `/dashboard?month=${trDay(-2).slice(0, 7)}`, ROLE.NO_PRICES);
    expect(dash.statusCode).toBe(200);
    expect(dash.json()).not.toHaveProperty('recoveredTotal');
    expect(dash.json()).not.toHaveProperty('disputePendingTotal');
    expect(findMoneyKeys(dash.json())).toEqual([]);
  });
});
