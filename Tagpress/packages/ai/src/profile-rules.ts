import { type Enforcement, type FontRole, PROFILE_DOCS, type Profile, type Tier } from "@tagpress/domain";

/**
 * Profilden AI talimatı üretimi. Tarz koda GÖMÜLMEZ: değerler profilden gelir, kimin uyguladığı
 * (`enforcement`: motor / ai / ikisi) `PROFILE_DOCS`'tan okunur. Kod yalnızca her alanın ANLAMINI bilir
 * (ürün şeması), hiçbir font adı, bağlaç ya da eşik bilmez.
 *
 * Her kuralın başında PROFILE_DOCS etiketi köşeli parantezle durur: denetimde ve kullanıcı açıklamasında
 * hangi ayarın hangi cümleyi ürettiği görünür.
 */

export interface RenderedRule {
  key: string;
  label: string;
  enforcement: Enforcement;
  text: string;
}

/** Satır sınıfı → kullanılabilecek font rolleri. Tasarım doğrulaması ve istem aynı tabloyu kullanır. */
export const ROLES_FOR_TIER: Record<Tier, readonly FontRole[]> = {
  primary: ["primary", "accent"],
  secondary: ["secondary", "accent"],
  tertiary: ["secondary"],
  connector: ["primary", "secondary", "accent"],
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (v: number) => String(Math.round(v * 100) / 100);
const quoteList = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

/** Harf olmayan bağlaçlar (&, +): çevrelerindeki boşluk değişebilir (izin varsa). */
export function symbolConnectors(p: Profile): string[] {
  return p.connectors.words.filter((w) => w.trim() && !/[\p{L}\p{N}]/u.test(w));
}

/** Metin koruma denetiminde boşluğu esnek sayılacak semboller. */
export function preservationSymbols(p: Profile): string[] {
  return p.connectors.allowSymbolSpacing ? symbolConnectors(p) : [];
}

function fontName(p: Profile, id: string): string {
  const f = p.fonts.list.find((x) => x.id === id);
  return f ? `${f.family}${f.style && f.style !== "Regular" ? ` ${f.style}` : ""}` : id;
}

/** Kural metni; kilit açıksa karar AI'a geçtiği için `enforcement` değiştirilebilir. */
type Renderer = (p: Profile) => string | { text: string; enforcement: Enforcement } | null;

/**
 * Alan anahtarı → İngilizce kural cümlesi. Anahtarlar PROFILE_DOCS'ta olmalı (test denetler).
 * Sıra = istemdeki sıra.
 */
const RENDERERS: Array<[string, Renderer]> = [
  // ── Satır bölme ──────────────────────────────────────────────────────────────────────────────
  ["lineBreaking.maxLineChars", (p) => `No line may be longer than ${p.lineBreaking.maxLineChars} characters.`],
  ["lineBreaking.typicalLines", (p) => `Most labels in this style use ${p.lineBreaking.typicalLines[0]}–${p.lineBreaking.typicalLines[1]} lines; land in that range unless the text is very short or very long.`],
  ["lineBreaking.maxLines", (p) => `Never more than ${p.lineBreaking.maxLines} lines.`],
  [
    "lineBreaking.nameOwnLine",
    (p) => (p.lineBreaking.nameOwnLine
        ? "A person's name stands on its own line (role \"name\") and is the largest line (tier \"primary\")."
        : "A name may share its line with other words."),
  ],
  [
    "lineBreaking.coupleStack",
    (p) =>
      ({
        always: "Two names joined by a connector are ALWAYS stacked: name / connector / name, the connector alone on the middle line.",
        option:
          "Two names joined by a connector may stay on one line or be stacked name / connector / name (connector alone on the middle line). The first candidate follows this designer's habit for this kind of text (notes and similar past texts); when the label is mainly a couple, at least one candidate stacks them.",
        never: "Two names joined by a connector stay on ONE line; never put the connector alone on its own line.",
      })[p.lineBreaking.coupleStack],
  ],
  ["lineBreaking.keepShortGreetings", (p) => (p.lineBreaking.keepShortGreetings ? "A short greeting or thank-you phrase (up to three words) is never split across lines." : null)],
  ["lineBreaking.dateOwnLine", (p) => (p.lineBreaking.dateOwnLine ? "A date stands on its own line (role \"date\")." : "A date may share a line with a place or a short phrase.")],
  [
    "lineBreaking.customerBreaks",
    (p) =>
      ({
        hint: "The customer's segments (typed on separate lines or separated by double spaces) are strong hints for line breaks; keep each segment together unless it is too long, and do not merge segments just because they are short.",
        strict: "Every boundary between the customer's segments MUST be a line break. You may split a segment further only when it is too long for one line.",
        ignore: "Ignore how the customer split the text; break by meaning and shape only.",
      })[p.lineBreaking.customerBreaks],
  ],
  [
    "lineBreaking.noLoneWords",
    (p) =>
      p.lineBreaking.noLoneWords.length
        ? `These words never stand alone on a line; they stay on a line with the phrase they belong to: ${quoteList(p.lineBreaking.noLoneWords)}.${p.lineBreaking.nameOwnLine ? " When one of them comes right before a name, it ends the previous line and the name stays alone on its own line." : ""}`
        : null,
  ],
  ["lineBreaking.notes", (p) => (p.lineBreaking.notes.trim() ? `Designer's own notes on line breaking: ${p.lineBreaking.notes.trim()}` : null)],
  // ── Bağlaçlar ────────────────────────────────────────────────────────────────────────────────
  [
    "connectors.words",
    (p) =>
      p.connectors.words.length
        ? `Connectors in this style: ${quoteList(p.connectors.words)}. A line that is only a connector gets role "connector" and tier "connector".`
        : null,
  ],
  [
    "connectors.allowSymbolSpacing",
    (p) => {
      const sym = symbolConnectors(p);
      if (!sym.length) return null;
      return p.connectors.allowSymbolSpacing
        ? `You may add or remove ONE space directly around the symbol connectors ${quoteList(sym)} (e.g. when splitting around them). Nowhere else may spacing change.`
        : `Keep the spacing around ${quoteList(sym)} exactly as typed.`;
    },
  ],
  ["connectors.separateDangling", (p) => (p.connectors.separateDangling ? "A connector left dangling at the start or end of a name line is moved onto its own line — never leave one dangling." : null)],
  // ── Fontlar ──────────────────────────────────────────────────────────────────────────────────
  [
    "fonts.mixing",
    (p) =>
      ({
        single: "Use ONE font family for every line of a label (character rules applied by the engine do not count).",
        two: "Use at most TWO font families on one label.",
        free: "Font families may be combined freely.",
      })[p.fonts.mixing],
  ],
  // ── Boyut ────────────────────────────────────────────────────────────────────────────────────
  [
    "sizing.tiersLocked",
    (p) => {
      const t = p.sizing.tiers;
      const extra = Object.entries(p.sizing.connectorScales);
      const ratios = `primary ${num(t.primary)}, secondary ${num(t.secondary)}, tertiary ${num(t.tertiary)}, connector ${num(t.connector)}${extra.length ? ` (connector "${extra.map(([w, v]) => `${w}" ${num(v)}`).join(', "')})` : ""}`;
      return p.sizing.tiersLocked
        ? `Line sizes come only from the tier you choose; the engine applies these ratios to the largest line: ${ratios}. Do not output sizes.`
        : { text: `Default tier ratios: ${ratios}. You may give each line a "size" (ratio to the largest line, 0.3–1.0) when a different ratio clearly serves the design.`, enforcement: "ai" };
    },
  ],
  [
    "sizing.fillLocked",
    (p) =>
      p.sizing.fillLocked
        ? `The text always fills ${pct(p.sizing.fill)} of the largest size that fits; the engine applies this. Do not output "fill".`
        : { text: `Default fill is ${pct(p.sizing.fill)} of the largest size that fits; you may propose "fill" (0.3–1.0) per candidate.`, enforcement: "ai" },
  ],
  ["sizing.maxCapHeight", () => "Very short texts are capped in height by the engine; never add line breaks just to make a short text smaller."],
  ["sizing.initials.oneLine", (p) => (p.sizing.initials.oneLine ? 'Initials joined by a connector (like "A & M") always stay side by side on ONE line — never stacked.' : null)],
  // ── Özel karakterler ─────────────────────────────────────────────────────────────────────────
  [
    "glyphRules",
    (p) => {
      const rules = p.glyphRules.filter((r) => r.enabled);
      if (!rules.length) return null;
      const items = rules.map((r) => {
        const m = r.match;
        const what =
          m.type === "chars"
            ? `the character${[...m.chars].length > 1 ? "s" : ""} ${quoteList([...m.chars])}`
            : m.type === "word-initial-upper"
              ? `a capital letter at the start of a word${m.letters ? ` (${quoteList([...m.letters])})` : ""}`
              : m.type === "line-initial-upper"
                ? `a capital letter at the start of a line${m.letters ? ` (${quoteList([...m.letters])})` : ""}`
                : "digits";
        return `${what} → ${fontName(p, r.fontId)}${r.scale !== 1 ? ` at ${num(r.scale)}×` : ""}`;
      });
      return `Character rules applied automatically on every line: ${items.join("; ")}. Never choose a font for these characters and never split lines to imitate them.`;
    },
  ],
  // ── Görünüm (motor) ──────────────────────────────────────────────────────────────────────────
  ["spacing.align", (p) => `Alignment (${p.spacing.align}) and the visible spacing between lines are set by the engine.`],
  ["weight.mode", () => "Letter weight is applied by the engine as one setting for the whole label; never ask for bold."],
  ["color.text", () => "Text colour is chosen by the engine."],
];

/** Profilden bütün kurallar (boş olanlar atlanır). */
export function renderProfileRules(p: Profile, only?: (key: string) => boolean): RenderedRule[] {
  const out: RenderedRule[] = [];
  for (const [key, render] of RENDERERS) {
    if (only && !only(key)) continue;
    const doc = PROFILE_DOCS[key];
    if (!doc) continue; // belgelenmemiş alan istemde yer almaz
    const r = render(p);
    if (!r) continue;
    if (typeof r === "string") out.push({ key, label: doc.label, enforcement: doc.enforcement, text: r });
    else out.push({ key, label: doc.label, ...r });
  }
  return out;
}

/** Test ve denetim için: istem üreten alan anahtarları. */
export const RULE_KEYS: readonly string[] = RENDERERS.map(([k]) => k);

const ruleLine = (r: RenderedRule) => `- [${r.label}] ${r.text}`;

/**
 * Kuralları "uy" (ai/ikisi) ve "motor uygular" diye iki bölüme ayırarak yazar.
 * `ikisi` kurallar ayrıca doğrulanır: uymayan aday reddedilir.
 */
export function profileRulesSection(p: Profile, only?: (key: string) => boolean): string {
  const rules = renderProfileRules(p, only);
  const follow = rules.filter((r) => r.enforcement === "ai" || r.enforcement === "ikisi");
  const engine = rules.filter((r) => r.enforcement === "motor");
  const parts: string[] = [];
  if (follow.length) {
    parts.push(
      "## Rules of this design language (follow them; rules marked * are also checked and a violating candidate is rejected)",
      ...follow.map((r) => ruleLine(r) + (r.enforcement === "ikisi" ? " *" : "")),
    );
  }
  if (engine.length) {
    parts.push("", "## Applied by the layout engine — you do not choose these", ...engine.map(ruleLine));
  }
  return parts.join("\n");
}

/** Yalnızca satır bölmeyi ilgilendiren kurallar (aday seçimi, görsel denetim, görüntü modeli). */
export const isBreakRule = (key: string) =>
  key.startsWith("lineBreaking.") || key === "connectors.words" || key === "connectors.separateDangling" || key === "sizing.initials.oneLine";

/** Örnek bölmeler: kuraldan güçlüdür. */
export function examplesSection(p: Profile, max = 12): string {
  const ex = p.lineBreaking.examples.slice(0, max);
  if (!ex.length) return "";
  const label = PROFILE_DOCS["lineBreaking.examples"]?.label ?? "Examples";
  return [
    `## [${label}] How this designer breaks real texts (these examples outrank the rules above; never copy their words)`,
    ...ex.map((e) => `- ${JSON.stringify(e.text)} → ${e.lines.map((l) => JSON.stringify(l)).join(" / ")}`),
  ].join("\n");
}

export function styleNoteSection(p: Profile): string {
  const note = p.ai.instructions.trim();
  if (!note) return "";
  const label = PROFILE_DOCS["ai.instructions"]?.label ?? "Style note";
  return `## [${label}] The designer's style\n${note}`;
}

/** Görüntü modeline gidecek kısa ipuçları (satır bölme + tarz). */
export function imageProfileHints(p: Profile): string[] {
  return renderProfileRules(p, isBreakRule).map((r) => r.text);
}
