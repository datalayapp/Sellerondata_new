import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  LANGUAGE_PACKAGE_FORMAT,
  type LanguageImportRequest,
  LanguageImportRequestSchema,
  type LanguageImportResponse,
  type LanguagePackage,
  ProfileSchema,
  upgradeProfileInput,
} from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import type { Clock } from "../util/clock.ts";
import { failFields, zodFields } from "../util/errors.ts";
import { isPng, safeFileName, writeAtomic } from "../util/files.ts";
import { PNG, safeJoin } from "../util/safe-path.ts";
import { fromBase64 } from "../util/text.ts";
import type { LanguageService } from "./languages.ts";
import type { ProfileService } from "./profiles.ts";
import { isValidKey, type TemplateService } from "./templates.ts";

const FONT_EXT = /\.(ttf|otf|ttc|woff2?)$/i;

/**
 * Tasarım dili paketi: profil (etkin + taslak) + şablon kayıtları + PNG'ler + fontlar tek JSON'da (base64).
 * Ortak yedek fontlar ve referanslar pakete girmez. İçe aktarma her zaman YENİ dil oluşturur (var olana dokunmaz).
 */
export class LanguagePackageService {
  constructor(
    private readonly d: { paths: DataPaths; languages: LanguageService; profiles: ProfileService; templates: TemplateService; clock: Clock },
  ) {}

  async export(languageId: string): Promise<LanguagePackage> {
    const lang = this.d.languages.get(languageId);
    const active = this.d.profiles.active(languageId);
    const draft = this.d.profiles.draft(languageId);
    const templates: LanguagePackage["templates"] = [];
    for (const item of this.d.templates.list(languageId)) {
      const file = this.d.templates.imageFile(languageId, item.template);
      templates.push({ record: item.template as Record<string, unknown>, png: file && existsSync(file) ? (await readFile(file)).toString("base64") : null });
    }
    const fonts: LanguagePackage["fonts"] = [];
    const fontDir = this.d.paths.fonts(languageId);
    if (existsSync(fontDir)) {
      for (const f of readdirSync(fontDir).sort()) {
        // Klasördeki bağ kökün dışını gösteriyorsa pakete girmez.
        const full = FONT_EXT.test(f) ? safeJoin(fontDir, f) : null;
        if (full) fonts.push({ file: f, data: (await readFile(full)).toString("base64") });
      }
    }
    return {
      format: LANGUAGE_PACKAGE_FORMAT,
      version: 1,
      exportedAt: this.d.clock.now().toISOString(),
      language: { id: lang.id, name: lang.name },
      profile: active?.data ?? null,
      profileVersion: active?.version ?? null,
      draft: draft?.data ?? null,
      templates,
      fonts,
    };
  }

  async import(input: LanguageImportRequest): Promise<LanguageImportResponse> {
    const parsed = LanguageImportRequestSchema.safeParse(input);
    if (!parsed.success) throw failFields("language-package-invalid", zodFields(parsed.error));
    const pkg = parsed.data;
    // Eski adlı alanlar (ör. `figma.frameName`) bugünkü adına çevrilir; taslak `saveDraft` içinde çevrilir.
    const profile = ProfileSchema.safeParse(upgradeProfileInput(pkg.profile));
    if (!profile.success) throw failFields("language-package-profile-invalid", zodFields(profile.error, "profile"));
    const warnings: string[] = [];
    const name = pkg.name ?? pkg.language.name;
    // Paket API'den gelir: kimliği (`pkg.id`, `pkg.language.id`) kullanılmaz, dil her zaman yeni UUIDv7 alır
    // (istenen kimliğin başka firmada dolu olup olmadığı yanıttan okunamasın).
    const lang = this.d.languages.create({ name, profile: { ...profile.data, name: profile.data.name || name }, note: `Paketten içe aktarıldı (${pkg.exportedAt})` });
    const id = lang.id;

    let fonts = 0;
    const fontDir = this.d.paths.fonts(id);
    await mkdir(fontDir, { recursive: true });
    for (const f of pkg.fonts) {
      const target = safeFileName(f.file) && FONT_EXT.test(f.file) ? safeJoin(fontDir, f.file) : null;
      if (!target) {
        warnings.push(`Font atlandı (geçersiz ad): ${f.file}`);
        continue;
      }
      await writeAtomic(target, fromBase64(f.data));
      fonts++;
    }

    let templates = 0;
    const tplDir = this.d.paths.templates(id);
    await mkdir(tplDir, { recursive: true });
    for (const t of pkg.templates) {
      const key = String(t.record.key ?? "").toLowerCase();
      if (!isValidKey(key)) {
        warnings.push(`Şablon atlandı (geçersiz anahtar): ${key || "?"}`);
        continue;
      }
      // Paketteki dosya adı yalnız şablon klasöründeki bir PNG olabilir; değilse anahtardan türetilir.
      const given = typeof t.record.file === "string" && safeFileName(t.record.file) ? t.record.file : null;
      const file = given && safeJoin(tplDir, given, { ext: PNG }) ? given : `${key}.png`;
      if (t.png) {
        const buf = fromBase64(t.png);
        if (!isPng(buf)) {
          warnings.push(`Şablon görseli PNG değil: ${key}`);
          continue;
        }
        await writeAtomic(this.d.templates.imagePath(id, { file }), buf);
      } else warnings.push(`Şablonun görseli pakette yok: ${key} (kayıt "dosya eksik" olarak eklendi)`);
      try {
        this.d.templates.upsert(id, { ...t.record, key, file, languageId: id });
        templates++;
      } catch (err) {
        warnings.push(`Şablon kaydı geçersiz: ${key} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // Dosya özetleri ve ölçüler diskteki PNG'lerden yeniden hesaplanır.
    await this.d.templates.sync(id);

    if (pkg.draft) {
      try {
        this.d.profiles.saveDraft(id, pkg.draft, "Paketten içe aktarılan taslak");
      } catch {
        warnings.push("Paketteki taslak profil geçersiz olduğu için alınmadı.");
      }
    }
    return { language: this.d.languages.get(id), templates, fonts, warnings };
  }
}
