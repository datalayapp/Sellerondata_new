import { existsSync } from "node:fs";
import type { Profile, StickerSheet, Template, TemplateGeometry } from "@tagpress/domain";
import type { Ports } from "../../ports.ts";
import { maybeOrg } from "../../org/context.ts";
import { stickerSheetId } from "../import/rows.ts";
import type { JobRow } from "../jobs/mapping.ts";
import type { TemplateService } from "../templates.ts";

/** Üretimin hedefi: şablon (ya da sticker sayfası) ve motor geometrisi. */
export interface Target {
  template: Template | null;
  templatePath: string | null;
  sticker: StickerSheet | null;
  geometry: TemplateGeometry;
}

/** Kullanıcıya gösterilecek, yeniden denemeyle düzelmeyecek hata. */
export class GenerationError extends Error {
  constructor(
    message: string,
    readonly code: "ai-failed" | "no-layout" | "ai-no-good-candidate" | "font-unavailable" = "ai-failed",
  ) {
    super(message);
  }
}

const CACHE_MAX = 64;

/** Geometri hesaplamak pahalıdır: (dil, şablon, dosya özeti, profil sürümü) başına önbellek. */
export class TargetResolver {
  private readonly cache = new Map<string, TemplateGeometry>();

  constructor(
    private readonly ports: Ports,
    private readonly templates: TemplateService,
  ) {}

  async resolve(job: Pick<JobRow, "language_id" | "template_key" | "kind">, profile: Profile, profileVersion: number, override?: Template): Promise<Target> {
    const geo = this.ports.geometry;
    if (!geo) throw new GenerationError("Şablon geometrisi (templates paketi) bağlı değil.");
    const sheetId = override ? null : stickerSheetId(job.template_key);
    if (sheetId || (job.kind === "sticker" && !override)) {
      const sheet = profile.stickers.sheets.find((s) => s.id === sheetId);
      if (!sheet) throw new GenerationError("Sticker sayfası profilde tanımlı değil.");
      const key = `${maybeOrg()?.orgId ?? "-"}|${job.language_id}|sticker|${sheet.id}|${profileVersion}`;
      const geometry = this.cache.get(key) ?? (await geo.forSticker({ sheet, profile }));
      this.remember(key, geometry);
      return { template: null, templatePath: null, sticker: sheet, geometry };
    }
    const template = override ?? (job.template_key ? this.templates.find(job.language_id, job.template_key) : null);
    if (!template) throw new GenerationError(job.template_key ? `"${job.template_key}" şablonu bulunamadı.` : "İşin şablonu yok.");
    const imagePath = this.templates.imagePath(job.language_id, template);
    if (!existsSync(imagePath)) throw new GenerationError(`"${template.key}" şablonunun PNG dosyası yok.`);
    // Süreç geneli önbellek: anahtarda firma da var (geometri firmanın şablon dosyasından).
    const key = `${maybeOrg()?.orgId ?? "-"}|${job.language_id}|${profileVersion}|${JSON.stringify(template)}`;
    const geometry = this.cache.get(key) ?? (await geo.forTemplate({ template, imagePath, profile }));
    this.remember(key, geometry);
    return { template, templatePath: imagePath, sticker: null, geometry };
  }

  private remember(key: string, g: TemplateGeometry): void {
    this.cache.delete(key);
    this.cache.set(key, g);
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }
}
