import { FakeBuilderModel, type FakeScript, fake } from "@tagpress/ai/builder/testing";
import type { BuilderModelPort } from "@tagpress/ai";
import sharp from "sharp";
import type { BuilderTranscriber } from "../services/builder/service.ts";
import { type TestApp, fullPorts, makeApp, seedLanguage } from "./helpers.ts";

/**
 * Oluşturucu testlerinin ortak kurulumu: sahte model (betikli, ücretsiz), sahte okuma, sahte motor/geometri.
 * `model.set(...)` ile betik değiştirilir; `model.off()` anahtarsız kurulumu taklit eder (409 `missing-key`).
 */
export interface BuilderHarness {
  t: TestApp;
  lang: string;
  model: {
    current: FakeBuilderModel | null;
    set(script: FakeScript[]): FakeBuilderModel;
    off(): void;
  };
  transcriber: { lines: string[]; calls: number };
  /** Çalışan işlerin (tur, ölçüm) bitmesini bekler. */
  idle(): Promise<void>;
}

export async function builderHarness(opts: { dir?: string; script?: FakeScript[]; transcribe?: string[]; seed?: boolean } = {}): Promise<BuilderHarness> {
  const model: BuilderHarness["model"] = {
    current: opts.script ? new FakeBuilderModel(opts.script) : null,
    set(script) {
      this.current = new FakeBuilderModel(script);
      return this.current;
    },
    off() {
      this.current = null;
    },
  };
  const transcriber: BuilderHarness["transcriber"] = { lines: opts.transcribe ?? ["Ayşe & Mehmet", "14.06.2026"], calls: 0 };
  const port: BuilderTranscriber = {
    transcribe: async () => {
      transcriber.calls++;
      return { ok: true, lines: [...transcriber.lines], usage: [{ model: "claude-haiku-5-5", inputTokens: 900, outputTokens: 40 }] };
    },
  };
  const t = await makeApp({
    ...(opts.dir ? { dir: opts.dir } : {}),
    ports: fullPorts(),
    builder: { model: () => model.current as BuilderModelPort | null, transcriber: () => port, loop: { sleep: async () => undefined } },
  });
  const lang = opts.seed === false ? "" : await seedLanguage(t);
  return { t, lang, model, transcriber, idle: () => t.inOrg(() => t.ctx.builder.idle()) };
}

/**
 * Düz zeminde iki satırlık "yazı" (ince koyu çubuklar, harf gövdesi gibi): `ink` kalitesinde ölçülür (iki mürekkep
 * satırı). Dolu dikdörtgen "kalın" sayılır ve `none` olur (sayı yok); ölçüm kanıtı isteyen senaryolar bunu kullanır.
 */
export async function samplePng(): Promise<Buffer> {
  const W = 600;
  const bars = (x0: number, y: number, w: number, h: number, step: number) => {
    let s = "";
    for (let x = x0; x < x0 + w; x += step) s += `<rect x="${x}" y="${y}" width="${Math.max(2, Math.round(step / 3))}" height="${h}" fill="#111"/>`;
    return s;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="100%" height="100%" fill="#fff"/>${bars(150, 220, 300, 60, 12)}${bars(220, 320, 160, 28, 8)}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Sık kullanılan model yanıtları. */
export const say = {
  ask: (questions: unknown[], text = "Birkaç sorum var.") => fake.reply([fake.text(text), fake.tool("ask_user", { questions })]),
  propose: (changes: unknown[], note = "Taslak") => fake.reply([fake.tool("propose_changes", { note, changes })]),
  done: (text = "Özet: taslak hazır.") => fake.reply([fake.text(text)]),
};

export const q = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  group: "satir-bolme",
  text: `Soru ${id}?`,
  options: [{ label: "Evet", value_json: "true" }, { label: "Hayır", value_json: "false" }],
  free: true,
  ...extra,
});

export { fake };
