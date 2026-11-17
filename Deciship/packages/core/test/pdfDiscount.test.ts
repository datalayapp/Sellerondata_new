import { describe, expect, it } from 'vitest';
import {
  applyListDiscount,
  diffTables,
  discountBandFor,
  discounted,
  expandStepRows,
  findDiscountTable,
  linkListDiscounts,
  parsePctCell,
  scanPdfLayout,
  suggestPdfSectionChoice,
  type PdfDiscountRow,
  type PdfPageLayout,
  type PdfTextItem,
} from '../src/index';

/** Liste fiyatı × indirim tablosu: sentetik konumlu metin (tüm sayılar uydurma). */

const H = 7;
const line = (y: number, cells: [number, string][]): PdfTextItem[] => cells.map(([x, str]) => ({ str, x, y, w: str.length * 3.6, h: H }));
const ZX = [200, 240, 280];
const row = (y: number, label: string, vals: string[]) => line(y, [[150, label], ...vals.map((v, i) => [ZX[i]! + 4, v] as [number, string])]);

function pricePage(opts: { service: string; net: boolean; dir?: string; scale?: number }): PdfPageLayout {
  let y = 760;
  const items: PdfTextItem[] = [];
  const add = (its: PdfTextItem[]) => {
    items.push(...its);
    y -= 9;
  };
  const k = (n: number) => (n * (opts.scale ?? 1)).toFixed(2);
  add(line(y, [[140, `DÜNYA GENELİ / ${opts.dir ?? 'İHRACAT'}`], [260, 'ÜCRETLERİ']]));
  add(line(y, [[140, opts.service]]));
  add(line(y, [[140, opts.net ? '- Net Ücretler' : '- Liste Fiyatı']]));
  add(line(y, [[145, 'AĞIRLIK (KG)'], [ZX[0]! - 8, 'A BÖLGESİ'], [ZX[1]! - 8, 'B BÖLGESİ'], [ZX[2]! - 6, 'ZONE C']]));
  add(line(y, ZX.map((x) => [x + 6, 'USD'] as [number, string])));
  add(line(y, [[140, 'Diğer ambalaj malzemeleri kullanıldığında ücretler (0,5 - 70,5kg)']]));
  add(row(y, '0.5', [k(30), k(40), k(50)]));
  add(row(y, '10.5', [k(100), k(110), k(120)]));
  add(row(y, 'İlave 0,5kg', [k(10), k(11), k(12)]));
  add(row(y, '21', [k(300), k(330), k(360)]));
  add(line(y, [[140, 'Kg başına ücret (toplam gönderi ağırlığıyla çarpınız)']]));
  add(row(y, '71-99', [k(15), k(16), k(17)]));
  add(row(y, '1000 +', [k(14), k(15), k(16)]));
  return { items };
}

/** Bölge başlıkları "(KG)" satırından ayrı; virgüllü / işaret önde yüzdeler; #REF!; eksik hücre; aynı sayfada ithalat. */
function discountPage(): PdfPageLayout {
  const z = (y: number) => line(y, ZX.map((x, i) => [x + 10, 'ABC'[i]!] as [number, string]));
  const r = (y: number, label: string, min: string, max: string, vals: (string | null)[]) =>
    line(y, [[70, label], [110, min], [146, max], ...vals.flatMap((v, i) => (v == null ? [] : [[ZX[i]! + 4, v] as [number, string]]))]);
  return {
    items: [
      ...line(720, [[70, 'İHRACAT İndirimi']]),
      ...line(710, [[70, 'Aşağıda yer alan değerler indirim yüzdeleridir; liste fiyatlarına uygulayınız.']]),
      ...line(690, [[100, 'Minimum Ağırlık'], [140, 'Maksimum Ağırlık']]),
      ...z(686),
      ...line(682, [[110, '(KG)'], [146, '(KG)']]),
      ...r(670, 'XP Letter', '0.50', '0.50', ['50.00%', '50.00%', '50.00%']),
      ...r(661, 'XP Pak', '0.50', '2.50', ['51.00%', '51.00%', '51.00%']),
      ...r(652, 'XP', '0.50', '2.50', ['60,00%', '61.5 %', '#REF!']),
      ...r(643, 'XP', '3.00', '20.50', ['%62,25', '63.00%', '#REF!']),
      ...r(634, 'XP', '21.00', '9999.00', ['64.00%', null, '#REF!']),
      ...r(625, 'XQ', '0.50', '9999.00', ['10.00%', '10.00%', '10.00%']),
      ...line(600, [[70, 'İTHALAT İndirimi']]),
      ...z(590),
      ...r(580, 'XP', '0.50', '9999.00', ['40.00%', '41.00%', '42.00%']),
    ],
  };
}

describe('indirim tablosu okuma', () => {
  const scan = scanPdfLayout([
    pricePage({ service: 'Örnek International Priority® (XP)', net: true, scale: 0.4 }),
    discountPage(),
    pricePage({ service: 'Örnek International Priority® (XP)', net: false }),
    pricePage({ service: 'Örnek International Priority® (XP)', net: false, dir: 'İTHALAT' }),
  ]);

  it('yüzde hücreleri: nokta / virgül / işaret önde; bozuk ve boş → null', () => {
    expect(parsePctCell('67.03%')).toBe(67.03);
    expect(parsePctCell('67,03 %')).toBe(67.03);
    expect(parsePctCell('%67,03')).toBe(67.03);
    expect(parsePctCell('67.03')).toBeNull();
    expect(parsePctCell('67.03', true)).toBe(67.03);
    expect(parsePctCell('#REF!')).toBeNull();
    expect(parsePctCell('#N/A')).toBeNull();
    expect(parsePctCell('')).toBeNull();
    expect(parsePctCell('140%')).toBeNull();
  });

  it('hizmet + yön başına tablo; bantlar, Letter/Pak satırları, konumla hücre, ara başlıkta ithalat', () => {
    expect(scan.discountTables.map((d) => [d.id, d.service, d.direction, d.pages, d.zones.join('')])).toEqual([
      ['d1', 'XP', 'export', [2], 'ABC'],
      ['d2', 'XQ', 'export', [2], 'ABC'],
      ['d3', 'XP', 'import', [2], 'ABC'],
    ]);
    const xp = scan.discountTables[0]!;
    expect(xp.rows.map((r) => [r.packaging, r.min, r.max, r.pcts])).toEqual([
      ['envelope', 0.5, 0.5, [50, 50, 50]],
      ['pak', 0.5, 2.5, [51, 51, 51]],
      [null, 0.5, 2.5, [60, 61.5, null]],
      [null, 3, 20.5, [62.25, 63, null]],
      [null, 21, 9999, [64, null, null]],
    ]);
    expect(xp.rows[4]!.cells).toEqual(['64.00%', '', '#REF!']);
    // indirim sayfası fiyat bölümü üretmez
    expect(scan.sections.map((s) => [s.id, s.priceType, s.direction, s.pages[0]])).toEqual([
      ['c1', 'net', 'export', 1],
      ['c2', 'list', 'export', 3],
      ['c3', 'list', 'import', 4],
    ]);
  });

  it('yuvarlama: kuruşa, yarım yukarı; kayan nokta kayması yok', () => {
    expect(discounted(69.75, 67.03)).toBe(23);
    expect(discounted(10, 56.25)).toBe(4.38); // 4.375 → 4.38
    expect(discounted(1041.94, 0)).toBe(1041.94);
  });

  it('bant seçimi: içeren en dar bant; bantlar arası alttaki; zarf/pak satırı koliye uygulanmaz', () => {
    const rows = scan.discountTables[0]!.rows;
    expect(discountBandFor(rows, 0.5)!.pcts[0]).toBe(60);
    expect(discountBandFor(rows, 2.75)!.pcts[0]).toBe(60);
    expect(discountBandFor(rows, 20.5)!.pcts[0]).toBe(62.25);
    expect(discountBandFor(rows, 1000)!.pcts[0]).toBe(64);
    expect(discountBandFor(rows, 20000)).toBeNull();
    const only: PdfDiscountRow[] = [{ label: 'XP', packaging: null, min: null, max: null, pcts: [5], cells: ['5%'], page: 1 }];
    expect(discountBandFor(only, 33)!.pcts[0]).toBe(5);
  });

  it('liste × indirim: ilave satırı listede ara ağırlıklara açılır, her ağırlık kendi bandıyla; indirimsiz hücre sayı olmaz', () => {
    const list = scan.sections[1]!;
    const disc = findDiscountTable(list, scan.discountTables)!;
    expect(disc.id).toBe('d1');
    expect(findDiscountTable(scan.sections[2]!, scan.discountTables)!.id).toBe('d3');
    const r = applyListDiscount(list, disc);
    const cells = (w: number) => r.table.rows.find((x) => x.kind === 'weight' && x.weight === w)!.cells;
    expect(cells(0.5)).toEqual(['12.00', '15.40', '#REF!']); // 30 × 0,40; 40 × 0,385
    expect(cells(10.5)).toEqual(['37.75', '40.70', '#REF!']); // 100 × 0,3775; 110 × 0,37
    expect(cells(11)).toEqual(['41.53', '44.77', '#REF!']); // (100 + 10) × 0,3775 = 41,525 → 41,53
    expect(cells(20.5)).toEqual(['113.25', '122.10', '#REF!']); // (100 + 20 × 10) × 0,3775
    expect(cells(21)).toEqual(['108.00', 'indirim yok', '#REF!']);
    expect(r.table.rows.filter((x) => x.kind === 'additional')).toEqual([]);
    expect(r.table.rows.filter((x) => x.kind === 'perKg').map((x) => x.cells)).toEqual([
      ['5.40', 'indirim yok', '#REF!'],
      ['5.04', 'indirim yok', '#REF!'],
    ]);
    expect(r.zonesWithoutDiscount).toEqual(['C']);
    expect(r.missing.filter((m) => m.zone === 'B').map((m) => m.label)).toEqual(['21', '71-99', '1000 +']);
    expect(r.bands).toEqual(['0,5–2,5 kg', '3–20,5 kg', '21–9999 kg']);
  });

  it('aşım "İlave" (son satırdan sonra) kendi ağırlığının bandıyla indirilir', () => {
    const list = scan.sections[1]!;
    const table = { ...list.table, rows: [list.table.rows[1]!, { ...list.table.rows[2]! }] }; // 10.5 + İlave (sonrası yok)
    const r = applyListDiscount({ zones: list.zones, table }, scan.discountTables[0]!);
    expect(r.table.rows.map((x) => [x.kind, x.cells[0]])).toEqual([
      ['weight', '37.75'],
      ['additional', '3.78'], // 10 × 0,3775 (11 kg bandı)
    ]);
  });

  it('net sayfayla bağlantı ve fark; öneri liste × indirim', () => {
    const links = linkListDiscounts(scan.sections, scan.discountTables);
    expect([...links.keys()]).toEqual(['c2', 'c3', 'c1']);
    const l = links.get('c1')!;
    expect(l).toMatchObject({ listSectionId: 'c2', discountTableId: 'd1', listPages: [3], discountPages: [2] });
    // net sayfa liste × 0,4 (uydurma) → indirim farklı olduğu için hücrelerin çoğu farklı
    expect(l.diff!.compared).toBeGreaterThan(40);
    expect(l.diff!.differing).toBeGreaterThan(0);
    const withLinks = scan.sections.map((s) => ({ ...s, listDiscount: links.get(s.id) ?? null }));
    expect(suggestPdfSectionChoice(withLinks, { invoiceServices: ['Örnek Intl Priority'] })).toEqual({ ids: ['c1'], source: 'invoices', pricing: 'listDiscount' });
    expect(suggestPdfSectionChoice(scan.sections, { invoiceServices: ['Örnek Intl Priority'] })).toEqual({ ids: ['c1'], source: 'invoices', pricing: 'table' });
  });

  it('fark: aynı tablo → 0; ara ağırlıktaki kuruş farkı sayılır', () => {
    const list = scan.sections[1]!;
    const r = applyListDiscount(list, scan.discountTables[0]!);
    expect(diffTables(r.table, r.table)).toMatchObject({ differing: 0, maxDiff: 0 });
    // net sayfa: açık satırlar aynı, ilave tutarı yuvarlanmış (10 × 0,3775 = 3,78) → 11 kg 41,53 ama 12 kg 45,31 ≠ 45,30
    const net = {
      ...r.table,
      rows: [
        { kind: 'weight' as const, label: '10.5', weight: 10.5, from: null, step: null, cells: ['37.75', '', ''], page: 1 },
        { kind: 'additional' as const, label: 'İlave 0,5kg', weight: null, from: null, step: 0.5, cells: ['3.78', '', ''], page: 1 },
        { kind: 'weight' as const, label: '21', weight: 21, from: null, step: null, cells: ['108.00', '', ''], page: 1 },
      ],
    };
    const d = diffTables(net, r.table);
    expect(d.compared).toBe(22);
    expect(d.differing).toBeGreaterThan(0);
    expect(d.examples[0]).toMatchObject({ zone: 'A' });
    expect(expandStepRows(net.rows).map((x) => x.weight)).toHaveLength(22);
  });
});
