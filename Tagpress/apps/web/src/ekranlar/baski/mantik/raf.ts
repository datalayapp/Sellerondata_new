import { parseCutSizeId, type PrintPreset, type PrintSlot, type PrintTemplate, slotFitsCut, type TemplateCut } from "@tagpress/domain";
import type { ShelfGroup } from "./shelf.ts";

/**
 * Raf grubu ↔ sayfa şablonu kesim uyumu ve hazır ayarın boyutu — SAF. Kural sunucunun `pageTemplateFor`'uyla aynı
 * (`apps/server/src/services/print/shelf.ts`): önce boyut kimliği tam uyan şablon; yoksa boyutsuz şablonlar. Grubun
 * işleri kesimliyse (raf satırındaki `cut`: dikdörtgen, oval, köşesi yuvarlak, daire) boyutsuz şablon yalnız BÜTÜN
 * yuvaları o kesime uyuyorsa kullanılır; uymayanlar ayrı döner (rafta uyarı). Kesimsiz (eski) işte boyutsuz şablonların
 * hepsi (eski kural; sahibin akışı değişmez). Ayrım boyut kimliğinden değil `cut` alanından yapılır: daire kesiminin
 * kimliği ("3.8") eski boyutla aynıdır; raf ikisini ayrı gruba koyar (`groupShelf`).
 */

type TplLike = Pick<PrintTemplate, "kind" | "sizeId" | "archived" | "slots">;

export interface GroupTemplates<T> {
  /** Grubun basılabileceği şablonlar (Planla bunları önerir). */
  usable: T[];
  /** Boyutsuz ama yuvaları grubun kesimine uymayan şablonlar (Planla önermez; uyarı gösterilir). */
  unfit: T[];
}

const fitsAll = (slots: readonly PrintSlot[], cut: TemplateCut) => slots.length > 0 && slots.every((s) => slotFitsCut(s, cut));

export function groupTemplates<T extends TplLike>(g: Pick<ShelfGroup, "kind" | "sizeId"> & Partial<Pick<ShelfGroup, "cut">>, templates: readonly T[]): GroupTemplates<T> {
  const live = templates.filter((t) => !t.archived && t.kind === g.kind);
  const exact = live.filter((t) => t.sizeId !== null && t.sizeId === g.sizeId);
  if (exact.length) return { usable: exact, unfit: [] };
  const loose = live.filter((t) => t.sizeId === null);
  const cut = g.kind === "label" ? g.cut : undefined;
  if (!cut) return { usable: loose, unfit: [] };
  return { usable: loose.filter((t) => fitsAll(t.slots, cut)), unfit: loose.filter((t) => !fitsAll(t.slots, cut)) };
}

/**
 * Hazır ayardan ızgara uygulanınca şablona yazılacak boyut alanları (sunucunun `grid` ucunun `sizeId` /
 * `labelDiameterMm` alanlarının karşılığı; düzenleyici taslağı PATCH'le kaydeder):
 * - Hazır ayarın boyut kimliği varsa yazılır; kesim kimliğiyse yalnız üretilen yuvaların hepsi o kesime uyuyorsa
 *   (kullanıcı ölçüyü değiştirdiyse boyut yanlış olur, eski değer kalır).
 * - Hazır ayarın boyutu yoksa şablonun kesim kimliği yeni yuvalara uymuyorsa boşaltılır (ör. dikdörtgen kağıda daire
 *   ızgarası); uyuyorsa ya da eski boyut kimliğiyse ("3.8") dokunulmaz.
 * - Etiket çapı hazır ayarda varsa yazılır.
 * Tür farklıysa (etiket hazır ayarı sticker şablonunda) hiçbir şey yazılmaz.
 */
export function presetSizePatch(
  preset: Pick<PrintPreset, "kind" | "sizeId" | "labelDiameterMm"> | null,
  draft: { kind: PrintTemplate["kind"]; sizeId: string | null },
  slots: readonly PrintSlot[],
): { sizeId?: string | null; labelDiameterMm?: number } {
  if (!preset || preset.kind !== draft.kind) return {};
  const out: { sizeId?: string | null; labelDiameterMm?: number } = {};
  if (preset.sizeId !== null) {
    const cut = preset.kind === "label" ? parseCutSizeId(preset.sizeId) : null;
    if (!cut || fitsAll(slots, cut)) out.sizeId = preset.sizeId;
  } else if (draft.kind === "label") {
    const cur = parseCutSizeId(draft.sizeId);
    if (cur && !fitsAll(slots, cur)) out.sizeId = null;
  }
  if (preset.labelDiameterMm !== null) out.labelDiameterMm = preset.labelDiameterMm;
  return out;
}
