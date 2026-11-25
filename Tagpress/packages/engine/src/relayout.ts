import {
  applyLineEdits,
  type Box,
  checkTextPreserved,
  type DesignIntent,
  editIsEffective,
  graphemes,
  type Issue,
  issueMsg,
  type LayoutResult,
  type LineEdit,
  normalizeSpans,
  type PlacedLine,
  type Profile,
} from "@tagpress/domain";
import { type FontRegistry, strokeOutset } from "@tagpress/typeset";
import { buildLine, issue, resolveLines, symbolConnectors } from "./compose.ts";
import { checkIntentRules, glyphWarnings } from "./rules.ts";

/**
 * Hafif düzeltmede ELLE metin/font düzenlemesi (motor tarafı). AI yok; piksel koordinatı motordan gelir.
 * Düzenlenen satır AYNI puntoda yeniden şekillendirilir (glif kuralları, yedek font — fontta olmayan karakter yedek
 * fontla basılır, asla silinmez), taban çizgisi korunur ve profil hizasına göre eski satırın yerine oturur (ortalı
 * hizada mürekkep merkezi, solda sol kenar, sağda sağ kenar). Diğer satırlar yerinde kalır; sığma/çarpışma hızlı
 * denetimde raporlanır, kullanıcı boyut/konumla düzeltir.
 */

/** Kullanıcının seçemeyeceği font (profilde yok, kapalı, satır rolü yok ya da dosyası yüklü değil). */
export class EditFontError extends Error {}

const r2 = (v: number) => Math.round(v * 100) / 100;
const toBox = (b: { x0: number; y0: number; x1: number; y1: number }): Box => ({ x: r2(b.x0), y: r2(b.y0), w: r2(b.x1 - b.x0), h: r2(b.y1 - b.y0) });

/** Elle seçilebilecek satır fontları: profilde açık, satır rolü olan ve dosyası yüklü. */
export function editableFonts(profile: Profile, fonts: FontRegistry) {
  return profile.fonts.list.filter((f) => f.enabled && f.roles.length > 0 && fonts.has(f.id));
}

/**
 * Yalnızca glif kuralı için olan fontlar (profilde satır rolü yok): satırın "ana fontu" ve aile sayısına girmezler.
 * Bir kural fontu aynı zamanda satır fontuysa (ör. kalp → Corsiva) sayılır; kullanıcı onu satıra da seçebilir.
 */
function ruleOnlyFonts(profile: Profile): Set<string> {
  const lineFonts = new Set(profile.fonts.list.filter((f) => f.roles.length > 0).map((f) => f.id));
  return new Set(profile.glyphRules.filter((r) => r.enabled && !lineFonts.has(r.fontId)).map((r) => r.fontId));
}

/** Tek satırın ana fontu: glif kuralı ve yedek font run'ları dışında en çok grafemi basan run'ın fontu; yoksa null. */
export function placedLineFont(line: PlacedLine, profile: Profile): string | null {
  const skip = ruleOnlyFonts(profile);
  const count = new Map<string, number>();
  for (const r of line.runs) {
    if (r.fallback || skip.has(r.fontId)) continue;
    count.set(r.fontId, (count.get(r.fontId) ?? 0) + graphemes(r.text).filter((g) => !/^\s+$/u.test(g)).length);
  }
  let best: string | null = null;
  let n = -1;
  for (const [id, c] of count) if (c > n) [best, n] = [id, c];
  return best;
}

/** Satırın ana fontu; satırda yoksa (ör. yalnızca "&") en yakın satırınki, o da yoksa profilin ilk satır fontu. */
export function lineBaseFont(layout: LayoutResult, index: number, profile: Profile, fonts: FontRegistry): string {
  const own = layout.lines[index] ? placedLineFont(layout.lines[index]!, profile) : null;
  if (own) return own;
  for (let d = 1; d < layout.lines.length; d++) {
    for (const j of [index - d, index + d]) {
      const f = layout.lines[j] ? placedLineFont(layout.lines[j]!, profile) : null;
      if (f) return f;
    }
  }
  const first = editableFonts(profile, fonts)[0];
  if (!first) throw new EditFontError("Tasarım dilinde satır fontu yok.");
  return first.id;
}

export interface RelaidLine {
  line: PlacedLine;
  /** Yedek fontla basılan grafemler. */
  fallbackChars: string[];
  /** Hiçbir fontun basamadığı grafemler (tasarım fontuyla bırakılır, SİLİNMEZ). */
  unprintable: string[];
  /** Parçalı / tek renk basılacak emoji kümeleri (bkz. `Resolution`). */
  partialChars: string[];
  monochromeChars: string[];
}

/**
 * Bir satırı düzenlemeyle yeniden ölçer. `edit.text` yoksa satırın metni, `edit.fontId` yoksa satırın ana fontu.
 * `spans`: satır içi parça fontları (UTF-16 ofsetleri; grafem başlangıcına göre atanır).
 */
export function relayoutLine(layout: LayoutResult, index: number, edit: Omit<LineEdit, "index">, profile: Profile, fonts: FontRegistry): RelaidLine {
  const old = layout.lines[index];
  if (!old) throw new EditFontError(`Satır ${index + 1} yok.`);
  const allowed = new Set(editableFonts(profile, fonts).map((f) => f.id));
  const current = lineBaseFont(layout, index, profile, fonts);
  // Profil kalınlığı "real" ve yerleşim konturu yoksa motor fontun kalın stilini kullanmıştı: seçilen font da öyle.
  const heavy = profile.weight.mode === "real" && !(layout.strokePx > 0);
  const pick = (id: string): string => {
    if (id === current) return id;
    if (!allowed.has(id)) throw new EditFontError(`Bu font seçilemez: ${id}.`);
    const h = heavy ? fonts.heavier(id) : null;
    return h ? h.id : id;
  };
  const raw = edit.text ?? old.text;
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim() || old.text;
  const base = pick(edit.fontId ?? current);
  const spans = normalizeSpans(
    (edit.spans ?? []).map((s) => ({ ...s, start: s.start - lead, end: s.end - lead })),
    text.length,
  ).map((s) => ({ ...s, fontId: pick(s.fontId) }));
  const gs = graphemes(text);
  const starts: number[] = [];
  let off = 0;
  for (const g of gs) {
    starts.push(off);
    off += g.length;
  }
  const fontAt = spans.length
    ? (_l: number, g: number) => {
        const at = starts[g]!;
        return spans.find((s) => at >= s.start && at < s.end)?.fontId;
      }
    : undefined;
  const res = resolveLines([{ text, role: old.role, tier: old.tier, fontId: base }], profile, fonts, { fontAt });
  const resolved = { ...res.lines[0]!, ratio: 1 };
  const outset = strokeOutset(old.strokePx ?? layout.strokePx, profile.weight.align);
  const built = buildLine(fonts, resolved, old.sizePx, outset);
  const align = profile.spacing.align;
  const lx =
    align === "left"
      ? old.ink.x - built.ink.x0
      : align === "right"
        ? old.ink.x + old.ink.w - built.ink.x1
        : old.ink.x + old.ink.w / 2 - (built.ink.x0 + built.ink.x1) / 2;
  const by = old.baselineY;
  const line: PlacedLine = {
    text,
    role: old.role,
    tier: resolved.tier,
    sizePx: r2(old.sizePx),
    runs: built.runs.map((r) => {
      const f = fonts.get(r.src.fontId);
      return {
        text: r.src.text,
        fontId: r.src.fontId,
        family: f.family,
        style: f.style,
        sizePx: r2(r.shaped.sizePx),
        baselineShiftPx: r2(-r.dy),
        fallback: r.src.fallback,
        trackingEm: 0,
      };
    }),
    baselineY: by,
    x: r2(lx),
    advance: r2(built.advance),
    ink: toBox({ x0: built.ink.x0 + lx, x1: built.ink.x1 + lx, y0: built.ink.y0 + by, y1: built.ink.y1 + by }),
    ...(old.strokePx !== undefined ? { strokePx: old.strokePx } : {}),
  };
  return { line, fallbackChars: res.fallbackChars, unprintable: res.unprintable, partialChars: res.partialChars, monochromeChars: res.monochromeChars };
}

export interface ResolvedEdits {
  /** Etkisizleri atılmış, `placed` doldurulmuş düzenlemeler (satır sırasına göre). */
  edits: LineEdit[];
  /** Düzenlenmiş (düzeltmesiz) yerleşim. */
  layout: LayoutResult;
  fallbackChars: string[];
  unprintable: string[];
  partialChars: string[];
  monochromeChars: string[];
}

/**
 * Düzenlemeleri motorla çözer: istemcinin `placed`'i yok sayılır. Özgün metinle aynı metin ve satırın ana fontuyla
 * aynı font düşer; hiçbir şey söylemeyen düzenleme atılır.
 */
export function resolveEdits(layout: LayoutResult, edits: readonly LineEdit[] | undefined, profile: Profile, fonts: FontRegistry): ResolvedEdits {
  const out: LineEdit[] = [];
  const fallback = new Set<string>();
  const unprintable = new Set<string>();
  const partial = new Set<string>();
  const monochrome = new Set<string>();
  const seen = new Set<number>();
  for (const e of [...(edits ?? [])].sort((a, b) => a.index - b.index)) {
    if (seen.has(e.index) || !layout.lines[e.index] || !editIsEffective(e)) continue;
    seen.add(e.index);
    const old = layout.lines[e.index]!;
    const current = lineBaseFont(layout, e.index, profile, fonts);
    const raw = e.text;
    const lead = raw === undefined ? 0 : raw.length - raw.trimStart().length;
    const text = raw === undefined ? undefined : raw.trim() === old.text ? undefined : raw.trim();
    const fontId = e.fontId !== undefined && e.fontId !== current ? e.fontId : undefined;
    const lineFont = fontId ?? current;
    const len = (text ?? old.text).length;
    const spans = normalizeSpans(
      (e.spans ?? []).map((s) => ({ ...s, start: s.start - lead, end: s.end - lead })),
      len,
    ).filter((s) => s.fontId !== lineFont);
    const clean: Omit<LineEdit, "index"> = { ...(text !== undefined ? { text } : {}), ...(fontId !== undefined ? { fontId } : {}), ...(spans.length ? { spans } : {}) };
    if (!editIsEffective(clean)) continue;
    const r = relayoutLine(layout, e.index, clean, profile, fonts);
    r.fallbackChars.forEach((g) => fallback.add(g));
    r.unprintable.forEach((g) => unprintable.add(g));
    r.partialChars.forEach((g) => partial.add(g));
    r.monochromeChars.forEach((g) => monochrome.add(g));
    out.push({ index: e.index, ...clean, placed: r.line });
  }
  return { edits: out, layout: applyLineEdits(layout, out), fallbackChars: [...fallback], unprintable: [...unprintable], partialChars: [...partial], monochromeChars: [...monochrome] };
}

/** Yerleşimde yedek fontla basılan grafemler (run `fallback` işaretinden). */
export function layoutFallbackChars(layout: LayoutResult): string[] {
  const out = new Set<string>();
  for (const l of layout.lines) for (const r of l.runs) if (r.fallback) graphemes(r.text).filter((g) => !/^\s+$/u.test(g)).forEach((g) => out.add(g));
  return [...out];
}

/**
 * Yerleşimin font aileleri (yalnızca glif kuralı fontları ve yedek font run'ları hariç). Düzenleme uyarısı yalnızca
 * aile sayısı motorun yerleşimine göre ARTTIYSA verilir (kural fontu satır fontuysa motorda da sayılmıştır).
 */
export function layoutFamilies(layout: LayoutResult, profile: Profile): string[] {
  const skip = ruleOnlyFonts(profile);
  const out = new Set<string>();
  for (const l of layout.lines) for (const r of l.runs) if (!r.fallback && !skip.has(r.fontId)) out.add(r.family);
  return [...out];
}

/** Düzenleme varken temel sorunlardan düşen kodlar (yeniden hesaplanırlar). */
export const EDIT_REPLACED_CODES = new Set<Issue["code"]>(["text-fallback-font", "text-unprintable", "font-mixing", "text-edited"]);

export interface EditCheck {
  issues: Issue[];
  /** Satırlar iş metninden farklı mı (yalnızca satır bölmesi değil)? */
  textEdited: boolean;
  /** Kurallar için kullanılan metin: korunuyorsa iş metni, değilse kullanıcının yeni metni (satırlar alt alta). */
  effectiveText: string;
  /** Satır metni değişti mi (bölme ya da metin): değiştiyse satır kuralları yeniden hesaplanmıştır. */
  linesChanged: boolean;
}

/**
 * Elle düzenlemenin denetimi. Müşteri metni (`jobText`) değişmez; satırlar onu korumuyorsa bu bir ELLE düzenlemedir ve
 * açıkça işaretlenir (`text-edited`, bilgi). Satır kuralları kullanıcının yeni metnine göre yeniden çalışır (metin
 * koruma denetimi yeni metinle yapılır, yanlış "metin bozuldu" hatası çıkmaz). Profilin aile kuralı aşılıyorsa uyarı
 * (kullanıcı elle yaptığı için engellemez).
 */
export function checkEdits(input: {
  base: LayoutResult;
  edited: LayoutResult;
  edits: readonly LineEdit[];
  jobText: string;
  profile: Profile;
  unprintable?: readonly string[];
  /** Parçalı / tek renk basılacak emoji kümeleri (görünür uyarı). */
  partialChars?: readonly string[];
  monochromeChars?: readonly string[];
  /** Satır fontları (kurallar için niyet kurulurken). */
  lineFont?: (index: number) => string;
}): EditCheck {
  const { base, edited, edits, jobText, profile } = input;
  const issues: Issue[] = [];
  const lines = edited.lines.map((l) => l.text);
  const linesChanged = edits.some((e) => e.text !== undefined);
  const symbols = symbolConnectors(profile);
  const kept = checkTextPreserved(lines, jobText, symbols);
  const textEdited = linesChanged && !kept.ok;
  const effectiveText = textEdited ? lines.join("\n") : jobText;
  if (textEdited)
    issues.push(
      issue(
        "text-edited",
        "info",
        kept.params ? issueMsg("text-edited-diff", kept.params) : issueMsg("text-edited"),
        "adjust",
      ),
    );
  if (linesChanged) {
    const intent: DesignIntent = {
      lines: edited.lines.map((l, i) => ({ text: l.text, role: l.role, tier: l.tier, fontId: input.lineFont?.(i) ?? l.runs[0]?.fontId ?? "?" })),
      rationale: "",
    };
    issues.push(...checkIntentRules(intent, effectiveText, profile).filter((i) => i.code !== "text-changed"));
  }
  const limit = profile.fonts.mixing === "single" ? 1 : profile.fonts.mixing === "two" ? 2 : Infinity;
  const fams = layoutFamilies(edited, profile);
  if (fams.length > limit && fams.length > layoutFamilies(base, profile).length)
    issues.push(
      issue("font-mixing", "warning", issueMsg("font-mixing-adjust", { limit, count: fams.length, families: fams.join(", ") }), "adjust"),
    );
  const fb = layoutFallbackChars(edited);
  if (fb.length) issues.push(issue("text-fallback-font", "info", issueMsg("text-fallback-font-used", { chars: fb.join(" ") }), "adjust"));
  if (input.unprintable?.length)
    issues.push(issue("text-unprintable", "warning", issueMsg("text-unprintable-kept", { chars: input.unprintable.join(" ") }), "adjust"));
  issues.push(...glyphWarnings(input.partialChars ?? [], input.monochromeChars ?? []).map((i) => ({ ...i, field: "adjust" })));
  return { issues, textEdited, effectiveText, linesChanged };
}
