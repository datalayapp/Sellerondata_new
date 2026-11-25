import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type PrintGridRequestSchema,
  type PrintGridResponse,
  type PrintPreset,
  type PrintPresetCreateSchema,
  type PrintPresetPatchSchema,
  PrintPresetSchema,
  type PrintTemplate,
  type PrintTemplateCreateSchema,
  type PrintTemplateDeleteResponse,
  type PrintTemplatePatchSchema,
  PrintTemplateSchema,
  type PrintTemplateView,
} from "@tagpress/domain";
import type { z } from "zod";
import { json } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import { requireFeature } from "../../features/service.ts";
import { type TenantDb, dialectSql } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";
import { fail, failFields, zodFields } from "../../util/errors.ts";
import type { LanguageService } from "../languages.ts";
import type { SettingsService } from "../settings.ts";
import { storedPrintDefaults } from "../setup.ts";
import { checkTemplate, generateGrid, normalizeSlots } from "./geometry.ts";

interface Row {
  id: string;
  language_id: string;
  data: string;
  archived: number;
}

type Create = z.output<typeof PrintTemplateCreateSchema>;
type Patch = z.output<typeof PrintTemplatePatchSchema>;
type Grid = z.output<typeof PrintGridRequestSchema>;

const presetKey = (languageId: string) => `print.presets.${languageId}`;

/** Başlangıç ön ayarları (veri dosyası; yalnızca ızgara üretecinin başlangıç değerleri, kullanıcı düzeltir). */
function starterPresets(): PrintPreset[] {
  const raw = JSON.parse(readFileSync(new URL("./baslangic-on-ayarlari.json", import.meta.url), "utf8")) as unknown[];
  return raw.map((p) => PrintPresetSchema.parse(p));
}

/** Düz nesne derin birleştirme (diziler ve null değer olduğu gibi yazılır). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/**
 * Baskı sayfası şablonları (tasarım dili kapsamında, düz veri). Arşivlenen listede gizlenir; silme yalnız hiç
 * kullanılmamış şablonu kalıcı siler, kullanılmışı arşivler (`remove`).
 * Her kayıt tam şemayla doğrulanır; geometri sorunları UYARI olarak döner (`warnings`), kaydı engellemez.
 */
export class PrintTemplateService {
  constructor(
    private readonly db: TenantDb,
    private readonly languages: LanguageService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly clock: Clock,
    /** Şablonun geometrisi değişti (taslak oturumlardaki yuva konumları eşitlenir). */
    private readonly afterChange?: (t: PrintTemplate, prev: PrintTemplate) => void,
  ) {}

  /** `usedIn` verilmezse (tek şablon) o şablon için sorulur; listede toplu sorgudan gelir (N+1 olmasın). */
  view(t: PrintTemplate, usedIn?: number): PrintTemplateView {
    return { ...t, warnings: checkTemplate(t), capacity: t.slots.length, usedIn: usedIn ?? this.usageCounts({ id: t.id }).get(t.id) ?? 0 };
  }

  list(languageId: string, includeArchived = false): PrintTemplateView[] {
    this.languages.get(languageId);
    const rows = this.db
      .prepare(
        `SELECT * FROM print_templates WHERE org_id = $org AND language_id = ? ${includeArchived ? "" : "AND archived = 0"} ORDER BY archived, ${dialectSql(this.db, { sqlite: "name COLLATE NOCASE", pg: "lower(name)" })}, created_at`,
      )
      .all(languageId) as unknown as Row[];
    const usage = this.usageCounts({ languageId });
    return rows.map((r) => {
      const parsed = this.parse(r);
      return this.view(parsed, usage.get(parsed.id) ?? 0);
    });
  }

  find(id: string): PrintTemplate | null {
    const r = this.db.prepare("SELECT * FROM print_templates WHERE id = ? AND org_id = $org").get(id) as Row | undefined;
    return r ? this.parse(r) : null;
  }

  require(id: string): PrintTemplate {
    const t = this.find(id);
    if (!t) throw fail("print-template-not-found");
    return t;
  }

  get(id: string): PrintTemplateView {
    return this.view(this.require(id));
  }

  /**
   * Yeni şablon. Kağıt verilmezse firmanın kurulumdaki kağıdı (`print.defaults.paper`; yoksa A4); kesim alanları
   * kurulumun kesim varsayılanlarının (`defaultCut`) üstüne derin birleşir.
   */
  create(input: Create, source: PrintTemplate["source"] = "manual"): PrintTemplateView {
    this.languages.get(input.languageId);
    const now = this.now();
    const t = this.validate({
      ...input,
      paper: input.paper ?? this.defaultPaper(),
      cut: deepMerge(this.defaultCut(), input.cut ?? {}),
      slots: normalizeSlots(input.slots),
      id: randomUUID(),
      source,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
    this.write(t, true);
    return this.view(t);
  }

  /** Yama: verilen alanlar değişir, `cut`/`cellLabel` derin birleşir, `slots` verilirse tamamı değişir. */
  update(id: string, patch: Patch): PrintTemplateView {
    const cur = this.require(id);
    const { slots, ...rest } = patch;
    const merged = deepMerge<PrintTemplate>(cur, rest);
    const t = this.validate({ ...merged, ...(slots ? { slots: normalizeSlots(slots) } : {}), updatedAt: this.now() });
    this.write(t, false, cur);
    if (slots || patch.paper || patch.kind) this.afterChange?.(t, cur);
    return this.view(t);
  }

  archive(id: string, archived: boolean): PrintTemplateView {
    return this.update(id, { archived });
  }

  /**
   * Sil: hiç kullanılmamış şablon kalıcı silinir (`deleted`). Bir baskı oturumunda ya da sayfasında geçiyorsa (`inUse`)
   * yalnız arşivlenir (`archived`); geçmiş baskı, geri alınabilir silinmiş sayfa/oturum ve yeniden basım bozulmaz.
   * Denetim ve silme tek işlemde.
   */
  remove(id: string): PrintTemplateDeleteResponse {
    const out = this.db.tx(() => {
      const cur = this.require(id);
      if (this.inUse(cur.id)) {
        if (cur.archived) return { result: "archived" as const, languageId: cur.languageId, changed: false };
        const now = this.now();
        this.db
          .prepare("UPDATE print_templates SET archived = 1, data = ?, updated_at = ? WHERE id = ? AND org_id = $org")
          .run(JSON.stringify({ ...cur, archived: true, updatedAt: now }), now, cur.id);
        return { result: "archived" as const, languageId: cur.languageId, changed: true };
      }
      this.db.prepare("DELETE FROM print_templates WHERE id = ? AND org_id = $org").run(cur.id);
      return { result: "deleted" as const, languageId: cur.languageId, changed: true };
    });
    if (out.changed) this.events.emit({ type: "print", languageId: out.languageId, sessionId: null });
    return { result: out.result };
  }

  /**
   * Şablon kullanılmış mı: herhangi bir baskı sayfası (`print_pages.template_id`) ya da oturum planı
   * (`print_sessions.template_id`) ona bakıyorsa ya da basılmış oturumun anlık kopyasında
   * (`print_sessions.template_snapshots`, kimlik anahtarı) geçiyorsa. Silinmiş (geri alınabilir) sayfa ve oturumlar da
   * sayılır: geri alınınca şablonları bulunmalı.
   */
  private inUse(id: string): boolean {
    return (this.usageCounts({ id }).get(id) ?? 0) > 0;
  }

  /**
   * Şablon başına "kaç baskı oturumunda kullanıldı" (tek sorgu; `inUse` ile aynı tanım): oturum planı, oturumun
   * sayfası ya da basılmış oturumun anlık kopyası (`template_snapshots`) şablona bakıyorsa o oturum sayılır.
   * Silinmiş (geri alınabilir) oturum ve sayfalar dahil. Hiç kullanılmayan şablon haritada yoktur.
   */
  private usageCounts(by: { id: string } | { languageId: string }): Map<string, number> {
    const [col, val] = "id" in by ? ["id", by.id] : ["language_id", by.languageId];
    // Anlık kopya JSON'u `{ "<kimlik>": {…} }`: tırnaklı kimlik metin olarak aranır (fazladan eşleşme yalnız fazla sayar/arşivletir).
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, COUNT(DISTINCT s.id) AS n
         FROM print_templates t
         JOIN print_sessions s ON s.org_id = $org AND (
           s.template_id = t.id
           OR s.template_snapshots LIKE ('%"' || replace(replace(replace(t.id, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '"%') ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM print_pages p WHERE p.org_id = $org AND p.session_id = s.id AND p.template_id = t.id)
         )
         WHERE t.org_id = $org AND t.${col} = ?
         GROUP BY t.id`,
      )
      .all(val) as unknown as { id: string; n: number | string }[];
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  duplicate(id: string, name?: string): PrintTemplateView {
    const cur = this.require(id);
    const now = this.now();
    const t = this.validate({ ...cur, id: randomUUID(), name: name ?? `${cur.name} (kopya)`, source: cur.source, archived: false, createdAt: now, updatedAt: now });
    this.write(t, true);
    return this.view(t);
  }

  /**
   * Basılmış oturumdaki anlık kopyadan yeni şablon (yeni kimlik, ARŞİVLİ: seçim listelerinde görünmez ama sayfa onu
   * kullanabilir). Yeniden basım "aynen" basıldığı hâliyle olsun diye; güncel şablona geçiş `setPageTemplate` ile.
   */
  restoreSnapshot(snap: PrintTemplate, name: string): PrintTemplate {
    const now = this.now();
    const t = this.validate({ ...snap, id: randomUUID(), name, archived: true, createdAt: now, updatedAt: now });
    this.write(t, true, undefined, true);
    return t;
  }

  /** Izgara üreteci: önizleme (dryRun), yeni şablon ya da var olan şablonun kağıdı + yuvaları. */
  grid(req: Grid): PrintGridResponse {
    this.languages.get(req.languageId);
    const slots = generateGrid(req);
    const probe = { kind: req.kind, paper: req.paper, slots, stickerFlow: null, labelDiameterMm: req.labelDiameterMm ?? null };
    if (req.dryRun) {
      const existing = req.templateId ? this.require(req.templateId) : null;
      return { slots, warnings: checkTemplate({ ...probe, ...(existing ? { cut: existing.cut } : {}), labelDiameterMm: req.labelDiameterMm !== undefined ? req.labelDiameterMm : (existing?.labelDiameterMm ?? null) }), template: null };
    }
    if (req.templateId) {
      const cur = this.require(req.templateId);
      if (cur.languageId !== req.languageId) throw fail("template-other-language");
      const view = this.update(cur.id, {
        paper: req.paper,
        slots,
        ...(req.name ? { name: req.name } : {}),
        ...(req.sizeId !== undefined ? { sizeId: req.sizeId } : {}),
        ...(req.labelDiameterMm !== undefined ? { labelDiameterMm: req.labelDiameterMm } : {}),
      });
      return { slots: view.slots, warnings: view.warnings, template: view };
    }
    const shapeName = req.shape === "circle" ? `Ø${slots[0]?.w ?? ""} mm` : `${slots[0]?.w ?? ""}×${slots[0]?.h ?? ""} mm`;
    const view = this.create(
      {
        languageId: req.languageId,
        name: req.name ?? `${req.paper.wMm}×${req.paper.hMm} · ${shapeName} · ${slots.length}'li`,
        kind: req.kind,
        paper: req.paper,
        sizeId: req.sizeId ?? null,
        slots,
        stickerFlow: null,
        cut: this.defaultCut(),
        cellLabel: PrintTemplateSchema.shape.cellLabel.parse(undefined),
        labelDiameterMm: req.labelDiameterMm ?? null,
      },
      "grid",
    );
    return { slots: view.slots, warnings: view.warnings, template: view };
  }

  /**
   * Yeni ızgara şablonunun kesim ayarı: kurulumun baskı cevaplarından (`print.defaults`; kesim çizgisi, kesim dosyası,
   * taşma, kayıt işareti) şema varsayılanlarının üstüne; kayıt yoksa ya da geçersizse yalnız şema varsayılanları.
   */
  private defaultCut(): PrintTemplate["cut"] {
    const fromSetup = storedPrintDefaults(this.settings)?.cut;
    const r = fromSetup ? PrintTemplateSchema.shape.cut.safeParse(fromSetup) : null;
    return r?.success ? r.data : PrintTemplateSchema.shape.cut.parse(undefined);
  }

  /** Yeni şablonun kağıdı: kurulumun kağıt cevabı (`print.defaults.paper`, mm); yoksa ya da geçersizse A4. */
  private defaultPaper(): PrintTemplate["paper"] {
    const r = PrintTemplateSchema.shape.paper.safeParse(storedPrintDefaults(this.settings)?.paper);
    return r.success ? r.data : { wMm: 210, hMm: 297 };
  }

  // ---------------------------------------------------------------- ön ayarlar (tasarım dili verisi)

  presets(languageId: string): PrintPreset[] {
    this.languages.get(languageId);
    const stored = this.settings.getValue<unknown[] | null>(presetKey(languageId), null);
    if (stored === null) {
      // İlk okuma: başlangıç ön ayarları dile kopyalanır (sonra kullanıcınındır; silinenler geri gelmez).
      const seed = starterPresets();
      this.settings.setValue(presetKey(languageId), seed);
      return seed;
    }
    return stored.flatMap((p) => {
      const r = PrintPresetSchema.safeParse(p);
      return r.success ? [r.data] : [];
    });
  }

  createPreset(input: z.output<typeof PrintPresetCreateSchema>): PrintPreset {
    const { languageId, ...rest } = input;
    const list = this.presets(languageId);
    const p = PrintPresetSchema.parse({ ...rest, id: randomUUID() });
    this.savePresets(languageId, [...list, p]);
    return p;
  }

  updatePreset(id: string, input: z.output<typeof PrintPresetPatchSchema>): PrintPreset {
    const { languageId, ...patch } = input;
    const list = this.presets(languageId);
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) throw fail("preset-not-found");
    const r = PrintPresetSchema.safeParse(deepMerge(list[i]!, patch));
    if (!r.success) throw failFields("preset-invalid", zodFields(r.error));
    list[i] = r.data;
    this.savePresets(languageId, list);
    return r.data;
  }

  deletePreset(languageId: string, id: string): void {
    const list = this.presets(languageId);
    if (!list.some((p) => p.id === id)) throw fail("preset-not-found");
    this.savePresets(languageId, list.filter((p) => p.id !== id));
  }

  private savePresets(languageId: string, list: PrintPreset[]): void {
    this.settings.setValue(presetKey(languageId), list);
    this.events.emit({ type: "print", languageId, sessionId: null });
  }

  // ---------------------------------------------------------------- kayıt

  private validate(t: unknown): PrintTemplate {
    const r = PrintTemplateSchema.safeParse(t);
    if (!r.success) throw failFields("print-template-invalid", zodFields(r.error));
    return r.data;
  }

  /**
   * `prev`: güncellemede önceki hâl; `restore`: anlık kopyadan geri getirme (yeniden basım). `print.stickers` yalnız
   * YENİ sticker şablonu yazılırken denetlenir (orkestratör kararı 2026-11-22, B2 incelemesi 3): ekleme (oluşturma,
   * ızgara, çoğaltma) ve etiket şablonunu sticker'a çevirme. Var olan sticker şablonunu yeniden adlandırma, düzenleme,
   * arşivleme, anlık kopyadan geri getirme, oturum açma ve yeniden basma özellik kapalıyken de serbest (veri kilitlenmez).
   */
  private write(t: PrintTemplate, insert: boolean, prev?: PrintTemplate, restore = false): void {
    const newSticker = t.kind === "sticker" && !restore && (insert || prev?.kind !== "sticker");
    if (newSticker) requireFeature(this.settings, "print.stickers"); // SUNUCU-PLANI §3.3
    if (insert) {
      this.db
        .prepare("INSERT INTO print_templates (org_id, id, language_id, name, kind, data, archived, created_at, updated_at) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(t.id, t.languageId, t.name, t.kind, JSON.stringify(t), t.archived ? 1 : 0, t.createdAt, t.updatedAt);
    } else {
      this.db
        .prepare("UPDATE print_templates SET name = ?, kind = ?, data = ?, archived = ?, updated_at = ? WHERE id = ? AND org_id = $org")
        .run(t.name, t.kind, JSON.stringify(t), t.archived ? 1 : 0, t.updatedAt, t.id);
    }
    this.events.emit({ type: "print", languageId: t.languageId, sessionId: null });
  }

  private parse(r: Row): PrintTemplate {
    // Kayıt şemayla okunur (yeni varsayılan alanlar dolar); bozuk kayıt kimliğiyle hata verir.
    const data = json<Record<string, unknown>>(r.data, {});
    const p = PrintTemplateSchema.safeParse({ ...data, id: r.id, languageId: r.language_id, archived: !!r.archived });
    if (!p.success) throw fail("print-template-corrupt", { id: r.id });
    return p.data;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}
