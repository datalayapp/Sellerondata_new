/**
 * Hesap servisine ürün bildirimi (MESAJ-14 §4.4, §4.5). DeciShip kişilerin e-posta adresini bilmez ve posta göndermez:
 * "bu firmada şu izni taşıyanlara şu metni gönder" der, alıcıyı ve adresi Hesap servisi çözer (`POST /api/account/internal/notify`).
 *
 * Güvenlik:
 * - Anahtar (`PRODUCT_NOTIFY_SECRET`) yalnız `authorization` başlığında gider. Hata nesnesine, günlüğe ve dönüşe hiç girmez:
 *   `NotifyError` yalnız neden kodu ve HTTP durumu taşır; ağ hatasının kendisi (adres, başlık izi taşıyabilir) yutulur.
 * - Yönlendirme izlenmez (`redirect: 'error'`): anahtar başka bir adrese taşınmasın.
 * - 5 saniye zaman aşımı; yanıt gövdesi küçük ve şekli denetlenir.
 */
import { NOTICE_LIMITS, PRODUCT_NOTICE_STATUSES, type ProductNoticeBody, type ProductNoticeResponse, type ProductNoticeStatus } from '@sellerondata/contracts';
import { env } from '../env.ts';

export const NOTIFY_TIMEOUT_MS = 5_000;
/** Hesap servisinin yanıtı birkaç onlarca bayttır; bundan büyüğü okunmaz. */
const MAX_RESPONSE_BYTES = 4 * 1024;

/**
 * Bildirim gönderilemedi. `reason`:
 * - `NOT_CONFIGURED`: `ACCOUNT_NOTIFY_URL` boş; `NO_SECRET`: anahtar boş; `BAD_URL`: adres http(s) değil.
 * - `TOO_LARGE`: gövde `NOTICE_LIMITS.bodyBytes`'ı aşıyor (gönderilmez).
 * - `TIMEOUT`, `NETWORK`: istek ulaşmadı; `HTTP`: 200 dışı yanıt (`httpStatus`); `BAD_RESPONSE`: yanıt şekli tanınmadı.
 */
export type NotifyFailure = 'NOT_CONFIGURED' | 'NO_SECRET' | 'BAD_URL' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'BAD_RESPONSE';

export class NotifyError extends Error {
  readonly reason: NotifyFailure;
  readonly httpStatus: number | null;
  constructor(reason: NotifyFailure, httpStatus: number | null = null) {
    // ileti sabit: adres, anahtar ve yanıt gövdesi yok
    super(httpStatus === null ? `product notice failed: ${reason}` : `product notice failed: ${reason} ${httpStatus}`);
    this.name = 'NotifyError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

const isStatus = (v: unknown): v is ProductNoticeStatus => typeof v === 'string' && (PRODUCT_NOTICE_STATUSES as readonly string[]).includes(v);

/** Gövdeyi Hesap servisine yollar. Yalnız `200 { status, recipients }` başarıdır; geri kalan her şey `NotifyError`. */
export async function sendProductNotice(body: ProductNoticeBody): Promise<ProductNoticeResponse> {
  const url = env.notifyUrl;
  const secret = env.notifySecret;
  if (!url) throw new NotifyError('NOT_CONFIGURED');
  if (!secret) throw new NotifyError('NO_SECRET');
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new NotifyError('BAD_URL');
  }
  // adreste kullanıcı adı ya da parola olmaz: kimlik yalnız başlıktaki anahtar
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) throw new NotifyError('BAD_URL');
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, 'utf8') > NOTICE_LIMITS.bodyBytes) throw new NotifyError('TOO_LARGE');

  let res: Response;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NotifyError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new NotifyError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK', res.status);
  }
  if (res.status !== 200) throw new NotifyError('HTTP', res.status);
  if (text.length > MAX_RESPONSE_BYTES) throw new NotifyError('BAD_RESPONSE', res.status);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NotifyError('BAD_RESPONSE', res.status);
  }
  const o = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  if (!isStatus(o.status) || typeof o.recipients !== 'number' || !Number.isInteger(o.recipients) || o.recipients < 0) throw new NotifyError('BAD_RESPONSE', res.status);
  return { status: o.status, recipients: o.recipients };
}

export type Notifier = (body: ProductNoticeBody) => Promise<ProductNoticeResponse>;

let custom: Notifier | null = null;

/** Testler için: sahte bildirimci takmak (`null` → gerçek istemciye dön). `setFxService` kalıbı. */
export function setNotifier(fn: Notifier | null): void {
  custom = fn;
}

/** Geçerli bildirimci: sahtesi takılıysa o, değilse Hesap servisine giden istemci. */
export function notifier(): Notifier {
  return custom ?? sendProductNotice;
}

/** Bildirim açık mı: sahte bildirimci takılı ya da `ACCOUNT_NOTIFY_URL` dolu. Boşsa hatırlatma hiç çalışmaz. */
export function notifyConfigured(): boolean {
  return custom !== null || env.notifyUrl !== '';
}
