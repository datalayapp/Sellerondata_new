/** SPEC §6.1 — bağlayıcı arayüz. Tüm ölçüler santimetre, 0,1 cm'ye yuvarlanmış. */
export type MeasureResult = {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** 0..1 */
  confidence: number;
  /** file:// JPEG (uygulama önbelleği) */
  snapshotUri?: string;
};

export type MeasureCapabilities = {
  lidar: boolean;
  ar: boolean;
  arUnavailableReason?: string;
};
