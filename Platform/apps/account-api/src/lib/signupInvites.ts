/**
 * Kayıt daveti (kullanıcı kararı 2026-11-12: kapalı deneme döneminde kayıt yalnız davetle). `SIGNUP_MODE=invite` iken yeni firma
 * kaydı (`POST /auth/register`) yalnız burada üretilen tek kullanımlık, süreli ve tek e-posta adresine bağlı davetle yapılır.
 * Üretim yalnız destek komutuyla: `scripts/signup-invite.ts` (`npm run signup:invite`). Firmaya ekip daveti (`Invitation`,
 * `routes/join.ts`) bu kuraldan etkilenmez.
 *
 * Bağlantıdaki jetonun yalnız özeti saklanır (`tokenHash`). Denetim izine adres ve jeton yazılmaz; adres davet satırındadır.
 */

import { prisma, type Tx } from '../db.ts';
import { env } from '../env.ts';
import { AppError } from '../errors.ts';
import { writeAudit } from './audit.ts';
import { randomToken, sha256 } from './crypto.ts';
import { emailField } from './schemas.ts';
import { requireOperator } from './support.ts';

export const SIGNUP_INVITE_DAYS_DEFAULT = 14;
export const SIGNUP_INVITE_DAYS_MIN = 1;
export const SIGNUP_INVITE_DAYS_MAX = 90;
const DAY_MS = 86_400_000;

/** Kayıt ucunun gövdesindeki jeton: `randomToken` base64url (43 karakter). Fazlası biçim hatası. */
export const SIGNUP_INVITE_TOKEN_MAX = 200;

export type CreatedSignupInvite = { id: string; email: string; url: string; expiresAt: Date; personExists: boolean };

/**
 * Yeni kayıt daveti. Aynı adrese önceki davetler geçerli kalır (her biri tek kullanımlık; adres de tek hesap açabilir).
 * `personExists`: adresle hesap zaten var; kayıt `EMAIL_TAKEN` alır, komut uyarır.
 */
export async function createSignupInvite(opts: {
  email: string;
  operator: string;
  days?: number;
  lang?: 'tr' | 'en';
  now?: Date;
}): Promise<CreatedSignupInvite> {
  const operator = requireOperator(opts.operator);
  const parsed = emailField.safeParse(opts.email);
  if (!parsed.success) throw new Error(`E-posta adresi geçersiz: ${opts.email}`);
  const email = parsed.data;
  const days = opts.days ?? SIGNUP_INVITE_DAYS_DEFAULT;
  if (!Number.isInteger(days) || days < SIGNUP_INVITE_DAYS_MIN || days > SIGNUP_INVITE_DAYS_MAX) {
    throw new Error(`--days ${SIGNUP_INVITE_DAYS_MIN} ile ${SIGNUP_INVITE_DAYS_MAX} arasında tam sayı olmalı (verilen: ${days}).`);
  }
  const now = opts.now ?? new Date();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  const { invite, personExists } = await prisma.$transaction(async (tx) => {
    const personExists = !!(await tx.person.findUnique({ where: { email }, select: { id: true } }));
    const invite = await tx.signupInvite.create({ data: { email, tokenHash: sha256(token), expiresAt, createdBy: operator } });
    await writeAudit(tx, {
      actor: {},
      action: 'support.signup_invite_created',
      target: invite.id,
      meta: { operator, days, expiresAt: expiresAt.toISOString() },
    });
    return { invite, personExists };
  });
  const lang = opts.lang === 'en' ? '&lang=en' : '';
  return { id: invite.id, email, url: `${env.appBaseUrl}/register?invite=${token}${lang}`, expiresAt, personExists };
}

export type SignupInviteStatus = 'pending' | 'used' | 'expired';
export type SignupInviteRow = { id: string; email: string; status: SignupInviteStatus; createdAt: Date; expiresAt: Date; usedAt: Date | null; createdBy: string };
export const SIGNUP_INVITE_LIST_MAX = 200;

/** Davetler, en yeni önce (jeton ve özeti yok). `email` verilirse yalnız o adres. İptal edilen davet "süresi dolmuş" görünür. */
export async function listSignupInvites(opts: { email?: string; limit?: number; now?: Date } = {}): Promise<SignupInviteRow[]> {
  const now = opts.now ?? new Date();
  const email = opts.email === undefined ? undefined : parseEmail(opts.email);
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > SIGNUP_INVITE_LIST_MAX) throw new Error(`--limit 1 ile ${SIGNUP_INVITE_LIST_MAX} arasında olmalı.`);
  const rows = await prisma.signupInvite.findMany({
    where: email ? { email } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { id: true, email: true, createdAt: true, expiresAt: true, usedAt: true, createdBy: true },
  });
  return rows.map((r) => ({ ...r, status: r.usedAt ? 'used' : r.expiresAt > now ? 'pending' : 'expired' }));
}

/**
 * Adrese ait kullanılmamış, süresi geçmemiş bütün davetleri hemen geçersiz kılar (süresi şimdiye çekilir; yeni sütun yok).
 * Kullanılmış davete ve açılmış hesaba dokunmaz. Dönen sayı iptal edilen davet sayısı; iz `support.signup_invite_revoked`.
 */
export async function revokeSignupInvites(opts: { email: string; operator: string; now?: Date }): Promise<number> {
  const operator = requireOperator(opts.operator);
  const email = parseEmail(opts.email);
  const now = opts.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const open = await tx.signupInvite.findMany({ where: { email, usedAt: null, expiresAt: { gt: now } }, select: { id: true } });
    if (!open.length) return 0;
    await tx.signupInvite.updateMany({ where: { id: { in: open.map((i) => i.id) }, usedAt: null }, data: { expiresAt: now } });
    for (const { id } of open) await writeAudit(tx, { actor: {}, action: 'support.signup_invite_revoked', target: id, meta: { operator } });
    return open.length;
  });
}

function parseEmail(input: string): string {
  const parsed = emailField.safeParse(input);
  if (!parsed.success) throw new Error(`E-posta adresi geçersiz: ${input}`);
  return parsed.data;
}

/** Davet bu adresle şu an kullanılabilir mi (salt okur). Kayıt bunu `EMAIL_TAKEN` denetiminden önce sorar: davetsiz ya da
 * uydurma davetle gelen biri kayıt ucunu "bu adresle hesap var mı" yoklaması için kullanamasın. Asıl harcama `consumeSignupInvite`. */
export async function assertSignupInviteUsable(tx: Tx, token: string, email: string): Promise<void> {
  const found = await tx.signupInvite.findFirst({
    where: { tokenHash: sha256(token), email, usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!found) throw new AppError(403, 'SIGNUP_INVITE_INVALID');
}

/**
 * Kayıt işleminin içinde daveti harcar: jeton doğru, kullanılmamış, süresi geçmemiş ve adres kaydın adresiyle aynı olmalı.
 * Tek koşullu güncelleme: aynı davetle eşzamanlı iki kayıttan yalnız biri geçer. Tutmazsa 403 `SIGNUP_INVITE_INVALID`
 * (neden söylenmez: başkasının davetinin hangi adrese bağlı olduğu bu yoldan öğrenilmesin) ve işlem geri alınır.
 */
export async function consumeSignupInvite(
  tx: Tx,
  input: { token: string; email: string; personId: string; orgId: string; ip?: string | null },
): Promise<void> {
  const now = new Date();
  const tokenHash = sha256(input.token);
  const claimed = await tx.signupInvite.updateMany({
    where: { tokenHash, email: input.email, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now, usedByPersonId: input.personId, orgId: input.orgId },
  });
  if (claimed.count !== 1) throw new AppError(403, 'SIGNUP_INVITE_INVALID');
  const invite = await tx.signupInvite.findUniqueOrThrow({ where: { tokenHash }, select: { id: true } });
  await writeAudit(tx, {
    orgId: input.orgId,
    actor: { personId: input.personId, ip: input.ip ?? null },
    action: 'signup.invite_used',
    target: invite.id,
  });
}
