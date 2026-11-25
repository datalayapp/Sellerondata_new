import { randomUUID } from "node:crypto";
import type { BatchSummary, FieldMap } from "@tagpress/domain";
import type { EventBus } from "../events.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";

interface BatchRow {
  id: string;
  language_id: string;
  name: string;
  source_file: string | null;
  created_at: string;
}

/** Partiler (bir içe aktarma = bir parti). Liste en yeni üstte; sayımlar tek sorguda. */
export class BatchService {
  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  create(input: { languageId: string; name: string; sourceFile: string | null; mapping: FieldMap | null }): string {
    // Ebeveyn (dil) aynı firmada olmalı: başka firmanın diline parti açılmaz.
    if (!this.db.prepare("SELECT 1 FROM languages WHERE id = ? AND org_id = $org").get(input.languageId)) throw fail("language-not-found");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO batches (org_id, id, language_id, name, source_file, mapping, created_at) VALUES ($org, ?, ?, ?, ?, ?, ?)")
      .run(id, input.languageId, input.name, input.sourceFile, input.mapping ? JSON.stringify(input.mapping) : null, this.clock.now().toISOString());
    this.events.emit({ type: "batch", batchId: id });
    return id;
  }

  /** Günün "Elle eklenenler" partisi (yoksa oluşturulur). */
  manualBatch(languageId: string): string {
    const day = this.clock.now().toISOString().slice(0, 10);
    const name = `Elle eklenenler ${day}`;
    const row = this.db
      .prepare("SELECT id FROM batches WHERE org_id = $org AND language_id = ? AND name = ? AND source_file IS NULL AND deleted_at IS NULL")
      .get(languageId, name) as { id: string } | undefined;
    return row?.id ?? this.create({ languageId, name, sourceFile: null, mapping: null });
  }

  list(languageId?: string): BatchSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM batches WHERE org_id = $org AND deleted_at IS NULL ${languageId ? "AND language_id = ?" : ""} ORDER BY created_at DESC`)
      .all(...(languageId ? [languageId] : [])) as unknown as BatchRow[];
    const counts = this.db
      .prepare(
        `SELECT batch_id, COALESCE(gen_state, status) AS st, COUNT(*) AS n, SUM(CASE WHEN issue_level IS NOT NULL THEN 1 ELSE 0 END) AS issues, SUM(CASE WHEN approved_variant_id IS NOT NULL THEN 1 ELSE 0 END) AS approved
         FROM jobs WHERE org_id = $org AND deleted_at IS NULL GROUP BY batch_id, st`,
      )
      .all() as { batch_id: string; st: string; n: number; issues: number; approved: number }[];
    const by = new Map<string, BatchSummary>();
    for (const r of rows) {
      by.set(r.id, { id: r.id, languageId: r.language_id, name: r.name, sourceFile: r.source_file, createdAt: r.created_at, total: 0, byStatus: {}, withIssues: 0, approved: 0 });
    }
    for (const c of counts) {
      const b = by.get(c.batch_id);
      if (!b) continue;
      b.total += c.n;
      b.byStatus[c.st] = (b.byStatus[c.st] ?? 0) + c.n;
      b.withIssues += c.issues ?? 0;
      b.approved += c.approved ?? 0;
    }
    return [...by.values()];
  }

  get(id: string): BatchSummary {
    const b = this.list().find((x) => x.id === id);
    if (!b) throw fail("batch-not-found");
    return b;
  }

  rename(id: string, name: string): BatchSummary {
    this.get(id);
    this.db.prepare("UPDATE batches SET name = ? WHERE id = ? AND org_id = $org").run(name, id);
    this.events.emit({ type: "batch", batchId: id });
    return this.get(id);
  }
}
