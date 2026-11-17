/**
 * Ölçüm uçlarının (`routes/measurements.ts`) hata kodlarının tek listesi (Y53, SPEC §6.2).
 *
 * `MEASUREMENT_REJECT_CODES`: kayda özgü kodlar; kaydın kendisi düzeltilmeden geçmez. Mobil kuyruk bunları "Hatalı" sayar
 * (`apps/mobile/src/queue/flush.ts` `REJECT_CODES`); iki liste birebir aynı olmalı. Kaynakları: şema ve okunamayan `data`
 * (`VALIDATION`), boş ya da görüntü olmayan fotoğraf (`EMPTY_FILE`, `INVALID_FILE`), sütuna sığmayan değer
 * (`VALUE_OUT_OF_RANGE`, `errors.ts`), aynı takip no çakışması (`TRACKING_IN_USE`), eksik koli fotoğrafı (`PHOTO_REQUIRED`),
 * fotoğraf ya da gövde sınırı (`FILE_TOO_LARGE`, `TOO_MANY_FILES`, `errors.ts`), cihaz saatine göre kabul aralığı dışındaki
 * ölçüm anı (`MEASURED_AT_INVALID`, KALANLAR 6.7; tekrar gönderimde aynı kalır, kayıt telefonda "Hatalı" bekler).
 *
 * `MEASUREMENT_OTHER_CODES`: ölçüm uçlarının döndürdüğü ama kayda özgü OLMAYAN kodlar (mobil bunları "Hatalı" saymaz).
 *
 * Ölçüm ucuna yeni bir hata kodu eklenince iki listeden birine yazılır; kayda özgüyse mobil `REJECT_CODES`'a da.
 * `apps/mobile/tests/rejectCodes.test.ts` üçünü ve `routes/measurements.ts` içindeki kodları karşılaştırır.
 */
export const MEASUREMENT_REJECT_CODES = [
  'VALIDATION',
  'EMPTY_FILE',
  'INVALID_FILE',
  'VALUE_OUT_OF_RANGE',
  'TRACKING_IN_USE',
  'PHOTO_REQUIRED',
  'FILE_TOO_LARGE',
  'TOO_MANY_FILES',
  'MEASURED_AT_INVALID',
] as const;

// NOT_DELETED, MEASUREMENT_PROTECTED, MEASUREMENT_CHANGED: yalnız web panelindeki kalıcı silme ucu (mobil çağırmaz).
export const MEASUREMENT_OTHER_CODES = ['NOT_FOUND', 'NOT_LATEST_VERSION', 'NEWER_EXISTS', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_DELETED', 'MEASUREMENT_PROTECTED', 'MEASUREMENT_CHANGED'] as const;

export type MeasurementRejectCode = (typeof MEASUREMENT_REJECT_CODES)[number];
