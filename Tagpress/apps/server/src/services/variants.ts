import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  API,
  type Box,
  type DesignIntent,
  type Issue,
  type LayoutResult,
  type VariantAdjust,
  type VariantDetail,
  type VariantKind,
  type VariantSnapshot,
  apiPath,
  applyAdjustToLayout,
} from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import { canSeeAmounts } from "../org/access.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";
import { writeAtomic } from "../util/files.ts";
import { PNG, safeJoin } from "../util/safe-path.ts";
import type { VariantRow } from "./jobs/mapping.ts";
import { variantSummary } from "./jobs/mapping.ts";
import type { JobService } from "./jobs/service.ts";

export interface VariantImage {
  textLayerFile: string | null;
  textBox: Box | null;
  readText: string | null;
  /** generated-template modunda üretilen şablonun anahtarı. */
  generatedTemplateKey?: string | null;
}

export interface NewVariant {
  jobId: string;
  kind: VariantKind;
  intent: DesignIntent | null;
  layout: LayoutResult | null;
  snapshot: VariantSnapshot;
  preview: Buffer;
  textLayer?: Buffer | null;
  image?: Omit<VariantImage, "textLayerFile"> | null;
  score: number | null;
  aiRank: number | null;
  suspect: boolean;
  issues: Issue[];
  rationale: string;
}

/** Varyasyonlar: kayıt + önizleme dosyaları (`data/onizleme/<id>.png`, `<id>.text.png`). */
export class VariantService {
  constructor(
    private readonly db: TenantDb,
    private readonly paths: DataPaths,
    private readonly jobs: JobService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  row(id: string, includeDeleted = false): VariantRow | null {
    const r = this.db.prepare(`SELECT * FROM variants WHERE id = ? AND org_id = $org ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as VariantRow | undefined;
    return r ?? null;
  }

  require(id: string): VariantRow {
    const r = this.row(id);
    if (!r) throw fail("variant-not-found");
    return r;
  }

  get(id: string): VariantDetail {
    const v = this.require(id);
    const job = this.jobs.require(v.job_id);
    const image = json<VariantImage | null>(v.image, null);
    return {
      ...variantSummary(v, job),
      intent: json<DesignIntent | null>(v.intent, null),
      layout: json<unknown>(v.layout, null),
      snapshot: amountsFor(json<VariantSnapshot>(v.snapshot, {} as VariantSnapshot)),
      issues: json<Issue[]>(v.issues, []),
      rationale: v.rationale,
      image: image
        ? { textLayerUrl: image.textLayerFile ? apiPath(API.variantTextLayer, { id }) : null, textBox: image.textBox, readText: image.readText }
        : null,
      adjust: this.adjustOf(v),
    };
  }

  /** Kayıtlı hafif düzeltme (yoksa null). */
  adjustOf(v: Pick<VariantRow, "adjust">): VariantAdjust | null {
    return json<VariantAdjust | null>(v.adjust ?? null, null);
  }

  /** Motorun düzeltmesiz yerleşimi. */
  baseLayout(v: Pick<VariantRow, "layout">): LayoutResult | null {
    return json<LayoutResult | null>(v.layout, null);
  }

  /** Önizleme ve baskının kullandığı yerleşim: motor yerleşimi + hafif düzeltme. */
  effectiveLayout(v: Pick<VariantRow, "layout" | "adjust">): LayoutResult | null {
    const base = this.baseLayout(v);
    return base ? applyAdjustToLayout(base, this.adjustOf(v)) : null;
  }

  /** Önizleme dosyası (önizleme klasöründe PNG; kayıttaki kaçan değer diske çevrilmez → null). */
  previewPath(v: Pick<VariantRow, "preview_file">): string | null {
    return safeJoin(this.paths.previews, v.preview_file, { ext: PNG });
  }

  textLayerPath(v: Pick<VariantRow, "image">): string | null {
    const file = json<VariantImage | null>(v.image, null)?.textLayerFile;
    return file ? safeJoin(this.paths.previews, file, { ext: PNG }) : null;
  }

  /** Yeni varyasyon: dosyalar önce yazılır, sonra kayıt (yarım kayıt kalmaz). */
  async create(input: NewVariant): Promise<string> {
    // Ebeveyn (iş) aynı firmada olmalı: başka firmanın işine varyasyon yazılmaz.
    if (!this.jobs.row(input.jobId, true)) throw fail("job-not-found");
    const id = randomUUID();
    const previewFile = `${id}.png`;
    await writeAtomic(path.join(this.paths.previews, previewFile), input.preview);
    let textLayerFile: string | null = null;
    if (input.textLayer) {
      textLayerFile = `${id}.text.png`;
      await writeAtomic(path.join(this.paths.previews, textLayerFile), input.textLayer);
    }
    const image: VariantImage | null = input.image || textLayerFile ? { textBox: null, readText: null, ...input.image, textLayerFile } : null;
    const no = (this.db.prepare("SELECT COALESCE(MAX(no), 0) + 1 AS n FROM variants WHERE job_id = ? AND org_id = $org").get(input.jobId) as { n: number }).n;
    this.db
      .prepare(
        `INSERT INTO variants (org_id, id, job_id, no, kind, intent, layout, snapshot, preview_file, image, score, ai_rank, suspect, issues, rationale, created_at)
         VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.jobId, no, input.kind, input.intent ? JSON.stringify(input.intent) : null, input.layout ? JSON.stringify(input.layout) : null,
        JSON.stringify(input.snapshot), previewFile, image ? JSON.stringify(image) : null, input.score, input.aiRank, input.suspect ? 1 : 0,
        JSON.stringify(input.issues), input.rationale, this.clock.now().toISOString(),
      );
    this.jobs.syncAfterVariants(input.jobId);
    this.events.emit({ type: "variant", jobId: input.jobId, variantId: id });
    return id;
  }

  setSuspect(id: string, suspect: boolean): VariantDetail {
    const v = this.require(id);
    this.db.prepare("UPDATE variants SET suspect = ? WHERE id = ? AND org_id = $org").run(suspect ? 1 : 0, id);
    this.events.emit({ type: "variant", jobId: v.job_id, variantId: id });
    return this.get(id);
  }

  /** İşin önceki varyasyonlarının niyetleri (AI tekrar etmesin). */
  previousIntents(jobId: string): DesignIntent[] {
    return this.jobs
      .liveVariants(jobId)
      .map((v) => json<DesignIntent | null>(v.intent, null))
      .filter((x): x is DesignIntent => !!x);
  }
}

/** Platformda harcama tutarı yalnız Yöneticiye (`org/access.ts` `canSeeAmounts`); diğerine `costUsd: null`. */
function amountsFor(snapshot: VariantSnapshot): VariantSnapshot {
  return canSeeAmounts() || snapshot.costUsd == null ? snapshot : { ...snapshot, costUsd: null };
}
