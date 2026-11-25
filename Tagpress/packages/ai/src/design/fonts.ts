import type { FontEntry, FontKind, FontRole, Profile } from "@tagpress/domain";

/** Bir işte fontun kullanılıp kullanılamayacağı ve nedeni. Sunucu eksik glifleri (typeset) ekleyebilir. */
export interface FontAvailability {
  id: string;
  family: string;
  style: string;
  kind: FontKind;
  roles: FontRole[];
  note: string;
  usable: boolean;
  /** Kullanıcıya (Türkçe). */
  reason?: string;
  /** Modele (İngilizce). */
  aiReason?: string;
}

/** Metindeki en uzun art arda büyük harf dizisi (harf olmayan karakter diziyi keser). */
export function longestUppercaseRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const ch of text) {
    if (/\p{Lu}/u.test(ch)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

/**
 * Profilin fontlarından bu iş için katalog. Kapalı fontlar listelenmez. Rolü olmayan font yalnızca karakter
 * kuralları içindir (seçilemez). `missingGlyphs` sunucudan gelir (font kimliği → eksik karakterler).
 */
export function fontCatalog(profile: Profile, text: string, missingGlyphs: Record<string, string[]> = {}): FontAvailability[] {
  const upper = longestUppercaseRun(text);
  return profile.fonts.list
    .filter((f) => f.enabled)
    .map((f: FontEntry) => {
      const base = { id: f.id, family: f.family, style: f.style, kind: f.kind, roles: [...f.roles], note: f.note };
      if (!f.roles.length) return { ...base, usable: false, reason: "Yalnızca özel karakter kuralları için.", aiReason: "used only by character rules" };
      if (f.maxUppercaseRun !== null && upper > f.maxUppercaseRun) {
        return {
          ...base,
          usable: false,
          reason: `Metinde art arda ${upper} büyük harf var; bu fontun sınırı ${f.maxUppercaseRun}.`,
          aiReason: `the text has ${upper} capitals in a row; this font allows at most ${f.maxUppercaseRun}`,
        };
      }
      const missing = missingGlyphs[f.id] ?? [];
      if (missing.length) {
        return { ...base, usable: false, reason: `Eksik glif: ${missing.join(" ")}`, aiReason: `missing glyphs: ${missing.join(" ")}` };
      }
      return { ...base, usable: true };
    });
}
