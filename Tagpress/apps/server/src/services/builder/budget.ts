import { randomUUID } from "node:crypto";
import { BUILDER_BUDGET_DEFAULTS } from "@tagpress/domain";
import { z } from "zod";
import { currentOrg } from "../../org/context.ts";
import type { SettingsService } from "../settings.ts";
import { fail } from "../../util/errors.ts";
import { HttpErrorWithBody } from "./errors.ts";

/**
 * Oluşturucunun bütçesi (SUNUCU-PLANI §4.6). İki sınır:
 *  - oturum: `design_sessions.budget_usd` (varsayılan $3; kullanıcı onayıyla bir kez +$3);
 *  - firma, aylık: `org_settings["ai.limits"].monthlyUsd` (varsayılan $20). Ay içindeki harcama = firmanın bu ayki
 *    bütün `ai_calls` maliyeti (bütün araçlar; fiyatı bilinmeyen çağrı en pahalı fiyatla) + şu an çalışan işlerin
 *    ayrılmış ama henüz harcanmamış tahminleri. Platform kipinde sınır ve harcama yapay zekâ geçidinin tek ortak aylık
 *    hakkından (`MonthlyAllowance`; en çok 30 sn eski) gelir, `ai.limits.monthlyUsd` kullanılmaz; platform durdurulduysa
 *    409 `ai-paused`. Önbellek gecikmesi yüzünden bu denetim bir tur kadar geç kalabilir; asıl sınırı geçit uygular
 *    (`sod_org_cap` / `sod_tool_cap` → tur `quota-exceeded` ile durur, yeniden denenmez).
 *
 * Tur ya da ölçüm başlamadan `reserve` çağrılır: kullanılan + ayrılmış + tahmin sınırı aşacaksa 409 `budget-exceeded`
 * (hiçbir şey başlamaz, hiçbir şey yazılmaz). Denetim ve ayırma aynı eşzamanlı adımdadır (arada `await` yok): iki
 * eşzamanlı istek aynı boş payı ikisi birden alamaz. Ayırma iş bitince (`release`) bırakılır; gerçek harcama o
 * zamana kadar istek istek `ai_calls`'a yazılmıştır. Ayırmalar süreç belleğindedir (tek süreç; süreç kapanınca
 * çalışan iş de yoktur).
 *
 * Tur içinde: döngüye kalan pay bir İŞLEV olarak verilir ve her model isteğinden önce kayıtlı harcamadan yeniden
 * hesaplanır (`remainingUsd`); 0'a inince yeni istek gönderilmez. Böylece eşzamanlı işler birbirinin harcamasını
 * istek istek görür: aylık sınır en çok çalışan iş başına bir istek kadar aşılır. Çalışan işin ayırmasından o işin
 * kaydedilmiş harcaması düşülür (`charge`): ayırma "henüz harcanmamış tahmin"dir, harcama iki kez sayılmaz.
 */

export const AI_LIMITS_KEY = "ai.limits";

const LimitsSchema = z
  .object({
    monthlyUsd: z.number().positive().optional(),
    sessionUsd: z.number().positive().optional(),
    sessionRaiseUsd: z.number().positive().optional(),
    warnRatio: z.number().min(0).max(1).optional(),
  })
  .catch({});

export interface BuilderLimits {
  monthlyUsd: number;
  sessionUsd: number;
  sessionRaiseUsd: number;
  warnRatio: number;
}

export interface Reservation {
  readonly token: string;
  readonly orgId: string;
  readonly estimateUsd: number;
}

export interface BudgetRequest {
  buildId: string;
  /** Oturumun bugüne kadarki harcaması ve sınırı. */
  sessionUsedUsd: number;
  sessionCapUsd: number;
  /** Sınır bir kez artırılabilir mi. */
  canRaise: boolean;
  /** Başlatılacak işin tahmini. */
  estimateUsd: number;
}

/**
 * Platform kipi: firmanın aylık hakkı yapay zekâ geçidinden (`AiGateway.peek` + `allowanceLimit`; bütün araçlarda tek
 * ortak hak, araç tavanı daha az bırakıyorsa o). Yanıt yoksa (henüz okunmadı, geçide ulaşılamadı) null: yerel değerler
 * (kurulum ayarı ve `ai_calls`) geçer; asıl sınırı geçit yine uygular.
 */
export type MonthlyAllowance = () => { limitUsd: number; usedUsd: number; state: "ok" | "warn" | "capped" | "paused" } | null;

export class BuilderBudget {
  /** firma → (ayırma → { tahmin, bu işin kaydedilmiş harcaması }). */
  private readonly reserved = new Map<string, Map<string, { estimateUsd: number; spentUsd: number }>>();

  constructor(
    private readonly settings: SettingsService,
    /** Firmanın bu ayki kaydedilmiş harcaması (`ai_calls`). */
    private readonly monthRecorded: () => number,
    /** Platform kipi: geçidin aylık hakkı (yerel kipte yok; `org_settings["ai.limits"].monthlyUsd` yalnız yerel kipte). */
    private readonly allowance: MonthlyAllowance | null = null,
    /** Platform kipi: hak önbelleği taze değilse geçitten yeniden okur (`AiGateway.ensureFresh`); yerel kipte yok. */
    private readonly refreshAllowance: (() => Promise<unknown>) | null = null,
  ) {}

  /**
   * Tur başlamadan önce (eşzamanlı `reserve`'den sonra, ilk model isteğinden önce): geçidin aylık hakkı taze değilse yeniden
   * okunur; turun kalan payı (`remainingUsd`) böylece taze harcamayla hesaplanır. Okunamazsa önbellekteki değer geçer.
   */
  async refresh(): Promise<void> {
    if (!this.refreshAllowance) return;
    try {
      await this.refreshAllowance();
    } catch {
      /* ulaşılamadı: önbellekteki değer (bugünkü davranış) */
    }
  }

  /** Bu ayki kaydedilmiş harcama: platform kipinde geçidin saydığı (bütün araçlar), yoksa yerel `ai_calls`. */
  private recorded(): number {
    return this.allowance?.()?.usedUsd ?? this.monthRecorded();
  }

  limits(): BuilderLimits {
    const o = LimitsSchema.parse(this.settings.getOrg<unknown>(AI_LIMITS_KEY, {}));
    const platform = this.allowance?.();
    return {
      monthlyUsd: platform ? platform.limitUsd : (o.monthlyUsd ?? BUILDER_BUDGET_DEFAULTS.monthlyUsd),
      sessionUsd: o.sessionUsd ?? BUILDER_BUDGET_DEFAULTS.sessionUsd,
      sessionRaiseUsd: o.sessionRaiseUsd ?? BUILDER_BUDGET_DEFAULTS.sessionRaiseUsd,
      warnRatio: o.warnRatio ?? BUILDER_BUDGET_DEFAULTS.warnRatio,
    };
  }

  /** Geçerli firmanın çalışan işlerine ayrılmış ve henüz harcanmamış toplam (`except` hariç). */
  reservedUsd(except?: Reservation): number {
    let sum = 0;
    for (const [token, v] of this.reserved.get(currentOrg().orgId) ?? []) if (token !== except?.token) sum += Math.max(0, v.estimateUsd - v.spentUsd);
    return sum;
  }

  /** İşin kaydedilen harcaması ayırmasından düşülür (aylık hesapta iki kez sayılmasın). */
  charge(r: Reservation | null | undefined, usd: number): void {
    if (!r || !(usd > 0)) return;
    const v = this.reserved.get(r.orgId)?.get(r.token);
    if (v) v.spentUsd += usd;
  }

  /** Bu ayki harcama: kaydedilen + ayrılmış (çalışan işlerin tahmini). */
  monthUsd(): number {
    return this.recorded() + this.reservedUsd();
  }

  /**
   * Denetle ve ayır (eşzamanlı). Oturum sınırı önce: aşılacaksa `scope: "session"` (bir kez artırılabilir); sonra
   * aylık sınır (`scope: "month"`, artırılamaz).
   */
  reserve(req: BudgetRequest): Reservation {
    const est = Math.max(0, req.estimateUsd);
    if (req.sessionUsedUsd + est > req.sessionCapUsd + 1e-9) {
      throw exceeded({ scope: "session", usedUsd: req.sessionUsedUsd, limitUsd: req.sessionCapUsd, estimateUsd: est, canRaise: req.canRaise, buildId: req.buildId });
    }
    // Platform kipi: geçit platformu durdurduysa iş başlamaz (firmanın hakkı dolmuş gibi gösterilmez).
    if (this.allowance?.()?.state === "paused") throw fail("ai-paused");
    const { monthlyUsd } = this.limits();
    const used = this.monthUsd();
    if (used + est > monthlyUsd + 1e-9) {
      throw exceeded({ scope: "month", usedUsd: used, limitUsd: monthlyUsd, estimateUsd: est, canRaise: false, buildId: req.buildId });
    }
    const orgId = currentOrg().orgId;
    const token = randomUUID();
    let m = this.reserved.get(orgId);
    if (!m) this.reserved.set(orgId, (m = new Map()));
    m.set(token, { estimateUsd: est, spentUsd: 0 });
    return { token, orgId, estimateUsd: est };
  }

  release(r: Reservation | null | undefined): void {
    if (!r) return;
    const m = this.reserved.get(r.orgId);
    m?.delete(r.token);
    if (m && !m.size) this.reserved.delete(r.orgId);
  }

  /**
   * Şu anki kalan pay: oturumda kalan ve ayda kalan. Ayda kalan = sınır − (kaydedilen harcama + BAŞKA işlerin
   * harcanmamış ayırmaları); bu işin kendi ayırması sayılmaz (kendi harcaması zaten kaydedilende). Her model isteğinden
   * önce taze oturum satırıyla çağrılır.
   */
  remainingUsd(r: Reservation, sessionUsedUsd: number, sessionCapUsd: number): number {
    const month = this.limits().monthlyUsd - (this.recorded() + this.reservedUsd(r));
    return Math.max(0, Math.min(sessionCapUsd - sessionUsedUsd, month));
  }
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function exceeded(b: { scope: "session" | "month"; usedUsd: number; limitUsd: number; estimateUsd: number; canRaise: boolean; buildId: string }) {
  return new HttpErrorWithBody(fail("budget-exceeded"), { scope: b.scope, usedUsd: r4(b.usedUsd), limitUsd: b.limitUsd, estimateUsd: r4(b.estimateUsd), canRaise: b.canRaise, buildId: b.buildId });
}
