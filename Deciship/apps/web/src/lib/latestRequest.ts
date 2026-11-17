// Yalnız son istek geçerli: yenisi başlarken ya da iptal edilince öncekinin sinyali kesilir
// (fatura yüklemede yapay zekâ ile eşleme: taşıyıcı ya da dosya değişti, sayfadan çıkıldı). Saf modül; `node --test` ile sınanır.

export type LatestRequest = {
  /** Öncekini keser, yenisinin sinyalini verir. */
  start(): AbortSignal;
  /** Süren isteği keser. */
  cancel(): void;
};

export function latestRequest(): LatestRequest {
  let ctrl: AbortController | null = null;
  return {
    start() {
      ctrl?.abort();
      ctrl = new AbortController();
      return ctrl.signal;
    },
    cancel() {
      ctrl?.abort();
      ctrl = null;
    },
  };
}

/** İptal edilen istek hata sayılmaz, sonucu da kullanılmaz: `null`. Başka hata olduğu gibi fırlar. */
export async function unlessAborted<T>(signal: AbortSignal, run: Promise<T>): Promise<T | null> {
  try {
    const value = await run;
    return signal.aborted ? null : value;
  } catch (e) {
    if (signal.aborted || (e as Error | null)?.name === 'AbortError') return null;
    throw e;
  }
}
