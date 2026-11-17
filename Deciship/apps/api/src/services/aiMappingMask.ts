/**
 * Yapay zekâ ile sütun eşlemede kişisel veri maskesi (kullanıcı kararı 2026-11-12; denetim 18-B1, 05-B8).
 *
 * Sağlayıcıya giden örnek hücrelerden kişisel veri olabilecekler BİÇİMİ korunarak gönderilir: büyük harf `A`, küçük harf `a`
 * (Türkçe ve diğer dillerin harfleri dahil), rakam `9`; boşluk, noktalama ve uzunluk aynen. Eşleme için biçim yeter
 * (takip no "AA999999999999", telefon "+99 999 999 99 99"), içerik gerekmez. Başlıklar hiç maskelenmez.
 *
 * Karar iki adımlıdır, önce başlık sonra değer:
 * 1. Başlık sınıfı (`headerPrivacy`), sırayla:
 *    - `personal`: adres, telefon, e-posta, posta kodu (PK, CAP, CP, NPA dahil), şehir/ilçe, kimlik no, doğum, imza, ilgili
 *      kişi sözcüğü geçiyorsa; ad sözcüğü (name, ad, isim, soyad, unvan, kişi, person, rep…) geçiyorsa (hiçbir güvenli sözcük
 *      bunu ezmez: "Charge To Name", "Customer Service Rep" kişisel); taraf sözcüğü (alıcı, alan, gönderici, recipient,
 *      consignee, Empfänger, müşteri…) geçiyor ve başlık ülke ya da tarih anlamı taşımıyorsa ("Recipient Country" güvenli,
 *      "Ürün / Alıcı", "Hizmet Alan" kişisel).
 *    - `safeText`: ülke, hizmet/ürün, ücret etiketi (charge, ücret, Gebühr, Zuschlag), para birimi, birim, tarih sözcüğü
 *      geçiyorsa. Bu sütunların metni (ülke adı, hizmet adı, ücret etiketi) eşlemede kanıttır ve kişisel değildir. Kısa
 *      güvenli sözcükler (land, date, unit, fee…) yalnız tam sözcük olarak sayılır ("Landline" ülke değildir).
 *    - `neutral`: hiçbiri değil (takip no, fatura no, tutar, ağırlık, ölçü, referans, açıklama…).
 * 2. Hücre (`shouldMaskSample`), sırayla:
 *    a. `personal` sütunda her dolu hücre maskelenir (sayı gibi görünse bile: "34710" posta kodu, "5321234567" telefon).
 *    b. Değer e-posta (`@`) ya da telefon biçimliyse (yalnız rakam, boşluk, `+ ( ) . / -`; 10-13 hane) her sütunda maskelenir.
 *    c. Değer sayı (tutar, ağırlık, ölçü; binlik ve ondalık ayırıcı, işaret, para birimi ya da birim eki), sayısal tarih/saat,
 *       "40x30x25" ölçü ya da kısa kod (tamamı büyük harf: TRY, TR, KG; birim: kg, cm, lb) ise korunur. 7 ve daha uzun
 *       ayırıcısız rakam dizisi sayı sayılmaz (takip no, hesap no, telefon, vergi no olabilir: maskelenir); yalnız yyyymmdd
 *       tarihi olan 8 hane korunur. Boşlukla gruplanmış, ondalıksız ve eksiz rakam dizisi ("612 345 678", "5 321 234") da
 *       sayı sayılmaz (telefon ya da hesap no olabilir).
 *    d. `safeText` sütunda metin yalnız değerin kendisi de güvenliyse korunur (Y45, 18-B1: "Hizmet" ya da "Ülke" başlıklı
 *       sütuna yazılmış kişi adı açık gitmesin): ülke adı ya da kodu, para birimi adı, bilinen ek ücret adı, ya da hizmet,
 *       ücret ve tarih sözlüğünden bir sözcük ("International Priority", "Fuel Surcharge", "Adres Düzeltme", "14-Oct-2026").
 *       Sözlükte ad olarak da kullanılan sözcük yok ("Deniz", "Kara", "Kıymet"). Sözlükte olmayan değer maskelenir.
 *    e. Geri kalan her şey maskelenir (emin değilsen maskele).
 * 3. Başlıkların kendisi (`headerAliases`): başlık satırı yanlış seçilmiş olabilir (başlıksız dosya, yinelenen başlıklar,
 *    birleştirilmiş grup başlığı); o zaman veri satırı "başlık" olur. Bir başlık veri gibi görünüyorsa (sayı, tarih, saat,
 *    ölçü, e-posta, telefon, 7+ rakam ya da rakamla başlayıp harf içeren kimlik: "1Z999AA…", "1Z1") bütün başlık satırı veri
 *    sayılır ve hiçbir başlık gitmez. Satır veri gibi değilse yalnız tek tek kuşkulu başlık (":" sonrası serbest metin,
 *    rakam ağırlıklı) gitmez. Gitmeyen başlığın yerine takma ad ("#3") ve biçim maskesi gider; yanıttaki takma ad gerçek
 *    başlığa çevrilir (`aiMapping.ts` `aiRawToMapping`).
 */

import { parseCountry, parseCurrency, SURCHARGE_SYNONYMS } from '@deciship/core';

export type HeaderPrivacy = 'personal' | 'safeText' | 'neutral';

type Words = { sub: readonly string[]; tok: readonly string[] };

/** Her zaman kişisel: iletişim ve konum ayrıntısı, kimlik, doğum, imza. */
const STRONG: Words = {
  sub: ['adres', 'address', 'anschrift', 'strasse', 'street', 'sokak', 'cadde', 'mahalle', 'telefon', 'phone', 'gsm', 'mobil', 'movil', 'handy', 'tfno', 'rufnummer', 'celular', 'landline', 'mail', 'eposta', 'postakod', 'postcode', 'postalcode', 'postleitzahl', 'zip', 'codepostal', 'sehir', 'sehri', 'ilce', 'stadt', 'district', 'bezirk', 'kimlik', 'tckn', 'contact', 'kontakt', 'yetkili', 'dogum', 'birth', 'geburt', 'signature', 'imza'],
  tok: ['tel', 'cep', 'cell', 'fax', 'plz', 'pk', 'cap', 'cp', 'npa', 'city', 'ville', 'town', 'ciudad', 'citta', 'il', 'ili', 'ort', 'str', 'attn', 'vkn', 'signed'],
};
/** Ad sözcüğü: hiçbir güvenli sözcük ezmez ("Charge To Name", "Service Name", "Customer Service Rep"). */
const NAME: Words = {
  sub: ['name', 'isim', 'soyad', 'unvan', 'kisi', 'person'],
  tok: ['ad', 'adi', 'nom', 'nome', 'nombre', 'firma', 'rep'],
};
/** Taraf sözcüğü: yalnız ülke ya da tarih anlamıyla birlikte güvenli ("Recipient Country"), değilse kişisel. */
const PARTY: Words = {
  sub: ['alici', 'recipient', 'receiver', 'consignee', 'sender', 'shipper', 'gonderen', 'gonderici', 'empfanger', 'absender', 'destinatar', 'expediteur', 'remitente', 'musteri', 'customer', 'kunde'],
  tok: ['alan'],
};
/** Taraf sözcüğünü güvenli yapan anlamlar: ülke ve tarih. Kısa sözcükler yalnız tam sözcük. */
const COUNTRY_DATE: Words = {
  sub: ['country', 'ulke', 'zielland', 'empfangerland', 'herkunftsland', 'lieferland', 'bestimmungsland', 'versandland', 'paese', 'tarih', 'datum', 'fecha'],
  tok: ['land', 'pays', 'pais', 'iso', 'date', 'data'],
};
/** Metni kişisel olmayan ve eşlemede kanıt olan alanlar. Kısa sözcükler yalnız tam sözcük ("Landline" değil). */
const SAFE_TEXT: Words = {
  sub: [...COUNTRY_DATE.sub, 'service', 'servis', 'hizmet', 'produkt', 'product', 'leistung', 'charge', 'ucret', 'gebuhr', 'zuschlag', 'surcharge', 'frais', 'currency', 'doviz', 'parabirim', 'wahrung', 'devise', 'moneda', 'valuta', 'birim', 'einheit'],
  tok: [...COUNTRY_DATE.tok, 'urun', 'unit', 'fee'],
};

/** Küçük harf, aksansız ("Empfängerland" → "empfangerland", "Alıcı Adı" → "alici adi"); CamelCase sözcüklere ayrılır. */
function words(header: string): { tokens: string[]; compact: string } {
  const folded = header
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/[\u0131\u0130]/g, 'i') // noktasiz i ve noktali buyuk I (Turkce)
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return { tokens, compact: tokens.join('') };
}

const hits = (w: { tokens: string[]; compact: string }, list: Words) => list.sub.some((s) => w.compact.includes(s)) || list.tok.some((t) => w.tokens.includes(t));

export function headerPrivacy(header: string): HeaderPrivacy {
  const w = words(header);
  if (hits(w, STRONG) || hits(w, NAME)) return 'personal';
  if (hits(w, PARTY)) return hits(w, COUNTRY_DATE) ? 'safeText' : 'personal';
  return hits(w, SAFE_TEXT) ? 'safeText' : 'neutral';
}

/** Biçimi koruyan maske: büyük harf `A`, diğer harfler `a`, rakam `9`; geri kalan karakterler ve uzunluk aynen. */
export function maskShape(v: string): string {
  return v
    .normalize('NFC')
    .replace(/\p{M}/gu, '')
    .replace(/\p{L}|\p{N}/gu, (c) => (/\p{N}/u.test(c) ? '9' : /\p{Lu}/u.test(c) ? 'A' : 'a'));
}

const EMAIL = /@/;
const PHONE_CHARS = /^[\d\s+()./-]+$/;
const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const DIMS = /^\d+(?:[.,]\d+)?\s*[x×X*]\s*\d+(?:[.,]\d+)?\s*[x×X*]\s*\d+(?:[.,]\d+)?(?:\s*(?:cm|in|mm))?$/i;
/** Kısa kod yalnız tamamı büyük harf ("Ali", "Can" ad olabilir); birimler büyük/küçük harf fark etmez. */
const CODE = /^(?:[A-Z]{2,3}|(?:kgs?|lbs?|cm|in|mm|desi))$/;
const UNIT_CODE = /^(?:kgs?|lbs?|cm|in|mm|desi)$/i;
/** Boşlukla gruplanmış ondalıksız rakam dizisi ("612 345 678", "5 321 234"): telefon ya da hesap no olabilir. */
const SPACE_GROUPED = /^\d{1,4}(?:[ \u00A0]\d{1,4})+$/;
/** Sayının önünde ya da arkasında olabilecek para birimi; bilinen kodlarla sınırlı ("12 SOK" gibi adres parçası sayı sayılmasın). */
const CUR = String.raw`[€$£₺]|TRY|TL|EUR|USD|GBP|CHF|PLN|CZK|HUF|RON|BGN|SEK|NOK|DKK|AED|SAR|CAD|AUD|JPY|CNY`;
const AFFIX_BEFORE = new RegExp(String.raw`^(?:${CUR})\s?`);
const AFFIX_AFTER = new RegExp(String.raw`\s?(?:${CUR}|%)$`);
const UNIT_AFTER = /\s?(?:kgs?|lbs?|cm|in|mm|desi)$/i;
/** İşaretli, binlik ayırıcılı (aynı ayırıcı), ondalıklı sayı; "(23,50)" ve "23,50-" eksi gösterimi. */
const NUMBER = /^[-+]?\(?(?:\d{1,3}(?:([.,' \u00A0])\d{3})(?:\1\d{3})*|\d+)?(?:[.,]\d+)?\)?-?$/;

function digitCount(v: string): number {
  return (v.match(/\d/g) ?? []).length;
}

/** yyyymmdd (19xx/20xx) */
function isCompactDate(v: string): boolean {
  if (!/^(?:19|20)\d{6}$/.test(v)) return false;
  const mo = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

function isNumber(v: string): boolean {
  const core = v.replace(AFFIX_BEFORE, '').replace(AFFIX_AFTER, '').replace(UNIT_AFTER, '').trim();
  if (!/\d/.test(core) || !NUMBER.test(core)) return false;
  // Boşlukla gruplu, ondalıksız ve eksiz (para birimi ya da birim yok) dizi tutar değil, telefon/hesap no olabilir.
  if (core === v.trim() && SPACE_GROUPED.test(core)) return false;
  // Ayırıcısız uzun rakam dizisi tutar değil kimliktir (takip, hesap, telefon, vergi no).
  if (/^\d{7,}$/.test(core) && !isCompactDate(core)) return false;
  return true;
}

/** Değerin kendisi kişisel olamayacak bir biçimde mi (sayı, sayısal tarih/saat, ölçü, kısa kod)? */
function isPlainValue(v: string): boolean {
  return isNumber(v) || DATE.test(v) || TIME.test(v) || DIMS.test(v) || CODE.test(v) || UNIT_CODE.test(v);
}

function looksLikeContact(v: string): boolean {
  if (EMAIL.test(v)) return true;
  if (!PHONE_CHARS.test(v)) return false;
  const n = digitCount(v);
  return n >= 10 && n <= 13;
}

/**
 * Y45: güvenli metin sütununda değerin kendisini güvenli sayan sözlük (hizmet, gönderi türü, ücret etiketi; TR, EN, DE, FR, ES).
 * Sözcükler tam sözcük olarak; 7 harf ve uzunları sözcük içinde de aranır ("Inselzuschlag", "Expressversand"). Kişi adı ya da
 * soyadı olarak da kullanılan sözcükler bilerek yok (deniz, kara, hava, alim, kiymet, ozel, pak, can…).
 */
const SAFE_VALUE_WORDS = new Set([
  // hizmet ve gönderi türü
  'express', 'ekspres', 'expres', 'priority', 'oncelikli', 'economy', 'ekonomi', 'ekonomik', 'standard', 'standart', 'standaard',
  'international', 'intl', 'domestic', 'yurtici', 'yurtdisi', 'ground', 'saver', 'worldwide', 'overnight', 'freight', 'navlun',
  'kargo', 'cargo', 'paket', 'parcel', 'package', 'packet', 'koli', 'dosya', 'document', 'documents', 'docs', 'doc', 'envelope',
  'zarf', 'box', 'next', 'day', 'sameday', 'gun', 'delivery', 'teslim', 'teslimat', 'gonderi', 'shipment', 'shipping', 'air',
  'road', 'ocean', 'import', 'export', 'ithalat', 'ihracat', 'return', 'returns', 'iade', 'plus', 'premium', 'first', 'home',
  'business', 'select', 'time', 'definite', 'service', 'servis', 'hizmet', 'hizmeti', 'versand', 'sendung', 'colis', 'envoi',
  'urgente', 'rapido', 'hizli', 'normal', 'pallet', 'palet', 'ltl', 'post', 'posta', 'kurye', 'courier', 'economico',
  'internacional', 'nacional', 'europe', 'europa', 'global', 'mobil', 'ups', 'fedex', 'dhl', 'tnt', 'gls', 'dpd', 'aras', 'mng',
  'ptt', 'surat', 'sendeo', 'hepsijet',
  // ücret etiketi
  'fuel', 'yakit', 'akaryakit', 'surcharge', 'surcharges', 'charge', 'charges', 'fee', 'fees', 'ucret', 'ucreti', 'bedel',
  'bedeli', 'tutar', 'tutari', 'extra', 'additional', 'handling', 'ellecleme', 'residential', 'remote', 'area', 'bolge',
  'bolgesi', 'uzak', 'correction', 'duzeltme', 'degisikligi', 'duty', 'duties', 'tax', 'taxes', 'vat', 'kdv', 'vergi', 'vergisi',
  'gumruk', 'customs', 'clearance', 'brokerage', 'disbursement', 'advancement', 'entry', 'processing', 'insurance', 'sigorta',
  'declared', 'value', 'signature', 'imzali', 'saturday', 'cumartesi', 'sunday', 'peak', 'demand', 'yogunluk', 'oversize',
  'oversized', 'overweight', 'large', 'agir', 'buyuk', 'hacimli', 'discount', 'indirim', 'rebate', 'base', 'basic', 'transport',
  'transportation', 'tasima', 'sms', 'cod', 'kapida', 'odeme', 'tahsilat', 'tahsilatli', 'emergency', 'security', 'guvenlik',
  'pickup', 'toplama', 'weekend', 'holiday', 'adjustment', 'credit', 'refund', 'rerouting', 'redirect', 'storage', 'depolama',
  'zuschlag', 'gebuhr', 'gebuehr', 'frais', 'supplement', 'recargo', 'tarifa', 'maut', 'toll', 'treibstoff', 'kraftstoff',
  'carburant', 'combustible', 'diesel', 'energy', 'enerji', 'ek',
]);
const LONG_SAFE_WORDS = [...SAFE_VALUE_WORDS].filter((w) => w.length >= 7);
/** Ay adları: yalnız değerde rakam da varsa (yazıyla tarih: "14-Oct-2026", "3 Kasım 2026"). */
const MONTH_WORDS = new Set([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march',
  'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'ocak', 'subat', 'mart', 'nisan', 'mayis',
  'haziran', 'temmuz', 'agustos', 'eylul', 'ekim', 'kasim', 'aralik', 'januar', 'februar', 'marz', 'mrz', 'mai', 'juni', 'juli',
  'okt', 'dez', 'dezember', 'oktober',
]);
/** Bilinen ek ücret adları (core `SURCHARGE_SYNONYMS`) sözcük dizisi olarak; ad olarak da kullanılan tek sözcük hariç. */
const NAME_LIKE_SYNONYMS = new Set(['kiymet']);
const SURCHARGE_PHRASES = SURCHARGE_SYNONYMS.flatMap((g) => g.synonyms)
  .map((p) => words(p).tokens)
  .filter((t) => t.length > 1 || (t.length === 1 && !NAME_LIKE_SYNONYMS.has(t[0]!)));

const hasPhrase = (tokens: readonly string[], phrase: readonly string[]) => tokens.some((_, i) => phrase.every((p, j) => tokens[i + j] === p));

/** Y45: güvenli metin sütunundaki değer kendisi de güvenli mi (ülke, para birimi, bilinen ücret adı, sözlük sözcüğü)? */
export function safeTextValue(value: string): boolean {
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) return true;
  if (parseCountry(v) || parseCurrency(v)) return true;
  const w = words(v);
  if (w.tokens.some((t) => SAFE_VALUE_WORDS.has(t) || (t.length >= 7 && LONG_SAFE_WORDS.some((s) => t.includes(s))))) return true;
  if (/\d/.test(v) && w.tokens.some((t) => MONTH_WORDS.has(t))) return true;
  return SURCHARGE_PHRASES.some((p) => hasPhrase(w.tokens, p));
}

/** Örnek hücre sağlayıcıya maskeli mi gitmeli? `cls` sütunun `headerPrivacy` sınıfı; `value` kırpılmamış hücre. */
export function shouldMaskSample(cls: HeaderPrivacy, value: string): boolean {
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) return false;
  if (cls === 'personal') return true;
  if (looksLikeContact(v)) return true;
  if (isPlainValue(v)) return false;
  // Y45: güvenli başlıklı sütunda da değer sözlükte değilse maskelenir (kişi adı "Hizmet" sütununa yazılmış olabilir)
  return cls !== 'safeText' || !safeTextValue(v);
}

/**
 * Başlık veri gibi mi görünüyor (başlık satırı yanlış seçilmiş olabilir)? Sayı, sayısal tarih/saat, ölçü, e-posta, telefon,
 * 7+ rakam ya da rakamla başlayıp harf ve yine rakam içeren kimlik ("1Z1", "1Z999AA10123456784").
 */
export function headerLooksLikeData(header: string): boolean {
  const v = header.replace(/\s+/g, ' ').trim();
  if (!v) return false;
  if (isNumber(v) || DATE.test(v) || TIME.test(v) || DIMS.test(v)) return true;
  if (looksLikeContact(v)) return true;
  if (digitCount(v) >= 7) return true;
  return v.split(' ').some((tok) => /^\d+\p{L}+\d/u.test(tok));
}

/** Tek başına kuşkulu başlık: veri gibi, ":" sonrası serbest metin ("Gönderici: Ahmet Yılmaz") ya da rakam ağırlıklı. */
export function headerSuspicious(header: string): boolean {
  if (headerLooksLikeData(header)) return true;
  if (/:\s*\p{L}{2,}/u.test(header)) return true;
  const digits = digitCount(header);
  const letters = (header.match(/\p{L}/gu) ?? []).length;
  return digits >= 3 && digits > letters;
}

/**
 * Sağlayıcıya başlık yerine gidecek takma adlar (`null`: başlık aynen gider). Bir başlık veri gibi görünüyorsa bütün satır
 * veri sayılır ve hepsi gizlenir; değilse yalnız kuşkulu olanlar. Takma ad "#<sıra>" (dosyadaki bir başlıkla çakışırsa
 * sonuna "~" eklenir); yanıttaki takma ad `unaliasHeader` ile gerçek başlığa çevrilir.
 */
export function headerAliases(headers: readonly string[]): (string | null)[] {
  const all = headers.some(headerLooksLikeData);
  const real = new Set(headers.map((h) => h.trim()));
  return headers.map((h, i) => {
    if (!all && !headerSuspicious(h)) return null;
    let alias = `#${i}`;
    while (real.has(alias)) alias += '~';
    return alias;
  });
}

/** Yanıttaki başlık bir takma adsa gerçek başlığı, değilse kendisini döner. */
export function unaliasHeader(headers: readonly string[], aliases: readonly (string | null)[], h: string | null | undefined): string | null | undefined {
  if (h == null) return h;
  const i = aliases.indexOf(h.trim());
  return i >= 0 ? headers[i] : h;
}
