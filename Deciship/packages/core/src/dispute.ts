import { desi, fromCents, sumMoney, toCents, type Dims, type EdgeRounding } from './calc';
import type { DiffType } from './compare';
import { disputeClaim, isDisputable } from './disputes';
import { fmtDate, fmtDesi, fmtDims, fmtKg, fmtMoney, fmtMoneyEn } from './format';
import { t, type Locale, type MessageKey, type MessageParams } from './i18n/index';

export type DisputeLang = Locale;

/** Ölçü yöntemi (mobil `dimMethod`). */
export type EvidenceDimMethod = 'LIDAR' | 'AR' | 'REFERENCE' | 'MANUAL' | 'PRESET';
/** Ağırlık yöntemi (mobil `weightMethod`). */
export type EvidenceWeightMethod = 'OCR' | 'MANUAL';

/**
 * Satırın ölçüm kanıtı (Mesaj 5, denetim 04-B8). Ölçen kişinin ADI burada yoktur ve metne girmez (kargo firmasına gider);
 * metin yalnız rolü ("depo çalışanımız"), ölçüm zamanını ve yöntemi yazar. Ad yalnız firmanın kendi raporundadır.
 */
export type DisputeEvidence = {
  /** 'YYYY-MM-DD HH:mm', firma saat diliminde. */
  measuredAtLocal: string;
  dimMethod: EvidenceDimMethod;
  weightMethod: EvidenceWeightMethod;
  photoCount: number;
};

export type DisputeLine = {
  trackingNo: string;
  shipDate?: string | null;
  diffTypes: DiffType[];
  decision?: 'OPEN' | 'VERIFIED' | 'ACCEPTED';
  /** Güncel karşılaştırma durumu; verilirse yalnız "Fark var" (DIFF) satırlar listelenir. */
  status?: 'MATCH' | 'DIFF' | 'UNMATCHED' | 'NO_TARIFF';
  ourDims?: Dims | null;
  ourActualKg?: number | null;
  ourChargeableKg: number | null;
  billedDims?: Dims | null;
  billedActualKg?: number | null;
  billedChargeableKg: number | null;
  expectedAmount: number | null;
  billedAmount: number;
  diffAmount: number | null;
  surcharges?: { code: string; name?: string; amount: number }[];
  /** Ölçüm kanıtı; mükerrer satırda yazılmaz. */
  evidence?: DisputeEvidence | null;
};

export type DisputeInput = {
  company: { name: string; contactName?: string; email?: string; phone?: string };
  carrier: { name: string; code?: string; accountNo?: string };
  /**
   * `chargeUnit` (KALANLAR 1.12): `desi` = yurt içi taşıyıcı (tarife böleni 3000); verilmezse `kg` (bugünkü metin). Yurt
   * içinde ücretli ağırlık desi ile gerçek kg'ın büyüğüdür; birim her taraf (bizim / faturalanan) için ayrı seçilir
   * (`chargeableUnitOf`): hacimsel desi belirlediyse "desi", gerçek ağırlık büyükse "kg", kaynağı bilinmiyorsa "desi/kg".
   * `divisor` ve `edgeRounding` (tarifenin) hacimsel desiyi hesaplamak için; yoksa kaynak bilinmez. Gerçek ağırlık her zaman kg.
   * `vatPct`: faturanın KDV oranı, yalnız biliniyorsa (K43). Verilirse ve 0'dan büyükse metin her tutarı KDV hariç ve KDV
   * dahil birlikte yazar; yoksa yalnız KDV hariç (saklanan tutar). Oranın kaynağı çağıranda (API `invoiceVatPct`).
   */
  invoice: {
    invoiceNo: string;
    invoiceDate?: string | null;
    currency: string;
    vatPct?: number | null;
    chargeUnit?: 'kg' | 'desi';
    divisor?: number | null;
    edgeRounding?: EdgeRounding;
  };
  lines: DisputeLine[];
  lang: DisputeLang;
};

/** Metne KDV dahil tutar yazılacak oran: sonlu, 0'dan büyük, en çok 100; değilse null (yalnız KDV hariç). */
export function disputeVatPct(vatPct: number | null | undefined): number | null {
  return typeof vatPct === 'number' && Number.isFinite(vatPct) && vatPct > 0 && vatPct <= 100 ? vatPct : null;
}

/**
 * K43: KDV hariç tutarın KDV dahil hâli, kuruşa yarım-yukarı yuvarlanmış (100,01 × %20 = 120,012 → 120,01;
 * 0,05 × %10 = 0,055 → 0,06). Toplamın KDV dahil hâli toplamdan hesaplanır (satırların KDV dahil toplamı değil),
 * alacak dekontu da KDV'yi toplama uygular.
 */
export function withVat(amount: number, vatPct: number): number {
  // kuruş × (100 + oran) tamsayı çarpım (oran tamsayıyken); bölüm yarım-yukarı yuvarlanır
  return fromCents(Math.round((toCents(amount) * (100 + vatPct)) / 100 + 1e-9));
}

/**
 * KALANLAR 1.12 (bağımsız inceleme): yurt içinde ücretli ağırlık = hacimsel desi ile gerçek kg'ın büyüğü. Ölçü, gerçek
 * ağırlık ve bölen biliniyorsa: gerçek kg hacimsel desiden büyükse `kg`, değilse `desi`; biri eksikse kaynak bilinmez,
 * `desi/kg`. (20×20×20 cm, 10 kg, bölen 3000: desi 2,67 → "ücretli 10 kg".)
 */
export function chargeableUnitOf(
  dims: Dims | null | undefined,
  actualKg: number | null | undefined,
  divisor: number | null | undefined,
  edgeRounding: EdgeRounding = 'CEIL_CM',
): 'desi' | 'kg' | 'desi/kg' {
  if (!dims || actualKg == null || !Number.isFinite(actualKg) || !divisor || !(divisor > 0)) return 'desi/kg';
  return actualKg > desi(dims, divisor, edgeRounding) ? 'kg' : 'desi';
}

/** E.164 Türkiye cep numarası okunur gruplarla ("+90 532 123 45 67"); başka biçim olduğu gibi. */
export function fmtPhone(phone: string): string {
  const p = phone.trim();
  const tr = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(p);
  return tr ? `+90 ${tr[1]} ${tr[2]} ${tr[3]} ${tr[4]}` : p;
}

function fmtDimsEn(d: Dims): string {
  return fmtDims(d, 'en').replace(/×/g, ' x ');
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Yazışmada gün/ay karışmasın diye ay adıyla: "Oct 27, 2026". */
function fmtDateEn(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS_EN[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/**
 * İtiraz e-postası: yalnızca VERIFIED (veya kararı verilmemiş, çağıranın süzdüğü) satırlar listelenir.
 * Yeniden karşılaştırmadan sonra artık "Fark var" olmayan ya da talep edilecek tutarı kalmayan (fark ≤ 0) doğrulanmış
 * satırlar listeye girmez — toplam, ekrandaki "İtiraz listesinde" tutarıyla (totals.verifiedTotal) aynıdır.
 */
export function buildDisputeText(input: DisputeInput): { subject: string; body: string; lineCount: number; total: number; photoCount: number } {
  const { company, carrier, invoice, lang } = input;
  // Talep kuralı itiraz paketiyle ortak (disputes.ts): gönderilen paketin tutarı bu metnin toplamıyla aynıdır.
  const claim = (l: DisputeLine) => disputeClaim(l);
  const lines = input.lines.filter(isDisputable);
  const total = sumMoney(lines.map(claim));
  const cur = invoice.currency || 'TRY';
  const tr = lang !== 'en';
  const locale: Locale = tr ? 'tr' : 'en';
  const m = (key: MessageKey, params?: MessageParams) => t(locale, key, params);
  // EN yazışmada para kodla yazılır ("1,184.00 TRY"): karşı taraf farklı ülkede olabilir
  const money = (n: number) => (tr ? fmtMoney(n, cur) : fmtMoneyEn(n, cur));
  // K43: oran biliniyorsa tutarlar KDV hariç ve KDV dahil birlikte ("%20" / "20%")
  const vat = disputeVatPct(invoice.vatPct);
  const pctText = vat == null ? '' : tr ? `%${String(vat).replace('.', ',')}` : `${vat}%`;
  const vatAmount = (n: number) => (vat == null ? '' : m('dispute.vatIncluded', { amount: money(withVat(n, vat)), pct: pctText }));
  const kg = (n: number) => fmtKg(n, locale);
  // KALANLAR 1.12: yurt içinde ücretli ağırlık desidir ("ücretli 12 desi"); gerçek ağırlık kg kalır
  const chargeable = (n: number, dims: Dims | null | undefined, actualKg: number | null | undefined) => {
    const unit = invoice.chargeUnit === 'desi' ? chargeableUnitOf(dims, actualKg, invoice.divisor, invoice.edgeRounding) : 'kg';
    const text = unit === 'desi' ? fmtDesi(n, locale) : unit === 'kg' ? kg(n) : `${fmtDesi(n, locale)}/kg`;
    return m('dispute.line.chargeable', { kg: text });
  };
  const dims = (d: Dims) => (tr ? `${fmtDims(d)} cm` : `${fmtDimsEn(d)} cm`);
  const dateText = (iso: string) => (tr ? fmtDate(iso) : fmtDateEn(iso));
  // 'YYYY-MM-DD HH:mm' → "21.10.2026 14:32" / "Oct 21, 2026 14:32"; beklenmeyen biçim olduğu gibi yazılır
  const whenText = (local: string) => {
    const w = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(local.trim());
    return w ? `${dateText(w[1]!)} ${w[2]}` : local.trim();
  };
  // Kanıt yalnız mükerrer olmayan satırda yazılır; fotoğraf sayısı da bu satırlardan (ZIP aynı kümeyi taşımalı).
  const evidenceOf = (l: DisputeLine): DisputeEvidence | null => (l.evidence && !l.diffTypes.includes('DUPLICATE') ? l.evidence : null);
  const photosOf = (l: DisputeLine): number => {
    const n = evidenceOf(l)?.photoCount ?? 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const describe = (l: DisputeLine, i: number): string => {
    const types = l.diffTypes.map((x) => m(`dispute.type.${x}`)).join(', ');
    const out: string[] = [];
    const date = l.shipDate ? ` (${dateText(l.shipDate)})` : '';
    out.push(m('dispute.line.head', { index: i + 1, trackingNo: l.trackingNo, date, types }));
    if (l.diffTypes.includes('DUPLICATE')) {
      out.push(m('dispute.line.duplicate', { amount: money(l.billedAmount) }) + vatAmount(l.billedAmount));
      out.push(m('dispute.line.duplicateClaim', { amount: money(claim(l)) }));
      return out.join('\n');
    }
    const ourParts: string[] = [];
    if (l.ourDims) ourParts.push(dims(l.ourDims));
    if (l.ourActualKg != null) ourParts.push(kg(l.ourActualKg));
    if (l.ourChargeableKg != null) ourParts.push(chargeable(l.ourChargeableKg, l.ourDims, l.ourActualKg));
    if (ourParts.length) out.push(m('dispute.line.ours', { parts: ourParts.join(', ') }));
    const ev = evidenceOf(l);
    if (ev) {
      out.push(
        m('dispute.line.evidence', {
          when: whenText(ev.measuredAtLocal),
          dim: m(`evidence.dimMethod.${ev.dimMethod}`),
          weight: m(`evidence.weightMethod.${ev.weightMethod}`),
        }),
      );
      const photos = photosOf(l);
      if (photos > 0) out.push(m('dispute.line.photos', { count: photos }));
    }
    const billedParts: string[] = [];
    if (l.billedDims) billedParts.push(dims(l.billedDims));
    if (l.billedActualKg != null) billedParts.push(kg(l.billedActualKg));
    if (l.billedChargeableKg != null) billedParts.push(chargeable(l.billedChargeableKg, l.billedDims, l.billedActualKg));
    if (billedParts.length) out.push(m('dispute.line.billed', { parts: billedParts.join(', ') }));
    if (l.surcharges?.length) {
      const s = l.surcharges.map((x) => `${x.name || x.code} ${money(x.amount)}`).join(', ');
      out.push(m('dispute.line.surcharges', { list: s }));
    }
    const expected = l.expectedAmount != null ? money(l.expectedAmount) : '—';
    out.push(m('dispute.line.amounts', { expected, billed: money(l.billedAmount) }) + vatAmount(l.billedAmount));
    out.push(m('dispute.line.claim', { amount: money(claim(l)) }));
    return out.join('\n');
  };

  const date = invoice.invoiceDate ? m('dispute.invoiceDate', { date: dateText(invoice.invoiceDate) }) : '';
  const account = carrier.accountNo ? m('dispute.account', { accountNo: carrier.accountNo }) : '';
  // KALANLAR 1.12: imzada telefon ve e-posta (gönderenin Merkez hesabından; yoksa ya da boşsa satır yazılmaz)
  const phone = company.phone?.trim();
  const email = company.email?.trim();
  const signature = [
    company.contactName?.trim(),
    company.name,
    email ? m('dispute.signEmail', { email }) : '',
    phone ? m('dispute.signPhone', { phone: fmtPhone(phone) }) : '',
  ]
    .filter(Boolean)
    .join('\n');
  const photoCount = lines.reduce((a, l) => a + photosOf(l), 0);
  // Fotoğraf ekliyken "talep etmeniz hâlinde iletebiliriz" çelişir: o cümlenin yerine ek cümlesi yazılır.
  const closing = photoCount > 0 ? `${m('dispute.photosAttached', { count: photoCount })} ${m('dispute.closingCredit')}` : m('dispute.closing');

  const subject = m('dispute.subject', {
    carrier: carrier.name,
    invoiceNo: invoice.invoiceNo,
    shipments: m('dispute.shipments', { count: lines.length }),
    total: money(total),
  });
  const body = [
    m('dispute.greeting', { carrier: carrier.name }),
    '',
    m('dispute.intro', { company: company.name, account, date, invoiceNo: invoice.invoiceNo, count: lines.length }),
    '',
    ...lines.map((l, i) => describe(l, i) + '\n'),
    vat == null
      ? m('dispute.total', { total: money(total) })
      : m('dispute.totalVat', { total: money(total), totalVat: money(withVat(total, vat)), pct: pctText }),
    '',
    closing,
    '',
    m('dispute.signoff'),
    signature,
  ].join('\n');
  return { subject, body, lineCount: lines.length, total, photoCount };
}
