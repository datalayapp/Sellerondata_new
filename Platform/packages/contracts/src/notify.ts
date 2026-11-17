import type { Locale, ProductKey } from './catalog.ts';

/**
 * Araç → Hesap servisi bildirim isteği (Mesaj 14 §4.5). Araç kişilerin e-posta adresini bilmez: "bu firmada şu izni taşıyanlara
 * şu metni gönder" der, alıcıyı ve adresi Hesap servisi çözer. Uç yalnız iç ağdadır (gateway `internal` geçen yolları 404 yapar).
 * Kimlik: `authorization: Bearer <ürünün anahtarı>`. Hesap servisi ürünü ANAHTARDAN çözer: sunulan anahtarı
 * `PRODUCT_NOTIFY_SECRETS` haritasındaki her anahtarla sabit sürede karşılaştırır; gövdedeki `product` yalnız bu ürünü tekrarlar,
 * tutmazsa 401 (bir araç başka aracın adına bildirim isteyemez).
 */
export const NOTIFY_PATH = '/api/account/internal/notify';

/** Ürün bildirim anahtarının en kısa uzunluğu. Üretimde kısa anahtarla iki servis de açılmaz. */
export const NOTIFY_SECRET_MIN_LENGTH = 32;
/** En uzun anahtar: Hesap servisi `Bearer` başlığından en çok bu kadarını okur. */
export const NOTIFY_SECRET_MAX_LENGTH = 512;
/** Üretim anahtarının biçimi: yalnız görünür ASCII (boşluk, virgül sorunu yok; başlıkta olduğu gibi gider), 32..512 karakter. */
export const NOTIFY_SECRET_PATTERN = /^[\x21-\x7e]{32,512}$/;

/**
 * Geliştirme anahtarı (compose ve `scripts/dev.ps1` varsayılanı). Yalnız yerelde; üretimde iki servis de bu değeri reddeder.
 * Hesap servisi `PRODUCT_NOTIFY_SECRETS=deciship=<bu>`, DeciShip API `PRODUCT_NOTIFY_SECRET=<bu>` alır.
 */
export const DEV_PRODUCT_NOTIFY_SECRET = 'yerel-bildirim-anahtari-0123456789abcdef';

/**
 * Üretimde geçerli anahtar mı: `NOTIFY_SECRET_PATTERN` ve geliştirme anahtarı değil. İki servis de açılışta bununla denetler
 * (DeciShip `missingProductionEnv`, Hesap servisi `assertProductionConfig`); geliştirme ve testte uygulanmaz.
 */
export function isValidNotifySecret(secret: string): boolean {
  return typeof secret === 'string' && NOTIFY_SECRET_PATTERN.test(secret) && secret !== DEV_PRODUCT_NOTIFY_SECRET;
}

/** Gövde sınırları. Hesap servisi aşanı `400 VALIDATION` ile reddeder; araç göndermeden önce aynı sınırlara uyar. */
export const NOTICE_LIMITS = {
  /** `dedupeKey` uzunluğu (bkz. `NOTICE_DEDUPE_KEY`). */
  dedupeKey: 120,
  subject: 120,
  /**
   * Satır sayısı 1..10, her satır en çok 300 karakter. DeciShip'in günlük özeti en çok 9 satır kullanır: giriş, 6 fatura,
   * "ve X fatura daha", yasal not.
   */
  linesMin: 1,
  linesMax: 10,
  line: 300,
  actionLabel: 40,
  actionPath: 200,
  footer: 200,
  /** Ham gövde, bayt. */
  bodyBytes: 16 * 1024,
  /** Bir firmaya bir üründe kayan 24 saatte en çok ileti; aşılırsa `limited`. */
  perOrgPerDay: 30,
  windowHours: 24,
} as const;

/** Tekrar anahtarı: `(product, orgId, dedupeKey)` tekildir. Ör. DeciShip günlük özeti `ttk:<YYYY-MM-DD>`. */
export const NOTICE_DEDUPE_KEY = /^[a-z0-9:._-]{1,120}$/i;

/**
 * Gönderimi tamamlanmamış ileti (Y129): Hesap servisi satırı yazdı ama postalar bitmeden süreç durdu (`ProductNotice.sentAt` boş).
 * Son denemenin üstünden bu kadar dakika geçtiyse aynı anahtarla gelen istek `duplicate` almaz: postalar yeniden kuyruğa girer,
 * yanıt `queued` olur. Daha yeni denemede `duplicate` (gönderim sürüyor olabilir; iki kopya çift göndermez).
 */
export const NOTICE_RESEND_AFTER_MINUTES = 10;

/** Eylem yolunun karakter kümesi (nokta yok: `..`, `%2e` ve alan adı benzeri yol kurulamaz). Ek kurallar `isNoticeActionPath`'te. */
export const NOTICE_ACTION_PATH = /^[A-Za-z0-9/_\-?=&]+$/;

/** Düz metin: denetim (CR/LF dahil), biçim (yön, sıfır genişlik), eşlenmemiş vekil, satır/paragraf ayırıcı karakteri yok. */
export const NOTICE_PLAIN_TEXT = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
/** Bağlantı biçimli metin oltalama aracı olur; postadaki tek bağlantı eylem düğmesidir. */
export const NOTICE_LINK_LIKE = /(https?:|:\/\/|www\.)/i;

/** NFKC'nin "."ya çevirmediği noktalar (ideografik nokta ve yarım genişlik biçimi): tarayıcı alan adında bunları da nokta sayar. */
const IDEOGRAPHIC_DOTS = /[。｡]/g;

/**
 * Bağlantı biçimi denetimi için katlama: NFKC (U+FF01..U+FF5E tam genişlik "www." ve "http://", küçük ve üst simge biçimler ASCII'ye döner)
 * ve ideografik nokta "." olur. Saklanan metni değiştirmez; yalnız denetimde ve postada gösterirken kullanılır.
 */
export function foldLinkText(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(IDEOGRAPHIC_DOTS, '.');
}

/**
 * Ad kuralı (Hesap servisi: kişi ve firma adı, yalnız yeni yazımda): katlanmış hâlde `NOTICE_LINK_LIKE` (http, ://, www.) yok.
 * Çıplak alan adı ("Kargo.com Lojistik") serbest: gerçek firma adlarında sık geçer; postada `defangLinkText` ile etkisizleşir.
 */
export function isLinkLikeName(value: string): boolean {
  return NOTICE_LINK_LIKE.test(foldLinkText(value));
}

/**
 * Alan adına benzeyen nokta: öncesinde harf, rakam ya da tire; sonrasında en az iki ASCII harf (ya da `xn--` IDN) ve ardından sözcük
 * bitişi. Türkçe kısaltmalar ("A.Ş.", "Ltd.Şti.") eşleşmez: Türkçe harf ASCII değildir, tek harf alan adı uzantısı değildir.
 */
const DOMAIN_DOT = /([\p{L}\p{N}-])\.(?=(?:xn--[a-z0-9-]+|[a-z]{2,})(?![\p{L}\p{N}-]))/giu;

/**
 * Kullanıcının yazdığı adı postada gösterirken bağlantı olmaktan çıkarır (Y36): katlar, `://`, `www.` ve alan adı noktasının ardına
 * boşluk koyar ("kargo.com" → "kargo. com"). Posta istemcileri boşluklu metni bağlantıya çevirmez; ad okunur kalır. Saklanan adı
 * değiştirmez. Kuraldan önce yazılmış adlar (http, www) da postada etkisizleşir.
 */
export function defangLinkText(value: string): string {
  return foldLinkText(value)
    .replace(/:\/\//g, ': //')
    .replace(/(^|[^\p{L}\p{N}-])(www)\./giu, '$1$2. ')
    .replace(DOMAIN_DOT, '$1. ');
}

/**
 * Bildirim metni kuralı (konu, satır, düğme etiketi, dipnot): kırpılmış hâli boş değil, en çok `max` UTF-16 birimi,
 * `NOTICE_PLAIN_TEXT` ve bağlantı biçimi yok. Hesap servisi aşanı `400 VALIDATION` ile reddeder; araç göndermeden önce aynı
 * işlevle denetler (iki servis de bunu kullanır).
 */
export function isNoticePlainText(value: string, max: number): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length >= 1 && v.length <= max && NOTICE_PLAIN_TEXT.test(v) && !NOTICE_LINK_LIKE.test(v);
}

/** U+2026; kaynakta özel karakter tutulmaz. */
const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * Kullanıcı verisini (taşıyıcı adı, fatura no) bildirim metnine hazırlar: denetim ve ayırıcı karakterler boşluk olur, biçim
 * karakterleri (`\p{Cf}`) ve eşlenmemiş vekiller silinir, boşluklar tekleşir; `max` UTF-16 birimini aşarsa kesilip `…` eklenir
 * (vekil çifti bölünmez). Bağlantı biçimini SİLMEZ: onu çağıran `NOTICE_LINK_LIKE` ile görüp genel metinle değiştirir.
 */
export function cleanNoticeText(value: string, max: number): string {
  const clean = String(value ?? '')
    .replace(/[\p{Cf}\p{Cs}]+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  let out = '';
  for (const ch of clean) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/** Tek dildeki ileti. Düz metindir: Hesap servisi HTML'e kaçışlayarak çizer, biçim işareti yorumlanmaz. */
export type NoticeText = {
  subject: string;
  lines: string[];
  /** Düğme. Bağlantı `APP_BASE_URL + path` ile Hesap servisinde kurulur; gövdede tam adres taşınmaz. */
  action?: { label: string; path: string };
  footer?: string;
};

/** `POST /api/account/internal/notify` gövdesi. */
export type ProductNoticeBody = {
  product: ProductKey;
  /** Organization.id (uuid). */
  orgId: string;
  dedupeKey: string;
  /** Alıcı: firmada etkin, doğrulanmış e-postalı ve bu üründeki rolü bu izni veren kişiler. İzin `${product}.` ile başlar ve katalogdadır. */
  audience: { permission: string };
  /** Her iki dil zorunlu; kişinin diline göre biri seçilir. */
  message: Record<Locale, NoticeText>;
};

export const PRODUCT_NOTICE_STATUSES = ['queued', 'duplicate', 'no_recipients', 'limited', 'disabled'] as const;
/**
 * `queued`: postalar kuyruğa girdi (gönderimi yarım kalmış ileti yeniden denendiyse de; `NOTICE_RESEND_AFTER_MINUTES`).
 * `duplicate`: aynı tekrar anahtarı daha önce gönderildi ya da gönderimi sürüyor (gönderilmez).
 * `no_recipients`: uygun alıcı yok. `limited`: 24 saat tavanı doldu. `disabled`: firmanın bu üründeki aboneliği etkin değil.
 */
export type ProductNoticeStatus = (typeof PRODUCT_NOTICE_STATUSES)[number];

/** `200` yanıtı. Alıcı listesi dönmez, yalnız sayı. Diğerleri: `400 VALIDATION`, `401 UNAUTHORIZED`, `404 ORG_NOT_FOUND`. */
export type ProductNoticeResponse = { status: ProductNoticeStatus; recipients: number };

/**
 * Eylem yolu kuralı: `/${product}/` ile başlar, `NOTICE_ACTION_PATH` kümesinde kalır, en çok `NOTICE_LIMITS.actionPath` karakter,
 * `..` ve `//` içermez (bağlantı yalnız o aracın sayfalarına gider). İki servis de aynı işlevi kullanır.
 */
export function isNoticeActionPath(product: string, path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length <= NOTICE_LIMITS.actionPath &&
    path.startsWith(`/${product}/`) &&
    NOTICE_ACTION_PATH.test(path) &&
    !path.includes('..') &&
    !path.includes('//')
  );
}
