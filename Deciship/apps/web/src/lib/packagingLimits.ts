// Taşıyıcı ayarındaki poşet (Pak) / zarf sınırı formu (saf; tarayıcısız sınanır). Boş alan = taşıyıcı kodunun varsayılanı
// (core `packagingLimitsFor`); sınırın anlamı ve denetimi sunucuda/core'da, burada yalnız formdan gövdeye çeviri.
import { packagingLimitsFor, type CarrierCode, type PackagingLimits } from '@deciship/core';
import { numToInput, parseMeasure, parseTrNumber } from './format';

export interface LimitsForm {
  pakKg: string;
  pakVolume: string;
  envKg: string;
  /** zarf kenarları, cm (büyükten küçüğe yazılması gerekmez; sunucu/core sıralar) */
  envEdges: [string, string, string];
}

/** Kayıtlı ayardan form (ayar yoksa boş: varsayılan geçerli). */
export function limitsForm(saved: PackagingLimits | null | undefined): LimitsForm {
  const e = saved?.ENVELOPE?.maxEdgesCm;
  return {
    pakKg: numToInput(saved?.PAK?.maxKg),
    pakVolume: numToInput(saved?.PAK?.maxVolumeCm3 ?? undefined, 0),
    envKg: numToInput(saved?.ENVELOPE?.maxKg),
    envEdges: [numToInput(e?.[0], 1), numToInput(e?.[1], 1), numToInput(e?.[2], 1)],
  };
}

/** Taşıyıcı kodunun varsayılanı (yer tutucu); bilinmeyen alan null. */
export function defaultLimits(code: CarrierCode | null | undefined): PackagingLimits {
  return packagingLimitsFor(code ?? null, null);
}

export type LimitsError = 'number' | 'pakKgRequired' | 'envKgRequired' | 'edgesPartial';

/**
 * Form → `PATCH /carriers/:id` `packagingLimits`. Bir ambalajın bütün alanları boşsa o ambalaj yazılmaz (varsayılan); dolu
 * alanların yanındaki boş alan varsayılandan tamamlanır (kişi yalnız kg'ı değiştirse de varsayılan hacim kalır). Hiçbiri
 * yoksa null (ayar silinir, varsayılan geçerli).
 */
export function limitsFromForm(f: LimitsForm, code: CarrierCode | null | undefined): { limits: PackagingLimits | null; error: LimitsError | null } {
  const def = defaultLimits(code);
  const kg = (s: string) => (s.trim() ? parseMeasure(s) : undefined);
  const vol = (s: string) => (s.trim() ? parseTrNumber(s) : undefined);
  const pos = (n: number | null | undefined) => n === undefined || (n !== null && n > 0);
  const pakKg = kg(f.pakKg);
  const pakVolume = vol(f.pakVolume);
  const envKg = kg(f.envKg);
  const edges = f.envEdges.map(kg);
  if (![pakKg, pakVolume, envKg, ...edges].every(pos)) return { limits: null, error: 'number' };
  const out: PackagingLimits = {};
  if (pakKg !== undefined || pakVolume !== undefined) {
    const maxKg = pakKg ?? def.PAK?.maxKg;
    if (maxKg == null) return { limits: null, error: 'pakKgRequired' };
    out.PAK = { maxKg, maxVolumeCm3: pakVolume ?? def.PAK?.maxVolumeCm3 ?? null };
  }
  const anyEdge = edges.some((x) => x !== undefined);
  if (anyEdge && edges.some((x) => x === undefined)) return { limits: null, error: 'edgesPartial' };
  if (envKg !== undefined || anyEdge) {
    const maxKg = envKg ?? def.ENVELOPE?.maxKg;
    if (maxKg == null) return { limits: null, error: 'envKgRequired' };
    const maxEdgesCm = anyEdge ? (edges as number[]).slice().sort((a, b) => b - a) : (def.ENVELOPE?.maxEdgesCm ?? null);
    out.ENVELOPE = { maxKg, ...(maxEdgesCm ? { maxEdgesCm: maxEdgesCm as [number, number, number] } : {}) };
  }
  return { limits: out.PAK || out.ENVELOPE ? out : null, error: null };
}
