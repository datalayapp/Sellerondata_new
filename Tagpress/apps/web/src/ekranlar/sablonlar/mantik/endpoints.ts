import type { Shape, TemplatePatch } from "@tagpress/domain";
import { ApiFailure } from "../../../lib/api.ts";

/**
 * `@tagpress/domain` sözleşmesinde HENÜZ OLMAYAN uçlar. Arayüz bunlara göre hazır; sunucu 404/405/501 dönerse
 * ilgili düğme "sunucuda henüz yok" der, ekran bozulmaz. Sunucu tarafı bu biçimi üstlenirse sözleşmeye taşınmalı.
 */
export const PROPOSED = {
  /**
   * POST SuggestAreaRequest → SuggestAreaResponse. `templates` paketindeki `suggestArea` (oran birimiyle Shape döner).
   * `decoration`: kaydedilmemiş dekor ayarları verilirse öneri onlarla hesaplanır.
   */
  suggestArea: "/api/languages/:lang/templates/:key/suggest-area",
  /**
   * POST TryTemplateRequest → TryTemplateResponse. "Bu şablonla dene": yapay zekâsız, yalnızca motor (yerleşim + yazı) önizlemesi.
   * `patch` verilirse kayıtlı şablonun üstüne GEÇİCİ uygulanır (kaydedilmez); verilmezse kayıtlı hâli çizilir.
   */
  tryTemplate: "/api/languages/:lang/templates/:key/try",
  /**
   * POST GenerateTemplateRequest → { queued: string } (202). Temadan görüntü modeliyle şablon üretir; hazır olunca
   * `template` olayı gelir ve kayıt `kind: "generated"`, `generatedFrom` dolu olarak listede belirir.
   * (`API.generate` iş kimliği ister; kütüphane şablonu üretmek için işsiz bir uç gerekir.)
   */
  generateTemplate: "/api/languages/:lang/templates/generate",
} as const;

export interface SuggestAreaRequest {
  /** Kaydedilmemiş dekor ayarları (yalnızca değişenler). */
  decoration?: Record<string, unknown>;
}
export interface SuggestAreaResponse {
  /** Oran birimiyle (tasarım alanı kenarı = 1). */
  shape: Shape;
}

export interface TryTemplateRequest {
  /** Örnek müşteri metni (satır sonları satır bölmesi sayılır). */
  text: string;
  patch?: TemplatePatch;
}
export interface TryTemplateResponse {
  /** PNG, base64 (tasarım alanı çözünürlüğünde). */
  png: string;
  /** Motorun böldüğü satırlar. */
  lines?: string[];
  /** Seçilen puntosu. */
  fontPt?: number | null;
  /** Sığmadı, alan dışına taştı gibi uyarılar (Türkçe). */
  issues?: string[];
}

export interface GenerateTemplateRequest {
  theme: string;
  /** Örnek müşteri metni: model, yazının nereye gireceğini bilsin (isteğe bağlı). */
  sampleText?: string;
  /** Üretilen şablon bu anahtarla kaydedilir; verilmezse sunucu seçer. */
  key?: string;
  kind?: "generated";
}

/** Sunucu bu ucu henüz sunmuyor mu? */
export function isUnsupported(e: unknown): boolean {
  return e instanceof ApiFailure && (e.status === 404 || e.status === 405 || e.status === 501);
}

/** Uç yoksa gösterilen not (`templates:unsupported.body`); okunduğu anda etkin dilde. */
export { unsupportedText } from "../metin.ts";
