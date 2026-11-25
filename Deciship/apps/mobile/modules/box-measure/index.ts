import BoxMeasure from './src/BoxMeasureModule';
import type { MeasureCapabilities, MeasureResult } from './src/BoxMeasure.types';

export type { MeasureCapabilities, MeasureResult } from './src/BoxMeasure.types';

/** Cihazın LiDAR / AR ölçüm yetenekleri. */
export function getCapabilities(): Promise<MeasureCapabilities> {
  return BoxMeasure.getCapabilities();
}

/** iPhone Pro LiDAR ile otomatik ölçüm. `null` = kullanıcı iptal etti. */
export function measureWithLidar(): Promise<MeasureResult | null> {
  return BoxMeasure.measureWithLidar();
}

/** AR köşe işaretleme ile ölçüm (ARKit / ARCore). `null` = kullanıcı iptal etti. */
export function measureWithAR(): Promise<MeasureResult | null> {
  return BoxMeasure.measureWithAR();
}

export default { getCapabilities, measureWithLidar, measureWithAR };
