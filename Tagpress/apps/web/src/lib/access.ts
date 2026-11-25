import type { OrgAccess } from "@tagpress/domain";
import { useOrg } from "./features.ts";
import { isPlatform } from "./platform.ts";

/**
 * Kişinin firmadaki yetkisi (`GET /api/org` → `access`; sunucu jetondaki izinlerden yazar). Yerel kipte hepsi açık.
 * - `edit`: iş, şablon, baskı ve tasarım dili değiştirme (`tagpress.work.edit`)
 * - `spend`: ücretli (yapay zekâ) eylemler (`tagpress.ai.use`)
 * - `manage`: ayarlar, özellikler, kurulum, maliyet (`tagpress.settings.manage`)
 * Platformda yanıt gelene kadar hepsi kapalı sayılır: yönetim bölümü bir an görünüp kaybolmaz. Kod rol adına bakmaz.
 * Arayüzdeki gizleme kolaylıktır; asıl denetim sunucudadır (403 `FORBIDDEN`).
 */
export type AccessNeed = keyof OrgAccess;

const ALL: OrgAccess = { edit: true, spend: true, manage: true };
const NONE: OrgAccess = { edit: false, spend: false, manage: false };

export function useAccess(): OrgAccess {
  // Yerel kipte sorgu gitmez (yetki zaten tam); platformda `["org"]` önbelleği paylaşılır.
  const org = useOrg({ enabled: isPlatform() });
  if (!isPlatform()) return ALL;
  return org.data?.access ?? NONE;
}

/** Tek yetki: `useCan("manage")`. */
export function useCan(need: AccessNeed | undefined): boolean {
  const access = useAccess();
  return need ? access[need] : true;
}
