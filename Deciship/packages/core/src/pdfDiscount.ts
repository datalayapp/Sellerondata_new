/**
 * Liste fiyatı × indirim tablosu → net fiyat (FedEx Türkiye sözleşmeleri, s. 2: "kesin hesap için liste fiyatlarına
 * İhracat/İthalat İndirimi sayfasındaki indirimi uygulayın"). Net sayfalar yalnız müzakere amaçlıdır ve faturadan az
 * oranda farklı olabilir; liste × (1 − indirim) faturayla birebir tutar.
 *
 * Saf fonksiyonlar: indirim tablosunu liste bölümüyle eşleştirir, her satırın ağırlık bandındaki yüzdeyle net fiyatı
 * hesaplar (2 haneye yuvarlanır), net sayfadaki tabloyla farkı sayar. Sonuç sıradan bir net tablodur (tarife modeli değişmez).
 */
import type { PdfDiscountRow, PdfDiscountTable, PdfSectionInfo, PdfTable, PdfTableRow } from './pdfScan';
import { serviceMatchScore, serviceTokens } from './pdfScan';
import { parseTrNumber } from './format';
import { zoneKey } from './tariff';

type SectionLike = Pick<PdfSectionInfo, 'id' | 'service' | 'title' | 'direction' | 'priceType' | 'packaging' | 'zones' | 'pages'>;
type SectionWithTable = SectionLike & { table?: PdfTable };

/** İndirim tablosunun hizmeti bölümle aynı mı: kısaltma ("IP" ↔ "… (IP)") ya da adın tamamı. */
export function discountMatchesSection(d: Pick<PdfDiscountTable, 'service'>, s: Pick<PdfSectionInfo, 'service' | 'title'>): boolean {
  return serviceMatchScore(d.service, s) >= 3;
}

/** Bölümün (aynı hizmet + yön) indirim tablosu; yön bilinmiyorsa tek eşleşen. */
export function findDiscountTable(s: SectionLike, tables: PdfDiscountTable[]): PdfDiscountTable | null {
  const same = tables.filter((d) => discountMatchesSection(d, s));
  const exact = same.filter((d) => d.direction === s.direction);
  if (exact.length) return exact[0]!;
  const loose = same.filter((d) => d.direction == null || s.direction == null);
  return loose.length === 1 ? loose[0]! : null;
}

const EPS = 1e-6;

/** Ağırlığı içeren bant (en dar olanı); bantlar arasındaki boşlukta alttaki bant. Zarf / Pak satırları koli için kullanılmaz. */
export function discountBandFor(rows: PdfDiscountRow[], w: number): PdfDiscountRow | null {
  const box = rows.filter((r) => r.packaging == null);
  const inside = box.filter((r) => (r.min == null || r.min - EPS <= w) && (r.max == null || w <= r.max + EPS));
  if (inside.length) {
    const width = (r: PdfDiscountRow) => (r.max ?? Infinity) - (r.min ?? -Infinity);
    return inside.reduce((a, b) => (width(b) < width(a) ? b : a));
  }
  // bantlar arası (ör. 2,5 ile 3,0 arası 2,75 kg): alttaki bant; hiçbir bandın üstünde değilse null
  const below = box.filter((r) => r.min != null && r.min <= w && r.max != null && r.max < w);
  const above = box.some((r) => r.min != null && r.min > w);
  if (!below.length || !above) return null;
  return below.reduce((a, b) => (b.min! > a.min! ? b : a));
}

/** liste × (1 − yüzde/100), kuruşa yuvarlanmış (yarım yukarı); tam sayı aritmetiğiyle (kayan nokta kayması yok). */
export function discounted(list: number, pct: number): number {
  const cents = Math.round(list * 100);
  const keep = 1_000_000 - Math.round(pct * 10_000);
  const sign = cents < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(cents) * keep) / 1_000_000)) / 100;
}

const fmtBand = (r: PdfDiscountRow) =>
  r.min == null && r.max == null ? 'tüm ağırlıklar' : r.max == null ? `${fmtKg(r.min!)}+ kg` : r.min === r.max ? `${fmtKg(r.min!)} kg` : `${fmtKg(r.min!)}–${fmtKg(r.max)} kg`;
const fmtKg = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');

const fmtWeightLabel = (g: number) => String(g / 1000);

/**
 * İki açık ağırlık satırı arasındaki "İlave X" satırını ara ağırlıklara açar: önceki fiyat + k × tutar (kuruş tam sayısıyla).
 * İçe aktarmanın ilave kuralıyla aynı hesap; açık satırlar olduğu gibi kalır. Son satırdan sonraki "İlave" (aşım) dokunulmaz.
 */
export function expandStepRows(rows: PdfTableRow[]): PdfTableRow[] {
  const out: PdfTableRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    if (r.kind !== 'additional' || !r.step || prev?.kind !== 'weight' || next?.kind !== 'weight' || prev.weight == null || next.weight == null) {
      out.push(r);
      continue;
    }
    const fromG = Math.round(prev.weight * 1000);
    const toG = Math.round(next.weight * 1000);
    const stepG = Math.round(r.step * 1000);
    if (!(stepG > 0) || toG <= fromG || (toG - fromG) / stepG > 5000) {
      out.push(r);
      continue;
    }
    let k = 1;
    for (let g = fromG + stepG; g < toG; g += stepG, k++) {
      const cells = prev.cells.map((pc, ci) => {
        const base = parseTrNumber((pc ?? '').trim());
        const add = parseTrNumber((r.cells[ci] ?? '').trim());
        // bozuk önceki hücre ("#REF!") ara satırlara da bozuk geçer (sütun düşürme kuralı aynı kalsın)
        if (base == null) return pc ?? '';
        if (add == null) return '';
        return ((Math.round(base * 100) + k * Math.round(add * 100)) / 100).toFixed(2);
      });
      out.push({ kind: 'weight', label: fmtWeightLabel(g), weight: g / 1000, from: null, step: null, cells, page: r.page });
    }
  }
  return out;
}

export type ListDiscountMissing ={ zone: string; label: string; band: string | null; text: string };
export type ListDiscountResult = {
  table: PdfTable;
  /** hesaplanan hücre sayısı */
  computed: number;
  /** liste fiyatı olup indirimi olmayan hücreler (bölge yok, "#REF!", bant yok) — hücreye indirim metni yazılır, net diye alınmaz */
  missing: ListDiscountMissing[];
  /** tamamen indirimsiz kalan bölgeler (ör. X: "#REF!") */
  zonesWithoutDiscount: string[];
  /** kullanılan bantlar ("0,5–2,5 kg", "3–5 kg" …) */
  bands: string[];
};

/**
 * Liste bölümünün tablosunu indirim tablosuyla net fiyata çevirir. Önce iki açık satır arasındaki "İlave X" satırları liste
 * fiyatı üzerinden ara ağırlıklara açılır (liste(10,5) + k × ilave; FedEx faturası da liste fiyatını böyle bulup indirir),
 * sonra her satır kendi ağırlık bandının yüzdesiyle indirilir. Satırın ağırlığı: ağırlık satırı → kendisi; son satırdan
 * sonraki "İlave X" (aşım) → son ağırlık + X; kg başı bant → alt sınırı ("71-99" → 71).
 * İndirimi bulunamayan hücreye sayı yazılmaz (indirim hücresinin metni ya da "indirim yok"): liste fiyatı net diye alınmaz.
 */
export function applyListDiscount(section: { zones: string[]; table: PdfTable }, disc: PdfDiscountTable): ListDiscountResult {
  const zones = section.table.zones.length ? section.table.zones : section.zones;
  const dIdx = zones.map((z) => disc.zones.findIndex((d) => zoneKey(d) === zoneKey(z)));
  const missing: ListDiscountMissing[] = [];
  const bands = new Set<string>();
  const zoneCells = zones.map(() => ({ priced: 0, missing: 0 }));
  let computed = 0;
  let prevWeight: number | null = null;
  const rows: PdfTableRow[] = expandStepRows(section.table.rows).map((r) => {
    let basis: number | null;
    if (r.kind === 'weight') basis = r.weight;
    else if (r.kind === 'additional') basis = prevWeight != null && r.step ? prevWeight + r.step : null;
    else basis = r.from ?? r.weight;
    if (r.kind === 'weight' && r.weight != null) prevWeight = r.weight;
    const band = basis != null ? discountBandFor(disc.rows, basis) : null;
    if (band) bands.add(fmtBand(band));
    const cells = r.cells.map((cell, ci) => {
      const t = (cell ?? '').trim();
      const v = parseTrNumber(t);
      if (!t || t === '-' || t === '—' || v == null) return cell; // boş / bozuk liste hücresi olduğu gibi
      const k = dIdx[ci] ?? -1;
      const pct = band && k >= 0 ? band.pcts[k] : null;
      const zc = zoneCells[ci];
      if (zc) zc.priced++;
      if (pct == null) {
        const raw = band && k >= 0 ? (band.cells[k] ?? '').trim() : '';
        const text = raw && /^#/.test(raw) ? raw : 'indirim yok';
        missing.push({ zone: zones[ci] ?? '', label: r.label, band: band ? fmtBand(band) : null, text });
        if (zc) zc.missing++;
        return text;
      }
      computed++;
      return discounted(v, pct).toFixed(2);
    });
    return { ...r, cells };
  });
  const zonesWithoutDiscount = zones.filter((_, ci) => zoneCells[ci]!.priced > 0 && zoneCells[ci]!.missing === zoneCells[ci]!.priced);
  return { table: { sectionId: section.table.sectionId, zones, rows }, computed, missing, zonesWithoutDiscount, bands: [...bands] };
}

export type TableDiff = {
  /** iki tabloda da sayı olan hücre */
  compared: number;
  /** 0,005'ten fazla farklı olan */
  differing: number;
  maxDiff: number;
  examples: { zone: string; label: string; net: number; computed: number }[];
};

/**
 * Net sayfadaki tablo ile liste × indirim hesabının hücre hücre farkı (aynı bölge + aynı ağırlık). İki taraf da "İlave"
 * satırları ara ağırlıklara açılmış hâliyle karşılaştırılır (içe aktarmanın üreteceği fiyatlar): açık satırlar çoğu zaman
 * aynıdır, fark ara ağırlıklarda yuvarlanmış net ilave tutarından doğar.
 */
export function diffTables(net: PdfTable, computed: PdfTable): TableDiff {
  const keyed = (t: PdfTable) => {
    const m = new Map<string, PdfTableRow>();
    let prevW: number | null = null;
    for (const r of expandStepRows(t.rows)) {
      const k = r.kind === 'weight' ? `w${r.weight}` : r.kind === 'additional' ? `a${prevW}:${r.step}` : `p${r.from}-${r.weight}`;
      if (r.kind === 'weight') prevW = r.weight;
      if (!m.has(k)) m.set(k, r);
    }
    return m;
  };
  const a = keyed(net);
  const b = keyed(computed);
  const out: TableDiff = { compared: 0, differing: 0, maxDiff: 0, examples: [] };
  for (const [k, ra] of a) {
    const rb = b.get(k);
    if (!rb) continue;
    net.zones.forEach((z, ia) => {
      const ib = computed.zones.findIndex((x) => zoneKey(x) === zoneKey(z));
      if (ib < 0) return;
      const va = parseTrNumber((ra.cells[ia] ?? '').trim());
      const vb = parseTrNumber((rb.cells[ib] ?? '').trim());
      if (va == null || vb == null) return;
      out.compared++;
      const d = Math.round(Math.abs(va - vb) * 100) / 100;
      if (d > 0.005) {
        out.differing++;
        out.maxDiff = Math.max(out.maxDiff, d);
        if (out.examples.length < 5) out.examples.push({ zone: z, label: ra.label, net: va, computed: vb });
      }
    });
  }
  return out;
}

/** Bölüm → liste × indirim bağlantısı (net bölüm için karşılık gelen liste bölümü; liste bölümü için kendisi). */
export type PdfListDiscountLink = {
  listSectionId: string;
  discountTableId: string;
  listPages: number[];
  discountPages: number[];
  /** yalnız net bölümlerde: net sayfa ile liste × indirim farkı */
  diff: TableDiff | null;
};

const zoneSet = (z: string[]) => z.map((x) => zoneKey(x)).sort().join(',');

/**
 * Hangi bölümler liste × indirimle hesaplanabilir: liste bölümü + aynı hizmet ve yönde indirim tablosu (en az bir
 * bölge indirimli). Net bölüm, aynı hizmet / yön / ambalaj / bölgelerdeki liste bölümüne bağlanır.
 */
export function linkListDiscounts(sections: SectionWithTable[], tables: PdfDiscountTable[]): Map<string, PdfListDiscountLink> {
  const out = new Map<string, PdfListDiscountLink>();
  if (!tables.length) return out;
  const applied = new Map<string, { disc: PdfDiscountTable; result: ListDiscountResult }>();
  for (const s of sections) {
    if (s.priceType !== 'list' || !s.table) continue;
    const disc = findDiscountTable(s, tables);
    if (!disc) continue;
    const result = applyListDiscount({ zones: s.zones, table: s.table }, disc);
    if (!result.computed) continue;
    applied.set(s.id, { disc, result });
    out.set(s.id, { listSectionId: s.id, discountTableId: disc.id, listPages: s.pages, discountPages: disc.pages, diff: null });
  }
  if (!applied.size) return out;
  const svc = (s: SectionLike) => serviceTokens(s.service ?? s.title).join(' ');
  for (const n of sections) {
    if (n.priceType === 'list') continue;
    const l = sections.find(
      (x) => applied.has(x.id) && svc(x) === svc(n) && x.direction === n.direction && x.packaging === n.packaging && zoneSet(x.zones) === zoneSet(n.zones),
    );
    if (!l) continue;
    const a = applied.get(l.id)!;
    out.set(n.id, {
      listSectionId: l.id,
      discountTableId: a.disc.id,
      listPages: l.pages,
      discountPages: a.disc.pages,
      diff: n.table ? diffTables(n.table, a.result.table) : null,
    });
  }
  return out;
}
