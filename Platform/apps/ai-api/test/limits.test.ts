import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_MICROS_PER_UNIT } from '@sellerondata/contracts';
import { disconnectPrisma, getPrisma, type PrismaClient } from '../src/db.ts';
import { uuidv7 } from '../src/ledger/ids.ts';
import { allowAll, BUSY_RETRY_SEC, createLimits, judge, type AdmitInput, type AdmitResult, type GatewayLimits, type LimitsDeps } from '../src/limits/index.ts';
import { orgMonth, zonedPeriodStart } from '../src/limits/periods.ts';
import { closeSuper, superClient } from './helpers.ts';

/**
 * Tavanlar, pay, hız (G3) gerçek Postgres'te. Vekil burada taklit edilir (G2'nin sözleşmesi): `pending` satırı payla yazılır ve
 * commit edilir, sonra `admit`; ret → satır `rejected` (pay 0); kabul → çağrı biter, satır gerçek tutarla kapanır, sonra `settle`.
 * DeciShip `aiDailyBudget.test.ts` senaryoları: tavan altı/üstü, yarış, süren işe %20 pay, gün (ve ay) dönümü, geçici ret.
 */

const prisma = getPrisma();
const $ = (usd: number) => Math.round(usd * AI_MICROS_PER_UNIT);
let clock = new Date('2026-11-15T12:00:00.000Z');
const now = () => clock;
/** Bu ayın daha önceki bir günü (platformun günlük tavanına girmez). */
const EARLIER = new Date('2026-11-02T10:00:00.000Z');

async function reset() {
  const su = await superClient();
  await su.query('TRUNCATE ai."AiCall", ai."Org", ai."OrgProductCap"');
  await su.query('UPDATE ai."PlatformLimits" SET "dailyCapMicroUsd" = NULL, "monthlyCapMicroUsd" = NULL, paused = false WHERE id = 1');
}

async function platformCaps(o: { dayUsd?: number | null; monthUsd?: number | null; paused?: boolean }) {
  const su = await superClient();
  await su.query('UPDATE ai."PlatformLimits" SET "dailyCapMicroUsd" = $1, "monthlyCapMicroUsd" = $2, paused = $3 WHERE id = 1', [
    o.dayUsd == null ? null : $(o.dayUsd),
    o.monthUsd == null ? null : $(o.monthUsd),
    o.paused ?? false,
  ]);
}

async function orgRow(id: string, o: { capUsd?: number | null; timeZone?: string | null; closed?: boolean; purged?: boolean } = {}) {
  await prisma.org.upsert({
    where: { id },
    create: {
      id,
      capOverrideMicroUsd: o.capUsd == null ? null : BigInt($(o.capUsd)),
      timeZone: o.timeZone ?? null,
      closedAt: o.closed ? clock : null,
      purgedAt: o.purged ? clock : null,
    },
    update: {
      capOverrideMicroUsd: o.capUsd == null ? null : BigInt($(o.capUsd)),
      timeZone: o.timeZone ?? null,
      closedAt: o.closed ? clock : null,
      purgedAt: o.purged ? clock : null,
    },
  });
}

async function toolCap(orgId: string, product: string, capUsd: number | null) {
  await prisma.orgProductCap.upsert({
    where: { orgId_product: { orgId, product } },
    create: { orgId, product, capMicroUsd: capUsd === null ? null : BigInt($(capUsd)) },
    update: { capMicroUsd: capUsd === null ? null : BigInt($(capUsd)) },
  });
}

type RowOpts = {
  orgId?: string;
  product?: 'deciship' | 'tagpress';
  status?: 'pending' | 'ok' | 'failed' | 'cancelled' | 'rejected' | 'interrupted';
  costUsd?: number;
  reserveUsd?: number;
  at?: Date;
  requestId?: string;
  origin?: 'request' | 'job';
  stream?: boolean;
  keySource?: 'platform' | 'org';
};

/** Defter satırı (doğrudan; vekilin yazdığı biçim). */
async function row(o: RowOpts = {}): Promise<string> {
  const id = uuidv7();
  const status = o.status ?? 'ok';
  const requestId = o.requestId ?? randomUUID();
  // Aynı istek kimliğinin denemeleri ayrı satır (vekil boş olan ilk deneme sayısını seçer).
  const attempt = await prisma.aiCall.count({ where: { product: o.product ?? 'deciship', toolRequestId: requestId } });
  await prisma.aiCall.create({
    data: {
      id,
      product: o.product ?? 'deciship',
      orgId: o.orgId ?? 'org-a',
      memberId: null,
      purpose: `${o.product ?? 'deciship'}.invoice_pdf`,
      origin: o.origin ?? 'request',
      provider: 'anthropic',
      requestedModel: 'claude-sonnet-5-5',
      stream: o.stream ?? false,
      priceVersion: 'r100:test',
      status,
      costMicroUsd: BigInt(status === 'pending' ? 0 : $(o.costUsd ?? 0)),
      reservedMicroUsd: BigInt(status === 'pending' ? $(o.reserveUsd ?? 0) : 0),
      keySource: o.keySource ?? 'platform',
      toolRequestId: requestId,
      attempt,
      startedAt: o.at ?? clock,
    },
  });
  return id;
}

type CallOpts = Omit<RowOpts, 'status' | 'costUsd'> & { reserveUsd: number };

function inputOf(id: string, o: CallOpts): AdmitInput {
  return {
    callId: id,
    product: o.product ?? 'deciship',
    orgId: o.orgId ?? 'org-a',
    memberId: null,
    purpose: `${o.product ?? 'deciship'}.invoice_pdf`,
    model: 'claude-sonnet-5-5',
    provider: 'anthropic',
    estimateMicroUsd: $(o.reserveUsd),
    requestId: o.requestId ?? randomUUID(),
    attempt: 0,
    origin: o.origin ?? 'request',
    stream: o.stream ?? false,
    keySource: o.keySource ?? 'platform',
  };
}

/** Vekilin ret kapanışı: tutar 0, pay 0. */
async function closeRejected(id: string, code: string) {
  await prisma.aiCall.updateMany({ where: { id, status: 'pending' }, data: { status: 'rejected', reservedMicroUsd: 0n, errorCode: code, finishedAt: clock } });
}

type Call = { id: string; result: AdmitResult };

/** Vekilin sırası: satır (commit) → admit → ret ise `rejected`. */
async function call(limits: GatewayLimits, o: CallOpts): Promise<Call> {
  const requestId = o.requestId ?? randomUUID();
  const id = await row({ ...o, requestId, status: 'pending' });
  const result = await limits.admit(inputOf(id, { ...o, requestId }));
  if (!result.ok) await closeRejected(id, result.code);
  return { id, result };
}

/** Kabul edilmiş çağrının bitişi: satır gerçek tutarla kapanır (vekil), sonra `settle`. */
async function finish(limits: GatewayLimits, c: Call, costUsd: number) {
  expect(c.result.ok).toBe(true);
  await prisma.aiCall.updateMany({ where: { id: c.id, status: 'pending' }, data: { status: 'ok', costMicroUsd: BigInt($(costUsd)), reservedMicroUsd: 0n, finishedAt: clock } });
  if (c.result.ok) await limits.settle(c.result.reservationId, $(costUsd));
}

const code = (c: Call) => (c.result.ok ? 'ok' : c.result.code);
const make = (o: Partial<LimitsDeps> = {}) => createLimits({ prisma, now, ...o });

beforeEach(async () => {
  clock = new Date('2026-11-15T12:00:00.000Z');
  await reset();
});
afterAll(async () => {
  await reset();
  await closeSuper();
  await disconnectPrisma();
});

describe('tek tavan kararı (judge)', () => {
  it('tavan 0 her zaman ret; harcanan tavana ulaştıysa kesin; kendi payı ya da açık paylar sığmıyorsa geçici; sınırda kabul', () => {
    expect(judge({ cap: 0, used: 0, reserved: 0 }, 0)).toBe('cap');
    expect(judge({ cap: null, used: 10, reserved: 10 }, 10)).toBe('ok');
    expect(judge({ cap: 100, used: 100, reserved: 0 }, 0)).toBe('cap');
    // R2: harcanan tavanın altında, yalnız kendi payı sığmıyor → geçici (pay kaba üst tahmin), kesin değil.
    expect(judge({ cap: 100, used: 90, reserved: 11 }, 11)).toBe('busy');
    expect(judge({ cap: 100, used: 0, reserved: 150 }, 150)).toBe('busy');
    expect(judge({ cap: 100, used: 90, reserved: 10 }, 10)).toBe('ok');
    expect(judge({ cap: 100, used: 50, reserved: 60 }, 10)).toBe('busy');
    // Süren iş: tavan × 1,2.
    expect(judge({ cap: 100, used: 110, reserved: 10 }, 10, 1.2)).toBe('ok');
    expect(judge({ cap: 100, used: 120, reserved: 1 }, 1, 1.2)).toBe('cap');
    // Asıl tavan dolmuş, pay %20'ye sığmıyor: kesin (geçici ret işi boşuna bekletirdi).
    expect(judge({ cap: 100, used: 110, reserved: 20 }, 20, 1.2)).toBe('cap');
    // Asıl tavan dolmamış, pay %20'ye de sığmıyor: geçici.
    expect(judge({ cap: 100, used: 95, reserved: 30 }, 30, 1.2)).toBe('busy');
  });

  it('allowAll her çağrıyı kabul eder, rezervasyon kimliği satırın kimliğidir', async () => {
    const id = uuidv7();
    expect(await allowAll.admit(inputOf(id, { reserveUsd: 1_000 }))).toEqual({ ok: true, reservationId: id });
  });
});

describe('platform tavanları', () => {
  it('tavan altı geçer; günlük tavan dolunca bütün firmalar sod_platform_paused alır (firma hakkı dolmuş sayılmaz)', async () => {
    await platformCaps({ dayUsd: 1 });
    const limits = make();
    await row({ costUsd: 0.99 });
    const a = await call(limits, { reserveUsd: 0.01 });
    expect(code(a)).toBe('ok');
    await finish(limits, a, 0.01);
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('sod_platform_paused');
    expect(code(await call(limits, { orgId: 'org-b', product: 'tagpress', reserveUsd: 0.001 }))).toBe('sod_platform_paused');
    // Reddedilen satır tutarsız ve paysız kapandı.
    const rejected = await prisma.aiCall.findMany({ where: { status: 'rejected' } });
    expect(rejected.every((r) => r.costMicroUsd === 0n && r.reservedMicroUsd === 0n)).toBe(true);
  });

  it('aylık tavan (UTC ayı) ve ortam varsayılanları (günlük 10 $, aylık 150 $)', async () => {
    const limits = make();
    await row({ costUsd: 9.99, orgId: 'org-x' });
    // Gün dolmadı, yalnız pay sığmıyor: geçici.
    expect(code(await call(limits, { reserveUsd: 0.02 }))).toBe('sod_rate_limited');
    expect(code(await call(limits, { reserveUsd: 0.005 }))).toBe('ok');
    await row({ costUsd: 0.01, orgId: 'org-x' });
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('sod_platform_paused');
    await reset();
    // Ayın başka günlerinde 149,99 $ (günlük tavan ayrı).
    await row({ costUsd: 149.99, orgId: 'org-x', at: new Date('2026-11-02T10:00:00Z') });
    expect(code(await call(limits, { reserveUsd: 0.02 }))).toBe('sod_rate_limited');
    await row({ costUsd: 0.01, orgId: 'org-x', at: new Date('2026-11-02T10:00:00Z') });
    expect(code(await call(limits, { reserveUsd: 0.02 }))).toBe('sod_platform_paused');
    await platformCaps({ monthUsd: 200 });
    expect(code(await call(limits, { reserveUsd: 0.02 }))).toBe('ok');
  });

  it('R2: şişkin pay tavan dolmadan "platform durdu" ya da "hak doldu" demez: 8,70/10 $ günde 1,44 $ pay → geçici, kesin değil', async () => {
    const limits = make();
    await row({ costUsd: 8.7, orgId: 'org-x' });
    const day = await call(limits, { reserveUsd: 1.44 });
    expect(day.result).toEqual({ ok: false, code: 'sod_rate_limited', retryAfterSec: BUSY_RETRY_SEC });
    expect(code(day)).not.toBe('sod_platform_paused');
    // Aynı çağrı küçük payla (gerçekçi 0,13 $) geçer.
    expect(code(await call(limits, { reserveUsd: 0.13 }))).toBe('ok');
    await reset();
    // Araç tavanı 13,70/15 $ (DeciShip; ayın başka günü): yine geçici, `sod_tool_cap` değil.
    await orgRow('org-a', { capUsd: 100 });
    await row({ costUsd: 13.7, at: EARLIER });
    const tool = await call(limits, { reserveUsd: 1.44 });
    expect(tool.result).toMatchObject({ ok: false, code: 'sod_rate_limited' });
    // Firmanın ortak hakkı 29/30 $: yine geçici, `sod_org_cap` değil.
    await reset();
    await row({ product: 'tagpress', costUsd: 16, at: EARLIER });
    await row({ product: 'deciship', costUsd: 13, at: EARLIER });
    expect(code(await call(limits, { reserveUsd: 1.44 }))).toBe('sod_rate_limited');
    expect(code(await call(limits, { reserveUsd: 0.5 }))).toBe('ok');
  });

  it('yöneticinin durdurması her şeyi durdurur (süren işe pay tanımaz); firmanın kendi anahtarı da durur', async () => {
    await platformCaps({ paused: true });
    const limits = make();
    const requestId = randomUUID();
    await row({ origin: 'job', requestId, costUsd: 0.01 });
    expect(code(await call(limits, { origin: 'job', requestId, reserveUsd: 0.01 }))).toBe('sod_platform_paused');
    expect(code(await call(limits, { keySource: 'org', reserveUsd: 0.01 }))).toBe('sod_platform_paused');
  });

  it('firmanın kendi anahtarıyla yapılan çağrı para tavanlarına girmez, sayılmaz da [V]', async () => {
    await platformCaps({ dayUsd: 1 });
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    await row({ costUsd: 5, keySource: 'org' });
    expect(code(await call(limits, { reserveUsd: 0.5 }))).toBe('ok');
    await row({ costUsd: 1 });
    expect(code(await call(limits, { reserveUsd: 0.5, keySource: 'org' }))).toBe('ok');
  });
});

describe('firmanın tek ortak aylık hakkı', () => {
  it('bütün araçlarda tek: DeciShip + TagPress harcaması toplanır, ikisi de sod_org_cap alır; başka firma etkilenmez', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    await row({ product: 'deciship', costUsd: 0.6 });
    await row({ product: 'tagpress', costUsd: 0.39 });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.01 }))).toBe('ok');
    await reset();
    await orgRow('org-a', { capUsd: 1 });
    await row({ product: 'deciship', costUsd: 0.6 });
    await row({ product: 'tagpress', costUsd: 0.4 });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.001 }))).toBe('sod_org_cap');
    expect(code(await call(limits, { product: 'deciship', reserveUsd: 0.001 }))).toBe('sod_org_cap');
    expect(code(await call(limits, { orgId: 'org-b', product: 'deciship', reserveUsd: 0.5 }))).toBe('ok');
  });

  it('varsayılan 30 $ (AI_ORG_MONTHLY_USD); yöneticinin ezdiği tutar geçer', async () => {
    const limits = make();
    // Ayın başka gününde (platformun günlük tavanı 10 $ ayrı).
    await row({ product: 'deciship', costUsd: 14, at: EARLIER });
    await row({ product: 'tagpress', costUsd: 15.99, at: EARLIER });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.02 }))).toBe('sod_rate_limited');
    await row({ product: 'tagpress', costUsd: 0.01, at: EARLIER });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.02 }))).toBe('sod_org_cap');
    await orgRow('org-a', { capUsd: 50 });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.02 }))).toBe('ok');
  });

  it('kapalı ya da silinmiş firma: sod_org_closed (tutar sorulmadan)', async () => {
    const limits = make();
    await orgRow('org-a', { closed: true });
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_org_closed');
    await orgRow('org-a', { purged: true });
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_org_closed');
    await orgRow('org-a', {});
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('ok');
  });
});

describe('firma × araç koruma tavanı', () => {
  it('kayıttaki varsayılan (TagPress 20 $, DeciShip 15 $); yalnız o araç durur', async () => {
    await orgRow('org-a', { capUsd: 100 });
    const limits = make();
    await row({ product: 'tagpress', costUsd: 20, at: EARLIER });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.001 }))).toBe('sod_tool_cap');
    expect(code(await call(limits, { product: 'deciship', reserveUsd: 0.5 }))).toBe('ok');
    await row({ product: 'deciship', costUsd: 14.99, at: EARLIER });
    expect(code(await call(limits, { product: 'deciship', reserveUsd: 0.5 }))).toBe('sod_rate_limited');
    await row({ product: 'deciship', costUsd: 0.01, at: EARLIER });
    expect(code(await call(limits, { product: 'deciship', reserveUsd: 0.001 }))).toBe('sod_tool_cap');
  });

  it('abonelik limiti ezer; 0: o araçta yapay zekâ kapalı (tahmin 0 olsa da); null: kayıttaki varsayılan', async () => {
    await orgRow('org-a', { capUsd: 100 });
    const limits = make();
    await toolCap('org-a', 'tagpress', 0.5);
    await row({ product: 'tagpress', costUsd: 0.5 });
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.001 }))).toBe('sod_tool_cap');
    await toolCap('org-a', 'tagpress', 0);
    await reset();
    await orgRow('org-a', { capUsd: 100 });
    await toolCap('org-a', 'tagpress', 0);
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0 }))).toBe('sod_tool_cap');
    await toolCap('org-a', 'tagpress', null);
    expect(code(await call(limits, { product: 'tagpress', reserveUsd: 0.01 }))).toBe('ok');
  });

  it('birden çok tavan takılırsa sıra platform, firma, araç; kesin ret geçiciden önce gelir', async () => {
    await platformCaps({ dayUsd: 1 });
    await orgRow('org-a', { capUsd: 1 });
    await toolCap('org-a', 'deciship', 1);
    const limits = make();
    await row({ costUsd: 1 });
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_platform_paused');
    await platformCaps({ dayUsd: 10 });
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_org_cap');
    await reset();
    // Platformda yalnız açık pay sorunu (geçici), firmada kesin dolu: kesin olan döner.
    await platformCaps({ dayUsd: 1 });
    await orgRow('org-b', { capUsd: 0.2 });
    await row({ orgId: 'org-a', status: 'pending', reserveUsd: 0.9 });
    await row({ orgId: 'org-b', costUsd: 0.2 });
    expect(code(await call(limits, { orgId: 'org-b', reserveUsd: 0.05 }))).toBe('sod_org_cap');
  });
});

describe('pay ayırma', () => {
  it('süren çağrıların payı tavanı dolduruyorsa geçici ret (sod_rate_limited, 15 sn); biter bitmez kabul', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    await row({ costUsd: 0.5 });
    const big = await call(limits, { reserveUsd: 0.4 });
    expect(code(big)).toBe('ok');
    const waiting = await call(limits, { reserveUsd: 0.2 });
    expect(waiting.result).toEqual({ ok: false, code: 'sod_rate_limited', retryAfterSec: BUSY_RETRY_SEC });
    await finish(limits, big, 0.1);
    expect(code(await call(limits, { reserveUsd: 0.2 }))).toBe('ok');
  });

  it('kendi payı kalan hakka sığmayan çağrı (harcanan tavanın altında) geçici ret, kesin değil (R2: pay kaba üst tahmin); küçüğü geçer', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    await row({ costUsd: 0.5 });
    expect((await call(limits, { reserveUsd: 0.6 })).result).toEqual({ ok: false, code: 'sod_rate_limited', retryAfterSec: BUSY_RETRY_SEC });
    expect(code(await call(limits, { reserveUsd: 0.5 }))).toBe('ok');
  });

  it('çağıranın satırı yoksa (sözleşme dışı) payı tahminden eklenir; satırı varsa ikinci kez eklenmez', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    // Satır yok: 0,4 + 0,61 > 1 (geçici: tavan dolmadı).
    await row({ costUsd: 0.4 });
    expect(await limits.admit(inputOf(uuidv7(), { reserveUsd: 0.61 }))).toMatchObject({ ok: false, code: 'sod_rate_limited' });
    // Satır var: 0,4 + 0,6 = 1 sığar (pay bir kez sayılır).
    expect(code(await call(limits, { reserveUsd: 0.6 }))).toBe('ok');
  });

  it('ay dönümünü aşan açık çağrının payı yeni ayda da sayılır (temkinli); kapanınca açıldığı aya yazılır', async () => {
    await orgRow('org-a', { capUsd: 1, timeZone: 'UTC' });
    const limits = make();
    clock = new Date('2026-11-30T23:59:00Z');
    const late = await call(limits, { reserveUsd: 0.9 });
    expect(code(late)).toBe('ok');
    clock = new Date('2026-12-01T00:01:00Z');
    expect(code(await call(limits, { reserveUsd: 0.2 }))).toBe('sod_rate_limited');
    await finish(limits, late, 0.9);
    expect(code(await call(limits, { reserveUsd: 0.2 }))).toBe('ok');
  });
});

describe('yarış', () => {
  it('60 eşzamanlı çağrı (satırlar yazılmış): yalnız tavana sığan 10 tanesi kabul edilir, kalanı geçici ret; aşım yok', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make({ rate: { orgCallsPerMinute: 1000, toolConcurrent: 1000 } });
    const ids = await Promise.all(Array.from({ length: 60 }, () => row({ status: 'pending', reserveUsd: 0.1 })));
    const results = await Promise.all(ids.map((id) => limits.admit(inputOf(id, { reserveUsd: 0.1 }))));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(10);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'sod_rate_limited')).toBe(true);
    for (const [i, r] of results.entries()) if (!r.ok) await closeRejected(ids[i]!, r.code);
    // Kabul edilenler tam payla bitti: tavan doldu, sonraki çağrı kesin ret.
    for (const [i, r] of results.entries()) if (r.ok) await finish(limits, { id: ids[i]!, result: r }, 0.1);
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('sod_org_cap');
    expect(limits.rate.inFlight).toBe(0);
  });

  it('satır yazımı ve kabul iç içe (40 eşzamanlı vekil isteği): kabul edilen payların toplamı tavanı aşmaz, en az biri geçer', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make({ rate: { orgCallsPerMinute: 1000, toolConcurrent: 1000 } });
    const calls = await Promise.all(Array.from({ length: 40 }, () => call(limits, { reserveUsd: 0.15 })));
    const ok = calls.filter((c) => c.result.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.length * 0.15).toBeLessThanOrEqual(1);
  });

  it('iki geçit süreci (iki ayrı örnek, ortak veritabanı) aynı anda: toplam yine tavanı aşmaz; sığan küçük yük tamamen geçer', async () => {
    await platformCaps({ dayUsd: 1 });
    const a = make({ rate: { orgCallsPerMinute: 1000, toolConcurrent: 1000 } });
    const b = make({ rate: { orgCallsPerMinute: 1000, toolConcurrent: 1000 } });
    const burst = async (n: number) => {
      const ids = await Promise.all(Array.from({ length: n }, (_, i) => row({ orgId: `org-${i % 5}`, status: 'pending', reserveUsd: 0.1 })));
      const results = await Promise.all(ids.map((id, i) => (i % 2 ? a : b).admit(inputOf(id, { orgId: `org-${i % 5}`, reserveUsd: 0.1 }))));
      for (const [i, r] of results.entries()) if (!r.ok) await closeRejected(ids[i]!, r.code);
      return results.filter((r) => r.ok).length;
    };
    // Öbür sürecin kararı bekleyen satırları da sayılır (temkinli): toplam tavanı aşmaz, gerekirse hepsi "sonra dene" alır.
    expect(await burst(40)).toBeLessThanOrEqual(10);
    await reset();
    await platformCaps({ dayUsd: 1 });
    expect(await burst(6)).toBe(6);
  });
});

describe('süren iş: tavanın %20 üstüne kadar', () => {
  it('tavandan önce başlamış iş zinciri (aynı istek kimliği) %20 üstüne kadar sürer, sonra durur; tavandan sonra açılan iş ve kişinin isteği durur', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make();
    const job = randomUUID();
    const first = await call(limits, { origin: 'job', requestId: job, reserveUsd: 0.1 });
    expect(code(first)).toBe('ok');
    await finish(limits, first, 0.95);
    // Tavan doldu (0,95 + 0,1 > 1): zincir sürer.
    const second = await call(limits, { origin: 'job', requestId: job, reserveUsd: 0.1 });
    expect(code(second)).toBe('ok');
    await finish(limits, second, 0.2);
    // 1,15 + 0,1 > 1,2: iş de durur.
    expect(code(await call(limits, { origin: 'job', requestId: job, reserveUsd: 0.1 }))).toBe('sod_org_cap');
    expect(code(await call(limits, { origin: 'job', requestId: job, reserveUsd: 0.04 }))).toBe('ok');
    // Yeni iş ve kişinin isteği pay almaz.
    expect(code(await call(limits, { origin: 'job', reserveUsd: 0.01 }))).toBe('sod_org_cap');
    expect(code(await call(limits, { origin: 'request', requestId: job, reserveUsd: 0.01 }))).toBe('sod_org_cap');
  });

  it('zincirin yalnız reddedilmiş satırı varsa pay yok; 24 saatten eski satır sayılmaz; araç ve platform tavanında da geçerli', async () => {
    await orgRow('org-a', { capUsd: 100 });
    await toolCap('org-a', 'deciship', 1);
    const limits = make();
    const job = randomUUID();
    await row({ origin: 'job', requestId: job, status: 'rejected' });
    await row({ costUsd: 1 });
    expect(code(await call(limits, { origin: 'job', requestId: job, reserveUsd: 0.1 }))).toBe('sod_tool_cap');
    const old = randomUUID();
    await row({ origin: 'job', requestId: old, costUsd: 0, at: new Date(clock.getTime() - 25 * 3600_000) });
    expect(code(await call(limits, { origin: 'job', requestId: old, reserveUsd: 0.1 }))).toBe('sod_tool_cap');
    const live = randomUUID();
    await row({ origin: 'job', requestId: live, costUsd: 0 });
    expect(code(await call(limits, { origin: 'job', requestId: live, reserveUsd: 0.1 }))).toBe('ok');
  });
});

describe('dönem dönümü', () => {
  it('gün dönümü (UTC): dolu gün gece yarısı biter, önceki günün harcaması yeni güne sayılmaz', async () => {
    await platformCaps({ dayUsd: 1 });
    const limits = make();
    clock = new Date('2026-11-15T23:59:00Z');
    await row({ costUsd: 1 });
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_platform_paused');
    clock = new Date('2026-11-16T00:00:01Z');
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('ok');
  });

  it('firmanın ayı kendi saat diliminde: İstanbul 1 Aralık 00:30 (UTC 30 Kasım 21:30) yeni ay', async () => {
    await orgRow('org-a', { capUsd: 1, timeZone: 'Europe/Istanbul' });
    const limits = make();
    await row({ costUsd: 1, at: new Date('2026-11-30T20:30:00Z') });
    clock = new Date('2026-11-30T20:45:00Z');
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('sod_org_cap');
    clock = new Date('2026-11-30T21:30:00Z');
    expect(code(await call(limits, { reserveUsd: 0.01 }))).toBe('ok');
  });

  it('dönem sınırları: saat dilimi farkı ve yaz saati; geçersiz saat dilimi varsayılana düşer', () => {
    expect(zonedPeriodStart('2026-12', 'Europe/Istanbul').toISOString()).toBe('2026-11-30T21:00:00.000Z');
    expect(zonedPeriodStart('2026-04', 'America/New_York').toISOString()).toBe('2026-04-01T04:00:00.000Z');
    expect(zonedPeriodStart('2026-01', 'America/New_York').toISOString()).toBe('2026-01-01T05:00:00.000Z');
    const m = orgMonth(new Date('2026-11-30T21:30:00Z'), 'Yok/Boyle');
    expect(m.period).toBe('2026-12');
    expect(m.end.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });
});

describe('hız ve eşzamanlılık', () => {
  it('firma başına dakikada sınır: aşınca sod_rate_limited + bekleme; pencere kayınca açılır; başka firma etkilenmez', async () => {
    const limits = make({ rate: { orgCallsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) await finish(limits, await call(limits, { reserveUsd: 0.001 }), 0.001);
    const fourth = await call(limits, { reserveUsd: 0.001 });
    expect(fourth.result).toMatchObject({ ok: false, code: 'sod_rate_limited' });
    const wait = (fourth.result as { retryAfterSec: number }).retryAfterSec;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(code(await call(limits, { orgId: 'org-b', reserveUsd: 0.001 }))).toBe('ok');
    clock = new Date(clock.getTime() + 61_000);
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('ok');
  });

  it('sağlayıcıya gitmeyen çağrının (release) dakika hakkı geri verilir; settle vermez', async () => {
    const limits = make({ rate: { orgCallsPerMinute: 1 } });
    const a = await call(limits, { reserveUsd: 0.001 });
    if (a.result.ok) await limits.release(a.result.reservationId);
    const b = await call(limits, { reserveUsd: 0.001 });
    expect(code(b)).toBe('ok');
    await finish(limits, b, 0.001);
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('sod_rate_limited');
  });

  it('firma başına aynı anda akış ve araç başına aynı anda çağrı; bitince yer açılır; hız reddi satırın payını bırakır', async () => {
    await orgRow('org-a', { capUsd: 1 });
    const limits = make({ rate: { orgConcurrentStreams: 2, toolConcurrent: 3 } });
    const s1 = await call(limits, { stream: true, reserveUsd: 0.1 });
    const s2 = await call(limits, { stream: true, reserveUsd: 0.1 });
    const s3 = await call(limits, { stream: true, reserveUsd: 0.1 });
    expect([code(s1), code(s2), code(s3)]).toEqual(['ok', 'ok', 'sod_rate_limited']);
    const plain = await call(limits, { stream: false, reserveUsd: 0.1 });
    expect(code(plain)).toBe('ok');
    // Araç dolu (3): başka firmadan da olsa.
    expect(code(await call(limits, { orgId: 'org-b', reserveUsd: 0.1 }))).toBe('sod_rate_limited');
    expect(code(await call(limits, { orgId: 'org-b', product: 'tagpress', reserveUsd: 0.1 }))).toBe('ok');
    await finish(limits, s1, 0.05);
    expect(code(await call(limits, { stream: true, reserveUsd: 0.1 }))).toBe('ok');
  });

  it('settle ve release bir kez sayılır; bildirimi gelmeyen kira süresi dolunca düşer', async () => {
    const limits = make({ rate: { toolConcurrent: 1, leaseMs: 60_000 } });
    const a = await call(limits, { reserveUsd: 0.001 });
    expect(limits.rate.inFlight).toBe(1);
    if (a.result.ok) {
      await limits.settle(a.result.reservationId, 1);
      await limits.settle(a.result.reservationId, 1);
      await limits.release(a.result.reservationId);
    }
    expect(limits.rate.inFlight).toBe(0);
    const b = await call(limits, { reserveUsd: 0.001 });
    expect(code(b)).toBe('ok');
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('sod_rate_limited');
    clock = new Date(clock.getTime() + 61_000);
    expect(code(await call(limits, { reserveUsd: 0.001 }))).toBe('ok');
  });

  it('admit fırlatırsa kira kalmaz (vekil satırı failed kapatır)', async () => {
    const broken = { $transaction: async () => Promise.reject(new Error('db düştü')) } as unknown as PrismaClient;
    const limits = createLimits({ prisma: broken, now });
    await expect(limits.admit(inputOf(uuidv7(), { reserveUsd: 0.01 }))).rejects.toThrow('db düştü');
    expect(limits.rate.inFlight).toBe(0);
  });
});
