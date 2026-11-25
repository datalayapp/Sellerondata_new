import { useEffect, useRef } from 'react';
import type { MeasurementDetail, MeasurementItem } from '../api/endpoints';

/**
 * Bellekte küçük bir ölçüm önbelleği + değişiklik olayı.
 * - Liste öğesi dokununca detay hemen (ağdan önce) çizilsin diye özet saklanır.
 * - Düzeltme yeni sürüm (yeni id) yazar: eski id → yeni id eşlemesi detay ekranını güncel sürüme taşır.
 * - Düzenle/sil/geri al sonrası Bugün ve Geçmiş listeleri `onMeasurementsChanged` ile yenilenir.
 */
const items = new Map<string, MeasurementItem | MeasurementDetail>();
const replaced = new Map<string, string>();
const listeners = new Set<() => void>();

export const measurementCache = {
  put(m: MeasurementItem | MeasurementDetail) {
    const prev = items.get(m.id);
    // Tam detay, sonradan gelen liste özetiyle ezilmesin.
    if (prev && 'photos' in prev && !('photos' in m)) return;
    items.set(m.id, m);
  },
  putMany(list: MeasurementItem[]) {
    list.forEach((m) => measurementCache.put(m));
  },
  get(id: string) {
    return items.get(id) ?? null;
  },
  getDetail(id: string): MeasurementDetail | null {
    const m = items.get(id);
    return m && 'photos' in m ? m : null;
  },
  /** Düzeltme sonrası: eski sürümü açan ekran yeni sürüme geçer. */
  replace(oldId: string, next: MeasurementDetail) {
    replaced.set(oldId, next.id);
    items.delete(oldId);
    items.set(next.id, next);
  },
  resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 20 && replaced.has(cur); i++) cur = replaced.get(cur)!;
    return cur;
  },
  /** Oturum (kişi veya firma) değişti: başka firmanın ölçümü bellekte kalmaz. */
  clear() {
    items.clear();
    replaced.clear();
  },
};

export function emitMeasurementsChanged() {
  listeners.forEach((fn) => fn());
}

export function useMeasurementsChanged(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = () => ref.current();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}
