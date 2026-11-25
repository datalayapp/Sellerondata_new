import { checkTextPreserved, type DesignIntent, DesignIntentSchema, type Issue, type IssueText, issueMsg, type Profile } from "@tagpress/domain";
import { formatZodIssues } from "../json.ts";
import { preservationSymbols, ROLES_FOR_TIER } from "../profile-rules.ts";
import type { FontAvailability } from "./fonts.ts";
import { defaultTier, type DesignWire, type WireCandidate } from "./prompt.ts";
import { checkIntentText } from "./rules.ts";

export interface DesignCandidate {
  intent: DesignIntent;
  /** Reddettirmeyen uyarılar. */
  warnings: Issue[];
}

export interface RejectedCandidate {
  /** Yanıttaki sırası (0'dan). */
  index: number;
  rationale: string;
  issues: Issue[];
}

export interface CandidateCheck {
  valid: DesignCandidate[];
  rejected: RejectedCandidate[];
  /** Onarım isteminde modele gidecek sorunlar (İngilizce). */
  repairIssues: string[];
}

export interface ValidateOptions {
  text: string;
  segments: readonly string[];
  profile: Profile;
  fonts: readonly FontAvailability[];
  wire: DesignWire;
  /** Önceki varyasyonlar: aynısı "yinelenen" sayılır (revizyonda verilmez). */
  previous?: ReadonlyArray<{ lines: string[] }>;
  /**
   * Ek kural denetimi (ör. engine `checkIntentRules`). Sunucu enjekte eder; ai paketi engine'e bağımlı değildir.
   * Hata önemindeki sorunlar adayı reddettirir; yerel denetimle aynı koddaki sorunlar tekrar eklenmez.
   */
  extraRules?: IntentRules;
}

export type IntentRules = (intent: DesignIntent, text: string, profile: Profile) => Issue[];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const signature = (lines: readonly string[]) => lines.map((l) => l.replace(/\s+/gu, " ").trim()).join("\n");

/** Tel adayını domain niyetine çevirir (tier yoksa rolden, boyutlar en büyük satır = 1 olacak şekilde). */
export function wireToIntent(c: WireCandidate): DesignIntent {
  const sizes = c.lines.map((l) => ("size" in l && typeof l.size === "number" && l.size > 0 ? l.size : null));
  const top = Math.max(0, ...sizes.map((s) => s ?? 0));
  const fill = "fill" in c && typeof c.fill === "number" ? clamp(c.fill, 0.3, 1) : undefined;
  return DesignIntentSchema.parse({
    lines: c.lines.map((l, i) => ({
      text: l.text,
      role: l.role,
      tier: l.tier ?? defaultTier(l.role),
      fontId: l.fontId,
      ...(sizes[i] && top > 0 ? { size: Math.round(clamp(sizes[i]! / top, 0.15, 1) * 100) / 100 } : {}),
    })),
    ...(fill !== undefined ? { fill } : {}),
    rationale: c.rationale.trim(),
  });
}

const issue = (code: Issue["code"], text: IssueText, field?: string): Issue => ({ ...text, code, severity: "error", fixes: [], ...(field ? { field } : {}) });

/**
 * Adayları doğrular: metin koruma (sembol bağlaçlarla), font (var mı, kullanılabilir mi, rolü uygun mu),
 * aile karışımı, profilin satır bölme kurallarının metin düzeyi denetimi, yinelenme.
 */
export function validateCandidates(raw: readonly unknown[], o: ValidateOptions): CandidateCheck {
  const valid: DesignCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const repairIssues: string[] = [];
  const fonts = new Map(o.fonts.map((f) => [f.id, f]));
  // Önceki varyasyonlarla aynı satır bölmesi yinelenmedir. Adaylar arasında ise satırlar + font + sınıf birlikte
  // karşılaştırılır: çeşitlilik font/sınıf ekseninde de olabilir; kullanıcının en olası bölmesi tek adaya sıkışmaz.
  const seenPrevious = new Set((o.previous ?? []).map((p) => signature(p.lines)));
  const seen = new Set<string>();
  const symbols = preservationSymbols(o.profile);

  raw.forEach((item, index) => {
    const label = `Candidate ${index + 1}`;
    const problems: Issue[] = [];
    const hints: string[] = [];
    const parsed = o.wire.candidate.safeParse(item);
    if (!parsed.success) {
      const z = formatZodIssues(parsed.error, 5);
      rejected.push({ index, rationale: "", issues: [issue("ai-failed", issueMsg("ai-failed-format", { detail: z.join("; ") }))] });
      repairIssues.push(`${label}: invalid shape — ${z.join("; ")}`);
      return;
    }
    const c = parsed.data;
    if (!c.lines.length || c.lines.some((l) => !l.text.trim())) {
      problems.push(issue("ai-failed", issueMsg("ai-failed-empty-line")));
      hints.push("every line must contain text");
    }

    const lineTexts = c.lines.map((l) => l.text);
    const kept = checkTextPreserved(lineTexts, o.text, symbols);
    if (!kept.ok) {
      problems.push(issue("text-changed", kept.params ? issueMsg("text-changed", kept.params) : issueMsg("text-changed-customer")));
      hints.push(`the lines do not reproduce the customer's text exactly (${kept.problem}). Only choose line breaks; copy every character.`);
    }

    const families = new Set<string>();
    c.lines.forEach((l, i) => {
      const f = fonts.get(l.fontId);
      const tier = l.tier ?? defaultTier(l.role);
      if (!f) {
        problems.push(issue("font-unavailable", issueMsg("font-unavailable-catalog", { font: l.fontId }), String(i)));
        hints.push(`line ${i + 1} uses "${l.fontId}", which is not in the catalog`);
        return;
      }
      families.add(f.family);
      if (!f.usable) {
        problems.push(issue("font-unavailable", issueMsg("font-unavailable-job", { font: f.id, reason: f.reason ?? "" }), String(i)));
        hints.push(`line ${i + 1} uses "${f.id}", which is not usable for this job (${f.aiReason ?? "blocked"})`);
      } else if (!ROLES_FOR_TIER[tier].some((r) => f.roles.includes(r))) {
        problems.push(issue("font-unavailable", issueMsg("font-unavailable-tier", { font: f.id, tier, roles: f.roles.join(", ") }), String(i)));
        hints.push(`line ${i + 1} is tier "${tier}" but "${f.id}" has roles ${f.roles.join("/")}; allowed roles for that tier: ${ROLES_FOR_TIER[tier].join("/")}`);
      }
    });
    const maxFamilies = o.profile.fonts.mixing === "single" ? 1 : o.profile.fonts.mixing === "two" ? 2 : Infinity;
    if (families.size > maxFamilies) {
      problems.push(issue("font-mixing", issueMsg("font-mixing-candidate", { limit: maxFamilies, families: [...families].join(", ") })));
      hints.push(`uses ${families.size} font families (${[...families].join(", ")}); at most ${maxFamilies} allowed`);
    }

    const rules = checkIntentText(
      c.lines.map((l) => ({ text: l.text, role: l.role, tier: l.tier ?? defaultTier(l.role) })),
      o.text,
      o.segments,
      o.profile,
    );
    const warnings: Issue[] = [];
    for (const r of rules) {
      if (r.issue.severity === "error") {
        problems.push(r.issue);
        hints.push(r.hint);
      } else warnings.push(r.issue);
    }

    if (o.extraRules && !problems.some((p) => p.code === "text-changed")) {
      try {
        const have = new Set(problems.map((p) => `${p.code}:${p.field ?? ""}`));
        for (const x of o.extraRules(wireToIntent(c), o.text, o.profile)) {
          if (have.has(`${x.code}:${x.field ?? ""}`) || problems.some((p) => p.code === x.code && x.field === undefined)) continue;
          if (x.severity === "error") {
            problems.push(x);
            hints.push(x.message);
          } else if (!warnings.some((w) => w.code === x.code)) warnings.push(x);
        }
      } catch {
        /* ek denetim çalışmazsa yerel denetim yeterli */
      }
    }

    if (!problems.length) {
      const sig = `${signature(lineTexts)}\n${c.lines.map((l) => `${fonts.get(l.fontId)?.family ?? l.fontId}:${l.tier ?? defaultTier(l.role)}`).join("|")}`;
      if (seenPrevious.has(signature(lineTexts))) {
        problems.push({ ...issue("ai-duplicate", issueMsg("ai-duplicate-lines")), severity: "warning" });
        hints.push("same line breaks as a variant already shown; make it clearly different");
      } else if (seen.has(sig)) {
        problems.push({ ...issue("ai-duplicate", issueMsg("ai-duplicate")), severity: "warning" });
        hints.push("same line breaks, fonts and tiers as another candidate; make it clearly different");
      } else seen.add(sig);
    }

    if (problems.length) {
      rejected.push({ index, rationale: c.rationale, issues: problems });
      repairIssues.push(`${label}: ${hints.join("; ")}`);
      return;
    }
    try {
      valid.push({ intent: wireToIntent(c), warnings });
    } catch (err) {
      rejected.push({ index, rationale: c.rationale, issues: [issue("ai-failed", issueMsg("ai-failed-intent", { detail: (err as Error).message }))] });
      repairIssues.push(`${label}: could not be converted`);
    }
  });
  return { valid, rejected, repairIssues };
}
