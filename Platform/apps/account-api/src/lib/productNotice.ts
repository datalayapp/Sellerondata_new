/**
 * Araç bildirimi (Mesaj 14 §4.5, `POST /api/account/internal/notify`). Araç kişilerin adresini bilmez: "bu firmada bu izni
 * taşıyanlara bu metni gönder" der; alıcıyı, adresi ve dili Hesap servisi seçer.
 *
 * Güvenlik sınırı:
 * - Kimlik ürün başına anahtardır (`PRODUCT_NOTIFY_SECRETS`). Ürün anahtardan çözülür; gövdedeki `product` onunla aynı olmalı:
 *   bir araç başka aracın adına ya da başka aracın izinleriyle bildirim isteyemez. Karşılaştırma sabit sürelidir, anahtar günlüğe yazılmaz.
 * - İzin `${product}.` ile başlar ve o ürünün kataloğundadır. Eylem yolu `isNoticeActionPath`: yalnız aracın kendi sayfası;
 *   bağlantı burada `APP_BASE_URL + path` ile kurulur, gövdede adres taşınmaz.
 * - Metin düz metindir; denetim karakteri, biçim karakteri (bidi) ve bağlantı biçimi (`http`, `://`, `www.`) reddedilir, HTML'de kaçışlanır.
 * - Alıcı: firmada ACTIVE üyelik, askıda olmayan kişi, doğrulanmış e-posta ve `productAccessFor` ile o üründe izni veren rol.
 *   Aboneliği ACTIVE olmayan (salt okunur, iptal, yok) ya da kapalı üründe posta yok: `disabled`.
 * - Tekrar anahtarı ve firma başına 24 saat tavanı aynı işlemde, firma satırı kilidi altında uygulanır: eşzamanlı istek ikisini de delemez.
 *   Satır yalnız posta kuyruğa girince yazılır; `no_recipients`, `disabled`, `limited` iz bırakmaz (araç sonra yeniden deneyebilir).
 * - Gönderim anı (`sentAt`, Y129): postalar bitince yazılır. Boş ve son denemesi (`attemptedAt`, veritabanı saati) `NOTICE_RESEND_AFTER_MINUTES`'tan
 *   eski satırda, ilk gövdeyle aynı (`bodyHash`) tekrar istek postaları yeniden gönderir; aynı kilit ve koşullu yazım iki kopyanın çift
 *   göndermesini önler. `attemptedAt` ya da `bodyHash` boş satır (eski kod) gönderilmiş sayılır. Teslim en az bir kezdir.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import {
  LOCALES,
  NOTICE_DEDUPE_KEY,
  NOTICE_LIMITS,
  NOTICE_RESEND_AFTER_MINUTES,
  PRODUCTS,
  PRODUCT_KEYS,
  isNoticeActionPath,
  isNoticePlainText,
  type Locale,
  type NoticeText,
  type Permission,
  type ProductKey,
  type ProductNoticeResponse,
} from '@sellerondata/contracts';
import { prisma, Prisma } from '../db.ts';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { productNoticeMail, queueMail, runInBackground } from './mailer.ts';
import { productAccessFor } from './productAccess.ts';
import { loadRoleBook } from './roleBook.ts';

// ---------- Kimlik ----------

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Sunulan anahtarın ürünü; tutmazsa null. Her anahtar özetlenip `timingSafeEqual` ile karşılaştırılır (eşit uzunluk), ilk eşleşmede
 * durulmaz: süre ne eşleşmeye ne uzunluğa ne de sıraya bağlıdır. Harita ürünler arası ortak anahtarı reddeder (`parseNotifySecrets`).
 */
export function productForSecret(presented: string, secrets: ReadonlyMap<ProductKey, string>): ProductKey | null {
  const given = digest(presented);
  let found: ProductKey | null = null;
  for (const [key, secret] of secrets) {
    const match = crypto.timingSafeEqual(given, digest(secret));
    if (match && found === null) found = key;
  }
  return found;
}

/** `authorization: Bearer <anahtar>` (şema adı büyük/küçük harf duyarsız). Başka biçim, boş başlık, birden çok başlık: null. */
export function bearerSecret(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(header.trim());
  return match?.[1] ?? null;
}

// ---------- Gövde ----------

/**
 * Metin kuralı sözleşmededir (`isNoticePlainText`): denetim (CR/LF dahil: konu başlığı), satır/paragraf ayırıcı, biçim (bidi,
 * sıfır genişlik), eşlenmemiş vekil ve bağlantı biçimi (`http`, `://`, `www.`) yok. Araç aynı işlevle göndermeden önce denetler
 * ve kullanıcı verisini `cleanNoticeText` ile temizler: bir firmanın verisi 400 alıp turu bozmasın.
 */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => isNoticePlainText(v, max));

const noticeText = z.strictObject({
  subject: plainText(NOTICE_LIMITS.subject),
  lines: z.array(plainText(NOTICE_LIMITS.line)).min(NOTICE_LIMITS.linesMin).max(NOTICE_LIMITS.linesMax),
  action: z.strictObject({ label: plainText(NOTICE_LIMITS.actionLabel), path: z.string().max(NOTICE_LIMITS.actionPath) }).optional(),
  footer: plainText(NOTICE_LIMITS.footer).optional(),
});

const productKey = z.enum(PRODUCT_KEYS as unknown as [ProductKey, ...ProductKey[]]);

export const noticeBodySchema = z
  .strictObject({
    product: productKey,
    orgId: z.uuid(),
    dedupeKey: z.string().regex(NOTICE_DEDUPE_KEY),
    audience: z.strictObject({ permission: z.string().min(1).max(100) }),
    message: z.strictObject({ tr: noticeText, en: noticeText }),
  })
  .superRefine((body, ctx) => {
    const { product } = body;
    const permission = body.audience.permission;
    if (!permission.startsWith(`${product}.`) || !Object.hasOwn(PRODUCTS[product].permissions, permission)) {
      ctx.addIssue({ code: 'custom', path: ['audience', 'permission'], message: 'invalid_value' });
    }
    for (const locale of LOCALES) {
      const path = body.message[locale].action?.path;
      if (path !== undefined && !isNoticeActionPath(product, path)) {
        ctx.addIssue({ code: 'custom', path: ['message', locale, 'action', 'path'], message: 'invalid_value' });
      }
    }
  });

export type ValidNoticeBody = z.infer<typeof noticeBodySchema>;

// ---------- Gönderim ----------

type Recipient = { email: string; locale: Locale };

/** Eylem bağlantısı: yalnız uygulama kökü + aracın kendi yolu. Yol `isNoticeActionPath`'ten geçmiştir. */
function actionUrl(text: NoticeText): string | null {
  return text.action ? `${env.appBaseUrl}${text.action.path}` : null;
}

/**
 * Yanıt, postaların gönderim denemesi bitene kadar en çok bu kadar bekler (DeciShip istemcisinin 5 sn sınırının altında). Süreç bu
 * arada durursa araç yanıt alamaz, sonraki turda aynı anahtarla yeniden sorar ve yarım kalan gönderim yeniden denenir (`sentAt`).
 * Süre dolarsa yanıt yine `queued` döner, gönderim arka planda sürer.
 */
export const NOTICE_SEND_WAIT_MS = 3_000;

/** Yeniden gönderim koşulu (gövde özeti hariç). `attemptedAt` boşsa satırı bu sütunu bilmeyen eski kod yazmıştır: gönderilmiş sayılır. */
const RESENDABLE_SQL = Prisma.sql`("sentAt" IS NULL AND "attemptedAt" IS NOT NULL AND "attemptedAt" <= now() - make_interval(mins => ${NOTICE_RESEND_AFTER_MINUTES}::int))`;

/** Anahtarları sıralı JSON: aynı gövde her zaman aynı metni verir. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * İlk gövdenin özeti (Y129 incelemesi): hedef izin ve iki dildeki metin. Yeniden gönderim yalnız aynı gövdeyle yapılır; ikinci istek
 * başka metin ya da izin taşırsa `duplicate` (ilk istekte gitmemiş bir metin yeniden gönderim yoluyla gönderilemez). Ürün, firma ve
 * anahtar satırın kendisidir.
 */
export function noticeBodyHash(body: Pick<ValidNoticeBody, 'audience' | 'message'>): string {
  return crypto.createHash('sha256').update(canonicalJson({ permission: body.audience.permission, message: body.message }), 'utf8').digest('hex');
}

type NoticeLog = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

/**
 * Gövde doğrulanmış ve `product` kimlikten gelen ürünle aynı olmalı (çağıran denetler). Postalar işlem bittikten sonra kuyruğa girer;
 * hepsinin denemesi bitince (başarılı ya da kalıcı hatalı) satıra `sentAt` yazılır (Y129). Satır yazılıp süreç postalar bitmeden
 * durursa `sentAt` boş kalır: son denemeden `NOTICE_RESEND_AFTER_MINUTES` sonra aynı anahtarla gelen istek `duplicate` yerine
 * postaları yeniden kuyruğa alır. Yeniden gönderim aynı satırı kullanır (yeni satır yok, `createdAt` değişmez): 24 saat tavanında
 * bir kez sayılmış iletidir, tavan yeniden sorulmaz. Abonelik ve alıcı kuralları yeniden uygulanır.
 */
export async function sendProductNotice(body: ValidNoticeBody, opts: { now?: Date; log?: NoticeLog; sendWaitMs?: number } = {}): Promise<ProductNoticeResponse> {
  const now = opts.now ?? new Date();
  const { product, orgId, dedupeKey } = body;
  const permission = body.audience.permission as Permission;
  const bodyHash = noticeBodyHash(body);

  const outcome = await prisma
    .$transaction(async (tx) => {
      // Abonelik yazarlarıyla aynı kilit (subscriptions.ts `lockOrg`): tavan sayımı, tekrar denetimi ve abonelik okuması tek sırada.
      const locked = await tx.$queryRaw<{ id: string; closedAt: Date | null }[]>`SELECT "id", "closedAt" FROM "platform"."Organization" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;
      if (!locked.length) throw new AppError(404, 'ORG_NOT_FOUND');
      // Kapalı firmaya (`POST /org/close`) posta gitmez: ekip firmaya giremez.
      if (locked[0].closedAt) return { status: 'disabled' as const, recipients: 0, mails: [] as Recipient[], noticeId: null };

      // Yeniden gönderilebilir mi, tek kural ve veritabanı saatiyle (kopyalar arası saat kayması erken göndertmesin):
      // gönderimi bitmemiş, son denemesi eşikten eski, eski kodun yazmadığı (`attemptedAt` dolu) ve gövdesi ilk istekle aynı.
      // Değilse tekrar: gönderilmiş, gönderimi sürüyor (başka kopyada olabilir), eski satır ya da başka metin/izin.
      const [existing] = await tx.$queryRaw<{ id: string; recipients: number; resendable: boolean }[]>`
        SELECT "id", "recipients", COALESCE(${RESENDABLE_SQL} AND "bodyHash" = ${bodyHash}, false) AS "resendable"
        FROM "platform"."ProductNotice"
        WHERE "product" = ${product} AND "orgId" = ${orgId} AND "dedupeKey" = ${dedupeKey}`;
      if (existing && !existing.resendable) {
        return { status: 'duplicate' as const, recipients: existing.recipients, mails: [] as Recipient[], noticeId: null };
      }

      const subscriptions = await tx.subscription.findMany({ where: { orgId } });
      const state = productAccessFor([], subscriptions, { now }).find((s) => s.key === product);
      if (!state?.subscription || state.subscription.status !== 'ACTIVE') return { status: 'disabled' as const, recipients: 0, mails: [], noticeId: null };

      if (!existing) {
        const since = new Date(now.getTime() - NOTICE_LIMITS.windowHours * 3_600_000);
        const recent = await tx.productNotice.count({ where: { orgId, product, createdAt: { gt: since } } });
        if (recent >= NOTICE_LIMITS.perOrgPerDay) return { status: 'limited' as const, recipients: 0, mails: [], noticeId: null };
      }

      const members = await tx.membership.findMany({
        where: {
          orgId,
          status: 'ACTIVE',
          person: { suspendedAt: null, email: { not: null }, emailVerifiedAt: { not: null } },
        },
        select: { productAccess: { select: { product: true, role: true } }, person: { select: { email: true, locale: true } } },
      });
      const mails: Recipient[] = [];
      // Jetonla aynı kural ve aynı rol defteri: kapalı ürün, canlı olmayan abonelik ve geçersiz rol izin vermez; izin firmadaki
      // rolün (özel ya da düzenlenmiş hazır rol) izinlerinden okunur.
      const roles = await loadRoleBook(tx, orgId);
      for (const m of members) {
        const permissions = productAccessFor(m.productAccess, subscriptions, { now, roles }).find((s) => s.key === product)?.permissions ?? [];
        if (m.person.email && permissions.includes(permission)) mails.push({ email: m.person.email, locale: m.person.locale });
      }
      if (!mails.length) return { status: 'no_recipients' as const, recipients: 0, mails: [], noticeId: null };

      if (existing) {
        // Yarım kalmış gönderimi bu istek üstlenir: koşullu yazım, aynı anda gelen ikinci istek (kilitten sonra) `duplicate` alır.
        const count = await tx.$executeRaw`
          UPDATE "platform"."ProductNotice" SET "attemptedAt" = now(), "recipients" = ${mails.length}
          WHERE "id" = ${existing.id} AND ${RESENDABLE_SQL} AND "bodyHash" = ${bodyHash}`;
        if (count === 0) return { status: 'duplicate' as const, recipients: existing.recipients, mails: [] as Recipient[], noticeId: null };
        opts.log?.warn({ product, orgId }, 'ürün bildirimi gönderimi yarım kalmıştı, yeniden gönderiliyor');
        return { status: 'queued' as const, recipients: mails.length, mails, noticeId: existing.id };
      }
      const created = await tx.productNotice.create({
        data: { product, orgId, dedupeKey, recipients: mails.length, createdAt: now, bodyHash },
        select: { id: true },
      });
      // Deneme anı veritabanı saatiyle (eşik denetimiyle aynı saat).
      await tx.$executeRaw`UPDATE "platform"."ProductNotice" SET "attemptedAt" = now() WHERE "id" = ${created.id}`;
      return { status: 'queued' as const, recipients: mails.length, mails, noticeId: created.id };
    })
    .catch(async (err: unknown) => {
      // Kilit sırayı korur; yine de tekil dizin ihlali (ör. kilitsiz bir yazar) tekrar sayılır, 409 değil.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await prisma.productNotice.findUnique({ where: { product_orgId_dedupeKey: { product, orgId, dedupeKey } }, select: { recipients: true } });
        return { status: 'duplicate' as const, recipients: row?.recipients ?? 0, mails: [] as Recipient[], noticeId: null };
      }
      throw err;
    });

  // Bir alıcının postası kurulamazsa kalanlar yine kuyruğa girer; hata adres ve metin olmadan günlüğe yazılır.
  let failed = 0;
  const sends: Promise<void>[] = [];
  for (const r of outcome.mails) {
    try {
      const text = body.message[r.locale];
      sends.push(queueMail(productNoticeMail(r.email, r.locale, text, { product, url: actionUrl(text) })));
    } catch (err) {
      failed++;
      opts.log?.error({ product, orgId, reason: err instanceof Error ? err.name : 'UNKNOWN' }, 'ürün bildirimi postası kurulamadı');
    }
  }
  if (failed) opts.log?.warn({ product, orgId, failed, recipients: outcome.recipients }, 'ürün bildirimi bazı alıcılara kurulamadı');

  const noticeId = outcome.noticeId;
  if (noticeId) {
    // Gönderim bitti: süreç artık ölse de yeniden gönderilmez. Kalıcı hata da "bitti" sayılır (tekrar etmek düzeltmez, öbür alıcılara çift gider).
    const done = Promise.all(sends).then(async () => {
      try {
        await prisma.productNotice.updateMany({ where: { id: noticeId, sentAt: null }, data: { sentAt: new Date() } });
      } catch (err) {
        opts.log?.warn({ product, orgId, reason: err instanceof Error ? err.name : 'UNKNOWN' }, 'ürün bildirimi gönderim anı yazılamadı');
      }
    });
    runInBackground(() => done);
    await waitAtMost(done, opts.sendWaitMs ?? NOTICE_SEND_WAIT_MS);
  }
  return { status: outcome.status, recipients: outcome.recipients };
}

async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
