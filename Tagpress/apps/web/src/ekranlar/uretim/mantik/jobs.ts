import type { JobStatus, JobSummary, VariantSummary } from "@tagpress/domain";
import { clockText, dayWord, shortDateText, sizeCmText, sortLabel, stickerLabel, weekdayText } from "../metin.ts";

/**
 * Üretim ekranının saf yardımcıları (arayüzden bağımsız, birim testli): bölümler (Bekleyen, Düzenle, Onaylı),
 * ürün tipi, arama, sıralama, gösterilecek seçenek, panelde gezinme, göreli tarih.
 */

// ---------------------------------------------------------------- bölümler

/** Izgaranın üç bölümü: üretilmeyi bekleyenler (üretiliyor ve üretilemedi dahil), düzenlenip onaylanacaklar, onaylılar. */
export type Section = "pending" | "edit" | "approved";
export const SECTIONS: readonly Section[] = ["pending", "edit", "approved"];

export function sectionOf(job: Pick<JobSummary, "status">): Section {
  if (job.status === "ready") return "edit";
  if (job.status === "approved") return "approved";
  return "pending";
}

/** Sırada ya da üretiliyor: seçilemez, yeniden üretilemez. */
export const isBusy = (j: Pick<JobSummary, "status">) => j.status === "queued" || j.status === "generating";

/** Kullanıcının bakması gereken iş: hata/uyarı var (onaylanmış işlerde "kontrol et" sorunu sayılmaz). */
export function needsAttention(job: Pick<JobSummary, "status" | "worst">): boolean {
  if (job.status === "approved") return false;
  return job.worst === "error" || job.worst === "warning";
}

/** "Sorunlu" çipi: hata/uyarılı ya da üretilemeyen iş. */
export function isProblem(job: Pick<JobSummary, "status" | "worst">): boolean {
  return needsAttention(job) || job.status === "failed";
}

export function sectionCounts(jobs: readonly Pick<JobSummary, "status">[]): Record<Section, number> {
  const c: Record<Section, number> = { pending: 0, edit: 0, approved: 0 };
  for (const j of jobs) c[sectionOf(j)]++;
  return c;
}

// ---------------------------------------------------------------- ürün tipi

/**
 * Kartın tip etiketi. Ürün tipleri gelene kadar işin verisinden: sticker ise "Sticker", değilse etiket ölçüsü
 * ("3,8 cm"; boşsa dilin varsayılanı). Ürün tipleri gelince yalnız bu işlev tip kaydına bakar; süzgeç ve kart aynı kalır.
 */
export interface JobType {
  key: string;
  label: string;
}

export function jobType(job: Pick<JobSummary, "kind" | "labelSize">, defaultSize?: string | null): JobType | null {
  if (job.kind === "sticker") return { key: "sticker", label: stickerLabel() };
  const size = job.labelSize ?? defaultSize ?? null;
  return size ? { key: `size:${size}`, label: sizeCmText(size) } : null;
}

/** Tip çipleri: listedeki tipler, çoktan aza (eşitlikte ada göre). */
export function typeCounts(jobs: readonly Pick<JobSummary, "kind" | "labelSize">[], defaultSize?: string | null): Array<JobType & { count: number }> {
  const map = new Map<string, JobType & { count: number }>();
  for (const j of jobs) {
    const t = jobType(j, defaultSize);
    if (!t) continue;
    const cur = map.get(t.key);
    if (cur) cur.count++;
    else map.set(t.key, { ...t, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
}

// ---------------------------------------------------------------- ızgara

export interface BoardFilter {
  query: string;
  /** Yalnız sorunlular. */
  problems: boolean;
  /** Tip anahtarı (`jobType().key`); null hepsi. */
  type: string | null;
  sort: SortKey;
  dir: SortDir;
  defaultSize?: string | null;
}

/** Süzülmüş ve sıralanmış üç bölüm. */
export function boardOf(jobs: readonly JobSummary[], f: BoardFilter): Record<Section, JobSummary[]> {
  const out: Record<Section, JobSummary[]> = { pending: [], edit: [], approved: [] };
  for (const j of sortJobs(jobs, f.sort, f.dir)) {
    if (f.problems && !isProblem(j)) continue;
    if (f.type && jobType(j, f.defaultSize)?.key !== f.type) continue;
    if (!matchesQuery(j, f.query)) continue;
    out[sectionOf(j)].push(j);
  }
  return out;
}

/** Seçimden görünmeyen, silinen ya da üretime giren işleri çıkarır; değişiklik yoksa aynı küme döner. */
export function pruneIds(ids: ReadonlySet<string>, allowed: readonly string[]): ReadonlySet<string> {
  const keep = new Set(allowed);
  const next = new Set([...ids].filter((id) => keep.has(id)));
  return next.size === ids.size ? ids : next;
}

/** Onay kutusu: ekle ya da çıkar (yeni küme). */
export function toggleId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Hepsini seç" kutusunun durumu. */
export function allState(ids: ReadonlySet<string>, selectable: readonly string[]): boolean | "mixed" {
  const n = selectable.filter((id) => ids.has(id)).length;
  if (n === 0) return false;
  return n === selectable.length ? true : "mixed";
}

// ---------------------------------------------------------------- panelde gezinme

/** Paneldeki önceki/sonraki: aynı bölümün görünen sırasında dolanarak. Liste boşsa ya da tek işse null. */
export function stepIn(order: readonly string[], currentId: string | null, d: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = currentId ? order.indexOf(currentId) : -1;
  if (i < 0) return order[0] ?? null;
  if (order.length === 1) return null;
  return order[(i + d + order.length) % order.length] ?? null;
}

/** Onaydan sonra açılacak iş: onaydan önceki Düzenle sırasında sonraki, yoksa önceki; başka yoksa null. */
export function afterApprove(editOrder: readonly string[], approvedId: string): string | null {
  const i = editOrder.indexOf(approvedId);
  if (i < 0) return editOrder[0] ?? null;
  return editOrder[i + 1] ?? editOrder[i - 1] ?? null;
}

// ---------------------------------------------------------------- arama

function fold(s: string): string {
  return s.toLocaleLowerCase("tr").normalize("NFC");
}

/** Metin, sipariş no, şablon ve üründe arar (Türkçe büyük/küçük harf duyarsız; boşlukla ayrılan her sözcük bulunmalı). */
export function matchesQuery(job: JobSummary, q: string): boolean {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = fold([job.text, job.orderNo, job.templateKey, job.product, job.labelSize].filter(Boolean).join(" \n "));
  return terms.every((t) => hay.includes(t));
}

// ---------------------------------------------------------------- sıralama

export type SortKey = "created" | "order" | "status" | "template";
export type SortDir = "asc" | "desc";
export interface SortChoice {
  id: string;
  label: string;
  sort: SortKey;
  dir: SortDir;
}

const sortChoice = (sort: SortKey, dir: SortDir): SortChoice => ({
  id: `${sort}-${dir}`,
  /** Ad okunduğu anda etkin dilde (`production:sort.<anahtar><Yön>`). */
  get label() {
    return sortLabel(`${sort}-${dir}`);
  },
  sort,
  dir,
});

export const SORT_CHOICES: SortChoice[] = [
  sortChoice("created", "desc"),
  sortChoice("created", "asc"),
  sortChoice("order", "asc"),
  sortChoice("order", "desc"),
  sortChoice("status", "asc"),
  sortChoice("template", "asc"),
  sortChoice("template", "desc"),
];

/** Durum sırası: önce dikkat isteyenler, sonra akış sırası. */
const STATUS_RANK: Record<JobStatus, number> = {
  failed: 0,
  new: 1,
  queued: 2,
  generating: 3,
  ready: 4,
  approved: 5,
};

const collator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });

/** Boş değerler yönden bağımsız hep sonda. */
function cmpNullable(a: string | null | undefined, b: string | null | undefined, dir: SortDir): number {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const c = collator.compare(a, b);
  return dir === "asc" ? c : -c;
}

/** Kararlı sıralama: eşitlikte iş sırası (seq) ve kimlik. Yeni dizi döner. */
export function sortJobs(jobs: readonly JobSummary[], sort: SortKey, dir: SortDir): JobSummary[] {
  const bySeq = (a: JobSummary, b: JobSummary) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...jobs].sort((a, b) => {
    let c = 0;
    switch (sort) {
      case "created":
        c = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;
        return dir === "asc" ? c : -c;
      case "order":
        c = cmpNullable(a.orderNo, b.orderNo, dir);
        break;
      case "status":
        c = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (dir === "desc") c = -c;
        break;
      case "template":
        c = cmpNullable(a.templateKey, b.templateKey, dir);
        break;
    }
    return c || bySeq(a, b);
  });
}

// ---------------------------------------------------------------- görüntülenecek varyasyon

/** Prova ızgarasında gösterilecek varyasyon: onaylı, yoksa AI'ın ilk tercihi, yoksa en yüksek puanlı, yoksa sonuncu. */
export function shownVariant(job: Pick<JobSummary, "variants" | "approvedVariantId">): VariantSummary | null {
  const vs = job.variants;
  if (vs.length === 0) return null;
  const approved = vs.find((v) => v.id === job.approvedVariantId || v.approved);
  if (approved) return approved;
  const fresh = vs.filter((v) => !v.stale);
  const pool = fresh.length ? fresh : vs;
  const unsuspected = pool.filter((v) => !v.suspect);
  const cands = unsuspected.length ? unsuspected : pool;
  const ranked = cands.filter((v) => v.aiRank !== null).sort((a, b) => (a.aiRank ?? 0) - (b.aiRank ?? 0));
  if (ranked[0]) return ranked[0];
  const scored = cands.filter((v) => v.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (scored[0]) return scored[0];
  return cands[cands.length - 1] ?? null;
}

/** Varyasyonları no sırasıyla (V1, V2…) verir. */
export function variantsByNo<T extends { no: number }>(vs: readonly T[]): T[] {
  return [...vs].sort((a, b) => a.no - b.no);
}

/** "1"–"9" kısayoluyla seçilecek varyasyon (1 tabanlı konum). */
export function variantAtKey(vs: readonly VariantSummary[], key: number): VariantSummary | null {
  return variantsByNo(vs)[key - 1] ?? null;
}

// ---------------------------------------------------------------- tarih

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

type DayKind = "today" | "yesterday" | "week" | "date" | "invalid";

function dayKind(d: Date, now: Date): DayKind {
  if (Number.isNaN(d.getTime())) return "invalid";
  if (sameDay(d, now)) return "today";
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000);
  if (diffDays === 1) return "yesterday";
  if (diffDays > 1 && diffDays < 7) return "week";
  return "date";
}

/** "Bugün" / "Dün" / gün adı (son 6 gün) / "7 Eki" (başka yıl: "7 Eki 2025"). */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const kind = dayKind(d, now);
  if (kind === "invalid") return "";
  if (kind === "today" || kind === "yesterday") return dayWord(kind);
  if (kind === "week") return weekdayText(d);
  return shortDateText(d, d.getFullYear() !== now.getFullYear());
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : clockText(d);
}

/** Bugün ya da dün mü (parti listesinde saat bu günlerde gösterilir). */
export function isRecentDay(iso: string, now: Date = new Date()): boolean {
  const k = dayKind(new Date(iso), now);
  return k === "today" || k === "yesterday";
}

/** "Bugün 14:20", "Dün 09:05", "7 Eki" (bugün ve dün saatli). */
export function relativeStamp(iso: string, now: Date = new Date()): string {
  const day = relativeDay(iso, now);
  return isRecentDay(iso, now) ? `${day} ${timeOfDay(iso)}` : day;
}


// ---------------------------------------------------------------- görünüm metinleri

/** "5.2" → "5,2 cm" */
export function sizeText(id: string | null | undefined): string | null {
  if (!id) return null;
  return sizeCmText(id);
}

/** Metni tek satıra indirir (kart): satır sonları " / " olur. */
export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " / ").trim();
}

/** Sorun sayısı: bilgi notları hariç hata + uyarı. */
export function issueCount(job: Pick<JobSummary, "issues">): number {
  return job.issues.filter((i) => i.severity !== "info").length;
}
