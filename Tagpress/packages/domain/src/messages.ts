import { z } from "zod";
import type { FixAction, IssueCode } from "./issues.ts";

/**
 * Sunucunun kullanıcıya gösterdiği metinlerin TEK kaynağı: hata kodları, sorun cümleleri, düzeltme önerisi adları,
 * geri al bildirimleri ve baskı şablonu uyarıları. Her kaydın Türkçe şablonu `{ad}` yer tutucularıyla yazılır;
 * sunucu yanıtta hem bugünkü Türkçe cümleyi (`message` / `error` / `label`) hem de kodu + parametreleri gönderir.
 * Arayüz kendi TR/EN sözlüğünde koda bakar; kod yoksa sunucu metnine düşer (`docs/sunucu-kodlari.md`).
 *
 * Kurallar:
 * - Kodlar küçük harf, kısa çizgili (kebab) ve düzdür (nokta yok; sözlük anahtarı olarak doğrudan kullanılır).
 * - Parametre adları İngilizce ve camelCase; sayılar sayı, listeler önceden birleştirilmiş metin olarak gider.
 * - Müşteri metni parametreye olduğu gibi girer (değiştirilmez). `detail` parametresi serbest metindir
 *   (motorun, AI sağlayıcısının ya da kütüphanenin kendi cümlesi) ve çevrilemez.
 */

export const MessageParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type MessageParams = z.infer<typeof MessageParamsSchema>;

/** Şablondaki `{ad}` yer tutucularının adları (tip düzeyinde). */
export type TemplateParams<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | TemplateParams<R> : never;
/** Şablonun istediği parametre nesnesi. */
export type ParamValues<S extends string> = { [K in TemplateParams<S>]: string | number };
/** Parametresiz şablonda parametre verilmez; parametreli şablonda hepsi zorunludur. */
export type ParamArgs<S extends string> = [TemplateParams<S>] extends [never] ? [params?: Record<string, never>] : [params: ParamValues<S>];

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Şablonu parametrelerle doldurur. Eksik parametre `{ad}` olarak kalır (testler bunu yakalar). */
export function renderMessage(template: string, params: MessageParams = {}): string {
  return template.replace(PLACEHOLDER, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

/** Şablondaki parametre adları (sırayla, tekrarsız). */
export function templateParams(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

const withParams = (params: MessageParams | undefined) => (params && Object.keys(params).length ? { params } : {});

// ---------------------------------------------------------------- hatalar (ApiError.code)

interface ErrorDef {
  /** HTTP durum kodu; `null`: duruma göre değişir (çağıran verir). */
  status: number | null;
  tr: string;
}

export const ERROR_MESSAGES = {
  // genel ve güvenlik
  "host-not-local": { status: 403, tr: "Yalnızca yerel adresten erişilebilir." },
  "origin-not-allowed": { status: 403, tr: "Bu kökenden erişime izin yok." },
  "studio-header-missing": { status: 403, tr: "İstek reddedildi: X-Studio başlığı eksik." },
  "not-found": { status: 404, tr: "Bulunamadı." },
  "web-not-built": { status: 404, tr: "Arayüz derlenmemiş." },
  "body-invalid-json": { status: 400, tr: "Gövde geçerli JSON değil." },
  /** Fastify'ın kendi 4xx hatası (gövde çok büyük, desteklenmeyen tür…); metin kütüphaneden gelir. */
  "request-failed": { status: null, tr: "{detail}" },
  "server-error": { status: 500, tr: "Sunucu hatası: {detail}" },

  // doğrulama (`fields` alan yollarını verir)
  "request-invalid": { status: 400, tr: "İstek geçersiz." },
  "query-invalid": { status: 400, tr: "Sorgu geçersiz." },
  "version-invalid": { status: 400, tr: "Sürüm geçersiz." },
  "version-range-invalid": { status: 400, tr: "Sürüm aralığı geçersiz." },
  "learn-request-invalid": { status: 400, tr: "Öğrenme isteği geçersiz." },
  "source-invalid": { status: 400, tr: "Kaynak geçersiz." },
  "replay-request-invalid": { status: 400, tr: "Deneme isteği geçersiz." },
  "session-invalid": { status: 400, tr: "Oturum geçersiz." },
  "session-entry-invalid": { status: 400, tr: "Oturum girdisi geçersiz." },
  "draft-patch-invalid": { status: 400, tr: "Taslak yaması geçersiz." },
  "setting-invalid": { status: 400, tr: "Ayar geçersiz." },
  "feature-invalid": { status: 400, tr: "Özellik seçimi geçersiz." },
  "setup-invalid": { status: 400, tr: "Kurulum cevabı geçersiz." },
  "provider-invalid": { status: 400, tr: "Sağlayıcı geçersiz." },
  "key-invalid": { status: 400, tr: "Anahtar geçersiz." },
  "language-package-invalid": { status: 400, tr: "Tasarım dili paketi geçersiz." },
  "language-package-profile-invalid": { status: 400, tr: "Paketteki profil geçersiz." },
  "trial-request-invalid": { status: 400, tr: "Deneme geçersiz." },
  "reference-invalid": { status: 400, tr: "Referans geçersiz." },
  "proposal-invalid": { status: 400, tr: "Öneri geçersiz." },
  "profile-invalid": { status: 400, tr: "Profil geçersiz; işaretli alanları düzeltin." },
  "preset-invalid": { status: 400, tr: "Ön ayar geçersiz." },
  "print-template-invalid": { status: 400, tr: "Baskı şablonu geçersiz." },
  "print-template-corrupt": { status: 500, tr: "Baskı şablonu kaydı bozuk ({id})." },
  "template-record-invalid": { status: 400, tr: "Şablon kaydı geçersiz." },
  "template-patch-invalid": { status: 400, tr: "Şablon yaması geçersiz." },
  "template-fields-readonly": { status: 400, tr: "Bu alanlar değiştirilemez." },
  "template-key-invalid": { status: 400, tr: 'Geçersiz şablon adı: "{key}" (harf, rakam, - ve _).' },
  "language-id-invalid": { status: 400, tr: "Geçersiz tasarım dili kimliği." },
  "language-id-required": { status: 400, tr: "languageId gerekli." },
  "language-unknown": { status: 400, tr: "Böyle bir tasarım dili yok." },
  "preview-width-range": { status: 400, tr: "w 32–4000 arasında olmalı." },
  "file-name-invalid": { status: 400, tr: "Geçersiz dosya adı." },
  "not-png": { status: 400, tr: "Dosya PNG değil." },
  "font-file-type": { status: 400, tr: "Font dosyası .ttf, .otf, .woff ya da .woff2 olmalı." },
  "font-invalid": { status: 400, tr: "Dosya geçerli bir font değil." },

  // bulunamadı (404)
  "job-not-found": { status: 404, tr: "İş bulunamadı." },
  "jobs-to-delete-not-found": { status: 404, tr: "Silinecek iş bulunamadı." },
  "batch-not-found": { status: 404, tr: "Parti bulunamadı." },
  "variant-not-found": { status: 404, tr: "Varyasyon bulunamadı." },
  "preview-not-found": { status: 404, tr: "Önizleme bulunamadı." },
  "text-layer-not-found": { status: 404, tr: "Yazı katmanı bulunamadı." },
  "language-not-found": { status: 404, tr: "Tasarım dili bulunamadı." },
  "profile-version-not-found": { status: 404, tr: "Profil sürümü {version} bulunamadı." },
  "template-not-found": { status: 404, tr: "Şablon bulunamadı." },
  "template-key-not-found": { status: 404, tr: 'Şablon "{key}" bulunamadı.' },
  "template-image-not-found": { status: 404, tr: "Şablon görseli bulunamadı." },
  "template-key-image-not-found": { status: 404, tr: 'Şablon "{key}" görseli bulunamadı.' },
  "template-backup-not-found": { status: 404, tr: '"{key}" için yedek bulunamadı.' },
  "template-task-not-found": { status: 404, tr: "Şablon üretim görevi bulunamadı." },
  "font-file-not-found": { status: 404, tr: "Font dosyası bulunamadı." },
  "reference-not-found": { status: 404, tr: "Referans bulunamadı." },
  "reference-image-not-found": { status: 404, tr: "Referans görseli bulunamadı." },
  "proposal-not-found": { status: 404, tr: "Öğrenme önerisi bulunamadı." },
  "ai-call-not-found": { status: 404, tr: "AI çağrısı bulunamadı." },
  "trial-preview-not-found": { status: 404, tr: "Deneme önizlemesi bulunamadı." },
  "undo-not-found": { status: 404, tr: "Geri alma kaydı bulunamadı." },
  "print-template-not-found": { status: 404, tr: "Baskı şablonu bulunamadı." },
  "preset-not-found": { status: 404, tr: "Ön ayar bulunamadı." },
  "print-session-not-found": { status: 404, tr: "Baskı oturumu bulunamadı." },
  "print-page-not-found": { status: 404, tr: "Baskı sayfası bulunamadı." },
  "print-item-not-found": { status: 404, tr: "Baskı öğesi bulunamadı." },
  "slot-not-found": { status: 404, tr: "Yuva {slot} bulunamadı." },
  "export-not-found": { status: 404, tr: "Baskı çıktısı bulunamadı." },
  "export-file-not-found": { status: 404, tr: "Çıktı dosyası bulunamadı." },

  // bağlı olmayan parça (501)
  "overlay-unavailable": { status: 501, tr: "Alan bindirmesi için templates paketi bağlı değil." },
  "specimen-unavailable": { status: 501, tr: "Font örneği için typeset paketi bağlı değil." },
  "key-tester-unavailable": { status: 501, tr: "Bağlantı denemesi bağlı değil." },
  "text-layer-unavailable": { status: 501, tr: "Yazı katmanı çizimi (motor) bağlı değil." },
  "edit-unavailable": { status: 501, tr: "Metin/font düzenlemesi (motor) bağlı değil." },
  "engine-preview-unavailable": { status: 501, tr: "Motor bağlı değil; önizleme çizilemez." },
  "layout-engine-unavailable": { status: 501, tr: "Yerleşim motoru bağlı değil." },
  "geometry-unavailable": { status: 501, tr: "Şablon geometrisi bağlı değil." },
  "ai-designer-unavailable": { status: 501, tr: "AI tasarımcı bağlı değil." },
  "image-generator-unavailable": { status: 501, tr: "Görüntü üretimi bağlı değil." },
  "print-render-unavailable": { status: 501, tr: "Baskı sayfası çizimi (motor) henüz bağlı değil." },
  "pdf-unavailable": { status: 501, tr: "PDF çıktısı (motor) henüz bağlı değil." },
  "print-planner-unavailable": { status: 501, tr: "Baskı sayfası planlayıcısı (@tagpress/print) henüz bağlı değil." },

  // AI anahtarı
  /** `provider` alanı da gelir ("anthropic" | "gemini"); `providerName` görünen addır. */
  "missing-key": { status: 409, tr: "{providerName} anahtarı yok. Ayarlar → Bağlantılar'dan {providerName} anahtarını girin." },
  /** Platform kipi: yapay zekâ anahtarları geçitte (platform yönetir); anahtar uçları kapalı. */
  "managed-by-platform": { status: 409, tr: "Bu ayarı SellerOnData platformu yönetir; burada değiştirilmez." },
  /** Platform kipi: firma adı Hesap'ta (Merkez) değişir, TagPress'te salt okunur. */
  "name-managed-by-platform": { status: 403, tr: "Firma adı SellerOnData Merkez'de değişir." },
  /** Platform kipi: yapay zekâ geçidi platformda durduruldu (`sod_platform_paused`); firmanın hakkı dolmuş sayılmaz. */
  "ai-paused": { status: 409, tr: "Yapay zekâ SellerOnData'da geçici olarak durduruldu; iş başlamadı. Biraz sonra yeniden deneyin." },
  /** Platform kipi: geçit bağlı değil (`AI_GATEWAY_URL` boş) ya da platformda sağlayıcı anahtarı yok (`sod_provider_missing`). */
  "ai-unavailable": { status: 409, tr: "Yapay zekâ şu an kullanılamıyor; iş başlamadı." },

  /** Ana anahtar (şifreleme) yok; `keys` anahtarın kaynağı ("dosya …", "ortam değişkeni …"). */
  "master-key-missing": {
    status: 409,
    tr: "Ana anahtar yok ({keys}); anahtar şifrelenemiyor. Ana anahtarı geri koyun ya da çözülemeyen anahtarları silip uygulamayı yeniden başlatın.",
  },
  /** Kayıtlı anahtar çözülemiyor (ana anahtar yok/yanlış, kayıt bozuk); `provider` alanı da gelir. `detail` sunucunun nedeni. */
  "key-unreadable": { status: 409, tr: "{providerName} anahtarı çözülemiyor: {detail} Ayarlar → Bağlantılar'dan anahtarı yeniden girin." },

  // özellik anahtarları (SUNUCU-PLANI §3.3)
  /** `feature` alanı da gelir (kapalı özelliğin anahtarı, ör. "learn"); arayüz "Aç" önerir. */
  "feature-off": { status: 409, tr: "Bu özellik kapalı. Ayarlar → Özellikler'den açabilirsiniz." },
  "feature-always-on": { status: 400, tr: "Bu özellik her zaman açıktır; kapatılamaz." },

  // tasarım dili, profil, öğrenme
  "no-language": { status: 409, tr: "Henüz tasarım dili yok. Önce bir tasarım dili oluşturun." },
  "no-published-profile": { status: 409, tr: "Bu tasarım dilinin yayınlanmış profili yok." },
  "no-draft": { status: 409, tr: "Yayınlanacak taslak yok." },
  "no-draft-profile": { status: 400, tr: "Taslak profil yok." },
  "learn-running": { status: 409, tr: "Bu tasarım dili için öğrenme zaten çalışıyor." },
  "learn-nothing": { status: 409, tr: "Henüz referans ya da elle düzeltme yok: üretilen varyasyonları Düzelt ile düzeltin." },
  "replay-no-references": { status: 409, tr: "Tekrar edilebilecek referans yok (şablonu ve görseli olan, tasarım alanı boyutunda)." },
  "proposal-decided": { status: 409, tr: "Bu öneri zaten karara bağlanmış." },
  "proposal-empty": { status: 400, tr: "Önerinin uygulanabilir değişikliği yok." },
  "proposal-accepted": { status: 409, tr: "Uygulanmış öneri reddedilemez; önce geri alın." },
  "proposal-not-applied": { status: 409, tr: "Öneri uygulanmamış." },
  "proposal-no-record": { status: 409, tr: "Bu önerinin uygulama kaydı yok; elle geri alın." },

  // sitede tasarım dili oluşturucu (builder-api.ts `BUILDER_HTTP_ERROR_CODES`; ek alanlar gövdede)
  "build-not-found": { status: 404, tr: "Oluşturma oturumu bulunamadı." },
  /** `buildId` alanı da gelir (dilin etkin oturumu). */
  "build-active": { status: 409, tr: "Bu tasarım dilinde açık bir oluşturma oturumu var." },
  /** `state` alanı da gelir (oturumun bugünkü durumu). */
  "build-state": { status: 409, tr: "Oturum bu adımda bu işi yapamaz." },
  "build-busy": { status: 409, tr: "Oturumda çalışan bir iş var; bitmesini bekleyin." },
  "build-no-revision": { status: 409, tr: "Bu revizyon henüz yok." },
  /** `scope`, `usedUsd`, `limitUsd`, `estimateUsd`, `canRaise`, `buildId` alanları da gelir. */
  "budget-exceeded": { status: 409, tr: "Yapay zekâ harcama sınırına ulaşıldı; iş başlamadı." },
  "budget-raise-used": { status: 409, tr: "Oturum sınırı zaten bir kez artırıldı." },
  /** `baseVersion`, `publishedVersion`, `draftChanged` alanları da gelir; `overwrite: true` ile yine de yayınlanır. */
  "build-base-changed": { status: 409, tr: "Oturum sürerken tasarım dili başka bir yerden değişti; yayınlanırsa o değişiklik kaybolur." },
  "sample-limit": { status: 409, tr: "Bu oturumda en çok {max} örnek olabilir." },
  "sample-too-large": { status: 413, tr: "Dosya çok büyük." },
  "sample-type": { status: 415, tr: "Bu dosya türü kabul edilmiyor (PNG, JPG ya da PDF)." },
  "sample-not-found": { status: 404, tr: "Örnek bulunamadı." },
  "question-unknown": { status: 400, tr: "Cevaplanan soru bekleyen sorular arasında yok." },
  "message-kind": { status: 409, tr: "Bu adımda bu tür ileti gönderilemez." },
  "showcase-item-not-found": { status: 404, tr: "Örnek etiket bulunamadı." },

  // şablonlar, deneme
  "template-exists": { status: 409, tr: '"{key}" adlı şablon zaten var.' },
  /** Motorun ya da AI'ın kendi cümlesi (serbest metin). */
  "trial-failed": { status: 422, tr: "{detail}" },

  // içe aktarma
  "import-empty": { status: 400, tr: "Dosya boş." },
  "import-json-invalid": { status: 400, tr: "Geçerli bir JSON değil: {detail}" },
  "import-no-list": { status: 400, tr: "JSON içinde iş listesi bulunamadı." },
  "import-no-records": { status: 400, tr: "JSON içinde iş (nesne) bulunamadı." },

  // hafif düzeltme
  /** Motorun cümlesi (satır fontu yok, satır yok, font seçilemez); serbest metin. */
  "edit-font": { status: 400, tr: "{detail}" },
  "not-adjustable": { status: 422, tr: "Bu varyasyon elle düzeltilemez (yazı motor yerleşimi değil)." },
  "no-saved-adjust": { status: 409, tr: "Bu varyasyonda kayıtlı düzeltme yok." },

  // geri alma
  "undo-used": { status: 409, tr: "Bu işlem zaten geri alındı." },
  "undo-expired": { status: 410, tr: "Geri alma süresi doldu." },

  // baskı
  "version-conflict": { status: 409, tr: "Oturum başka bir yerde değişti; sayfayı yenileyip yeniden deneyin." },
  printed: { status: 409, tr: "Basılmış oturum değiştirilemez; yeniden basmak için kopyalayın." },
  "printed-session-not-deletable": { status: 409, tr: "Basılmış oturum arşivdedir ve silinmez." },
  "template-other-language": { status: 400, tr: "Şablon bu tasarım diline ait değil." },
  "template-archived": { status: 409, tr: "Arşivlenmiş şablonla oturum kurulamaz." },
  "print-template-required": { status: 400, tr: "Sayfa şablonu seçin (templateId)." },
  "session-template-missing": { status: 400, tr: "Oturumun şablonu yok." },
  "session-no-matching-jobs": { status: 400, tr: "Bu şablona uyan onaylı iş yok." },
  "session-no-matching-jobs-quantity": { status: 400, tr: "Bu şablona uyan onaylı iş yok. Seçilen işlerin adedi yok." },
  "shelf-no-matching-jobs": { status: 400, tr: "Rafta bu şablona uyan, planlanmamış onaylı iş yok." },
  "shelf-no-matching-jobs-quantity": { status: 400, tr: "Rafta bu şablona uyan, planlanmamış onaylı iş yok. Seçilen işlerin adedi yok." },
  /** Planlayıcının cümlesi (serbest metin). */
  "plan-failed": { status: 400, tr: "Plan yapılamadı: {detail}" },
  "export-no-pages": { status: 400, tr: "Oturumda basılacak sayfa yok." },
  "grid-diameter-required": { status: 400, tr: "Izgara için yuva çapı gerekli." },
  "grid-size-required": { status: 400, tr: "Izgara için yuva genişliği ve yüksekliği gerekli." },
  "grid-no-fit": { status: 400, tr: "Yuvalar bu kağıda bu sayıda sığmıyor (adım sıfır ya da eksi çıktı)." },
  "sticker-on-label-page": { status: 400, tr: "Sticker etiket sayfasına konmaz; sticker sayfasına bırakın." },
  "label-on-sticker-page": { status: 400, tr: "Etiket sticker sayfasına konmaz; etiket sayfasına bırakın." },
  "sticker-move-to-label": { status: 400, tr: "Sticker etiket sayfasına taşınamaz." },
  "label-move-to-sticker": { status: 400, tr: "Etiket sticker sayfasına taşınamaz." },
  "page-kind-mismatch": { status: 400, tr: "Etiket sayfası sticker şablonuna (ya da tersi) çevrilemez." },
  "no-approved-variant": { status: 400, tr: "İşin onaylı varyasyonu yok; varyasyon seçin." },
  "slot-occupied": { status: 409, tr: "Yuva {slot} dolu." },
  "no-free-slot": { status: 409, tr: "Sayfada boş yuva yok; konum verin." },
  "free-position-required": { status: 400, tr: "Serbest konum için xMm ve yMm gerekli." },
  "move-target-required": { status: 400, tr: "Taşımak için yuva ya da xMm/yMm gerekli." },
  "id-in-use": { status: 400, tr: "Kimlik zaten kullanılıyor: {id}." },
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;
export const ERROR_CODES = Object.keys(ERROR_MESSAGES) as ErrorCode[];
export type ErrorParams<C extends ErrorCode> = ParamValues<(typeof ERROR_MESSAGES)[C]["tr"]>;
/** Parametre almayan hata kodları (ör. `parseBody`'nin doğrulama kodu). */
export type PlainErrorCode = { [C in ErrorCode]: [TemplateParams<(typeof ERROR_MESSAGES)[C]["tr"]>] extends [never] ? C : never }[ErrorCode];

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_MESSAGES, code);
}

/** Hata kodunun Türkçe cümlesi. */
export function errorText<C extends ErrorCode>(code: C, ...[params]: ParamArgs<(typeof ERROR_MESSAGES)[C]["tr"]>): string {
  return renderMessage(ERROR_MESSAGES[code].tr, params);
}

// ---------------------------------------------------------------- sorunlar (Issue.messageKey)

interface IssueDef {
  /** Sorunun kodu (`Issue.code`); bir kodun birden çok cümlesi olabilir. */
  code: IssueCode;
  tr: string;
}

export const ISSUE_MESSAGES = {
  // içe aktarma: metin
  "text-missing": { code: "text-missing", tr: "Metin boş." },
  "text-very-long": { code: "text-very-long", tr: "Metin çok uzun ({length} karakter); bu profilde yaklaşık {capacity} karaktere kadar sığar." },
  "text-very-long-lines": { code: "text-very-long", tr: "Müşteri {lines} satır vermiş; profil en fazla {max} satıra izin veriyor." },
  "text-very-long-segment": { code: "text-very-long", tr: "{line}. satır {max} karakterden uzun (satır bölmeleri kesin)." },
  "text-word-too-long": { code: "text-word-too-long", tr: "Tek satıra sığmayacak kadar uzun kelime: {words} (en fazla {max} karakter)." },
  "text-outer-quotes-removed": { code: "text-outer-quotes-removed", tr: "Metni saran tırnak işaretleri kaldırıldı." },
  "text-unicode-styled": {
    code: "text-unicode-styled",
    tr: "Süslü yazı var ({chars}). Düz harfe çevrilirse etiketin fontuyla, olduğu gibi bırakılırsa bu stille basılır.",
  },
  "text-unprintable": { code: "text-unprintable", tr: "Hiçbir fontta olmayan karakter: {chars}. Basılırsa boş kutu çıkar." },
  "text-unprintable-broken": {
    code: "text-unprintable",
    tr: "Yarım kalmış karakter var (bozuk emoji ya da kopyalama hatası, {count} yerde); basılamaz. Müşterinin metnini kontrol edin.",
  },
  "text-unprintable-control": { code: "text-unprintable", tr: "Basılamayan denetim karakteri var ({chars})." },
  "text-fallback-font": { code: "text-fallback-font", tr: "Tasarım fontlarında olmayan karakterler yedek fontla basılacak: {chars}." },
  "text-fallback-font-partial": { code: "text-fallback-font", tr: "Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {chars}." },
  "text-fallback-font-mono": { code: "text-fallback-font", tr: "Bu emojiler renkli fontta yok; tek renk basılacak: {chars}." },
  "text-suspicious-space": { code: "text-suspicious", tr: "Alışılmadık boşluk karakteri var ({chars})." },
  "text-suspicious-all-caps": { code: "text-suspicious", tr: "Metnin tamamı büyük harf; müşteri böyle mi istiyor?" },
  "text-suspicious-mixed-case": { code: "text-suspicious", tr: "Kelime içinde karışık büyük/küçük harf: {words}." },
  "text-suspicious-leading-punct": { code: "text-suspicious", tr: 'Metin noktalama işaretiyle başlıyor ("{char}").' },
  "text-suspicious-trailing-punct": { code: "text-suspicious", tr: 'Metin noktalama işaretiyle bitiyor ("{char}").' },
  "text-suspicious-unbalanced": { code: "text-suspicious", tr: "Eşleşmeyen parantez/tırnak: {chars}." },
  "text-suspicious-mojibake": {
    code: "text-suspicious",
    tr: 'Metin bozuk kodlanmış görünüyor (Türkçe harf ya da emoji yanlış okunmuş); doğrusu: "{fixed}".',
  },
  "text-suspicious-escapes": { code: "text-suspicious", tr: 'Metinde kaçışlı yazılmış karakter var; çözülmüş hâli: "{fixed}".' },
  "text-suspicious-replacement": {
    code: "text-suspicious",
    tr: "Metinde bozuk karakter (�) var: müşterinin dosyasında kodlama hatası olabilir; asıl karakteri yazın.",
  },

  // içe aktarma: alanlar
  "template-missing": { code: "template-missing", tr: "Şablon bilgisi yok." },
  "template-missing-input": { code: "template-missing", tr: 'Şablon değeri anlaşılamadı ("{input}").' },
  "template-unknown": { code: "template-unknown", tr: '"{key}" adlı şablon bu tasarım dilinde yok.' },
  "template-unknown-suggest": { code: "template-unknown", tr: '"{key}" adlı şablon bu tasarım dilinde yok. Şunu mu demek istediniz: {suggestions}?' },
  "template-unknown-file": { code: "template-unknown", tr: '"{key}" şablonunun PNG dosyası klasörde yok.' },
  "size-unknown": { code: "size-unknown", tr: 'Etiket boyutu "{size}" tanınmadı; varsayılan {defaultSize} kullanılacak.' },
  "quantity-missing": { code: "quantity-missing", tr: "Adet yok." },
  "quantity-invalid": { code: "quantity-invalid", tr: 'Adet geçersiz ("{value}"); pozitif tam sayı olmalı.' },
  "order-missing": { code: "order-missing", tr: "Sipariş numarası yok." },
  "duplicate-in-file": { code: "duplicate-in-file", tr: "Dosyada {row}. satırla aynı iş." },
  "duplicate-existing": { code: "duplicate-existing", tr: 'Bu iş daha önce "{batch}" partisinde içe aktarılmış ({date}).' },
  "duplicate-similar-file": { code: "duplicate-similar", tr: "Aynı metin ve şablon {order} numaralı siparişte de var (dosyada {row}. satır)." },
  "duplicate-similar-batch": { code: "duplicate-similar", tr: 'Aynı metin ve şablon {order} numaralı siparişte de var ("{batch}" partisi).' },
  "sticker-detected": { code: "sticker-detected", tr: "Sticker siparişi (şablonsuz, sticker sayfasına yerleşir)." },
  "sticker-sheet-missing": { code: "sticker-sheet-missing", tr: "Bu sticker için sayfa seçilmedi." },
  "sticker-sheet-missing-none": { code: "sticker-sheet-missing", tr: "Profilde sticker sayfası tanımlı değil (Tasarım dili → Sticker)." },
  "sticker-sheet-missing-id": { code: "sticker-sheet-missing", tr: 'Sticker sayfası "{sheet}" profilde yok.' },

  // üretim: motor (yerleşim, kurallar, hafif düzeltme)
  "text-changed": { code: "text-changed", tr: 'Metin değişmiş ({at}. karakter): "{got}" ≠ "{want}"' },
  "text-changed-generic": { code: "text-changed", tr: "Metin değişmiş." },
  "text-changed-lines": { code: "text-changed", tr: "Satırlar müşteri metnini değiştiriyor." },
  "text-changed-customer": { code: "text-changed", tr: "Müşteri metni değişmiş." },
  "text-edited": { code: "text-edited", tr: "Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi)." },
  "text-edited-diff": {
    code: "text-edited",
    tr: 'Satır metni elle düzenlendi; iş metninden farklı (yalnızca bu varyasyonda, müşteri metni değişmedi). Metin değişmiş ({at}. karakter): "{got}" ≠ "{want}"',
  },
  "no-layout": { code: "no-layout", tr: "Metin en küçük ölçekte bile yazı alanına sığmıyor." },
  "text-too-small": { code: "text-too-small", tr: "En küçük satır {pt} pt; okunurluk sınırı {min} pt." },
  "text-too-small-min": { code: "text-too-small", tr: "En küçük satır {min} pt altına düşüyor; metin bu dizilişle sığmıyor." },
  "text-too-small-adjust": { code: "text-too-small", tr: "Küçültme sonrası en küçük satır {pt} pt; okunurluk sınırı {min} pt." },
  collision: { code: "collision", tr: "Yazı dekorla ya da kesim çizgisiyle çarpışmadan yerleştirilemedi." },
  "collision-cut": { code: "collision", tr: "Yazı kesim çizgisinin dışına taşıyor; baskıda kesilir." },
  "collision-decoration": { code: "collision", tr: "Yazı şablon süslemesine değiyor." },
  "text-unprintable-layout": { code: "text-unprintable", tr: "Hiçbir font şu karakterleri basamıyor: {chars}" },
  "text-unprintable-kept": { code: "text-unprintable", tr: "Hiçbir font şu karakterleri basamıyor (silinmedi): {chars}" },
  "text-fallback-font-used": { code: "text-fallback-font", tr: "Tasarım fontunda olmayan karakterler yedek fontla basıldı: {chars}" },
  "text-fallback-font-partial-used": { code: "text-fallback-font", tr: "Bu emojiler fontta tek parça yok; parçaları yan yana basılacak: {chars}" },
  "text-fallback-font-mono-used": { code: "text-fallback-font", tr: "Bu emojiler renkli fontta yok; tek renk basılacak: {chars}" },
  "rule-too-many-lines": { code: "rule-too-many-lines", tr: "{lines} satır var; en fazla {max} olmalı." },
  "rule-line-too-long": { code: "rule-line-too-long", tr: "{line}. satır {chars} karakter; sınır {max}." },
  "rule-lone-word": { code: "rule-lone-word", tr: '"{text}" tek başına satır olmamalı; ait olduğu ifadeyle kalmalı.' },
  "rule-name-not-own-line": { code: "rule-name-not-own-line", tr: 'İsim satırı ("{text}") en büyük satır değil.' },
  "rule-name-not-own-line-extra": { code: "rule-name-not-own-line", tr: "İsim satırında başka kelimeler var: {words}." },
  "rule-split-greeting": { code: "rule-split-greeting", tr: 'Kısa selam bölünmüş: "{first}" / "{second}".' },
  "rule-date-own-line": { code: "rule-date-own-line", tr: 'Tarih kendi satırında değil: "{text}".' },
  "rule-customer-break": { code: "rule-customer-break", tr: "{line}. satır müşterinin verdiği satır bölmesine uymuyor." },
  "rule-initials-split": { code: "rule-initials-split", tr: "Yalnızca baş harf olan metin tek satırda olmalı." },
  "font-unavailable-unknown": { code: "font-unavailable", tr: "Profilde olmayan font: {font}." },
  "font-unavailable-disabled": { code: "font-unavailable", tr: "{font} profilde kapalı." },
  "font-unavailable-special": { code: "font-unavailable", tr: "{font} yalnızca özel karakter kuralları için; satır fontu olamaz." },
  "font-unavailable-missing": { code: "font-unavailable", tr: "{font} font dosyası yüklü değil." },
  "font-unavailable-uppercase": { code: "font-unavailable", tr: "{font}: metinde art arda {run} büyük harf var (sınır {max})." },
  "font-mixing": { code: "font-mixing", tr: "Bir etikette en fazla {limit} font ailesi olabilir; {count} kullanılmış." },
  "font-mixing-adjust": { code: "font-mixing", tr: "Tasarım dili bir etikette en fazla {limit} font ailesi istiyor; elle {count} aile kullanıldı ({families})." },

  // üretim: AI aday denetimi
  "rule-too-many-lines-ai": { code: "rule-too-many-lines", tr: "{lines} satır; en fazla {max}." },
  "rule-lone-word-ai": { code: "rule-lone-word", tr: '"{text}" tek başına satır olamaz.' },
  "rule-split-greeting-example": { code: "rule-split-greeting", tr: '"{text}" bölünmüş; tasarımcının örneğinde tek satır.' },
  "rule-initials-split-connector": { code: "rule-initials-split", tr: "Baş harfler alt alta dizilmiş; tek satırda olmalı." },
  "rule-initials-split-stacked": { code: "rule-initials-split", tr: "Baş harfler alt alta dizilmiş." },
  "rule-couple-stack": { code: "rule-couple-stack", tr: '"{text}": isimler alt alta (isim / bağlaç / isim) dizilmeli.' },
  "rule-couple-stack-connector": { code: "rule-couple-stack", tr: "Bağlaç kendi satırında; bu tarzda isimler tek satırda kalır." },
  "rule-name-not-own-line-ai": { code: "rule-name-not-own-line", tr: 'İsim satırı "{text}" ana satır değil.' },
  "rule-date-own-line-ai": { code: "rule-date-own-line", tr: 'Tarih "{date}" başka sözcüklerle aynı satırda.' },
  "rule-customer-break-ai": { code: "rule-customer-break", tr: "Müşterinin satır bölmelerinden biri korunmamış." },
  "font-unavailable-none": { code: "font-unavailable", tr: "Bu iş için kullanılabilir font yok (font listesi, roller ve büyük harf sınırlarını kontrol edin)." },
  "font-unavailable-catalog": { code: "font-unavailable", tr: "Katalogda olmayan font: {font}" },
  /** `reason`: font kataloğunun Türkçe gerekçesi (serbest metin). */
  "font-unavailable-job": { code: "font-unavailable", tr: "{font} bu işte kullanılamaz: {reason}" },
  "font-unavailable-tier": { code: "font-unavailable", tr: '{font} "{tier}" satırında kullanılamaz (rolleri: {roles}).' },
  "font-mixing-candidate": { code: "font-mixing", tr: "Bu tasarım dili en fazla {limit} font ailesine izin veriyor; aday {families} kullanıyor." },
  "ai-duplicate": { code: "ai-duplicate", tr: "Aynı tasarım zaten var." },
  "ai-duplicate-lines": { code: "ai-duplicate", tr: "Aynı satır bölmesi zaten gösterildi." },
  "ai-failed-empty-line": { code: "ai-failed", tr: "Boş satır var." },
  "ai-failed-format": { code: "ai-failed", tr: "Aday biçimi geçersiz: {detail}" },
  "ai-failed-intent": { code: "ai-failed", tr: "Niyet oluşturulamadı: {detail}" },
  /** `reason`: AI hata türünün Türkçe açıklaması (serbest metin), `detail`: sağlayıcının cümlesi. */
  "ai-unavailable": { code: "ai-failed", tr: "AI kullanılamıyor: {reason}. {detail}" },
  "ai-call-failed": { code: "ai-failed", tr: "AI çağrısı başarısız: {detail}" },
  /** `detail`: reddedilen adayların sorun cümleleri (" | " ile, Türkçe). */
  "ai-no-good-candidate": { code: "ai-no-good-candidate", tr: "AI geçerli aday üretemedi: {detail}" },
  "ai-no-good-candidate-empty": { code: "ai-no-good-candidate", tr: "AI geçerli aday üretemedi: yanıt kullanılamadı" },
  /** Üretim adımı başarısız; `detail` hatanın kendi cümlesi. Kod hatanın türüne göre değişir. */
  "generation-failed": { code: "ai-failed", tr: "Üretim başarısız: {detail}" },
  /** Eski kayıtlar: görsel denetim üründen kalktı (SUNUCU-PLANI §9); üretilmez, eski varyasyonlarda okunur. */
  "critique-issue": { code: "critique-issue", tr: "Görsel denetim: {note}" },
  "critique-issue-fixed": { code: "critique-issue", tr: "Görsel denetim: {note} (düzeltildi)" },

  // üretim: görüntü
  "image-text-unreadable": { code: "image-text-mismatch", tr: "Görseldeki yazı okunamadı; metni gözle kontrol edin." },
  "image-text-mismatch": { code: "image-text-mismatch", tr: 'Görseldeki yazı müşteri metninden farklı: "{text}"' },
  "image-text-different": { code: "image-text-mismatch", tr: 'Görseldeki yazı müşteri metniyle aynı değil (görselde: "{text}").' },
  "image-template-changed": { code: "image-template-changed", tr: "Görüntü modeli şablonun piksellerini değiştirdi; bu sonuç kullanılmamalı." },
  /** `reasons`: ayrım ölçümlerinin Türkçe gerekçeleri ("; " ile). */
  "image-template-changed-reasons": {
    code: "image-template-changed",
    tr: "Görüntü modeli şablonu değiştirdi ya da yazı ayrılamadı ({reasons}); şablona dokunulmadığı garanti edilemediği için sonuç kullanılmadı.",
  },
  "template-cut-changed": {
    code: "template-cut-changed",
    tr: "Şablonun ({template}) kesim şekli ya da ölçüsü değişti; onay kaldırıldı. Yerleşimi yeni kesimle kontrol edip yeniden onaylayın (gerekirse yeniden üretin).",
  },
  "image-template-changed-internal": { code: "image-template-changed", tr: "İç hata: bileşikte şablon pikseli değişti; sonuç kullanılmadı." },
  "image-model-unavailable": { code: "ai-failed", tr: "Görüntü modeli kullanılamıyor: {detail}" },
  "image-generation-failed": { code: "ai-failed", tr: "Görüntü üretilemedi: {detail}" },
  "image-generation-failed-unknown": { code: "ai-failed", tr: "Görüntü üretilemedi: bilinmeyen hata" },
  "template-text-unchecked": { code: "image-text-mismatch", tr: "Şablonda yazı olup olmadığı denetlenemedi (görsel okuyucu yok)." },
  "template-has-text": { code: "image-text-mismatch", tr: 'Üretilen şablonda yazı var: "{text}".' },
  "template-text-unreadable": { code: "image-text-mismatch", tr: "Üretilen şablonda yazı olup olmadığı okunamadı." },
  "template-generation-failed": { code: "ai-failed", tr: "Şablon üretilemedi: {detail}" },
} as const satisfies Record<string, IssueDef>;

export type IssueMessageKey = keyof typeof ISSUE_MESSAGES;
export const ISSUE_MESSAGE_KEYS = Object.keys(ISSUE_MESSAGES) as IssueMessageKey[];

/** Sorunun metin kısmı: Türkçe cümle + sözlük anahtarı + parametreler. */
export interface IssueText {
  message: string;
  messageKey: IssueMessageKey;
  params?: MessageParams;
}

/**
 * Sorun cümlesi: `{ ...issueMsg("text-very-long", { length, capacity }), severity, fixes }`. Dönen `code` kaydın
 * kodudur; kodun ayrıca verildiği yerlerde (`issue(code, …)`) aynı olmalıdır (test denetler).
 */
export function issueMsg<K extends IssueMessageKey>(
  key: K,
  ...[params]: ParamArgs<(typeof ISSUE_MESSAGES)[K]["tr"]>
): IssueText & { code: (typeof ISSUE_MESSAGES)[K]["code"] } {
  const def = ISSUE_MESSAGES[key];
  return { code: def.code, message: renderMessage(def.tr, params), messageKey: key, ...withParams(params) };
}

// ---------------------------------------------------------------- düzeltme önerileri (FixAction.labelKey)

type FixKind = FixAction["kind"];

interface FixDef {
  kind: FixKind;
  tr: string;
}

export const FIX_LABELS = {
  regenerate: { kind: "regenerate", tr: "Yeniden üret" },
  retry: { kind: "regenerate", tr: "Yeniden dene" },
  revise: { kind: "revise", tr: "Daha az satırla dene" },
  /** Eski kayıtlar (görsel denetimin önerisi; SUNUCU-PLANI §9): üretilmez, eski sorunlarda okunur. */
  "request-fix": { kind: "revise", tr: "Bu düzeltmeyi iste" },
  "edit-text": { kind: "edit-text", tr: "Metni düzenle" },
  "fix-text": { kind: "edit-text", tr: "Metni düzelt" },
  "write-text": { kind: "edit-text", tr: "Metni yaz" },
  "restore-quotes": { kind: "edit-text", tr: "Tırnakları geri koy" },
  "normalize-spaces": { kind: "edit-text", tr: "Normal boşluğa çevir" },
  "fix-encoding": { kind: "edit-text", tr: "Kodlamayı düzelt" },
  "decode-escapes": { kind: "edit-text", tr: "Kaçışları çöz" },
  "remove-control": { kind: "edit-text", tr: "Denetim karakterlerini sil" },
  "convert-unicode": { kind: "convert-unicode", tr: "Düz harfe çevir" },
  "choose-template": { kind: "choose-template", tr: "Şablon seç" },
  /** Önerilen şablonun anahtarı düğmenin adıdır (`value` ile aynı). */
  "choose-template-key": { kind: "choose-template", tr: "{key}" },
  "set-size": { kind: "set-size", tr: "{cm} cm" },
  "set-quantity": { kind: "set-quantity", tr: "Adet yaz" },
  "fix-quantity": { kind: "set-quantity", tr: "Adeti düzelt" },
  "set-order": { kind: "set-order", tr: "Sipariş no yaz" },
  "open-template": { kind: "open-template", tr: "Şablonu aç" },
  "upload-template": { kind: "open-template", tr: "Şablon yükle" },
  "fix-text-area": { kind: "open-template", tr: "Yazı alanını düzelt" },
  skip: { kind: "skip", tr: "Bunu alma" },
  "skip-row": { kind: "skip", tr: "Bu satırı alma" },
  dismiss: { kind: "dismiss", tr: "Doğru, böyle kalsın" },
  "print-as-is": { kind: "dismiss", tr: "Olduğu gibi bas" },
} as const satisfies Record<string, FixDef>;

export type FixLabelKey = keyof typeof FIX_LABELS;
export const FIX_LABEL_KEYS = Object.keys(FIX_LABELS) as FixLabelKey[];

type FixArgs<S extends string> = [TemplateParams<S>] extends [never]
  ? [opts?: { value?: string }]
  : [opts: { value?: string; params: ParamValues<S> }];

/** Düzeltme önerisi: `fixMsg("restore-quotes", { value })` → `{ kind, label, labelKey, value }`. */
export function fixMsg<K extends FixLabelKey>(key: K, ...[opts]: FixArgs<(typeof FIX_LABELS)[K]["tr"]>): FixAction & { kind: (typeof FIX_LABELS)[K]["kind"] } {
  const def = FIX_LABELS[key];
  const o = opts as { value?: string; params?: MessageParams } | undefined;
  return {
    kind: def.kind,
    label: renderMessage(def.tr, o?.params),
    labelKey: key,
    ...(o?.value !== undefined ? { value: o.value } : {}),
    ...withParams(o?.params),
  };
}

// ---------------------------------------------------------------- geri al bildirimi (UndoToken.code)

export const UNDO_MESSAGES = {
  "jobs-deleted": { tr: "{count} iş silindi" },
  "batch-deleted": { tr: "Parti ve {count} işi silindi" },
  "variant-deleted": { tr: "Varyasyon silindi" },
  "adjust-saved": { tr: "Elle düzeltme kaydedildi" },
  "adjust-removed": { tr: "Elle düzeltme kaldırıldı" },
  "print-page-deleted": { tr: "Baskı sayfası silindi" },
  "print-pages-deleted": { tr: "{count} baskı sayfası silindi" },
  "print-session-deleted": { tr: "Baskı oturumu silindi" },
  "language-deleted": { tr: "Tasarım dili silindi" },
} as const satisfies Record<string, { tr: string }>;

export type UndoCode = keyof typeof UNDO_MESSAGES;
export const UNDO_CODES = Object.keys(UNDO_MESSAGES) as UndoCode[];

export interface UndoText {
  label: string;
  code: UndoCode;
  params?: MessageParams;
}

export function undoMsg<C extends UndoCode>(code: C, ...[params]: ParamArgs<(typeof UNDO_MESSAGES)[C]["tr"]>): UndoText {
  return { label: renderMessage(UNDO_MESSAGES[code].tr, params), code, ...withParams(params) };
}

// ---------------------------------------------------------------- baskı oturumu bildirimleri (PrintSessionNotice.code)

/**
 * Oturum ayrıntısında (`PrintSessionDetail.notices`) dönen, oturumun bütününe dair bildirimler. Arayüz anahtarı
 * `printDesk:notices.<code>` (parametrelerle).
 */
export const PRINT_NOTICE_MESSAGES = {
  "plan-stale": {
    tr: "Bu oturum eski ölçülerle dizilmiş ({sheets} kağıt; sticker ölçüsü ya da bir şablonun kesimi değişti). Yeniden planlayınca yaklaşık {replanSheets} kağıt; basmadan önce yeniden planlayın.",
  },
  "printed-old-scale": {
    tr: "Bu oturum eski sticker ölçüsüyle basıldı; dışa aktarım basıldığı gibi çıkar. Yeni ölçüyle basmak için yeniden basın ve yeniden planlayın.",
  },
  "sticker-small-text": {
    tr: "{orderNo}: sticker'daki en küçük yazı {pt} pt; okunurluk sınırının ({minPt} pt) altında. Sticker alanını büyütün ya da yazıyı kısaltın.",
  },
} as const satisfies Record<string, { tr: string }>;

export type PrintNoticeCode = keyof typeof PRINT_NOTICE_MESSAGES;
export const PRINT_NOTICE_CODES = Object.keys(PRINT_NOTICE_MESSAGES) as PrintNoticeCode[];

export function printNoticeMsg<C extends PrintNoticeCode>(
  code: C,
  ...[params]: ParamArgs<(typeof PRINT_NOTICE_MESSAGES)[C]["tr"]>
): { code: C; message: string; params?: MessageParams } {
  return { code, message: renderMessage(PRINT_NOTICE_MESSAGES[code].tr, params), ...withParams(params) };
}

// ---------------------------------------------------------------- baskı şablonu uyarıları (PrintTemplateWarning.messageKey)

export const PRINT_WARNING_MESSAGES = {
  "no-slots": { code: "no-slots", tr: "Şablonda yuva yok." },
  "no-slots-sticker": { code: "no-slots", tr: "Şablonda ne yuva ne de sticker akışı var." },
  "slot-duplicate-id": { code: "slot-duplicate-id", tr: "Aynı kimlikli yuvalar var: {slots}." },
  "slot-outside": { code: "slot-outside", tr: "{count} yuva kağıt dışına taşıyor: {slots}." },
  "slot-overlap": { code: "slot-overlap", tr: "{count} yuva üst üste biniyor: {slots}." },
  "label-larger-than-slot": { code: "label-larger-than-slot", tr: "Etiket çapı ({diameter} mm) {count} yuvadan büyük; etiket yuva çizgisine taşar." },
  "slot-in-printer-margin": {
    code: "slot-in-printer-margin",
    tr: "{count} yuva (taşma payı dahil) yazıcının basamadığı {marginMm} mm'lik kenara giriyor: {slots}. Kenarı eksik basılabilir.",
  },
  "mark-overlap": {
    code: "mark-overlap",
    tr: "Kayıt işaretleri {count} yuvaya çakışıyor ya da taşma payı + {safeMm} mm güvenli alana giriyor: {slots}. Kenardan payı değiştirin.",
  },
} as const satisfies Record<string, { code: string; tr: string }>;

export type PrintWarningKey = keyof typeof PRINT_WARNING_MESSAGES;

export function printWarningMsg<K extends PrintWarningKey>(
  key: K,
  ...[params]: ParamArgs<(typeof PRINT_WARNING_MESSAGES)[K]["tr"]>
): { code: (typeof PRINT_WARNING_MESSAGES)[K]["code"]; message: string; messageKey: K; params?: MessageParams } {
  const def = PRINT_WARNING_MESSAGES[key];
  return { code: def.code, message: renderMessage(def.tr, params), messageKey: key, ...withParams(params) };
}
