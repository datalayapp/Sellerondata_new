import type { Org } from "@tagpress/domain";
import type { Clock } from "../util/clock.ts";
import { normalizeOrgId, uuidv7 } from "../util/ids.ts";
import { INSTALL_KEYS } from "./tables.ts";
import type { TenantDb } from "./tenant-db.ts";

export type OrgSourceKind = "local" | "account";

export interface OrgRecord {
  id: string;
  name: string;
  source: OrgSourceKind;
  createdAt: string;
  closedAt: string | null;
  purgedAt: string | null;
}

type OrgRow = { id: string; name: string; source: OrgSourceKind; created_at: string; closed_at: string | null; purged_at: string | null };

const toRecord = (r: OrgRow): OrgRecord => ({ id: r.id, name: r.name, source: r.source, createdAt: r.created_at, closedAt: r.closed_at, purgedAt: r.purged_at });

/** Yeni yerel firmanın adı (sahip adı koda yazılmaz; `PATCH /api/org` ile verilir). */
export const DEFAULT_ORG_NAME = "Firmam";

/** Yeni firmaya varsayılan içeriği kuran (`org/seed.ts` `OrgSeeder`). Firmada dil varsa hiçbir şey yapmaz. */
export interface OrgSeed {
  seed(orgId: string): unknown;
}

/**
 * Firmalar (`orgs`, kurulum tablosu). Firma açmak, yeniden adlandırmak ve kurulumun varsayılan/sahip firmasını
 * okumak buradadır. Firmanın kendi verisine dokunmaz (kalıcı silme A3'ün betiğinde, `TENANT_TABLES` sırasıyla).
 */
export class OrgService {
  constructor(
    private readonly db: TenantDb,
    private readonly clock: Clock,
    /** Varsayılan/sahip firma değişince (dosya kökleri yeniden okunur). */
    private readonly onInstallChange: () => void = () => undefined,
    /** Varsayılan içerik (A5). Verilmezse yeni firma boş açılır (testlerin çoğu böyle kurar). */
    private readonly seeder: OrgSeed | null = null,
  ) {}

  list(): OrgRecord[] {
    return (this.db.install.prepare("SELECT * FROM orgs ORDER BY created_at, id").all() as OrgRow[]).map(toRecord);
  }

  get(id: string): OrgRecord | null {
    const r = this.db.install.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow | undefined;
    return r ? toRecord(r) : null;
  }

  /**
   * Yeni firma (kimlik verilmezse UUIDv7) ve varsayılan içeriği (`seeder`: dil v1, şablon, font; `org/seed.ts`).
   * İkisi tek işlemde: içerik kurulamazsa firma da açılmaz. `seed: false` yalnız `ensureLocal` için (kökler önce).
   */
  create(input: { name: string; source?: OrgSourceKind; id?: string }, opts: { seed?: boolean } = {}): OrgRecord {
    const id = input.id === undefined ? uuidv7(this.clock.now().getTime()) : normalizeOrgId(input.id);
    return this.db.install.tx(() => {
      this.db.install
        .prepare("INSERT INTO orgs (id, name, source, created_at) VALUES (?, ?, ?, ?)")
        .run(id, input.name.trim() || DEFAULT_ORG_NAME, input.source ?? "local", this.clock.now().toISOString());
      if (opts.seed !== false) this.seeder?.seed(id);
      return this.get(id)!;
    });
  }

  rename(id: string, name: string): OrgRecord | null {
    this.db.install.prepare("UPDATE orgs SET name = ? WHERE id = ?").run(name.trim(), id);
    return this.get(id);
  }

  defaultOrgId(): string | null {
    return this.installValue(INSTALL_KEYS.defaultOrgId);
  }

  ownerOrgId(): string | null {
    return this.installValue(INSTALL_KEYS.ownerOrgId);
  }

  /**
   * İlk açılış: kurulumda varsayılan firma yoksa "Firmam"ı açar; varsayılan ve (henüz yoksa) eski kökün sahibi yapar
   * (`install.ownerOrgId`: dosya düzeni 1'de veri klasörünün kökü bu firmanındır; varsayılan sonradan değişse de
   * kaymaz). Göç 9 veri varsa ikisini zaten yazmıştır. Varsayılan içerik `seeder` verilmişse aynı işlemde kurulur
   * (A5); kurulum durumu B2'nin işi.
   */
  ensureLocal(): { org: OrgRecord; created: boolean } {
    const existing = this.defaultOrgId();
    const found = existing ? this.get(existing) : null;
    if (found) return { org: found, created: false };
    if (existing) throw new Error(`Kurulumun varsayılan firması (${existing}) orgs tablosunda yok.`);
    const org = this.db.install.tx(() => {
      const o = this.create({ name: DEFAULT_ORG_NAME, source: "local" }, { seed: false });
      this.setInstallValue(INSTALL_KEYS.defaultOrgId, o.id);
      if (!this.ownerOrgId()) this.setInstallValue(INSTALL_KEYS.ownerOrgId, o.id);
      if (this.seeder) {
        // Varsayılan içerik aynı işlemde, kökler yeni sahibi gördükten sonra (düzen 1'de sahibin kökü veri klasörü).
        this.onInstallChange();
        this.seeder.seed(o.id);
      }
      return o;
    });
    this.onInstallChange();
    return { org, created: true };
  }

  /** API görünümü. */
  view(id: string): Org | null {
    const o = this.get(id);
    return o ? { id: o.id, name: o.name } : null;
  }

  private installValue(key: string): string | null {
    const r = this.db.install.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value) as unknown;
      return typeof v === "string" && v ? v : null;
    } catch {
      return null;
    }
  }

  private setInstallValue(key: string, value: string): void {
    this.db.install.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}
