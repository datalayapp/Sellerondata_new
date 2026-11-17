import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EmailResendResponse } from '@sellerondata/contracts';
import { prisma } from '../db.ts';
import { env } from '../env.ts';
import { AppError, notFound, unauthorized, validation } from '../errors.ts';
import { clearSessionCookies, principalOf, requireAuth, sendSession } from '../auth.ts';
import { writeAudit } from '../lib/audit.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import { normalizeEmail, normalizePhone } from '../lib/identity.ts';
import { emailChangedMail, emailChangeRequestedMail, queueMail } from '../lib/mailer.ts';
import { buildMe } from '../lib/me.ts';
import { bumpPersonEpochs } from '../lib/members.ts';
import { emitMemberUpserted } from '../lib/outbox.ts';
import { enforceRateLimit, RATE_RULES } from '../lib/rateLimit.ts';
import { displayName, emailField, existingPassword, newPassword } from '../lib/schemas.ts';
import { assertPasswordUnchanged, familyHead, lockPerson, revokeAllSessions, revokeFamily } from '../lib/sessions.ts';
import { sendPasswordChangedMail, sendVerificationMail } from './auth.ts';

const patchSchema = z.object({
  name: displayName.optional(),
  locale: z.enum(['tr', 'en']).optional(),
  email: emailField.nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  currentPassword: existingPassword.optional(),
});

export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/me', async (req) => {
    const principal = principalOf(req);
    const me = await buildMe(prisma, principal.personId, principal.claims.org);
    // Jeton üyeliğin gerisinde kaldı: `activeOrg: null` kişiyi "Firma oluşturun" ekranına düşürürdü. İstemci yeniler, yenileme firmayı seçer (§5).
    const behind = me.activeOrg ? me.activeOrg.membershipId !== principal.claims.mid : me.orgs.some((o) => o.status === 'ACTIVE');
    if (behind) throw new AppError(401, 'TOKEN_STALE');
    return me;
  });

  app.patch('/me', async (req, reply) => {
    const principal = principalOf(req);
    const body = patchSchema.parse(req.body);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId } });

    const email = body.email === undefined ? undefined : body.email === null ? null : normalizeEmail(body.email);
    let phone: string | null | undefined;
    if (body.phone === undefined) phone = undefined;
    else if (body.phone === null) phone = null;
    else {
      phone = normalizePhone(body.phone);
      if (!phone) throw validation('phone', 'invalid_phone');
    }
    // Yeni adres hemen yazılmaz, onaya bekler (02-B2): yanlış yazılan ya da başkasının adresi hesabı kaybettirmesin.
    // `email` ve `emailVerifiedAt` onaya kadar değişmez. Adresi kaldırmak (null) bugünkü gibi hemen uygulanır.
    const emailRequested = typeof email === 'string' && email !== person.email;
    const emailRemoved = email === null && person.email !== null;
    const phoneChanged = phone !== undefined && phone !== person.phone;
    // SMS yok: numarayı kanıtlamadan sahiplenmek başkasını davetten kilitlerdi. Telefon yalnız kodlu davet kabulüyle bağlanır. Kaldırmak serbest.
    if (phoneChanged && phone !== null) throw new AppError(403, 'PHONE_CHANGE_NOT_ALLOWED');

    // Kimlik değişimi hesabın anahtarıdır: çalınmış oturumla tek başına yapılamaz.
    if (emailRequested || emailRemoved || phoneChanged) {
      await enforceRateLimit([{ key: `password:person:${person.id}`, rule: RATE_RULES.passwordConfirm }]);
      if (!body.currentPassword) throw validation('currentPassword', 'current_password_required');
      if (!(await verifyPassword(person.passwordHash, body.currentPassword))) throw new AppError(401, 'INVALID_CREDENTIALS');
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Kilit altında: eşzamanlı iki silme son kimliği de götürmesin.
      await lockPerson(tx, person.id);
      const locked = await tx.person.findUniqueOrThrow({ where: { id: person.id } });
      // Onaylanan şifre bu arada değiştiyse kimlik değişimi yapılmaz.
      if ((emailRequested || emailRemoved || phoneChanged) && locked.passwordHash !== person.passwordHash) {
        throw new AppError(401, 'INVALID_CREDENTIALS');
      }
      const nextEmail = emailRemoved ? null : locked.email;
      const nextPhone = phoneChanged ? phone : locked.phone;
      if (!nextEmail && !nextPhone) throw validation('email', 'contact_required');
      // Telefon ancak doğrulanmış e-posta varken kaldırılır: doğrulanmamış (yanlış yazılmış olabilir) ya da yalnız bekleyen adres
      // giriş yolu değildir, kişi tek kapısını kaybederdi. E-postayı kaldırmak telefon varken serbest (değişmez).
      if (phoneChanged && phone === null && !(nextEmail && locked.emailVerifiedAt)) throw validation('phone', 'contact_required');
      if (emailRemoved && (await tx.membership.count({ where: { personId: person.id, orgRole: 'OWNER' } })) > 0) {
        throw new AppError(409, 'OWNER_REQUIRES_EMAIL');
      }
      // Bekleyen adres benzersiz değildir; başkasının mevcut adresi istenemez (onayda yeniden denetlenir).
      if (emailRequested) {
        const owner = await tx.person.findUnique({ where: { email: email as string }, select: { id: true } });
        if (owner && owner.id !== person.id) throw new AppError(409, 'EMAIL_TAKEN');
      }
      // Önceki bekleyen adrese giden bağlantılar ölür: art arda iki değişiklikte eski bağlantı yenisini onaylayamaz.
      if ((emailRequested || email === null) && locked.pendingEmail) {
        await tx.oneTimeToken.deleteMany({ where: { personId: person.id, kind: 'EMAIL_VERIFY', usedAt: null, email: locked.pendingEmail } });
      }
      const next = await tx.person.update({
        where: { id: person.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(emailRequested ? { pendingEmail: email } : {}),
          // Kaldırma bekleyen adresi de temizler.
          ...(email === null ? { pendingEmail: null } : {}),
          ...(emailRemoved ? { email: null, emailVerifiedAt: null } : {}),
          ...(phoneChanged ? { phone } : {}),
        },
      });
      if (emailRemoved) {
        // Kaldırılan adrese giden bağlantılar geçersiz: hesabı geri alma yolu olarak kalmasın.
        await tx.oneTimeToken.deleteMany({ where: { personId: person.id, usedAt: null } });
      }
      if (body.name !== undefined && body.name !== person.name) {
        // Ad değişimi yetki değişimi değil: epoch artmaz, projeksiyon güncellenir.
        const memberships = await tx.membership.findMany({ where: { personId: person.id }, select: { id: true } });
        for (const m of memberships) await emitMemberUpserted(tx, m.id);
      }
      if (emailRemoved || phoneChanged) {
        await writeAudit(tx, {
          actor: { personId: person.id, ip: req.ip },
          action: 'person.identity_changed',
          target: person.id,
          meta: { email: emailRemoved, phone: phoneChanged },
        });
      }
      if (emailRequested) {
        await writeAudit(tx, { actor: { personId: person.id, ip: req.ip }, action: 'person.email_change_requested', target: person.id });
      }
      return next;
    });

    // Onay bağlantısı yeni adrese. Eski adrese hemen "istek yapıldı" haberi (Y37): oturumu çalınan sahip onaydan önce öğrenir ve
    // Profil'de vazgeçer. "Değişti" postası onay anında ayrıca gider (`verify-email`). Şifre onayı kovası (`passwordConfirm`) bu
    // postayı da sınırlar.
    if (emailRequested && updated.pendingEmail) {
      sendVerificationMail(updated.id, updated.pendingEmail, updated.locale, { purpose: 'change' });
      if (updated.email) queueMail(emailChangeRequestedMail(updated.email, updated.locale, `${env.appBaseUrl}/login`));
    }
    if (emailRemoved && person.email) queueMail(emailChangedMail(person.email, person.locale, `${env.appBaseUrl}/login`));

    const head = await familyHead(prisma, principal.familyId);
    if (!head) throw unauthorized();
    // Jetondaki ad ve dil hemen yenilensin. Yenileme jetonu değişmez. Web'de dil çerezi de burada yazılır.
    return sendSession(reply, { person: updated, session: head, refreshToken: null });
  });

  /** Doğrulama bağlantısını yeniden gönderir: bekleyen adres varsa ona, yoksa doğrulanmamış mevcut adrese. */
  app.post('/me/email/resend', async (req): Promise<EmailResendResponse> => {
    const principal = principalOf(req);
    await enforceRateLimit([{ key: `verify:mail:${principal.personId}`, rule: RATE_RULES.verifyMailPerson }]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId } });
    // Sınır yukarıda 429 ile sayıldı: arka plandaki gönderim aynı kovayı ikinci kez saymaz.
    if (person.pendingEmail) {
      sendVerificationMail(person.id, person.pendingEmail, person.locale, { purpose: 'change', limited: false });
      return { ok: true, sentTo: 'pending' };
    }
    if (person.email && !person.emailVerifiedAt) {
      sendVerificationMail(person.id, person.email, person.locale, { limited: false });
      return { ok: true, sentTo: 'current' };
    }
    return { ok: true, sentTo: null };
  });

  /** Bekleyen e-posta değişikliğinden vazgeçer. Tekrar çağrılabilir. */
  app.delete('/me/pending-email', async (req) => {
    const principal = principalOf(req);
    await prisma.$transaction(async (tx) => {
      await lockPerson(tx, principal.personId);
      const person = await tx.person.findUniqueOrThrow({ where: { id: principal.personId }, select: { pendingEmail: true } });
      if (!person.pendingEmail) return;
      await tx.oneTimeToken.deleteMany({
        where: { personId: principal.personId, kind: 'EMAIL_VERIFY', usedAt: null, email: person.pendingEmail },
      });
      await tx.person.update({ where: { id: principal.personId }, data: { pendingEmail: null } });
    });
    return { ok: true };
  });

  app.post('/me/password', async (req, reply) => {
    const principal = principalOf(req);
    await enforceRateLimit([{ key: `password:person:${principal.personId}`, rule: RATE_RULES.passwordConfirm }]);
    const body = z.object({ currentPassword: existingPassword, newPassword }).parse(req.body);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: principal.personId } });
    if (!(await verifyPassword(person.passwordHash, body.currentPassword))) throw new AppError(401, 'INVALID_CREDENTIALS');
    const passwordHash = await hashPassword(body.newPassword);

    const head = await prisma.$transaction(async (tx) => {
      await assertPasswordUnchanged(tx, person.id, person.passwordHash);
      await tx.person.update({ where: { id: person.id }, data: { passwordHash } });
      await tx.oneTimeToken.deleteMany({ where: { personId: person.id, kind: 'PASSWORD_RESET', usedAt: null } });
      await revokeAllSessions(tx, person.id, principal.familyId);
      await bumpPersonEpochs(tx, person.id);
      await writeAudit(tx, { actor: { personId: person.id, ip: req.ip }, action: 'person.password_changed', target: person.id });
      return familyHead(tx, principal.familyId);
    });
    if (!head) throw unauthorized();
    // Oturumu çalınmış hesabın sahibi şifresinin değiştiğini hemen öğrensin (04-B9). Değişim işlemi bitti; posta arka planda.
    sendPasswordChangedMail(person);
    // Bu oturumun jetonu da bayatladı: yeni erişim jetonu verilir, oturum kapanmaz.
    return sendSession(reply, { person, session: head, refreshToken: null, includeMe: false });
  });

  app.get('/me/sessions', async (req) => {
    const principal = principalOf(req);
    const rows = await prisma.session.findMany({
      where: { personId: principal.personId, rotatedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        client: s.client,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        current: s.familyId === principal.familyId,
      })),
    };
  });

  app.delete('/me/sessions/:id', async (req, reply) => {
    const principal = principalOf(req);
    const { id } = req.params as { id: string };
    const row = await prisma.session.findFirst({ where: { id, personId: principal.personId }, select: { familyId: true } });
    if (!row) throw notFound();
    await prisma.$transaction(async (tx) => {
      const revoked = await revokeFamily(tx, row.familyId);
      // Zaten kapalı aile yeniden kapatılınca epoch artmaz: tekrarlanan istek diğer cihazları boşuna yenilemesin.
      if (revoked === 0) return;
      // Çalınmış cihaz kapatılıyor: ürünlerdeki açık erişim jetonu da hemen düşsün. Diğer oturumlar sessizce yenilenir.
      await bumpPersonEpochs(tx, principal.personId);
      await writeAudit(tx, { actor: { personId: principal.personId, ip: req.ip }, action: 'session.revoked', target: id });
    });
    if (row.familyId === principal.familyId) clearSessionCookies(reply);
    return { ok: true };
  });
}

