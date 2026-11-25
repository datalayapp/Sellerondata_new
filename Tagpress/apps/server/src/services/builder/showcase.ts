import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type BuildLabelType,
  type DesignIntent,
  type Profile,
  type Reference,
  type RuleChange,
  type SampleLine,
  type ShowcaseItem,
  type Template,
  TemplateSchema,
} from "@tagpress/domain";
import { referenceToIntent } from "@tagpress/engine";
import type { Ports } from "../../ports.ts";
import { errorMessage } from "../../util/errors.ts";
import { writeAtomic } from "../../util/files.ts";
import { PNG, safeJoin } from "../../util/safe-path.ts";
import { TargetResolver } from "../generation/target.ts";
import { layoutSignature } from "../generation/text-flow.ts";
import type { TemplateService } from "../templates.ts";
import { simpleIntent } from "../trial/intent.ts";
import { changeDirection } from "./revisions.ts";

/**
 * Örnek etiketler (SUNUCU-PLANI §4.5): revizyon başına ücretsiz motorla yerleşim. Kaynaklar:
 *  - `sample`: yüklenen örneğin satırları (kullanıcının kendi bölmesi; boyut sınıfı mürekkep yüksekliğinden);
 *  - `reference`: firmanın referansı (`referenceToIntent`, motor denemesiyle aynı yöntem);
 *  - `preset`: kurulumdaki türe göre hazır örnek metin, deterministik niyetle (`simpleIntent`).
 * Her örnek için önceki revizyonla yerleşim imzası (`layoutSignature`) karşılaştırılır: `changed` ve not (bu
 * revizyonun değişen kurallarından). Görseller `tasarim-oturumlari/<oturum>/vitrin/<rev>/` altında saklanır.
 *
 * Örnek metinler içeriktir (müşteri metni gibi; çevrilmez, tarz değildir); arayüz metni değildir.
 */

export const PRESET_TEXTS: Record<"tr" | "en", Record<BuildLabelType, readonly string[]>> = {
  tr: {
    wedding: ["Ayşe & Mehmet 14.06.2026", "Elif & Can"],
    baptism: ["Deniz'in Vaftizi 12 Nisan 2026"],
    birthday: ["İyi ki doğdun Zeynep! 5 yaş"],
    thanks: ["Bizi yalnız bırakmadığınız için teşekkürler"],
    product: ["Lavanta Kolonyası 250 ml"],
    sticker: ["Mutlu Yıllar"],
  },
  en: {
    wedding: ["Emma & James 14.06.2026", "Lily & Noah"],
    baptism: ["Baptism of Grace 12 April 2026"],
    birthday: ["Happy Birthday Mia! 5 years"],
    thanks: ["Thank you for sharing our day"],
    product: ["Lavender Cologne 250 ml"],
    sticker: ["Happy New Year"],
  },
};

/** Gösterilecek bir örneğin tanımı (profilden bağımsız). */
export interface ShowcaseSpec {
  id: string;
  labelType: BuildLabelType | null;
  sampleId: string | null;
  source: ShowcaseItem["source"];
  templateKey: string | null;
  /** Niyet ve metin (profile göre; satır bölmesi ve fontlar profilden). */
  intent: (profile: Profile) => { intent: DesignIntent; text: string };
  text: string;
}

const ITEM_ID = /^[A-Za-z0-9_-]{1,120}$/;

/** Örneğin satırlarından niyet: kullanıcının bölmesi aynen; boyut sınıfı mürekkep yüksekliğinden (yoksa eşit). */
export function sampleLinesIntent(lines: readonly SampleLine[], profile: Profile, templateKey: string | null): { intent: DesignIntent; text: string } {
  const rows = lines.filter((l): l is SampleLine & { text: string } => typeof l.text === "string" && l.text.trim() !== "");
  const ref: Reference = {
    id: "vitrin",
    languageId: "",
    source: "uploaded",
    orderNo: null,
    quantity: null,
    templateKey,
    labelFramePx: profile.output.designFramePx,
    text: rows.map((l) => l.text).join(" "),
    user: rows.map((l) => {
      const sizePx = l.ink && l.ink.h > 0 ? l.ink.h : 1;
      return { text: l.text, family: "", style: "", sizePx, segments: [{ text: l.text, family: "", style: "", sizePx }], ink: l.ink ?? { x: 0, y: 0, w: 0, h: 0 } };
    }),
    program: null,
    programMeta: null,
    image: null,
    split: "train",
    createdAt: "",
  };
  return referenceToIntent(ref, profile);
}

export function presetSpecs(labelTypes: readonly BuildLabelType[], locale: "tr" | "en", templateKey: string | null): ShowcaseSpec[] {
  const types = labelTypes.length ? labelTypes : (["wedding"] as const);
  return types.flatMap((t) =>
    PRESET_TEXTS[locale][t].map((text, i) => ({
      id: `p-${locale}-${t}-${i}`,
      labelType: t,
      sampleId: null,
      source: "preset" as const,
      templateKey,
      text,
      intent: (p: Profile) => simpleIntent(text, p),
    })),
  );
}

export function referenceSpecs(refs: readonly Reference[], limit: number): ShowcaseSpec[] {
  return refs.slice(0, limit).map((r, i) => ({
    id: `r-${i}`,
    labelType: null,
    sampleId: null,
    source: "reference" as const,
    templateKey: r.templateKey,
    text: r.text,
    intent: (p: Profile) => referenceToIntent(r, p),
  }));
}

/** Profilin geometriye giren kısmından önbellek sürümü (geometri önbelleği profil sürümüne göre tutulur). */
export function profileKey(p: Profile): number {
  return Number.parseInt(createHash("sha1").update(JSON.stringify(p)).digest("hex").slice(0, 8), 16);
}

interface Rendered {
  sig: string | null;
  error: ShowcaseItem["error"];
}

export class ShowcaseRenderer {
  private readonly targets: TargetResolver;

  constructor(
    private readonly ports: Ports,
    private readonly templates: TemplateService,
    private readonly fontsDir: (languageId: string) => string,
  ) {
    this.targets = new TargetResolver(ports, templates);
  }

  /** Dilin şablonları (geçerli kayıtlar), anahtara göre. */
  templateList(languageId: string): Template[] {
    return this.templates
      .list(languageId)
      .flatMap((i) => {
        const r = TemplateSchema.safeParse(i.template);
        return r.success ? [r.data] : [];
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Bir örneğin yerleşimi; `png` verilirse çizilir. */
  private async place(languageId: string, spec: ShowcaseSpec, profile: Profile, png: string | null): Promise<Rendered> {
    const engine = this.ports.engine;
    if (!engine) return { sig: null, error: { code: "engine-unavailable" } };
    if (!spec.templateKey) return { sig: null, error: { code: "no-template" } };
    try {
      const { intent, text } = spec.intent(profile);
      const target = await this.targets.resolve({ language_id: languageId, template_key: spec.templateKey, kind: "label" }, profile, profileKey(profile));
      const fontsDir = this.fontsDir(languageId);
      const layout = await engine.layout({ intent, text, profile, geometry: target.geometry, fontsDir });
      if (!layout.ok) return { sig: null, error: { code: "layout-failed" } };
      if (png) await writeAtomic(png, await engine.render({ layout, geometry: target.geometry, profile, templatePath: target.templatePath, fontsDir }));
      return { sig: layoutSignature(intent, layout), error: null };
    } catch (err) {
      return { sig: null, error: { code: "layout-failed", params: { detail: errorMessage(err).slice(0, 200) } } };
    }
  }

  /**
   * Revizyonun örnek etiketleri. `prev` verilirse (önceki revizyonun profili) her örnek onunla da yerleştirilir ve
   * imza karşılaştırılır. Görseller `dir` altına `<id>.png`; adres `url(id)`.
   */
  async render(input: {
    languageId: string;
    specs: readonly ShowcaseSpec[];
    profile: Profile;
    prev: Profile | null;
    changes: readonly RuleChange[];
    dir: string;
    url: (itemId: string) => string;
  }): Promise<ShowcaseItem[]> {
    const items: ShowcaseItem[] = [];
    const note = noteOf(input.changes);
    for (const spec of input.specs) {
      if (!ITEM_ID.test(spec.id)) continue;
      const file = path.join(input.dir, `${spec.id}.png`);
      const now = await this.place(input.languageId, spec, input.profile, file);
      const before = input.prev && !now.error ? await this.place(input.languageId, spec, input.prev, null) : null;
      const changed = !!before && before.sig !== now.sig;
      items.push({
        id: spec.id,
        labelType: spec.labelType,
        sampleId: spec.sampleId,
        text: spec.text,
        templateKey: spec.templateKey,
        size: null,
        sizeMm: null,
        previewUrl: now.error ? "" : input.url(spec.id),
        changed,
        note: changed ? note : [],
        source: spec.source,
        error: now.error,
      });
    }
    return items;
  }

  /** Saklanan görsel (yalnız `dir` altındaki `<id>.png`). */
  async image(dir: string, itemId: string): Promise<Buffer | null> {
    if (!ITEM_ID.test(itemId)) return null;
    const file = safeJoin(dir, `${itemId}.png`, { ext: PNG });
    return file && existsSync(file) ? readFile(file) : null;
  }
}

/** Değişen kurallardan kısa not (etiket anahtarı + yön; en çok 3, tekrarsız). */
export function noteOf(changes: readonly RuleChange[]): ShowcaseItem["note"] {
  const out: ShowcaseItem["note"] = [];
  for (const c of changes) {
    if (out.some((n) => n.label === c.label)) continue;
    out.push({ label: c.label, direction: changeDirection(c) });
    if (out.length >= 3) break;
  }
  return out;
}
