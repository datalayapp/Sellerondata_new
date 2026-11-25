import type { AiCallOrigin, AiKeySource, AiProvider, AiRejectCode } from '@sellerondata/contracts';

/**
 * Vekil ↔ tavanlar (G3, `src/limits/index.ts`) arayüzü; orkestratörün sabitlediği biçim + geriye uyumlu ek alanlar (`callId`,
 * `origin`, `stream`, `keySource`). Vekil yalnız bu yapıya dayanır (G3'ün dosyasını içe aktarmaz): G3'ün `Limits`'i buna uyar.
 *
 * Akış (her ücretli çağrı: Anthropic `messages`, Gemini `generateContent`/`streamGenerateContent`; `count_tokens` ücretsiz, gelmez):
 * 1. Vekil araç jetonu, bağlam başlıkları, amaç (kayıt), model izin listesi, gövde ve sağlayıcı anahtarını denetler
 *    (`sod_context_invalid`, `sod_purpose_unknown`, `sod_model_not_allowed`, `sod_provider_missing` vekilin kararıdır).
 * 2. Vekil `pending` satırını `reservedMicroUsd = estimateMicroUsd` ile yazar ve COMMIT eder.
 * 3. `admit`: G3 kendi kilidi altında kapanmış satırların `costMicroUsd` toplamı + açık satırların `reservedMicroUsd` toplamıyla
 *    (çağıranın kendi satırı DAHİL) tavanları karşılaştırır; platform durdurma ve tavanları, firma kapalı (`sod_org_closed`), tek
 *    ortak aylık hak (`sod_org_cap`), firma × araç tavanı (`sod_tool_cap`), hız ve eşzamanlılık (`sod_rate_limited`), arka plan işine
 *    %20 pay. Ret: vekil satırı `rejected` (tutar 0) kapatır ve araca ret yanıtını verir (gövde + `x-sod-ai-reject` +
 *    `x-should-retry: false`). `admit` fırlatırsa satır `failed` kapanır, araca 503 `api_error`.
 * 4. Kabul: istek sağlayıcıya gider. Satır kapandıktan SONRA (gerçek ya da tahmini tutar, pay 0) `settle(reservationId, tutar)`;
 *    istek sağlayıcıya hiç gitmediyse `release(reservationId)`. `ok` dönen her `admit`'e tam bir `settle` ya da `release` gelir.
 *    Satırı başka yol (çökme taraması) önce kapatmışsa da çağrılır. İkisi de bildirimdir; deftere G3 yazmaz.
 */
export interface AdmitInput {
  product: string;
  orgId: string;
  memberId: string | null;
  purpose: string;
  model: string;
  provider: AiProvider;
  /** Bu çağrının olabilecek en yüksek tutarı (mikro USD); `pending` satırının `reservedMicroUsd`'si (admit'ten önce yazıldı). */
  estimateMicroUsd: number;
  /** `x-sod-request-id`. */
  requestId: string;
  /** Satıra yazılan deneme sayısı (boş olan ilk sayı). */
  attempt: number;
  /** Ek: defter satırının kimliği (UUIDv7, `x-sod-ai-call-id`). */
  callId: string;
  /** Ek: `request` | `job` (arka plan işine %20 pay kuralı). */
  origin: AiCallOrigin;
  /** Ek. */
  stream: boolean;
  /** Ek: `org` satırı platform tavanına girmez. */
  keySource: AiKeySource;
}

export type AdmitResult = { ok: true; reservationId: string } | { ok: false; code: AiRejectCode; retryAfterSec?: number };

export interface Limits {
  admit(input: AdmitInput): Promise<AdmitResult>;
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/** G3 bağlanana dek: her çağrıyı kabul eder (tavan yok). */
export const allowAllLimits: Limits = {
  async admit(input) {
    return { ok: true, reservationId: input.callId };
  },
  async settle() {},
  async release() {},
};
