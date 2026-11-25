import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { SQLInputValue } from "node:sqlite";
import {
  type Build,
  type BuildAnswer,
  type BuildEntry,
  type BuildEntryKind,
  type BuildError,
  type BuildLabelType,
  type BuildQuestion,
  type BuildState,
  type Profile,
  ProfileSchema,
  type RevisionReason,
  type RevisionSummary,
  type RuleChange,
  type Sample,
  type Usage,
  BUILDER_API,
  apiPath,
  estimateCost,
  upgradeProfileInput,
} from "@tagpress/domain";
import { type BuilderMessage, budgetCostOf } from "@tagpress/ai";
import { json } from "../../db/database.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";
import { fail } from "../../util/errors.ts";
import { type SampleMeasurement, SampleMeasurementSchema } from "./samples.ts";

/**
 * Oluşturucunun veri katmanı (göç 13): oturum (`design_sessions`, `mode = 'site'`), akış girdileri, turlar,
 * revizyonlar, örnekler ve oturumun AI harcamaları (`ai_calls.build_id`). Bütün SQL firma kapsamlıdır (`$org`);
 * kimlikle okuma başka firmanın satırını "bulunamadı" sayar. İş kuralı yok: durum geçişleri `service.ts`'te.
 */

export interface BuildRow {
  id: string;
  language_id: string;
  state: BuildState;
  resume_state: BuildState | null;
  base: "published" | "default";
  base_version: number | null;
  base_data: string;
  current_rev: number;
  cost_usd: number;
  budget_usd: number;
  budget_raised: number;
  from_setup: number;
  label_types: string | null;
  model: string;
  prompt_version: string;
  locale: "tr" | "en";
  turn_seq: number | null;
  turn_started_at: string | null;
  turn_input: string | null;
  next_seq: number;
  notices: string | null;
  error: string | null;
  measured_at: string | null;
  quality_ai: string | null;
  /** Oturum açılırken dilin yayınlanmış sürümü (taban varsayılan olsa da; yoksa null). Yayında karşılaştırılır. */
  start_version: number | null;
  started_at: string;
  updated_at: string;
}

interface EntryRow {
  id: number;
  at: string;
  role: "user" | "assistant" | "system";
  kind: BuildEntryKind;
  grp: string | null;
  text: string;
  data: string | null;
  turn_seq: number | null;
}

/** Girdinin `data` sütunu (JSON). */
export interface EntryData {
  question?: BuildQuestion;
  answer?: BuildAnswer;
  rev?: number;
  sampleEdit?: { sampleId: string; fields: string[] };
  code?: string;
  params?: Record<string, string | number>;
}

export interface SampleRow {
  id: string;
  session_id: string;
  language_id: string;
  seq: number;
  name: string;
  w: number;
  h: number;
  status: Sample["status"];
  measurement: string | null;
  template_key: string | null;
  font_file: string | null;
  split: "train" | "test" | null;
  excluded: number;
  reference_id: string | null;
  error: string | null;
  /** Modele ilk gösterildiği an (bağlam, `get_samples`, ölçüm özeti); doluysa örnek bir daha `test` olmaz. */
  shown_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface RevisionRow {
  rev: number;
  data: string;
  changes: string;
  reason: RevisionReason;
  summary: string;
  entry_id: number | null;
  restored_from: number | null;
  cost_usd: number;
  created_at: string;
}

export interface StoredRevision {
  rev: number;
  at: string;
  reason: RevisionReason;
  summary: string;
  profile: Profile;
  changes: RuleChange[];
  entryId: number | null;
  restoredFrom: number | null;
  costUsd: number;
}

const parseProfile = (s: string): Profile => ProfileSchema.parse(upgradeProfileInput(json(s, {})));

export class BuilderStore {
  constructor(
    private readonly db: TenantDb,
    private readonly clock: Clock,
  ) {}

  now(): string {
    return this.clock.now().toISOString();
  }

  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  // ------------------------------------------------------------ oturum

  row(id: string): BuildRow {
    const r = this.db.prepare("SELECT * FROM design_sessions WHERE id = ? AND org_id = $org AND mode = 'site'").get(id) as BuildRow | undefined;
    if (!r) throw fail("build-not-found");
    return r;
  }

  /** Dilin etkin (bitmemiş) site oturumu. */
  activeRow(languageId: string): BuildRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM design_sessions WHERE language_id = ? AND org_id = $org AND mode = 'site' AND state NOT IN ('published', 'closed') ORDER BY started_at DESC LIMIT 1")
        .get(languageId) as BuildRow | undefined) ?? null
    );
  }

  insert(input: {
    languageId: string;
    state: BuildState;
    base: "published" | "default";
    baseVersion: number | null;
    baseData: Profile;
    budgetUsd: number;
    fromSetup: boolean;
    labelTypes: readonly BuildLabelType[];
    model: string;
    promptVersion: string;
    locale: "tr" | "en";
    startVersion: number | null;
  }): string {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO design_sessions (org_id, id, language_id, title, status, started_at, updated_at, mode, state, base, base_version, base_data,
           current_rev, cost_usd, budget_usd, budget_raised, from_setup, label_types, model, prompt_version, locale, next_seq, start_version)
         VALUES ($org, ?, ?, '', 'idle', ?, ?, 'site', ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id, input.languageId, now, now, input.state, input.base, input.baseVersion, JSON.stringify(input.baseData), input.budgetUsd,
        input.fromSetup ? 1 : 0, JSON.stringify(input.labelTypes), input.model, input.promptVersion, input.locale, input.startVersion,
      );
    return id;
  }

  /** Sütunları günceller (`updated_at` her zaman). Alan adları koddan gelir (istemciden değil). */
  update(id: string, fields: Partial<Omit<BuildRow, "id" | "language_id" | "started_at" | "updated_at">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    const values = keys.map((k) => (fields[k] ?? null) as SQLInputValue);
    this.db.prepare(`UPDATE design_sessions SET ${sets} WHERE id = ? AND org_id = $org AND mode = 'site'`).run(...values, this.now(), id);
  }

  /** Karşılaştırarak yazma: durum hâlâ `from` ise (ve tur kilidi beklenen hâldeyse) yazar; yazdıysa true. */
  compareAndSet(id: string, from: BuildState, lock: "free" | "any", fields: Partial<Omit<BuildRow, "id" | "language_id" | "started_at" | "updated_at">>): boolean {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    const values = keys.map((k) => (fields[k] ?? null) as SQLInputValue);
    const lockSql = lock === "free" ? " AND turn_seq IS NULL" : "";
    const r = this.db.prepare(`UPDATE design_sessions SET ${sets} WHERE id = ? AND org_id = $org AND mode = 'site' AND state = ?${lockSql}`).run(...values, this.now(), id, from);
    return Number(r.changes) === 1;
  }

  // ------------------------------------------------------------ akış girdileri

  addEntry(buildId: string, e: { role: EntryRow["role"]; kind: BuildEntryKind; text?: string | null; group?: string | null; turnSeq?: number | null; data?: EntryData }): BuildEntry {
    const r = this.db
      .prepare("INSERT INTO design_session_entries (org_id, session_id, at, kind, grp, text, paths, role, data, turn_seq) VALUES ($org, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(buildId, this.now(), e.kind, e.group ?? null, e.text ?? "", e.role, e.data ? JSON.stringify(e.data) : null, e.turnSeq ?? null);
    return this.entry(buildId, Number(r.lastInsertRowid))!;
  }

  entry(buildId: string, id: number): BuildEntry | null {
    const r = this.db.prepare("SELECT * FROM design_session_entries WHERE id = ? AND session_id = ? AND org_id = $org").get(id, buildId) as EntryRow | undefined;
    return r ? toEntry(r) : null;
  }

  entries(buildId: string, after = 0, limit = 500): BuildEntry[] {
    const rows = this.db.prepare("SELECT * FROM design_session_entries WHERE session_id = ? AND org_id = $org AND id > ? ORDER BY id LIMIT ?").all(buildId, after, limit) as unknown as EntryRow[];
    return rows.map(toEntry);
  }

  entriesOfKind(buildId: string, kinds: readonly BuildEntryKind[]): BuildEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM design_session_entries WHERE session_id = ? AND org_id = $org AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id`)
      .all(buildId, ...kinds) as unknown as EntryRow[];
    return rows.map(toEntry);
  }

  updateEntryData(buildId: string, id: number, data: EntryData): void {
    this.db.prepare("UPDATE design_session_entries SET data = ? WHERE id = ? AND session_id = ? AND org_id = $org").run(JSON.stringify(data), id, buildId);
  }

  lastEntryId(buildId: string): number {
    const r = this.db.prepare("SELECT MAX(id) AS n FROM design_session_entries WHERE session_id = ? AND org_id = $org").get(buildId) as { n: number | null };
    return r.n ?? 0;
  }

  /** Bu oturumun kullanıcı girdisi mi (kanıt denetimi). */
  userEntry(buildId: string, id: number): BuildEntry | null {
    const e = this.entry(buildId, id);
    return e && e.role === "user" ? e : null;
  }

  // ------------------------------------------------------------ turlar (yalnız eklenir)

  history(buildId: string): BuilderMessage[] {
    const rows = this.db.prepare("SELECT messages FROM design_session_turns WHERE session_id = ? AND org_id = $org ORDER BY seq").all(buildId) as { messages: Uint8Array }[];
    return rows.flatMap((r) => JSON.parse(inflateSync(Buffer.from(r.messages)).toString("utf8")) as BuilderMessage[]);
  }

  insertTurn(buildId: string, seq: number, t: { messages: BuilderMessage[]; usage: unknown; costUsd: number; stopReason: string }): void {
    this.db
      .prepare("INSERT INTO design_session_turns (org_id, session_id, seq, messages, usage, cost_usd, stop_reason, created_at) VALUES ($org, ?, ?, ?, ?, ?, ?, ?)")
      .run(buildId, seq, deflateSync(Buffer.from(JSON.stringify(t.messages), "utf8")), JSON.stringify(t.usage ?? null), t.costUsd, t.stopReason, this.now());
  }

  // ------------------------------------------------------------ revizyonlar

  revisions(buildId: string): StoredRevision[] {
    const rows = this.db.prepare("SELECT * FROM profile_revisions WHERE session_id = ? AND org_id = $org ORDER BY rev").all(buildId) as unknown as RevisionRow[];
    return rows.map(toRevision);
  }

  revision(buildId: string, rev: number): StoredRevision | null {
    const r = this.db.prepare("SELECT * FROM profile_revisions WHERE session_id = ? AND org_id = $org AND rev = ?").get(buildId, rev) as RevisionRow | undefined;
    return r ? toRevision(r) : null;
  }

  insertRevision(buildId: string, languageId: string, r: Omit<StoredRevision, "at">): void {
    this.db
      .prepare(
        `INSERT INTO profile_revisions (org_id, session_id, language_id, rev, data, changes, reason, summary, entry_id, restored_from, cost_usd, created_at)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(buildId, languageId, r.rev, JSON.stringify(r.profile), JSON.stringify(r.changes), r.reason, r.summary, r.entryId, r.restoredFrom, r.costUsd, this.now());
  }

  /** Turun maliyeti, turda yazılan son revizyona (sürüm listesindeki "bu revizyonu üreten turun maliyeti"). */
  updateRevisionCost(buildId: string, rev: number, costUsd: number): void {
    this.db.prepare("UPDATE profile_revisions SET cost_usd = ? WHERE session_id = ? AND org_id = $org AND rev = ?").run(costUsd, buildId, rev);
  }

  // ------------------------------------------------------------ örnekler

  sampleRows(buildId: string, opts: { deleted?: boolean } = {}): SampleRow[] {
    const del = opts.deleted ? "" : " AND deleted_at IS NULL";
    return this.db.prepare(`SELECT * FROM design_samples WHERE session_id = ? AND org_id = $org${del} ORDER BY seq`).all(buildId) as unknown as SampleRow[];
  }

  sampleRow(buildId: string, id: string): SampleRow {
    const r = this.db.prepare("SELECT * FROM design_samples WHERE id = ? AND session_id = ? AND org_id = $org AND deleted_at IS NULL").get(id, buildId) as SampleRow | undefined;
    if (!r) throw fail("sample-not-found");
    return r;
  }

  insertSample(buildId: string, languageId: string, s: { id: string; name: string; w: number; h: number; templateKey: string | null }): void {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM design_samples WHERE session_id = ? AND org_id = $org").get(buildId) as { n: number }).n;
    this.db
      .prepare(
        `INSERT INTO design_samples (org_id, id, session_id, language_id, seq, name, w, h, status, measurement, template_key, font_file, split, excluded, reference_id, error, created_at)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, 'uploaded', NULL, ?, NULL, NULL, 0, NULL, NULL, ?)`,
      )
      .run(s.id, buildId, languageId, seq, s.name, s.w, s.h, s.templateKey, this.now());
  }

  /** Örnekleri "modele gösterildi" işaretler (ilk gösterim anı kalır). */
  markShown(buildId: string, ids: readonly string[]): void {
    const now = this.now();
    const st = this.db.prepare("UPDATE design_samples SET shown_at = ? WHERE id = ? AND session_id = ? AND org_id = $org AND shown_at IS NULL");
    for (const id of ids) st.run(now, id, buildId);
  }

  updateSample(buildId: string, id: string, fields: Partial<Omit<SampleRow, "id" | "session_id" | "language_id" | "seq" | "created_at">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const values = keys.map((k) => (fields[k] ?? null) as SQLInputValue);
    this.db.prepare(`UPDATE design_samples SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND session_id = ? AND org_id = $org`).run(...values, id, buildId);
  }

  // ------------------------------------------------------------ harcama

  /**
   * Oturumun bir AI isteğini kaydeder (`ai_calls`, `build_id`). Kayıttaki maliyet `estimateCost` (platform sözleşmesinin
   * fiyatı; tabloda olmayan model en pahalı fiyattan). DÖNEN tutar bütçe tutarıdır (`budgetCostOf`, aynı tutar). `member_id`
   * bağlamın üyesi (`$member`), `gateway_call_id` platform kipinde geçidin çağrı kimliği (`usage.gatewayCallId`).
   */
  recordCall(buildId: string, languageId: string, c: { purpose: string; model: string; usage: Usage; summary: string; error?: string | null; durationMs?: number }): number {
    const usage = { ...c.usage, model: c.usage.model || c.model };
    const cost = estimateCost(usage);
    this.db
      .prepare(
        `INSERT INTO ai_calls (org_id, id, job_id, task_id, variant_id, language_id, purpose, model, summary, response, error, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, images, cost_usd, duration_ms, created_at, build_id, member_id, gateway_call_id)
         VALUES ($org, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, $member, ?)`,
      )
      .run(
        randomUUID(), languageId, c.purpose, c.usage.model || c.model, c.summary.slice(0, 2000), c.error ?? null, c.usage.inputTokens, c.usage.outputTokens,
        c.usage.cacheReadTokens ?? 0, c.usage.cacheWriteTokens ?? 0, cost, Math.round(c.durationMs ?? 0), this.now(), buildId, c.usage.gatewayCallId ?? null,
      );
    return budgetCostOf(usage);
  }

  /**
   * Firmanın bu ayki bütün AI harcaması (bütün araçlar). Fiyatı kayıtlı olmayan çağrı, token sayılarından en pahalı
   * bilinen fiyatla sayılır (`budgetCostOf`; sınır için güvenli yön).
   */
  monthUsd(): number {
    const month = this.now().slice(0, 7);
    const r = this.db.prepare("SELECT SUM(cost_usd) AS usd FROM ai_calls WHERE org_id = $org AND substr(created_at, 1, 7) = ? AND cost_usd IS NOT NULL").get(month) as { usd: number | null };
    const unpriced = this.db
      .prepare("SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM ai_calls WHERE org_id = $org AND substr(created_at, 1, 7) = ? AND cost_usd IS NULL")
      .all(month) as Array<{ model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>;
    let extra = 0;
    for (const u of unpriced) {
      extra += budgetCostOf({ model: u.model ?? "", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_tokens ?? 0, cacheWriteTokens: u.cache_write_tokens ?? 0 });
    }
    return (r.usd ?? 0) + extra;
  }
}

// ------------------------------------------------------------ dönüşümler

function toEntry(r: EntryRow): BuildEntry {
  const d = json<EntryData | null>(r.data, null) ?? {};
  const role = r.role ?? "system";
  return {
    id: r.id,
    at: r.at,
    role,
    kind: r.kind,
    turnSeq: r.turn_seq ?? null,
    text: role === "system" ? null : r.text,
    group: (r.grp as BuildEntry["group"]) ?? null,
    ...(d.question ? { question: d.question } : {}),
    ...(d.answer ? { answer: d.answer } : {}),
    ...(d.rev !== undefined ? { rev: d.rev } : {}),
    ...(d.sampleEdit ? { sampleEdit: d.sampleEdit } : {}),
    ...(d.code ? { code: d.code } : {}),
    ...(d.params ? { params: d.params } : {}),
  };
}

function toRevision(r: RevisionRow): StoredRevision {
  return {
    rev: r.rev,
    at: r.created_at,
    reason: r.reason,
    summary: r.summary,
    profile: parseProfile(r.data),
    changes: json<RuleChange[]>(r.changes, []),
    entryId: r.entry_id,
    restoredFrom: r.restored_from,
    costUsd: r.cost_usd,
  };
}

export function revisionSummary(r: StoredRevision): RevisionSummary {
  return { rev: r.rev, at: r.at, reason: r.reason, summary: r.summary, changeCount: r.changes.length, costUsd: r.costUsd, restoredFrom: r.restoredFrom };
}

export function measurementOf(row: SampleRow): SampleMeasurement | null {
  if (!row.measurement) return null;
  const r = SampleMeasurementSchema.safeParse(json(row.measurement, null));
  return r.success ? r.data : null;
}

export function toSample(row: SampleRow): Sample {
  const m = measurementOf(row);
  return {
    id: row.id,
    buildId: row.session_id,
    name: row.name,
    w: m?.w ?? row.w,
    h: m?.h ?? row.h,
    status: row.status,
    quality: row.status === "uploaded" || row.status === "failed" ? null : (m?.quality ?? null),
    approx: m?.approx ?? false,
    templateKey: row.template_key ?? m?.templateKey ?? null,
    templateMatch: row.template_key ? (m?.templateMatch ?? "user") : (m?.templateMatch ?? null),
    lines: m?.lines ?? [],
    fontFile: row.font_file,
    split: row.split,
    excluded: !!row.excluded,
    referenceId: row.reference_id,
    imageUrl: apiPath(BUILDER_API.sampleImage.path, { id: row.session_id, sid: row.id }),
    error: json<Sample["error"]>(row.error, null),
    createdAt: row.created_at,
  };
}

export function baseProfile(row: BuildRow): Profile {
  return parseProfile(row.base_data);
}

export function rowError(row: BuildRow): BuildError | null {
  return json<BuildError | null>(row.error, null);
}

export function rowNotices(row: BuildRow): string[] {
  return json<string[]>(row.notices, []);
}

export function rowLabelTypes(row: BuildRow): BuildLabelType[] {
  return json<BuildLabelType[]>(row.label_types, []);
}

/** `Build` görünümü. */
export function toBuild(row: BuildRow, samples: Sample[], pendingQuestions: BuildQuestion[], lastEntryId: number): Build {
  return {
    id: row.id,
    languageId: row.language_id,
    mode: "site",
    state: row.state,
    resumeState: row.state === "interrupted" || row.state === "failed" ? row.resume_state : null,
    base: row.base,
    baseVersion: row.base_version,
    currentRev: row.current_rev,
    costUsd: Math.round(row.cost_usd * 1e6) / 1e6,
    budgetUsd: row.budget_usd,
    budgetRaised: !!row.budget_raised,
    fromSetup: !!row.from_setup,
    labelTypes: rowLabelTypes(row),
    pendingQuestions: row.state === "awaiting-user" ? pendingQuestions : [],
    samples,
    turn: row.turn_seq !== null ? { seq: row.turn_seq, startedAt: row.turn_started_at ?? row.updated_at } : null,
    lastEntryId,
    error: rowError(row),
    createdAt: row.started_at,
    updatedAt: row.updated_at,
  };
}
