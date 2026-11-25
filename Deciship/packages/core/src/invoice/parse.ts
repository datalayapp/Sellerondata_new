import { round2, round3, sumMoney, toCents } from '../calc';
import { parseTrNumber } from '../format';
import { ambiguousWeightSeparator, ambiguousWeightText, readAmbiguousWeight } from '../measureInput';
import { DEFAULT_LOCALE, t as tt, type Locale } from '../i18n/index';
import { canonicalCountryCode } from '../countryNames';
import { parsePackaging, servicePackaging } from '../packaging';
import { normalizeTracking } from '../tracking';
import { classifyCharge } from './charges';
import { CHARGE_TOLERANCE } from './constants';
import { normalizeHeader } from './normalize';
import { rawHash } from './sha256';
import { isNumericCell, numericCellValue } from './read';
import type { ColumnMapping, InvoiceSurcharge, ParsedInvoiceLine, ParseRowError, SkippedInvoiceRow, Table } from './types';
import { resolveDateOrder } from './meta';
import { detectNumberFormat, lengthFactor, parseDateAs, parseNumberAs, weightFactor, type DateOrder, type NumberFormat } from './values';

const TOTAL_ROW = /^(genel\s*toplam|ara\s*toplam|toplam|total|totals|grand\s*total|sub\s*total|subtotal|sum|summary|ozet|özet)\b/i;

const COUNTRY_NAMES: Record<string, string> = {
  turkiye: 'TR', turkey: 'TR', fransa: 'FR', france: 'FR', almanya: 'DE', germany: 'DE', deutschland: 'DE',
  hollanda: 'NL', netherlands: 'NL', 'the netherlands': 'NL', ingiltere: 'GB', 'birlesik krallik': 'GB',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', abd: 'US', usa: 'US', 'united states': 'US',
  'amerika birlesik devletleri': 'US', kanada: 'CA', canada: 'CA', italya: 'IT', italy: 'IT', ispanya: 'ES', spain: 'ES',
  belcika: 'BE', belgium: 'BE', avusturya: 'AT', austria: 'AT', isvicre: 'CH', switzerland: 'CH', polonya: 'PL', poland: 'PL',
  isvec: 'SE', sweden: 'SE', danimarka: 'DK', denmark: 'DK', norvec: 'NO', norway: 'NO', finlandiya: 'FI', finland: 'FI',
  yunanistan: 'GR', greece: 'GR', bulgaristan: 'BG', bulgaria: 'BG', romanya: 'RO', romania: 'RO', irlanda: 'IE', ireland: 'IE',
  portekiz: 'PT', portugal: 'PT', cekya: 'CZ', 'czech republic': 'CZ', czechia: 'CZ', macaristan: 'HU', hungary: 'HU',
  azerbaycan: 'AZ', azerbaijan: 'AZ', gurcistan: 'GE', georgia: 'GE', rusya: 'RU', russia: 'RU', ukrayna: 'UA', ukraine: 'UA',
  'birlesik arap emirlikleri': 'AE', 'united arab emirates': 'AE', bae: 'AE', uae: 'AE', 'suudi arabistan': 'SA', 'saudi arabia': 'SA',
  israil: 'IL', israel: 'IL', japonya: 'JP', japan: 'JP', cin: 'CN', china: 'CN', avustralya: 'AU', australia: 'AU',
};

function fold(s: string): string {
  return s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ülke adlarının dile bağımsız ters dizini: Intl.DisplayNames ile çok dilde ad → ISO-2 (ilk kullanımda kurulur). */
const NAME_LOCALES = ['en', 'tr', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'sv', 'da', 'cs', 'ro', 'hu'];
/** Tarihî/özel bölge kodları (Doğu Almanya, Yugoslavya, AB, BM…) ad eşlemesinde kullanılmaz. */
const NON_COUNTRY = new Set(['DD', 'FX', 'YU', 'CS', 'ZR', 'BU', 'TP', 'SU', 'NT', 'QO', 'EU', 'EZ', 'UN', 'ZZ', 'XA', 'XB', 'AN', 'DG', 'EA', 'IC', 'CP', 'TA', 'AC',
  // eski/kaldırılmış kodlar (Yeni Hebridler, Rodezya, Dahomey, Yukarı Volta …)
  'NH', 'RH', 'DY', 'HV', 'VD', 'YD', 'PZ', 'PU', 'PC', 'NQ', 'MI', 'JT', 'FQ', 'WK', 'CT']);
let intlCountries: Map<string, string> | null = null;
function intlCountryIndex(): Map<string, string> {
  if (intlCountries) return intlCountries;
  intlCountries = new Map();
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return intlCountries;
  const A = 65;
  for (const loc of NAME_LOCALES) {
    let dn: Intl.DisplayNames;
    try {
      dn = new Intl.DisplayNames([loc], { type: 'region', fallback: 'none' });
    } catch {
      continue;
    }
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(A + i, A + j);
        const name = dn.of(code);
        if (!name || name === code || NON_COUNTRY.has(code)) continue;
        const key = fold(name);
        if (key && !intlCountries.has(key)) intlCountries.set(key, code);
      }
    }
  }
  return intlCountries;
}

export function parseCountry(v: string): string | undefined {
  const t = v.trim();
  if (!t) return undefined;
  if (/^[A-Za-z]{2}$/.test(t)) return canonicalCountryCode(t);
  const k = fold(t);
  return COUNTRY_NAMES[k] ?? intlCountryIndex().get(k);
}

/**
 * Para biriminin yazıyla adı (`fold` ile: küçük harf, aksansız, noktasız) → ISO kodu. DENETIM-2 01-B8: satırın para birimi
 * faturanınkiyle karşılaştırılır; "Türk Lirası", "TL.", "Euro" gibi yazımlar tanınmazsa satır sessizce faturanın para
 * birimini alıyor ya da yanlış bayrak alıyordu.
 */
const CURRENCY_NAMES: Record<string, string> = {
  tl: 'TRY', ytl: 'TRY', trl: 'TRY', lira: 'TRY', 'turk lirasi': 'TRY', 'turk lira': 'TRY', 'turkish lira': 'TRY',
  euro: 'EUR', euros: 'EUR', avro: 'EUR',
  dolar: 'USD', dollar: 'USD', dollars: 'USD', 'us dollar': 'USD', 'us dollars': 'USD', 'abd dolari': 'USD', 'amerikan dolari': 'USD',
  sterlin: 'GBP', sterling: 'GBP', 'pound sterling': 'GBP', 'ingiliz sterlini': 'GBP',
};

export function parseCurrency(v: string): string | undefined {
  const t = v.trim().toUpperCase();
  if (!t) return undefined;
  if (t === 'TL' || t === '₺' || t === 'YTL' || t === 'TRL') return 'TRY';
  if (t === '€') return 'EUR';
  if (t === '$' || t === 'US$') return 'USD';
  if (t === '£') return 'GBP';
  if (/^[A-Z]{3}$/.test(t)) return t;
  // "EUR.", "(USD)"
  const code = /^[\s.()]*([A-Z]{3})[\s.()]*$/.exec(t)?.[1];
  if (code) return code;
  // "TL.", "Türk Lirası", "Euro"
  return CURRENCY_NAMES[fold(v)];
}

/** "40x30x25", "40 × 30 × 25 cm", "40*30*25", "40,5X30X25" → { l, w, h }. */
export function parseDims(v: string): { l: number; w: number; h: number } | undefined {
  const parts = v
    .replace(/cm/gi, '')
    .split(/\s*[x×*X]\s*/)
    .map((p) => parseTrNumber(p.trim()));
  if (parts.length !== 3 || parts.some((p) => p == null || !(p > 0))) return undefined;
  return { l: parts[0]!, w: parts[1]!, h: parts[2]! };
}

/** Eşlemedeki sayısal sütunlar (sayı biçimi tespiti için). */
function numericHeaders(m: ColumnMapping): string[] {
  const hs = [m.netAmount, m.actualKg, m.billedKg, m.dimL, m.dimW, m.dimH, m.billedDivisor, m.baseAmount, m.discountAmount, m.fuelAmount];
  for (const sc of m.surchargeColumns ?? []) hs.push(sc.header);
  for (const p of m.chargePairs ?? []) hs.push(p.amount);
  return hs.filter((h): h is string => typeof h === 'string' && h !== '');
}

/**
 * Tablo + eşleme için sayı biçimini (tr/en) eşlenen sayısal sütunların değerlerinden tahmin eder. XLSX'in gerçek sayı
 * hücreleri (01-B4) sayılmaz: metinleri okuyucunun biçimidir ("1234,5"), dosyanın biçimi değil.
 */
export function detectTableNumberFormat(t: Table, m: ColumnMapping): NumberFormat {
  return detectColumnsNumberFormat(t, numericHeaders(m));
}

/** Eşlemedeki tutar sütunları (net, navlun, indirim, yakıt, ek ücretler, ücret çiftleri, fatura toplamı). */
function amountHeaders(m: ColumnMapping): string[] {
  const hs = [m.netAmount, m.baseAmount, m.discountAmount, m.fuelAmount, m.invoiceTotal];
  for (const sc of m.surchargeColumns ?? []) hs.push(sc.header);
  for (const p of m.chargePairs ?? []) hs.push(p.amount);
  return hs.filter((h): h is string => typeof h === 'string' && h !== '');
}

/** Yalnız tutar sütunlarının metin hücrelerinden sayı biçimi (KALANLAR 1.4; ağırlıklar K36 `weightFormat`ındır). */
export function detectAmountNumberFormat(t: Table, m: ColumnMapping): NumberFormat {
  return detectColumnsNumberFormat(t, amountHeaders(m));
}

function detectColumnsNumberFormat(t: Table, headers: string[]): NumberFormat {
  const idx = headers.map((h) => t.headers.indexOf(h)).filter((i, k, a) => i >= 0 && a.indexOf(i) === k);
  function* values() {
    for (let r = 0; r < t.rows.length; r++) {
      const row = t.rows[r]!;
      for (const i of idx) if (!isNumericCell(t, r, i)) yield String(row[i] ?? '');
    }
  }
  return detectNumberFormat(values());
}

/**
 * Tablonun sayı biçimi ve kaynağı (KALANLAR 1.4). Tutar sütunlarının kendi kanıtı (`detectAmountNumberFormat`) eşlemedeki
 * ipucunu (`numberFormat`: taşıyıcının kayıtlı eşlemesi ya da yapay zekânın önerisi) ezer: eskiden hatırlanan `en`, Türkçe
 * dosyadaki "2.010,00"yı 2,01 okuyordu. Ağırlık ve ölçü sütunlarının yazımı tutarların biçimini belirlemez ("0.5" kg varken
 * "1.250" tutar kayıtlı `tr` ile 1250 kalır). Tutarlarda kanıt yoksa ipucu, ipucu da yoksa bütün sayı sütunlarından tespit
 * (`detected`, eskisi gibi).
 */
export function resolveNumberFormat(t: Table, m: ColumnMapping, detected: NumberFormat = detectTableNumberFormat(t, m)): { format: NumberFormat; source: 'detected' | 'hint' } {
  const amounts = detectAmountNumberFormat(t, m);
  if (amounts !== 'auto') return { format: amounts, source: 'detected' };
  if (m.numberFormat === 'tr' || m.numberFormat === 'en') return { format: m.numberFormat, source: 'hint' };
  return { format: detected, source: 'detected' };
}

/**
 * K36: dosyada iki türlü okunan ağırlık yazımı (ilk örnek, kaç satırda, örneğin iki okuması). `other`: öbür ayırıcıyla
 * yazılmış ilk örnek (dosyada hem "1.500" hem "1,500" varsa; soru ikisini birlikte gösterir).
 */
export type WeightAmbiguity = { sample: string; rows: number; decimal: number; thousands: number; other?: string };

/**
 * K36 (kullanıcı kararı 2026-11-14): ağırlık sütunlarında "1.500" ya da "1,500" gibi yazım (tek ayırıcı + tam 3 hane) varken dosyanın sayı biçimi
 * eşlenen sayı sütunlarından anlaşılamıyorsa (`detectTableNumberFormat` = auto) 1500 kg da 1,5 kg da olabilir; sorulmalı.
 * Biçim kanıtla belliyse (ör. "1.234,56" tutarlar) ya da hücre XLSX'in gerçek sayısıysa belirsizlik yoktur. Eşlemedeki
 * sayı biçimi ipucuna (`numberFormat`, yapay zekâ ya da kayıtlı eşleme) bakmaz: o ipucu soruyu cevaplamaz. Seçim `weightFormat`tır
 * (yalnız ağırlık hücreleri); seçimden sonra da soru (seçili hâliyle) görünür, sorunu `verifyMapping` `weightFormat`a göre yazar.
 */
export function tableWeightAmbiguity(t: Table, m: ColumnMapping): WeightAmbiguity | null {
  const idx = [m.actualKg, m.billedKg]
    .filter((h): h is string => typeof h === 'string' && h !== '')
    .map((h) => t.headers.indexOf(h))
    .filter((i, k, a) => i >= 0 && a.indexOf(i) === k);
  if (!idx.length) return null;
  let first: WeightAmbiguity | null = null;
  let other: string | undefined;
  let rows = 0;
  for (let r = 0; r < t.rows.length; r++) {
    let hit = false;
    for (const i of idx) {
      if (isNumericCell(t, r, i)) continue;
      const raw = String(t.rows[r]![i] ?? '').trim();
      const w = ambiguousWeightText(raw, 'any');
      if (!w) continue;
      hit = true;
      first ??= { sample: raw, rows: 0, ...w };
      if (!other && ambiguousWeightSeparator(raw) !== ambiguousWeightSeparator(first.sample)) other = raw;
    }
    if (hit) rows++;
  }
  if (!first || detectTableNumberFormat(t, m) !== 'auto') return null;
  return { ...first, rows, ...(other ? { other } : {}) };
}

/**
 * Tablo hücresinin sayısı (01-B4). XLSX'te gerçek sayı olan hücre sayı biçimine bakılmadan (`numericCellValue`), metin hücre
 * `fmt` ile okunur. `row` tablodaki 0 tabanlı veri satırı, `col` sütun sırası. CSV/PDF tablosunda `parseNumberAs` ile aynı.
 */
export function cellNumber(t: Pick<Table, 'headers' | 'numeric'>, row: number, col: number, raw: string | null | undefined, fmt: NumberFormat): number | null {
  if (raw == null) return null;
  return isNumericCell(t, row, col) ? numericCellValue(String(raw)) : parseNumberAs(raw, fmt);
}

/**
 * Sütunun en sık dolu değeri sayı olarak (fatura toplamı sütunu; her satırda tekrarlanır). Eşitlikte ilk görülen; sayı
 * hücresi mi, o değerin ilk görüldüğü satırdan anlaşılır. Değer yoksa ya da okunamazsa null.
 */
export function columnMostCommonNumber(t: Table, header: string | undefined, fmt: NumberFormat): number | null {
  const i = header ? t.headers.indexOf(header) : -1;
  if (i < 0) return null;
  const counts = new Map<string, { n: number; row: number }>();
  t.rows.forEach((r, ri) => {
    const v = String(r[i] ?? '').trim();
    if (!v) return;
    const c = counts.get(v);
    if (c) c.n++;
    else counts.set(v, { n: 1, row: ri });
  });
  let best: string | undefined;
  let bestN = 0;
  let bestRow = -1;
  for (const [v, c] of counts) if (c.n > bestN) [best, bestN, bestRow] = [v, c.n, c.row];
  return best == null ? null : cellNumber(t, bestRow, i, best, fmt);
}

/** Bileşen başlığı KDV'yi açıkça söylüyorsa: "Navlun (KDV Dahil)" → true, "Navlun (KDV Hariç)" → false. */
function componentVatHint(m: ColumnMapping): boolean | undefined {
  const hs = [m.baseAmount, m.discountAmount, m.fuelAmount, ...(m.surchargeColumns ?? []).map((s) => s.header), ...(m.chargePairs ?? []).map((p) => p.amount)];
  let incl = false;
  let excl = false;
  for (const h of hs) {
    if (!h) continue;
    const nh = normalizeHeader(h);
    if (!/\b(kdv|vat)\b/.test(nh) && !/\bkdvli\b/.test(nh)) continue;
    if (/\b(haric|excl|excluding|exclusive|without|matrah)\b/.test(nh)) excl = true;
    else if (/\b(dahil|incl|including|inclusive|kdvli)\b/.test(nh)) incl = true;
  }
  if (incl !== excl) return incl;
  return undefined;
}

export type RawComponents = { base?: number; discount?: number; fuel?: number; surcharges: number[]; netRaw: number };

/**
 * Bileşen sütunlarının (navlun, indirim, yakıt, ek ücret) KDV kararı ve dayanağı. `mapping`: kullanıcı eşlemede seçti;
 * `header`: sütun başlığı söylüyor; `data`: satırların toplamı öyle tutuyor; `default`: hiçbir kanıt yok, KDV hariç
 * varsayıldı (kullanıcıya gösterilir, değiştirebilir); `none`: toplam KDV dahil değil, karar gerekmez.
 */
export type ComponentsVatDecision = { value: boolean; source: 'mapping' | 'header' | 'data' | 'default' | 'none'; hasComponents: boolean };

/** Yalnız veriden karar (PDF yolu da kullanır): bileşenlerin toplamı KDV dahil toplama mı, KDV hariç tutara mı eşit; çoğunluk. */
export function componentsVatFromData(vatFactor: number, raws: RawComponents[]): { value: boolean; source: 'data' | 'default' } {
  let incl = 0;
  let excl = 0;
  for (const r of raws) {
    if (r.base == null) continue;
    const parts = (r.base ?? 0) - (r.discount ?? 0) + (r.fuel ?? 0) + r.surcharges.reduce((a, x) => a + x, 0);
    const asIncl = Math.abs(parts - r.netRaw) <= CHARGE_TOLERANCE + 1e-9;
    const asExcl = Math.abs(parts * vatFactor - r.netRaw) <= CHARGE_TOLERANCE * vatFactor + 1e-9;
    if (asIncl && !asExcl) incl++;
    else if (asExcl && !asIncl) excl++;
  }
  if (incl === excl) return { value: false, source: 'default' };
  return { value: incl > excl, source: 'data' };
}

/**
 * Denetim 04-B5: "Tutarlar KDV dahil" net tutarın (toplam sütunu) KDV dahil olduğunu söyler; bileşen sütunlarının KDV'si
 * ayrıca belirlenir. Sıra: eşlemedeki `componentsIncludeVat` → bileşen başlığındaki KDV ibaresi → veri (navlun − indirim +
 * yakıt + ek ücret toplamı KDV dahil toplama mı, KDV hariç tutara mı eşit; çoğunluk) → hiçbiri yoksa KDV hariç.
 */
function decideComponentsIncludeVat(m: ColumnMapping, vatFactor: number, raws: RawComponents[]): ComponentsVatDecision {
  const hasComponents = raws.some((r) => r.base != null || r.discount != null || r.fuel != null || r.surcharges.length > 0);
  if (vatFactor === 1) return { value: false, source: 'none', hasComponents };
  if (typeof m.componentsIncludeVat === 'boolean') return { value: m.componentsIncludeVat, source: 'mapping', hasComponents };
  const hint = componentVatHint(m);
  if (hint !== undefined) return { value: hint, source: 'header', hasComponents };
  return { ...componentsVatFromData(vatFactor, raws), hasComponents };
}

/** Toplam satırı tutar eşleşmesi payı (kuruş): ±0,01. */
const TOTAL_ROW_TOLERANCE_CENTS = 1;

export type ParseRowsResult = {
  lines: ParsedInvoiceLine[];
  errors: ParseRowError[];
  /** Takip no'suz ücret satırları (Mesaj 5); toplam satırları sayılmaz. */
  skipped: SkippedInvoiceRow[];
  componentsVat?: ComponentsVatDecision;
};

export function parseRows(t: Table, m: ColumnMapping, locale: Locale = DEFAULT_LOCALE): ParseRowsResult {
  const lines: ParsedInvoiceLine[] = [];
  const errors: ParseRowError[] = [];
  const skipped: SkippedInvoiceRow[] = [];
  const index = new Map<string, number>();
  t.headers.forEach((h, i) => {
    if (!index.has(h)) index.set(h, i);
  });
  const col = (header: string | undefined) => (header != null && header !== '' ? index.get(header) : undefined);

  if (col(m.trackingNo) == null) {
    errors.push({ rowIndex: -1, code: 'NO_TRACKING_COLUMN', message: tt(locale, 'parse.noTrackingColumn') });
    return { lines, errors, skipped };
  }
  if (col(m.netAmount) == null) {
    errors.push({ rowIndex: -1, code: 'NO_NET_COLUMN', message: tt(locale, 'parse.noNetColumn') });
    return { lines, errors, skipped };
  }

  const vatFactor = m.amountsIncludeVat ? 1 + (m.vatPct ?? 20) / 100 : 1;
  const money = (n: number) => round2(n / vatFactor);
  // Bileşen tutarları önce ham toplanır; KDV'leri tüm tablodan karar verildikten sonra uygulanır (decideComponentsIncludeVat).
  const raws: RawComponents[] = [];
  const detectedFmt = detectTableNumberFormat(t, m);
  const numFmt: NumberFormat = resolveNumberFormat(t, m, detectedFmt).format;
  // K36: ağırlık seçimi yalnız ağırlık sütunlarının iki türlü okunan metin hücrelerine; tutarlar `numFmt` ile kalır.
  const weightPick = m.weightFormat === 'tr' || m.weightFormat === 'en' ? (detectedFmt === 'auto' ? m.weightFormat : null) : null;
  const dateOrder: DateOrder = resolveDateOrder(t, m).order;
  const pairs = (m.chargePairs ?? []).filter((p) => col(p.label) != null && col(p.amount) != null);

  // Takip no'suz ücret satırı adayları (Mesaj 5). Toplam/ara toplam satırı olanlar ayıklanır: hücrede toplam deseni ya da
  // tutar bir toplama ±0,01 eşit. Toplamlar: okunan satırlar ya da her şey (okunan + takip no'su bozuk + takip no'suz
  // ücret satırları); bu satıra kadar, son toplam satırından beri ya da (tablo sonunda) tümü; ham, KDV hariç ya da KDV
  // dahil hâliyle.
  const totalVatFactor = 1 + (m.vatPct ?? 20) / 100;
  type Acc = { raw: number; excl: number };
  const acc = (): Acc => ({ raw: 0, excl: 0 });
  const linesAll = acc();
  const linesSeg = acc();
  const everyAll = acc();
  const everySeg = acc();
  const addTo = (net: number, ...targets: Acc[]) => {
    for (const a of targets) {
      a.raw += toCents(net);
      a.excl += toCents(money(net));
    }
  };
  const resetSegment = () => {
    linesSeg.raw = linesSeg.excl = everySeg.raw = everySeg.excl = 0;
  };
  const sumCandidates = (a: Acc): number[] => [a.raw, a.excl, toCents(round2((a.excl / 100) * totalVatFactor))];
  const matchesSum = (amount: number, accs: Acc[]) => {
    const c = toCents(Math.abs(amount));
    return accs.flatMap(sumCandidates).some((s) => s !== 0 && Math.abs(Math.abs(s) - c) <= TOTAL_ROW_TOLERANCE_CENTS);
  };
  // `counted`: tutar "her şey" toplamına eklendi. Henüz hiçbir tutar okunmadan gelen aday (tablonun en üstündeki genel
  // toplam olabilir) eklenmez; sonda tüm toplamla karşılaştırılır.
  const noTracking: { rowIndex: number; net: number; counted: boolean }[] = [];

  t.rows.forEach((row, rowIndex) => {
    const cell = (header: string | undefined): string => {
      const i = col(header);
      return i == null ? '' : String(row[i] ?? '').trim();
    };
    // XLSX'in gerçek sayı hücresi biçime bakılmadan okunur (01-B4)
    const numAt = (header: string | undefined): number | null => {
      const i = col(header);
      return i == null ? null : cellNumber(t, rowIndex, i, String(row[i] ?? '').trim(), numFmt);
    };
    const num = (header: string | undefined): number | undefined => {
      const v = cell(header);
      if (!v) return undefined;
      return numAt(header) ?? undefined;
    };
    /** Ağırlık hücresi: K36 seçimi yapıldıysa "1.500" gibi metin seçilen okumayla, öbürleri `num` ile. */
    const weightNum = (header: string | undefined): number | undefined => {
      if (weightPick) {
        const i = col(header);
        const w = i == null || isNumericCell(t, rowIndex, i) ? null : readAmbiguousWeight(cell(header), weightPick, 'any');
        if (w != null) return w;
      }
      return num(header);
    };

    const trackingRaw = cell(m.trackingNo);
    if (!trackingRaw) {
      const net = numAt(m.netAmount);
      if (net == null || toCents(net) === 0) return;
      const totalLike = row.some((c) => TOTAL_ROW.test(String(c ?? '').trim())) || matchesSum(net, [linesAll, linesSeg, everyAll, everySeg]);
      if (totalLike) {
        resetSegment();
        return;
      }
      const counted = everyAll.raw !== 0 || everyAll.excl !== 0;
      noTracking.push({ rowIndex, net, counted });
      if (counted) addTo(net, everyAll, everySeg);
      return;
    }
    if (TOTAL_ROW.test(trackingRaw) || row.some((c, i) => i <= 2 && TOTAL_ROW.test(String(c ?? '').trim()) && !/\d{6,}/.test(trackingRaw))) {
      resetSegment();
      return;
    }
    const trackingNo = normalizeTracking(trackingRaw);
    if (!/\d/.test(trackingNo)) {
      errors.push({ rowIndex, code: 'BAD_TRACKING', message: tt(locale, 'parse.badTracking', { row: rowIndex + 1, value: trackingRaw }), value: trackingRaw });
      const badNet = numAt(m.netAmount);
      if (badNet != null) addTo(badNet, everyAll, everySeg);
      return;
    }

    const netRaw = cell(m.netAmount);
    const net = numAt(m.netAmount);
    if (net == null) {
      errors.push({ rowIndex, code: 'BAD_NET', message: tt(locale, 'parse.badNet', { row: rowIndex + 1, value: netRaw }), value: netRaw, trackingRaw });
      return;
    }
    addTo(net, linesAll, linesSeg, everyAll, everySeg);

    const line: ParsedInvoiceLine = {
      rowIndex,
      trackingNo,
      surcharges: [],
      netAmount: money(net),
      rawHash: rawHash(row),
    };

    const shipDateRaw = cell(m.shipDate);
    if (shipDateRaw) {
      const d = parseDateAs(shipDateRaw, dateOrder);
      if (d) line.shipDate = d;
      else errors.push({ rowIndex, code: 'BAD_DATE', message: tt(locale, 'parse.badDate', { row: rowIndex + 1, value: shipDateRaw }), value: shipDateRaw, trackingRaw });
    }
    const service = cell(m.service);
    if (service) line.service = service;
    const country = parseCountry(cell(m.destCountry));
    if (country) line.destCountry = country;

    const actualKg = weightNum(m.actualKg);
    if (actualKg != null) line.actualKg = round3(actualKg * weightFactor(cell(m.actualKgUnit) || m.defaultWeightUnit));
    const billedKg = weightNum(m.billedKg);
    if (billedKg != null) line.billedKg = round3(billedKg * weightFactor(cell(m.billedKgUnit) || m.defaultWeightUnit));

    const lf = lengthFactor(cell(m.dimUnit) || m.defaultDimUnit);
    const edge = (x: number) => (lf === 1 ? x : round2(x * lf));
    const l = num(m.dimL);
    const w = num(m.dimW);
    const h = num(m.dimH);
    if (l && w && h && l > 0 && w > 0 && h > 0) line.dims = { l: edge(l), w: edge(w), h: edge(h) };
    else if (m.dims) {
      const d = parseDims(cell(m.dims));
      if (d) line.dims = { l: edge(d.l), w: edge(d.w), h: edge(d.h) };
    }
    const divisor = num(m.billedDivisor);
    if (divisor && divisor > 0) line.billedDivisor = divisor;

    // Etiket/tutar çiftleri: her satırda sıra değişebilir, etikete göre sınıflanır.
    const pairBase: number[] = [];
    const pairDiscount: number[] = [];
    const pairFuel: number[] = [];
    const surcharges: InvoiceSurcharge[] = [];
    for (const p of pairs) {
      const amount = num(p.amount);
      if (amount == null || amount === 0) continue;
      const c = classifyCharge(cell(p.label), amount, m.chargeLabelOverrides);
      if (c.kind === 'base') pairBase.push(amount);
      else if (c.kind === 'discount') pairDiscount.push(Math.abs(amount));
      else if (c.kind === 'fuel') pairFuel.push(amount);
      else surcharges.push({ code: c.code!, name: c.name, amount });
    }

    const base = num(m.baseAmount) ?? (pairBase.length ? sumMoney(pairBase) : undefined);
    const discount = num(m.discountAmount) ?? (pairDiscount.length ? sumMoney(pairDiscount) : undefined);
    const fuel = num(m.fuelAmount) ?? (pairFuel.length ? sumMoney(pairFuel) : undefined);

    for (const sc of m.surchargeColumns ?? []) {
      const amount = num(sc.header);
      if (amount != null && amount !== 0) surcharges.push({ code: sc.code, name: sc.header, amount });
    }
    // anahtar sırası eskisi gibi kalsın diye ham değerle yazılır; KDV kararı sonrası aşağıda üzerine yazılır
    if (base != null) line.baseAmount = base;
    if (discount != null) line.discountAmount = Math.abs(discount);
    if (fuel != null) line.fuelAmount = fuel;
    line.surcharges = surcharges;
    raws.push({
      ...(base != null ? { base } : {}),
      ...(discount != null ? { discount: Math.abs(discount) } : {}),
      ...(fuel != null ? { fuel } : {}),
      surcharges: surcharges.map((x) => x.amount),
      netRaw: net,
    });

    const currency = parseCurrency(cell(m.currency));
    if (currency) line.currency = currency;
    const reference = cell(m.reference);
    if (reference) line.reference = reference;
    // Ambalaj: sütundan, yoksa (ya da okunamazsa) hizmet adından yalnız Pak/Zarf
    const packaging = parsePackaging(cell(m.packaging), m.packagingCodes) ?? servicePackaging(line.service);
    if (packaging) line.packaging = packaging;

    lines.push(line);
  });

  const componentsVat = decideComponentsIncludeVat(m, vatFactor, raws);
  const componentFactor = componentsVat.value ? vatFactor : 1;
  const component = (n: number) => round2(n / componentFactor);
  lines.forEach((line, i) => {
    const r = raws[i]!;
    if (r.base != null) line.baseAmount = component(r.base);
    if (r.discount != null) line.discountAmount = component(r.discount);
    if (r.fuel != null) line.fuelAmount = component(r.fuel);
    line.surcharges = line.surcharges.map((x) => ({ ...x, amount: component(x.amount) }));
  });

  // Tabloda toplam satırı en üstte de olabilir: tüm satırların toplamıyla son kez karşılaştırılır.
  for (const r of noTracking) {
    const others = r.counted ? { raw: everyAll.raw - toCents(r.net), excl: everyAll.excl - toCents(money(r.net)) } : everyAll;
    if (matchesSum(r.net, [linesAll, others])) continue;
    skipped.push({ rowIndex: r.rowIndex, reason: 'NO_TRACKING', amount: money(r.net) });
  }

  return { lines, errors, skipped, componentsVat };
}
