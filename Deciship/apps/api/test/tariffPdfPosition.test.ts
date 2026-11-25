import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPdfImport, readPdfText, type BuildInput, type PdfExtraction } from '../src/services/tariffPdf.ts';

/**
 * 05-B11: yapay zekânın okuduğu tarife fiyatı yalnız "bu sayı sayfada var mı" diye değil, yeriyle de denetlenir. Fiyatlar
 * metin katmanında başka bir ağırlığın satırında (satır kayması) ya da kendi satırında başka sırada (sütun karışması)
 * duruyorsa "doğrulanamadı" listesine girer. Sayfa metinleri gerçek PDF'ten (pdf-lib ile çizilir, pdfjs ile okunur);
 * yanlış alarm ölçümü için farklı yerleşimler: çok satırlı başlık, sütun sütun çizim, etiketi sonda çizilen satır, yan yana
 * iki blok, lb + kg sütunu, aralık etiketi, ağırlıklar sütunda (bölgeler satırda). Sayılar uydurmadır.
 */

type Cell = { text: string; x: number; y: number };

const SIZE = 8;
const ZX = [220, 280, 340];
const ZONES = ['A', 'B', 'C'];
const WEIGHTS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 5.5, 6];
/** her ağırlık ve bölge için ayrı fiyat */
const price = (w: number, zi: number) => (10 + w * 3.1 + zi * 1.7).toFixed(2);
const pricesOf = (w: number) => ZONES.map((_, zi) => price(w, zi));
const lbl = (w: number) => String(w).replace('.', ',');

/** Hücreler verilen sırayla çizilir (metin katmanının sırası çizim sırasıdır). */
async function pageTextsOf(pages: Cell[][]): Promise<string[]> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const cells of pages) {
    const p = doc.addPage([595, 842]);
    for (const c of cells) p.drawText(c.text, { x: c.x, y: c.y, size: SIZE, font });
  }
  return (await readPdfText(Buffer.from(await doc.save()), { companyId: 'test' })).pages;
}

/** Başlık: iki satırlı ağırlık ve bölge başlığı + para birimi satırı. */
function header(y: number, labelX = 60): Cell[] {
  return [
    { text: 'ULUSLARARASI EKSPRES / IHRACAT - Net ucretler (USD)', x: 60, y: y + 30 },
    { text: 'AGIRLIK', x: labelX, y: y + 18 },
    { text: '(KG)', x: labelX, y: y + 9 },
    ...ZONES.flatMap((z, zi) => [
      { text: 'BOLGE', x: ZX[zi]!, y: y + 18 },
      { text: z, x: ZX[zi]! + 8, y: y + 9 },
    ]),
    ...ZONES.map((_, zi) => ({ text: 'USD', x: ZX[zi]!, y })),
  ];
}

type Order = 'row' | 'column' | 'labelLast';
/** Ağırlık satırları, bölge sütunları; `order` çizim sırası. */
function grid(weights: number[], o: { y0?: number; order?: Order; label?: (w: number) => string; extra?: (w: number) => string } = {}): Cell[] {
  const y0 = o.y0 ?? 740;
  const label = o.label ?? lbl;
  const rows = weights.map((w, i) => {
    const y = y0 - 12 * (i + 1);
    const head: Cell[] = [{ text: label(w), x: 60, y }, ...(o.extra ? [{ text: o.extra(w), x: 120, y }] : [])];
    const cells = pricesOf(w).map((t, zi) => ({ text: t, x: ZX[zi]!, y }));
    return { head, cells };
  });
  const order = o.order ?? 'row';
  const body =
    order === 'row'
      ? rows.flatMap((r) => [...r.head, ...r.cells])
      : order === 'labelLast'
        ? rows.flatMap((r) => [...r.cells, ...r.head])
        : [...rows.flatMap((r) => r.head), ...ZONES.flatMap((_, zi) => rows.map((r) => r.cells[zi]!))];
  return [...header(y0, 60), ...body];
}

type XRow = PdfExtraction['tables'][number]['rows'][number];
const wRow = (w: number, cells: string[], label = lbl(w)): XRow => ({ kind: 'weight', label, weight: w, from: null, step: null, cells, page: 1 });

function input(rows: XRow[], pageTexts: string[], zones = ZONES): BuildInput {
  return {
    fileName: 'uydurma.pdf',
    sections: [
      {
        id: 's1',
        title: 'IP ihracat · Dünya · kutu · net',
        service: 'Uluslararası Ekspres',
        direction: 'export',
        priceType: 'net',
        packaging: 'box',
        zones,
        weightMin: 0.5,
        weightMax: 100,
        currency: 'USD',
        pages: [1],
        hasAdditionalStep: false,
        hasPerKgBands: false,
      },
    ],
    extraction: { tables: [{ sectionId: 's1', zones, rows }], countries: [], notes: [] },
    document: {
      carrier: 'Ornek',
      validFrom: null,
      currency: 'USD',
      weightUnit: 'kg',
      dimDivisor: 5000,
      fuel: { kind: 'UNKNOWN', pct: null },
      surchargeNotes: [],
      countryZonePages: [],
      discountPages: [],
      notes: [],
    },
    pageTexts,
    includeCountryZones: false,
    current: null,
    codeSectionIds: new Set(),
  };
}

const misplaced = (r: ReturnType<typeof buildPdfImport>) => r.issues.find((i) => i.code === 'PDF_VALUES_MISPLACED');
const unverifiedWeights = (r: ReturnType<typeof buildPdfImport>) => [...new Set(r.verification!.unmatched.map((u) => u.weight))];
const correct = (weights = WEIGHTS) => weights.map((w) => wRow(w, pricesOf(w)));

describe('05-B11: tarife PDF fiyatı yeriyle doğrulanır', () => {
  let standard: string[];
  beforeAll(async () => {
    standard = await pageTextsOf([grid(WEIGHTS)]);
  });

  it('doğru okuma: hepsi eşleşir, konum uyarısı yok', () => {
    const r = buildPdfImport(input(correct(), standard));
    expect(r.verification).toEqual({ method: 'ai', checked: 30, matched: 30, unmatched: [] });
    expect(misplaced(r)).toBeUndefined();
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('satır kayması: 1,5 kg ve sonrası bir üst satırın fiyatını almış → o satırlar doğrulanamadı (uyarı)', () => {
    const rows = WEIGHTS.map((w, i) => wRow(w, pricesOf(i >= 2 ? WEIGHTS[i - 1]! : w)));
    const r = buildPdfImport(input(rows, standard));
    // her sayı sayfada var: eski denetim "eşleşti" derdi
    expect(r.issues.find((i) => i.code === 'PDF_VALUES_UNVERIFIED')).toBeUndefined();
    expect(r.verification).toMatchObject({ checked: 30, matched: 6 });
    expect(unverifiedWeights(r)).toEqual(WEIGHTS.slice(2));
    expect(r.verification!.unmatched[0]).toEqual({ zone: 'A', weight: 1.5, price: Number(price(1, 0)), page: 1 });
    expect(misplaced(r)).toMatchObject({
      severity: 'warning',
      title: "24 fiyatın PDF'teki yeri tutmuyor: başka bir ağırlığın satırında ya da başka sütunda (30 fiyattan)",
    });
    expect(misplaced(r)!.detail).toContain('Bölge A, 1,50 kg');
  });

  it("tek satır: 5 kg'ın fiyatı 5,5 kg'a yazılmış → yalnız 5,5 kg", () => {
    const rows = WEIGHTS.map((w) => wRow(w, pricesOf(w === 5.5 ? 5 : w)));
    const r = buildPdfImport(input(rows, standard));
    expect(unverifiedWeights(r)).toEqual([5.5]);
    expect(r.verification).toMatchObject({ checked: 30, matched: 27 });
  });

  it('sütun karışması: 2 kg satırında A ile B yer değiştirmiş; bütün tabloda A ile B karışmış', () => {
    const one = WEIGHTS.map((w) => {
      const p = pricesOf(w);
      return wRow(w, w === 2 ? [p[1]!, p[0]!, p[2]!] : p);
    });
    expect(unverifiedWeights(buildPdfImport(input(one, standard)))).toEqual([2]);
    const all = WEIGHTS.map((w) => {
      const p = pricesOf(w);
      return wRow(w, [p[1]!, p[0]!, p[2]!]);
    });
    const r = buildPdfImport(input(all, standard));
    expect(r.verification).toMatchObject({ checked: 30, matched: 0 });
    expect(misplaced(r)?.severity).toBe('warning');
  });

  it('kayma ile sayfada olmayan fiyat birlikte: ikisi ayrı uyarı, sayılar toplanır', () => {
    const rows = WEIGHTS.map((w) => wRow(w, w === 3 ? ['99.99', ...pricesOf(3).slice(1)] : pricesOf(w === 5.5 ? 5 : w)));
    const r = buildPdfImport(input(rows, standard));
    expect(r.issues.find((i) => i.code === 'PDF_VALUES_UNVERIFIED')).toMatchObject({ title: '1 fiyat PDF metninde bulunamadı (30 fiyattan)' });
    expect(misplaced(r)).toMatchObject({ title: expect.stringContaining('3 fiyatın') });
    expect(r.verification).toMatchObject({ checked: 30, matched: 26 });
    // sayfada olmayan önce (bugünkü sıra), sonra yeri tutmayanlar
    expect(r.verification!.unmatched.map((u) => u.weight)).toEqual([3, 5.5, 5.5, 5.5]);
  });

  it('kodla taranan bölümde konum denetimi yapılmaz (değerler zaten metinden)', () => {
    const rows = WEIGHTS.map((w, i) => wRow(w, pricesOf(i >= 2 ? WEIGHTS[i - 1]! : w)));
    const r = buildPdfImport({ ...input(rows, standard), codeSectionIds: new Set(['s1']) });
    expect(r.verification).toMatchObject({ method: 'code', checked: 30, matched: 30, unmatched: [] });
    expect(misplaced(r)).toBeUndefined();
  });
});

describe('05-B11: yanlış alarm yok (doğru okuma, farklı yerleşimler)', () => {
  const clean = (r: ReturnType<typeof buildPdfImport>, checked: number) => {
    expect(r.verification).toEqual({ method: 'ai', checked, matched: checked, unmatched: [] });
    expect(misplaced(r)).toBeUndefined();
  };

  it('sütun sütun çizilmiş tablo (metinde her hücre ayrı satır): denetlenemez, alarm yok', async () => {
    const texts = await pageTextsOf([grid(WEIGHTS, { order: 'column' })]);
    clean(buildPdfImport(input(correct(), texts)), 30);
    // bu yerleşimde kayma da yakalanamaz (bilinen sınır): eski davranış
    const shifted = WEIGHTS.map((w, i) => wRow(w, pricesOf(i >= 2 ? WEIGHTS[i - 1]! : w)));
    clean(buildPdfImport(input(shifted, texts)), 30);
  });

  it('etiketi hücrelerden sonra çizilen satır', async () => {
    const texts = await pageTextsOf([grid(WEIGHTS, { order: 'labelLast' })]);
    clean(buildPdfImport(input(correct(), texts)), 30);
  });

  it('aynı satırlarda yan yana iki blok (0,5–2,5 solda, 3–6 sağda); sağ blokta kayma yakalanır', async () => {
    const left = WEIGHTS.slice(0, 5);
    const right = WEIGHTS.slice(5);
    const cells: Cell[] = [...header(740)];
    left.forEach((w, i) => {
      const y = 740 - 12 * (i + 1);
      cells.push({ text: lbl(w), x: 40, y }, ...pricesOf(w).map((t, zi) => ({ text: t, x: 70 + zi * 40, y })));
      const rw = right[i];
      if (rw != null) cells.push({ text: lbl(rw), x: 300, y }, ...pricesOf(rw).map((t, zi) => ({ text: t, x: 330 + zi * 40, y })));
    });
    const texts = await pageTextsOf([cells]);
    clean(buildPdfImport(input(correct(), texts)), 30);
    const shifted = WEIGHTS.map((w) => wRow(w, pricesOf(w === 4 ? 3 : w)));
    expect(unverifiedWeights(buildPdfImport(input(shifted, texts)))).toEqual([4]);
  });

  it('lb tablosu, yanında kg sütunu ("1 lb  0,45 kg")', async () => {
    const lbs = [1, 2, 3, 4, 5, 6];
    const texts = await pageTextsOf([grid(lbs, { label: (w) => `${w} lb`, extra: (w) => `${(w * 0.4536).toFixed(2).replace('.', ',')} kg` })]);
    const r = buildPdfImport({
      ...input(
        lbs.map((w) => wRow(w, pricesOf(w), `${w} lb`)),
        texts,
      ),
      document: { ...input([], []).document, weightUnit: 'lb' },
    });
    clean(r, 18);
  });

  it('aralık etiketi ("0,51 - 1,00") ve kg başı bantlar ("71-99", "100 +")', async () => {
    const y0 = 740;
    const labels: [string, number][] = [
      ['0,00 - 0,50', 0.5],
      ['0,51 - 1,00', 1],
      ['1,01 - 1,50', 1.5],
      ['1,51 - 2,00', 2],
    ];
    const cells: Cell[] = [...header(y0)];
    labels.forEach(([t, w], i) => {
      const y = y0 - 12 * (i + 1);
      cells.push({ text: t, x: 60, y }, ...pricesOf(w).map((p, zi) => ({ text: p, x: ZX[zi]!, y })));
    });
    cells.push({ text: '71-99', x: 60, y: y0 - 72 }, ...pricesOf(99).map((p, zi) => ({ text: p, x: ZX[zi]!, y: y0 - 72 })));
    cells.push({ text: '100 +', x: 60, y: y0 - 84 }, ...pricesOf(100).map((p, zi) => ({ text: p, x: ZX[zi]!, y: y0 - 84 })));
    const texts = await pageTextsOf([cells]);
    const rows: XRow[] = [
      ...labels.map(([t, w]) => wRow(w, pricesOf(w), t)),
      { kind: 'perKg', label: '71-99', weight: 99, from: 71, step: null, cells: pricesOf(99), page: 1 },
      { kind: 'perKg', label: '100 +', weight: null, from: 100, step: null, cells: pricesOf(100), page: 1 },
    ];
    clean(buildPdfImport(input(rows, texts)), 18);
  });

  it('ağırlıklar sütunda, bölgeler satırda: denetlenemez, alarm yok', async () => {
    const ws = [0.5, 1, 1.5, 2];
    const cells: Cell[] = [{ text: 'BOLGE / KG', x: 60, y: 760 }, ...ws.map((w, i) => ({ text: lbl(w), x: 150 + i * 60, y: 760 }))];
    ZONES.forEach((z, zi) => {
      const y = 748 - zi * 12;
      cells.push({ text: `BOLGE ${z}`, x: 60, y }, ...ws.map((w, i) => ({ text: price(w, zi), x: 150 + i * 60, y })));
    });
    const texts = await pageTextsOf([cells]);
    clean(
      buildPdfImport(
        input(
          ws.map((w) => wRow(w, pricesOf(w))),
          texts,
        ),
      ),
      12,
    );
  });
});
