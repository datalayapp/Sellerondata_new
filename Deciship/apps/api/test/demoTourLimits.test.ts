/**
 * Y130: deneme turunun kalan iki sınırı.
 *  1. Çok yavaş ama süren yükleme (15 dk'yı aşan): yükleme sürdükçe `loadingSince` tazelenir; başka kopyanın bitirmesi
 *     409 DEMO_LOADING alır, hiçbir şey silinmez. Eskiden süresi dolmuş sayılıp temizleniyor, arkadan gelen örnek veri kalıyordu.
 *  2. `carrierIds` taşımayan (eski sürüm) bayrak: örnek taşıyıcılar sıkı kuralla bulunup silinir (eskiden hiçbir taşıyıcı
 *     silinmiyordu); kurala uymayan taşıyıcı (gerçek fatura, pencere dışı kayıt, aynı koddan iki aday) olduğu gibi kalır.
 * Kendi dosyasında: örnek fatura yüklemesini bekletmek için `sampleInvoices.ts` taklit edilir (demoTour.test.ts başka taklit kullanır).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Yükleme bekletilir: `hold` varken örnek fatura yüklemesi `reached`'i çağırıp `hold`'u bekler.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, reached: null as (() => void) | null }));
vi.mock('../src/services/sampleInvoices.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/sampleInvoices.ts')>();
  return {
    ...mod,
    importDemoInvoice: async (...args: Parameters<typeof mod.importDemoInvoice>) => {
      if (gate.hold) {
        gate.reached?.();
        await gate.hold;
      }
      return mod.importDemoInvoice(...args);
    },
  };
});

import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { sampleCarrierCodes } from '../src/services/companyData.ts';
import { DEMO_CLIENT_ID_PREFIX, DEMO_LOADING_TTL_MS, demoLoadingFresh, removeDemoData, startDemo } from '../src/services/demoTour.ts';
import { getApp, inCompany, registerCompany, uniq } from './helpers.ts';

const API = '/api/deciship';
const silent = { warn: () => undefined };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, timeoutMs = 8000, label = 'koşul') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`${label} ${timeoutMs} ms içinde gerçekleşmedi`);
}

type Flag = { startedAt: string; byMemberId: string | null; carrierIds?: string[]; loadingSince?: string };

const rawSettings = (companyId: string) =>
  inCompany(companyId, async () => (await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } })).settings as Record<string, unknown> & { demo?: Flag });
const rawFlag = async (companyId: string) => (await rawSettings(companyId)).demo;
const writeFlag = async (companyId: string, demo: Flag) => {
  const s = await rawSettings(companyId);
  await inCompany(companyId, () => prisma.company.update({ where: { id: companyId }, data: { settings: { ...s, demo } } }));
};

function counts(companyId: string) {
  return inCompany(companyId, async () => ({
    carriers: await prisma.carrier.count({ where: { companyId } }),
    tariffs: await prisma.tariff.count({ where: { companyId } }),
    invoices: await prisma.invoice.count({ where: { companyId } }),
    lines: await prisma.invoiceLine.count({ where: { companyId } }),
    measurements: await prisma.measurement.count({ where: { companyId } }),
    demoMeasurements: await prisma.measurement.count({ where: { companyId, clientId: { startsWith: DEMO_CLIENT_ID_PREFIX } } }),
  }));
}

const carriersOf = (companyId: string) =>
  inCompany(companyId, () => prisma.carrier.findMany({ where: { companyId }, select: { id: true, code: true }, orderBy: { code: 'asc' } }));

afterEach(() => {
  gate.hold = null;
  gate.reached = null;
});

describe('Y130: yavaş yükleme', () => {
  it('15 dakikayı aşan ama süren yükleme tazelenir: başka kopyanın bitirmesi 409 DEMO_LOADING, hiçbir şey silinmez; yükleme bitince tazeleme durur', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Deneme Yavaş '));
    let open!: () => void;
    gate.hold = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (gate.reached = r));

    const run = startDemo(a.companyId, a.userId, { heartbeatMs: 40, log: silent });
    await reached;
    // Yükleme ilk örnek faturada bekliyor; süre geçmiş gibi: işaret süresi dolmuş bir ana çekilir.
    const flag = (await rawFlag(a.companyId))!;
    expect(flag.loadingSince).toBeTruthy();
    await writeFlag(a.companyId, { ...flag, loadingSince: new Date(Date.now() - DEMO_LOADING_TTL_MS - 60_000).toISOString() });
    expect(demoLoadingFresh((await rawFlag(a.companyId))!)).toBe(false);
    // Süren yükleme işareti tazeler (süreç ayakta)
    await until(async () => demoLoadingFresh((await rawFlag(a.companyId))!), 5000, 'tazeleme');

    // Başka kopyanın bitirmesi (bu sürecin sırasına girmeden): reddedilir, hiçbir şey silinmez
    const before = await counts(a.companyId);
    expect(before.carriers).toBeGreaterThan(0);
    const other = await removeDemoData(a.companyId, { log: silent }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(other).toBeInstanceOf(AppError);
    expect((other as AppError).code).toBe('DEMO_LOADING');
    expect(await counts(a.companyId)).toEqual(before);

    open();
    const result = await run;
    expect(result.invoices).toBe(2);
    const done = (await rawFlag(a.companyId))!;
    expect(done.loadingSince).toBeUndefined();
    expect(done.startedAt).toBe(flag.startedAt);
    // tazeleme durdu: işaret geri gelmez
    await sleep(200);
    expect((await rawFlag(a.companyId))!.loadingSince).toBeUndefined();

    // bitirme hepsini siler
    const e = await app.inject({ method: 'DELETE', url: `${API}/settings/demo`, headers: a.auth });
    expect(e.statusCode, e.body).toBe(200);
    expect(await counts(a.companyId)).toMatchObject({ carriers: 0, tariffs: 0, invoices: 0, demoMeasurements: 0 });
  }, 120_000);

  it('düşen yükleme (tazeleme yok) eskisi gibi süresi dolunca temizlenebilir', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Deneme Düşen '));
    expect((await app.inject({ method: 'POST', url: `${API}/settings/demo`, headers: a.auth, payload: {} })).statusCode).toBe(201);
    const flag = (await rawFlag(a.companyId))!;
    // süreç düşmüş gibi: işaret kalmış, süresi dolmuş, tazeleyen yok
    await writeFlag(a.companyId, { ...flag, loadingSince: new Date(Date.now() - DEMO_LOADING_TTL_MS - 60_000).toISOString() });
    const removed = await removeDemoData(a.companyId, { log: silent });
    expect(removed?.invoices).toBe(2);
    expect(await counts(a.companyId)).toMatchObject({ carriers: 0, tariffs: 0, invoices: 0, demoMeasurements: 0 });
  }, 120_000);
});

describe('Y130: carrierIds taşımayan (eski sürüm) bayrak', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  /** Deneme açılır, bayrak eski biçime çevrilir (`carrierIds` ve `loadingSince` yok). */
  async function legacyDemo(name: string) {
    const a = await registerCompany(app, uniq(name));
    expect((await app.inject({ method: 'POST', url: `${API}/settings/demo`, headers: a.auth, payload: {} })).statusCode).toBe(201);
    const flag = (await rawFlag(a.companyId))!;
    expect(flag.carrierIds?.length).toBe(sampleCarrierCodes().length);
    await writeFlag(a.companyId, { startedAt: flag.startedAt, byMemberId: flag.byMemberId });
    expect((await rawFlag(a.companyId))!.carrierIds).toBeUndefined();
    return { a, startedAt: flag.startedAt, carriers: await carriersOf(a.companyId) };
  }
  const end = (auth: { authorization: string }) => app.inject({ method: 'DELETE', url: `${API}/settings/demo`, headers: auth });
  const byCode = (list: { id: string; code: string }[], code: string) => list.filter((c) => c.code === code);

  it('kurala uyan örnek taşıyıcılar, tarifeleri ve faturaları silinir; bayrak iner', async () => {
    const { a } = await legacyDemo('Eski Bayrak ');
    const before = await counts(a.companyId);
    const e = await end(a.auth);
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().removed).toMatchObject({ carriers: before.carriers, tariffs: before.tariffs, invoices: 2, measurements: before.demoMeasurements });
    expect(await counts(a.companyId)).toMatchObject({ carriers: 0, tariffs: 0, invoices: 0, lines: 0, demoMeasurements: 0 });
    expect(await rawFlag(a.companyId)).toBeUndefined();
  }, 120_000);

  it('kurala uymayan taşıyıcı kalır: gerçek numaralı faturası, pencere dışı tarifesi ya da aynı koddan ikinci aday varsa', async () => {
    const codes = sampleCarrierCodes();
    expect(codes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = codes as [string, string];

    // (1) Birinci örnek taşıyıcının faturalarından biri gerçek numara taşıyor: o taşıyıcı (tarife ve faturalarıyla) kalır.
    const one = await legacyDemo('Eski Gerçek Fatura ');
    const firstCarrier = byCode(one.carriers, first)[0]!;
    const inv = await inCompany(one.a.companyId, () => prisma.invoice.findFirst({ where: { companyId: one.a.companyId, carrierId: firstCarrier.id } }));
    if (inv) {
      await inCompany(one.a.companyId, () => prisma.invoice.update({ where: { id: inv.id }, data: { invoiceNo: uniq('GERCEK-') } }));
    } else {
      // bu örnekte birinci taşıyıcının faturası yoksa pencere dışı tarife ile aynı sonuç sınanır
      await inCompany(one.a.companyId, () => prisma.tariff.updateMany({ where: { companyId: one.a.companyId, carrierId: firstCarrier.id }, data: { createdAt: new Date(Date.parse(one.startedAt) + DEMO_LOADING_TTL_MS + 3_600_000) } }));
    }
    const kept1Before = await inCompany(one.a.companyId, async () => ({
      tariffs: await prisma.tariff.count({ where: { carrierId: firstCarrier.id } }),
      invoices: await prisma.invoice.count({ where: { carrierId: firstCarrier.id } }),
    }));
    expect((await end(one.a.auth)).statusCode).toBe(200);
    expect((await carriersOf(one.a.companyId)).map((c) => c.id)).toEqual([firstCarrier.id]);
    expect(
      await inCompany(one.a.companyId, async () => ({
        tariffs: await prisma.tariff.count({ where: { carrierId: firstCarrier.id } }),
        invoices: await prisma.invoice.count({ where: { carrierId: firstCarrier.id } }),
      })),
    ).toEqual(kept1Before);
    expect((await counts(one.a.companyId)).demoMeasurements).toBe(0);

    // (2) İkinci kodlu taşıyıcı pencere dışında açılmış (denemeden bir saat önce): kalır; öbürleri silinir.
    const two = await legacyDemo('Eski Pencere ');
    const secondCarrier = byCode(two.carriers, second)[0]!;
    await inCompany(two.a.companyId, () => prisma.carrier.update({ where: { id: secondCarrier.id }, data: { createdAt: new Date(Date.parse(two.startedAt) - 3_600_000) } }));
    expect((await end(two.a.auth)).statusCode).toBe(200);
    expect((await carriersOf(two.a.companyId)).map((c) => c.id)).toEqual([secondCarrier.id]);

    // (3) Aynı koddan ikinci taşıyıcı (pencere içinde, örnekle aynı kod): hangisi örnek bilinmez, ikisi de kalır.
    const three = await legacyDemo('Eski İki Aday ');
    const extra = await inCompany(three.a.companyId, () => prisma.carrier.create({ data: { companyId: three.a.companyId, code: first, name: 'Gerçek' } }));
    expect((await end(three.a.auth)).statusCode).toBe(200);
    const left = await carriersOf(three.a.companyId);
    expect(left.map((c) => c.code)).toEqual([first, first]);
    expect(left.map((c) => c.id)).toContain(extra.id);
    expect(left.map((c) => c.id)).toContain(byCode(three.carriers, first)[0]!.id);
    expect(await rawFlag(three.a.companyId)).toBeUndefined();
  }, 240_000);
});
