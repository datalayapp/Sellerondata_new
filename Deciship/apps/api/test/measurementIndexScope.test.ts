/**
 * Y81 (04-B13 c): ölçüm dizini her faturada firmanın bütün ölçümlerini değil, yalnız satırların takip no'larının
 * anahtarlarına dokunan ölçümleri yükler. Para etkili: aynı satırlar, tam dizin (eski yol) ve kapsamlı dizin (yeni yol)
 * ile birebir aynı ölçüme ve birebir aynı karşılaştırma sonucuna varmalı. Eşleşme yolları (core `tracking.ts`,
 * `MeasurementIndex.find`): normalize tam eşitlik ve FedEx 34 haneli barkod adayları (düzey 1), en az 10 karakterlik sonek
 * (düzey 2), kırpılmış ham değer (düzey 3); eşitlikte en yeni ölçüm.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { cleanTracking, normalizeTracking, type ParsedInvoiceLine } from '@deciship/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { buildContext, compareAll, MeasurementIndex, SCOPE_SQL_SEPARATORS, SCOPE_SQL_WS } from '../src/services/compare.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany } from './helpers.ts';

// Kaynakta görünmez karakter yazılmaz (depo denetimi K2): kod noktasıyla kurulur.
const NBSP = String.fromCharCode(0xa0);
const HYPHEN = String.fromCharCode(0x2010);
const EM_DASH = String.fromCharCode(0x2014);
const C_CEDILLA = String.fromCharCode(0xe7); // küçük ç
const C_CEDILLA_UP = String.fromCharCode(0xc7); // büyük Ç

/** 96 ile başlayan 34 haneli FedEx barkodu: son 12 hane takip no'su. */
const FEDEX = `96${'12345678901234567890'}${'123456789012'}`;

describe('ölçüm dizini kapsamı (Y81)', () => {
  let app: FastifyInstance;
  let f: Fixture;
  const ids: Record<string, string> = {};

  /** Doğrudan ölçüm satırı. `no` verilmezse bugünkü yazım kuralı (normalizeTracking); verilirse eski kayıt taklidi. */
  async function mk(name: string, raw: string, o: { no?: string; at?: string; deleted?: boolean; supersededBy?: string } = {}) {
    const row = await inCompany(f.companyId, () =>
      prisma.measurement.create({
        data: {
          companyId: f.companyId,
          clientId: crypto.randomUUID(),
          trackingRaw: raw,
          trackingNo: o.no ?? normalizeTracking(raw),
          lengthCm: 30,
          widthCm: 20,
          heightCm: 15,
          weightKg: 2,
          dimMethod: 'MANUAL',
          weightMethod: 'MANUAL',
          measuredById: f.admin.userId,
          measuredAt: new Date(o.at ?? '2026-10-10T10:00:00.000Z'),
          ...(o.deleted ? { deletedAt: new Date() } : {}),
          ...(o.supersededBy ? { supersededById: o.supersededBy } : {}),
        },
        select: { id: true },
      }),
    );
    ids[name] = row.id;
    return row.id;
  }

  const LINES = [
    'TST1234567890',
    ' tst 1234-567890 ',
    'xy123',
    '123456789012',
    FEDEX,
    FEDEX.slice(-15),
    '12345678901',
    '5555512345',
    'LEG0001112223',
    '--',
    EM_DASH,
    `${C_CEDILLA_UP}KR 1234567890`,
    'ud9876543210',
    'NB1231231231',
    'SUP1112223334',
    'DEL4445556667',
    'NOMATCH000001',
    'TST1234567890',
  ];
  const parsed = (): ParsedInvoiceLine[] =>
    LINES.map((t, i) => ({ rowIndex: i, trackingNo: t, billedKg: 3, destCountry: 'TR', netAmount: 30, currency: 'TRY', surcharges: [], rawHash: `y81-${i}` }));

  beforeAll(async () => {
    app = await getApp();
    f = await companyFixture(app);
    await mk('A', 'TST1234567890');
    await mk('A_noise', 'ZZZ1234567890'); // son 10 karakteri A ile aynı: havuza girer, seçilmez
    await mk('B', 'XY123');
    await mk('C', FEDEX);
    await mk('D', 'AB0012345678901');
    await mk('E_old', 'AA5555512345', { at: '2026-10-01T10:00:00.000Z' });
    await mk('F_new', 'BB5555512345', { at: '2026-10-05T10:00:00.000Z' });
    await mk('G_legacy', 'LEG 0001112223', { no: 'leg0001112223' });
    await mk('H_raw', '--', { no: '--' });
    await mk('I_raw', EM_DASH, { no: EM_DASH });
    await mk('J', `${C_CEDILLA}kr1234567890`);
    await mk('K', `UD${HYPHEN}9876543210`);
    await mk('L', `NB${NBSP}1231231231`);
    const sup = await mk('S_new', 'SUP1112223334');
    await mk('S_old', 'SUP1112223334', { supersededBy: sup, at: '2026-10-20T10:00:00.000Z' });
    await mk('DEL', 'DEL4445556667', { deleted: true });
    for (let i = 0; i < 30; i++) await mk(`noise${i}`, `NOISE${String(i).padStart(8, '0')}`);
  });

  it('SQL sabitleri core kuralının ASCII karşılığı (0-127 arası her karakter)', () => {
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c);
      expect(cleanTracking(ch) === '', `cleanTracking ${c}`).toBe(SCOPE_SQL_SEPARATORS.includes(ch));
      expect(ch.trim() === '', `trim ${c}`).toBe(SCOPE_SQL_WS.includes(ch));
      const up = ch >= 'a' && ch <= 'z' ? String.fromCharCode(c - 32) : ch;
      expect(ch.toLocaleUpperCase('en-US'), `upper ${c}`).toBe(up);
    }
  });

  it('kapsamlı dizin her satırda tam dizinle aynı ölçümü bulur, firmanın bütün ölçümlerini yüklemez', async () => {
    const { full, scoped } = await inCompany(f.companyId, async () => ({
      full: await MeasurementIndex.load(f.companyId),
      scoped: await MeasurementIndex.load(f.companyId, LINES),
    }));
    for (const t of LINES) expect(scoped.find(t)?.id ?? null, JSON.stringify(t)).toBe(full.find(t)?.id ?? null);

    // test boş geçmesin: beklenen eşleşmeler
    const found = (t: string) => full.find(t)?.id ?? null;
    expect(found(' tst 1234-567890 ')).toBe(ids.A);
    expect(found('xy123')).toBe(ids.B);
    expect(found('123456789012')).toBe(ids.C);
    expect(found(FEDEX.slice(-15))).toBe(ids.C);
    expect(found('12345678901')).toBe(ids.D);
    expect(found('5555512345')).toBe(ids.F_new);
    expect(found('LEG0001112223')).toBe(ids.G_legacy);
    expect(found('--')).toBe(ids.H_raw);
    expect(found(EM_DASH)).toBe(ids.I_raw);
    expect(found(`${C_CEDILLA_UP}KR 1234567890`)).toBe(ids.J);
    expect(found('ud9876543210')).toBe(ids.K);
    expect(found('NB1231231231')).toBe(ids.L);
    expect(found('SUP1112223334')).toBe(ids.S_new);
    expect(found('DEL4445556667')).toBeNull();
    expect(found('NOMATCH000001')).toBeNull();

    // gürültü yüklenmez; ASCII dışı ölçümler (I, J, K, L) her zaman yüklenir
    expect(full.size).toBeGreaterThan(scoped.size + 29);
    expect(scoped.size).toBeLessThanOrEqual(15);
    // kapsam dışı takip no sessizce "eşleşmedi" demez
    expect(() => scoped.find('NOISE00000001')).toThrow();
  });

  it('aynı fatura satırları iki yolla birebir aynı karşılaştırma sonucunu verir', async () => {
    const lines = parsed();
    const invoiceDate = new Date('2026-10-15T00:00:00.000Z');
    const { a, b } = await inCompany(f.companyId, async () => {
      const ctx = await buildContext(
        f.companyId,
        f.carrierId,
        lines.map((l) => normalizeTracking(l.trackingNo)),
        null,
        f.tariffId,
        false,
        undefined,
        lines.map((l) => l.trackingNo),
      );
      const fullCtx = { ...ctx, index: await MeasurementIndex.load(f.companyId) };
      return { a: compareAll(lines, fullCtx, invoiceDate), b: compareAll(lines, ctx, invoiceDate) };
    });
    expect(b).toEqual(a);
    expect(a.filter((r) => r.measurementId).length).toBeGreaterThanOrEqual(14);
  });

  it('içe aktarma ham takip no ile dizin kurar (normalize edilmiş listeyle kurulan dizin ham satırı reddeder)', async () => {
    const raw = ' tst 1234-567890 ';
    const scoped = await inCompany(f.companyId, () => MeasurementIndex.load(f.companyId, [normalizeTracking(raw)]));
    expect(() => scoped.find(raw)).toThrow();
  });
});
