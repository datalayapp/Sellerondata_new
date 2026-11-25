import {
  applyToggle,
  effectiveFeatures,
  errorText,
  FEATURE_KEYS,
  FEATURES,
  FeatureChoiceSchema,
  type FeatureChoice,
  type FeatureExplicit,
  type FeatureKey,
  type FeaturesPatchBody,
  type FeaturesResponse,
  FeatureStateSchema,
} from "@tagpress/domain";
import type { EventBus } from "../events.ts";
import type { SettingsService } from "../services/settings.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, fail } from "../util/errors.ts";

/** Firma ayarındaki anahtar (`org_settings`). */
export const FEATURES_KEY = "features";

/**
 * Özellik kapalı: yazma ya da harcama isteği reddedilir (409, `code: "feature-off"`, `feature`). Biçim `missing-key`
 * ile aynı (`MissingKeyError`): arayüz `feature` alanına bakıp "Aç" önerir.
 */
export class FeatureOffError extends HttpError {
  constructor(readonly feature: FeatureKey) {
    super(409, errorText("feature-off"), undefined, "feature-off");
  }
}

/**
 * Firmanın açık seçimleri (`org_settings.features`, `FeatureStateSchema`). Kayıt yoksa `{}` (kayıt varsayılanları).
 * Bozuk kayıtta yalnız geçerli seçimler okunur (bir anahtarın bozuk olması bütün seçimleri silmez).
 */
export function readExplicit(settings: SettingsService): FeatureExplicit {
  const raw = settings.getOrg<unknown>(FEATURES_KEY, {});
  const strict = FeatureStateSchema.safeParse(raw);
  if (strict.success) return strict.data;
  const out: FeatureExplicit = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of FEATURE_KEYS) {
      const r = FeatureChoiceSchema.safeParse((raw as Record<string, unknown>)[key]);
      if (r.success) out[key] = r.data;
    }
  }
  return out;
}

/** Geçerli firmada özellik açık mı (servislerin gövdeye bağlı okumaları için; firma bağlamı gerekir). */
export function featureOn(settings: SettingsService, key: FeatureKey): boolean {
  return effectiveFeatures(readExplicit(settings))[key];
}

/** Geçerli firmada özellik kapalıysa `FeatureOffError` (409 `feature-off`). */
export function requireFeature(settings: SettingsService, key: FeatureKey): void {
  if (!featureOn(settings, key)) throw new FeatureOffError(key);
}

/**
 * Özellik anahtarları (SUNUCU-PLANI §3.1, §3.3). Etkin değer = kayıt varsayılanı + firmanın açık seçimleri
 * (`effectiveFeatures`); saklanan biçim `org_settings.features = { [anahtar]: { on, by, at } }`. Kapatmak veri silmez:
 * yalnız yazma ve harcama uçları (`route-map.ts`) ile gövdeye bağlı servis denetimleri (`requireFeature`) durur.
 */
export class FeatureService {
  constructor(
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly events?: EventBus,
  ) {}

  explicit(): FeatureExplicit {
    return readExplicit(this.settings);
  }

  effective(): Record<FeatureKey, boolean> {
    return effectiveFeatures(this.explicit());
  }

  isOn(key: FeatureKey): boolean {
    return this.effective()[key];
  }

  require(key: FeatureKey): void {
    if (!this.isOn(key)) throw new FeatureOffError(key);
  }

  /** API görünümü (`GET /api/features`). */
  view(): FeaturesResponse {
    const explicit = this.explicit();
    return { registry: FEATURE_KEYS.map((k) => FEATURES[k]), effective: effectiveFeatures(explicit), explicit };
  }

  /**
   * Toplu açma/kapama (`PATCH /api/features`): anahtarlar sırayla `applyToggle` ile uygulanır (açılan özelliğin
   * bağımlılıkları açılır, kapanan özelliğe bağlı olanlar kapanır). `always` özellik kapatılamaz (400
   * `feature-always-on`, hiçbir şey yazılmaz). `changed`: etkin değeri değişen bütün anahtarlar (bağlılar dahil).
   */
  toggle(patch: FeaturesPatchBody, by: FeatureChoice["by"]): { view: FeaturesResponse; changed: FeatureKey[] } {
    const at = this.clock.now().toISOString();
    const before = this.effective();
    let next = this.explicit();
    // Çelişkili istek: bir özellik kapanırken (doğrudan ya da zincirle) ona bağlı olan açılmak istenemez.
    const needs = (key: FeatureKey): FeatureKey[] => (FEATURES[key].dependsOn ?? []).flatMap((d) => [d, ...needs(d)]);
    for (const key of FEATURE_KEYS) {
      if (patch[key] === true && needs(key).some((d) => patch[d] === false)) throw fail("feature-invalid");
    }
    for (const key of FEATURE_KEYS) {
      const on = patch[key];
      if (on === undefined) continue;
      if (!on && FEATURES[key].always) throw fail("feature-always-on");
      next = applyToggle(next, key, on, by, at).explicit;
    }
    this.write(next);
    const after = effectiveFeatures(next);
    return { view: this.view(), changed: FEATURE_KEYS.filter((k) => before[k] !== after[k]) };
  }

  /** Açık seçimleri olduğu gibi yazar (kurulum servisi; ayar olayı yayınlanır). */
  write(explicit: FeatureExplicit): void {
    this.settings.setOrg(FEATURES_KEY, explicit);
    this.events?.emit({ type: "settings" });
  }
}
