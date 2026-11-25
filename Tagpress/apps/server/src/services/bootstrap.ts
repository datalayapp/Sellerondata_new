import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ReferenceSchema } from "@tagpress/domain";
import { z } from "zod";
import type { DataPaths } from "../config.ts";
import { errorMessage } from "../util/errors.ts";
import type { LanguageService } from "./languages.ts";
import type { ReferenceService } from "./references.ts";
import type { SettingsService } from "./settings.ts";
import type { TemplateService } from "./templates.ts";

/**
 * Eski sistemden aktarılmış paket (aktarım aracı kaldırıldı; biçim korunur): `<firma kökü>/aktarim/<dilId>/paket.json`.
 * Şablon/font dosyaları aktarımda zaten `<firma kökü>/diller/<dilId>/` altına kopyalanır; pakette `sablonlar/` klasörü
 * varsa oradan da alınır. Yalnız geçerli firmanın klasörüne bakılır; açılışta yalnız `config.bootstrapPackages`
 * (`TAGPRESS_BOOTSTRAP=1`) açıksa çağrılır.
 */
const PackageSchema = z.object({
  language: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), name: z.string().min(1) }),
  profile: z.unknown(),
  templates: z.array(z.record(z.string(), z.unknown())).default([]),
  createdAt: z.string().optional(),
});

export interface BootstrapResult {
  imported: { languageId: string; templates: number; references: number; warnings: string[] }[];
  errors: string[];
}

interface Deps {
  paths: DataPaths;
  languages: LanguageService;
  templates: TemplateService;
  references: ReferenceService;
  settings: SettingsService;
}

/** İlk açılış: geçerli firmada paketi olan ama veritabanında olmayan (ve daha önce içe alınmamış) dilleri içe alır. */
export async function importMigrationPackages(d: Deps): Promise<BootstrapResult> {
  const result: BootstrapResult = { imported: [], errors: [] };
  const root = d.paths.migration;
  if (!existsSync(root)) return result;
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const base = path.join(root, dir.name);
    const file = path.join(base, "paket.json");
    if (!existsSync(file)) continue;
    try {
      const pkg = PackageSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      const id = pkg.language.id;
      // Silinmiş dil de "var" sayılır: kullanıcı sildiyse yeniden içe alınmaz.
      if (d.languages.exists(id, true) || d.settings.getValue(`imported:${id}`, null)) continue;
      result.imported.push(await importOne(d, base, pkg));
      d.settings.setValue(`imported:${id}`, { at: new Date().toISOString(), from: file });
    } catch (err) {
      result.errors.push(`${dir.name}: ${errorMessage(err)}`);
    }
  }
  return result;
}

async function importOne(d: Deps, base: string, pkg: z.infer<typeof PackageSchema>) {
  const warnings: string[] = [];
  // Kimlik paketten gelir (sahibin aktarım paketi: güvenilir yol); başka bir firmada doluysa dil yeni kimlik alır
  // (aşağıdaki her şey ona yazılır).
  const id = d.languages.createWithTrustedId({ id: pkg.language.id, name: pkg.language.name, profile: pkg.profile, note: "Eski sistemden aktarıldı" }).id;

  const tplDir = d.paths.templates(id);
  await mkdir(tplDir, { recursive: true });
  const srcTpl = path.join(base, "sablonlar");
  if (existsSync(srcTpl)) {
    for (const f of readdirSync(srcTpl)) if (!existsSync(path.join(tplDir, f))) await copyFile(path.join(srcTpl, f), path.join(tplDir, f));
  }
  const srcFonts = path.join(base, "fontlar");
  if (existsSync(srcFonts)) {
    await mkdir(d.paths.fonts(id), { recursive: true });
    for (const f of readdirSync(srcFonts)) if (!existsSync(path.join(d.paths.fonts(id), f))) await copyFile(path.join(srcFonts, f), path.join(d.paths.fonts(id), f));
  }
  let templates = 0;
  for (const t of pkg.templates) {
    try {
      d.templates.upsert(id, { ...t, languageId: id });
      templates++;
    } catch (err) {
      warnings.push(`Şablon ${String(t.key)}: ${errorMessage(err)}`);
    }
  }
  // Paketteki kayıtlarla klasör eşitlenir (eksik dosyalar işaretlenir; kayıt alanları korunur).
  await d.templates.sync(id);

  let references = 0;
  const refFile = path.join(base, "referanslar.json");
  if (existsSync(refFile)) {
    const list = JSON.parse(readFileSync(refFile, "utf8")) as unknown[];
    for (const r of Array.isArray(list) ? list : []) {
      const parsed = ReferenceSchema.safeParse({ ...(r as object), languageId: id });
      if (parsed.success) {
        d.references.save(parsed.data);
        references++;
      } else warnings.push(`Referans atlandı: ${parsed.error.issues[0]?.message ?? "geçersiz"}`);
    }
  }
  return { languageId: id, templates, references, warnings };
}
