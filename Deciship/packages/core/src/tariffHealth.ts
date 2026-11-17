import { round2 } from './calc';
import { fmtSignedPct } from './compare';
import { countryName, countryNameTr } from './countryNames';
import { DEFAULT_FX_TOLERANCE_PCT } from './fx';
import { fmtNumber, fmtPct } from './format';
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from './i18n/index';
import { serviceClassWords, serviceMismatch } from './service';

/**
 * Tarife uyumu raporu (SPEC §3.9): bir faturanın satırlarında taşıyıcının uyguladığı taşıma fiyatı tarifeyle — faturanın
 * kendi ücretli kg'ında, ölçümden bağımsız — karşılaştırılır; varış ülkesi + bölge + hizmet grubuna göre özetlenir.
 * Ülke istisnası önerisi buradan çıkar.
 */

/** Aynı para biriminde (kur yok) "uyumlu" sayılan sapma bandı, ± %. Kur çevrilen satırlarda `fxTolerancePct`. */
export const HEALTH_OK_PCT_SAME_CURRENCY = 1;
/** Grubun güvenilir sayılması için en az satır. */
export const HEALTH_MIN_LINES = 3;
/** Grup içi sapmaların yayılımı (en büyük − en küçük, puan) bundan büyükse öneri "dağınık" sayılır. */
export const HEALTH_MAX_SPREAD = 5;
/** Bundan büyük sapma istisna değil, büyük olasılıkla yanlış hizmet/bölge: öneri verilmez. */
export const HEALTH_SUSPECT_PCT = 35;

export type HealthLineInput = {
  destCountry: string | null | undefined;
  service: string | null | undefined;
  zone: string | null | undefined;
  /** Faturadaki taşıma bedelinin tarifeye göre sapması (%); hesaplanamadıysa null (satır sayılmaz). */
  rateDeviationPct: number | null | undefined;
  /** Satıra o an uygulanmış ülke istisnası (%); öneri istisna DAHİL toplam yüzde olarak verilir. */
  adjustmentPct?: number | null;
  /** Satırda kur çevrimi var mı (tarife ile fatura para birimi farklı). */
  fx: boolean;
  /** Faturadaki yakıt oranı (%), yakıt ayrı yazmıyorsa null. */
  fuelPct?: number | null;
};

export type HealthStatus = 'ok' | 'cheaper' | 'pricier';

export type HealthGroup = {
  key: string;
  country: string | null;
  countryName: string;
  zone: string | null;
  service: string | null;
  lines: number;
  medianDeviationPct: number;
  minDeviationPct: number;
  maxDeviationPct: number;
  status: HealthStatus;
  /** Tarifeye yazılacak ülke istisnası (toplam, mevcut istisna dahil); öneri yoksa null. */
  suggestedAdjustmentPct: number | null;
  currentAdjustmentPct: number;
  /** Az satır ya da dağınık sapma: öneri zayıf. */
  weak: boolean;
  /** |sapma| çok büyük: istisna değil, yanlış hizmet/bölge olabilir. */
  suspect: boolean;
  /** Grubun hizmeti tarifedeki hizmetten farklı: sapma itiraz konusu değil, "bu hizmet için tarife ekleyin". */
  serviceMismatch: boolean;
  message: string;
};

export type TariffHealthReport = {
  /** Fiyatı karşılaştırılabilen satırlar. */
  checkedLines: number;
  okLines: number;
  /** Fiyatı karşılaştırılamayan (ağırlık/tutar/bölge eksik) satırlar. */
  skippedLines: number;
  okTolerancePct: number;
  groups: HealthGroup[];
  /** Tüm satırlarda aynı küçük sapma (ör. kur kaynağı farkı) varsa tek cümle; yoksa null. */
  overallNote: string | null;
  overallMedianPct: number | null;
  /** Faturadaki yakıt oranı (medyan) tarifedekinden farklıysa tek cümle; yoksa null. */
  fuelNote: string | null;
  invoiceFuelPct: number | null;
};

/** Yakıt notu için en az satır ve en küçük oran farkı (puan). */
export const HEALTH_FUEL_MIN_LINES = 3;
export const HEALTH_FUEL_MIN_GAP = 0.1;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Mevcut istisna `cur` iken gözlenen sapma `dev` → yeni toplam istisna: (1+cur)(1+dev) − 1. */
export function combineAdjustment(cur: number, dev: number): number {
  return round2(((1 + cur / 100) * (1 + dev / 100) - 1) * 100);
}

const pctText = (p: number, locale: Locale) => fmtPct(Math.abs(round2(p)) >= 10 ? Math.round(Math.abs(p)) : Math.abs(round2(p)), locale);

export function tariffHealth(
  lines: HealthLineInput[],
  opts: {
    fxTolerancePct?: number;
    carrierName?: string | null;
    tariffFuelPct?: number | null;
    /** Tarifede yakıt "değişken": faturadaki oran kabul edilmiştir, not bunu söyler. */
    tariffFuelVariable?: boolean;
    /** Tarifenin hizmeti; grubun hizmeti bundan farklıysa öneri yerine "tarife ekleyin" denir. */
    tariffService?: string | null;
    /**
     * DENETIM-2 B1: faturada farklı hizmet sınıfları var (core `invoiceHasMixedServices`). Tarifenin hizmeti boş ya da
     * tanınmıyorsa sapma başka hizmetin fiyatından olabilir: ülke istisnası önerilmez.
     */
    mixedServices?: boolean;
    locale?: Locale;
  } = {},
): TariffHealthReport {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const carrier = opts.carrierName?.trim() || t(locale, 'health.carrierFallback');
  const usable = lines.filter((l) => typeof l.rateDeviationPct === 'number' && Number.isFinite(l.rateDeviationPct));
  const anyFx = usable.some((l) => l.fx);
  const okTol = anyFx ? (opts.fxTolerancePct ?? DEFAULT_FX_TOLERANCE_PCT) : HEALTH_OK_PCT_SAME_CURRENCY;

  const byKey = new Map<string, HealthLineInput[]>();
  for (const l of usable) {
    const key = [l.destCountry?.toUpperCase() ?? '', l.zone ?? '', l.service?.trim() ?? ''].join('|');
    const list = byKey.get(key);
    if (list) list.push(l);
    else byKey.set(key, [l]);
  }

  const unknownService = opts.mixedServices === true && serviceClassWords(opts.tariffService).length === 0;
  const groups: HealthGroup[] = [];
  for (const [key, ls] of byKey) {
    const devs = ls.map((l) => l.rateDeviationPct!);
    const med = round2(median(devs));
    const min = round2(Math.min(...devs));
    const max = round2(Math.max(...devs));
    const status: HealthStatus = med < -okTol ? 'cheaper' : med > okTol ? 'pricier' : 'ok';
    const first = ls[0]!;
    const country = first.destCountry ? first.destCountry.toUpperCase() : null;
    const cur = round2(median(ls.map((l) => l.adjustmentPct ?? 0)));
    const suspect = Math.abs(med) > HEALTH_SUSPECT_PCT;
    const weak = ls.length < HEALTH_MIN_LINES || max - min > HEALTH_MAX_SPREAD;
    const name = country ? countryName(country, locale) : t(locale, 'health.unknownCountry');
    const head = t(locale, 'health.head', { name, count: fmtNumber(ls.length, 0, locale) });
    const msgParams = { head, carrier, pct: pctText(med, locale) };
    const otherService = status !== 'ok' && serviceMismatch(first.service, opts.tariffService);
    const messageKey: MessageKey =
      status === 'ok' ? 'health.ok' : suspect ? (med < 0 ? 'health.suspect.lower' : 'health.suspect.higher') : status === 'cheaper' ? 'health.cheaper' : 'health.pricier';
    const noSuggestion = status !== 'ok' && !otherService && unknownService;
    const message = otherService
      ? t(locale, 'health.serviceMismatch', { head, service: first.service!.trim(), tariff: opts.tariffService!.trim() })
      : noSuggestion
        ? t(locale, 'health.serviceUnknown', { head })
        : t(locale, messageKey, msgParams);
    groups.push({
      key,
      country,
      countryName: name,
      zone: first.zone ?? null,
      service: first.service?.trim() || null,
      lines: ls.length,
      medianDeviationPct: med,
      minDeviationPct: min,
      maxDeviationPct: max,
      status,
      suggestedAdjustmentPct: status === 'ok' || suspect || otherService || noSuggestion || !country ? null : combineAdjustment(cur, med),
      currentAdjustmentPct: cur,
      weak,
      suspect,
      serviceMismatch: otherService,
      message,
    });
  }
  const trName = (g: HealthGroup) => (g.country ? countryNameTr(g.country) : t('tr', 'health.unknownCountry'));
  // önce sorunlu gruplar (büyük sapma önce), sonra uyumlular (çok satırlı önce)
  groups.sort((a, b) => {
    const ra = a.status === 'ok' ? 1 : 0;
    const rb = b.status === 'ok' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    if (!ra) return Math.abs(b.medianDeviationPct) - Math.abs(a.medianDeviationPct) || b.lines - a.lines;
    // eşitlikte Türkçe ada göre: grup sırası dile göre değişmez
    return b.lines - a.lines || trName(a).localeCompare(trName(b), 'tr');
  });

  // Genel not: satırların çoğu aynı küçük yüzdeyle sapıyorsa ülke istisnası değil, genel bir neden (kur kaynağı, yakıt/indirim)
  let overallNote: string | null = null;
  let overallMedianPct: number | null = null;
  if (usable.length) {
    const all = usable.map((l) => l.rateDeviationPct!);
    const m = median(all);
    overallMedianPct = round2(m);
    const near = all.filter((d) => Math.abs(d - m) <= 1).length;
    if (usable.length >= 5 && near / usable.length >= 0.7 && Math.abs(m) >= 0.3 && Math.abs(m) <= 3) {
      const pct = fmtSignedPct(m, locale);
      overallNote = anyFx
        ? t(locale, m > 0 ? 'health.overall.fx.higher' : 'health.overall.fx.lower', { pct, carrier }) + (Math.abs(m) <= okTol ? t(locale, 'health.overall.fxCovered', { pct: fmtPct(okTol, locale) }) : '')
        : t(locale, m > 0 ? 'health.overall.same.higher' : 'health.overall.same.lower', { pct });
    }
  }

  // Yakıt: tarifedeki oran eskiyse (taşıyıcı yayımladığı oranı değiştirir) tüm satırlarda küçük "Fiyat farkı" çıkar
  let fuelNote: string | null = null;
  const fuels = lines.map((l) => l.fuelPct).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const invoiceFuelPct = fuels.length >= HEALTH_FUEL_MIN_LINES ? round2(median(fuels)) : null;
  if (invoiceFuelPct != null && opts.tariffFuelPct != null && Math.abs(invoiceFuelPct - opts.tariffFuelPct) >= HEALTH_FUEL_MIN_GAP) {
    fuelNote = t(locale, opts.tariffFuelVariable ? 'health.fuel.variable' : invoiceFuelPct > opts.tariffFuelPct ? 'health.fuel.higher' : 'health.fuel.lower', {
      invoice: fmtPct(invoiceFuelPct, locale),
      tariff: fmtPct(opts.tariffFuelPct, locale),
    });
  }

  return {
    fuelNote,
    invoiceFuelPct,
    checkedLines: usable.length,
    okLines: groups.filter((x) => x.status === 'ok').reduce((s, x) => s + x.lines, 0),
    skippedLines: lines.length - usable.length,
    okTolerancePct: okTol,
    groups,
    overallNote,
    overallMedianPct,
  };
}
