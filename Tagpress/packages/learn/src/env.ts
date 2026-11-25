import { existsSync } from "node:fs";
import type { DesignIntent, LayoutResult, Profile, Reference, Template, TemplateGeometry } from "@tagpress/domain";
import { type ReplayMetrics, layout, referenceToIntent, renderPreview, replayReference } from "@tagpress/engine";
import { buildGeometry } from "@tagpress/templates";
import { FontRegistry } from "@tagpress/typeset";

/**
 * AI'sız tekrar ortamı: font kaydı + şablon geometrisi önbelleği. Geometri hesaplamak pahalıdır (şablon başına
 * ~0,3 sn); referanslar şablona göre sıralanıp işlenir ve geometri (şablon, profilin geometri alanları) başına
 * önbelleğe alınır. Bellek kısıtlı: önbellek sınırlıdır (en son kullanılan kalır).
 */

export interface ReplayEnvOptions {
  /** Tasarım dilinin font klasörü. */
  fontDir: string;
  fallbackDirs?: string[];
  /** Şablon PNG'sinin yolu. */
  templatePath: (t: Template) => string;
  /** Referansın kullanıcı görseli (yazı katmanı PNG'si), yoksa null. */
  referenceImagePath?: (ref: Reference) => string | null;
  /** Geometri önbelleği sınırı (varsayılan 64: bir tasarım dilinin bütün şablonları sığsın, yoksa her geçişte yeniden hesaplanır). */
  cacheLimit?: number;
  systemFallbacks?: boolean;
}

export interface ReplayItem {
  ref: Reference;
  metrics: ReplayMetrics;
}

const geometryKey = (t: Template, p: Profile) => JSON.stringify([t, p.output, p.sizing.breathing, p.sizing.edgeMargin]);

export class ReplayEnv {
  private fonts: FontRegistry | null = null;
  private fontsKey = "";
  private readonly cache = new Map<string, Promise<TemplateGeometry>>();

  constructor(readonly opts: ReplayEnvOptions) {}

  async fontsFor(profile: Profile): Promise<FontRegistry> {
    const key = JSON.stringify(profile.fonts.list);
    if (!this.fonts || key !== this.fontsKey) {
      this.fonts = await FontRegistry.create({
        entries: profile.fonts.list,
        fontDir: this.opts.fontDir,
        fallbackDirs: this.opts.fallbackDirs ?? [],
        ...(this.opts.systemFallbacks !== undefined ? { systemFallbacks: this.opts.systemFallbacks } : {}),
      });
      this.fontsKey = key;
    }
    return this.fonts;
  }

  geometry(template: Template, profile: Profile): Promise<TemplateGeometry> {
    const key = geometryKey(template, profile);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = buildGeometry(template, profile, { imagePath: this.opts.templatePath(template) });
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    const limit = this.opts.cacheLimit ?? 64;
    while (this.cache.size > limit) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /** Şablonu olan ve PNG'si bulunan referanslar (tekrar edilebilenler). */
  replayable(refs: readonly Reference[], profile: Profile, templates: ReadonlyMap<string, Template>): Reference[] {
    return refs.filter((r) => {
      if (r.labelFramePx !== profile.output.designFramePx || !r.templateKey) return false;
      const t = templates.get(r.templateKey);
      return !!t && existsSync(this.opts.templatePath(t));
    });
  }

  /** Referansları şablon sırasıyla tekrar oynatır. Hata veren referans `ok: false` metrikle döner. */
  async replayAll(
    refs: readonly Reference[],
    profile: Profile,
    templates: ReadonlyMap<string, Template>,
    onProgress?: (done: number, total: number) => void,
    cancelled?: () => boolean,
  ): Promise<Map<string, ReplayMetrics>> {
    const list = this.replayable(refs, profile, templates).sort((a, b) => (a.templateKey ?? "").localeCompare(b.templateKey ?? ""));
    const fonts = await this.fontsFor(profile);
    const out = new Map<string, ReplayMetrics>();
    let done = 0;
    for (const ref of list) {
      if (cancelled?.()) throw new Error("Durduruldu.");
      const t = templates.get(ref.templateKey!)!;
      try {
        const g = await this.geometry(t, profile);
        out.set(ref.id, await replayReference(ref, profile, g, fonts));
      } catch (err) {
        out.set(ref.id, failed(ref, err));
      }
      onProgress?.(++done, list.length);
      // Uzun döngüde olay döngüsüne nefes (SSE ve diğer istekler beklemesin).
      if (done % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    return out;
  }

  /** Kullanıcının satırlarıyla motor yerleşimi (önizleme için; tekrar düzeneğiyle aynı niyet). */
  async layoutFor(ref: Reference, profile: Profile, template: Template): Promise<{ result: LayoutResult; geometry: TemplateGeometry; fonts: FontRegistry }> {
    const fonts = await this.fontsFor(profile);
    const geometry = await this.geometry(template, profile);
    const { intent, text } = referenceToIntent(ref, profile);
    const result = await layout({ text, intent, profile, geometry, fonts });
    return { result, geometry, fonts };
  }

  /**
   * Hazır bir niyeti (ör. elle düzeltilmiş varyasyonun metni + niyeti) verilen şablonla motora yerleştirir.
   * Elle düzeltmelerden öğrenmede önerilen hedef merkezin önce/sonra ölçümü için.
   */
  async layoutIntent(text: string, intent: DesignIntent, profile: Profile, template: Template): Promise<LayoutResult> {
    const fonts = await this.fontsFor(profile);
    const geometry = await this.geometry(template, profile);
    return layout({ text, intent, profile, geometry, fonts });
  }

  /** Motorun yerleşiminin önizlemesi (şablon + yazı). */
  async preview(ref: Reference, profile: Profile, template: Template, scale = 0.5): Promise<Buffer> {
    const { result, geometry, fonts } = await this.layoutFor(ref, profile, template);
    return renderPreview(result, geometry, fonts, { scale, profile });
  }

  clear(): void {
    this.cache.clear();
  }
}

function failed(ref: Reference, err: unknown): ReplayMetrics {
  return {
    id: ref.id,
    templateKey: ref.templateKey,
    ok: false,
    reason: err instanceof Error ? err.message : String(err),
    lines: ref.user.length,
    sizeRatio: NaN,
    within10: false,
    dx: NaN,
    dy: NaN,
    heightRatio: NaN,
    gaps: [],
    ms: 0,
  };
}
