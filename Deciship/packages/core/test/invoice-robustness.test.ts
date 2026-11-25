/**
 * Fatura okumanın gerçek dünyadaki dosya çeşitliliğine dayanıklılığı (ayırıcı, kodlama, sayı/tarih biçimi,
 * çok sayfalı / birleştirilmiş başlıklı XLSX, boş/eksik/mükerrer içerik, büyük dosya).
 * Fikstürler: test/fixtures/robustness (uydurma veri; üretici build.ts / generate.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  detectFormat,
  InvoiceFileError,
  mappingDiagnostics,
  parseDateAs,
  parseNumberAs,
  parseRows,
  parseTrDate,
  parseTrNumber,
  readTable,
  splitSepHint,
  suggestMapping,
  unsupportedFileError,
  type CarrierCode,
  type ColumnMapping,
  type ParsedInvoiceLine,
  type Table,
} from '../src/index';
import { bigCsv, bigXlsx, encodeCp, excelSerial, FIXTURE_DIR, FIXTURES, ROWS, SAMPLES_DIR, TR_HEADERS, TR_NAMES } from './fixtures/robustness/build';
import { measureBigFile } from './bigInvoiceFiles';

const bytesOf = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURE_DIR, name)));
const read = (name: string) => readTable(name, bytesOf(name));
const sampleJson = JSON.parse(readFileSync(resolve(SAMPLES_DIR, '../expected.json'), 'utf8')) as {
  invoices: { file: string; suggestedMapping: Partial<ColumnMapping>; totals: { billedTotal: number; lines: number } }[];
};
const expectedFor = (file: string) => sampleJson.invoices.find((i) => i.file.endsWith(file))!;

function parse(t: Table, carrier: CarrierCode = 'generic') {
  const s = suggestMapping(t.headers, carrier, t.rows);
  const p = parseRows(t, s.mapping);
  return { ...p, mapping: s.mapping, missing: s.missing };
}

async function rejects(p: Promise<unknown>): Promise<InvoiceFileError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceFileError);
    return e as InvoiceFileError;
  }
  throw new Error('hata bekleniyordu');
}

/** ROWS ile aynı 5 satır okunmalı (takip no, net, tarih; istenirse kg ve ölçü). */
function expectCanonical(lines: ParsedInvoiceLine[], opts: { kg?: boolean; dims?: boolean; dates?: boolean } = {}) {
  expect(lines.map((l) => l.trackingNo)).toEqual(ROWS.map((r) => r.tracking));
  expect(lines.map((l) => l.netAmount)).toEqual(ROWS.map((r) => r.net));
  if (opts.dates !== false) expect(lines.map((l) => l.shipDate)).toEqual(ROWS.map((r) => r.date));
  if (opts.kg) {
    expect(lines.map((l) => l.actualKg)).toEqual(ROWS.map((r) => r.actualKg));
    expect(lines.map((l) => l.billedKg)).toEqual(ROWS.map((r) => r.billedKg));
  }
  if (opts.dims) expect(lines.map((l) => l.dims && [l.dims.l, l.dims.w, l.dims.h])).toEqual(ROWS.map((r) => r.dims));
}

describe('fikstürler güncel', () => {
  it('diskteki metin fikstürleri üreticiyle bayt bayt aynı', async () => {
    for (const f of FIXTURES.filter((x) => !x.name.endsWith('.xlsx'))) {
      expect(Buffer.from(bytesOf(f.name)).equals(Buffer.from(await f.bytes())), f.name).toBe(true);
    }
  });
});

describe('CSV ayırıcıları ve tırnaklı alanlar', () => {
  it('FedEx Billing Online tarzı: virgül, her değer tırnaklı, adreste virgül + satır sonu, "" kaçışı, YYYYMMDD, etiket/tutar çiftleri', async () => {
    const t = await read('sep-comma-quoted-fedex-fbo.csv');
    expect(t.headers).toHaveLength(26);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[0]![t.headers.indexOf('Recipient Company')]).toBe('Atelier "Lumière", Paris');
    expect(t.rows[0]![t.headers.indexOf('Recipient Address Line 1')]).toBe('Örnek Sokak 1,\nKat 2');
    const { lines, errors, mapping } = parse(t, 'fedex');
    expect(errors).toEqual([]);
    expect(mapping.trackingNo).toBe('Express or Ground Tracking ID');
    expect(mapping.netAmount).toBe('Net Charge Amount');
    expect(mapping.chargePairs).toHaveLength(2);
    expectCanonical(lines, { kg: true, dims: true });
    expect(lines[3]!.discountAmount).toBe(ROWS[3]!.discount);
    expect(lines[3]!.fuelAmount).toBe(ROWS[3]!.fuel);
    const d = mappingDiagnostics(t, mapping, { divisor: 5000 });
    expect(d.numberFormat).toBe('en');
    expect(d.verification.verdict).toBe('ok');
  });

  it('noktalı virgül + Excel "sep=;" ipucu satırı atlanır', async () => {
    expect(splitSepHint('sep=;\r\na;b')).toEqual({ text: 'a;b', delimiter: ';' });
    expect(splitSepHint('a;b')).toEqual({ text: 'a;b', delimiter: null });
    const t = await read('sep-semicolon-sep-hint.csv');
    expect(t.headers).toEqual(TR_HEADERS);
    expectCanonical(parse(t).lines, { kg: true, dims: true });
  });

  it('sekme ayırıcı: UTF-8 ve Excel "Unicode Metin" (UTF-16LE)', async () => {
    for (const name of ['sep-tab-utf8.csv', 'sep-tab-utf16le.txt']) {
      expect(detectFormat(name, bytesOf(name)), name).toBe('csv');
      const t = await read(name);
      expect(t.headers, name).toEqual(TR_HEADERS);
      expect(t.rows.map((r) => r[2]), name).toEqual(TR_NAMES);
      expectCanonical(parse(t).lines, { kg: true, dims: true });
    }
  });
});

describe('kodlamalar', () => {
  it('UTF-8 BOM\'lu, BOM\'suz ve Windows-1254 aynı tabloyu verir (ş ğ ı İ)', async () => {
    const tables = await Promise.all(['enc-utf8-bom.csv', 'enc-utf8-nobom.csv', 'enc-cp1254-turkish.csv'].map(read));
    for (const t of tables) {
      expect(t.headers).toEqual(TR_HEADERS);
      expect(t.rows.map((r) => r[2])).toEqual(TR_NAMES);
      expectCanonical(parse(t).lines, { kg: true, dims: true });
    }
    expect(decodeText(encodeCp('ŞşĞğİıÇçÖöÜü', '1254'))).toBe('ŞşĞğİıÇçÖöÜü');
  });

  it('Windows-1252 (Almanca, € = 0x80) bozulmadan çözülür', async () => {
    const t = await read('enc-cp1252-german.csv');
    expect(t.headers).toEqual(['Sendungsnummer', 'Versanddatum', 'Empfängerland', 'Gewicht (kg)', 'Größe', 'Betrag (€)', 'Währung']);
    expect(t.rows[0]![5]).toBe('€ 1.184,00');
    const m: ColumnMapping = { ...suggestMapping(t.headers, 'generic').mapping, trackingNo: 'Sendungsnummer', netAmount: 'Betrag (€)', shipDate: 'Versanddatum', currency: 'Währung' };
    const p = parseRows(t, m);
    expect(p.errors).toEqual([]);
    expectCanonical(p.lines);
    expect(p.lines.every((l) => l.currency === 'EUR')).toBe(true);
  });

  it('Windows-1254 MNG faturası (tutarlar "TL" ekli) özgün UTF-8 örnekle aynı satırları verir', async () => {
    const orig = await readTable('mng.csv', new Uint8Array(readFileSync(resolve(SAMPLES_DIR, 'mng-MNG-2026-77120.csv'))));
    const t = await read('enc-cp1254-mng.csv');
    expect(t.headers).toEqual(orig.headers);
    expect(t.rows[0]![2]).toBe('Zeynep Şahin');
    const m = { ...suggestMapping(t.headers, 'mng', t.rows).mapping, ...expectedFor('mng-MNG-2026-77120.csv').suggestedMapping } as ColumnMapping;
    const a = parseRows(orig, m).lines.map(({ rawHash: _h, ...l }) => l);
    const b = parseRows(t, m).lines.map(({ rawHash: _h, ...l }) => l);
    expect(b).toEqual(a);
    expect(b).toHaveLength(expectedFor('mng-MNG-2026-77120.csv').totals.lines);
  });
});

describe('ondalık / binlik ve para simgeleri', () => {
  it('tek tek değerler', () => {
    const tr: [string, number][] = [
      ['1.234,56', 1234.56], ['₺1.234,56', 1234.56], ['1.234,56 TL', 1234.56], ['1.234,56 ₺', 1234.56], ['TRY 1.234,56', 1234.56],
      ['-₺12,00', -12], ['₺-12,00', -12], ['(80,00)', -80], ['45,00-', -45], ['€ 1.234,56', 1234.56], ['1 234,56 €', 1234.56],
      ['CHF 1.234,56', 1234.56], ['1.234.567,89', 1234567.89],
    ];
    for (const [v, n] of tr) expect(parseNumberAs(v, 'tr'), v).toBe(n);
    const en: [string, number][] = [
      ['1,234.56', 1234.56], ['$1,234.56', 1234.56], ['1,234.56 USD', 1234.56], ['USD 1,234.56', 1234.56], ['(12.00)', -12], ['2.500', 2.5], ['1,010', 1010],
    ];
    for (const [v, n] of en) expect(parseNumberAs(v, 'en'), v).toBe(n);
    expect(parseTrNumber('12 LBS')).toBeNull(); // ağırlık birimi ayrı sütundan okunur; tutar değildir
  });

  it('TR dosyası: "₺1.234,56", "1.234,56 TL", "TRY …" ve negatif iade', async () => {
    const p = parse(await read('num-money-symbols-tr.csv'));
    expect(p.errors).toEqual([]);
    expect(p.lines.map((l) => l.netAmount)).toEqual([...ROWS.map((r) => r.net), -12]);
  });

  it('EN dosyası: "$1,234.56", "USD …", "(12.00)"', async () => {
    const p = parse(await read('num-money-symbols-en.csv'));
    expect(p.errors).toEqual([]);
    expect(p.lines.map((l) => l.netAmount)).toEqual([...ROWS.map((r) => r.net), -12]);
  });
});

describe('tarih biçimleri', () => {
  it('05.11.2026, 2026-11-05, 11/05/2026, Excel seri tarihi, 20261105', async () => {
    for (const name of ['date-dmy.csv', 'date-iso.csv', 'date-mdy.csv', 'date-excel-serial.csv', 'date-yyyymmdd.csv']) {
      const p = parse(await read(name));
      expect(p.errors, name).toEqual([]);
      expect(p.lines.map((l) => l.shipDate), name).toEqual(ROWS.map((r) => r.date));
    }
    expect(excelSerial('2026-11-05')).toBe(46331);
    expect(parseTrDate('46331')).toBe('2026-11-05');
    expect(parseTrDate(46331)).toBe('2026-11-05');
    expect(parseDateAs('11/05/2026', 'mdy')).toBe('2026-11-05');
    expect(parseDateAs('05/11/2026', 'dmy')).toBe('2026-11-05');
    expect(parseTrDate('5.11.2026 14:30')).toBe('2026-11-05');
    expect(parseTrDate('2026-11-05 00:00:00')).toBe('2026-11-05');
  });
});

describe('XLSX', () => {
  it('çok sayfalı: önde "Özet" sayfası olsa da gönderi sayfası okunur (birleşik başlık, bilgi satırları, alt toplam)', async () => {
    const t = await read('xlsx-multi-sheet.xlsx');
    const exp = expectedFor('fedex-9-482-11735.csv');
    expect(t.headers[2]).toBe('Tracking ID');
    const { lines, errors, mapping, missing } = parse(t, 'fedex');
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
    for (const k of ['trackingNo', 'netAmount', 'billedKg', 'actualKg', 'dimL'] as const) expect(mapping[k], k).toBe(exp.suggestedMapping[k]);
    expect(lines).toHaveLength(exp.totals.lines); // TOPLAM satırı atlanır
    expect(Math.round(lines.reduce((a, l) => a + l.netAmount, 0) * 100) / 100).toBe(exp.totals.billedTotal);
  });

  it('iki katlı birleştirilmiş başlık ve üstte logo/başlık satırları', async () => {
    const t = await read('xlsx-merged-header.xlsx');
    expect(t.headers).toEqual(['Gönderi No', 'Tarih', 'Ağırlık / Gerçek', 'Ağırlık / Ücretli', 'Ölçü (cm) / En', 'Ölçü (cm) / Boy', 'Ölçü (cm) / Yükseklik', 'Desi', 'Tutar']);
    const { lines, errors, mapping } = parse(t);
    expect(errors).toEqual([]);
    expect(mapping).toMatchObject({ trackingNo: 'Gönderi No', netAmount: 'Tutar', actualKg: 'Ağırlık / Gerçek', dimL: 'Ölçü (cm) / En', dimW: 'Ölçü (cm) / Boy', dimH: 'Ölçü (cm) / Yükseklik' });
    expect(mapping.dims).toBeUndefined();
    expectCanonical(lines, { dims: true });
    expect(mappingDiagnostics(t, mapping, { divisor: 3000 }).verification.verdict).toBe('ok');
  });

  it('sayısal seri tarihler, metin TR tutarlar, sayı olarak takip no', async () => {
    expectCanonical(parse(await read('xlsx-serial-dates.xlsx')).lines);
  });

  it('gizli sayfa, görünür sayfa varken seçilmez; tek sayfadaki ön satırlar başlık sanılmaz', async () => {
    const wb = new ExcelJS.Workbook();
    const hidden = wb.addWorksheet('Ham');
    hidden.state = 'hidden';
    hidden.addRow(['Takip No', 'Tarih', 'Tutar', 'Not']);
    for (let i = 0; i < 10; i++) hidden.addRow([`99990000000${i}`, '01.11.2026', 10, 'eski']);
    const ws = wb.addWorksheet('Fatura');
    ws.addRow(['ÖRNEK KARGO']);
    ws.addRow(['Takip No', 'Tarih', 'Tutar', 'Not']);
    ws.addRow(['794800000011', '05.11.2026', 1184, 'yeni']);
    const t = await readTable('a.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(t.headers).toEqual(['Takip No', 'Tarih', 'Tutar', 'Not']);
    expect(t.rows).toEqual([['794800000011', '05.11.2026', '1184', 'yeni']]);
  });
});

describe('içerik sorunları ve Türkçe hata mesajları', () => {
  it('boş dosya, yalnız boş satırlar, boş XLSX → "Dosya boş"', async () => {
    expect(detectFormat('content-empty.csv', new Uint8Array(0))).toBe('unknown');
    expect(unsupportedFileError('content-empty.csv', new Uint8Array(0)).code).toBe('EMPTY_FILE');
    for (const name of ['content-empty.csv', 'content-blank-lines.csv', 'xlsx-empty.xlsx']) {
      const e = await rejects(read(name));
      expect(e.code, name).toBe('EMPTY_FILE');
      expect(e.message).toMatch(/^Dosya boş\./);
    }
  });

  it('yalnız başlık satırı (CSV ve XLSX) → "fatura satırı yok"', async () => {
    for (const name of ['content-header-only.csv', 'xlsx-header-only.xlsx']) {
      const e = await rejects(read(name));
      expect(e.code, name).toBe('NO_ROWS');
      expect(e.message).toContain('fatura satırı yok');
    }
  });

  it('eski .xls, HTML\'den .xls, bozuk .xlsx: ne yapılacağını söyler', async () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    expect(detectFormat('fatura.xls', ole)).toBe('unknown');
    expect(unsupportedFileError('fatura.xls', ole).code).toBe('OLD_EXCEL');
    const html = new TextEncoder().encode('<html><body><table><tr><td>Takip No</td></tr></table></body></html>');
    const e = unsupportedFileError('rapor.xls', html);
    expect(e.code).toBe('HTML_AS_EXCEL');
    expect(e.message).toContain('.xlsx');
    expect((await rejects(readTable('rapor.xls', html))).code).toBe('HTML_AS_EXCEL');
    const broken = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await rejects(readTable('bozuk.xlsx', broken))).code).toBe('XLSX_UNREADABLE');
    expect(unsupportedFileError('a.docx', new TextEncoder().encode('\u0001\u0002\u0003'.repeat(50))).code).toBe('UNSUPPORTED_FORMAT');
  });

  it('mükerrer takip no: satırlar okunur, yumuşak bayrak, okuma kontrolü "ok"', async () => {
    const t = await read('content-duplicate-tracking.csv');
    const { lines, mapping } = parse(t);
    expect(lines.map((l) => l.trackingNo)).toEqual(['794800000011', '794800000022', '794800000011']);
    expect(new Set(lines.map((l) => l.rawHash)).size).toBe(3); // referans farklı → içe aktarmada atlanmaz
    const v = mappingDiagnostics(t, mapping, { divisor: 5000 }).verification;
    expect(v.verdict).toBe('ok');
    expect(v.flagCounts.DUPLICATE_TRACKING).toBe(1); // ikinci görünüm
  });

  it('fatura no sütunu takip no seçilirse yine uyarılır (az farklı değer)', async () => {
    const t: Table = { headers: ['Fatura No', 'Takip No', 'Tutar'], rows: Array.from({ length: 6 }, (_, i) => ['9-482-11735', `79480000001${i}`, '10,00']) };
    const v = mappingDiagnostics(t, { ...suggestMapping(t.headers, 'generic').mapping, trackingNo: 'Fatura No' }, { divisor: 5000 }).verification;
    expect(v.fields.trackingNo?.status).toBe('check');
  });

  it('zorunlu sütun eksik: öneride eksik görünür, okuma ne yapılacağını söyler', async () => {
    const t = await read('content-missing-amount.csv');
    const { lines, errors, missing } = parse(t);
    expect(missing).toEqual(['netAmount']);
    expect(lines).toEqual([]);
    expect(errors[0]!.message).toBe('Net tutar sütunu seçilmedi: gönderi başına ödenen tutarın bulunduğu sütunu seçin.');
  });

  it('negatif tutar / iade satırları: "-125,00", "(80,00)", "45,00-"; TOPLAM satırı atlanır', async () => {
    const t = await read('content-refunds.csv');
    const { lines, errors, mapping } = parse(t);
    expect(errors).toEqual([]);
    expect(lines.map((l) => l.netAmount)).toEqual([210.5, 1250, -125, -80, -45]);
    expect(mappingDiagnostics(t, mapping, { divisor: 3000 }).verification.verdict).toBe('ok');
  });

  it('farklı para birimleri tek dosyada', async () => {
    const t = await read('content-multi-currency.csv');
    const { lines, errors, mapping } = parse(t, 'dhl');
    expect(errors).toEqual([]);
    expect(mapping.netAmount).toBe('Total amount (excl. VAT)');
    expect(lines.map((l) => [l.currency, l.netAmount, l.shipDate])).toEqual([
      ['EUR', 84.3, '2026-11-05'],
      ['USD', 1120.75, '2026-11-05'],
      ['TRY', 1450, '2026-11-06'],
      ['GBP', 96.1, '2026-11-06'],
    ]);
  });

  it('Excel metin sarmalayıcısı ="0012…" ve boşluklu takip no', async () => {
    const t = await read('excel-text-wrapped.csv');
    const { lines, mapping } = parse(t);
    expect(lines.map((l) => l.trackingNo)).toEqual(['0012345678901', '0012345678902', '0012345678903']);
    expect(mappingDiagnostics(t, mapping, { divisor: 3000 }).verification.verdict).toBe('ok');
  });
});

describe('büyük dosyalar', () => {
  // Süre sınırı kapı dışında: invoice-robustness.perf.test.ts (`npm run test:perf`). Burada yalnız sonucun doğruluğu.
  it('5.000 satır CSV (başta FedEx 11735 satırları)', async () => {
    const { p, d } = await measureBigFile('big-5000.csv', bigCsv(5000, { prefixFedex11735: true }));
    expect(p.errors).toEqual([]);
    expect(p.lines).toHaveLength(5018);
    expect(d.verification.verdict).toBe('ok');
  });

  it('20.000 satır CSV', async () => {
    const { p } = await measureBigFile('big-20000.csv', bigCsv(20000));
    expect(p.lines).toHaveLength(20000);
  });

  it('20.000 satır XLSX', async () => {
    const { p } = await measureBigFile('big-20000.xlsx', await bigXlsx(20000));
    expect(p.lines).toHaveLength(20000);
    expect(p.lines[19999]!.shipDate).toBe('2026-10-08');
  }, 60_000);
});
