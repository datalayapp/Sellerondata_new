// Firmayı kapatma ve geri açma: ekranların React'siz kuralları.
// Düz Node testleri (`closeOrg.test.mjs`) bu dosyayı doğrudan yükler: kabuğun ana girişini (React) içe aktarmaz.
import { ORG_PURGE_DAYS_DEFAULT, confirmNameMatches, isOrgClosedEntry, isOrgTimeZone, type MeResponse } from '@sellerondata/contracts';
import { dateLong, fmtLocale } from '@sellerondata/format';

type MeOrg = MeResponse['orgs'][number];

/** `/me` listesindeki kapalı firmalar. Sunucu onları yalnız firma sahibine gönderir; alan yoksa (eski sunucu) liste boştur. */
export function closedOrgsOf(me: Pick<MeResponse, 'orgs'> | null | undefined): MeOrg[] {
  return (me?.orgs ?? []).filter((o) => isOrgClosedEntry(o));
}

/** Kişinin kapalı firması; yoksa (sahip değil, geri açıldı, kalıcı silindi, hiç yok) null. */
export function closedOrgOf(me: Pick<MeResponse, 'orgs'> | null | undefined, orgId: string | undefined): MeOrg | null {
  if (!orgId) return null;
  return closedOrgsOf(me).find((o) => o.id === orgId) ?? null;
}

/** "Firmayı kapat" bölümü yalnız etkin firmanın sahibine (sunucu da `403 FORBIDDEN` ile reddeder). */
export function canCloseOrg(me: Pick<MeResponse, 'activeOrg'> | null | undefined): boolean {
  return me?.activeOrg?.orgRole === 'OWNER';
}

/** Onay penceresinin kırmızı düğmesi: ad firma adıyla aynı (`confirmNameMatches`, sunucuyla aynı işlev) ve şifre dolu. */
export function canSubmitClose(typedName: string, password: string, orgName: string): boolean {
  return confirmNameMatches(typedName, orgName) && password.length > 0;
}

/**
 * Pencerede gösterilecek saklama bitişi: kapatma anından varsayılan gün sayısı sonrası. Ön izlemedir; asıl tarih sunucudan gelir
 * (`purgeAfter`, `ORG_PURGE_DAYS` ile değişebilir) ve kapalı firma ekranında o yazılır.
 */
export function purgePreview(now: number = Date.now(), days: number = ORG_PURGE_DAYS_DEFAULT): string {
  return new Date(now + days * 86_400_000).toISOString();
}

/** Sözlük anahtarı (`closeOrg.err.*`) ya da null: null ise sunucunun yerelleşmiş metni gösterilir (`apiMessage`, bekleme süresiyle 429). */
export function closeErrorKey(e: unknown): string | null {
  switch ((e as { code?: unknown } | null)?.code) {
    case 'CONFIRM_NAME_MISMATCH':
      return 'closeOrg.err.name';
    case 'INVALID_CREDENTIALS':
      return 'closeOrg.err.password';
    case 'ORG_CLOSED':
      return 'closeOrg.err.alreadyClosed';
    case 'FORBIDDEN':
      return 'closeOrg.err.ownerOnly';
    default:
      return null;
  }
}

/**
 * Geri açma hatası. `gone`: firma artık geri açılamaz (süre doldu, sahip değil, firma yok, zaten açık); ekran `/me`'yi yeniler ve
 * sakin "bulunamadı" haline düşer.
 */
export function reopenErrorOf(e: unknown): { key: string | null; gone: boolean } {
  switch ((e as { code?: unknown } | null)?.code) {
    case 'INVALID_CREDENTIALS':
      return { key: 'closeOrg.err.password', gone: false };
    case 'ORG_PURGED':
      return { key: 'closeOrg.err.purged', gone: true };
    case 'ORG_NOT_FOUND':
      return { key: 'closeOrg.err.notFound', gone: true };
    case 'CONFLICT':
      return { key: 'closeOrg.err.notClosed', gone: true };
    default:
      return { key: null, gone: false };
  }
}

/**
 * Kapalı firmanın tarihi (uzun yazım: "13 Aralık 2026" / "13 December 2026") firmanın KENDİ saat diliminde (`/me` `orgs[].timeZone`).
 * Kapalı firma etkin olamaz: kabuğun saat dilimi başka firmanındır ya da yoktur. Dilim yoksa ya da listede değilse `fallback`
 * (kabuğun saat dilimi); o da yoksa tarayıcının saati. Geçersiz tarih "—".
 */
export function closedOrgDate(iso: string, locale: string, timeZone?: string | null, fallback?: string | null): string {
  const tz = isOrgTimeZone(timeZone) ? timeZone : isOrgTimeZone(fallback) ? fallback : undefined;
  return dateLong(iso, fmtLocale(locale), tz ? { timeZone: tz } : {});
}

/**
 * `409 ORG_CLOSED`: istek kapatılmış firmada kaldı (firma başka sekmede ya da başka kişi tarafından kapatıldı, araç kapanışı jetondan
 * önce öğrendi). Merkez kişiyi yeniden okur: kapalı firma `/me`'de etkin olmaz, kabuk firmasız ekrana ya da "firma değişti" uyarısına
 * düşer (sahip orada "Firmayı geri aç"ı görür).
 */
export function isOrgClosedError(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown } | null;
  return x?.status === 409 && x.code === 'ORG_CLOSED';
}

type FlashStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const REOPENED_KEY = 'sod_hub_reopened';

/** Geri açma başarılı: sayfa baştan yüklenecek (`useReloadSession`); ileti yüklemeden sonra bir kez gösterilsin diye firma adı saklanır. */
export function noteReopened(storage: FlashStorage | undefined, orgName: string): void {
  try {
    storage?.setItem(REOPENED_KEY, orgName);
  } catch {
    /* depo kapalı: ileti gösterilmez, işlem yine başarılıdır */
  }
}

/** Saklanan geri açma iletisini bir kez verir ve siler; yoksa ya da depo kapalıysa null. */
export function takeReopened(storage: FlashStorage | undefined): string | null {
  try {
    const name = storage?.getItem(REOPENED_KEY) ?? null;
    if (name !== null) storage?.removeItem(REOPENED_KEY);
    return name;
  } catch {
    return null;
  }
}
