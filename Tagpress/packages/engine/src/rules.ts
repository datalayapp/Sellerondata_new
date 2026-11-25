import { type DesignIntent, type Issue, type Profile, canonicalText, checkTextPreserved, graphemes, fixMsg, isInitialsOnly, issueMsg, normalizeText, ptToPx, withoutStyled } from "@tagpress/domain";
import type { FontRegistry } from "@tagpress/typeset";
import { isConnectorText, issue, symbolConnectors } from "./compose.ts";

/**
 * rules: niyeti profile göre denetler. Motor (`layout`), AI akışı ve içe aktarma aynı fonksiyonları kullanır.
 * Bütün eşikler profilden gelir; kod hiçbir bağlaç, kelime ya da font adı bilmez.
 */

/** Gün.ay.yıl biçimli tarih (12.10.2026, 12/10/26, 12-10-2026). */
const DATE_RE = /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/u;
const lineNo = (i: number) => `line:${i + 1}`;
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, "");

/** Satır bölme kuralları (yalnızca niyet ve metinden; font ya da geometri gerekmez). */
export function checkIntentRules(intent: DesignIntent, text: string, profile: Profile): Issue[] {
  const out: Issue[] = [];
  const lines = intent.lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
  const lb = profile.lineBreaking;
  const preserved = checkTextPreserved(lines.map((l) => l.text), text, symbolConnectors(profile));
  if (!preserved.ok) out.push(issue("text-changed", "error", preserved.params ? issueMsg("text-changed", preserved.params) : issueMsg("text-changed-lines"), "text", [fixMsg("regenerate")]));

  if (lines.length > lb.maxLines) out.push(issue("rule-too-many-lines", "warning", issueMsg("rule-too-many-lines", { lines: lines.length, max: lb.maxLines }), "lines", [fixMsg("regenerate")]));

  lines.forEach((l, i) => {
    const n = graphemes(l.text).length;
    if (n > lb.maxLineChars) out.push(issue("rule-line-too-long", "warning", issueMsg("rule-line-too-long", { line: i + 1, chars: n, max: lb.maxLineChars }), lineNo(i)));
  });

  if (lb.noLoneWords.length && lines.length > 1) {
    const lone = new Set(lb.noLoneWords.map(bare));
    lines.forEach((l, i) => {
      if (lone.has(bare(l.text)) && !isConnectorText(l.text, profile)) out.push(issue("rule-lone-word", "warning", issueMsg("rule-lone-word", { text: l.text }), lineNo(i)));
    });
  }

  if (lb.nameOwnLine) {
    const rank = { primary: 0, secondary: 1, tertiary: 2, connector: 3 } as const;
    const best = Math.min(...lines.map((l) => rank[l.tier]));
    lines.forEach((l, i) => {
      if (l.role !== "name") return;
      if (rank[l.tier] > best && lines.some((o) => o.role !== "name" && rank[o.tier] < rank[l.tier]))
        out.push(issue("rule-name-not-own-line", "warning", issueMsg("rule-name-not-own-line", { text: l.text }), lineNo(i)));
      // İsim satırında küçük harfle başlayan, bağlaç olmayan kelime: başka bir ifade isimle aynı satıra girmiş.
      const words = l.text.split(/\s+/u).filter(Boolean);
      const stray = words.filter((w) => /^\p{Ll}/u.test(w) && !isConnectorText(w, profile));
      if (stray.length) out.push(issue("rule-name-not-own-line", "warning", issueMsg("rule-name-not-own-line-extra", { words: stray.join(", ") }), lineNo(i)));
    });
  }

  if (lb.keepShortGreetings) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1]!, b = lines[i]!;
      if (a.role === "greeting" && b.role === "greeting" && a.text.split(/\s+/u).length + b.text.split(/\s+/u).length <= 3)
        out.push(issue("rule-split-greeting", "warning", issueMsg("rule-split-greeting", { first: a.text, second: b.text }), lineNo(i)));
    }
  }

  if (lb.dateOwnLine) {
    lines.forEach((l, i) => {
      const date = DATE_RE.exec(l.text);
      if (date && /\p{L}{2,}/u.test(l.text.replace(DATE_RE, ""))) out.push(issue("rule-date-own-line", "warning", issueMsg("rule-date-own-line", { text: l.text }), lineNo(i)));
    });
  }

  if (lb.customerBreaks === "strict") {
    // Müşterinin verdiği her parça, satırların birleşimi olarak geri çıkmalı (bir satır iki parçaya yayılmamalı).
    const symbols = symbolConnectors(profile);
    const segs = normalizeText(text).segments.map((s) => canonicalText(s, symbols));
    let si = 0;
    let acc = "";
    for (const [i, l] of lines.entries()) {
      acc = canonicalText(acc ? `${acc} ${l.text}` : l.text, symbols);
      const seg = segs[si];
      if (seg === undefined) break;
      if (acc === seg) {
        si++;
        acc = "";
      } else if (!seg.startsWith(acc)) {
        out.push(issue("rule-customer-break", "warning", issueMsg("rule-customer-break", { line: i + 1 }), lineNo(i)));
        break;
      }
    }
  }

  if (profile.sizing.initials.oneLine && lines.length > 1 && isInitialsOnly(text, profile.connectors.words))
    out.push(issue("rule-initials-split", "warning", issueMsg("rule-initials-split"), "lines"));

  return out;
}

/** Font politikası: profilde olmayan/kapalı font, yalnızca glif kuralı fontu, büyük harf sınırı, aile sayısı. */
export function checkFontPolicy(intent: DesignIntent, text: string, profile: Profile, fonts?: FontRegistry): Issue[] {
  const out: Issue[] = [];
  const families = new Set<string>();
  const seen = new Set<string>();
  intent.lines.forEach((l, i) => {
    const entry = profile.fonts.list.find((f) => f.id === l.fontId);
    if (!entry) {
      out.push(issue("font-unavailable", "error", issueMsg("font-unavailable-unknown", { font: l.fontId }), lineNo(i)));
      return;
    }
    families.add(entry.family);
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    if (!entry.enabled) out.push(issue("font-unavailable", "error", issueMsg("font-unavailable-disabled", { font: entry.id }), lineNo(i)));
    else if (!entry.roles.length) out.push(issue("font-unavailable", "error", issueMsg("font-unavailable-special", { font: entry.id }), lineNo(i)));
    if (fonts && !fonts.has(entry.id)) out.push(issue("font-unavailable", "error", issueMsg("font-unavailable-missing", { font: entry.id }), lineNo(i)));
    if (entry.maxUppercaseRun !== null) {
      // Süslü harfler (𝐊𝐄𝐑𝐄𝐌, Ａ) tasarım fontuyla değil yedek fontla basılır; sınır yalnız düz yazıya bakar.
      const longest = Math.max(0, ...(withoutStyled(text).match(/\p{Lu}+/gu) ?? []).map((m) => [...m].length));
      if (longest > entry.maxUppercaseRun)
        out.push(issue("font-unavailable", "error", issueMsg("font-unavailable-uppercase", { font: entry.id, run: longest, max: entry.maxUppercaseRun }), lineNo(i)));
    }
  });
  const limit = profile.fonts.mixing === "single" ? 1 : profile.fonts.mixing === "two" ? 2 : Infinity;
  if (families.size > limit) out.push(issue("font-mixing", "error", issueMsg("font-mixing", { limit, count: families.size }), "fonts"));
  return out;
}

/** Yerleşim sonrası: okunurluk ve yedek font bilgisi. */
export function checkLayoutIssues(profile: Profile, smallestPx: number, fallbackChars: readonly string[]): Issue[] {
  const out: Issue[] = [];
  const readable = ptToPx(profile, profile.quality.readableMinPt);
  if (smallestPx > 0 && smallestPx < readable) {
    const pt = (smallestPx / ptToPx(profile, 1)).toFixed(1);
    out.push(issue("text-too-small", "warning", issueMsg("text-too-small", { pt, min: profile.quality.readableMinPt }), "lines", [fixMsg("revise")]));
  }
  if (fallbackChars.length) out.push(issue("text-fallback-font", "info", issueMsg("text-fallback-font-used", { chars: fallbackChars.join(" ") }), "text"));
  return out;
}

/**
 * Emoji uyarıları (görünür, basımı durdurmaz): fontta tek parça olmayan küme bileşenleri yan yana basılır (🐦+ZWJ+🔥 → 🐦 🔥);
 * renkli fontta olmayan emoji tek renk basılır. Kod `text-fallback-font` (yedek font konusu), önem "warning".
 */
export function glyphWarnings(partial: readonly string[], monochrome: readonly string[]): Issue[] {
  const out: Issue[] = [];
  if (partial.length)
    out.push(issue("text-fallback-font", "warning", issueMsg("text-fallback-font-partial-used", { chars: partial.join(" ") }), "text", [fixMsg("fix-text")]));
  if (monochrome.length)
    out.push(issue("text-fallback-font", "warning", issueMsg("text-fallback-font-mono-used", { chars: monochrome.join(" ") }), "text", [fixMsg("fix-text")]));
  return out;
}
