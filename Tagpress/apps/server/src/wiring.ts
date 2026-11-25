import type { LabelSize } from "@tagpress/domain";
import type { CoverageResult, FontCoverage, Ports, TemplateResolution, TemplateResolver } from "./ports.ts";
import { levenshtein } from "./util/text.ts";

/**
 * Portların varsayılanı (paket bağımsız). Gerçek paketler `adapters/index.ts` → `productionPorts()` ile bağlanır
 * (main.ts); testler sahte uygulamalar verir. Sunucunun geri kalanı yalnızca `Ports` arayüzünü bilir.
 * - `basicTemplateResolver`: sade şablon çözücü (templates adaptörü bilinmeyen anahtar için bunu da kullanır).
 * - `basicFontCoverage`: typeset bağlanana kadar; glif bilmez, yalnızca yazı sistemi tahmini yapar.
 */
export function defaultPorts(overrides: Partial<Ports> = {}): Ports {
  return {
    templateResolver: basicTemplateResolver,
    fontCoverage: basicFontCoverage,
    geometry: null,
    engine: null,
    designer: null,
    imageGenerator: null,
    fontCatalog: null,
    ...overrides,
  };
}

/** Şablon anahtarı karşılaştırma biçimi: küçük harf, ayırıcısız, sayılarda baştaki sıfır yok ("A-01" → "a1"). */
export function canonicalKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(^|[a-z])0+(?=\d)/g, "$1");
}

function sizeRegex(id: string): RegExp {
  const body = id.replace(/[.,]/g, "[.,]").replace(/[*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\d.,])(${body})(?![\\d.,])\\s*(?:cm)?`, "i");
}

const UNKNOWN_SIZE = /(^|[^\d.,a-z])(\d{1,2}[.,]\d{1,2})(?![\d.,])\s*(?:cm)?/i;

export const basicTemplateResolver: TemplateResolver = {
  resolve(input: string, ctx: { keys: readonly string[]; sizes: readonly LabelSize[] }): TemplateResolution {
    let rest = input.trim();
    let size: string | null = null;
    let unknownSize: string | null = null;
    for (const s of ctx.sizes) {
      const re = sizeRegex(s.id);
      if (re.test(rest)) {
        size = s.id;
        rest = rest.replace(re, "$1 ");
        break;
      }
    }
    if (!size) {
      const m = rest.match(UNKNOWN_SIZE);
      if (m) {
        unknownSize = m[2]!.replace(",", ".");
        rest = rest.replace(UNKNOWN_SIZE, "$1 ");
      }
    }
    rest = rest.replace(/[()[\]]/g, " ").replace(/^[\s\-_/,]+|[\s\-_/,]+$/g, "").trim();
    if (!rest) return { key: null, size, unknownSize, suggestions: [] };
    const canon = canonicalKey(rest);
    const exact = ctx.keys.find((k) => canonicalKey(k) === canon);
    if (exact) return { key: exact, size, unknownSize, suggestions: [] };
    const suggestions = ctx.keys
      .map((k) => ({ k, d: levenshtein(canonicalKey(k), canon) }))
      .filter((x) => x.d <= 2 || canonicalKey(x.k).startsWith(canon))
      .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
      .slice(0, 3)
      .map((x) => x.k);
    return { key: canon || rest.toLowerCase(), size, unknownSize, suggestions };
  },
};

const EMOJI = /\p{Extended_Pictographic}/u;
const FALLBACK_SCRIPTS = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}]/u;

/** Glif bilmeyen tahmin: emoji ve Latin dışı yazı sistemleri "yedek fontla basılacak" sayılır. */
export const basicFontCoverage: FontCoverage = {
  check(text: string): CoverageResult {
    const fallback = new Set<string>();
    for (const ch of text) if (EMOJI.test(ch) || FALLBACK_SCRIPTS.test(ch)) fallback.add(ch);
    return { fallback: [...fallback], missing: [] };
  },
};
