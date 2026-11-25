/**
 * İtiraz süresi hatırlatması (MESAJ-14 §4.4, 13-B4). Türkiye'deki firmada fark tutarı olan ve itirazı gönderilmemiş faturalar
 * için firmanın itiraz yetkilisine (Yönetici, Muhasebe) GÜNDE EN ÇOK BİR özet e-posta gider. Postayı Hesap servisi gönderir;
 * burası yalnız "hangi firmaya, hangi faturalar için, ne zaman" sorusunu yanıtlar ve bildirim ister (`services/notify.ts`).
 *
 * Y30: etkin itiraz turu olan faturada gönderimden sonra listeye eklenip henüz gönderilmemiş satır varsa fatura da adaydır
 * (`unsentAfterSend`; o satırlar da TTK süresine tabidir). Turu olmayan faturanın kuralı değişmedi (fazla ödeme var).
 *
 * Özet: o gün TTK son gününe 3 gün kalan faturalar ve son güne yakın tek yuva (`inDigest`): son günden bir önceki günden önce
 * yüklenen fatura 1 gün kala, o gün ya da sonra yüklenen son gün özetine girer. Son günü en yakın olan önce, en çok
 * `DIGEST_MAX_ROWS` satır ve "ve X fatura daha"; konu ve giriş cümlesi en acil olana göre. Bir fatura en çok iki özette görünür:
 * bir kez "3 gün kala", bir kez "1 gün kala" ya da "son gün". Kural yalnız yükleme gününe bakar: iz tutmaz, yeniden başlatmada
 * değişmez. Bilinen sınır: o günün özeti gittikten sonra yüklenen fatura o günün özetine girmez (anahtar gün başına tektir);
 * 3 gün kala günü böyle kaçan fatura 1 gün kala özetinde, son gün böyle yüklenen fatura hiç hatırlatılmaz.
 *
 * Veri kapsamı (RLS):
 * - Firma listesi bakım kapsamında okunur: yalnız `Company` satırının `id`, `settings` ve `nameVersion` sütunları (ülke
 *   `firmCountry` ile çözülür). İlke 20261115090000_company_maintenance_read; başka tablo bakım kapsamında AÇILMAZ.
 * - Adaylar her firmanın KENDİ bağlamında (`withCompany`) okunur: başka firmanın faturası görünmez, bildirimdeki `orgId`
 *   sorgunun firmasıdır.
 *
 * Tekrar: anahtar `ttk:<YYYY-MM-DD>` (firmanın saat dilimindeki takvim günü). Hesap servisi `(product, orgId, dedupeKey)`
 * tekilliğiyle her anahtarı bir kez gönderir; süreç içi bellek, cevabı alınmış anahtarı saatlik turlarda yeniden sormaz ve firma
 * düzeyindeki olumsuz yanıtı (`disabled`, `no_recipients`, `limited`, reddedilen gövde) birkaç saat hatırlar: tur bütçesi aynı
 * firmalara harcanmaz, sonraki firmalara sıra gelir. Bellek yeniden başlatmada boşalır; o zaman yalnız `duplicate` yanıtı alınır.
 *
 * Kullanıcı verisi (taşıyıcı adı, fatura no) sözleşmedeki `cleanNoticeText` ile temizlenir; bağlantıya benzeyen değer yerine genel
 * metin konur. Kurulan her metin Hesap servisinin kuralıyla (`isNoticePlainText`) denetlenir: bir firmanın verisi 400 alıp turu
 * bozamaz. Postada tutar yazmaz. Gece posta yok: firmanın saat diliminde 09:00–19:00 dışında firma atlanır.
 */
import { disputeDeadlines, ttkApplies, turkeyDate, type Locale } from '@deciship/core';
import {
  NOTICE_DEDUPE_KEY,
  NOTICE_LIMITS,
  NOTICE_LINK_LIKE,
  cleanNoticeText,
  isNoticeActionPath,
  isNoticePlainText,
  type NoticeText,
  type Permission,
  type ProductNoticeBody,
} from '@sellerondata/contracts';
import { dateLong } from '@sellerondata/format';
import { prisma, withCompany, withMaintenanceScope } from '../db.ts';
import { m } from '../i18n/index.ts';
import { firmCountry, readSettings } from '../lib/settings.ts';
import { DEFAULT_TIME_ZONE, isTimeZone, zonedDate } from '../lib/time.ts';
import { activeRoundWhere, unsentAfterSend } from './disputes.ts';
import { deciship as links } from './hub/links.ts';
import { NotifyError, notifier, notifyConfigured } from './notify.ts';

/** Gönderim penceresi, firmanın yerel saatiyle: `from` dahil, `to` hariç (09:00–18:59). */
export const REMINDER_HOURS = { from: 9, to: 19 } as const;
/** Bir turda en çok bu kadar bildirim isteği (firma başına bir özet). Kalanı sonraki tura kalır. */
export const REMINDER_MAX_PER_RUN = 200;
/** Adaylar: fatura tarihi son bu kadar gün içinde (TTK 8 gün; pay bırakılır). */
export const REMINDER_LOOKBACK_DAYS = 10;
/** Alıcı: itiraz gönderebilen kişi. */
export const REMINDER_PERMISSION = 'deciship.disputes.manage' satisfies Permission;
/** Özette en çok bu kadar fatura satırı; kalanı "ve X fatura daha". */
export const DIGEST_MAX_ROWS = 6;
/** Firma düzeyindeki olumsuz yanıtın hatırlandığı süre: bu sürede o firmaya yeniden sorulmaz. */
export const DECLINED_MEMORY_MS = 3 * 3_600_000;
/** Art arda bu kadar ulaşılamayan istekten sonra tur kesilir (Hesap servisi kapalıysa her firma beklenmesin). */
const MAX_CONSECUTIVE_FAILURES = 5;
const DAY_MS = 86_400_000;
const LOCALES: readonly Locale[] = ['tr', 'en'];
/** Taşıyıcı adı ve fatura no postada en çok bu kadar karakter. */
const VALUE_MAX = 40;

/**
 * Fatura bugünkü özete girer mi (Y129). 3 gün kala her zaman. Son güne yakın hatırlatma TEK yuvadır ve yükleme günü belirler:
 * son günden bir önceki günden ÖNCE yüklenen fatura 1 gün kala özetine, o gün ya da sonra yüklenen (`lateUpload`) son gün özetine
 * girer. Böylece fatura "1 gün kala" ile "son gün"den yalnız birinde görünür ve 1 gün kala özeti gittikten sonra yüklenen fatura
 * kaybolmaz. 2 gün kala ve diğer günler: hayır.
 */
export function inDigest(daysLeft: number, lateUpload: boolean): boolean {
  return daysLeft === 3 || (daysLeft === 1 && !lateUpload) || (daysLeft === 0 && lateUpload);
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** O anda firmanın yerel saati (0–23). */
export function localHour(now: Date, timeZone: string): number {
  let f = hourFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(timeZone, f);
  }
  return Number(f.formatToParts(now).find((p) => p.type === 'hour')?.value ?? NaN);
}

/** Firmanın yerel saati gönderim penceresinde mi. */
export function inReminderHours(now: Date, timeZone: string): boolean {
  const h = localHour(now, timeZone);
  return h >= REMINDER_HOURS.from && h < REMINDER_HOURS.to;
}

// ---------- gövde ----------

export type DigestItem = {
  invoiceId: string;
  invoiceNo: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  carrierName: string;
  /** YYYY-MM-DD */
  lastDay: string;
  daysLeft: number;
};

export type DigestInput = {
  companyId: string;
  /** Firmanın takvim günü, YYYY-MM-DD: tekrar anahtarı `ttk:<day>`. */
  day: string;
  items: DigestItem[];
};

/** Kullanıcı verisi: temizlenir; boş kalırsa ya da bağlantıya benziyorsa genel metin. */
function safeValue(raw: string, fallback: string): string {
  const v = cleanNoticeText(raw, VALUE_MAX);
  return v && !NOTICE_LINK_LIKE.test(v) ? v : fallback;
}

/** Kurulan metin Hesap servisinin kuralına uymalı; uymuyorsa gövde kurulmaz (çağıran sayar ve geçer). */
function checked(text: string, max: number): string {
  const v = cleanNoticeText(text, max);
  if (!isNoticePlainText(v, max)) throw new Error('reminder: text breaks the notice rule');
  return v;
}

function rowText(i: DigestItem, locale: Locale): string {
  const params = (carrier: string, invoiceNo: string) => ({ carrier, invoiceNo, invoiceDate: dateLong(i.invoiceDate, locale), lastDay: dateLong(i.lastDay, locale) });
  const carrierFallback = m('mail.ttk.carrierFallback', undefined, locale);
  const invoiceFallback = m('mail.ttk.invoiceFallback', undefined, locale);
  const row = m('mail.ttk.row', params(safeValue(i.carrierName, carrierFallback), safeValue(i.invoiceNo, invoiceFallback)), locale);
  // İki değer yan yana bağlantı biçimi oluşturursa (ör. "http" + ":"): değerler genel metinle yazılır.
  if (isNoticePlainText(cleanNoticeText(row, NOTICE_LIMITS.line), NOTICE_LIMITS.line)) return checked(row, NOTICE_LIMITS.line);
  return checked(m('mail.ttk.row', params(carrierFallback, invoiceFallback), locale), NOTICE_LIMITS.line);
}

/** Son günü en yakın önce; eşitse fatura tarihi, no ve kimlik (aynı girdi her zaman aynı sıra). */
function byDeadline(a: DigestItem, b: DigestItem): number {
  return a.lastDay.localeCompare(b.lastDay) || a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNo.localeCompare(b.invoiceNo) || a.invoiceId.localeCompare(b.invoiceId);
}

function digestText(items: DigestItem[], locale: Locale): NoticeText {
  const urgent = items[0]!;
  const lastDay = dateLong(urgent.lastDay, locale);
  const d = Math.max(0, urgent.daysLeft);
  const n = items.length;
  const subject = d === 0 ? m('mail.ttk.subject.today', { lastDay }, locale) : d === 1 ? m('mail.ttk.subject.tomorrow', { lastDay }, locale) : m('mail.ttk.subject.days', { d, lastDay }, locale);
  const intro = d === 0 ? m('mail.ttk.intro.today', { n }, locale) : d === 1 ? m('mail.ttk.intro.tomorrow', { n }, locale) : m('mail.ttk.intro.days', { d, n }, locale);
  const lines = [checked(intro, NOTICE_LIMITS.line), ...items.slice(0, DIGEST_MAX_ROWS).map((i) => rowText(i, locale))];
  if (n > DIGEST_MAX_ROWS) lines.push(checked(m('mail.ttk.more', { n: n - DIGEST_MAX_ROWS }, locale), NOTICE_LIMITS.line));
  lines.push(checked(m('mail.ttk.legal', undefined, locale), NOTICE_LIMITS.line));
  const one = n === 1;
  const path = one ? links.invoice(urgent.invoiceId) : `${links.invoices}?status=TO_DISPUTE`;
  if (!isNoticeActionPath('deciship', path)) throw new Error('reminder: invalid action path');
  return {
    subject: checked(subject, NOTICE_LIMITS.subject),
    lines,
    action: { label: checked(m(one ? 'mail.ttk.action.one' : 'mail.ttk.action.many', undefined, locale), NOTICE_LIMITS.actionLabel), path },
    footer: checked(m('mail.ttk.footer', undefined, locale), NOTICE_LIMITS.footer),
  };
}

/** Firmanın o günkü özet gövdesi (iki dil). Sözleşmeye uymayan gövde kurulmaz: hata atar, çağıran sayar ve geçer. */
export function buildTtkDigest(input: DigestInput): ProductNoticeBody {
  if (!input.items.length) throw new Error('reminder: empty digest');
  const dedupeKey = `ttk:${input.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !NOTICE_DEDUPE_KEY.test(dedupeKey)) throw new Error('reminder: invalid dedupe key');
  const items = [...input.items].sort(byDeadline);
  const message = Object.fromEntries(LOCALES.map((l) => [l, digestText(items, l)])) as Record<Locale, NoticeText>;
  if (LOCALES.some((l) => message[l].lines.length > NOTICE_LIMITS.linesMax)) throw new Error('reminder: too many lines');
  return { product: 'deciship', orgId: input.companyId, dedupeKey, audience: { permission: REMINDER_PERMISSION }, message };
}

// ---------- süreç içi bellek ----------

/** Süreli anahtar kümesi: anahtar → unutulacağı an. Dolunca önce süresi geçenler, sonra en eskiler gider. */
class ExpiringSet {
  private readonly items = new Map<string, number>();
  constructor(private readonly max: number) {}
  has(key: string, now: number): boolean {
    const until = this.items.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    this.items.delete(key);
    return false;
  }
  add(key: string, until: number, now: number): void {
    if (this.items.size >= this.max) {
      for (const [k, u] of this.items) if (u <= now) this.items.delete(k);
      // hâlâ doluysa en eskiler (Map ekleme sırası) gider: unutulan anahtar yalnız bir yeniden soruya mal olur
      for (const k of this.items.keys()) {
        if (this.items.size < this.max) break;
        this.items.delete(k);
      }
    }
    this.items.delete(key);
    this.items.set(key, until);
  }
  clear(): void {
    this.items.clear();
  }
}

/** Cevabı (`queued` ya da `duplicate`) alınmış özetler: `firma|ttk:<gün>`. Anahtar günü taşıdığı için iki gün yeter. */
const answered = new ExpiringSet(20_000);
const ANSWERED_TTL_MS = 2 * DAY_MS;
/** Firma düzeyinde olumsuz yanıt almış firmalar: `firma` (`DECLINED_MEMORY_MS`). */
const declined = new ExpiringSet(20_000);

/** Testler için: süreç içi belleği boşaltır (yeniden başlatılmış süreç gibi). */
export function clearReminderMemory(): void {
  answered.clear();
  declined.clear();
}

// ---------- tur ----------

/**
 * `disabled`: bildirim adresi yok, hiçbir şey okunmadı. `companies`: kurallara uyan firma. `checked`: incelenen aday fatura.
 * `sent`: Hesap servisi özeti kuyruğa aldı (`queued`). `duplicate`: o günün özeti daha önce işlenmiş (bellekte ya da Hesap'ta).
 * `skipped`: Hesap servisi göndermedi (`no_recipients`, `limited`, `disabled`) ya da firma bu yüzden bellekte bekliyor.
 * `failed`: istek ya da gövde hatası. `planned`: `dryRun`'da gönderilecek özet. `capped`: tur tavanı ya da art arda hata turu kesti.
 */
export type ReminderResult = {
  disabled: boolean;
  companies: number;
  checked: number;
  sent: number;
  duplicate: number;
  skipped: number;
  failed: number;
  planned: number;
  capped: boolean;
};

export const emptyReminderResult = (disabled = false): ReminderResult => ({ disabled, companies: 0, checked: 0, sent: 0, duplicate: 0, skipped: 0, failed: 0, planned: 0, capped: false });

export type ReminderLog = { warn: (obj: unknown, msg: string) => void; error?: (obj: unknown, msg: string) => void };

/** Kuru çalışmada gönderilecek özet (komut satırı yazar). */
export type ReminderPlan = { companyId: string; dedupeKey: string; invoices: number; nearestDaysLeft: number };

export type ReminderOptions = {
  /** Gece penceresini yok say (komut satırı `--now`). */
  ignoreQuietHours?: boolean;
  /** Bildirim gönderme; yalnız say (komut satırında `--send` verilmezse). */
  dryRun?: boolean;
  /** Yalnız bu firma (komut satırı `--company`). */
  companyId?: string;
  log?: ReminderLog;
  /** `dryRun`'da her özet için çağrılır. */
  onPlan?: (plan: ReminderPlan) => void;
  /** Testler için tur tavanı; varsayılan `REMINDER_MAX_PER_RUN`. */
  maxNotices?: number;
};

let disabledLogged = false;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * Bildirim hatasının türü. `reach`: Hesap servisine ulaşılamadı ya da anahtar tutmadı (zaman aşımı, ağ, 5xx, 401): art arda
 * sayılır. `config`: bu süreçte adres ya da anahtar bozuk: tur hemen durur. `rejected`: istek ulaştı ama bu firmanın isteği
 * reddedildi (400, 404, diğer 4xx, yanıt şekli, gövde boyu): sayılmaz, firma bir süre beklemeye alınır.
 */
export function reminderFailureKind(err: unknown): 'reach' | 'config' | 'rejected' {
  if (!(err instanceof NotifyError)) return 'rejected';
  if (err.reason === 'TIMEOUT' || err.reason === 'NETWORK') return 'reach';
  if (err.reason === 'NOT_CONFIGURED' || err.reason === 'NO_SECRET' || err.reason === 'BAD_URL') return 'config';
  if (err.reason === 'HTTP' && err.httpStatus !== null && (err.httpStatus >= 500 || err.httpStatus === 401)) return 'reach';
  return 'rejected';
}

function logError(log: ReminderLog | undefined, obj: unknown, msg: string) {
  if (log?.error) log.error(obj, msg);
  else log?.warn(obj, msg);
}

export async function runDisputeReminders(now: Date = new Date(), opts: ReminderOptions = {}): Promise<ReminderResult> {
  if (!opts.dryRun && !notifyConfigured()) {
    if (!disabledLogged) {
      disabledLogged = true;
      opts.log?.warn({}, 'dispute reminders are off: ACCOUNT_NOTIFY_URL is empty');
    }
    return emptyReminderResult(true);
  }
  const out = emptyReminderResult();
  const max = opts.maxNotices ?? REMINDER_MAX_PER_RUN;
  const nowMs = now.getTime();
  const today = turkeyDate(now);
  const since = new Date(Date.parse(`${today}T00:00:00.000Z`) - REMINDER_LOOKBACK_DAYS * DAY_MS);
  const send = notifier();
  let calls = 0;
  let consecutiveFailures = 0;
  let authLogged = false;

  // Yalnız Company okunur (bakım kapsamının tek açık firma tablosu); sütunlar dar.
  const companies = await withMaintenanceScope(() =>
    prisma.company.findMany({
      // Kapalı firmaya hatırlatma gitmez; geri açılınca kaldığı yerden.
      where: { closedAt: null, ...(opts.companyId ? { id: opts.companyId } : {}) },
      select: { id: true, settings: true, nameVersion: true },
      orderBy: { id: 'asc' },
    }),
  );

  for (const company of companies) {
    if (out.capped) break;
    const s = readSettings(company.settings);
    if (s.disputeReminders === false) continue;
    // deneme turundaki firmanın faturaları örnektir: posta gitmez
    if (s.demo) continue;
    const country = firmCountry(company);
    if (!ttkApplies(country)) continue;
    const timeZone = typeof s.timeZone === 'string' && isTimeZone(s.timeZone) ? s.timeZone : DEFAULT_TIME_ZONE;
    if (!opts.ignoreQuietHours && !inReminderHours(now, timeZone)) continue;
    out.companies++;

    const companyId = company.id;
    const day = zonedDate(now, timeZone);
    const memoryKey = `${companyId}|ttk:${day}`;
    // Bugünün özeti cevaplandıysa ya da firma olumsuz yanıt aldıysa faturalar hiç okunmaz.
    if (!opts.dryRun && answered.has(memoryKey, nowMs)) {
      out.duplicate++;
      continue;
    }
    if (!opts.dryRun && declined.has(companyId, nowMs)) {
      out.skipped++;
      continue;
    }

    const rows = await withCompany(companyId, () =>
      prisma.invoice.findMany({
        where: { companyId, deletedAt: null, isSample: false, invoiceDate: { gte: since } },
        select: { id: true, invoiceNo: true, invoiceDate: true, createdAt: true, totals: true, carrier: { select: { name: true, code: true } }, disputes: { where: activeRoundWhere, select: { id: true } } },
        orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      }),
    );
    // Önce bugünkü özete girecek günler (ucuz, bellekte); gönderilmemiş satır sayımı yalnız onların etkin turlularına (Y30)
    const due = new Map<string, { invoiceDate: string; lastDay: string; daysLeft: number }>();
    for (const r of rows) {
      const invoiceDate = r.invoiceDate.toISOString().slice(0, 10);
      const ttk = disputeDeadlines(invoiceDate, r.carrier.code, today, country)?.ttk;
      if (!ttk || ttk.expired) continue;
      // son güne yakın tek yuva: son günden bir önceki gün ya da sonra yüklenen fatura 1 gün kala yerine son gün özetine girer
      const lateUpload = turkeyDate(r.createdAt) >= prevDay(ttk.lastDay);
      if (!inDigest(ttk.daysLeft, lateUpload)) continue;
      due.set(r.id, { invoiceDate, lastDay: ttk.lastDay, daysLeft: ttk.daysLeft });
    }
    const sentDue = rows.filter((r) => r.disputes.length > 0 && due.has(r.id)).map((r) => r.id);
    const unsent = sentDue.length ? await withCompany(companyId, () => unsentAfterSend(prisma, companyId, sentDue)) : new Map<string, number>();

    const items: DigestItem[] = [];
    for (const r of rows) {
      // etkin turu olan fatura yalnız gönderilmemiş satırı varsa adaydır (Y30); eskiden sorgu hiç getirmezdi
      const sent = r.disputes.length > 0;
      if (sent && !unsent.has(r.id)) continue;
      out.checked++;
      if (!sent) {
        const t = (r.totals ?? {}) as Record<string, unknown>;
        if (num(t.overchargeTotal) <= 0) continue;
        if (num(t.diff) - num(t.acceptedLines) <= 0) continue;
      }
      const d = due.get(r.id);
      if (!d) continue;
      items.push({ invoiceId: r.id, invoiceNo: r.invoiceNo, invoiceDate: d.invoiceDate, carrierName: r.carrier.name, lastDay: d.lastDay, daysLeft: d.daysLeft });
    }
    if (!items.length) continue;

    let body: ProductNoticeBody;
    try {
      body = buildTtkDigest({ companyId, day, items });
    } catch (err) {
      out.failed++;
      opts.log?.warn({ companyId, reason: err instanceof Error ? err.message : 'build' }, 'dispute reminder not built');
      continue;
    }
    if (opts.dryRun) {
      out.planned++;
      opts.onPlan?.({ companyId, dedupeKey: body.dedupeKey, invoices: items.length, nearestDaysLeft: Math.min(...items.map((i) => i.daysLeft)) });
      continue;
    }
    if (calls >= max) {
      out.capped = true;
      opts.log?.warn({ max }, 'dispute reminder run hit its cap; the rest waits for the next run');
      break;
    }
    calls++;
    try {
      const res = await send(body);
      consecutiveFailures = 0;
      if (res.status === 'queued' || res.status === 'duplicate') {
        if (res.status === 'queued') out.sent++;
        else out.duplicate++;
        answered.add(memoryKey, nowMs + ANSWERED_TTL_MS, nowMs);
      } else {
        // disabled, no_recipients, limited: firma düzeyinde; birkaç saat bu firmaya sorulmaz
        out.skipped++;
        declined.add(companyId, nowMs + DECLINED_MEMORY_MS, nowMs);
      }
    } catch (err) {
      out.failed++;
      // yalnız neden ve durum: hata nesnesi (adres, başlık izi) günlüğe yazılmaz
      const detail = err instanceof NotifyError ? { reason: err.reason, httpStatus: err.httpStatus } : { reason: 'UNKNOWN' };
      const kind = reminderFailureKind(err);
      if (kind === 'config') {
        out.capped = true;
        logError(opts.log, detail, 'dispute reminder run stopped: notify address or secret is not usable');
        break;
      }
      if (kind === 'rejected') {
        // bu firmanın isteği: tur sürer, ardışık hata sayılmaz, firma bir süre beklemeye alınır
        declined.add(companyId, nowMs + DECLINED_MEMORY_MS, nowMs);
        opts.log?.warn({ companyId, ...detail }, 'dispute reminder rejected by the account service; company skipped for a while');
        continue;
      }
      consecutiveFailures++;
      opts.log?.warn({ companyId, ...detail }, 'dispute reminder not sent');
      if (detail.httpStatus === 401 && !authLogged) {
        authLogged = true;
        logError(opts.log, { httpStatus: 401 }, 'dispute reminder: PRODUCT_NOTIFY_SECRET does not match the account service (PRODUCT_NOTIFY_SECRETS)');
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        out.capped = true;
        opts.log?.warn({ failures: consecutiveFailures }, 'dispute reminder run stopped after repeated failures');
        break;
      }
    }
  }
  return out;
}
