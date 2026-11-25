import { AsyncLocalStorage } from "node:async_hooks";
import type { GatewayCall, GatewayOptions } from "@tagpress/ai";
import { AI_GATEWAY_KEY_HEADERS, AI_GATEWAY_PATHS, AI_PRODUCT, type AiAllowance, type AiCallOrigin, aiContextHeaders, aiGatewayBaseUrl, aiPurposeKey } from "@tagpress/domain";
import { currentOrg } from "../org/context.ts";

/**
 * Platform kipi (`TAGPRESS_AUTH=platform`): TagPress'in yapay zekâ çağrıları SellerOnData yapay zekâ geçidinden
 * (`Platform/apps/ai-api`; sözleşme `@sellerondata/contracts` `ai.ts`, `aiSpend.ts`) geçer. Sağlayıcı anahtarı TagPress'te
 * yoktur; istemciler `AI_GATEWAY_URL` tabanına araç jetonuyla (`AI_GATEWAY_TOKEN`) gider (`adapters/ai.ts`, `context.ts`).
 *
 * Bağlam başlıkları (`X-SOD-*`) her çağrıda geçerli firma bağlamından (`currentOrg()`):
 * - firma ve üye: bağlamın `orgId`, `memberId` (arka plan işinde üye yok);
 * - amaç: `tagpress.<yerel amaç>` (`aiPurposeKey`; iş kapsamının öneki varsa `sablon-`, `deneme-`, `builder-try-` …);
 * - istek kimliği: iş kapsamınınki (`withAiJob`; bir üretim görevi, bir oluşturucu turu …), yoksa istemcinin mantıksal
 *   çağrısınınki. Geçidin süren iş payı (`origin: job`) aynı istek kimliği zincirine bakar: bir işin bütün çağrıları aynı
 *   kimliği taşır, deneme sayısını geçit artırır;
 * - çıkış: iş kapsamınınki, yoksa üyeli bağlam `request`, üyesiz (arka plan) `job`.
 *
 * Aylık hak: geçidin `GET /internal/allowance?orgId=` yanıtı (`AiAllowance`), firma başına 30 sn önbellek (`peek` eşzamanlı
 * okur, bayatsa arka planda tazeler). Bu yalnız işi baştan durdurmak içindir (`KeyGuard`, oluşturucu bütçesi); asıl sınırı
 * geçit uygular (`sod_org_cap`, `sod_tool_cap`).
 */

export interface AiGatewayConfig {
  /** `AI_GATEWAY_URL` (ör. `http://ai-api:4300`). */
  url: string;
  /** `AI_GATEWAY_TOKEN`: geçidin `AI_GATEWAY_TOKENS` içindeki TagPress jetonu. */
  token: string;
}

/** Bir işin yapay zekâ kapsamı: bütün çağrıları aynı istek kimliğiyle, aynı çıkışla ve (varsa) amaç önekiyle gider. */
export interface AiJobScope {
  requestId?: string;
  origin?: AiCallOrigin;
  /** Yerel amacın öneki: `sablon` → `sablon-design` (`tagpress.sablon_design`). */
  purposePrefix?: string;
}

const jobScope = new AsyncLocalStorage<AiJobScope>();

/** `fn`'i iş kapsamında çalıştırır (dıştaki kapsamın verilmeyen alanları korunur). */
export function withAiJob<T>(s: AiJobScope, fn: () => T): T {
  return jobScope.run({ ...(jobScope.getStore() ?? {}), ...s }, fn);
}

/** Geçerli iş kapsamı (yoksa boş). */
export function currentAiJob(): AiJobScope {
  return jobScope.getStore() ?? {};
}

/** Önbellek süresi (sözleşme: araç en çok 30 sn önbellekler). */
export const AI_ALLOWANCE_TTL_MS = 30_000;
/** Oluşturucu turu başlamadan önce kabul edilen en eski hak (`ensureFresh`): tur pahalıdır, bir okuma ucuzdur. */
export const AI_ALLOWANCE_FRESH_MS = 5_000;
/** Bundan eski değer kullanılmaz (geçide ulaşılamıyorsa eski "doldu" yanıtı işleri sonsuza dek durdurmasın). */
const ALLOWANCE_MAX_AGE_MS = 5 * 60_000;
const ALLOWANCE_TIMEOUT_MS = 5_000;

export interface AiGatewayOptions {
  /** Test: sahte ağ. */
  fetch?: typeof fetch;
  /** Test: saat (ms). */
  now?: () => number;
}

export class AiGateway {
  readonly url: string;
  readonly token: string;
  /** Anthropic SDK tabanı (`/internal/anthropic`). */
  readonly anthropicBaseUrl: string;
  /** Gemini tabanı (`/internal/gemini/v1beta`). */
  readonly geminiBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly allowances = new Map<string, { at: number; value: AiAllowance }>();
  private readonly inflight = new Map<string, Promise<AiAllowance | null>>();
  private warned = false;

  constructor(cfg: AiGatewayConfig, opts: AiGatewayOptions = {}) {
    this.url = cfg.url.trim().replace(/\/+$/, "");
    this.token = cfg.token.trim();
    if (!/^https?:\/\//i.test(this.url)) throw new Error(`AI_GATEWAY_URL bir http(s) adresi olmalı (verilen: ${JSON.stringify(cfg.url).slice(0, 60)}).`);
    if (!this.token) throw new Error("AI_GATEWAY_TOKEN boş.");
    this.anthropicBaseUrl = aiGatewayBaseUrl(this.url, "anthropic");
    this.geminiBaseUrl = aiGatewayBaseUrl(this.url, "gemini");
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * İstemcinin geçit seçenekleri. `fixed`: bu istemcinin sabit amacı ve çıkışı (oluşturucu modeli `builder-turn`, `job`);
   * verilmezse amaç çağrının yerel amacı, çıkış iş kapsamından ya da bağlamdan.
   */
  options(fixed: { purpose?: string; origin?: AiCallOrigin } = {}): GatewayOptions {
    return { context: (call) => this.headers(call, fixed) };
  }

  /** Çağrının bağlam başlıkları. Firma bağlamı yoksa `OrgContextError` (bağlamsız yapay zekâ çağrısı programlama hatasıdır). */
  headers(call: GatewayCall, fixed: { purpose?: string; origin?: AiCallOrigin } = {}): Record<string, string> {
    const org = currentOrg();
    const s = currentAiJob();
    const local = fixed.purpose ?? call.purpose;
    return aiContextHeaders({
      orgId: org.orgId,
      memberId: org.memberId,
      purpose: aiPurposeKey(AI_PRODUCT, s.purposePrefix ? `${s.purposePrefix}-${local}` : local),
      requestId: s.requestId ?? call.requestId,
      origin: fixed.origin ?? s.origin ?? (org.memberId ? "request" : "job"),
      attempt: call.attempt,
    });
  }

  /** Firmanın aylık hakkı (önbellekten, eşzamanlı). Bayatsa arka planda tazelenir; hiç okunmadıysa ya da çok eskiyse null. */
  peek(orgId: string): AiAllowance | null {
    const e = this.allowances.get(orgId);
    const age = e ? this.now() - e.at : Infinity;
    if (age >= AI_ALLOWANCE_TTL_MS) void this.refresh(orgId);
    return e && age < ALLOWANCE_MAX_AGE_MS ? e.value : null;
  }

  /**
   * Harcamalı bir iş başlamadan önce (oluşturucu turu): önbellekteki hak `maxAgeMs`'ten eskiyse geçitten okunmasını bekler.
   * Ulaşılamazsa önbellekteki değer kalır (`peek` bugünkü gibi davranır); dönen değer `peek`'inki.
   */
  async ensureFresh(orgId: string, maxAgeMs = AI_ALLOWANCE_FRESH_MS): Promise<AiAllowance | null> {
    const e = this.allowances.get(orgId);
    if (!e || this.now() - e.at >= maxAgeMs) await this.refresh(orgId);
    return this.peek(orgId);
  }

  /** Geçitten okur ve önbelleğe yazar (aynı firmaya eşzamanlı tek istek). Ulaşılamazsa null (önbellekteki değer kalır). */
  refresh(orgId: string): Promise<AiAllowance | null> {
    const running = this.inflight.get(orgId);
    if (running) return running;
    const p = this.fetchAllowance(orgId).finally(() => this.inflight.delete(orgId));
    this.inflight.set(orgId, p);
    return p;
  }

  private async fetchAllowance(orgId: string): Promise<AiAllowance | null> {
    try {
      const res = await this.fetchFn(`${this.url}${AI_GATEWAY_PATHS.allowance}?orgId=${encodeURIComponent(orgId)}`, {
        headers: { [AI_GATEWAY_KEY_HEADERS.anthropic]: this.token, accept: "application/json" },
        signal: AbortSignal.timeout(ALLOWANCE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`geçit ${res.status} döndü`);
      const value = (await res.json()) as AiAllowance;
      if (typeof value?.capMicroUsd !== "number" || typeof value.usedMicroUsd !== "number" || typeof value.state !== "string") throw new Error("yanıt biçimi tanınmıyor");
      this.allowances.set(orgId, { at: this.now(), value });
      return value;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`Yapay zekâ geçidinden aylık hak okunamadı (${err instanceof Error ? err.message : String(err)}); geçit yine kendi sınırını uygular.`);
      }
      return null;
    }
  }
}

/** Platform ayarından geçit (adres ya da jeton boşsa null: platform kipinde yapay zekâ kapalı, `ai-unavailable`). */
export function createAiGateway(cfg: AiGatewayConfig | null | undefined, opts: AiGatewayOptions = {}): AiGateway | null {
  return cfg?.url?.trim() && cfg.token?.trim() ? new AiGateway(cfg, opts) : null;
}

/** Aylık hakkın oluşturucu bütçesine ve ön denetime çevrilmiş hâli (USD): firma hakkı ile araç tavanından kalanı az olan. */
export function allowanceLimit(a: AiAllowance): { limitUsd: number; usedUsd: number; state: AiAllowance["state"] } {
  const org = { limit: a.capMicroUsd, used: a.usedMicroUsd };
  const tool = a.tool?.capMicroUsd !== null && a.tool?.capMicroUsd !== undefined ? { limit: a.tool.capMicroUsd, used: a.tool.usedMicroUsd } : null;
  const pick = tool && tool.limit - tool.used < org.limit - org.used ? tool : org;
  return { limitUsd: pick.limit / 1e6, usedUsd: pick.used / 1e6, state: a.state };
}
