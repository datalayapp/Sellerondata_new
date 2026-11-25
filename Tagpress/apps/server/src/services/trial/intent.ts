import { fontCatalog, preservationSymbols } from "@tagpress/ai";
import { type DesignIntent, type IntentLine, type Profile, checkTextPreserved, graphemes, normalizeText } from "@tagpress/domain";
import { isConnectorText } from "@tagpress/engine";

/**
 * AI'sız, deterministik basit tasarım niyeti (şablon deneme, "Dene"nin motor modu, üretilen şablon önizlemesi).
 * Kasıtlı olarak sade: müşterinin satır ipuçları (çift boşluk / satır sonu) varsa onlar; yoksa tarih kendi satırına,
 * "İsim & İsim" kısa ise tek satır, uzunsa üç satır; geri kalan dengeli sarılır. Fontlar profilin kullanılabilir
 * ilk ana fontu (tek aile); sınıflar: isim benzeri satır ana, tarih üçüncül, bağlaç bağlaç, diğerleri ikincil.
 * Bu bir tasarım değil, motor ve şablon ayarlarını AI'sız görmek için bir başlangıçtır.
 */

const DATE_RE = /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4})$/u;
const len = (s: string) => graphemes(s).length;

function balancedWrap(words: string[], maxChars: number): string[] {
  const total = len(words.join(" "));
  if (total <= maxChars) return [words.join(" ")];
  const n = Math.ceil(total / maxChars);
  const target = total / n;
  const out: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    const next = [...cur, w].join(" ");
    if (cur.length && len(next) > target * 1.15 && out.length < n - 1) {
      out.push(cur.join(" "));
      cur = [w];
    } else cur.push(w);
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/** Otomatik satır bölme (müşteri ipucu yoksa). */
export function autoBreak(text: string, profile: Profile): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const maxChars = Math.max(8, Math.min(profile.lineBreaking.maxLineChars, 16));
  // Tarih(ler) kendi satırına (profil istiyorsa); metnin sonundaki ya da başındaki tarih ayrılır.
  const tail: string[] = [];
  const head: string[] = [];
  if (profile.lineBreaking.dateOwnLine) {
    while (words.length > 1 && DATE_RE.test(words.at(-1)!)) tail.unshift(words.pop()!);
    while (words.length > 1 && DATE_RE.test(words[0]!)) head.push(words.shift()!);
  }
  const body: string[] = [];
  const ci = words.findIndex((w, i) => i > 0 && i < words.length - 1 && isConnectorText(w, profile));
  if (ci > 0 && words.length <= 5) {
    const whole = words.join(" ");
    if (len(whole) <= maxChars || profile.lineBreaking.coupleStack === "never") body.push(...balancedWrap(words, Math.max(maxChars, len(whole))));
    else body.push(words.slice(0, ci).join(" "), words[ci]!, words.slice(ci + 1).join(" "));
  } else body.push(...balancedWrap(words, maxChars));
  return [...(head.length ? [head.join(" ")] : []), ...body, ...(tail.length ? [tail.join(" ")] : [])].filter(Boolean);
}

/** İsim benzeri: en çok üç kelime, rakam yok, bağlaçlar dışındaki her kelime büyük harfle başlar. */
const nameLike = (s: string, profile: Profile) => {
  const ws = s.split(/\s+/u).filter((w) => w && !isConnectorText(w, profile));
  return ws.length > 0 && ws.length <= 3 && !/\d/u.test(s) && ws.every((w) => /^\p{Lu}/u.test(w));
};

export function simpleIntent(rawText: string, profile: Profile): { text: string; segments: string[]; intent: DesignIntent } {
  const norm = normalizeText(rawText);
  const text = norm.text;
  const symbols = preservationSymbols(profile);
  let lines = norm.segments.length > 1 ? norm.segments : autoBreak(text, profile);
  if (!lines.length || !checkTextPreserved(lines, text, symbols).ok) lines = [text];
  const usable = fontCatalog(profile, text).filter((f) => f.usable);
  const primary = usable.find((f) => f.roles.includes("primary")) ?? usable[0];
  if (!primary) throw new Error("Profilde bu metin için kullanılabilir font yok (font listesi, roller ve büyük harf sınırlarını kontrol edin).");
  const secondary = profile.fonts.mixing === "single" ? primary : (usable.find((f) => f.roles.includes("secondary") && f.id !== primary.id) ?? primary);
  const multi = lines.length > 1;
  const out: IntentLine[] = lines.map((t) => {
    if (multi && isConnectorText(t, profile)) return { text: t, role: "connector", tier: "connector", fontId: primary.id };
    if (multi && DATE_RE.test(t.trim())) return { text: t, role: "date", tier: "tertiary", fontId: secondary.id };
    if (!multi || nameLike(t, profile)) return { text: t, role: "name", tier: "primary", fontId: primary.id };
    return { text: t, role: "message", tier: "secondary", fontId: secondary.id };
  });
  if (!out.some((l) => l.tier === "primary")) {
    const longest = out.filter((l) => l.role !== "date" && l.role !== "connector").sort((a, b) => len(b.text) - len(a.text))[0] ?? out[0]!;
    longest.tier = "primary";
    longest.fontId = primary.id;
  }
  return { text, segments: norm.segments, intent: { lines: out, rationale: "AI'sız deneme (basit kural)" } };
}
