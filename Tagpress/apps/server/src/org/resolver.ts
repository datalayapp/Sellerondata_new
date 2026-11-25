import type { FastifyRequest } from "fastify";
import type { ProductAuthContext } from "@sellerondata/auth-kit";
import { type OrgContext, OrgContextError, type OrgLocale, localOrg } from "./context.ts";
import type { PlatformOrgService } from "./platform-service.ts";
import { isUuid } from "../util/ids.ts";
import type { OrgService } from "./service.ts";

/**
 * İsteğin firmasını bulur. `app.ts` `onRequest` kancası çağırır; isteğin geri kalanı `runInOrg` içinde sürer.
 * Servisler çözücüyü görmez, yalnız `OrgContext`'i (aşama değişince iş kodu değişmez).
 */
export interface OrgResolver {
  resolve(req: FastifyRequest): OrgContext | Promise<OrgContext>;
}

/** `Accept-Language`'in ilk dili (tr, en); yoksa İngilizce (platform kuralı: kayıtlı tercih yoksa tarayıcı dili). */
export function requestLocale(req: Pick<FastifyRequest, "headers">): OrgLocale {
  const first = String(req.headers["accept-language"] ?? "")
    .split(",")[0]!
    .trim()
    .toLowerCase();
  return first.startsWith("tr") ? "tr" : "en";
}

/**
 * 1. aşama: tek yerel firma. Firma `TAGPRESS_ORG`'dan (`config.org`), yoksa kurulumun `install.defaultOrgId`'sinden;
 * izinler `all`. Firma değiştirme ucu yok; ikinci firmayı denemek için `pnpm firma ekle` (A3) ve `TAGPRESS_ORG=<id>`
 * ile 5499'da açılış. Firma açılışta doğrulanır (`assertUsable`); bilinmeyen ya da kapatılmış firmayla sunucu açılmaz.
 */
export class LocalOrgResolver implements OrgResolver {
  constructor(
    private readonly orgs: OrgService,
    private readonly configured: string | null,
  ) {}

  get orgId(): string {
    const raw = this.configured ?? this.orgs.defaultOrgId();
    // UUID biçimli kimlik küçük harfe (kayıttaki biçim).
    const id = raw && isUuid(raw) ? raw.toLowerCase() : raw;
    if (!id) throw new Error("Kurulumda varsayılan firma yok (OrgService.ensureLocal çağrılmadı).");
    return id;
  }

  /** Açılışta: firma var ve açık mı. */
  assertUsable(): void {
    const id = this.orgId;
    const org = this.orgs.get(id);
    if (!org) throw new Error(`TAGPRESS_ORG bilinmeyen firma: ${id}`);
    if (org.closedAt) throw new Error(`Firma kapatılmış: ${id}`);
  }

  resolve(req: FastifyRequest): OrgContext {
    return localOrg(this.orgId, requestLocale(req));
  }
}

/**
 * Platform kipi (`TAGPRESS_AUTH=platform`, plan §S6): firma bağlamı Hesap jetonundan. Jetonu auth-kit doğrular (uç kapısı
 * `features/gate.ts` `registerPermissionGate`: jeton, CSRF/köken/`X-SOD-Org`, kapalı firma 409 `ORG_CLOSED`, ürün erişimi,
 * izin, `READ_ONLY`); bu çözücü ancak ondan sonra çağrılır ve `req.auth`'tan bağlamı kurar. Firma kaydı product-kit
 * `Company`'dir (JIT); ilk istekte varsayılan içerik kurulur (`PlatformOrgService.touch`).
 * `OrgContext = { orgId: auth.orgId, memberId: auth.membershipId, permissions: auth.permissions, locale, source: 'platform' }`.
 */
export class PlatformOrgResolver implements OrgResolver {
  constructor(private readonly orgs: Pick<PlatformOrgService, "touch">) {}

  resolve(req: FastifyRequest): OrgContext {
    const auth = (req as { auth?: ProductAuthContext | null }).auth;
    // Kimliksiz istek buraya gelmez (kapı önce yanıtlar); gelirse programlama hatasıdır, varsayılan firmaya düşülmez.
    if (!auth?.orgId) throw new OrgContextError("PlatformOrgResolver: istek kimliksiz (uç kapısı çalışmadı).");
    this.orgs.touch(auth);
    const locale: OrgLocale = auth.locale === "tr" || auth.locale === "en" ? auth.locale : requestLocale(req);
    return { orgId: auth.orgId, memberId: auth.membershipId, permissions: auth.permissions, locale, source: "platform" };
  }
}
