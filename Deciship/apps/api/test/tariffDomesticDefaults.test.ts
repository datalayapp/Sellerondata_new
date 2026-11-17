import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { DEFAULT_SETTINGS, LEGACY_EDGE_TOL_CM, readSettings } from '../src/lib/settings.ts';
import { readCompareSettings } from '../src/services/compare.ts';
import { getApp, inCompany, multipart, registerCompany, uniq } from './helpers.ts';

/**
 * KALANLAR Aşama 1, gerçek Türk tarifesi öncesi:
 * - 1.1 yeni tarife (elle, Excel) yurt içi taşıyıcıda 3000 bölen + sabit yakıtla; PTT ve "Diğer" adla; kayıtlı tarife değişmez.
 * - 1.2 bölge sayfası olmayan tek bölgeli tarifeye `*`.
 * - 1.7 "31+" satırı ilave desi başı (aşım fiyatı); "kg başı" seçilebilir.
 * - 1.10 yeni firmanın kenar toleransı 0,5 cm; kayıtlı değeri olmayan eski firma 1 cm.
 */

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const API = '/api/deciship';

let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `${API}${url}`, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url: `${API}${url}`, headers: auth });

async function carrier(code: string, name: string) {
  const r = await post('/carriers', { code, name: uniq(name) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

/** Tek fiyat sütunlu yurt içi desi listesi, Bölgeler sayfası yok; son satır "31+" (30 desi üstü her desi 8 TL). */
async function desiXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fiyatlar');
  ws.addRow(['Desi', 'Fiyat (TL)']);
  for (const [d, p] of [['1', '60,00'], ['10', '120,00'], ['20', '160,00'], ['30', '195,00'], ['31+', '8,00']]) ws.addRow([d, p]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function preview(carrierId: string) {
  const form = multipart([
    { name: 'carrierId', value: carrierId },
    { name: 'file', filename: 'desi.xlsx', contentType: XLSX_MIME, data: await desiXlsx() },
  ]);
  const r = await app.inject({ method: 'POST', url: `${API}/tariff-imports`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

const codes = (checks: { code: string; severity: string }[]) => checks.map((c) => `${c.severity}:${c.code}`);

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'Yurt İçi Varsayılan')).auth;
});

describe('1.1 + 1.2 + 1.7: yurt içi Excel tarifesi yeni tarife olarak', () => {
  it('PTT: önizleme 3000 bölen + sabit yakıt önerir; * kendiliğinden; 31+ ilave desi; uygulanan tarife 35 desi = 235', async () => {
    const ptt = await carrier('ptt', 'PTT Kargo');
    const p = await preview(ptt);
    expect(p.suggestedDefaults).toMatchObject({ divisor: 3000, fuelVariable: false });
    const c = codes(p.checks);
    expect(c).toEqual(expect.arrayContaining(['warning:OPEN_BAND_ADDITIONAL', 'info:ZONE_STAR_AUTO']));
    expect(c).not.toContain('warning:NO_COUNTRY_MAPPING');
    expect(p.overflow).toEqual([{ zone: 'Fiyat (TL)', perUnit: 8 }]);
    expect(p.summary.countryCount).toBe(1);
    expect(p.fixes.filter((f: { id: string }) => f.id === 'openBandMode').map((f: { value: string }) => f.value)).toEqual(['additional', 'perKg', 'flat']);

    const noAck = await post(`/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: false, meta: { name: 'PTT 2026' } });
    expect(noAck.statusCode, noAck.body).toBe(409);
    expect(noAck.json().error.details.warnings).toContain('OPEN_BAND_ADDITIONAL');
    const applied = await post(`/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: true, meta: { name: 'PTT 2026', divisor: 3000 } });
    expect(applied.statusCode, applied.body).toBe(200);
    const id = applied.json().tariff.id as string;
    const t = (await get(`/tariffs/${id}`)).json().tariff;
    expect(t).toMatchObject({ divisor: 3000, fuelVariable: false });
    expect(t.zones.map((z: { country: string; zone: string }) => [z.country, z.zone])).toEqual([['*', 'Fiyat (TL)']]);
    expect(t.overflow.map((o: { zone: string; perUnit: number }) => [o.zone, o.perUnit])).toEqual([['Fiyat (TL)', 8]]);
    // 50×42×50 cm = 35 desi (3000 bölen), 2 kg: 195 + 5 × 8
    const q = (await post(`/tariffs/${id}/quote`, { lengthCm: 50, widthCm: 42, heightCm: 50, weightKg: 2, destCountry: 'TR' })).json();
    expect(q).toMatchObject({ ok: true, chargeableKg: 35, base: 235 });
  });

  it('"Diğer" adla: Sürat yurt içi, TNT yurt dışı; sihirbazdaki yakıt seçimi kaydedilir', async () => {
    const surat = await carrier('generic', 'Sürat Kargo');
    expect((await preview(surat)).suggestedDefaults).toMatchObject({ divisor: 3000, fuelVariable: false });
    const tnt = await carrier('generic', 'TNT Express');
    const p = await preview(tnt);
    expect(p.suggestedDefaults).toMatchObject({ divisor: 5000, fuelVariable: true });
    // yurt dışı taşıyıcıda * kendiliğinden eklenmez (her ülke tek bölgeden fiyatlanırdı): eşleme uyarısı kalır
    expect(codes(p.checks)).toContain('warning:NO_COUNTRY_MAPPING');
    expect(codes(p.checks)).not.toContain('info:ZONE_STAR_AUTO');
    const r = await post(`/tariff-imports/${p.draftId}/apply`, { options: {}, acknowledged: true, meta: { name: 'TNT yurt içi', divisor: 3000, fuelVariable: false } });
    expect(r.statusCode, r.body).toBe(200);
    const saved = (await get(`/tariffs/${r.json().tariff.id}`)).json().tariff;
    expect(saved).toMatchObject({ divisor: 3000, fuelVariable: false });
    expect(saved.zones).toEqual([]);
  });

  it('"kg başı" seçilirse eski okuma (fiyat × toplam desi), uyarısız', async () => {
    const ptt = await carrier('ptt', 'PTT Kg');
    const p = await preview(ptt);
    const re = await post(`/tariff-imports/${p.draftId}/recheck`, { options: { openBandMode: 'perKg' } });
    expect(re.statusCode, re.body).toBe(200);
    const d = re.json();
    expect(codes(d.checks).filter((x) => x.includes('OPEN_BAND'))).toEqual([]);
    expect(d.overflow).toEqual([]);
    expect(d.rates.find((r: { weightUpto: number }) => r.weightUpto === 99999)).toMatchObject({ price: 8, perKg: true });
    const bad = await post(`/tariff-imports/${p.draftId}/recheck`, { options: { openBandMode: 'bogus' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('1.1 elle açılan tarife: gövde yakıtı söylemiyorsa taşıyıcının kapsamı', () => {
  const body = (carrierId: string) => ({
    carrierId,
    name: uniq('Elle'),
    currency: 'TRY',
    divisor: 3000,
    edgeRounding: 'CEIL_CM',
    weightSteps: [{ upto: null, step: 1 }],
    discountPct: 0,
    fuelPct: 0,
    isDefault: false,
    zones: [{ country: '*', zone: 'TR' }],
    rates: [{ zone: 'TR', weightUpto: 1, price: 60 }],
    overflow: [],
    surcharges: [],
  });

  it('PTT ve Sürat sabit, TNT ve UPS değişken; gövdedeki seçim geçerli', async () => {
    const cases: [string, string, boolean][] = [
      ['ptt', 'PTT', false],
      ['generic', 'Sürat Kargo', false],
      ['generic', 'TNT Express', true],
      ['ups', 'UPS', true],
      ['aras', 'Aras', false],
    ];
    for (const [code, name, fuelVariable] of cases) {
      const r = await post('/tariffs', body(await carrier(code, name)));
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().tariff.fuelVariable, name).toBe(fuelVariable);
    }
    const chosen = await post('/tariffs', { ...body(await carrier('ptt', 'PTT seçim')), fuelVariable: true });
    expect(chosen.json().tariff.fuelVariable).toBe(true);
  });
});

describe('1.10 kenar toleransı', () => {
  it('yeni firma 0,5 cm ile açılır (kayıtlı); kayıtlı değeri olmayan eski firma 1 cm kalır', async () => {
    expect(DEFAULT_SETTINGS.edgeTolCm).toBe(0.5);
    const fresh = await registerCompany(app, uniq('Yeni Firma'), { realDefaults: true });
    const s = await app.inject({ method: 'GET', url: `${API}/settings`, headers: fresh.auth });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().settings?.edgeTolCm ?? s.json().edgeTolCm).toBe(0.5);
    const stored = await inCompany(fresh.auth, () => prisma.company.findFirstOrThrow({ where: { id: fresh.companyId }, select: { settings: true } }));
    expect((stored.settings as { edgeTolCm?: number }).edgeTolCm).toBe(0.5);
    expect(LEGACY_EDGE_TOL_CM).toBe(1);
    expect(readSettings({}).edgeTolCm).toBe(1);
    expect(readSettings({ edgeTolCm: 'x' }).edgeTolCm).toBe(1);
    expect(readSettings({ edgeTolCm: 0 }).edgeTolCm).toBe(0);
    expect(readSettings({ edgeTolCm: 0.5 }).edgeTolCm).toBe(0.5);
    // donmuş faturanın eksik alanı da yazıldığı günün değeriyle (1 cm) dolar
    expect(readCompareSettings({ weightTolKg: 0.1 })!.edgeTolCm).toBe(1);
    expect(readCompareSettings({ edgeTolCm: 0.5 })!.edgeTolCm).toBe(0.5);
  });
});
