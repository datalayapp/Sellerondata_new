import { z } from "zod";
import { FeaturesResponseSchema } from "./features.ts";
import { SetupStateSchema } from "./setup.ts";

// ================================================================ Firma (SUNUCU-PLANI §2.9)

/** Firma (kiracı). Kimlik UUIDv7 (Hesap servisindeki firma kimliğiyle aynı biçim). */
export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type Org = z.infer<typeof OrgSchema>;

/**
 * `GET /api/org` ve `PATCH /api/org` yanıtı (§2.9): firma, kurulum durumu (`setup`; kayıt yoksa `pending`) ve
 * özellik görünümü (`features`, `GET /api/features` ile aynı). Arayüz açılışta buna bakıp kurulum ekranını açar.
 */
/**
 * İsteğin firmadaki yetkisi (platform kipinde jetondaki izinlerden; yerel kipte hepsi `true`): `edit` iş, şablon ve baskı
 * değiştirme, `spend` yapay zekâ, `manage` ayarlar/özellikler/kurulum. Arayüz yönetim bölümlerini `manage`'e göre gösterir.
 */
export const OrgAccessSchema = z.object({ edit: z.boolean(), spend: z.boolean(), manage: z.boolean() });
export type OrgAccess = z.infer<typeof OrgAccessSchema>;

/** `platform`: sunucu SellerOnData platform kipinde (firma adı Merkez'de değişir, anahtarlar platformda). */
export const OrgResponseSchema = z.object({ org: OrgSchema, setup: SetupStateSchema, features: FeaturesResponseSchema, platform: z.boolean(), access: OrgAccessSchema });
export type OrgResponse = z.infer<typeof OrgResponseSchema>;

/** Firma adı: 1–80 karakter (baştaki/sondaki boşluk atılır). */
export const OrgPatchBodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type OrgPatchBody = z.infer<typeof OrgPatchBodySchema>;

/** Firma uçları. `request`: gövde şeması (null = gövdesiz); `response`: başarı yanıtı. */
export const ORG_API = {
  get: { method: "GET", path: "/api/org", request: null, response: OrgResponseSchema },
  patch: { method: "PATCH", path: "/api/org", request: OrgPatchBodySchema, response: OrgResponseSchema },
} as const;
