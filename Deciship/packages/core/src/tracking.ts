const SEPARATORS = /[\s\u00a0\u202f‐-―-]/g;

/** Yalnızca boşluk/tire temizler ve büyük harfe çevirir (FedEx kısaltması yapmaz). */
export function cleanTracking(raw: string): string {
  return String(raw ?? '')
    .replace(SEPARATORS, '')
    .toLocaleUpperCase('en-US');
}

/** Boşluk ve tireleri temizler, büyük harfe çevirir; FedEx 34 haneli barkodda son 12 haneyi döner. */
export function normalizeTracking(raw: string): string {
  const n = cleanTracking(raw);
  return isFedexLongBarcode(n) ? n.slice(-12) : n;
}

/** FedEx 34 haneli Code 128 (96… ile başlar) barkodu mu? */
export function isFedexLongBarcode(normalized: string): boolean {
  return /^96\d{32}$/.test(normalized);
}

/**
 * Eşleşme adayları: normalize edilmiş değer; FedEx 34 haneli barkod için son 12 hane (birincil), son 15 hane ve tamamı.
 * İlk eleman her zaman normalizeTracking(raw) ile aynıdır.
 */
export function trackingCandidates(raw: string): string[] {
  const n = cleanTracking(raw);
  if (!n) return [];
  if (isFedexLongBarcode(n)) return [n.slice(-12), n.slice(-15), n];
  return [n];
}

export const MIN_SUFFIX_MATCH = 10;

/**
 * İki takip no'nun eşleşme düzeyi: 1 = normalize tam eşit (adaylar dahil), 2 = biri diğerinin soneki (≥ 10 karakter),
 * 3 = ham değer eşit, null = eşleşmez. Küçük değer daha güçlü eşleşmedir.
 */
export function trackingMatchLevel(a: string, b: string): 1 | 2 | 3 | null {
  const ca = trackingCandidates(a);
  const cb = trackingCandidates(b);
  if (ca.length && cb.length && ca.some((x) => cb.includes(x))) return 1;
  for (const x of ca) {
    for (const y of cb) {
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= MIN_SUFFIX_MATCH && long.endsWith(short)) return 2;
    }
  }
  const ra = String(a ?? '').trim();
  if (ra !== '' && ra === String(b ?? '').trim()) return 3;
  return null;
}

/** Listeden en iyi eşleşeni seçer (önce düzey, sonra listedeki sıra). */
export function findBestTrackingMatch<T>(raw: string, items: T[], key: (t: T) => string): T | null {
  let best: T | null = null;
  let bestLevel = 4;
  for (const it of items) {
    const lvl = trackingMatchLevel(raw, key(it));
    if (lvl != null && lvl < bestLevel) {
      best = it;
      bestLevel = lvl;
      if (lvl === 1) break;
    }
  }
  return best;
}
