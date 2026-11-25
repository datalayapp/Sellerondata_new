import path from "node:path";
import { fileURLToPath } from "node:url";
import { tagpressEnv } from "@tagpress/domain/env";
import type { TenancyMode } from "./org/tenancy.ts";
import { fail } from "./util/errors.ts";

/** Proje kökü (apps/server/src → ../../..). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Kimlik kipi (`TAGPRESS_AUTH`, plan §S2):
 * - `platform` (varsayılan): SellerOnData Hesap jetonu (auth-kit), firma bağlamı jetondan, izinler kayıttan, veritabanı
 *   Postgres (`DATABASE_URL`). Gerekli değişken yoksa sunucu açılmaz (`platformConfigProblems`).
 * - `local`: girişsiz tek kurulum (SQLite, `LocalOrgResolver`, Host/köken/`X-Studio` güvenliği). `pnpm dev`, `pnpm start`
 *   ve testler bunu kendisi verir.
 */
export type AuthMode = "platform" | "local";

/** Platform kipinin kimlik ayarları (yerel kipte kullanılmaz). */
export interface PlatformConfig {
  /** Hesap servisinin açık anahtarları (`ACCOUNT_JWKS_URL`). */
  jwksUrl: string;
  /** Çerezli yazmada kabul edilen kökenler (`ALLOWED_ORIGINS`, virgülle; Hesap'la aynı liste). */
  allowedOrigins: string[];
  /** `SOD_ENV=production`: üretim kuralları (sağlayıcı anahtarı ortamda olamaz). */
  production: boolean;
  /** Yapay zekâ geçidi (`AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN`); boşsa platform kipinde yapay zekâ kapalı. */
  aiGateway: { url: string; token: string } | null;
}

export interface AppConfig {
  root: string;
  /** Kimlik kipi (`TAGPRESS_AUTH`). */
  auth: AuthMode;
  /** Postgres bağlantısı (`DATABASE_URL`, uygulama rolü `sod_tagpress`); platform kipinde zorunlu. */
  databaseUrl: string | null;
  /** Platform kipinin kimlik ayarları; değişkenler eksikse null (`platformConfigProblems` açılışı durdurur). */
  platform: PlatformConfig | null;
  dataDir: string;
  port: number;
  /** Geliştirme: Vite (5421) kökenine de izin verilir. */
  dev: boolean;
  /** Derlenmiş web arayüzü klasörü (varsa `/` altında sunulur). */
  webDist: string;
  /** Firma kapsamı kipi (`TAGPRESS_TENANCY`): `strict` (varsayılan) ya da yalnız açıkça `audit` (teşhis; açılışta uyarı). */
  tenancy: TenancyMode;
  /** Yerel çözücünün firması (`TAGPRESS_ORG`); yoksa kurulumun varsayılan firması. */
  org: string | null;
  /**
   * Açılışta firmanın `aktarim/` klasöründeki eski sistem paketlerini içe al (`TAGPRESS_BOOTSTRAP=1`). Varsayılan kapalı:
   * ürünle paket gelmez; sahibin kurulumunda paket zaten alınmıştır (`imported:<dil>` işareti).
   */
  bootstrapPackages: boolean;
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** `TAGPRESS_AUTH`: yalnız `platform` ya da `local`; boşsa `platform`. Başka değer açılışı durdurur (yanlış yazım yerel kipe düşmesin). */
export function authModeFromEnv(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = env.TAGPRESS_AUTH?.trim().toLowerCase();
  if (!raw || raw === "platform") return "platform";
  if (raw === "local") return "local";
  throw new Error(`TAGPRESS_AUTH yalnız "platform" ya da "local" olabilir (verilen: ${JSON.stringify(env.TAGPRESS_AUTH).slice(0, 40)}).`);
}

/** Ortamdan platform ayarları; zorunlu değişken eksikse null. */
export function platformConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformConfig | null {
  const jwksUrl = env.ACCOUNT_JWKS_URL?.trim();
  const allowedOrigins = list(env.ALLOWED_ORIGINS);
  if (!jwksUrl || !allowedOrigins.length) return null;
  const url = env.AI_GATEWAY_URL?.trim();
  const token = env.AI_GATEWAY_TOKEN?.trim();
  return { jwksUrl, allowedOrigins, production: env.SOD_ENV?.trim() === "production", aiGateway: url && token ? { url, token } : null };
}

/**
 * Platform kipinde açılışı durduran sorunlar (boşsa açılır). Eksik değişkenler ve üretimde ortamda duran sağlayıcı anahtarı
 * (platform kipinde yapay zekâ yalnız geçitten; §S2).
 */
export function platformConfigProblems(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (config.auth !== "platform") return [];
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.platform?.jwksUrl) missing.push("ACCOUNT_JWKS_URL");
  if (!config.platform?.allowedOrigins.length) missing.push("ALLOWED_ORIGINS");
  const problems = missing.length ? [`Platform kipi için eksik ortam değişkeni: ${missing.join(", ")}. Yerel kip için TAGPRESS_AUTH=local.`] : [];
  if (config.platform?.production) {
    const keys = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"].filter((k) => env[k]?.trim());
    if (keys.length) problems.push(`Üretimde sağlayıcı anahtarı ortamda olamaz (${keys.join(", ")}); yapay zekâ yalnız geçitten (AI_GATEWAY_URL).`);
  }
  return problems;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = overrides.root ?? PROJECT_ROOT;
  const envDir = tagpressEnv("DATA_DIR")?.trim();
  const auth = overrides.auth ?? authModeFromEnv();
  return {
    root,
    auth,
    databaseUrl: process.env.DATABASE_URL?.trim() || null,
    platform: platformConfigFromEnv(),
    dataDir: envDir ? path.resolve(envDir) : path.join(root, "data"),
    port: Number(process.env.PORT ?? (auth === "platform" ? 4200 : 5420)),
    dev: process.env.NODE_ENV !== "production",
    webDist: path.join(root, "apps/web/dist"),
    tenancy: process.env.TAGPRESS_TENANCY?.trim() === "audit" ? "audit" : "strict",
    org: process.env.TAGPRESS_ORG?.trim() || null,
    bootstrapPackages: tagpressEnv("BOOTSTRAP")?.trim() === "1",
    ...overrides,
  };
}

/**
 * Veri klasörünün alt yolları (PLAN.md'deki düzen). Kurulum düzeyindekiler (`db`, `sharedFonts`, `backups`, `orgs`)
 * veri klasörüne, geri kalanı GEÇERLİ FİRMANIN köküne göre çözülür (`root`, her erişimde; firma bağlamı yoksa hata). Kayıtlardaki göreli yollar (`ref.image = "referanslar/…"`,
 * `variants.preview_file`) firma köküne göredir; dosya düzeni değişse de yeniden yazılmaz.
 */
export interface DataPaths {
  /** Kurulum: veritabanı. */
  readonly db: string;
  /** Kurulum: açık lisanslı yedek fontlar (bütün firmalar). */
  readonly sharedFonts: string;
  /** Kurulum: yedekler (göç öncesi yedek dahil). */
  readonly backups: string;
  /** Kurulum: firma klasörlerinin kökü (`firmalar/`, dosya düzeni 2). */
  readonly orgs: string;
  /** Geçerli firmanın kökü. */
  readonly root: string;
  language(id: string): string;
  templates(id: string): string;
  fonts(id: string): string;
  readonly previews: string;
  references(id: string): string;
  /** Aktarım paketleri (yalnız bu firmanın; sahibe özgü otomatik yükleme). */
  readonly migration: string;
  /** Baskı çıktıları. */
  readonly prints: string;
  /** Tasarım dili oluşturma oturumlarının dosyaları (C adımı). */
  readonly designSessions: string;
  /** Şablon dosyası yedekleri (üzerine yazmadan önce; firmanın kökünde `yedek/sablonlar/<dil>`). */
  templateBackups(id: string): string;
}

/**
 * Yola giren kimlik (dil kimliği) tek klasör adı olmalı: ayraç, `..`, noktayla başlayan ad yok. Dosya düzeni 1'de
 * sahibin kökü veri klasörüdür ve başka firmaların kökü (`firmalar/`) onun içindedir: kimlikle oraya inilmesin.
 * Geçersiz kimlik "bulunamadı" (404) sayılır.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function seg(id: string): string {
  if (typeof id !== "string" || !SEGMENT.test(id)) throw fail("language-not-found");
  return id;
}

/** Firma kökü bir işlevden okunan yollar (`OrgRoots.current`). */
export function orgDataPaths(dataDir: string, root: () => string): DataPaths {
  return {
    db: path.join(dataDir, "studio.db"),
    sharedFonts: path.join(dataDir, "ortak", "fontlar"),
    backups: path.join(dataDir, "yedek"),
    orgs: path.join(dataDir, "firmalar"),
    get root() {
      return root();
    },
    language: (id) => path.join(root(), "diller", seg(id)),
    templates: (id) => path.join(root(), "diller", seg(id), "sablonlar"),
    fonts: (id) => path.join(root(), "diller", seg(id), "fontlar"),
    get previews() {
      return path.join(root(), "onizleme");
    },
    references: (id) => path.join(root(), "referanslar", seg(id)),
    get migration() {
      return path.join(root(), "aktarim");
    },
    get prints() {
      return path.join(root(), "baski");
    },
    get designSessions() {
      return path.join(root(), "tasarim-oturumlari");
    },
    // Düzen 1'de sahibin kökü veri klasörü olduğundan sahibin yedekleri bugünkü yerinde (`data/yedek/sablonlar`).
    templateBackups: (id) => path.join(root(), "yedek", "sablonlar", seg(id)),
  };
}

/** Eski (tek firmalı, dosya düzeni 1) yollar: firma kökü veri klasörünün kendisi. Betikler ve taşıma için. */
export function dataPaths(dataDir: string): DataPaths {
  return orgDataPaths(dataDir, () => dataDir);
}
