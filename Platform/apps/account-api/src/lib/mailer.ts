import nodemailer from 'nodemailer';
import { defangLinkText, foldLinkText, PRODUCTS, type Locale, type NoticeText, type ProductKey } from '@sellerondata/contracts';
import { prisma } from '../db.ts';
import { env } from '../env.ts';

export type MailMessage = { to: string; template: string; subject: string; text: string; html: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

type MailLogger = { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };

/** Tek denemenin üst sınırı. Yöneticinin isteği de en çok bu kadar bekler. */
const SEND_TIMEOUT_MS = 8000;
/** İlk deneme + iki yeniden deneme. */
const RETRY_DELAYS_MS = [2000, 8000];

class MailTimeoutError extends Error {}
class MailDisabledError extends Error {}

export type MailErrorClass = 'timeout' | 'connection' | 'temporary_rejection' | 'rejected' | 'auth' | 'tls' | 'not_configured' | 'unknown';
export type MailFailure = { errorClass: MailErrorClass; transient: boolean; code?: string; responseCode?: number };

const CONNECTION_CODES = new Set(['ECONNECTION', 'EDNS', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Hata sınıfı ve yeniden denemeye değer mi. Günlüğe yalnız bu gider: nodemailer'ın iletisi ve yanıtı alıcıyı ya da bağlantıyı taşıyabilir.
 * Bilinmeyen hata geçici sayılmaz: tekrar etmek düzeltmez.
 */
export function classifyMailError(err: unknown): MailFailure {
  if (err instanceof MailTimeoutError) return { errorClass: 'timeout', transient: true };
  if (err instanceof MailDisabledError) return { errorClass: 'not_configured', transient: false };
  const raw = err as { code?: unknown; responseCode?: unknown } | null | undefined;
  const code = typeof raw?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(raw.code) ? raw.code : undefined;
  const responseCode = typeof raw?.responseCode === 'number' ? raw.responseCode : undefined;
  const known = { ...(code ? { code } : {}), ...(responseCode ? { responseCode } : {}) };
  if (code === 'EAUTH' || code === 'ENOAUTH') return { errorClass: 'auth', transient: false, ...known };
  if (responseCode && responseCode >= 400 && responseCode < 500) return { errorClass: 'temporary_rejection', transient: true, ...known };
  if (responseCode && responseCode >= 500) return { errorClass: 'rejected', transient: false, ...known };
  if (code === 'ETIMEDOUT') return { errorClass: 'timeout', transient: true, ...known };
  if (code && CONNECTION_CODES.has(code)) return { errorClass: 'connection', transient: true, ...known };
  if (code === 'ETLS') return { errorClass: 'tls', transient: false, ...known };
  return { errorClass: 'unknown', transient: false, ...known };
}

/** Süreyi aşan denemenin soketi de kapansın (nodemailer varsayılanı dakikalarca bekler). Adreste yazan değer kazanır. */
function smtpUrlWithTimeouts(url: string) {
  try {
    const parsed = new URL(url);
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, String(SEND_TIMEOUT_MS));
    }
    return parsed.href;
  } catch {
    return url;
  }
}

class SmtpMailer implements Mailer {
  private transport;
  constructor(url: string) {
    this.transport = nodemailer.createTransport(smtpUrlWithTimeouts(url));
  }
  async send(message: MailMessage) {
    await this.transport.sendMail({
      from: env.mailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

/** SMTP yok. Geliştirmede MailLog + günlük (bağlantıyla). Üretimde içerik yazılmaz: bağlantı parola sıfırlama yetkisidir. */
class LogMailer implements Mailer {
  constructor(private log?: MailLogger) {}
  async send(message: MailMessage) {
    if (env.isProduction) throw new MailDisabledError();
    await prisma.mailLog.create({
      data: { to: message.to, template: message.template, subject: message.subject, body: message.text },
    });
    this.log?.info({ to: message.to, subject: message.subject, body: message.text }, 'geliştirme postası');
  }
}

let mailer: Mailer | undefined;
let logger: MailLogger | undefined;
let sendTimeoutMs = SEND_TIMEOUT_MS;
let retryDelaysMs = RETRY_DELAYS_MS;
const pending = new Set<Promise<void>>();

export function configureMailer(opts: { log?: MailLogger; mailer?: Mailer; sendTimeoutMs?: number; retryDelaysMs?: number[] } = {}) {
  logger = opts.log;
  mailer = opts.mailer ?? (env.smtpUrl ? new SmtpMailer(env.smtpUrl) : new LogMailer(opts.log));
  sendTimeoutMs = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
}

/** Tek deneme, süre sınırıyla. Hata atmaz. Süre dolduktan sonra posta yine de çıkabilir: "gönderilemedi" denmiş postanın gelmesi zararsızdır. */
async function attemptSend(message: MailMessage): Promise<MailFailure | null> {
  mailer ??= env.smtpUrl ? new SmtpMailer(env.smtpUrl) : new LogMailer(logger);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MailTimeoutError()), sendTimeoutMs);
    });
    await Promise.race([mailer.send(message), expired]);
    return null;
  } catch (err) {
    return classifyMailError(err);
  } finally {
    clearTimeout(timer);
  }
}

function logFailure(message: MailMessage, failure: MailFailure, attempt: number, text: string) {
  const { transient: _transient, ...detail } = failure;
  logger?.warn({ operation: message.template, attempt, ...detail }, text);
}

/** İsteğin sonucu bu gönderime bağlıysa: tek deneme, gerçek sonuç. Yöneticinin elinde bağlantı olduğu için istek içinde yeniden denenmez. */
export async function sendMailNow(message: MailMessage): Promise<boolean> {
  const failure = await attemptSend(message);
  if (failure) logFailure(message, failure, 1, 'e-posta gönderilemedi');
  return failure === null;
}

async function deliverWithRetry(message: MailMessage) {
  for (let attempt = 1; ; attempt += 1) {
    const failure = await attemptSend(message);
    if (!failure) return;
    const wait = retryDelaysMs[attempt - 1];
    if (!failure.transient || wait === undefined) {
      logFailure(message, failure, attempt, 'e-posta gönderilemedi');
      return;
    }
    logFailure(message, failure, attempt, 'e-posta yeniden denenecek');
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Arka planda gönderir, yanıtı bekletmez. Hem SMTP gecikmesi isteği yavaşlatmaz
 * hem de "şifremi unuttum" yanıt süresi kimliğin varlığını ele vermez.
 * Geçici hatada süreç içinde sınırlı yeniden denenir. Jeton yalnız bellekteki iletide durur: süreç yeniden başlarsa posta kaybolabilir (ARCHITECTURE, Posta).
 * Dönen söz gönderim denemesi bitince (başarılı ya da kalıcı hatalı) çözülür, hiç reddedilmez; bekleyen çağıran yalnız araç bildirimidir (`sentAt`).
 */
export function queueMail(message: MailMessage): Promise<void> {
  const sending = deliverWithRetry(message).finally(() => pending.delete(sending));
  pending.add(sending);
  return sending;
}

/** Yanıtı beklemeyen iş. Hata günlüğe gider. */
export function runInBackground(work: () => Promise<void>) {
  const running = work()
    .catch((err) => logger?.warn({ err }, 'arka plan işi başarısız'))
    .finally(() => pending.delete(running));
  pending.add(running);
}

/** Kapanışta ve testte kuyruğun boşalmasını bekler. Arka plan işi yeni posta ekleyebilir: boşalana kadar sürer. */
export async function flushMail() {
  while (pending.size) await Promise.all(pending);
}

/** Kapanışta: en çok bu kadar bekler, kalan iş sayısını döner. Yeniden deneme bekleyen posta süreci açık tutmasın. */
export async function drainMail(timeoutMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([flushMail(), new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  clearTimeout(timer);
  return pending.size;
}

// ---------- Şablonlar ----------

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** `action` yalnız araç bildiriminde boş olabilir (düğmesiz ileti); hesap postalarının hepsi bağlantı taşır. */
function render(subject: string, lines: string[], action: { label: string; url: string } | null, footer: string) {
  const text = [...lines, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', footer, '', 'SellerOnData'].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f1b2d;line-height:1.5">',
    ...lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    ...(action ? [`<p><a href="${escapeHtml(action.url)}" style="color:#1d5bd8">${escapeHtml(action.label)}</a></p>`] : []),
    `<p style="color:#5b6b82;font-size:13px">${escapeHtml(footer)}</p>`,
    '<p style="color:#5b6b82;font-size:13px">SellerOnData</p>',
    '</body></html>',
  ].join('');
  return { subject, text, html };
}

export function passwordResetMail(to: string, locale: Locale, url: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Reset your SellerOnData password',
          ['We received a request to reset your password. The link works for one hour.'],
          { label: 'Reset password', url },
          'If you did not ask for this, you can ignore this email. Your password stays the same.',
        )
      : render(
          'SellerOnData şifrenizi yenileyin',
          ['Şifrenizi yenilemek için istek aldık. Bağlantı bir saat geçerlidir.'],
          { label: 'Şifreyi yenile', url },
          'Bu isteği siz yapmadıysanız e-postayı yok sayın. Şifreniz değişmez.',
        );
  return { to, template: 'password_reset', ...content };
}

export function emailVerifyMail(to: string, locale: Locale, url: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Confirm your email address',
          ['Confirm this email address for your SellerOnData account. The link works for seven days.'],
          { label: 'Confirm email', url },
          'If you did not create this account, you can ignore this email.',
        )
      : render(
          'E-posta adresinizi doğrulayın',
          ['SellerOnData hesabınız için bu e-posta adresini doğrulayın. Bağlantı yedi gün geçerlidir.'],
          { label: 'E-postayı doğrula', url },
          'Bu hesabı siz açmadıysanız e-postayı yok sayın.',
        );
  return { to, template: 'email_verify', ...content };
}

/** Yeni adrese: değişikliği onaylamak için. Onaylanana kadar eski adres geçerli kalır. */
export function emailChangeVerifyMail(to: string, locale: Locale, url: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Confirm your new email address',
          ['Open the link to change the email address of your SellerOnData account to this one. The link works for seven days. Your old address stays active until you confirm.'],
          { label: 'Confirm address', url },
          'If you did not ask for this, ignore this email; nothing changes in your account.',
        )
      : render(
          'Yeni e-posta adresinizi doğrulayın',
          ['SellerOnData hesabınızın e-posta adresini bu adresle değiştirmek için bağlantıyı açın. Bağlantı yedi gün geçerlidir. Onaylayana kadar eski adresiniz geçerli kalır.'],
          { label: 'Adresi doğrula', url },
          'Bu isteği siz yapmadıysanız e-postayı yok sayın; hesabınızda değişiklik olmaz.',
        );
  return { to, template: 'email_change_verify', ...content };
}

/**
 * Eski adrese, değişiklik İSTENİNCE (Y37): oturumu çalınmış hesabın sahibi onaydan önce öğrensin ve Profil'de vazgeçebilsin.
 * Yeni adresi ve onay bağlantısını içermez; tek bağlantı giriş sayfası.
 */
export function emailChangeRequestedMail(to: string, locale: Locale, loginUrl: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'A change to your SellerOnData email address was requested',
          ['Someone asked to change the email address of your SellerOnData account. This address stays active until the new address is confirmed.'],
          { label: 'Sign in', url: loginUrl },
          'If you did not ask for this, sign in, cancel the change on the Profile page and change your password.',
        )
      : render(
          'SellerOnData e-posta adresinizi değiştirme isteği',
          ['SellerOnData hesabınızın e-posta adresini değiştirmek için istek yapıldı. Yeni adres onaylanana kadar bu adres geçerli kalır.'],
          { label: 'Giriş yap', url: loginUrl },
          'Bu isteği siz yapmadıysanız giriş yapın, Profil ekranında değişiklikten vazgeçin ve şifrenizi değiştirin.',
        );
  return { to, template: 'email_change_requested', ...content };
}

/** Eski adrese: hesap ele geçirildiyse sahibi öğrensin. Yeni adres ve bağlantı içermez. */
export function emailChangedMail(to: string, locale: Locale, loginUrl: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Your SellerOnData email address was changed',
          ['The email address of your SellerOnData account was changed. This address no longer receives account messages.'],
          { label: 'Sign in', url: loginUrl },
          'If you did not do this, contact your company admin right away.',
        )
      : render(
          'SellerOnData e-posta adresiniz değiştirildi',
          ['SellerOnData hesabınızın e-posta adresi değiştirildi. Bu adres artık hesap iletisi almaz.'],
          { label: 'Giriş yap', url: loginUrl },
          'Bu işlemi siz yapmadıysanız hemen firma yöneticinize başvurun.',
        );
  return { to, template: 'email_changed', ...content };
}

/**
 * Şifre değişince ya da yenilenince kişinin adresine (04-B9): oturumu çalınmış hesabın sahibi hemen öğrensin. Bağlantı yalnız
 * "şifremi unuttum" sayfasıdır, jeton taşımaz. Zaman bilgisi kişinin saat dilimi bilinmediği için yazılmaz; posta anında gider.
 */
export function passwordChangedMail(to: string, locale: Locale, forgotUrl: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Your SellerOnData password was changed',
          ['The password of your SellerOnData account was just changed. Your other devices were signed out.'],
          { label: 'Reset password', url: forgotUrl },
          'If you did not do this, reset your password now with this link and tell your company admin.',
        )
      : render(
          'SellerOnData şifreniz değiştirildi',
          ['SellerOnData hesabınızın şifresi az önce değiştirildi. Diğer cihazlarınızdaki oturumlar kapatıldı.'],
          { label: 'Şifremi yenile', url: forgotUrl },
          'Bu işlemi siz yapmadıysanız bu bağlantıyla şifrenizi hemen yenileyin ve firma yöneticinize haber verin.',
        );
  return { to, template: 'password_changed', ...content };
}

/**
 * Giriş kilidi bilgisi (04-B6): kişinin hesabına çok sayıda hatalı şifre denendi. Günde en çok bir posta. Kişi daha önce giriş
 * yaptığı ağdan girmeye devam eder; yeni bir yerden giremiyorsa şifresini yenileyince kilit kalkar. Bağlantı jeton taşımaz.
 */
export function loginLockedMail(to: string, locale: Locale, forgotUrl: string): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'Many failed sign-in attempts on your SellerOnData account',
          [
            'Someone tried to sign in to your SellerOnData account with a wrong password many times. For your safety, sign-ins from new places are paused for a while.',
            'You can still sign in from a network you used before. If you cannot sign in, reset your password: the pause ends with it.',
          ],
          { label: 'Reset password', url: forgotUrl },
          'If these attempts were yours, you do not need to do anything. Your password has not been changed.',
        )
      : render(
          'SellerOnData hesabınıza çok sayıda hatalı giriş denemesi',
          [
            'SellerOnData hesabınıza çok sayıda yanlış şifreyle giriş denendi. Güvenliğiniz için yeni yerlerden giriş bir süre durduruldu.',
            'Daha önce giriş yaptığınız ağdan girmeye devam edebilirsiniz. Giremiyorsanız şifrenizi yenileyin: durdurma da kalkar.',
          ],
          { label: 'Şifremi yenile', url: forgotUrl },
          'Denemeler sizinse bir şey yapmanıza gerek yok. Şifreniz değiştirilmedi.',
        );
  return { to, template: 'login_locked', ...content };
}

/**
 * Posta gövdesinde ad 60 karakterde kesilir; uzun ad metin gizlemek için kullanılamaz. Ad bağlantı olmaktan çıkarılır (Y36):
 * "kargo.com" posta istemcisinde tıklanır bağlantıya dönmesin diye "kargo. com" yazılır; tam genişlik karakter katlanır. Saklanan ad değişmez.
 */
function clipName(value: string): string {
  const chars = [...foldLinkText(value)];
  // Üç nokta katlamadan SONRA eklenir: NFKC onu "..." yapar.
  return chars.length > 60 ? `${defangLinkText(chars.slice(0, 60).join(''))}…` : defangLinkText(chars.join(''));
}

export function invitationMail(to: string, locale: Locale, data: { orgName: string; inviterName: string; url: string }): MailMessage {
  const content =
    locale === 'en'
      ? render(
          'You have been invited to a company on SellerOnData',
          [`“${clipName(data.inviterName)}” invited you to join “${clipName(data.orgName)}” on SellerOnData. The link works for seven days.`],
          { label: 'Accept invitation', url: data.url },
          'If you were not expecting this, you can ignore this email.',
        )
      : render(
          'SellerOnData üzerinde bir firmaya davet edildiniz',
          [`“${clipName(data.inviterName)}” sizi SellerOnData üzerinde “${clipName(data.orgName)}” firmasına davet etti. Bağlantı yedi gün geçerlidir.`],
          { label: 'Daveti kabul et', url: data.url },
          'Bu daveti beklemiyorsanız e-postayı yok sayın.',
        );
  return { to, template: 'invitation', ...content };
}

/**
 * Araç bildirimi (`POST /internal/notify`, Mesaj 14 §4.5). Metin aracındır ve düz metindir: `render` HTML'e kaçışlar, biçim işareti
 * yorumlanmaz. Bağlantı çağıranın kurduğu `APP_BASE_URL + path`'tir; gövdeden adres alınmaz. Dipnot verilmezse sabit kaynak satırı.
 */
export function productNoticeMail(to: string, locale: Locale, text: NoticeText, opts: { product: ProductKey; url: string | null }): MailMessage {
  const name = PRODUCTS[opts.product].name;
  // Aracın metni faturadan gelen değer taşıyabilir (taşıyıcı adı, fatura numarası): tam genişlikli ya da çıplak alan adı posta
  // istemcisinde tıklanır bağlantıya dönmesin (03-B6). Ad kuralıyla aynı etkisizleştirme (`defangLinkText`, katlayarak).
  const footer = text.footer
    ? defangLinkText(text.footer)
    : locale === 'en'
      ? `You received this email from ${name} on SellerOnData.`
      : `Bu e-postayı SellerOnData üzerindeki ${name} aracından aldınız.`;
  const action = text.action && opts.url ? { label: defangLinkText(text.action.label), url: opts.url } : null;
  return {
    to,
    template: `product_notice:${opts.product}`,
    ...render(defangLinkText(text.subject), text.lines.map(defangLinkText), action, footer),
  };
}
