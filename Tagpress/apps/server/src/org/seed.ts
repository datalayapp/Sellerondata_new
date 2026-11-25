import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LANGUAGE_NAME, defaultProfile } from "@tagpress/domain";
import { z } from "zod";
import { type DataPaths, PROJECT_ROOT, orgDataPaths } from "../config.ts";
import { EventBus } from "../events.ts";
import { LanguageService } from "../services/languages.ts";
import { ProfileService } from "../services/profiles.ts";
import { SettingsService } from "../services/settings.ts";
import { TemplateService } from "../services/templates.ts";
import type { Clock } from "../util/clock.ts";
import { pngSize, sha1 } from "../util/files.ts";
import { PNG, safeJoin } from "../util/safe-path.ts";
import { runInOrg } from "./context.ts";
import type { OrgSeed } from "./service.ts";
import type { TenantDb } from "./tenant-db.ts";

/**
 * Ürünle gelen varsayılan içerik (SUNUCU-PLANI §2.8): yeni firma boş ama kullanılabilir başlar.
 * - Varsayılan tasarım dili v1 YAYINLANMIŞ (`defaultProfile()`: şema varsayılanları + ürünle gelen fontlar) ve
 *   firmanın varsayılan dili; şablonları kayıtlı (dosya özeti ve ölçüsü diskteki PNG'den), fontları ve lisansları
 *   dilin font klasöründe.
 * - Kaynak `assets/varsayilan/` (depoda): fontlar (OFL) + `fontlar.json`, şablonlar (CC0, betikle üretilir) +
 *   `sablonlar.json`. Hiçbir firmanın verisi buraya girmez (`seed.test.ts` sahibin `data/` klasörüyle karşılaştırır).
 * - YALNIZ hiç dili olmayan (silinmiş dil de sayılır) firmada çalışır; ikinci çağrı hiçbir şey yapmaz. Sahibin
 *   firması (dili var) hiç etkilenmez.
 * - Veritabanı yazıları tek işlemde; bir adım düşerse işlem geri alınır ve yeni dilin klasörü silinir.
 */

/** Depodaki varsayılan içerik klasörü. */
export const DEFAULT_CONTENT_DIR = path.join(PROJECT_ROOT, "assets", "varsayilan");

const FontManifestSchema = z.object({
  fontlar: z
    .array(
      z.object({
        file: z.string().min(1),
        family: z.string().min(1),
        license: z.enum(["OFL-1.1", "Apache-2.0"]),
        licenseFile: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

const TemplateManifestSchema = z.object({
  // Kaydın geri kalanı (alan, kurdele payı, not …) şablon şemasıyla `TemplateService.upsert` içinde doğrulanır.
  sablonlar: z.array(z.object({ key: z.string().min(1), file: z.string().min(1) }).loose()).min(1),
});

export type FontManifest = z.infer<typeof FontManifestSchema>;
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export function readFontManifest(contentDir = DEFAULT_CONTENT_DIR): FontManifest {
  return FontManifestSchema.parse(JSON.parse(readFileSync(path.join(contentDir, "fontlar", "fontlar.json"), "utf8")));
}

export function readTemplateManifest(contentDir = DEFAULT_CONTENT_DIR): TemplateManifest {
  return TemplateManifestSchema.parse(JSON.parse(readFileSync(path.join(contentDir, "sablonlar", "sablonlar.json"), "utf8")));
}

export interface SeedResult {
  languageId: string;
  templates: string[];
  fonts: string[];
}

export interface SeedServices {
  db: TenantDb;
  paths: DataPaths;
  languages: LanguageService;
  templates: TemplateService;
  /** Varsayılan: `DEFAULT_CONTENT_DIR`. */
  contentDir?: string;
}

/** Klasördeki dosyanın yolu; kaçan ya da olmayan dosya hata (içerik paketi bozuk). */
function assetFile(dir: string, rel: string, ext?: readonly string[]): string {
  const full = safeJoin(dir, rel, ext ? { ext } : {});
  if (!full || !existsSync(full)) throw new Error(`Varsayılan içerik eksik: ${path.join(dir, rel)}`);
  return full;
}

/**
 * GEÇERLİ FİRMAYA (bağlam içinde çağrılır) varsayılan içeriği kurar. Firmada dil varsa null (hiçbir şey yazılmaz).
 */
export function seedDefaultContent(d: SeedServices): SeedResult | null {
  if (d.db.prepare("SELECT 1 FROM languages WHERE org_id = $org LIMIT 1").get()) return null;
  const contentDir = d.contentDir ?? DEFAULT_CONTENT_DIR;
  const fontDir = path.join(contentDir, "fontlar");
  const tplDir = path.join(contentDir, "sablonlar");
  const profile = defaultProfile();
  const fontManifest = readFontManifest(contentDir);
  const tplManifest = readTemplateManifest(contentDir);

  // Önce paketi denetle (diske ve veritabanına bir şey yazmadan): profildeki her font pakette ve lisanslı.
  const fonts = profile.fonts.list.map((f) => {
    const entry = fontManifest.fontlar.find((m) => m.file === f.file);
    if (!f.file || !entry) throw new Error(`Varsayılan font paketin listesinde yok: ${f.file ?? f.id}`);
    return { file: assetFile(fontDir, entry.file), license: assetFile(fontDir, entry.licenseFile) };
  });
  const templates = tplManifest.sablonlar.map((t) => {
    const png = readFileSync(assetFile(tplDir, t.file, PNG));
    const size = pngSize(png);
    if (!size) throw new Error(`Varsayılan şablon PNG değil: ${t.file}`);
    return { record: t, png, size };
  });

  let languageId: string | null = null;
  try {
    return d.db.tx(() => {
      const lang = d.languages.create({ name: DEFAULT_LANGUAGE_NAME, profile, note: "Ürünle gelen varsayılan ayarlar" });
      languageId = lang.id;
      const fontTarget = d.paths.fonts(lang.id);
      mkdirSync(fontTarget, { recursive: true });
      for (const f of fonts) {
        copyFileSync(f.file, path.join(fontTarget, path.basename(f.file)));
        copyFileSync(f.license, path.join(fontTarget, path.basename(f.license)));
      }
      const tplTarget = d.paths.templates(lang.id);
      mkdirSync(tplTarget, { recursive: true });
      const keys: string[] = [];
      for (const t of templates) {
        const target = safeJoin(tplTarget, t.record.file, { ext: PNG });
        if (!target || t.record.file.includes("/")) throw new Error(`Varsayılan şablonun dosya adı geçersiz: ${t.record.file}`);
        copyFileSync(path.join(tplDir, t.record.file), target);
        // Kayıt paketten; dosya özeti ve ölçü diskteki PNG'den (açılıştaki eşitleme aynısını bulur).
        const item = d.templates.upsert(lang.id, { ...t.record, languageId: lang.id, hash: sha1(t.png), width: t.size.width, height: t.size.height });
        keys.push(item.template.key);
      }
      d.languages.setDefault(lang.id);
      return { languageId: lang.id, templates: keys, fonts: fonts.map((f) => path.basename(f.file)) };
    });
  } catch (err) {
    // Veritabanı geri alındı; yeni dilin klasörü (yalnız o) silinir.
    if (languageId) rmSync(d.paths.language(languageId), { recursive: true, force: true });
    throw err;
  }
}

export interface OrgSeederDeps {
  db: TenantDb;
  clock: Clock;
  /** Kurulumun veri klasörü (`config.dataDir`). */
  dataDir: string;
  /** Firmanın dosya kökü (`OrgRoots.rootOf`; dosya düzeni 1'de sahibin kökü veri klasörüdür). */
  rootOf: (orgId: string) => string;
  /** Olay yolu (yoksa dinleyicisiz yerel yol; kuruluşta arayüz bağlı değildir). */
  events?: EventBus;
  contentDir?: string;
}

/**
 * `OrgService`'e verilen kurucu: firma açılır açılmaz (servisler henüz kurulmamışken de) çalışır; kendi servis
 * örneklerini kurar (hepsi durumsuz, veritabanı ve dosya üstünde ince katman). Her çağrı `runInOrg(orgId)` içinde.
 */
export class OrgSeeder implements OrgSeed {
  constructor(private readonly d: OrgSeederDeps) {}

  seed(orgId: string): SeedResult | null {
    return runInOrg(orgId, () => {
      const { db, clock } = this.d;
      const paths = orgDataPaths(this.d.dataDir, () => this.d.rootOf(orgId));
      const events = this.d.events ?? new EventBus(db.tenancy);
      const settings = new SettingsService(db);
      const profiles = new ProfileService(db, events, clock);
      const languages = new LanguageService(db, paths, profiles, settings, events, clock);
      const templates = new TemplateService(db, paths, events, clock);
      return seedDefaultContent({ db, paths, languages, templates, ...(this.d.contentDir ? { contentDir: this.d.contentDir } : {}) });
    });
  }
}
