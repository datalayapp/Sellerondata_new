import { normalizeHeader } from './normalize';
import { isNumericCell, numericCellValue } from './read';
import type { ColumnMapping, Table } from './types';
import { detectNumberFormat, parseNumberAs, type NumberFormat } from './values';

/**
 * KALANLAR 1.3: KDV dahil toplam sütunu net tutar sanılmasın. Ayrı bir KDV tutarı sütunu varsa net tutar sütunu veriyle
 * sınanır: KDV ≈ (tutar − KDV) × oran ise tutar KDV dahildir, KDV ≈ tutar × oran ise KDV hariçtir. "KDV dahil" kararı
 * yalnız veriden çıkar; başlık tahmini (mapping.ts, eskisi gibi dar) veriyle desteklenmezse okuma kontrolü sorar (verify.ts).
 * Veri anlaşılmazken "KDV hariç" seçimi sorulmaz (gümrük vergisi "Tax" sütunlu dosyalar yeni engel görmez).
 */

/** Türkiye'de geçerli ve eski KDV oranları; eşlemedeki oran da denenir. 25 yok: %25 dahil, %20 hariçle aynı görünür. */
export const VAT_RATES = [20, 18, 10, 8, 1];

const VAT_WORD = /\b(kdv|vat|tax)\b/;
/** KDV tutarı sütununun başlığında KDV sözcüğünün yanında bulunabilecek sözcükler ("KDV Tutarı (TL)", "KDV (%20)", "VAT Amount"). */
const VAT_AMOUNT_WORDS = new Set(['kdv', 'vat', 'tax', 'tutari', 'tutar', 'amount', 'toplam', 'toplami', 'total', 'hesaplanan', 'tl', 'try', 'eur', 'usd']);
const VAT_INCL_HEADER = /\b(dahil|incl|including|inclusive|kdvli)\b/;

/**
 * KDV tutarı sütunu olabilecek başlık ("KDV", "KDV (%20)", "KDV Tutarı (TL)", "VAT Amount"); yalnız veri sınaması için.
 * "KDV Oranı", "KDV Hariç Tutar", "KDV Dahil" değildir. Sütunun gerçekten satır KDV'si olup olmadığına veri karar verir.
 */
export function isVatAmountHeader(nh: string): boolean {
  if (!nh || !VAT_WORD.test(nh)) return false;
  return nh.split(' ').every((w) => VAT_AMOUNT_WORDS.has(w) || /^\d+$/.test(w));
}

/**
 * `incl`: tutar KDV dahil, `pct` oranıyla (karar veren bütün satırlar aynı oranla uyuyor); `excl`: tutar KDV hariç
 * (satırların en az %90'ı); `zero`: KDV her satırda 0; `mixed`: KDV'li satırlar KDV dahil görünüyor ama KDV'si boş ya da 0
 * satırlar da var (tek oranla düşülemez); `unclear`: satırlar tek okumaya uymuyor; `none`: veri kanıtı yok (KDV sütunu boş
 * ya da tutar değişirken her satırda aynı değer: oran ya da fatura düzeyi KDV toplamı).
 */
export type VatVerdict = 'incl' | 'excl' | 'zero' | 'mixed' | 'unclear' | 'none';

export type VatEvidence = {
  /** Sınanan KDV tutarı sütunu. */
  vatColumn: string;
  verdict: VatVerdict;
  /** `incl`/`excl`/`mixed` kararında satırlara uyan oran (yüzde). */
  pct?: number;
  /** Karar veren satırlar (iki okumaya birden uyan ve KDV'si 0 ya da boş olan satırlar sayılmaz). */
  rows: number;
  /** Bunlardan karara uyanlar. */
  agreeing: number;
  /** KDV'si 0 ya da (sütunun başka satırları doluyken) boş olan, tutarı dolu satırlar. */
  zeroRows: number;
  /**
   * `unclear` iken karar veren satırların yarıdan çoğu aynı oranla KDV dahil okumaya uyuyor: "KDV hariç" seçimi de sorulur
   * (birkaç satır başka oranlı diye her tutar sessizce KDV'li kalmasın). Gümrük vergisi gibi dağınık "Tax" sütununda yok.
   */
  leansIncl?: boolean;
};

/** Sınanan en çok satır: büyük faturada karar ilk satırlardan çıkar. */
const MAX_ROWS = 5000;
/** "KDV hariç" kararı için satırların en az bu kadarı aynı okumaya uymalı ("KDV dahil" için hepsi). */
const EXCL_AGREE_SHARE = 0.9;

type Cells = Pick<Table, 'headers' | 'rows' | 'numeric'>;

function cellAt(t: Cells, r: number, c: number, fmt: NumberFormat): number | null {
  const raw = String(t.rows[r]?.[c] ?? '').trim();
  if (!raw) return null;
  return isNumericCell(t, r, c) ? numericCellValue(raw) : parseNumberAs(raw, fmt);
}

/** KDV tutarı başlıklı sütunlar (başlık sırasıyla). `exclude`: eşlemede başka alana verilmiş sütunlar. */
export function vatAmountColumns(t: Pick<Table, 'headers'>, exclude: readonly (string | undefined)[] = []): string[] {
  const skip = new Set(exclude.filter((h): h is string => !!h));
  return t.headers.filter((h) => !skip.has(h) && isVatAmountHeader(normalizeHeader(h)));
}

/** İlk KDV tutarı başlıklı sütun (`vatAmountColumns`). */
export function findVatAmountColumn(t: Pick<Table, 'headers'>, exclude: readonly (string | undefined)[] = []): string | undefined {
  return vatAmountColumns(t, exclude)[0];
}

/**
 * Net tutar sütununu KDV sütunuyla satır satır sınar. Satır başına: KDV ≈ (tutar − KDV) × p/100 → KDV dahil (p);
 * KDV ≈ tutar × p/100 → KDV hariç; pay 0,02 + KDV'nin binde biri (kalem başına yuvarlanmış KDV). İki okumaya birden uyan
 * satır (küçük tutar) karar vermez; KDV'si 0 ya da boş (sütunun başka satırı doluyken) satır `zeroRows`'a sayılır.
 * "KDV dahil" için karar veren bütün satırlar aynı oranla uymalı ve KDV'siz satır olmamalı (varsa `mixed`); "KDV hariç"
 * için %90'ı. `fmt` verilmezse iki sütunun metin hücrelerinden tahmin edilir.
 */
export function vatEvidence(t: Cells, netHeader: string, vatHeader: string, fmt?: NumberFormat, mappingPct?: number): VatEvidence {
  const ni = t.headers.indexOf(netHeader);
  const vi = t.headers.indexOf(vatHeader);
  const base: VatEvidence = { vatColumn: vatHeader, verdict: 'none', rows: 0, agreeing: 0, zeroRows: 0 };
  if (ni < 0 || vi < 0 || ni === vi) return base;
  const format = fmt ?? detectNumberFormat(textValues(t, [ni, vi]));
  const extra = typeof mappingPct === 'number' && mappingPct > 0 && mappingPct < 100 ? [mappingPct] : [];
  // eşlemedeki oran önce: eşit sayıda satıra uyan iki oranda o seçilir
  const rates = [...new Set([...extra, ...VAT_RATES])];
  const counts = new Map<string, number>();
  let informative = 0;
  let zeroRows = 0;
  let blankRows = 0;
  let vatFilled = 0;
  const vatValues = new Set<string>();
  const netValues = new Set<string>();
  let seen = 0;
  for (let r = 0; r < t.rows.length && seen < MAX_ROWS; r++) {
    let n = cellAt(t, r, ni, format);
    if (n == null || n === 0) continue;
    seen++;
    const vRaw = String(t.rows[r]![vi] ?? '').trim();
    if (!vRaw) {
      blankRows++;
      continue;
    }
    vatFilled++;
    if (vatValues.size < 2) vatValues.add(vRaw);
    if (netValues.size < 2) netValues.add(String(t.rows[r]![ni] ?? '').trim());
    let v = cellAt(t, r, vi, format);
    if (v == null) {
      informative++;
      continue;
    }
    // iade/alacak satırı: ikisi de eksi
    if (n < 0 && v <= 0) {
      n = -n;
      v = -v;
    }
    if (v === 0) {
      zeroRows++;
      continue;
    }
    if (n < 0 || v < 0 || v >= n) {
      informative++;
      continue;
    }
    const tol = 0.02 + v * 0.001 + 1e-9;
    const incl = rates.filter((p) => Math.abs(v - ((n - v) * p) / 100) <= tol);
    const excl = rates.filter((p) => Math.abs(v - (n * p) / 100) <= tol);
    if (incl.length && excl.length) continue;
    informative++;
    for (const p of incl) counts.set(`incl:${p}`, (counts.get(`incl:${p}`) ?? 0) + 1);
    for (const p of excl) counts.set(`excl:${p}`, (counts.get(`excl:${p}`) ?? 0) + 1);
  }
  // boş sütun ya da tutar değişirken hep aynı (sıfırdan farklı) değer: veri kanıtı değil
  if (vatFilled === 0) return base;
  if (vatFilled >= 3 && vatValues.size === 1 && netValues.size > 1 && /[1-9]/.test([...vatValues][0]!)) return base;
  zeroRows += blankRows;
  if (informative === 0) return { ...base, verdict: zeroRows > 0 ? 'zero' : 'none', zeroRows };
  let best: { side: 'incl' | 'excl'; pct: number; n: number } | null = null;
  let tie = false;
  for (const side of ['excl', 'incl'] as const) {
    for (const p of rates) {
      const n = counts.get(`${side}:${p}`) ?? 0;
      if (!n) continue;
      if (!best || n > best.n) {
        best = { side, pct: p, n };
        tie = false;
      } else if (n === best.n && best.side !== side) tie = true;
    }
  }
  const out = { ...base, rows: informative, zeroRows };
  if (!best || tie) return { ...out, verdict: 'unclear', agreeing: best?.n ?? 0 };
  if (best.side === 'excl') {
    return best.n >= informative * EXCL_AGREE_SHARE ? { ...out, verdict: 'excl', pct: best.pct, agreeing: best.n } : { ...out, verdict: 'unclear', agreeing: best.n };
  }
  // KDV dahil: tek bir uymayan satır da tahmini bozar (başka oran, KDV'siz kalem)
  if (best.n < informative) return { ...out, verdict: 'unclear', pct: best.pct, agreeing: best.n, ...(best.n * 2 > informative ? { leansIncl: true } : {}) };
  return { ...out, verdict: zeroRows > 0 ? 'mixed' : 'incl', pct: best.pct, agreeing: best.n };
}

function* textValues(t: Cells, cols: number[]): Generator<string> {
  for (let r = 0; r < t.rows.length && r < MAX_ROWS; r++) for (const c of cols) if (!isNumericCell(t, r, c)) yield String(t.rows[r]![c] ?? '');
}

/**
 * Net tutar sütununun KDV kanıtı: KDV başlıklı sütunlardan kanıt veren ilki (yoksa ilkinin `none` sonucu). KDV başlıklı
 * sütun yoksa null.
 */
export function netVatEvidence(t: Cells, netHeader: string, exclude: readonly (string | undefined)[], fmt?: NumberFormat, mappingPct?: number): VatEvidence | null {
  const cols = vatAmountColumns(t, [netHeader, ...exclude]);
  let first: VatEvidence | null = null;
  for (const c of cols) {
    const ev = vatEvidence(t, netHeader, c, fmt, mappingPct);
    if (ev.verdict !== 'none') return ev;
    first ??= ev;
  }
  return first;
}

/**
 * Eşlemenin KDV seçimi veriye uymuyor: `looksIncl` (KDV dahil görünüyor), `looksExcl`, `pctDiffers`, `zeroVat`, `mixed`
 * (KDV'li ve KDV'siz satır karışık), `unclear` ("KDV dahil" seçili ama veri bunu göstermiyor).
 */
export type VatProblem = 'looksIncl' | 'looksExcl' | 'pctDiffers' | 'zeroVat' | 'mixed' | 'unclear';

export type MappingVatCheck = { evidence: VatEvidence; problem: VatProblem | null };

/** Eşlemenin bileşen ve ek ücret sütunları (KDV sütunu sayılmaz). */
function takenColumns(m: ColumnMapping): (string | undefined)[] {
  return [m.baseAmount, m.discountAmount, m.fuelAmount, ...(m.surchargeColumns ?? []).map((s) => s.header), ...(m.chargePairs ?? []).map((p) => p.amount)];
}

/**
 * Eşlemenin "Tutarlar KDV dahil" seçimi ve oranı dosyadaki KDV sütunuyla tutuyor mu. KDV başlıklı sütun yoksa null (sınanamaz;
 * kullanıcının seçimi geçer). Veri kanıtı yokken ya da anlaşılmazken yalnız "KDV dahil" seçimi sorulur; net tutar başlığı
 * KDV dahil olduğunu açıkça yazıyorsa ("Toplam (KDV Dahil)") kanıtsızlık sorun sayılmaz.
 */
export function checkMappingVat(t: Cells, m: ColumnMapping, fmt?: NumberFormat): MappingVatCheck | null {
  if (!m.netAmount || t.headers.indexOf(m.netAmount) < 0) return null;
  const pct = m.vatPct ?? 20;
  const evidence = netVatEvidence(t, m.netAmount, takenColumns(m), fmt, pct);
  if (!evidence) return null;
  const incl = !!m.amountsIncludeVat;
  const nh = normalizeHeader(m.netAmount);
  const explicitIncl = VAT_WORD.test(nh) && VAT_INCL_HEADER.test(nh);
  let problem: VatProblem | null = null;
  switch (evidence.verdict) {
    case 'incl':
      problem = !incl ? 'looksIncl' : Math.abs((evidence.pct ?? pct) - pct) > 1e-9 ? 'pctDiffers' : null;
      break;
    case 'excl':
      problem = incl ? 'looksExcl' : null;
      break;
    case 'zero':
      problem = incl ? 'zeroVat' : null;
      break;
    case 'mixed':
      problem = 'mixed';
      break;
    default:
      // "KDV dahil" seçili ama veri göstermiyor; ya da "KDV hariç" seçili ama satırların çoğu KDV dahil görünüyor
      problem = (incl && !explicitIncl) || (!incl && evidence.leansIncl) ? 'unclear' : null;
  }
  return { evidence, problem };
}

/** `suggestMapping` için: net tutar sütununun veri kanıtı (eşleme henüz kurulurken). */
export function suggestedVatEvidence(t: Cells, m: ColumnMapping): VatEvidence | null {
  return m.netAmount ? netVatEvidence(t, m.netAmount, takenColumns(m)) : null;
}
