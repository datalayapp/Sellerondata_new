import {
  type FontKind,
  type GlyphRule,
  type IntentLine,
  type Issue,
  type IssueText,
  type LineRole,
  type Profile,
  type Tier,
  checkTextPreserved,
  graphemes,
  isInitialsOnly,
  issueMsg,
} from "@tagpress/domain";
import { type Box, type FontRegistry, inflateBox, type ShapedRun, shapeRun, unionBox } from "@tagpress/typeset";

/**
 * compose: niyet + profil → satır bloğu.
 *  1. Ön işlem (metin koruma, baş harf tek satır, asılı bağlaç) — her adım profil bayrağına bağlı.
 *  2. Run çözümü (glif kuralları HER satırda ve HER rolde, yedek font).
 *  3. Belirli bir ana puntoda (k) satırları şekillendirip mürekkep boşluklarıyla bloğu kurma.
 */

// ───────────────────────── yardımcılar ─────────────────────────

const hasLetterOrDigit = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Boşluk eklenip kaldırılabilen sembol bağlaçlar (&, +); profil izin vermiyorsa boş. */
export function symbolConnectors(profile: Profile): string[] {
  if (!profile.connectors.allowSymbolSpacing) return [];
  return profile.connectors.words.filter((w) => w.trim() && !hasLetterOrDigit(w));
}

/** Metin tek başına bir bağlaç mı ("&", "e", "and")? */
export function isConnectorText(text: string, profile: Profile): boolean {
  const t = text.trim().toLowerCase();
  return !!t && profile.connectors.words.some((w) => w.toLowerCase() === t);
}

export function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

const wordCount = (s: string) => s.trim().split(/\s+/u).filter(Boolean).length;
const TIER_RANK: Record<Tier, number> = { primary: 0, secondary: 1, tertiary: 2, connector: 3 };
/** Cümle/ifade rolleri: asılı bağlaç kuralı bunlara dokunmaz. */
const SENTENCE_ROLES = new Set<LineRole>(["message", "greeting", "date", "place", "title"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ───────────────────────── 1. ön işlem ─────────────────────────

export interface Prepared {
  lines: IntentLine[];
  notes: string[];
  /** Metin korunmadıysa. */
  problem?: string;
  /** `problem` cümlesinin sözlük anahtarı ve parametreleri. */
  problemText?: IssueText;
}

/**
 * Satır kenarı boşluklarını atar (metin değişmez), metnin korunduğunu doğrular, profil bayraklarına göre
 * baş harf çiftini tek satıra alır ve asılı bağlacı ayırır. Her değişiklik `notes`'a yazılır.
 */
export function prepareIntent(lines: readonly IntentLine[], text: string, profile: Profile): Prepared {
  const symbols = symbolConnectors(profile);
  const preserved = (ls: IntentLine[]) => checkTextPreserved(ls.map((l) => l.text), text, symbols).ok;
  const trimmed = lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
  const check = checkTextPreserved(trimmed.map((l) => l.text), text, symbols);
  if (!check.ok) {
    const problemText = check.params ? issueMsg("text-changed", check.params) : issueMsg("text-changed-generic");
    return { lines: trimmed, notes: [], problem: check.problem ?? problemText.message, problemText };
  }
  const notes: string[] = [];
  let out = trimmed;
  if (profile.sizing.initials.oneLine) {
    const joined = joinInitials(out, text, profile, preserved);
    if (joined !== out) {
      out = joined;
      notes.push("Baş harfler tek satıra alındı.");
    }
  }
  if (profile.connectors.separateDangling) {
    const sep = separateDangling(out, profile);
    if (sep.lines !== out && preserved(sep.lines)) {
      out = sep.lines;
      notes.push(...sep.notes);
    }
  }
  return { lines: out, notes };
}

/** Art arda satırlar birleşince yalnızca baş harf ("A & M") oluyorsa tek satıra alır (en büyük satırın sınıfı ve fontuyla). */
function joinInitials(lines: IntentLine[], text: string, profile: Profile, preserved: (ls: IntentLine[]) => boolean): IntentLine[] {
  const words = profile.connectors.words;
  const flat = text.replace(/\s+/gu, " ");
  for (let span = Math.min(lines.length, 5); span >= 2; span--) {
    for (let i = 0; i + span <= lines.length; i++) {
      const group = lines.slice(i, i + span);
      if (!isInitialsOnly(group.map((l) => l.text).join(" "), words)) continue;
      const lead = [...group].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]!;
      const sizes = group.map((l) => l.size).filter((s): s is number => s !== undefined);
      // Kaynakta birebir geçen birleşim önce ("A&M" boşluksuzsa boşluksuz), yoksa metni koruyan ilk birleşim.
      const options = [" ", ""].map((sep) => group.map((l) => l.text).join(sep));
      options.sort((a, b) => Number(flat.includes(b)) - Number(flat.includes(a)));
      for (const joined of options) {
        const merged: IntentLine = {
          text: joined,
          role: "name",
          tier: "primary",
          fontId: lead.fontId,
          ...(sizes.length ? { size: Math.max(...sizes) } : {}),
        };
        const next = [...lines.slice(0, i), merged, ...lines.slice(i + span)];
        if (preserved(next)) return joinInitials(next, text, profile, preserved);
      }
    }
  }
  return lines;
}

/**
 * Satır başında/sonunda asılı kalan bağlacı kendi satırına alır ("Elena e" / "Martina" → "Elena" / "e" / "Martina")
 * ve iki ismi eşit boyuta (büyük olanın sınıfı) getirir. Yalnızca isim kalıbında: bağlacın yanındaki parça ve
 * komşu satır en fazla üç kelime, ikisi de cümle rolünde (mesaj, selam, tarih…) değil.
 */
export function separateDangling(lines: IntentLine[], profile: Profile): { lines: IntentLine[]; notes: string[] } {
  const words = profile.connectors.words.filter(hasLetterOrDigit).map(esc);
  const syms = profile.connectors.words.filter((w) => w.trim() && !hasLetterOrDigit(w)).map(esc);
  if (!words.length && !syms.length) return { lines, notes: [] };
  const endAlt = [words.length && `\\s+(?:${words.join("|")})`, syms.length && `\\s*(?:${syms.join("|")})`].filter(Boolean).join("|");
  const startAlt = [words.length && `(?:${words.join("|")})\\s+`, syms.length && `(?:${syms.join("|")})\\s*`].filter(Boolean).join("|");
  const endRe = new RegExp(`^(.*?\\S)(${endAlt})$`, "iu");
  const startRe = new RegExp(`^(${startAlt})(\\S.*)$`, "iu");
  const nameLike = (l: IntentLine | undefined) => !!l && !SENTENCE_ROLES.has(l.role) && wordCount(l.text) <= 3 && !isConnectorText(l.text, profile);
  const pair = (a: IntentLine, b: IntentLine): Pick<IntentLine, "tier" | "size"> => {
    const tier = TIER_RANK[a.tier] <= TIER_RANK[b.tier] ? a.tier : b.tier;
    const sizes = [a.size, b.size].filter((s): s is number => s !== undefined);
    return { tier: tier === "connector" ? "primary" : tier, ...(sizes.length ? { size: Math.max(...sizes) } : {}) };
  };
  const out: IntentLine[] = [];
  const notes: string[] = [];
  const pending = new Map<number, Pick<IntentLine, "tier" | "size">>();
  let changed = false;
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const cur = { ...line, ...pending.get(i) };
    if (SENTENCE_ROLES.has(line.role) || isConnectorText(line.text, profile)) {
      out.push(cur);
      return;
    }
    const end = next ? endRe.exec(line.text) : null;
    if (end && wordCount(end[1]!) <= 3 && nameLike(next)) {
      const style = pair(cur, next!);
      const conn = end[2]!.trim();
      out.push({ ...cur, ...style, text: end[1]!.trim() }, { text: conn, role: "connector", tier: "connector", fontId: line.fontId });
      pending.set(i + 1, style);
      notes.push(`Asılı bağlaç "${conn}" kendi satırına alındı; iki isim aynı boyuta getirildi.`);
      changed = true;
      return;
    }
    const start = prev && !pending.has(i) ? startRe.exec(line.text) : null;
    if (start && wordCount(start[2]!) <= 3 && nameLike(prev)) {
      const style = pair(cur, prev!);
      const conn = start[1]!.trim();
      out[out.length - 1] = { ...out[out.length - 1]!, ...style };
      out.push({ text: conn, role: "connector", tier: "connector", fontId: line.fontId }, { ...cur, ...style, text: start[2]!.trim() });
      notes.push(`Asılı bağlaç "${conn}" kendi satırına alındı; iki isim aynı boyuta getirildi.`);
      changed = true;
      return;
    }
    out.push(cur);
  });
  return changed ? { lines: out, notes } : { lines, notes: [] };
}

// ───────────────────────── 2. run çözümü ─────────────────────────

export interface ResolvedRun {
  text: string;
  fontId: string;
  /** Satır puntosuna oran (glif kuralı `scale`). */
  scale: number;
  /** Taban çizgisi kayması (em, run puntosu; pozitif = yukarı). */
  shiftEm: number;
  fallback: boolean;
}

export interface ResolvedLine {
  text: string;
  role: LineRole;
  tier: Tier;
  fontId: string;
  /** Ana punto (k) çarpanı. */
  ratio: number;
  kind: FontKind;
  allCaps: boolean;
  /** Tek başına bağlaç satırı. */
  connector: boolean;
  runs: ResolvedRun[];
}

export interface Resolution {
  lines: ResolvedLine[];
  /** Yedek fontla basılan grafemler. */
  fallbackChars: string[];
  /** Hiçbir fontun basamadığı grafemler (tasarım fontuyla bırakılır, ASLA silinmez). */
  unprintable: string[];
  /** Fontta tek parça olmayan, bileşenleri yan yana basılacak kümeler (ör. yeni ZWJ emojisi). */
  partialChars: string[];
  /** Renkli fontta olmayan, tek renk basılacak emoji kümeleri. */
  monochromeChars: string[];
}

function isUpper(g: string): boolean {
  return g !== g.toLowerCase() && g === g.toUpperCase();
}

function ruleMatches(rule: GlyphRule, g: string, ctx: { wordStart: boolean; lineStart: boolean }): boolean {
  const m = rule.match;
  switch (m.type) {
    case "chars":
      return graphemes(m.chars).includes(g);
    case "digits":
      return /^\p{Nd}$/u.test(g);
    case "word-initial-upper":
      return ctx.wordStart && isUpper(g) && (!m.letters || graphemes(m.letters).includes(g));
    case "line-initial-upper":
      return ctx.lineStart && isUpper(g) && (!m.letters || graphemes(m.letters).includes(g));
  }
}

/** Satır sınıfının ana puntoya oranı (kilitliyse profil, değilse niyet; bağlaçta `connectorScales`). */
export function lineRatio(line: IntentLine, connector: boolean, profile: Profile): number {
  const t = profile.sizing.tiers;
  const p = t.primary || 1;
  const tierValue = connector ? (profile.sizing.connectorScales[line.text.trim().toLowerCase()] ?? t.connector) : t[line.tier];
  const ratio = profile.sizing.tiersLocked ? tierValue / p : (line.size ?? tierValue / p);
  return Math.max(0.05, ratio);
}

/** `resolveLines` seçenekleri. */
export interface ResolveOptions {
  /**
   * Elle parça fontu (hafif düzeltme): satır `line`'ın `g`. grafeminin tasarım fontu; undefined = satırın fontu.
   * Glif kuralları, kapsama ve yedek font bu fonta göre çalışır.
   */
  fontAt?: (line: number, g: number) => string | undefined;
}

/** Glif kuralları, yedek font ve satır oranları. */
export function resolveLines(lines: readonly IntentLine[], profile: Profile, fonts: FontRegistry, opts: ResolveOptions = {}): Resolution {
  const rules = profile.glyphRules.filter((r) => r.enabled && fonts.has(r.fontId));
  const kindOf = (id: string): FontKind => profile.fonts.list.find((f) => f.id === id)?.kind ?? fonts.get(id).kind ?? "sans";
  const fallbackChars = new Set<string>();
  const unprintable = new Set<string>();
  const partialChars = new Set<string>();
  const monochromeChars = new Set<string>();
  const multi = lines.length > 1;
  const out = lines.map((line, li): ResolvedLine => {
    const base = line.fontId;
    const baseAt = (i: number) => opts.fontAt?.(li, i) ?? base;
    const gs = graphemes(line.text);
    const space = (g: string) => /^\s+$/u.test(g);
    // Önce boşluk olmayan grafemlere font seçilir.
    const picks: Array<Omit<ResolvedRun, "text"> | null> = gs.map(() => null);
    let prev = "";
    let lineStart = true;
    gs.forEach((g, i) => {
      if (space(g)) {
        prev = g;
        return;
      }
      const wordStart = !/[\p{L}\p{M}\p{N}'’]/u.test(prev);
      const own = baseAt(i);
      const rule = rules.find((r) => (r.onlyWithFonts.length === 0 || r.onlyWithFonts.includes(own)) && ruleMatches(r, g, { wordStart, lineStart }) && fonts.covers(r.fontId, g));
      if (rule) picks[i] = { fontId: rule.fontId, scale: rule.scale, shiftEm: rule.baselineShiftEm, fallback: false };
      else {
        // Küme düzeyinde font: tasarım fontu, emoji sunumunda renkli emoji fontu, yoksa yedek zinciri (typeset `resolve`).
        const res = fonts.resolve(g, own);
        if (res) {
          picks[i] = { fontId: res.fontId, scale: 1, shiftEm: 0, fallback: res.fallback };
          if (res.fallback) fallbackChars.add(g);
          if (res.partial) partialChars.add(g);
          if (res.monochrome) monochromeChars.add(g);
        } else {
          picks[i] = { fontId: own, scale: 1, shiftEm: 0, fallback: false };
          unprintable.add(g);
        }
      }
      lineStart = false;
      prev = g;
    });
    // Boşluklar: iki yanı aynı yedek fontsa (Arapça cümle tek run şekillensin) o font, değilse tasarım fontu.
    gs.forEach((g, i) => {
      if (!space(g)) return;
      let a: Omit<ResolvedRun, "text"> | null = null;
      let b: Omit<ResolvedRun, "text"> | null = null;
      for (let j = i - 1; j >= 0 && !a; j--) a = picks[j] ?? null;
      for (let j = i + 1; j < gs.length && !b; j++) b = picks[j] ?? null;
      const same = a && b && a.fallback && a.fontId === b.fontId && fonts.covers(a.fontId, g);
      picks[i] = same ? { ...a! } : { fontId: baseAt(i), scale: 1, shiftEm: 0, fallback: false };
    });
    const runs: ResolvedRun[] = [];
    gs.forEach((g, i) => {
      const p = picks[i]!;
      const last = runs[runs.length - 1];
      if (last && last.fontId === p.fontId && last.scale === p.scale && last.shiftEm === p.shiftEm && last.fallback === p.fallback) last.text += g;
      else runs.push({ text: g, ...p });
    });
    const connector = line.tier === "connector" || (multi && isConnectorText(line.text, profile));
    // Tek başına bağlaç: görünen en büyük run sınıf oranında olur ("&" kuralının küçültmesi iki kez uygulanmaz).
    if (connector) {
      const peak = Math.max(...runs.map((r) => r.scale));
      if (peak > 0) for (const r of runs) r.scale /= peak;
    }
    return {
      text: line.text,
      role: line.role,
      tier: connector ? "connector" : line.tier,
      fontId: base,
      ratio: lineRatio(line, connector, profile),
      kind: kindOf(base),
      allCaps: isAllCaps(line.text),
      connector,
      runs,
    };
  });
  return { lines: out, fallbackChars: [...fallbackChars], unprintable: [...unprintable], partialChars: [...partialChars], monochromeChars: [...monochromeChars] };
}

// ───────────────────────── 3. blok kurma ─────────────────────────

export interface BuiltRun {
  src: ResolvedRun;
  shaped: ShapedRun;
  /** Satır başına göre run başlangıcı (px). */
  x: number;
  /** Taban çizgisi kayması (px, aşağı pozitif). */
  dy: number;
}

export interface BuiltLine {
  src: ResolvedLine;
  sizePx: number;
  runs: BuiltRun[];
  advance: number;
  /** Mürekkep kutusu (kontur dahil), satır başı x = 0, taban çizgisi y = 0. */
  ink: Box;
  /** Glif kutuları (kontur dahil), satır koordinatında. Sığdırma bunları kullanır. */
  boxes: Box[];
}

export interface Block {
  lines: BuiltLine[];
  /** İlk satırın taban çizgisine göre taban çizgileri. */
  baselines: number[];
  /** Satır başlarının blok referans x'ine göre konumu. */
  xs: number[];
  /** Bloğun mürekkep kutusu (blok koordinatı). */
  ink: Box;
  /** Satır arası boşluk türleri (i: i-1 ile i arası). */
  gapKinds: GapKind[];
}

export type GapKind = "normal" | "beforeLast" | "connector";

/**
 * Sığdırma modeli: "glyph" = her glifin mürekkep kutusu (sıkı), "line" = satırın tek mürekkep kutusu
 * (eski sistemin modeli; profil değerleri onunla ölçülmüştü). Tekrar düzeneği ikisini karşılaştırabilir.
 */
export type FitModel = "glyph" | "line";

export function buildLine(fonts: FontRegistry, line: ResolvedLine, k: number, outset: number, fit: FitModel = "glyph"): BuiltLine {
  const sizePx = k * line.ratio;
  let pen = 0;
  const runs: BuiltRun[] = [];
  const boxes: Box[] = [];
  line.runs.forEach((r, i) => {
    const size = sizePx * r.scale;
    const shaped = shapeRun(fonts, r.text, { fontId: r.fontId, sizePx: size });
    const dy = -r.shiftEm * size;
    for (const g of shaped.glyphs) if (g.ink) boxes.push(inflateBox({ x0: g.ink.x0 + pen, x1: g.ink.x1 + pen, y0: g.ink.y0 + dy, y1: g.ink.y1 + dy }, outset));
    runs.push({ src: r, shaped, x: pen, dy });
    pen += shaped.advance + (i < line.runs.length - 1 ? shaped.trackingPx : 0);
  });
  const ink = boxes.length ? boxes.reduce(unionBox) : { x0: 0, x1: pen, y0: -0.7 * sizePx, y1: 0 };
  return { src: line, sizePx, runs, advance: pen, ink, boxes: fit === "line" ? [ink] : boxes };
}

export function gapKind(lines: readonly ResolvedLine[], i: number, profile: Profile, sizes: readonly number[]): GapKind {
  if (lines[i - 1]!.connector || lines[i]!.connector) return "connector";
  if (i === lines.length - 1 && sizes[i]! < profile.spacing.beforeLastRatio * sizes[i - 1]!) return "beforeLast";
  return "normal";
}

/**
 * Satırları k ana puntosunda kurar. Satır aralığı GÖRÜNEN boşluktur: üst satırın mürekkep altı → alt satırın
 * mürekkep üstü = `inkGaps[tür] × min(iki satırın puntosu)`. Satırlar mürekkep kutusuna göre hizalanır; iki el
 * yazısı ismin arasındaki tek başına bağlaç `shiftEm × isim puntosu` sağa kayar.
 */
export function buildBlock(fonts: FontRegistry, lines: readonly ResolvedLine[], k: number, outset: number, profile: Profile, fit: FitModel = "glyph"): Block {
  const built = lines.map((l) => buildLine(fonts, l, k, outset, fit));
  const sizes = built.map((b) => b.sizePx);
  const baselines = [0];
  const gapKinds: GapKind[] = ["normal"];
  for (let i = 1; i < built.length; i++) {
    const a = built[i - 1]!, b = built[i]!;
    const kind = gapKind(lines, i, profile, sizes);
    gapKinds.push(kind);
    const gap = profile.spacing.inkGaps[kind] * Math.min(a.sizePx, b.sizePx);
    // Taban çizgileri çökmesin: en az büyük satırın puntosunun %20'si.
    const pitch = Math.max(a.ink.y1 - b.ink.y0 + gap, 0.2 * Math.max(a.sizePx, b.sizePx));
    baselines.push(baselines[i - 1]! + pitch);
  }
  const align = profile.spacing.align;
  const xs = built.map((b) => (align === "left" ? -b.ink.x0 : align === "right" ? -b.ink.x1 : -(b.ink.x0 + b.ink.x1) / 2));
  const shiftEm = profile.connectors.shiftEm;
  if (shiftEm) {
    const cx = (i: number) => xs[i]! + (built[i]!.ink.x0 + built[i]!.ink.x1) / 2;
    const scriptName = (l: ResolvedLine) => !l.connector && l.kind === "script" && !l.allCaps;
    for (let i = 1; i < built.length - 1; i++) {
      if (!lines[i]!.connector || !scriptName(lines[i - 1]!) || !scriptName(lines[i + 1]!)) continue;
      const names = (cx(i - 1) + cx(i + 1)) / 2;
      const target = names + shiftEm * Math.max(sizes[i - 1]!, sizes[i + 1]!);
      xs[i] = target - (built[i]!.ink.x0 + built[i]!.ink.x1) / 2;
    }
  }
  let ink: Box | null = null;
  built.forEach((b, i) => {
    const box = { x0: b.ink.x0 + xs[i]!, x1: b.ink.x1 + xs[i]!, y0: b.ink.y0 + baselines[i]!, y1: b.ink.y1 + baselines[i]! };
    ink = ink ? unionBox(ink, box) : box;
  });
  return { lines: built, baselines, xs, ink: ink!, gapKinds };
}

/** Uyarı üretmek için kısa yardımcı. `message`: `issueMsg(...)` (sözlük anahtarı + parametreler) ya da düz metin. */
export function issue(code: Issue["code"], severity: Issue["severity"], message: string | IssueText, field?: string, fixes: Issue["fixes"] = []): Issue {
  const text = typeof message === "string" ? { message } : { message: message.message, messageKey: message.messageKey, ...(message.params ? { params: message.params } : {}) };
  return { code, severity, ...text, ...(field !== undefined ? { field } : {}), fixes };
}
