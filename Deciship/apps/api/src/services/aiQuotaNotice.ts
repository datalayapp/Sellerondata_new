/**
 * KALANLAR 6.5: aylık yapay zekâ hakkının %80'i kullanılınca firmanın ayar yetkililerine (firma sahibi ve Yönetici:
 * `deciship.settings.manage`; Merkez'in yapay zekâ kullanımı sayfasını da bu izin görür) AYDA EN ÇOK BİR posta.
 * %100'deki davranış (429 `AI_QUOTA_EXCEEDED`, `aiMeter.ts` `assertAiQuota`) değişmez; ayrı posta yok.
 *
 * Tetik: sayacın ücretli `OK` satırından sonra (`aiMeter.ts` `quotaNoticeAfter`): hak uygulanıyor, hak > 0 ve kullanılan
 * (çağrı öncesi okunan + bu çağrı) ≥ %80. Arkada çalışır: çağrının yanıtı postayı beklemez, posta hatası çağrıyı düşürmez.
 *
 * Bir kez:
 * - Hesap servisi `(product, orgId, dedupeKey)` tekilliğiyle her anahtarı bir kez gönderir; anahtar `ai-quota-80:<YYYY-MM>`
 *   (dönem firmanın saat diliminde, sayaçla aynı).
 * - DeciShip'te kalıcı işaret: gönderim kabul edilince (`queued` ya da `duplicate`) denetim kaydı (`AuditLog`, eylem
 *   `ai.quotaNotice`, varlık `AiQuota`, kimlik dönem; Merkez etkinlik akışında görünmez). İşaretli dönemde Hesap servisine hiç
 *   sorulmaz; yeniden başlatmadan sonra da. Süreç içi bellek işaretli dönemi bir daha veritabanına da sormaz.
 * - Kabul edilmezse (`no_recipients`, `limited`, `disabled`, ağ ya da yanıt hatası) işaret yazılmaz; o firma ve dönem
 *   `AI_QUOTA_NOTICE_RETRY_MS` boyunca yeniden denenmez, sonra hakkı kullanan ilk ücretli çağrı yeniden dener.
 * - Aynı süreçte aynı firma ve dönem için tek deneme sürer; iki kopya aynı anda denerse Hesap servisi ikincisine `duplicate`
 *   döner (tek posta), işaret iki kez yazılabilir (zararsız).
 *
 * Postada tutar yok (yalnız yüzde ve yeni hakkın başladığı gün); eylem düğmesi yok (kullanım sayfası Merkez'de, bildirim yolu
 * yalnız `/deciship/...` olabilir). Metin TR + EN (`mail.aiQuota.*`), Hesap servisinin düz metin kuralıyla denetlenir.
 * Ay dönümü: çağrı eski dönemde başlayıp yeni dönemde bittiyse (ya da deneme beklerken ay döndüyse) eski dönemin postası
 * gönderilmez; yeni dönemin kullanımı sıfırdan sayılır.
 * Bilinen sınır: eşiği geçen çağrının postası gönderilemezse ve o ay başka ücretli çağrı olmazsa posta gitmez.
 */
import {
  aiPeriodOf,
  NOTICE_DEDUPE_KEY,
  NOTICE_LIMITS,
  cleanNoticeText,
  isNoticePlainText,
  type Locale,
  type NoticeText,
  type Permission,
  type ProductNoticeBody,
} from '@sellerondata/contracts';
import { dateLong } from '@sellerondata/format';
import { prisma, withCompany } from '../db.ts';
import { m } from '../i18n/index.ts';
import type { MeterLog } from './aiMeter.ts';
import { NotifyError, notifier, notifyConfigured } from './notify.ts';

/** Eşik (yüzde, aşağı yuvarlanmış kullanım; `aiUsedPct`). */
export const AI_QUOTA_NOTICE_PCT = 80;
/** Alıcı: ayar izni (firma sahibi ve Yönetici). */
export const AI_QUOTA_NOTICE_PERMISSION = 'deciship.settings.manage' satisfies Permission;
/** Kalıcı işaretin denetim kaydı eylemi (`AuditLog.action`). */
export const AI_QUOTA_NOTICE_ACTION = 'ai.quotaNotice';
const MARKER_ENTITY = 'AiQuota';
/** Kabul edilmeyen gönderimden sonra o firma ve dönem için bekleme. */
export const AI_QUOTA_NOTICE_RETRY_MS = 60 * 60_000;
const LOCALES: readonly Locale[] = ['tr', 'en'];

export type AiQuotaNoticeInput = {
  companyId: string;
  /** 'YYYY-MM' (firmanın saat diliminde) */
  period: string;
  /** kullanılan yüzde (tamsayı); postada en çok 100 */
  pct: number;
  /** yeni hakkın başladığı gün, 'YYYY-MM-DD' */
  resetsDay: string;
};

/** Gönderim anının bilgisi: dönemin hesaplandığı saat dilimi ve günlük. */
type NoticeRun = AiQuotaNoticeInput & { timeZone: string; log: MeterLog };

function checked(text: string, max: number): string {
  const v = cleanNoticeText(text, max);
  if (!isNoticePlainText(v, max)) throw new Error('ai quota notice: text breaks the notice rule');
  return v;
}

function noticeText(locale: Locale, pct: number, resetsDay: string): NoticeText {
  const resetsAt = dateLong(resetsDay, locale);
  return {
    subject: checked(m('mail.aiQuota.subject', { pct }, locale), NOTICE_LIMITS.subject),
    lines: [
      checked(m('mail.aiQuota.intro', { pct }, locale), NOTICE_LIMITS.line),
      checked(m('mail.aiQuota.stop', { resetsAt }, locale), NOTICE_LIMITS.line),
      checked(m('mail.aiQuota.more', undefined, locale), NOTICE_LIMITS.line),
    ],
    footer: checked(m('mail.aiQuota.footer', undefined, locale), NOTICE_LIMITS.footer),
  };
}

/** Postanın gövdesi (iki dil). Sözleşmeye uymayan gövde kurulmaz: hata atar. */
export function buildAiQuotaNotice(o: AiQuotaNoticeInput): ProductNoticeBody {
  const dedupeKey = `ai-quota-${AI_QUOTA_NOTICE_PCT}:${o.period}`;
  if (!/^\d{4}-\d{2}$/.test(o.period) || !NOTICE_DEDUPE_KEY.test(dedupeKey)) throw new Error('ai quota notice: invalid dedupe key');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.resetsDay)) throw new Error('ai quota notice: invalid reset day');
  const pct = Math.min(100, Math.max(AI_QUOTA_NOTICE_PCT, Math.floor(o.pct)));
  const message = Object.fromEntries(LOCALES.map((l) => [l, noticeText(l, pct, o.resetsDay)])) as Record<Locale, NoticeText>;
  return { product: 'deciship', orgId: o.companyId, dedupeKey, audience: { permission: AI_QUOTA_NOTICE_PERMISSION }, message };
}

// ---------- süreç içi bellek ----------

/** İşaretli (gönderilmiş) firma + dönem. */
const marked = new Set<string>();
/** Kabul edilmeyen gönderim: bu ana kadar yeniden denenmez. */
const retryAt = new Map<string, number>();
/** Süren deneme (firma + dönem başına bir). */
const inFlight = new Map<string, Promise<void>>();
/** Bütün süren denemeler (testler `drainAiQuotaNotices` ile bekler). */
const pending = new Set<Promise<void>>();

/** Testler için (`resetAiMeterState` çağırır): süreç içi bellek boşalır; veritabanındaki işaret kalır. */
export function resetAiQuotaNoticeState(): void {
  marked.clear();
  retryAt.clear();
  inFlight.clear();
}

/** Süren denemelerin bitmesini bekler (testler; kapanışta gerekmez: kaybolan deneme sonraki çağrıda yeniden yapılır). */
export async function drainAiQuotaNotices(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Eşiği geçen çağrıdan sonra: gerekiyorsa postayı arkada ister. Hiçbir zaman atmaz. */
export function noticeAiQuota(o: NoticeRun): void {
  if (!notifyConfigured()) return;
  // ay dönümü: çağrı eski dönemde başlayıp yeni dönemde bittiyse eski dönemin postası artık gönderilmez
  if (aiPeriodOf(new Date(), o.timeZone) !== o.period) return;
  const key = `${o.companyId}:${o.period}`;
  if (marked.has(key) || inFlight.has(key)) return;
  const wait = retryAt.get(key);
  if (wait !== undefined) {
    if (wait > Date.now()) return;
    retryAt.delete(key);
  }
  const run: Promise<void> = attempt(o, key)
    .catch((err: unknown) => o.log.warn({ err, companyId: o.companyId, period: o.period }, 'ai-quota-notice-failed'))
    .finally(() => {
      inFlight.delete(key);
      pending.delete(run);
    });
  inFlight.set(key, run);
  pending.add(run);
}

async function attempt(o: NoticeRun, key: string): Promise<void> {
  const { companyId, period, log } = o;
  // deneme arkada sürer: veritabanı ve Hesap servisi beklenirken ay dönmüş olabilir
  if (aiPeriodOf(new Date(), o.timeZone) !== period) return;
  const done = await withCompany(companyId, () =>
    prisma.auditLog.findFirst({ where: { companyId, action: AI_QUOTA_NOTICE_ACTION, entity: MARKER_ENTITY, entityId: period }, select: { id: true } }),
  );
  if (done) {
    marked.add(key);
    return;
  }
  const body = buildAiQuotaNotice(o);
  let res: Awaited<ReturnType<ReturnType<typeof notifier>>>;
  try {
    res = await notifier()(body);
  } catch (err) {
    retryAt.set(key, Date.now() + AI_QUOTA_NOTICE_RETRY_MS);
    // anahtar ve adres günlüğe girmez (`NotifyError` yalnız neden ve durum taşır)
    log.warn(
      { companyId, period, reason: err instanceof NotifyError ? err.reason : 'UNKNOWN', httpStatus: err instanceof NotifyError ? err.httpStatus : null },
      'ai-quota-notice-not-sent',
    );
    return;
  }
  if (res.status !== 'queued' && res.status !== 'duplicate') {
    retryAt.set(key, Date.now() + AI_QUOTA_NOTICE_RETRY_MS);
    log.warn({ companyId, period, status: res.status }, 'ai-quota-notice-declined');
    return;
  }
  await withCompany(companyId, () =>
    prisma.auditLog.create({
      data: {
        companyId,
        userId: null,
        action: AI_QUOTA_NOTICE_ACTION,
        entity: MARKER_ENTITY,
        entityId: period,
        data: { threshold: AI_QUOTA_NOTICE_PCT, pct: Math.floor(o.pct), status: res.status, recipients: res.recipients },
      },
    }),
  );
  marked.add(key);
}
