import { type Profile, type ProfileInput, ProfileSchema } from "@tagpress/domain";
import { FontRegistry } from "@tagpress/typeset";
import { TEST_FALLBACK_FONTS_DIR, TEST_FONTS_DIR } from "@tagpress/typeset/testing";

/**
 * YALNIZCA TESTLER İÇİN. Fontlar depodaki açık lisanslı fikstürden gelir (`@tagpress/typeset/testing`; her makinede aynı).
 * Profil, kullanıcının Figma'da düzelttiği 215 etiketten ölçülen değerlerle kurulur (koda değil profile gömülü).
 * İkinci el yazısı ailesi: ticari Monotype Corsiva yerine açık lisanslı Parisienne (aynı rol, tür ve kilit).
 */
export const PARISIENNE = "Parisienne/Regular";

export function userProfile(patch: Partial<ProfileInput> = {}): Profile {
  const base: ProfileInput = {
    name: "Test (kullanıcı ölçümleri)",
    fonts: {
      mixing: "single",
      list: [
        { id: "Great Vibes/Regular", family: "Great Vibes", style: "Regular", file: "GreatVibes-Regular.ttf", kind: "script", roles: ["primary", "secondary"], maxUppercaseRun: 2, lockTracking: true },
        { id: PARISIENNE, family: "Parisienne", style: "Regular", file: "Parisienne-Regular.ttf", kind: "script", roles: ["primary", "secondary"], lockTracking: true },
        { id: "IM FELL Great Primer SC/Regular", family: "IM FELL Great Primer SC", style: "Regular", file: "IMFeGPsc28P.ttf", kind: "serif", roles: [] },
        { id: "Alex Brush/Regular", family: "Alex Brush", style: "Regular", file: "AlexBrush-Regular.ttf", kind: "script", roles: [] },
        { id: "Playfair Display/Regular", family: "Playfair Display", style: "Regular", file: "PlayfairDisplay[wght].ttf", kind: "serif", roles: ["primary", "secondary"] },
        { id: "Cinzel/Regular", family: "Cinzel", style: "Regular", file: "Cinzel[wght].ttf", kind: "serif", roles: ["primary", "secondary"] },
      ],
    },
    glyphRules: [
      { id: "ampersand", match: { type: "chars", chars: "&" }, fontId: "IM FELL Great Primer SC/Regular", scale: 0.5 },
      { id: "capital-a", match: { type: "word-initial-upper", letters: "A" }, fontId: "Alex Brush/Regular", onlyWithFonts: ["Great Vibes/Regular"] },
    ],
    sizing: {
      fill: 0.97,
      tiers: { primary: 1, secondary: 0.73, tertiary: 0.64, connector: 0.52 },
      maxCapHeight: 0.14,
      breathing: 0.03,
      minPt: 4,
      maxPt: 40,
    },
    spacing: { inkGaps: { normal: 0.11, beforeLast: 0.29, connector: 0.09 }, beforeLastRatio: 0.85 },
    connectors: { words: ["&", "+", "and", "e", "y", "und", "et"], shiftEm: 0.13, separateDangling: true },
    lineBreaking: { maxLineChars: 32, maxLines: 6, noLoneWords: ["di", "de", "of", "la", "per"] },
    weight: { mode: "stroke", widthEm: 0.02, minPx: 0.6, maxPx: 2, align: "outside" },
  };
  return ProfileSchema.parse(deepMerge(base, patch));
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (b && typeof b === "object" && !Array.isArray(b) && a && typeof a === "object" && !Array.isArray(a)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return b === undefined ? a : b;
}

let shared: Promise<FontRegistry> | null = null;
/** Test font kaydı (bir kez kurulur). Ortak yedekler: fikstürün `yedek/` klasörü (Noto Naskh Arabic, Twemoji); sistem fontu yok. */
export function testFonts(profile: Profile = userProfile()): Promise<FontRegistry> {
  shared ??= FontRegistry.create({ entries: profile.fonts.list, fontDir: TEST_FONTS_DIR, fallbackDirs: [TEST_FALLBACK_FONTS_DIR], systemFallbacks: false });
  return shared;
}
