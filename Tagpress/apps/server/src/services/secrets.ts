import { AI_PROVIDERS, type AiProvider, type ApiKeyStatus, errorText } from "@tagpress/domain";
import type { Clock } from "../util/clock.ts";
import { HttpError, fail } from "../util/errors.ts";
import type { LegacyDecrypt } from "./dpapi.ts";
import { type KeyRing, type MasterKeyProvider, type Sealed, SecretKeyError, isSealed, open, seal } from "./secret-box.ts";
import type { SettingsService } from "./settings.ts";

/**
 * Anahtarın kaynağı. `local` (yerel kip): kurulum düzeyinde `settings` içinde şifreli `key:<sağlayıcı>` kayıtları;
 * firmalar anahtar girmez, bütün firmalar kurulumun anahtarını kullanır. `platform` (platform kipi): anahtar SellerOnData
 * yapay zekâ geçidinde (`adapters/ai-gateway.ts`); bu servis anahtar okumaz, yazmaz (`get` programlama hatasıdır).
 * Ortam değişkenindeki sağlayıcı anahtarına (`ANTHROPIC_API_KEY` …) hiçbir kipte düşülmez (YAPAY-ZEKA-GECIDI §6).
 */
export type KeySource = "local" | "platform";

/** Sağlayıcılar ve adresleri SABİTTİR; kullanıcı yalnızca anahtar girer. */
export const PROVIDERS: Record<AiProvider, { label: string; baseUrl: string }> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com" },
  gemini: { label: "Google Gemini (görüntü)", baseUrl: "https://generativelanguage.googleapis.com" },
};

/**
 * `settings` tablosunda `key:<sağlayıcı>` kaydı. Yeni kayıt her zaman şifrelidir (`secret-box.ts`). Eski biçimler yalnız
 * okunur ve açılışta taşınır: `dpapi` (Windows hesabına bağlı) ve `plain` (eskiden Windows dışında düz yazılırdı).
 */
type SealedStored = Sealed & { updatedAt: string };
type LegacyStored = { format: "dpapi" | "plain"; value: string; updatedAt: string };
type StoredKey = SealedStored | LegacyStored;

export interface SecretServiceOptions {
  /** Ana anahtarın kaynağı (`defaultKeyProvider`). */
  keys: MasterKeyProvider;
  /** Eski DPAPI kayıtlarının çözücüsü; bu platformda yoksa null (`legacyDpapi()`). */
  legacyDpapi: LegacyDecrypt | null;
  /** Anahtar kaynağı; varsayılan `local`. `platform`: anahtar geçitte, bu servis yalnız boş durum gösterir. */
  source?: KeySource;
}

/** Açılış özeti (günlük için; değer içermez). */
export interface SecretInitReport {
  /** Ana anahtarın kaynağı ("dosya …", "ortam değişkeni …"). */
  source: string;
  /** Ana anahtar bu açılışta üretildi. */
  created: boolean;
  /** Yükleme notları (dosya DPAPI ile sarıldı, dosyadan ortam değişkenine geçiş…); yol içerebilir, yalnız günlüğe. */
  notes: string[];
  /** Eski biçimden (DPAPI, düz) şifreli biçime taşınanlar. */
  migrated: AiProvider[];
  /** Eski ana anahtardan geçerli ana anahtara yeniden şifrelenenler (döndürme). */
  rotated: AiProvider[];
  /** Çözülemeyen kayıtlar; kayıt olduğu gibi yerinde bırakıldı. */
  failed: { provider: AiProvider; reason: string }[];
}

/** Kayıtlı anahtar çözülemiyor (ana anahtar yok/yanlış, kayıt bozuk): AI işi açık hatayla durur (409, `provider`). */
export class UnreadableKeyError extends HttpError {
  constructor(
    readonly provider: AiProvider,
    reason: string,
  ) {
    const params = { providerName: PROVIDERS[provider].label, detail: reason };
    super(409, errorText("key-unreadable", params), undefined, "key-unreadable", params);
  }
}

const aad = (provider: AiProvider) => `tagpress:key:${provider}`;
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : "Beklenmeyen hata.");

/**
 * API anahtarları. Yanıtlarda ve günlüklerde ASLA anahtar yoktur; çözülmüş değer yalnızca bellekte tutulur.
 * `init()` açılışta bir kez çağrılır (`createContext`).
 */
export class SecretService {
  private readonly cache = new Map<AiProvider, string>();
  /** Çözülemeyen kayıtlar ve nedeni (uyarı olarak gösterilir; tekrar tekrar denenmez). */
  private readonly problems = new Map<AiProvider, string>();
  private ring: KeyRing | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly opts: SecretServiceOptions,
  ) {}

  get source(): KeySource {
    return this.opts.source ?? "local";
  }

  /**
   * Ana anahtarı yükler; yoksa ve sahipsiz şifreli kayıt yoksa üretir. Kaynak bozuksa (biçim, izin) `SecretKeyError`
   * fırlatır: uygulama açılmaz, düz metne düşülmez. Sonra eski biçimli ve eski ana anahtarlı kayıtları geçerli biçime
   * taşır. Taşıma, yeni kayıt yazılıp geri çözülerek doğrulanmadan eski kaydın yerine geçmez; başarısızsa eski kayıt kalır.
   */
  async init(): Promise<SecretInitReport> {
    // Platform kipi: ana anahtar dosyası açılmaz, kayıt taşınmaz (anahtar geçitte).
    if (this.source === "platform") return { source: "platform", created: false, notes: [], migrated: [], rotated: [], failed: [] };
    const report: SecretInitReport = { source: this.opts.keys.description, created: false, notes: [], migrated: [], rotated: [], failed: [] };
    this.ring = await this.opts.keys.load();
    report.notes.push(...(this.ring?.notes ?? []));
    // Ana anahtar yokken şifreli kayıt varsa yenisi ÜRETİLMEZ: dosya geri konunca o kayıtlar yine çözülebilsin.
    if (!this.ring && this.opts.keys.create && !AI_PROVIDERS.some((p) => isSealed(this.stored(p)))) {
      this.ring = await this.opts.keys.create();
      report.created = true;
    }
    for (const p of AI_PROVIDERS) {
      const s = this.stored(p);
      if (!s) continue;
      try {
        const plain = this.decrypt(p, s);
        if (!isSealed(s)) {
          this.write(p, plain, s.updatedAt);
          report.migrated.push(p);
        } else if (s.kid !== this.ring!.current.id) {
          this.write(p, plain, s.updatedAt);
          report.rotated.push(p);
        }
        this.cache.set(p, plain);
      } catch (err) {
        const reason = reasonOf(err);
        this.problems.set(p, reason);
        report.failed.push({ provider: p, reason });
      }
    }
    return report;
  }

  status(): ApiKeyStatus[] {
    return AI_PROVIDERS.map((p) => {
      const stored = this.source === "platform" ? null : this.stored(p);
      return {
        provider: p,
        label: PROVIDERS[p].label,
        baseUrl: PROVIDERS[p].baseUrl,
        hasKey: !!stored,
        encrypted: stored?.format !== "plain",
        updatedAt: stored?.updatedAt ?? null,
      };
    });
  }

  warnings(): string[] {
    if (this.source === "platform") return [];
    const out = [...this.problems].map(([p, reason]) => `${PROVIDERS[p].label} anahtarı çözülemiyor: ${reason} Anahtarı yeniden girin.`);
    if (!this.ring) out.push(`Ana anahtar yok (${this.opts.keys.label}); yeni anahtar kaydedilemez.`);
    return out;
  }

  set(provider: AiProvider, apiKey: string): ApiKeyStatus {
    this.assertLocal();
    const plain = apiKey.trim();
    this.write(provider, plain, this.clock.now().toISOString());
    this.cache.set(provider, plain);
    this.problems.delete(provider);
    return this.status().find((s) => s.provider === provider)!;
  }

  remove(provider: AiProvider): ApiKeyStatus {
    this.assertLocal();
    this.settings.deleteInstall(`key:${provider}`);
    this.cache.delete(provider);
    this.problems.delete(provider);
    return this.status().find((s) => s.provider === provider)!;
  }

  /**
   * Sunucu içi kullanım (ai paketi, yalnız yerel kip): kayıtlı anahtar; kayıt yoksa null. Ortam değişkenine
   * (`ANTHROPIC_API_KEY` …) düşülmez (sahibin ortamdaki anahtarı sessizce bir firmaya açılmasın). Kayıt var ama
   * çözülemiyorsa `UnreadableKeyError`. Bir kez çözülür, bellekte kalır. Platform kipinde çağrı programlama hatasıdır
   * (yapay zekâ yalnız geçitten).
   */
  get(provider: AiProvider): string | null {
    this.assertLocal();
    const cached = this.cache.get(provider);
    if (cached) return cached;
    const stored = this.stored(provider);
    if (!stored) return null;
    const problem = this.problems.get(provider);
    if (problem) throw new UnreadableKeyError(provider, problem);
    try {
      const plain = this.decrypt(provider, stored);
      this.cache.set(provider, plain);
      return plain;
    } catch (err) {
      const reason = reasonOf(err);
      this.problems.set(provider, reason);
      throw new UnreadableKeyError(provider, reason);
    }
  }

  private decrypt(provider: AiProvider, s: StoredKey): string {
    let plain: string;
    if (isSealed(s)) {
      if (!this.ring) throw new SecretKeyError("master-key-missing", `Ana anahtar bulunamadı (${this.opts.keys.label}); yedekten geri koyun.`);
      plain = open(this.ring, s, aad(provider));
    } else if (s.format === "dpapi") {
      if (!this.opts.legacyDpapi) throw new Error("Kayıt Windows DPAPI ile şifreli; yalnız onu kaydeden Windows kullanıcısında taşınabilir.");
      plain = this.opts.legacyDpapi(String(s.value));
    } else if (s.format === "plain") {
      plain = String(s.value);
    } else {
      throw new Error("Kayıt biçimi tanınmıyor.");
    }
    if (!plain.trim()) throw new Error("Kayıt boş çözüldü.");
    return plain;
  }

  /** Şifreleyip yazar; yazmadan önce geri çözerek doğrular (eski kaydın yerine ancak doğrulanmış kayıt geçer). */
  private write(provider: AiProvider, plain: string, updatedAt: string): void {
    if (!this.ring) throw fail("master-key-missing", { keys: this.opts.keys.label });
    const sealed = seal(this.ring, plain, aad(provider));
    if (open(this.ring, sealed, aad(provider)) !== plain) throw new SecretKeyError("secret-corrupt", "Şifreleme doğrulanamadı.");
    this.settings.setInstall(`key:${provider}`, { ...sealed, updatedAt } satisfies SealedStored);
  }

  /** Platform kipinde anahtar okunmaz ve yazılmaz (rota kapısı 409 `managed-by-platform` verir; buraya gelmek hatadır). */
  private assertLocal(): void {
    if (this.source === "platform") throw new Error("Platform kipinde SecretService anahtar okumaz ve yazmaz; yapay zekâ yalnız geçitten (AI_GATEWAY_URL).");
  }

  private stored(provider: AiProvider): StoredKey | null {
    return this.settings.getInstall<StoredKey | null>(`key:${provider}`, null);
  }
}
