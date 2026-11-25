import { type DesignIntent, fixMsg, type Issue, issueMsg, type Usage } from "@tagpress/domain";
import type { CallLog, ClaudePort, ContentPart, ProgressEvent } from "../claude.ts";
import { describeKind } from "../errors.ts";
import type { DesignContext } from "./context.ts";
import { fontCatalog } from "./fonts.ts";
import { buildDesignSystem, buildDesignUser, DESIGN_PROMPT_VERSION, designWire } from "./prompt.ts";
import { type DesignCandidate, type IntentRules, type RejectedCandidate, validateCandidates } from "./validate.ts";

export interface DesignResult {
  /** En az bir geçerli aday var mı? */
  ok: boolean;
  candidates: DesignCandidate[];
  /** Kolaylık: `candidates[].intent`. */
  intents: DesignIntent[];
  rejected: RejectedCandidate[];
  /** İş düzeyi sorunlar (ai-failed, ai-no-good-candidate, font-unavailable). */
  issues: Issue[];
  usage: Usage[];
  /** Son ham yanıt. */
  raw: string;
  attempts: number;
  ms: number;
  promptVersion: string;
  calls: CallLog[];
  /** Kayıt/günlük için gönderilen istem. */
  request: { system: string; user: string; images: number };
  /** Ayar hatası (anahtar/kota) mı? Sunucu işi açıkça başarısız saymalı. */
  configError: boolean;
}

export interface ProposeOptions {
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  /** İlk çıktı bütçesi (varsayılan 8000; kesilmede ikiye katlanır). */
  maxTokens?: number;
  maxRepairs?: number;
  /** Ek kural denetimi: sunucu engine'in `checkIntentRules`'ını buraya verir. */
  extraRules?: IntentRules;
}

/**
 * AI'dan tasarım niyeti adayları ister, doğrular; hiç geçerli aday yoksa önceki ham yanıt + sorunlarla
 * onarım ister. AI asla piksel/punto/konum üretmez.
 */
export async function proposeDesigns(claude: ClaudePort, ctx: DesignContext, opts: ProposeOptions = {}): Promise<DesignResult> {
  const started = Date.now();
  const fonts = ctx.fonts ?? fontCatalog(ctx.profile, ctx.text);
  const usable = fonts.filter((f) => f.usable).map((f) => f.id);
  const segments = ctx.segments ?? [];
  const system = buildDesignSystem(ctx.profile, fonts);
  const user = buildDesignUser(ctx, fonts);
  const imgs = ctx.images ?? {};
  const imageList = [imgs.template, imgs.area, ...(imgs.references ?? []), imgs.revisionBase].filter((b): b is Buffer => !!b);
  const base = {
    candidates: [] as DesignCandidate[],
    intents: [] as DesignIntent[],
    rejected: [] as RejectedCandidate[],
    usage: [] as Usage[],
    raw: "",
    attempts: 0,
    promptVersion: DESIGN_PROMPT_VERSION,
    calls: [] as CallLog[],
    request: { system, user, images: imageList.length },
    configError: false,
  };

  if (!usable.length) {
    return {
      ...base,
      ok: false,
      ms: Date.now() - started,
      issues: [{ ...issueMsg("font-unavailable-none"), severity: "error", fixes: [] }],
    };
  }

  const wire = designWire(ctx.profile, usable);
  const check = (raw: readonly unknown[]) =>
    validateCandidates(raw, {
      text: ctx.text,
      segments,
      profile: ctx.profile,
      fonts,
      wire,
      ...(ctx.revision ? {} : { previous: ctx.previous ?? [] }),
      ...(opts.extraRules ? { extraRules: opts.extraRules } : {}),
    });
  const content: ContentPart[] = [{ type: "text", text: user }, ...imageList.map((png) => ({ type: "image" as const, png }))];

  const res = await claude.callJson({
    purpose: "design",
    system,
    content,
    schema: wire.response,
    jsonSchema: wire.jsonSchema,
    maxTokens: opts.maxTokens ?? 8000,
    cacheSystem: true,
    ...(opts.maxRepairs !== undefined ? { maxRepairs: opts.maxRepairs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    validate: (data) => {
      const v = check(data.candidates);
      return { ok: v.valid.length > 0, issues: v.repairIssues.length ? v.repairIssues : ["No candidates were returned."] };
    },
  });

  const v = res.data ? check(res.data.candidates) : { valid: [], rejected: [], repairIssues: [] };
  const issues: Issue[] = [];
  if (!v.valid.length) {
    if (res.error && res.error.kind !== "invalid-response") {
      issues.push({
        ...(res.error.config
          ? issueMsg("ai-unavailable", { reason: describeKind(res.error.kind), detail: res.error.message })
          : issueMsg("ai-call-failed", { detail: res.error.message })),
        severity: "error",
        fixes: res.error.config ? [] : [fixMsg("retry")],
      });
    } else {
      const detail = v.rejected
        .flatMap((r) => r.issues.map((i) => i.message))
        .slice(0, 4)
        .join(" | ");
      issues.push({
        ...(detail ? issueMsg("ai-no-good-candidate", { detail }) : issueMsg("ai-no-good-candidate-empty")),
        severity: "error",
        fixes: [fixMsg("retry")],
      });
    }
  }
  return {
    ...base,
    ok: v.valid.length > 0,
    candidates: v.valid,
    intents: v.valid.map((c) => c.intent),
    rejected: v.rejected,
    issues,
    usage: res.usage,
    raw: res.raw,
    attempts: res.attempts,
    ms: Date.now() - started,
    calls: res.calls,
    configError: !!res.error?.config,
  };
}
