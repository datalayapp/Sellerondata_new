import { graphemes, isEmojiGrapheme, isPictographic } from "./grapheme.ts";
import { issueMsg } from "./messages.ts";

/**
 * Müşteri metni kuralları. Müşteri metni HİÇBİR otomatik adımda değişmez: harf, büyük/küçük, noktalama,
 * satır sonundaki ayırıcılar olduğu gibi kalır. Yalnızca satır bölmesi (ve izin verilirse sembol bağlaç
 * çevresindeki boşluk) değişebilir.
 */

const OUTER_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["„", "“"],
  ["”", "”"],
  ["'", "'"],
  ["‘", "’"],
  ["«", "»"],
  ["‹", "›"],
];

export interface NormalizedText {
  /** Üretimde kullanılan metin. */
  text: string;
  /** Müşterinin satır ipuçları (çift boşluk ya da satır sonu ile ayrılmış parçalar). */
  segments: string[];
  /** Dış tırnak çifti kaldırıldı mı? */
  outerQuotesRemoved: boolean;
}

/** NFC, kenar boşlukları, kaçışlı "\n" ve sekmeler; metni tamamen saran eşleşen tırnak çifti kaldırılır. */
export function normalizeText(raw: string): NormalizedText {
  let t = raw.normalize("NFC").replace(/\\n/g, "\n").replace(/\t/g, " ").replace(/\r\n?/g, "\n").trim();
  let outerQuotesRemoved = false;
  for (const [open, close] of OUTER_QUOTES) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length);
      // İçeride aynı açılış tırnağı kapanmadan kalıyorsa (ör. "a" ve "b") dış çift değildir.
      if (open === close && closesEarly(inner, open)) continue;
      t = inner.trim();
      outerQuotesRemoved = true;
      break;
    }
  }
  const segments = t
    .split(/\n+| {2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { text: t, segments, outerQuotesRemoved };
}

/**
 * Aynı karakterli tırnakta ('…', "…") dıştaki çift gerçekten metni mi sarıyor? İç tırnaklar açılış
 * (önü boşluk) / kapanış (arkası boşluk) gibi okunur; kelime içindeki kesme işareti (Laura's) sayılmaz.
 * Dıştaki açılış, son karakterden önce kapanıyorsa ("'a' and 'b'") dış çift değildir.
 */
function closesEarly(inner: string, q: string): boolean {
  const chars = [...inner];
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== q) continue;
    const prev = chars[i - 1] ?? " ";
    const next = chars[i + 1] ?? " ";
    const prevSpace = /[\s([{]/u.test(prev);
    const nextSpace = /[\s)\]}.,;:!?]/u.test(next);
    if (prevSpace && !nextSpace) depth++;
    else if (!prevSpace && nextSpace) {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

/** Karşılaştırma biçimi: boşluk dizileri tek boşluk; izin verilen sembollerin çevresindeki boşluk yok. */
export function canonicalText(text: string, symbols: readonly string[] = []): string {
  let t = text.replace(/\s+/gu, " ").trim();
  for (const s of symbols) {
    if (!s.trim() || /[\p{L}\p{N}]/u.test(s)) continue; // yalnızca harf olmayan semboller (&, +)
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*${esc}\\s*`, "gu"), s);
  }
  return t;
}

export interface PreservationResult {
  ok: boolean;
  /** Bozulma varsa ilk farklı karakterin yeri ve kısa açıklama. */
  problem?: string;
  /** `problem` cümlesinin parametreleri (`issueMsg("text-changed", params)`): 1'den sayılan yer ve iki taraftaki parça. */
  params?: { at: number; got: string; want: string };
}

/**
 * Satırlar müşteri metnini değiştirmeden mi bölüyor? Satır sonları boşluğun yerine geçer; sembol bağlaçlar
 * (izin verildiyse) boşluksuz yazılmış olsa da bölünebilir. Başka hiçbir fark kabul edilmez.
 */
export function checkTextPreserved(lines: readonly string[], text: string, symbols: readonly string[] = []): PreservationResult {
  const a = canonicalText(lines.join(" "), symbols);
  const b = canonicalText(text, symbols);
  if (a === b) return { ok: true };
  if (matchesWithTightBreaks(lines, b, symbols)) return { ok: true };
  const ca = [...a];
  const cb = [...b];
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  const got = ca.slice(Math.max(0, i - 8), i + 8).join("");
  const want = cb.slice(Math.max(0, i - 8), i + 8).join("");
  const params = { at: i + 1, got, want };
  return { ok: false, problem: issueMsg("text-changed", params).message, params };
}

/** Boşluksuz satır sonu yalnızca bu işaretlerden SONRA olabilir ("compleanno.Felice" → "compleanno." / "Felice"). */
const TIGHT_BREAK_AFTER = /[.,;:!?…)\]}»”’\-–—/~•·]/u;

/**
 * Satır sonları müşteri metninde boşluk OLMAYAN bir yere de düşebilir mi? Satırlar sırayla metnin içinde aranır;
 * iki satır arasında ya bir boşluk vardır ya da (boşluksuz) önceki karakter noktalama/sembol bağlaçtır. Kelime
 * ortasından bölme kabul edilmez. Hiçbir karakter eklenmez ya da silinmez.
 */
function matchesWithTightBreaks(lines: readonly string[], target: string, symbols: readonly string[]): boolean {
  const syms = new Set(symbols.filter((s) => s.trim() && !/[\p{L}\p{N}]/u.test(s)));
  // Grafem sınırları (UTF-16 konumu → o konumda biten / başlayan küme): bölme bir kümenin (emoji) içine düşemez.
  const before = new Map<number, string>();
  const after = new Map<number, string>();
  let off = 0;
  for (const g of graphemes(target)) {
    after.set(off, g);
    off += g.length;
    before.set(off, g);
  }
  let pos = 0;
  const parts = lines.map((l) => canonicalText(l, symbols)).filter((l) => l.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!target.startsWith(part, pos)) return false;
    pos += part.length;
    if (i === parts.length - 1) break;
    if (target[pos] === " ") {
      pos++;
      continue;
    }
    const prev = before.get(pos);
    const next = after.get(pos);
    if (prev === undefined || next === undefined) return false; // kümenin ortası
    // Boşluksuz bölme: noktalamadan sonra, sembol bağlacın yanında ya da resimli sembolün/emojinin önünde veya arkasında.
    if (!(TIGHT_BREAK_AFTER.test(prev) || syms.has(prev) || syms.has(next) || isPictographic(prev) || isPictographic(next))) return false;
  }
  return pos === target.length;
}

/**
 * Süslü ("farklı stilde") yazı: müşterinin süslü yazı üreticileriyle yazdığı harfler — matematiksel harfler (𝓔𝓵𝓲𝓯,
 * 𝐊𝐞𝐫𝐞𝐦), tam genişlik (Ａｙｓｅ), daire/kare içi (Ⓐ, 🄰, 🅐, 🅴), küçük büyük harf (ᴇʟɪꜰ), üst simge harf (ᵉ) ve
 * harfin üstüne/altına eklenen süs çizgileri (E̶, A̲). İki yol vardır ve seçim KULLANICININDIR (kendiliğinden
 * çevrilmez): düz harfe çevirmek (`toPlainLetters`, etiketin fontuyla basılır) ya da olduğu gibi bırakmak (uygulamayla
 * gelen yedek fontlarla bu stilde basılır). Emoji (Ⓜ️, 🅰️ gibi seçicili harf emojileri), Türkçe harfler, ① ² ★ © gibi
 * semboller süslü sayılmaz.
 */

/** Küçük büyük harf (fonetik blok) → düz küçük harf. Türkçe okumada ɪ "i" olur (ᴇʟɪꜰ → elif). */
const SMALL_CAPS: Record<string, string> = {
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m",
  ɴ: "n", ᴏ: "o", ᴘ: "p", ꞯ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};

/** Harfe eklenen süs işaretleri (üst/alt çizgi, üstü çizili, eğik çizgi). Türkçe işaretler (çengel, nokta, kesme) değil. */
const DECOR_MARKS = /[\u0305\u0332\u0333\u0334\u0335\u0336\u0337\u0338\u033F\u20D2\u20D3]/gu;

/** Tek kod noktasının düz karşılığı; süslü değilse null. */
function plainOf(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (SMALL_CAPS[ch]) return SMALL_CAPS[ch]!;
  // Negatif daire/kare harfler (🅐, 🅴): uyumluluk ayrışımı yok, sırayla A–Z.
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode(0x41 + cp - 0x1f150);
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(0x41 + cp - 0x1f170);
  const nfkc =
    (cp >= 0x1d400 && cp <= 0x1d7ff) || // matematiksel harf ve rakamlar
    (cp >= 0xff01 && cp <= 0xff5e) || // tam genişlik
    (cp >= 0x24b6 && cp <= 0x24e9) || // daire içi harf
    (cp >= 0x1f130 && cp <= 0x1f149) || // kare içi harf
    (cp >= 0x1d2c && cp <= 0x1d6a) || // üst simge harf (ᴬ ᵉ)
    (cp >= 0x1d9b && cp <= 0x1dbf); // üst simge küçük harf (ᶠ)
  if (!nfkc) return null;
  const plain = ch.normalize("NFKC");
  return plain !== ch && /^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(plain) ? plain : null;
}

/** Kümede süslü harf ya da süs işareti var mı (emoji kümeleri hariç)? */
function isStyledGrapheme(g: string): boolean {
  if (isEmojiGrapheme(g)) return false;
  DECOR_MARKS.lastIndex = 0;
  if (DECOR_MARKS.test(g)) return true;
  for (const ch of g) if (plainOf(ch) !== null) return true;
  return false;
}

/** Süslü yazı kümeleri (sırayla; boşsa metinde süslü yazı yok). */
export function styledUnicodeChars(text: string): string[] {
  return graphemes(text).filter(isStyledGrapheme);
}

/**
 * Yalnızca süslü kümeleri düz harfe çevirir (süs işaretleri atılır, kalan Türkçe işaret harfle birleşir: NFC);
 * metnin geri kalanına (emoji, Türkçe harfler, semboller, boşluklar) dokunmaz. Kullanıcı eylemidir.
 */
export function toPlainLetters(text: string): string {
  let out = "";
  for (const g of graphemes(text)) {
    if (!isStyledGrapheme(g)) {
      out += g;
      continue;
    }
    let plain = "";
    for (const ch of g.replace(DECOR_MARKS, "")) plain += plainOf(ch) ?? ch;
    out += plain.normalize("NFC");
  }
  return out;
}

/** Metinden süslü kümeleri çıkarır (yerlerine boşluk): tasarım fontuna ait kurallar (büyük harf sınırı) yalnız düz yazıya bakar. */
export function withoutStyled(text: string): string {
  return graphemes(text)
    .map((g) => (isStyledGrapheme(g) ? " " : g))
    .join("");
}

/** "A & M", "A.M & J" gibi yalnızca baş harf metni mi? */
export function isInitialsOnly(text: string, connectors: readonly string[]): boolean {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length < 1) return false;
  const conn = new Set(connectors.map((c) => c.toLowerCase()));
  let letters = 0;
  for (const w of words) {
    if (conn.has(w.toLowerCase())) continue;
    for (const part of w.split(/[&+]/u)) {
      if (!part) continue;
      if (!/^(\p{Lu}\.?){1,2}$/u.test(part)) return false;
      letters++;
    }
  }
  return letters >= 2;
}
