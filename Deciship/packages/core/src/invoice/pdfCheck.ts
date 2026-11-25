import { round2, round3, sumMoney, toCents } from '../calc';
import { ambiguousWeightText, weightAs, type WeightFormat, type WeightReadings } from '../measureInput';
import { normalizeTracking } from '../tracking';
import { pdfNumberReadings } from './pdfRead';
import { INCH_TO_CM, LB_TO_KG } from './values';
import type { RowFlagCode } from './verify';

/**
 * PDF fatura satırlarının PDF metniyle karşılaştırılması (Mesaj 5, denetim 04-B12). Yapay zekânın okuduğu takip no ve
 * net tutar PDF'in metin katmanında aranır; bulunamayan satır işaretlenir ("Kontrol edilecek / İncele"). Yüklemeyi
 * durdurmaz. Metin katmanı yoksa (taranmış PDF) denetim yapılmaz, bayrak konmaz.
 *
 * Kurallar (R2 incelemesi):
 * - Takip no: 8 karakter ve üstü normalleştirilmiş no metnin harf/rakam dizisinde aranır (boşluk/tire ile bölünmüş
 *   yazım da bulunur). Daha kısa no alt dize olarak aranmaz: boşlukla ayrılmış bağımsız bir parça olmalı ("4567",
 *   "1234567890"un ya da "2026", "20.10.2026"nın içinde bulunmuş sayılmaz).
 * - Tutar adayı yalnız iki ondalıklı yazılmış sayılardır ("1.234,56", "1,234.56", "12,50", "45.00"); tam sayı ("12",
 *   desi), tek ondalık ve tarih ("21.10.2026") aday değildir. Tam sayı gibi okunan tutar (120) metinde "120,00" aranır.
 * - Yakınlık: tutar, takip no'nun geçtiği metin satırında ya da izleyen en çok 3 satırda aranır; denetlenen başka bir
 *   takip no'nun geçtiği satırda pencere biter (alt satırın tutarı bu satırınki sayılmaz). Takip no metinde yoksa tutar
 *   bütün metinde aranır (satır zaten işaretlidir). Satır sonu olmayan metinde (tek satırlık sayfa) pencere sayfadır.
 * - Maliyet metin uzunluğu + satır sayısıyla doğrusaldır (satır başına bütün metni taramak yok).
 *
 * Denetim 05-B4 (ağırlık, ölçü, ek ücret): sonraki takip no'ya kadar en çok 12 satırlık pencerede (blok düzeni; net tutarın
 * penceresi 3 satır kalır), yalnız takip no metinde bulunduysa ve değer okunduysa (null
 * denetlenmez). Ağırlık ve ölçü her sayı yazımıyla aranır (tam sayı, tek ondalık, virgül/nokta, binlik; `pdfNumberReadings`);
 * birim lb, g ya da in ise basılı değer (kg/cm karşılığı değil) aranır, çeviri payıyla. Ek ücret ve yakıt tutarı net tutar
 * gibi aranır (iki ondalık, KDV dahil hâli de). Bulunamazsa `PDF_WEIGHT_UNVERIFIED`, `PDF_DIMS_UNVERIFIED`,
 * `PDF_SURCHARGE_UNVERIFIED`.
 *
 * Y44 (yakıt yalnız yüzde olarak basılı): yakıt tutarı metinde yoksa ama belgede yakıt sözcüğüyle aynı metin satırında
 * basılı bir yüzde ("Yakıt %12,5", "Fuel Surcharge 12.5%") taşıma bedelinden (liste, liste − indirim ya da net − yakıt − ek
 * ücretler) bu yakıtı kuruşu kuruşuna veriyorsa yakıt doğrulanmış sayılır (model yüzdeden hesaplamış). KDV oranına eşit
 * yüzde (`vatFactors`) sayılmaz: KDV tutarının yakıt diye yazılması yakalanır. İnceleme 2026-11-13: yakıt sözcüğü olmayan
 * satırdaki yüzde (yalnız sütun başlığında "Yakıt") sayılmaz, indirim sözcüğünün yanındaki yüzde ("İndirim %15", "%15
 * discount") hiç sayılmaz: %15 indirimli satırda model 15,00 yakıt uydurunca bayrak kalkıyordu.
 *
 * Denetim 05-B2 (satır penceresinde KDV): pencerede hem net N hem N ÷ (1 + oran) basılıysa, N × (1 + oran) basılı değilse
 * ve modelin bileşenleri (taşıma − indirim + yakıt + ek ücretler) N'yi açıklamıyorsa model büyüğünü (KDV dahil tutarı) net
 * demiş olabilir: `PDF_VAT_UNCLEAR`. Yanlış alarma karşı: taşıma 100 + yakıt 20 = net 120 (100 = 120 ÷ 1,2 rastlantısı)
 * bileşenlerle açıklanır; belgede "KDV"/"VAT" hiç geçmiyorsa kural çalışmaz; KDV'nin ek ücret diye yazılması bileşen sayılmaz.
 */

/**
 * `text`: metin vardı, satırlar arandı. `none`: metin katmanı yok (taranmış PDF). `skipped`: denetim o an yapılamadı
 * (API: dosya okuma havuzu meşgul ya da süre/bellek sınırı; Mesaj 6). `checkPdfLines` `skipped` üretmez.
 */
export type PdfCheckMethod = 'text' | 'none' | 'skipped';

/**
 * `weightAmbiguity` (K36): satırın ağırlığı penceresinde "1.500" gibi iki türlü okunan basılı yazımla eşleşiyor (kg
 * karşılıkları). Bayrak değildir: kullanıcı seçmeden içe aktarılmaz (API), seçince kalkar.
 */
export type PdfCheckRow = { rowIndex: number; codes: RowFlagCode[]; weightAmbiguity?: Partial<Record<'actualKg' | 'billedKg', PdfWeightReadings>> };
/** Basılı iki okumalı ağırlığın kg karşılıkları, basılı ayırıcısı (`sep`: seçilen yazım biçimi her yazıma kendi ayırıcısıyla uygulanır) ve basılı yazımı (`text`, soruda gösterilir). */
export type PdfWeightReadings = WeightReadings & { sep: '.' | ','; text: string };

export type PdfCheckResult = {
  method: PdfCheckMethod;
  /** Denetlenen satır sayısı (`none` iken 0). */
  checked: number;
  /** Yalnız bayrağı (ya da K36 ağırlık sorusu, `weightAmbiguity`) olan satırlar, `rowIndex` sırasıyla. */
  rows: PdfCheckRow[];
};

/**
 * Denetlenen satır. Tutarlar KDV hariç net (bileşenler satırla aynı kuralla), ağırlık kg, ölçü cm (çeviri sonrası; basılı
 * birim `units` ile verilir). İsteğe bağlı alanlar yoksa ya da null ise o alan denetlenmez.
 */
export type PdfCheckLine = {
  rowIndex: number;
  trackingNo: string;
  netAmount: number;
  actualKg?: number | null;
  billedKg?: number | null;
  dims?: { l: number; w: number; h: number } | null;
  baseAmount?: number | null;
  discountAmount?: number | null;
  fuelAmount?: number | null;
  surcharges?: readonly { code?: string | null; name?: string | null; amount: number }[] | null;
};

/**
 * Basılı birim (okumanın notu, `File.preview.read`). `any`: bilinmiyor ya da gruplar farklı birim söyledi: bütün
 * karşılıklar denenir (yanlış alarmdan kaçınmak için gevşek). Verilmezse kg / cm.
 */
export type PdfCheckUnits = { weight?: 'kg' | 'lb' | 'g' | 'any'; dim?: 'cm' | 'in' | 'any' };

/** Varsayılan KDV çarpanı: PDF faturada tutar KDV dahil yazılmış olabilir (%20). */
export const PDF_CHECK_DEFAULT_VAT_FACTORS: readonly number[] = [1.2];

/** Alt dize olarak aranan takip no'nun en kısa hâli; daha kısası bağımsız parça olmalı. */
export const PDF_TRACKING_MIN_SUBSTRING = 8;
/** Tutarın takip no satırından sonra arandığı en çok satır. */
export const PDF_AMOUNT_WINDOW_LINES = 3;
/** Bir takip no'nun yakınlık için tutulan en çok geçişi (özet sayfaları vb.). */
const MAX_OCCURRENCES = 50;
/** Ayraçlı kısa takip no ("AB-123") için en çok bakılan satır. */
const SHORT_FALLBACK_LINES = 2000;

/** Rakam ve ayraçlardan oluşan sayı adayları ("1.234,56", "1,234.56", "12,50", "-45", "(12,00)"). */
const NUMBER_TOKEN = /\d[\d.,]*\d|\d/g;
/** İki ondalıkla biten en uzun rakam/ayraç dizisi; doğrulaması `twoDecimalCents`. */
const TWO_DECIMAL_TOKEN = /(?<![\d.,])\d[\d.,]*[.,]\d\d(?![.,]?\d)/g;

const KEY_LEN = PDF_TRACKING_MIN_SUBSTRING;
/** 8 karakterlik pencerenin 32 bitlik kayan özeti (Rabin-Karp, mod 2^32). */
const HASH_BASE = 1_000_003;
const HASH_TOP = (() => {
  let x = 1;
  for (let i = 0; i < KEY_LEN - 1; i++) x = Math.imul(x, HASH_BASE);
  return x;
})();
const BLOOM_SHIFT = 10;
const BLOOM_SIZE = 1 << (32 - BLOOM_SHIFT);

/** Metin büyük harfe çevrilir, harf ve rakam dışındaki her şey atılır (takip no araması için). */
export function pdfSearchText(pageTexts: readonly string[]): string {
  return pageTexts.join('\n').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * İki ondalıklı yazılmış sayının kuruş değeri (mutlak), değilse null. Ondalık ayracı sondan üçüncü karakterdir; öbür
 * ayraç binliktir ve üçlü gruplarla yazılmalıdır. "1.234,56" / "1,234.56" / "1234,56" / "12.50" → kuruş; "12", "12,5",
 * "1.234", "21.10.2026" → null.
 */
export function twoDecimalCents(token: string): number | null {
  const m = /^(\d[\d.,]*?)([.,])(\d{2})$/.exec(token);
  if (!m) return null;
  const [, int, dec, frac] = m as unknown as [string, string, string, string];
  const thousands = dec === ',' ? '.' : ',';
  if (int.includes(dec)) return null;
  if (int.includes(thousands)) {
    const parts = int.split(thousands);
    if (!/^\d{1,3}$/.test(parts[0]!) || parts.slice(1).some((p) => !/^\d{3}$/.test(p))) return null;
  } else if (!/^\d+$/.test(int)) return null;
  const whole = Number(int.split(thousands).join(''));
  if (!Number.isSafeInteger(whole)) return null;
  return whole * 100 + Number(frac);
}

/** Metinde (tek satır) sıfırdan büyük, iki ondalıklı yazılmış bir tutar var mı (`twoDecimalCents` kuralıyla). */
export function pdfTextHasAmount(text: string): boolean {
  for (const mt of text.matchAll(TWO_DECIMAL_TOKEN)) {
    const c = twoDecimalCents(mt[0]);
    if (c != null && c > 0) return true;
  }
  return false;
}

/** Sayfalardaki iki ondalıklı sayıların kuruş değerleri (bütün metin). */
export function pdfAmountSet(pageTexts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const text of pageTexts) {
    for (const token of text.match(NUMBER_TOKEN) ?? []) {
      const c = twoDecimalCents(token);
      if (c != null) out.add(c);
    }
  }
  return out;
}

/** Sıralı dizide `x`'ten büyük ilk elemanın yeri. */
function upperBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sıralı dizide [from, to] aralığında eleman var mı. */
function anyInRange(arr: readonly number[], from: number, to: number): boolean {
  const i = upperBound(arr, from - 1);
  return i < arr.length && arr[i]! <= to;
}

/** Satır başları (0 ve her `\n`'den sonraki konum). */
function lineStarts(str: string): number[] {
  const out = [0];
  for (let k = str.indexOf('\n'); k >= 0; k = str.indexOf('\n', k + 1)) out.push(k + 1);
  return out;
}

const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
const isSpace = (c: number) => c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160;

/**
 * Satırları PDF metniyle karşılaştırır (kurallar dosya başında).
 * - Takip no bulunamazsa `PDF_TRACKING_UNVERIFIED`; tutar (net ya da her `f` için `round2(net × f) ± 0,01`, varsayılan
 *   f = 1,2) bulunamazsa `PDF_AMOUNT_UNVERIFIED`. İşaret dikkate alınmaz (iade "-12,50" ya da "(12,50)" yazılabilir).
 * - Sonra (dosya başı) `PDF_VAT_UNCLEAR`, `PDF_WEIGHT_UNVERIFIED`, `PDF_DIMS_UNVERIFIED`, `PDF_SURCHARGE_UNVERIFIED`.
 * - Hiçbir sayfada metin yoksa `method: 'none'`, `checked: 0`, bayrak yok.
 */
export function checkPdfLines(pageTexts: string[], lines: readonly PdfCheckLine[], opts: { vatFactors?: readonly number[]; units?: PdfCheckUnits } = {}): PdfCheckResult {
  const factors = opts.vatFactors && opts.vatFactors.length ? opts.vatFactors : PDF_CHECK_DEFAULT_VAT_FACTORS;
  const text = pageTexts.join('\n');
  const U = text.toUpperCase();
  // Harf/rakam dizisi; satır sonları yalnız satır başlarını bulmak için kalır, aramada yoktur.
  const S = U.replace(/[^A-Z0-9\n]/g, '');
  const search = S.replace(/\n/g, '');
  if (!search.length) return { method: 'none', checked: 0, rows: [] };
  // i. satırın `search` içindeki başı: S'deki başı eksi önceki satır sonu sayısı
  const lineStart = lineStarts(S).map((p, i) => p - i);
  const lineOf = (p: number) => upperBound(lineStart, p) - 1;

  // Tutarlar: yalnız iki ondalıklı yazımlar, geçtikleri satırla (kuruş → artan satır listesi).
  const rawStarts = lineStarts(text);
  const amountLines = new Map<number, number[]>();
  for (const mt of text.matchAll(TWO_DECIMAL_TOKEN)) {
    const c = twoDecimalCents(mt[0]);
    if (c == null) continue;
    const line = upperBound(rawStarts, mt.index) - 1;
    const list = amountLines.get(c);
    if (!list) amountLines.set(c, [line]);
    else if (list[list.length - 1] !== line) list.push(line);
  }

  // Takip no'lar: uzunlar 8 karakterlik son ekleriyle tek geçişte, kısalar bağımsız parça olarak.
  const needleOf = (l: PdfCheckLine) => normalizeTracking(l.trackingNo ?? '').replace(/[^A-Z0-9]/g, '');
  const occurrences = new Map<string, number[]>();
  const bySuffix = new Map<number, string[]>();
  const shortNeedles = new Set<string>();
  for (const l of lines) {
    const n = needleOf(l);
    if (!n || occurrences.has(n)) continue;
    occurrences.set(n, []);
    if (n.length < KEY_LEN) {
      shortNeedles.add(n);
      continue;
    }
    let h = 0;
    for (let k = n.length - KEY_LEN; k < n.length; k++) h = (Math.imul(h, HASH_BASE) + n.charCodeAt(k)) | 0;
    const list = bySuffix.get(h);
    if (list) list.push(n);
    else bySuffix.set(h, [n]);
  }
  const record = (n: string, line: number) => {
    const list = occurrences.get(n)!;
    if (list.length < MAX_OCCURRENCES && list[list.length - 1] !== line) list.push(line);
  };

  if (bySuffix.size) {
    // Map'e bakmadan önce bit tablosu: konumların çoğu hiçbir son eke uymaz. Özet çakışması `startsWith` ile elenir.
    const bloom = new Uint8Array(BLOOM_SIZE);
    for (const h of bySuffix.keys()) bloom[h >>> BLOOM_SHIFT] = 1;
    let h = 0;
    for (let p = 0; p < search.length; p++) {
      if (p >= KEY_LEN) h = (h - Math.imul(search.charCodeAt(p - KEY_LEN), HASH_TOP)) | 0;
      h = (Math.imul(h, HASH_BASE) + search.charCodeAt(p)) | 0;
      if (p < KEY_LEN - 1 || bloom[h >>> BLOOM_SHIFT] === 0) continue;
      const hit = bySuffix.get(h);
      if (!hit) continue;
      const end = p + 1;
      for (const n of hit) {
        const start = end - n.length;
        if (start >= 0 && search.startsWith(n, start)) record(n, lineOf(start));
      }
    }
  }

  if (shortNeedles.size) {
    const uStarts = lineStarts(U);
    const lineOfU = (p: number) => upperBound(uStarts, p) - 1;
    /** U[from..to) bağımsız parça mı: iki yanda (harf/rakam olmayan işaretler atlanınca) boşluk ya da metin sınırı. */
    const standalone = (from: number, to: number): boolean => {
      let a = from - 1;
      while (a >= 0 && !isSpace(U.charCodeAt(a)) && !isAlnum(U.charCodeAt(a))) a--;
      if (a >= 0 && !isSpace(U.charCodeAt(a))) return false;
      let b = to;
      while (b < U.length && !isSpace(U.charCodeAt(b)) && !isAlnum(U.charCodeAt(b))) b++;
      return b >= U.length || isSpace(U.charCodeAt(b));
    };
    for (const n of shortNeedles) {
      const list = occurrences.get(n)!;
      for (let q = U.indexOf(n); q >= 0 && list.length < MAX_OCCURRENCES; q = U.indexOf(n, q + 1)) {
        if (standalone(q, q + n.length)) record(n, lineOfU(q));
      }
      if (list.length) continue;
      // İçinde ayraç olan yazım ("AB-123" → AB123): harf/rakam dizisinde geçtiği satırların parçalarına bakılır (sınırlı).
      let visited = 0;
      let p = search.indexOf(n);
      while (p >= 0 && visited < SHORT_FALLBACK_LINES && list.length < MAX_OCCURRENCES) {
        visited++;
        const line = lineOf(p);
        const raw = U.slice(uStarts[line], (uStarts[line + 1] ?? U.length + 1) - 1);
        if (raw.split(/\s+/).some((t) => t.replace(/[^A-Z0-9]/g, '') === n)) record(n, line);
        const next = lineStart[line + 1];
        if (next == null) break;
        p = search.indexOf(n, Math.max(next, p + 1));
      }
    }
  }
  const trackingLines = [...new Set([...occurrences.values()].flat())].sort((a, b) => a - b);

  const candidates = (net: number): number[] => {
    const abs = Math.abs(net);
    const out = [toCents(abs)];
    for (const f of factors) {
      const c = toCents(round2(abs * f));
      out.push(c, c - 1, c + 1);
    }
    return out;
  };
  /** Takip no'nun geçtiği satırdan başlayan pencerenin son satırı (sonraki takip no satırından önce). */
  const windowEnd = (line: number, size = PDF_AMOUNT_WINDOW_LINES) => {
    const next = trackingLines[upperBound(trackingLines, line)];
    return Math.min(line + size, next == null ? Infinity : next - 1);
  };
  /** Ağırlık, ölçü ve ek ücretin penceresi: sonraki takip no'ya kadar, en çok `PDF_FIELD_WINDOW_LINES`. */
  const fieldWindowEnd = (line: number) => windowEnd(line, PDF_FIELD_WINDOW_LINES);
  /** `keys`'ten biri pencerelerden birinde geçiyor mu (`index`: anahtar → artan satır listesi). */
  const inWindow = (index: ReadonlyMap<number, number[]>, keys: readonly number[], at: readonly number[], end: (line: number) => number = windowEnd): boolean =>
    at.some((line) => {
      const last = end(line);
      return keys.some((c) => {
        const where = index.get(c);
        return where != null && anyInRange(where, line, last);
      });
    });
  const amountNear = (net: number, at: readonly number[]): boolean => {
    if (!Number.isFinite(net)) return false;
    const cs = candidates(net);
    if (!at.length) return cs.some((c) => amountLines.has(c));
    return inWindow(amountLines, cs, at);
  };

  // 05-B4: ağırlık ve ölçü sayıları yalnız gerekirse ve yalnız pencere satırlarında okunur (16 MB metinde bütün sayıları
  // tutmamak için). Anahtar: değerin binde biri (her okunuşu: TR, EN, düz).
  const needsNumbers = lines.some((l) => posNum(l.actualKg) || posNum(l.billedKg) || (l.dims && (posNum(l.dims.l) || posNum(l.dims.w) || posNum(l.dims.h))));
  const numberLines = new Map<number, number[]>();
  /**
   * K36: pencerelerdeki "1.500" gibi iki türlü okunan, tutar olmayan yazımlar (para işareti bitişik değil): okumalarının binde
   * bir anahtarı → satırlar ve okumalar. `plainLines`: aynı pencerelerde tek türlü okunan sayılar ("1,5", "2", "1500"); ağırlık
   * böyle de basılıysa soru sorulmaz (ör. "2 kg 2.000 TL").
   */
  /** `unit`: yazımın hemen ardında ağırlık birimi var ("1,500 kg"): satırın ağırlığı odur. */
  const ambiguousLines = new Map<number, { lines: number[]; r: PdfWeightReadings; unit: boolean }[]>();
  const plainLines = new Map<number, number[]>();
  const addLine = (m: Map<number, number[]>, key: number, i: number) => {
    const list = m.get(key);
    if (!list) m.set(key, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  };
  if (needsNumbers && trackingLines.length) {
    const lineCount = rawStarts.length;
    const mark = new Uint8Array(lineCount);
    for (const t of trackingLines) for (let k = t, last = Math.min(fieldWindowEnd(t), lineCount - 1); k <= last; k++) mark[k] = 1;
    for (let i = 0; i < lineCount; i++) {
      if (!mark[i]) continue;
      const raw = text.slice(rawStarts[i], (rawStarts[i + 1] ?? text.length + 1) - 1);
      for (const mt of raw.matchAll(NUMBER_TOKEN)) {
        const tok = mt[0];
        const amb = ambiguousWeightText(tok, 'any');
        const before = raw.slice(Math.max(0, mt.index - 4), mt.index);
        const after = raw.slice(mt.index + tok.length, mt.index + tok.length + 5);
        if (amb && !CURRENCY_BEFORE.test(before) && !CURRENCY_AFTER.test(after)) {
          const sep = tok.includes(',') ? ',' : '.';
          for (const v of [amb.decimal, amb.thousands]) {
            const key = Math.round(v * 1000);
            const list = ambiguousLines.get(key) ?? [];
            const unit = WEIGHT_UNIT_AFTER.test(raw.slice(mt.index + tok.length, mt.index + tok.length + 8));
            const e = list.find((x) => x.r.sep === sep && x.unit === unit);
            if (!e) ambiguousLines.set(key, [...list, { lines: [i], r: { ...amb, sep, text: tok }, unit }]);
            else if (e.lines[e.lines.length - 1] !== i) e.lines.push(i);
          }
        }
        if (!amb) for (const v of pdfNumberReadings(tok)) addLine(plainLines, Math.round(v * 1000), i);
        for (const v of pdfNumberReadings(tok)) {
          const key = Math.round(v * 1000);
          const list = numberLines.get(key);
          if (!list) numberLines.set(key, [i]);
          else if (list[list.length - 1] !== i) list.push(i);
        }
      }
    }
  }
  const weightFactors = WEIGHT_PRINT_FACTORS[opts.units?.weight ?? 'kg'];
  const dimFactors = DIM_PRINT_FACTORS[opts.units?.dim ?? 'cm'];
  /** `v`'nin `f` çarpanlı basılı hâllerinin binde bir anahtarları (çevrilmiş birimde çeviri payıyla). */
  const printedKeys = (v: number, f: number): number[] => {
    if (f === 1) return [Math.round(v * 1000)];
    const keys: number[] = [];
    const c = v * f;
    const tol = Math.max(0.006, c * 0.003);
    for (let d = 0; d <= 3; d++) {
      const t = Math.round(c * 10 ** d) / 10 ** d;
      if (Math.abs(t - c) <= tol) keys.push(Math.round(t * 1000));
    }
    return keys;
  };
  /** Değer `v` (kg ya da cm) basılı hâlleriyle pencerede mi. Çevrilmiş birimde basılı sayı çeviri payıyla aranır. */
  const valueNear = (v: number, factors: readonly number[], at: readonly number[]): boolean =>
    inWindow(
      numberLines,
      factors.flatMap((f) => printedKeys(v, f)),
      at,
      fieldWindowEnd,
    );
  /**
   * K36 (inceleme): belgenin sayı biçimi açık kanıttan: iki ayırıcılı gruplu sayı ("1.234,56" / "1,234.56") ya da para işaretli
   * iki ondalıklı tutar ("250,00 TL", "$12.50"). Tek yönde kanıt varsa o biçim, yoksa ya da iki yönde varsa null. Biçim belliyse
   * "1,500" (Türkçe belge) sorulmaz; yapay zekânın değeri belgenin biçimine uymuyorsa yine sorulur.
   */
  let docFormat: WeightFormat | null | undefined;
  const documentFormat = (): WeightFormat | null => {
    if (docFormat !== undefined) return docFormat;
    let tr = 0;
    let en = 0;
    for (const mt of text.matchAll(NUMBER_TOKEN)) {
      const tok = mt[0];
      if (STRONG_TR.test(tok)) tr++;
      else if (STRONG_EN.test(tok)) en++;
      else if (/^\d+[.,]\d{2}$/.test(tok)) {
        const before = text.slice(Math.max(0, mt.index - 4), mt.index);
        const after = text.slice(mt.index + tok.length, mt.index + tok.length + 5);
        if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) tok.includes(',') ? tr++ : en++;
      }
      if (tr && en) break;
    }
    // inceleme: tek kanıt (kapaktaki bir "1.234,56 TL" toplamı, "Kur 34.50 TL") bütün belgeye karar vermesin: tek yönde en az 2
    docFormat = tr >= 2 && !en ? 'tr' : en >= 2 && !tr ? 'en' : null;
    return docFormat;
  };
  /** K36: ağırlık `v` penceresinde "1.500" / "1,500" gibi iki türlü okunan basılı yazımla eşleşiyorsa iki okumanın kg karşılıkları. */
  const ambiguousWeightNear = (v: number, at: readonly number[]): PdfWeightReadings | null => {
    // ağırlık tek türlü okunan bir yazımla da basılıysa (ör. "2 kg … 2.000"), "N.NNN" ağırlığın yazımı değildir: sorulmaz
    if (inWindow(plainLines, weightFactors.flatMap((f) => printedKeys(v, f)), at, fieldWindowEnd)) return null;
    // penceredeki bütün eşleşen yazımlar (her çarpanla); karar ilkine değil hepsine bakar (inceleme: "1.500   1,500 kg")
    const found: { e: { r: PdfWeightReadings; unit: boolean }; f: number; keys: number[] }[] = [];
    for (const f of weightFactors) {
      const keys = printedKeys(v, f);
      for (const key of keys)
        for (const e of ambiguousLines.get(key) ?? []) {
          if (at.some((line) => anyInRange(e.lines, line, fieldWindowEnd(line))) && !found.some((x) => x.e === e)) found.push({ e, f, keys });
        }
    }
    if (!found.length) return null;
    // birim bitişik yazım varsa satırın ağırlığı odur ve o karar verir; yoksa hepsi
    const relevant = found.some((x) => x.e.unit) ? found.filter((x) => x.e.unit) : found;
    const fmt = documentFormat();
    const agrees = (x: (typeof found)[number]) => !!fmt && x.keys.includes(Math.round(weightAs(x.e.r, x.e.r.sep, fmt) * 1000));
    // belgenin biçimi belli ve her ilgili yazım o biçimde okunan değeri veriyorsa soru yok; biri uymuyorsa sorulur
    if (relevant.every(agrees)) return null;
    const { e, f } = relevant.find((x) => !agrees(x)) ?? relevant[0]!;
    return f === 1 ? e.r : { decimal: round3(e.r.decimal / f), thousands: round3(e.r.thousands / f), sep: e.r.sep, text: e.r.text };
  };

  // 05-B2: belgede KDV geçiyor mu (geçmiyorsa pencere kuralı çalışmaz; yurt dışı faturada yakıt tam %20 olabilir)
  const vatWord = VAT_WORD.test(text);
  const vatFactorsUp = factors.filter((f) => f > 1.0001);
  const cents = (n: number) => toCents(Math.abs(n));
  const near1 = (c: number) => [c, c - 1, c + 1];
  /**
   * Modelin bileşenleri neti açıklıyor mu: taşıma − indirim + yakıt + ek ücretler ≈ net. Taban netten farklı olmalı ve en
   * az bir başka sıfır olmayan bileşen bulunmalı (inceleme 1: tek bileşende model toplamı tabana kopyalar, taban = net hiçbir
   * şey açıklamaz). KDV/vergi adlı ek ücret bileşen sayılmaz (inceleme 2: `VAT_AMOUNT`, `TAX`, "Vergi").
   */
  const componentsExplain = (l: PdfCheckLine): boolean => {
    if (l.baseAmount == null || !Number.isFinite(l.baseAmount)) return false;
    const n = Math.abs(l.netAmount);
    if (Math.abs(Math.abs(l.baseAmount) - n) <= 0.02) return false;
    const others = [-Math.abs(l.discountAmount ?? 0), l.fuelAmount ?? 0];
    for (const s of l.surcharges ?? []) if (!isTaxCharge(s)) others.push(s.amount);
    const real = others.filter((v) => Number.isFinite(v) && v !== 0);
    if (!real.length) return false;
    return Math.abs(sumMoney([l.baseAmount, ...real]) - n) <= 0.02;
  };
  const vatSwappedRow = (l: PdfCheckLine, at: readonly number[]): boolean => {
    if (!vatWord || !at.length || !Number.isFinite(l.netAmount) || l.netAmount === 0) return false;
    const n = Math.abs(l.netAmount);
    if (!inWindow(amountLines, [cents(n)], at)) return false;
    return vatFactorsUp.some(
      (f) => inWindow(amountLines, near1(cents(round2(n / f))), at) && !inWindow(amountLines, near1(cents(round2(n * f))), at) && !componentsExplain(l),
    );
  };

  // Y44: yakıt sözcüklü metin satırlarındaki basılı yüzdeler (yalnız gerekirse, bir kez; belge geneli). İndirim sözcüğünün
  // yanındaki yüzde alınmaz (inceleme 2026-11-13).
  let fuelPcts: Set<number> | null = null;
  const vatPcts = new Set(factors.map((f) => Math.round((f - 1) * 100 * 1000)));
  const percents = () => {
    if (fuelPcts) return fuelPcts;
    fuelPcts = new Set();
    for (const mt of text.matchAll(PERCENT_TOKEN)) {
      if (fuelPcts.size >= MAX_PERCENT_VALUES) break;
      const raw = mt[1] ?? mt[2];
      const v = raw == null ? NaN : Number(raw.replace(',', '.'));
      if (!(v > 0 && v < 100)) continue;
      const key = Math.round(v * 1000);
      if (vatPcts.has(key)) continue;
      const line = upperBound(rawStarts, mt.index) - 1;
      const start = rawStarts[line]!;
      const lineText = text.slice(start, (rawStarts[line + 1] ?? text.length + 1) - 1);
      if (!FUEL_WORD.test(lineText)) continue;
      if (discountPercent(lineText.slice(0, mt.index - start), lineText.slice(mt.index - start + mt[0].length))) continue;
      fuelPcts.add(key);
    }
    return fuelPcts;
  };
  /** Yakıt, yakıt sözcüklü satırdaki bir yüzdeyle taşıma bedelinden kuruşu kuruşuna çıkıyor mu. */
  const fuelFromPrintedPct = (l: PdfCheckLine): boolean => {
    const fuel = l.fuelAmount;
    if (fuel == null || !Number.isFinite(fuel) || fuel === 0) return false;
    const sur = sumMoney((l.surcharges ?? []).map((s) => s.amount).filter((v) => Number.isFinite(v)));
    const bases = [
      l.baseAmount,
      l.baseAmount != null ? l.baseAmount - Math.abs(l.discountAmount ?? 0) : null,
      Number.isFinite(l.netAmount) ? l.netAmount - fuel - sur : null,
    ].filter((b): b is number => typeof b === 'number' && Number.isFinite(b) && Math.abs(b) > 0);
    if (!bases.length) return false;
    for (const key of percents()) {
      const pct = key / 1000;
      if (bases.some((b) => Math.abs(round2((Math.abs(b) * pct) / 100) - Math.abs(fuel)) <= 0.01)) return true;
    }
    return false;
  };

  const rows: PdfCheckRow[] = [];
  for (const l of [...lines].sort((a, b) => a.rowIndex - b.rowIndex)) {
    const codes: RowFlagCode[] = [];
    let weightAmbiguity: PdfCheckRow['weightAmbiguity'];
    const n = needleOf(l);
    const at = n ? occurrences.get(n)! : [];
    if (!at.length) codes.push('PDF_TRACKING_UNVERIFIED');
    if (!amountNear(l.netAmount, at)) codes.push('PDF_AMOUNT_UNVERIFIED');
    if (vatSwappedRow(l, at)) codes.push('PDF_VAT_UNCLEAR');
    // 05-B4: yalnız takip no bulunduysa (bulunmadıysa satır zaten işaretli; bütün metinde küçük sayı her zaman bulunur)
    if (at.length) {
      // inceleme 8: satır başına en çok 10 geçiş ve 30 farklı tutar (5.000 satır × 100 ek ücret × 50 geçiş istek içinde saniyeler sürerdi)
      const near = at.length > FIELD_MAX_OCCURRENCES ? at.slice(0, FIELD_MAX_OCCURRENCES) : at;
      const weights = [l.actualKg, l.billedKg].filter(posNum);
      if (weights.some((v) => !valueNear(v, weightFactors, near))) codes.push('PDF_WEIGHT_UNVERIFIED');
      const edges = l.dims ? [l.dims.l, l.dims.w, l.dims.h].filter(posNum) : [];
      if (edges.some((v) => !valueNear(v, dimFactors, near))) codes.push('PDF_DIMS_UNVERIFIED');
      const charges = [...new Set([l.fuelAmount, ...(l.surcharges ?? []).map((s) => s.amount)].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0))].slice(0, FIELD_MAX_CHARGES);
      // Y44: metinde tutarı olmayan yakıt basılı yüzdeden hesaplanmışsa doğrulanmış sayılır
      const chargeOk = (v: number) => inWindow(amountLines, candidates(v), near, fieldWindowEnd) || (v === l.fuelAmount && fuelFromPrintedPct(l));
      if (charges.some((v) => !chargeOk(v))) codes.push('PDF_SURCHARGE_UNVERIFIED');
      if (ambiguousLines.size) {
        for (const k of ['actualKg', 'billedKg'] as const) {
          const v = l[k];
          const r = posNum(v) ? ambiguousWeightNear(v, near) : null;
          if (r) (weightAmbiguity ??= {})[k] = r;
        }
      }
    }
    if (codes.length || weightAmbiguity) rows.push({ rowIndex: l.rowIndex, codes, ...(weightAmbiguity ? { weightAmbiguity } : {}) });
  }
  return { method: 'text', checked: lines.length, rows };
}

const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** Y44: basılı yüzde ("%12,5", "% 12.5", "12,50 %", "12.5%"); en çok 4 ondalık. */
const PERCENT_TOKEN = /%\s?(\d{1,2}(?:[.,]\d{1,4})?)(?![\d.,]*\d)|(?<![\d.,])(\d{1,2}(?:[.,]\d{1,4})?)\s?%/g;
/** Y44: yakıt sözcüğü (TR, EN, DE, FR, ES). */
const FUEL_WORD = /yak[ıi]t|akaryak|fuel|treibstoff|kraftstoff|carburant|combustible/i;
/** İnceleme 2026-11-13: indirim sözcüğü (TR, EN, DE); büyük harfe ve noktasız I'ya çevrilmiş metinde. */
const PCT_DISCOUNT_WORD = /^(?:INDIRIM|ISKONTO|DISCOUNT|REBATE|RABATT?|NACHLASS)/;
const upperTr = (s: string) => s.replace(/İ/g, 'I').replace(/ı/g, 'i').toUpperCase();
/**
 * Yüzde indirim yüzdesi mi: satırda hemen önündeki sözcük indirim sözcüğü ("İndirim %15", "Discount: 15%") ya da hemen
 * ardındaki sözcük indirim sözcüğü ve önündeki yakıt sözcüğü değil ("%15 indirim"; "Yakıt %12,5 İndirim …"de 12,5 yakıtın).
 */
function discountPercent(before: string, after: string): boolean {
  const prev = /([\p{L}]+)[^\p{L}\d]*$/u.exec(before)?.[1];
  const next = /^[^\p{L}\d]*([\p{L}]+)/u.exec(after)?.[1];
  if (prev && PCT_DISCOUNT_WORD.test(upperTr(prev))) return true;
  return !!next && PCT_DISCOUNT_WORD.test(upperTr(next)) && !(prev && FUEL_WORD.test(prev));
}
/** Kötü niyetli girdiye karşı: tutulan en çok farklı yüzde. */
const MAX_PERCENT_VALUES = 200;
/** Belgede KDV bağlamı ("KDV", "K.D.V.", "VAT", "VAT_20"; alt çizgi harf sayılmaz). */
const VAT_WORD = /K\.?\s?D\.?\s?V|(?<![A-Z])VAT(?![A-Z])/i;
/** Ek ücretin kodunda ya da adında vergi sözcüğü (KDV, VAT, TAX, Vergi, MWST, GST…): bileşen değildir. */
const TAX_WORDS = new Set(['KDV', 'VAT', 'TAX', 'TAXES', 'VERGI', 'VERGISI', 'MWST', 'GST', 'IVA', 'TVA']);
function isTaxCharge(s: { code?: string | null; name?: string | null }): boolean {
  const t = `${s.code ?? ''} ${s.name ?? ''}`.replace(/İ/g, 'I').replace(/ı/g, 'i').toUpperCase();
  if (/K\.\s?D\.\s?V/.test(t)) return true;
  return t.split(/[^A-Z]+/).some((w) => TAX_WORDS.has(w));
}
/** K36: sayının hemen ardında ağırlık birimi ("1,500 kg", "1.500 lbs"). */
const WEIGHT_UNIT_AFTER = /^\s?(?:kgs?|kilo|lbs?|desi)\b/i;
/** K36: iki ayırıcılı gruplu sayı (belgenin biçimine açık kanıt). */
const STRONG_TR = /^\d{1,3}(?:\.\d{3})+,\d+$/;
const STRONG_EN = /^\d{1,3}(?:,\d{3})+\.\d+$/;
/** K36: sayıya bitişik para işareti ("1.500 TL", "₺1.500", "1.500 EUR"): o sayı tutardır, ağırlık sorusu çıkmaz. */
const CURRENCY_BEFORE = /(?:₺|€|\$|£|TL|TRY|EUR|USD|GBP|CHF)\s?$/i;
const CURRENCY_AFTER = /^\s?(?:TL|TRY|₺|€|\$|£|EUR|USD|GBP|CHF|,\d)/i;
/** 05-B4 inceleme 3: ağırlık, ölçü ve ek ücretin penceresi (blok düzeni: UPS/FedEx/DHL ek ücretleri alt satırlarda). */
export const PDF_FIELD_WINDOW_LINES = 12;
/** Kötü niyetli girdiye karşı (inceleme 8): satır başına denetlenen en çok geçiş ve tutar. */
const FIELD_MAX_OCCURRENCES = 10;
const FIELD_MAX_CHARGES = 30;
/** kg değerinden basılı değere çarpanlar (birime göre); 1 her zaman denenir (model zaten çevirmiş olabilir). */
const WEIGHT_PRINT_FACTORS: Record<NonNullable<PdfCheckUnits['weight']>, readonly number[]> = {
  kg: [1],
  lb: [1, 1 / LB_TO_KG],
  g: [1, 1000],
  any: [1, 1 / LB_TO_KG, 1000],
};
const DIM_PRINT_FACTORS: Record<NonNullable<PdfCheckUnits['dim']>, readonly number[]> = {
  cm: [1],
  in: [1, 1 / INCH_TO_CM],
  any: [1, 1 / INCH_TO_CM],
};

// ---------------------------------------------------------------------------------------------
// Denetim 05-B2: satır toplamı fatura toplamıyla. Model KDV dahil tutarı "net" diye verip "KDV dahil değil" derse (ya da
// tersi) her satır %20 yanlış kaydedilir; satır denetimi tutarı metinde bulduğu için yakalamaz. Fatura toplamları okunur,
// metinde doğrulanır (uydurulmuş toplam kullanılmaz) ve satırların toplamıyla karşılaştırılır.

export type PdfInvoiceTotals = { net: number | null; vat: number | null; gross: number | null };
export type PdfTotalsStatus = 'ok' | 'vatSwapped' | 'mismatch' | 'unavailable';
export type PdfTotalsCheck = {
  /**
   * `ok`: satır toplamı okunan KDV kipindeki toplamla (%1 içinde) aynı. `vatSwapped`: öbür kipteki toplamla aynı (KDV dahil
   * tutar net diye ya da tersi okundu): bütün satırlar `PDF_VAT_UNCLEAR`. `mismatch`: %1'den fazla sapma (eksik okunan satır
   * ya da faturaya ait ayrı kalem). `unavailable`: karşılaştırılamadı (`reason`).
   */
  status: PdfTotalsStatus;
  reason?: 'notPrinted' | 'notInText' | 'inconsistent' | 'ambiguous';
  /** Satır tutarlarının okunduğu kip: `amountsIncludeVat` ise `gross`. */
  basis: 'net' | 'gross';
  /** Satırların (takip no'suzlar dahil) ham tutarlarının toplamı (mutlak). */
  linesSum: number;
  /** Karşılaştırılan fatura toplamı (`vatSwapped`'ta öbür kipteki). */
  invoiceAmount?: number;
  /** `mismatch`: (satır toplamı − fatura toplamı) / fatura toplamı × 100. */
  deviationPct?: number;
  /** Metin katmanı vardı, toplamlar metinde arandı (yoksa modelin okuduğu kullanıldı). */
  textChecked: boolean;
  /** Metinde bulunmadığı için kullanılmayan toplamlar. */
  dropped?: ('net' | 'vat' | 'gross')[];
};

/** Satır toplamının fatura toplamından sapma payı (yüzde). */
export const PDF_TOTALS_TOLERANCE_PCT = 1;

/**
 * Satır toplamını fatura toplamlarıyla karşılaştırır. `totals` null ise (bu alandan önceki okuma) sonuç null (söylenecek
 * bir şey yok). `lineAmounts`: modelin satır tutarları basıldığı kipte (takip no'suzlar dahil, işaretli). `vatPctRead`:
 * belgeden okunan oran (okunmadıysa null; yalnız bir toplam basılıysa öbürünü türetmede kullanılır).
 * - Metin varsa her toplam metinde (iki ondalıklı, ±1 kuruş) aranır; bulunmayan kullanılmaz (`dropped`).
 * - Üçü de varsa net + KDV = brüt (±0,02 + binde 0,5) olmalı; değilse `inconsistent`. İkisi varsa üçüncüsü türetilir;
 *   yalnız biri varsa öbürü oranla (okunan; okunmadıysa belgede KDV/VAT geçiyorsa `vatPct`, geçmiyorsa 0; taranmışta
 *   türetilmez: `ambiguous`). Türetilen toplam da metinde aranır; okunan bir toplam düştüyse ya da türetilen metinde yoksa
 *   `ok` denmez (`unavailable`, `notInText`).
 * - Pay: toplamın %1'i (en az 0,05). Öbür kip (`vatSwapped`) yalnız brüt − net payın iki katından büyükse, satır toplamı
 *   öbür kipteki toplama binde 2 (en az 0,05) içinde eşitse ve fark metinde indirim sözcüklü bir satırda yazmıyorsa.
 */
export function checkPdfTotals(
  pageTexts: readonly string[] | null,
  o: { totals: PdfInvoiceTotals | null | undefined; amountsIncludeVat: boolean; vatPct: number; vatPctRead: number | null; lineAmounts: readonly number[] },
): PdfTotalsCheck | null {
  if (!o.totals) return null;
  const basis: PdfTotalsCheck['basis'] = o.amountsIncludeVat ? 'gross' : 'net';
  const linesSum = Math.abs(sumMoney(o.lineAmounts.filter(Number.isFinite)));
  const textChecked = !!pageTexts?.some((t) => t.trim() !== '');
  const amounts = textChecked ? pdfAmountSet(pageTexts!) : new Set<number>();
  const dropped: ('net' | 'vat' | 'gross')[] = [];
  const out =(status: PdfTotalsStatus, x: Partial<PdfTotalsCheck> = {}): PdfTotalsCheck => ({
    status,
    basis,
    linesSum,
    textChecked,
    ...(dropped.length ? { dropped } : {}),
    ...x,
  });
  const pick = (k: 'net' | 'vat' | 'gross'): number | null => {
    const v = o.totals![k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const a = round2(Math.abs(v));
    const c = toCents(a);
    if (textChecked && !amounts.has(c) && !amounts.has(c - 1) && !amounts.has(c + 1)) {
      dropped.push(k);
      return null;
    }
    return a;
  };
  let net = pick('net');
  const vat = pick('vat');
  let gross = pick('gross');
  if (net == null && vat == null && gross == null) return out('unavailable', { reason: dropped.length ? 'notInText' : 'notPrinted' });
  if (net != null && vat != null && gross != null && Math.abs(net + vat - gross) > 0.02 + gross * 0.0005) return out('unavailable', { reason: 'inconsistent' });
  // inceleme 4: türetilen toplam da metinde aranır (model brütü net diye okuduysa türetilen brüt metinde yoktur)
  let rejected = false;
  const derive = (v: number): number | null => {
    const a = round2(Math.abs(v));
    const c = toCents(a);
    if (textChecked && !amounts.has(c) && !amounts.has(c - 1) && !amounts.has(c + 1)) {
      rejected = true;
      return null;
    }
    return a;
  };
  if (net == null && gross != null && vat != null) net = derive(gross - vat);
  if (gross == null && net != null && vat != null) gross = derive(net + vat);
  // Tek toplamdan öbürü oranla: okunan oran; okunmadıysa belgede KDV/VAT geçiyorsa varsayılan oran, hiç geçmiyorsa 0
  // (inceleme 6: yurt dışı, KDV'siz fatura). Taranmış belgede türetilmez: model toplamı satırlardan kendisi hesaplamış
  // olabilir (brüt = satır toplamı, oranla türetilen net tutmaz, sahte "KDV belirsiz").
  const docVat = textChecked && VAT_WORD.test(pageTexts!.join('\n'));
  const rate = !textChecked ? null : (o.vatPctRead ?? (docVat ? o.vatPct : 0)) / 100;
  if (net == null && gross != null && rate != null) net = derive(gross / (1 + rate));
  if (gross == null && net != null && rate != null) gross = derive(net * (1 + rate));
  // Okunan bir toplam metinde yoktu ya da türetilen toplam metinde yok: okuma şüpheli, "tutuyor" denmez
  const suspect = textChecked && (dropped.length > 0 || rejected);
  const claimed = basis === 'net' ? net : gross;
  const opposite = basis === 'net' ? gross : net;
  const tol = (ref: number) => Math.max((Math.abs(ref) * PDF_TOTALS_TOLERANCE_PCT) / 100, 0.05);
  if (claimed != null && claimed > 0) {
    if (Math.abs(linesSum - claimed) <= tol(claimed)) return suspect ? out('unavailable', { reason: 'notInText' }) : out('ok', { invoiceAmount: claimed });
    // inceleme 5: öbür kipe eşitlik sıkı payla (binde 2) ve fark faturadaki bir indirim satırıyla açıklanmıyorsa
    if (
      opposite != null &&
      net != null &&
      gross != null &&
      Math.abs(gross - net) > 2 * tol(net) &&
      Math.abs(linesSum - opposite) <= Math.max(Math.abs(opposite) * 0.002, 0.05) &&
      !(textChecked && discountLineHas(pageTexts!, Math.abs(linesSum - net)))
    ) {
      return out('vatSwapped', { invoiceAmount: opposite });
    }
    return out('mismatch', { invoiceAmount: claimed, deviationPct: ((linesSum - claimed) / claimed) * 100 });
  }
  // yalnız öbür kipteki toplam var ve kullanılabilir oran yok: KDV %0 da olabilir, karar verilemez
  return out('unavailable', { reason: suspect ? 'notInText' : 'ambiguous' });
}

/** İndirim sözcükleri (fatura düzeyinde indirim satırı). */
const DISCOUNT_WORD = /ISKONTO|INDIRIM|DISCOUNT|REBATE|RABAT/;

/** Metinde indirim sözcüğü geçen bir satırda `amount` (±0,01) yazıyor mu (indirim satır toplamı ile net farkını açıklar). */
function discountLineHas(pageTexts: readonly string[], amount: number): boolean {
  const c = toCents(round2(amount));
  for (const page of pageTexts) {
    for (const line of page.split('\n')) {
      if (!DISCOUNT_WORD.test(line.replace(/İ/g, 'I').replace(/ı/g, 'i').toUpperCase())) continue;
      for (const mt of line.matchAll(TWO_DECIMAL_TOKEN)) {
        const v = twoDecimalCents(mt[0]);
        if (v != null && Math.abs(v - c) <= 1) return true;
      }
    }
  }
  return false;
}
