import type { FastifyReply, FastifyRequest } from 'fastify';
import { COOKIE_REFRESH } from '@sellerondata/contracts';
import { prisma } from '../db.ts';
import { env } from '../env.ts';
import { hasDuplicateCookie } from '../auth.ts';
import { sha256 } from './crypto.ts';
import { familyExpired } from './sessions.ts';

/**
 * Tanıtım sitesinin "kimim" yanıtı (ARCHITECTURE §5 "Tek hesap"). Jeton, kimlik, e-posta, firma kimliği taşımaz:
 * sitedeki betiğin göreceği en az bilgi (ad, firma adı, yönetim bağlantısını gösterip göstermeme).
 */
export type SiteSession = { signedIn: false } | { signedIn: true; name: string; orgName: string | null; canManageOrg: boolean };

export const SIGNED_OUT: SiteSession = Object.freeze({ signedIn: false });

/**
 * Salt okunur yoklama. Yenileme çerezinin (`sod_rt`, Path=/api/account/auth) özetine bakar; hiçbir satıra yazmaz
 * (lastUsedAt dahil), jeton üretmez, aileyi düşürmez, hırsızlık saymaz. Döndürme ve tekrar kuralları yalnız
 * `POST /auth/refresh`te uygulanır: burası bir okuma olduğu için eski jeton yalnız "giriş yapılmamış" der.
 *
 * `signedIn: true` yalnız şu koşulların hepsinde:
 * - istek siteler arası değil (`Sec-Fetch-Site: cross-site` ise yanıt her zaman `signedIn: false`),
 * - tek `sod_rt` çerezi var (yinelenen çerez alt alan adından yazılmış olabilir: hangisinin doğru olduğu bilinemez),
 * - özet eşleşen satır web oturumu ve ailenin başı: döndürülmemiş (tolerans süresi içinde bile), iptal edilmemiş, süresi geçmemiş,
 *   ailesi üst yaşa (`SESSION_MAX_AGE_DAYS`) ulaşmamış (yenileme de o aileye jeton vermez),
 * - kişi askıda değil; `EMAIL_VERIFICATION_REQUIRED` açıksa e-postası doğrulanmış (yenileme de aynı kişiye oturum vermez).
 * `orgName` oturumun etkin firması ve üyelik ACTIVE ise doludur; `canManageOrg` o üyelik OWNER veya ADMIN ise true.
 */
export async function readSiteSession(req: FastifyRequest): Promise<SiteSession> {
  // Seçim: 403 yerine `signedIn: false`. Site her durumda "giriş yapılmamış"a düşer, ayrı hata dalı gerekmez; yanıt bilgi taşımaz.
  if (req.headers['sec-fetch-site'] === 'cross-site') return SIGNED_OUT;
  if (hasDuplicateCookie(req, COOKIE_REFRESH)) return SIGNED_OUT;
  const token = req.cookies?.[COOKIE_REFRESH];
  // `POST /auth/refresh` ile aynı üst sınır: uzun değer özetlenmeden reddedilir.
  if (!token || token.length > 200) return SIGNED_OUT;

  const row = await prisma.session.findUnique({
    where: { refreshHash: sha256(token) },
    select: {
      personId: true,
      activeOrgId: true,
      client: true,
      expiresAt: true,
      familyCreatedAt: true,
      rotatedAt: true,
      revokedAt: true,
      person: { select: { name: true, email: true, emailVerifiedAt: true, suspendedAt: true } },
    },
  });
  if (!row || row.client !== 'web' || row.rotatedAt || row.revokedAt || row.expiresAt <= new Date()) return SIGNED_OUT;
  if (familyExpired(row.familyCreatedAt)) return SIGNED_OUT;
  const person = row.person;
  if (person.suspendedAt) return SIGNED_OUT;
  if (env.emailVerificationRequired && person.email && !person.emailVerifiedAt) return SIGNED_OUT;

  const membership = row.activeOrgId
    ? await prisma.membership.findUnique({
        where: { personId_orgId: { personId: row.personId, orgId: row.activeOrgId } },
        select: { status: true, orgRole: true, org: { select: { name: true, closedAt: true } } },
      })
    : null;
  // Kapalı firma (`closedAt`) etkin firma sayılmaz.
  const active = membership?.status === 'ACTIVE' && !membership.org.closedAt ? membership : null;
  return {
    signedIn: true,
    name: person.name,
    orgName: active?.org.name ?? null,
    canManageOrg: active?.orgRole === 'OWNER' || active?.orgRole === 'ADMIN',
  };
}

/** `Vary` başlığına değer ekler; CORS eklentisinin yazdığı `Origin` silinmez. */
export function appendVary(reply: FastifyReply, ...values: string[]) {
  const current = reply.getHeader('vary');
  const parts = String(current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const value of values) if (!parts.some((p) => p.toLowerCase() === value.toLowerCase())) parts.push(value);
  void reply.header('vary', parts.join(', '));
}
