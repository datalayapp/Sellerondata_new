import { PROFILE_DOCS } from "@tagpress/domain";
import { tt } from "../dil.ts";
import { diffLeaves, getPath, type LeafChange } from "./profilePath.ts";

/**
 * Öğrenme önerilerinin `patch` ve `evidence` alanları sözleşmede serbest (`unknown`). Burada olabildiğince hoşgörülü okunur:
 *  - patch: `[{path, from?, to}]`, `{changes: [...]}`, `{profile: {...kısmi...}}` ya da doğrudan kısmi profil / "yol: değer" nesnesi.
 *  - evidence: `{count|samples|n}`, `{before, after}` (ayrılmış kümede ölçüler; `heldOut|holdout|test` altında da olabilir),
 *    `{examples: [id | {referenceId|id}]}`.
 * Tanınmayan biçim boş sonuç verir; ekran "ayrıntı yok" der, çökmez.
 */

const PROFILE_ROOTS = new Set(Object.keys(PROFILE_DOCS).map((k) => k.split(".")[0] as string));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Profile uygulanabilir değişiklikler (yol → yeni değer), mevcut profile göre "önce" değerleriyle. */
export function proposalChanges(patch: unknown, current: unknown, opts: { keepSame?: boolean } = {}): LeafChange[] {
  let raw: LeafChange[] = [];
  const fromList = (list: unknown[]): LeafChange[] =>
    list.flatMap((x) => {
      if (!isObj(x) || typeof x.path !== "string") return [];
      return [{ path: x.path, from: "from" in x ? x.from : getPath(current, x.path), to: "to" in x ? x.to : x.value }];
    });
  if (Array.isArray(patch)) raw = fromList(patch);
  else if (isObj(patch)) {
    if (Array.isArray(patch.changes)) raw = fromList(patch.changes);
    else {
      const body = isObj(patch.profile) ? patch.profile : isObj(patch.profilePatch) ? patch.profilePatch : patch;
      raw = flattenPartial(body, "", current);
    }
  }
  return raw.filter((c) => PROFILE_ROOTS.has(c.path.split(".")[0] as string) && (opts.keepSame || JSON.stringify(c.from) !== JSON.stringify(c.to)));
}

function flattenPartial(node: unknown, prefix: string, current: unknown): LeafChange[] {
  if (!isObj(node)) return [];
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && !(path in PROFILE_DOCS)) return flattenPartial(v, path, current);
    // "a.b.c": değer biçimindeki düz anahtarlar da buraya düşer.
    const cur = getPath(current, path);
    return [{ path, from: cur ?? null, to: isObj(v) && isObj(cur) ? { ...cur, ...v } : v }];
  });
}

export interface MetricView {
  key: string;
  label: string;
  before: number;
  after: number;
  /** Yüksek değer iyi mi? (bilinmiyorsa null) */
  higherIsBetter: boolean | null;
  percent: boolean;
}

/** Bilinen ölçüler: ad sözlükte (`designLanguageLab:metrics.<ad>`), yön ve birim burada. */
const METRIC_LABELS: Record<string, { name: "breaks" | "size" | "position" | "score"; higherIsBetter: boolean; percent: boolean }> = {
  lineMatch: { name: "breaks", higherIsBetter: true, percent: true },
  breakMatch: { name: "breaks", higherIsBetter: true, percent: true },
  sameBreaks: { name: "breaks", higherIsBetter: true, percent: true },
  sizeError: { name: "size", higherIsBetter: false, percent: true },
  sizeDiff: { name: "size", higherIsBetter: false, percent: true },
  positionError: { name: "position", higherIsBetter: false, percent: false },
  score: { name: "score", higherIsBetter: true, percent: false },
};

function humanize(key: string): string {
  const s = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return s.charAt(0).toLocaleUpperCase("tr") + s.slice(1);
}

function metricsFrom(before: unknown, after: unknown): MetricView[] {
  if (!isObj(before) || !isObj(after)) return [];
  return Object.keys(before)
    .filter((k) => typeof before[k] === "number" && typeof after[k] === "number")
    .map((k) => {
      const known = METRIC_LABELS[k];
      return {
        key: k,
        label: known ? tt(`designLanguageLab:metrics.${known.name}`) : humanize(k),
        before: before[k] as number,
        after: after[k] as number,
        higherIsBetter: known?.higherIsBetter ?? null,
        percent: known?.percent ?? false,
      };
    });
}

export interface EvidenceView {
  count: number | null;
  /** Ayrılmış (test) kümede önce/sonra. */
  heldOut: MetricView[];
  /** Öneriyi doğuran (eğitim) örneklerde önce/sonra. */
  train: MetricView[];
  exampleIds: string[];
}

export function readEvidence(evidence: unknown): EvidenceView {
  const empty: EvidenceView = { count: null, heldOut: [], train: [], exampleIds: [] };
  if (!isObj(evidence)) return empty;
  const examples = Array.isArray(evidence.examples) ? evidence.examples : Array.isArray(evidence.references) ? evidence.references : [];
  const exampleIds = examples.flatMap((x) => (typeof x === "string" ? [x] : isObj(x) ? [String(x.referenceId ?? x.id ?? "")].filter(Boolean) : []));
  const countRaw = evidence.count ?? evidence.samples ?? evidence.n ?? evidence.evidenceCount;
  const held = [evidence.heldOut, evidence.holdout, evidence.test].find(isObj);
  return {
    count: typeof countRaw === "number" ? countRaw : exampleIds.length || null,
    heldOut: held ? metricsFrom(held.before, held.after) : [],
    train: metricsFrom(evidence.before, evidence.after),
    exampleIds,
  };
}

/** Metrik değişimi iyi mi, kötü mü, belirsiz mi. */
export function metricVerdict(m: MetricView): "better" | "worse" | "same" | "unknown" {
  if (m.before === m.after) return "same";
  if (m.higherIsBetter === null) return "unknown";
  return m.after > m.before === m.higherIsBetter ? "better" : "worse";
}

export { diffLeaves };

// ---------------------------------------------------------------- elle düzeltme kanıtı

export interface AdjustAxisView {
  /** Ortanca kayma (tasarım px; + sağa/aşağı). */
  medianPx: number;
  /** Çeyrekler arası yayılım (px). */
  iqrPx: number;
  /** Aynı yöne kaydıran işlerin payı (0..1). */
  agreement: number;
  systematic: boolean;
}

export interface AdjustEvidenceView {
  samples: number;
  jobs: number;
  x: AdjustAxisView | null;
  y: AdjustAxisView | null;
  /** Kayıt anında motorun yeri ile elle düzeltilmiş yer arasındaki ortanca uzaklık (px). */
  loggedErrorPx: number | null;
  usage: { approved: number; adjusted: number } | null;
  /** Dışarıda tutulan iş grubu sayısı (önce/sonra ölçümünde). */
  folds: number | null;
  variants: Array<{ variantId: string; url: string | null }>;
}

const numOr = (v: unknown, d: number | null = null) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function axisView(v: unknown): AdjustAxisView | null {
  if (!isObj(v) || typeof v.medianPx !== "number") return null;
  return { medianPx: v.medianPx, iqrPx: numOr(v.iqrPx, 0)!, agreement: numOr(v.agreement, 0)!, systematic: v.systematic === true };
}

/** Elle düzeltmelerden çıkan önerinin kanıtı (`evidence.origin === "adjust"`); değilse null. */
export function readAdjustEvidence(evidence: unknown): AdjustEvidenceView | null {
  if (!isObj(evidence) || evidence.origin !== "adjust") return null;
  const s = isObj(evidence.stats) ? evidence.stats : {};
  const held = isObj(evidence.heldOut) ? evidence.heldOut : null;
  const usage = isObj(s.usage) && typeof s.usage.approved === "number" && typeof s.usage.adjusted === "number" ? { approved: s.usage.approved, adjusted: s.usage.adjusted } : null;
  const variants = Array.isArray(evidence.variants)
    ? evidence.variants.flatMap((v) => (isObj(v) && typeof v.variantId === "string" ? [{ variantId: v.variantId, url: typeof v.url === "string" ? v.url : null }] : []))
    : [];
  return {
    samples: numOr(s.samples, numOr(evidence.count, 0))!,
    jobs: numOr(s.jobs, 0)!,
    x: axisView(s.x),
    y: axisView(s.y),
    loggedErrorPx: isObj(s.loggedErrorPx) ? numOr(s.loggedErrorPx.median) : null,
    usage,
    folds: held ? numOr(held.folds) : null,
    variants,
  };
}

/** Kaymanın insan diliyle özeti: "12 px sağa ve 8 px aşağı" (etkin arayüz dilinde). Yalnızca sistematik eksenler. */
export function shiftText(a: AdjustEvidenceView): string {
  const parts: string[] = [];
  if (a.x?.systematic) parts.push(tt(a.x.medianPx > 0 ? "designLanguageLab:shift.right" : "designLanguageLab:shift.left", { n: Math.round(Math.abs(a.x.medianPx)) }));
  if (a.y?.systematic) parts.push(tt(a.y.medianPx > 0 ? "designLanguageLab:shift.down" : "designLanguageLab:shift.up", { n: Math.round(Math.abs(a.y.medianPx)) }));
  return parts.length === 2 ? tt("designLanguageLab:shift.both", { x: parts[0], y: parts[1] }) : (parts[0] ?? "");
}
