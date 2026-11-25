import { PAPER_SIZE_IDS, PAPER_SIZES, type PaperSizeId, type PrintGridSpec, type PrintGridSpecInput, PrintGridSpecSchema, type PrintSlot, paperSizeId, slotsInReadingOrder } from "@tagpress/domain";
import { i18n } from "../../../i18n/index.ts";
import { r2 } from "./slot-geometry.ts";

/**
 * Izgara üreteci — SAF (canlı önizleme istemcide). Sunucunun `templates/grid` ucuyla (services/print/geometry.ts
 * `generateGrid`) aynı sonucu verir; fark testte yakalanır.
 *
 * Kurallar (`PrintGridSpec` açıklamasıyla aynı):
 * - Yuva ölçüsü: dairede çap (`diameterMm`, yoksa `wMm`); elips/dikdörtgende `wMm × hMm` (verilmeyen çap olur).
 * - Adım (merkezden merkeze) verilmişse o; yoksa boşluk (kenardan kenara) + ölçü; ikisi de yoksa yuvalar kenar
 *   payları arasında (kenar payı da yoksa kağıtta, kenarlarla birlikte) eşit aralıkla dağıtılır.
 * - `center` ya da o eksende kenar payı verilmemişse ızgara o eksende kağıda ortalanır.
 * - Kaydırmalı dizilim: 2., 4., … satırlar `offsetXMm` (varsayılan yarım adım) kayar; `dropLast` o satırların son yuvasını atar.
 * - Adım sıfır ya da eksi çıkarsa hata; yuvalar birbirine giriyorsa hata değil, şablon uyarısı (çakışma) çıkar.
 * - Kimlikler okuma sırasıyla s1, s2, …
 */

const t = (key: string): string => i18n.t(key) as string;

export interface GridResult {
  slots: PrintSlot[];
  /** Kullanıcıya gösterilecek hata (ör. çap yok); varsa `slots` boş. */
  error: string | null;
  /** Hesaplanan adım ve boşluk (mm) — panelde bilgi olarak. */
  pitchX: number;
  pitchY: number;
  gapX: number;
  gapY: number;
}

function slotSize(g: PrintGridSpec): { w: number; h: number } | null {
  if (g.shape === "circle") {
    const d = g.diameterMm ?? g.wMm ?? g.hMm;
    return d ? { w: d, h: d } : null;
  }
  const w = g.wMm ?? g.diameterMm ?? g.hMm;
  const h = g.hMm ?? g.diameterMm ?? w;
  return w && h ? { w, h } : null;
}

export function generateGrid(input: PrintGridSpecInput): GridResult {
  const parsed = PrintGridSpecSchema.safeParse(input);
  const empty = { slots: [], pitchX: 0, pitchY: 0, gapX: 0, gapY: 0 };
  if (!parsed.success) return { ...empty, error: t("printDesk:grid.invalid") };
  const g = parsed.data;
  const size = slotSize(g);
  if (!size) return { ...empty, error: t(g.shape === "circle" ? "printDesk:grid.diameter" : "printDesk:grid.size") };
  const { w, h } = size;

  // Kaydırmalı satırlar sağa taşar (son yuva atılmıyorsa): eşit dağıtımda blok genişliğine kaydırma da girer.
  const st = g.stagger;
  const staggered = st.enabled && g.rows > 1;
  const extendsRight = staggered && !st.dropLast;
  const frac = extendsRight && st.offsetXMm === undefined ? 0.5 : 0;
  const fixed = extendsRight && st.offsetXMm !== undefined ? st.offsetXMm : 0;
  const axis = (n: number, sz: number, paper: number, margin: number | undefined, pitch: number | undefined, gap: number | undefined, fr: number, fx: number) => {
    const span = n - 1 + fr;
    if (pitch !== undefined) return pitch;
    if (gap !== undefined) return sz + gap;
    if (span <= 0) return sz;
    if (margin !== undefined && !g.center) return (paper - 2 * margin - sz - fx) / span;
    return sz + (paper - sz - fx - span * sz) / (2 + span);
  };
  const pitchX = axis(g.columns, w, g.paper.wMm, g.marginLeftMm, g.pitchXMm, g.gapXMm, frac, fixed);
  const pitchY = axis(g.rows, h, g.paper.hMm, g.marginTopMm, g.pitchYMm, g.gapYMm, 0, 0);
  if (!(pitchX > 0) || !(pitchY > 0)) return { ...empty, error: t("printDesk:grid.noFit") };
  const offset = staggered ? (st.offsetXMm ?? pitchX / 2) : 0;
  const blockW = (g.columns - 1) * pitchX + w + (extendsRight ? offset : 0);
  const blockH = (g.rows - 1) * pitchY + h;
  const left = g.marginLeftMm !== undefined && !g.center ? g.marginLeftMm : (g.paper.wMm - blockW) / 2;
  const top = g.marginTopMm !== undefined && !g.center ? g.marginTopMm : (g.paper.hMm - blockH) / 2;

  const raw: Array<Omit<PrintSlot, "id">> = [];
  for (let r = 0; r < g.rows; r++) {
    const shifted = staggered && r % 2 === 1;
    const n = shifted && st.dropLast ? g.columns - 1 : g.columns;
    for (let c = 0; c < n; c++) {
      raw.push({
        shape: g.shape,
        cx: r2(left + w / 2 + c * pitchX + (shifted ? offset : 0)),
        cy: r2(top + h / 2 + r * pitchY),
        w: r2(w),
        h: r2(h),
        rotation: 0,
        cornerRadius: g.shape === "rect" ? g.cornerRadiusMm : 0,
      });
    }
  }
  const slots = slotsInReadingOrder(raw).map((s, i) => ({ id: `s${i + 1}`, ...s }));
  return { slots, error: null, pitchX: r2(pitchX), pitchY: r2(pitchY), gapX: r2(pitchX - w), gapY: r2(pitchY - h) };
}

/** Kağıt ön ayarları (genel standart ölçüler; tasarım diline ait değil). */
// Ad etkin dilde okunur (`label` alıcı): TR "A4 yatay (297 × 210)", EN "A4 landscape (297 × 210)".
const preset = (id: string, key: string, wMm: number, hMm: number): { id: string; label: string; wMm: number; hMm: number } => ({
  id,
  get label() {
    return i18n.t(`printDesk:paper.${key}`) as string;
  },
  wMm,
  hMm,
});
// Ölçüler `@tagpress/domain` `PAPER_SIZES`'tan (tek kaynak; kurulumdaki `print.paperPreset` kimlikleri aynı).
const LABEL_KEYS: Record<PaperSizeId, string> = { a4: "a4", "a4-yatay": "a4Landscape", a3: "a3", a5: "a5", sra3: "sra3", letter: "letter" };
export const PAPER_PRESETS: Array<{ id: string; label: string; wMm: number; hMm: number }> = PAPER_SIZE_IDS.map((id) =>
  preset(id, LABEL_KEYS[id], PAPER_SIZES[id].wMm, PAPER_SIZES[id].hMm),
);

/** Kağıt ölçüsünün ön ayar kimliği (eşleşmezse "ozel"). */
export function paperPresetId(p: { wMm: number; hMm: number }): string {
  return paperSizeId(p) ?? "ozel";
}

/** Var olan yuvalardan ızgara üretecine başlangıç değeri tahmini (şablonda yuva varsa panel onlarla açılır). */
export function guessGrid(paper: { wMm: number; hMm: number }, slots: readonly PrintSlot[]): PrintGridSpecInput {
  const first = slots[0];
  if (!first) return { paper, columns: 4, rows: 6, shape: "circle", diameterMm: 38, center: true };
  const cols = new Set(slots.map((s) => Math.round(s.cx))).size;
  const rows = new Set(slots.map((s) => Math.round(s.cy))).size;
  const xs = [...new Set(slots.map((s) => r2(s.cx)))].sort((a, b) => a - b);
  const ys = [...new Set(slots.map((s) => r2(s.cy)))].sort((a, b) => a - b);
  const pitchX = xs.length > 1 ? r2(xs[1]! - xs[0]!) : undefined;
  const pitchY = ys.length > 1 ? r2(ys[1]! - ys[0]!) : undefined;
  return {
    paper,
    columns: Math.max(1, Math.min(cols, 200)),
    rows: Math.max(1, Math.min(rows, 200)),
    shape: first.shape,
    ...(first.shape === "circle" ? { diameterMm: first.w } : { wMm: first.w, hMm: first.h }),
    cornerRadiusMm: first.cornerRadius ?? 0,
    pitchXMm: pitchX,
    pitchYMm: pitchY,
    center: true,
  };
}
