/**
 * Yurt içi tek fiyat sütunlu listeler ("Desi | Ücret"), ISO-3 ülke kodları ve son satırdan sonraki "İlave" (aşım).
 * Tüm sayılar uydurmadır; yapı Türk kargo firmalarının herkese açık desi listelerine benzer
 * ("Dosya" satırı, 1…N desi, "30 desi üzeri her desi", KDV hariç/dahil iki sütun, "+" satırı).
 */
import { describe, expect, it } from 'vitest';
import {
  countryNameToIso2,
  expectedCharge,
  importWeightSteps,
  iso3ToIso2,
  parseTariffImport,
  scanPdfLayout,
  type PdfCodeSection,
  type PdfTextItem,
  type TariffInput,
} from '../src/index';

const H = 8;
const at = (y: number, cells: [number, string][]): PdfTextItem[] => cells.map(([x, str]) => ({ str, x, y, w: str.length * 4, h: H }));

/** Satır satır sayfa: her satır [x, metin] hücreleri. */
function page(lines: [number, string][][]): PdfTextItem[] {
  return lines.flatMap((cells, i) => at(780 - i * 12, cells));
}

/** buildPdfImport'un yaptığı gibi bölüm tablosunu içe aktarma sayfasına çevirir. */
function sheetOf(s: PdfCodeSection): string[][] {
  return [
    ['Ağırlık (kg)', ...s.table.zones],
    ...s.table.rows.map((r) => [r.kind === 'additional' ? `İlave ${r.step} kg` : String(r.weight), ...r.cells]),
  ];
}

// Aras/MNG tipi: "Desi/Kg | Fiyat (TL)", Dosya satırı, 1…30, "30 desi üzeri her desi için"
const arasLike = page([
  [[60, 'ORNEK KARGO 2026 YURT İÇİ STANDART DESİ FİYAT LİSTESİ']],
  [[60, 'Fiyatlara KDV dahil değildir.']],
  [[60, 'Desi/Kg'], [190, 'Fiyat (TL)']],
  [[60, 'Dosya'], [200, '81,40']],
  [[60, '1'], [200, '96,10']],
  [[60, '2'], [200, '104,30']],
  [[60, '3'], [200, '112,50']],
  [[60, '5'], [200, '128,90']],
  [[60, '10'], [200, '170,00']],
  [[60, '20'], [200, '262,60']],
  [[60, '30'], [200, '355,20']],
  [[60, '30 desi üzeri her desi için'], [200, '11,70']],
  [[60, 'Ek hizmetler ve koşullar için www.ornek.com']],
]);

describe('PDF (kodla): yurt içi tek fiyat sütunlu desi listesi', () => {
  const scan = scanPdfLayout([{ items: arasLike }]);
  const s = scan.sections[0]!;

  it('tek bölgeli (TR) yurt içi tablo olarak okunur; Dosya satırı atlanır ve not düşülür', () => {
    expect(scan.sections).toHaveLength(1);
    expect(s).toMatchObject({ zones: ['TR'], direction: 'domestic', packaging: 'all', weightMin: 1, weightMax: 30, currency: 'TRY', hasAdditionalStep: true });
    expect(s.title).toContain('1–30 desi');
    expect(s.title).toContain('yurt içi');
    expect(s.notes).toEqual(['"Dosya" satırı alınmadı (zarf/dosya fiyatı; koli desisi ölçülür)']);
    expect(s.table.rows.map((r) => [r.kind, r.weight ?? r.step, r.cells.join('|')])).toEqual([
      ['weight', 1, '96,10'],
      ['weight', 2, '104,30'],
      ['weight', 3, '112,50'],
      ['weight', 5, '128,90'],
      ['weight', 10, '170,00'],
      ['weight', 20, '262,60'],
      ['weight', 30, '355,20'],
      ['additional', 1, '11,70'],
    ]);
  });

  it('desi tablosu → hacim böleni 3000 (birim kg/desi; yeni kavram yok)', () => {
    expect(scan.document).toMatchObject({ dimDivisor: 3000, weightUnit: 'kg', currency: 'TRY' });
  });

  it('içe aktarma: "30 desi üzeri her desi" aşım fiyatı olur; 35 desi = 30 desi + 5 × aşım', () => {
    const p = parseTariffImport({ fileName: 'aras.pdf', kind: 'pdf', prices: sheetOf(s), zones: [['Ülke kodu', 'Bölge'], ['*', 'TR']], surcharges: null });
    expect(p.stepIssues).toEqual([]);
    expect(p.overflow).toEqual([{ zone: 'TR', perUnit: 11.7 }]);
    expect(p.overflowStep).toBe(1);
    expect(p.zones).toEqual([{ country: '*', zone: 'TR' }]);
    const steps = importWeightSteps(p, { tariffCurrency: 'TRY', currentZones: [], currentRates: [], currentSurcharges: [] } as never)!;
    expect(steps.at(-1)).toEqual({ upto: null, step: 1 });
    const tariff: TariffInput = {
      id: 't',
      currency: 'TRY',
      divisor: 3000,
      edgeRounding: 'CEIL_CM',
      weightSteps: steps,
      discountPct: 0,
      fuelPct: 0,
      zones: { '*': 'TR' },
      rates: p.rates.map((r) => ({ zone: r.zone, weightUpto: r.weightUpto, price: r.price })),
      overflowPerUnit: { TR: 11.7 },
      surcharges: [],
    };
    const q = expectedCharge({ tariff, chargeableKg: 35, destCountry: 'TR' });
    expect(q).toMatchObject({ ok: true, base: 413.7 });
    expect(expectedCharge({ tariff, chargeableKg: 4, destCountry: 'TR' })).toMatchObject({ ok: true, base: 128.9 });
  });
});

describe('PDF (kodla): yurt içi liste biçimleri', () => {
  it('Yurtiçi tipi "Desi | Ücret (KDV Hariç) | Ücret (KDV Dahil)": KDV hariç sütunu alınır; aralık etiketleri; "0-1 Dosya" atlanır', () => {
    const scan = scanPdfLayout([
      {
        items: page([
          [[60, 'Kargo Ücret Tarifesi 2026']],
          [[60, 'Desi'], [170, 'Ücret (KDV Hariç)'], [260, 'Ücret (KDV Dahil)']],
          [[60, '0-1 Dosya'], [180, '70,00'], [270, '84,00']],
          [[60, '0-2'], [180, '90,00'], [270, '108,00']],
          [[60, '3-5'], [180, '110,00'], [270, '132,00']],
          [[60, '6-10'], [180, '150,00'], [270, '180,00']],
          [[60, '11-20'], [180, '240,00'], [270, '288,00']],
          [[60, 'Her ilave desi'], [180, '9,00'], [270, '10,80']],
        ]),
      },
    ]);
    expect(scan.sections).toHaveLength(1);
    const s = scan.sections[0]!;
    expect(s.zones).toEqual(['TR']);
    expect(s.table.rows.map((r) => [r.kind, r.weight ?? r.step, r.cells.join('|')])).toEqual([
      ['weight', 2, '90,00'],
      ['weight', 5, '110,00'],
      ['weight', 10, '150,00'],
      ['weight', 20, '240,00'],
      ['additional', 1, '9,00'],
    ]);
    expect(s.notes).toEqual([
      '"0-1 Dosya" satırı alınmadı (zarf/dosya fiyatı; koli desisi ölçülür)',
      'fiyatlar "Ücret (KDV Hariç)" sütunundan alındı',
    ]);
    expect(scan.document.dimDivisor).toBe(3000);
  });

  it('"KG/Desi | Ücret" + son satırda "+" (her ilave birim); "Zarf" satırı atlanır', () => {
    const scan = scanPdfLayout([
      {
        items: page([
          [[60, 'KG/Desi'], [190, 'Ücret']],
          [[60, 'Zarf'], [200, '55,00']],
          [[60, '1'], [200, '80,00']],
          [[60, '2'], [200, '88,00']],
          [[60, '3'], [200, '96,00']],
          [[60, '+'], [200, '8,50']],
        ]),
      },
    ]);
    const s = scan.sections[0]!;
    expect(s.table.rows.map((r) => [r.kind, r.weight ?? r.step, r.cells[0]])).toEqual([
      ['weight', 1, '80,00'],
      ['weight', 2, '88,00'],
      ['weight', 3, '96,00'],
      ['additional', 1, '8,50'],
    ]);
    expect(s.notes?.[0]).toContain('"Zarf"');
  });

  it('PTT tipi "Ağırlık (kg) | Fiyat (TL)": kg tablosu (desi değil) → bölen belgeden ya da boş; yine tek bölge', () => {
    const scan = scanPdfLayout([
      {
        items: page([
          [[60, 'Ağırlık (kg)'], [190, 'Fiyat (TL)']],
          [[60, '1'], [200, '60,00']],
          [[60, '2'], [200, '70,00']],
          [[60, '5'], [200, '95,00']],
        ]),
      },
    ]);
    expect(scan.sections).toHaveLength(1);
    expect(scan.sections[0]!.zones).toEqual(['TR']);
    expect(scan.sections[0]!.title).toContain('1–5 kg');
    expect(scan.document.dimDivisor).toBeNull();
  });

  it('düz metindeki "Ağırlık  Ücret" satırı tablo sanılmaz (altında fiyat satırı yok)', () => {
    const scan = scanPdfLayout([
      {
        items: page([
          [[60, 'Ağırlık'], [190, 'Ücret']],
          [[60, 'Gönderilerin ağırlığı teslim alınırken tartılır.']],
          [[60, 'Ücret, desi ile kg arasında büyük olana göre hesaplanır.']],
          [[60, 'Ek hizmetler ayrıca ücretlendirilir.']],
          [[60, '5 numaralı madde uyarınca 10,00 TL eklenir.']],
        ]),
      },
    ]);
    expect(scan.sections).toEqual([]);
  });

  it('çok bölgeli tablolar etkilenmez: "Desi | 1. Bölge | 2. Bölge" yine iki bölge; "1000+" yine kg başı', () => {
    const scan = scanPdfLayout([
      {
        items: page([
          [[60, 'Desi'], [180, '1'], [240, '2']],
          [[60, '1'], [180, '50,00'], [240, '60,00']],
          [[60, '2'], [180, '55,00'], [240, '66,00']],
          [[60, '1000+'], [180, '5,00'], [240, '6,00']],
        ]),
      },
    ]);
    const s = scan.sections[0]!;
    expect(s.zones).toEqual(['1', '2']);
    expect(s.direction).toBeNull();
    expect(s.table.rows.at(-1)!.kind).toBe('perKg');
  });
});

describe('Ülke kodları: ISO-3 ("DEU", "GBR")', () => {
  it('iso3ToIso2 ve countryNameToIso2 (büyük harf) alfa-3 kodu tanır', () => {
    expect(iso3ToIso2('DEU')).toBe('DE');
    expect(iso3ToIso2('gbr')).toBe('GB');
    expect(iso3ToIso2('XKX')).toBe('XK');
    expect(iso3ToIso2('ABD')).toBeNull();
    expect(countryNameToIso2('USA')).toBe('US');
    expect(countryNameToIso2('TUR')).toBe('TR');
    expect(countryNameToIso2('ABD')).toBe('US'); // Türkçe ad yine ad olarak
  });

  it('Bölgeler sayfası ISO-3 kodlarını okur (önceden "tanınmayan ülke" oluyordu)', () => {
    const p = parseTariffImport({
      fileName: 't.xlsx',
      kind: 'xlsx',
      prices: [['Ağırlık (kg)', 'A', 'B'], ['1', '10', '20']],
      zones: [['Ülke kodu', 'Bölge'], ['DEU', 'A'], ['gbr', 'B'], ['USA', 'B'], ['Fransa', 'A']],
      surcharges: null,
    });
    expect(p.zones).toEqual([
      { country: 'DE', zone: 'A' },
      { country: 'GB', zone: 'B' },
      { country: 'US', zone: 'B' },
      { country: 'FR', zone: 'A' },
    ]);
    expect(p.sheetIssues).toEqual([]);
  });
});

describe('Excel: son satırdan sonraki "İlave" satırı aşım fiyatı olur', () => {
  it('"İlave 1 kg" son satırın altında → aşım; "Aşım" satırı varsa o kalır', () => {
    const p = parseTariffImport({ fileName: 't.xlsx', kind: 'xlsx', prices: [['Desi', 'TR'], ['1', '50'], ['2', '60'], ['İlave 1 kg', '7,5']], zones: null, surcharges: null });
    expect(p.overflow).toEqual([{ zone: 'TR', perUnit: 7.5 }]);
    expect(p.stepIssues).toEqual([]);
    const q = parseTariffImport({ fileName: 't.xlsx', kind: 'xlsx', prices: [['Desi', 'TR'], ['1', '50'], ['2', '60'], ['Aşım', '9'], ['İlave 1 kg', '7,5']], zones: null, surcharges: null });
    expect(q.overflow).toEqual([{ zone: 'TR', perUnit: 9 }]);
  });
});
