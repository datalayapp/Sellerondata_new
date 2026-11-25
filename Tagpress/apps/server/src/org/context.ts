import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Firma bağlamı: bir isteğin ya da arka plan görevinin hangi firma adına çalıştığı. `AsyncLocalStorage` ile taşınır;
 * servisler yalnız bunu görür (1. aşamada `LocalOrgResolver`, 2. aşamada Hesap jetonu; iş kodu değişmez).
 *
 * Kurallar:
 * - İstek: `app.ts` kancası çözücüyü çağırır, isteğin geri kalanı `runInOrg` içinde sürer.
 * - Arka plan görevi (kuyruk, zamanlayıcı, olay dinleyici) bağlamı MİRAS ALMAZ: her görev kendi kaydındaki firmayla
 *   `runInOrg(task.orgId, …)` içinde başlatılır. İsteğin içinden başlatılan mikro görev isteğin firmasını taşır; bu
 *   yalnız o firmanın işi için doğrudur.
 * - Kurulum geneli bakım (açılışta kurtarma, kalıcı temizlik, göç) `maintenance(…)` içinde çalışır: firma yoktur,
 *   `currentOrg()` hata verir, `TenantDb.maintenance` açılır.
 */
export interface OrgContext {
  readonly orgId: string;
  /** 2. aşamada jetondaki üye (`mid`); yerelde null. */
  readonly memberId: string | null;
  /** Yerelde `all`; 2. aşamada jetondaki izin adları. */
  readonly permissions: "all" | readonly string[];
  readonly locale: OrgLocale;
  readonly source: OrgSource;
}
export type OrgLocale = "tr" | "en";
/** Bağlamın kaynağı: yerel çözücü ya da Hesap servisi (2. aşama). */
export type OrgSource = "local" | "platform";

type Store = { kind: "org"; org: OrgContext } | { kind: "maintenance"; reason: string };

const storage = new AsyncLocalStorage<Store>();

/** Bağlam yok (ya da bakım kapsamında firma istendi). Programlama hatasıdır; kullanıcıya 500 olarak gider. */
export class OrgContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgContextError";
  }
}

/** Yerel (1. aşama) bağlam: izinler `all`, üye yok. */
export function localOrg(orgId: string, locale: OrgLocale = "tr"): OrgContext {
  // UUID biçimli kimlik küçük harfe (kayıttaki biçim); büyük harfli kopya başka firma sayılmasın.
  return { orgId: UUID.test(orgId) ? orgId.toLowerCase() : orgId, memberId: null, permissions: "all", locale, source: "local" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `fn`'i firma bağlamında çalıştırır (dönen söz de o bağlamda sürer). Kimlik verilirse yerel bağlam kurulur. */
export function runInOrg<T>(org: string | OrgContext, fn: () => T): T {
  const ctx = typeof org === "string" ? localOrg(org) : org;
  if (!ctx.orgId) throw new OrgContextError("runInOrg: firma kimliği boş.");
  return storage.run({ kind: "org", org: ctx }, fn);
}

/** Kurulum geneli bakım kapsamı: firma bağlamı yoktur; `TenantDb.maintenance` yalnız burada çalışır. */
export function maintenance<T>(fn: () => T, reason = "bakım"): T {
  return storage.run({ kind: "maintenance", reason }, fn);
}

/** Geçerli firma; yoksa (bağlamsız ya da bakım kapsamı) `OrgContextError`. Yeni kod bunu ya da `TenantDb`'yi kullanır. */
export function currentOrg(): OrgContext {
  const s = storage.getStore();
  if (s?.kind === "org") return s.org;
  throw new OrgContextError(s?.kind === "maintenance" ? `Bakım kapsamında (${s.reason}) firma bağlamı yok.` : "Firma bağlamı yok (runInOrg dışında).");
}

/** Geçerli firma ya da null (hata vermez). */
export function maybeOrg(): OrgContext | null {
  const s = storage.getStore();
  return s?.kind === "org" ? s.org : null;
}

export function inMaintenance(): boolean {
  return storage.getStore()?.kind === "maintenance";
}

/**
 * Arka plan işlerinin firma kapısı (platform kipi): kapalı ya da kalıcı silinen firmanın işi başlatılmaz (kuyruk seçimi,
 * bellek içi adil sıra). Platform kipinde `PlatformOrgService` kurar (açılış, kapanışta kaldırır); yerel kipte yoktur ve her
 * firma açık sayılır. İstekler bu kapıdan geçmez: kapalı firmanın isteği auth-kit'te 409 `ORG_CLOSED` alır.
 * Kapı üç değerlidir: `true` açık, `false` kapalı, `null` bu kapı firmayı (henüz) bilmiyor.
 */
type OrgGate = (orgId: string) => boolean | null;
/**
 * Kurulu kapılar (süreçte birden çok uygulama olabilir: testler). Firma: bir kapı kapalı derse kapalı; hiçbiri kapalı
 * demiyor ve en az biri açık diyorsa açık; hiçbir kapı bilmiyorsa KAPALI (durumu okunmamış firmanın işi başlamaz, R1).
 */
const orgGates = new Set<OrgGate>();

/** Kapıyı ekler; dönen işlev yalnız onu kaldırır. */
export function setOrgGate(gate: OrgGate): () => void {
  const own: OrgGate = (orgId) => gate(orgId);
  orgGates.add(own);
  return () => {
    orgGates.delete(own);
  };
}

/** Firmanın arka plan işi başlayabilir mi (kapı yoksa her zaman evet; kapılar varsa ve hiçbiri bilmiyorsa hayır). */
export function isOrgOpen(orgId: string): boolean {
  if (!orgGates.size) return true;
  let open = false;
  for (const gate of orgGates) {
    const v = gate(orgId);
    if (v === false) return false;
    if (v === true) open = true;
  }
  return open;
}

/** Bağlamı (firma ya da bakım) koruyarak sonradan çağrılacak işlev (ör. olay dinleyicisine verilen geri çağırma). */
export function bindContext<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return AsyncLocalStorage.bind(fn);
}
