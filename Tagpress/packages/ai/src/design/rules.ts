import { graphemes, type Issue, type IssueCode, type IssueText, isInitialsOnly, issueMsg, type LineRole, type Profile, type Tier } from "@tagpress/domain";

/**
 * Satır bölme kurallarının METİN DÜZEYİ denetimi (profilden; kod eşik/bağlaç bilmez).
 *
 * Not: engine paketi `checkIntentRules(intent, text, profile)` dışa açacak. O hazır olunca sunucu ikisini
 * birleştirebilir; bu fonksiyon AI adaylarını onarıma göndermek için gereken asgari denetimdir.
 */

export interface RuleLine {
  text: string;
  role: LineRole;
  tier: Tier;
}

export interface RuleProblem {
  issue: Issue;
  /** Onarımda modele gidecek İngilizce açıklama. */
  hint: string;
}

const problem = (code: IssueCode, severity: Issue["severity"], text: IssueText, hint: string, field?: string): RuleProblem => ({
  issue: { ...text, code, severity, fixes: [], ...(field ? { field } : {}) },
  hint,
});

const norm = (w: string) => w.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
const words = (s: string) => s.trim().split(/\s+/u).filter(Boolean);
/** Yalnızca harf/rakam, küçük harf kelimeler (noktalama ve tek başına semboller yok sayılır). */
const letterWords = (s: string) => words(s).map((w) => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);

export function isConnectorLine(text: string, connectors: readonly string[]): boolean {
  const t = text.trim().toLocaleLowerCase();
  return connectors.some((c) => c.toLocaleLowerCase() === t);
}

const DATE_RE = /\b\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,4})?\b/u;
const INITIAL_RE = /^\p{Lu}\.?$/u;

/** Müşteri bölmelerinin sınırları: boşluksuz karakter sayısıyla konumlar. */
function boundaries(parts: readonly string[]): Set<number> {
  const out = new Set<number>();
  let pos = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    pos += [...parts[i]!.replace(/\s+/gu, "")].length;
    out.add(pos);
  }
  return out;
}

export function checkIntentText(lines: readonly RuleLine[], text: string, segments: readonly string[], profile: Profile): RuleProblem[] {
  const lb = profile.lineBreaking;
  const conn = profile.connectors.words;
  const out: RuleProblem[] = [];

  if (lines.length > lb.maxLines) {
    out.push(problem("rule-too-many-lines", "error", issueMsg("rule-too-many-lines-ai", { lines: lines.length, max: lb.maxLines }), `${lines.length} lines; the maximum is ${lb.maxLines}.`));
  }

  const lone = new Set(lb.noLoneWords.map(norm));
  lines.forEach((l, i) => {
    const n = graphemes(l.text.trim()).length;
    if (n > lb.maxLineChars) {
      out.push(problem("rule-line-too-long", "error", issueMsg("rule-line-too-long", { line: i + 1, chars: n, max: lb.maxLineChars }), `line ${i + 1} ("${l.text}") has ${n} characters; the limit is ${lb.maxLineChars}.`, String(i)));
    }
    const ws = words(l.text);
    if (lone.size && ws.length) {
      // Yalnızca "tek başına satır" kesin kuraldır. Edatın hangi yana (önceki/sonraki satıra) yapışacağı tarzdır:
      // profil örneklerinden ve benzer örneklerden gelir (ör. isim kendi satırındaysa edat önceki satırın sonunda kalır).
      if (ws.length === 1 && lone.has(norm(ws[0]!))) {
        out.push(problem("rule-lone-word", "error", issueMsg("rule-lone-word-ai", { text: l.text }), `"${l.text}" may not stand alone on a line.`, String(i)));
      }
    }
  });

  if (lb.keepShortGreetings) {
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = lines[i]!;
      const b = lines[i + 1]!;
      if (a.role !== "greeting" || b.role !== "greeting") continue;
      const joined = `${a.text.trim()} ${b.text.trim()}`;
      if (words(joined).length <= 3 && graphemes(joined).length <= lb.maxLineChars) {
        out.push(problem("rule-split-greeting", "error", issueMsg("rule-split-greeting", { first: a.text, second: b.text }), `the short greeting "${joined}" is split; keep it on one line.`, String(i)));
      }
    }
  }

  // Tasarımcının kendi örneğinde TEK satırda duran kısa ifade (ör. "Thank You" → "Thank You") hiçbir adayda bölünmez.
  // Genel kısa selam kuralı kapalı olsa da geçerlidir (bazı selamlar bölünür, bazıları asla). İfadeler profil
  // örneklerinden gelir; kod hiçbir selam kelimesi bilmez. Ölçüm: kural kapalıyken öğrenme kümesinde "Thank / You" çıktı.
  const seq = lines.flatMap((l, i) => letterWords(l.text).map((w) => ({ w, i })));
  for (const ex of lb.examples) {
    if (ex.lines.length !== 1) continue;
    const phrase = letterWords(ex.text);
    if (phrase.length < 2 || phrase.length > 3) continue;
    for (let s = 0; s + phrase.length <= seq.length; s++) {
      if (!phrase.every((w, j) => seq[s + j]!.w === w)) continue;
      const first = seq[s]!.i;
      const last = seq[s + phrase.length - 1]!.i;
      if (first !== last) {
        out.push(
          problem("rule-split-greeting", "error", issueMsg("rule-split-greeting-example", { text: ex.text }), `"${ex.text}" stays on ONE line in the designer's own example; do not split it.`, String(first)),
        );
      }
      break;
    }
  }

  if (profile.sizing.initials.oneLine) {
    if (isInitialsOnly(text, conn) && lines.length > 1) {
      out.push(problem("rule-initials-split", "error", issueMsg("rule-initials-split-connector"), "initials joined by a connector must stay on ONE line."));
    } else {
      for (let i = 0; i + 1 < lines.length; i++) {
        const a = lines[i]!.text.trim();
        const b = lines[i + 1]!.text.trim();
        const initialPair = (INITIAL_RE.test(a) && (isConnectorLine(b, conn) || INITIAL_RE.test(b))) || (isConnectorLine(a, conn) && INITIAL_RE.test(b));
        if (initialPair) {
          out.push(problem("rule-initials-split", "error", issueMsg("rule-initials-split-stacked"), `initials are stacked ("${a}" / "${b}"); keep them on one line.`, String(i)));
          break;
        }
      }
    }
  }

  // Çift isimleri: profilin dizilişi.
  const nameLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.role === "name");
  if (lb.coupleStack === "always" && !isInitialsOnly(text, conn)) {
    for (const { l, i } of nameLines) {
      const ws = words(l.text);
      if (ws.length >= 3 && ws.slice(1, -1).some((w) => isConnectorLine(w, conn))) {
        out.push(problem("rule-couple-stack", "error", issueMsg("rule-couple-stack", { text: l.text }), `"${l.text}": stack the names as name / connector / name.`, String(i)));
      }
    }
  }
  if (lb.coupleStack === "never") {
    for (let i = 1; i + 1 < lines.length; i++) {
      if (isConnectorLine(lines[i]!.text, conn) && lines[i - 1]!.role === "name" && lines[i + 1]!.role === "name") {
        out.push(problem("rule-couple-stack", "error", issueMsg("rule-couple-stack-connector"), "do not put the connector alone between the names; keep the couple on one line.", String(i)));
      }
    }
  }

  if (lb.nameOwnLine) {
    for (const { l, i } of nameLines) {
      if (l.tier !== "primary") {
        out.push(problem("rule-name-not-own-line", "warning", issueMsg("rule-name-not-own-line-ai", { text: l.text }), `the name line "${l.text}" should be tier "primary".`, String(i)));
      }
    }
  }

  if (lb.dateOwnLine) {
    lines.forEach((l, i) => {
      const m = l.text.match(DATE_RE);
      if (!m) return;
      const rest = l.text.replace(m[0], "");
      if (/\p{L}{2,}/u.test(rest)) {
        out.push(problem("rule-date-own-line", "error", issueMsg("rule-date-own-line-ai", { date: m[0] }), `the date "${m[0]}" must stand on its own line.`, String(i)));
      }
    });
  }

  if (lb.customerBreaks === "strict" && segments.length > 1) {
    const need = boundaries(segments);
    const have = boundaries(lines.map((l) => l.text));
    const missing = [...need].filter((b) => !have.has(b));
    if (missing.length) {
      out.push(problem("rule-customer-break", "error", issueMsg("rule-customer-break-ai"), "every boundary between the customer's segments must be a line break.", undefined));
    }
  }

  return out;
}
