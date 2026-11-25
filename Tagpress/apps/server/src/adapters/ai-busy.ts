import type { AiCallRecord, AiErrorLike } from "../ports.ts";

/**
 * Geçidin hız ya da eşzamanlılık reddi (`sod_rate_limited`, tür `busy`): geçici. Üretim kuyruğu görevi `retryAfterMs`
 * sonra yeni bir istekle yeniden dener (sınırlı sayıda, `services/generation`); başka çağıranlar için bugünkü genel hata
 * (kodsuz `Error` + çağrı kayıtları, `adapters/ai.ts` `aiError` gibi).
 */
export class AiBusyError extends Error implements AiErrorLike {
  constructor(
    message: string,
    public calls: AiCallRecord[],
    /** Geçidin önerdiği bekleme (`retry-after`), yoksa undefined. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "AiBusyError";
  }
}
