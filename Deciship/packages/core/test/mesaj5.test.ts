import { describe, expect, it } from 'vitest';
import {
  HARD_ROW_FLAGS,
  IMPORT_REPORT_MAX_ROWS,
  ROW_FLAG_LABELS,
  SOFT_ROW_FLAGS,
  buildDisputeText,
  buildImportReport,
  checkPdfLines,
  emptyMapping,
  hardFlags,
  overchargeReconciliation,
  parseRows,
  rowFlagLabel,
  toCents,
  verifyMapping,
  type ColumnMapping,
  type DisputeInput,
  type DisputeLine,
  type ReconLineInput,
  type Table,
} from '../src/index';

/** Mesaj 5 ("Kullanıcıya açık ol"): okunamayan satırlar, PDF metin denetimi, fazla ödeme açıklaması, itiraz kanıtı. */

const HEAD = ['Takip No', 'Açıklama', 'Tarih', 'Net Tutar'];
const map = (over: Partial<ColumnMapping> = {}): ColumnMapping => ({
  ...emptyMapping(),
  trackingNo: 'Takip No',
  netAmount: 'Net Tutar',
  shipDate: 'Tarih',
  numberFormat: 'tr',
  ...over,
});
const table = (rows: string[][]): Table => ({ headers: HEAD, rows });

describe('parseRows: kodlu hatalar', () => {
  it('satır hataları kod, ham değer ve takip no taşır; ileti değişmez', () => {
    const { errors, lines } = parseRows(
      table([
        ['ABCDEF', '', '', '10,00'],
        ['794812345301', '', '', 'yok'],
        ['794812345302', '', 'dün', '12,50'],
        ['794812345303', '', '', '15,00'],
      ]),
      map(),
    );
    expect(lines.map((l) => l.trackingNo)).toEqual(['794812345302', '794812345303']);
    expect(errors).toEqual([
      { rowIndex: 0, code: 'BAD_TRACKING', message: 'Satır 1: geçersiz takip no "ABCDEF"', value: 'ABCDEF' },
      { rowIndex: 1, code: 'BAD_NET', message: 'Satır 2: net tutar okunamadı "yok"', value: 'yok', trackingRaw: '794812345301' },
      { rowIndex: 2, code: 'BAD_DATE', message: 'Satır 3: tarih okunamadı "dün"', value: 'dün', trackingRaw: '794812345302' },
    ]);
  });

  it('sütun hataları: NO_TRACKING_COLUMN, NO_NET_COLUMN (rowIndex -1)', () => {
    const t = table([['794812345301', '', '', '10']]);
    expect(parseRows(t, map({ trackingNo: undefined })).errors.map((e) => [e.rowIndex, e.code])).toEqual([[-1, 'NO_TRACKING_COLUMN']]);
    expect(parseRows(t, map({ netAmount: 'Yok' })).errors.map((e) => [e.rowIndex, e.code])).toEqual([[-1, 'NO_NET_COLUMN']]);
    expect(parseRows(t, map({ netAmount: 'Yok' })).skipped).toEqual([]);
  });

  it('kod dilden bağımsızdır (EN ileti, aynı kod)', () => {
    const { errors } = parseRows(table([['ABCDEF', '', '', '10']]), map(), 'en');
    expect(errors[0]).toMatchObject({ code: 'BAD_TRACKING', message: 'Row 1: invalid tracking no "ABCDEF"' });
  });
});

describe('verifyMapping: bayrak metinden değil koddan', () => {
  it('tarih hücresinde "tutar" geçse de satır tarih bayrağı alır, tutar bayrağı almaz', () => {
    const t = table([
      ['794812345301', '', 'tutar yok', '10,00'],
      ['794812345302', '', '01.10.2026', '12,00'],
    ]);
    const v = verifyMapping(t, map());
    const row0 = v.rowFlags.find((r) => r.rowIndex === 0)!;
    expect(row0.codes).toContain('DATE_PARSE');
    expect(row0.codes).not.toContain('AMOUNT_PARSE');
  });

  it('takip no hücresinde "tarih" geçse de takip no bayrağı', () => {
    const t = table([['tarih', '', '', '10,00']]);
    const v = verifyMapping(t, map());
    expect(v.rowFlags[0]!.codes).toEqual(['TRACKING_FORMAT']);
  });

  it('kodsuz (eski) hata listesi verilirse ileti metninden çıkarılır', () => {
    const t = table([
      ['ABCDEF', '', '', '10,00'],
      ['794812345301', '', '', 'x'],
    ]);
    const v = verifyMapping(t, map(), {
      lines: [],
      errors: [
        { rowIndex: 0, message: 'Satır 1: geçersiz takip no "ABCDEF"' },
        { rowIndex: 1, message: 'Row 2: net amount could not be read "x"' },
      ],
    });
    expect(v.rowFlags.map((r) => [r.rowIndex, r.codes])).toEqual([
      [0, ['TRACKING_FORMAT']],
      [1, ['AMOUNT_PARSE']],
    ]);
  });
});

describe('parseRows: takip no\'suz ücret satırları (skipped)', () => {
  it('takip no boş, tutar 0 değil → skipped; tutar 0 / boş / okunamaz → sayılmaz', () => {
    const { lines, skipped, errors } = parseRows(
      table([
        ['794812345301', '', '', '100,00'],
        ['', 'Adres düzeltme', '', '45,00'],
        ['', 'Boş satır', '', '0,00'],
        ['', '', '', ''],
        ['', 'Not', '', 'abc'],
        ['794812345302', '', '', '50,00'],
        ['', 'İade', '', '-7,50'],
      ]),
      map(),
    );
    expect(lines).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(skipped).toEqual([
      { rowIndex: 1, reason: 'NO_TRACKING', amount: 45 },
      { rowIndex: 6, reason: 'NO_TRACKING', amount: -7.5 },
    ]);
  });

  it('tutar satırlarla aynı KDV kuralıyla (KDV dahil → KDV düşülür)', () => {
    const { skipped, lines } = parseRows(
      table([
        ['794812345301', '', '', '120,00'],
        ['', 'Ek ücret', '', '54,00'],
      ]),
      map({ amountsIncludeVat: true, vatPct: 20 }),
    );
    expect(lines[0]!.netAmount).toBe(100);
    expect(skipped).toEqual([{ rowIndex: 1, reason: 'NO_TRACKING', amount: 45 }]);
  });

  it('toplam deseni herhangi bir hücrede → toplam satırı, sayılmaz', () => {
    const { skipped } = parseRows(
      table([
        ['794812345301', '', '', '100,00'],
        ['', 'Genel Toplam', '', '999,00'],
        ['', 'TOTAL', '', '888,00'],
      ]),
      map(),
    );
    expect(skipped).toEqual([]);
  });

  it('tutar okunan satırların toplamına eşit (±0,01) → toplam satırı', () => {
    const rows = [
      ['794812345301', '', '', '100,00'],
      ['794812345302', '', '', '50,25'],
    ];
    expect(parseRows(table([...rows, ['', '', '', '150,25']]), map()).skipped).toEqual([]);
    expect(parseRows(table([...rows, ['', '', '', '150,26']]), map()).skipped).toEqual([]);
    expect(parseRows(table([...rows, ['', '', '', '150,24']]), map()).skipped).toEqual([]);
    // 0,02 fark: toplam değil, takip no'suz ücret
    expect(parseRows(table([...rows, ['', '', '', '150,27']]), map()).skipped).toHaveLength(1);
  });

  it('KDV dahil toplam (KDV hariç satırlar) ve KDV hariç toplam (KDV dahil satırlar) da toplam sayılır', () => {
    const excl = [
      ['794812345301', '', '', '100,00'],
      ['794812345302', '', '', '50,00'],
    ];
    // satırlar KDV hariç; toplam KDV dahil (150 × 1,2)
    expect(parseRows(table([...excl, ['', '', '', '180,00']]), map()).skipped).toEqual([]);
    // satırlar KDV dahil (120 + 60 = 180), toplam KDV hariç 150
    const incl = [
      ['794812345301', '', '', '120,00'],
      ['794812345302', '', '', '60,00'],
    ];
    expect(parseRows(table([...incl, ['', '', '', '150,00']]), map({ amountsIncludeVat: true, vatPct: 20 })).skipped).toEqual([]);
    expect(parseRows(table([...incl, ['', '', '', '180,00']]), map({ amountsIncludeVat: true, vatPct: 20 })).skipped).toEqual([]);
  });

  it('ara toplamlar (son toplamdan beri) ve en üstteki genel toplam da sayılmaz', () => {
    const { skipped } = parseRows(
      table([
        ['', '', '', '175,00'], // en üstte genel toplam
        ['794812345301', '', '', '100,00'],
        ['794812345302', '', '', '25,00'],
        ['', '', '', '125,00'], // ara toplam 1
        ['794812345303', '', '', '50,00'],
        ['', '', '', '50,00'], // ara toplam 2 (son toplamdan beri)
        ['', 'Kapıda ödeme', '', '12,00'], // gerçek ücret
      ]),
      map(),
    );
    expect(skipped).toEqual([{ rowIndex: 6, reason: 'NO_TRACKING', amount: 12 }]);
  });

  it('toplam takip no\'suz ücreti ve takip no\'su bozuk satırı da içeriyorsa yine toplam sayılır', () => {
    const { skipped, errors } = parseRows(
      table([
        ['', '', '', '182,00'], // en üstte: her şeyin toplamı
        ['794812345301', '', '', '100,00'],
        ['', 'Adres düzeltme', '', '45,00'],
        ['ABCDEF', '', '', '25,00'],
        ['794812345302', '', '', '12,00'],
        ['', '', '', '182,00'], // altta: her şeyin toplamı
      ]),
      map(),
    );
    expect(errors.map((e) => e.code)).toEqual(['BAD_TRACKING']);
    expect(skipped).toEqual([{ rowIndex: 2, reason: 'NO_TRACKING', amount: 45 }]);
  });
});

describe('buildImportReport', () => {
  it('parseRows sonucundan: sayılar, nedenler, 1 tabanlı satırlar, takip no\'suz toplam', () => {
    const t = table([
      ['ABCDEF', '', '', '10,00'],
      ['794812345301', '', '', 'yok'],
      ['794812345302', '', 'dün', '12,50'],
      ['', 'Adres düzeltme', '', '45,00'],
      ['', 'Kapıda ödeme', '', '5,10'],
      ['794812345303', '', '', '15,00'],
    ]);
    const r = parseRows(t, map());
    const rep = buildImportReport({ source: 'table', rowsInFile: t.rows.length, linesImported: r.lines.length, errors: r.errors, skipped: r.skipped });
    expect(rep).toEqual({
      version: 1,
      source: 'table',
      rowsInFile: 6,
      linesImported: 2,
      skippedCount: 4,
      byReason: { BAD_TRACKING: 1, BAD_NET: 1, NO_TRACKING: 2 },
      skippedRows: [
        { row: 1, reason: 'BAD_TRACKING', trackingRaw: 'ABCDEF' },
        { row: 2, reason: 'BAD_NET', trackingRaw: '794812345301', rawNet: 'yok' },
        { row: 4, reason: 'NO_TRACKING', amount: 45 },
        { row: 5, reason: 'NO_TRACKING', amount: 5.1 },
      ],
      noTrackingAmount: 50.1,
    });
  });

  it('tarih ve sütun hataları satır düşürmez; takip no\'suz satır yoksa noTrackingAmount yazılmaz', () => {
    const rep = buildImportReport({
      source: 'table',
      rowsInFile: 3,
      linesImported: 3,
      errors: [
        { rowIndex: -1, code: 'NO_NET_COLUMN', message: '' },
        { rowIndex: 1, code: 'BAD_DATE', message: '', value: 'dün' },
        { rowIndex: 2, message: 'kodsuz' },
      ],
      skipped: [],
    });
    expect(rep).toEqual({ version: 1, source: 'table', rowsInFile: 3, linesImported: 3, skippedCount: 0, byReason: {}, skippedRows: [] });
    expect('noTrackingAmount' in rep).toBe(false);
    expect('pdfCheck' in rep).toBe(false);
  });

  it(`en çok ${IMPORT_REPORT_MAX_ROWS} satır listelenir, sayı tamdır; uzun ham değer kısaltılır`, () => {
    const errors = Array.from({ length: 250 }, (_, i) => ({ rowIndex: i, code: 'BAD_NET' as const, message: '', value: 'x'.repeat(500) }));
    const rep = buildImportReport({ source: 'table', rowsInFile: 250, linesImported: 0, errors, skipped: [] });
    expect(rep.skippedCount).toBe(250);
    expect(rep.byReason).toEqual({ BAD_NET: 250 });
    expect(rep.skippedRows).toHaveLength(IMPORT_REPORT_MAX_ROWS);
    expect(rep.skippedRows[0]!.rawNet!.length).toBeLessThanOrEqual(80);
  });

  it('PDF: pdfCheck özeti checkPdfLines sonucundan (bayraklı satır sayısı)', () => {
    const check = checkPdfLines(['794812345301 100,00\n794812345302 50,00'], [
      { rowIndex: 0, trackingNo: '794812345301', netAmount: 100 },
      { rowIndex: 1, trackingNo: '794812345399', netAmount: 50 },
      { rowIndex: 2, trackingNo: '794812345302', netAmount: 77 },
    ]);
    const rep = buildImportReport({ source: 'pdf', rowsInFile: 3, linesImported: 3, errors: [], skipped: [], pdfCheck: check });
    expect(rep.pdfCheck).toEqual({ method: 'text', checked: 3, unverified: 2 });
    const given = buildImportReport({ source: 'pdf', rowsInFile: 3, linesImported: 3, errors: [], skipped: [], pdfCheck: { method: 'none', checked: 0, unverified: 0 } });
    expect(given.pdfCheck).toEqual({ method: 'none', checked: 0, unverified: 0 });
  });
});

describe('checkPdfLines', () => {
  const lines = [
    { rowIndex: 0, trackingNo: '794812345305', netAmount: 1234.56 },
    { rowIndex: 1, trackingNo: '1Z999AA10123456784', netAmount: 45 },
  ];

  it('metin yoksa method none, bayrak yok', () => {
    expect(checkPdfLines([], lines)).toEqual({ method: 'none', checked: 0, rows: [] });
    expect(checkPdfLines(['', '  \n\t ', '— · —'], lines)).toEqual({ method: 'none', checked: 0, rows: [] });
  });

  it('takip no boşluk/tire ile bölünmüş ya da küçük harfle yazılmış olsa da bulunur; tutar TR ve EN yazımla', () => {
    const r = checkPdfLines(['Gönderi 7948-1234 5305 ... Tutar 1.234,56 TL', 'Shipment 1z999aa1 0123456784 total 45.00'], lines);
    expect(r).toEqual({ method: 'text', checked: 2, rows: [] });
    expect(checkPdfLines(['794812345305 1,234.56 1Z999AA10123456784 45.00'], lines).rows).toEqual([]);
  });

  it('takip no metinde yoksa PDF_TRACKING_UNVERIFIED, tutar yoksa PDF_AMOUNT_UNVERIFIED; yalnız bayraklı satırlar, sırayla', () => {
    const r = checkPdfLines(
      ['794812345305 999,99'],
      [
        { rowIndex: 3, trackingNo: '794812345399', netAmount: 10 },
        ...lines,
      ],
    );
    expect(r.checked).toBe(3);
    expect(r.rows).toEqual([
      { rowIndex: 0, codes: ['PDF_AMOUNT_UNVERIFIED'] },
      { rowIndex: 1, codes: ['PDF_TRACKING_UNVERIFIED', 'PDF_AMOUNT_UNVERIFIED'] },
      { rowIndex: 3, codes: ['PDF_TRACKING_UNVERIFIED', 'PDF_AMOUNT_UNVERIFIED'] },
    ]);
  });

  it('KDV dahil yazılmış tutar (× 1,2, ±0,01) bulunur; ±0,02 bulunmaz; başka çarpan verilebilir', () => {
    const l = [{ rowIndex: 0, trackingNo: '794812345305', netAmount: 37.43 }]; // × 1,2 = 44,916 → 44,92
    expect(checkPdfLines(['794812345305 44,92'], l).rows).toEqual([]);
    expect(checkPdfLines(['794812345305 44,91'], l).rows).toEqual([]);
    expect(checkPdfLines(['794812345305 44,93'], l).rows).toEqual([]);
    expect(checkPdfLines(['794812345305 44,94'], l).rows[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    // net tutarın kendisinde pay yok
    expect(checkPdfLines(['794812345305 37,44'], l).rows[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    expect(checkPdfLines(['794812345305 41,17'], l, { vatFactors: [1.1] }).rows).toEqual([]);
    expect(checkPdfLines(['794812345305 44,92'], l, { vatFactors: [1.1] }).rows[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });

  it('tutar adayı yalnız iki ondalıklı sayı: "1.234" ne 1234 ne 1,23; "1.234,00" 1234; "12.50" 12,5', () => {
    const one = (text: string, netAmount: number) => checkPdfLines([text], [{ rowIndex: 0, trackingNo: '794812345305', netAmount }]).rows;
    expect(one('794812345305 1.234', 1234)[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    expect(one('794812345305 1.234', 1.23)[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    expect(one('794812345305 1.234,00', 1234)).toEqual([]);
    expect(one('794812345305 1,234.00', 1234)).toEqual([]);
    expect(one('794812345305 12.50', 12.5)).toEqual([]);
    expect(one('794812345305 12,5', 12.5)[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    // tam sayı gibi okunan tutar metinde iki ondalıkla aranır
    expect(one('794812345305 120,00', 120)).toEqual([]);
    expect(one('794812345305 120', 120)[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });

  it('iade satırı: işaret dikkate alınmaz ("-12,50", "(12,50)")', () => {
    const l = [{ rowIndex: 0, trackingNo: '794812345305', netAmount: -12.5 }];
    expect(checkPdfLines(['794812345305 -12,50'], l).rows).toEqual([]);
    expect(checkPdfLines(['794812345305 (12,50)'], l).rows).toEqual([]);
  });

  it('FedEx 34 haneli barkod satırı: son 12 hane metinde aranır', () => {
    const long = '9622001900000000000000794812345305';
    expect(checkPdfLines(['Tracking 794812345305 10,00'], [{ rowIndex: 0, trackingNo: long, netAmount: 10 }]).rows).toEqual([]);
  });

  it('tarih ve sayfa numarası tutar sanılmaz', () => {
    const l = [{ rowIndex: 0, trackingNo: '794812345305', netAmount: 21.1 }];
    expect(checkPdfLines(['794812345305 21.10.2026'], l).rows[0]!.codes).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });
});

describe('checkPdfLines: yanlış güven (R2)', () => {
  const page = [
    'FATURA 9-482-11735 Tarih 20.10.2026 Sayfa 1',
    'Takip No          Desi  Tutar',
    '794812345305      12    1.642,50',
    '794812345306      3     250,00',
    '794812345307      2     100,00',
    'Ref 1234567890',
  ].join('\n');
  const one = (trackingNo: string, netAmount: number, texts = [page]) => checkPdfLines(texts, [{ rowIndex: 0, trackingNo, netAmount }]).rows[0]?.codes ?? [];

  it('desi ile aynı tam sayı tutar ("12") bulunmuş sayılmaz', () => {
    expect(one('794812345305', 12)).toEqual(['PDF_AMOUNT_UNVERIFIED']);
  });

  it('kısa takip no ("4567") uzun bir numaranın içinde bulunmuş sayılmaz; bağımsız parça olarak bulunur', () => {
    expect(one('4567', 100)).toContain('PDF_TRACKING_UNVERIFIED');
    expect(one('4567', 10, ['Gönderi 4567 tutar 10,00'])).toEqual([]);
    expect(one('4567', 10, ['Gönderi (4567) tutar 10,00'])).toEqual([]);
    expect(one('AB-123', 10, ['Gönderi AB-123 tutar 10,00'])).toEqual([]);
  });

  it('tarihteki "2026" ne takip no ne tutar sayılır', () => {
    expect(one('2026', 2026)).toEqual(['PDF_TRACKING_UNVERIFIED', 'PDF_AMOUNT_UNVERIFIED']);
  });

  it('alt satırın tutarı bu satırınki sayılmaz (yakınlık: takip no satırı ve izleyen satırlar, sonraki takip no\'ya kadar)', () => {
    // yapay zekâ 1. satıra 2. satırın, 2. satıra 3. satırın tutarını yazdı (satırlar birlikte denetlenir)
    const shifted = checkPdfLines([page], [
      { rowIndex: 0, trackingNo: '794812345305', netAmount: 250 },
      { rowIndex: 1, trackingNo: '794812345306', netAmount: 100 },
      { rowIndex: 2, trackingNo: '794812345307', netAmount: 100 },
    ]);
    expect(shifted.rows).toEqual([
      { rowIndex: 0, codes: ['PDF_AMOUNT_UNVERIFIED'] },
      { rowIndex: 1, codes: ['PDF_AMOUNT_UNVERIFIED'] },
    ]);
    // kendi satırındaki tutar bulunur
    expect(one('794812345306', 250)).toEqual([]);
    // çok satırlı satır: tutar takip no'dan sonraki satırlarda (en çok 3) olabilir
    const multi = ['794812345305 Express', 'Almanya', 'Ağırlık 4 kg', 'Tutar 1.642,50', 'Dip not'].join('\n');
    expect(one('794812345305', 1642.5, [multi])).toEqual([]);
    const far = ['794812345305 Express', 'a', 'b', 'c', 'Tutar 1.642,50'].join('\n');
    expect(one('794812345305', 1642.5, [far])).toEqual(['PDF_AMOUNT_UNVERIFIED']);
    // satır sonu yoksa (tek satırlık sayfa) sayfa düzeyi
    expect(one('794812345307', 1642.5, [page.replace(/\n/g, ' ')])).toEqual([]);
  });

  it('gerçek biçimli doğru satırlar bayrak almaz: TR, EN, KDV dahil, takip no bölünmüş', () => {
    const lines = [
      { rowIndex: 0, trackingNo: '794812345305', netAmount: 1642.5 },
      { rowIndex: 1, trackingNo: '794812345306', netAmount: 250 },
      { rowIndex: 2, trackingNo: '794812345307', netAmount: 100 },
    ];
    expect(checkPdfLines([page], lines).rows).toEqual([]);
    const en = ['Tracking        Weight  Amount', '7948 1234 5305  12      1,642.50', '794812345306    3       250.00', '794812345307    2       100.00'].join('\n');
    expect(checkPdfLines([en], lines).rows).toEqual([]);
    // KDV dahil basılmış (× 1,2): 1.971,00 · 300,00 · 120,00
    const vat = ['794812345305 1.971,00', '794812345306 300,00', '794812345307 120,00'].join('\n');
    expect(checkPdfLines([vat], lines).rows).toEqual([]);
    // satırlar ayrı sayfalarda
    expect(checkPdfLines(vat.split('\n'), lines).rows).toEqual([]);
  });
});

describe('PDF satır bayrakları', () => {
  it('sert bayraktır, yumuşak değildir; TR ve EN etiketi var', () => {
    for (const c of ['PDF_TRACKING_UNVERIFIED', 'PDF_AMOUNT_UNVERIFIED'] as const) {
      expect(HARD_ROW_FLAGS).toContain(c);
      expect(SOFT_ROW_FLAGS).not.toContain(c);
      expect(hardFlags([c])).toEqual([c]);
      expect(ROW_FLAG_LABELS[c]).toBe(rowFlagLabel(c, 'tr'));
      expect(rowFlagLabel(c, 'en')).not.toBe(rowFlagLabel(c, 'tr'));
      expect(rowFlagLabel(c, 'en')).not.toContain('verify.flag');
    }
    expect(rowFlagLabel('PDF_TRACKING_UNVERIFIED', 'tr')).toBe('Takip no PDF metninde bulunamadı');
    expect(rowFlagLabel('PDF_AMOUNT_UNVERIFIED', 'en')).toBe('Net amount not found in the PDF text');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// overchargeReconciliation: değişmez kural
// ---------------------------------------------------------------------------------------------------------------------

/** API `lib/util.ts` `sum` ile aynı. */
const apiSum = (values: number[]) => Math.round(values.reduce((a, b) => a + Math.round(b * 100), 0)) / 100;

/** API `services/compare.ts` `computeTotals.overchargeTotal` (+ `countsAsOvercharge`) birebir kopyası; DOKUNULMAZ kural. */
function apiOverchargeTotal(lines: ReconLineInput[]): number {
  const counts = (l: ReconLineInput) => l.status === 'DIFF' && l.decision !== 'ACCEPTED' && !l.estimated;
  const diffPositive = (l: ReconLineInput) => Math.max(0, l.diffAmount ?? 0);
  return apiSum(lines.filter(counts).map(diffPositive));
}

/** Özet kutusundaki Faturalanan − Beklenen (karşılaştırılan satırlar; fark = faturalanan − beklenen). */
const netDiffOf = (lines: ReconLineInput[]) => apiSum(lines.filter((l) => l.expectedAmount != null).map((l) => l.diffAmount ?? 0));

function assertInvariant(lines: ReconLineInput[]) {
  const r = overchargeReconciliation(lines);
  const api = apiOverchargeTotal(lines);
  const stepCents = r.reconciliation.steps.reduce((a, s) => a + toCents(s.amount), 0);
  const typeCents = r.overchargeByType.reduce((a, s) => a + toCents(s.amount), 0);
  expect(toCents(r.reconciliation.overchargeTotal)).toBe(toCents(api));
  expect(stepCents).toBe(toCents(api));
  expect(typeCents).toBe(toCents(api));
  expect(r.reconciliation.steps[0]!.key).toBe('netDiff');
  expect(toCents(r.reconciliation.steps[0]!.amount)).toBe(toCents(netDiffOf(lines)));
  return r;
}

const L = (o: Partial<ReconLineInput> & Pick<ReconLineInput, 'status'>): ReconLineInput => ({
  decision: 'OPEN',
  expectedAmount: 100,
  diffAmount: 0,
  diffTypes: [],
  estimated: false,
  ...o,
});

describe('overchargeReconciliation', () => {
  it('karışık fatura: adımlar, türler ve toplam', () => {
    const lines: ReconLineInput[] = [
      L({ status: 'MATCH', diffAmount: 0.4 }),
      L({ status: 'MATCH', diffAmount: -0.3 }),
      L({ status: 'MATCH', diffAmount: -25 }), // lehe, uyumlu: tolerans değil, "lehinize" adımına
      L({ status: 'DIFF', diffAmount: 458.5, diffTypes: ['DIMENSION', 'WEIGHT'] }),
      L({ status: 'DIFF', diffAmount: 56.3, diffTypes: ['PRICE'] }),
      L({ status: 'DIFF', diffAmount: -12, diffTypes: ['SURCHARGE'] }), // lehe fark satırı
      L({ status: 'DIFF', diffAmount: 412, diffTypes: ['SURCHARGE'] }),
      L({ status: 'DIFF', diffAmount: 30, diffTypes: ['WEIGHT'], decision: 'ACCEPTED' }),
      L({ status: 'DIFF', diffAmount: 80, diffTypes: ['PRICE'], estimated: true }),
      L({ status: 'DIFF', diffAmount: 1120, expectedAmount: null, diffTypes: ['DUPLICATE'], decision: 'VERIFIED' }),
      L({ status: 'DIFF', diffAmount: 300, expectedAmount: null, diffTypes: ['DUPLICATE'], estimated: true }),
      L({ status: 'UNMATCHED', diffAmount: null, expectedAmount: null }),
      L({ status: 'NO_TARIFF', diffAmount: null, expectedAmount: null }),
    ];
    const r = assertInvariant(lines);
    expect(r.reconciliation.overchargeTotal).toBe(2046.8);
    expect(r.reconciliation.steps).toEqual([
      { key: 'netDiff', amount: 999.9, lines: 9 },
      // İncele (tahmini) mükerrer de Faturalanan'a girer ve "İncele" adımında geri çıkar: 1120 + 300, 80 + 300
      { key: 'uncompared', amount: 1420, lines: 2 },
      { key: 'matchLines', amount: -0.4, lines: 1 },
      { key: 'accepted', amount: -30, lines: 1 },
      { key: 'review', amount: -380, lines: 2 },
      { key: 'favourable', amount: 37.3, lines: 3 },
    ]);
    expect(r.overchargeByType).toEqual([
      { type: 'DUPLICATE', lines: 1, amount: 1120 },
      { type: 'DIMENSION', lines: 1, amount: 458.5 },
      { type: 'SURCHARGE', lines: 2, amount: 412 },
      { type: 'PRICE', lines: 1, amount: 56.3 },
    ]);
  });

  it('boş fatura: yalnız netDiff 0, toplam 0, tür yok', () => {
    const r = assertInvariant([]);
    expect(r).toEqual({ reconciliation: { steps: [{ key: 'netDiff', amount: 0, lines: 0 }], overchargeTotal: 0 }, overchargeByType: [] });
  });

  it('uyumlu satırın eksi farkı tolerans sayılmaz, lehinize adımına düşer (faturalanan 750, beklenen 1000)', () => {
    const r = assertInvariant([
      L({ status: 'MATCH', expectedAmount: 1000, diffAmount: -250 }),
      L({ status: 'DIFF', diffAmount: 100, diffTypes: ['PRICE'] }),
    ]);
    expect(r.reconciliation.steps).toEqual([
      { key: 'netDiff', amount: -150, lines: 2 },
      { key: 'favourable', amount: 250, lines: 1 },
    ]);
    expect(r.reconciliation.steps.some((s) => s.key === 'matchLines')).toBe(false);
    expect(r.reconciliation.overchargeTotal).toBe(100);
    expect(r.overchargeByType).toEqual([{ type: 'PRICE', lines: 1, amount: 100 }]);
  });

  it('uyumlu satırda fark 0: hiçbir adıma satır yazmaz', () => {
    const r = assertInvariant([L({ status: 'MATCH', diffAmount: 0 }), L({ status: 'MATCH', diffAmount: 0.3 })]);
    expect(r.reconciliation.steps).toEqual([
      { key: 'netDiff', amount: 0.3, lines: 2 },
      { key: 'matchLines', amount: -0.3, lines: 1 },
    ]);
  });

  it('yalnız uyumlu satırlar: netDiff ve matchLines birbirini sıfırlar', () => {
    const r = assertInvariant([L({ status: 'MATCH', diffAmount: 0.1 }), L({ status: 'MATCH', diffAmount: 0.2 })]);
    expect(r.reconciliation.steps).toEqual([
      { key: 'netDiff', amount: 0.3, lines: 2 },
      { key: 'matchLines', amount: -0.3, lines: 2 },
    ]);
    expect(r.reconciliation.overchargeTotal).toBe(0);
  });

  it('beklenen tutarı olan ama uyumlu/fark olmayan satır "other" adımına düşer', () => {
    const r = assertInvariant([L({ status: 'NO_TARIFF', diffAmount: 7 }), L({ status: 'DIFF', diffAmount: 5, diffTypes: ['PRICE'] })]);
    expect(r.reconciliation.steps).toEqual([
      { key: 'netDiff', amount: 12, lines: 2 },
      { key: 'other', amount: -7, lines: 1 },
    ]);
  });

  it('türler Pano gibi: ilk fark türü, sıfır tutarlı satır da sayılır, büyükten küçüğe; türsüz satır PRICE', () => {
    const r = assertInvariant([
      L({ status: 'DIFF', diffAmount: 10, diffTypes: ['WEIGHT', 'DIMENSION'] }),
      L({ status: 'DIFF', diffAmount: -4, diffTypes: ['WEIGHT'] }),
      L({ status: 'DIFF', diffAmount: 20, diffTypes: ['DIMENSION'] }),
      L({ status: 'DIFF', diffAmount: 3, diffTypes: [] }),
    ]);
    expect(r.overchargeByType).toEqual([
      { type: 'DIMENSION', lines: 1, amount: 20 },
      { type: 'WEIGHT', lines: 2, amount: 10 },
      { type: 'PRICE', lines: 1, amount: 3 },
    ]);
  });

  it('kayan nokta tuzakları (0,1 + 0,2, 1,005) kuruşu kuruşuna', () => {
    const vals = [0.1, 0.2, 0.7, 1.15, 2.675, 1234.565, 0.01, 99999.99];
    const lines = vals.flatMap((v, i) => [
      L({ status: 'DIFF', diffAmount: v, diffTypes: ['PRICE'], expectedAmount: i % 2 ? null : 10 }),
      L({ status: 'MATCH', diffAmount: -v / 10 }),
    ]);
    assertInvariant(lines.map((l) => ({ ...l, diffAmount: l.diffAmount == null ? null : Math.round(l.diffAmount * 100) / 100 })));
  });

  it('rastgele 2.000 fatura (sabit tohum): değişmez kural her karışımda tutar', () => {
    let seed = 20261112;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const statuses = ['MATCH', 'DIFF', 'DIFF', 'DIFF', 'UNMATCHED', 'NO_TARIFF'] as const;
    const decisions = ['OPEN', 'VERIFIED', 'ACCEPTED', 'OPEN'] as const;
    const types = ['DUPLICATE', 'DIMENSION', 'WEIGHT', 'SURCHARGE', 'PRICE'] as const;
    for (let n = 0; n < 2000; n++) {
      const count = Math.floor(rnd() * 40);
      const lines: ReconLineInput[] = [];
      for (let i = 0; i < count; i++) {
        const status = pick(statuses);
        const dup = status === 'DIFF' && rnd() < 0.15;
        const cents = Math.round((rnd() - 0.3) * 200000);
        const compared = status === 'MATCH' || (status === 'DIFF' && !dup) || rnd() < 0.05;
        lines.push({
          status,
          decision: pick(decisions),
          expectedAmount: compared ? Math.round(rnd() * 500000) / 100 : null,
          diffAmount: status === 'UNMATCHED' && rnd() < 0.8 ? null : cents / 100,
          diffTypes: status === 'DIFF' ? (dup ? ['DUPLICATE'] : [pick(types), ...(rnd() < 0.3 ? [pick(types)] : [])]) : [],
          estimated: rnd() < 0.2,
        });
      }
      assertInvariant(lines);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// İtiraz metni: kanıt satırları
// ---------------------------------------------------------------------------------------------------------------------

const evLine = (over: Partial<DisputeLine> = {}): DisputeLine => ({
  trackingNo: '794812345305',
  shipDate: '2026-10-22',
  diffTypes: ['DIMENSION'],
  decision: 'VERIFIED',
  ourDims: { l: 40, w: 30, h: 25 },
  ourActualKg: 4,
  ourChargeableKg: 6,
  billedDims: { l: 45, w: 35, h: 30 },
  billedChargeableKg: 9.5,
  expectedAmount: 1184,
  billedAmount: 1642.5,
  diffAmount: 458.5,
  evidence: { measuredAtLocal: '2026-10-21 14:32', dimMethod: 'LIDAR', weightMethod: 'OCR', photoCount: 2 },
  ...over,
});

const dispute = (lines: DisputeLine[], lang: 'tr' | 'en' = 'tr'): ReturnType<typeof buildDisputeText> => {
  const input: DisputeInput = {
    company: { name: 'Demo İhracat', contactName: 'Elif Kaya' },
    carrier: { name: 'FedEx' },
    invoice: { invoiceNo: '9-482-11735', currency: 'TRY' },
    lines,
    lang,
  };
  return buildDisputeText(input);
};

describe('buildDisputeText: kanıt', () => {
  it('TR: ölçüm kaydı (zaman, rol, yöntem) ve fotoğraf satırı, ölçümümüzün hemen altında', () => {
    const r = dispute([evLine()]);
    const lines = r.body.split('\n');
    const ours = lines.findIndex((x) => x.includes('Bizim ölçümümüz'));
    expect(lines[ours + 1]).toBe('   Ölçüm kaydımız: 21.10.2026 14:32 · depo çalışanımız tarafından · ölçü: LiDAR, ağırlık: terazi ekranından okundu');
    expect(lines[ours + 2]).toBe('   Fotoğraf: 2');
    expect(r.photoCount).toBe(2);
    expect(r.body).not.toMatch(/\{[a-z]+\}/);
  });

  it('EN: tarih ay adıyla, rol İngilizce', () => {
    const r = dispute([evLine({ evidence: { measuredAtLocal: '2026-10-21 09:05', dimMethod: 'MANUAL', weightMethod: 'MANUAL', photoCount: 1 } })], 'en');
    expect(r.body).toContain('   Our measurement record: Oct 21, 2026 09:05 · by our warehouse staff · dimensions: manual (tape measure), weight: entered manually');
    expect(r.body).toContain('   Photos: 1');
    expect(r.body).toContain('Our measurement photos (1) are in the attached ZIP file. We kindly ask you to issue a credit note for the amounts above.');
    expect(r.body).not.toContain('available on request');
  });

  it('fotoğraf varsa kapanış: ek cümlesi, "talep etmeniz hâlinde" yok; toplam fotoğraf sayısı', () => {
    const r = dispute([
      evLine(),
      evLine({ trackingNo: '794812345306', evidence: { measuredAtLocal: '2026-10-21 15:00', dimMethod: 'AR', weightMethod: 'OCR', photoCount: 3 } }),
    ]);
    expect(r.photoCount).toBe(5);
    expect(r.body).toContain('Ölçüm fotoğraflarımız (5 adet) ekteki ZIP dosyasındadır. Yukarıdaki tutarlar için alacak dekontu düzenlenmesini rica ederiz.');
    expect(r.body).not.toContain('talep etmeniz hâlinde');
  });

  it('fotoğrafsız kanıt: kayıt satırı var, fotoğraf satırı yok, kapanış eskisi gibi', () => {
    const r = dispute([evLine({ evidence: { measuredAtLocal: '2026-10-21 14:32', dimMethod: 'PRESET', weightMethod: 'MANUAL', photoCount: 0 } })]);
    expect(r.body).toContain('ölçü: hazır koli ölçüsü, ağırlık: elle girildi');
    expect(r.body).not.toContain('Fotoğraf:');
    expect(r.body).toContain('Ölçüm fotoğraflarımızı talep etmeniz hâlinde iletebiliriz.');
    expect(r.body).not.toContain('ZIP');
    expect(r.photoCount).toBe(0);
  });

  it('kanıtsız satır: metin değişmez (null ya da yok)', () => {
    const plain = dispute([evLine({ evidence: undefined })]);
    expect(dispute([evLine({ evidence: null })]).body).toBe(plain.body);
    expect(plain.body).not.toContain('Ölçüm kaydımız');
    expect(plain.photoCount).toBe(0);
  });

  it('mükerrer satırda kanıt ve fotoğraf yazılmaz, sayılmaz', () => {
    const r = dispute([
      evLine({ trackingNo: '794812345288', diffTypes: ['DUPLICATE'], expectedAmount: null, billedAmount: 1120, diffAmount: 1120, ourDims: null, ourChargeableKg: null }),
    ]);
    expect(r.lineCount).toBe(1);
    expect(r.body).not.toContain('Ölçüm kaydımız');
    expect(r.body).not.toContain('Fotoğraf:');
    expect(r.photoCount).toBe(0);
    expect(r.body).toContain('talep etmeniz hâlinde');
  });

  it('listeye girmeyen satırın (OPEN) fotoğrafı sayılmaz', () => {
    const r = dispute([evLine(), evLine({ trackingNo: '794812345399', decision: 'OPEN' })]);
    expect(r.lineCount).toBe(1);
    expect(r.photoCount).toBe(2);
  });

  it('ölçen kişinin adı metne girmez (alan gelse bile)', () => {
    const withName = evLine({ evidence: { measuredAtLocal: '2026-10-21 14:32', dimMethod: 'REFERENCE', weightMethod: 'OCR', photoCount: 1, measuredBy: 'Ahmet Yılmaz' } as never });
    for (const lang of ['tr', 'en'] as const) {
      const r = dispute([withName], lang);
      expect(r.body).not.toContain('Ahmet');
      expect(r.subject).not.toContain('Ahmet');
    }
    expect(dispute([withName]).body).toContain('depo çalışanımız tarafından · ölçü: referans kartı');
  });

  it('beklenmeyen zaman biçimi olduğu gibi yazılır', () => {
    const r = dispute([evLine({ evidence: { measuredAtLocal: 'dün akşam', dimMethod: 'LIDAR', weightMethod: 'OCR', photoCount: 0 } })]);
    expect(r.body).toContain('Ölçüm kaydımız: dün akşam ·');
  });
});
