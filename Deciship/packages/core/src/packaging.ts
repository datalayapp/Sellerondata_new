// Ambalaj modülü (mobil de kullanır: `@deciship/core/packaging`). Yalnız çeviri katmanı ve türler içe aktarılır.
import type { Dims } from './calc';
import { DEFAULT_LOCALE, t, type Locale } from './i18n/index';
import type { CarrierCode } from './invoice/types';

/**
 * Gönderinin ambalajı, bütün taşıyıcılar için: `OWN` kendi ambalajımız (koli, poşet; desi uygulanır), `PAK` taşıyıcının
 * poşeti (FedEx Pak, UPS Express Pak, DHL Flyer…), `ENVELOPE` taşıyıcının zarfı (FedEx/UPS/DHL Envelope; Türk
 * taşıyıcılarda dosya/evrak). Ölçüm ambalajı yoksa `OWN`; fatura satırında bilinmiyorsa alan yoktur.
 */
export type Packaging = 'OWN' | 'PAK' | 'ENVELOPE';
export const PACKAGINGS: readonly Packaging[] = ['OWN', 'PAK', 'ENVELOPE'];

/**
 * Bir taşıyıcının özel ambalaj sınırları. `null`/yok = o ambalajın sınırı bilinmiyor (sığdığı doğrulanamaz). Pak:
 * gerçek ağırlık ve (varsa) hacim sınırı; sınır içindeki Pak'ta ücretli kg gerçek kg'dır (desi yok). Zarf: ağırlık ve
 * (varsa) kenar sınırı `maxEdgesCm` (cm, büyükten küçüğe; ölçüler sıralanıp kenar kenar karşılaştırılır); aşarsa Pak gibi,
 * Pak sınırını da aşarsa kendi ambalajı gibi fiyatlanır.
 */
export type PackagingLimits = {
  PAK?: { maxKg: number; maxVolumeCm3?: number | null } | null;
  ENVELOPE?: { maxKg: number; maxEdgesCm?: [number, number, number] | null } | null;
};

/**
 * Taşıyıcı kodunun varsayılan sınırları (firma, taşıyıcı ayarında geçersiz kılabilir: `packagingLimitsFor`). Listede
 * olmayan taşıyıcıda (Aras, Yurtiçi, MNG, PTT, diğer) sınır bilinmez; `null` = bilinmiyor.
 */
export const DEFAULT_PACKAGING_LIMITS: Readonly<Partial<Record<CarrierCode, Readonly<PackagingLimits>>>> = Object.freeze({
  // FedEx: Pak en çok 2,5 kg ve 15.400 cm³ (940 in³); Zarf en çok 0,5 kg, 31,7×24,1 cm (9,5"×12,5"; kalınlık 2 cm varsayım)
  fedex: Object.freeze({
    PAK: Object.freeze({ maxKg: 2.5, maxVolumeCm3: 15400 }),
    ENVELOPE: Object.freeze({ maxKg: 0.5, maxEdgesCm: Object.freeze([31.7, 24.1, 2]) as unknown as [number, number, number] }),
  }),
  // UPS: Express Envelope en çok 0,5 kg, 40,6×31,7 cm (kalınlık 2 cm varsayım); Express Pak sınırı resmi kaynakta
  // bulunamadı (sahip panelden girer)
  ups: Object.freeze({ PAK: null, ENVELOPE: Object.freeze({ maxKg: 0.5, maxEdgesCm: Object.freeze([40.6, 31.7, 2]) as unknown as [number, number, number] }) }),
  // DHL: Express Envelope en çok 0,3 kg, 35×27,5×1 cm; Flyer sınırı resmi kaynakta yok (sahip panelden girer)
  dhl: Object.freeze({ PAK: null, ENVELOPE: Object.freeze({ maxKg: 0.3, maxEdgesCm: Object.freeze([35, 27.5, 1]) as unknown as [number, number, number] }) }),
});

/** Geçerli bir sınır mı (pozitif, sonlu kg; hacim verildiyse pozitif, sonlu). */
function validPak(v: PackagingLimits['PAK']): PackagingLimits['PAK'] {
  if (!v || !(Number.isFinite(v.maxKg) && v.maxKg > 0)) return null;
  const vol = v.maxVolumeCm3 != null && Number.isFinite(v.maxVolumeCm3) && v.maxVolumeCm3 > 0 ? v.maxVolumeCm3 : null;
  return { maxKg: v.maxKg, maxVolumeCm3: vol };
}
/** Zarf: kg geçersizse sınır bilinmiyor; kenarlar üç pozitif sonlu sayı değilse kenar sınırı bilinmiyor (büyükten küçüğe sıralanır). */
function validEnvelope(v: PackagingLimits['ENVELOPE']): PackagingLimits['ENVELOPE'] {
  if (!v || !(Number.isFinite(v.maxKg) && v.maxKg > 0)) return null;
  const e = v.maxEdgesCm;
  const edges =
    Array.isArray(e) && e.length === 3 && e.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
      ? ([...e].sort((a, b) => b - a) as [number, number, number])
      : null;
  return { maxKg: v.maxKg, maxEdgesCm: edges };
}

/**
 * Taşıyıcının etkin sınırları: ambalaj başına geçersiz kılma (firma ayarı; anahtar varsa, `null` dahil) > taşıyıcı kodunun
 * varsayılanı > bilinmiyor. Geçersiz sayılar bilinmiyor sayılır.
 */
export function packagingLimitsFor(carrier: CarrierCode | null | undefined, override?: PackagingLimits | null): PackagingLimits {
  const base = (carrier ? DEFAULT_PACKAGING_LIMITS[carrier] : undefined) ?? {};
  const o = override ?? {};
  return {
    PAK: validPak('PAK' in o ? o.PAK : base.PAK),
    ENVELOPE: validEnvelope('ENVELOPE' in o ? o.ENVELOPE : base.ENVELOPE),
  };
}

/**
 * Sığma sonucu: `ok` true = sınır içinde, false = aşıyor (`reasons`), null = bu ambalajın sınırı bilinmiyor (aşan bilinen
 * bir sınır da yoksa). OWN her zaman true.
 */
export type PackagingFitReason = 'WEIGHT' | 'VOLUME' | 'DIMENSION';
/** `DIMENSION`: zarfın kenar sınırını (`maxEdgesCm`) aşan kenar var. */
export type PackagingFit = { ok: boolean | null; reasons: PackagingFitReason[] };

/** Gram tamsayısı (kayan nokta gürültüsü sınırda "aşıyor" demesin). */
const grams = (kg: number) => Math.round(kg * 1000);

/** Ölçülerin hacmi (cm³), ham kenarlarla (yuvarlamasız), 3 ondalık. */
export function volumeCm3(d: Dims): number {
  return Math.round(d.l * d.w * d.h * 1000) / 1000;
}

/** Ölçünün kenarları (büyükten küçüğe) sınırın kenarlarını (büyükten küçüğe) aşıyor mu; 0,1 mm'ye yuvarlanarak. */
function edgesOver(d: Dims, max: [number, number, number]): boolean {
  const e = [d.l, d.w, d.h].sort((a, b) => b - a);
  const mm = (x: number) => Math.round(x * 100);
  return e.some((x, i) => mm(x) > mm(max[i]!));
}

/**
 * Seçilen özel ambalaja sığıyor mu; neden sığmadığı. OWN her zaman ok. `limits` taşıyıcının etkin sınırları
 * (`packagingLimitsFor`); verilmez ya da o ambalajın sınırı yoksa `ok: null`. Pak: ağırlık ve (sınırı varsa) hacim
 * (`VOLUME`); Zarf: ağırlık ve (kenar sınırı varsa) kenarlar (`DIMENSION`). `dims` null → hacim/kenar denetlenmez.
 */
export function packagingFit(p: Packaging, actualKg: number, dims: Dims | null, limits: PackagingLimits | null | undefined): PackagingFit {
  if (p === 'OWN') return { ok: true, reasons: [] };
  const reasons: PackagingFitReason[] = [];
  const weightOver = (maxKg: number) => !Number.isFinite(actualKg) || grams(actualKg) > grams(maxKg);
  if (p === 'PAK') {
    const limit = validPak(limits?.PAK);
    if (!limit) return { ok: null, reasons: [] };
    if (weightOver(limit.maxKg)) reasons.push('WEIGHT');
    if (limit.maxVolumeCm3 != null && dims && volumeCm3(dims) > limit.maxVolumeCm3) reasons.push('VOLUME');
  } else {
    const limit = validEnvelope(limits?.ENVELOPE);
    if (!limit) return { ok: null, reasons: [] };
    if (weightOver(limit.maxKg)) reasons.push('WEIGHT');
    if (limit.maxEdgesCm && dims && edgesOver(dims, limit.maxEdgesCm)) reasons.push('DIMENSION');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Kendi ambalajındaki paket hangi özel ambalaja sığardı (en ucuz: önce ENVELOPE, sonra PAK); hiçbiri → null. Sınırı
 * bilinmeyen ambalaj önerilmez; zarf yalnız kenar sınırı biliniyor, ölçü var ve sığıyorsa önerilir. Mobil uyarısı için.
 */
export function suggestPackaging(actualKg: number, dims: Dims | null, limits: PackagingLimits | null | undefined): Exclude<Packaging, 'OWN'> | null {
  const envelopeEdges = validEnvelope(limits?.ENVELOPE)?.maxEdgesCm;
  if (envelopeEdges && dims && packagingFit('ENVELOPE', actualKg, dims, limits).ok === true) return 'ENVELOPE';
  if (packagingFit('PAK', actualKg, dims, limits).ok === true) return 'PAK';
  return null;
}

/**
 * Seçilen ambalajdan başlayıp fiyatın uygulanacağı ambalaja kadar sıra: Zarf → Pak → kendi ambalajı. Zarf sınırını aşarsa
 * Pak gibi, Pak sınırını aşarsa kendi ambalajı gibi fiyatlanır.
 */
export function packagingChain(p: Packaging): Packaging[] {
  return p === 'ENVELOPE' ? ['ENVELOPE', 'PAK', 'OWN'] : p === 'PAK' ? ['PAK', 'OWN'] : ['OWN'];
}

/**
 * Seçilen ambalajın ölçüme göre fiyatlanacağı ambalaj (`packagingChain` içinde aşılmayan ilk; sınırı bilinmeyen ambalaj
 * aşılmamış sayılır). `allowed` verilirse yalnız onun kabul ettiği ambalajlar (ör. tarifede fiyatı olanlar) seçilir; OWN
 * her zaman kabul.
 */
export function pricedPackaging(p: Packaging, actualKg: number, dims: Dims | null, limits: PackagingLimits | null | undefined, allowed?: (p: Packaging) => boolean): Packaging {
  for (const c of packagingChain(p)) {
    if (c === 'OWN') return 'OWN';
    if (packagingFit(c, actualKg, dims, limits).ok !== false && (!allowed || allowed(c))) return c;
  }
  return 'OWN';
}

/** Ambalajın ucuzluk sırası: Zarf 0, Pak 1, kendi ambalajı 2. */
export function packagingRank(p: Packaging): number {
  return p === 'ENVELOPE' ? 0 : p === 'PAK' ? 1 : 2;
}

/** Ambalaj adında adı geçen taşıyıcılar; diğerleri genel ad ("Kargo poşeti"). */
const NAMED_CARRIERS: ReadonlySet<CarrierCode> = new Set<CarrierCode>(['fedex', 'ups', 'dhl']);

/**
 * Ambalajın taşıyıcıya göre adı: FedEx Pak / FedEx Zarf, UPS Express Pak / UPS Express Zarf, DHL Flyer / DHL Zarf; diğer
 * ya da bilinmeyen taşıyıcıda "Kargo poşeti" / "Kargo zarfı"; OWN "Kendi ambalajı".
 */
export function packagingLabel(carrier: CarrierCode | null | undefined, p: Packaging, locale: Locale = DEFAULT_LOCALE): string {
  if (p === 'OWN') return t(locale, 'packaging.OWN');
  const c = carrier && NAMED_CARRIERS.has(carrier) ? (carrier as 'fedex' | 'ups' | 'dhl') : 'other';
  return t(locale, `packaging.${c}.${p}`);
}

const fold = (s: string) =>
  s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_\-/.,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Açıkça kendi ambalajı (özel ambalaj sözcüklerinden önce denenir). */
const OWN_TEXT = /(^| )(your packaging|customer packaging|customer supplied( package| packaging)?|own packaging|kendi ambalaj\w*|musteri ambalaj\w*|fedex box)( |$)/;
/**
 * Zarf sözcükleri. Hizmet adında "Document(s)"/"Doc" ürün türüdür (belge tarifesi), ambalaj değildir: yalnız ambalaj
 * sütununda (`parsePackaging`) zarf sayılır, hizmet adından (`servicePackaging`) sayılmaz.
 */
const ENVELOPE_WORDS = '(envelope|letter|zarf|zarfi|dosya|evrak|mektup)';
const ENVELOPE_COLUMN_WORDS = '(envelope|letter|document|documents|zarf|zarfi|dosya|evrak|mektup)';
const PAK_WORDS = '(pak|flyer|poset|poseti)';
const ENVELOPE_TEXT = new RegExp(`(^| )${ENVELOPE_COLUMN_WORDS}( |$)`);
const PAK_TEXT = new RegExp(`(^| )${PAK_WORDS}( |$)`);
/** Olumsuzlama: "Non-Documents", "Non Document", "NONDOC", "Non-Envelope" (DHL koli ürünü): özel ambalaj değil. */
const NEGATED = /(^| )non ?(doc\w*|dox|envelope\w*|letter\w*|pak)( |$)/;
/** Kutu/koli adı geçen ambalaj ("Doc Box", "Document Box"): zarf ya da poşet sözcüğü olsa da kendi ambalajı. */
const BOX_TEXT = /(^| )(box|kutu|koli)( |$)/;
/** Ambalaj sütununda kendi ambalajı anlamına gelen genel sözcükler (özel ambalaj sözcükleri yoksa). */
const OWN_GENERIC = /(^| )(package|parcel|box|koli|paket|kutu|own)( |$)/;

/**
 * Sayısal ambalaj kodları. FedEx "Service Packaging"/"Paketleme": 01→OWN, 02→PAK, 03→OWN (FedEx Box, kutu tarifesi),
 * 06→ENVELOPE. UPS (PackagingType): 01→ENVELOPE (UPS Letter), 02→OWN (Customer Supplied Package), 04→PAK.
 */
const NUMERIC_CODES: Record<'fedex' | 'ups', Record<number, Packaging>> = {
  fedex: { 1: 'OWN', 2: 'PAK', 3: 'OWN', 6: 'ENVELOPE' },
  ups: { 1: 'ENVELOPE', 2: 'OWN', 4: 'PAK' },
};

/**
 * Faturadaki ambalaj kodu/adı → Packaging. Yalnız sayı olan değer `codes` taşıyıcısının tablosuyla okunur (yoksa
 * undefined: DHL, Aras… kodlarının anlamı bilinmez); metin
 * bütün taşıyıcılar için: "Pak"/"Flyer" → PAK; "Envelope"/"Letter"/"Document"/"Zarf"/"Dosya"/"Evrak" → ENVELOPE;
 * "Your Packaging"/"Customer Supplied Package"/"Package"/"Koli", olumsuzlama ("Non-Documents", "NONDOC") ve kutu adı
 * ("Doc Box") → OWN. Tanınmazsa undefined.
 */
export function parsePackaging(raw: string | null | undefined, codes?: 'fedex' | 'ups' | null): Packaging | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    // Yalnız sayı: kod tablosu bilinen taşıyıcıda (FedEx, UPS) okunur; diğerlerinde anlamı bilinmez
    const code = /^0*(\d{1,2})$/.exec(s);
    return codes && code ? NUMERIC_CODES[codes][Number(code[1])] : undefined;
  }
  const f = fold(s);
  if (OWN_TEXT.test(f) || NEGATED.test(f) || BOX_TEXT.test(f)) return 'OWN';
  if (ENVELOPE_TEXT.test(f)) return 'ENVELOPE';
  if (PAK_TEXT.test(f)) return 'PAK';
  if (OWN_GENERIC.test(f)) return 'OWN';
  return undefined;
}

const SERVICE_ENVELOPE = new RegExp(`(^|[^\\p{L}])${ENVELOPE_WORDS}([^\\p{L}]|$)`, 'iu');
const SERVICE_PAK = new RegExp(`(^|[^\\p{L}])${PAK_WORDS}([^\\p{L}]|$)`, 'iu');

/**
 * Hizmet adından ambalaj ("FedEx Intl Priority Pak", "DHL Express Flyer" → PAK; "FedEx Envelope", "UPS Express Letter",
 * "Dosya" → ENVELOPE). Yalnız özel ambalajı tanır; hizmet adı kendi ambalajını söylemez (undefined). "Documents" / "Doc"
 * ürün türüdür, ambalaj sayılmaz; "Non-Documents", "Doc Box" gibi adlar da undefined.
 */
export function servicePackaging(service: string | null | undefined): Exclude<Packaging, 'OWN'> | undefined {
  if (!service) return undefined;
  const f = fold(service);
  if (NEGATED.test(f) || BOX_TEXT.test(f)) return undefined;
  if (SERVICE_ENVELOPE.test(f)) return 'ENVELOPE';
  if (SERVICE_PAK.test(f)) return 'PAK';
  return undefined;
}
