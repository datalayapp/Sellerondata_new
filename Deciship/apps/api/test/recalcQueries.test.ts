/**
 * Y11: tek faturanın yeniden hesabı (önizleme + onay, iki istek) toplam 40 sorgunun altında kalır (eskiden ~73: Prisma
 * `include` her ilişki için ayrı sorgu açıyordu, aynı fatura üç kez okunuyordu, itirazsız faturada boş tur listesi için
 * ~9 sorgu gidiyordu). Sayım `performance.test.ts` ile aynı kuralla: RLS bağlamının denetim ifadeleri (BEGIN, set_config,
 * COMMIT, ROLLBACK) sayılmaz. Satır sayısıyla büyümediği `performance.test.ts`'te (3.000 satır) sınanır.
 *
 * Sadeleştirme hesap sonucunu değiştirmez: hesap testleri (recalculate, frozenResults, bulkRecalc, …) aynen geçer; burada
 * ayrıca onay yanıtının fatura ayrıntısı `GET /invoices/:id` ile aynı mı ve itiraz sorgusunun birleşik hâli eski iki
 * sorguyla aynı sonucu veriyor mu denetlenir.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeDisputeStateForTest } from '../src/services/compare.ts';
import { caller, digestOf, disputeCompany, invoiceWithDiffs, trDay } from './disputeHelpers.ts';
import { getApp, inCompany } from './helpers.ts';
import { tariffPayload } from './fixtures.ts';
import { applyRecalc, previewRecalc } from './recalcHelpers.ts';

const pg = createRequire(import.meta.url)('pg') as { Client: { prototype: { query: (...a: unknown[]) => unknown } } };
const origQuery = pg.Client.prototype.query;
let queries = 0;

beforeAll(() => {
  pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
    const text = String((args[0] as { text?: string } | string | undefined) && ((args[0] as { text?: string }).text ?? args[0]));
    if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(text)) queries++;
    return origQuery.apply(this, args);
  };
});
afterAll(() => {
  pg.Client.prototype.query = origQuery;
});

/** Ayrıntının imzalı dosya bağlantısı saniyeye bağlı bitiş taşır: karşılaştırmada yalnız yolu alınır. */
const stable = (inv: { fileUrl: string | null }) => ({ ...inv, fileUrl: inv.fileUrl ? inv.fileUrl.split('?')[0] : null });

/** Önizleme + onay; iki isteğin sorgu sayısı ve onay yanıtı. */
async function recalcCounted(auth: { authorization: string }, invoiceId: string, basis: 'pinned' | 'tariff' | 'rules') {
  const app = await getApp();
  const q0 = queries;
  const p = await previewRecalc(app, auth, invoiceId, { basis });
  expect(p.statusCode, p.body).toBe(200);
  const q1 = queries;
  const a = await applyRecalc(app, auth, invoiceId, { basis, token: p.json().token });
  expect(a.statusCode, a.body).toBe(200);
  return { preview: q1 - q0, apply: queries - q1, total: queries - q0, invoice: a.json().invoice, previewBody: p.json() };
}

describe('Y11: yeniden hesabın sorgu sayısı', () => {
  it('"Yeni tarifeyle" ve "Yeni ayarla" hesap: önizleme + onay toplam 40 sorgunun altında; yanıt GET ile aynı', async () => {
    const app = await getApp();
    const call = caller(app);
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70, 80, 90], { verify: 2 });
    const tariffId = (await call(c.admin.auth, 'GET', '/tariffs')).json().items[0].id as string;

    // yeni tarife sürümü: "Yeni tarifeyle hesapla"
    const put = await app.inject({ method: 'PUT', url: `/api/deciship/tariffs/${tariffId}`, headers: c.admin.auth, payload: tariffPayload(c.carrierId, { currency: c.currency, discountPct: 10 }) });
    expect(put.statusCode, put.body).toBe(200);
    const byTariff = await recalcCounted(c.admin.auth, inv.invoiceId, 'tariff');
    expect(byTariff.previewBody.basis.to.revisionId).not.toBe(byTariff.previewBody.basis.from.revisionId);
    expect(byTariff.total, `önizleme ${byTariff.preview} + onay ${byTariff.apply}`).toBeLessThan(40);
    // onayın döndürdüğü ayrıntı (yazımın dönüşünden kurulur) yeniden okunan ayrıntıyla aynı
    const detail = (await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}`)).json().invoice;
    expect(stable(byTariff.invoice)).toEqual(stable(detail));
    expect(detail.basis.state).toBe('CURRENT');

    // ayar değişti: "Yeni ayarla hesapla"
    expect((await call(c.admin.auth, 'PATCH', '/settings', { amountTol: 3 })).statusCode).toBe(200);
    const byRules = await recalcCounted(c.admin.auth, inv.invoiceId, 'rules');
    expect(byRules.previewBody.basis.rulesChanged).toBe(true);
    expect(byRules.total, `önizleme ${byRules.preview} + onay ${byRules.apply}`).toBeLessThan(40);
    expect(stable(byRules.invoice)).toEqual(stable((await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}`)).json().invoice));

    // sabit dayanakla "Yeniden karşılaştır"
    const pinned = await recalcCounted(c.admin.auth, inv.invoiceId, 'pinned');
    expect(pinned.total, `önizleme ${pinned.preview} + onay ${pinned.apply}`).toBeLessThan(40);
  });

  it('itirazlı fatura: birleşik itiraz sorgusu eski iki sorguyla aynı; onay yanıtı GET ile aynı', async () => {
    const app = await getApp();
    const call = caller(app);
    const c = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, c, [50, 60, 70], { verify: 2 });
    const state = () => inCompany(c.admin.auth, () => activeDisputeStateForTest(c.admin.companyId, inv.invoiceId));

    const none = await state();
    expect(none.merged).toEqual(none.separate);
    expect(none.merged).toEqual({ lineIds: [], hasRound: false });

    const sent = await call(c.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(-1), channel: 'EMAIL', selectionDigest: await digestOf(app, c.admin.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const active = await state();
    expect(active.merged).toEqual(active.separate);
    expect(active.merged.hasRound).toBe(true);
    expect(active.merged.lineIds).toEqual(inv.lines.slice(0, 2).map((l) => l.id).sort());

    // etkin itirazda sabit dayanakla yeniden karşılaştırma serbest (itirazdaki satırlar yazılmaz); yanıt GET ile aynı
    const pinned = await recalcCounted(c.admin.auth, inv.invoiceId, 'pinned');
    expect(stable(pinned.invoice)).toEqual(stable((await call(c.admin.auth, 'GET', `/invoices/${inv.invoiceId}`)).json().invoice));
    expect(pinned.invoice.dispute.active).not.toBeNull();

    // geri çekilen tur etkin değil
    const round = sent.json().dispute.active as { id: string; version: number };
    expect((await call(c.admin.auth, 'POST', `/disputes/${round.id}/withdraw`, { version: round.version, reason: 'deneme' })).statusCode).toBe(200);
    const withdrawn = await state();
    expect(withdrawn.merged).toEqual(withdrawn.separate);
    expect(withdrawn.merged).toEqual({ lineIds: [], hasRound: false });
  });
});
