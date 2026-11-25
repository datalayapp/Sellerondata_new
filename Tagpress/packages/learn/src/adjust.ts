import type { Box, DesignIntent, Point, Template } from "@tagpress/domain";
import { templatePath } from "./patch.ts";
import type { ProposalDraft } from "./propose.ts";
import { type Robust, clamp, median, robust, round } from "./stats.ts";

/**
 * Hafif düzeltmelerden (uygulamadaki "Düzelt" penceresi) öğrenme: kullanıcı üretilen varyasyonun yazı bloğunu elle
 * kaydırdıkça her kayıt `adjust_log`'a düşer. Bir şablonda kayma SİSTEMATİKSE (birçok işte aynı yönde) şablonun hedef
 * merkezi (`textCenter`) için öneri çıkar. Tamamen deterministik istatistik: AI yok, piksel üretilmez.
 *
 * Model. Motor bloğu hedef merkeze göre yerleştirir; kullanıcının düzeltmesi mürekkep merkezini Δ = (sonra − önce)
 * kadar taşır. Hedef Δ kadar taşınsaydı motor (aynı yerleşim payıyla) bloğu kullanıcının koyduğu yere koyardı. Bu
 * yüzden örneğin "istenen hedefi" = (kayıt anındaki hedef + Δ) / framePx: tasarım alanına oran, yani şablonun
 * `textCenter` birimi. Kayıt anındaki hedefe göre hesaplandığı için şablonun merkezi sonradan değişse de örnek
 * geçerli kalır; tasarım alanı boyutu (framePx) farklı örnekler de aynı birime çevrilir.
 *
 * Gürültüye karşı: önce İŞ başına ortanca (aynı işin birkaç varyasyonu tek oy), sonra işler üzerinden ortanca. Eksen
 * ancak (a) yeterli örnek ve farklı iş varsa, (b) ortanca kayma en az eşik kadarsa, (c) işlerin yeterli bir payı aynı
 * yöne kaydırmışsa sistematik sayılır. Tek işin aşırı düzeltmesi ortancayı sürükleyemez.
 *
 * Boyut (ölçek) tercihi bilerek ÖNERİYE DÖNMEZ, yalnızca bulgu olarak raporlanır (bkz. `adjustFindings`).
 */

export interface AdjustObservation {
  /** Varyasyon kimliği. */
  id: string;
  jobId: string;
  templateKey: string | null;
  /** Kayıt anındaki tasarım alanı (px). */
  framePx: number;
  /** Kayıt anındaki hedef merkez (tasarım px). */
  target: Point;
  /** Motorun mürekkep kutusu (düzeltmesiz) ve kullanıcının düzeltilmiş kutusu (tasarım px). */
  inkBefore: Box;
  inkAfter: Box;
  /** Bloğun ölçek çarpanı (düzeltmenin `scale`'i; 1 = boyuta dokunulmadı). */
  scale: number;
  createdAt?: string;
  /** Motorla yeniden yerleştirme girdisi (varyasyonun metni + niyeti). Yoksa önce/sonra ölçülemez. */
  replay?: { text: string; intent: DesignIntent } | null;
  /** Arayüzde gösterilecek görsel (düzeltilmiş önizleme). */
  previewUrl?: string;
}

/** Eşikler: kod kullanıcı eşiği bilmez; varsayılanlar burada, koşu isteği (`LearnRunRequest`) değiştirebilir. */
export interface AdjustThresholds {
  /** Şablon başına en az düzeltilmiş varyasyon. */
  minAdjust: number;
  /** Şablon başına en az farklı iş. */
  minAdjustJobs: number;
  /** Sistematik sayılacak en küçük ortanca kayma (tasarım alanına oran; 0,01 = 440 px alanda 4,4 px). */
  minAdjustShift: number;
  /** Aynı yöne kaydıran işlerin en az payı (0..1). */
  minAdjustAgreement: number;
}

export const DEFAULT_ADJUST_THRESHOLDS: AdjustThresholds = { minAdjust: 4, minAdjustJobs: 3, minAdjustShift: 0.01, minAdjustAgreement: 0.6 };

export function adjustThresholds(o: Partial<AdjustThresholds> = {}): AdjustThresholds {
  return {
    minAdjust: o.minAdjust ?? DEFAULT_ADJUST_THRESHOLDS.minAdjust,
    minAdjustJobs: o.minAdjustJobs ?? DEFAULT_ADJUST_THRESHOLDS.minAdjustJobs,
    minAdjustShift: o.minAdjustShift ?? DEFAULT_ADJUST_THRESHOLDS.minAdjustShift,
    minAdjustAgreement: o.minAdjustAgreement ?? DEFAULT_ADJUST_THRESHOLDS.minAdjustAgreement,
  };
}

const centerOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const goodBox = (b: Box) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;

/** Ölçüme girebilir mi (bozuk kayıt atılır). */
export function adjustUsable(o: AdjustObservation): boolean {
  return o.framePx > 0 && Number.isFinite(o.target.x) && Number.isFinite(o.target.y) && goodBox(o.inkBefore) && goodBox(o.inkAfter);
}

/** Örneğin istediği hedef merkez (tasarım alanına oran): kayıttaki hedef + kullanıcının mürekkep merkezini taşıdığı kadar. */
export function desiredCenter(o: AdjustObservation): Point {
  const a = centerOf(o.inkAfter);
  const b = centerOf(o.inkBefore);
  return { x: (o.target.x + a.x - b.x) / o.framePx, y: (o.target.y + a.y - b.y) / o.framePx };
}

/** Kırpılmış ortalama (her uçtan `trim` payı atılır). Yalnızca bilgi için raporlanır; öneri ortancayı kullanır. */
export function trimmedMean(xs: readonly number[], trim = 0.2): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const k = Math.floor(s.length * trim);
  const kept = s.length - 2 * k > 0 ? s.slice(k, s.length - k) : s;
  return kept.reduce((a, x) => a + x, 0) / kept.length;
}

/** İş başına ortanca istenen merkez (aynı işin varyasyonları tek oy). */
export function desiredByJob(list: readonly AdjustObservation[]): Map<string, Point> {
  const by = new Map<string, Point[]>();
  for (const o of list) by.set(o.jobId, [...(by.get(o.jobId) ?? []), desiredCenter(o)]);
  return new Map([...by].map(([j, ps]) => [j, { x: median(ps.map((p) => p.x)), y: median(ps.map((p) => p.y)) }]));
}

export interface AdjustAxis {
  /** İş başına kayma (geçerli hedefe göre, oran) özeti. */
  shift: Robust;
  /** Aynısının kırpılmış ortalaması (bilgi). */
  trimmedMean: number;
  /** Ortancayla aynı yöne en az eşiğin yarısı kadar kaydıran işlerin payı. */
  agreement: number;
  systematic: boolean;
}

export interface AdjustTemplateStats {
  key: string;
  /** Düzeltilmiş varyasyon ve farklı iş sayısı. */
  samples: number;
  jobs: number;
  enough: boolean;
  /** Geçerli hedef merkez (oran) ve kaynağı: motorun geometrisi, şablon kaydı ya da son düzeltme kaydı. */
  current: Point;
  currentSource: "geometry" | "template" | "log";
  x: AdjustAxis;
  y: AdjustAxis;
  /** Önerilen hedef merkez (oran); hiçbir eksen sistematik değilse null. */
  to: Point | null;
  /** Kayıt anında motor ↔ kullanıcı mürekkep merkezi uzaklığı (tasarım px, güncel alan boyutunda). */
  logged: Robust;
  /** İş başına ortanca blok ölçeği. */
  scale: Robust;
  ids: string[];
  jobIds: string[];
  /** Bu şablonda onaylanan etiket sayısı ve bunların kaçının elle düzeltildiği (varsa). */
  usage: { approved: number; adjusted: number } | null;
}

export interface AnalyzeAdjustOptions {
  thresholds?: Partial<AdjustThresholds>;
  /** Güncel tasarım alanı (px): px'e çevrilmiş açıklamalar için. */
  framePx: number;
  /** Şablonun geçerli hedef merkezi (oran), motorun geometrisinden. Yoksa şablon kaydı ya da son kayıt. */
  current?: ReadonlyMap<string, Point>;
  usage?: ReadonlyMap<string, { approved: number; adjusted: number }>;
}

function axisOf(vals: readonly number[], th: AdjustThresholds, enough: boolean): AdjustAxis {
  const shift = robust(vals)!;
  const med = shift.median;
  const agreeing = vals.filter((v) => Math.sign(v) === Math.sign(med) && Math.abs(v) >= th.minAdjustShift / 2).length;
  const agreement = vals.length ? agreeing / vals.length : 0;
  return { shift, trimmedMean: trimmedMean(vals), agreement, systematic: enough && Math.abs(med) >= th.minAdjustShift && agreement >= th.minAdjustAgreement };
}

/** Şablon bazında düzeltme istatistiği (şablonu bilinmeyen kayıtlar atılır). */
export function analyzeAdjust(observations: readonly AdjustObservation[], templates: ReadonlyMap<string, Template>, opts: AnalyzeAdjustOptions): AdjustTemplateStats[] {
  const th = adjustThresholds(opts.thresholds);
  const F = opts.framePx;
  const byTpl = new Map<string, AdjustObservation[]>();
  for (const o of observations) {
    if (!o.templateKey || !templates.has(o.templateKey) || !adjustUsable(o)) continue;
    byTpl.set(o.templateKey, [...(byTpl.get(o.templateKey) ?? []), o]);
  }
  const out: AdjustTemplateStats[] = [];
  for (const [key, list] of [...byTpl].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tpl = templates.get(key)!;
    const latest = [...list].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).at(-1)!;
    const fromGeometry = opts.current?.get(key);
    const current = fromGeometry ?? tpl.textCenter ?? { x: latest.target.x / latest.framePx, y: latest.target.y / latest.framePx };
    const currentSource = fromGeometry ? "geometry" : tpl.textCenter ? "template" : "log";
    const perJob = desiredByJob(list);
    const jobIds = [...perJob.keys()].sort();
    const enough = list.length >= th.minAdjust && jobIds.length >= th.minAdjustJobs;
    const x = axisOf(jobIds.map((j) => perJob.get(j)!.x - current.x), th, enough);
    const y = axisOf(jobIds.map((j) => perJob.get(j)!.y - current.y), th, enough);
    const to = x.systematic || y.systematic
      ? { x: round(clamp(x.systematic ? current.x + x.shift.median : current.x, 0, 1), 3), y: round(clamp(y.systematic ? current.y + y.shift.median : current.y, 0, 1), 3) }
      : null;
    const scales = new Map<string, number[]>();
    for (const o of list) scales.set(o.jobId, [...(scales.get(o.jobId) ?? []), o.scale]);
    out.push({
      key,
      samples: list.length,
      jobs: jobIds.length,
      enough,
      current: { x: round(current.x, 4), y: round(current.y, 4) },
      currentSource,
      x,
      y,
      to,
      logged: robust(list.map((o) => (Math.hypot(centerOf(o.inkAfter).x - centerOf(o.inkBefore).x, centerOf(o.inkAfter).y - centerOf(o.inkBefore).y) * F) / o.framePx))!,
      scale: robust([...scales.values()].map((s) => median(s)))!,
      ids: list.map((o) => o.id),
      jobIds,
      usage: opts.usage?.get(key) ?? null,
    });
  }
  return out;
}

const fmt = (x: number, d = 3) => x.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const px = (ratio: number, F: number) => Math.round(Math.abs(ratio) * F);
const dirX = (v: number) => (v > 0 ? "sağa" : "sola");
const dirY = (v: number) => (v > 0 ? "aşağı" : "yukarı");
const pctOf = (x: number) => `%${Math.round(x * 100)}`;
const axisStat = (a: AdjustAxis, F: number) => ({
  medianPx: round(a.shift.median * F, 1),
  q1Px: round(a.shift.q1 * F, 1),
  q3Px: round(a.shift.q3 * F, 1),
  iqrPx: round(a.shift.iqr * F, 1),
  trimmedMeanPx: round(a.trimmedMean * F, 1),
  median: round(a.shift.median, 4),
  agreement: round(a.agreement, 3),
  systematic: a.systematic,
});

/** Önceden açıklanabilir öneri: hedef merkez `textCenter`. Kimlik referanslardan (bitmiş etiketler) çıkan merkez önerisinden ayrıdır. */
export const adjustSlug = (key: string) => `template:${key}:textCenter:adjust`;

export function proposeFromAdjust(stats: readonly AdjustTemplateStats[], templates: ReadonlyMap<string, Template>, framePx: number): ProposalDraft[] {
  const F = framePx;
  const out: ProposalDraft[] = [];
  for (const s of stats) {
    const tpl = templates.get(s.key);
    if (!tpl || !s.to) continue;
    const cur = tpl.textCenter;
    if (cur && Math.abs(cur.x - s.to.x) < 0.005 && Math.abs(cur.y - s.to.y) < 0.005) continue;
    const parts: string[] = [];
    if (s.x.systematic) parts.push(`${px(s.x.shift.median, F)} px ${dirX(s.x.shift.median)}`);
    if (s.y.systematic) parts.push(`${px(s.y.shift.median, F)} px ${dirY(s.y.shift.median)}`);
    const spread = [s.x.systematic ? `yatayda ${px(s.x.shift.iqr, F)} px` : null, s.y.systematic ? `dikeyde ${px(s.y.shift.iqr, F)} px` : null].filter(Boolean).join(", ");
    const agree = [s.x.systematic ? `yatayda ${pctOf(s.x.agreement)}` : null, s.y.systematic ? `dikeyde ${pctOf(s.y.agreement)}` : null].filter(Boolean).join(", ");
    const curText = cur ? `(${fmt(cur.x)}, ${fmt(cur.y)})` : `yok; motor alanın ortasını (${fmt(s.current.x)}, ${fmt(s.current.y)}) kullanıyor`;
    const usage = s.usage && s.usage.approved ? ` Bu şablonda onaylanan ${s.usage.approved} etiketin ${s.usage.adjusted} tanesi elle düzeltilmiş.` : "";
    out.push({
      slug: adjustSlug(s.key),
      kind: "motor",
      scope: { kind: "template", key: s.key },
      title: `Şablon ${s.key}: yazı merkezi (elle düzeltmelerden)`,
      summary:
        `Uygulamada ${s.jobs} işin ${s.samples} varyasyonunu elle düzelttiniz; yazıyı motorun yerleşiminden iş başına ortanca ${parts.join(" ve ")} kaydırdınız ` +
        `(yayılım, çeyrekler arası: ${spread}; aynı yönde kaydıran işler: ${agree}). Hedef merkez ${curText} → (${fmt(s.to.x)}, ${fmt(s.to.y)}).${usage}`,
      changes: [{ target: "template", key: s.key, field: "textCenter", path: templatePath(s.key, "textCenter"), from: cur, to: s.to }],
      primary: "position",
      count: s.samples,
      stats: {
        source: "adjust",
        samples: s.samples,
        jobs: s.jobs,
        framePx: F,
        current: s.current,
        currentSource: s.currentSource,
        x: axisStat(s.x, F),
        y: axisStat(s.y, F),
        loggedErrorPx: { median: round(s.logged.median, 1), q1: round(s.logged.q1, 1), q3: round(s.logged.q3, 1) },
        usage: s.usage,
      },
      examples: s.ids.slice(0, 6),
    });
  }
  return out;
}

/**
 * Bulgular (öneriye dönmeyenler dahil). Boyut tercihi neden öneri değil: (1) yalnızca kullanıcının BEĞENMEDİĞİ
 * varyasyonlar düzeltilir, dokunmadan onaylananların "boyut iyi" sinyali kayıtta yok (seçim yanlılığı); (2) karşılığı
 * profil geneli `sizing.fill`, o da bitmiş etiketlerden (referanslar) motor tekrarıyla ölçülüyor (daha büyük ve yansız
 * küme); (3) motor boyutu alana sığma sınırıyla kesiyor, büyütme tercihini doluluk karşılayamaz. Şablona ait boyut
 * alanı da yok.
 */
export function adjustFindings(stats: readonly AdjustTemplateStats[], observations: readonly AdjustObservation[], th: Partial<AdjustThresholds> = {}): string[] {
  const t = adjustThresholds(th);
  const out: string[] = [];
  if (!stats.length) return out;
  const samples = stats.reduce((a, s) => a + s.samples, 0);
  out.push(`Uygulamada elle düzeltilmiş ${samples} varyasyon (${stats.length} şablon) okundu.`);
  for (const s of stats) {
    if (s.enough && !s.to) out.push(`Şablon ${s.key}: ${s.samples} düzeltme (${s.jobs} iş) var ama kayma sistematik değil (yön tutarsız ya da ortanca kayma küçük); merkez önerisi yok.`);
  }
  // Boyut: bütün işler üzerinden, iş başına ortanca blok ölçeği (aynı işin varyasyonları tek oy).
  const keys = new Set(stats.map((s) => s.key));
  const byJob = new Map<string, number[]>();
  for (const o of observations) if (o.templateKey && keys.has(o.templateKey) && adjustUsable(o)) byJob.set(o.jobId, [...(byJob.get(o.jobId) ?? []), o.scale]);
  const r = robust([...byJob.values()].map((s) => median(s)));
  if (r && r.n >= t.minAdjustJobs && Math.abs(r.median - 1) >= 0.02) {
    out.push(
      `Elle düzeltmelerde blok boyutu iş başına ortanca ×${r.median.toFixed(2)} değiştirilmiş (${r.n} iş, çeyrekler ×${r.q1.toFixed(2)}–×${r.q3.toFixed(2)}). ` +
        "Boyut önerisi üretilmedi: yalnızca beğenilmeyen varyasyonlar düzeltildiği için örnek yanlı; boyutun karşılığı profil genelindeki doluluk ve o, bitmiş etiketlerden (referanslar) ölçülüyor.",
    );
  }
  return out;
}

// ---------------------------------------------------------------- önce/sonra (dışarıda tutulan işlerle)

/** Örneği verilen şablonla motora yerleştirir, mürekkep kutusunu (güncel tasarım px) döner; yerleşemezse null. */
export type AdjustPlacer = (o: AdjustObservation, template: Template) => Promise<Box | null>;

export interface AdjustEvalMetrics {
  /** Önce ve sonra yerleşen (karşılaştırılan) örnek sayısı. */
  n: number;
  failed: number;
  /** Motorun mürekkep merkezi ↔ kullanıcının düzeltilmiş merkezi, ortanca (tasarım px). */
  positionError: number;
  dx: number;
  dy: number;
  /** |motor yüksekliği / kullanıcı yüksekliği − 1| ortancası (yan ölçü: merkez boyutu da etkileyebilir). */
  sizeError: number;
}

export interface AdjustEvaluation {
  verdict: "better" | "same" | "worse" | "unmeasured";
  weak: boolean;
  drop: boolean;
  reason: string;
  n: number;
  folds: number;
  before: AdjustEvalMetrics | null;
  after: AdjustEvalMetrics | null;
}

export interface EvaluateAdjustOptions {
  /** Güncel tasarım alanı (px). */
  framePx: number;
  /** Dışarıda tutulup ölçülen en az örnek (altı: kanıt zayıf, düşürülmez). */
  minHeldOut?: number;
  /** En fazla kat (iş grupları). Varsayılan 8: her iş bir kez dışarıda kalır, çok işte gruplanır. */
  maxFolds?: number;
}

/** Konum karşılaştırmasında anlamlı fark (px) ve yan ölçüde gerileme sınırı (değerlendirme sabitleri, `evaluate.ts` gibi). */
const POSITION_EPS = 0.5;
const SIZE_SLACK = 0.02;

/**
 * Dışarıda tutulan işlerle önce/sonra: işler katlara bölünür; her katta merkez YALNIZCA diğer işlerden hesaplanır
 * (aynı eksenler), dışarıdaki işlerin varyasyonları motorla hem geçerli şablonla hem kat merkeziyle yerleştirilir ve
 * motorun mürekkep merkezinin kullanıcının düzeltilmiş merkezine uzaklığı karşılaştırılır.
 */
export async function evaluateAdjust(
  stat: AdjustTemplateStats,
  template: Template,
  observations: readonly AdjustObservation[],
  place: AdjustPlacer,
  opts: EvaluateAdjustOptions,
): Promise<AdjustEvaluation> {
  const none = (reason: string): AdjustEvaluation => ({ verdict: "unmeasured", weak: true, drop: false, reason, n: 0, folds: 0, before: null, after: null });
  if (!stat.to) return none("Sistematik kayma yok.");
  const F = opts.framePx;
  const list = observations.filter((o) => o.templateKey === stat.key && adjustUsable(o));
  const perJob = desiredByJob(list);
  const jobs = [...perJob.keys()].sort();
  const K = Math.min(opts.maxFolds ?? 8, jobs.length);
  if (K < 2) return none("Dışarıda tutulacak ikinci iş yok; önce/sonra ölçülemedi.");
  const foldOf = new Map(jobs.map((j, i) => [j, i % K]));

  type Pair = { b: Box | null; a: Box | null; user: { x: number; y: number; h: number } };
  const pairs: Pair[] = [];
  for (let f = 0; f < K; f++) {
    const train = jobs.filter((j) => foldOf.get(j) !== f);
    const shift = (axis: "x" | "y") => median(train.map((j) => perJob.get(j)![axis] - stat.current[axis]));
    const center = {
      x: round(clamp(stat.x.systematic ? stat.current.x + shift("x") : stat.current.x, 0, 1), 4),
      y: round(clamp(stat.y.systematic ? stat.current.y + shift("y") : stat.current.y, 0, 1), 4),
    };
    const folded: Template = { ...template, textCenter: center };
    for (const o of list.filter((x) => foldOf.get(x.jobId) === f)) {
      const k = F / o.framePx;
      const c = centerOf(o.inkAfter);
      const safe = async (t: Template) => {
        try {
          return await place(o, t);
        } catch {
          return null;
        }
      };
      pairs.push({ b: await safe(template), a: await safe(folded), user: { x: c.x * k, y: c.y * k, h: o.inkAfter.h * k } });
    }
  }
  const both = pairs.filter((p) => p.b && p.a);
  const metrics = (side: "b" | "a"): AdjustEvalMetrics => {
    const errs = both.map((p) => {
      const c = centerOf(p[side]!);
      return { dx: c.x - p.user.x, dy: c.y - p.user.y, size: Math.abs(p[side]!.h / p.user.h - 1) };
    });
    return {
      n: both.length,
      failed: pairs.filter((p) => !p[side]).length,
      positionError: round(median(errs.map((e) => Math.hypot(e.dx, e.dy))), 2),
      dx: round(median(errs.map((e) => e.dx)), 2),
      dy: round(median(errs.map((e) => e.dy)), 2),
      sizeError: round(median(errs.map((e) => e.size)), 4),
    };
  };
  if (!both.length) {
    return { ...none("Motor dışarıda tutulan varyasyonları yeniden yerleştiremedi (niyet ya da font yok); önce/sonra ölçülemedi."), folds: K };
  }
  const before = metrics("b");
  const after = metrics("a");
  const need = opts.minHeldOut ?? 2;
  let verdict: AdjustEvaluation["verdict"] = "same";
  if (after.positionError < before.positionError - POSITION_EPS) verdict = "better";
  else if (after.positionError > before.positionError + POSITION_EPS) verdict = "worse";
  let reason =
    verdict === "same"
      ? `motor ↔ elle düzeltilmiş konum uzaklığı değişmedi (${before.positionError.toFixed(1)} px)`
      : `motor ↔ elle düzeltilmiş konum uzaklığı ${before.positionError.toFixed(1)} → ${after.positionError.toFixed(1)} px`;
  reason += ` · ${both.length} varyasyon, ${K} katta dışarıda tutularak`;
  const small = both.length < need;
  let weak = small || verdict !== "better";
  if (small) reason += ` · yalnızca ${both.length} ölçüm (en az ${need})`;
  if (verdict === "same") reason += " · iyileştirmedi";
  if (after.sizeError - before.sizeError >= SIZE_SLACK) {
    weak = true;
    reason += ` · boyut sapması ${pctOf(before.sizeError)} → ${pctOf(after.sizeError)} arttı`;
  }
  if (after.failed > before.failed) {
    weak = true;
    reason += ` · yerleşmeyen ${before.failed} → ${after.failed}`;
  }
  return { verdict, weak, drop: verdict === "worse" && !small, reason, n: both.length, folds: K, before, after };
}
