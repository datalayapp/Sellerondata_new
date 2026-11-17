import { File } from 'expo-file-system';
import type { SessionScope } from '../auth/token';
import { ApiError, productJson, type FetchInit } from './client';

/** DeciShip API kökü: `/api/deciship`. */
const api = <T,>(path: string, init?: FetchInit) => productJson<T>('deciship', path, init);

export type DimMethod = 'LIDAR' | 'AR' | 'REFERENCE' | 'MANUAL' | 'PRESET';
export type WeightMethod = 'OCR' | 'MANUAL';
export type PhotoKind = 'PHOTO_BOX' | 'PHOTO_SCALE' | 'PHOTO_LABEL' | 'PHOTO_OTHER';
export type Point = [number, number];

/** `warnEdgeCm`, `warnWeightKg`: akla aykırı ölçü uyarısının eşikleri (Y44; `lib/plausibility.ts`). Eski sunucu göndermez. */
/** `scaleAiRead`: firma tartı fotoğrafını ücretli yapay zekâya okutuyor mu (kullanıcı kararı 2026-11-12; gelmezse kapalı). */
export type CompanySettings = { desiDivisor: number; requiredBoxPhotos: number; warnEdgeCm: number; warnWeightKg: number; scaleAiRead: boolean };

export type BoxPreset = { id: string; name: string; lengthCm: number; widthCm: number; heightCm: number; sortOrder?: number; active?: boolean };

export type MeasurementItem = {
  id: string;
  trackingNo: string;
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  desi?: number;
  volumetricKg5000?: number;
  dimMethod: DimMethod;
  weightMethod: WeightMethod;
  measuredAt: string;
  measuredBy?: { id: string; name: string };
  photoCount?: number;
  version?: number;
  note?: string | null;
  boxPresetId?: string | null;
  dimConfidence?: number | null;
  superseded?: boolean;
  deleted?: boolean;
};

export type MeasurementPhoto = { id: string; kind: PhotoKind; url: string };

/** `GET /measurements/:id` — fiyat alanı yok (çalışan). */
export type MeasurementDetail = MeasurementItem & {
  photos: MeasurementPhoto[];
  history?: MeasurementItem[];
  canEdit?: boolean;
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

/** PATCH gövdesi (§10.1). Yalnızca değişen alanlar gönderilir. */
export type MeasurementPatch = {
  trackingRaw?: string;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
  dimMethod?: DimMethod;
  weightMethod?: WeightMethod;
  boxPresetId?: string | null;
  note?: string | null;
};

export type MeasurementPayload = {
  clientId: string;
  trackingRaw: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  dimMethod: DimMethod;
  weightMethod: WeightMethod;
  ocrWeightKg?: number;
  dimConfidence?: number;
  boxPresetId?: string;
  measuredAt: string;
  note?: string;
  photoKinds: PhotoKind[];
  /** KALANLAR 6.7-a: bilerek yerine konan sunucu kaydı (kontrol ekranında görülen). */
  replacesId?: string;
  /** KALANLAR 6.7-b: gönderim anındaki telefon saati; kuyrukta saklanmaz, her denemede yeniden (`flush.ts` `wirePayload`). */
  sentAt?: string;
};

export type CheckResult = {
  exists: boolean;
  /** Başkasının kaydında yalnız ne zaman ve kim gelir. */
  last?: { id?: string; measuredAt: string; measuredByName: string; lengthCm?: number; widthCm?: number; heightCm?: number; weightKg?: number };
};

export type ScaleResult = { weightKg: number | null; unit: 'kg' | 'g' | null; rawText: string; confidence: number };

export type DetectResult = {
  ok: boolean;
  detectId?: string;
  marker?: { corners: Point[]; id: number };
  imageSize: { w: number; h: number };
  /** auto: vision kutu köşelerini kendisi buldu mu (eski vision sürümlerinde yok). */
  suggestedBox?: { points: Point[]; auto?: boolean };
  intrinsics?: unknown;
  message?: string;
};

export type SolveResult = { lengthCm: number; widthCm: number; heightCm: number; confidence: number };

type Num = number | string;
const num = (v: Num | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function normalizePreset(p: BoxPreset & Record<string, unknown>): BoxPreset {
  return { ...p, lengthCm: num(p.lengthCm), widthCm: num(p.widthCm), heightCm: num(p.heightCm) };
}

function normalizeMeasurement<T extends MeasurementItem>(m: T): T {
  return {
    ...m,
    lengthCm: num(m.lengthCm),
    widthCm: num(m.widthCm),
    heightCm: num(m.heightCm),
    weightKg: num(m.weightKg),
    desi: m.desi === undefined ? undefined : num(m.desi),
    volumetricKg5000: m.volumetricKg5000 === undefined ? undefined : num(m.volumetricKg5000),
  };
}

function normalizeDetail(m: MeasurementDetail): MeasurementDetail {
  return { ...normalizeMeasurement(m), photos: m.photos ?? [], history: (m.history ?? []).map(normalizeMeasurement) };
}

export const Api = {
  /** Firma ayarı. Ölçüm rolü yalnız desi böleni ve zorunlu fotoğraf sayısını alır; fiyat sunucudan süzülür. */
  companySettings: async (): Promise<Partial<CompanySettings>> => {
    try {
      return await api<Partial<CompanySettings>>('/settings', { timeoutMs: 8000 });
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) throw e;
      const m = await api<{ company?: { settings?: Partial<CompanySettings> } }>('/me', { timeoutMs: 8000 });
      return m.company?.settings ?? {};
    }
  },
  boxPresets: async (): Promise<BoxPreset[]> => {
    const r = await api<BoxPreset[] | { items: BoxPreset[] }>('/box-presets', { timeoutMs: 8000 });
    const list = Array.isArray(r) ? r : (r.items ?? []);
    return list
      .filter((p) => p.active !== false)
      .map((p) => normalizePreset(p as BoxPreset & Record<string, unknown>))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  },
  check: (tracking: string) =>
    api<CheckResult>(`/measurements/check?tracking=${encodeURIComponent(tracking)}`, { timeoutMs: 4000 }),
  todayMeasurements: async (from: Date): Promise<MeasurementItem[]> => {
    const r = await api<{ items: MeasurementItem[] }>(`/measurements?from=${encodeURIComponent(from.toISOString())}&pageSize=200`, {
      timeoutMs: 10000,
    });
    return (r.items ?? []).map(normalizeMeasurement);
  },
  /** Bugünün ölçüm sayısı (firma saat dilimiyle; hepsini görme izni yoksa yalnız kendi). Liste 200 ile sınırlı, sayı değil (11-B13). */
  todayStats: async (): Promise<{ count: number | null }> => {
    const r = await api<{ count?: unknown }>('/measurements/stats/today', { timeoutMs: 8000 });
    return { count: typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0 ? r.count : null };
  },
  listMeasurements: async (p: { q?: string; page: number; pageSize?: number }): Promise<Paged<MeasurementItem>> => {
    const qs = new URLSearchParams({ page: String(p.page), pageSize: String(p.pageSize ?? 30) });
    if (p.q) qs.set('q', p.q);
    const r = await api<Paged<MeasurementItem>>(`/measurements?${qs.toString()}`, { timeoutMs: 15000 });
    return { ...r, items: (r.items ?? []).map(normalizeMeasurement) };
  },
  measurement: async (id: string): Promise<MeasurementDetail> => {
    const r = await api<{ measurement: MeasurementDetail }>(`/measurements/${encodeURIComponent(id)}`, { timeoutMs: 15000 });
    return normalizeDetail(r.measurement);
  },
  /** JSON ya da (fotoğraf değiştiyse) multipart; yanıt her zaman yeni sürüm. */
  patchMeasurement: async (id: string, body: { json: MeasurementPatch } | { form: FormData }): Promise<MeasurementDetail> => {
    const r = await api<{ measurement: MeasurementDetail }>(`/measurements/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...('json' in body ? { json: body.json } : { form: body.form }),
      timeoutMs: 60000,
    });
    return normalizeDetail(r.measurement);
  },
  deleteMeasurement: (id: string) => api<void>(`/measurements/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 15000 }),
  restoreMeasurement: async (id: string): Promise<MeasurementDetail> => {
    const r = await api<{ measurement: MeasurementDetail }>(`/measurements/${encodeURIComponent(id)}/restore`, { method: 'POST', timeoutMs: 15000 });
    return normalizeDetail(r.measurement);
  },
  /** Kuyruk gönderimi. `scope`: kayıt yalnız sahibinin jetonuyla çıkar. */
  postMeasurement: (form: FormData, scope: SessionScope) =>
    api<{ measurement: MeasurementItem }>('/measurements', { method: 'POST', form, timeoutMs: 60000, requireScope: scope, stampSentAt: true }),
  readScale: (form: FormData) => api<ScaleResult>('/vision/scale', { method: 'POST', form, timeoutMs: 45000 }),
  detectReference: (form: FormData) => api<DetectResult>('/vision/reference/detect', { method: 'POST', form, timeoutMs: 45000 }),
  solveReference: (body: {
    detectId?: string;
    imageSize: { w: number; h: number };
    marker: DetectResult['marker'];
    intrinsics?: unknown;
    points: Point[];
  }) => api<SolveResult>('/vision/reference/solve', { method: 'POST', json: body, timeoutMs: 30000 }),
};

/** SDK 58 fetch (expo/fetch) çok parçalı gövdede `bytes()` sunan nesne ister; expo-file-system File bunu sağlar. */
export function jpegPart(uri: string): Blob {
  return new File(uri) as unknown as Blob;
}

export function imageForm(field: string, uri: string): FormData {
  const fd = new FormData();
  fd.append(field, jpegPart(uri));
  return fd;
}
