import {
  type AskUserInput,
  type BuildEntry,
  BUILDER_LOOP,
  type Evidence,
  type Profile,
  ProfileSchema,
  type ProposeChangesInput,
  type ProposeChangesResult,
  type RuleChange,
  checkTextPreserved,
  isWritableProfilePath,
  parseValueJson,
  toEvidence,
  upgradeProfileInput,
} from "@tagpress/domain";
import { type BuilderToolCall, type BuilderToolContent, type BuilderToolExecutor, type BuilderToolResult, escapeData, formatProfile, preservationSymbols, schemaFields } from "@tagpress/ai";
import type { StyleMeasurement } from "@tagpress/learn";
import { mergePatch } from "../session.ts";
import { ruleChanges } from "./revisions.ts";

/**
 * Oluşturucu modelinin araçlarını çalıştırır (SUNUCU-PLANI §4.3; "uydurma değer yazılmaz" kuralının zorlandığı yer).
 * Girdiler döngüde zod ile DOĞRULANMIŞTIR (`validateBuilderToolUse`); burada iş kuralları denetlenir.
 *
 * `propose_changes` her değişikliği sırayla, öncekilerin kabul edildiği taslak üzerinde denetler:
 *  1. yol yazılabilir mi (`isWritableProfilePath`; ad ve tasarım alanı yok) → `path-not-allowed`
 *  2. `value_json` ayrışıyor mu → `invalid-json`
 *  3. kanıt: ölçüm anahtarı SON ölçümde var mı (`n` ölçümden yazılır; modelin verdiği yok sayılır) →
 *     `unknown-measurement`; girdi kimliği BU oturumun kullanıcı girdisi mi → `unknown-entry`; `default` yalnız `null`
 *     değerle → `default-not-null`
 *  4. taslağa birleştirilmiş profil `ProfileSchema`'dan geçiyor mu → `schema-invalid`
 *  5. `lineBreaking.examples`: yeni örneklerde satırlar birleşince metin harfi harfine aynı mı → `text-not-preserved`
 *  6. değer zaten aynı mı → `no-change`
 *  7. sayısal değer ölçülen çeyrekler aralığının dışındaysa kabul edilir, `outside-measured-range` uyarısı alır.
 * En az biri kabul edilirse yeni revizyon yazılır; hiçbiri kabul edilmezse üst üste başarısızlık sayısı artar (sınıra
 * ulaşınca döngü turu bitirir, taslak bozulmaz). Hiçbir araç yayın yapmaz, ücret harcamaz, müşteri metnini değiştirmez.
 */

// ================================================================ ölçüm anahtarı

export interface MeasuredStat {
  key: string;
  value: unknown;
  n: number;
  q1: number | null;
  q3: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isCompact = (v: unknown): v is { n: number; q1: number; q3: number } => isObj(v) && typeof v.n === "number" && typeof v.q1 === "number" && typeof v.q3 === "number";

/** İstatistik düğümünün (`Compact`) kanıt olabilen yaprakları (`n` sayımdır, değer değil). */
const STAT_LEAVES = new Set(["median", "q1", "q3", "p10", "p90"]);
/** İstatistik düğümü olmayan ama istatistik olan sayılar (kullanılabilir referans sayısıyla). */
const PLAIN_STATS = new Set(["lineLength.p50", "lineLength.p90", "lineLength.max"]);
/** Kanıt olamayan dallar: sayımlar, listeler, örnek metinler, bulgu cümleleri, program ile kullanıcı karşılaştırması. */
const DENIED_ROOTS = new Set(["refs", "findings", "examples", "programVsUser"]);

/**
 * Ölçüm anahtarını çözer. Yalnız İSTATİSTİK kanıt sayılır (izin listesi):
 *  - istatistik düğümü (`{ n, median, q1, q3, p10, p90 }`; ör. `ratios.secondary`, `ratios.byConnector.&`, `gaps.normal`)
 *    ya da onun `median` / `q1` / `q3` / `p10` / `p90` yaprağı;
 *  - `lineLength.p50`, `lineLength.p90`, `lineLength.max`.
 * Sayımlar ve listeler (`refs.*`, `lineCount.0`, `fonts.*`, `templates.*`), örnek metinler (`examples`,
 * `lineLength.longest`), bulgular ve `programVsUser` kanıt değildir. Dizi içine inilmez. Değer yoksa ya da örnek
 * sayısı 0 ise null. `n` istatistiğin örnek sayısıdır; satır uzunluğunda metni ölçülen etiket sayısı.
 */
export function resolveMeasurement(m: StyleMeasurement | null, key: string): MeasuredStat | null {
  const k = key.trim();
  if (!m || !k) return null;
  const segs = k.split(".");
  if (DENIED_ROOTS.has(segs[0]!)) return null;
  let node: unknown = m;
  let parent: unknown = null;
  for (const [i, seg] of segs.entries()) {
    if (!isObj(node) || !Object.hasOwn(node, seg)) return null;
    // İstatistik düğümünden sonra yalnız bir yaprak gelebilir.
    if (isCompact(node) && (!STAT_LEAVES.has(seg) || i !== segs.length - 1)) return null;
    parent = node;
    node = (node as Record<string, unknown>)[seg];
  }
  let stat: { n: number; q1: number | null; q3: number | null } | null = null;
  if (isCompact(node)) stat = node;
  else if (isCompact(parent) && typeof node === "number" && Number.isFinite(node)) stat = parent;
  else if (PLAIN_STATS.has(k) && typeof node === "number" && Number.isFinite(node)) {
    // Satır uzunluğu metni ölçülen etiketlerden: n = o etiketlerin sayısı (satır sayısı dağılımının toplamı). Metin
    // ölçülmediyse (n 0) `max` 0'ı ölçüm değildir.
    stat = { n: m.lineCount.reduce((a, r) => a + r.count, 0), q1: null, q3: null };
  }
  if (!stat || !stat.n) return null;
  return { key: k, value: node, n: stat.n, q1: stat.q1 ?? null, q3: stat.q3 ?? null };
}

/** Ölçüm özeti metni (oturum bağlamı ve `get_measurements`; MCP `olcum_ozeti` ile aynı biçim). */
export function measurementText(m: StyleMeasurement | null): string {
  if (!m || !m.refs.usable) return "";
  const { findings, ...rest } = m;
  const notes =
    "Units: ratios are relative to the largest line; gaps are in em of the smaller of two lines; blockWidthOfCut/blockHeightOfCut relative to the cut diameter; template centre relative to the design frame (0..1). " +
    "Approximate lines are excluded from gap statistics. Only statistics count as measurement evidence: the dotted key of a statistic object ({n, median, q1, q3, p10, p90}, e.g. ratios.connector, gaps.normal) or one of its fields (e.g. ratios.secondary.median), and lineLength.p50 / lineLength.p90 / lineLength.max. Counts, lists, example texts, findings and programVsUser are not evidence.";
  // Örnek metinler ve bulgular müşteri verisidir: istemdeki gösterimde `<` ve `>` kaçırılır (veri bloğundan çıkamaz).
  return escapeData(`Findings:\n${findings.map((f) => `- ${f}`).join("\n")}\n\n${notes}\n\n${JSON.stringify(rest)}`);
}

// ================================================================ öneri denetimi (saf)

export interface ProposalEnv {
  draft: Profile;
  measurement: StyleMeasurement | null;
  /** Bu oturumun kullanıcı girdisi (yoksa null). */
  userEntry: (id: number) => BuildEntry | null;
}

export interface ProposalCheck {
  /** Kabul edilenlerle oluşan profil (hiçbiri kabul edilmediyse null). */
  profile: Profile | null;
  applied: RuleChange[];
  rejected: ProposeChangesResult["rejected"];
}

const pathPatch = (path: string, value: unknown): Record<string, unknown> => {
  const parts = path.split(".");
  let out: Record<string, unknown> = { [parts.at(-1)!]: value };
  for (let i = parts.length - 2; i >= 0; i--) out = { [parts[i]!]: out };
  return out;
};

export function checkProposal(input: ProposeChangesInput, env: ProposalEnv): ProposalCheck {
  let working: Profile = env.draft;
  const applied: RuleChange[] = [];
  const rejected: ProposalCheck["rejected"] = [];
  input.changes.forEach((c, index) => {
    const reject = (code: ProposalCheck["rejected"][number]["code"], params?: Record<string, string | number>) =>
      rejected.push({ index, path: c.path, code, ...(params ? { params } : {}) });
    if (!isWritableProfilePath(c.path)) return reject("path-not-allowed");
    const parsed = parseValueJson(c.value_json);
    if (!parsed.ok) return reject("invalid-json");
    const ev: Evidence = toEvidence(c.evidence);
    let stat: MeasuredStat | null = null;
    if (ev.kind === "default") {
      if (parsed.value !== null) return reject("default-not-null");
    } else {
      if (parsed.value === null) return reject("default-not-null");
      if (ev.kind === "measurement") {
        stat = resolveMeasurement(env.measurement, ev.key);
        if (!stat) return reject("unknown-measurement", { key: ev.key });
      } else if (!env.userEntry(ev.entryId)) {
        return reject("unknown-entry", { entryId: ev.entryId });
      }
    }
    const merged = mergePatch(working as unknown as Record<string, unknown>, pathPatch(c.path, parsed.value));
    const next = ProfileSchema.safeParse(upgradeProfileInput(merged));
    if (!next.success) {
      const issue = next.error.issues[0];
      return reject("schema-invalid", { issue: issue ? `${issue.path.join(".")}: ${issue.message}` : "?" });
    }
    if (c.path === "lineBreaking.examples" || c.path.startsWith("lineBreaking.examples.")) {
      const before = new Set(working.lineBreaking.examples.map((e) => JSON.stringify(e)));
      const symbols = preservationSymbols(next.data);
      const bad = next.data.lineBreaking.examples.findIndex((e) => !before.has(JSON.stringify(e)) && !checkTextPreserved(e.lines, e.text, symbols).ok);
      if (bad >= 0) return reject("text-not-preserved", { example: bad });
    }
    const source: RuleChange["source"] =
      ev.kind === "measurement" ? { kind: "measurement", ref: stat!.key, n: stat!.n } : ev.kind === "default" ? { kind: "default", ref: null } : { kind: ev.kind, ref: String(ev.entryId) };
    const changes = ruleChanges(working, next.data, () => source);
    if (!changes.length) return reject("no-change");
    if (stat && typeof parsed.value === "number" && stat.q1 !== null && stat.q3 !== null && (parsed.value < stat.q1 || parsed.value > stat.q3)) {
      for (const ch of changes) ch.warning = { code: "outside-measured-range", params: { q1: stat.q1, q3: stat.q3, n: stat.n } };
    }
    applied.push(...changes);
    working = next.data;
  });
  return { profile: applied.length ? working : null, applied, rejected };
}

// ================================================================ çalıştırıcı

/** Turun başında kurulan araç ortamı (servis doldurur). */
export interface ToolsEnv {
  base: Profile;
  /** Taslak (son revizyon); öneri kabul edilince `writeRevision` sonrası güncellenir. */
  draft: Profile;
  measurement: StyleMeasurement | null;
  userEntry: (id: number) => BuildEntry | null;
  /** Modele gösterilebilen örnekler ve referanslar (ayrılmış küme YOK). */
  samples: (limit: number, ids?: readonly string[]) => Promise<BuilderToolContent[]>;
  templates: (keys?: readonly string[]) => Promise<BuilderToolContent[]>;
  engineTrial: (split: "test" | "all", limit: number, profile: Profile, signal: AbortSignal) => Promise<string>;
  /** Kabul edilen önerinin revizyonunu yazar; yeni revizyon numarasını döner. */
  writeRevision: (profile: Profile, changes: RuleChange[], note: string) => number;
}

const text = (t: string): BuilderToolContent => ({ type: "text", text: t });

export class BuilderTools implements BuilderToolExecutor {
  /** Bu turdaki üst üste başarısız öneri sayısı. */
  failedStreak = 0;
  /** Bu turda yazılan revizyonlar. */
  readonly revisions: number[] = [];
  /** Doğrulamayı geçemeyen alanlar (tur sonu bildirimi). */
  readonly failedPaths = new Set<string>();

  constructor(private readonly env: ToolsEnv) {}

  /** Turun başındaki ölçüm (soruların ölçülen değeri bundan yazılır). */
  get measurement(): StyleMeasurement | null {
    return this.env.measurement;
  }

  async execute(call: BuilderToolCall, ctx: { signal: AbortSignal; round: number }): Promise<BuilderToolResult> {
    const e = this.env;
    switch (call.name) {
      case "read_profile": {
        const p = call.input.source === "base" ? e.base : e.draft;
        const body = formatProfile({ id: "", languageId: "", version: 0, status: "draft", data: p, note: "", createdAt: "" }, call.input.group);
        return { content: [text(body.trim() || "(no fields in this group)")] };
      }
      case "profile_schema": {
        const group = call.input.group;
        const rows = schemaFields().filter((f) => isWritableProfilePath(String(f.path)) && (!group || f.group === group));
        return { content: [text(JSON.stringify(rows))] };
      }
      case "get_samples":
        return { content: await e.samples(call.input.limit, call.input.ids) };
      case "get_measurements": {
        const t = measurementText(e.measurement);
        return { content: [text(t || "No measurable samples or references yet. Do not use measurement evidence; ask the user instead.")] };
      }
      case "get_templates":
        return { content: await e.templates(call.input.keys) };
      case "engine_trial":
        try {
          return { content: [text(await e.engineTrial(call.input.split, call.input.limit, e.draft, ctx.signal))] };
        } catch (err) {
          return { isError: true, content: [text(`The engine trial could not run: ${err instanceof Error ? err.message : String(err)}`)] };
        }
      case "propose_changes":
        return { proposal: this.propose(call.input) };
      case "ask_user":
        return this.ask(call.input);
    }
  }

  private propose(input: ProposeChangesInput): ProposeChangesResult {
    const r = checkProposal(input, { draft: this.env.draft, measurement: this.env.measurement, userEntry: this.env.userEntry });
    if (!r.profile) {
      this.failedStreak++;
      for (const x of r.rejected) this.failedPaths.add(x.path);
      return { rev: null, applied: [], rejected: r.rejected, failedStreak: this.failedStreak };
    }
    this.failedStreak = 0;
    for (const a of r.applied) this.failedPaths.delete(a.path);
    const rev = this.env.writeRevision(r.profile, r.applied, input.note.trim());
    this.env.draft = r.profile;
    this.revisions.push(rev);
    return { rev, applied: r.applied, rejected: r.rejected, failedStreak: 0 };
  }

  private ask(input: AskUserInput): BuilderToolResult {
    const unknown = input.questions.filter((q) => q.measured && !resolveMeasurement(this.env.measurement, q.measured.key));
    if (unknown.length) {
      return {
        isError: true,
        content: [text(`Unknown measurement key(s): ${unknown.map((q) => `${q.id} → ${q.measured!.key}`).join(", ")}. Use a key from get_measurements or leave "measured" out.`)],
      };
    }
    return { content: [text("The questions are shown to the user. Your turn ends here; the answers come in the next message.")] };
  }
}

export const MAX_FAILED_PROPOSALS = BUILDER_LOOP.maxFailedProposals;
