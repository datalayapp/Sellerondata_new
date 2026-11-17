import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.ts';
import { can } from '../lib/access.ts';
import { firmCountry, readOnboarding, readSettings, settingsFor } from '../lib/settings.ts';
import { aiEnabled } from '../services/ai.ts';
import { aiAllowance } from '../services/aiMeter.ts';
import { onboardingFlags, setupFacts } from '../services/onboarding.ts';

/** Son görülme bu sıklıktan fazla yazılmaz. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

/**
 * Y62-E3: ekranların kota dolunca yapay zekâ seçeneğini kapatması için. Tutar ya da yüzde yok (ölçüm rolü de okur; harcamayı dolaylı
 * sızdırmamak için yalnız iki bayrak). `quotaExhausted`: kota uygulanıyor ve bu ayki hak ya da sonuç vermeyen çağrı tavanı doldu, yani yeni
 * çağrı 429 `AI_QUOTA_EXCEEDED` alır (`assertAiQuota` ile aynı kural). Anahtar yoksa veritabanına gidilmez.
 */
async function aiState(companyId: string, available: boolean, limits: Record<string, number | boolean>) {
  if (!available) return { available, quotaExhausted: false };
  const a = await aiAllowance(companyId, limits);
  return {
    available,
    quotaExhausted: a.enforced && (a.exhausted || a.failedExhausted),
  };
}

/** DeciShip'e özel durum: ayarlar ve kurulum. Kişi, rol ve izinler Hesap'ın `GET /api/account/me` ucundadır. */
export async function meRoutes(app: FastifyInstance) {
  /** Ölçüm listesindeki kişi süzgeci. Yönetim Hesap'tadır, burada yalnız kim ve ad. Ayrılan üye de vardır: eski ölçümleri listede. */
  app.get('/members', { onRequest: app.requirePermission('deciship.measurements.view_all') }, async (req) => {
    const items = await prisma.member.findMany({ where: { companyId: req.auth.orgId }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return { items };
  });

  app.get('/me', { onRequest: app.authenticate }, async (req) => {
    const { orgId, membershipId, name } = req.auth;
    const company = await prisma.company.findFirstOrThrow({ where: { id: orgId } });
    const settings = readSettings(company.settings);
    const now = new Date();
    await prisma.member.updateMany({
      where: { id: membershipId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_RESOLUTION_MS) } }] },
      data: { lastSeenAt: now },
    });
    // ilk kurulum: yalnız ayar yetkisi olana (web yönlendirmesi ve Pano bandı için)
    const onboarding = can(req, 'deciship.settings.manage')
      ? onboardingFlags(readOnboarding(settings.onboarding), await setupFacts(orgId, settings))
      : undefined;
    const aiAvailable = aiEnabled();
    return {
      member: { id: membershipId, name },
      company: { id: company.id, name: company.name, settings: settingsFor(req, settings, firmCountry(company)) },
      aiAvailable,
      ai: await aiState(orgId, aiAvailable, req.auth.subscription?.limits ?? {}),
      ...(onboarding ? { onboarding } : {}),
    };
  });
}
