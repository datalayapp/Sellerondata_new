/**
 * Yapay zekâsız PDF tarife taraması: metin katmanındaki konumlu parçalardan (x, y) satır/sütun kurar,
 * fiyat tablolarını (ağırlık × bölge), "İlave X kg" satırlarını, "kg başına" bantlarını, ülke → bölge
 * listesini ve belge bilgilerini (geçerlilik, para birimi, yakıt, hacim böleni) bulur.
 * Çıktı, yapay zekâ keşfi/çıkarmasıyla aynı yapıdadır; seçilen bölümler doğrudan taslağa çevrilir.
 * Zarf / Pak / mektup alt tabloları alınmaz (DeciShip koli desisini ölçer).
 */
import { DEFAULT_LOCALE, type Locale } from './i18n/index';
import { countryNameToIso2 } from './countries';
import { fmtWeightNumber, parseTrNumber } from './format';
import { cleanZoneLabel, distanceZoneCode } from './tariff';
import { parseStepLabel, parseWeightLabel } from './tariffImport';

/** pdfjs metin parçası: sol alt köşe (x, y; y yukarı doğru artar), genişlik, yükseklik. */
export type PdfTextItem = { str: string; x: number; y: number; w: number; h: number };
export type PdfPageLayout = { items: PdfTextItem[] };

export type PdfFuel = { kind: 'FIXED_PCT' | 'INDEXED' | 'UNKNOWN'; pct: number | null };
export type PdfDocumentFacts = {
  carrier: string | null;
  validFrom: string | null;
  currency: string | null;
  weightUnit: 'kg' | 'lb' | null;
  dimDivisor: number | null;
  fuel: PdfFuel;
  surchargeNotes: string[];
  countryZonePages: number[];
  discountPages: number[];
  notes: string[];
};

export type PdfPackaging = 'envelope' | 'pak' | 'box' | 'all';
export type PdfSectionInfo = {
  id: string;
  title: string;
  service: string | null;
  direction: 'export' | 'import' | 'domestic' | null;
  priceType: 'net' | 'list' | 'unknown';
  packaging: PdfPackaging | null;
  zones: string[];
  weightMin: number | null;
  weightMax: number | null;
  currency: string | null;
  pages: number[];
  hasAdditionalStep: boolean;
  hasPerKgBands: boolean;
};

/** Yapay zekâ çıkarmasıyla aynı satır biçimi. */
export type PdfTableRow = {
  kind: 'weight' | 'additional' | 'perKg';
  label: string;
  weight: number | null;
  from: number | null;
  step: number | null;
  cells: string[];
  page: number | null;
};
export type PdfTable = { sectionId: string; zones: string[]; rows: PdfTableRow[] };
export type PdfCountryRow = { name: string; zone: string; page: number | null };

/** `notes`: kodla okumada atlanan / seçilen şeyler (ör. "Dosya" satırı); içe aktarma notlarına eklenir. */
export type PdfCodeSection = PdfSectionInfo & { table: PdfTable; notes?: string[] };
/**
 * İndirim tablosu satırı ("IP 3.00 5.00 67.00% 67.03% …"): bir hizmetin bir ağırlık bandındaki bölge bazlı indirim yüzdeleri.
 * `min`/`max` null: bant yazmıyor (tüm ağırlıklar). `packaging`: "Letter" / "Pak" satırları (koli tablolarında kullanılmaz).
 */
export type PdfDiscountRow = {
  label: string;
  packaging: 'envelope' | 'pak' | null;
  min: number | null;
  max: number | null;
  /** bölge sırasıyla yüzde (67.03 = %67,03); okunamayan ("#REF!", "#N/A") ya da boş hücre null */
  pcts: (number | null)[];
  /** basılı hücre metni ("67.03%", "#REF!", "") */
  cells: string[];
  page: number;
};
/** İhracat / ithalat indirim tablosu (hizmet başına bir tablo; sözleşmede liste fiyatı × (1 − indirim) = net). */
export type PdfDiscountTable = {
  id: string;
  direction: 'export' | 'import' | 'domestic' | null;
  /** basıldığı gibi hizmet: kısaltma ("IP", "IPE", "IEF") ya da ad */
  service: string;
  title: string;
  pages: number[];
  zones: string[];
  rows: PdfDiscountRow[];
};

export type PdfCodeScan = {
  document: PdfDocumentFacts;
  sections: PdfCodeSection[];
  countries: PdfCountryRow[];
  /** indirim yüzdesi tabloları (FedEx "İhracat İndirimi" / "İthalat İndirimi"); liste fiyatıyla birlikte kesin net hesap */
  discountTables: PdfDiscountTable[];
};

// ---------------------------------------------------------------------------------------------
// Satırlar

type Piece = { str: string; x: number; x2: number; y: number; h: number };
type Line = { y: number; pieces: Piece[]; text: string };

const fold = (s: string) =>
  String(s ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Bir parçadaki "  " (2+ boşluk) ile ayrılmış hücreleri, karakter oranıyla x'e yayarak ayırır. */
function splitItem(it: PdfTextItem): Piece[] {
  const str = it.str.replace(/ /g, ' ');
  const h = it.h > 0 ? it.h : 8;
  const w = it.w > 0 ? it.w : str.length * h * 0.5;
  if (!/\S\s{2,}\S/.test(str)) {
    const t = str.trim();
    if (!t) return [];
    const lead = str.length - str.trimStart().length;
    const cw = w / Math.max(1, str.length);
    return [{ str: t, x: it.x + lead * cw, x2: it.x + (lead + t.length) * cw, y: it.y, h }];
  }
  const cw = w / Math.max(1, str.length);
  const out: Piece[] = [];
  for (const m of str.matchAll(/\S+(?: \S+)*/g)) {
    const start = m.index ?? 0;
    out.push({ str: m[0], x: it.x + start * cw, x2: it.x + (start + m[0].length) * cw, y: it.y, h });
  }
  return out;
}

function buildLines(items: PdfTextItem[]): Line[] {
  const pieces = items.flatMap(splitItem).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; pieces: Piece[] }[] = [];
  for (const p of pieces) {
    const tol = Math.min(2.5, Math.max(1, p.h * 0.3));
    const l = lines.find((x) => Math.abs(x.y - p.y) <= tol);
    if (l) l.pieces.push(p);
    else lines.push({ y: p.y, pieces: [p] });
  }
  const out: Line[] = [];
  for (const l of lines.sort((a, b) => b.y - a.y)) {
    l.pieces.sort((a, b) => a.x - b.x);
    // bitişik parçaları (harf harf yazılmış metin) birleştir
    const merged: Piece[] = [];
    for (const p of l.pieces) {
      const last = merged[merged.length - 1];
      const gap = last ? p.x - last.x2 : Infinity;
      if (last && gap < Math.max(0.6, p.h * 0.15)) {
        last.str += p.str;
        last.x2 = Math.max(last.x2, p.x2);
      } else merged.push({ ...p });
    }
    out.push({ y: l.y, pieces: merged, text: merged.map((p) => p.str).join(' ') });
  }
  return out;
}

const center = (p: Piece) => (p.x + p.x2) / 2;

// ---------------------------------------------------------------------------------------------
// Fiyat tabloları

const WEIGHT_HEAD = /a[gğ][ıi]rl[ıi]k|weight|\bkgs?\b|\bdes[iİ](?![a-zçğıöşü])|\blbs?\b/i;
const ZONE_HEAD = /^(?:(?:zone|b[öo]lge|region)\s*)?([a-z]{1,2}|\d{1,2})(?:\s*(?:b[öo]lges[iİı]|b[öo]lge|zone))?$/i;
const CURRENCY_CELL: [RegExp, string][] = [
  [/^(?:usd|us\$|\$)$/i, 'USD'],
  [/^(?:eur|euro|€)$/i, 'EUR'],
  [/^(?:gbp|£)$/i, 'GBP'],
  [/^(?:try|tl|₺)$/i, 'TRY'],
  [/^chf$/i, 'CHF'],
];
const currencyCell = (s: string) => CURRENCY_CELL.find(([re]) => re.test(s.trim()))?.[1] ?? null;
const PER_KG_TITLE = /kg\s*ba[sş][ıi]|per\s*kg|\/\s*kg|[cç]arp[ıi]n[ıi]z|multipl/i;
const ENVELOPE_RE = /envelope|zarf|letter|mektup|d[oö]k[uü]man|document|\bdosya\b/i;
const PAK_RE = /\bpak\b/i;
const BOX_RE = /di[gğ]er\s+ambalaj|other\s+packag|\bkutu|\bbox(?:es)?\b|\bpackages?\b|\bkoli/i;
const NOISE_TITLE = /daha fazla bilgi|more information|[şs]artlar ve ko[şs]ullar|terms and conditions|itibaren ge[cç]erli|\beffective\b|^page\s*\d+$|^sayfa\s*\d+$|©/i;
const SERVICE_WORD = /international|intl|priority|economy|express|freight|standard|saver|expedited|ground|domestic|ekonomi|ekspres|yurt\s*i[cç]i|kargo|desi|\bservis|\bhizmet/i;

function zoneHeader(p: Piece): string | null {
  const t = p.str.replace(/\s+/g, ' ').trim();
  // yurt içi mesafe sütunu ("Şehir içi", "Kısa Mesafe", "Uzak") → kısa kod ("SEHIRICI", "KISA", "UZAK")
  const dist = distanceZoneCode(t);
  if (dist) return dist;
  if (!ZONE_HEAD.test(t)) return null;
  const z = cleanZoneLabel(t);
  return /^[A-Za-z0-9]{1,3}$/.test(z) ? z.toUpperCase() : null;
}

/**
 * `adder`: "From | To | Zone 1 …" başlıklı ilave ücret tablosu (DHL: "Adder rate per additional 1 LB from 20.1 LB";
 * satırlar "20.1 | 40 | 6.60 …") — her satır bir ağırlık aralığında her ilave birim için eklenen tutardır.
 */
type Header = {
  line: number;
  zones: { zone: string; c: number }[];
  labelRight: number;
  spacing: number;
  unit: 'kg' | 'lb';
  adder: boolean;
  /** "Desi" başlıklı tablo (yurt içi; ağırlık sütunu desi = ücretlenecek kg, bölen 3000) */
  desi?: boolean;
  /** tek fiyat sütunlu tablo ("Desi | Ücret"): tek bölge; birden çok fiyat sütunu varsa seçilenin başlığı */
  single?: { priceHeader: string; currency: string | null };
  /** yurt içi mesafe sütunları ("Şehir içi | Yakın | Orta | Uzak"): basılı başlık → kod */
  distance?: { label: string; code: string }[];
};

/** Tek fiyat sütunlu (yurt içi) tablonun bölge adı (seed'deki "Aras Desi" tarifesiyle aynı: `*` → TR). */
export const DOMESTIC_ZONE = 'TR';
/** "Desi", "Kg", "Desi/Kg", "KG/Desi", "Ağırlık (kg)", "Weight" — tek sütunlu tablonun ağırlık başlığı. */
const SINGLE_WEIGHT_HEAD = /^(?:des[iİ]|kgs?|a[gğ][ıi]rl[ıi]k|weight)(?:\s*[/-]\s*(?:des[iİ]|kgs?|a[gğ][ıi]rl[ıi]k))?(?:\s*\([^)]*\))?$/i;
const PRICE_HEAD = /[üu]cret|fiyat|tutar|bedel|price|rate|charge|amount|kdv|vat|^\(?(?:tl|try|₺)\)?$/i;
const VAT_INCL = /dahil|incl/i;
const VAT_EXCL = /hari[çc]|excl|\bnet\b/i;

function singleHeaderAt(l: Line, i: number): Header | null {
  if (l.pieces.length > 5) return null;
  const wIdx = l.pieces.findIndex((p) => SINGLE_WEIGHT_HEAD.test(p.str.trim()));
  if (wIdx < 0) return null;
  const right = l.pieces.slice(wIdx + 1);
  if (!right.length || right.some((p) => p.str.length > 40 || !PRICE_HEAD.test(p.str))) return null;
  // KDV hariç / dahil iki sütun varsa hariç olan (tarife fiyatları KDV'siz tutulur)
  const pick = right.find((p) => VAT_EXCL.test(p.str)) ?? right.find((p) => !VAT_INCL.test(p.str)) ?? right[0]!;
  const k = right.indexOf(pick);
  const wp = l.pieces[wIdx]!;
  const c = center(pick);
  const labelRight = k === 0 ? (wp.x2 + pick.x) / 2 : (right[k - 1]!.x2 + pick.x) / 2;
  if (!(c > labelRight)) return null;
  const neighbors = right.filter((p) => p !== pick).map((p) => Math.abs(center(p) - c));
  const spacing = Math.max(8, Math.min(2 * (c - labelRight), ...neighbors));
  const txt = right.map((p) => p.str).join(' ');
  const currency = DOC_CURRENCY.find(([re]) => new RegExp(re.source, 'i').test(txt))?.[1] ?? null;
  return {
    line: i,
    zones: [{ zone: DOMESTIC_ZONE, c }],
    labelRight,
    spacing,
    unit: 'kg',
    adder: false,
    desi: /des[iİ]/i.test(wp.str),
    single: { priceHeader: right.length > 1 ? pick.str.trim() : '', currency },
  };
}

/**
 * Tek sütunlu yurt içi listelerde son satırdan sonraki aşım satırı: "+", "30+", "30 desi üzeri (her desi)",
 * "her ilave desi", "her ek 1 desi" → her `step` birim için eklenen tutar (içe aktarmada aşım fiyatı).
 */
const OVER_LABEL =
  /^\+$|^\d+(?:[.,]\d+)?\s*(?:desi|kgs?)?\s*(?:\+|(?:ve\s+)?[üu]zeri|[üu]st[üu])|her\s+(?:ilave\s+|ek\s+)?(?:\d+(?:[.,]\d+)?\s*)?(?:desi|kg)|(?:ilave|ek)\s+(?:her\s+)?(?:desi|kg)/i;
function overStep(label: string): number | null {
  const t = label.trim();
  if (!OVER_LABEL.test(t)) return null;
  const m = /(?:her|ilave|ek)\s+(?:ilave\s+|ek\s+)?(\d+(?:[.,]\d+)?)\s*(?:desi|kgs?)/i.exec(t);
  const v = m ? parseTrNumber(m[1]!) : null;
  return v != null && v > 0 ? v : 1;
}

const FROM_HEAD = /^(?:from|ba[sş]lang[ıi][cç]|min\.?)$/i;
const TO_HEAD = /^(?:to|biti[sş]|max\.?)$/i;

function headerAt(lines: Line[], i: number): Header | null {
  const l = lines[i]!;
  let wIdx = l.pieces.findIndex((p) => WEIGHT_HEAD.test(p.str));
  let adder = false;
  // ağırlık başlığı var ama bölge sütunu yok: tek fiyat sütunlu yurt içi liste olabilir ("Desi | Ücret")
  if (wIdx >= 0 && !l.pieces.slice(wIdx + 1).some((p) => zoneHeader(p) != null)) return singleHeaderAt(l, i);
  if (wIdx < 0) {
    // "From  To  Zone 1  Zone 2 …" (ya da "Başlangıç  Bitiş  …"): ilave ücret tablosu
    const f = l.pieces.findIndex((p, k) => FROM_HEAD.test(p.str.trim()) && TO_HEAD.test(l.pieces[k + 1]?.str.trim() ?? ''));
    if (f < 0) return null;
    wIdx = f + 1;
    adder = true;
  }
  const right = l.pieces.slice(wIdx + 1);
  const firstZone = right.findIndex((p) => zoneHeader(p) != null);
  if (firstZone < 0) return null;
  const zp = right.slice(firstZone);
  if (zp.length < 2 || zp.some((p) => zoneHeader(p) == null)) return null;
  const zones = zp.map((p) => ({ zone: zoneHeader(p)!, c: center(p) }));
  if (new Set(zones.map((z) => z.zone)).size !== zones.length) return null;
  const gaps = zones.slice(1).map((z, k) => z.c - zones[k]!.c);
  const spacing = gaps.length ? Math.min(...gaps) : 40;
  if (spacing <= 0) return null;
  const unit = /\blbs?\b/i.test(l.pieces[wIdx]!.str) ? 'lb' : 'kg';
  // tüm sütunlar mesafe bölgesiyse yurt içi mesafe tablosu (bölge eşlemesi il/mesafeye göre; otomatik yapılmaz)
  const distance =
    !adder && zp.every((p) => distanceZoneCode(p.str) != null) ? zp.map((p) => ({ label: p.str.replace(/\s+/g, ' ').trim(), code: zoneHeader(p)! })) : undefined;
  return {
    line: i,
    zones,
    labelRight: zones[0]!.c - spacing / 2,
    spacing,
    unit,
    adder,
    desi: !adder && /des[iİ]/i.test(l.pieces[wIdx]!.str),
    ...(distance ? { distance } : {}),
  };
}

/** Satırı ağırlık etiketi + bölge hücrelerine böler. */
function cellsOf(l: Line, h: Header): { label: string; cells: string[] } {
  const label: string[] = [];
  const cells: string[][] = h.zones.map(() => []);
  const tol = h.spacing / 2;
  for (const p of l.pieces) {
    const c = center(p);
    if (p.x2 <= h.labelRight + 2 || c < h.labelRight) {
      label.push(p.str);
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    h.zones.forEach((z, k) => {
      const d = Math.abs(z.c - c);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0 && bestD <= tol) cells[best]!.push(p.str);
  }
  return { label: label.join(' ').trim(), cells: cells.map((c) => c.join(' ').trim()) };
}

const isPriceCell = (s: string) => !!s && !/%/.test(s) && /\d/.test(s) && parseTrNumber(s) != null;
const isBrokenCell = (s: string) => /^#|^n\/?a$/i.test(s.trim());

type Segment = { packaging: PdfPackaging | null; rows: PdfTableRow[]; perKg: boolean };
type RawTable = {
  page: number;
  header: Header;
  titleLines: string[];
  segments: Segment[];
  currency: Map<string, number>;
  endLine: number;
  /** tek sütunlu tablolarda atlanan zarf/dosya satırları ("Dosya", "Zarf") */
  skippedPackRows?: string[];
  /** yalnız `header.adder` tablolarında: bantlar ve başlıktaki adım ("per additional 1 LB" → 1). */
  adders?: { step: number | null; bands: AdderBand[] };
};

/** İlave ücret tablosu satırı: (from, to] aralığında her `step` birim için `cells` tutarı. */
type AdderBand = { from: number; to: number; cells: string[] };

const ADDER_STEP = /(?:additional|ilave|her\s+ek|\bek\b)\s*(\d+(?:[.,]\d+)?)\s*(?:kgs?|lbs?|desi)\b/i;

/** "20.1 40" / "20,1 - 40" / "600.1 99 999" → aralık. */
function adderRange(label: string): { from: number; to: number } | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:kgs?|lbs?)?\s*[-–—]?\s*(\d[\d .,]*?)\s*(?:kgs?|lbs?)?$/i.exec(label.trim());
  if (!m) return null;
  const from = parseTrNumber(m[1]!);
  const to = parseTrNumber(m[2]!.trim());
  return from != null && to != null && to > from ? { from, to } : null;
}

function readAdderTable(lines: Line[], i: number, h: Header, page: number, titleLines: string[]): { t: RawTable; next: number } {
  const sm = ADDER_STEP.exec(titleLines.join(' '));
  const t: RawTable = {
    page,
    header: h,
    titleLines,
    segments: [{ packaging: null, rows: [], perKg: false }],
    currency: new Map(),
    endLine: i,
    adders: { step: sm ? parseTrNumber(sm[1]!) : null, bands: [] },
  };
  let j = i + 1;
  for (; j < lines.length; j++) {
    if (headerAt(lines, j)) break;
    const { label, cells } = cellsOf(lines[j]!, h);
    const range = label ? adderRange(label) : null;
    if (!range || !cells.some(isPriceCell)) break;
    t.adders!.bands.push({ ...range, cells: cells.map((c) => (isPriceCell(c) ? c : '')) });
    t.endLine = j;
  }
  return { t, next: j };
}

/**
 * İlave ücret tablosunu (aynı sayfadaki) önceki fiyat tablosuna işler: iki açık ağırlık satırı arasındaki boşluk
 * (ör. 30 → 40 lb) bir bandın içindeyse araya "İlave {adım}" satırı eklenir — içe aktarma bunu her ara ağırlık için
 * önceki fiyat + k × tutar olarak üretir ve sonraki açık satırla tutarlılığını denetler. Son satırın üstünü kapsayan bant
 * (ör. "150.1 – 99 999") son satırdan sonra "İlave" satırı olur; içe aktarma bunu aşım fiyatı olarak alır.
 */
function applyAdders(target: RawTable, adder: RawTable): number {
  const a = adder.adders;
  if (!a || !a.step || !(a.step > 0) || !a.bands.length) return 0;
  const zoneIdx = target.header.zones.map((z) => adder.header.zones.findIndex((x) => x.zone === z.zone));
  if (zoneIdx.every((k) => k < 0)) return 0;
  let added = 0;
  const cellsFor = (band: AdderBand) => zoneIdx.map((ix) => (ix >= 0 ? (band.cells[ix] ?? '') : ''));
  for (const seg of target.segments) {
    const out: PdfTableRow[] = [];
    for (let k = 0; k < seg.rows.length; k++) {
      const cur = seg.rows[k]!;
      out.push(cur);
      const next = seg.rows[k + 1];
      if (cur.kind === 'weight' && cur.weight != null && next == null) {
        // son satırın üstü ("150.1 – 99 999": 150 lb üstü her ilave lb) → "İlave" satırı; içe aktarmada aşım fiyatı
        const w = cur.weight;
        const over = a.bands.find((b) => b.from <= w + a.step! + 1e-9 && b.to > w + 1e-9);
        if (over) {
          out.push({ kind: 'additional', label: `İlave ${fmtWeightNumber(a.step)}`, weight: null, from: null, step: a.step, cells: cellsFor(over), page: adder.page });
          added++;
        }
        continue;
      }
      if (cur.kind !== 'weight' || next?.kind !== 'weight' || cur.weight == null || next.weight == null) continue;
      const gapG = Math.round((next.weight - cur.weight) * 1000);
      const stepG = Math.round(a.step * 1000);
      if (gapG <= stepG || gapG % stepG !== 0) continue;
      const band = a.bands.find((b) => b.from <= cur.weight! + a.step! + 1e-9 && b.to >= next.weight! - 1e-9);
      if (!band) continue;
      out.push({
        kind: 'additional',
        label: `İlave ${fmtWeightNumber(a.step)}`,
        weight: null,
        from: null,
        step: a.step,
        cells: zoneIdx.map((ix) => (ix >= 0 ? (band.cells[ix] ?? '') : '')),
        page: adder.page,
      });
      added++;
    }
    seg.rows = out;
  }
  return added;
}

function packagingOf(text: string): PdfPackaging | null {
  const env = ENVELOPE_RE.test(text);
  const pak = PAK_RE.test(text);
  if (env || pak) return env ? 'envelope' : 'pak';
  if (BOX_RE.test(text)) return 'box';
  return null;
}

function readTables(lines: Line[], page: number): RawTable[] {
  const out: RawTable[] = [];
  let prevEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = headerAt(lines, i);
    if (!h) continue;
    const titleLines = lines.slice(prevEnd + 1, i).map((l) => l.text);
    if (h.adder) {
      const { t, next } = readAdderTable(lines, i, h, page, titleLines);
      out.push(t);
      prevEnd = t.endLine;
      i = Math.max(i, next - 1);
      continue;
    }
    const t: RawTable = { page, header: h, titleLines, segments: [{ packaging: null, rows: [], perKg: false }], currency: new Map(), endLine: i };
    if (h.single?.currency) t.currency.set(h.single.currency, 1);
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (headerAt(lines, j)) break;
      const l = lines[j]!;
      const { label, cells } = cellsOf(l, h);
      const seg = t.segments[t.segments.length - 1]!;
      const curCells = cells.map(currencyCell);
      if (!label && curCells.filter(Boolean).length >= Math.max(1, cells.filter(Boolean).length) && curCells.some(Boolean)) {
        for (const c of curCells) if (c) t.currency.set(c, (t.currency.get(c) ?? 0) + 1);
        continue;
      }
      const hasPrice = cells.some(isPriceCell);
      if ((h.single || h.distance) && label && hasPrice) {
        // yurt içi liste (tek sütun ya da mesafe sütunları): "Dosya" / "Zarf" satırı kapsam dışı (koli desisi ölçülür)
        const pk = packagingOf(label);
        if ((pk === 'envelope' || pk === 'pak') && parseWeightLabel(label) == null) {
          (t.skippedPackRows ??= []).push(label);
          t.endLine = j;
          continue;
        }
        // "30 desi üzeri her desi", "+": son satırın üstü → "İlave 1" (içe aktarmada aşım fiyatı)
        const over = seg.rows.some((r) => r.kind === 'weight') ? overStep(label) : null;
        if (over != null) {
          seg.rows.push({ kind: 'additional', label, weight: null, from: null, step: over, cells: cells.map((c) => (isPriceCell(c) ? c : '')), page });
          t.endLine = j;
          continue;
        }
      }
      const step = label ? parseStepLabel(label) : null;
      const wl = label && step == null ? parseWeightLabel(label) : null;
      const pctRow = cells.some((c) => /%/.test(c));
      if ((step != null || wl) && hasPrice && !pctRow) {
        const rowCells = cells.map((c) => (isPriceCell(c) || isBrokenCell(c) ? c : c === '-' || c === '—' ? '' : c));
        if (step != null) {
          seg.rows.push({ kind: 'additional', label, weight: null, from: null, step, cells: rowCells, page });
        } else if (wl!.kind === 'open' || ((wl!.kind === 'range' || wl!.perKg) && (seg.perKg || wl!.perKg))) {
          seg.rows.push({
            kind: 'perKg',
            label,
            weight: wl!.kind === 'open' ? null : wl!.weight,
            from: wl!.from ?? (wl!.kind === 'single' ? wl!.weight : null),
            step: null,
            cells: rowCells,
            page,
          });
          seg.perKg = true;
        } else {
          seg.rows.push({ kind: 'weight', label, weight: wl!.weight, from: null, step: null, cells: rowCells, page });
        }
        t.endLine = j;
        continue;
      }
      // başlık / ara başlık satırı
      const text = l.text;
      if (PER_KG_TITLE.test(label || text) && !packagingOf(label || text)) {
        seg.perKg = true;
        continue;
      }
      const pk = packagingOf(label || text);
      if (pk) {
        t.segments.push({ packaging: pk, rows: [], perKg: false });
        continue;
      }
      // tanınmayan metin: tablo satır aldıysa tablo biter
      if (t.segments.some((s) => s.rows.length)) break;
      // tek sütunlu başlık sanılan düz metin: hemen altında satır yoksa tablo değil
      if (h.single && j - i >= 3) break;
    }
    out.push(t);
    prevEnd = t.endLine;
    i = Math.max(i, j - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// İndirim tabloları ("İHRACAT İndirimi": hizmet + ağırlık bandı × bölge yüzdesi)

const DISCOUNT_PAGE = /indirim|discount/;
const DIR_WORD: [RegExp, 'export' | 'import'][] = [
  [/ihracat|export|outbound/, 'export'],
  [/ithalat|import|inbound/, 'import'],
];
/** Hizmet adından ayrılan ambalaj kelimeleri ("IPE Letter", "IP Pak", "Box"). */
const DISC_PACK_WORDS = /\b(?:letter|envelope|zarf|mektup|d[oö]k[uü]man|document|pak|box|kutu|koli|package|packages|paket)\b/gi;
const PCT_TEXT = /^%?\s*\d{1,3}(?:[.,]\d+)?\s*%?$/;

/** "67.03%", "67,03 %", "%67,03" → 67.03; "#REF!", "#N/A", "-", boş → null. `bare`: % işareti olmadan da kabul et. */
export function parsePctCell(s: string, bare = false): number | null {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || !PCT_TEXT.test(t) || (!bare && !t.includes('%'))) return null;
  const v = parseTrNumber(t.replace(/%/g, '').trim());
  return v != null && v >= 0 && v <= 100 ? v : null;
}

/**
 * İndirim satırı etiketi: "IP 3.00 5.00", "IPE Letter 0.50 0.50", "IP Pak 0,5 - 2,5", "IEF 68.00 9999.00", "IP 71 +", "IP"
 * → hizmet + ambalaj + bant. Hizmet yazmıyorsa (birleşik hücre) önceki satırınki kullanılır.
 */
function discountLabel(label: string): { service: string; packaging: PdfDiscountRow['packaging'] | 'box'; min: number | null; max: number | null } | null {
  const t = label.replace(/\s+/g, ' ').trim();
  const nums = [...t.matchAll(/\d[\d.,]*\d|\d/g)];
  if (nums.length > 2) return null;
  const head = (nums.length ? t.slice(0, nums[0]!.index) : t).replace(/[-–—:(]+\s*$/, '').trim();
  const values = nums.map((m) => parseTrNumber(m[0]));
  if (values.some((v) => v == null)) return null;
  const tail = nums.length ? t.slice(nums[nums.length - 1]!.index! + nums[nums.length - 1]![0].length) : '';
  let min: number | null = null;
  let max: number | null = null;
  if (values.length === 2) [min, max] = [values[0]!, values[1]!];
  else if (values.length === 1) {
    min = values[0]!;
    max = /\+|[üu]zeri|[üu]st[üu]|over|above/i.test(tail) ? null : values[0]!;
  }
  if (min != null && max != null && max < min) return null;
  const pk = packagingOf(head);
  const service = head
    .replace(DISC_PACK_WORDS, ' ')
    .replace(/®|™/g, '')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\b(?:kgs?|lbs?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
    .trim();
  return { service, packaging: pk === 'envelope' || pk === 'pak' ? pk : pk === 'box' ? 'box' : null, min, max };
}

/** Bölge başlıkları satırı: sondaki ≥2 bölge başlığı (solunda sayı / yüzde yok). */
function discountHeaderAt(l: Line, i: number): Header | null {
  const ps = l.pieces;
  let k = ps.length;
  while (k > 0 && zoneHeader(ps[k - 1]!) != null) k--;
  const zp = ps.slice(k);
  if (zp.length < 2) return null;
  if (ps.slice(0, k).some((p) => /\d|%/.test(p.str.replace(/\((?:kgs?|lbs?)\)/gi, '')))) return null;
  const zones = zp.map((p) => ({ zone: zoneHeader(p)!, c: center(p) }));
  if (new Set(zones.map((z) => z.zone)).size !== zones.length) return null;
  const gaps = zones.slice(1).map((z, n) => z.c - zones[n]!.c);
  const spacing = Math.min(...gaps);
  if (!(spacing > 0)) return null;
  return { line: i, zones, labelRight: zones[0]!.c - spacing / 2, spacing, unit: 'kg', adder: false };
}

type RawDiscountRow = PdfDiscountRow & { service: string; direction: PdfDiscountTable['direction']; zones: string[] };

/**
 * İndirim yüzdesi tabloları: "İhracat İndirimi" / "Export Discount" sayfasında bölge başlıkları + satırlar
 * ("IP 3.00 5.00 67.00% … #REF!"). Hücreler bölge sütununa x konumuyla atanır (eksik sütunlu "RE" satırları da doğru yere düşer).
 * Yön sayfa başlığından; arada "İthalat" gibi bir satır gelirse sonraki satırlar o yöne.
 */
function readDiscountRows(lines: Line[], page: number, direction: PdfDiscountTable['direction']): RawDiscountRow[] {
  const out: RawDiscountRow[] = [];
  let h: Header | null = null;
  let dir = direction;
  let lastService = '';
  let bare = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const nh = discountHeaderAt(l, i);
    if (nh) {
      h = nh;
      lastService = '';
      // başlık bölgesi yüzde diyorsa ("İndirim (%)", "yüzde") işaretsiz sayılar da yüzde sayılır
      const around = fold(lines.slice(Math.max(0, i - 4), i + 1).map((x) => x.text).join(' '));
      bare = /%|yuzde|percent/.test(around);
      continue;
    }
    if (!h) {
      const f = fold(l.text);
      for (const [re, d] of DIR_WORD) if (re.test(f)) dir = d;
      continue;
    }
    const { label, cells } = cellsOf(l, h);
    const pcts = cells.map((c) => parsePctCell(c, bare));
    const hasPct = pcts.some((p) => p != null);
    const broken = cells.filter((c) => c && isBrokenCell(c)).length;
    const parsed = label ? discountLabel(label) : null;
    if (parsed && (hasPct || (broken > 0 && broken === cells.filter(Boolean).length))) {
      const service = parsed.service || lastService;
      if (!service) continue;
      lastService = service;
      out.push({
        label,
        packaging: parsed.packaging === 'box' ? null : parsed.packaging,
        min: parsed.min,
        max: parsed.max,
        pcts,
        cells,
        page,
        service,
        direction: dir,
        zones: h.zones.map((z) => z.zone),
      });
      continue;
    }
    // ara başlık: "İthalat İndirimi" → sonraki satırlar ithalat
    const f = fold(l.text);
    if (!hasPct) for (const [re, d] of DIR_WORD) if (re.test(f)) dir = d;
  }
  return out;
}

/** Ham satırları (yön + hizmet) tablolarına toplar; farklı bölge başlıklı parçalar birleşir (bölgeler birleşimi). */
function groupDiscountRows(rows: RawDiscountRow[]): PdfDiscountTable[] {
  const tables: PdfDiscountTable[] = [];
  const keyOf = (r: RawDiscountRow) => `${r.direction ?? ''}|${r.service.toUpperCase()}`;
  const byKey = new Map<string, PdfDiscountTable>();
  for (const r of rows) {
    const key = keyOf(r);
    let t = byKey.get(key);
    if (!t) {
      const dir = r.direction === 'export' ? ' ihracat' : r.direction === 'import' ? ' ithalat' : '';
      t = { id: `d${tables.length + 1}`, direction: r.direction, service: r.service, title: `${r.service}${dir} indirimi`, pages: [], zones: [], rows: [] };
      tables.push(t);
      byKey.set(key, t);
    }
    for (const z of r.zones) {
      if (t.zones.includes(z)) continue;
      t.zones.push(z);
      for (const old of t.rows) {
        old.pcts.push(null);
        old.cells.push('');
      }
    }
    const idx = t.zones.map((z) => r.zones.indexOf(z));
    t.rows.push({
      label: r.label,
      packaging: r.packaging,
      min: r.min,
      max: r.max,
      pcts: idx.map((k) => (k >= 0 ? (r.pcts[k] ?? null) : null)),
      cells: idx.map((k) => (k >= 0 ? (r.cells[k] ?? '') : '')),
      page: r.page,
    });
    if (!t.pages.includes(r.page)) t.pages.push(r.page);
  }
  return tables;
}

function pageContext(lines: Line[]) {
  const top = lines.slice(0, 12).map((l) => l.text).join(' \n ');
  const f = fold(top);
  const direction: PdfSectionInfo['direction'] = /ihracat|export|outbound/.test(f)
    ? 'export'
    : /ithalat|import|inbound/.test(f)
      ? 'import'
      : /yurt\s*ici|domestic/.test(f)
        ? 'domestic'
        : null;
  const region = /dunya|world|global/.test(f) ? 'Dünya' : /avrupa|europe/.test(f) ? 'Avrupa' : /asya|asia/.test(f) ? 'Asya' : /amerika|americas/.test(f) ? 'Amerika' : null;
  return { direction, region };
}

const REGION_LINE = /\/\s*(?:ihracat|ithalat|export|import)/;

function serviceTitle(titleLines: string[]): { raw: string | null; service: string | null; priceType: PdfSectionInfo['priceType'] } {
  const cand = titleLines.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && !NOISE_TITLE.test(t));
  let start = -1;
  for (let k = cand.length - 1; k >= 0; k--) {
    const t = cand[k]!;
    if (SERVICE_WORD.test(t) && !/[:：]$/.test(t) && !REGION_LINE.test(fold(t))) {
      start = k;
      // aynı başlığın üst satırları ("FedEx International Priority® Express" + "(IPE) - Net Ücretler")
      while (start > 0 && SERVICE_WORD.test(cand[start - 1]!) && !/[:：]$/.test(cand[start - 1]!) && !/\//.test(cand[start - 1]!)) start--;
      break;
    }
  }
  if (start < 0) {
    const all = cand.join(' ');
    return { raw: null, service: null, priceType: priceTypeOf(all) };
  }
  const parts = [cand[start]!];
  for (let k = start + 1; k < cand.length; k++) {
    const t = cand[k]!;
    if (/[:：]$/.test(t)) break;
    parts.push(t);
  }
  const raw = parts.join(' ').replace(/\s+/g, ' ').replace(/\s+-\s*$/, '').trim();
  const service =
    raw
      .replace(/\s*[-–—]\s*(?:net\s*[üu]cret\w*|liste\s*fiyat\w*|net\s*rates?|list\s*(?:prices?|rates?)).*$/i, '')
      .replace(/\s*[-–—]\s*$/, '')
      .trim() || null;
  return { raw, service, priceType: priceTypeOf(raw) };
}

function priceTypeOf(text: string): PdfSectionInfo['priceType'] {
  const f = fold(text);
  if (/net\s*ucret|net\s*fiyat|net\s*rate|\bnet\b/.test(f)) return 'net';
  if (/liste\s*fiyat|list\s*(price|rate)|yayinlanan/.test(f)) return 'list';
  return 'unknown';
}

const fmtW = (n: number) => {
  const s = fmtWeightNumber(n);
  return s.endsWith(',0') ? s.slice(0, -2) : s;
};

function abbrOf(service: string | null): string | null {
  const m = service?.match(/\(([A-Z]{2,5})\)/);
  return m ? m[1]! : null;
}

function sectionTitle(s: Omit<PdfSectionInfo, 'id' | 'title'>, region: string | null, unit: 'kg' | 'lb' | 'desi' = 'kg'): string {
  const name = abbrOf(s.service) ?? s.service?.replace(/®|™/g, '').replace(/\s+/g, ' ').trim() ?? 'Fiyat tablosu';
  const dir = s.direction === 'export' ? ' ihracat' : s.direction === 'import' ? ' ithalat' : s.direction === 'domestic' ? ' yurt içi' : '';
  const zones = s.zones.length > 1 ? `(${s.zones[0]}–${s.zones[s.zones.length - 1]})` : s.zones[0] ?? '';
  const pk = s.packaging === 'box' ? 'kutu ' : '';
  const w = s.weightMin != null && s.weightMax != null ? `${pk}${fmtW(s.weightMin)}–${fmtW(s.weightMax)} ${unit}` : pk.trim();
  const pt = s.priceType === 'net' ? 'net' : s.priceType === 'list' ? 'liste' : '';
  return [`${name}${dir}`, [region, zones].filter(Boolean).join(' '), w, pt].filter(Boolean).join(' · ');
}

/**
 * `sectionTitle` başlığının gösterimi. Başlık tarama sonucunda Türkçe kalır (hizmet eşleştirmesi ve API başlığın
 * parçalarına bakar); yalnız ekranda çevrilir. Hizmet adı ve bölge kodları olduğu gibi kalır.
 */
const PDF_TITLE_WORDS: [RegExp, string][] = [
  [/^Fiyat tablosu/, 'Price table'],
  [/ ihracat$/, ' export'],
  [/ ithalat$/, ' import'],
  [/ yurt içi$/, ' domestic'],
  [/^Dünya\b/, 'World'],
  [/^Avrupa\b/, 'Europe'],
  [/^Asya\b/, 'Asia'],
  [/^Amerika\b/, 'Americas'],
  [/^kutu\b/, 'box'],
  [/^liste × indirim$/, 'list × discount'],
  [/^liste$/, 'list'],
];

export function localizePdfSectionTitle(title: string, locale: Locale = DEFAULT_LOCALE): string {
  if (locale === 'tr') return title;
  return title
    .split(' · ')
    .map((seg) => PDF_TITLE_WORDS.reduce((x, [re, en]) => x.replace(re, en), seg).replace(/(\d),(\d)/g, '$1.$2'))
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Ülke → bölge listesi

/** "Ülke", "Ülkeler", "Country", "Countries & Territories", "Country/Territory", "Destination (country)". */
const COUNTRY_HEAD = /^(?:[üu]lke(?:ler)?|countr(?:y|ies)(?:\s*(?:&|and|\/)\s*territor(?:y|ies))?|destination(?:\s*countr(?:y|ies))?|var[ıi][sş]\s*[üu]lkesi)$/i;
const ZONE_WORD = /^(?:b[öo]lge|zone|region)$/i;
const ZONE_CODE = /^(?:[A-Z]{1,2}|\d{1,2})$/;

function readCountries(lines: Line[], page: number): PdfCountryRow[] {
  const hIdx = lines.findIndex((l) => {
    const ps = l.pieces;
    return ps.some((p, k) => COUNTRY_HEAD.test(p.str.trim()) && ps[k + 1] && ZONE_WORD.test(ps[k + 1]!.str.trim()));
  });
  if (hIdx < 0) return [];
  const hl = lines[hIdx]!;
  const pairs: { nameX: number; zoneC: number; zoneX: number }[] = [];
  hl.pieces.forEach((p, k) => {
    const n = hl.pieces[k + 1];
    if (COUNTRY_HEAD.test(p.str.trim()) && n && ZONE_WORD.test(n.str.trim())) pairs.push({ nameX: p.x, zoneC: center(n), zoneX: n.x });
  });
  if (!pairs.length) return [];
  const below = lines.slice(hIdx + 1).flatMap((l) => l.pieces);
  const out: PdfCountryRow[] = [];
  pairs.forEach((pair, k) => {
    const left = k === 0 ? -Infinity : pairs[k - 1]!.zoneC + 10;
    const right = pair.zoneX - 4;
    const zones = below
      .filter((p) => ZONE_CODE.test(p.str.trim()) && Math.abs(center(p) - pair.zoneC) <= 12)
      .sort((a, b) => b.y - a.y);
    if (!zones.length) return;
    const zoneSet = new Set(zones);
    const frags = below.filter((p) => !zoneSet.has(p) && p.x >= left && p.x < right && !NOISE_TITLE.test(p.str)).sort((a, b) => b.y - a.y || a.x - b.x);
    // her satırın kendi hizasındaki ad parçaları + aradaki (tek başına) parçalar
    const rows = zones.map((z) => ({ z, own: [] as Piece[], name: [] as string[] }));
    const orphans: Piece[] = [];
    for (const f of frags) {
      const r = rows.find((x) => Math.abs(x.z.y - f.y) <= 1.5);
      if (r) r.own.push(f);
      else orphans.push(f);
    }
    // ilk satırın üstü / son satırın altı
    const maxGap = 14;
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const prefix0 = orphans.filter((o) => o.y > first.z.y && o.y - first.z.y <= maxGap);
    const suffixN = orphans.filter((o) => o.y < last.z.y && last.z.y - o.y <= maxGap);
    const text = (ps: Piece[]) => ps.map((p) => p.str).join(' ');
    const rec = (s: string) => (s && countryNameToIso2(s) ? 1 : 0);
    let carry = text(prefix0);
    for (let r = 0; r < rows.length; r++) {
      const cur = rows[r]!;
      const own = text(cur.own);
      const next = rows[r + 1];
      if (!next) {
        out.push({ name: [carry, own, text(suffixN)].filter(Boolean).join(' '), zone: cur.z.str.trim(), page });
        break;
      }
      const gap = orphans.filter((o) => o.y < cur.z.y && o.y > next.z.y && (cur.z.y - o.y <= maxGap || o.y - next.z.y <= maxGap));
      const nextOwn = text(next.own);
      let bestS = 0;
      let bestScore = -Infinity;
      for (let s = 0; s <= gap.length; s++) {
        const upper = [carry, own, text(gap.slice(0, s))].filter(Boolean).join(' ');
        const lower = [text(gap.slice(s)), nextOwn].filter(Boolean).join(' ');
        // yakınlık: parçanın atandığı satıra uzaklığı
        let dist = 0;
        gap.forEach((g, gi) => (dist += gi < s ? cur.z.y - g.y : g.y - next.z.y));
        const score = 2 * rec(upper) + rec(lower) - dist * 0.001;
        if (score > bestScore) {
          bestScore = score;
          bestS = s;
        }
      }
      out.push({ name: [carry, own, text(gap.slice(0, bestS))].filter(Boolean).join(' '), zone: cur.z.str.trim(), page });
      carry = text(gap.slice(bestS));
    }
  });
  return out.filter((c) => c.name.trim());
}

// ---------------------------------------------------------------------------------------------
// Belge bilgileri

const TR_MONTHS = ['ocak', 'subat', 'mart', 'nisan', 'mayis', 'haziran', 'temmuz', 'agustos', 'eylul', 'ekim', 'kasim', 'aralik'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ymd = (y: number, m: number, d: number) =>
  y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;

export function detectValidFrom(text: string): string | null {
  const f = fold(text).replace(/\s+/g, ' ');
  const counts = new Map<string, number>();
  const bump = (s: string | null) => s && counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const m of f.matchAll(/(\d{1,2}) (ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) (\d{4})\S{0,6} (?:tarihinden )?itibaren/g))
    bump(ymd(+m[3]!, TR_MONTHS.indexOf(m[2]!) + 1, +m[1]!));
  for (const m of f.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4}) (?:tarihinden |tarihi )?itibaren/g)) bump(ymd(+m[3]!, +m[2]!, +m[1]!));
  for (const m of f.matchAll(/(?:effective|valid)(?: from| as of| date)?:? (\d{1,2}) (january|february|march|april|may|june|july|august|september|october|november|december),? (\d{4})/g))
    bump(ymd(+m[3]!, EN_MONTHS.indexOf(m[2]!) + 1, +m[1]!));
  for (const m of f.matchAll(/(?:effective|valid)(?: from| as of| date)?:? (january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2}),? (\d{4})/g))
    bump(ymd(+m[3]!, EN_MONTHS.indexOf(m[1]!) + 1, +m[2]!));
  for (const m of f.matchAll(/(?:effective|valid)(?: from| as of| date)?:? (\d{4})-(\d{2})-(\d{2})/g)) bump(ymd(+m[1]!, +m[2]!, +m[3]!));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function detectDimDivisor(text: string): number | null {
  const ok = (n: number) => (n >= 1000 && n <= 10000 ? n : null);
  const m = /\bDIM\s*(?:factor|divisor)?\s*:?\s*(\d{4,5})\b/i.exec(text) ?? /(?:hacim\s*)?b[öo]len(?:i)?\s*:?\s*(\d{4,5})\b/i.exec(text) ?? /divisor\s*:?\s*(\d{4,5})\b/i.exec(text);
  if (m) return ok(+m[1]!);
  const r = /(?:boyutsal|dimensional|hacim|volum)[^.\n]{0,60}?\b1\s*:\s*([3-6])\b(?![\d.,])/i.exec(text);
  return r ? +r[1]! * 1000 : null;
}

export function detectFuel(text: string): PdfFuel {
  const m = /\bFIXED\s*:?\s*%?\s*(\d+(?:[.,]\d+)?)\s*%?/i.exec(text) ?? /yak[ıi]t[^\n]{0,80}?sabit\s*%\s*(\d+(?:[.,]\d+)?)/i.exec(text) ?? /fuel[^\n]{0,80}?fixed\s*(?:at)?\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(text);
  if (m) {
    const pct = parseTrNumber(m[1]!);
    if (pct != null && pct >= 0 && pct <= 100) return { kind: 'FIXED_PCT', pct };
  }
  if (/(?:yak[ıi]t|fuel)[^\n]{0,80}(?:endeks|index|haftal[ıi]k|weekly|monthly|ayl[ıi]k)/i.test(text)) return { kind: 'INDEXED', pct: null };
  return { kind: 'UNKNOWN', pct: null };
}

const CARRIERS: [RegExp, string][] = [
  [/fedex/gi, 'FedEx'],
  [/\bups\b/gi, 'UPS'],
  [/\bdhl\b/gi, 'DHL'],
  [/\btnt\b/gi, 'TNT'],
  [/\baras\b/gi, 'Aras Kargo'],
  [/yurt\s*i̇?[çc]i\s*kargo/gi, 'Yurtiçi Kargo'],
  [/\bmng\b/gi, 'MNG Kargo'],
  [/\bptt\b/gi, 'PTT'],
  [/aramex/gi, 'Aramex'],
];

function detectCarrier(text: string): string | null {
  const scored = CARRIERS.map(([re, name]) => ({ name, n: (text.match(re) ?? []).length })).sort((a, b) => b.n - a.n);
  return scored[0] && scored[0].n > 0 ? scored[0].name : null;
}

const DOC_CURRENCY: [RegExp, string][] = [
  [/\bUSD\b|US\$/g, 'USD'],
  [/\bEUR\b|€/g, 'EUR'],
  [/\bGBP\b|£/g, 'GBP'],
  [/\bTRY\b|\bTL\b|₺/g, 'TRY'],
];

/** Yalnız sayfa metinlerinden (konumsuz) belge bilgileri; yüklemede de hızlıca kullanılır. */
export function detectDocumentFacts(pageTexts: string[]): Omit<PdfDocumentFacts, 'countryZonePages'> {
  const all = pageTexts.join('\n');
  const stated = /(?:t[üu]m\s+fiyatlar|all\s+(?:rates|prices))[^.\n]{0,40}?\b(USD|EUR|GBP|TRY|TL)\b/i.exec(all);
  let currency: string | null = stated ? (stated[1]!.toUpperCase() === 'TL' ? 'TRY' : stated[1]!.toUpperCase()) : null;
  if (!currency) {
    const c = DOC_CURRENCY.map(([re, code]) => ({ code, n: (all.match(re) ?? []).length })).sort((a, b) => b.n - a.n)[0];
    currency = c && c.n >= 3 ? c.code : null;
  }
  const weightUnit = /a[gğ][ıi]rl[ıi]k\s*\(\s*kg\s*\)|weight\s*\(\s*kgs?\s*\)/i.test(all) ? 'kg' : /weight\s*\(\s*lbs?\s*\)/i.test(all) ? 'lb' : /\bkg\b/i.test(all) ? 'kg' : null;
  const notes: string[] = [];
  if (/KDV[^.\n]{0,40}hari[çc]|excluding\s+VAT|VAT\s+excluded/i.test(all)) notes.push('Fiyatlara KDV dahil değil');
  if (/g[üu]nl[üu]k\s+kur|daily\s+(?:exchange|fx)|OANDA/i.test(all)) notes.push('Başka para birimiyle faturada taşıyıcının günlük kuru kullanılır');
  const surchargeNotes: string[] = [];
  const discountPages: number[] = [];
  pageTexts.forEach((t, i) => {
    const pct = (t.match(/\d+(?:[.,]\d+)?\s*%/g) ?? []).length;
    if (pct >= 10 && /indirim|discount/i.test(t)) discountPages.push(i + 1);
    if (/muaf|waiver|exempt/i.test(t)) {
      for (const m of t.matchAll(/([A-Za-zÇĞİÖŞÜçğıöşü][A-Za-zÇĞİÖŞÜçğıöşü/ ()-]{3,60}?)\s+(\d{1,3})\s*%/g)) {
        const name = m[1]!.replace(/\s+/g, ' ').trim();
        if (!/y[üu]zde|percent|muafiyet|fixed|yak[ıi]t|fuel/i.test(name)) surchargeNotes.push(`${name} ek ücreti %${m[2]} muaf`);
      }
    }
  });
  return {
    carrier: detectCarrier(all),
    validFrom: detectValidFrom(all),
    currency,
    weightUnit,
    dimDivisor: detectDimDivisor(all),
    fuel: detectFuel(all),
    surchargeNotes: [...new Set(surchargeNotes)].slice(0, 6),
    discountPages,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Tarama

const lineText = (items: PdfTextItem[]) =>
  buildLines(items)
    .map((l) => l.text)
    .join('\n');

/** Konumlu metinden sayfa metni (yapay zekâ ve doğrulama için de kullanılabilir). */
export function layoutPageText(page: PdfPageLayout): string {
  return lineText(page.items);
}

export function scanPdfLayout(pages: PdfPageLayout[], pageTexts?: string[]): PdfCodeScan {
  const texts = pageTexts ?? pages.map(layoutPageText);
  const facts = detectDocumentFacts(texts);
  const sections: PdfCodeSection[] = [];
  const countries: PdfCountryRow[] = [];
  const countryPages: number[] = [];
  const units: ('kg' | 'lb')[] = [];
  let desiTables = 0;
  const discountRows: RawDiscountRow[] = [];
  pages.forEach((pg, pi) => {
    const page = pi + 1;
    const lines = buildLines(pg.items);
    const ctx = pageContext(lines);
    if (DISCOUNT_PAGE.test(fold(lines.map((l) => l.text).join(' ')))) discountRows.push(...readDiscountRows(lines, page, ctx.direction));
    const cs = readCountries(lines, page);
    if (cs.length >= 5) {
      countries.push(...cs);
      countryPages.push(page);
    }
    let pagePriceType: PdfSectionInfo['priceType'] = 'unknown';
    const tables = readTables(lines, page);
    // "From | To" ilave ücret tabloları kendi başına bölüm değildir: aynı sayfadaki önceki fiyat tablosuna işlenir
    tables.forEach((t, k) => {
      if (!t.header.adder) return;
      const target = tables.slice(0, k).reverse().find((x) => !x.header.adder);
      if (target) applyAdders(target, t);
    });
    for (const t of tables) {
      if (t.header.adder) continue;
      const split = t.segments.some((s) => s.packaging != null);
      const keep = t.segments.filter((s) => s.rows.length && (split ? s.packaging === 'box' : true));
      const rows = keep.flatMap((s) => s.rows);
      if (!rows.some((r) => r.kind !== 'additional')) continue;
      const zones = t.header.zones.map((z) => z.zone);
      // tamamen boş sütun (ör. bölge yalnız başlıkta) tablodan çıkmaz; bozuk hücreler çıkarmada elenir
      const { raw, service, priceType: pt } = serviceTitle(t.titleLines);
      let priceType = pt;
      if (priceType === 'unknown') priceType = priceTypeOf(t.titleLines.join(' '));
      if (priceType === 'unknown') priceType = pagePriceType;
      else pagePriceType = priceType;
      const weights = rows.flatMap((r) => (r.kind === 'weight' ? [r.weight!] : r.kind === 'perKg' ? [r.weight ?? r.from ?? 0] : [])).filter((w) => w > 0);
      const cur = [...t.currency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? facts.currency;
      const single = !!t.header.single;
      const distance = t.header.distance;
      const info: Omit<PdfSectionInfo, 'id' | 'title'> = {
        service: service ?? raw,
        // tek fiyat sütunlu liste ("Desi | Ücret") ve mesafe sütunlu liste ("Şehir içi | Yakın …") yurt içidir
        direction: ctx.direction ?? (single || distance ? 'domestic' : null),
        priceType,
        packaging: split ? 'box' : 'all',
        zones,
        weightMin: weights.length ? Math.min(...weights) : null,
        weightMax: weights.length ? Math.max(...weights) : null,
        currency: cur ?? null,
        pages: [page],
        hasAdditionalStep: rows.some((r) => r.kind === 'additional'),
        hasPerKgBands: rows.some((r) => r.kind === 'perKg'),
      };
      const id = `c${sections.length + 1}`;
      const notes: string[] = [];
      if (t.skippedPackRows?.length) {
        notes.push(`${t.skippedPackRows.map((x) => `"${x}"`).join(', ')} satırı alınmadı (zarf/dosya fiyatı; koli desisi ölçülür)`);
      }
      if (distance) {
        const renamed = distance.filter((d) => d.label !== d.code);
        notes.push(
          `mesafe bölgeleri okundu${renamed.length ? ` (${renamed.map((d) => `"${d.label}" → ${d.code}`).join(', ')})` : ''}; mesafe bölgelerini fatura satırlarıyla eşlemek için bölge eşlemesini kontrol edin`,
        );
      }
      if (t.header.single?.priceHeader) notes.push(`fiyatlar "${t.header.single.priceHeader}" sütunundan alındı`);
      const unitLabel = t.header.desi ? 'desi' : t.header.unit;
      sections.push({
        ...info,
        id,
        title: sectionTitle(info, ctx.region, unitLabel),
        table: { sectionId: id, zones, rows },
        ...(notes.length ? { notes } : {}),
      });
      units.push(t.header.unit);
      if (t.header.desi) desiTables++;
    }
  });
  // Tablo başlıklarının hepsi libre ("Lb | Zone 1 …") ise ağırlıklar libredir — metindeki dağınık "kg" geçişleri
  // (ör. "Weight (kg)" yoksa genel kg tahmini) bunu ezmez; aksi hâlde lb ağırlıklar kg diye içe aktarılırdı.
  const allLb = units.length > 0 && units.every((u) => u === 'lb');
  // "Desi" başlıklı tablo: ağırlık sütunu desidir → hacim böleni 3000 (belgede başka bölen yazmıyorsa)
  const dimDivisor = facts.dimDivisor ?? (desiTables > 0 && desiTables === sections.length ? 3000 : null);
  // belgede para birimi sayılmadıysa tabloların başlığındaki ("Fiyat (TL)") ortak para birimi
  const secCur = [...new Set(sections.map((x) => x.currency))];
  const currency = facts.currency ?? (secCur.length === 1 ? secCur[0]! : null);
  return {
    document: { ...facts, currency, dimDivisor, weightUnit: allLb ? 'lb' : (facts.weightUnit ?? (sections.length ? 'kg' : null)), countryZonePages: countryPages },
    sections,
    countries,
    discountTables: groupDiscountRows(discountRows),
  };
}

// ---------------------------------------------------------------------------------------------
// Önerilen bölümler (faturalardaki hizmet adı → bölüm)

const NOISE_WORDS = new Set(['fedex', 'ups', 'dhl', 'tnt', 'the', 've', 'and', 'pak', 'envelope', 'zarf', 'box', 'kutu', 'export', 'import', 'ihracat', 'ithalat', 'net', 'ucretler', 'ucret', 'liste', 'fiyati', 'service', 'servis', 'hizmet']);

export function serviceTokens(s: string | null | undefined): string[] {
  const t = fold(String(s ?? ''))
    .replace(/[®™©]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bint['’]?l\b|\bintl\.?\b|\binternat\b/g, 'international')
    .replace(/\bintl(?=[a-z])/g, 'international ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [...new Set(t.split(' ').filter((w) => w && !NOISE_WORDS.has(w)))];
}

/** Hizmet adı ↔ bölüm hizmeti benzerliği: birebir aynı > bölüm kısaltması > alt küme (fazla kelime cezalı). */
export function serviceMatchScore(invoiceService: string, section: { service: string | null; title?: string }): number {
  const a = serviceTokens(invoiceService);
  const b = serviceTokens(section.service ?? section.title ?? '');
  if (!a.length || !b.length) return 0;
  const abbr = abbrOf(section.service);
  if (abbr && fold(invoiceService).split(/[^a-z0-9]+/).includes(abbr.toLowerCase())) return 3;
  const sa = new Set(a);
  const sb = new Set(b);
  if (a.length === b.length && a.every((w) => sb.has(w))) return 3;
  if (a.every((w) => sb.has(w))) return 2 - 0.1 * (b.length - a.length);
  if (b.every((w) => sa.has(w))) return 1.5 - 0.1 * (a.length - b.length);
  const common = a.filter((w) => sb.has(w)).length;
  return common >= 2 ? 0.5 + common * 0.1 : 0;
}

type SuggestSection = Pick<PdfSectionInfo, 'id' | 'service' | 'title' | 'priceType' | 'direction' | 'packaging' | 'zones'> & {
  /** bölüm liste × indirim tablosuyla hesaplanabiliyorsa (core `linkListDiscounts`) dolu */
  listDiscount?: unknown;
};

/** Fiyat kaynağı: 'listDiscount' = liste fiyatı × indirim tablosu (sözleşmedeki kesin hesap), 'table' = tablodaki fiyat. */
export type PdfPricing = 'table' | 'listDiscount';

/** Önerinin kaynağı: faturalardaki hizmet, hedef tarifenin hizmeti, ya da eşleşme yok (ilk koli tablosu). */
export type PdfSuggestionSource = 'invoices' | 'tariff' | 'default';

/** Hizmet adlarından (ilk eşleşen kazanır) en uyan bölüm hizmeti anahtarı; yoksa null. */
function bestServiceKey(usable: SuggestSection[], services: (string | null | undefined)[]): string | null {
  for (const svc of services.filter((s): s is string => !!s && !!s.trim())) {
    let best: { score: number; key: string } | null = null;
    for (const s of usable) {
      const sc = serviceMatchScore(svc, s);
      if (sc > 0 && (!best || sc > best.score)) best = { score: sc, key: serviceTokens(s.service ?? s.title).join(' ') };
    }
    if (best) return best.key; // en sık kullanılan (ilk) eşleşen hizmet
  }
  return null;
}

/**
 * Önerilen bölümler ve kaynağı (SPEC §5.7): önce son faturaların hizmetleri; tarifenin hizmeti yalnız taşıyıcının
 * hizmet adı yazan faturası yoksa. Hiçbiri eşleşmezse ilk koli tablosunun hizmeti ('default').
 */
export function suggestPdfSectionChoice(
  sections: SuggestSection[],
  from: { invoiceServices: (string | null | undefined)[]; tariffService?: string | null },
): { ids: string[]; source: PdfSuggestionSource | null; pricing: PdfPricing } {
  const usable = sections.filter((s) => s.packaging !== 'envelope' && s.packaging !== 'pak');
  if (!usable.length) return { ids: [], source: null, pricing: 'table' };
  const invoices = from.invoiceServices.filter((s): s is string => !!s && !!s.trim());
  const pool = invoices.length ? invoices : [from.tariffService];
  const key = bestServiceKey(usable, pool);
  const source: PdfSuggestionSource = key == null ? 'default' : invoices.length ? 'invoices' : 'tariff';
  const ids = groupFor(usable, key ?? serviceTokens(usable[0]!.service ?? usable[0]!.title).join(' '));
  // önerilen tabloların hepsi liste × indirimle hesaplanabiliyorsa o önerilir (sözleşmenin 2. sayfası: kesin hesap)
  const byId = new Map(usable.map((s) => [s.id, s]));
  const pricing: PdfPricing = ids.length > 0 && ids.every((id) => byId.get(id)?.listDiscount) ? 'listDiscount' : 'table';
  return { ids, source, pricing };
}

/**
 * Verilen hizmet adlarına (sırayla) en uyan bölümler: aynı hizmetin tüm bölge grupları (Dünya + Avrupa),
 * netler listeden, ihracat ithalattan önce; zarf/pak hiç önerilmez.
 */
export function suggestPdfSections(sections: SuggestSection[], services: (string | null | undefined)[]): string[] {
  const usable = sections.filter((s) => s.packaging !== 'envelope' && s.packaging !== 'pak');
  if (!usable.length) return [];
  return groupFor(usable, bestServiceKey(usable, services) ?? serviceTokens(usable[0]!.service ?? usable[0]!.title).join(' '));
}

function groupFor(usable: SuggestSection[], key: string): string[] {
  let group = usable.filter((s) => serviceTokens(s.service ?? s.title).join(' ') === key);
  if (group.some((s) => s.priceType === 'net')) group = group.filter((s) => s.priceType === 'net');
  if (group.some((s) => s.direction === 'export')) group = group.filter((s) => s.direction === 'export');
  else if (group.some((s) => s.direction === 'domestic')) group = group.filter((s) => s.direction === 'domestic');
  // aynı bölgeleri kapsayan ikinci tabloyu alma (ilk geleni tut)
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of group) {
    const zs = s.zones.map((z) => z.toUpperCase());
    if (zs.some((z) => seen.has(z))) continue;
    zs.forEach((z) => seen.add(z));
    out.push(s.id);
  }
  return out;
}
