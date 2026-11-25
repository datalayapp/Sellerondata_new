import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { getApp, multipart, registerCompany, uniq } from './helpers.ts';
import { viaJob } from './jobHelpers.ts';

/**
 * Yurt içi mesafe sütunlu PDF listesi, Excel "Aşım" satırının birimi ve şablonun aşım etiketi (gece ekibi A5;
 * uydurma sayılar, yapay zekâ yok). pdf-lib'in standart yazı tipi Türkçe harf basamadığı için başlıklar ASCII
 * ("Sehir Ici", "Yakin") — okuyucu her iki yazımı da tanır.
 */

type Auth = { authorization: string };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let app: FastifyInstance;
let auth: Auth;

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
const postJob = (url: string, payload: unknown) => viaJob(app, { method: 'POST', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const upload = (url: string, filename: string, data: Buffer, fields: { name: string; value: string }[] = []) => {
  const contentType = filename.endsWith('.pdf') ? 'application/pdf' : XLSX_MIME;
  const form = multipart([...fields, { name: 'file', filename, contentType, data }]);
  return app.inject({ method: 'POST', url, headers: { ...auth, ...form.headers }, payload: form.payload });
};
const codes = (checks: { code: string; severity: string }[], sev: string) => checks.filter((c) => c.severity === sev).map((c) => c.code);

async function carrier(code: string) {
  const r = await post('/api/deciship/carriers', { code, name: uniq(code) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().carrier.id as string;
}

/** "Desi | Sehir Ici | Yakin | Orta | Uzak", Dosya satırı, 1…30 desi, "Her ilave desi". */
async function distancePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  let y = 800;
  const line = (cells: [number, string][]) => {
    for (const [x, t] of cells) p.drawText(t, { x, y, size: 8, font });
    y -= 12;
  };
  line([[60, 'ORNEK KARGO 2026 YURT ICI LISTE FIYATLARI (TL, KDV HARIC)']]);
  line([[60, 'Desi'], [170, 'Sehir Ici'], [240, 'Yakin'], [300, 'Orta'], [360, 'Uzak']]);
  line([[60, 'Dosya'], [175, '60,00'], [245, '70,00'], [305, '75,00'], [365, '80,00']]);
  const rows: [string, string[]][] = [
    ['1', ['90,00', '100,00', '110,00', '120,00']],
    ['2', ['95,00', '106,00', '117,00', '128,00']],
    ['5', ['110,00', '124,00', '138,00', '152,00']],
    ['30', ['260,00', '300,00', '340,00', '380,00']],
    ['Her ilave desi', ['8,00', '9,00', '10,00', '11,00']],
  ];
  for (const [w, v] of rows) line([[60, w], [175, v[0]!], [245, v[1]!], [305, v[2]!], [365, v[3]!]]);
  return Buffer.from(await doc.save());
}

async function sheetRows(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return (wb.getWorksheet('Fiyatlar')!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => r.slice(1));
}

beforeAll(async () => {
  app = await getApp();
  auth = (await registerCompany(app, 'A5 Mesafe')).auth;
});

describe('Yurt içi mesafe sütunlu PDF', () => {
  it('kodla okunur: bölgeler SEHIRICI/YAKIN/ORTA/UZAK, otomatik eşleme yok, uyarı + not eşlemeyi söyler', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const mng = await carrier('mng');
    const up = await upload('/api/deciship/tariff-imports', 'mesafe.pdf', await distancePdf(), [{ name: 'carrierId', value: mng }]);
    expect(up.statusCode, up.body).toBe(200);
    const docId = up.json().documentId;
    const sc = (await post(`/api/deciship/tariff-documents/${docId}/scan`, { mode: 'code' })).json();
    // "Dosya" satırı artık atılmaz: koli bölümünden sonra zarf bölümü olur
    expect(sc.sections.map((s: { packaging: string }) => s.packaging)).toEqual([expect.not.stringMatching(/^(pak|envelope)$/), 'envelope']);
    expect(sc.sections[0]).toMatchObject({ zones: ['SEHIRICI', 'YAKIN', 'ORTA', 'UZAK'], direction: 'domestic', weightMin: 1, weightMax: 30, hasAdditionalStep: true });
    expect(sc.document).toMatchObject({ dimDivisor: 3000 });

    const ex = await postJob(`/api/deciship/tariff-documents/${docId}/extract`, { sectionIds: [sc.sections[0].id], includeCountryZones: true, target: { newTariff: { name: null, service: null } } });
    expect(ex.statusCode, ex.body).toBe(200);
    const d = ex.json();
    expect(d.zones).toEqual([]); // ülke/il → mesafe eşlemesi otomatik yapılmaz
    expect(d.overflow).toEqual([
      { zone: 'SEHIRICI', perUnit: 8 },
      { zone: 'YAKIN', perUnit: 9 },
      { zone: 'ORTA', perUnit: 10 },
      { zone: 'UZAK', perUnit: 11 },
    ]);
    expect(d.verification).toMatchObject({ method: 'code', unmatched: [] });
    expect(codes(d.checks, 'error')).toEqual([]);
    expect(codes(d.checks, 'warning')).toEqual(['DISTANCE_ZONES']);
    const notes = d.checks.find((c: { code: string }) => c.code === 'PDF_NOTES').detail as string;
    expect(notes).toContain('mesafe bölgelerini fatura satırlarıyla eşlemek için bölge eşlemesini kontrol edin');
    expect(d.headline.status).toBe('warning');
  });
});

describe('Excel "Aşım" satırının birimi ve şablon etiketi', () => {
  it('0,5 kg basamaklı tarifede "Aşım" (birimsiz) uyarı verir; "Aşım (kg başı)" ile 4 kg = 2 kg + 2 × aşım', async () => {
    const carrierId = await carrier('ptt');
    const r = await post('/api/deciship/tariffs', {
      carrierId,
      name: 'Yarim kg',
      currency: 'TRY',
      divisor: 3000,
      weightSteps: [{ upto: null, step: 0.5 }],
      zones: [{ country: '*', zone: 'TR' }],
      rates: [{ zone: 'TR', weightUpto: 0.5, price: 40 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().tariff.id as string;
    const file = async (label: string) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Fiyatlar');
      for (const row of [['Ağırlık (kg)', 'TR', 'İndirim %'], [0.5, 50, 0], [1, 55], [1.5, 60], [2, 65], [label, 20]]) ws.addRow(row);
      return Buffer.from(await wb.xlsx.writeBuffer());
    };

    const bare = (await upload(`/api/deciship/tariffs/${id}/import`, 'a.xlsx', await file('Aşım'))).json();
    expect(codes(bare.checks, 'warning')).toContain('OVERFLOW_UNIT_MISSING');

    const pv = (await upload(`/api/deciship/tariffs/${id}/import`, 'b.xlsx', await file('Aşım (kg başı)'))).json();
    expect(codes(pv.checks, 'warning')).not.toContain('OVERFLOW_UNIT_MISSING');
    const ap = await post(`/api/deciship/tariff-imports/${pv.draftId}/apply`, { options: {} });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json().tariff.weightSteps).toEqual([
      { upto: 2, step: 0.5 },
      { upto: null, step: 1 },
    ]);
    const q = await post(`/api/deciship/tariffs/${id}/quote`, { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: 4, destCountry: 'TR' });
    expect(q.json()).toMatchObject({ ok: true, base: 65 + 2 * 20 }); // önceden 65 + 4 × 20

    // şablon: üstte tek basamak (1 kg) → "Aşım (kg başı)"; geri yüklemede uyarı yok, basamaklar aynı kalır
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${id}`);
    expect((await sheetRows(tpl.rawPayload)).at(-1)).toEqual(['Aşım (kg başı)', 20]);
    const again = (await upload(`/api/deciship/tariffs/${id}/import`, 'c.xlsx', tpl.rawPayload)).json();
    expect(again.checks.filter((c: { severity: string }) => c.severity !== 'info')).toEqual([]);
  });

  it('şablon: üstte 0,5 kg basamak → "Aşım (her ilave 0,5 kg)"', async () => {
    const carrierId = await carrier('aras');
    const r = await post('/api/deciship/tariffs', {
      carrierId,
      name: 'Hep yarim',
      currency: 'TRY',
      divisor: 3000,
      weightSteps: [{ upto: null, step: 0.5 }],
      zones: [{ country: '*', zone: 'TR' }],
      rates: [
        { zone: 'TR', weightUpto: 0.5, price: 40 },
        { zone: 'TR', weightUpto: 1, price: 45 },
      ],
      overflow: [{ zone: 'TR', perUnit: 4 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const tpl = await get(`/api/deciship/tariffs/template.xlsx?tariffId=${r.json().tariff.id}`);
    expect((await sheetRows(tpl.rawPayload)).at(-1)).toEqual(['Aşım (her ilave 0,5 kg)', 4]);
  });
});
