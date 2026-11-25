import { similarExamplesSection } from "./similar.ts";
import { type DesignIntent, LineRoleSchema, type Profile, TierSchema } from "@tagpress/domain";
import { z } from "zod";
import { toApiJsonSchema } from "../json.ts";
import { examplesSection, preservationSymbols, profileRulesSection, ROLES_FOR_TIER, styleNoteSection } from "../profile-rules.ts";
import type { DesignContext } from "./context.ts";
import type { FontAvailability } from "./fonts.ts";

/** İstem değiştiğinde artırılır; her çağrı kaydına yazılır. */
export const DESIGN_PROMPT_VERSION = "studio-design-v9";

/**
 * Tel şeması (AI'ın yanıt biçimi). Profilden üretilir: oranlar kilitliyse `size`, doluluk kilitliyse `fill`
 * alanı ŞEMADA YOKTUR. Anlam alanları (metin, rol, font) katı; üslup alanları (tier, size, fill) hoşgörülü:
 * geçersiz değer varsayılana düşer, adayı çöpe atmaz.
 */
export function designWire(profile: Profile, fontIds: readonly string[]) {
  const makeLine = (fontId: z.ZodType<string>) =>
    z.object({
      text: z.string(),
      role: LineRoleSchema,
      tier: TierSchema.nullable().catch(null),
      fontId,
      ...(profile.sizing.tiersLocked ? {} : { size: z.number().nullable().catch(null) }),
    });
  const makeCandidate = (fontId: z.ZodType<string>) =>
    z.object({
      rationale: z.string().catch(""),
      lines: z.array(makeLine(fontId)),
      ...(profile.sizing.fillLocked ? {} : { fill: z.number().nullable().catch(null) }),
    });
  // API şemasında font kullanılabilir fontlarla sınırlı (enum); ayrıştırmada düz metin: katalog dışı font
  // doğrulamada anlaşılır bir "font-unavailable" sorunu olarak raporlanır.
  const line = makeLine(z.string());
  const candidate = makeCandidate(z.string());
  const strict = z.object({ candidates: z.array(makeCandidate(fontIds.length ? z.enum(fontIds as [string, ...string[]]) : z.string())) });
  /** Yanıt düzeyinde adaylar ayrı ayrı doğrulanır: tek bozuk aday ötekileri düşürmesin. */
  const response = z.object({ candidates: z.array(z.unknown()) });
  return { line, candidate, response, jsonSchema: toApiJsonSchema(strict) };
}

export type DesignWire = ReturnType<typeof designWire>;
export type WireCandidate = z.output<DesignWire["candidate"]>;

/** Rolden varsayılan satır sınıfı (model sınıfı vermezse). */
export function defaultTier(role: string): DesignIntent["lines"][number]["tier"] {
  if (role === "name") return "primary";
  if (role === "connector") return "connector";
  if (role === "date" || role === "place") return "tertiary";
  return "secondary";
}

function fontCatalogText(fonts: readonly FontAvailability[]): string {
  const rows = fonts.map((f) => {
    const roles = f.roles.length ? `roles: ${f.roles.join(", ")}` : "character rules only — never choose";
    return `- "${f.id}" — ${f.kind}; ${roles}${f.note ? `; ${f.note}` : ""}`;
  });
  return ["## Font catalog (use these exact ids)", ...rows].join("\n");
}

const tierTable = () =>
  (Object.entries(ROLES_FOR_TIER) as Array<[string, readonly string[]]>).map(([tier, roles]) => `${tier} → ${roles.join(" / ")}`).join("; ");

/**
 * Sistem istemi: değişmez ürün kuralları (koda gömülü OLABİLİR, tarz değil) + profilden üretilen kurallar.
 * Aynı profil için bayt bayt aynıdır (önbelleğe uygun): işe özel hiçbir şey içermez.
 */
export function buildDesignSystem(profile: Profile, fonts: readonly FontAvailability[]): string {
  const sizeField = profile.sizing.tiersLocked ? "" : ', optionally "size" (ratio to the largest line)';
  const fillField = profile.sizing.fillLocked ? "" : ', optionally "fill" per candidate';
  const sym = preservationSymbols(profile);
  return [
    "You design the typography of personalised text on small printed labels (stickers with a decorative template). A deterministic layout engine measures the real fonts, sizes and places your design inside the template's free area and checks every collision. You produce DESIGN INTENT only.",
    "",
    "# Fixed rules (always)",
    `1. Never output coordinates, pixel sizes, point sizes or positions. You decide only where lines break and, per line, its role, tier and font${sizeField}${fillField}.`,
    "2. Preserve the customer's text EXACTLY, character for character: same letters, same capital and small letters, same punctuation, symbols and emoji, same order — including separators at the end of a part (a trailing comma, dash or full stop stays where it is). Never translate, correct, complete, add, remove or reorder anything.",
    `3. The only change you make is choosing line breaks: a break replaces a space${sym.length ? `, sits directly next to ${sym.map((s) => `"${s}"`).join(", ")}` : ""} or comes right after a punctuation mark that has no space after it ("compleanno.Felice" → "compleanno." / "Felice"), or sits directly before or after an emoji or symbol written without a space ("olsun🎂İyi" → "olsun🎂" / "İyi"). Never split inside a word or inside an emoji (a flag, a family or a skin tone emoji is one character). Reading your lines top to bottom must reproduce the text exactly. A changed text is rejected.`,
    "4. Characters a font lacks are set automatically in a fallback font: never avoid, replace or drop them.",
    "5. The FIRST candidate is the design this designer would most likely make: break the lines exactly as their habit shows (the similar past texts and the examples below outrank everything except these fixed rules). The other candidates are alternatives: vary the font or the hierarchy first; vary the line breaks only where this designer's habit is genuinely ambiguous for this text. Never the same design twice. Order them most likely first.",
    '6. "rationale": at most two short sentences about the idea of the candidate.',
    "",
    "# Each line",
    "- text: the exact slice of the customer's text.",
    "- role: name | connector | greeting | message | date | place | title | other — what the line means.",
    "- tier: primary | secondary | tertiary | connector — its visual size class, independent of the font. primary = names or the main message; secondary = a supporting phrase; tertiary = date, place, small print; connector = a line that is only a connector.",
    `- fontId: a usable font from the catalog whose roles fit the tier (${tierTable()}).`,
    "",
    profileRulesSection(profile),
    "",
    examplesSection(profile),
    "",
    styleNoteSection(profile),
    "",
    fontCatalogText(fonts),
  ]
    .filter((s, i, a) => !(s === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

function templateText(ctx: DesignContext): string[] {
  const t = ctx.template;
  if (!t) return [];
  const out = [`# Template${t.key ? ` ${t.key}` : ""}`];
  if (t.notes?.trim()) out.push(`Description: ${t.notes.trim()}`);
  if (t.tags?.length) out.push(`Tags: ${t.tags.join(", ")}`);
  // Oran olduğu gibi verilir (piksel değil); dar/geniş ayrımının eşiği koda değil profil notlarına yazılır.
  if (t.areaAspect) out.push(`Free text area: width/height ≈ ${Math.round(t.areaAspect * 100) / 100} (1 = as wide as it is tall; higher = wider and flatter, lower = narrower and taller).`);
  if (t.widthHints?.length) {
    out.push(
      `Usable line width at heights of the free area (top → bottom), in characters at a typical size: ${t.widthHints
        .map((w) => `${Math.round(w.at * 100)}%: ~${Math.round(w.chars)}`)
        .join(", ")}. Lines near the top and bottom must be shorter.`,
    );
  }
  if (t.ribbonTop) out.push(`A ribbon covers the top ${Math.round(t.ribbonTop * 100)}% of the label; text sits below it.`);
  if (t.printedText) out.push("The template already has printed text of its own; it is not part of the customer's text.");
  if (t.darkBackground) out.push("The background under the text is dark.");
  return out;
}

function imagesText(ctx: DesignContext): string[] {
  const im = ctx.images;
  if (!im) return [];
  const desc: string[] = [];
  let n = 1;
  if (im.template) desc.push(`Image ${n++}: the template as printed.`);
  if (im.area) desc.push(`Image ${n++}: the same template with the usable text area in green (a limit, not necessarily the optical centre).`);
  const refs = im.references?.length ?? 0;
  if (refs) {
    desc.push(
      `Image${refs > 1 ? `s ${n}–${n + refs - 1}` : ` ${n}`}: the designer's own finished labels on this template — learn their placement, size rhythm and line breaks. NEVER copy their text; this job has its own text.`,
    );
    n += refs;
  }
  if (im.revisionBase) desc.push(`Image ${n++}: the variant being revised.`);
  return desc.length ? ["# Attached images", ...desc] : [];
}

/** İşe özel kullanıcı mesajı. */
export function buildDesignUser(ctx: DesignContext, fonts: readonly FontAvailability[]): string {
  const count = ctx.candidates ?? 3;
  const blocked = fonts.filter((f) => !f.usable && f.roles.length);
  const segments = ctx.segments?.length ? ctx.segments : [];
  const sections: string[][] = [
    [
      "# Job",
      "Customer text (between the marker lines; the markers are not part of it):",
      "<<<TEXT",
      ctx.text,
      "TEXT>>>",
      segments.length > 1 ? `The customer typed it in ${segments.length} parts: ${JSON.stringify(segments)}` : "",
      ctx.aiNote?.trim() ? `Note for this job (highest priority after the fixed rules): ${ctx.aiNote.trim()}` : "",
    ],
    blocked.length ? ["# Fonts NOT usable for this job", ...blocked.map((f) => `- "${f.id}": ${f.aiReason ?? "blocked"}`)] : [],
    ctx.similar?.length ? [similarExamplesSection(ctx.similar, ctx.template?.areaAspect !== undefined ? { areaAspect: ctx.template.areaAspect } : {})] : [],
    templateText(ctx),
    imagesText(ctx),
  ];
  if (ctx.revision) {
    sections.push([
      "# Revision",
      "The user chose this existing design as the starting point:",
      JSON.stringify({ lines: ctx.revision.intent.lines.map((l) => ({ text: l.text, role: l.role, tier: l.tier, fontId: l.fontId, ...(l.size ? { size: l.size } : {}) })), ...(ctx.revision.intent.fill ? { fill: ctx.revision.intent.fill } : {}) }),
      `Their request: «${ctx.revision.request.trim()}»`,
      "Apply the request fully; keep everything it does not mention as in the starting design. Every candidate must satisfy the request; candidates may differ only in how they interpret it. If the request would change the customer's wording, keep the wording and change only the typography.",
    ]);
  } else if (ctx.previous?.length) {
    sections.push([
      "# Variants already shown (every new candidate must be clearly different from these)",
      ...ctx.previous.map((p, i) => `${i + 1}. ${p.lines.map((l) => JSON.stringify(l)).join(" / ")}`),
    ]);
  }
  sections.push(["# Task", `Return exactly ${count} candidate${count > 1 ? "s" : ""} in "candidates".`]);
  return sections
    .map((s) => s.filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}
