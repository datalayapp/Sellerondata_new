import type { ImportRow, ImportRowInput } from "@tagpress/domain";
import type { DataPaths } from "../../config.ts";
import { placeholders } from "../../db/database.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Ports } from "../../ports.ts";
import type { ProfileService } from "../profiles.ts";
import type { TemplateService } from "../templates.ts";
import { dedupeRest, type ExistingDuplicate, type RowContext, validateRows } from "./rows.ts";

/** Satır/iş doğrulayıcı: içe aktarma ve iş düzenleme aynı kuralları kullanır. */
export class RowValidator {
  constructor(
    private readonly db: TenantDb,
    private readonly paths: DataPaths,
    private readonly profiles: ProfileService,
    private readonly templates: TemplateService,
    private readonly ports: Ports,
  ) {}

  context(languageId: string): RowContext {
    const { profile } = this.profiles.activeProfile(languageId);
    const items = this.templates.list(languageId);
    return {
      languageId,
      profile,
      templateKeys: items.map((i) => i.template.key),
      missingFiles: new Set(items.filter((i) => i.fileMissing).map((i) => i.template.key)),
      resolver: this.ports.templateResolver,
      coverage: this.ports.fontCoverage,
      fontsDir: this.paths.fonts(languageId),
      sharedFontsDir: this.paths.sharedFonts,
    };
  }

  /** Geçerli firmanın mevcut (silinmemiş) işlerinde aynı tekrar anahtarı; `exclude` hariç (başka firmanın işi eşleşmez). */
  existing(languageId: string, keys: string[], exclude: string[] = []): ExistingDuplicate[] {
    const out: ExistingDuplicate[] = [];
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = keys.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT j.dedupe_key, j.id, b.name, j.created_at FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
           WHERE j.org_id = $org AND j.deleted_at IS NULL AND b.deleted_at IS NULL AND b.language_id = ? AND j.dedupe_key IN (${placeholders(chunk.length)})
           ${exclude.length ? `AND j.id NOT IN (${placeholders(exclude.length)})` : ""}
           ORDER BY j.created_at`,
        )
        .all(languageId, ...chunk, ...exclude) as { dedupe_key: string; id: string; name: string; created_at: string }[];
      out.push(...rows.map((r) => ({ dedupeKey: r.dedupe_key, jobId: r.id, batchName: r.name, createdAt: r.created_at })));
    }
    return out;
  }

  /** Sipariş numarası dışındaki kısmı (şablon | boyut | metin) aynı olan mevcut işler. */
  similar(languageId: string, rests: string[], exclude: string[] = []): ExistingDuplicate[] {
    if (!rests.length) return [];
    const wanted = new Set(rests);
    const rows = this.db
      .prepare(
        `SELECT j.dedupe_key, j.id, b.name, j.created_at FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
         WHERE j.org_id = $org AND j.deleted_at IS NULL AND b.deleted_at IS NULL AND b.language_id = ? ORDER BY j.created_at`,
      )
      .all(languageId) as { dedupe_key: string; id: string; name: string; created_at: string }[];
    const skip = new Set(exclude);
    return rows
      .filter((r) => !skip.has(r.id) && wanted.has(dedupeRest(r.dedupe_key)))
      .map((r) => ({ dedupeKey: r.dedupe_key, jobId: r.id, batchName: r.name, createdAt: r.created_at }));
  }

  validate(languageId: string, rows: ImportRowInput[], fresh: boolean, exclude: string[] = [], ctx?: RowContext): ImportRow[] {
    return validateRows(rows, ctx ?? this.context(languageId), (keys) => this.existing(languageId, keys, exclude), fresh, (rests) => this.similar(languageId, rests, exclude));
  }
}
