import { dateShort, EMPTY } from '@sellerondata/format';
import { en } from './messages.en';
import { tr, type MessageKey } from './messages.tr';

export type { MessageKey } from './messages.tr';

/**
 * Çekirdeğin küçük çeviri katmanı (i18next'e bağımlı değil). Küresel durum yok: etkin dil her çağrıda parametre olarak
 * gelir, varsayılan `tr` (çekirdeğin kanonik dili; çağıran dili verir). Bu yüzden sunucuda eşzamanlı istekler birbirini etkilemez. Ağır bağımlılığı yoktur; mobil
 * `@deciship/core/i18n` olarak içe aktarır.
 */
export type Locale = 'tr' | 'en';
export const DEFAULT_LOCALE: Locale = 'tr';
export const LOCALES: readonly Locale[] = ['tr', 'en'];

export const messages: Record<Locale, Record<MessageKey, string>> = { tr, en };

/**
 * Dil kodunu ya da `Accept-Language` başlığını desteklenen dile indirir; kalite değerine bakar ("tr;q=0.1,en;q=0.9" → en).
 * contracts `localeFromAcceptLanguage` ile aynı davranış. Desteklenen yoksa en: "dil bilgisi yok" son çaresi İngilizce
 * (kullanıcı kararı 2026-11-12; contracts `DEFAULT_LOCALE`). `DEFAULT_LOCALE` burada yalnız işlev parametrelerinin varsayılanıdır.
 */
export const FALLBACK_LOCALE: Locale = 'en';

export function normalizeLocale(v: unknown): Locale {
  if (typeof v !== 'string' || !v) return FALLBACK_LOCALE;
  const ranked = v
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { lang: tag.trim().replace(/_/g, '-').toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { lang } of ranked) if (lang === 'tr' || lang === 'en') return lang;
  return FALLBACK_LOCALE;
}

/** `Intl` için dil etiketi. */
export function intlLocale(locale: Locale = DEFAULT_LOCALE): 'tr-TR' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'tr-TR';
}

export type MessageParams = Record<string, string | number>;

/** `{ad}` değer koyar; `{ad|tekil|çoğul}` değer bir ise tekili, değilse çoğulu yazar (binlik ayırıcılı sayı da olur). */
const PLACEHOLDER = /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g;

const isOne = (v: string | number) => Number(String(v).replace(/[.,\s]/g, '')) === 1;

export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = (messages[locale] ?? tr)[key] ?? tr[key];
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name: string, one?: string, other?: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return one === undefined ? String(v) : isOne(v) ? one : (other ?? '');
  });
}

// ---------------------------------------------------------------------------------------------
// Kanonik Türkçe metinleri geri eşleme

/**
 * Geri eşlenen anahtarlar: verinin içinde Türkçe saklanan metinler (satır notu, döküm etiketi, güven gerekçesi, okuma
 * sebebi, PDF notu). Bu metinler veritabanında ve eski kayıtlarda Türkçedir, üstelik `isPakNote` ve API'deki önek
 * kontrolleri onlara bakar; bu yüzden yazarken değil gösterirken çevrilir.
 */
const STORED_PREFIXES = ['tariff.', 'fx.sourceFor', 'compare.', 'import.reason.', 'read.', 'parse.', 'stored.'];

type Matcher = { key: MessageKey; re: RegExp; names: string[] };
let matchers: Matcher[] | null = null;

function storedMatchers(): Matcher[] {
  if (matchers) return matchers;
  const out: (Matcher & { literal: number })[] = [];
  for (const key of Object.keys(tr) as MessageKey[]) {
    if (!STORED_PREFIXES.some((p) => key.startsWith(p))) continue;
    const template = tr[key];
    const names: string[] = [];
    const source = template
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[1]!);
        return '(.*?)';
      })
      .join('');
    out.push({ key, names, re: new RegExp(`^${source}$`, 's'), literal: template.replace(/\{\w+\}/g, '').length });
  }
  // uzun sabit metin önce: "Pak/zarf … ; koli …" kısa olandan önce denenir
  matchers = out.sort((a, b) => b.literal - a.literal);
  return matchers;
}

const swapSeparators = (n: string) => n.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'));

/** "27.10.2026" → "27 Oct 2026": `fmtDate(…, 'en')` ile aynı yazım (Y102). Okunamayan gün olduğu gibi kalır. */
function enDay(m: string, d: string, mo: string, y: string): string {
  const out = dateShort(`${y}-${mo}-${d}`, 'en');
  return out === EMPTY ? m : out;
}

/**
 * Metne gömülmüş Türkçe biçimli değerler → İngilizce: tarih panelle aynı ("27 Oct 2026"), para, yüzde ve sayı en-US.
 * Rakamlar yeniden yuvarlanmaz.
 */
function localizeValues(s: string): string {
  const NUM = '\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+,\\d+|\\d+';
  return s
    .replace(/(?<![\d.])(\d{2})\.(\d{2})\.(\d{4})(?![\d.])/g, enDay)
    .replace(new RegExp(`(?<![\\d.,])(-?)(${NUM}) (₺|€|\\$|£|[A-Z]{3})(?![A-Za-z])`, 'g'), (_m, sign: string, n: string, cur: string) =>
      /^[A-Z]{3}$/.test(cur) ? `${sign}${cur} ${swapSeparators(n)}` : `${sign}${cur}${swapSeparators(n)}`,
    )
    .replace(/%(-?\d+(?:,\d+)?)/g, (_m, n: string) => `${n.replace(',', '.')}%`)
    .replace(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+)(?![\d.,])/g, (n) => swapSeparators(n));
}

/**
 * Kimlik ya da dosyadan olduğu gibi alınmış metin taşıyan yer tutucular: çevrilmez, sayı biçimi de değiştirilmez
 * ("123.456" numaralı fatura İngilizcede "123,456" olmaz). Saklanan anahtarlardaki adlar: `invoice` (fatura no),
 * `invoiceNo`, `trackingNo`, `value` (okunamayan ham hücre), `name` (tarife / ek ücret adı), `header` (sütun başlığı).
 */
const VERBATIM_PARAMS: ReadonlySet<string> = new Set(['invoice', 'invoiceNo', 'trackingNo', 'value', 'name', 'header']);

function localizePart(part: string, locale: Locale): string | null {
  for (const m of storedMatchers()) {
    const hit = m.re.exec(part);
    if (!hit) continue;
    const params: MessageParams = {};
    m.names.forEach((name, i) => {
      const raw = hit[i + 1] ?? '';
      params[name] = VERBATIM_PARAMS.has(name) ? raw : (localizePart(raw, locale) ?? localizeValues(raw));
    });
    return t(locale, m.key, params);
  }
  return null;
}

const localizedCache = new Map<string, string>();

/**
 * Çekirdeğin Türkçe ürettiği (ve çoğu zaman veritabanından gelen) metni istenen dile çevirir. " · " ile birleştirilmiş
 * notlar parça parça çevrilir; tanınmayan parça (kullanıcının yazdığı not, ek ücret adı) olduğu gibi kalır.
 * `tr` için metne dokunmaz. Hesaba girmez: yalnız gösterim.
 */
export function localizeText(text: string, locale?: Locale): string;
export function localizeText(text: string | null | undefined, locale?: Locale): string | null | undefined;
export function localizeText(text: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string | null | undefined {
  if (!text || locale === 'tr') return text;
  const key = `${locale}\u0000${text}`;
  const cached = localizedCache.get(key);
  if (cached !== undefined) return cached;
  const out = text.split(' · ').map((p) => localizePart(p, locale) ?? p).join(' · ');
  if (localizedCache.size >= 5000) localizedCache.clear();
  localizedCache.set(key, out);
  return out;
}
