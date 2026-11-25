import { type AiProvider, errorText } from "@tagpress/domain";
import type { AiGateway } from "../adapters/ai-gateway.ts";
import { currentOrg } from "../org/context.ts";
import { HttpError, fail } from "../util/errors.ts";
import type { SecretService } from "./secrets.ts";

const NAMES: Record<AiProvider, string> = { anthropic: "Anthropic", gemini: "Google Gemini" };

/** Anahtar yok: iş kuyruğa alınmadan önce açık hata (409, `code: "missing-key"`, `provider`). */
export class MissingKeyError extends HttpError {
  constructor(readonly provider: AiProvider) {
    const params = { providerName: NAMES[provider] };
    super(409, errorText("missing-key", params), undefined, "missing-key", params);
  }
}

/**
 * AI çağrısı gerektiren işlerin ön denetimi. Yalnızca gerçek AI bağlantıları kullanılırken (üretim fabrikası)
 * zorlanır; sahte portlu testlerde kapalıdır (`enforce: false`).
 * - Yerel kip (`SecretService`): sağlayıcının kayıtlı anahtarı yoksa 409 `missing-key`.
 * - Platform kipi (`{ gateway }`): anahtar okunmaz. Geçit bağlı değilse 409 `ai-unavailable`; geçidin bildirdiği aylık hak
 *   (önbellekteki `AiAllowance`, en çok 30 sn eski) platform durdurulmuş diyorsa 409 `ai-paused`, dolmuş diyorsa 409
 *   `budget-exceeded`. Hak henüz okunmadıysa iş başlar; sınırı geçit yine uygular.
 */
export class KeyGuard {
  constructor(
    private readonly source: SecretService | { gateway: AiGateway | null },
    private readonly enforce: boolean,
  ) {}

  require(...providers: AiProvider[]): void {
    if (!this.enforce) return;
    if ("gateway" in this.source) {
      const gw = this.source.gateway;
      if (!gw) throw fail("ai-unavailable");
      const state = gw.peek(currentOrg().orgId)?.state;
      if (state === "paused") throw fail("ai-paused");
      if (state === "capped") throw fail("budget-exceeded");
      return;
    }
    for (const p of providers) if (!this.source.get(p)) throw new MissingKeyError(p);
  }
}
