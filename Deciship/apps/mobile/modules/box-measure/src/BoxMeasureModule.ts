import { NativeModule, requireNativeModule } from 'expo';

import type { MeasureCapabilities, MeasureResult } from './BoxMeasure.types';

declare class BoxMeasureNativeModule extends NativeModule<{}> {
  getCapabilities(): Promise<MeasureCapabilities>;
  measureWithLidar(): Promise<MeasureResult | null>;
  measureWithAR(): Promise<MeasureResult | null>;
}

// Yerel modül yoksa (Expo Go, web) burada hata fırlatılır; uygulama tarafı bunu yakalar.
export default requireNativeModule<BoxMeasureNativeModule>('BoxMeasure');
