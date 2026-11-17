import { ApiError, SCOPE_MISMATCH, UPGRADE_REQUIRED } from '../api/client';
import type { MeasurementPayload } from '../api/endpoints';
import { sameScope, type SessionScope } from '../auth/token';
import type { Trouble } from './schedule';
import { dueRows, getRow, markError, markRetry, markSending, markSent, pendingByOrg, ROW_DELAY_MAX_MS, unsentGroups, type QueueRow } from './store';

const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 10 * 60 * 1000;
const NETWORK_MAX_DELAY_MS = 20 * 1000;

export function backoffDelay(attempts: number, network = false): number {
  const exp = Math.min(network ? NETWORK_MAX_DELAY_MS : MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.85 + Math.random() * 0.3));
}

/**
 * Sunucuya giden gövde: gönderim anındaki telefon saati (`sentAt`) eklenir (KALANLAR 6.7-b). Sunucu farkı (alış anı − `sentAt`)
 * ölçüm anına ekler: saati yanlış telefonun kaydı, kuyrukta günlerce beklese de gerçek ölçüm anıyla sıralanır. Her denemede
 * yeniden yazılır; kuyrukta saklanmaz. Asıl kaynak `X-SOD-Sent-At` başlığıdır (`client.ts` `stampSentAt`: jeton yenilemesinden
 * sonra, istek çıkarken); gövdedeki alan başlığı taşımayan aracıya karşı yedektir, sunucu başlığı önce okur.
 */
export function wirePayload(data: MeasurementPayload, now = Date.now()): MeasurementPayload {
  return { ...data, sentAt: new Date(now).toISOString() };
}

/** Sunucunun gelecek için saat kayması payı (`apps/api` `MEASURED_AT_FUTURE_SKEW_MS`). */
const SERVER_FUTURE_SKEW_MS = 15 * 60 * 1000;
/** Bundan uzak gelecekteki ölçüm anı beklenmez: her yarım saatte fotoğraflarla yeniden yükleme günlerce sürmesin. */
const FUTURE_RETRY_MAX_MS = 6 * 3600 * 1000;

/**
 * `MEASURED_AT_INVALID` alan kaydın ölçüm anı telefonun şimdiki saatine göre gelecekte mi? Ölçümden sonra telefon saati
 * düzelmiş demektir (gönderim anındaki saat doğru, ölçüm anı ileride): zaman geçince kayıt geçerli olur. O ana dek (en çok
 * `ROW_DELAY_MAX_MS`) beklenip kendiliğinden yeniden denenir; "Hatalı" olmaz. Geçmişteki (çok eski) ya da 6 saatten uzak
 * gelecekteki an: "Hatalı".
 */
export function measuredAtRetryAt(row: Pick<QueueRow, 'data'>, now: number): number | null {
  const at = Date.parse(row.data.measuredAt);
  if (!Number.isFinite(at) || at <= now || at - now > FUTURE_RETRY_MAX_MS) return null;
  return now + Math.min(ROW_DELAY_MAX_MS, Math.max(60_000, at - SERVER_FUTURE_SKEW_MS - now + 60_000));
}

/** Yetki veya abonelik engelinden sonra otomatik deneme aralığı. Her deneme fotoğrafları yeniden yükler. */
export const PAUSE_MS = 5 * 60 * 1000;

/**
 * Engel varken zamanlayıcı ve "öne alma" gönderim yapmaz; elle "Gönder" (force) dener.
 * `blocked`: uygulamanın güncellenmesi gerekiyor (426). Bu durumda elle "Gönder" de dahil hiçbir gönderim yapılmaz:
 * ağ ve fotoğraf yüklemesi boşa harcanmaz, kayıt kuyrukta bekler (Mesaj 13 §3.5-2).
 */
export function flushAllowed(now: number, pausedUntil: number, force: boolean, blocked = false): boolean {
  if (blocked) return false;
  return force || now >= pausedUntil;
}

/**
 * Firmasız jetonda (`org: null`) kapsam yoktur, kuyruk gönderemez. Kişinin bekleyen kaydı varsa oturumu toparlamayı dener;
 * firma gelirse kapsamı döner, gönderim yine yalnız o kapsamın kayıtlarını okur. Kayıtlara dokunmaz.
 */
export async function recoverQueueSession(personId: string | null, recover: () => Promise<SessionScope | null>): Promise<SessionScope | null> {
  if (!personId) return null;
  if (Object.keys(pendingByOrg(await unsentGroups(), personId)).length === 0) return null;
  return recover();
}

/**
 * Açılışta yarıda kalmış gönderimlerin geri alınması (`recoverInterrupted`: SENDING → PENDING). Gönderim bunu bekler.
 * Hata verirse (ör. depolama dolu, veritabanı açılamadı; 11-B11) söz saklanmaz: sonraki gönderim yeniden dener. Eskiden
 * reddedilmiş söz kalıyor, uygulama yeniden başlatılana dek kuyruk hiç gönderim yapmıyordu. Yalnız gönderim yokken çağrılır
 * (açılışta ve gönderim kilidi alındıktan sonra): yeniden deneme süren bir gönderimi PENDING'e çeviremez.
 */
export function createRecovery(recover: () => Promise<void>) {
  let done: Promise<void> | null = null;
  return {
    ready(): Promise<void> {
      if (!done) {
        const attempt = recover();
        done = attempt;
        attempt.catch(() => {
          if (done === attempt) done = null;
        });
      }
      return done;
    },
  };
}

export type SendErrorKind =
  /** Jeton artık bu kayda ait değil: dur, kayıt sahibini bekler, deneme sayılmaz. */
  | 'scope'
  /** Bağlantı yok: dur, kısa aralıkla yeniden dene. */
  | 'network'
  /** Yetki veya abonelik engeli: hiçbir kayıt geçmez. Dur, kayıt kuyrukta kalır, profil yenilenir. */
  | 'paused'
  /**
   * Geçici sunucu hatası: bunu sonra dene. Sunucu genelinde bir sorunsa (`serverTrouble`: 429, 502-504, 408, hesap servisine ya da
   * veritabanına ulaşılamadı) tur durur ve genel bekleme kurulur; tek kaydın 500'ünde sıradakine geçilir, ikinci 500'de durulur.
   */
  | 'retry'
  /** Bu kayda özgü red (ör. doğrulama): hatalı olarak işaretle, kullanıcı düzeltir. */
  | 'rejected'
  /**
   * Sunucu ayarı sorunu (adres yok, bilinmeyen kod): kayıt uzun süre ertelenir, sıradakine geçilir.
   * Aynı turda arka arkaya iki kayıt bu sınıfa düşerse sunucu gerçekten bozuktur: döngü durur, kullanıcıya söylenir.
   */
  | 'config'
  /**
   * Uygulamanın bu sürümü artık kabul edilmiyor (426 `UPGRADE_REQUIRED`). Hiçbir kayıt geçmez: dur.
   * Kayıt olduğu gibi kalır: Hatalı olmaz, silinmez, deneme sayılmaz, hata metni değişmez. Güncelleme kurulunca gönderilir.
   */
  | 'upgrade';

const PAUSING_CODES = new Set(['READ_ONLY', 'NO_PRODUCT_ACCESS', 'ORG_REQUIRED', 'FORBIDDEN']);

/**
 * Kayda özgü red kodları: kaydın kendisi düzeltilmeden geçmez. Kaynak `apps/api` `POST /measurements`
 * (`routes/measurements.ts` `readMultipart` ve oluşturma yolu) ve ortak hata işleyicisi (`errors.ts`):
 * - `VALIDATION`: şema (Zod), eksik ya da okunamayan `data`, boş takip no;
 * - `EMPTY_FILE`, `INVALID_FILE`: fotoğraf boş ya da görüntü değil;
 * - `VALUE_OUT_OF_RANGE`: sütuna sığmayan değer;
 * - `TRACKING_IN_USE` (409): aynı takip no için çakışma;
 * - `FILE_TOO_LARGE`, `TOO_MANY_FILES` (413, `errors.ts` ortak işleyici): fotoğraf ya da gövde sınırı aşıldı, fotoğraf azaltılır.
 *   Ağ geçidinin (nginx) kendi 413'ü JSON değildir (`HTTP_413`): o sunucu ayarı sorunudur.
 * - `PHOTO_REQUIRED`: koli fotoğrafı eksik (bugün düzeltme ucunda; oluşturmaya gelirse de kayda özgüdür).
 * - `MEASURED_AT_INVALID`: ölçüm anı (telefon saati farkı düzeltildikten sonra) sunucunun kabul aralığı dışında. Çok eskiyse
 *   yeniden göndermek düzeltmez: kayıt "Hatalı" olur, otomatik turlara girmez (döngü yok). Telefona göre gelecekteyse (ölçümden
 *   sonra saat düzelmiş) o an gelince kendiliğinden yeniden denenir (`measuredAtRetryAt`).
 * API yeni bir kayda özgü kod eklerse buraya da eklenir; eklenmezse kayıt kaybolmaz, "sunucu ayarı sorunu" olarak bekler.
 */
export const REJECT_CODES = new Set([
  'VALIDATION',
  'EMPTY_FILE',
  'INVALID_FILE',
  'VALUE_OUT_OF_RANGE',
  'TRACKING_IN_USE',
  'PHOTO_REQUIRED',
  'FILE_TOO_LARGE',
  'TOO_MANY_FILES',
  'MEASURED_AT_INVALID',
]);
const REJECT_STATUSES = new Set([400, 409, 413, 422]);

export function classifySendError(e: unknown): SendErrorKind {
  if (!(e instanceof ApiError)) return 'retry';
  if (e.code === SCOPE_MISMATCH) return 'scope';
  if (e.code === UPGRADE_REQUIRED || e.status === 426) return 'upgrade';
  if (e.isNetwork || e.code === 'TIMEOUT') return 'network';
  if (PAUSING_CODES.has(e.code)) return 'paused';
  if (e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500) return 'retry';
  if (REJECT_STATUSES.has(e.status) && REJECT_CODES.has(e.code)) return 'rejected';
  // 404, 405, 415, ağ geçidi 413'ü, tanınmayan kod: kayıtta değil sunucuda sorun var.
  return 'config';
}

/** Bütün kayıtları etkileyen geçici sunucu durumları: aynı turda sıradaki kaydı göndermek de boşa yükleme olur. */
const SERVER_WIDE_STATUSES = new Set([408, 502, 503, 504]);
const SERVER_WIDE_CODES = new Set(['AUTH_UNAVAILABLE', 'DB_UNAVAILABLE']);

/**
 * Gönderim hatası turu durdurup genel bekleme gerektiriyor mu (11-B1)? `null`: bu kayda özgü ya da başka sınıfta ele alınan hata.
 * Ağ hatası `network`, 429 `rateLimit` (sunucunun `retry-after` süresiyle), sunucu genelindeki 5xx `server`.
 * 500 ve diğer 5xx burada `null`: tek kayda özgü olabilir; arka arkaya ikisi `runFlush` içinde turu durdurur.
 */
export function serverTrouble(e: unknown): Trouble | null {
  if (!(e instanceof ApiError)) return null;
  const retryAfterMs = e.retryAfterMs ?? null;
  if (e.code === SCOPE_MISMATCH || e.code === UPGRADE_REQUIRED || e.status === 426) return null;
  if (e.isNetwork || e.code === 'TIMEOUT') return { kind: 'network', retryAfterMs: null };
  if (e.status === 429) return { kind: 'rateLimit', retryAfterMs };
  if (SERVER_WIDE_STATUSES.has(e.status) || SERVER_WIDE_CODES.has(e.code)) return { kind: 'server', retryAfterMs };
  return null;
}

export type FlushDeps = {
  /** Gönderimi başlatan oturum. */
  scope: SessionScope;
  /** Elimizdeki jetonun anlık kapsamı. Döngü her kayıttan önce sorar. */
  currentScope: () => SessionScope | null;
  /** Kaydı, yalnız `requireScope` ile sunucuya yollar. */
  send: (row: QueueRow) => Promise<string | null>;
  /** Hata metni (kullanıcı dili). */
  describe: (e: unknown) => string;
  onSent?: (row: QueueRow) => void;
  onRowDone?: () => Promise<void> | void;
  /**
   * Deneme durdu. `access`: yetki veya abonelik engeli, profil yenilensin. `config`: sunucu ayarı sorunu.
   * `upgrade`: uygulama güncellenmeli (426); güncelleme durumu kalkana dek gönderim yapılmaz.
   */
  onPaused?: (reason: 'access' | 'config' | 'upgrade') => void;
  /** Güncelleme gerekiyor mu (426). Döngü her kayıttan önce sorar; açıksa hiçbir kayıt gönderilmez. */
  blocked?: () => boolean;
  /**
   * Tur sunucu ya da ağ sorunuyla durdu: çağıran genel bekleme kurar (`schedule.ts` `afterTrouble`). Dönen değer genel
   * beklemenin bittiği an (`backoff.until`); arka arkaya iki 500'de turu durduran kayıtlar bundan sonraya ertelenir.
   */
  onTrouble?: (t: Trouble) => number | void;
  /**
   * KALANLAR 4.9: sunucuya ulaşılıyor mu (`reach.ts`, önbellekli). Yalnız gönderilecek kayıt varken, turda bir kez sorulur.
   * `false` ise hiçbir kayıt yüklenmez (karşılama sayfasına fotoğraf gitmez), deneme sayılmaz; ağ sorunu bildirilir.
   */
  reachable?: () => Promise<boolean>;
  now?: () => number;
};

/**
 * Kuyruğu gönderir. Yalnız `scope` sahibinin kayıtları okunur; oturum değiştiği anda durur.
 * Son güvence `send` içindeki `requireScope`: yarış olsa da kayıt başka jetonla çıkmaz.
 */
export async function runFlush(deps: FlushDeps, force = false, ignoreRowBackoff = false): Promise<void> {
  const now = deps.now ?? Date.now;
  if (deps.blocked?.()) return;
  const due = await dueRows(deps.scope, force, ignoreRowBackoff);
  if (due.length && deps.reachable && !(await deps.reachable())) {
    deps.onTrouble?.({ kind: 'network', retryAfterMs: null });
    return;
  }
  /** Arka arkaya sunucu ayarı sorunu alan kayıt sayısı. Biri tek başına sıradakileri tıkamaz. */
  let configStreak = 0;
  /**
   * Arka arkaya 5xx (500 gibi, sunucu geneli olduğu belli olmayan) alan kayıtlar. İkincisinde tur durur; bu kayıtlar genel
   * beklemenin iki katı ertelenir: bekleme bitince sıradakiler önce denenir. Yoksa baştaki iki bozuk kayıt (her zaman 500)
   * her turu durdurur, arkadaki ölçümler hiç gönderilmezdi.
   */
  let serverStreak: { clientId: string; attempts: number; delay: number; error: string }[] = [];
  for (const queued of due) {
    if (!sameScope(deps.currentScope(), deps.scope)) return;
    if (deps.blocked?.()) return;
    if (!(await markSending(deps.scope, queued.clientId))) continue;
    // Kuyruktayken yerelde düzeltilmiş olabilir: en güncel hâlini gönder.
    const row = (await getRow(deps.scope, queued.clientId)) ?? queued;
    try {
      const serverId = await deps.send(row);
      await markSent(row.clientId, serverId);
      configStreak = 0;
      serverStreak = [];
      deps.onSent?.(row);
    } catch (e) {
      const kind = classifySendError(e);
      const attempts = row.attempts + 1;
      if (kind === 'scope') {
        await markRetry(row.clientId, row.attempts, 0, row.lastError);
        return;
      }
      if (kind === 'upgrade') {
        // Kayıt gönderimden önceki hâline döner: Hatalı ise Hatalı (elle "Gönder"de denenmiş olabilir), değilse bekliyor.
        // Deneme sayısı ve hata metni aynı kalır. Bekleme süresi sıfır: güncelleme kurulunca ilk turda gider.
        if (queued.status === 'ERROR') await markError(row.clientId, row.attempts, row.lastError ?? '');
        else await markRetry(row.clientId, row.attempts, 0, row.lastError);
        deps.onPaused?.('upgrade');
        return;
      }
      const error = deps.describe(e);
      const delay = backoffDelay(attempts, kind === 'network');
      const retryAt = kind === 'rejected' && e instanceof ApiError && e.code === 'MEASURED_AT_INVALID' ? measuredAtRetryAt(row, now()) : null;
      if (retryAt != null) await markRetry(row.clientId, attempts, retryAt, error);
      else if (kind === 'rejected') await markError(row.clientId, attempts, error);
      else if (kind === 'config') await markRetry(row.clientId, attempts, now() + MAX_DELAY_MS, error);
      else await markRetry(row.clientId, attempts, now() + delay, error);
      const trouble = kind === 'network' || kind === 'retry' ? serverTrouble(e) : null;
      if (kind === 'network') {
        deps.onTrouble?.(trouble ?? { kind: 'network', retryAfterMs: null });
        return;
      }
      if (trouble) {
        // Sunucu genelinde sorun: sıradaki kayıtların fotoğrafları da boşuna yüklenirdi (G1). Tur durur, genel bekleme kurulur.
        deps.onTrouble?.(trouble);
        return;
      }
      serverStreak =
        kind === 'retry' && e instanceof ApiError && e.status >= 500 ? [...serverStreak, { clientId: row.clientId, attempts, delay, error }] : [];
      if (serverStreak.length >= 2) {
        const at = now();
        const until = deps.onTrouble?.({ kind: 'server', retryAfterMs: e instanceof ApiError ? (e.retryAfterMs ?? null) : null });
        const gap = typeof until === 'number' && until > at ? until - at : 0;
        for (const s of serverStreak) {
          await markRetry(s.clientId, s.attempts, at + Math.min(ROW_DELAY_MAX_MS, Math.max(s.delay, 2 * gap)), s.error);
        }
        return;
      }
      if (kind === 'paused') {
        deps.onPaused?.('access');
        return;
      }
      configStreak = kind === 'config' ? configStreak + 1 : 0;
      if (configStreak >= 2) {
        deps.onPaused?.('config');
        return;
      }
    }
    await deps.onRowDone?.();
  }
  // Tur sunucu ayarı sorunuyla bitti (sonrasında gönderilen kayıt yok): kullanıcıya söylenir.
  if (configStreak > 0) deps.onPaused?.('config');
}
