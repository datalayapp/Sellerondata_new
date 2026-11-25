/**
 * Sağlam istatistik yardımcıları: medyan, çeyrekler, IQR. Uç değerler (kullanıcının bir kez yaptığı tuhaf düzeltme)
 * ortalamayı bozar; öğrenme her yerde medyan ve çeyrek kullanır.
 */

export interface Robust {
  n: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

/** Doğrusal ara değerli yüzdelik (p: 0..1). Sonlu olmayan değerler atılır. */
export function percentile(xs: readonly number[], p: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

export const median = (xs: readonly number[]) => percentile(xs, 0.5);

/** Sağlam özet; değer yoksa null. */
export function robust(xs: readonly number[]): Robust | null {
  const s = xs.filter((x) => Number.isFinite(x));
  if (!s.length) return null;
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  return {
    n: s.length,
    median: percentile(s, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    p10: percentile(s, 0.1),
    p90: percentile(s, 0.9),
    min: Math.min(...s),
    max: Math.max(...s),
  };
}

/** Yuvarlama (gösterim ve öneri değerleri için). */
export const round = (x: number, d = 3) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Tek boyutlu k-medyan: değerleri verilen tohumlara en yakın kümeye atar, küme medyanlarını yeniler (birkaç tur).
 * Satır sınıfı oranlarını (ikincil / üçüncül) mevcut profil değerlerinden başlayarak ayırmak için.
 */
export function kMedians(xs: readonly number[], seeds: readonly number[], rounds = 12): { centers: number[]; groups: number[][] } {
  let centers = [...seeds];
  let groups: number[][] = centers.map(() => []);
  for (let r = 0; r < rounds; r++) {
    groups = centers.map(() => []);
    for (const x of xs) {
      let best = 0;
      for (let i = 1; i < centers.length; i++) if (Math.abs(x - centers[i]!) < Math.abs(x - centers[best]!)) best = i;
      groups[best]!.push(x);
    }
    const next = groups.map((g, i) => (g.length ? median(g) : centers[i]!));
    if (next.every((c, i) => Math.abs(c - centers[i]!) < 1e-9)) break;
    centers = next;
  }
  return { centers, groups };
}

/** Sayım tablosu (en sık başta). */
export function countBy<T>(xs: readonly T[], key: (x: T) => string): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
