import {
  FEATURE_KEYS,
  FEATURES,
  type FeatureExplicit,
  type FeatureKey,
  type FeaturesResponse,
  previewSetup,
  printDefaultsFromSetup,
  type SetupAnswers,
  SetupStateSchema,
  type SetupState,
  suggestFeatures,
} from "@tagpress/domain";
import type { EventBus } from "../events.ts";
import type { FeatureService } from "../features/service.ts";
import type { Clock } from "../util/clock.ts";
import type { SettingsService } from "./settings.ts";

/** Firma ayarındaki anahtar (`org_settings`). */
export const SETUP_KEY = "setup";

/**
 * Kurulumun baskı cevaplarından türetilen varsayılanlar (`printDefaultsFromSetup`; firma ayarı). Kurulum tamamlanınca
 * (atlanınca da) yazılır; yeni ızgara sayfa şablonunun kesim/işaret ayarları buradan başlar (`PrintTemplateService.grid`).
 * Kayıt yoksa (sahibin göçle gelen firması, kurulumu hiç bitmemiş firma) şema varsayılanları geçer.
 */
export const PRINT_DEFAULTS_KEY = "print.defaults";
export type PrintDefaults = ReturnType<typeof printDefaultsFromSetup>;

/** Kayıtlı baskı varsayılanları (geçerli firma); yoksa ya da bozuksa null. */
export function storedPrintDefaults(settings: SettingsService): PrintDefaults | null {
  const v = settings.getOrg<unknown>(PRINT_DEFAULTS_KEY, null);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as PrintDefaults) : null;
}

/** Kayıt yokken (yeni firma, taze kurulum): kurulum bekliyor. */
export const PENDING_SETUP: SetupState = { status: "pending", step: 1, answers: { labelTypes: [] }, completedAt: null, skipped: false };

/**
 * Kurulum akışı (SUNUCU-PLANI §3.2, §3.4): cevaplar adım adım `org_settings.setup`'a yazılır; `complete` yalnız
 * onaylanan özellik listesini uygular (listede olmayan kapanır). Kayıt yoksa (yeni firma, `OrgService.create`/`ensureLocal` sonrası) durum `pending`;
 * sahibin firması göç 11'de tamamlanmış yazılır.
 */
export class SetupService {
  constructor(
    private readonly settings: SettingsService,
    private readonly features: FeatureService,
    private readonly clock: Clock,
    private readonly events?: EventBus,
  ) {}

  /** Geçerli firmanın kurulum durumu (kayıt yoksa ya da bozuksa `pending`). */
  state(): SetupState {
    const r = SetupStateSchema.safeParse(this.settings.getOrg<unknown>(SETUP_KEY, null));
    return r.success ? r.data : structuredClone(PENDING_SETUP);
  }

  /** Kaydetmeden önizleme: önerilen etkin durum ve bugüne göre farklar. */
  preview(answers: SetupAnswers): ReturnType<typeof previewSetup> {
    return previewSetup(answers, this.features.explicit(), this.now());
  }

  /** Adım adım kayıt (tarayıcı kapanırsa kaldığı yerden). Tamamlanmış kurulumda durum değişmez, cevaplar güncellenir. */
  saveAnswers(step: SetupState["step"], answers: SetupAnswers): SetupState {
    const cur = this.state();
    return this.write({ ...cur, step, answers, status: cur.status === "completed" ? "completed" : "in-progress" });
  }

  /**
   * Kurulumu bitirir: `approved` (kullanıcının onayladığı açık özellikler) ve bağımlılıkları açılır; kurulumda
   * gösterilen ama listede olmayanlar kapanır (kullanıcının ya da göçün açtığı da: ekranda bilerek kapatılmıştır).
   * `always` ve kurulumda gizli özelliklere dokunulmaz.
   */
  complete(answers: SetupAnswers, approved: readonly FeatureKey[]): { setup: SetupState; features: FeaturesResponse } {
    const at = this.now();
    const explicit = this.features.explicit();
    const on = new Set(approved);
    const next: FeatureExplicit = { ...explicit };
    for (const key of FEATURE_KEYS) {
      // Her zaman açık ve kurulumda gizli özelliklere dokunulmaz.
      if (FEATURES[key].always || FEATURES[key].setup === "hidden") continue;
      const cur = explicit[key];
      // Listedeki özellik, kullanıcının ya da göçün açtığı kaydıyla kalır (kaydı `setup`'a dönmez).
      // Listede olmayan, kurulumda gösterilen özellik kullanıcı bilerek kapattığı için kapanır (ürün kararı, 2026-11-22).
      if (on.has(key) && cur?.on && (cur.by === "user" || cur.by === "migration")) continue;
      next[key] = { on: on.has(key), by: "setup", at };
    }
    // Açık kalan özelliğin bağımlılıkları da açılır (`print.stickers` → `print`): bağlı özellik dolaylı yoldan kapanmaz.
    const ensureDeps = (key: FeatureKey): void => {
      for (const d of FEATURES[key].dependsOn ?? []) {
        if (!next[d]?.on && !FEATURES[d].always) next[d] = { on: true, by: "setup", at };
        ensureDeps(d);
      }
    };
    for (const key of on) ensureDeps(key);
    // Baskı cevaplarından sayfa şablonu varsayılanları (kağıt, kesim çizgisi, kayıt işareti, taşma, sticker ölçüsü).
    this.settings.setOrg(PRINT_DEFAULTS_KEY, printDefaultsFromSetup(answers));
    return this.finish(next, { status: "completed", step: 3, answers, completedAt: at, skipped: false });
  }

  /** "Atla, varsayılanla başla": adım 1'in ortak kümesi açılır (türsüz öneri), `skipped: true`. */
  skip(): { setup: SetupState; features: FeaturesResponse } {
    const answers: SetupAnswers = { ...this.state().answers, labelTypes: [] };
    const r = this.complete(answers, suggestFeatures(answers));
    return { setup: this.write({ ...r.setup, skipped: true }), features: r.features };
  }

  /** Yeniden çalıştırma: eski cevaplar dolu, `in-progress`, adım 1. Özellikler değişmez (`complete` yazar). */
  restart(): SetupState {
    const cur = this.state();
    return this.write({ ...cur, status: "in-progress", step: 1, completedAt: null, skipped: false });
  }

  private finish(explicit: FeatureExplicit, setup: SetupState): { setup: SetupState; features: FeaturesResponse } {
    this.features.write(explicit);
    return { setup: this.write(setup), features: this.features.view() };
  }

  private write(state: SetupState): SetupState {
    const s = SetupStateSchema.parse(state);
    this.settings.setOrg(SETUP_KEY, s);
    this.events?.emit({ type: "settings" });
    return s;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}
