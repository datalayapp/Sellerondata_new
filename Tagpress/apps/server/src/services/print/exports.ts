import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { PRINT_API, type PrintExport, type PrintExportRequestSchema, apiPath } from "@tagpress/domain";
import type { z } from "zod";
import { json } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import type { DataPaths } from "../../config.ts";
import { maintenance } from "../../org/context.ts";
import type { TenantDb } from "../../org/tenant-db.ts";
import type { Ports } from "../../ports.ts";
import type { Clock } from "../../util/clock.ts";
import { fail } from "../../util/errors.ts";
import { writeAtomic } from "../../util/files.ts";
import { safeJoin } from "../../util/safe-path.ts";
import { DEFAULT_MAX_CONCURRENCY, FairScheduler } from "../generation/fair.ts";
import type { ProfileService } from "../profiles.ts";
import type { PrintRenderPage } from "./ports.ts";
import type { PrintRenderInputBuilder } from "./render-input.ts";
import type { PrintSessionService } from "./sessions.ts";
import type { PrintTemplateService } from "./templates.ts";

interface ExportRow {
  id: string;
  session_id: string;
  format: "pdf" | "png";
  params: string;
  status: PrintExport["status"];
  done: number;
  total: number;
  files: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface StoredFile {
  name: string;
  file: string;
  bytes: number;
}

type ExportRequest = z.output<typeof PrintExportRequestSchema>;

/** Dosya adı: Windows'ta geçersiz karakterler atılır. */
// eslint-disable-next-line no-control-regex -- Windows dosya adında geçersiz denetim karakterleri (U+0000–001F) bilerek atılır
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "baski";

interface Deps {
  db: TenantDb;
  /** Çıktı klasörü: geçerli firmanın `baski/` klasörü (`paths.prints`, her erişimde okunur). */
  paths: Pick<DataPaths, "prints">;
  ports: Ports;
  sessions: PrintSessionService;
  templates: PrintTemplateService;
  profiles: ProfileService;
  builder: PrintRenderInputBuilder;
  events: EventBus;
  clock: Clock;
  /** Kurulum genelinde aynı anda çalışan en çok çıktı görevi (varsayılan 4). */
  maxConcurrency?: () => number;
}

/**
 * Baskı çıktısı (PDF/PNG): arka plan görevi; bir firmanın görevleri tek sırada, firmalar arasında adil sıra (kurulum
 * genelinde en çok `maxConcurrency`), her görev kendi firmasının bağlamında. İlerleme SSE `printExport`; dosyalar
 * firma kökünde `baski/<görev>/`. Çizim motoru (`ports.printRenderer`) bağlı değilse 501.
 */
export class PrintExportService {
  private readonly scheduler: FairScheduler;

  constructor(private readonly d: Deps) {
    this.scheduler = new FairScheduler({ maxTotal: () => d.maxConcurrency?.() ?? DEFAULT_MAX_CONCURRENCY, maxPerOrg: () => 1 });
  }

  /** Sayfa küçük resmi / tam çözünürlük PNG. */
  async pagePng(pageId: string, widthPx?: number): Promise<Buffer> {
    const renderer = this.d.ports.printRenderer;
    if (!renderer) throw fail("print-render-unavailable");
    const { session, page } = this.d.sessions.page(pageId);
    // Basılmış oturumda "basıldı" anındaki şablon kopyası; taslakta güncel şablon.
    const t = this.d.sessions.pageTemplate(session.id, page.templateId);
    const input = await this.d.builder.build(page, t, session.id, { legacyStickerScale: this.d.sessions.legacyStickerScale(session.id) });
    const dpi = this.dpiFor(session.language_id, t.kind);
    return renderer.renderPagePng({ page: input, dpi, ...(widthPx ? { widthPx } : {}) });
  }

  /** Etiket: profil `printing.dpi`; sticker: `printing.stickerDpi` (ikisi de varsayılan 300). Fiziksel ölçü dpi'den bağımsızdır (mm). */
  private dpiFor(languageId: string, kind: "label" | "sticker"): number {
    const p = this.d.profiles.activeProfile(languageId).profile.printing;
    return kind === "sticker" ? p.stickerDpi : p.dpi;
  }

  start(sessionId: string, req: ExportRequest): PrintExport {
    const renderer = this.d.ports.printRenderer;
    if (!renderer) throw fail("print-render-unavailable");
    if (req.format === "pdf" && !renderer.renderPdf) throw fail("pdf-unavailable");
    const s = this.d.sessions.detail(sessionId);
    const pages = req.pages ? s.pages.filter((p) => req.pages!.includes(p.id)) : s.pages;
    if (req.pages && pages.length !== new Set(req.pages).size) throw fail("print-page-not-found");
    if (!pages.length) throw fail("export-no-pages");
    const id = randomUUID();
    const now = this.now();
    this.d.db
      .prepare("INSERT INTO print_exports (org_id, id, session_id, format, params, status, done, total, created_at) VALUES ($org, ?, ?, ?, ?, 'queued', 0, ?, ?)")
      .run(id, sessionId, req.format, JSON.stringify({ pages: pages.map((p) => p.id), dpi: req.dpi ?? null, pdfMode: req.pdfMode ?? null }), pages.length, now);
    this.progress(id, sessionId, "queued", 0, pages.length);
    void this.scheduler.submit(this.d.db.orgId("print-exports.start"), () => this.run(id).catch(() => undefined));
    return this.get(id);
  }

  get(id: string): PrintExport {
    const r = this.row(id);
    return {
      id: r.id,
      sessionId: r.session_id,
      format: r.format,
      status: r.status,
      done: r.done,
      total: r.total,
      files: json<StoredFile[]>(r.files, []).map((f, i) => ({ name: f.name, bytes: f.bytes, url: apiPath(PRINT_API.exportFile, { id: r.id, index: i }) })),
      error: r.error,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  file(id: string, index: number): { path: string; name: string; mime: string } {
    const r = this.row(id);
    const f = json<StoredFile[]>(r.files, [])[index];
    if (!f) throw fail("export-file-not-found");
    const p = safeJoin(this.d.paths.prints, `${r.id}/${f.file}`, { ext: [".png", ".pdf"] });
    if (!p || !existsSync(p)) throw fail("export-file-not-found");
    return { path: p, name: f.name, mime: f.file.endsWith(".pdf") ? "application/pdf" : "image/png" };
  }

  /** Açılışta yarım kalan görevler (bütün firmalar; kurulum geneli bakım) "kesildi". */
  recover(): void {
    maintenance(
      () => this.d.db.maintenance.prepare("UPDATE print_exports SET status = 'interrupted', finished_at = ? WHERE status IN ('queued', 'running')").run(this.now()),
      "baskı çıktısı kurtarma",
    );
  }

  /** Sıradaki bütün görevler (bütün firmalar) bitince (testler, kapanış). */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  private async run(id: string): Promise<void> {
    const r = this.row(id);
    const params = json<{ pages: string[]; dpi: number | null; pdfMode?: "raster" | "vector" | null }>(r.params, { pages: [], dpi: null });
    const renderer = this.d.ports.printRenderer;
    const set = (status: PrintExport["status"], done: number, extra: { files?: StoredFile[]; error?: string | null } = {}) => {
      const finished = status === "done" || status === "failed" ? this.now() : null;
      this.d.db
        .prepare("UPDATE print_exports SET status = ?, done = ?, files = COALESCE(?, files), error = ?, finished_at = ? WHERE id = ? AND org_id = $org")
        .run(status, done, extra.files ? JSON.stringify(extra.files) : null, extra.error ?? null, finished, id);
      this.progress(id, r.session_id, status, done, r.total);
    };
    try {
      if (!renderer) throw new Error("Baskı sayfası çizimi (motor) bağlı değil.");
      set("running", 0);
      const s = this.d.sessions.detail(r.session_id);
      const inputs: PrintRenderPage[] = [];
      let kind: "label" | "sticker" = "label";
      for (const pid of params.pages) {
        const page = s.pages.find((p) => p.id === pid);
        if (!page) throw new Error("Sayfa oturumda yok (silinmiş olabilir).");
        const t = this.d.sessions.pageTemplate(s.id, page.templateId);
        kind = t.kind;
        inputs.push(await this.d.builder.build(page, t, s.id, { legacyStickerScale: this.d.sessions.legacyStickerScale(s.id) }));
      }
      const dpi = params.dpi ?? this.dpiFor(s.languageId, kind);
      const dir = path.join(this.d.paths.prints, id);
      const files: StoredFile[] = [];
      if (r.format === "pdf") {
        const mode = params.pdfMode ?? "raster";
        const pdf = await renderer.renderPdf!({ pages: inputs, dpi, mode, title: s.name, onPage: (done) => set("running", done) });
        const file = "baski.pdf";
        await writeAtomic(path.join(dir, file), pdf);
        files.push({ name: `${safeName(s.name)}${mode === "vector" ? " (vektör)" : ""}.pdf`, file, bytes: pdf.length });
      } else {
        for (const [i, page] of inputs.entries()) {
          const png = await renderer.renderPagePng({ page, dpi });
          const file = `${String(i + 1).padStart(2, "0")}.png`;
          await writeAtomic(path.join(dir, file), png);
          const copies = page.copies > 1 ? ` x${page.copies}` : "";
          files.push({ name: `${String(page.index + 1).padStart(2, "0")} ${safeName(page.name || "sayfa")}${copies}.png`, file, bytes: png.length });
          set("running", i + 1);
        }
      }
      set("done", inputs.length, { files });
    } catch (err) {
      set("failed", 0, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private progress(exportId: string, sessionId: string, status: PrintExport["status"], done: number, total: number): void {
    this.d.events.emit({ type: "printExport", exportId, sessionId, status, done, total });
  }

  private row(id: string): ExportRow {
    const r = this.d.db.prepare("SELECT * FROM print_exports WHERE id = ? AND org_id = $org").get(id) as ExportRow | undefined;
    if (!r) throw fail("export-not-found");
    return r;
  }

  private now(): string {
    return this.d.clock.now().toISOString();
  }
}
