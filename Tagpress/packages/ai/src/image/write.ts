import { type Box, effectiveCut, fixMsg, type Issue, issueMsg, type Profile, type Shape, scaleShape, type TemplateCutInput, templateImageBox, type Usage } from "@tagpress/domain";
import type { ClaudePort } from "../claude.ts";
import type { ImagePort } from "../gemini.ts";
import { decodeRgba, decodeRgbResized, encodeRgba, nearestAspect, pngFlatResized, type RawImage, shapeMask } from "../images.ts";
import { sameText, transcribe } from "../transcribe.ts";
import { buildRevisePrompt, buildWritePrompt, IMAGE_REVISE_PROMPT_VERSION, IMAGE_WRITE_PROMPT_VERSION } from "./prompts.ts";
import { composeOnTemplate, extractTextLayer, inkHex, type LayerThresholds, type TextLayer, templateUntouched } from "./text-layer.ts";

/**
 * "Şablona yaz": görüntü modeli şablon üstüne yazar → yazı katmanı ayrılır → SONUÇ = ORİJİNAL ŞABLON + SAYDAM
 * YAZI KATMANI. Modelin arka planı hiçbir pikselde kullanılmaz; bu yapı gereği garantidir ve ayrıca doğrulanır.
 * Model şablonu değiştirdiyse (kaydırma, dekoru silme/yeniden çizme) sonuç reddedilir ve yeniden denenir.
 */

export interface ImageDeps {
  gemini: ImagePort;
  /** Görseldeki yazıyı okumak için. Yoksa metin denetimi yapılamaz (checks.textMatches = null + uyarı). */
  claude?: ClaudePort;
}

export interface Acceptance {
  /** Yazı kapsamı aralığı (bölgeye oran). */
  minCoverage: number;
  maxCoverage: number;
  /** Yazı kutusu dışında değişen piksel oranı tavanı. */
  maxDrift: number;
  /** Küme hâlinde dekor değişimi tavanı. */
  maxEdited: number;
}

/** Eski sistemin gerçek örnekleri: değişmemiş şablonda edited ≈ 0, dekor kırpılınca %0,7–2,4; kayma > %12 güvenilmez. */
export const DEFAULT_ACCEPTANCE: Acceptance = { minCoverage: 0.0005, maxCoverage: 0.3, maxDrift: 0.08, maxEdited: 0.004 };

export interface WriteOnTemplateInput {
  /** Şablonun ORİJİNAL PNG'si (saydam olabilir). Sonuç bu görselin piksel boyutundadır. */
  templatePng: Buffer;
  text: string;
  segments?: string[];
  /** Profilin tarz notu. */
  styleNote?: string;
  /** Yazının yeri, sözlü (ör. "inside the empty centre of the wreath, 20%–80% of the width…"). */
  areaHint: string;
  /** Profilden üretilmiş satır bölme ipuçları (`imageProfileHints`). */
  profileHints?: string[];
  aiNote?: string;
  /** Kesim şekli, ŞABLON GÖRSELİ pikselinde (`templateCutShape`). Analiz yalnızca bunun içinde. */
  cut?: Shape;
  /** Revizyon: mevcut bileşik görsel + istenen değişiklik. */
  revision?: { currentPng: Buffer; request: string };
  /** Deneme sayısı (varsayılan 2). */
  attempts?: number;
  /** Metin karşılaştırmasında çevresindeki boşluğu esnek sayılan semboller (profil izin veriyorsa). */
  symbols?: string[];
  acceptance?: Partial<Acceptance>;
  thresholds?: Partial<LayerThresholds>;
  /** Modele gönderilecek kare kenar (varsayılan 1024). */
  modelSize?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface WriteChecks {
  attempts: number;
  coverage: number;
  drift: number;
  edited: number;
  overDecoration: number;
  /** Görselde okunan satırlar (okunamadıysa null). */
  transcript: string[] | null;
  /** Okunan metin müşteri metniyle aynı mı (okunamadıysa null). */
  textMatches: boolean | null;
  /** Bileşikte yazı alfası 0 olan her piksel orijinalle bayt bayt aynı mı (doğrulandı). */
  templateUntouched: boolean;
  /** Ayrımın neden reddedildiği (kabul edildiyse boş). */
  rejectedBecause: string[];
}

export interface WriteOnTemplateResult {
  ok: boolean;
  /** Saydam yazı katmanı, şablonla aynı piksel boyutunda. */
  textLayerPng?: Buffer;
  /** Yazı kutusu (şablon pikseli). */
  textBox?: Box;
  /** Orijinal şablon + yazı katmanı (önizleme). Orijinal şablon ve yazı katmanı ayrı saklanır (şablon pikseline dokunulmaz). */
  compositePng?: Buffer;
  inkColor?: string;
  /** Modelin kendi görseli (şablon boyutunda; yalnızca tanı/revizyon girdisi — SONUÇTA KULLANILMAZ). */
  modelPng?: Buffer;
  checks: WriteChecks;
  usage: Usage[];
  issues: Issue[];
  promptVersion: string;
  prompt: string;
}

/**
 * Kesim şeklini şablon görselinin pikseline çevirir. `template` verilir ve kendi kesimi varsa: şablonun etkin kesimi
 * (`effectiveCut`), görsel `templateImageBox`'a oturur. Kesimsiz şablonda ya da şablon verilmezse eskisi gibi: profilin
 * `output.cut`'ı, görsel profilin `templateBox`'ına oturur (sonuç piksel piksel aynı).
 */
export function templateCutShape(profile: Profile, imageWidth: number, imageHeight: number, template?: { cut?: TemplateCutInput | null; imageBox?: Box | null } | null): Shape {
  const own = template?.cut ? { cut: template.cut, imageBox: template.imageBox ?? null } : null;
  const tb = own ? templateImageBox(own, profile) : profile.output.templateBox;
  const k = imageWidth / tb.w;
  const ky = imageHeight / tb.h;
  const moved = translate(own ? effectiveCut(own, profile).shape : profile.output.cut, -tb.x, -tb.y);
  // Kare değilse x ve y ayrı ölçeklenir; elips/çokgen olarak yaklaşıkla.
  if (Math.abs(k - ky) < 1e-6) return scaleShape(moved, k);
  const b = moved.kind === "circle" ? { kind: "ellipse" as const, cx: moved.cx, cy: moved.cy, rx: moved.r, ry: moved.r } : moved;
  if (b.kind === "ellipse") return { kind: "ellipse", cx: b.cx * k, cy: b.cy * ky, rx: b.rx * k, ry: b.ry * ky };
  if (b.kind === "rect") return { kind: "rect", x: b.x * k, y: b.y * ky, w: b.w * k, h: b.h * ky, radius: b.radius * Math.min(k, ky) };
  if (b.kind === "polygon") return { kind: "polygon", points: b.points.map((p) => ({ x: p.x * k, y: p.y * ky })) };
  return scaleShape(b, k);
}

function translate(s: Shape, dx: number, dy: number): Shape {
  switch (s.kind) {
    case "circle":
    case "ellipse":
      return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    case "rect":
      return { ...s, x: s.x + dx, y: s.y + dy };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

interface Attempt {
  layer: TextLayer;
  reasons: string[];
  textMatches: boolean | null;
  transcript: string[] | null;
  modelRgb: RawImage;
}

export async function writeOnTemplate(deps: ImageDeps, input: WriteOnTemplateInput): Promise<WriteOnTemplateResult> {
  const say = input.onProgress ?? (() => {});
  const acc = { ...DEFAULT_ACCEPTANCE, ...input.acceptance };
  const original = await decodeRgba(input.templatePng);
  const { width: w, height: h } = original;
  const region = input.cut ? shapeMask(input.cut, w, h) : undefined;
  const modelSize = input.modelSize ?? 1024;
  const aspect = nearestAspect(w, h);
  const side = aspect === "1:1" ? [modelSize, modelSize] : w >= h ? [modelSize, Math.round((modelSize * h) / w)] : [Math.round((modelSize * w) / h), modelSize];
  const templateForModel = await pngFlatResized(input.templatePng, side[0]!, side[1]!);
  const promptInput = {
    text: input.text,
    areaHint: input.areaHint,
    ...(input.segments ? { segments: input.segments } : {}),
    ...(input.styleNote ? { styleNote: input.styleNote } : {}),
    ...(input.profileHints ? { profileHints: input.profileHints } : {}),
    ...(input.aiNote ? { aiNote: input.aiNote } : {}),
  };
  const prompt = input.revision ? buildRevisePrompt({ ...promptInput, request: input.revision.request }) : buildWritePrompt(promptInput);
  const images = input.revision ? [templateForModel, await pngFlatResized(input.revision.currentPng, side[0]!, side[1]!)] : [templateForModel];
  const promptVersion = input.revision ? IMAGE_REVISE_PROMPT_VERSION : IMAGE_WRITE_PROMPT_VERSION;

  const usage: Usage[] = [];
  const issues: Issue[] = [];
  const maxAttempts = Math.max(1, Math.min(4, input.attempts ?? 2));
  let best: Attempt | null = null;
  let attempts = 0;
  let lastError: string | null = null;

  const score = (a: Attempt) => (a.reasons.length ? 0 : 2) + (a.textMatches === true ? 1 : 0);

  while (attempts < maxAttempts) {
    attempts++;
    say(`Görüntü isteniyor (${attempts}. deneme) · ${deps.gemini.model}`);
    const gen = await deps.gemini.generate({ prompt, images, aspectRatio: aspect, ...(input.signal ? { signal: input.signal } : {}) });
    usage.push(gen.usage);
    if (!gen.ok || !gen.png) {
      lastError = gen.error?.message ?? "Görsel gelmedi.";
      say(`Görsel gelmedi: ${lastError}`);
      if (gen.error?.config || gen.error?.kind === "aborted") {
        issues.push({ ...issueMsg("image-model-unavailable", { detail: lastError }), severity: "error", fixes: [] });
        return emptyResult(false);
      }
      continue;
    }
    const modelRgb = await decodeRgbResized(gen.png, w, h);
    const layer = extractTextLayer(original, modelRgb, { ...(region ? { region } : {}), ...(input.thresholds ? { thresholds: input.thresholds } : {}) });
    const reasons: string[] = [];
    if (!layer.box || layer.coverage < acc.minCoverage) reasons.push("yazı bulunamadı");
    if (layer.coverage > acc.maxCoverage) reasons.push(`yazı sanılan alan çok büyük (%${(layer.coverage * 100).toFixed(1)}): model zemini boyamış`);
    if (layer.drift > acc.maxDrift) reasons.push(`yazı dışında şablon değişmiş (%${(layer.drift * 100).toFixed(1)})`);
    if (layer.edited > acc.maxEdited) reasons.push(`model dekoru değiştirmiş (%${(layer.edited * 100).toFixed(2)})`);
    // Kabul ölçüleri günlüğe yazılır: eşiklere uyum sonradan doğrulanabilsin (başka yerde saklanmıyor).
    say(`Ayrım ölçüleri: kapsam ${layer.coverage.toFixed(4)}, kayma ${layer.drift.toFixed(4)} (≤ ${acc.maxDrift}), dekor değişimi ${layer.edited.toFixed(4)} (≤ ${acc.maxEdited})`);

    let transcript: string[] | null = null;
    let textMatches: boolean | null = null;
    if (!reasons.length && deps.claude) {
      const { composite } = composeOnTemplate(original, layer);
      const read = await transcribe(deps.claude, await encodeRgba(composite), input.signal ? { signal: input.signal } : {});
      usage.push(...read.usage);
      if (read.ok) {
        transcript = read.lines;
        textMatches = sameText(read.text, input.text, input.symbols ?? []);
        say(textMatches ? `Yazı kontrolü: müşteri metniyle aynı (görselde: ${read.lines.join(" / ")})` : `Yazı kontrolü: FARKLI (görselde: ${read.lines.join(" / ")})`);
      } else say(`Yazı okunamadı: ${read.error?.message ?? ""}`);
    } else if (reasons.length) say(`Ayrım reddedildi: ${reasons.join("; ")}`);

    const att: Attempt = { layer, reasons, textMatches, transcript, modelRgb };
    if (!best || score(att) > score(best)) best = att;
    if (!reasons.length && textMatches !== false) break; // tuttu ya da denetlenemiyor
  }

  if (!best) {
    issues.push({ ...(lastError ? issueMsg("image-generation-failed", { detail: lastError }) : issueMsg("image-generation-failed-unknown")), severity: "error", fixes: [fixMsg("retry")] });
    return emptyResult(false);
  }

  const { layer } = best;
  const checksBase = { attempts, coverage: layer.coverage, drift: layer.drift, edited: layer.edited, overDecoration: layer.overDecoration, transcript: best.transcript, textMatches: best.textMatches, rejectedBecause: best.reasons };
  if (best.reasons.length) {
    issues.push({
      ...issueMsg("image-template-changed-reasons", { reasons: best.reasons.join("; ") }),
      severity: "error",
      fixes: [fixMsg("retry")],
    });
    return { ...emptyResult(false), modelPng: await encodeRgba(best.modelRgb), checks: { ...checksBase, templateUntouched: false } };
  }

  const { layer: layerImg, composite } = composeOnTemplate(original, layer);
  const untouched = templateUntouched(original, composite, layer.alpha);
  if (!untouched) {
    // Yapı gereği olmamalı; olursa sonuç kesinlikle kullanılmaz.
    issues.push({ ...issueMsg("image-template-changed-internal"), severity: "error", fixes: [] });
  }
  if (best.textMatches === false) {
    issues.push({
      ...issueMsg("image-text-different", { text: (best.transcript ?? []).join(" / ") }),
      severity: "error",
      fixes: [fixMsg("retry")],
    });
  } else if (best.textMatches === null) {
    issues.push({ ...issueMsg("image-text-unreadable"), severity: "warning", fixes: [] });
  }
  return {
    ok: untouched && best.textMatches !== false,
    textLayerPng: await encodeRgba(layerImg),
    textBox: layer.box!,
    compositePng: await encodeRgba(composite),
    inkColor: inkHex(layer.ink),
    modelPng: await encodeRgba(best.modelRgb),
    checks: { ...checksBase, templateUntouched: untouched },
    usage,
    issues,
    promptVersion,
    prompt,
  };

  function emptyResult(ok: boolean): WriteOnTemplateResult {
    return {
      ok,
      checks: { attempts, coverage: 0, drift: 0, edited: 0, overDecoration: 0, transcript: null, textMatches: null, templateUntouched: false, rejectedBecause: [] },
      usage,
      issues,
      promptVersion,
      prompt,
    };
  }
}

export interface ReviseImageInput extends Omit<WriteOnTemplateInput, "revision"> {
  /** Mevcut varyasyonun bileşik görseli. */
  currentPng: Buffer;
  request: string;
}

/** Görsel varyasyonda "şunu değiştir". Şablon yine korunur: sonuç = orijinal şablon + yeni yazı katmanı. */
export function reviseImage(deps: ImageDeps, input: ReviseImageInput): Promise<WriteOnTemplateResult> {
  const { currentPng, request, ...rest } = input;
  return writeOnTemplate(deps, { ...rest, revision: { currentPng, request } });
}
