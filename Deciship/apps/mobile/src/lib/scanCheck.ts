import { checkTracking, extractTracking } from '@deciship/core/trackingFormat';

/**
 * Barkod ekranında okunan değerle ne yapılacağı (KALANLAR 4.8). Kural core `trackingFormat.ts`'te, sunucu da aynısını kullanır.
 * - `proceed`: takip no gibi görünüyor, akış sürer.
 * - `confirm`: takip no'ya benzemiyor (ürün barkodu, yarım okuma, adres…): tek soru, "Yine de devam et" seçilebilir.
 *   Bilinmeyen biçimli gerçek takip no'lar olabilir; sert engel değildir.
 * - `reject`: kesin geçersiz (çok kısa, çok uzun, yasak karakter): sunucu da reddeder, kayıt "Hatalı" kalırdı; yeniden okutulur.
 * - `ignore`: boş girdi.
 * `code`: taslağa yazılacak değer. Barkodun içinden takip no ayıklanabildiyse yalnız o (2D barkodun tüm iletisi ya da 34
 * haneli FedEx barkodu değil, core `extractTracking`); değilse ham değer (görünmez işaretler silinmiş, boşluk ve tire durur).
 */
export type ScanDecision = { code: string; action: 'proceed' | 'confirm' | 'reject' | 'ignore' };

export function scanDecision(raw: string, symbology?: string | null): ScanDecision {
  const { code, action } = scanCandidate(raw, symbology);
  return { code, action };
}

/**
 * Kameranın bir okuması, sıralamaya hazır. `score` (büyük daha iyi): 4 barkodun içinden ayıklanmış ve taşıyıcı biçimini
 * tutan takip no (kesin), 3 taşıyıcı biçimini tutan değer, 2 biçimi bilinmeyen ama olağan değer, 1 olağan dışı, 0 geçersiz.
 * `inFrame`: barkod nişan çerçevesinin içinde mi (`null`: konum bilinmiyor ya da güvenilmez).
 */
export type ScanCandidate = ScanDecision & { score: number; inFrame: boolean | null; seenAt: number };

export function scanCandidate(raw: string, symbology?: string | null, seen: { inFrame?: boolean | null; at?: number } = {}): ScanCandidate {
  const { value: code, source } = extractTracking(raw);
  const base = { code, inFrame: seen.inFrame ?? null, seenAt: seen.at ?? 0 };
  if (!code) return { ...base, action: 'ignore', score: -1 };
  const { verdict, carriers } = checkTracking(code, { symbology });
  if (verdict === 'invalid') return { ...base, action: 'reject', score: 0 };
  if (verdict === 'unusual') return { ...base, action: 'confirm', score: 1 };
  return { ...base, action: 'proceed', score: carriers.length ? (source !== 'none' ? 4 : 3) : 2 };
}

/** En uygun okuma: önce puan, eşitse çerçevenin içindeki, sonra ilk görülen. */
export function pickScan(cands: readonly ScanCandidate[]): ScanCandidate | null {
  let best: ScanCandidate | null = null;
  for (const c of cands) {
    if (c.action === 'ignore') continue;
    if (!best) {
      best = c;
      continue;
    }
    if (c.score !== best.score) {
      if (c.score > best.score) best = c;
      continue;
    }
    const cin = c.inFrame === true;
    const bin = best.inFrame === true;
    if (cin !== bin) {
      if (cin) best = c;
      continue;
    }
    if (c.seenAt < best.seenAt) best = c;
  }
  return best;
}

/**
 * Etikette birden çok barkod var (FedEx: 2D PDF417, 34 haneli barkod, form kodu…) ve kamera her karede yalnız birini verir.
 * İlk okumadan sonra bir an daha beklenir, gelenlerin en uygunu alınır: yanlış numara almaktansa beklemek iyidir.
 * Kesin okuma (puan 4) beklemez; taşıyıcı biçimini tutan kısa, ötekiler uzun bekler.
 */
export const SCAN_WAIT_MS = 350;
export const SCAN_WAIT_WEAK_MS = 1200;

/** İlk okumadan kaç ms sonra en iyi adayla karar verilir. */
export function scanWaitMs(best: ScanCandidate): number {
  if (best.score >= 4) return 0;
  return best.score >= 3 ? SCAN_WAIT_MS : SCAN_WAIT_WEAK_MS;
}

/** Nişan çerçevesi (`scan.tsx` çizer): görünüm genişliğinin oranı, en çok genişlik (dp), en/boy. */
export const SCAN_FRAME = { widthPct: 64, maxWidth: 260, aspect: 1.7 } as const;

type Pt = { x: number; y: number };
export type BarcodePlace = { cornerPoints?: readonly Pt[] | null; bounds?: { origin: Pt; size: { width: number; height: number } } | null };

/**
 * Barkodun ortası nişan çerçevesinde mi (görünüm koordinatı, dp; Android expo-camera bunları görünüme çevirir). Çerçeve
 * kılavuz yazısı yüzünden biraz yukarıdadır ve el titrer: pay bırakılır. Konum yoksa ya da görünümün dışına düşüyorsa
 * (başka koordinat düzeni) `null`: sıralamada kullanılmaz.
 */
export function barcodeInFrame(place: BarcodePlace, view: { width: number; height: number } | null): boolean | null {
  if (!view || !(view.width > 0) || !(view.height > 0)) return null;
  let cx: number;
  let cy: number;
  const pts = place.cornerPoints ?? [];
  if (pts.length >= 3) {
    cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  } else if (place.bounds && place.bounds.size.width > 0 && place.bounds.size.height > 0) {
    cx = place.bounds.origin.x + place.bounds.size.width / 2;
    cy = place.bounds.origin.y + place.bounds.size.height / 2;
  } else return null;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0 || cx > view.width || cy > view.height) return null;
  const fw = Math.min((view.width * SCAN_FRAME.widthPct) / 100, SCAN_FRAME.maxWidth);
  const fh = fw / SCAN_FRAME.aspect;
  const mx = fw * 0.15;
  const my = fh * 0.25 + 20;
  const left = (view.width - fw) / 2 - mx;
  const top = (view.height - fh) / 2 - my;
  return cx >= left && cx <= left + fw + 2 * mx && cy >= top && cy <= top + fh + 2 * my;
}
