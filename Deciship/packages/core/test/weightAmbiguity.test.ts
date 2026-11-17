// K36 (kullanıcı kararı 2026-11-14): faturada "1.500" ağırlık 1,5 kg da 1500 kg da olabilir. Dosyanın sayı biçimi
// anlaşılamıyorsa sessizce seçilmez: okuma kontrolü sorar, eşleme ekranı biçimi sordurur; seçim bütün dosyaya uygulanır.
import { describe, expect, it } from 'vitest';
import { mappingDiagnostics, parseRows, tableWeightAmbiguity, verifyMapping, type ColumnMapping, type Table } from '../src/invoice';

const table = (amounts: string[], weights: string[], numeric?: Uint8Array): Table => ({
  headers: ['Takip', 'Tutar', 'Kg'],
  rows: weights.map((w, i) => [`TRK${1000 + i}`, amounts[i] ?? '100', w]),
  ...(numeric ? { numeric } : {}),
});
const mapping = (over: Partial<ColumnMapping> = {}) =>
  ({
    trackingNo: 'Takip',
    netAmount: 'Tutar',
    actualKg: 'Kg',
    surchargeColumns: [],
    amountsIncludeVat: false,
    vatPct: 20,
    desiAsWeight: false,
    ...over,
  }) as ColumnMapping;
const ISSUE = /Ağırlık yazımı belli değil: "1\.500" 1,5 kg de olabilir 1\.500 kg de \(2 satır\)/;

describe('K36 faturada "1.500" ağırlık', () => {
  it('biçim belli değilken sorulur: tanı soruyu verir, okuma kontrolü onay ister', () => {
    const t = table(['100', '200', '300'], ['1.500', '2', '1.500']);
    const d = mappingDiagnostics(t, mapping());
    expect(d.numberFormat).toBe('auto');
    expect(d.weightAmbiguity).toEqual({ sample: '1.500', rows: 2, decimal: 1.5, thousands: 1500 });
    expect(d.verification.verdict).toBe('check');
    expect(d.verification.issues.join()).toMatch(ISSUE);
    expect(mappingDiagnostics(t, mapping(), { locale: 'en' }).verification.issues.join()).toMatch(/"1\.500" could be 1\.5 kg or 1,500 kg \(2 rows\)/);
  });

  it.each([
    ['en', 1.5],
    ['tr', 1500],
  ] as const)('ağırlık seçilince (%s) sorun kalkar, seçim okumaya uygulanır, soru seçili hâliyle kalır', (fmt, kg) => {
    const t = table(['100', '200'], ['1.500', '2']);
    const m = mapping({ weightFormat: fmt });
    const d = mappingDiagnostics(t, m);
    expect(d.verification.issues.join()).not.toMatch(/Ağırlık yazımı/);
    expect(d.weightAmbiguity).toBeTruthy();
    expect(parseRows(t, m).lines[0]!.actualKg).toBe(kg);
    expect(verifyMapping(t, m).issues.join()).not.toMatch(/Ağırlık yazımı/);
  });

  it('biçim dosyadan belliyse sorulmaz (Türkçe tutar "1.234,56" → 1500 kg; İngilizce "1,234.56" → 1,5 kg)', () => {
    const tr = table(['1.234,56', '12,50'], ['1.500', '2']);
    expect(tableWeightAmbiguity(tr, mapping())).toBeNull();
    expect(mappingDiagnostics(tr, mapping()).verification.issues.join()).not.toMatch(/Ağırlık yazımı/);
    expect(parseRows(tr, mapping()).lines[0]!.actualKg).toBe(1500);
    const en = table(['1,234.56', '12.50'], ['1.500', '2']);
    expect(tableWeightAmbiguity(en, mapping())).toBeNull();
    expect(parseRows(en, mapping()).lines[0]!.actualKg).toBe(1.5);
  });

  it('belirsiz olmayan yazımlar sorulmaz ve okuması değişmez ("1,500", "1500", "1.5")', () => {
    const t = table(['100', '200', '300'], ['1,500', '1500', '1.5']);
    expect(tableWeightAmbiguity(t, mapping())).toBeNull();
    expect(mappingDiagnostics(t, mapping()).verification.issues.join()).not.toMatch(/Ağırlık yazımı/);
  });

  it('XLSX gerçek sayı hücresi belirsiz değildir', () => {
    // XLSX okuyucusu gerçek sayıyı ondalık virgülle yazar; burada metin "1.500" kalsa da hücre sayıdır
    const t = table(['100', '200'], ['1.500', '2'], Uint8Array.from([0, 0, 1, 0, 0, 1]));
    expect(tableWeightAmbiguity(t, mapping())).toBeNull();
  });

  it('ücretli ağırlık sütunu da sayılır; ağırlık sütunu eşlenmemişse soru yok', () => {
    const t: Table = { headers: ['Takip', 'Tutar', 'Desi'], rows: [['TRK1', '100', '12.000']] };
    expect(tableWeightAmbiguity(t, mapping({ actualKg: undefined, billedKg: 'Desi' }))).toEqual({ sample: '12.000', rows: 1, decimal: 12, thousands: 12000 });
    expect(tableWeightAmbiguity(t, mapping({ actualKg: undefined }))).toBeNull();
  });
});

// İnceleme (para): ağırlık seçimi dosyanın sayı biçimi değildir; tutarları ve öbür sütunları değiştirmez.
describe('K36: ağırlık seçimi yalnız ağırlık hücrelerine', () => {
  const tr = () => table(['1.234,56', '125,50', '980,00'], ['0.5', '1.500', '2.25']);

  it('Türkçe tutarlı karışık dosya: "1,5 kg" seçilince net tutar 1234,56 kalır (1,23 değil)', () => {
    const t = tr();
    expect(mappingDiagnostics(t, mapping()).weightAmbiguity).toMatchObject({ sample: '1.500', rows: 1 });
    for (const [weightFormat, kg] of [
      ['en', 1.5],
      ['tr', 1500],
    ] as const) {
      const lines = parseRows(t, mapping({ weightFormat })).lines;
      expect(lines.map((l) => l.netAmount)).toEqual([1234.56, 125.5, 980]);
      expect(lines.map((l) => l.actualKg)).toEqual([0.5, kg, 2.25]);
    }
    // seçimsiz okuma (eski yol) tutarları da aynı okur: seçim tutara hiç dokunmaz
    expect(parseRows(t, mapping()).lines.map((l) => l.netAmount)).toEqual([1234.56, 125.5, 980]);
  });

  it('sayı biçimi ipucu (yapay zekâ ya da kayıtlı eşleme) soruyu cevaplamaz', () => {
    const t = table(['100', '200'], ['1.500', '2']);
    for (const numberFormat of ['tr', 'en'] as const) {
      const d = mappingDiagnostics(t, mapping({ numberFormat }));
      expect(d.weightAmbiguity).toBeTruthy();
      expect(d.verification.issues.join()).toMatch(/Ağırlık yazımı belli değil/);
    }
  });

  it('biçim kanıtla belli dosyada seçim yok sayılır (eski okuma)', () => {
    const t = table(['1.234,56', '12,50'], ['1.500', '2']);
    expect(parseRows(t, mapping({ weightFormat: 'en' })).lines[0]!.actualKg).toBe(1500);
  });

  it('ücretli ağırlık da seçimle okunur; XLSX gerçek sayı hücresi seçimden etkilenmez', () => {
    const t: Table = { headers: ['Takip', 'Tutar', 'Kg', 'Desi'], rows: [['TRK1', '100', '1.500', '12.000']], numeric: Uint8Array.from([0, 0, 1, 0]) };
    const l = parseRows(t, mapping({ billedKg: 'Desi', weightFormat: 'en' })).lines[0]!;
    expect(l.billedKg).toBe(12);
    expect(l.actualKg).toBe(1.5); // gerçek sayı hücresi: metni okuyucunun yazımı, seçim uygulanmaz
  });
});

// İkinci doğrulama: "1.500 lb" K36 öncesi okunmuyordu (null); seçim onu kg olarak okumaz.
describe('K36: başka birimli ağırlık hücresi eskisi gibi', () => {
  it('"1.500 lb" belirsiz sayılmaz ve seçimle kg okunmaz; "1.500 kg" seçimle okunur', () => {
    const lb = table(['100', '200'], ['1.500 lb', '2']);
    expect(tableWeightAmbiguity(lb, mapping())).toBeNull();
    const before = parseRows(lb, mapping()).lines[0]!.actualKg;
    expect(parseRows(lb, mapping({ weightFormat: 'en' })).lines[0]!.actualKg).toBe(before);
    expect(before).toBeUndefined();
    const kg = table(['100', '200'], ['1.500 kg', '2']);
    expect(tableWeightAmbiguity(kg, mapping())).toMatchObject({ sample: '1.500 kg', decimal: 1.5, thousands: 1500 });
    expect(parseRows(kg, mapping({ weightFormat: 'en' })).lines[0]!.actualKg).toBe(1.5);
  });
});

// Kullanıcı kararı 2026-11-14: biçim kanıtı olmayan dosyada virgüllü "1,500" de iki türlü okunur (eskiden sessizce 1,5).
describe('K36: dosyada "1,500" ağırlık', () => {
  it('kanıtsız dosyada sorulur; seçim yalnız ağırlığa, tutarlar değişmez', () => {
    const t = table(['100', '200'], ['1,500', '2']);
    expect(tableWeightAmbiguity(t, mapping())).toEqual({ sample: '1,500', rows: 1, decimal: 1.5, thousands: 1500 });
    expect(mappingDiagnostics(t, mapping()).verification.issues.join()).toMatch(/Ağırlık yazımı belli değil: "1,500"/);
    expect(parseRows(t, mapping({ weightFormat: 'tr' })).lines.map((l) => [l.netAmount, l.actualKg])).toEqual([
      [100, 1.5],
      [200, 2],
    ]);
    expect(parseRows(t, mapping({ weightFormat: 'en' })).lines[0]!.actualKg).toBe(1500);
  });

  it('kanıtlı dosyada sorulmaz: Türkçe tutarlarla 1,5 kg, İngilizce tutarlarla 1500 kg (eskisi gibi)', () => {
    const tr = table(['1.234,56', '12,50'], ['1,500', '2']);
    expect(tableWeightAmbiguity(tr, mapping())).toBeNull();
    expect(parseRows(tr, mapping()).lines[0]!.actualKg).toBe(1.5);
    const en = table(['1,234.56', '12.50'], ['1,500', '2']);
    expect(tableWeightAmbiguity(en, mapping())).toBeNull();
    expect(parseRows(en, mapping()).lines[0]!.actualKg).toBe(1500);
  });
});

// İnceleme: seçim ağırlık sütununun YAZIM biçimidir; aynı dosyadaki "1.500" ve "1,500" her biri kendi ayırıcısıyla okunur.
describe('K36: dosyada iki yazım birlikte', () => {
  it('soru iki örneği de gösterir; Türkçe yazım "1.500"=1500, "1,500"=1,5; İngilizce tersi (ikisi aynı sayı olmaz)', () => {
    const t = table(['100', '200', '300'], ['1.500', '1,500', '2']);
    expect(tableWeightAmbiguity(t, mapping())).toEqual({ sample: '1.500', rows: 2, decimal: 1.5, thousands: 1500, other: '1,500' });
    expect(parseRows(t, mapping({ weightFormat: 'tr' })).lines.map((l) => l.actualKg)).toEqual([1500, 1.5, 2]);
    expect(parseRows(t, mapping({ weightFormat: 'en' })).lines.map((l) => l.actualKg)).toEqual([1.5, 1500, 2]);
    expect(parseRows(t, mapping({ weightFormat: 'en' })).lines.map((l) => l.netAmount)).toEqual([100, 200, 300]);
  });
});
