// Biçimleme paketi matris testleri (Mesaj 12 D; kararlar rapor Y72). Beklentiler elle yazıldı: bir satır değişirse karar değişmiştir.
process.env.TZ = 'Europe/Istanbul';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CURRENCY_SYMBOL,
  EMPTY,
  currencySymbol,
  dateLong,
  dateShort,
  dateTime,
  dayMonth,
  fmtLocale,
  money,
  moneyParts,
  num,
  percent,
  time,
} from '../src/index.ts';

const M = String.fromCharCode(0x2212); // ekrandaki eksi
const NBSP = String.fromCharCode(0xa0);
const G = NBSP; // ekran kipinde tutar ile simge arası

describe('fmtLocale', () => {
  it('en ile başlayan en, gerisi tr', () => {
    for (const x of ['en', 'en-US', 'EN-gb', ' en ']) assert.equal(fmtLocale(x), 'en', x);
    for (const x of ['tr', 'tr-TR', 'de', '', null, undefined]) assert.equal(fmtLocale(x), 'tr', String(x));
  });
});

describe('currencySymbol', () => {
  it('bilinen dört simge, bilinmeyen büyük harf kod, boş TRY', () => {
    assert.deepEqual({ ...CURRENCY_SYMBOL }, { TRY: '₺', USD: '$', EUR: '€', GBP: '£' });
    assert.equal(currencySymbol('try'), '₺');
    assert.equal(currencySymbol('USD'), '$');
    assert.equal(currencySymbol('chf'), 'CHF');
    assert.equal(currencySymbol(' xxx1 '), 'XXX1');
    assert.equal(currencySymbol(''), '₺');
    assert.equal(currencySymbol(null), '₺');
    assert.equal(currencySymbol(), '₺');
    assert.ok(Object.isFrozen(CURRENCY_SYMBOL));
  });
});

describe('money matrisi', () => {
  // [değer, TR, EN] TRY için; diğer kodlar aşağıda simge yer değiştirerek üretilir.
  const rows: Array<[number, string, string]> = [
    [-1234.567, `${M}1.234,57${G}₺`, `${M}₺1,234.57`],
    [-5, `${M}5,00${G}₺`, `${M}₺5.00`],
    [0, `0,00${G}₺`, '₺0.00'],
    [-0, `0,00${G}₺`, '₺0.00'],
    [-0.004, `0,00${G}₺`, '₺0.00'], // Y72-1: yuvarlanınca sıfır olan negatif işaretsiz
    [-0.005, `${M}0,01${G}₺`, `${M}₺0.01`], // tam yarım (ikili gösterimde 0.005000…01): sıfırdan uzağa
    [0.005, `0,01${G}₺`, '₺0.01'],
    [1e-7, `0,00${G}₺`, '₺0.00'],
    [-1e-7, `0,00${G}₺`, '₺0.00'],
    [2.5, `2,50${G}₺`, '₺2.50'],
    [1234567.891, `1.234.567,89${G}₺`, '₺1,234,567.89'],
    [1e15, `1.000.000.000.000.000,00${G}₺`, '₺1,000,000,000,000,000.00'],
    [1e21, `1.000.000.000.000.000.000.000,00${G}₺`, '₺1,000,000,000,000,000,000,000.00'],
    [-1e21, `${M}1.000.000.000.000.000.000.000,00${G}₺`, `${M}₺1,000,000,000,000,000,000,000.00`],
  ];
  it('TRY, TR ve EN', () => {
    for (const [n, tr, en] of rows) {
      assert.equal(money(n, 'TRY', 'tr'), tr, `tr ${n}`);
      assert.equal(money(n, 'TRY', 'en'), en, `en ${n}`);
    }
  });
  it('USD, EUR, GBP: simge yeri TRY ile aynı', () => {
    for (const [code, sym] of [['USD', '$'], ['EUR', '€'], ['GBP', '£']] as const) {
      for (const [n, tr, en] of rows) {
        assert.equal(money(n, code, 'tr'), tr.replace('₺', sym), `tr ${code} ${n}`);
        assert.equal(money(n, code, 'en'), en.replace('₺', sym), `en ${code} ${n}`);
      }
    }
  });
  it('bilinmeyen kod boşluklu (Y72-3): TR "2,50 CHF", EN "CHF 2.50"', () => {
    assert.equal(money(2.5, 'CHF', 'tr'), `2,50${G}CHF`);
    assert.equal(money(2.5, 'CHF', 'en'), `CHF${G}2.50`);
    assert.equal(money(-1234.567, 'CHF', 'tr'), `${M}1.234,57${G}CHF`);
    assert.equal(money(-1234.567, 'CHF', 'en'), `${M}CHF${G}1,234.57`);
    assert.equal(money(11234.5, 'XXX', 'en'), `XXX${G}11,234.50`); // kabuktaki "XXX11,234.50" hatası yok
    assert.equal(money(5, 'xxx1', 'tr'), `5,00${G}XXX1`);
    assert.equal(money(-0.004, 'CHF', 'en'), `CHF${G}0.00`);
  });
  it('kod boş, null ya da undefined: TRY', () => {
    for (const c of ['', null, undefined, '  ']) {
      assert.equal(money(5, c, 'tr'), `5,00${G}₺`);
      assert.equal(money(5, c, 'en'), '₺5.00');
    }
  });
  it('tutar ile simge/kod arası: ekranda bölünmez boşluk (U+00A0), ASCII kipinde düz boşluk', () => {
    assert.equal(money(1, 'TRY', 'tr'), `1,00${NBSP}₺`);
    assert.equal(money(1, 'CHF', 'en'), `CHF${NBSP}1.00`);
    assert.equal(money(1, 'CHF', 'tr'), `1,00${NBSP}CHF`);
    assert.equal(money(1, 'USD', 'en'), '$1.00');
    assert.equal(money(1, 'TRY', 'tr', { sign: 'ascii' }), '1,00 ₺');
    assert.equal(money(1, 'CHF', 'en', { sign: 'ascii' }), 'CHF 1.00');
    assert.ok(!money(-1, 'CHF', 'tr', { sign: 'ascii' }).includes(NBSP));
  });
  it('değer yok: uzun çizgi', () => {
    for (const n of [Number.NaN, null, undefined, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(money(n, 'TRY', 'tr'), EMPTY);
      assert.equal(money(n, 'USD', 'en'), EMPTY);
    }
  });
  it('ASCII kipi (dışa aktarma, kayıtlı not)', () => {
    assert.equal(money(-1234.567, 'TRY', 'tr', { sign: 'ascii' }), '-1.234,57 ₺');
    assert.equal(money(-1234.567, 'TRY', 'en', { sign: 'ascii' }), '-₺1,234.57');
    assert.equal(money(-12.5, 'CHF', 'en', { sign: 'ascii' }), '-CHF 12.50');
    assert.equal(money(-0.004, 'TRY', 'tr', { sign: 'ascii' }), '0,00 ₺');
    assert.match(money(-1, 'EUR', 'tr', { sign: 'ascii' }), /^[\x20-\x7e€]+$/);
  });
  it('plus: pozitifte +, sıfırda işaret yok', () => {
    assert.equal(money(458.5, 'TRY', 'tr', { plus: true }), `+458,50${G}₺`);
    assert.equal(money(458.5, 'TRY', 'en', { plus: true }), '+₺458.50');
    assert.equal(money(0.004, 'TRY', 'tr', { plus: true }), `0,00${G}₺`);
    assert.equal(money(0, 'TRY', 'tr', { plus: true }), `0,00${G}₺`);
    assert.equal(money(-3, 'TRY', 'tr', { plus: true }), `${M}3,00${G}₺`);
  });
  it('decimals', () => {
    assert.equal(money(1234.5, 'TRY', 'tr', { decimals: 0 }), `1.235${G}₺`);
    assert.equal(money(1.23456, 'USD', 'en', { decimals: 4 }), '$1.2346');
  });
});

describe('yarım kuruş yuvarlaması (hesap motoru round2 ile aynı)', () => {
  it('ikili gösterimde yarımın altında kalan değerler yukarı', () => {
    const rows: Array<[number, string, string]> = [
      [1.005, `1,01${G}₺`, '₺1.01'],
      [2.675, `2,68${G}₺`, '₺2.68'],
      [0.285, `0,29${G}₺`, '₺0.29'],
      [580.545, `580,55${G}₺`, '₺580.55'],
      [9.995, `10,00${G}₺`, '₺10.00'],
      [-1.005, `${M}1,01${G}₺`, `${M}₺1.01`],
      [999.995, `1.000,00${G}₺`, '₺1,000.00'],
    ];
    for (const [n, tr, en] of rows) {
      assert.equal(money(n, 'TRY', 'tr'), tr, `tr ${n}`);
      assert.equal(money(n, 'TRY', 'en'), en, `en ${n}`);
    }
    assert.equal(num(1.0005, 'tr', { max: 3 }), '1,001');
    assert.equal(num(2.5, 'tr', { max: 0 }), '3');
    assert.equal(num(0.45, 'en', { max: 1 }), '0.5');
    assert.equal(percent(12.345, 'tr', { max: 2 }), '%12,35');
  });
  it('rastgele k/1000: money(x) === money(round2(x))', async () => {
    const { round2 } = await import('../../../../Deciship/packages/core/src/calc.ts');
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 20000; i++) {
      const k = Math.floor(rnd() * 20_000_000) - 10_000_000; // ±10.000,000
      const x = k / 1000;
      assert.equal(money(x, 'TRY', 'tr'), money(round2(x), 'TRY', 'tr'), `x=${x}`);
      assert.equal(num(x, 'en', { min: 2, max: 2, sign: 'ascii' }), num(round2(x), 'en', { min: 2, max: 2, sign: 'ascii' }), `x=${x}`);
    }
    for (let k = -2000; k <= 2000; k++) assert.equal(money(k / 1000, 'USD', 'en'), money(round2(k / 1000), 'USD', 'en'), `k=${k}`);
  });
  it('büyük tutar (Y108): 1e10 üstünde kuruş yazılır, motorla aynı; 1e9 altında eski 12 basamak kuralı', async () => {
    const { round2, round3 } = await import('../../../../Deciship/packages/core/src/calc.ts');
    assert.equal(money(12_345_678_901.23, 'TRY', 'en'), '₺12,345,678,901.23'); // eskiden .20
    assert.equal(money(12_345_678_901.235, 'TRY', 'tr'), `12.345.678.901,24${G}₺`);
    assert.equal(money(-98_765_432_109.875, 'USD', 'en'), `${M}$98,765,432,109.88`);
    assert.equal(num(1_234_567_890.1235, 'en', { max: 3 }), '1,234,567,890.124');
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 20000; i++) {
      const x = (Math.floor(rnd() * 2e13) - 1e13 + (i % 2 ? 0.5 : 0)) / 1000; // ±1e10, yarım kuruşlar dahil
      const big = x * 1000; // ±1e13
      assert.equal(money(x, 'TRY', 'tr'), money(round2(x), 'TRY', 'tr'), `x=${x}`);
      assert.equal(money(big, 'USD', 'en'), money(round2(big), 'USD', 'en'), `big=${big}`);
      assert.equal(num(big, 'en', { min: 3, max: 3 }), num(round3(big), 'en', { min: 3, max: 3 }), `big3=${big}`);
      // 1e13 … 1e16: kuruş kısalır ama ekran ile motor yine aynı (motor eskiden r / 100 artığı bırakıyordu: …470,1)
      const huge = (x * 1e5) / 7;
      assert.equal(money(huge, 'USD', 'en'), money(round2(huge), 'USD', 'en'), `huge=${huge}`);
      assert.equal(num(huge, 'en', { min: 3, max: 3 }), num(round3(huge), 'en', { min: 3, max: 3 }), `huge3=${huge}`);
    }
    // Çift yuvarlama yok (Y108): …,0049 önce …,005'e temizlenip yukarı gitmez
    assert.equal(money(1_234_567_890.0049, 'TRY', 'en'), '₺1,234,567,890.00');
    assert.equal(num(12_345_678_901.2349, 'en', { max: 2 }), '12,345,678,901.23');
    assert.equal(num(1_234_567_890.12345, 'en', { max: 3 }), '1,234,567,890.123');
    assert.equal(money(849_977_758_444_469.5, 'USD', 'en'), money(round2(849_977_758_444_469.5), 'USD', 'en'));
    // 1e9 altında temizlik eskisi gibi 12 basamak: 12 basamağı aşan artık atılır
    assert.equal(num(123_456_789 + 0.123456789, 'en', { max: 9 }), '123,456,789.123');
  });
});

describe('moneyParts', () => {
  it('matris: TR birim sonda, EN önde; bilinmeyen kodda boşluk; işaret en önde', () => {
    const cases: Array<[number, string, 'tr' | 'en', object | undefined, { sign: string; amount: string; unit: string; unitFirst: boolean; gap: string }]> = [
      [1234.5, 'TRY', 'tr', undefined, { sign: '', amount: '1.234,50', unit: '₺', unitFirst: false, gap: NBSP }],
      [1234.5, 'TRY', 'en', undefined, { sign: '', amount: '1,234.50', unit: '₺', unitFirst: true, gap: '' }],
      [-1234.5, 'USD', 'en', undefined, { sign: M, amount: '1,234.50', unit: '$', unitFirst: true, gap: '' }],
      [1234.5, 'CHF', 'en', undefined, { sign: '', amount: '1,234.50', unit: 'CHF', unitFirst: true, gap: NBSP }],
      [-1234.5, 'chf', 'tr', undefined, { sign: M, amount: '1.234,50', unit: 'CHF', unitFirst: false, gap: NBSP }],
      [-0.004, 'EUR', 'tr', undefined, { sign: '', amount: '0,00', unit: '€', unitFirst: false, gap: NBSP }],
      [5, '', 'en', { plus: true }, { sign: '+', amount: '5.00', unit: '₺', unitFirst: true, gap: '' }],
      [-5, 'CHF', 'en', { sign: 'ascii' }, { sign: '-', amount: '5.00', unit: 'CHF', unitFirst: true, gap: ' ' }],
    ];
    for (const [n, cur, loc, opts, want] of cases) {
      const p = moneyParts(n, cur, loc, opts as never);
      assert.deepEqual(p, want, `${n} ${cur} ${loc}`);
      const text = p!.unitFirst ? p!.sign + p!.unit + p!.gap + p!.amount : p!.sign + p!.amount + p!.gap + p!.unit;
      assert.equal(text, money(n, cur, loc, opts as never), 'parçalar money ile aynı metni kurar');
    }
    for (const n of [Number.NaN, null, undefined, Number.POSITIVE_INFINITY]) assert.equal(moneyParts(n, 'TRY', 'tr'), null);
  });
});

describe('num', () => {
  it('TR ve EN ayırıcıları, varsayılan en çok 2 ondalık, binlik açık', () => {
    assert.equal(num(1234567.891, 'tr'), '1.234.567,89');
    assert.equal(num(1234567.891, 'en'), '1,234,567.89');
    assert.equal(num(2.5, 'tr'), '2,5');
    assert.equal(num(1234, 'tr'), '1.234');
    assert.equal(num(999, 'en'), '999');
    assert.equal(num(0, 'tr'), '0');
  });
  it('min, max, group', () => {
    assert.equal(num(2.5, 'tr', { min: 2, max: 2 }), '2,50');
    assert.equal(num(2, 'en', { min: 1, max: 3 }), '2.0');
    assert.equal(num(1234.5678, 'tr', { max: 3 }), '1.234,568');
    assert.equal(num(1234.5, 'tr', { max: 0 }), '1.235');
    assert.equal(num(1234567.891, 'tr', { group: false }), '1234567,89');
    assert.equal(num(1.5, 'tr', { min: 5, max: 2 }), '1,50'); // min > max ise min = max
    assert.equal(num(1, 'en', { min: 99, max: 99 }), `1.${'0'.repeat(15)}`); // en çok 15 ondalık
    assert.equal(num(1.1, 'en', { max: 20 }), '1.1'); // kayan nokta artığı (1.1000000000000001) yok
    assert.equal(num(1.1, 'en', { min: 16, max: 20 }), `1.1${'0'.repeat(14)}`);
    assert.equal(num(1.5, 'en', { max: -3 }), '2'); // eksi basamak 0 sayılır
  });
  it('işaret: Unicode varsayılan, ASCII kipi, eksi sıfır yok', () => {
    assert.equal(num(-1234.567, 'tr'), `${M}1.234,57`);
    assert.equal(num(-1234.567, 'en', { sign: 'ascii' }), '-1,234.57');
    for (const n of [-0, -0.004, -1e-7]) {
      assert.equal(num(n, 'tr'), '0');
      assert.equal(num(n, 'tr', { min: 2, max: 2 }), '0,00');
      assert.equal(num(n, 'en', { sign: 'ascii', max: 1 }), '0');
    }
    assert.equal(num(-0.004, 'tr', { max: 3 }), `${M}0,004`);
    assert.equal(num(5, 'tr', { plus: true }), '+5');
    assert.equal(num(0, 'tr', { plus: true }), '0');
  });
  it('yuvarlama: tam ondalık değer, eşitlikte sıfırdan uzağa', () => {
    assert.equal(num(2.5, 'tr', { max: 0 }), '3');
    assert.equal(num(-2.5, 'tr', { max: 0 }), `${M}3`);
    assert.equal(num(0.125, 'en', { max: 2 }), '0.13');
    assert.equal(num(-0.125, 'en', { max: 2 }), `${M}0.13`);
    assert.equal(num(1.005, 'en', { max: 2 }), '1.01'); // hesap motoru kuralı: önce 12 anlamlı basamağa temizlik
  });
  it('çok büyük ve çok küçük', () => {
    assert.equal(num(1e21, 'en'), '1,000,000,000,000,000,000,000');
    assert.equal(num(1.5e300, 'tr').length > 300, true);
    assert.ok(!num(1.5e300, 'tr').includes('e'));
    // 15 anlamlı basamak sınırı (hesap motoruyla aynı): 16 haneli tamsayının son hanesi sıfırlanır. Y108'de bilerek
    // değişti: önce 12 basamaktı ('9,007,199,254,740,000'); 1e9 üstünde temizlik artık 15 basamak.
    assert.equal(num(Number.MAX_SAFE_INTEGER, 'en'), '9,007,199,254,740,990');
    assert.equal(num(1.5e-7, 'en', { max: 7 }), '0.0000002');
    assert.equal(num(1.5e-7, 'en', { max: 6 }), '0');
    assert.equal(num(5e-324, 'tr'), '0');
  });
  it('değer yok: uzun çizgi', () => {
    for (const n of [Number.NaN, null, undefined, Number.POSITIVE_INFINITY]) assert.equal(num(n, 'tr'), EMPTY);
  });
});

describe('percent', () => {
  it('TR %önce, EN sonra; varsayılan en çok 1 ondalık; binlik açık', () => {
    assert.equal(percent(86.4, 'tr'), '%86,4');
    assert.equal(percent(86.4, 'en'), '86.4%');
    assert.equal(percent(2.55, 'tr'), '%2,6'); // 2.55 ikili gösterimde 2.5499…; temizlenince tam yarım: yukarı
    assert.equal(percent(2.5, 'tr', { max: 0 }), '%3');
    assert.equal(percent(1234567.891, 'tr'), '%1.234.567,9');
    assert.equal(percent(1234567.891, 'en'), '1,234,567.9%');
    assert.equal(percent(0, 'tr'), '%0');
    assert.equal(percent(50, 'en', { min: 1 }), '50.0%');
    assert.equal(percent(1234567.891, 'tr', { max: 2, group: false }), '%1234567,89');
  });
  it('işaret: TR "−%5", EN "−5%"; sıfıra yuvarlanan negatif işaretsiz', () => {
    assert.equal(percent(-1234.567, 'tr'), `${M}%1.234,6`);
    assert.equal(percent(-1234.567, 'en'), `${M}1,234.6%`);
    assert.equal(percent(-5, 'tr', { sign: 'ascii' }), '-%5');
    assert.equal(percent(-0.004, 'tr'), '%0');
    assert.equal(percent(-0.04, 'en'), '0%');
    assert.equal(percent(-0.04, 'en', { max: 2 }), `${M}0.04%`);
  });
  it('değer yok: uzun çizgi', () => {
    for (const n of [Number.NaN, null, undefined]) assert.equal(percent(n, 'en'), EMPTY);
  });
});

describe('tarih', () => {
  const DAY = '2026-10-27';
  const AT = '2026-10-27T14:32:10+03:00';
  it('kısa tarih: TR "27 Eki 2026", EN "27 Oct 2026" (Y72-4)', () => {
    assert.equal(dateShort(DAY, 'tr'), '27 Eki 2026');
    assert.equal(dateShort(DAY, 'en'), '27 Oct 2026');
    assert.equal(dateShort(AT, 'tr'), '27 Eki 2026');
    assert.equal(dateShort(new Date(AT), 'en'), '27 Oct 2026');
    assert.equal(dateShort(Date.parse(AT), 'tr'), '27 Eki 2026');
  });
  it('takvim günü saat diliminden bağımsız', () => {
    assert.equal(dateShort(DAY, 'tr', { timeZone: 'America/Los_Angeles' }), '27 Eki 2026');
    assert.equal(dateShort('2026-01-01', 'en', { timeZone: 'Pacific/Kiritimati' }), '1 Jan 2026');
    // saatli an verilen dilimde yazılır
    assert.equal(dateShort('2026-10-27T23:30:00+00:00', 'tr'), '28 Eki 2026');
    assert.equal(dateShort('2026-10-27T23:30:00+00:00', 'tr', { timeZone: 'UTC' }), '27 Eki 2026');
  });
  it('tarih-saat: yıl 4 hane, 24 saat (Y72-5)', () => {
    assert.equal(dateTime(AT, 'tr'), '27 Eki 2026 14:32');
    assert.equal(dateTime(AT, 'en'), '27 Oct 2026, 14:32');
    assert.equal(dateTime('2026-10-27T23:05:00+03:00', 'en'), '27 Oct 2026, 23:05');
    assert.equal(dateTime('2026-10-27T00:05:00+03:00', 'en'), '27 Oct 2026, 00:05');
    assert.equal(dateTime(DAY, 'tr'), '27 Eki 2026 00:00');
    assert.equal(dateTime(AT, 'tr', { year: false }), '27 Eki 14:32');
    assert.equal(dateTime(AT, 'en', { year: false }), '27 Oct, 14:32');
    assert.equal(dateTime(AT, 'tr', { timeZone: 'UTC' }), '27 Eki 2026 11:32');
    assert.equal(time(AT, 'en'), '14:32');
    assert.equal(time('2026-10-27T09:05:00+03:00', 'tr'), '09:05');
    assert.equal(time('2026-10-27T00:00:00+03:00', 'en'), '00:00');
  });
  it('gün-ay ve uzun tarih', () => {
    assert.equal(dayMonth(DAY, 'tr'), '27 Eki');
    assert.equal(dayMonth(AT, 'en'), '27 Oct');
    assert.equal(dateLong('2026-10-05', 'tr'), '5 Ekim 2026');
    assert.equal(dateLong('2026-10-05', 'en'), '5 October 2026');
  });
  it('geçersiz tarih: uzun çizgi, girdi geri yazılmaz, NaN yok (Y72-6)', () => {
    const bad = ['abc', '', '   ', '2026-02-31', '2026-13-01', null, undefined, new Date('x'), Number.NaN];
    for (const v of bad) {
      for (const loc of ['tr', 'en'] as const) {
        for (const out of [dateShort(v, loc), dateTime(v, loc), dateTime(v, loc, { year: false }), dayMonth(v, loc), dateLong(v, loc), time(v, loc)]) {
          assert.equal(out, EMPTY, `${String(v)} ${loc}`);
        }
      }
    }
  });
});
