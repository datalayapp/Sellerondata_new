// Denetim 10-B7: PDF fatura adımında kg ve ölçü para gibi okunmaz (ölçüm formu ve mobil ile aynı `parseMeasure`). Dolu ama
// okunamayan sayı hücresi (kg, kenar) ya da eksik kenar varken içe aktarma kapalıdır; ölçü sessizce düşmez.
// K36 (kullanıcı kararı 2026-11-14): Türkçe arayüzde "1.500" kg 1,5 kg da 1500 kg da olabilir: hücre kırmızı, içe aktarma
// kapalı, tablonun üstünde bir kez sorulur; seçim bütün belirsiz ağırlık hücrelerine uygulanır.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';

// `@deciship/core` kök dosyası uzantısız içe aktarma yapar (Vite çözer, düz Node çözmez): format-golden testindeki kanca.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && e.code === 'ERR_MODULE_NOT_FOUND') { for (const x of ['.ts', '/index.ts']) { try { return await n(s + x, c); } catch {} } } throw e; } }`,
    ),
);
const f = await import('../src/lib/format.ts');
const P = await import('../src/pages/invoice-upload/pdfRowParse.ts');

const SRC = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

type Row = Parameters<typeof P.fromPdfRow>[0];
const row = (over: Partial<Row> = {}): Row => ({
  key: 'k',
  rowIndex: 0,
  rawHash: 'h',
  trackingNo: 'TRK1',
  shipDate: '',
  destCountry: '',
  service: '',
  actualKg: '',
  billedKg: '',
  l: '',
  w: '',
  h: '',
  netAmount: '100',
  surcharges: [],
  extra: {},
  ...over,
});

describe('PDF satırı: kg ve ölçü okuma (10-B7)', () => {
  it('TR: "1.500" kg sorulur (K36): hücre kırmızı, satır durur; seçim okumayı belirler, tutar binlikli kalır', () => {
    f.setFormatLocale('tr');
    const r = row({ billedKg: '1.500', actualKg: '2,5', netAmount: '1.500' });
    assert.equal(P.pdfCellInvalid(r, 'billedKg'), true);
    assert.equal(P.pdfCellInvalid(r, 'actualKg'), false);
    assert.equal(P.pdfCellInvalid(r, 'netAmount'), false);
    assert.equal(P.pdfRowInvalid(r), true);
    assert.deepEqual(P.pdfCellWeightChoice(r, 'billedKg'), { decimal: 1.5, thousands: 1500 });
    assert.equal(P.pdfCellWeightChoice(r, 'netAmount'), null);
    const dec = P.applyPdfWeightChoice([r], 'en')[0]!;
    assert.equal(dec.billedKg, '1,5');
    assert.equal(P.pdfRowInvalid(dec), false);
    assert.equal(P.fromPdfRow(dec).billedKg, 1.5);
    assert.equal(P.fromPdfRow(dec).netAmount, 1500);
    const thou = P.applyPdfWeightChoice([r], 'tr')[0]!;
    assert.equal(thou.billedKg, '1500');
    assert.equal(P.fromPdfRow(thou).billedKg, 1500);
    assert.equal(P.fromPdfRow(thou).actualKg, 2.5);
  });

  it('TR: tek soru bütün tablo için; her hücre kendi okumasıyla yazılır', () => {
    f.setFormatLocale('tr');
    const rows = [row({ actualKg: '1.500', billedKg: '2.250' }), row({ billedKg: '12.000' }), row({ billedKg: '3' })];
    assert.deepEqual(P.pdfWeightAmbiguity(rows), { samples: [{ text: '1.500', readings: { decimal: 1.5, thousands: 1500 }, sep: '.' }], cells: 3 });
    const picked = P.applyPdfWeightChoice(rows, 'en');
    assert.deepEqual(
      picked.map((x) => [x.actualKg, x.billedKg]),
      [
        ['1,5', '2,25'],
        ['', '12'],
        ['', '3'],
      ],
    );
    assert.equal(P.pdfWeightAmbiguity(picked), null);
    assert.equal(picked[2], rows[2]);
  });

  it('sunucu PDF\'te "1.500" basılı buldu: yapay zekânın düz sayısı ("1,5") da sorulur; seçim bildirilir (TR ve EN)', () => {
    for (const loc of ['tr', 'en'] as const) {
      f.setFormatLocale(loc);
      const read = P.toPdfRow({ rowIndex: 7, rawHash: 'x', trackingNo: 'T', actualKg: 1.5, netAmount: 100, surcharges: [] } as never, 0);
      const [r] = P.withPdfWeightAsks([read], [{ rowIndex: 7, weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } } }]);
      assert.equal(P.pdfCellInvalid(r!, 'actualKg'), true, loc);
      assert.equal(P.pdfRowInvalid(r!), true, loc);
      assert.deepEqual(P.pdfWeightAmbiguity([r!]), { samples: [{ text: '1.500', readings: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' }, sep: '.' }], cells: 1 }, loc);
      assert.deepEqual(P.pdfWeightConfirmed([r!]), [], loc);
      // seçim (aynı değer olsa da) soruyu kapatır ve sunucuya bildirilir
      for (const [pick, kg] of [
        ['en', 1.5],
        ['tr', 1500],
      ] as const) {
        const [c] = P.applyPdfWeightChoice([r!], pick);
        assert.equal(P.pdfRowInvalid(c!), false, `${loc} ${pick}`);
        assert.equal(P.fromPdfRow(c!).actualKg, kg, `${loc} ${pick}`);
        assert.deepEqual(P.pdfWeightConfirmed([c!]), [7], `${loc} ${pick}`);
        assert.equal('weightAsk' in P.fromPdfRow(c!), false);
      }
      // hücreyi elle düzeltmek de soruyu kapatır
      const edited = { ...r!, actualKg: '2' };
      assert.equal(P.pdfRowInvalid(edited), false, loc);
      assert.deepEqual(P.pdfWeightConfirmed([edited]), [7], loc);
    }
  });

  it('belirsiz olmayan kg sorulmaz: "1,500", "1500", "1.5"; EN arayüzde "1.500" de', () => {
    f.setFormatLocale('tr');
    for (const kg of ['1,500', '1500', '1.5']) {
      assert.equal(P.pdfCellInvalid(row({ billedKg: kg }), 'billedKg'), false, kg);
      assert.equal(P.pdfWeightAmbiguity([row({ billedKg: kg })]), null, kg);
    }
    assert.equal(P.fromPdfRow(row({ billedKg: '1,500' })).billedKg, 1.5);
    assert.equal(P.fromPdfRow(row({ billedKg: '1500' })).billedKg, 1500);
    assert.equal(P.fromPdfRow(row({ billedKg: '1.5' })).billedKg, 1.5);
    f.setFormatLocale('en');
    assert.equal(P.pdfWeightAmbiguity([row({ billedKg: '1.500' })]), null);
    assert.equal(P.pdfRowInvalid(row({ billedKg: '1.500' })), false);
  });

  it('kenarlar binliksiz okunur; üçü de varsa ölçü kaydedilir', () => {
    f.setFormatLocale('tr');
    assert.deepEqual(P.fromPdfRow(row({ l: '40', w: '30,5', h: '1.250' })).dims, { l: 40, w: 30.5, h: 1.25 });
    f.setFormatLocale('en');
    assert.deepEqual(P.fromPdfRow(row({ l: '40', w: '30.5', h: '20' })).dims, { l: 40, w: 30.5, h: 20 });
    assert.equal(P.fromPdfRow(row({ billedKg: '1.5' })).billedKg, 1.5);
  });

  it('okunan değer ekrana yazılıp geri okununca aynı kalır (TR ve EN)', () => {
    for (const loc of ['tr', 'en'] as const) {
      f.setFormatLocale(loc);
      const back = P.fromPdfRow(
        P.toPdfRow({ rawHash: 'x', trackingNo: 'T', actualKg: 1234.567, billedKg: 1.5, dims: { l: 40.5, w: 30, h: 20 }, netAmount: 1234.5, surcharges: [] } as never, 0),
      );
      assert.equal(back.actualKg, 1234.567, loc);
      assert.equal(back.billedKg, 1.5, loc);
      assert.deepEqual(back.dims, { l: 40.5, w: 30, h: 20 }, loc);
      assert.equal(back.netAmount, 1234.5, loc);
    }
  });
});

describe('PDF satırı: içe aktarmayı durduran hücre (10-B7)', () => {
  it('geçerli satır ve boş ölçü/kg durdurmaz', () => {
    f.setFormatLocale('tr');
    assert.equal(P.pdfRowInvalid(row()), false);
    assert.equal(P.pdfRowInvalid(row({ billedKg: '1,5', l: '40', w: '30', h: '20' })), false);
  });

  it('okunamayan kenar kırmızıdır ve satırı durdurur ("40x")', () => {
    f.setFormatLocale('tr');
    const r = row({ l: '40x', w: '30', h: '20' });
    assert.equal(P.pdfCellInvalid(r, 'l'), true);
    assert.equal(P.pdfRowInvalid(r), true);
  });

  it('bir kenar boşken öteki kenarlar doluysa boş kenar kırmızıdır (ölçü sessizce düşmez)', () => {
    f.setFormatLocale('tr');
    const r = row({ l: '40', w: '', h: '20' });
    assert.equal(P.pdfCellInvalid(r, 'w'), true);
    assert.equal(P.pdfCellInvalid(r, 'l'), false);
    assert.equal(P.pdfRowInvalid(r), true);
  });

  it('sıfır ya da eksi kenar, okunamayan ya da eksi kg durdurur', () => {
    f.setFormatLocale('tr');
    assert.equal(P.pdfRowInvalid(row({ l: '0', w: '30', h: '20' })), true);
    assert.equal(P.pdfRowInvalid(row({ billedKg: 'abc' })), true);
    assert.equal(P.pdfRowInvalid(row({ actualKg: '-1' })), true);
    assert.equal(P.pdfRowInvalid(row({ billedKg: '0' })), false);
  });

  it('takip no boş ya da net tutar okunamıyorsa durdurur (eski kural)', () => {
    f.setFormatLocale('tr');
    assert.equal(P.pdfRowInvalid(row({ trackingNo: '  ' })), true);
    assert.equal(P.pdfRowInvalid(row({ netAmount: '' })), true);
    assert.equal(P.pdfRowInvalid(row({ netAmount: '12a' })), true);
  });

  it('sihirbaz "Devam"ı satır kuralıyla kapatır; tablo aynı kuralla kırmızı yakar', () => {
    const up = read('pages/InvoiceUpload.tsx');
    assert.match(up, /const pdfInvalid =[\s\S]{0,200}pdfRows\.some\(pdfRowInvalid\)/);
    const step = read('pages/invoice-upload/PdfStep.tsx');
    assert.match(step, /pdfCellInvalid\(r, c\.k\)/);
    // K36: tek soru tablonun üstünde, seçim hepsine
    assert.match(step, /applyPdfWeightChoice\(rows, fmt\)/);
    // K36 (inceleme): sunucunun PDF soruları satırlara eklenir, seçimler sunucuya bildirilir
    assert.match(up, /withPdfWeightAsks\(p\.aiLines\.map\(toPdfRow\), p\.pdfCheck\?\.rows \?\? \[\]\)/);
    assert.match(up, /pdfWeightConfirmed: pdfWeightConfirmed\(pdfRows\)/);
    assert.match(up, /e\.code === "PDF_WEIGHT_CHOICE_REQUIRED"/);
    // kg ve ölçü para okuyucusuyla okunmaz
    assert.doesNotMatch(step, /parseTrNumber\(\s*(r\.)?(l|w|h|actualKg|billedKg)\b/);
  });

  it('K36 (inceleme): tablo faturasında ağırlık seçimi yalnız ağırlık, dosya başına, onayla geçilmez', () => {
    const up = read('pages/InvoiceUpload.tsx');
    const map = read('pages/invoice-upload/MappingStep.tsx');
    // seçim `weightFormat`tır, dosyanın sayı biçimi (`numberFormat`, tutarlar) değil
    assert.match(map, /setMapping\(\{ \.\.\.mapping, weightFormat: fmt \}\)/);
    assert.doesNotMatch(map, /numberFormat: fmt/);
    // seçilmeden ilerlenmez, içe aktarılmaz; onay penceresi de geçirmez
    assert.match(up, /const weightUnchosen = preview\?\.format !== "pdf" && Boolean\(diag\?\.weightAmbiguity\) && !mapping\.weightFormat;/);
    assert.equal((up.match(/\|\| weightUnchosen/g) ?? []).length, 2);
    assert.match(up, /onConfirm=\{\(\) => \{\s*\/\/ K36[^\n]*\n\s*if \(weightUnchosen\)/);
    // seçim taşıyıcının kayıtlı eşlemesini kendiliğinden açmaz
    assert.doesNotMatch(up, /weightAmbiguity\) setSaveMapping\(true\)/);
    // dil değişince ekrandaki sayılar anlamını korur (PDF adımı ve tarife düzenleyici; taban da birlikte)
    assert.match(up, /setPdfRows\(\(rows\) => relocalizePdfRows\(rows, from, next\)\)/);
    const te = read('pages/TariffEditor.tsx');
    assert.match(te, /i18next\.on\('languageChanged', onLang\)/);
    assert.match(te, /setDraft\(\(d\) => \(d \? relocalizeDraft\(d, from, next\) : d\)\)/);
    assert.match(te, /setBaseline\(\(b\) => \(b \? JSON\.stringify\(relocalizeDraft\(/);
  });
});

// Bağımsız inceleme (10-B7): ölçüsüz satır kilitlenmez, EN arayüz, sunucu sınırları, KDV hariç etiketi (01-B9).
describe('PDF satırı: ölçüsüz satır, EN arayüz, sunucu sınırları', () => {
  it('ölçüsüz satır: üç kenar boşsa durdurmaz, dims gitmez; "0" yazılmış kenarı silmek kilidi açar', () => {
    f.setFormatLocale('tr');
    assert.equal(P.fromPdfRow(row()).dims, undefined);
    // sunucu sıfır kenarlı okumayı ölçüsüz gönderir (`dims` yok); ekranda üç boş hücre olur
    const zeroRead = P.toPdfRow({ rawHash: 'x', trackingNo: 'T', netAmount: 10, surcharges: [] } as never, 0);
    assert.deepEqual([zeroRead.l, zeroRead.w, zeroRead.h], ['', '', '']);
    assert.equal(P.pdfRowInvalid(zeroRead), false);
    assert.equal(P.pdfRowInvalid(row({ l: '0', w: '0', h: '0' })), true);
    assert.equal(P.pdfRowInvalid(row({ l: '', w: '', h: '' })), false);
  });

  it('EN arayüz: kg "1.500" 1,5 kg; kg "1,500" sorulur (kullanıcı kararı 2026-11-14); tutar "1,500" 1500 (para binlikli)', () => {
    f.setFormatLocale('en');
    const r = row({ billedKg: '1,500', actualKg: '1.500', netAmount: '1,500' });
    assert.equal(P.fromPdfRow(r).actualKg, 1.5);
    assert.equal(P.fromPdfRow(r).netAmount, 1500);
    assert.equal(P.pdfCellInvalid(r, 'actualKg'), false);
    assert.equal(P.pdfCellInvalid(r, 'billedKg'), true);
    assert.equal(P.pdfCellInvalid(r, 'netAmount'), false);
    assert.deepEqual(P.pdfWeightAmbiguity([r]), { samples: [{ text: '1,500', readings: { decimal: 1.5, thousands: 1500 }, sep: ',' }], cells: 1 });
    assert.deepEqual(
      P.applyPdfWeightChoice([r], 'en').map((x) => [x.billedKg, P.fromPdfRow(x).billedKg]),
      [['1500', 1500]],
    );
    assert.deepEqual(
      P.applyPdfWeightChoice([r], 'tr').map((x) => [x.billedKg, P.fromPdfRow(x).billedKg]),
      [['1.5', 1.5]],
    );
    assert.equal(P.fromPdfRow(row({ netAmount: '1.500' })).netAmount, 1.5);
  });

  it('ölçüm okuyucusu her iki dilde dil almaz: "1,500" ve "1.500" 1,5 (koli ölçümünde soru yok)', () => {
    for (const loc of ['tr', 'en'] as const) {
      f.setFormatLocale(loc);
      assert.equal(f.parseMeasure('1,500'), 1.5, loc);
      assert.equal(f.parseMeasure('1.500'), 1.5, loc);
    }
  });

  it('dil değişince PDF hücreleri anlamını korur; seçilmemiş "1.500" soruyla "1,500" olur, sunucunun sorusu da geçer', () => {
    f.setFormatLocale('tr');
    const read = P.toPdfRow({ rowIndex: 3, rawHash: 'x', trackingNo: 'T', actualKg: 1.5, netAmount: 1500, dims: { l: 40.5, w: 30, h: 20 }, surcharges: [] } as never, 0);
    const [asked] = P.withPdfWeightAsks([read], [{ rowIndex: 3, weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: '.', text: '1.500' } } }]);
    const rows = [asked!, row({ billedKg: '1.500', netAmount: '1.500' }), row({ billedKg: '1,500' })];
    const en = P.relocalizePdfRows(rows, 'tr', 'en');
    assert.deepEqual(
      en.map((x) => [x.actualKg, x.billedKg, x.netAmount, x.l]),
      [
        ['1.5', '', '1500', '40.5'],
        ['', '1,500', '1500', ''],
        ['', '1.5', '100', ''],
      ],
    );
    f.setFormatLocale('en');
    // sunucunun sorusu hâlâ açık; Türkçede yazılıp sorulmamış "1,500" artık "1.5" (1,5 kg), sessizce 1500 olmadı
    assert.equal(P.pdfCellInvalid(en[0]!, 'actualKg'), true);
    assert.equal(P.pdfCellInvalid(en[1]!, 'billedKg'), true);
    assert.equal(P.fromPdfRow(en[2]!).billedKg, 1.5);
    assert.equal(P.pdfCellInvalid(en[2]!, 'billedKg'), false);
    // tutar anlamını korudu
    assert.equal(P.fromPdfRow(en[1]!).netAmount, 1500);
  });

  it('sunucu şemasını aşan hücre kırmızıdır (kg, kenar, tutar, takip no)', () => {
    f.setFormatLocale('tr');
    assert.equal(P.pdfCellInvalid(row({ billedKg: '9999999' }), 'billedKg'), false);
    assert.equal(P.pdfCellInvalid(row({ billedKg: '10000000' }), 'billedKg'), true);
    assert.equal(P.pdfRowInvalid(row({ l: '999999', w: '1', h: '1' })), false);
    assert.equal(P.pdfRowInvalid(row({ l: '1000000', w: '1', h: '1' })), true);
    assert.equal(P.pdfCellInvalid(row({ netAmount: '-999999999999' }), 'netAmount'), false);
    assert.equal(P.pdfCellInvalid(row({ netAmount: '1000000000000' }), 'netAmount'), true);
    assert.equal(P.pdfCellInvalid(row({ trackingNo: 'T'.repeat(200) }), 'trackingNo'), false);
    assert.equal(P.pdfCellInvalid(row({ trackingNo: 'T'.repeat(201) }), 'trackingNo'), true);
  });

  it('PDF adımı tutarların KDV hariç olduğunu söyler (TR ve EN; düzeltilen tutar KDV hariç kaydedilir)', () => {
    for (const [loc, word] of [['tr', 'KDV hariç'], ['en', 'excl. VAT']] as const) {
      const pdf = JSON.parse(fs.readFileSync(path.join(SRC, `locales/${loc}/invoiceUpload.json`), 'utf8')).pdf;
      assert.ok(pdf.editHint.includes(word), `${loc} editHint`);
      assert.ok(pdf.total_one.includes(word) && pdf.total_other.includes(word), `${loc} total`);
    }
  });
});

describe('01-B8: PDF adımının toplamı para birimine göre ayrı', () => {
  it('tek para birimi: tek toplam; satırda para birimi yoksa faturanınki', () => {
    f.setFormatLocale('tr');
    const rows = [row({ netAmount: '100' }), row({ netAmount: '50,50', extra: { currency: 'USD' } })];
    assert.deepEqual(P.pdfTotalsByCurrency(rows, 'usd'), [{ currency: 'USD', total: 150.5, count: 2 }]);
  });

  it('USD fatura, 2 EUR satır: önce faturanın parası, farklı paralar toplanmaz', () => {
    f.setFormatLocale('tr');
    const rows = [
      row({ netAmount: '100', extra: { currency: 'USD' } }),
      row({ netAmount: '10', extra: { currency: 'EUR' } }),
      row({ netAmount: '5,25', extra: { currency: 'EUR' } }),
      row({ netAmount: '1', extra: { currency: 'CHF' } }),
    ];
    assert.deepEqual(P.pdfTotalsByCurrency(rows, 'USD'), [
      { currency: 'USD', total: 100, count: 1 },
      { currency: 'CHF', total: 1, count: 1 },
      { currency: 'EUR', total: 15.25, count: 2 },
    ]);
    assert.equal(P.pdfRowCurrency(row({ extra: { currency: ' eur ' } }), 'USD'), 'EUR');
  });

  it('uyarı ve kapı metinleri TR ve EN sözlükte', () => {
    for (const loc of ['tr', 'en'] as const) {
      const j = JSON.parse(read(`locales/${loc}/invoiceUpload.json`)) as { pdf: Record<string, string>; gate: Record<string, string> };
      assert.ok(j.pdf.currencyMixed_one && j.pdf.currencyMixed_other, `${loc} currencyMixed`);
      assert.ok(j.gate.pdfTitle && j.gate.pdfIntro, `${loc} gate.pdf*`);
      assert.ok(j.pdf.weightAmbiguous && j.pdf.cellWeightAmbiguous, `${loc} pdf.weightAmbiguous`);
    }
  });
});

// İnceleme: seçim yazım biçimidir; "1.500" ve "1,500" birlikte geçince her hücre kendi ayırıcısıyla okunur.
describe('K36: PDF adımında iki yazım birlikte', () => {
  it('soru iki örneği gösterir; Türkçe yazım "1.500"=1500 / "1,500"=1,5, İngilizce tersi', () => {
    f.setFormatLocale('tr');
    const read = P.toPdfRow({ rowIndex: 1, rawHash: 'x', trackingNo: 'T', actualKg: 1.5, netAmount: 10, surcharges: [] } as never, 0);
    const [server] = P.withPdfWeightAsks([read], [{ rowIndex: 1, weightAmbiguity: { actualKg: { decimal: 1.5, thousands: 1500, sep: ',', text: '1,500' } } }]);
    const typed = row({ rowIndex: 2, billedKg: '1.500' });
    const amb = P.pdfWeightAmbiguity([server!, typed])!;
    assert.deepEqual(
      amb.samples.map((s) => [s.text, s.sep]),
      [
        ['1,500', ','],
        ['1.500', '.'],
      ],
    );
    const tr = P.applyPdfWeightChoice([server!, typed], 'tr');
    assert.deepEqual([P.fromPdfRow(tr[0]!).actualKg, P.fromPdfRow(tr[1]!).billedKg], [1.5, 1500]);
    const en = P.applyPdfWeightChoice([server!, typed], 'en');
    assert.deepEqual([P.fromPdfRow(en[0]!).actualKg, P.fromPdfRow(en[1]!).billedKg], [1500, 1.5]);
    assert.deepEqual(P.pdfWeightConfirmed(en), [1]);
  });
});

// İnceleme: dil değişince formlardaki yazılı sayılar anlamını korur (Türkçe "6.000" bölen İngilizcede 6 olmasın).
describe('K36: dil değişince form sayıları', async () => {
  const L = await import('../src/lib/localeSwitch.ts');
  it('sayı ve ölçü alanları çevrilir; öbür alanlara dokunulmaz', () => {
    const form = { divisor: '6.000', fuelPct: '12,5', discountPct: '', edgeTolCm: '0,5', name: 'A 1.500' };
    assert.deepEqual(L.relocalizeFields(form, ['divisor', 'fuelPct', 'discountPct'], ['edgeTolCm'], 'tr', 'en'), {
      divisor: '6000',
      fuelPct: '12.5',
      discountPct: '',
      edgeTolCm: '0.5',
      name: 'A 1.500',
    });
    assert.deepEqual(L.relocalizeFields({ divisor: '6,000' }, ['divisor'], [], 'en', 'tr'), { divisor: '6000' });
    // geri dönüş anlamı korur
    f.setFormatLocale('en');
    assert.equal(f.parseTrNumber(L.relocalizeFields({ d: '6.000' }, ['d'], [], 'tr', 'en').d), 6000);
  });

  it('dil dinleyicisi yazılı sayı tutan bütün formlarda', () => {
    const uses: [string, RegExp][] = [
      ['pages/TariffImport.tsx', /useLocaleSwitch\(\(from, to\) => setForm\(\(f\) => relocalizeFields\(f, \['discountPct', 'fuelPct', 'divisor'\]/],
      ['pages/Settings.tsx', /relocalizeFields\(x, \['amountTol', 'desiDivisor', 'fxTolerancePct'\], \['edgeTolCm', 'weightTolKg'\]/],
      ['pages/onboarding/SetupSteps.tsx', /relocalizeFields\(x, \['amountTol', 'fxTolerancePct'\], \['edgeTolCm', 'weightTolKg'\]/],
      ['pages/invoice-detail/DisputeDialogs.tsx', /useLocaleSwitch\(\(from, to\) => setAmounts\(/],
      ['pages/invoice-upload/MappingStep.tsx', /useLocaleSwitch\(\(from, to\) => setVatText\(/],
    ];
    for (const [file, re] of uses) assert.match(read(file), re, file);
  });
});
