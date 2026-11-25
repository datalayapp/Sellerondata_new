import { type Issue, type IssueText, type Profile, fixMsg, graphemes, issueMsg, loneSurrogates, styledUnicodeChars, toPlainLetters } from "@tagpress/domain";
import type { CoverageResult } from "../../ports.ts";

/**
 * Metin düzeyindeki sorunlar. Bu işlevler metni ASLA değiştirmez; yalnızca işaretler ve kullanıcının tek
 * tıkla uygulayabileceği öneriler (fixes) verir.
 */

// Denetim karakterleri (Unicode Cc: U+0000–001F, U+007F–009F), satır sonu (\n) hariç.
const CONTROL = /(?!\n)\p{Cc}/gu;
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u200B\u202F\u205F\u3000\uFEFF]/gu;
const LEAD_PUNCT = /^[,.;:!?\-–—_/\\|]/u;
const TRAIL_PUNCT = /[,;:\-–—_/\\|]$/u;
/** Soyadı önekleri ("McDonald", "DeLuca") büyük harf kayması sayılmaz. */
const NAME_PREFIX = /^(Mc|Mac|O'|O’|D'|D’|De|Di|Da|Del|La|Le|Van|Von)\p{Lu}/u;

const show = (chars: string[]) =>
  chars
    .slice(0, 8)
    .map((c) => (/\p{L}|\p{N}|\p{P}|\p{S}/u.test(c) ? `"${c}"` : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`))
    .join(", ");

const unique = (xs: Iterable<string>) => [...new Set(xs)];

export function segmentsOf(text: string): string[] {
  return text
    .split(/\n+| {2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function textIssues(text: string, profile: Profile, coverage: CoverageResult): Issue[] {
  const out: Issue[] = [];
  const issue = (i: Omit<Issue, "fixes"> & { fixes?: Issue["fixes"] }) => out.push({ fixes: [], field: "text", ...i });
  if (!text.trim()) {
    issue({ ...issueMsg("text-missing"), severity: "error", fixes: [fixMsg("write-text"), fixMsg("skip-row")] });
    return out;
  }
  const lb = profile.lineBreaking;
  const len = graphemes(text.replace(/\s+/gu, " ").trim()).length;
  const capacity = lb.maxLineChars * lb.maxLines;
  if (len > capacity) {
    issue({ ...issueMsg("text-very-long", { length: len, capacity }), severity: "warning" });
  }
  const segs = segmentsOf(text);
  if (segs.length > lb.maxLines) {
    issue({ ...issueMsg("text-very-long-lines", { lines: segs.length, max: lb.maxLines }), severity: "warning" });
  }
  if (lb.customerBreaks === "strict") {
    const longSeg = segs.findIndex((s) => graphemes(s).length > lb.maxLineChars);
    if (longSeg >= 0) issue({ ...issueMsg("text-very-long-segment", { line: longSeg + 1, max: lb.maxLineChars }), severity: "warning" });
  }
  const longWords = unique(text.split(/\s+/u).filter((w) => graphemes(w).length > lb.maxLineChars));
  if (longWords.length) {
    issue({ ...issueMsg("text-word-too-long", { words: longWords.map((w) => `"${w}"`).join(", "), max: lb.maxLineChars }), severity: "warning" });
  }
  const styled = styledUnicodeChars(text);
  if (styled.length) {
    // Seçim kullanıcının: düz harfe çevirmek metni değiştirir (öneri, geri alınabilir); "olduğu gibi bas" uyarıyı
    // kapatır (`dismissed`) ve yazı bu stille, uygulamayla gelen yedek fontlarla basılır.
    issue({
      ...issueMsg("text-unicode-styled", { chars: show(unique(styled)) }),
      severity: "warning",
      fixes: [fixMsg("convert-unicode", { value: toPlainLetters(text) }), fixMsg("print-as-is")],
    });
  }
  const broken = loneSurrogates(text);
  if (broken.length) {
    issue({ ...issueMsg("text-unprintable-broken", { count: broken.length }), severity: "error", fixes: [fixMsg("edit-text")] });
  }
  const control = unique(text.match(CONTROL) ?? []);
  if (control.length) {
    issue({ ...issueMsg("text-unprintable-control", { chars: show(control) }), severity: "error", fixes: [fixMsg("remove-control", { value: text.replace(CONTROL, "") })] });
  }
  const missing = unique(coverage.missing).filter((c) => !control.includes(c) && !loneSurrogates(c).length);
  if (missing.length) {
    issue({ ...issueMsg("text-unprintable", { chars: show(missing) }), severity: "error", fixes: [fixMsg("edit-text")] });
  }
  const fallback = unique(coverage.fallback);
  if (fallback.length) {
    issue({ ...issueMsg("text-fallback-font", { chars: show(fallback) }), severity: "info" });
  }
  const partial = unique(coverage.partial ?? []);
  if (partial.length) issue({ ...issueMsg("text-fallback-font-partial", { chars: show(partial) }), severity: "warning" });
  const mono = unique(coverage.monochrome ?? []);
  if (mono.length) issue({ ...issueMsg("text-fallback-font-mono", { chars: show(mono) }), severity: "warning" });
  out.push(...encodingIssues(text));
  out.push(...suspicious(text));
  return out;
}

/** Şüpheli görünen ama müşterinin bilerek yazmış olabileceği durumlar: yalnızca uyarı. */
function suspicious(text: string): Issue[] {
  const out: Issue[] = [];
  const warn = (text: IssueText, fixes: Issue["fixes"] = []) => out.push({ ...text, code: "text-suspicious", severity: "warning", field: "text", fixes: [...fixes, fixMsg("dismiss")] });

  const odd = unique(text.match(ODD_SPACE) ?? []);
  if (odd.length) warn(issueMsg("text-suspicious-space", { chars: show(odd) }), [fixMsg("normalize-spaces", { value: text.replace(ODD_SPACE, " ") })]);

  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  const cased = letters.filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (cased.length >= 4 && cased.every((c) => c === c.toUpperCase())) warn(issueMsg("text-suspicious-all-caps"));

  const mixed = text.split(/[\s&+/,.;:!?()"“”«»-]+/u).filter((w) => /\p{Ll}\p{Lu}/u.test(w) && graphemes(w).length >= 3 && !NAME_PREFIX.test(w));
  if (mixed.length) warn(issueMsg("text-suspicious-mixed-case", { words: unique(mixed).map((w) => `"${w}"`).join(", ") }));

  const t = text.trim();
  if (LEAD_PUNCT.test(t)) warn(issueMsg("text-suspicious-leading-punct", { char: t[0]! }));
  if (TRAIL_PUNCT.test(t)) warn(issueMsg("text-suspicious-trailing-punct", { char: t[t.length - 1]! }));

  const unbalanced = unbalancedPairs(t);
  if (unbalanced.length) warn(issueMsg("text-suspicious-unbalanced", { chars: unbalanced.map((c) => `"${c}"`).join(", ") }));
  return out;
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "“": "”", "«": "»" };
const CLOSERS = new Map(Object.entries(PAIRS).map(([o, c]) => [c, o]));

export function unbalancedPairs(text: string): string[] {
  const stack: string[] = [];
  const bad: string[] = [];
  for (const ch of text) {
    if (ch in PAIRS) stack.push(ch);
    else if (CLOSERS.has(ch)) {
      if (stack[stack.length - 1] === CLOSERS.get(ch)) stack.pop();
      else bad.push(ch);
    }
  }
  bad.push(...stack);
  if (((text.match(/"/g) ?? []).length & 1) === 1) bad.push('"');
  return unique(bad);
}

// ---------------------------------------------------------------- kodlama sorunları (yalnız öneri)

/** Windows-1252'nin 0x80–0x9F aralığı (Latin-1'den farkı): karakter → bayt. */
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
const CP1252_CHARS = Object.keys(CP1252).join("");
/** Bayta çevrilebilen ardışık karakterler (U+0000–U+00FF ya da Windows-1252 eşlemesi olanlar). */
const BYTE_RUN = new RegExp(`[\\u0000-\\u00FF${CP1252_CHARS}]+`, "gu");
const HIGH_BYTE = new RegExp(`[\\u0080-\\u00FF${CP1252_CHARS}]`, "u");

/**
 * UTF-8 baytları Latin-1/Windows-1252 diye okunmuş metin ("â¤ï¸", "Ã¼", "ÅŸ"): bayta geri çevrilebilen ve geçerli UTF-8
 * olan parçalar çözülür. Gerçek Latin metni (Café, Ümit) geçerli UTF-8 olmadığı için dokunulmaz. Değişiklik yoksa null.
 */
export function repairMojibake(text: string): string | null {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let changed = false;
  const out = text.replace(BYTE_RUN, (run) => {
    if (!HIGH_BYTE.test(run)) return run;
    const bytes = Uint8Array.from([...run].map((ch) => CP1252[ch] ?? ch.charCodeAt(0)));
    try {
      const fixed = decoder.decode(bytes);
      if (fixed !== run) changed = true;
      return fixed;
    } catch {
      return run;
    }
  });
  return changed ? out.normalize("NFC") : null;
}

/** Yazı olarak kalmış kaçışlar: ❤, \u{1F382}, \U0001F382, &#x1F382;, &#127881;. */
const ESCAPE = /\\u\{([0-9a-fA-F]{1,6})\}|\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})|&#[xX]([0-9a-fA-F]{1,6});|&#(\d{1,7});/g;

/** Kaçışların çözülmüş hâli (vekil çiftleri birleşir); kaçış yoksa ya da sonuç bozuksa null. */
export function decodeEscapes(text: string): string | null {
  let any = false;
  const out = text.replace(ESCAPE, (m, braced?: string, long?: string, u4?: string, hex?: string, dec?: string) => {
    any = true;
    if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt((braced ?? long ?? hex)!, 16);
    return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
  if (!any || out === text || loneSurrogates(out).length) return null;
  return out.normalize("NFC");
}

/** Kodlama sorunları: yalnız uyarı ve tek tıkla uygulanabilir öneri (metin kendiliğinden değişmez). */
function encodingIssues(text: string): Issue[] {
  const out: Issue[] = [];
  const warn = (text: IssueText, fixes: Issue["fixes"]) => out.push({ ...text, code: "text-suspicious", severity: "warning", field: "text", fixes: [...fixes, fixMsg("dismiss")] });
  const mojibake = repairMojibake(text);
  if (mojibake !== null) warn(issueMsg("text-suspicious-mojibake", { fixed: mojibake }), [fixMsg("fix-encoding", { value: mojibake })]);
  const escaped = decodeEscapes(text);
  if (escaped !== null) warn(issueMsg("text-suspicious-escapes", { fixed: escaped }), [fixMsg("decode-escapes", { value: escaped })]);
  if (text.includes("�") && mojibake === null)
    warn(issueMsg("text-suspicious-replacement"), [fixMsg("edit-text")]);
  return out;
}
