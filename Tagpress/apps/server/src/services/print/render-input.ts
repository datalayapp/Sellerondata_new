import path from "node:path";
import {
  type Box,
  type EffectiveCut,
  effectiveCut,
  templateImageBox,
  type LayoutResult,
  type PrintItem,
  type PrintSlot,
  type PrintTemplate,
  type Profile,
  type TemplateGeometry,
  type VariantSnapshot,
  applyAdjustToLayout,
  slotsInReadingOrder,
} from "@tagpress/domain";
import { type StickerPrintSize, stickerPrintSize } from "@tagpress/print";
import type { DataPaths } from "../../config.ts";
import { json } from "../../db/database.ts";
import type { TargetResolver } from "../generation/target.ts";
import { stickerSheetId } from "../import/rows.ts";
import type { JobRow, VariantRow } from "../jobs/mapping.ts";
import type { JobService } from "../jobs/service.ts";
import type { ProfileService } from "../profiles.ts";
import type { TemplateService } from "../templates.ts";
import type { VariantImage, VariantService } from "../variants.ts";
import type { PrintRenderCellLabel, PrintRenderItem, PrintRenderPage } from "./ports.ts";
import type { PrintPageRecord } from "./sessions.ts";

/** Varyasyonun tasarlandığı profil: anlık kopyadaki sürüm, yoksa (ya da silinmişse) etkin sürüm. */
export function variantProfile(profiles: ProfileService, job: Pick<JobRow, "language_id">, v: Pick<VariantRow, "snapshot">): { profile: Profile; version: number | null } {
  const snap = json<VariantSnapshot | null>(v.snapshot, null);
  const version = snap?.profileVersion ?? null;
  if (version !== null) {
    try {
      return { profile: profiles.version(job.language_id, version).data, version };
    } catch {
      // sürüm yok: etkin sürüme düşer
    }
  }
  const a = profiles.activeProfile(job.language_id);
  return { profile: a.profile, version: a.version };
}

/** Çizimin kullandığı yerleşim: motor yerleşimi + hafif düzeltme (önizlemeyle aynı). */
export function printLayout(variants: VariantService, v: VariantRow, profile: Profile): LayoutResult | null {
  const base = variants.baseLayout(v);
  return base && base.lines.length ? applyAdjustToLayout(base, variants.adjustOf(v), { strokeAlign: profile.weight.align }) : null;
}

/**
 * Sticker'ın baskı ölçüsü (mm) — masa (raf, oturum `itemSizes`), planlayıcı ve çizim BU işlevi kullanır; ekrandaki ile
 * kağıttaki boyut aynıdır. Mürekkep (yerleşim ya da görüntü varyasyonunun yazı kutusu) işin sticker sayfasının yazı
 * alanına sığdırılır (`@tagpress/print` `stickerPrintSize`).
 */
export function stickerSizeFor(
  layout: LayoutResult | null,
  image: VariantImage | null,
  job: Pick<JobRow, "template_key">,
  profile: Profile,
  scale = 1,
  legacy = false,
): StickerPrintSize {
  const ink: Box | null = layout?.ink ?? image?.textBox ?? null;
  const sheetId = stickerSheetId(job.template_key);
  const sheet = profile.stickers.sheets.find((s) => s.id === sheetId) ?? null;
  const lineInks = layout?.ink ? layout.lines.map((l) => l.ink) : null;
  return stickerPrintSize(ink, sheet, profile.output.designFramePx, scale, { lineInks, legacy });
}

/** Satırdaki ±tolerans (mm): hücre etiketi en sağdaki yuvaya düşüyorsa soldakine yazılır (eklentideki kural). */
const ROW_TOL_MM = 2;

interface Deps {
  paths: DataPaths;
  jobs: JobService;
  variants: VariantService;
  profiles: ProfileService;
  templates: TemplateService;
  targets: TargetResolver;
}

interface VariantPrep {
  v: VariantRow;
  job: JobRow;
  profile: Profile;
  profileVersion: number | null;
  layout: LayoutResult | null;
  geometry: TemplateGeometry | null;
  templatePath: string | null;
  image: VariantImage | null;
  /** Etikette şablon kaydının etkin kesimi (geometri kurulamasa da ölçek/kırpma için). */
  labelCut: EffectiveCut | null;
  /** Etikette şablon görselinin kutusu (kayıttan). */
  imageBox: Box | null;
}

/**
 * Etiketin tasarım alanı karesinin (`designFramePx`) fiziksel kenarı (mm): etiket çerçevesi yuvaya
 * ortalanır ve yuva ölçüsündedir. Sıra: şablonun etiket çapı → yuva genişliği → işin etiket boyutu
 * (profil `output.sizes`: cm × 10 / framePx × designFramePx × contentScale; motorun `labelDiameterMm`'iyle aynı).
 */
export function labelDiameterMm(t: PrintTemplate, slot: PrintSlot | null, profile: Profile, labelSize: string | null): number {
  if (t.labelDiameterMm) return t.labelDiameterMm;
  if (slot) return Math.min(slot.w, slot.h);
  const sizes = profile.output.sizes;
  const s = sizes.find((x) => x.id === labelSize) ?? sizes.find((x) => x.id === profile.output.defaultSize) ?? sizes[0];
  if (s) {
    const F = profile.output.designFramePx;
    return ((s.cm * 10) / s.framePx) * F * (s.contentScale ?? s.framePx / F);
  }
  return t.slots[0] ? Math.min(t.slots[0].w, t.slots[0].h) : 38;
}

/**
 * Sayfa → çizim girdisi (motorun `renderPagePng`/`renderPdf`'ine verilir). Her öğe varyasyonunun önizlemesiyle AYNI
 * yerleşimi taşır (motor yerleşimi + hafif düzeltme), profil sürümü ve font klasörüyle; konum/ölçek mm'ye çevrilmiştir.
 */
export class PrintRenderInputBuilder {
  constructor(private readonly d: Deps) {}

  /** `legacyStickerScale`: eski ölçü kuralıyla (plan sürümü 1) basılmış arşiv oturumu basıldığı gibi çizilir. */
  async build(page: PrintPageRecord, template: PrintTemplate, sessionId: string, opts: { legacyStickerScale?: boolean } = {}): Promise<PrintRenderPage> {
    const cache = new Map<string, VariantPrep | undefined>();
    const slots = new Map(template.slots.map((s) => [s.id, s]));
    const items: PrintRenderItem[] = [];
    for (const it of [...page.items].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))) {
      let prep = cache.get(it.variantId);
      if (!cache.has(it.variantId)) {
        prep = await this.prepare(it.variantId);
        cache.set(it.variantId, prep);
      }
      if (!prep) continue;
      items.push(this.item(it, prep, template, it.slotId ? (slots.get(it.slotId) ?? null) : null, !!opts.legacyStickerScale));
    }
    const show = page.showCellLabels;
    return {
      pageId: page.id,
      sessionId,
      name: page.name,
      index: page.index,
      copies: page.copies,
      templateId: template.id,
      templateName: template.name,
      printKind: template.kind,
      paper: template.paper,
      slots: template.slots,
      cut: template.cut,
      cellLabel: { ...template.cellLabel, show },
      cellLabels: show ? this.cellLabels(page.items, template) : [],
      items,
    };
  }

  private item(it: PrintItem, p: VariantPrep, t: PrintTemplate, slot: PrintSlot | null, legacy: boolean): PrintRenderItem {
    const framePx = p.geometry?.framePx ?? p.profile.output.designFramePx;
    const cut = p.geometry?.cut ?? (t.kind === "label" ? (p.labelCut?.shape ?? p.profile.output.cut) : null);
    const image = p.image;
    let mmPerPx: number;
    let anchor: { x: number; y: number };
    if (t.kind === "sticker") {
      // Sticker: mürekkep yazı alanına (mm) sığdırılır; çapa mürekkep kutusunun merkezi (planlayıcı mürekkep merkezini verir).
      const size = stickerSizeFor(p.layout, image, p.job, p.profile, it.scale, legacy);
      mmPerPx = size.mmPerPx;
      anchor = size.anchorPx;
    } else {
      // Etiket: şablonun kendi kesimi (mm) varsa o ölçüde basılır (yuvaya ölçeklenmez; yuva uymazsa oturum uyarır);
      // yoksa tasarım karesi yuvaya ortalanır ve yuva ölçüsündedir (eski kural).
      const own = p.geometry?.mmPerPx ?? p.labelCut?.mmPerPx;
      mmPerPx = own ? own * it.scale : (labelDiameterMm(t, slot, p.profile, p.job.label_size) * it.scale) / framePx;
      anchor = { x: framePx / 2, y: framePx / 2 };
    }
    const diameterMm = framePx * mmPerPx;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    return {
      itemId: it.id,
      jobId: it.jobId,
      variantId: it.variantId,
      orderNo: p.job.order_no,
      variantKind: p.v.kind,
      printKind: t.kind,
      centerMm: { x: it.xMm, y: it.yMm },
      rotation: it.rotation,
      mmPerPx: r4(mmPerPx),
      framePx,
      anchorPx: anchor,
      diameterMm: Math.round(diameterMm * 100) / 100,
      bleedMm: t.cut.bleedMm,
      layout: p.layout,
      geometry: p.geometry,
      templatePath: p.templatePath,
      templateBox: p.geometry?.templateBox ?? (t.kind === "label" ? (p.imageBox ?? p.profile.output.templateBox) : null),
      cut,
      profile: p.profile,
      profileVersion: p.profileVersion,
      fontsDir: this.d.paths.fonts(p.job.language_id),
      previewPath: p.v.preview_file ? path.join(this.d.paths.previews, p.v.preview_file) : null,
      textLayerPath: this.d.variants.textLayerPath(p.v),
      textBox: image?.textBox ?? null,
      extra: it.extra,
      z: it.z,
    };
  }

  /**
   * Hücre etiketleri: sayfadaki her siparişin okuma sırasındaki İLK yuvasının sağ alt köşesine göre (dx, dy).
   * İlk yuva satırın en sağındaysa yazı sayfadan taşmasın diye bir önceki yuva kullanılır (eklentideki kural).
   * Sticker sayfasında basılmaz: eklentide sipariş adı yalnızca grubun adıydı, masa da göstermez; yuva olmadığı için
   * etiket dairesi varsayımıyla konan yazı alttaki sticker'ın üstüne biniyordu.
   */
  cellLabels(items: readonly PrintItem[], t: PrintTemplate): PrintRenderCellLabel[] {
    if (t.kind === "sticker") return [];
    const order = slotsInReadingOrder(t.slots, ROW_TOL_MM);
    const pos = new Map(order.map((s, i) => [s.id, i]));
    const sorted = [...items].sort((a, b) => {
      const pa = a.slotId !== null ? (pos.get(a.slotId) ?? Infinity) : Infinity;
      const pb = b.slotId !== null ? (pos.get(b.slotId) ?? Infinity) : Infinity;
      return pa - pb || a.yMm - b.yMm || a.xMm - b.xMm;
    });
    const seen = new Set<string>();
    const out: PrintRenderCellLabel[] = [];
    for (const it of sorted) {
      if (seen.has(it.jobId)) continue;
      seen.add(it.jobId);
      const text = this.labelText(it.jobId);
      if (!text) continue;
      const i = it.slotId !== null ? pos.get(it.slotId) : undefined;
      let slot = i !== undefined ? order[i]! : null;
      if (slot && i !== undefined && i > 0) {
        const s = slot;
        const rightmost = !order.some((o) => o.id !== s.id && Math.abs(o.cy - s.cy) <= ROW_TOL_MM && o.cx > s.cx);
        if (rightmost) slot = order[i - 1]!;
      }
      const half = slot ? { w: slot.w / 2, h: slot.h / 2 } : { w: (t.labelDiameterMm ?? t.slots[0]?.w ?? 38) / 2, h: (t.labelDiameterMm ?? t.slots[0]?.h ?? 38) / 2 };
      const cx = slot ? slot.cx : it.xMm;
      const cy = slot ? slot.cy : it.yMm;
      out.push({
        text,
        xMm: Math.round((cx + half.w + t.cellLabel.dxMm) * 100) / 100,
        yMm: Math.round((cy + half.h + t.cellLabel.dyMm) * 100) / 100,
        slotId: slot?.id ?? null,
      });
    }
    return out;
  }

  /** Sipariş adı: profilin sipariş adı deseni (`printing.orderNamePattern`, ör. "{orderNo}_{quantity}adet"). */
  private labelText(jobId: string): string {
    const job = this.d.jobs.row(jobId, true);
    if (!job) return "";
    const pattern = this.d.profiles.active(job.language_id)?.data.printing.orderNamePattern ?? "{orderNo}_{quantity}adet";
    const name = formatOrderName(pattern, { orderNo: job.order_no, quantity: job.quantity, templateKey: job.template_key, labelSize: job.label_size, seq: job.seq, raw: json(job.raw, {}) });
    return name.replace(/^_+|_+$/g, "") ? name : "";
  }

  private async prepare(variantId: string): Promise<VariantPrep | undefined> {
    const v = this.d.variants.row(variantId, true);
    if (!v) return undefined;
    const job = this.d.jobs.row(v.job_id, true);
    if (!job) return undefined;
    const snap = json<VariantSnapshot | null>(v.snapshot, null);
    const { profile, version: profileVersion } = variantProfile(this.d.profiles, job, v);
    const layout = printLayout(this.d.variants, v, profile);
    let geometry: TemplateGeometry | null = null;
    let templatePath: string | null = null;
    const key = snap?.templateKey ?? job.template_key;
    // Şablon kaydındaki kesim (geometri kurulamasa da: görsel eksik, paket bağlı değil): ölçek ve kırpma buradan.
    const record = job.kind === "label" && key ? this.d.templates.find(job.language_id, key) : null;
    const labelCut = job.kind === "label" ? effectiveCut(record, profile) : null;
    const imageBox = record ? templateImageBox(record, profile) : null;
    try {
      const override = snap?.templateKey ? (this.d.templates.find(job.language_id, snap.templateKey) ?? undefined) : undefined;
      const target = await this.d.targets.resolve({ language_id: job.language_id, template_key: key, kind: job.kind }, profile, profileVersion ?? 0, override);
      geometry = target.geometry;
      templatePath = target.templatePath;
    } catch {
      // templates paketi bağlı değil ya da şablon kayıp: motor önizleme PNG'sine düşebilir.
    }
    return { v, job, profile, profileVersion, layout, geometry, templatePath, image: json<VariantImage | null>(v.image, null), labelCut, imageBox };
  }
}


/** Sipariş adı deseni: {orderNo}, {quantity}, {template}, {size}, {seq} ve JSON alan adları ({alan}). */
export function formatOrderName(
  pattern: string,
  job: { orderNo: string | null; quantity: number | null; templateKey: string | null; labelSize: string | null; seq: number; raw: Record<string, unknown> },
): string {
  return pattern
    .replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (key === "orderNo") return job.orderNo ?? "";
      if (key === "quantity") return job.quantity === null ? "" : String(job.quantity);
      if (key === "template") return job.templateKey ?? "";
      if (key === "size") return job.labelSize ?? "";
      if (key === "seq") return String(job.seq + 1);
      const v = job.raw[key];
      return v === undefined || v === null ? "" : String(v);
    })
    .trim();
}
