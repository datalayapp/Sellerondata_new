/**
 * Gönderinin ambalajı (kendi ambalajı / taşıyıcı poşeti / taşıyıcı zarfı) için mobil kuralları. Saf modül: React almaz.
 * Sınır ve ad kuralı core'da (`@deciship/core/packaging`); burada taşıyıcının bulunması, firma ayarının okunması ve
 * kaydetmeden önceki uyarının kararı durur.
 */
import { DEFAULT_WEIGHT_STEPS, roundUpToStep } from '@deciship/core/calc';
import {
  PACKAGINGS,
  packagingFit,
  packagingLimitsFor,
  pricedPackaging,
  suggestPackaging,
  volumeCm3,
  type Packaging,
  type PackagingFitReason,
  type PackagingLimits,
} from '@deciship/core/packaging';
import { checkTracking, type TrackingCheck } from '@deciship/core/trackingFormat';

export type { Packaging, PackagingFitReason, PackagingLimits };
/** Ambalajı tanınan taşıyıcı kodları (core `CarrierCode`, `generic` hariç). */
export type PackagingCarrier = TrackingCheck['carriers'][number];

/** Firma ayarı yanıtındaki ambalaj bilgisi (`GET /settings` → `packaging`). Eski sunucu göndermez: boş. */
export type PackagingSettings = {
  /** Barkoddan taşıyıcı bulunamazsa kullanılan taşıyıcı (varsayılan tarifenin taşıyıcısı); yoksa null. */
  primaryCarrier: PackagingCarrier | null;
  /** Etkin taşıyıcıların etkin sınırları, koda göre. */
  carriers: Partial<Record<PackagingCarrier, PackagingLimits>>;
};

export const EMPTY_PACKAGING_SETTINGS: PackagingSettings = Object.freeze({ primaryCarrier: null, carriers: Object.freeze({}) }) as PackagingSettings;

const CARRIERS: readonly PackagingCarrier[] = ['fedex', 'ups', 'dhl', 'aras', 'yurtici', 'mng', 'ptt'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCarrier = (v: unknown): v is PackagingCarrier => typeof v === 'string' && (CARRIERS as readonly string[]).includes(v);

export function isPackaging(v: unknown): v is Packaging {
  return typeof v === 'string' && (PACKAGINGS as readonly string[]).includes(v);
}

/** Kayıttaki ambalaj; alan yoksa ya da tanınmıyorsa (eski kuyruk kaydı, eski sunucu) kendi ambalajı. */
export function packagingOf(v: { packaging?: unknown } | null | undefined): Packaging {
  return isPackaging(v?.packaging) ? v.packaging : 'OWN';
}

/** Sunucudan (ya da önbellekten) gelen ambalaj ayarı; bozuk parçalar atılır. Sınır değerleri core'da yeniden doğrulanır. */
export function normalizePackagingSettings(raw: unknown): PackagingSettings {
  if (!isObj(raw)) return EMPTY_PACKAGING_SETTINGS;
  const carriers: PackagingSettings['carriers'] = {};
  if (isObj(raw.carriers)) {
    for (const [code, limits] of Object.entries(raw.carriers)) {
      if (!isCarrier(code) || !isObj(limits)) continue;
      const out: PackagingLimits = {};
      if ('PAK' in limits) out.PAK = isObj(limits.PAK) ? (limits.PAK as PackagingLimits['PAK']) : null;
      if ('ENVELOPE' in limits) out.ENVELOPE = isObj(limits.ENVELOPE) ? (limits.ENVELOPE as PackagingLimits['ENVELOPE']) : null;
      carriers[code] = out;
    }
  }
  return { primaryCarrier: isCarrier(raw.primaryCarrier) ? raw.primaryCarrier : null, carriers };
}

/**
 * Ambalajın taşıyıcısı: takip no tek bir taşıyıcının biçimine uyuyorsa o; uymuyorsa ya da birden çok taşıyıcıya uyuyorsa
 * firmanın ana taşıyıcısı; o da yoksa null (genel ad, sınır bilinmez). Ölçüm kaydında taşıyıcı tutulmaz.
 */
export function packagingCarrier(
  trackingRaw: string | null | undefined,
  settings: Pick<PackagingSettings, 'primaryCarrier'> | null | undefined,
): PackagingCarrier | null {
  const raw = (trackingRaw ?? '').trim();
  if (raw) {
    const found = checkTracking(raw).carriers;
    if (found.length === 1) return found[0]!;
  }
  return settings?.primaryCarrier ?? null;
}

/** Taşıyıcının etkin sınırları: firma ayarındaki sınır > core varsayılanı > bilinmiyor. */
export function carrierLimits(carrier: PackagingCarrier | null, settings: Pick<PackagingSettings, 'carriers'> | null | undefined): PackagingLimits {
  if (!carrier) return {};
  return packagingLimitsFor(carrier, settings?.carriers?.[carrier]);
}

export type Dims3 = { l: number | null; w: number | null; h: number | null };
const dimsOf = ({ l, w, h }: Dims3) => (l && w && h && l > 0 && w > 0 && h > 0 ? { l, w, h } : null);

/** Seçili özel ambalajın sınırı karşısındaki durum (ölçü ekranındaki sınır kartı). OWN için null. */
export type LimitView = {
  packaging: Exclude<Packaging, 'OWN'>;
  /** Sınır bilinmiyor: kart yerine kısa bilgi, uyarı yok. */
  known: boolean;
  maxKg: number | null;
  maxVolumeCm3: number | null;
  /** Zarfın kenar sınırı (cm, büyükten küçüğe); yoksa null. */
  maxEdgesCm: [number, number, number] | null;
  volumeCm3: number | null;
  /** true sınır içinde, false aşıyor, null henüz denetlenemiyor (ağırlık ya da ölçü yok). */
  ok: boolean | null;
  reasons: PackagingFitReason[];
  /** Sınır içindeyse ücretli ağırlık: gerçek kg, yaygın basamağa yukarı (desi uygulanmaz). */
  chargeableKg: number | null;
};

export function limitView(p: Packaging, kg: number | null, dims: Dims3, limits: PackagingLimits): LimitView | null {
  if (p === 'OWN') return null;
  const pak = p === 'PAK' ? limits.PAK : null;
  const env = p === 'ENVELOPE' ? limits.ENVELOPE : null;
  const maxKg = pak?.maxKg ?? env?.maxKg ?? null;
  const maxVolumeCm3 = pak?.maxVolumeCm3 ?? null;
  const maxEdgesCm = env?.maxEdgesCm ?? null;
  const d = dimsOf(dims);
  const vol = d ? volumeCm3(d) : null;
  if (maxKg === null)
    return { packaging: p, known: false, maxKg: null, maxVolumeCm3: null, maxEdgesCm: null, volumeCm3: vol, ok: null, reasons: [], chargeableKg: null };
  const hasKg = kg !== null && kg > 0;
  const fit = hasKg ? packagingFit(p, kg, d, limits) : null;
  const reasons = fit?.reasons ?? [];
  // Ağırlık ya da (hacim ya da kenar sınırı varken) ölçü eksikse sonuç verilmez; bilinen bir aşım yine de gösterilir.
  const complete = hasKg && ((maxVolumeCm3 === null && maxEdgesCm === null) || d !== null);
  const ok = reasons.length ? false : complete ? fit!.ok === true : null;
  return {
    packaging: p,
    known: true,
    maxKg,
    maxVolumeCm3,
    maxEdgesCm,
    volumeCm3: vol,
    ok,
    reasons,
    chargeableKg: ok ? roundUpToStep(kg!, DEFAULT_WEIGHT_STEPS) : null,
  };
}

/**
 * Kaydetmeden önceki ambalaj uyarısı:
 * - `suggest`: kendi ambalajı seçili ama paket özel ambalaja sığıyor (en ucuz önerilir; sınırı bilinmeyen önerilmez);
 * - `over`: poşet/zarf seçili ama sınırı aşıyor (`priced`: taşıyıcının bu paketi fiyatlayacağı ambalaj).
 * Ağırlık ya da ölçü eksikse ya da sınır bilinmiyorsa uyarı yok.
 */
export type PackagingWarning =
  { kind: 'suggest'; to: Exclude<Packaging, 'OWN'> } | { kind: 'over'; from: Exclude<Packaging, 'OWN'>; reasons: PackagingFitReason[]; priced: Packaging };

export function packagingWarning(p: Packaging, kg: number | null, dims: Dims3, limits: PackagingLimits): PackagingWarning | null {
  const d = dimsOf(dims);
  if (kg === null || !(kg > 0) || !d) return null;
  if (p === 'OWN') {
    const to = suggestPackaging(kg, d, limits);
    return to ? { kind: 'suggest', to } : null;
  }
  const fit = packagingFit(p, kg, d, limits);
  if (fit.ok !== false) return null;
  return { kind: 'over', from: p, reasons: fit.reasons, priced: pricedPackaging(p, kg, d, limits) };
}

/** Onayın anahtarı: ambalaj, ağırlık, ölçü ya da sınır değişince onay düşer. */
export function packagingCheckKey(p: Packaging, kg: number | null, dims: Dims3, limits: PackagingLimits): string {
  return [p, kg, dims.l, dims.w, dims.h, JSON.stringify(limits)].join('|');
}

/**
 * Aynı takip no yeniden ölçülürken taslağın ambalajı: önceki ölçümün (sunucu `check` yanıtındaki `last` ya da kuyruktaki
 * gönderilmemiş kayıt) ambalajı; alan yoksa kendi ambalajı. Önceki ölçüm yoksa taslağa dokunulmaz (boş yama).
 */
export function remeasurePackaging(previous: { packaging?: unknown } | null | undefined): { packaging?: Packaging } {
  return previous ? { packaging: packagingOf(previous) } : {};
}
