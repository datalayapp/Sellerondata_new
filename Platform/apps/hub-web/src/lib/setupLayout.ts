import type { ProductKey } from '@sellerondata/contracts';

/**
 * Genel Bakış'ta kurulumun nasıl çizileceği. Saf işlev: node ile doğrudan testlenir (`setupLayout.test.mjs`).
 * Merkez kurulumu (firma onayı) ile araç kurulumu ayrıdır (KARARLAR "Merkez kurulumu ve araç kurulumu"):
 * - `start`: başlangıç sayfası. Yönetici ve firma onayı eksik; ya da görünen araç var ve hiçbirinin kurulumu bitmemiş.
 * - `loading`: karar araçların overview'ına bağlı ve biri hâlâ yükleniyor; normal sayfa bir an görünüp kaybolmasın.
 * - `normal`: Genel Bakış; kurulumu hâlâ açık her görünen araç için üstte kısa kart (`cards`).
 * `tools` görünen araçların sırasıyla gelir; `setupOpen` = `isSetupOpen(overview)`, `pending` = ilk yanıt henüz yok.
 * Hata veren araç `setupOpen: false` gelir: kurulumu bilinmez, Genel Bakış hatayı kendi bölümünde söyler.
 */
export type SetupTool = { key: ProductKey; setupOpen: boolean; pending?: boolean };
export type SetupInput = { admin: boolean; companyConfirmed: boolean; tools: readonly SetupTool[] };
export type SetupLayout = { view: 'start' | 'loading' | 'normal'; cards: ProductKey[] };

export function setupLayout({ admin, companyConfirmed, tools }: SetupInput): SetupLayout {
  // Merkez kurulumu yalnız yöneticinin işidir; eksikse araçları beklemeden başlangıç sayfası.
  if (admin && !companyConfirmed) return { view: 'start', cards: [] };
  if (tools.some((t) => t.pending)) return { view: 'loading', cards: [] };
  if (tools.length > 0 && tools.every((t) => t.setupOpen)) return { view: 'start', cards: [] };
  return { view: 'normal', cards: tools.filter((t) => t.setupOpen).map((t) => t.key) };
}
