import { i18n } from '../i18n';

// SPEC §6.1 yerel modülünün güvenli sarmalayıcısı. Modül yoksa/yüklenemezse yetenekler false döner.

export type MeasureResult = { lengthCm: number; widthCm: number; heightCm: number; confidence: number; snapshotUri?: string };
export type Capabilities = { lidar: boolean; ar: boolean; arUnavailableReason?: string };

type BoxMeasureModule = {
  getCapabilities(): Promise<Capabilities>;
  measureWithLidar(): Promise<MeasureResult | null>;
  measureWithAR(): Promise<MeasureResult | null>;
};

let mod: BoxMeasureModule | null = null;
/** İç işaret (Error.message); kullanıcıya `measureUnavailableText()` gösterilir, teknik ayrıntı yalnız konsola yazılır. */
export const MEASURE_UNAVAILABLE = 'MEASURE_UNAVAILABLE';
/** Etkin dilde "bu yöntem kullanılamıyor" metni (çalışma anında çağrılır). */
export const measureUnavailableText = (): string => i18n.t('native.unavailable', { ns: 'measure' });
let loadError: string | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('../../modules/box-measure') as Partial<BoxMeasureModule> & { default?: Partial<BoxMeasureModule> };
  const candidate = typeof m.getCapabilities === 'function' ? m : m.default;
  if (candidate && typeof candidate.getCapabilities === 'function') mod = candidate as BoxMeasureModule;
  else loadError = MEASURE_UNAVAILABLE;
} catch (e) {
  console.warn('box-measure failed to load', e);
  loadError = MEASURE_UNAVAILABLE;
}

const NONE: Capabilities = { lidar: false, ar: false, arUnavailableReason: loadError ?? undefined };
let capsCache: Capabilities | null = mod ? null : NONE;
let capsPending: Promise<Capabilities> | null = null;

/** Cihaz kontrolü (Android'de ARCore ~3 sn sürebilir); sonuç uygulama açıkken önbellekte kalır. */
export function getCapabilities(): Promise<Capabilities> {
  if (capsCache) return Promise.resolve(capsCache);
  if (!capsPending) {
    capsPending = (async () => {
      try {
        const c = await mod!.getCapabilities();
        capsCache = { lidar: !!c?.lidar, ar: !!c?.ar, arUnavailableReason: c?.arUnavailableReason };
      } catch (e) {
        capsCache = { lidar: false, ar: false, arUnavailableReason: MEASURE_UNAVAILABLE };
        console.warn('box-measure capability check failed', e);
      }
      capsPending = null;
      return capsCache;
    })();
  }
  return capsPending;
}

/** Önbellekteki sonuç (henüz kontrol bitmediyse null). Ölçü ekranı ilk çizimde bunu kullanır, düzen kaymaz. */
export function peekCapabilities(): Capabilities | null {
  return capsCache;
}

export async function measureWithLidar(): Promise<MeasureResult | null> {
  if (!mod) throw new Error(MEASURE_UNAVAILABLE);
  return mod.measureWithLidar();
}

export async function measureWithAR(): Promise<MeasureResult | null> {
  if (!mod) throw new Error(MEASURE_UNAVAILABLE);
  return mod.measureWithAR();
}

export function moduleAvailable(): boolean {
  return mod !== null;
}
