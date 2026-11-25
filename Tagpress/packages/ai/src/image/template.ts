import { fixMsg, type Issue, issueMsg, type Shape, scaleShape, type Usage } from "@tagpress/domain";
import sharp from "sharp";
import { decodeRgbResized, encodeRgba, nearestAspect, type RawImage, shapeMask, shapeSvg } from "../images.ts";
import { transcribe } from "../transcribe.ts";
import { buildTemplatePrompt, TEMPLATE_PROMPT_VERSION } from "./prompts.ts";
import type { ImageDeps } from "./write.ts";

/**
 * Temadan yazısız yeni şablon. Modele kesim şekli çizili kılavuz tuval verilir (eski ders: verilmezse etiketi
 * küçük bir daireye çizip dışta beyaz halka bırakıyordu). Çıktı kesim şekline maskelenir (dışı saydam) ve
 * görselde yazı olmadığı okunarak denetlenir; yazı varsa yeniden denenir.
 */

export interface GenerateTemplateInput {
  theme: string;
  styleNotes?: string;
  /** Kesim şekli, `sizePx` kenarlı karede piksel. */
  cut: Shape;
  /** Çıktı kenarı (kare). */
  sizePx: number;
  /** Tarz referansı (isteğe bağlı). */
  reference?: Buffer;
  attempts?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface GenerateTemplateResult {
  ok: boolean;
  /** Kesim şekline maskelenmiş RGBA PNG (sizePx × sizePx). */
  png?: Buffer;
  checks: { attempts: number; textFound: string[] | null };
  usage: Usage[];
  issues: Issue[];
  promptVersion: string;
  prompt: string;
}

/** Beyaz kare + ince gri kesim çizgisi. */
export async function cutGuidePng(cut: Shape, sizePx: number): Promise<Buffer> {
  const stroke = Math.max(2, Math.round(sizePx / 340));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}"><rect width="100%" height="100%" fill="#ffffff"/>${shapeSvg(cut, `fill="none" stroke="#b0b0b0" stroke-width="${stroke}"`)}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Görseli kesim şekline maskeler: dışı tamamen saydam, kenar yumuşatılmış. */
export function maskToShape(img: RawImage, cut: Shape): RawImage {
  const mask = shapeMask(cut, img.width, img.height);
  const n = img.width * img.height;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const srcA = img.channels === 4 ? img.data[4 * i + 3]! : 255;
    for (let c = 0; c < 3; c++) out[4 * i + c] = img.data[img.channels * i + c]!;
    out[4 * i + 3] = Math.round((srcA * mask[i]!) / 255);
  }
  return { width: img.width, height: img.height, channels: 4, data: out };
}

export async function generateTemplate(deps: ImageDeps, input: GenerateTemplateInput): Promise<GenerateTemplateResult> {
  const say = input.onProgress ?? (() => {});
  const prompt = buildTemplatePrompt({ theme: input.theme, ...(input.styleNotes ? { styleNotes: input.styleNotes } : {}), hasReference: !!input.reference });
  // Kılavuz en az 512, en çok 1024 px; kesim şekli `sizePx` ölçeğinden kılavuz ölçeğine çevrilir.
  const guideSize = Math.min(1024, Math.max(512, input.sizePx));
  const guide = await cutGuidePng(scaleShape(input.cut, guideSize / input.sizePx), guideSize);
  const images = [guide, ...(input.reference ? [input.reference] : [])];
  const usage: Usage[] = [];
  const issues: Issue[] = [];
  const maxAttempts = Math.max(1, Math.min(4, input.attempts ?? 2));
  let attempts = 0;
  let lastError = "";
  let fallback: { png: Buffer; text: string[] } | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    say(`Şablon görseli isteniyor (${attempts}. deneme)`);
    const gen = await deps.gemini.generate({ prompt, images, aspectRatio: nearestAspect(1, 1), ...(input.signal ? { signal: input.signal } : {}) });
    usage.push(gen.usage);
    if (!gen.ok || !gen.png) {
      lastError = gen.error?.message ?? "Görsel gelmedi.";
      if (gen.error?.config || gen.error?.kind === "aborted") break;
      continue;
    }
    const rgb = await decodeRgbResized(gen.png, input.sizePx, input.sizePx);
    const png = await encodeRgba(maskToShape(rgb, input.cut));
    if (!deps.claude) {
      issues.push({ ...issueMsg("template-text-unchecked"), severity: "warning", fixes: [] });
      return { ok: true, png, checks: { attempts, textFound: null }, usage, issues, promptVersion: TEMPLATE_PROMPT_VERSION, prompt };
    }
    const read = await transcribe(deps.claude, png, input.signal ? { signal: input.signal } : {});
    usage.push(...read.usage);
    const found = read.ok ? read.lines.filter((l) => /[\p{L}\p{N}]/u.test(l)) : null;
    if (found && !found.length) return { ok: true, png, checks: { attempts, textFound: [] }, usage, issues, promptVersion: TEMPLATE_PROMPT_VERSION, prompt };
    say(found ? `Şablonda yazı bulundu (${found.join(" / ")}); yeniden deneniyor` : "Şablon okunamadı");
    fallback = { png, text: found ?? [] };
  }

  if (fallback) {
    issues.push({
      ...(fallback.text.length ? issueMsg("template-has-text", { text: fallback.text.join(" / ") }) : issueMsg("template-text-unreadable")),
      severity: "error",
      fixes: [fixMsg("regenerate")],
    });
    return { ok: false, png: fallback.png, checks: { attempts, textFound: fallback.text }, usage, issues, promptVersion: TEMPLATE_PROMPT_VERSION, prompt };
  }
  issues.push({ ...issueMsg("template-generation-failed", { detail: String(lastError) }), severity: "error", fixes: [fixMsg("regenerate")] });
  return { ok: false, checks: { attempts, textFound: null }, usage, issues, promptVersion: TEMPLATE_PROMPT_VERSION, prompt };
}
