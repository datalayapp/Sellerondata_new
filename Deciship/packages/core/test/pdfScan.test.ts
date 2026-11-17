import { describe, expect, it } from 'vitest';
import {
  detectDimDivisor,
  detectFuel,
  detectValidFrom,
  scanPdfLayout,
  serviceMatchScore,
  suggestPdfSectionChoice,
  suggestPdfSections,
  type PdfPageLayout,
  type PdfTextItem,
} from '../src/index';

/** Kodla PDF taraması: sentetik konumlu metin (tüm sayılar uydurma). */

const H = 7;
/** Bir satır: [x, metin] çiftleri; genişlik karakter sayısından. */
const line = (y: number, cells: [number, string][]): PdfTextItem[] => cells.map(([x, str]) => ({ str, x, y, w: str.length * 3.6, h: H }));
const ZX = [200, 240, 280];
const row = (y: number, label: string, vals: string[]) => line(y, [[150, label], ...vals.map((v, i) => [ZX[i]! + 4, v] as [number, string])]);

function pricePage(opts: { service: string; region: string; dir: string; net: boolean }): PdfPageLayout {
  let y = 760;
  const items: PdfTextItem[] = [];
  const add = (its: PdfTextItem[]) => {
    items.push(...its);
    y -= 9;
  };
  add(line(y, [[140, `${opts.region} / ${opts.dir}`], [240, 'ÜCRETLERİ'], [360, "Türkiye'de 1 Mart 2026'dan itibaren geçerlidir."]]));
  add(line(y, [[140, 'Hızlı teslimat için:']]));
  add(line(y, [[140, opts.service]]));
  add(line(y, [[140, opts.net ? '- Net Ücretler' : '- Liste Fiyatı']]));
  add(line(y, [[140, 'Daha fazla bilgi için genel koşullara bakın.']]));
  add(line(y, [[145, 'AĞIRLIK (KG)'], [ZX[0]! - 8, 'A BÖLGESİ'], [ZX[1]! - 8, 'B BÖLGESİ'], [ZX[2]! - 6, 'ZONE C']]));
  add(line(y, ZX.map((x) => [x + 6, 'USD'] as [number, string])));
  add(line(y, [[140, 'Zarf/Pak (0,5 - 2,5kg) kullanıldığında ücretler']]));
  add(line(y, [[140, 'Envelope']]));
  add(row(y, '0.5', ['9.10', '9.90', '10.40']));
  add(line(y, [[140, 'Pak']]));
  add(row(y, '0.5', ['9.20', '9.95', '10.45']));
  add(line(y, [[140, 'Diğer ambalaj malzemeleri kullanıldığında ücretler (0,5 - 70,5kg)']]));
  add(row(y, '0.5', ['11.10', '15.30', '#REF!']));
  add(row(y, '1', ['12.40', '16.80', '#REF!']));
  add(row(y, '10.5', ['31.50', '27.20', '#REF!']));
  add(row(y, 'İlave 0,5kg', ['3.10', '3.40', '#REF!']));
  add(row(y, '21', ['96.60', '98.60', '#REF!']));
  add(line(y, [[140, 'Kg başına ücret (toplam gönderi ağırlığıyla çarpınız)']]));
  add(row(y, '71-99', ['5.20', '5.10', '#REF!']));
  add([...row(y, '1000 +', ['5.20', '5.10', '#REF!']), ...line(y, [[330, 'TR © Örnek Kargo A.Ş.']])]);
  y -= 10;
  add(line(y, [[140, `${opts.service.replace(/\s*\(\w+\)$/, '')} Freight (XF)`]]));
  add(line(y, [[145, 'AĞIRLIK (KG)'], [ZX[0]! - 8, 'A BÖLGESİ'], [ZX[1]! - 8, 'B BÖLGESİ'], [ZX[2]! - 6, 'ZONE C']]));
  add(line(y, ZX.map((x) => [x + 6, 'USD'] as [number, string])));
  add(line(y, [[140, 'Kg başına ücret (toplam gönderi ağırlığıyla çarpınız)']]));
  add(row(y, '68-70', ['5.00', '4.90', '6.00']));
  add(row(y, '1000 +', ['5.00', '4.90', '6.00']));
  add(line(y, [[140, 'Freight gönderileri için rezervasyon gerekir.']]));
  add(line(30, [[290, 'Page 2']]));
  return { items };
}

function discountPage(): PdfPageLayout {
  return {
    items: [
      ...line(700, [[70, 'İHRACAT İndirimi']]),
      ...line(680, [[100, 'Minimum Ağırlık'], [140, 'Maksimum Ağırlık']]),
      ...line(672, [[110, '(KG)'], [146, '(KG)'], [180, 'A'], [205, 'B'], [230, 'C']]),
      ...Array.from({ length: 6 }, (_, i) => line(660 - i * 9, [[70, 'XP'], [110, '0.50'], [146, '2.50'], [176, '41.00%'], [200, '41.50%'], [225, '42.00%']])).flat(),
    ],
  };
}

function countryPage(): PdfPageLayout {
  const items: PdfTextItem[] = [
    ...line(700, [[100, 'Örnek Kargo İhracat Bölgeleri']]),
    ...line(605, [[107, 'ÜLKE'], [144, 'BÖLGE'], [195, 'ÜLKE'], [231, 'BÖLGE']]),
    // sütun 1
    ...line(589, [[100, 'ALMANYA'], [150, 'A']]),
    ...line(580, [[100, 'AMERİKA']]),
    ...line(573, [[100, 'BİRLEŞİK'], [150, 'B']]),
    ...line(567, [[100, 'DEVLETLERİ']]),
    ...line(555, [[100, 'AMERİKAN']]),
    ...line(552, [[150, 'C']]),
    ...line(549, [[100, 'SAMOASI']]),
    ...line(540, [[100, 'İTALYA'], [150, 'A']]),
    ...line(531, [[100, 'ATLANTİS'], [150, 'B']]),
    // sütun 2
    ...line(589, [[190, 'KANADA'], [238, 'B']]),
    ...line(580, [[190, 'KONGO'], [238, 'C']]),
    ...line(573, [[190, 'KOSOVA - ISO']]),
    ...line(566, [[190, 'KODSUZ -'], [238, 'C']]),
    ...line(559, [[190, 'YALNIZCA TNT']]),
    ...line(550, [[190, 'FRANSA'], [238, 'A']]),
    ...line(18, [[200, 'Page 3']]),
  ];
  return { items };
}

const termsPage: PdfPageLayout = {
  items: [
    ...line(700, [[70, 'Genel Şartlar']]),
    ...line(690, [[70, '3. Tüm fiyatlar USD cinsinden verilmiştir (KDV hariçtir).']]),
    ...line(680, [[70, '5. Boyutsal Ağırlık oranı 1:5, DIM 5000 (cm) şeklindedir.']]),
    ...line(670, [[70, 'Yakıt tanımı']]),
    ...line(660, [[70, 'FIXED 7%']]),
  ],
};

describe('kodla PDF taraması', () => {
  const pages = [
    termsPage,
    pricePage({ service: 'Örnek International Priority® (XP)', region: 'DÜNYA GENELİ', dir: 'İHRACAT', net: true }),
    pricePage({ service: 'Örnek International Priority® Express (XPE)', region: 'DÜNYA GENELİ', dir: 'İHRACAT', net: true }),
    pricePage({ service: 'Örnek International Priority® (XP)', region: 'AVRUPA', dir: 'İHRACAT', net: false }),
    pricePage({ service: 'Örnek International Priority® (XP)', region: 'DÜNYA GENELİ', dir: 'İTHALAT', net: true }),
    discountPage(),
    countryPage(),
  ];
  const scan = scanPdfLayout(pages);

  it('belge bilgileri', () => {
    expect(scan.document).toMatchObject({
      validFrom: '2026-03-01',
      currency: 'USD',
      weightUnit: 'kg',
      dimDivisor: 5000,
      fuel: { kind: 'FIXED_PCT', pct: 7 },
      countryZonePages: [7],
      discountPages: [],
    });
    expect(scan.document.notes).toContain('Fiyatlara KDV dahil değil');
  });

  it('bölümler: zarf/pak alınmaz; kutu + ilave + kg başı; aynı sayfadaki freight ayrı bölüm; indirim tablosu yok', () => {
    expect(scan.sections.map((s) => [s.id, s.pages[0], s.service, s.packaging, s.priceType, s.direction])).toEqual([
      ['c1', 2, 'Örnek International Priority® (XP)', 'box', 'net', 'export'],
      ['c2', 2, 'Örnek International Priority® Freight (XF)', 'all', 'net', 'export'],
      ['c3', 3, 'Örnek International Priority® Express (XPE)', 'box', 'net', 'export'],
      ['c4', 3, 'Örnek International Priority® Express Freight (XF)', 'all', 'net', 'export'],
      ['c5', 4, 'Örnek International Priority® (XP)', 'box', 'list', 'export'],
      ['c6', 4, 'Örnek International Priority® Freight (XF)', 'all', 'list', 'export'],
      ['c7', 5, 'Örnek International Priority® (XP)', 'box', 'net', 'import'],
      ['c8', 5, 'Örnek International Priority® Freight (XF)', 'all', 'net', 'import'],
    ]);
    const s = scan.sections[0]!;
    expect(s).toMatchObject({ zones: ['A', 'B', 'C'], weightMin: 0.5, weightMax: 1000, currency: 'USD', hasAdditionalStep: true, hasPerKgBands: true });
    expect(s.title).toBe('XP ihracat · Dünya (A–C) · kutu 0,5–1.000 kg · net');
    expect(s.table.rows.map((r) => [r.kind, r.label, r.weight, r.from, r.step, r.cells.join(' ')])).toEqual([
      ['weight', '0.5', 0.5, null, null, '11.10 15.30 #REF!'],
      ['weight', '1', 1, null, null, '12.40 16.80 #REF!'],
      ['weight', '10.5', 10.5, null, null, '31.50 27.20 #REF!'],
      ['additional', 'İlave 0,5kg', null, null, 0.5, '3.10 3.40 #REF!'],
      ['weight', '21', 21, null, null, '96.60 98.60 #REF!'],
      ['perKg', '71-99', 99, 71, null, '5.20 5.10 #REF!'],
      ['perKg', '1000 +', null, 1000, null, '5.20 5.10 #REF!'],
    ]);
    expect(scan.sections[1]!.table.rows.map((r) => r.kind)).toEqual(['perKg', 'perKg']);
  });

  it('ülke listesi: çok satırlı adlar, bölge kodu iki satır arasında', () => {
    expect(scan.countries.map((c) => `${c.name}=${c.zone}`)).toEqual([
      'ALMANYA=A',
      'AMERİKA BİRLEŞİK DEVLETLERİ=B',
      'AMERİKAN SAMOASI=C',
      'İTALYA=A',
      'ATLANTİS=B',
      'KANADA=B',
      'KONGO=C',
      'KOSOVA - ISO KODSUZ - YALNIZCA TNT=C',
      'FRANSA=A',
    ]);
  });

  it('önerilen bölümler: fatura hizmeti tam eşleşen hizmet (Express değil), net + ihracat, tüm bölge grupları', () => {
    expect(serviceMatchScore('Örnek Intl Priority', { service: 'Örnek International Priority® (XP)' })).toBeGreaterThan(
      serviceMatchScore('Örnek Intl Priority', { service: 'Örnek International Priority® Express (XPE)' }),
    );
    expect(suggestPdfSections(scan.sections, ['Örnek Intl Priority'])).toEqual(['c1']);
    expect(suggestPdfSections(scan.sections, ['Örnek International Priority Express'])).toEqual(['c3']);
    expect(suggestPdfSections(scan.sections, ['XPE'])).toEqual(['c3']);
    // Avrupa grubu yalnız liste fiyatıyla varsa net olan alınır; dünya + avrupa netse ikisi birlikte
    const both = scan.sections.map((s) => (s.id === 'c5' ? { ...s, priceType: 'net' as const, zones: ['R', 'S'] } : s));
    expect(suggestPdfSections(both, ['Örnek Intl Priority'])).toEqual(['c1', 'c5']);
    expect(suggestPdfSections([], ['x'])).toEqual([]);
  });

  it('öneri önce faturalardan; tarifenin hizmeti yalnız fatura yoksa; kaynak etiketi için source', () => {
    const tariffService = 'Örnek Intl Priority';
    expect(suggestPdfSectionChoice(scan.sections, { invoiceServices: ['Örnek International Priority Express'], tariffService })).toEqual({
      ids: ['c3'],
      source: 'invoices',
      pricing: 'table',
    });
    expect(suggestPdfSectionChoice(scan.sections, { invoiceServices: [], tariffService })).toEqual({ ids: ['c1'], source: 'tariff', pricing: 'table' });
    // faturalar var ama eşleşmiyor: tarifenin hizmeti kullanılmaz, ilk koli tablosu "önerilen"
    expect(suggestPdfSectionChoice(scan.sections, { invoiceServices: ['Bilinmeyen Kargo'], tariffService: 'Örnek International Priority Express' }).source).toBe(
      'default',
    );
    expect(suggestPdfSectionChoice([], { invoiceServices: ['x'] })).toEqual({ ids: [], source: null, pricing: 'table' });
  });

  it('boş / metinsiz sayfa → bölüm yok', () => {
    expect(scanPdfLayout([{ items: [] }]).sections).toEqual([]);
  });
});

describe('belge bilgisi kalıpları', () => {
  it('geçerlilik, bölen, yakıt', () => {
    expect(detectValidFrom("Türkiye'de 2 Haziran 2026'dan itibaren geçerlidir.")).toBe('2026-06-02');
    expect(detectValidFrom('Rates effective 15 January 2026')).toBe('2026-01-15');
    expect(detectValidFrom('01.04.2026 tarihinden itibaren')).toBe('2026-04-01');
    expect(detectDimDivisor('Hacim böleni: 6000')).toBe(6000);
    expect(detectDimDivisor('Boyutsal ağırlık oranı 1:4')).toBe(4000);
    expect(detectDimDivisor('Sayfa 1:5')).toBeNull();
    expect(detectFuel('Yakıt tanımı FIXED 5%')).toEqual({ kind: 'FIXED_PCT', pct: 5 });
    expect(detectFuel('Yakıt ek ücreti haftalık endekse göre')).toEqual({ kind: 'INDEXED', pct: null });
    expect(detectFuel('yok')).toEqual({ kind: 'UNKNOWN', pct: null });
  });
});
