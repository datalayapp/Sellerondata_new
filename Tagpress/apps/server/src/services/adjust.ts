import path from "node:path";
import {
  ADJUST_LIMITS,
  API,
  type AdjustCheckResponse,
  type AdjustRelayoutResponse,
  type AdjustSaveResponse,
  type Box,
  type Issue,
  type LayoutResult,
  type LineEdit,
  type Profile,
  type VariantAdjust,
  type VariantEditModel,
  type VariantSnapshot,
  adjustOrigin,
  apiPath,
  applyAdjustToLayout,
  baseLineStroke,
  boxCenter,
  normalizeAdjust,
  shapeBounds,
  stripPlaced,
  undoMsg,
} from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Ports } from "../ports.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";
import { writeAtomic } from "../util/files.ts";
import type { Target, TargetResolver } from "./generation/target.ts";
import type { JobRow, VariantRow } from "./jobs/mapping.ts";
import type { JobService } from "./jobs/service.ts";
import type { ProfileService } from "./profiles.ts";
import type { TemplateService } from "./templates.ts";
import type { AdjustState, UndoService } from "./undo.ts";
import type { VariantService } from "./variants.ts";

interface Deps {
  db: TenantDb;
  paths: DataPaths;
  ports: Ports;
  jobs: JobService;
  variants: VariantService;
  templates: TemplateService;
  profiles: ProfileService;
  targets: TargetResolver;
  undo: UndoService;
  events: EventBus;
  clock: Clock;
}

/** Varyasyonun düzenleme bağlamı: yerleşim, profil, hedef geometri. */
interface EditContext {
  v: VariantRow;
  job: JobRow;
  snap: VariantSnapshot;
  base: LayoutResult;
  profile: Profile;
  profileVersion: number | null;
  target: Target;
  fontsDir: string;
}

/** Öğrenme için kayıtlı tek düzeltme (şablon bazında hedef merkeze göre kayma). */
export interface AdjustSample {
  variantId: string;
  jobId: string;
  templateKey: string | null;
  profileVersion: number | null;
  framePx: number;
  adjust: VariantAdjust;
  /** Kayıt anındaki hedef merkez (tasarım px) ve kaynağı. */
  target: { x: number; y: number; source: "template" | "area" };
  inkBefore: Box;
  inkAfter: Box;
  /** Mürekkep merkezinin hedef merkeze göre kayması (tasarım px): önce (motor) ve sonra (kullanıcı). */
  offsetBefore: { x: number; y: number };
  offsetAfter: { x: number; y: number };
  createdAt: string;
}

interface LogRow {
  variant_id: string;
  job_id: string;
  template_key: string | null;
  profile_version: number | null;
  frame_px: number;
  adjust: string;
  target_x: number;
  target_y: number;
  target_source: "template" | "area";
  ink_before: string;
  ink_after: string;
  created_at: string;
}

/**
 * Dilin GEÇERLİ hafif düzeltmeleri (öğrenme kaynağı): her varyasyonun şu an kayıtlı düzeltme sürümü; silinmiş,
 * düzeltmesi kaldırılmış ya da geri alınmış olanlar girmez. `learn` servisi şablon bazında hedef merkez önerisi
 * için okuyabilir (ilk sürümde yalnızca saklanır).
 */
export function adjustSamples(db: TenantDb, languageId: string, templateKey?: string): AdjustSample[] {
  const rows = db
    .prepare(
      `SELECT l.* FROM adjust_log l JOIN variants v ON v.id = l.variant_id AND v.adjust_rev = l.rev AND v.org_id = $org
       WHERE l.org_id = $org AND l.language_id = ? AND v.deleted_at IS NULL AND v.adjust IS NOT NULL ${templateKey !== undefined ? "AND l.template_key = ?" : ""}
       ORDER BY l.created_at`,
    )
    .all(...(templateKey !== undefined ? [languageId, templateKey] : [languageId])) as unknown as LogRow[];
  return rows.map((r) => {
    const before = json<Box>(r.ink_before, { x: 0, y: 0, w: 0, h: 0 });
    const after = json<Box>(r.ink_after, { x: 0, y: 0, w: 0, h: 0 });
    const off = (b: Box) => ({ x: round2(boxCenter(b).x - r.target_x), y: round2(boxCenter(b).y - r.target_y) });
    return {
      variantId: r.variant_id,
      jobId: r.job_id,
      templateKey: r.template_key,
      profileVersion: r.profile_version,
      framePx: r.frame_px,
      adjust: json<VariantAdjust>(r.adjust, { dx: 0, dy: 0, scale: 1 }),
      target: { x: r.target_x, y: r.target_y, source: r.target_source },
      inkBefore: before,
      inkAfter: after,
      offsetBefore: off(before),
      offsetAfter: off(after),
      createdAt: r.created_at,
    };
  });
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const roundBox = (b: Box): Box => ({ x: round2(b.x), y: round2(b.y), w: round2(b.w), h: round2(b.h) });

/** Elle metin/font düzenlemesi varken motorun temel sorunlarından düşenler (düzenlemeyle yeniden hesaplanırlar). */
const EDIT_REPLACED = new Set<Issue["code"]>(["text-fallback-font", "text-unprintable", "font-mixing", "text-edited"]);

/** Düzeltmenin elle düzenlemeleri çözülmüş hâli: motorun `placed`'i dolu düzeltme + düzenlenmiş temel yerleşim. */
interface Resolved {
  adjust: VariantAdjust | null;
  /** Düzenlenmiş, düzeltmesiz yerleşim (düzenleme yoksa motor yerleşimi). */
  base: LayoutResult;
  issues: Issue[];
  linesChanged: boolean;
  hasEdits: boolean;
}

/**
 * Hafif düzeltme: varyasyonun yazı bloğunu elle kaydırma/ölçekleme. AI yok, metin değişmez. Varyasyonun
 * `layout`'u motor çıktısı olarak kalır; düzeltme `adjust` sütunundadır ve önizleme + baskı onu uygular.
 * Kaydet/kaldır geri alınabilir (`POST /api/undo/:token`).
 */
export class AdjustService {
  constructor(private readonly d: Deps) {}

  /** Düzenleme katmanının modeli. */
  async editModel(variantId: string): Promise<VariantEditModel> {
    const c = await this.context(variantId);
    const g = c.target.geometry;
    const stored = this.d.variants.adjustOf(c.v);
    // Kayıtlı elle düzenlemeler motorla tazelenir (font dosyası değiştiyse); olmazsa kayıtlı hâli kalır.
    let adjust = stored;
    if (stored?.edits?.length) {
      try {
        adjust = this.resolve(c, stored).adjust;
      } catch {
        adjust = stored;
      }
    }
    const strokeAlign = c.profile.weight.align;
    const adjusted = applyAdjustToLayout(c.base, adjust, { strokeAlign });
    const fontInfo = this.d.ports.engine?.editFonts?.({ layout: c.base, profile: c.profile, fontsDir: c.fontsDir }) ?? null;
    const t = c.target.template;
    const cutBox = shapeBounds(g.cut);
    return {
      variantId: c.v.id,
      jobId: c.job.id,
      framePx: g.framePx,
      templateImageUrl: t ? apiPath(API.templateImage, { lang: c.job.language_id, key: t.key }) : null,
      templateBox: g.templateBox,
      cut: g.cut,
      cutBox,
      areaBox: g.areaBounds,
      centers: {
        textCenter: { x: g.target.x, y: g.target.y, source: t?.textCenter ? "template" : "area" },
        area: boxCenter(g.areaBounds),
        cut: boxCenter(cutBox),
      },
      origin: adjustOrigin(c.base),
      ink: c.base.ink,
      lines: c.base.lines.map((l, index) => ({
        index,
        text: l.text,
        sizePx: l.sizePx,
        ink: l.ink,
        strokePx: baseLineStroke(c.base, index),
        ...(fontInfo?.lineFonts[index] ? { fontId: fontInfo.lineFonts[index] } : {}),
      })),
      strokePx: c.base.strokePx,
      strokeAlign,
      ...(fontInfo && this.d.ports.engine?.editLines ? { fonts: fontInfo.fonts, fontMixing: c.profile.fonts.mixing } : {}),
      jobText: c.job.text,
      textLayerUrl: this.d.ports.engine?.textLayerSvg ? apiPath(API.variantEditText, { id: c.v.id }) : null,
      adjust,
      adjustedInk: adjusted.ink,
      issues: json<Issue[]>(c.v.issues, []),
      previewUrl: this.d.variants.get(c.v.id).previewUrl,
      limits: { scaleMin: ADJUST_LIMITS.scaleMin, scaleMax: ADJUST_LIMITS.scaleMax, shiftMaxPx: ADJUST_LIMITS.shiftMaxPx, strokeMaxPx: ADJUST_LIMITS.strokeMaxPx },
    };
  }

  /** Yalnızca yazı katmanı (düzeltmesiz), saydam SVG. */
  async textSvg(variantId: string): Promise<string> {
    const engine = this.d.ports.engine;
    if (!engine?.textLayerSvg) throw fail("text-layer-unavailable");
    const c = await this.context(variantId);
    return engine.textLayerSvg({ layout: c.base, profile: c.profile, fontsDir: c.fontsDir });
  }

  /**
   * Elle metin/font düzenlemesini motorla ölçer (kaydetmez): `placed` dolu düzenlemeler + düzenlenmiş yazı katmanı
   * (SVG, düzeltmesiz) + düzenlemeden doğan sorunlar. İstemcinin gönderdiği `placed` yok sayılır.
   */
  async relayout(variantId: string, edits: readonly LineEdit[]): Promise<AdjustRelayoutResponse> {
    const engine = this.d.ports.engine;
    if (!engine?.editLines || !engine.textLayerSvg) throw fail("edit-unavailable");
    const c = await this.context(variantId);
    const r = engine.editLines({ layout: c.base, edits: stripPlaced(edits), profile: c.profile, fontsDir: c.fontsDir, jobText: c.job.text });
    return { edits: r.edits, textSvg: engine.textLayerSvg({ layout: r.layout, profile: c.profile, fontsDir: c.fontsDir }), issues: r.issues };
  }

  /** Hızlı denetim (kaydetmez): düzeltilmiş mürekkep kutuları + düzeltmeden doğan sorunlar. */
  async check(variantId: string, input: VariantAdjust): Promise<AdjustCheckResponse> {
    const t0 = performance.now();
    const c = await this.context(variantId);
    const r = this.resolve(c, normalizeAdjust(input));
    const adjust = r.adjust;
    const layout = applyAdjustToLayout(c.base, adjust, { strokeAlign: c.profile.weight.align });
    const res = await this.inspect(c, layout);
    return {
      adjust,
      ink: layout.ink,
      lineInks: layout.lines.map((l) => l.ink),
      lineStrokes: layout.lines.map((l) => l.strokePx ?? layout.strokePx),
      issues: [...(res?.issues ?? []), ...r.issues],
      collision: res ? { inkPx: res.report.inkPx, outsideCutPx: res.report.outsideCutPx, decorationPx: res.report.decorationPx, outsideFreePx: res.report.outsideFreePx } : null,
      ms: Math.round(performance.now() - t0),
    };
  }

  /** Kaydet: önizleme yeniden çizilir, sorunlar güncellenir, öğrenme kaydı yazılır. Kimlik düzeltmesi = kaldır. */
  async save(variantId: string, input: VariantAdjust): Promise<AdjustSaveResponse> {
    const normalized = normalizeAdjust(input);
    if (!normalized) return this.remove(variantId);
    const c = await this.context(variantId);
    const engine = this.d.ports.engine;
    if (!engine) throw fail("engine-preview-unavailable");
    const r = this.resolve(c, normalized);
    const adjust = r.adjust;
    // Düzenlemeler motorda etkisiz çıktıysa ve başka değişiklik yoksa: kaldır.
    if (!adjust) return this.remove(variantId);
    const layout = applyAdjustToLayout(c.base, adjust, { strokeAlign: c.profile.weight.align });
    const res = await this.inspect(c, layout);
    const preview = await engine.render({ layout, geometry: c.target.geometry, profile: c.profile, templatePath: c.target.templatePath, fontsDir: c.fontsDir });

    const before = this.state(c.v);
    const baseIssues = json<Issue[]>(c.v.base_issues ?? c.v.issues, []);
    // Düzeltme yeni bir okunurluk ölçümü getirir; motorun eski okunurluk uyarısı ve önceki düzeltme sorunları düşer.
    // Elle metin/font düzenlemesinde yedek font, aile sayısı ve (satırlar değiştiyse) satır kuralları yeniden hesaplanır.
    const kept = baseIssues.filter(
      (i) =>
        i.field !== "adjust" &&
        i.code !== "text-too-small" &&
        !(r.hasEdits && EDIT_REPLACED.has(i.code)) &&
        !(r.linesChanged && i.code.startsWith("rule-")),
    );
    const issues = [...kept, ...(res?.issues ?? []), ...r.issues];
    const rev = this.nextRev(c.v.id);
    const previewFile = `${c.v.id}.adj${rev}.png`;
    await writeAtomic(path.join(this.d.paths.previews, previewFile), preview);

    const g = c.target.geometry;
    const now = this.d.clock.now().toISOString();
    this.d.db.tx(() => {
      this.d.db
        .prepare(
          `UPDATE variants SET adjust = ?, adjust_rev = ?, issues = ?, preview_file = ?,
             base_issues = COALESCE(base_issues, ?), base_preview_file = COALESCE(base_preview_file, ?) WHERE id = ? AND org_id = $org`,
        )
        .run(JSON.stringify(adjust), rev, JSON.stringify(issues), previewFile, c.v.base_issues ?? c.v.issues, c.v.base_preview_file ?? c.v.preview_file, c.v.id);
      this.d.db
        .prepare(
          `INSERT INTO adjust_log (org_id, language_id, template_key, job_id, variant_id, rev, profile_version, frame_px, adjust, target_x, target_y, target_source, ink_before, ink_after, created_at)
           VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.job.language_id, c.target.template?.key ?? c.snap.templateKey ?? c.job.template_key, c.job.id, c.v.id, rev, c.profileVersion, g.framePx,
          // Öğrenme: "önce" motorun (elle düzenlenmişse düzenlenmiş satırlarla) yerleşimi; fark yalnızca konum/boyut düzeltmesi.
          JSON.stringify(adjust), round2(g.target.x), round2(g.target.y), c.target.template?.textCenter ? "template" : "area",
          JSON.stringify(roundBox(r.base.ink)), JSON.stringify(roundBox(layout.ink)), now,
        );
    });
    const undo = this.d.undo.adjustChanged(undoMsg("adjust-saved"), before);
    this.d.events.emit({ type: "variant", jobId: c.job.id, variantId: c.v.id });
    return { variant: this.d.variants.get(c.v.id), undo };
  }

  /** Düzeltmeyi kaldır: motorun özgün önizlemesi ve sorunları geri gelir. */
  async remove(variantId: string): Promise<AdjustSaveResponse> {
    const v = this.d.variants.require(variantId);
    if (!v.adjust) throw fail("no-saved-adjust");
    const before = this.state(v);
    this.d.db
      .prepare("UPDATE variants SET adjust = NULL, adjust_rev = 0, issues = COALESCE(base_issues, issues), preview_file = COALESCE(base_preview_file, preview_file) WHERE id = ? AND org_id = $org")
      .run(v.id);
    const undo = this.d.undo.adjustChanged(undoMsg("adjust-removed"), before);
    this.d.events.emit({ type: "variant", jobId: v.job_id, variantId: v.id });
    return { variant: this.d.variants.get(v.id), undo };
  }

  /** Dilin geçerli düzeltmeleri (öğrenme kaynağı). */
  samples(languageId: string, templateKey?: string): AdjustSample[] {
    return adjustSamples(this.d.db, languageId, templateKey);
  }

  /**
   * Düzeltmenin elle düzenlemelerini motorla çözer (istemcinin `placed`'i yok sayılır). Düzenleme yoksa olduğu gibi.
   * Motor bağlı değilse düzenlemeli düzeltme reddedilir (yazı tipine erişmeden satır ölçülemez).
   */
  private resolve(c: EditContext, adjust: VariantAdjust | null): Resolved {
    if (!adjust?.edits?.length) return { adjust, base: c.base, issues: [], linesChanged: false, hasEdits: false };
    const edit = this.d.ports.engine?.editLines;
    if (!edit) throw fail("edit-unavailable");
    const r = edit({ layout: c.base, edits: stripPlaced(adjust.edits), profile: c.profile, fontsDir: c.fontsDir, jobText: c.job.text });
    const next = normalizeAdjust({ ...adjust, edits: r.edits });
    return { adjust: next, base: r.edits.length ? r.layout : c.base, issues: r.edits.length ? r.issues : [], linesChanged: r.edits.length > 0 && r.linesChanged, hasEdits: r.edits.length > 0 };
  }

  private async inspect(c: EditContext, layout: LayoutResult) {
    const check = this.d.ports.engine?.checkPlacement;
    if (!check) return null;
    return check({ layout, geometry: c.target.geometry, profile: c.profile, fontsDir: c.fontsDir });
  }

  private state(v: VariantRow): AdjustState {
    return { variantId: v.id, adjust: v.adjust ?? null, rev: v.adjust_rev ?? 0, issues: v.issues, previewFile: v.preview_file };
  }

  /** Sürüm hiç tekrar kullanılmaz (geri alınan sürümün önizleme dosyası ve öğrenme kaydı korunur). */
  private nextRev(variantId: string): number {
    const r = this.d.db.prepare("SELECT MAX(rev) AS m FROM adjust_log WHERE variant_id = ? AND org_id = $org").get(variantId) as { m: number | null };
    const v = this.d.db.prepare("SELECT adjust_rev FROM variants WHERE id = ? AND org_id = $org").get(variantId) as { adjust_rev: number };
    return Math.max(r.m ?? 0, v.adjust_rev ?? 0) + 1;
  }

  private async context(variantId: string): Promise<EditContext> {
    const v = this.d.variants.require(variantId);
    const job = this.d.jobs.require(v.job_id);
    const snap = json<VariantSnapshot>(v.snapshot, {} as VariantSnapshot);
    const base = this.d.variants.baseLayout(v);
    if (v.kind === "image-on-template" || !base || !base.lines.length)
      throw fail("not-adjustable");
    const languageId = job.language_id;
    let profile: Profile;
    let profileVersion: number | null = snap.profileVersion ?? null;
    try {
      if (profileVersion === null) throw new Error("sürüm yok");
      profile = this.d.profiles.version(languageId, profileVersion).data;
    } catch {
      const active = this.d.profiles.activeProfile(languageId);
      profile = active.profile;
      profileVersion = active.version;
    }
    const key = snap.templateKey ?? job.template_key;
    const override = snap.templateKey ? (this.d.templates.find(languageId, snap.templateKey) ?? undefined) : undefined;
    const target = await this.d.targets.resolve({ language_id: languageId, template_key: key, kind: job.kind }, profile, profileVersion, override);
    return { v, job, snap, base, profile, profileVersion, target, fontsDir: this.d.paths.fonts(languageId) };
  }
}
