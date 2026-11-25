import type { HubErrorKind } from './http';

/**
 * Bir bölümün veri durumu. Saf durum makinesi: sayfa değil bölüm düşer.
 * - `holding`: dönem değişti, eski dönemin verisi soluk tutuluyor (iskelet yanıp sönmesin).
 * - `failed`: son deneme başarısız. Veri varsa son veriyle ayakta kalır, ekran "son güncelleme" yazar.
 */
export type ResourceState<T> = {
  key: string | null;
  status: 'loading' | 'ready' | 'error' | 'forbidden';
  data: T | null;
  /** Verinin alındığı an. */
  at: number | null;
  busy: boolean;
  holding: boolean;
  failed: Exclude<HubErrorKind, 'forbidden'> | null;
};

export type ResourceAction<T> =
  | { type: 'start'; key: string; cached: { at: number; data: T } | null }
  | { type: 'success'; key: string; data: T; at: number }
  | { type: 'failure'; key: string; kind: HubErrorKind };

export const emptyResource = <T>(): ResourceState<T> => ({ key: null, status: 'loading', data: null, at: null, busy: true, holding: false, failed: null });

export function resourceReducer<T>(s: ResourceState<T>, a: ResourceAction<T>): ResourceState<T> {
  if (a.type === 'start') {
    if (a.key === s.key) return { ...s, busy: true, failed: null, status: s.data !== null ? 'ready' : 'loading' };
    if (a.cached) return { key: a.key, status: 'ready', data: a.cached.data, at: a.cached.at, busy: true, holding: false, failed: null };
    if (s.data !== null) return { ...s, key: a.key, status: 'ready', busy: true, holding: true, failed: null };
    return { key: a.key, status: 'loading', data: null, at: null, busy: true, holding: false, failed: null };
  }
  // Geç gelen eski yanıt yeni dönemin üstüne yazmaz.
  if (a.key !== s.key) return s;
  if (a.type === 'success') return { key: a.key, status: 'ready', data: a.data, at: a.at, busy: false, holding: false, failed: null };
  if (a.kind === 'forbidden') return { key: a.key, status: 'forbidden', data: null, at: null, busy: false, holding: false, failed: null };
  // Soluk tutulan başka dönemin verisidir: hata altında gösterilmez, yanlış sayı okunmasın.
  if (s.data !== null && !s.holding) return { ...s, status: 'ready', busy: false, failed: a.kind };
  return { key: a.key, status: 'error', data: null, at: null, busy: false, holding: false, failed: a.kind };
}
