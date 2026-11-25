import type { ProductAuthContext } from "@sellerondata/auth-kit";
import { type SqlDb, isOrgClosed, readOrgProfile, withOrg } from "@sellerondata/product-kit";
import type { Org } from "@tagpress/domain";
import type { Clock } from "../util/clock.ts";
import { runInOrg, setOrgGate } from "./context.ts";
import type { OrgSeed } from "./service.ts";

/** Firma ayarı: varsayılan içerik kuruldu (`ensureSeeded`). Değer `{ at, languageId }` (aktarım aracı varsayılan içeriği tanır). */
export const SEEDED_KEY = "platform.seeded";

/** `ensureSeeded`'in gördüğü ayar yüzeyi (`SettingsService`). */
export interface SeedSettings {
  getOrg<T>(key: string, fallback: T): T;
  setOrg(key: string, value: unknown): void;
}

export interface PlatformOrgServiceDeps {
  /** Async havuz (product-kit `pgDb`): `Company` okuması. Senkron köprü bu tabloya bakmaz. */
  db: SqlDb;
  schema: string;
  /** Firma kapsamlı senkron işlem (`TenantDb.tx`): varsayılan içerik ve işareti tek işlemde. */
  tx: <T>(fn: () => T) => T;
  settings: SeedSettings;
  /** Varsayılan içerik (`OrgSeeder`; firmada dil varsa hiçbir şey yapmaz). */
  seeder: OrgSeed;
  clock: Clock;
  /** Kapalılık bilgisinin tazelenme aralığı (ms). Varsayılan 60 sn; olay alıcısından sonra hemen tazelenir. */
  refreshEveryMs?: number;
  log?: { warn: (obj: unknown, msg: string) => void };
}

interface Known {
  name: string;
  /** `null`: durumu henüz okunmadı (arka plan kapısı için kapalı; `isOpen` `null` döner). */
  closed: boolean | null;
  checkedAt: number;
}

/**
 * Platform kipinde firmalar (plan §2.6): firma kaydı product-kit `Company`'dir (Hesap'tan; JIT ve `org.*` olaylarıyla
 * product-kit yazar). TagPress'te firma adı salt okunur, firma açılmaz ve silinmez. Bu servis:
 * - `touch(auth)`: kimliği doğrulanmış her istekte firmayı tanır (ad jetondan) ve **ilk istekte** varsayılan içeriği kurar
 *   (`ensureSeeded`: idempotent, firma ayarı `platform.seeded`; JIT'in işleminde değil, çünkü senkron köprü havuzun commit
 *   edilmemiş `Company` satırını göremez).
 * - Arka plan kapısı (`setOrgGate`): kapalı ya da kalıcı silinen firmanın işi başlamaz. Bilgi bellekte, havuzdan tazelenir
 *   (aralıkla ve her olaydan sonra); istek yolunda kapalılık auth-kit'te zaten 409 `ORG_CLOSED`. Durumu henüz okunmamış
 *   firma KAPALI sayılır (R1: yeniden açılışta kapalı firmanın bekleyen görevi çalışmasın); okuma arkada başlar, bitince
 *   `onRefreshed` kancası (kuyruğu dürter) çağrılır. Açılışta görevi olan firmalar `prime` ile önceden okunur.
 * - `list()`: bu süreçte görülen firmalar (saatlik bakım turu; kurulum geneli firma listesi RLS altında okunmaz).
 */
export class PlatformOrgService {
  private readonly known = new Map<string, Known>();
  private readonly seeded = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private again = false;
  private ungate: (() => void) | null = null;
  private refreshed: (() => void) | null = null;

  constructor(private readonly d: PlatformOrgServiceDeps) {}

  /** Kapıyı ve tazeleme zamanlayıcısını kurar (açılışta). */
  start(): void {
    this.ungate ??= setOrgGate((orgId) => this.isOpen(orgId));
    if (!this.timer) {
      this.timer = setInterval(() => this.refreshSoon(), this.d.refreshEveryMs ?? 60_000);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ungate?.();
    this.ungate = null;
    // Kapanışta bekleyen tazeleme kuyruğu dürtmesin.
    this.refreshed = null;
    await this.pending;
  }

  /**
   * Kimliği doğrulanmış istek (auth-kit geçti: firma açık, üye etkin). Firmayı tanır ve gerekirse varsayılan içeriği kurar.
   * Senkron: çözücü bunu bağlamı kurmadan önce çağırır.
   */
  touch(auth: Pick<ProductAuthContext, "orgId" | "orgName">): void {
    const prev = this.known.get(auth.orgId);
    this.known.set(auth.orgId, { name: auth.orgName ?? prev?.name ?? "", closed: false, checkedAt: this.d.clock.now().getTime() });
    this.ensureSeeded(auth.orgId);
  }

  /**
   * Yeni firmanın varsayılan içeriği (dil v1, şablonlar, fontlar; `org/seed.ts`). İşaret ve içerik tek işlemde; işaret varsa
   * (içerik sonradan silinmiş olsa da) hiçbir şey yapılmaz. Bu süreçte bir kez denetlenir.
   */
  ensureSeeded(orgId: string): void {
    if (this.seeded.has(orgId)) return;
    runInOrg(orgId, () => {
      if (!this.d.settings.getOrg<unknown>(SEEDED_KEY, null)) {
        this.d.tx(() => {
          const result = this.d.seeder.seed(orgId) as { languageId?: string } | null;
          this.d.settings.setOrg(SEEDED_KEY, { at: this.d.clock.now().toISOString(), languageId: result?.languageId ?? null });
        });
      }
    });
    this.seeded.add(orgId);
  }

  /**
   * Arka plan işi başlayabilir mi: `true` açık, `false` kapalı, `null` durumu henüz okunmadı (ör. açılıştan önce sıraya
   * girmiş görev; kapı bunu kapalı sayar, `org/context.ts` `isOrgOpen`). Tanınmayan firma tanınır ve durumu arkada okunur;
   * okuma bitince `onRefreshed` (kuyruk yeniden seçer). Bilgi eskiyse arkada tazelenir.
   */
  isOpen(orgId: string): boolean | null {
    const k = this.known.get(orgId);
    if (!k) {
      this.known.set(orgId, { name: "", closed: null, checkedAt: 0 });
      this.refreshSoon();
      return null;
    }
    if (this.d.clock.now().getTime() - k.checkedAt > (this.d.refreshEveryMs ?? 60_000)) this.refreshSoon();
    return k.closed === null ? null : !k.closed;
  }

  /**
   * Açılış: bu firmaların durumunu (arka plan işleri başlamadan) okur. Tanınmayanlar "okunmadı" olarak eklenir, tek
   * tazeleme turunda gerçek durumları yazılır. Okuma başarısızsa okunmamış kalırlar (iş başlamaz; sonraki tazelemede açılır).
   */
  async prime(orgIds: readonly string[]): Promise<void> {
    let added = false;
    for (const id of orgIds) {
      if (this.known.has(id)) continue;
      this.known.set(id, { name: "", closed: null, checkedAt: 0 });
      added = true;
    }
    if (!added) return;
    this.refreshSoon();
    await this.settle();
  }

  /** Başarılı her tazelemeden sonra çağrılır (kuyruğu dürtmek için; açılan firmanın bekleyen işi sürer). */
  onRefreshed(fn: (() => void) | null): void {
    this.refreshed = fn;
  }

  /** Bu süreçte görülen açık firmalar (bakım turu). */
  list(): { id: string; name: string }[] {
    return [...this.known.entries()].filter(([, k]) => k.closed === false).map(([id, k]) => ({ id, name: k.name }));
  }

  /** API görünümü (`GET /api/org`): ad yerel `Company` kaydından (Merkez'de değişir, `org.updated`), yoksa jetondan. */
  async view(orgId: string): Promise<Org | null> {
    const profile = await withOrg(this.d.db, orgId, (tx) => readOrgProfile(tx, this.d.schema, orgId));
    const name = profile?.name || this.known.get(orgId)?.name || "";
    if (!profile && !this.known.has(orgId)) return null;
    return { id: orgId, name };
  }

  /** Olaydan sonra ya da aralıkla: bütün tanınan firmaların kapalılığı ve adı (üst üste çağrı tek tura katılır). */
  refreshSoon(): void {
    if (this.pending) {
      this.again = true;
      return;
    }
    let ok = false;
    this.pending = this.refresh()
      .then(() => {
        ok = true;
      })
      .catch((err: unknown) => this.d.log?.warn({ err }, "tagpress: firma durumu tazelenemedi"))
      .finally(() => {
        this.pending = null;
        if (this.again) {
          this.again = false;
          this.refreshSoon();
        } else if (ok) {
          // Yalnız başarılı turdan sonra (başarısız okuma kuyruğu dürtüp yeni okumayı döngüye sokmasın).
          try {
            this.refreshed?.();
          } catch (err) {
            this.d.log?.warn({ err }, "tagpress: tazeleme sonrası kanca hata verdi");
          }
        }
      });
  }

  /** Bekleyen tazelemenin bitmesi (testler). */
  async settle(): Promise<void> {
    while (this.pending) await this.pending;
  }

  /** Kalıcı silinen firma: bellekteki izleri (yeniden tanınırsa kapalı görünür; Hesap artık jeton basmaz). */
  forget(orgId: string): void {
    this.seeded.delete(orgId);
    this.known.set(orgId, { name: "", closed: true, checkedAt: this.d.clock.now().getTime() });
  }

  private async refresh(): Promise<void> {
    for (const orgId of [...this.known.keys()]) {
      const state = await withOrg(this.d.db, orgId, async (tx) => ({
        closed: await isOrgClosed(tx, this.d.schema, orgId),
        profile: await readOrgProfile(tx, this.d.schema, orgId),
      }));
      const prev = this.known.get(orgId);
      this.known.set(orgId, { name: state.profile?.name || prev?.name || "", closed: state.closed, checkedAt: this.d.clock.now().getTime() });
    }
  }
}
