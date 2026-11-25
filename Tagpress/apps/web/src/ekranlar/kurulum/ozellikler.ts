import { applyToggle, effectiveFeatures, FEATURE_KEYS, FEATURES, type FeatureExplicit, type FeatureKey, LABEL_TYPES, type LabelType, SETUP_FEATURE_RULES } from "@tagpress/domain";
import type { IconName } from "../../tezgah/ikon/Icon.tsx";

/**
 * Kurulum 1. adımı: etiket türleri ve özellik satırları. Hangi türün hangi özelliği önerdiği sunucudadır
 * (`POST /api/setup/preview`, kaynak `@tagpress/domain` setup.ts); burada yalnız görünüm: sıra, gruplama, ikon.
 * Metinler `setup.json`'da: `types.<tür>`, `typeHints.<tür>`, `feat.<özellik kimliği>.name`.
 */
export const TYPE_IDS = LABEL_TYPES;
export type TypeId = LabelType;

/** Tür kartındaki ikon (maketteki etiket çizimleri yerine; ikon kümesinden). */
export const TYPE_ICON: Record<TypeId, IconName> = {
  wedding: "spark",
  baptism: "stamp",
  birthday: "flag",
  thanks: "msg",
  product: "tag",
  sticker: "cut",
};

/** Bir türün önerebildiği isteğe bağlı özellikler (ör. Sticker → Sticker sayfaları): ana listede görünür. */
const TYPE_LINKED = new Set<FeatureKey>(Object.values(SETUP_FEATURE_RULES.byType).flat());

/**
 * Satırlar: ana liste kayıttaki `setup: "core"` özellikler ve bir türe bağlı isteğe bağlılar; geri kalan isteğe
 * bağlılar kapalı grupta. `hidden` (her zaman açık) gösterilmez.
 */
export function featureRows(): { main: FeatureKey[]; more: FeatureKey[] } {
  const main: FeatureKey[] = [];
  const more: FeatureKey[] = [];
  for (const k of FEATURE_KEYS) {
    const place = FEATURES[k].setup ?? "optional";
    if (place === "hidden" || FEATURES[k].always) continue;
    if (place === "core" || TYPE_LINKED.has(k)) main.push(k);
    else more.push(k);
  }
  return { main, more };
}

/**
 * Elle açma/kapama, bağımlılıklarla (`applyToggle`, Ayarlar'daki anahtarla aynı kural): açılan özelliğin bağlı olduğu
 * özellikler de açılır; kapanan özelliğe bağlı olanlar da kapanır. Kayıt `complete` ile sunucuda yapılır.
 */
export function toggleWithDeps(state: Record<FeatureKey, boolean>, key: FeatureKey, on: boolean): Record<FeatureKey, boolean> {
  if (FEATURES[key].always) return state;
  const explicit: FeatureExplicit = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { on: state[k], by: "user", at: "" }]));
  return effectiveFeatures(applyToggle(explicit, key, on, "user", "").explicit);
}

/** Ücretli özellik (yapay zekâ ya da görsel hizmeti kullanır). */
export const isPaid = (k: FeatureKey): boolean => FEATURES[k].paid !== "none";
