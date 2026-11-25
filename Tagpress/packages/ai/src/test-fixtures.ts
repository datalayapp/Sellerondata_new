/**
 * Test verisi. Bu dosyadaki font adları, bağlaçlar ve eşikler YALNIZCA TEST İÇİNDİR (tarz verisi); üretim kodu
 * bunları bilmez — istemin profilden geldiğini göstermek için iki farklı profil kullanılır.
 */
import { type Profile, ProfileSchema } from "@tagpress/domain";

export const profileA: Profile = ProfileSchema.parse({
  name: "Romantik",
  fonts: {
    mixing: "single",
    list: [
      { id: "Velvet Script/Regular", family: "Velvet Script", kind: "script", roles: ["primary", "secondary"], maxUppercaseRun: 2, note: "bitişik el yazısı" },
      { id: "Old Fell/Italic", family: "Old Fell", style: "Italic", kind: "serif", roles: [] },
      { id: "Plain Sans/Regular", family: "Plain Sans", kind: "sans", roles: ["primary", "secondary"] },
    ],
  },
  glyphRules: [{ id: "amp", match: { type: "chars", chars: "&" }, fontId: "Old Fell/Italic", scale: 0.5 }],
  sizing: { fillLocked: true, tiersLocked: true, fill: 0.95 },
  connectors: { words: ["&", "e"] },
  lineBreaking: {
    maxLineChars: 20,
    maxLines: 4,
    noLoneWords: ["di", "per"],
    notes: "Selamı ismin üstüne koy.",
    examples: [{ text: "Grazie Anna & Luca", lines: ["Grazie", "Anna", "&", "Luca"] }],
    coupleStack: "option",
  },
  ai: { instructions: "Zarif ve ferah; isimler büyük." },
});

export const profileB: Profile = ProfileSchema.parse({
  name: "Neşeli",
  fonts: {
    mixing: "two",
    list: [
      { id: "Bubble Display/Regular", family: "Bubble Display", kind: "display", roles: ["primary"] },
      { id: "Round Sans/Regular", family: "Round Sans", kind: "sans", roles: ["secondary", "primary"] },
    ],
  },
  sizing: { fillLocked: false, tiersLocked: false, fill: 0.8 },
  connectors: { words: ["+", "and"], allowSymbolSpacing: false },
  lineBreaking: { maxLineChars: 28, coupleStack: "never", customerBreaks: "strict" },
  ai: { instructions: "Canlı, oyuncu; büyük harfli başlıklar." },
});
