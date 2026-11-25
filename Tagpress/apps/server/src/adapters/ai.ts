import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type AiFailure,
  type CallLog,
  type ClaudePort,
  type DesignContext,
  type ImagePort,
  type TemplateSummary,
  createClaude,
  createGemini,
  fontCatalog,
  generateTemplate,
  imageProfileHints,
  preservationSymbols,
  proposeDesigns,
  pickSimilarExamples,
  type BreakExample,
  rankCandidates,
  templateCutShape,
  writeOnTemplate,
} from "@tagpress/ai";
import { AI_REJECT_KIND, type AiRejectCode, MODELS, type Profile, type TemplateGeometry, type Usage, isAiRejectCode, shapeCutDiameter } from "@tagpress/domain";
import { checkIntentRules, templateLayer } from "@tagpress/engine";
import { renderOverlay } from "@tagpress/templates";
import { type FontRegistry, fontMetricsPx, shapeRun } from "@tagpress/typeset";
import sharp, { type OverlayOptions } from "sharp";
import type { AiCallRecord, AiErrorLike, Designer, ImageGenerator, KeyTester, PortDeps } from "../ports.ts";
import { maybeOrg } from "../org/context.ts";
import { HttpError, fail } from "../util/errors.ts";
import { AiBusyError } from "./ai-busy.ts";
import type { AiGateway } from "./ai-gateway.ts";
import type { FontRegistryCache } from "./fonts.ts";

/**
 * ai paketine bağlantı: tasarımcı (Claude: niyet adayları, aday sıralama) ve görüntü üretimi
 * (Gemini: şablona yaz, temadan şablon; görseldeki yazıyı Claude okur).
 * - Yerel kip: anahtarlar her çağrıda ayarlardan (şifreli kayıttan çözülmüş) alınır; anahtar yoksa açık bir hata verilir.
 * - Platform kipi (`platformAi`): istemciler SellerOnData yapay zekâ geçidine gider (`ai-gateway.ts`), anahtar okunmaz.
 *   Geçidin reddi (hak doldu, platform durdu, anahtar yok) kodlu hataya çevrilir (`AiRejectError`), yeniden denenmez.
 */

/** Her tasarım çağrısına giden benzer geçmiş örnek sayısı. */
const SIMILAR_EXAMPLES = 6;

export const NO_ANTHROPIC_KEY = "Anthropic anahtarı yok: Ayarlar → Bağlantılar'dan Anthropic anahtarını girin.";
export const NO_GEMINI_KEY = "Gemini anahtarı yok: Ayarlar → Bağlantılar'dan Google Gemini anahtarını girin.";

export interface AiAdapterDeps {
  /** Yerel kip: kayıtlı anahtar. Platform kipinde (`platformAi`) hiç çağrılmaz. */
  apiKey: PortDeps["apiKey"];
  /** Platform kipi: istemciler yalnız yapay zekâ geçidine gider; geçit yoksa (null) açık hata `ai-unavailable`. */
  platformAi?: PortDeps["platformAi"];
  /** Platform kipi, testler: geçit istemcilerinin ağı (gerçek SDK + sahte `fetch`). */
  fetch?: typeof fetch;
  referenceImages?: PortDeps["referenceImages"];
  breakExamples?: PortDeps["breakExamples"];
  /** Benzer örneklerin şablonlarındaki yazı alanı en/boy oranı (yoksa örnekler oransız gider). */
  templateAspect?: PortDeps["templateAspect"];
  fonts: FontRegistryCache;
  /** Testler: sahte istemci fabrikaları (varsayılan gerçek `createClaude` / `createGemini`). Platform kipinde jetonla çağrılır. */
  claude?: (apiKey: string) => ClaudePort;
  gemini?: (apiKey: string) => ImagePort;
}

function aiError(message: string, calls: AiCallRecord[]): AiErrorLike {
  const err = new Error(message) as AiErrorLike;
  err.calls = calls;
  return err;
}

/** Geçidin reddi kullanıcıya kodlu hata olarak çıkar (`budget-exceeded`, `ai-paused`, `ai-unavailable`); çağrı kayıtlarını taşır. */
export class AiRejectError extends HttpError implements AiErrorLike {
  calls: AiCallRecord[];
  constructor(
    readonly reject: AiRejectCode,
    calls: AiCallRecord[],
  ) {
    const kind = AI_REJECT_KIND[reject];
    const base = kind === "cap" ? fail("budget-exceeded") : kind === "paused" ? fail("ai-paused") : fail("ai-unavailable");
    super(base.status, base.message, undefined, base.code, base.params);
    this.calls = calls;
  }
}

export { AiBusyError };

/** Akışın başarısızlığı: geçit reddettiyse kodlu hata (cap/paused/unavailable) ya da yoğunluk (`AiBusyError`), değilse bugünkü `aiError`. */
function flowError(message: string, calls: AiCallRecord[], rejects: readonly AiFailure[]): AiErrorLike {
  const code = rejects.map((f) => f.reject).find((c): c is AiRejectCode => isAiRejectCode(c) && ["cap", "paused", "unavailable"].includes(AI_REJECT_KIND[c]));
  if (code) return new AiRejectError(code, calls);
  const busy = rejects.find((f) => isAiRejectCode(f.reject) && AI_REJECT_KIND[f.reject] === "busy");
  return busy ? new AiBusyError(busy.message, calls, busy.retryAfterMs) : aiError(message, calls);
}

/** Görülen geçit retleri (bir akış çağrısı boyunca; istemciler süreç geneli paylaşıldığından istemci başına değil). */
function trackClaude(c: ClaudePort, seen: AiFailure[]): ClaudePort {
  return {
    model: c.model,
    async callJson(req) {
      const r = await c.callJson(req);
      for (const call of r.calls) if (call.error?.reject) seen.push(call.error);
      return r;
    },
  };
}

function trackGemini(g: ImagePort, seen: AiFailure[]): ImagePort {
  return {
    model: g.model,
    async generate(req) {
      const r = await g.generate(req);
      if (r.error?.reject) seen.push(r.error);
      return r;
    },
  };
}

/** Claude deneme kayıtlarını sunucu çağrı kayıtlarına çevirir (tam istem saklanmaz). */
export function callRecords(purpose: string, model: string, calls: readonly CallLog[], summary = ""): AiCallRecord[] {
  return calls.map((c) => {
    const gatewayCallId = c.usage?.gatewayCallId ?? c.error?.gatewayCallId ?? null;
    return {
      purpose,
      model: c.usage?.model ?? model,
      summary: [summary, `${c.kind} (deneme ${c.attempt})`, c.issues?.length ? `sorunlar: ${c.issues.slice(0, 3).join(" | ")}` : ""].filter(Boolean).join(" · "),
      response: c.raw,
      error: c.error ? c.error.message : null,
      usage: c.usage,
      durationMs: c.ms,
      ...(gatewayCallId ? { gatewayCallId } : {}),
    };
  });
}

/** Görüntü akışlarının kullanım kayıtları (Gemini görseli + Claude okuması). */
function usageRecords(usage: readonly Usage[], summary: string): AiCallRecord[] {
  return usage.map((u) => ({
    purpose: u.model.startsWith("gemini") ? "image" : "transcribe",
    model: u.model,
    summary,
    response: "",
    error: null,
    usage: u,
    durationMs: 0,
    ...(u.gatewayCallId ? { gatewayCallId: u.gatewayCallId } : {}),
  }));
}

function makeClients(deps: AiAdapterDeps) {
  if (deps.platformAi) return gatewayClients(deps, deps.platformAi.gateway);
  const claudeCache = new Map<string, ClaudePort>();
  const geminiCache = new Map<string, ImagePort>();
  const claude = (): ClaudePort => {
    const key = deps.apiKey("anthropic");
    if (!key) throw new Error(NO_ANTHROPIC_KEY);
    let c = claudeCache.get(key);
    if (!c) {
      c = deps.claude ? deps.claude(key) : createClaude({ apiKey: key, model: MODELS.daily });
      claudeCache.clear();
      claudeCache.set(key, c);
    }
    return c;
  };
  const optionalClaude = (): ClaudePort | undefined => (deps.apiKey("anthropic") ? claude() : undefined);
  const gemini = (): ImagePort => {
    const key = deps.apiKey("gemini");
    if (!key) throw new Error(NO_GEMINI_KEY);
    let g = geminiCache.get(key);
    if (!g) {
      g = deps.gemini ? deps.gemini(key) : createGemini({ apiKey: key, model: MODELS.image });
      geminiCache.clear();
      geminiCache.set(key, g);
    }
    return g;
  };
  return { claude, optionalClaude, gemini };
}

/**
 * Platform kipi: geçit istemcileri (süreç başına birer tane; bağlam başlıkları çağrı anında `AiGateway.headers`'tan).
 * Anahtar okunmaz (`deps.apiKey` çağrılmaz); geçit adresi boşsa her çağrı 409 `ai-unavailable` (anahtara düşülmez).
 */
function gatewayClients(deps: AiAdapterDeps, gw: AiGateway | null) {
  let c: ClaudePort | null = null;
  let g: ImagePort | null = null;
  const fetchOpt = deps.fetch ? { fetch: deps.fetch } : {};
  const claude = (): ClaudePort => {
    if (!gw) throw fail("ai-unavailable");
    c ??= deps.claude ? deps.claude(gw.token) : createClaude({ apiKey: gw.token, baseURL: gw.anthropicBaseUrl, model: MODELS.daily, gateway: gw.options(), ...fetchOpt });
    return c;
  };
  const gemini = (): ImagePort => {
    if (!gw) throw fail("ai-unavailable");
    g ??= deps.gemini ? deps.gemini(gw.token) : createGemini({ apiKey: gw.token, baseUrl: gw.geminiBaseUrl, model: MODELS.image, gateway: gw.options(), ...fetchOpt });
    return g;
  };
  return { claude, optionalClaude: (): ClaudePort | undefined => (gw ? claude() : undefined), gemini };
}

// ---------------------------------------------------------------- tasarım bağlamı

/** Fontun basamadığı ama profilin başka bir metin fontunun basabildiği karakterler (yedekle basılanlar sayılmaz). */
function missingGlyphs(reg: FontRegistry | null, profile: Profile, text: string): Record<string, string[]> {
  if (!reg) return {};
  const textFonts = profile.fonts.list.filter((f) => f.enabled && f.roles.length);
  const loaded = textFonts.filter((f) => reg.has(f.id));
  if (!loaded.length) return {};
  const out: Record<string, string[]> = {};
  for (const f of textFonts) {
    if (!reg.has(f.id)) {
      out[f.id] = ["(font dosyası yok)"];
      continue;
    }
    const miss = reg.missing(f.id, text).filter((g) => loaded.some((o) => o.id !== f.id && reg.covers(o.id, g)));
    if (miss.length) out[f.id] = miss;
  }
  return out;
}

/** Şablonun AI'a giden özeti: alan oranı ve alanın birkaç yüksekliğinde tipik puntoda kaç karakter sığdığı. */
export function templateSummary(req: { template: { key: string; notes: string; tags: string[]; ribbonTop: number; printedText: boolean } | null; geometry: TemplateGeometry; profile: Profile }, reg: FontRegistry | null): TemplateSummary {
  const g = req.geometry;
  const a = g.areaBounds;
  const out: TemplateSummary = {
    key: req.template?.key ?? g.key,
    ...(req.template?.notes ? { notes: req.template.notes } : {}),
    ...(req.template?.tags.length ? { tags: req.template.tags } : {}),
    areaAspect: a.h > 0 ? Math.round((a.w / a.h) * 100) / 100 : 1,
    ribbonTop: req.template?.ribbonTop ?? 0,
    printedText: req.template?.printedText ?? false,
    darkBackground: g.background.dark,
  };
  const primary = req.profile.fonts.list.find((f) => f.enabled && f.roles.includes("primary") && reg?.has(f.id));
  if (reg && primary && a.h > 0) {
    // Tipik ana puntoyu harf yüksekliği tavanı ve alanın iki-üç satırlık yüksekliğinden kaba tahmin et.
    const unit = fontMetricsPx(reg, primary.id, 100);
    const capRatio = unit.capHeight / 100 || 0.7;
    // Harf yüksekliği tavanı şablonun ETKİN kesimine göre (geometri `effectiveCut`; kesimsiz şablonda dilin kesimi).
    const sizePx = Math.min((req.profile.sizing.maxCapHeight * shapeCutDiameter(g.cut)) / capRatio, a.h / 2.8);
    const avg = shapeRun(reg, "abcdefghijklmnopqrstuvwxyz", { fontId: primary.id, sizePx }).advance / 26;
    const S = g.rows.length / g.framePx || 1;
    out.widthHints = [0.25, 0.5, 0.75].map((at) => {
      const row = g.rows[Math.min(g.rows.length - 1, Math.max(0, Math.floor((a.y + at * a.h) * S)))] ?? [];
      const width = row.reduce((m, [x0, x1]) => Math.max(m, x1 - x0), 0);
      return { at, chars: avg > 0 ? Math.floor(width / avg) : 0 };
    });
  }
  return out;
}

/** Referansın yazı katmanını şablonun üstüne koyar (AI "bitmiş etiket" olarak görsün). */
async function referenceComposite(g: TemplateGeometry, layer: Buffer): Promise<Buffer> {
  const F = Math.round(g.framePx);
  const layers: OverlayOptions[] = [];
  if (g.imagePath && existsSync(g.imagePath)) {
    const layer = await templateLayer(g.imagePath, g.templateBox, 1, F);
    if (layer) layers.push(layer);
  }
  layers.push({ input: await sharp(layer).resize(F, F, { fit: "fill" }).png().toBuffer(), left: 0, top: 0 });
  return sharp({ create: { width: F, height: F, channels: 4, background: "#ffffff" } }).composite(layers).png().toBuffer();
}


// ---------------------------------------------------------------- tasarımcı

export function createDesigner(deps: AiAdapterDeps): Designer {
  const clients = makeClients(deps);
  /**
   * Tasarım çağrısında seçilen benzer örnekler (ve işin alan oranı), AYNI İŞİN aday seçiminde de kullanılır. Bağdaştırıcı
   * süreç genelidir: anahtar firma + iş + metindir (yalnız metin olsaydı başka firmanın aynı metinli işine o firmanın
   * referans örnekleri girerdi). Firma bağlamı yoksa saklanmaz.
   */
  const similarByJob = new Map<string, { examples: BreakExample[]; areaAspect?: number }>();
  const memoKey = (jobId: string, text: string): string | null => {
    const org = maybeOrg()?.orgId;
    return org ? JSON.stringify([org, jobId, text]) : null;
  };
  /**
   * Şablon yazı alanı oranı önbelleği: (dil, şablon, profil özeti) → oran. Geometri pahalı; profil değişince anahtar
   * değişir. İşin kendi şablonu her çağrıda güncel geometriden yazılır (alan düzeltmesi hemen yansısın).
   */
  // Söz (promise) saklanır: paralel işler aynı şablonun geometrisini iki kez hesaplamasın.
  const aspectCache = new Map<string, Promise<number | null>>();
  // Firma da anahtarda: dil kimlikleri kurulumda tekil olsa da önbellek firma sınırını kendisi korur.
  const aspectKey = (languageId: string, templateKey: string, stamp: string) => JSON.stringify([maybeOrg()?.orgId ?? null, languageId, templateKey, stamp]);
  async function withAreaAspects(examples: BreakExample[], languageId: string, profile: Profile, stamp: string): Promise<BreakExample[]> {
    if (aspectCache.size > 500) aspectCache.clear();
    return Promise.all(
      examples.map(async (e) => {
        if (!e.templateKey) return e;
        const key = aspectKey(languageId, e.templateKey, stamp);
        let p = aspectCache.get(key);
        if (!p && deps.templateAspect) {
          p = deps.templateAspect(languageId, e.templateKey, profile).then((x) => x ?? null, () => null);
          aspectCache.set(key, p);
        }
        const a = p ? await p : null;
        return typeof a === "number" && Number.isFinite(a) ? { ...e, areaAspect: a } : e;
      }),
    );
  }
  return {
    async design(req) {
      if (similarByJob.size > 200) similarByJob.clear();
      const rejects: AiFailure[] = [];
      const claude = trackClaude(clients.claude(), rejects);
      let reg: FontRegistry | null = null;
      try {
        reg = req.fontsDir ? deps.fonts.forProfile(req.fontsDir, req.profile) : null;
      } catch {
        reg = null;
      }
      const images: NonNullable<DesignContext["images"]> = {};
      const g = req.geometry;
      if (g.imagePath && existsSync(g.imagePath)) {
        images.template = await readFile(g.imagePath);
        const area = await renderOverlay(g).catch(() => null);
        if (area) images.area = area;
        const languageId = req.languageId ?? req.template?.languageId;
        if (languageId && req.template && deps.referenceImages) {
          const refs = await deps.referenceImages(languageId, req.template.key, 2, req.excludeReferenceId).catch(() => []);
          if (refs.length) images.references = await Promise.all(refs.map((r) => referenceComposite(g, r)));
        }
      }
      const langForExamples = req.languageId ?? req.template?.languageId;
      const summary = templateSummary(req, reg);
      const picked =
        langForExamples && deps.breakExamples
          ? pickSimilarExamples(req.text, deps.breakExamples(langForExamples).filter((e) => !req.excludeReferenceId || e.referenceId !== req.excludeReferenceId), SIMILAR_EXAMPLES, req.profile.connectors.words, { templateKey: req.template?.key ?? null })
          : [];
      // Benzer örneklere şablonlarının yazı alanı oranı eklenir (piksel değil; dar/geniş ayrımı profil notlarında).
      let similar = picked;
      if (picked.length && langForExamples) {
        const stamp = createHash("sha1").update(JSON.stringify(req.profile)).digest("hex").slice(0, 16);
        if (req.template?.key && summary.areaAspect !== undefined) aspectCache.set(aspectKey(langForExamples, req.template.key, stamp), Promise.resolve(summary.areaAspect));
        similar = await withAreaAspects(picked, langForExamples, req.profile, stamp);
      }
      const mk = memoKey(req.jobId, req.text);
      if (similar.length && mk) similarByJob.set(mk, { examples: similar, ...(summary.areaAspect !== undefined ? { areaAspect: summary.areaAspect } : {}) });
      const revisionNote = req.revision && !req.revision.intent ? `Değişiklik isteği: ${req.revision.request}` : "";
      const ctx: DesignContext = {
        text: req.text,
        segments: req.segments,
        profile: req.profile,
        template: summary,
        fonts: fontCatalog(req.profile, req.text, missingGlyphs(reg, req.profile, req.text)),
        previous: req.previous.map((i) => ({ lines: i.lines.map((l) => l.text) })),
        aiNote: [req.aiNote, revisionNote].filter(Boolean).join("\n"),
        ...(req.revision?.intent ? { revision: { intent: req.revision.intent, request: req.revision.request } } : {}),
        candidates: req.candidates,
        images,
        ...(similar.length ? { similar } : {}),
      };
      const res = await proposeDesigns(claude, ctx, {
        extraRules: checkIntentRules,
        onProgress: (e) => {
          if (e.stage !== "request" && e.stage !== "done") req.log("ai", e.message);
        },
      });
      const calls = callRecords("design", claude.model, res.calls, `${res.intents.length} geçerli aday, ${res.rejected.length} reddedilen`);
      if (!res.ok) throw flowError(res.issues[0]?.message ?? "AI geçerli aday üretemedi.", calls, rejects);
      return { candidates: res.intents, model: claude.model, promptVersion: res.promptVersion, calls };
    },

    async pick(req) {
      const claude = clients.claude();
      const ids = req.candidates.map((_, i) => `c${i}`);
      const mk = memoKey(req.jobId, req.text);
      const memo = mk ? similarByJob.get(mk) : undefined;
      const lineSummary = (i: number) => req.candidates[i]!.intent.lines.map((l) => l.text).join(" / ");
      const res = await rankCandidates(claude, {
        images: req.candidates.map((c, i) => ({ id: ids[i]!, png: c.preview, summary: lineSummary(i) })),
        context: { text: req.text, profile: req.profile, ...(memo ? { similar: memo.examples, ...(memo.areaAspect !== undefined ? { areaAspect: memo.areaAspect } : {}) } : {}) },
        // Tasarım çağrısının ilk adayı = tasarımcının en olası tasarımı; görünür sorunu yoksa başta kalır.
        preferredId: ids[0]!,
      });
      const calls = callRecords("rank", claude.model, res.calls, res.summary);
      if (!res.ok) req.log("pick", `Aday seçimi yapılamadı, motor sırası kullanılıyor${res.error ? `: ${res.error.message}` : ""}`);
      const ranking = res.ranking.map((id) => ids.indexOf(id)).filter((i) => i >= 0);
      const first = res.ranking[0];
      const reason = [res.summary, first ? res.reasons[first] : ""].filter(Boolean).join(" ");
      // Teşhis (kalite ölçümü okur): 1. aday korunduğunda modelin kendi ilk seçimi farklıysa özetin sonunda kalır.
      const modelFirst = res.modelRanking?.[0] ? ids.indexOf(res.modelRanking[0]) : -1;
      const modelNote = modelFirst >= 0 && res.modelRanking![0] !== first ? `[modelin ilk seçimi: ${lineSummary(modelFirst)}]` : "";
      return {
        ranking,
        reason: res.noneAcceptable ? `${reason} (AI hiçbirini yeterli bulmadı)`.trim() : reason,
        calls,
        reasons: ids.map((id) => res.reasons[id] ?? ""),
        summary: [res.summary, res.preferredHasProblem === false ? "[1. aday korundu]" : res.preferredHasProblem ? "[1. adayda görünür sorun]" : "", modelNote].filter(Boolean).join(" "),
      };
    },
  };
}

// ---------------------------------------------------------------- görüntü üretimi

const pct = (v: number) => Math.round(Math.min(100, Math.max(0, v * 100)));

export function createImageGenerator(deps: AiAdapterDeps): ImageGenerator {
  const clients = makeClients(deps);
  return {
    async onTemplate(req) {
      const rejects: AiFailure[] = [];
      const gemini = trackGemini(clients.gemini(), rejects);
      const plain = clients.optionalClaude();
      const claude = plain ? trackClaude(plain, rejects) : undefined;
      if (!claude) req.log("image", "Anthropic anahtarı yok: görseldeki yazı okunamayacak");
      const templatePng = await readFile(req.templatePath);
      const meta = await sharp(templatePng).metadata();
      const w = meta.width ?? 1;
      const h = meta.height ?? 1;
      const tb = req.geometry.templateBox;
      const a = req.geometry.areaBounds;
      const areaHint = `inside the template's empty writable area: from ${pct((a.x - tb.x) / tb.w)}% to ${pct((a.x + a.w - tb.x) / tb.w)}% of the image width and from ${pct((a.y - tb.y) / tb.h)}% to ${pct((a.y + a.h - tb.y) / tb.h)}% of the image height (from the top-left corner), centred there, never touching any decoration`;
      const currentPng = req.revision?.currentPng ?? null;
      const revisionNote = req.revision && !currentPng ? `Change request: ${req.revision.request}` : "";
      const r = await writeOnTemplate(
        { gemini, ...(claude ? { claude } : {}) },
        {
          templatePng,
          text: req.text,
          areaHint,
          profileHints: imageProfileHints(req.profile),
          // Şablonun kendi kesimi (yoksa dilin kesimi), şablon görselinin pikselinde.
          cut: templateCutShape(req.profile, w, h, req.template),
          symbols: preservationSymbols(req.profile),
          ...(req.profile.ai.instructions.trim() ? { styleNote: req.profile.ai.instructions } : {}),
          ...([req.aiNote, revisionNote].filter(Boolean).length ? { aiNote: [req.aiNote, revisionNote].filter(Boolean).join("\n") } : {}),
          ...(req.revision && currentPng ? { revision: { currentPng, request: req.revision.request } } : {}),
          onProgress: (m) => req.log("image", m),
        },
      );
      const calls = usageRecords(r.usage, `şablona yaz · ${r.checks.attempts} deneme${r.checks.rejectedBecause.length ? ` · ${r.checks.rejectedBecause.join("; ")}` : ""}`);
      if (!r.compositePng || !r.textLayerPng || !r.textBox) throw flowError(r.issues[0]?.message ?? "Görüntü üretilemedi.", calls, rejects);
      const kx = w / tb.w;
      const ky = h / tb.h;
      const box = r.textBox;
      const transcript = r.checks.transcript;
      return {
        composite: r.compositePng,
        textLayer: r.textLayerPng,
        textBox: { x: tb.x + box.x / kx, y: tb.y + box.y / ky, w: box.w / kx, h: box.h / ky },
        // Karşılaştırma ai paketinde sembol boşluğu esnekliğiyle yapıldı; aynıysa müşteri metni döner.
        readText: r.checks.textMatches === true ? req.text : transcript ? transcript.join(" ") : null,
        templateUntouched: r.checks.templateUntouched,
        model: gemini.model,
        promptVersion: r.promptVersion,
        calls,
      };
    },

    async newTemplate(req) {
      const rejects: AiFailure[] = [];
      const gemini = trackGemini(clients.gemini(), rejects);
      const plain = clients.optionalClaude();
      const claude = plain ? trackClaude(plain, rejects) : undefined;
      const sizePx = Math.max(req.width, req.height);
      const r = await generateTemplate(
        { gemini, ...(claude ? { claude } : {}) },
        {
          theme: req.theme,
          cut: templateCutShape(req.profile, sizePx, sizePx),
          sizePx,
          ...(req.profile.ai.instructions.trim() ? { styleNotes: req.profile.ai.instructions } : {}),
          onProgress: (m) => req.log("image", m),
        },
      );
      const calls = usageRecords(r.usage, `temadan şablon · ${r.checks.attempts} deneme`);
      if (!r.ok || !r.png) throw flowError(r.issues[0]?.message ?? "Şablon görseli üretilemedi.", calls, rejects);
      return { png: r.png, model: gemini.model, prompt: r.prompt, calls };
    },
  };
}

// ---------------------------------------------------------------- anahtar denemesi

/**
 * Anahtar denemesi: sağlayıcının model bilgisi ucu (ücretsiz, tek küçük GET). Anahtar geçerli ve model erişilebilir
 * mi söyler; üretim yapmaz.
 */
export function createKeyTester(fetchFn: typeof fetch = fetch): KeyTester {
  return async (provider, apiKey) => {
    const model = provider === "anthropic" ? MODELS.daily : MODELS.image;
    const url =
      provider === "anthropic"
        ? `https://api.anthropic.com/v1/models/${model}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
    const headers: Record<string, string> =
      provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { "x-goog-api-key": apiKey };
    try {
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { ok: true, message: "Bağlantı çalışıyor.", model };
      const body = await res.text().catch(() => "");
      const detail = body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? "";
      const message =
        res.status === 401 || res.status === 403
          ? "Anahtar geçersiz ya da yetkisiz."
          : res.status === 404
            ? `Anahtar çalışıyor ama "${model}" modeline erişilemiyor.`
            : res.status === 429
              ? "Hız sınırı ya da kota aşıldı; biraz sonra tekrar deneyin."
              : `Sağlayıcı ${res.status} döndü.`;
      return { ok: false, message: detail ? `${message} (${detail})` : message, model };
    } catch (err) {
      return { ok: false, message: `Sağlayıcıya ulaşılamadı: ${err instanceof Error ? err.message : String(err)}`, model };
    }
  };
}
