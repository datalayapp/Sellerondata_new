import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  chargeableWeight,
  DEFAULT_WEIGHT_STEPS,
  desi,
  pctOf,
  round2,
  round3,
  roundEdges,
  roundUpToStep,
  sortedEdges,
  subMoney,
  sumMoney,
  toCents,
  volumetricWeight,
} from '../src/calc';

describe('calc.ts bağımlılıksız', () => {
  it('hiç import içermez', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/calc.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });
});

describe('round2 (yarım-yukarı)', () => {
  it.each([
    [1.005, 1.01],
    [1.004999, 1],
    [2.675, 2.68],
    [580.545, 580.55],
    [1527.75 * 0.38, 580.55],
    [0.125, 0.13],
    [10.235, 10.24],
    [1.255, 1.26],
    [-1.005, -1.01],
    [-0.004, 0],
    [0.1 + 0.2, 0.3],
    [12345.675, 12345.68],
    [99999999.995, 100000000],
    [236.8, 236.8],
    [0, 0],
  ])('round2(%s) = %s', (n, r) => {
    expect(round2(n)).toBe(r);
  });

  it('negatif sıfır üretmez', () => {
    expect(Object.is(round2(-0.001), 0)).toBe(true);
  });

  it('round3 gram hassasiyeti', () => {
    expect(round3(9.4500000001)).toBe(9.45);
    expect(round3(4.0245)).toBe(4.025);
    expect(round3(0.1 + 0.2)).toBe(0.3);
  });
});

describe('para yardımcıları', () => {
  it('kuruş tamsayısıyla toplar', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney(Array(10).fill(0.1))).toBe(1);
    expect(sumMoney([947.2, 236.8])).toBe(1184);
    expect(toCents(1184.005)).toBe(118401);
  });
  it('çıkarma', () => {
    expect(subMoney(1642.5, 1184)).toBe(458.5);
    expect(subMoney(1527.75, 580.55)).toBe(947.2);
    expect(subMoney(0.3, 0.1)).toBe(0.2);
  });
  it('yüzde', () => {
    expect(pctOf(1527.75, 38)).toBe(580.55);
    expect(pctOf(947.2, 25)).toBe(236.8);
    expect(pctOf(2252, 27.5)).toBe(619.3);
    expect(pctOf(100, 0)).toBe(0);
  });
});

describe('büyük tutarda kuruş (Y108)', () => {
  // Y108 öncesi kural, birebir: her adımda 12 anlamlı basamak (cleanFloat = toPrecision(12), perfEquivalence testi).
  const old12 = (x: number) => (!Number.isFinite(x) || x === 0 ? (x === 0 ? 0 : x) : Number(x.toPrecision(12)));
  const oldRound = (n: number, d: number) => {
    if (!Number.isFinite(n)) return n;
    const c = old12(n);
    const f = 10 ** d;
    const out = ((c < 0 ? -1 : 1) * Math.round(old12(Math.abs(c) * f))) / f;
    return out === 0 ? 0 : out;
  };
  const oldPct = (amount: number, pct: number) => oldRound(old12(amount * pct) / 100, 2);

  it('1e9 altında round2, round3 ve pctOf sonuçları eskisiyle birebir aynı', () => {
    let seed = 20261112;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const gens = [
      () => Math.round(rnd() * 1e7) / 100, // tam kuruş
      () => (Math.floor(rnd() * 2e8) + 0.5) / 1000 - 1e5, // yarım kuruş, eksiler dahil
      () => (Math.floor(rnd() * 1e12) + 0.5) / 1000, // 1e9'a kadar yarım kuruş
      () => (rnd() * 2 - 1) * 999_999_999.999, // sınıra kadar her şey
      () => (Math.round(rnd() * 1e7) / 100) * (1 + Math.floor(rnd() * 40) / 100), // KDV, yakıt çarpanı
      () => Math.floor(rnd() * 1e9) + 0.0005, // round3 yarımı
      () => (rnd() - 0.5) * 10 ** Math.floor(rnd() * 21 - 12), // 1e-12 … 1e9 arası büyüklükler
    ];
    const fixed = [0, -0, 1.005, 2.675, 580.545, 99999999.995, 999_999_999.994, 999_999_999.995, -999_999_999.995, 999_999_999.9995, 1e9 - 1e-6, 0.1 + 0.2];
    let bad = 0;
    for (let i = 0; i < 200_000 + fixed.length; i++) {
      const v = i < fixed.length ? fixed[i]! : pick(gens)();
      if (!(Math.abs(v) < 1e9)) continue;
      if (!Object.is(round2(v), oldRound(v, 2))) bad++;
      if (!Object.is(round3(v), oldRound(v, 3))) bad++;
    }
    for (let i = 0; i < 100_000; i++) {
      const amount = pick(gens)();
      const pct = pick([18, 20, 27.5, 38, 1.5, 0.75, -10, 100, Math.round(rnd() * 10000) / 100]);
      if (!(Math.abs(amount * pct) < 1e11)) continue; // sonuç 1e9 altında
      if (!Object.is(pctOf(amount, pct), oldPct(amount, pct))) bad++;
    }
    expect(bad).toBe(0);
    function pick<T>(a: T[]): T {
      return a[Math.floor(rnd() * a.length)]!;
    }
  });

  it('1e10 üstünde kuruş korunur (eskiden ondalık hane siliniyordu)', () => {
    expect(round2(12_345_678_901.23)).toBe(12_345_678_901.23);
    expect(oldRound(12_345_678_901.23, 2)).toBe(12_345_678_901.2); // eski kayıp, karşılaştırma için
    expect(round2(12_345_678_901.235)).toBe(12_345_678_901.24);
    expect(round2(-12_345_678_901.235)).toBe(-12_345_678_901.24);
    expect(round2(1_234_567_890.125)).toBe(1_234_567_890.13);
    expect(round3(1_234_567_890.1235)).toBe(1_234_567_890.124);
    expect(toCents(98_765_432_109.87)).toBe(9_876_543_210_987);
    expect(sumMoney([10_000_000_000.01, 0.02])).toBe(10_000_000_000.03);
    expect(subMoney(98_765_432_109.87, 0.01)).toBe(98_765_432_109.86);
    expect(pctOf(12_345_678_901.23, 100)).toBe(12_345_678_901.23);
    expect(pctOf(50_000_000_000.1, 20)).toBe(10_000_000_000.02);
  });

  it('1e9 üstünde çift yuvarlama yok: …,0049 aşağı, yazılan ondalığa göre yarım-yukarı', () => {
    // Tek yarım paylı temizlik (tam + ondalık + 1 basamak) bunları önce …5'e, sonra yukarı yuvarlıyordu.
    expect(round2(1_234_567_890.0049)).toBe(1_234_567_890);
    expect(round2(-1_234_567_890.0049)).toBe(-1_234_567_890);
    expect(round2(9_559_110_737.4645)).toBe(9_559_110_737.46);
    expect(round2(9_999_999_999.9949)).toBe(9_999_999_999.99);
    expect(round2(12_345_678_901.2349)).toBe(12_345_678_901.23);
    expect(round3(1_234_567_890.12345)).toBe(1_234_567_890.123);
    expect(pctOf(9_935_604_261.67, 38)).toBe(3_775_529_619.43); // tam sonuç 3775529619,4346
    // Yazılan değer 15 anlamlı basamağa sığıyorsa sonuç tam ondalık hesapla (BigInt) aynıdır.
    const ref = (s: string, d: number) => {
      const neg = s.startsWith('-');
      const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
      const scale = f.length;
      let q = BigInt(i! + f);
      if (scale <= d) q *= 10n ** BigInt(d - scale);
      else {
        const div = 10n ** BigInt(scale - d);
        q = q / div + ((q % div) * 2n >= div ? 1n : 0n);
      }
      const t = q.toString().padStart(d + 1, '0');
      return Number(`${neg ? '-' : ''}${t.slice(0, t.length - d)}.${t.slice(t.length - d)}`);
    };
    let seed = 108;
    const rnd = (k: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
    let bad = 0;
    for (let n = 0; n < 20_000; n++) {
      const intDigits = 10 + rnd(2);
      const dec = rnd(5);
      let s = String(1 + rnd(9));
      for (let j = 1; j < intDigits; j++) s += rnd(10);
      if (dec) s += '.' + Array.from({ length: dec }, () => rnd(10)).join('').replace(/.$/, rnd(2) ? '5' : String(rnd(10)));
      if (rnd(3) === 0) s = '-' + s;
      const v = Number(s);
      if (!Object.is(round2(v), ref(s, 2)) || !Object.is(round3(v), ref(s, 3))) bad++;
    }
    expect(bad).toBe(0);
  });

  it('1e13 üstünde sonuç yine kuruş katı (r / 100 bölmesi artık bırakmaz)', () => {
    expect(round2(849_977_758_444_469.5)).toBe(849_977_758_444_470); // eskiden 849977758444470.1
    expect(round2(-268_501_538_135_693.75)).toBe(-268_501_538_135_694); // eskiden −…694.03
    expect(round3(47_099_588_726_108.5)).toBe(47_099_588_726_108.5); // eskiden …108.49
  });

  it('bilinen sınır: ~1e13 üstünde 15 basamak yetmez, kuruş yine kaybolur', () => {
    expect(round2(12_345_678_901_234.56)).toBe(12_345_678_901_234.6);
  });
});

describe('kenar yuvarlama ve hacimsel ağırlık', () => {
  it('CEIL_CM kenarları yukarı yuvarlar', () => {
    expect(roundEdges({ l: 40.2, w: 30, h: 24.01 }, 'CEIL_CM')).toEqual({ l: 41, w: 30, h: 25 });
    expect(roundEdges({ l: 40.2, w: 30, h: 24.01 }, 'NONE')).toEqual({ l: 40.2, w: 30, h: 24.01 });
  });
  it('kayan nokta artığı tam sayıyı bir üste taşımaz', () => {
    expect(roundEdges({ l: 0.1 * 3 * 100, w: 30, h: 25 }, 'CEIL_CM').l).toBe(30);
  });
  it('#5305: 40×30×25 / 5000 = 6,0 kg', () => {
    expect(volumetricWeight({ l: 40, w: 30, h: 25 }, 5000)).toBe(6);
  });
  it('FedEx ölçüsü 45×35×30 / 5000 = 9,45', () => {
    expect(volumetricWeight({ l: 45, w: 35, h: 30 }, 5000)).toBe(9.45);
  });
  it('varsayılan CEIL_CM, NONE seçilebilir', () => {
    expect(volumetricWeight({ l: 40.5, w: 30, h: 25 }, 5000)).toBe(6.15);
    expect(volumetricWeight({ l: 40.5, w: 30, h: 25 }, 5000, 'NONE')).toBe(6.075);
  });
  it('3 ondalık', () => {
    expect(volumetricWeight({ l: 33, w: 27, h: 19 }, 5000)).toBe(3.386);
  });
  it('geçersiz bölen 0 döner', () => {
    expect(volumetricWeight({ l: 1, w: 1, h: 1 }, 0)).toBe(0);
  });
  it('desi (bölen 3000 varsayılan, 2 ondalık)', () => {
    expect(desi({ l: 40, w: 30, h: 25 })).toBe(10);
    expect(desi({ l: 40, w: 30, h: 25 }, 5000)).toBe(6);
    expect(desi({ l: 33, w: 27, h: 19 })).toBe(5.64);
  });
  it('desi karşılaştırmayla aynı kenar kuralını uygular (04-B15: varsayılan CEIL_CM)', () => {
    // telefonda 39,6 × 30 × 25 ölçüldü: karşılaştırma kenarı 40'a yuvarlar → 10 desi; ekran da 10 göstermeli (9,9 değil)
    expect(desi({ l: 39.6, w: 30, h: 25 })).toBe(10);
    expect(desi({ l: 44.6, w: 34.8, h: 29.7 }, 3000)).toBe(15.75);
    expect(desi({ l: 39.6, w: 30, h: 25 }, 3000, 'NONE')).toBe(9.9);
    for (const d of [{ l: 39.6, w: 30, h: 25 }, { l: 59.6, w: 49.8, h: 25 }, { l: 12.1, w: 8.4, h: 3.3 }]) {
      for (const div of [3000, 5000]) {
        // karşılaştırmanın kenarları (volumetricWeight → roundEdges CEIL_CM) ile hesaplanan desi
        expect({ d, div, desi: desi(d, div) }).toEqual({ d, div, desi: desi(roundEdges(d, 'CEIL_CM'), div, 'NONE') });
      }
    }
  });
  it('sortedEdges yön bağımsız', () => {
    expect(sortedEdges({ l: 25, w: 40, h: 30 })).toEqual([40, 30, 25]);
  });
});

describe('roundUpToStep', () => {
  it.each([
    [9.45, 9.5],
    [21.2, 22],
    [6, 6],
    [6.001, 6.5],
    [0.1, 0.5],
    [19.99, 20],
    [20, 20],
    [20.01, 21],
    [4.8, 5],
    [5.4, 5.5],
  ])('%s → %s', (kg, r) => {
    expect(roundUpToStep(kg, DEFAULT_WEIGHT_STEPS)).toBe(r);
  });
  it('boş liste yuvarlamaz', () => {
    expect(roundUpToStep(9.45, [])).toBe(9.45);
  });
  it('desi basamağı 1', () => {
    expect(roundUpToStep(9.01, [{ upto: null, step: 1 }])).toBe(10);
    expect(roundUpToStep(10, [{ upto: null, step: 1 }])).toBe(10);
  });
  it('kapalı son bandın üstünde son bandın adımı kullanılır', () => {
    expect(roundUpToStep(31.2, [{ upto: 30, step: 0.5 }])).toBe(31.5);
  });
  it('kayan nokta: 0.1+0.2 ile 0,3 aynı basamakta', () => {
    expect(roundUpToStep(0.1 + 0.2, [{ upto: null, step: 0.1 }])).toBe(0.3);
  });
});

describe('chargeableWeight', () => {
  it('#5305: hacimsel 6,0, ücretli 6,0', () => {
    expect(chargeableWeight({ dims: { l: 40, w: 30, h: 25 }, actualKg: 4, divisor: 5000, steps: DEFAULT_WEIGHT_STEPS })).toEqual({
      volumetric: 6,
      chargeable: 6,
      basis: 'VOLUMETRIC',
    });
  });
  it('FedEx 45×35×30 4,0 kg → 9,5', () => {
    expect(chargeableWeight({ dims: { l: 45, w: 35, h: 30 }, actualKg: 4, divisor: 5000, steps: DEFAULT_WEIGHT_STEPS }).chargeable).toBe(9.5);
  });
  it('gerçek ağırlık büyükse ACTUAL', () => {
    expect(chargeableWeight({ dims: { l: 20, w: 20, h: 20 }, actualKg: 4.8, divisor: 5000, steps: DEFAULT_WEIGHT_STEPS })).toEqual({
      volumetric: 1.6,
      chargeable: 5,
      basis: 'ACTUAL',
    });
  });
  it('bölen 3000 → 10 desi', () => {
    expect(chargeableWeight({ dims: { l: 40, w: 30, h: 25 }, actualKg: 4, divisor: 3000, steps: [{ upto: null, step: 1 }] }).chargeable).toBe(10);
  });
  it('basamak verilmezse yuvarlama yok', () => {
    expect(chargeableWeight({ dims: { l: 45, w: 35, h: 30 }, actualKg: 4, divisor: 5000 }).chargeable).toBe(9.45);
  });
});
