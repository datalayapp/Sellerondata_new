import type { ProductKey } from '@sellerondata/contracts';

/**
 * Genel Bakış'ta kurulumun nasıl çizileceği. Saf işlev: node ile doğrudan testlenir (`setupLayout.test.mjs`).
 * Merkez kurulumu (firma onayı) ile araç kurulumu ayrıdır (KARARLAR "Merkez kurulumu ve araç kurulumu"):
 * - `start`: başlangıç sayfası. Yönetici ve firma onayı eksik; ya da görünen araç var ve hiçbirinin kurulumu bitmemiş.
 * - `loading`: karar araçların overview'ına bağlı ve biri hâlâ yükleniyor; normal sayfa bir an görünüp kaybolmasın.
 * - `normal`: Genel Bakış. Kurulumu hâlâ açık araç için Genel Bakış'ta kart yok; kurulum aracın kendi menüsünde ("Kurulum · Eksik").
 * `tools` görünen araçların sırasıyla gelir; `setupOpen` = `isSetupOpen(overview)`, `pending` = ilk yanıt henüz yok.
 * Hata veren araç `setupOpen: false` gelir: kurulumu bilinmez, Genel Bakış hatayı kendi bölümünde söyler.
 */
export type SetupTool = { key: ProductKey; setupOpen: boolean; pending?: boolean };
export type SetupInput = { admin: boolean; companyConfirmed: boolean; tools: readonly SetupTool[] };
export type SetupLayout = { view: 'start' | 'loading' | 'normal' };

export function setupLayout({ admin, companyConfirmed, tools }: SetupInput): SetupLayout {
  // Merkez kurulumu yalnız yöneticinin işidir; eksikse araçları beklemeden başlangıç sayfası.
  if (admin && !companyConfirmed) return { view: 'start' };
  if (tools.some((t) => t.pending)) return { view: 'loading' };
  if (tools.length > 0 && tools.every((t) => t.setupOpen)) return { view: 'start' };
  return { view: 'normal' };
}
