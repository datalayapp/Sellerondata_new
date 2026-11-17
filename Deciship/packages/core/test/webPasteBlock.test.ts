import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Web tarife tablosuna yapıştırma, gerçek `draft.ts` ile. Web bağımlılıkları kurulu değilse atlanır; web'in `node --test`
 * koşucusu core'u ve i18n'i yükleyemediği için burada durur.
 */
const web = path.resolve(import.meta.dirname, '../../../apps/web');
const hasWeb = existsSync(path.join(web, 'node_modules/i18next'));

type Draft = { zones: string[]; rows: { upto: string; prices: string[]; perKg: boolean }[]; overflow: string[]; countryZones: { country: string; zone: number }[] };
type DraftModule = {
  pasteBlock: (d: Draft, r: number, c: number, text: string, header: boolean, format?: 'tr' | 'en') => Draft | null;
  pasteAmbiguity: (text: string, c: number, header: boolean) => { example: string; asTr: number; asEn: number } | null;
  newDraft: (carrierId: string) => Draft;
  afterImportCheck: (checks: { code: string; title: string }[]) => 'surcharges' | 'overflow' | undefined;
  toBody: (d: Draft) => { body: unknown; errors: string[] };
  relocalizeDraft: (d: Draft, from: 'tr' | 'en', to: 'tr' | 'en') => Draft;
};
type WeightChoiceModule = {
  weightChoice: (s: string) => { decimal: number; thousands: number } | null;
  weightChoiceText: (r: { decimal: number; thousands: number }, pick: 'decimal' | 'thousands') => string;
};
type FormatModule = { setFormatLocale: (l: string) => void; parseTrNumber: (s: string) => number | null };
type PasteEvent = { target: unknown; clipboardData: { getData: () => string }; preventDefault: () => void };
type PasteAsk = { target: unknown; text: string; asTr: number; asEn: number };
type GuardModule = { handleNumberPaste: (e: PasteEvent, ask: (q: PasteAsk) => void) => boolean; spliceValue: (value: string, start: number | null, end: number | null, text: string) => string };

// Panel kurulu değilse yerelde atlanır; CI'da atlamak yerine kırılır (kurulum yoksa takım sessiz geçmez).
// eslint-disable-next-line no-restricted-properties -- panelin node_modules'u yerelde isteğe bağlı
describe.skipIf(!hasWeb && process.env.CI !== 'true')('pasteBlock: yapıştırılan bloğun biçimi', () => {
  let draft: DraftModule;
  let format: FormatModule;
  // ülke eşlemesi sütun sırasıdır (draft.ts countryZones, rapor 10-B1)
  const blank = (): Draft => ({ zones: ['A', 'B'], rows: [{ upto: '', prices: ['', ''], perKg: false }], overflow: ['', ''], countryZones: [] });
  const read = (d: Draft | null) => d!.rows.filter((r) => r.upto || r.prices.some(Boolean)).map((r) => [format.parseTrNumber(r.upto), ...r.prices.slice(0, 2).map((p) => format.parseTrNumber(p))]);
  const paste = (text: string, f?: 'tr' | 'en') => draft.pasteBlock(blank(), 0, -1, text, false, f);

  beforeAll(async () => {
    draft = (await import(/* @vite-ignore */ path.join(web, 'src/pages/tariff-editor/draft.ts'))) as DraftModule;
    format = (await import(/* @vite-ignore */ path.join(web, 'src/lib/format.ts'))) as FormatModule;
  }, 60_000);
  afterAll(() => format?.setFormatLocale('tr'));

  const TR_BLOCK = '0,5\t1.234\t2.500\n1\t1.234,50\t12.345,67\n';
  const EN_BLOCK = '0.5\t1,234\t2,500\n1\t1,234.50\t12,345.67\n';
  const WANT = [
    [0.5, 1234, 2500],
    [1, 1234.5, 12345.67],
  ];

  it.each([
    ['en', TR_BLOCK],
    ['en', EN_BLOCK],
    ['tr', TR_BLOCK],
    ['tr', EN_BLOCK],
  ])('%s arayüz: aynı değerler, %j', (locale, text) => {
    format.setFormatLocale(locale);
    expect(read(paste(text))).toEqual(WANT);
  });

  it('kaynak dille aynı arayüzde metin olduğu gibi kalır', () => {
    format.setFormatLocale('tr');
    expect(paste(TR_BLOCK)!.rows[0]!.prices.slice(0, 2)).toEqual(['1.234', '2.500']);
    format.setFormatLocale('en');
    expect(paste(EN_BLOCK)!.rows[0]!.prices.slice(0, 2)).toEqual(['1,234', '2,500']);
  });

  it('başka dildeki blok etkin dile çevrilir', () => {
    format.setFormatLocale('en');
    const d = paste(TR_BLOCK)!;
    expect(d.rows[0]!.upto).toBe('0.5');
    expect(d.rows[0]!.prices.slice(0, 2)).toEqual(['1234', '2500']);
    expect(d.rows[1]!.prices.slice(0, 2)).toEqual(['1234.5', '12345.67']);
    format.setFormatLocale('tr');
    const e = paste(EN_BLOCK)!;
    expect(e.rows[0]!.upto).toBe('0,5');
    expect(e.rows[1]!.prices.slice(0, 2)).toEqual(['1234,5', '12345,67']);
  });

  it('sayı olmayan hücre korunur, başlık satırı bölge adı olur', () => {
    format.setFormatLocale('en');
    const d = draft.pasteBlock(blank(), 0, -1, 'Kg\tZon 1\tZon 2\n0,5\t1.234\tyok\n', false)!;
    expect(d.zones.slice(0, 2)).toEqual(['Zon 1', 'Zon 2']);
    expect(d.rows[0]!.upto).toBe('0.5');
    expect(d.rows[0]!.prices.slice(0, 2)).toEqual(['1234', 'yok']);
  });

  it.each(['tr', 'en'])('%s arayüz: belirsiz blokta tahmin yok', (locale) => {
    format.setFormatLocale(locale);
    expect(draft.pasteAmbiguity('1.234\t2.500\n3.000\t100', 0, false)).toEqual({ example: '1.234', asTr: 1234, asEn: 1.234 });
    expect(draft.pasteAmbiguity('1,234\n', 0, false)).toEqual({ example: '1,234', asTr: 1.234, asEn: 1234 });
    // iki dilde aynı okunan blok ve kanıtı olan blok sorulmaz
    expect(draft.pasteAmbiguity('12\t100\n1,5\t2', 0, false)).toBeNull();
    expect(draft.pasteAmbiguity(TR_BLOCK, -1, false)).toBeNull();
    expect(draft.pasteAmbiguity(EN_BLOCK, -1, false)).toBeNull();
    // yalnız başlık (bölge adı) yapıştırma sayı değildir
    expect(draft.pasteAmbiguity('1.234', 0, true)).toBeNull();
  });

  it.each(['tr', 'en'])('%s arayüz: sayı alanına tek değer yapıştırma', async (locale) => {
    format.setFormatLocale(locale);
    const guard = (await import(/* @vite-ignore */ path.join(web, 'src/lib/numberPaste.ts'))) as GuardModule;
    const run = (text: string, attrs: { mode?: string; cell?: string; tag?: string; measure?: boolean } = {}) => {
      let prevented = false;
      const asked: PasteAsk[] = [];
      const target = { tagName: attrs.tag ?? 'INPUT', dataset: attrs.cell ? { cell: attrs.cell } : attrs.measure ? { measure: '' } : {}, getAttribute: () => attrs.mode ?? 'decimal' };
      guard.handleNumberPaste({ target, clipboardData: { getData: () => text }, preventDefault: () => (prevented = true) }, (q) => asked.push(q));
      return { prevented, asked: asked.map((q) => [q.text, q.asTr, q.asEn]) };
    };
    expect(run('1.234')).toEqual({ prevented: true, asked: [['1.234', 1234, 1.234]] });
    expect(run('1,234\r\n', { mode: 'numeric' }).prevented).toBe(true);
    for (const ok of ['12,5', '12.5', '1.234,50', '1,234.50', '1234', 'abc', '']) expect(run(ok), ok).toEqual({ prevented: false, asked: [] });
    expect(run('1.234', { cell: '0:0' }).prevented).toBe(false);
    expect(run('1.234', { mode: 'text' }).prevented).toBe(false);
    expect(run('1.234', { tag: 'TEXTAREA' }).prevented).toBe(false);
    // K36: koli ölçüsü alanı (`data-measure`) sorulmaz; "1.500" ondalık okunur
    expect(run('1.500', { measure: true })).toEqual({ prevented: false, asked: [] });
    // seçilen değer yapıştırma gibi seçili metnin yerine geçer
    expect(guard.spliceValue('', 0, 0, '1234')).toBe('1234');
    expect(guard.spliceValue('999', 0, 3, '1234')).toBe('1234');
    expect(guard.spliceValue('12', 1, 1, '5')).toBe('152');
    expect(guard.spliceValue('12', null, null, '5')).toBe('125');
  });

  it('yeni taslağın varsayılan ağırlıkları etkin dilde', () => {
    format.setFormatLocale('en');
    expect(draft.newDraft('c').rows.map((r) => r.upto)).toEqual(['0.5', '1', '1.5', '2', '2.5']);
    format.setFormatLocale('tr');
    expect(draft.newDraft('c').rows.map((r) => r.upto)).toEqual(['0,5', '1', '1,5', '2', '2,5']);
  });

  it('içe aktarma sonrası bölüm: İngilizce başlıkta da doğru', () => {
    const code = 'SURCHARGES_OTHER_CURRENCY';
    expect(draft.afterImportCheck([{ code, title: 'Surcharges are in TRY; the tariff is now in USD — check the surcharges' }])).toBe('surcharges');
    expect(draft.afterImportCheck([{ code, title: 'Overflow prices are in TRY; the tariff is now in USD — check the overflow prices' }])).toBe('overflow');
    expect(draft.afterImportCheck([{ code, title: 'Ek ücretler TRY; tarife artık USD — ek ücretleri kontrol edin' }])).toBe('surcharges');
    expect(draft.afterImportCheck([{ code: 'X', title: 'check the surcharges' }])).toBeUndefined();
  });

  it.each(['tr', 'en'])('%s arayüz: kullanıcı seçince seçilen okuma uygulanır, tek hücre dahil', (locale) => {
    format.setFormatLocale(locale);
    const at = (text: string, f: 'tr' | 'en') => read(draft.pasteBlock(blank(), 0, 0, text, false, f));
    expect(at('1.234\t2.500', 'tr')).toEqual([[null, 1234, 2500]]);
    expect(at('1.234\t2.500', 'en')).toEqual([[null, 1.234, 2.5]]);
    expect(at('1.234', 'tr')).toEqual([[null, 1234, null]]);
    expect(at('1.234', 'en')).toEqual([[null, 1.234, null]]);
  });
});

// K36 (kullanıcı kararı 2026-11-14): tarife düzenleyicide "1.500" ağırlık 1,5 kg da 1500 kg da olabilir: alanın altında
// seçilene dek kayıt yok (Türkçe arayüz). İngilizce arayüzde nokta ondalıktır; "1,500", "1500", "1.5" sorulmaz.
// eslint-disable-next-line no-restricted-properties -- panelin node_modules'u yerelde isteğe bağlı
describe.skipIf(!hasWeb && process.env.CI !== 'true')('K36: tarife düzenleyicide "1.500" ağırlık', () => {
  let draft: DraftModule;
  let format: FormatModule;
  let wc: WeightChoiceModule;
  beforeAll(async () => {
    draft = (await import(/* @vite-ignore */ path.join(web, 'src/pages/tariff-editor/draft.ts'))) as DraftModule;
    format = (await import(/* @vite-ignore */ path.join(web, 'src/lib/format.ts'))) as FormatModule;
    wc = (await import(/* @vite-ignore */ path.join(web, 'src/lib/weightChoice.ts'))) as WeightChoiceModule;
  }, 60_000);
  afterAll(() => format?.setFormatLocale('tr'));

  const withWeight = (upto: string, step = '0,5'): Draft => {
    const d = draft.newDraft('c') as Draft & { name: string; steps: { upto: string; step: string }[] };
    d.name = 'Deneme';
    d.rows = [{ upto, prices: ['10', '12'], perKg: false }];
    d.steps = [{ upto: '', step }];
    return d;
  };
  // i18next burada yüklü değil (metin boş döner): seçim isteyen hata, aynı taslağın belirsiz olmayan ağırlıklı hâline göre sayılır
  const asks = (d: Draft) => draft.toBody(d).errors.length - draft.toBody(withWeight('2')).errors.length;

  it('Türkçe arayüz: "1.500" seçim ister, kayıt kapalı; seçim alana iki türlü okunmayan metni yazar', () => {
    format.setFormatLocale('tr');
    expect(asks(withWeight('1.500'))).toBe(1);
    expect(draft.toBody(withWeight('1.500')).body).toBeNull();
    expect(asks(withWeight('2', '1.000'))).toBe(1);
    const r = wc.weightChoice('1.500')!;
    expect(r).toEqual({ decimal: 1.5, thousands: 1500 });
    expect(wc.weightChoiceText(r, 'decimal')).toBe('1,5');
    expect(wc.weightChoiceText(r, 'thousands')).toBe('1500');
    for (const picked of ['1,5', '1500']) {
      expect(asks(withWeight(picked)), picked).toBe(0);
      expect(wc.weightChoice(picked)).toBeNull();
    }
  });

  it.each(['1,500', '1500', '1.5', '0,5'])('Türkçe arayüz: "%s" sorulmaz', (w) => {
    format.setFormatLocale('tr');
    expect(asks(withWeight(w))).toBe(0);
  });

  it('İngilizce arayüz: nokta ondalık, "1.500" ve düzenleyicinin yazdığı "1.125" sorulmaz', () => {
    format.setFormatLocale('en');
    expect(wc.weightChoice('1.500')).toBeNull();
    expect(asks(withWeight('1.125', '0.5'))).toBe(0);
    expect(draft.toBody(withWeight('1.500', '0.5')).body).not.toBeNull();
  });

  // kullanıcı kararı 2026-11-14: İngilizcede "1,500" Türkçedeki "1.500"ın aynası (eskiden sessizce 1500)
  it('İngilizce arayüz: "1,500" seçim ister ("1.5 kg or 1,500 kg?"); seçim "1.5" ya da "1500" yazar', () => {
    format.setFormatLocale('en');
    expect(asks(withWeight('1,500', '0.5'))).toBe(1);
    expect(asks(withWeight('2', '1,000'))).toBe(1);
    const r = wc.weightChoice('1,500')!;
    expect(r).toEqual({ decimal: 1.5, thousands: 1500 });
    expect(wc.weightChoiceText(r, 'decimal')).toBe('1.5');
    expect(wc.weightChoiceText(r, 'thousands')).toBe('1500');
    for (const w of ['1.5', '1500', '1,500.5']) expect(asks(withWeight(w, '0.5')), w).toBe(0);
  });

  it('dil değişince kaydedilmemiş taslak anlamını korur: Türkçe "1,500" kg 1,5 kalır, seçilmemiş "1.500" soruyla geçer', () => {
    format.setFormatLocale('tr');
    const d = withWeight('1,500', '0,5') as Draft & { steps: { upto: string; step: string }[]; discountPct: string };
    d.rows = [
      { upto: '1,500', prices: ['1.500', '12,5'], perKg: false },
      { upto: '1.500', prices: ['10', ''], perKg: false },
    ];
    d.discountPct = '12,5';
    const en = draft.relocalizeDraft(d, 'tr', 'en') as typeof d;
    expect(en.rows.map((r) => r.upto)).toEqual(['1.5', '1,500']);
    expect(en.rows[0]!.prices).toEqual(['1500', '12.5', ]);
    expect(en.discountPct).toBe('12.5');
    expect(en.steps[0]!.step).toBe('0.5');
    format.setFormatLocale('en');
    // birinci satır 1,5 kg kaldı; ikincisi soruyla (aynı iki okuma) duruyor, sessizce 1,5 ya da 1500 olmadı
    expect(wc.weightChoice(en.rows[0]!.upto)).toBeNull();
    expect(wc.weightChoice(en.rows[1]!.upto)).toEqual({ decimal: 1.5, thousands: 1500 });
    // geri dönüş aynı metni verir
    expect(draft.relocalizeDraft(en, 'en', 'tr').rows.map((r) => r.upto)).toEqual(['1,5', '1.500']);
  });

  it('biçimi belli yapıştırılan blokta ağırlık binliksiz yazılır (Türkçe blokta "1.500" → "1500"), soru kalmaz', () => {
    format.setFormatLocale('tr');
    const d = draft.pasteBlock({ zones: ['A', 'B'], rows: [{ upto: '', prices: ['', ''], perKg: false }], overflow: ['', ''], countryZones: [] }, 0, -1, '1.500\t1.234,50\n', false)!;
    expect(d.rows[0]!.upto).toBe('1500');
    expect(wc.weightChoice(d.rows[0]!.upto)).toBeNull();
    const en = draft.pasteBlock({ zones: ['A', 'B'], rows: [{ upto: '', prices: ['', ''], perKg: false }], overflow: ['', ''], countryZones: [] }, 0, -1, '1.500\t1,234.50\n', false)!;
    expect(en.rows[0]!.upto).toBe('1,5');
  });
});
