import path from "node:path";
import { safeJoin } from "../util/safe-path.ts";
import { INSTALL_KEYS } from "./tables.ts";
import type { Tenancy } from "./tenancy.ts";

/** Dosya düzeni: 1 (işaret yok) = sahibin dosyaları veri klasörünün kökünde; 2 = her firma `firmalar/<orgId>/` altında. */
export const ORG_FILE_LAYOUT = 2;

/**
 * Firma kimliği klasör adı olarak: UUID (büyük-küçük harf duyarsız, klasör adı küçük harf) ya da küçük harfli eski
 * kısa çizgili ad. Windows'a ayrılmış adlar (CON, NUL, COM1 …) kabul edilmez.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function orgDirName(orgId: string): string | null {
  if (UUID.test(orgId)) return orgId.toLowerCase();
  return ORG_DIR.test(orgId) && !WINDOWS_RESERVED.test(orgId) ? orgId : null;
}

/** Kurulum ayarlarından okunanlar (SettingsService.install*). */
export interface RootSettings {
  getInstall<T>(key: string, fallback: T): T;
}

/**
 * Firmaların dosya kökleri. Dosya düzeni (`files.layout`) ve eski köke sahip firma ilk istekte okunur, `reload()`
 * ile yenilenir (A3'ün taşıması bittikten sonra çağrılır).
 * - Düzen 2: her firma `<veri>/firmalar/<orgId>`.
 * - Düzen 1 (bugün, A3'ten önce): eski kökün sahibi (`install.ownerOrgId`, yoksa `install.defaultOrgId`) için
 *   `<veri>` (bugünkü düzen olduğu gibi çalışır); başka her firma yine `<veri>/firmalar/<orgId>`.
 */
export class OrgRoots {
  private state: { layout: number; legacyOwner: string | null } | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly settings: RootSettings,
    private readonly tenancy: Tenancy,
  ) {}

  get layout(): number {
    return this.load().layout;
  }

  /** Bu firmanın kökü. Kimlik klasör adı olamayacak biçimdeyse hata (yol kaçışı yok). */
  rootOf(orgId: string): string {
    const name = orgDirName(orgId);
    if (!name) throw new Error(`Geçersiz firma kimliği (klasör adı olamaz): ${JSON.stringify(orgId).slice(0, 80)}`);
    const s = this.load();
    if (s.layout < ORG_FILE_LAYOUT && s.legacyOwner && name === s.legacyOwner.toLowerCase()) return this.dataDir;
    const dir = safeJoin(path.join(this.dataDir, "firmalar"), name);
    if (!dir) throw new Error(`Firma klasörü veri klasörünün dışına çıkıyor: ${orgId}`);
    return dir;
  }

  /** Geçerli firmanın kökü (firma bağlamı yoksa hata). */
  current(site = "paths"): string {
    return this.rootOf(this.tenancy.orgId(site));
  }

  reload(): void {
    this.state = null;
  }

  private load(): { layout: number; legacyOwner: string | null } {
    if (!this.state) {
      const layout = Number(this.settings.getInstall<number | null>(INSTALL_KEYS.fileLayout, null) ?? 1);
      const legacyOwner =
        this.settings.getInstall<string | null>(INSTALL_KEYS.ownerOrgId, null) ?? this.settings.getInstall<string | null>(INSTALL_KEYS.defaultOrgId, null);
      this.state = { layout: Number.isFinite(layout) ? layout : 1, legacyOwner };
    }
    return this.state;
  }
}
