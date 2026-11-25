import { randomUUID } from "node:crypto";
import {
  type PrintItem,
  type PrintItemSize,
  type PrintPageFull,
  type PrintPatchOp,
  type PrintSessionCreateSchema,
  type PrintSessionDetail,
  type PrintSessionNotice,
  type PrintSessionListQuerySchema,
  type PrintSessionPatchResponse,
  type PrintSessionSummary,
  type PrintSkipped,
  type PrintSlot,
  type PrintTemplate,
  PrintTemplateSchema,
  type Profile,
  type UndoToken,
  TemplateCutSchema,
  cornerMismatchMm,
  cutLabel,
  cutRotationForSlot,
  effectiveCut,
  normalizeCut,
  printNoticeMsg,
  ptToMm,
  slotFitsCut,
  undoMsg,
} from "@tagpress/domain";
import { STICKER_FALLBACK_AREA } from "@tagpress/print";
import type { z } from "zod";
import { json, placeholders } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import { type TenantDb, insertOrder } from "../../org/tenant-db.ts";
import type { Ports } from "../../ports.ts";
import type { Clock } from "../../util/clock.ts";
import { HttpError, fail } from "../../util/errors.ts";
import { uuidv7 } from "../../util/ids.ts";
import { fold } from "../../util/text.ts";
import type { JobService } from "../jobs/service.ts";
import type { ProfileService } from "../profiles.ts";
import type { UndoService } from "../undo.ts";
import type { VariantImage, VariantService } from "../variants.ts";
import type { PlannedPage, PlanOrder, PlanStickerOrder, PrintPlanner, ReflowedPage, ReflowInputPage } from "./ports.ts";
import { printLayout, stickerSizeFor, variantProfile } from "./render-input.ts";
import { type PrintJob, SHELF_STATUSES, approvedJobs, approvedJobsById, designKeyOf, jobCuts, orderNoOf, placedCounts, planOrder, printedJobIds, sizeOf, templateCutSql } from "./shelf.ts";
import type { PrintTemplateService } from "./templates.ts";

/** Sayfa + öğeleri (çizim girdisi ve istemci için). */
export type PrintPageRecord = PrintPageFull;

interface SessionRow {
  id: string;
  language_id: string;
  name: string;
  status: "draft" | "printed";
  version: number;
  template_id: string | null;
  job_ids: string;
  source_session_id: string | null;
  /** Basılmış oturumda şablonların anlık kopyası (JSON `{ kimlik: PrintTemplate }`); taslakta null. */
  template_snapshots: string | null;
  created_at: string;
  updated_at: string;
  printed_at: string | null;
  deleted_at: string | null;
  /** Planın ölçü kuralları sürümü (göç 12): 1 = eski sticker ölçüsü, `PLAN_VERSION` = bugünkü. */
  plan_version: number;
}

/**
 * Plan ölçü kuralları sürümü: 2 = sticker mürekkebi yazı alanına (mm) sığar (2026-11-21). Yeni plan ve yeniden planlama
 * bunu yazar; daha eski sticker oturumu masada "yeniden planla" uyarısı alır, basılmışsa basıldığı gibi dışa aktarılır.
 */
export const PLAN_VERSION = 2;

/**
 * Kayıttaki plan sürümü. 0 yalnız yayımlanmamış bir ara sürümün "kesim bayat" işaretiydi (artık yazılmaz; bayatlık
 * `cutStale`'de işlerden okunur): ölçü kuralı açısından bugünkü sürüm sayılır.
 */
const planVersionOf = (s: Pick<SessionRow, "plan_version">): number => {
  const v = s.plan_version ?? PLAN_VERSION;
  return v < 1 ? PLAN_VERSION : v;
};

interface PageRow {
  id: string;
  session_id: string;
  template_id: string;
  idx: number;
  name: string;
  copies: number;
  kind: "full" | "mixed" | "manual";
  show_cell_labels: number;
  locked: number;
  deleted_at: string | null;
}

interface ItemRow {
  id: string;
  page_id: string;
  job_id: string;
  variant_id: string;
  slot_id: string | null;
  x_mm: number;
  y_mm: number;
  rotation: number;
  scale: number;
  extra: number;
  manual: number;
  z: number;
}

interface Deps {
  db: TenantDb;
  ports: Ports;
  profiles: ProfileService;
  templates: PrintTemplateService;
  jobs: JobService;
  variants: VariantService;
  undo: UndoService;
  events: EventBus;
  clock: Clock;
}

type CreateInput = z.output<typeof PrintSessionCreateSchema>;
type ListQuery = z.output<typeof PrintSessionListQuerySchema>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const versionConflict = () => fail("version-conflict");

/** Baskıyı etkileyen şablon alanları (ad, tarih, arşiv hariç): anlık kopya ile güncel şablon aynı mı. */
const printFields = (t: PrintTemplate): string =>
  JSON.stringify([t.languageId, t.kind, t.paper, t.sizeId, t.slots, t.stickerFlow, t.cut, t.cellLabel, t.labelDiameterMm]);

/**
 * Baskı oturumları: onaylı işlerden plan → sayfalar ve öğeler; toplu yama (iyimser eşzamanlılık), yeniden planlama,
 * basıldı/arşiv, yeniden basım. Basılmış oturum değişmez ve silinmez; taslak silme geri alınabilir.
 */
export class PrintSessionService {
  constructor(private readonly d: Deps) {}

  private get planner(): PrintPlanner {
    const p = this.d.ports.printPlanner;
    if (!p) throw fail("print-planner-unavailable");
    return p;
  }

  // ---------------------------------------------------------------- okuma

  detail(id: string): PrintSessionDetail {
    const s = this.row(id);
    const pages = this.pages(id);
    return {
      id: s.id,
      languageId: s.language_id,
      name: s.name,
      status: s.status,
      version: s.version,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      printedAt: s.printed_at,
      templateId: s.template_id,
      sourceSessionId: s.source_session_id,
      jobIds: json<string[]>(s.job_ids, []),
      templateSnapshots: s.status === "printed" ? this.snapshots(s) : null,
      pages,
      itemSizes: this.itemSizes(pages, this.legacyRow(s)),
      notices: this.notices(s, pages),
    };
  }

  /** Eski ölçü kuralıyla (plan sürümü < 2) BASILMIŞ oturum: arşiv basıldığı gibi (eski sticker ölçüsüyle) çizilir. */
  legacyStickerScale(sessionId: string): boolean {
    return this.legacyRow(this.row(sessionId));
  }

  private legacyRow(s: SessionRow): boolean {
    return s.status === "printed" && planVersionOf(s) < PLAN_VERSION;
  }

  /**
   * Ucuz bildirim durumu (ayrıntı ve liste aynı kural):
   * - `planStale`: taslak, bugünkü ölçü kurallarından önce dizilmiş (sticker sayfası varken plan sürümü 1) ya da
   *   sayfalarında kesimi değişmiş bir iş var (`cutStale`).
   * - `oldScale`: eski kuralla basılmış sticker arşivi.
   */
  private noticeState(s: SessionRow, pages: PrintPageFull[]): { planStale: boolean; oldScale: boolean; stickerPages: PrintPageFull[] } {
    const kinds = new Map(pages.map((p) => [p.templateId, this.d.templates.find(p.templateId)?.kind]));
    const stickerPages = pages.filter((p) => kinds.get(p.templateId) === "sticker");
    const planStale = s.status === "draft" && ((planVersionOf(s) < PLAN_VERSION && stickerPages.length > 0) || this.cutStale(s, pages));
    return { planStale, oldScale: this.legacyRow(s) && stickerPages.length > 0, stickerPages };
  }

  /**
   * Taslağın sayfalarında, şablon kesimi sonradan değişmiş (`template-cut-changed` uyarılı) etiket işi var ve plan
   * ona artık uymuyor: işin onayı düşmüş ya da silinmiş (yeniden planlama onu atlar), ya da yeniden onaylanmış ama yeni
   * kesimin boyutu sayfanın şablonuna uymuyor (`mismatch`). Plan sürümüne yazılmaz: bayatlık işlerin bugünkü durumundan
   * okunur; yeniden planlama (ya da yeniden onay + uyan şablon) onu kaldırır, basılan oturumun plan sürümü doğru kalır.
   */
  private cutStale(s: SessionRow, pages: PrintPageFull[]): boolean {
    const onPage = new Map<string, string>();
    for (const p of pages) for (const it of p.items) if (!onPage.has(it.jobId)) onPage.set(it.jobId, p.templateId);
    if (!onPage.size) return false;
    const ids = [...onPage.keys()];
    const rows = this.d.db
      .prepare(`SELECT id, status, approved_variant_id, run_issues, deleted_at FROM jobs WHERE org_id = $org AND kind = 'label' AND id IN (${placeholders(ids.length)})`)
      .all(...ids) as { id: string; status: string; approved_variant_id: string | null; run_issues: string; deleted_at: string | null }[];
    const flagged = rows.filter((r) => {
      const run = json<unknown>(r.run_issues, []);
      return Array.isArray(run) && run.some((i) => (i as { code?: string } | null)?.code === "template-cut-changed");
    });
    if (!flagged.length) return false;
    if (flagged.some((r) => r.status !== "approved" || !r.approved_variant_id || r.deleted_at)) return true;
    const found = approvedJobsById(this.d.db, flagged.map((r) => r.id));
    let profile: Profile | null = null;
    for (const r of flagged) {
      const j = found.get(r.id);
      if (!j) return true;
      const t = this.d.templates.find(onPage.get(r.id)!);
      if (!t) continue;
      profile ??= this.d.profiles.activeProfile(s.language_id).profile;
      if (this.mismatch(j, t, profile)) return true;
    }
    return false;
  }

  /**
   * Oturum bildirimleri (`PRINT_NOTICE_MESSAGES`):
   * - `plan-stale`: `noticeState.planStale`. Yeniden planlanınca kaç kağıt tutacağı planlayıcıyla (kaydetmeden)
   *   hesaplanır.
   * - `printed-old-scale`: eski kuralla basılmış sticker arşivi; dışa aktarım basıldığı gibi.
   * - `sticker-small-text`: sticker'daki en küçük yazı tasarım dilinin okunurluk sınırının (`quality.readableMinPt`,
   *   etiketlerdeki kuralın aynısı; varsayılan 4,5 pt) altında.
   */
  private notices(s: SessionRow, pages: PrintPageFull[]): PrintSessionNotice[] {
    const out: PrintSessionNotice[] = [];
    const { planStale, oldScale, stickerPages } = this.noticeState(s, pages);
    if (planStale) {
      const sheets = pages.reduce((n, p) => n + p.copies, 0);
      const est = this.estimateSheets(s);
      out.push(printNoticeMsg("plan-stale", { sheets, replanSheets: est ?? sheets }));
    }
    if (oldScale) out.push(printNoticeMsg("printed-old-scale"));
    const seen = new Set<string>();
    for (const p of stickerPages) {
      for (const it of p.items) {
        if (seen.has(it.variantId)) continue;
        seen.add(it.variantId);
        const small = this.stickerSmallText(it.variantId, this.legacyRow(s));
        if (small) out.push(printNoticeMsg("sticker-small-text", small));
      }
    }
    return out;
  }

  /** Oturum bugün baştan planlansa kaç kağıt (sayfa × kopya) tutar; planlanamıyorsa null. Kaydetmez. */
  private estimateSheets(s: SessionRow): number | null {
    try {
      const templateId = s.template_id ?? this.firstTemplateIdOrNull(s.id);
      if (!templateId) return null;
      const template = this.d.templates.require(templateId);
      const profile = this.d.profiles.activeProfile(s.language_id).profile;
      const ids = [...new Set([...json<string[]>(s.job_ids, []), ...this.pages(s.id).flatMap((p) => p.items.map((i) => i.jobId))])];
      const found = approvedJobsById(this.d.db, ids);
      const jobs = [...found.values()].filter((j) => !j.quantityMissing && !this.mismatch(j, template, profile));
      if (!jobs.length) return null;
      const planned = this.plan(template, jobs, new Map(jobs.map((j) => [j.id, j.quantity])), profile, []);
      return planned.reduce((n, p) => n + p.copies, 0);
    } catch {
      return null;
    }
  }

  /** Sticker'daki en küçük satırın baskıdaki puntosu okunurluk sınırının altındaysa parametreler; değilse null. */
  private stickerSmallText(variantId: string, legacy: boolean): { orderNo: string; pt: number; minPt: number } | null {
    const v = this.d.variants.row(variantId, true);
    if (!v) return null;
    const job = this.d.jobs.row(v.job_id, true);
    if (!job) return null;
    const { profile } = variantProfile(this.d.profiles, job, v);
    const layout = printLayout(this.d.variants, v, profile);
    if (!layout?.lines.length) return null;
    const size = stickerSizeFor(layout, json<VariantImage | null>(v.image, null), job, profile, 1, legacy);
    const minPx = Math.min(...layout.lines.map((l) => l.sizePx));
    const pt = (minPx * size.mmPerPx) / ptToMm(1);
    const minPt = profile.quality.readableMinPt;
    return pt < minPt ? { orderNo: job.order_no ?? "?", pt: Math.round(pt * 10) / 10, minPt } : null;
  }

  /**
   * Öğelerin ölçüleri (varyasyon başına bir kez): sticker sayfalarında mürekkep kutusu; etiket sayfalarında yalnız
   * şablonun kendi kesimi olan (mm) etiketler (diğerleri yuva ölçüsündedir, masa yuvadan çizer).
   */
  private itemSizes(pages: PrintPageFull[], legacy = false): Record<string, PrintItemSize> {
    const out: Record<string, PrintItemSize> = {};
    const kinds = new Map<string, string | undefined>();
    for (const p of pages) {
      if (!kinds.has(p.templateId)) kinds.set(p.templateId, this.d.templates.find(p.templateId)?.kind);
      const kind = kinds.get(p.templateId);
      for (const it of p.items) {
        if (out[it.variantId]) continue;
        const size = kind === "sticker" ? this.stickerSize(it.variantId, legacy) : this.labelSize(it.variantId);
        if (size) out[it.variantId] = size;
      }
    }
    return out;
  }

  /**
   * Şablonun kendi kesimi olan etiketin ölçüsü (mm): kesim kutusu ve tasarım karesinin (önizleme görseli) merkeze
   * göre kutusu. Çizimle aynı ölçek (`effectiveCut` → geometri `mmPerPx`). Kesimi olmayan etikette null.
   */
  labelSize(variantId: string): PrintItemSize | null {
    const v = this.d.variants.row(variantId, true);
    if (!v) return null;
    const job = this.d.jobs.row(v.job_id, true);
    if (!job || job.kind !== "label") return null;
    // Varyasyonun etkin şablonu (başka şablonda üretildiyse o; çizimle aynı: `render-input.ts`).
    const key = json<{ templateKey?: string | null } | null>(v.snapshot, null)?.templateKey ?? job.template_key;
    if (!key) return null;
    const row = this.d.db
      .prepare(`SELECT ${templateCutSql(this.d.db, "templates")} AS cut FROM templates WHERE org_id = $org AND language_id = ? AND key = ?`)
      .get(job.language_id, key) as { cut: string | null } | undefined;
    const parsed = row?.cut ? TemplateCutSchema.safeParse(json<unknown>(row.cut, null)) : null;
    if (!parsed?.success) return null;
    const { profile } = variantProfile(this.d.profiles, job, v);
    const eff = effectiveCut({ cut: parsed.data }, profile);
    const frame = profile.output.designFramePx * eff.mmPerPx!;
    const hMm = parsed.data.shape === "circle" ? parsed.data.wMm : parsed.data.hMm;
    return { wMm: r2(parsed.data.wMm), hMm: r2(hMm), art: { xMm: r2(-frame / 2), yMm: r2(-frame / 2), wMm: r2(frame), hMm: r2(frame) }, kind: "label" };
  }

  /**
   * Sticker'ın tuval ölçüsü (mm): mürekkep kutusu (planlayıcının kullandığı; öğe merkezi = mürekkep merkezi) ve
   * önizleme görselinin (tasarım karesi) öğe merkezine göre kutusu. Çizimle AYNI hesap (`stickerSizeFor`: mürekkep
   * profildeki sticker sayfasının yazı alanına sığar) ve aynı profil (varyasyonun tasarlandığı sürüm).
   */
  stickerSize(variantId: string, legacy = false): PrintItemSize | null {
    const v = this.d.variants.row(variantId, true);
    if (!v) return null;
    const job = this.d.jobs.row(v.job_id, true);
    if (!job) return null;
    const { profile } = variantProfile(this.d.profiles, job, v);
    const image = json<VariantImage | null>(v.image, null);
    const s = stickerSizeFor(printLayout(this.d.variants, v, profile), image, job, profile, 1, legacy);
    return { wMm: r2(s.wMm), hMm: r2(s.hMm), art: { xMm: r2(s.art.xMm), yMm: r2(s.art.yMm), wMm: r2(s.art.wMm), hMm: r2(s.art.hMm) } };
  }

  /**
   * Sayfanın çizim şablonu: basılmış oturumda "basıldı" anındaki anlık kopya (şablon sonradan değişse de arşiv
   * basıldığı gibi kalır), taslakta güncel şablon. Kopyada yoksa (eski kayıt) güncel şablon.
   */
  pageTemplate(sessionId: string, templateId: string): PrintTemplate {
    const s = this.row(sessionId);
    const snap = s.status === "printed" ? this.snapshots(s)?.[templateId] : undefined;
    return snap ?? this.d.templates.require(templateId);
  }

  /** Tek sayfa (çizim için) ve oturumu. */
  page(pageId: string): { session: SessionRow; page: PrintPageRecord } {
    const p = this.d.db.prepare("SELECT * FROM print_pages WHERE id = ? AND org_id = $org AND deleted_at IS NULL").get(pageId) as PageRow | undefined;
    if (!p) throw fail("print-page-not-found");
    const session = this.row(p.session_id);
    const page = this.pages(session.id).find((x) => x.id === pageId);
    if (!page) throw fail("print-page-not-found");
    return { session, page };
  }

  list(q: ListQuery): PrintSessionSummary[] {
    const where = ["deleted_at IS NULL"];
    const args: string[] = [];
    if (q.languageId) {
      where.push("language_id = ?");
      args.push(q.languageId);
    }
    if (q.status) {
      where.push("status = ?");
      args.push(q.status);
    }
    const rows = this.d.db
      .prepare(`SELECT * FROM print_sessions WHERE org_id = $org AND ${where.join(" AND ")} ORDER BY COALESCE(printed_at, updated_at) DESC, created_at DESC`)
      .all(...args) as unknown as SessionRow[];
    const needle = fold(q.q ?? "").trim();
    const out: PrintSessionSummary[] = [];
    for (const s of rows) {
      const stats = this.d.db
        .prepare(
          `SELECT COUNT(DISTINCT p.id) AS pages, COALESCE(SUM(p.copies), 0) AS sheets FROM print_pages p WHERE p.org_id = $org AND p.session_id = ? AND p.deleted_at IS NULL`,
        )
        .get(s.id) as { pages: number; sheets: number };
      const jobs = this.d.db
        .prepare(
          `SELECT i.job_id, COUNT(*) AS n, j.order_no, j.text FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org LEFT JOIN jobs j ON j.id = i.job_id AND j.org_id = $org
           WHERE i.org_id = $org AND p.session_id = ? AND p.deleted_at IS NULL GROUP BY i.job_id, j.order_no, j.text ORDER BY MIN(p.idx)`,
        )
        .all(s.id) as { job_id: string; n: number; order_no: string | null; text: string | null }[];
      if (needle) {
        const pageNames = (this.d.db.prepare("SELECT name FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").all(s.id) as { name: string }[]).map((r) => r.name);
        const hay = fold([s.name, ...pageNames, ...jobs.flatMap((j) => [j.order_no ?? "", j.text ?? ""])].join("\n"));
        if (!hay.includes(needle)) continue;
      }
      out.push({
        id: s.id,
        languageId: s.language_id,
        name: s.name,
        status: s.status,
        version: s.version,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        printedAt: s.printed_at,
        pageCount: Number(stats.pages),
        sheetCount: Number(stats.sheets),
        itemCount: jobs.reduce((a, j) => a + Number(j.n), 0),
        jobCount: jobs.length,
        orderNos: [...new Set(jobs.map((j) => j.order_no).filter((x): x is string => !!x))],
        sourceSessionId: s.source_session_id,
        noticeCodes: this.noticeCodes(s),
      });
      if (out.length >= q.limit) break;
    }
    return out;
  }

  /** Liste satırının bildirim kodları (`noticeState`; parametreli metin ve `sticker-small-text` yalnız ayrıntıda). */
  private noticeCodes(s: SessionRow): PrintSessionSummary["noticeCodes"] {
    // Basılmış ve bugünkü kuralla dizilmiş oturumda bildirim olamaz: sayfalar okunmaz.
    if (s.status === "printed" && !this.legacyRow(s)) return [];
    const { planStale, oldScale } = this.noticeState(s, this.pages(s.id));
    return [...(planStale ? (["plan-stale"] as const) : []), ...(oldScale ? (["printed-old-scale"] as const) : [])];
  }

  // ---------------------------------------------------------------- oturum kurma

  /** Onaylı işlerden oturum: şablona uyan işler planlanır; uymayanlar `skipped`. */
  create(input: CreateInput): { session: PrintSessionDetail; skipped: PrintSkipped[]; warnings: string[] } {
    const template = this.d.templates.require(input.templateId);
    if (template.languageId !== input.languageId) throw fail("template-other-language");
    if (template.archived) throw fail("template-archived");
    const profile = this.d.profiles.activeProfile(input.languageId).profile;
    const skipped: PrintSkipped[] = [];
    const warnings: string[] = [];
    const printed = printedJobIds(this.d.db, input.languageId);
    let candidates: PrintJob[];
    if (input.jobIds) {
      const found = approvedJobsById(this.d.db, [...new Set(input.jobIds)]);
      candidates = [];
      for (const id of new Set(input.jobIds)) {
        const j = found.get(id);
        if (!j) skipped.push({ jobId: id, reason: "İş bulunamadı ya da onaylı varyasyonu yok." });
        else if (j.languageId !== input.languageId) skipped.push({ jobId: id, reason: "İş başka bir tasarım dilinde." });
        else candidates.push(j);
      }
      for (const j of candidates) if (printed.has(j.id)) warnings.push(`${orderNoOf(j)} daha önce basıldı; yeniden basılıyor.`);
    } else {
      const placed = placedCounts(this.d.db, input.languageId);
      candidates = approvedJobs(this.d.db, input.languageId, SHELF_STATUSES).filter((j) => !printed.has(j.id) && !placed.get(j.id));
    }
    const fits: PrintJob[] = [];
    for (const j of candidates) {
      const reason = this.mismatch(j, template, profile);
      if (reason) {
        if (input.jobIds) skipped.push({ jobId: j.id, reason });
      } else if (j.quantityMissing) {
        // Kullanıcı kararı (2026-10-10): adedi olmayan sipariş planlanmaz; adet girilince normal akışa girer.
        skipped.push({ jobId: j.id, reason: `${orderNoOf(j)}: adet yok; planlanmadı (adet girilince planlanır).` });
      } else fits.push(j);
    }
    fits.sort(planOrder);
    this.shapeWarnings(fits, template, warnings);
    if (!fits.length) {
      const noQuantity = skipped.length > 0 && skipped.every((x) => x.reason.includes("adet yok"));
      if (input.jobIds) throw fail(noQuantity ? "session-no-matching-jobs-quantity" : "session-no-matching-jobs");
      throw fail(noQuantity ? "shelf-no-matching-jobs-quantity" : "shelf-no-matching-jobs");
    }

    const planned = this.plan(template, fits, new Map(fits.map((j) => [j.id, j.quantity])), profile, warnings);
    const now = this.now();
    const id = randomUUID();
    const orderNos = [...new Set(fits.map(orderNoOf))];
    const name = input.name ?? `${orderNos.slice(0, 4).join("_")}${orderNos.length > 4 ? "…" : ""} · ${template.name}`;
    this.d.db.tx(() => {
      this.d.db
        .prepare(
          `INSERT INTO print_sessions (org_id, id, language_id, name, status, version, template_id, job_ids, created_at, updated_at, plan_version) VALUES ($org, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.languageId, name, template.id, JSON.stringify(fits.map((j) => j.id)), now, now, PLAN_VERSION);
      this.insertPlanned(id, template, planned, 0);
      this.syncSlotRotations(id);
    });
    this.emit(input.languageId, id);
    return { session: this.detail(id), skipped, warnings };
  }

  /**
   * Şablonun kendi kesimi olan işler yuvaya uymuyorsa (daire yuvaya dikdörtgen etiket, ölçü farkı > 0,5 mm) görünür
   * uyarı: etiket kendi ölçüsünde basılır, kesim çizgisi yuvadadır. Engellemez.
   */
  private shapeWarnings(jobs: readonly PrintJob[], t: PrintTemplate, warnings: string[]): void {
    if (t.kind !== "label" || !t.slots.length) return;
    const slotName = (s: PrintSlot) => (s.shape === "circle" ? `Ø${r2(s.w)} mm daire` : `${r2(s.w)} × ${r2(s.h)} mm ${s.shape === "ellipse" ? "oval" : "dikdörtgen"}`);
    for (const j of jobs) {
      if (!j.cut) {
        // Kesimsiz (daire) etiket dikdörtgen yuvada: etiket kısa kenara sığdırılır, kesim çizgisi daireye oturmaz.
        const rect = t.slots.find((s) => s.shape === "rect");
        if (rect) warnings.push(`${orderNoOf(j)}: daire etiket, sayfa şablonunun yuvası ${slotName(rect)}; kesim çizgisi etikete oturmaz (daire yuvalı sayfa şablonu seçin).`);
        continue;
      }
      const cut = j.cut;
      const bad = t.slots.filter((s) => !slotFitsCut(s, cut));
      if (bad.length) {
        warnings.push(`${orderNoOf(j)}: etiket ${cutLabel(cut)}, sayfa şablonunun yuvası ${slotName(bad[0]!)}; kesim çizgisi etikete oturmaz (uygun yuvalı sayfa şablonu seçin).`);
        continue;
      }
      const corner = t.slots.find((s) => cornerMismatchMm(s, cut) > 0.5);
      if (corner) {
        warnings.push(`${orderNoOf(j)}: etiketin köşe yarıçapı ${r2(normalizeCut(cut).radiusMm)} mm, yuvanınki ${r2(corner.cornerRadius)} mm; kesim köşelerde etikete oturmaz.`);
      }
    }
  }

  /**
   * Yuvadaki kesimli etiketlerin dönüşü yuvanın yönüne eşitlenir (dikey dikdörtgen yuvada çeyrek tur): plan, masa
   * çizimi ve PDF/PNG aynı `rotation`'ı kullanır. `skip`: elle açı verilmiş öğeler. Uymayan yuvada dokunulmaz (uyarı
   * `shapeWarnings`'te).
   */
  private syncSlotRotations(sessionId: string, skip: ReadonlySet<string> = new Set()): void {
    const db = this.d.db;
    const rows = db
      .prepare(
        `SELECT i.id, i.job_id, i.slot_id, i.rotation, p.template_id FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org
         WHERE i.org_id = $org AND p.session_id = ? AND p.deleted_at IS NULL AND i.slot_id IS NOT NULL`,
      )
      .all(sessionId) as { id: string; job_id: string; slot_id: string; rotation: number; template_id: string }[];
    if (!rows.length) return;
    const cuts = jobCuts(db, [...new Set(rows.map((r) => r.job_id))]);
    if (!cuts.size) return;
    const templates = new Map<string, PrintTemplate | null>();
    const upd = db.prepare("UPDATE print_items SET rotation = ? WHERE id = ? AND org_id = $org");
    for (const r of rows) {
      const cut = cuts.get(r.job_id);
      if (!cut || skip.has(r.id)) continue;
      if (!templates.has(r.template_id)) templates.set(r.template_id, this.d.templates.find(r.template_id));
      const slot = templates.get(r.template_id)?.slots.find((x) => x.id === r.slot_id);
      const rot = slot ? cutRotationForSlot(slot, cut) : null;
      if (rot !== null && rot !== r.rotation) upd.run(rot, r.id);
    }
  }

  /** İş şablona uymuyorsa nedeni. */
  private mismatch(j: PrintJob, t: PrintTemplate, profile: Profile): string | null {
    if (j.kind !== t.kind) return j.kind === "sticker" ? "Sticker işi etiket şablonuna konmaz." : "Etiket işi sticker şablonuna konmaz.";
    const size = sizeOf(j, profile);
    if (t.sizeId !== null && size !== t.sizeId) return `Boyut uyuşmuyor (iş ${size ?? "?"}, şablon ${t.sizeId}).`;
    return null;
  }

  /** Planlayıcıyı çağırır ve çıktısını şablona göre doğrular (bilinmeyen yuva → serbest konum). */
  private plan(t: PrintTemplate, jobs: PrintJob[], quantities: Map<string, number>, profile: Profile, warnings: string[]): PlannedPage[] {
    const orders = this.planOrders(t, jobs, quantities);
    if (!orders.length) return [];
    const pages = this.callPlanner(() =>
      t.kind === "sticker"
        ? this.planner.planStickerPages({ orders: orders as PlanStickerOrder[], template: t, rules: profile.printing })
        : this.planner.planLabelPages({ orders, template: t, rules: profile.printing }),
    );
    return this.sanitize(pages, orders, t, warnings);
  }

  /** Planlayıcıya giden siparişler (adedi > 0 olan işler; sticker'da mürekkep ölçüsüyle). */
  private planOrders(t: PrintTemplate, jobs: PrintJob[], quantities: Map<string, number>): PlanOrder[] {
    const orders: PlanOrder[] = jobs
      .filter((j) => (quantities.get(j.id) ?? 0) > 0)
      .map((j) => ({ jobId: j.id, variantId: j.variantId, orderNo: orderNoOf(j), quantity: quantities.get(j.id)!, designKey: designKeyOf(j) }));
    return t.kind === "sticker" ? orders.map((o) => this.stickerOrder(o)) : orders;
  }

  private callPlanner<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw fail("plan-failed", { detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Planlayıcı çıktısını şablona göre doğrular: bilinmeyen iş / geçersiz konum atlanır (uyarı), bilinmeyen yuva →
   * serbest konum. Elle öğeler (yeniden planlamada korunanlar, zaten kayıtlı) olduğu gibi kalır.
   */
  private sanitize<P extends PlannedPage>(pages: P[], orders: PlanOrder[], t: PrintTemplate, warnings: string[]): P[] {
    const known = new Map(orders.map((o) => [o.jobId, o]));
    const slotIds = new Set(t.slots.map((s) => s.id));
    let dropped = 0;
    const out = pages.map((p) => ({
      ...p,
      copies: Math.max(1, Math.round(p.copies || 1)),
      items: p.items.flatMap((it) => {
        if ((it as { manual?: boolean }).manual) return [it];
        const o = known.get(it.jobId);
        if (!o || !Number.isFinite(it.xMm) || !Number.isFinite(it.yMm)) {
          dropped++;
          return [];
        }
        return [{ ...it, variantId: it.variantId || o.variantId, slotId: it.slotId && slotIds.has(it.slotId) ? it.slotId : null }];
      }),
    }));
    if (dropped) warnings.push(`Planlayıcının ${dropped} öğesi geçersizdi ve atlandı.`);
    return out.filter((p) => p.items.length);
  }

  /** Sticker ölçüsü (mm): varyasyonun (düzeltilmiş) mürekkep kutusu yazı alanına sığmış hâliyle (`stickerSize`). */
  private stickerOrder(o: PlanOrder): PlanStickerOrder {
    const size = this.stickerSize(o.variantId);
    const fallback = r2(STICKER_FALLBACK_AREA.wMm);
    return { ...o, wMm: size?.wMm ?? fallback, hMm: size?.hMm ?? fallback };
  }

  // ---------------------------------------------------------------- raf: ilk plan toplamı

  /**
   * Raf `needed`: işlerin İLK PLAN toplamı (adet + fazlalık; yeniden planlamanın kullandığı sayı). Taslak oturumdaki
   * iş o oturumun planından (oturumun şablonu + oturumun işleri birlikte, `replan` ile aynı hesap); taslakta olmayan iş,
   * aynı tür/boyuttaki diğerleriyle birlikte grubun şablonuyla ("Planla" ne yapacaksa). Şablon yoksa ya da plan
   * yapılamazsa iş haritada olmaz (raf formüle düşer, "≈").
   */
  plannedNeeds(languageId: string, jobs: PrintJob[], profile: Profile, pickTemplate: (j: PrintJob) => PrintTemplate | null): Map<string, number> {
    const out = new Map<string, number>();
    const planner = this.d.ports.printPlanner;
    if (!planner) return out;
    const wanted = new Set(jobs.map((j) => j.id));
    const totals = (t: PrintTemplate, list: PrintJob[]) => {
      try {
        const pages = this.plan(t, list, new Map(list.map((j) => [j.id, j.quantity])), profile, []);
        const m = new Map<string, number>();
        for (const p of pages) for (const it of p.items) m.set(it.jobId, (m.get(it.jobId) ?? 0) + p.copies);
        return m;
      } catch {
        return null;
      }
    };
    // 1) Taslak oturumlar.
    const drafts = this.d.db
      .prepare("SELECT * FROM print_sessions WHERE org_id = $org AND language_id = ? AND status = 'draft' AND deleted_at IS NULL ORDER BY created_at")
      .all(languageId) as unknown as SessionRow[];
    for (const s of drafts) {
      const ids = [...new Set([...json<string[]>(s.job_ids, []), ...this.pages(s.id).flatMap((p) => p.items.map((i) => i.jobId))])];
      if (!ids.some((x) => wanted.has(x) && !out.has(x))) continue;
      const tid = s.template_id ?? this.firstTemplateIdOrNull(s.id);
      const t = tid ? this.d.templates.find(tid) : null;
      if (!t) continue;
      const found = approvedJobsById(this.d.db, ids);
      const list = ids.flatMap((x) => {
        const j = found.get(x);
        return j && j.quantity > 0 && !this.mismatch(j, t, profile) ? [j] : [];
      });
      const m = list.length ? totals(t, list) : null;
      if (m) for (const j of list) if (wanted.has(j.id) && !out.has(j.id)) out.set(j.id, m.get(j.id) ?? 0);
    }
    // 2) Taslakta olmayanlar: aynı şablona düşenler birlikte.
    const groups = new Map<string, { t: PrintTemplate; list: PrintJob[] }>();
    for (const j of jobs) {
      if (out.has(j.id) || !(j.quantity > 0)) continue;
      const t = pickTemplate(j);
      if (!t || this.mismatch(j, t, profile)) continue;
      const g = groups.get(t.id) ?? { t, list: [] };
      g.list.push(j);
      groups.set(t.id, g);
    }
    for (const { t, list } of groups.values()) {
      const m = totals(t, list);
      if (m) for (const j of list) out.set(j.id, m.get(j.id) ?? 0);
    }
    return out;
  }

  private insertPlanned(sessionId: string, t: PrintTemplate, pages: PlannedPage[], startIdx: number): void {
    const insPage = this.d.db.prepare(
      "INSERT INTO print_pages (org_id, id, session_id, template_id, idx, name, copies, kind, show_cell_labels, locked) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    );
    const insItem = this.d.db.prepare(
      "INSERT INTO print_items (org_id, id, page_id, job_id, variant_id, slot_id, x_mm, y_mm, rotation, scale, extra, manual, z) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 0, 0)",
    );
    pages.forEach((p, i) => {
      const pageId = randomUUID();
      insPage.run(pageId, sessionId, t.id, startIdx + i, p.name, p.copies, p.kind === "full" || p.kind === "mixed" ? p.kind : "manual", t.cellLabel.enabledByDefault ? 1 : 0);
      for (const it of p.items) insItem.run(randomUUID(), pageId, it.jobId, it.variantId, it.slotId, r2(it.xMm), r2(it.yMm), it.extra ? 1 : 0);
    });
  }

  // ---------------------------------------------------------------- yeniden planlama

  /**
   * Yeniden planla: kilitli sayfalar ve elle konmuş öğeler kalır; geri kalan plan öğeleri silinip oturumun işleri
   * yeniden planlanır. Planı boşalan otomatik sayfalar kalkar.
   *
   * Planlayıcı `reflowPages` veriyorsa (gerçek bağlantı): sipariş başına kalan = ilk plandaki toplam (adet + fazlalık)
   * − yerleşmiş (kilitli sayfalar + elle öğeler, × kopya; raftaki `placed` ile aynı sayım); kalana fazlalık yeniden
   * eklenmez. Elle öğeli kilitsiz etiket sayfasının boş yuvaları doldurulur, yeni sayfalar sona eklenir.
   * Vermiyorsa yaklaşık yol: kalan adet (adet − yerleşmiş) düz plan olarak sona eklenir (fazlalık yeniden eklenir).
   */
  replan(id: string, version: number): PrintSessionPatchResponse {
    const s = this.editable(id, version);
    const profile = this.d.profiles.activeProfile(s.language_id).profile;
    const template = this.d.templates.require(s.template_id ?? this.firstTemplateId(id));
    const warnings: string[] = [];
    const pages = this.pages(id);
    const itemJobs = pages.flatMap((p) => p.items.map((i) => i.jobId));
    const jobIds = [...new Set([...json<string[]>(s.job_ids, []), ...itemJobs])];
    const found = approvedJobsById(this.d.db, jobIds);
    const jobs: PrintJob[] = [];
    const skipped: PrintSkipped[] = [];
    for (const jid of jobIds) {
      const j = found.get(jid);
      if (!j) {
        warnings.push(`Bir iş artık onaylı değil ya da silindi; planlanmadı (${jid}).`);
        skipped.push({ jobId: jid, reason: "İş artık onaylı değil ya da silindi." });
        continue;
      }
      const reason = this.mismatch(j, template, profile);
      if (reason) {
        warnings.push(`${orderNoOf(j)}: ${reason}`);
        skipped.push({ jobId: j.id, reason });
      } else if (j.quantityMissing) {
        // Adedi olmayan iş planlanmaz; sayfadaki elle konmuş öğeleri yine korunur.
        skipped.push({ jobId: j.id, reason: `${orderNoOf(j)}: adet yok; planlanmadı.` });
      } else jobs.push(j);
    }
    // Oturum kurmadaki gibi: kesimli etiket sayfa şablonunun yuvasına uymuyorsa görünür uyarı (engellemez).
    this.shapeWarnings(jobs, template, warnings);
    const reflow = this.d.ports.printPlanner?.reflowPages;
    if (reflow) this.applyReflow(s, pages, template, jobs, profile, warnings, (req) => reflow(req));
    else this.applyApproxReplan(s, template, jobs, profile, warnings);
    this.d.db.tx(() => {
      this.d.db.prepare("UPDATE print_sessions SET plan_version = ? WHERE id = ? AND org_id = $org").run(PLAN_VERSION, id);
      this.syncSlotRotations(id);
    });
    this.emit(s.language_id, id);
    return { session: this.detail(id), warnings, undo: null, skipped };
  }

  /**
   * Açık taslağa iş ekle: sayfadaki her öğe (plan öğeleri dahil) yerinde kalır, yerleşmiş sayılır; planlayıcı
   * yalnızca eklenen işleri yerleştirir — önce kilitsiz, tek kopyalı, oturumun şablonundaki sayfaların boş yuvalarına,
   * sonra sona yeni sayfalara. Hedef = işin ilk plan toplamı (adet + fazlalık) − bu oturumda zaten yerleşmiş.
   * Uymayan / adedi olmayan / bulunamayan işler `skipped`. Eklenen işler oturumun iş listesine girer (yeniden
   * planlama onları da kapsar).
   */
  addJobs(id: string, version: number, jobIds: string[]): PrintSessionPatchResponse {
    const s = this.editable(id, version);
    const profile = this.d.profiles.activeProfile(s.language_id).profile;
    const template = this.d.templates.require(s.template_id ?? this.firstTemplateId(id));
    const warnings: string[] = [];
    const skipped: PrintSkipped[] = [];
    const found = approvedJobsById(this.d.db, [...new Set(jobIds)]);
    const printed = printedJobIds(this.d.db, s.language_id);
    const elsewhere = placedCounts(this.d.db, s.language_id, s.id);
    const jobs: PrintJob[] = [];
    for (const jid of new Set(jobIds)) {
      const j = found.get(jid);
      if (!j) skipped.push({ jobId: jid, reason: "İş bulunamadı ya da onaylı varyasyonu yok." });
      else if (j.languageId !== s.language_id) skipped.push({ jobId: jid, reason: "İş başka bir tasarım dilinde." });
      else {
        const reason = this.mismatch(j, template, profile);
        if (reason) skipped.push({ jobId: jid, reason: `${orderNoOf(j)}: ${reason}` });
        else if (j.quantityMissing) skipped.push({ jobId: jid, reason: `${orderNoOf(j)}: adet yok; planlanmadı (adet girilince eklenebilir).` });
        else {
          if (printed.has(j.id)) warnings.push(`${orderNoOf(j)} daha önce basıldı; yeniden basılıyor.`);
          if (elsewhere.get(j.id)) warnings.push(`${orderNoOf(j)} başka bir taslak oturumda da var (${elsewhere.get(j.id)} adet).`);
          jobs.push(j);
        }
      }
    }
    this.shapeWarnings(jobs, template, warnings);
    if (!jobs.length) {
      this.emit(s.language_id, id);
      return { session: this.detail(id), warnings, undo: null, skipped };
    }
    const pages = this.pages(id);
    // Hedef = OTURUMUN ilk planındaki toplam (oturumun işleri + eklenenler birlikte; yeniden planlamanın ve rafın
    // kullandığı sayı) − yerleşmiş. Oturumdaki işler de siparişe girer ama onlara çıkan yeni öğeler atılır:
    // yalnızca eklenen işler yerleşir.
    const newIds = new Set(jobs.map((j) => j.id));
    const existingIds = [...new Set([...json<string[]>(s.job_ids, []), ...pages.flatMap((p) => p.items.map((i) => i.jobId))])].filter((x) => !newIds.has(x));
    const existingFound = approvedJobsById(this.d.db, existingIds);
    const existing = existingIds.flatMap((x) => {
      const j = existingFound.get(x);
      return j && j.quantity > 0 && !this.mismatch(j, template, profile) ? [j] : [];
    });
    const all = [...existing, ...jobs];
    const orders = this.planOrders(template, all, new Map(all.map((j) => [j.id, j.quantity])));
    const variantOf = new Map(orders.map((o) => [o.jobId, o.variantId]));
    const reflow = this.d.ports.printPlanner?.reflowPages;
    const db = this.d.db;
    const insItem = db.prepare(
      "INSERT INTO print_items (org_id, id, page_id, job_id, variant_id, slot_id, x_mm, y_mm, rotation, scale, extra, manual, z) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 0, 0)",
    );
    if (reflow) {
      // Sayfadaki her şey "elle" sayılır: planlayıcı dokunmaz, yalnızca boşluklara yeni işleri koyar.
      const input: ReflowInputPage[] = pages.map((p) => ({
        locked: p.locked,
        copies: p.copies,
        fill: p.templateId === template.id,
        items: p.items.map((it) => ({ jobId: it.jobId, variantId: variantOf.get(it.jobId) ?? it.variantId, slotId: it.slotId, xMm: it.xMm, yMm: it.yMm, extra: it.extra, manual: true })),
      }));
      const out = this.sanitize(
        this.callPlanner(() => reflow({ pages: input, orders, template, rules: profile.printing })),
        orders,
        template,
        warnings,
      );
      db.tx(() => {
        for (const p of out) {
          const fresh = p.items.filter((it) => !it.manual && newIds.has(it.jobId));
          if (!fresh.length) continue;
          const page = p.fromIndex != null ? pages[p.fromIndex] : undefined;
          if (page && !page.locked) {
            for (const it of fresh) insItem.run(randomUUID(), page.id, it.jobId, it.variantId, it.slotId, r2(it.xMm), r2(it.yMm), it.extra ? 1 : 0);
            // Otomatik adlı karışık sayfanın adı yeni siparişi de içersin ("4849_4850_1sayfa"); elle adlandırılan kalır.
            if (page.kind !== "manual") db.prepare("UPDATE print_pages SET name = ?, kind = 'mixed' WHERE id = ? AND org_id = $org").run(p.name, page.id);
          } else if (p.fromIndex == null) {
            const next = (db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").get(s.id) as { n: number }).n;
            // Oturumdaki işlerin öğeleri atıldıysa sayfa adı yalnızca eklenen siparişlerden.
            const name =
              fresh.length === p.items.length ? p.name : `${[...new Set(fresh.map((it) => orders.find((o) => o.jobId === it.jobId)?.orderNo ?? ""))].join("_")}_${p.copies}sayfa`;
            this.insertPlanned(s.id, template, [{ ...p, name, items: fresh }], Number(next));
          }
        }
        this.addJobIds(s, jobs.map((j) => j.id));
        this.compact(s.id);
        this.bump(s.id);
      });
    } else {
      // Yaklaşık yol: eklenen işlerin düz planı sona.
      const planned = this.plan(template, jobs, new Map(jobs.map((j) => [j.id, j.quantity])), profile, warnings);
      db.tx(() => {
        const next = (db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").get(s.id) as { n: number }).n;
        this.insertPlanned(s.id, template, planned, Number(next));
        this.addJobIds(s, jobs.map((j) => j.id));
        this.compact(s.id);
        this.bump(s.id);
      });
    }
    this.d.db.tx(() => this.syncSlotRotations(id));
    this.emit(s.language_id, id);
    return { session: this.detail(id), warnings, undo: null, skipped };
  }

  private addJobIds(s: SessionRow, ids: string[]): void {
    const cur = json<string[]>(s.job_ids, []);
    const next = [...new Set([...cur, ...ids])];
    if (next.length !== cur.length) this.d.db.prepare("UPDATE print_sessions SET job_ids = ? WHERE id = ? AND org_id = $org").run(JSON.stringify(next), s.id);
  }

  private applyReflow(
    s: SessionRow,
    pages: PrintPageFull[],
    template: PrintTemplate,
    jobs: PrintJob[],
    profile: Profile,
    warnings: string[],
    reflow: NonNullable<PrintPlanner["reflowPages"]>,
  ): void {
    const orders = this.planOrders(template, jobs, new Map(jobs.map((j) => [j.id, j.quantity])));
    const variantOf = new Map(orders.map((o) => [o.jobId, o.variantId]));
    // Sayım iş başına (raf gibi): elle başka varyasyona çevrilmiş öğe de siparişin yerleşmişi sayılır.
    const input: ReflowInputPage[] = pages.map((p) => ({
      locked: p.locked,
      copies: p.copies,
      fill: p.templateId === template.id,
      items: p.items.map((it) => ({ jobId: it.jobId, variantId: variantOf.get(it.jobId) ?? it.variantId, slotId: it.slotId, xMm: it.xMm, yMm: it.yMm, extra: it.extra, manual: it.manual })),
    }));
    const out = this.sanitize(
      this.callPlanner(() => reflow({ pages: input, orders, template, rules: profile.printing })),
      orders,
      template,
      warnings,
    );
    const kept = new Map<number, ReflowedPage>();
    const fresh: ReflowedPage[] = [];
    for (const p of out) {
      if (p.fromIndex != null && pages[p.fromIndex] && !pages[p.fromIndex]!.locked) kept.set(p.fromIndex, p);
      else if (p.fromIndex == null) fresh.push(p);
    }
    const db = this.d.db;
    db.tx(() => {
      const dropAuto = db.prepare("DELETE FROM print_items WHERE org_id = $org AND page_id = ? AND manual = 0");
      const insItem = db.prepare(
        "INSERT INTO print_items (org_id, id, page_id, job_id, variant_id, slot_id, x_mm, y_mm, rotation, scale, extra, manual, z) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 0, 0)",
      );
      pages.forEach((p, i) => {
        if (p.locked) return;
        const k = kept.get(i);
        // Sticker'da elle öğeli sayfa olduğu gibi korunur (akış serbest konumlu; üstüne ekleme yapılmaz).
        if (k && template.kind === "sticker") return;
        dropAuto.run(p.id);
        if (k) {
          for (const it of k.items) if (!it.manual) insItem.run(randomUUID(), p.id, it.jobId, it.variantId, it.slotId, r2(it.xMm), r2(it.yMm), it.extra ? 1 : 0);
          if (p.kind !== "manual") db.prepare("UPDATE print_pages SET name = ?, kind = ? WHERE id = ? AND org_id = $org").run(k.name, k.kind === "full" ? "full" : "mixed", p.id);
        } else if (p.kind !== "manual" && !p.items.some((it) => it.manual)) {
          db.prepare("DELETE FROM print_pages WHERE id = ? AND org_id = $org").run(p.id);
        }
      });
      const next = (db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").get(s.id) as { n: number }).n;
      this.insertPlanned(s.id, template, fresh, Number(next));
      this.compact(s.id);
      this.bump(s.id);
    });
  }

  /** Planlayıcı `reflowPages` vermezse: kalan adet (adet − kilitli/elle yerleşmiş) düz plan olarak sona eklenir. */
  private applyApproxReplan(s: SessionRow, template: PrintTemplate, jobs: PrintJob[], profile: Profile, warnings: string[]): void {
    const id = s.id;
    const kept = new Map(
      (
        this.d.db
          .prepare(
            `SELECT i.job_id, SUM(p.copies) AS n FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org
             WHERE i.org_id = $org AND p.session_id = ? AND p.deleted_at IS NULL AND (p.locked = 1 OR i.manual = 1) GROUP BY i.job_id`,
          )
          .all(id) as { job_id: string; n: number }[]
      ).map((r) => [r.job_id, Number(r.n)]),
    );
    const quantities = new Map(jobs.map((j) => [j.id, Math.max(0, j.quantity - (kept.get(j.id) ?? 0))]));
    const planned = this.plan(template, jobs, quantities, profile, warnings);
    this.d.db.tx(() => {
      this.d.db
        .prepare("DELETE FROM print_items WHERE org_id = $org AND manual = 0 AND page_id IN (SELECT id FROM print_pages WHERE print_pages.org_id = $org AND session_id = ? AND locked = 0 AND deleted_at IS NULL)")
        .run(id);
      this.d.db
        .prepare(
          `DELETE FROM print_pages WHERE org_id = $org AND session_id = ? AND locked = 0 AND deleted_at IS NULL AND kind <> 'manual'
           AND NOT EXISTS (SELECT 1 FROM print_items i WHERE i.org_id = $org AND i.page_id = print_pages.id)`,
        )
        .run(id);
      const next = (this.d.db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").get(id) as { n: number }).n;
      this.insertPlanned(id, template, planned, Number(next));
      this.compact(id);
      this.bump(id);
    });
  }

  // ---------------------------------------------------------------- toplu yama

  patch(id: string, version: number, ops: PrintPatchOp[]): PrintSessionPatchResponse {
    const s = this.editable(id, version);
    const warnings: string[] = [];
    const removedPages: string[] = [];
    // İstemcinin `addPage`/`addItem` kimliği → kayıttaki kimlik (aynı yamadaki başvurular çevrilir, yanıtta döner).
    const ids = new Map<string, string>();
    const resolved: PrintPatchOp[] = [];
    this.d.db.tx(() => {
      for (const op of ops) {
        const r = resolveIds(op, ids);
        resolved.push(r);
        this.apply(s, r, warnings, removedPages, ids);
      }
      this.compact(id);
      // Elle açı verilen öğe dışında, yuvadaki kesimli etiket yuvanın yönüne döner.
      this.syncSlotRotations(id, new Set([...manualAngles(resolved)].map((x) => ids.get(x) ?? x)));
      this.bump(id);
    });
    const undo = removedPages.length ? this.d.undo.printDeleted(removedPages.length === 1 ? undoMsg("print-page-deleted") : undoMsg("print-pages-deleted", { count: removedPages.length }), [], removedPages) : null;
    this.emit(s.language_id, id);
    return { session: this.detail(id), warnings, undo, ...(ids.size ? { ids: Object.fromEntries(ids) } : {}) };
  }

  private apply(s: SessionRow, op: PrintPatchOp, warnings: string[], removedPages: string[], idMap: Map<string, string>): void {
    const db = this.d.db;
    switch (op.op) {
      case "renameSession":
        db.prepare("UPDATE print_sessions SET name = ? WHERE id = ? AND org_id = $org").run(op.name, s.id);
        return;

      case "addItem": {
        const page = this.pageRow(s.id, op.pageId);
        const t = this.d.templates.require(page.template_id);
        const job = this.d.jobs.row(op.jobId);
        if (!job || job.language_id !== s.language_id) throw fail("job-not-found");
        if (job.kind !== t.kind) throw fail(job.kind === "sticker" ? "sticker-on-label-page" : "label-on-sticker-page");
        const variantId = op.variantId ?? job.approved_variant_id;
        if (!variantId) throw fail("no-approved-variant");
        this.requireVariant(variantId, job.id);
        let slot: PrintSlot | null = null;
        let x = op.xMm;
        let y = op.yMm;
        let keepXY = false;
        if (op.slotId) {
          slot = this.slot(t, op.slotId);
          if (this.occupant(page.id, slot.id)) throw fail("slot-occupied", { slot: slot.id });
          // Yuva + konum birlikte verilirse konum korunur (yuva içinde ofset; ör. geri alınan ince ayarlı öğe).
          keepXY = x !== undefined && y !== undefined;
        } else if (op.slotId === undefined && (x === undefined || y === undefined)) {
          slot = this.freeSlot(page.id, t);
          if (!slot) throw fail("no-free-slot");
        }
        if (slot && !keepXY) {
          x = slot.cx;
          y = slot.cy;
        }
        if (x === undefined || y === undefined) throw fail("free-position-required");
        const z = op.z ?? this.maxZ(page.id) + 1;
        const insert = db.prepare(
          "INSERT INTO print_items (org_id, id, page_id, job_id, variant_id, slot_id, x_mm, y_mm, rotation, scale, extra, manual, z) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        this.claimId(op.id, idMap, (rowId) =>
          insert.run(rowId, page.id, job.id, variantId, slot?.id ?? null, r2(x), r2(y), op.rotation ?? 0, op.scale ?? 1, op.extra ? 1 : 0, op.manual === false ? 0 : 1, z),
        );
        if (!this.inPaper(t, x, y)) warnings.push("Eklenen öğe kağıdın dışında.");
        return;
      }

      case "moveItem": {
        const item = this.itemRow(s.id, op.itemId);
        const target = op.pageId ? this.pageRow(s.id, op.pageId) : this.pageRow(s.id, item.page_id);
        const t = this.d.templates.require(target.template_id);
        const manual = op.manual === false ? 0 : 1;
        if (target.id !== item.page_id) {
          const job = this.d.jobs.row(item.job_id, true);
          if (job && job.kind !== t.kind) throw fail(job.kind === "sticker" ? "sticker-move-to-label" : "label-move-to-sticker");
        }
        if (op.slotId) {
          const slot = this.slot(t, op.slotId);
          if (target.id === item.page_id && item.slot_id === slot.id) {
            // Aynı yuvada: yuva içinde ince ayar (ofset korunur).
            const x = op.xMm ?? item.x_mm;
            const y = op.yMm ?? item.y_mm;
            db.prepare("UPDATE print_items SET x_mm = ?, y_mm = ?, manual = ? WHERE id = ? AND org_id = $org").run(r2(x), r2(y), manual, item.id);
            return;
          }
          const other = this.occupant(target.id, slot.id);
          if (other && other.id !== item.id) {
            // Yer değiştir: dolu yuvadaki öğe taşınanın eski yerine (eski yuvanın merkezine) geçer.
            const from = item.slot_id ? this.d.templates.find(this.pageRow(s.id, item.page_id).template_id) : null;
            const old = item.slot_id ? from?.slots.find((x) => x.id === item.slot_id) : undefined;
            db.prepare("UPDATE print_items SET page_id = ?, slot_id = ?, x_mm = ?, y_mm = ?, manual = 1 WHERE id = ? AND org_id = $org").run(
              item.page_id, old ? old.id : null, old ? old.cx : item.x_mm, old ? old.cy : item.y_mm, other.id,
            );
          }
          // Yuva değişti: öğe yeni yuvanın merkezine oturur.
          db.prepare("UPDATE print_items SET page_id = ?, slot_id = ?, x_mm = ?, y_mm = ?, manual = ? WHERE id = ? AND org_id = $org").run(target.id, slot.id, slot.cx, slot.cy, manual, item.id);
          return;
        }
        if (op.xMm === undefined || op.yMm === undefined) throw fail("move-target-required");
        db.prepare("UPDATE print_items SET page_id = ?, slot_id = NULL, x_mm = ?, y_mm = ?, manual = ? WHERE id = ? AND org_id = $org").run(target.id, r2(op.xMm), r2(op.yMm), manual, item.id);
        if (!this.inPaper(t, op.xMm, op.yMm)) warnings.push("Taşınan öğe kağıdın dışında.");
        return;
      }

      case "updateItem": {
        const item = this.itemRow(s.id, op.itemId);
        if (op.variantId) this.requireVariant(op.variantId, item.job_id);
        db.prepare(
          `UPDATE print_items SET variant_id = COALESCE(?, variant_id), rotation = COALESCE(?, rotation), scale = COALESCE(?, scale),
           z = COALESCE(?, z), extra = COALESCE(?, extra), manual = ? WHERE id = ? AND org_id = $org`,
        ).run(op.variantId ?? null, op.rotation ?? null, op.scale ?? null, op.z ?? null, op.extra === undefined ? null : op.extra ? 1 : 0, op.manual === false ? 0 : 1, item.id);
        return;
      }

      case "removeItem": {
        const item = this.itemRow(s.id, op.itemId);
        db.prepare("DELETE FROM print_items WHERE id = ? AND org_id = $org").run(item.id);
        return;
      }

      case "addPage": {
        const templateId = op.templateId ?? this.lastTemplateId(s);
        const t = this.d.templates.require(templateId);
        if (t.languageId !== s.language_id) throw fail("template-other-language");
        const ids = this.pageIds(s.id);
        const index = Math.min(op.index ?? ids.length, ids.length);
        const insert = db.prepare(
          "INSERT INTO print_pages (org_id, id, session_id, template_id, idx, name, copies, kind, show_cell_labels, locked) VALUES ($org, ?, ?, ?, ?, ?, ?, 'manual', ?, 0)",
        );
        const pageId = this.claimId(op.id, idMap, (rowId) =>
          insert.run(rowId, s.id, t.id, ids.length, op.name ?? `Sayfa ${ids.length + 1}`, op.copies ?? 1, t.cellLabel.enabledByDefault ? 1 : 0),
        );
        this.reorder(s.id, [...ids.slice(0, index), pageId, ...ids.slice(index)]);
        return;
      }

      case "removePage": {
        const page = this.pageRow(s.id, op.pageId);
        db.prepare("UPDATE print_pages SET deleted_at = ? WHERE id = ? AND org_id = $org").run(this.now(), page.id);
        removedPages.push(page.id);
        return;
      }

      case "updatePage": {
        const page = this.pageRow(s.id, op.pageId);
        db.prepare(
          "UPDATE print_pages SET name = COALESCE(?, name), copies = COALESCE(?, copies), locked = COALESCE(?, locked), show_cell_labels = COALESCE(?, show_cell_labels) WHERE id = ? AND org_id = $org",
        ).run(op.name ?? null, op.copies ?? null, op.locked === undefined ? null : op.locked ? 1 : 0, op.showCellLabels === undefined ? null : op.showCellLabels ? 1 : 0, page.id);
        if (op.index !== undefined) {
          const ids = this.pageIds(s.id).filter((x) => x !== page.id);
          const index = Math.min(op.index, ids.length);
          this.reorder(s.id, [...ids.slice(0, index), page.id, ...ids.slice(index)]);
        }
        return;
      }

      case "setPageTemplate": {
        const page = this.pageRow(s.id, op.pageId);
        const from = this.d.templates.require(page.template_id);
        const to = this.d.templates.require(op.templateId);
        if (to.languageId !== s.language_id) throw fail("template-other-language");
        if (to.kind !== from.kind) throw fail("page-kind-mismatch");
        const order = new Map(from.slots.map((sl, i) => [sl.id, i]));
        const items = db.prepare("SELECT * FROM print_items WHERE org_id = $org AND page_id = ?").all(page.id) as unknown as ItemRow[];
        let removed = 0;
        for (const it of items) {
          if (it.slot_id === null) continue;
          const i = order.get(it.slot_id);
          const next = i !== undefined ? to.slots[i] : undefined;
          if (!next) {
            db.prepare("DELETE FROM print_items WHERE id = ? AND org_id = $org").run(it.id);
            removed++;
          } else db.prepare("UPDATE print_items SET slot_id = ?, x_mm = ?, y_mm = ? WHERE id = ? AND org_id = $org").run(next.id, next.cx, next.cy, it.id);
        }
        db.prepare("UPDATE print_pages SET template_id = ? WHERE id = ? AND org_id = $org").run(to.id, page.id);
        if (removed) warnings.push(`Yeni şablonda yuva az: ${removed} öğe sayfadan çıkarıldı.`);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- basıldı, yeniden basım, silme

  /**
   * Basıldı (arşiv) / taslağa geri. Basıldı işaretlenince sayfaların (ve planın) şablonlarının o anki hâli oturuma
   * anlık kopya olarak yazılır; zaten basılmışsa ilk kopya korunur. Taslağa dönünce kopya bırakılır (taslak güncel
   * şablonla çalışır).
   */
  markPrinted(id: string, printed: boolean, version?: number): PrintSessionDetail {
    const s = this.row(id);
    if (version !== undefined && version !== s.version) throw versionConflict();
    const now = this.now();
    const snapshots = printed ? (s.status === "printed" && s.template_snapshots ? s.template_snapshots : JSON.stringify(this.takeSnapshots(s))) : null;
    // Plan sürümü yalnız ölçü kuralını taşır (`planVersionOf`): basılan oturum hangi kuralla dizildiyse o yazılır.
    // Kesimi değişmiş işi içeren taslak (`plan-stale`) basılabilir; masa önce onay sorar, kayıt bayatlıktan etkilenmez.
    this.d.db
      .prepare("UPDATE print_sessions SET status = ?, printed_at = ?, template_snapshots = ?, plan_version = ?, version = version + 1, updated_at = ? WHERE id = ? AND org_id = $org")
      .run(printed ? "printed" : "draft", printed ? (s.printed_at ?? now) : null, snapshots, planVersionOf(s), now, id);
    this.emit(s.language_id, id);
    return this.detail(id);
  }

  /** Oturumun kullandığı şablonların (sayfalar + planın şablonu) şu anki hâli. Bulunamayan atlanır. */
  private takeSnapshots(s: SessionRow): Record<string, PrintTemplate> {
    const ids = (this.d.db.prepare("SELECT DISTINCT template_id FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL").all(s.id) as { template_id: string }[]).map(
      (r) => r.template_id,
    );
    if (s.template_id) ids.push(s.template_id);
    const out: Record<string, PrintTemplate> = {};
    for (const tid of new Set(ids)) {
      const t = this.d.templates.find(tid);
      if (t) out[tid] = t;
    }
    return out;
  }

  /** Kayıtlı anlık kopya (şemayla okunur; bozuk kayıt atlanır). */
  private snapshots(s: SessionRow): Record<string, PrintTemplate> | null {
    const raw = json<Record<string, unknown> | null>(s.template_snapshots, null);
    if (!raw || typeof raw !== "object") return null;
    const out: Record<string, PrintTemplate> = {};
    for (const [tid, v] of Object.entries(raw)) {
      const p = PrintTemplateSchema.safeParse(v);
      if (p.success) out[tid] = p.data;
    }
    return out;
  }

  /**
   * Oturumun kopyası (sayfalar, öğeler, kopya sayıları, kilitler) yeni taslak olarak. Basılmış oturumda "aynen yeniden
   * bas": sayfalar basıldığı andaki şablonla gelir. Güncel şablon anlık kopyayla aynıysa (baskıyı etkileyen alanlar)
   * o kullanılır; farklıysa ya da silinmişse kopya arşivli yeni şablon olarak eklenir. Güncel şablona geçiş taslakta
   * `setPageTemplate` ile.
   */
  reprint(id: string, name?: string): PrintSessionDetail {
    const s = this.row(id);
    const pages = this.pages(id);
    const now = this.now();
    const copyId = randomUUID();
    this.d.db.tx(() => {
      const snaps = s.status === "printed" ? this.snapshots(s) : null;
      const mapped = new Map<string, string>();
      const templateFor = (tid: string): string => {
        const known = mapped.get(tid);
        if (known) return known;
        const snap = snaps?.[tid];
        const live = snap ? this.d.templates.find(tid) : null;
        const use = !snap || (live && printFields(live) === printFields(snap)) ? tid : this.d.templates.restoreSnapshot(snap, `${snap.name} (${s.name} basımı)`).id;
        mapped.set(tid, use);
        return use;
      };
      this.d.db
        .prepare(
          `INSERT INTO print_sessions (org_id, id, language_id, name, status, version, template_id, job_ids, source_session_id, created_at, updated_at, plan_version)
           VALUES ($org, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?)`,
        )
        // Kopya kaynağın plan sürümünü taşır: eski ölçüyle basılmışın kopyası masada "yeniden planla" uyarısı alır.
        .run(copyId, s.language_id, name ?? `${s.name} (yeniden basım)`, s.template_id ? templateFor(s.template_id) : null, s.job_ids, s.id, now, now, s.plan_version ?? PLAN_VERSION);
      const insPage = this.d.db.prepare(
        "INSERT INTO print_pages (org_id, id, session_id, template_id, idx, name, copies, kind, show_cell_labels, locked) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insItem = this.d.db.prepare(
        "INSERT INTO print_items (org_id, id, page_id, job_id, variant_id, slot_id, x_mm, y_mm, rotation, scale, extra, manual, z) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const p of pages) {
        const pid = randomUUID();
        insPage.run(pid, copyId, templateFor(p.templateId), p.index, p.name, p.copies, p.kind, p.showCellLabels ? 1 : 0, p.locked ? 1 : 0);
        for (const it of p.items) insItem.run(randomUUID(), pid, it.jobId, it.variantId, it.slotId, it.xMm, it.yMm, it.rotation, it.scale, it.extra ? 1 : 0, it.manual ? 1 : 0, it.z);
      }
    });
    this.emit(s.language_id, copyId);
    return this.detail(copyId);
  }

  /** Taslak silme (yumuşak; geri alınabilir). Basılmış oturum arşivdir, silinmez. */
  remove(id: string): UndoToken {
    const s = this.row(id);
    if (s.status === "printed") throw fail("printed-session-not-deletable");
    this.d.db.prepare("UPDATE print_sessions SET deleted_at = ? WHERE id = ? AND org_id = $org").run(this.now(), id);
    this.emit(s.language_id, id);
    return this.d.undo.printDeleted(undoMsg("print-session-deleted"), [id], []);
  }

  /**
   * Şablonun yuvaları değişti: taslak oturumlardaki yuvadaki öğeler yeni yuva merkezine (yuva içi ofsetleri, önceki
   * hâl biliniyorsa, korunarak); yuvası kalkanlar serbest kalır.
   */
  syncTemplate(t: PrintTemplate, prev?: PrintTemplate): void {
    const rows = this.d.db
      .prepare(
        `SELECT i.id, i.slot_id, i.x_mm, i.y_mm, p.session_id, s.language_id FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org
         JOIN print_sessions s ON s.id = p.session_id AND s.org_id = $org
         WHERE i.org_id = $org AND p.template_id = ? AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status = 'draft' AND i.slot_id IS NOT NULL`,
      )
      .all(t.id) as { id: string; slot_id: string; x_mm: number; y_mm: number; session_id: string; language_id: string }[];
    if (!rows.length) return;
    const slots = new Map(t.slots.map((s) => [s.id, s]));
    const before = new Map((prev?.slots ?? []).map((s) => [s.id, s]));
    const touched = new Map<string, string>();
    this.d.db.tx(() => {
      for (const r of rows) {
        const sl = slots.get(r.slot_id);
        const old = before.get(r.slot_id);
        const x = sl ? r2(sl.cx + (old ? r.x_mm - old.cx : 0)) : r.x_mm;
        const y = sl ? r2(sl.cy + (old ? r.y_mm - old.cy : 0)) : r.y_mm;
        if (sl && x === r.x_mm && y === r.y_mm) continue;
        if (sl) this.d.db.prepare("UPDATE print_items SET x_mm = ?, y_mm = ? WHERE id = ? AND org_id = $org").run(x, y, r.id);
        else this.d.db.prepare("UPDATE print_items SET slot_id = NULL WHERE id = ? AND org_id = $org").run(r.id);
        touched.set(r.session_id, r.language_id);
      }
      for (const sid of touched.keys()) this.bump(sid);
    });
    for (const [sid, lang] of touched) this.emit(lang, sid);
  }

  /** Geri alma sonrası (oturum/sayfa geri geldi). */
  restored(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const s = this.d.db.prepare("SELECT language_id FROM print_sessions WHERE id = ? AND org_id = $org").get(id) as { language_id: string } | undefined;
      if (s) this.emit(s.language_id, id);
    }
  }

  // ---------------------------------------------------------------- yardımcılar

  private row(id: string): SessionRow {
    const r = this.d.db.prepare("SELECT * FROM print_sessions WHERE id = ? AND org_id = $org AND deleted_at IS NULL").get(id) as SessionRow | undefined;
    if (!r) throw fail("print-session-not-found");
    return r;
  }

  private editable(id: string, version: number): SessionRow {
    const s = this.row(id);
    if (s.status === "printed") throw fail("printed");
    if (version !== s.version) throw versionConflict();
    return s;
  }

  private pages(sessionId: string): PrintPageFull[] {
    const pages = this.d.db
      .prepare(`SELECT * FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL ORDER BY idx, ${insertOrder(this.d.db)}`)
      .all(sessionId) as unknown as PageRow[];
    if (!pages.length) return [];
    const items = this.d.db
      .prepare(`SELECT * FROM print_items WHERE org_id = $org AND page_id IN (${placeholders(pages.length)}) ORDER BY z, ${insertOrder(this.d.db)}`)
      .all(...pages.map((p) => p.id)) as unknown as ItemRow[];
    const byPage = new Map<string, PrintItem[]>();
    for (const i of items) {
      const list = byPage.get(i.page_id) ?? [];
      list.push({
        id: i.id,
        pageId: i.page_id,
        jobId: i.job_id,
        variantId: i.variant_id,
        slotId: i.slot_id,
        xMm: i.x_mm,
        yMm: i.y_mm,
        rotation: i.rotation,
        scale: i.scale,
        extra: !!i.extra,
        manual: !!i.manual,
        z: i.z,
      });
      byPage.set(i.page_id, list);
    }
    return pages.map((p, index) => ({
      id: p.id,
      sessionId: p.session_id,
      templateId: p.template_id,
      index,
      name: p.name,
      copies: p.copies,
      kind: p.kind,
      showCellLabels: !!p.show_cell_labels,
      locked: !!p.locked,
      items: byPage.get(p.id) ?? [],
    }));
  }

  private pageRow(sessionId: string, pageId: string): PageRow {
    const p = this.d.db.prepare("SELECT * FROM print_pages WHERE id = ? AND org_id = $org AND session_id = ? AND deleted_at IS NULL").get(pageId, sessionId) as PageRow | undefined;
    if (!p) throw fail("print-page-not-found");
    return p;
  }

  private itemRow(sessionId: string, itemId: string): ItemRow {
    const i = this.d.db
      .prepare("SELECT i.* FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org WHERE i.org_id = $org AND i.id = ? AND p.session_id = ? AND p.deleted_at IS NULL")
      .get(itemId, sessionId) as ItemRow | undefined;
    if (!i) throw fail("print-item-not-found");
    return i;
  }

  private requireVariant(variantId: string, jobId: string): void {
    const v = this.d.variants.row(variantId);
    if (!v || v.job_id !== jobId) throw fail("variant-not-found");
  }

  private slot(t: PrintTemplate, slotId: string): PrintSlot {
    const s = t.slots.find((x) => x.id === slotId);
    if (!s) throw fail("slot-not-found", { slot: slotId });
    return s;
  }

  private occupant(pageId: string, slotId: string): ItemRow | null {
    return (this.d.db.prepare("SELECT * FROM print_items WHERE org_id = $org AND page_id = ? AND slot_id = ? LIMIT 1").get(pageId, slotId) as ItemRow | undefined) ?? null;
  }

  private freeSlot(pageId: string, t: PrintTemplate): PrintSlot | null {
    const used = new Set((this.d.db.prepare("SELECT slot_id FROM print_items WHERE org_id = $org AND page_id = ? AND slot_id IS NOT NULL").all(pageId) as { slot_id: string }[]).map((r) => r.slot_id));
    return t.slots.find((s) => !used.has(s.id)) ?? null;
  }

  private inPaper(t: PrintTemplate, x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x <= t.paper.wMm && y <= t.paper.hMm;
  }

  private maxZ(pageId: string): number {
    return Number((this.d.db.prepare("SELECT COALESCE(MAX(z), 0) AS z FROM print_items WHERE org_id = $org AND page_id = ?").get(pageId) as { z: number }).z);
  }

  /**
   * Yeni sayfa/öğe satırı ve kimliği (SUNUCU-PLANI §10.3, dil kimliğindeki kural): kimliği HER ZAMAN sunucu verir
   * (UUIDv7). İstemcinin `id`'si yalnız geçici başvurudur: kayıttaki kimlikle eşlemesi `idMap`'e (yanıtta `ids`) yazılır,
   * aynı yamadaki sonraki işlemler onunla başvurabilir (`resolveIds`). Hiçbir tabloya bakılmadığı için başka firmadaki
   * (ya da aynı firmadaki) bir kimliğin varlığı yanıttan okunamaz. Aynı yamada iki eklemeye aynı geçici kimlik
   * belirsizdir: `id-in-use`.
   */
  private claimId(wanted: string | undefined, idMap: Map<string, string>, insert: (rowId: string) => unknown): string {
    if (wanted !== undefined && idMap.has(wanted)) throw fail("id-in-use", { id: wanted });
    const rowId = uuidv7();
    insert(rowId);
    if (wanted !== undefined) idMap.set(wanted, rowId);
    return rowId;
  }

  private pageIds(sessionId: string): string[] {
    return (this.d.db.prepare(`SELECT id FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL ORDER BY idx, ${insertOrder(this.d.db)}`).all(sessionId) as { id: string }[]).map((r) => r.id);
  }

  private reorder(sessionId: string, ids: string[]): void {
    const st = this.d.db.prepare("UPDATE print_pages SET idx = ? WHERE id = ? AND session_id = ? AND org_id = $org");
    ids.forEach((id, i) => st.run(i, id, sessionId));
  }

  private compact(sessionId: string): void {
    this.reorder(sessionId, this.pageIds(sessionId));
  }

  private lastTemplateId(s: SessionRow): string {
    const r = this.d.db.prepare(`SELECT template_id FROM print_pages WHERE org_id = $org AND session_id = ? AND deleted_at IS NULL ORDER BY idx DESC, ${insertOrder(this.d.db)} DESC LIMIT 1`).get(s.id) as
      | { template_id: string }
      | undefined;
    const id = r?.template_id ?? s.template_id;
    if (!id) throw fail("print-template-required");
    return id;
  }

  private firstTemplateIdOrNull(sessionId: string): string | null {
    const r = this.d.db.prepare("SELECT template_id FROM print_pages WHERE org_id = $org AND session_id = ? ORDER BY idx LIMIT 1").get(sessionId) as { template_id: string } | undefined;
    return r?.template_id ?? null;
  }

  private firstTemplateId(sessionId: string): string {
    const r = this.d.db.prepare("SELECT template_id FROM print_pages WHERE org_id = $org AND session_id = ? ORDER BY idx LIMIT 1").get(sessionId) as { template_id: string } | undefined;
    if (!r) throw fail("session-template-missing");
    return r.template_id;
  }

  private bump(id: string): void {
    this.d.db.prepare("UPDATE print_sessions SET version = version + 1, updated_at = ? WHERE id = ? AND org_id = $org").run(this.now(), id);
  }

  private emit(languageId: string, sessionId: string): void {
    this.d.events.emit({ type: "print", languageId, sessionId });
  }

  private now(): string {
    return this.d.clock.now().toISOString();
  }
}

/**
 * Aynı yamada daha önce `addPage`/`addItem` ile verilmiş geçici kimliğe başvuru (`pageId`, `itemId`) kayıttaki
 * kimliğe çevrilir. Eklemenin kendi `id`'si çevrilmez (`claimId` yeni kimlik verir).
 */
function resolveIds(op: PrintPatchOp, ids: ReadonlyMap<string, string>): PrintPatchOp {
  if (!ids.size) return op;
  const o = { ...op } as PrintPatchOp & { pageId?: string; itemId?: string };
  if (o.pageId !== undefined) o.pageId = ids.get(o.pageId) ?? o.pageId;
  if (o.itemId !== undefined) o.itemId = ids.get(o.itemId) ?? o.itemId;
  return o;
}

/** Yamada elle açı verilen öğeler (açısı yuvaya eşitlenmez): `rotation` taşıyan ekleme/güncelleme işlemleri. */
function manualAngles(ops: readonly PrintPatchOp[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    const o = op as { rotation?: number; itemId?: string; id?: string };
    if (o.rotation === undefined) continue;
    const id = o.itemId ?? o.id;
    if (id) out.add(id);
  }
  return out;
}
