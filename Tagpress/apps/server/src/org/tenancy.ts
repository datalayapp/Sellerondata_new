import { type OrgContext, OrgContextError, inMaintenance, maybeOrg } from "./context.ts";

/**
 * Firma kapsamının kipi:
 * - `strict` (sıkı, varsayılan): bakım bağlantısı (`TenantDb.maintenance`, `ctx.maintenanceDb`) yalnız `maintenance(…)`
 *   içinde çalışır; dışında hata.
 * - `audit` (denetim; yalnız `TAGPRESS_TENANCY=audit` ile, açılışta uyarı verir): bakım bağlantısının `maintenance(…)`
 *   dışındaki kullanımı hata vermez, sayılır (`tenancy.audit`, tür `raw-sql`). Geçici teşhis içindir.
 * İki kipte de: `TenantDb` kapsamsız SQL'i reddeder, firma bağlamı olmayan çağrı hata verir (varsayılan firmaya düşülmez)
 * ve bakım kapsamında firma bağlamı okunmaz.
 */
export type TenancyMode = "audit" | "strict";

export type AuditKind =
  /** Bakım bağlantısı bakım kapsamı dışında kullanıldı (yalnız denetim kipinde sayılır; sıkı kipte hata). */
  | "raw-sql"
  /** Firma bağlamı olmadan yayınlanan olay üretimde düştü. */
  | "no-context";

export interface AuditEntry {
  kind: AuditKind;
  /** SQL'in ilk satırı (boşluklar sıkıştırılmış, 160 karakter) ya da çağrı yeri (`events.emit` …). */
  site: string;
  count: number;
}

/** Kapsam dışı erişim sayacı (denetim kipi ve üretimde düşen olaylar). */
export class TenancyAudit {
  private readonly entries = new Map<string, AuditEntry>();
  private n = 0;

  record(kind: AuditKind, site: string): void {
    this.n++;
    const id = `${kind}\u0000${site}`;
    const e = this.entries.get(id);
    if (e) e.count++;
    else if (this.entries.size < 2000) this.entries.set(id, { kind, site, count: 1 });
  }

  get total(): number {
    return this.n;
  }

  /** Çoktan aza. */
  list(kind?: AuditKind): AuditEntry[] {
    return [...this.entries.values()].filter((e) => !kind || e.kind === kind).sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
  }

  reset(): void {
    this.entries.clear();
    this.n = 0;
  }
}

export interface TenancyOptions {
  mode: TenancyMode;
}

/** Bir uygulama bağlamının (createContext) firma kapsamı ayarı: kip ve sayaç. */
export class Tenancy {
  readonly audit = new TenancyAudit();

  constructor(private readonly opts: TenancyOptions = { mode: "strict" }) {}

  get mode(): TenancyMode {
    return this.opts.mode;
  }

  get strict(): boolean {
    return this.opts.mode === "strict";
  }

  /**
   * Geçerli firma. Bağlam yoksa ya da bakım kapsamındaysa HER kipte `OrgContextError` (varsayılan firmaya düşülmez):
   * bakımda işi kaydın firmasıyla `runInOrg` açar. `site`: hata iletisinde görünecek çağrı yeri.
   */
  current(site: string): OrgContext {
    const org = maybeOrg();
    if (org) return org;
    if (inMaintenance()) throw new OrgContextError(`Firma bağlamı okunmaz (bakım kapsamı): ${site}; kaydın firmasıyla runInOrg açın.`);
    throw new OrgContextError(`Firma bağlamı yok: ${site}.`);
  }

  orgId(site: string): string {
    return this.current(site).orgId;
  }
}
