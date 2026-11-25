/**
 * Toplu ham SQL satır yazımı (services/lineWrite.ts) Prisma'nın yazdığıyla birebir aynı mı: Decimal yuvarlaması,
 * null'lar, enum'lar, dizi sırası, gün (shipDate) ve zaman damgaları — veritabanı oturumu UTC dışında olsa bile.
 */
import { beforeAll, describe, expect, it as baseIt } from 'vitest';
import { roundEdges, type DiffType } from '@deciship/core';
import { prisma, Prisma, withCompany } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import type { PrevResult } from '../src/services/compare.ts';
import { atStoredPrecision, insertInvoiceLines, LINE_SCALE, storedEdge, storedNumber, writeLineResults, writeRecalcPending, type NewInvoiceLine } from '../src/services/lineWrite.ts';
import { numOrNull as num } from '../src/lib/util.ts';
import { getApp, inCompany, measurementPayload, multipart, registerCompany, uniq } from './helpers.ts';

const COMPARE_KEYS = [
  'companyId', 'rowIndex', 'trackingNo', 'shipDate', 'service', 'destCountry', 'actualKg', 'billedKg', 'dimL', 'dimW', 'dimH',
  'billedDivisor', 'baseAmount', 'discountAmount', 'fuelAmount', 'surcharges', 'netAmount', 'currency', 'reference', 'packaging', 'rawHash',
  'parseFlags', 'decision', 'measurementId', 'tariffId', 'status', 'diffTypes', 'ourChargeableKg', 'billedChargeableKg',
  'expectedAmount', 'diffAmount', 'breakdown', 'pricing', 'note', 'parseChecked', 'measurementPinned', 'noteManual',
  'tariffRevisionId', 'prevResult', 'recalcPending',
] as const;

function lines(companyId: string): NewInvoiceLine[] {
  // yarıma denk gelen / kayan nokta gürültülü değerler (Decimal(14,2), (10,3), (8,1) yuvarlaması)
  const awkward = [1.005, 2.675, 0.1 + 0.2, 1e-7, 123456.125, -0.005, 999.995, 1234.5678];
  return awkward.map((v, i) => ({
    companyId,
    rowIndex: i,
    trackingNo: `79510000${String(i).padStart(4, '0')}`,
    shipDate: i % 2 ? new Date('2026-10-15T00:00:00.000Z') : null,
    service: i === 3 ? null : `Intl Priority — "ş" ${i}`,
    destCountry: i === 4 ? null : 'DE',
    actualKg: v,
    billedKg: i === 5 ? null : v * 3,
    dimL: v * 10,
    dimW: 20.05,
    dimH: i === 6 ? null : 30.25,
    billedDivisor: i === 7 ? null : 5000,
    baseAmount: v * 100,
    discountAmount: i === 2 ? null : -v,
    fuelAmount: 0.125 * i,
    surcharges: i === 1 ? [] : [{ code: 'FUEL', name: 'Akaryakıt', amount: v }],
    netAmount: v * 101,
    currency: i === 0 ? null : 'TRY',
    reference: i === 2 ? "O'Brien; DROP TABLE x; --" : null,
    packaging: ([null, 'OWN', 'PAK', 'ENVELOPE'] as const)[i % 4]!,
    rawHash: `h${i}`,
    parseFlags: i === 3 ? ['TRACKING_FORMAT', 'CHARGES_MISMATCH', 'A'] : [],
    decision: (['OPEN', 'VERIFIED', 'ACCEPTED'] as const)[i % 3]!,
    measurementId: null,
    tariffId: null,
    tariffRevisionId: null,
    status: (['MATCH', 'DIFF', 'UNMATCHED', 'NO_TARIFF'] as const)[i % 4]!,
    diffTypes: i % 4 === 1 ? ['WEIGHT', 'PRICE', 'DIMS'] : [],
    ourChargeableKg: i % 3 ? v : null,
    billedChargeableKg: v + 0.0005,
    expectedAmount: i % 4 === 2 ? null : v * 99,
    diffAmount: i % 4 === 1 ? v * 2 : null,
    breakdown: [{ label: 'Taban', amount: v, nested: { b: 2, a: [1, 'x'] } }],
    pricing:
      i % 3 === 0
        ? null
        : { basis: i % 2 ? 'INVOICE' : 'TARIFF', rateDeviationPct: -v, confidence: i === 4 ? 'LOW' : 'HIGH', confidenceReason: i === 4 ? 'Faturada ücretli ağırlık yok' : null, zone: 'T', rateKg: 3, mode: 'split', adjustmentPct: 0 },
    note: i === 4 ? null : `not ${i}`,
  })) as NewInvoiceLine[];
}

async function newInvoice(companyId: string, invoiceNo: string) {
  const carrier = await prisma.carrier.findFirstOrThrow({ where: { companyId } });
  const user = await prisma.member.findFirstOrThrow({ where: { companyId } });
  const file = await prisma.file.create({
    data: { companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: 'x.csv', sha256: invoiceNo, createdById: user.id },
  });
  return prisma.invoice.create({
    data: {
      companyId,
      carrierId: carrier.id,
      invoiceNo,
      invoiceDate: new Date('2026-10-31T00:00:00.000Z'),
      currency: 'TRY',
      sourceFileId: file.id,
      mapping: {},
      totals: {},
    },
  });
}

const pick = (row: Record<string, unknown>) => Object.fromEntries(COMPARE_KEYS.map((k) => [k, row[k] instanceof Prisma.Decimal ? String(row[k]) : row[k]]));

describe('toplu satır yazımı = Prisma yazımı', () => {
  let companyId = '';
  // Testin tamamı firma bağlamında: doğrudan okuyup yazıyor.
  const it = (name: string, work: () => Promise<void>) => baseIt(name, () => withCompany(companyId, work));
  beforeAll(async () => {
    companyId = await seed({ reset: true, samples: true, log: () => {} });
  });

  it('ekleme: tüm alanlar Prisma createMany ile aynı', async () => {
    const data = lines(companyId);
    const viaPrisma = await newInvoice(companyId, 'P-1');
    await prisma.invoiceLine.createMany({
      data: data.map((l) => ({
        ...l,
        invoiceId: viaPrisma.id,
        surcharges: l.surcharges as Prisma.InputJsonValue,
        breakdown: l.breakdown as Prisma.InputJsonValue,
        pricing: (l.pricing ?? Prisma.DbNull) as Prisma.InputJsonValue,
      })),
    });
    const viaSql = await newInvoice(companyId, 'S-1');
    await prisma.$transaction((tx) => insertInvoiceLines(tx, viaSql.id, data));

    const a = await prisma.invoiceLine.findMany({ where: { invoiceId: viaPrisma.id }, orderBy: { rowIndex: 'asc' } });
    const b = await prisma.invoiceLine.findMany({ where: { invoiceId: viaSql.id }, orderBy: { rowIndex: 'asc' } });
    expect(b).toHaveLength(data.length);
    expect(b.map(pick)).toEqual(a.map(pick));
  });

  it('hesaplanmış (yuvarlanmamış) sayılar Prisma ile aynı yöne yuvarlanır; 2.000 sınırını aşan parçalar', async () => {
    // inç/lb çevirisi ve çarpımlar gibi uzun ondalıklı değerler (ör. 270.17499999999995, 31.749999999999996)
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const base = lines(companyId)[0]!;
    const data: NewInvoiceLine[] = Array.from({ length: 2501 }, (_, i) => {
      const a = Math.round(rnd() * 100000) / 1000;
      const b = Math.round(rnd() * 100000) / 100;
      const v = i % 3 === 0 ? a * b : i % 3 === 1 ? (a * 1.18) / 3 : a * 0.45359237 + b;
      return { ...base, rowIndex: i, trackingNo: `T${i}`, netAmount: v, baseAmount: v / 3, actualKg: v / 10, dimL: (a * 2.54) % 1000, expectedAmount: v * 0.97, diffAmount: v * 0.03 };
    });
    data.push({ ...base, rowIndex: 2501, trackingNo: 'T-edge', netAmount: 270.17499999999995, actualKg: 1.0054999999999998, dimL: 31.749999999999996 });
    const p = await newInvoice(companyId, 'P-R');
    await prisma.invoiceLine.createMany({
      data: data.map((l) => ({
        ...l,
        invoiceId: p.id,
        surcharges: l.surcharges as Prisma.InputJsonValue,
        breakdown: l.breakdown as Prisma.InputJsonValue,
        pricing: (l.pricing ?? Prisma.DbNull) as Prisma.InputJsonValue,
      })),
    });
    const q = await newInvoice(companyId, 'S-R');
    await prisma.$transaction((tx) => insertInvoiceLines(tx, q.id, data));
    const a = await prisma.invoiceLine.findMany({ where: { invoiceId: p.id }, orderBy: { rowIndex: 'asc' } });
    const b = await prisma.invoiceLine.findMany({ where: { invoiceId: q.id }, orderBy: { rowIndex: 'asc' } });
    expect(b).toHaveLength(data.length);
    expect(b.map(pick)).toEqual(a.map(pick));
    expect(String(b.at(-1)!.netAmount)).toBe('270.18');
    expect(String(b.at(-1)!.dimL)).toBe('31.8');
    // 01-B7: içe aktarmanın karşılaştırmadan önce uyguladığı yuvarlama, veritabanının yazdığıyla birebir aynı
    const want = (v: number | null, scale: number) => (v == null ? null : storedNumber(v, scale));
    expect(b.map((r) => [num(r.netAmount), num(r.baseAmount), num(r.actualKg), num(r.dimL)])).toEqual(
      data.map((l) => [want(l.netAmount, LINE_SCALE.amount), want(l.baseAmount, LINE_SCALE.amount), want(l.actualKg, LINE_SCALE.kg), want(l.dimL, LINE_SCALE.cm)]),
    );
  });

  it('zaman damgaları oturum saat diliminden bağımsız (UTC dışı veritabanı)', async () => {
    const inv = await newInvoice(companyId, 'S-TZ');
    const before = Date.now();
    await prisma.$transaction(async (tx) => {
      // sunucu/veritabanı TimeZone ayarı UTC değilse (ör. ALTER DATABASE … SET timezone) now() yerel saati yazar
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Asia/Tokyo'`);
      await insertInvoiceLines(tx, inv.id, lines(companyId).slice(0, 2));
    });
    const rows = await prisma.invoiceLine.findMany({ where: { invoiceId: inv.id } });
    for (const r of rows) {
      for (const t of [r.createdAt, r.updatedAt]) {
        expect(Math.abs(t.getTime() - before)).toBeLessThan(60_000);
      }
      // gün alanı kaymaz
      if (r.shipDate) expect(r.shipDate.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    }
  });

  it('güncelleme: Prisma update ile aynı; yönetici notu korunur', async () => {
    const data = lines(companyId);
    const p = await newInvoice(companyId, 'P-2');
    const s = await newInvoice(companyId, 'S-2');
    for (const inv of [p, s]) await prisma.$transaction((tx) => insertInvoiceLines(tx, inv.id, data));
    await prisma.invoiceLine.updateMany({ where: { invoiceId: { in: [p.id, s.id] }, rowIndex: 1 }, data: { note: 'yönetici', noteManual: true } });

    const result = (i: number) => ({
      measurementId: null,
      tariffId: null,
      tariffRevisionId: null,
      status: (['DIFF', 'MATCH', 'NO_TARIFF', 'UNMATCHED'] as const)[i % 4]!,
      diffTypes: (i % 2 ? [] : ['PRICE', 'WEIGHT']) as DiffType[],
      ourChargeableKg: i % 3 ? 3.0005 : null,
      billedChargeableKg: 1.0004,
      expectedAmount: i === 0 ? null : 97.725, // Prisma 97.72 (16 basamak), en kısa biçim 97.73
      diffAmount: i % 2 ? -2.675 : null,
      breakdown: [{ label: `Taban ${i}`, amount: i * 1.5 }],
      pricing: i % 2 ? null : ({ basis: 'TARIFF', rateDeviationPct: 1.5, confidence: 'HIGH', confidenceReason: null, zone: null, rateKg: null, mode: null, adjustmentPct: 0 } as const),
      note: i % 2 ? null : `yeni ${i}`,
    });
    const rowsP = await prisma.invoiceLine.findMany({ where: { invoiceId: p.id }, orderBy: { rowIndex: 'asc' } });
    await prisma.$transaction(async (tx) => {
      for (const r of rowsP) {
        const res = result(r.rowIndex);
        const d: Prisma.InvoiceLineUncheckedUpdateInput = { ...res, pricing: res.pricing ?? Prisma.DbNull };
        if (r.noteManual) delete d.note;
        await tx.invoiceLine.update({ where: { id: r.id }, data: d });
      }
    });
    const rowsS = await prisma.invoiceLine.findMany({ where: { invoiceId: s.id }, orderBy: { rowIndex: 'asc' } });
    const before = Date.now();
    await writeLineResults(rowsS.map((r) => ({ id: r.id, keepNote: r.noteManual, ...result(r.rowIndex) })));

    const a = await prisma.invoiceLine.findMany({ where: { invoiceId: p.id }, orderBy: { rowIndex: 'asc' } });
    const b = await prisma.invoiceLine.findMany({ where: { invoiceId: s.id }, orderBy: { rowIndex: 'asc' } });
    expect(b.map(pick)).toEqual(a.map(pick));
    expect(b[1]!.note).toBe('yönetici');
    for (const r of b) expect(Math.abs(r.updatedAt.getTime() - before)).toBeLessThan(60_000);
  });

  it('güncelleme: sürüm, önceki sonuç ve bekleyen işaret Prisma update ile aynı', async () => {
    const data = lines(companyId);
    const p = await newInvoice(companyId, 'P-3');
    const s = await newInvoice(companyId, 'S-3');
    for (const inv of [p, s]) await prisma.$transaction((tx) => insertInvoiceLines(tx, inv.id, data));
    const tariff = await prisma.tariff.findFirstOrThrow({ where: { companyId } });
    const revision = await prisma.tariffRevision.create({
      data: { companyId, tariffId: tariff.id, tariffName: tariff.name, snapshot: {}, currency: tariff.currency },
    });
    const oldPrev: PrevResult = { status: 'MATCH', diffTypes: [], expectedAmount: 1, diffAmount: 0, ourChargeableKg: 1, measurementId: null, tariffRevisionId: null, at: '2026-11-01T00:00:00.000Z', cause: 'OTHER' };
    // başlangıç: her satırda bekleyen işaret; çift satırlarda eski bir "önceki sonuç"
    const pendingAt = new Date('2026-11-02T10:00:00.000Z');
    await prisma.invoiceLine.updateMany({ where: { invoiceId: { in: [p.id, s.id] } }, data: { recalcPending: 'MEASUREMENT', recalcPendingAt: pendingAt } });
    await prisma.invoiceLine.updateMany({ where: { invoiceId: { in: [p.id, s.id] }, rowIndex: { in: [0, 2, 4, 6] } }, data: { prevResult: oldPrev } });

    const prev = (i: number): PrevResult => ({ status: 'DIFF', diffTypes: ['WEIGHT', 'PRICE'], expectedAmount: 97.72, diffAmount: i + 0.5, ourChargeableKg: 3.5, measurementId: null, tariffRevisionId: revision.id, at: '2026-11-10T12:00:00.000Z', cause: 'MEASUREMENT' });
    const result = (i: number) => ({
      measurementId: null,
      tariffId: tariff.id,
      tariffRevisionId: i === 3 ? null : revision.id,
      status: 'DIFF' as const,
      diffTypes: ['PRICE'] as DiffType[],
      ourChargeableKg: 3,
      billedChargeableKg: 5,
      expectedAmount: 30 + i,
      diffAmount: 20,
      breakdown: [],
      pricing: null,
      note: null,
    });
    // satır 0-5 yazılır (0,1: yeni önceki sonuç; 2-5: verilmez, kayıtlı kalır); 6: işaret silinir; 7: işaret değişir
    const written = [0, 1, 2, 3, 4, 5];
    const rowsP = await prisma.invoiceLine.findMany({ where: { invoiceId: p.id }, orderBy: { rowIndex: 'asc' } });
    const markAt = new Date();
    await prisma.$transaction(async (tx) => {
      for (const r of rowsP) {
        if (written.includes(r.rowIndex)) {
          const res = result(r.rowIndex);
          await tx.invoiceLine.update({
            where: { id: r.id },
            data: { ...res, pricing: Prisma.DbNull, recalcPending: null, recalcPendingAt: null, ...(r.rowIndex < 2 ? { prevResult: prev(r.rowIndex) } : {}) },
          });
        } else if (r.rowIndex === 6) await tx.invoiceLine.update({ where: { id: r.id }, data: { recalcPending: null, recalcPendingAt: null } });
        else await tx.invoiceLine.update({ where: { id: r.id }, data: { recalcPending: 'DUPLICATE', recalcPendingAt: markAt } });
      }
    });
    const rowsS = await prisma.invoiceLine.findMany({ where: { invoiceId: s.id }, orderBy: { rowIndex: 'asc' } });
    const before = Date.now();
    await prisma.$transaction(async (tx) => {
      await writeLineResults(
        rowsS.filter((r) => written.includes(r.rowIndex)).map((r) => ({ id: r.id, keepNote: false, ...result(r.rowIndex), ...(r.rowIndex < 2 ? { prevResult: prev(r.rowIndex) } : {}) })),
        tx,
      );
      await writeRecalcPending([{ id: rowsS[6]!.id, cause: null }, { id: rowsS[7]!.id, cause: 'DUPLICATE' }], tx);
    });

    const a = await prisma.invoiceLine.findMany({ where: { invoiceId: p.id }, orderBy: { rowIndex: 'asc' } });
    const b = await prisma.invoiceLine.findMany({ where: { invoiceId: s.id }, orderBy: { rowIndex: 'asc' } });
    expect(b.map(pick)).toEqual(a.map(pick));
    expect(b[0]!.tariffRevisionId).toBe(revision.id);
    expect(b[3]!.tariffRevisionId).toBeNull();
    expect(b[0]!.prevResult).toEqual(prev(0));
    expect(b[2]!.prevResult).toEqual(oldPrev); // verilmedi: kayıtlı kaldı
    expect(b[3]!.prevResult).toBeNull();
    for (const r of b.slice(0, 7)) expect([r.recalcPending, r.recalcPendingAt]).toEqual([null, null]);
    expect(b[7]!.recalcPending).toBe('DUPLICATE');
    expect(Math.abs(b[7]!.recalcPendingAt!.getTime() - before)).toBeLessThan(60_000);
    // işaret yazımı sonuca dokunmaz, satırın değiştiği anı günceller
    expect(String(b[7]!.expectedAmount)).toBe(String(rowsS[7]!.expectedAmount));
    expect(b[7]!.updatedAt.getTime()).toBeGreaterThan(rowsS[7]!.updatedAt.getTime());
  });
});

describe('01-B7: içe aktarma sonucu = hemen ardından "Yeniden karşılaştır" sonucu (veritabanı hassasiyeti)', () => {
  type Auth = { authorization: string };
  type LineView = { id: string; status: string; diffTypes: string[]; diffAmount: number | null; expectedAmount: number | null; note: string | null; dims: unknown };

  baseIt('atStoredPrecision: kenar 0,1 cm yukarı; kg 3, tutar 2 ondalık (veritabanı kuralı); bölen tam sayı; zaten yuvarlak satır aynen', () => {
    const l = { rowIndex: 0, trackingNo: 'T1', netAmount: 270.17499999999995, baseAmount: 1.005, actualKg: 1.0054999999999998, billedKg: 0.45359237, dims: { l: 33.02, w: 31.749999999999996, h: 25.4 }, billedDivisor: 5000.5, surcharges: [{ code: 'X', amount: 1.234 }], rawHash: 'h' };
    expect(atStoredPrecision(l)).toEqual({ ...l, netAmount: 270.18, baseAmount: 1.01, actualKg: 1.006, billedKg: 0.454, dims: { l: 33.1, w: 31.8, h: 25.4 }, billedDivisor: 5001 });
    const round = { rowIndex: 1, trackingNo: 'T2', netAmount: 10.5, dims: { l: 40, w: 30.5, h: 25 }, surcharges: [], rawHash: 'h' };
    expect(atStoredPrecision(round)).toEqual(round);
    // kayan nokta gürültüsü kenarı yukarı itmez (40.00000000000001 → 40)
    expect(atStoredPrecision({ ...round, dims: { l: 40.00000000000001, w: 33.019999999999996, h: 25.400000000000002 } }).dims).toEqual({ l: 40, w: 33.1, h: 25.4 });
  });

  baseIt('storedEdge, "kenar yukarı tam cm" (CEIL_CM) sonucunu hiçbir kenarda değiştirmez; saklanan kenar gerçek kenardan en çok 0,1 cm büyük, hiç küçük değil', () => {
    // 0,01–1000 cm arası her 2 ondalıklı değer, aynı değerin inç → cm karşılığı (ham ve parse.ts gibi 2 ondalık) ve 3 ondalıklı değerler
    let checked = 0;
    const bad: number[] = [];
    for (let i = 1; i <= 100_000; i++) {
      for (const v of [i / 100, (i / 100) * 2.54, Math.round((i / 100) * 2.54 * 100) / 100, i / 1000]) {
        const s = storedEdge(v);
        checked++;
        if (roundEdges({ l: s, w: 1, h: 1 }, 'CEIL_CM').l !== roundEdges({ l: v, w: 1, h: 1 }, 'CEIL_CM').l || s < v - 1e-9 || s - v > 0.1 + 1e-9) bad.push(v);
      }
    }
    expect(checked).toBe(400_000);
    expect(bad.slice(0, 5)).toEqual([]);
    // yarım-yukarı (veritabanının kendi kuralı) aynı denemede binlerce kenarı bir tam cm aşağı indirirdi (13 in = 33,02 → 33,0 → 33)
    expect(roundEdges({ l: storedNumber(33.02, LINE_SCALE.cm), w: 1, h: 1 }, 'CEIL_CM').l).toBe(33);
    expect(roundEdges({ l: storedEdge(33.02), w: 1, h: 1 }, 'CEIL_CM').l).toBe(34);
  });

  baseIt('13×13×10 inç satır (33,02 cm): içe aktarma saklanan 33,1 ile karşılaştırır (kenar yukarı 34, uyumlu); yeniden karşılaştırma aynı sonucu verir', async () => {
    const app = await getApp();
    const admin = await registerCompany(app);
    const auth: Auth = admin.auth;
    const carrier = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: auth, payload: { code: 'fedex', name: 'FedEx inç' } });
    expect(carrier.statusCode, carrier.body).toBe(201);
    const carrierId = carrier.json().carrier.id as string;
    const tariff = await app.inject({
      method: 'POST',
      url: '/api/deciship/tariffs',
      headers: auth,
      payload: {
        carrierId,
        name: 'Kenar yukarı',
        currency: 'TRY',
        divisor: 3000,
        edgeRounding: 'CEIL_CM',
        weightSteps: [{ upto: null, step: 1 }],
        discountPct: 0,
        fuelPct: 0,
        fuelVariable: false,
        active: true,
        isDefault: true,
        zones: [{ country: '*', zone: 'A' }],
        rates: Array.from({ length: 30 }, (_, i) => ({ zone: 'A', weightUpto: i + 1, price: (i + 1) * 10 })),
        overflow: [],
        surcharges: [],
      },
    });
    expect(tariff.statusCode, tariff.body).toBe(201);
    // bizim ölçümümüz 33×33×26 cm, 3 kg → 33·33·26/3000 = 9,4 → 10 kg = 100 TL
    const p = measurementPayload({ trackingRaw: uniq('7948'), lengthCm: 33, widthCm: 33, heightCm: 26, weightKg: 3 });
    const m = await app.inject({ method: 'POST', url: '/api/deciship/measurements', headers: { ...auth, ...p.headers }, payload: p.payload });
    expect(m.statusCode, m.body).toBe(201);
    const tracking = m.json().measurement.trackingNo as string;

    // faturada 13×13×10 inç (33,02×33,02×25,4 cm; kenar yukarı 34 cm → 11 kg = 110 TL)
    const csv = ['Takip No;Tarih;Uzunluk;Genislik;Yukseklik;Agirlik;Tutar', `${tracking};15.10.2026;13;13;10;3;110`].join('\n');
    const form = multipart([
      { name: 'carrierId', value: carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(csv) },
    ]);
    const pv = await app.inject({ method: 'POST', url: '/api/deciship/invoices/preview', headers: { ...auth, ...form.headers }, payload: form.payload });
    expect(pv.statusCode, pv.body).toBe(200);
    const mapping = {
      trackingNo: 'Takip No',
      netAmount: 'Tutar',
      shipDate: 'Tarih',
      actualKg: 'Agirlik',
      dimL: 'Uzunluk',
      dimW: 'Genislik',
      dimH: 'Yukseklik',
      defaultDimUnit: 'in',
      surchargeColumns: [],
      chargePairs: [],
      amountsIncludeVat: false,
      vatPct: 20,
      desiAsWeight: false,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/deciship/invoices',
      headers: auth,
      payload: { fileId: pv.json().fileId, carrierId, invoiceNo: uniq('IN-'), invoiceDate: '2026-10-15', currency: 'TRY', mapping, acknowledgeIssues: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().invoice.id as string;
    const lineOf = async () => {
      const l = await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}/lines`, headers: auth });
      expect(l.statusCode, l.body).toBe(200);
      const x = (l.json().items as LineView[])[0]!;
      return { status: x.status, diffTypes: x.diffTypes, diffAmount: x.diffAmount, expectedAmount: x.expectedAmount, note: x.note };
    };
    const totalsOf = async () => (await app.inject({ method: 'GET', url: `/api/deciship/invoices/${id}`, headers: auth })).json().invoice.totals;
    const imported = await lineOf();
    const importedTotals = await totalsOf();
    const row = await inCompany(auth, () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id }, select: { dimL: true, dimW: true, dimH: true } }));
    expect([row.dimL, row.dimW, row.dimH].map(String)).toEqual(['33.1', '33.1', '25.4']);
    // eskiden içe aktarma 33,02 ile "uyumlu", yeniden karşılaştırma saklanan 33,0 ile "fiyat farkı 10 TL" diyordu
    expect(imported).toMatchObject({ status: 'MATCH', diffTypes: [], expectedAmount: 110 });

    const rc = await app.inject({ method: 'POST', url: `/api/deciship/invoices/${id}/recompare`, headers: auth });
    expect(rc.statusCode, rc.body).toBe(200);
    expect(await lineOf()).toEqual(imported);
    expect(await totalsOf()).toEqual(importedTotals);
  });
});
