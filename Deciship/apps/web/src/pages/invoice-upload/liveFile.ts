// Önizlemesi çıkmış dosyanın "vazgeçilirse sunucuda silinir" kararı (saf; `test/live-file.test.ts` sınar).
// `live`: içe aktarılmamış önizleme dosyası; vazgeçilirse silinir. `importing`: içe aktarma isteği sürerken dosya;
// hiçbir yoldan silinmez (sekme kapansa da kaydedilmekte olan fatura düşmesin).
export interface LiveFile {
  live: string | null;
  importing: string | null;
}

export const NO_FILE: LiveFile = { live: null, importing: null };

/** Yeni önizleme çıktı. */
export const previewReady = (fileId: string): LiveFile => ({ live: fileId, importing: null });

/**
 * Yeni okuma uygulandı (10-B5): eski önizleme yenisi gelene kadar tutulur ("Yeniden oku", taşıyıcı değişimi; okuma düşerse
 * ekrana geri gelir), ancak şimdi bırakılır ve dosyası silinir. Sunucu aynı dosyayı döndürdüyse silinmez.
 */
export function previewArrived(s: LiveFile, fileId: string): { discard: string | null; next: LiveFile } {
  // İçe aktarma sürüyorsa onun dosyası bırakılmaz (silinmeye açık olmaz, kaybolmaz).
  return { discard: s.live && s.live !== fileId ? s.live : null, next: { live: fileId, importing: s.importing } };
}

/** İçe aktarma isteği başlıyor: dosya silinmeye açık olmaktan çıkar. */
export const beginImport = (s: LiveFile): LiveFile => ({ live: null, importing: s.importing ?? s.live });

/** İçe aktarma başarısız: dosya yeniden denenebilsin diye geri gelir (sonra vazgeçilirse silinir). */
export const importFailed = (s: LiveFile): LiveFile => ({ live: s.importing ?? s.live, importing: null });

/** İçe aktarma tamam: dosya faturaya bağlandı, sunucu sahiplenir. */
export const importSucceeded = (): LiveFile => NO_FILE;

/** Vazgeçme çağrısı gider mi? Yalnız `live` için; içe aktarma sürerken asla. */
export function takeDiscard(s: LiveFile): { discard: string | null; next: LiveFile } {
  return { discard: s.live, next: { live: null, importing: s.importing } };
}
