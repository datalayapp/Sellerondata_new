import { type FeatureKey, builderRouteTable } from "@tagpress/domain";

/**
 * Uç → özellik tablosu (SUNUCU-PLANI §3.3). Fastify'a kayıtlı HER uç (`METOT yol`, Fastify'ın yol yazımıyla) burada
 * olmalı (`route-map.test.ts` ve izolasyon takımı denetler). `feature` yoksa uç çekirdektir (her zaman açık).
 * - `read`: veri okur; özellik kapalıyken de açık kalır (kapatmak veri silmez, gizlemez).
 * - `write`: veri değiştirir; özellik kapalıysa 409 `feature-off`.
 * - `spend`: yapay zekâ harcaması yapabilir; özellik kapalıysa 409 `feature-off`.
 * - `manage`: firma yönetimi (ayarlar, anahtarlar, özellik anahtarları, kurulum yazmaları, firma adı); özelliği yoktur.
 * Gövdeye bağlı denetimler (üretim kipi, görsel denetim, ikinci tasarım dili, sticker sayfa şablonu) serviste
 * (`requireFeature`); tablo yalnız uç düzeyindedir. Fastify'ın GET için açtığı HEAD kopyası GET'in kaydını kullanır.
 * Platform kipinde erişim izne bağlanır (`org/access.ts` `ACCESS_PERMISSIONS`): read → `tagpress.web.access`, write →
 * `tagpress.work.edit`, spend → `tagpress.ai.use` + `tagpress.work.edit`, manage → `tagpress.settings.manage`. Yerel kipte
 * izin `all`. Harcama tutarı okuyan uçlar platformda ayrıca `manage` ister (`PLATFORM_MANAGE_READS`).
 */
export type RouteAccess = "read" | "write" | "spend" | "manage";
export interface RouteFeature {
  feature?: FeatureKey;
  access: RouteAccess;
}

const core = (access: RouteAccess): RouteFeature => ({ access });
const f = (feature: FeatureKey, access: RouteAccess): RouteFeature => ({ feature, access });

export const ROUTE_FEATURES: Readonly<Record<string, RouteFeature>> = {
  // ------------------------------------------------ sistem, ayarlar, olaylar
  "GET /api/health": core("read"),
  "GET /api/settings": core("read"),
  "PATCH /api/settings": core("manage"),
  "PUT /api/settings/keys/:provider": core("manage"),
  "DELETE /api/settings/keys/:provider": core("manage"),
  "POST /api/settings/keys/:provider/test": core("manage"),
  "GET /api/costs": core("read"),
  "GET /api/ai-calls/:id": core("read"),
  "POST /api/undo/:token": core("write"),
  "GET /api/profile-docs": core("read"),
  "GET /api/events": core("read"),
  "GET /api/fallback-fonts": core("read"),
  "GET /api/fallback-fonts.css": core("read"),
  "GET /api/fallback-fonts/:file": core("read"),

  // ------------------------------------------------ firma, özellikler, kurulum
  "GET /api/org": core("read"),
  "PATCH /api/org": core("manage"),
  "GET /api/features": core("read"),
  "PATCH /api/features": core("manage"),
  "GET /api/setup": core("read"),
  "POST /api/setup/preview": core("read"),
  "PUT /api/setup/answers": core("manage"),
  "POST /api/setup/complete": core("manage"),
  "POST /api/setup/skip": core("manage"),
  "POST /api/setup/restart": core("manage"),

  // ------------------------------------------------ tasarım dilleri ve profil
  "GET /api/languages": core("read"),
  // İkinci dil `language.multi` (serviste: `LanguageService.create`).
  "POST /api/languages": core("write"),
  "PATCH /api/languages/:lang": core("write"),
  "DELETE /api/languages/:lang": core("write"),
  "POST /api/languages/:lang/default": core("write"),
  "GET /api/languages/:lang/profile": core("read"),
  "GET /api/languages/:lang/profile/draft": core("read"),
  "PUT /api/languages/:lang/profile/draft": f("language.rules", "write"),
  // Taslağı yayınlamak ve atmak çekirdek: taslak öğrenmeden, oluşturucudan ya da MCP oturumundan da gelir.
  "DELETE /api/languages/:lang/profile/draft": core("write"),
  "POST /api/languages/:lang/profile/publish": core("write"),
  "GET /api/languages/:lang/profile/versions": f("language.rules", "read"),
  "GET /api/languages/:lang/profile/versions/:version": f("language.rules", "read"),
  "GET /api/languages/:lang/profile/diff": f("language.rules", "read"),
  "POST /api/languages/:lang/profile/revert": f("language.rules", "write"),
  "POST /api/languages/:lang/profile/try": core("spend"),

  // ------------------------------------------------ şablonlar ve fontlar
  "GET /api/languages/:lang/templates": core("read"),
  "POST /api/languages/:lang/templates": core("write"),
  "POST /api/languages/:lang/templates/sync": core("write"),
  "GET /api/languages/:lang/templates/:key": core("read"),
  "PATCH /api/languages/:lang/templates/:key": f("templates.editor", "write"),
  // Kesim önizlemesi kayda yazmaz (PATCH'ten önce sayı sorar).
  "POST /api/languages/:lang/templates/:key/cut-preview": f("templates.editor", "read"),
  "GET /api/languages/:lang/templates/:key/image.png": core("read"),
  "GET /api/languages/:lang/templates/:key/overlay.png": f("templates.editor", "read"),
  "POST /api/languages/:lang/templates/:key/suggest-area": f("templates.editor", "write"),
  "POST /api/languages/:lang/templates/:key/try": f("templates.editor", "write"),
  "POST /api/languages/:lang/templates/generate": f("image.themeTemplate", "spend"),
  "GET /api/template-tasks/:id": f("image.themeTemplate", "read"),
  "GET /api/languages/:lang/fonts": core("read"),
  "POST /api/languages/:lang/fonts": core("write"),
  "GET /api/languages/:lang/fonts/:file/specimen.png": core("read"),

  // ------------------------------------------------ dil paketi
  "GET /api/languages/:lang/export": f("language.package", "read"),
  "POST /api/languages/import": f("language.package", "write"),

  // ------------------------------------------------ içe aktarma, işler, partiler, varyasyonlar, üretim
  "POST /api/import/preview": f("import.json", "write"),
  "POST /api/import/validate": f("import.json", "write"),
  "POST /api/import/commit": f("import.json", "write"),
  "GET /api/jobs": core("read"),
  "POST /api/jobs/manual": f("jobs.manual", "write"),
  "POST /api/jobs/bulk": core("write"),
  "POST /api/jobs/delete": core("write"),
  "POST /api/jobs/approve-best": core("write"),
  "GET /api/jobs/:id": core("read"),
  "PATCH /api/jobs/:id": core("write"),
  "DELETE /api/jobs/:id": core("write"),
  "POST /api/jobs/:id/approve": core("write"),
  "GET /api/jobs/:id/log": core("read"),
  "GET /api/batches": core("read"),
  "PATCH /api/batches/:id": core("write"),
  "DELETE /api/batches/:id": core("write"),
  "GET /api/variants/:id": core("read"),
  "PATCH /api/variants/:id": core("write"),
  "DELETE /api/variants/:id": core("write"),
  "GET /api/variants/:id/preview.png": core("read"),
  "GET /api/variants/:id/text-layer.png": core("read"),
  "POST /api/variants/:id/revise": f("revise", "spend"),
  // Üretim (`core.production`, her zaman açık); görüntü kipleri `image.onTemplate` / `image.themeTemplate`
  // (serviste: `GenerationService.enqueue`).
  "POST /api/generate": core("spend"),
  "POST /api/generate/cancel": core("write"),
  "GET /api/generate/status": core("read"),

  // ------------------------------------------------ düzelt (hafif düzeltme, elle metin ve font)
  "GET /api/variants/:id/edit": f("adjust", "read"),
  "GET /api/variants/:id/edit/text.svg": f("adjust", "read"),
  "POST /api/variants/:id/edit/relayout": f("adjust", "write"),
  "POST /api/variants/:id/adjust/check": f("adjust", "write"),
  "PUT /api/variants/:id/adjust": f("adjust", "write"),
  "DELETE /api/variants/:id/adjust": f("adjust", "write"),

  // ------------------------------------------------ referanslar, öneriler, öğrenme
  "GET /api/references": f("learn", "read"),
  "POST /api/references": f("learn", "write"),
  "GET /api/references/:id": f("learn", "read"),
  "PATCH /api/references/:id": f("learn", "write"),
  "DELETE /api/references/:id": f("learn", "write"),
  "GET /api/references/:id/image.png": f("learn", "read"),
  "GET /api/learn/proposals": f("learn", "read"),
  "POST /api/learn/proposals": f("learn", "write"),
  "GET /api/learn/proposals/:id": f("learn", "read"),
  "PATCH /api/learn/proposals/:id": f("learn", "write"),
  "DELETE /api/learn/proposals/:id": f("learn", "write"),
  "POST /api/languages/:lang/learn/run": f("learn", "write"),
  "GET /api/languages/:lang/learn/run": f("learn", "read"),
  "DELETE /api/languages/:lang/learn/run": f("learn", "write"),
  "POST /api/learn/proposals/:id/apply": f("learn", "write"),
  "POST /api/learn/proposals/:id/reject": f("learn", "write"),
  "POST /api/learn/proposals/:id/revert": f("learn", "write"),
  "GET /api/languages/:lang/learn/measure": f("learn", "read"),
  "GET /api/languages/:lang/learn/samples": f("learn", "read"),
  "POST /api/languages/:lang/learn/replay": f("learn", "write"),
  "GET /api/learn/previews/:dir/:file": f("learn", "read"),
  "GET /api/learn/references/:id/thumb.png": f("learn", "read"),
  "GET /api/languages/:lang/learn/templates/:key/thumb.png": f("learn", "read"),
  "GET /api/trials/:id/preview.png": core("read"),

  // ------------------------------------------------ tasarım dili oturumu (MCP becerisi: yapay zekâ ile dil)
  "GET /api/languages/:lang/design-session": f("language.builder", "read"),
  "POST /api/languages/:lang/design-session": f("language.builder", "write"),
  "POST /api/languages/:lang/design-session/entries": f("language.builder", "write"),
  "POST /api/languages/:lang/design-session/draft": f("language.builder", "write"),

  // ------------------------------------------------ sitede oluşturucu (`BUILDER_API`; satırlar sözleşmeden: yol, özellik, erişim)
  ...Object.fromEntries(builderRouteTable().map((r) => [r.key, f(r.feature, r.access)])),
  // Oturum sınırını artırmak harcamayı açar: yapay zekâ izni ister (sözleşmede `write`; R1 kararı: `spend`).
  "POST /api/builds/:id/budget/raise": f("language.builder", "spend"),

  // ------------------------------------------------ baskı masası (sticker sayfa şablonu `print.stickers`: serviste)
  "GET /api/print/templates": f("print", "read"),
  "POST /api/print/templates": f("print", "write"),
  "POST /api/print/templates/grid": f("print", "write"),
  "GET /api/print/templates/:id": f("print", "read"),
  "PATCH /api/print/templates/:id": f("print", "write"),
  "DELETE /api/print/templates/:id": f("print", "write"),
  "POST /api/print/templates/:id/archive": f("print", "write"),
  "POST /api/print/templates/:id/duplicate": f("print", "write"),
  "GET /api/print/presets": f("print", "read"),
  "POST /api/print/presets": f("print", "write"),
  "PATCH /api/print/presets/:id": f("print", "write"),
  "DELETE /api/print/presets/:id": f("print", "write"),
  "GET /api/print/shelf": f("print", "read"),
  "GET /api/print/sessions": f("print", "read"),
  "POST /api/print/sessions": f("print", "write"),
  "GET /api/print/sessions/:id": f("print", "read"),
  "PATCH /api/print/sessions/:id": f("print", "write"),
  "DELETE /api/print/sessions/:id": f("print", "write"),
  "POST /api/print/sessions/:id/replan": f("print", "write"),
  "POST /api/print/sessions/:id/jobs": f("print", "write"),
  "POST /api/print/sessions/:id/printed": f("print", "write"),
  "POST /api/print/sessions/:id/reprint": f("print", "write"),
  "GET /api/print/pages/:id/preview.png": f("print", "read"),
  "POST /api/print/sessions/:id/export": f("print", "write"),
  "GET /api/print/exports/:id": f("print", "read"),
  "GET /api/print/exports/:id/files/:index": f("print", "read"),
};

/**
 * Yalnız platform kipinde kayıtlı, yolu yeniden yazılmayan uçlar (plan §S3; product-kit ve auth-kit kaydeder). Uç tablosunda
 * değildir: izinlerini kendileri denetler (Merkez uçları kayıttaki `hub` izinleriyle; olay alıcısı imzalı olay jetonuyla).
 * `public`: kimlik istemez (sağlık, imzalı olay alıcısı; gateway olay yolunu dışarı kapatır).
 */
export const PLATFORM_ROUTES: Readonly<Record<string, { public: boolean }>> = {
  "GET /api/tagpress/health": { public: true },
  "POST /api/tagpress/internal/events": { public: true },
  "GET /api/tagpress/platform/overview": { public: false },
  "GET /api/tagpress/platform/analytics": { public: false },
  "GET /api/tagpress/platform/datasets": { public: false },
  "GET /api/tagpress/platform/datasets/:id": { public: false },
  "GET /api/tagpress/platform/datasets/:id/export": { public: false },
  "GET /api/tagpress/platform/activity": { public: false },
};

/**
 * Platform kipinde platformun yönettiği uçlar: yapay zekâ anahtarları geçitte (`Platform/apps/ai-api`), firmalar anahtar
 * girmez. Yerel kipte olağan çalışır; platformda (izinden sonra) 409 `managed-by-platform`.
 */
export const PLATFORM_MANAGED_ROUTES: ReadonlySet<string> = new Set([
  "PUT /api/settings/keys/:provider",
  "DELETE /api/settings/keys/:provider",
  "POST /api/settings/keys/:provider/test",
]);

/**
 * Platform kipinde harcama tutarı okuyan uçlar: yalnız TagPress Yöneticisi (`manage`; R1 kararı). Tabloda `read` kalır
 * (özellik kapısı okumayı kapatmaz); uç kapısı (`features/gate.ts`) bunlara `tagpress.settings.manage` ister, diğerine 403
 * `FORBIDDEN`. Tutarı yan bilgi olarak taşıyan yanıtlar (iş günlüğündeki çağrılar, varyasyon kaydı, şablon görevi) uçta
 * kapanmaz; tutar alanı `null` gelir (`org/access.ts` `canSeeAmounts`). Yerel kipte değişiklik yok.
 */
export const PLATFORM_MANAGE_READS: ReadonlySet<string> = new Set(["GET /api/costs", "GET /api/ai-calls/:id"]);

/** Platform uç listesindeki kayıt (HEAD kopyası GET'inki); yoksa null. */
export function platformRoute(method: string, url: string): { public: boolean } | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return PLATFORM_ROUTES[`${m} ${url}`] ?? null;
}

/** Uç kaydı: `METOT yol` (HEAD kopyası GET'in kaydı); tabloda yoksa null. */
export function routeFeature(method: string, url: string): RouteFeature | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return ROUTE_FEATURES[`${m} ${url}`] ?? null;
}

/** Kapalıyken reddedilen uç mu (yazma ya da harcama, özelliği olan). */
export function gated(entry: RouteFeature | null): entry is RouteFeature & { feature: FeatureKey } {
  return !!entry?.feature && entry.access !== "read";
}
