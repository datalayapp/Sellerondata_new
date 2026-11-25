/**
 * Sipariş JSON'undaki şablon alanını çözer: "A1" = "a1", "01" = "1", "a15 5.2" → a15 + boyut 5.2,
 * "2,5 cm 12" → 12 + 2.5. Boyut kimlikleri profilden gelir (`output.sizes`), koda gömülmez.
 */
export interface TemplateKeyResult {
  /** Bilinen şablonlardan biri (özgün yazımıyla) ya da null. */
  key: string | null;
  /** Profildeki boyut kimliği ya da null. */
  size: string | null;
  /** Anahtar bulunamadıysa en yakın bilinen şablonlar (en çok 5). */
  suggestions: string[];
}

type SizeLike = string | { id: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Boyut kimliği için desen: ondalık ayırıcı "." ya da "," olabilir; ardından isteğe bağlı "cm". */
function sizePattern(id: string): RegExp {
  const body = id
    .split(/[.,]/)
    .map(escapeRe)
    .join("[.,]");
  return new RegExp(`(?<![\\p{L}\\p{N}.,])${body}(?![\\p{N}.,])\\s*(?:cm)?`, "iu");
}

/** Karşılaştırma biçimi: küçük harf, ayraçsız, harf önekinden sonraki baştaki sıfırlar atılmış. */
export function normalizeTemplateKey(raw: string): string {
  let s = raw.normalize("NFKC").trim().toLocaleLowerCase("tr").replace(/ı/g, "i");
  s = s.replace(/^[#№]+/u, "").replace(/[\s\-_./#]+/gu, "");
  return s.replace(/^(\p{L}*)0+(?=\d)/u, "$1");
}

export function templateKeyFromInput(raw: string, known: readonly string[], sizes: readonly SizeLike[] = []): TemplateKeyResult {
  let rest = String(raw ?? "");
  let size: string | null = null;
  // Uzun kimlikler önce ("12.5" varsa "2.5"ten önce denensin).
  const ids = sizes.map((s) => (typeof s === "string" ? s : s.id)).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const re = sizePattern(id);
    if (re.test(rest)) {
      size = id;
      rest = rest.replace(re, " ");
      break;
    }
  }
  rest = rest.replace(/[()[\]{}]/g, " ").replace(/^[\s\-_/,;:]+|[\s\-_/,;:]+$/g, "").trim();
  if (!rest) return { key: null, size, suggestions: [] };

  const norm = normalizeTemplateKey(rest);
  const byNorm = new Map<string, string>();
  for (const k of known) byNorm.set(normalizeTemplateKey(k), k);
  const hit = byNorm.get(norm);
  if (hit !== undefined) return { key: hit, size, suggestions: [] };
  return { key: null, size, suggestions: nearest(norm, known) };
}

/** En yakın bilinen anahtarlar: aynı harf öneki ve sayısal yakınlık önce, sonra düzenleme uzaklığı. */
function nearest(norm: string, known: readonly string[], limit = 5): string[] {
  const parse = (s: string) => {
    const m = /^(\p{L}*)(\d*)(.*)$/u.exec(s);
    return { prefix: m?.[1] ?? "", num: m?.[2] ? Number(m[2]) : null, tail: m?.[3] ?? "" };
  };
  const q = parse(norm);
  const scored = known.map((k) => {
    const n = normalizeTemplateKey(k);
    const c = parse(n);
    let score = levenshtein(norm, n);
    if (c.prefix === q.prefix && q.num !== null && c.num !== null) score = Math.min(score + 0.25, Math.abs(c.num - q.num) * 0.5);
    else if (c.prefix !== q.prefix) score += 0.75;
    return { k, score };
  });
  return scored
    .sort((a, b) => a.score - b.score || a.k.localeCompare(b.k, "tr", { numeric: true }))
    .filter((s) => s.score <= Math.max(2, norm.length))
    .slice(0, limit)
    .map((s) => s.k);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}
