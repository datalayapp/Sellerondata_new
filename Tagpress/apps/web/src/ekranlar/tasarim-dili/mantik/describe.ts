import type { GlyphRule, Profile, ProfileGroup } from "@tagpress/domain";
import { currentLocale } from "../../../i18n/index.ts";
import { joinList, num, pct, pctOwn, tt } from "../dil.ts";

/** Profili insan diliyle anlatan cümleler. Değerlerden üretilir; kodda hiçbir tarz bilgisi yok. Metinler `designLanguage:describe.*`. */

export interface DescGroup {
  group: ProfileGroup;
  title: string;
  sentences: string[];
}

export function fontName(p: Profile, fontId: string): string {
  const f = p.fonts.list.find((x) => x.id === fontId);
  if (!f) return fontId;
  return f.style && f.style !== "Regular" ? `${f.family} ${f.style}` : f.family;
}

function scaleWords(scale: number): string {
  if (scale === 1) return "";
  if (scale === 0.5) return tt("designLanguage:describe.glyph.half");
  return tt("designLanguage:describe.glyph.scale", { pct: pct(scale) });
}

export function glyphMatchText(rule: GlyphRule): string {
  const m = rule.match;
  switch (m.type) {
    case "chars":
      return Array.from(m.chars)
        .map((c) => `“${c}”`)
        .join(" ");
    case "word-initial-upper":
      return m.letters ? tt("designLanguage:describe.glyph.wordInitialLetters", { letters: Array.from(m.letters).join(", ") }) : tt("designLanguage:describe.glyph.wordInitial");
    case "line-initial-upper":
      return m.letters ? tt("designLanguage:describe.glyph.lineInitialLetters", { letters: Array.from(m.letters).join(", ") }) : tt("designLanguage:describe.glyph.lineInitial");
    case "digits":
      return tt("designLanguage:describe.glyph.digits");
  }
}

export function describeGlyphRule(p: Profile, r: GlyphRule): string {
  const parts = [tt("designLanguage:describe.glyph.base", { match: glyphMatchText(r), font: fontName(p, r.fontId) })];
  const s = scaleWords(r.scale);
  if (s) parts.push(s);
  if (r.baselineShiftEm !== 0) parts.push(tt(r.baselineShiftEm > 0 ? "designLanguage:describe.glyph.shiftUp" : "designLanguage:describe.glyph.shiftDown", { n: num(Math.abs(r.baselineShiftEm)) }));
  let text = parts.join(", ");
  if (r.onlyWithFonts.length) text += ` ${tt("designLanguage:describe.glyph.only", { list: joinList(r.onlyWithFonts.map((id) => fontName(p, id))) })}`;
  return `${text}.`;
}

const cap = (s: string) => s.charAt(0).toLocaleUpperCase(currentLocale()) + s.slice(1);
const d = (key: string, o?: Record<string, unknown>) => tt(`designLanguage:describe.${key}`, o);

export function describeProfile(p: Profile): DescGroup[] {
  const out: DescGroup[] = [];
  const add = (group: ProfileGroup, sentences: Array<string | false | null | undefined>) => {
    const list = sentences.filter((s): s is string => !!s);
    out.push({ group, title: d(`titles.${group}`), sentences: list });
  };

  // Genel
  add("genel", [d("general.name", { name: p.name }), p.description ? cap(p.description) : false, p.ai.instructions ? d("general.styleNote", { note: p.ai.instructions.trim() }) : false]);

  // Fontlar
  const enabled = p.fonts.list.filter((f) => f.enabled);
  add("fontlar", [
    enabled.length === 0 ? d("fonts.none") : d("fonts.available", { n: enabled.length, list: joinList(enabled.map((f) => fontName(p, f.id))) }),
    enabled.length > 0 && d(`fonts.mixing.${p.fonts.mixing}`),
    ...enabled.filter((f) => f.maxUppercaseRun !== null).map((f) => d("fonts.upperRun", { font: fontName(p, f.id), n: f.maxUppercaseRun })),
    ...enabled.filter((f) => f.lockTracking).map((f) => d("fonts.lockTracking", { font: fontName(p, f.id) })),
  ]);

  // Özel karakterler
  const rules = p.glyphRules.filter((r) => r.enabled);
  add("ozel-karakterler", rules.length ? rules.map((r) => describeGlyphRule(p, r)) : [d("glyphs.none")]);

  // Boyut
  const t = p.sizing.tiers;
  add("boyut", [
    d(p.sizing.fillLocked ? "size.fillLocked" : "size.fillFree", { fill: pctOwn(p.sizing.fill) }),
    d("size.tiers", { secondary: pctOwn(t.secondary / t.primary), tertiary: pctOwn(t.tertiary / t.primary), connector: pctOwn(t.connector / t.primary) }),
    d(p.sizing.tiersLocked ? "size.tiersLocked" : "size.tiersFree"),
    d("size.limits", { cap: pctOwn(p.sizing.maxCapHeight), min: num(p.sizing.minPt), max: num(p.sizing.maxPt) }),
    p.sizing.initials.oneLine && d("size.initialsOneLine"),
  ]);

  // Boşluk
  const g = p.spacing.inkGaps;
  add("bosluk", [d("spacing.gaps", { normal: pctOwn(g.normal), beforeLast: pct(g.beforeLast), connector: pctOwn(g.connector) }), d("spacing.align", { how: d(`spacing.alignHow.${p.spacing.align}`) })]);

  // Bağlaçlar
  add("baglaclar", [
    p.connectors.words.length ? d("connectors.words", { list: p.connectors.words.map((w) => `“${w}”`).join(", ") }) : d("connectors.none"),
    p.connectors.separateDangling && d("connectors.dangling"),
    p.connectors.allowSymbolSpacing && d("connectors.symbolSpacing"),
    p.connectors.shiftEm !== 0 && d(p.connectors.shiftEm > 0 ? "connectors.shiftRight" : "connectors.shiftLeft", { n: num(Math.abs(p.connectors.shiftEm)) }),
    ...Object.entries(p.sizing.connectorScales).map(([w, s]) => d("connectors.scale", { word: w, pct: pctOwn(s) })),
  ]);

  // Satır bölme
  const lb = p.lineBreaking;
  add("satir-bolme", [
    lb.nameOwnLine && d("lineBreaking.nameOwnLine"),
    d(`lineBreaking.couple.${lb.coupleStack}`),
    lb.dateOwnLine && d("lineBreaking.dateOwnLine"),
    lb.keepShortGreetings && d("lineBreaking.keepGreetings"),
    d("lineBreaking.limits", { chars: lb.maxLineChars, lines: lb.maxLines, min: lb.typicalLines[0], max: lb.typicalLines[1] }),
    d(`lineBreaking.customer.${lb.customerBreaks}`),
    lb.noLoneWords.length > 0 && d("lineBreaking.noLone", { list: lb.noLoneWords.join(", ") }),
    lb.examples.length > 0 && d("lineBreaking.examples", { n: lb.examples.length }),
    lb.notes.trim() && d("lineBreaking.notes", { note: lb.notes.trim() }),
  ]);

  // Kalınlık ve renk
  const w = p.weight;
  add("kalinlik-renk", [
    w.mode === "stroke" && d("weight.stroke", { n: num(w.widthEm, 3) }),
    w.mode === "real" && d("weight.real"),
    w.mode === "none" && d("weight.none"),
    p.color.autoContrast ? d("weight.colorAuto", { color: p.color.text, dark: p.color.onDark }) : d("weight.color", { color: p.color.text }),
  ]);

  // Çıktı
  add("cikti", [d("output.line", { cut: d(`output.cut.${p.output.cut.kind}`), sizes: p.output.sizes.map((s) => `${num(s.cm)} cm`).join(", "), def: p.output.defaultSize })]);

  // Sticker
  add("sticker", [
    p.stickers.enabled ? d("sticker.on", { detect: d(`sticker.detect.${p.stickers.detect}`), n: p.stickers.sheets.length }) : d("sticker.off"),
  ]);

  // Kalite
  add("kalite", [d("quality.line", { score: num(p.quality.suspectScore), pt: num(p.quality.readableMinPt) })]);

  return out;
}
