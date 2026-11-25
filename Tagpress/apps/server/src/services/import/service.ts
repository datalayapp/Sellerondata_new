import {
  type ImportCommitRequest,
  ImportCommitRequestSchema,
  type ImportCommitResponse,
  type ImportPreviewRequest,
  ImportPreviewRequestSchema,
  type ImportPreviewResponse,
  type ImportRow,
  type ImportSummary,
  type ImportValidateRequest,
  ImportValidateRequestSchema,
  type ImportValidateResponse,
  type JobDetail,
  type ManualJob,
  ManualJobSchema,
} from "@tagpress/domain";
import { requireAccess } from "../../org/access.ts";
import { HttpError } from "../../util/errors.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { BatchService } from "../batches.ts";
import type { JobService } from "../jobs/service.ts";
import type { LanguageService } from "../languages.ts";
import { collectFields, detectFieldMap, parseRecords } from "./parse.ts";
import { rowFromRecord, sheetsOf, stickerKey } from "./rows.ts";
import type { RowValidator } from "./validator.ts";

/** İçe aktarma ve elle işin üretim kuyruğu: kuyruğa girenler ve (başlatılamadıysa) neden. */
export type ImportEnqueue = (jobIds: string[]) => { queued: string[]; notQueued?: NotQueued };
export type NotQueued = NonNullable<ImportCommitResponse["notQueued"]>;

/**
 * Üretimi baştan durduran ön denetim hataları (anahtar yok; platformda yapay zekâ kapalı, durdurulmuş ya da hak dolmuş):
 * içe aktarma ve elle iş bunlarda yine tamamlanır, işler açılır ama kuyruğa girmez (yanıtta `notQueued`). Böylece hata
 * dönüp işleri yazmış olmak (yeniden aktarımda çift iş) olmaz.
 */
export const NOT_QUEUED_CODES: ReadonlySet<string> = new Set(["missing-key", "ai-unavailable", "ai-paused", "budget-exceeded"]);

/** Kuyruğa alma: ön denetim hatası (`NOT_QUEUED_CODES`) yutulur ve neden döner; başka hata yukarı çıkar. */
export function enqueueOrExplain(enqueue: (jobIds: string[]) => string[]): ImportEnqueue {
  return (jobIds) => {
    try {
      return { queued: enqueue(jobIds) };
    } catch (err) {
      const code = err instanceof HttpError ? err.code : undefined;
      if (code && NOT_QUEUED_CODES.has(code)) return { queued: [], notQueued: { code, message: err instanceof Error ? err.message : code } };
      throw err;
    }
  };
}

/** Üretimi engelleyen sorunlar: bunlar varken iş kuyruğa alınmaz. */
export const BLOCKING = new Set(["text-missing", "template-missing", "template-unknown", "sticker-sheet-missing"]);

export function summarize(rows: ImportRow[]): ImportSummary {
  const byCode: Record<string, number> = {};
  for (const r of rows) for (const c of new Set(r.issues.map((i) => i.code))) byCode[c] = (byCode[c] ?? 0) + 1;
  return {
    total: rows.length,
    included: rows.filter((r) => r.include).length,
    errors: rows.filter((r) => r.issues.some((i) => i.severity === "error")).length,
    warnings: rows.filter((r) => r.issues.some((i) => i.severity === "warning")).length,
    duplicates: rows.filter((r) => r.issues.some((i) => i.code === "duplicate-in-file" || i.code === "duplicate-existing")).length,
    stickers: rows.filter((r) => r.kind === "sticker").length,
    byCode,
  };
}

/**
 * İçe aktarma: önizleme (hiçbir şey kaydedilmez) → kullanıcı düzenler, `validate` ile anında denetlenir →
 * `commit` parti + işleri oluşturur. Sunucu commit'te satırları YENİDEN doğrular (arayüze güvenmez).
 */
export class ImportService {
  constructor(
    private readonly db: TenantDb,
    private readonly languages: LanguageService,
    private readonly validator: RowValidator,
    private readonly batches: BatchService,
    private readonly jobs: JobService,
    private readonly enqueue: ImportEnqueue,
  ) {}

  preview(input: ImportPreviewRequest): ImportPreviewResponse {
    const req = ImportPreviewRequestSchema.parse(input);
    const languageId = this.languages.resolve(req.languageId);
    const { records, format } = parseRecords(req.content);
    const { mapping, source } = detectFieldMap(records, req.mapping ?? {});
    const ctx = this.validator.context(languageId);
    const drafts = records.map((r, i) => rowFromRecord(r, i, mapping, ctx));
    const rows = this.validator.validate(languageId, drafts, true, [], ctx);
    const warnings: string[] = [];
    if (!mapping.text) warnings.push("Metin alanı bulunamadı; eşlemeden metin alanını seçin.");
    if (source.text === "content") warnings.push(`Metin alanı içerikten tahmin edildi ("${mapping.text}"); doğru olduğunu kontrol edin.`);
    if (!mapping.template && rows.some((r) => r.kind === "label")) warnings.push("Şablon alanı bulunamadı; eşlemeden şablon alanını seçin.");
    if (!mapping.orderNo) warnings.push("Sipariş no alanı bulunamadı.");
    if (!mapping.quantity) warnings.push("Adet alanı bulunamadı.");
    return {
      languageId,
      fileName: req.fileName,
      fields: collectFields(records),
      mapping,
      mappingSource: source,
      format,
      rows,
      warnings,
      summary: summarize(rows),
      templateKeys: [...ctx.templateKeys, ...sheetsOf(ctx.profile).map((s) => stickerKey(s.id))],
      labelSizes: ctx.profile.output.sizes,
    };
  }

  validate(input: ImportValidateRequest): ImportValidateResponse {
    const req = ImportValidateRequestSchema.parse(input);
    const languageId = this.languages.resolve(req.languageId);
    const rows = this.validator.validate(languageId, req.rows, false);
    return { rows, summary: summarize(rows) };
  }

  commit(input: ImportCommitRequest): ImportCommitResponse {
    const req = ImportCommitRequestSchema.parse(input);
    // Üretimle birlikte içe aktarma harcama izni ister (`spend`); izin yoksa hiçbir şey yazılmadan 403 (R1).
    if (req.generate) requireAccess("spend");
    const languageId = this.languages.resolve(req.languageId);
    const rows = this.validator.validate(languageId, req.rows, false);
    const skipped: ImportCommitResponse["skipped"] = [];
    const take: ImportRow[] = [];
    for (const r of rows) {
      if (!r.include) skipped.push({ index: r.index, reason: "Hariç tutuldu." });
      else if (!r.text.trim()) skipped.push({ index: r.index, reason: "Metin boş." });
      else take.push(r);
    }
    const name = req.batchName?.trim() || `${req.fileName.replace(/\.[a-z0-9]+$/i, "")} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const { batchId, jobIds } = this.db.tx(() => {
      const batchId = this.batches.create({ languageId, name, sourceFile: req.fileName, mapping: req.mapping });
      return { batchId, jobIds: take.length ? this.jobs.createMany(batchId, take) : [] };
    });
    // İşler yazıldı: üretim başlatılamazsa (ön denetim) hata dönülmez, neden yanıtta (`notQueued`).
    const q = req.generate ? this.enqueue(jobIds.filter((_, i) => !take[i]!.issues.some((x) => BLOCKING.has(x.code)))) : { queued: [] };
    return { batchId, jobIds, created: jobIds.length, skipped, queued: q.queued, ...(q.notQueued ? { notQueued: q.notQueued } : {}) };
  }

  /** Elle tek iş: aynı doğrulamadan geçer. İş açıldıktan sonra üretim başlatılamazsa iş kalır, neden `notQueued`'da. */
  manual(input: ManualJob): { job: JobDetail; queued: string[]; notQueued?: NotQueued } {
    const req = ManualJobSchema.parse(input);
    // Üretimle birlikte elle iş harcama izni ister (`spend`); izin yoksa iş açılmadan 403 (R1).
    if (req.generate) requireAccess("spend");
    const languageId = this.languages.resolve(req.languageId);
    const [row] = this.validator.validate(
      languageId,
      [{ index: 0, text: req.text, textRaw: req.text, templateKey: req.templateKey?.trim().toLowerCase() || null, labelSize: req.labelSize, orderNo: req.orderNo, quantity: req.quantity, product: req.product, aiNote: req.aiNote, kind: req.kind }],
      false,
    );
    const batchId = req.batchId ? this.batches.get(req.batchId).id : this.batches.manualBatch(languageId);
    const [id] = this.jobs.createMany(batchId, [row!]);
    const q = req.generate && !row!.issues.some((x) => BLOCKING.has(x.code)) ? this.enqueue([id!]) : { queued: [] };
    return { job: this.jobs.get(id!), queued: q.queued, ...(q.notQueued ? { notQueued: q.notQueued } : {}) };
  }
}
