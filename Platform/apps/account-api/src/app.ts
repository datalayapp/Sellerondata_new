import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { CLIENT_HEADER, CSRF_HEADER, ORG_HEADER, isBelowMinimum, parseClientHeader } from '@sellerondata/contracts';
import { env } from './env.ts';
import { originKind, registerAuthHooks } from './auth.ts';
import { AppError, registerErrorHandling } from './errors.ts';
import { initKeys } from './lib/keys.ts';
import { authRoutes } from './routes/auth.ts';
import { internalRoutes } from './routes/internal.ts';
import { joinRoutes } from './routes/join.ts';
import { meRoutes } from './routes/me.ts';
import { operatorRoutes } from './routes/operator.ts';
import { orgRoutes } from './routes/org.ts';
import { publicRoutes } from './routes/public.ts';

/** Uygulama kökeni (ALLOWED_ORIGINS): bugünkü tam yetki. `origin: true` isteğin kökenini geri yazar. */
const APP_CORS = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'authorization', 'accept-language', CSRF_HEADER, ORG_HEADER],
};
/** Site kökeni (SITE_ORIGINS): yalnız yoklama ve çıkış. Bearer, firma başlığı ve gövde türü izinli değil. */
const SITE_CORS = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['accept-language', CSRF_HEADER],
};

/** 426 denetiminden muaf yollar: istemci güncelleme adresini ve sağlık durumunu her sürümde okuyabilmeli. */
const UPGRADE_EXEMPT = new Set(['/api/account/client-policy', '/api/account/health', '/api/account/catalog', '/api/account/.well-known/jwks.json']);

/** Davet bağlantısı yolda jeton taşır: günlüğe düşmesin. */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/(\/invites\/)[^/?#]+/, '$1[gizli]');
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  await initKeys();
  const hops = env.trustProxyHops;

  const app = Fastify({
    logger: opts.logger
      ? {
          serializers: {
            req(req) {
              return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip };
            },
          },
        }
      : false,
    // Hesap ucunda büyük gövde yok.
    bodyLimit: 64 * 1024,
    // Yalnız bilinen vekil sayısı kadar güvenilir. `true` olsaydı X-Forwarded-For'un istemcinin yazdığı sol ucu okunur, hız sınırı atlatılırdı.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });

  registerErrorHandling(app);

  // §11 yetki matrisi testi rota listesini buradan alır: tabloya girmeyen uç test kırar.
  const routes: string[] = [];
  app.decorate('sodRoutes', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routes.push(`${method} ${route.url}`);
    }
  });

  // Postgres metinde NUL kabul etmez: 500 yerine 400. Yolda ve gövdede erken kesilir.
  app.addHook('onRequest', async (req) => {
    if (req.url.includes('%00')) throw new AppError(400, 'BAD_REQUEST');
  });
  // Mobil uygulamanın desteklenmeyen sürümü: 426. Başlık yoksa ya da bozuksa denetim yok (web, curl, eski APK etkilenmez).
  // Oturuma dokunmaz: çerez silinmez, kayıt yazılmaz. Politika ucu ve sağlık/katalog/anahtar uçları muaf.
  app.addHook('onRequest', async (req) => {
    const min = env.minMobileVersion;
    if (!min) return;
    const client = parseClientHeader(req.headers[CLIENT_HEADER.toLowerCase()] as string | undefined);
    if (!client || !isBelowMinimum(client.version, min)) return;
    if (UPGRADE_EXEMPT.has(req.url.split('?')[0]!)) return;
    throw new AppError(426, 'UPGRADE_REQUIRED', { minVersion: min, updateUrl: env.mobileUpdateUrl });
  });
  // Gövdesiz POST/DELETE'te JSON başlığı olan istemci 400 almasın. Dolu gövde Fastify'ın güvenli ayrıştırıcısından geçer.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, undefined);
    // Tek sayıda ters bölü gerçek kaçıştır; çifti düz metindir ve şifrede geçebilir.
    if (/(^|[^\\])(\\\\)*\\u0000/.test(body as string)) return done(new AppError(400, 'VALIDATION'));
    return parseJson(req, body as string, done);
  });

  await app.register(cookie);
  // CORS kararı istek başına, rotanın yapılandırmasından: site kökeni yalnız `siteOrigin` işaretli uçta yanıt başlığı alır.
  // Ön uçuşta rota, uca kardeş kaydedilen OPTIONS rotasıdır (routes/auth.ts `sitePreflight`): işaret orada da durur.
  await app.register(cors, {
    delegator: (req, cb) => {
      const kind = originKind(req);
      if (kind === 'app') return cb(null, APP_CORS);
      if (kind === 'site') return cb(null, SITE_CORS);
      // İzinsiz köken: hiçbir CORS başlığı yazılmaz, ön uçuş 404'e düşer. `Vary: Origin` yine yazılır (önbellek karışmasın).
      return cb(null, { origin: false });
    },
  });
  registerAuthHooks(app);

  // Jeton, kod, kişi verisi taşıyan yanıtlar önbelleğe girmez. Açık uçlar kendi başlığını koyar.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
  });

  await app.register(
    async (api) => {
      await api.register(publicRoutes);
      await api.register(authRoutes);
      await api.register(joinRoutes);
      await api.register(meRoutes);
      await api.register(orgRoutes);
      // Platform yöneticisi (adım artırma; yapay zekâ geçidinin yönetici uçları için).
      await api.register(operatorRoutes);
      // Araç → Hesap iç uçları (ürün anahtarıyla; gateway'de 404).
      await api.register(internalRoutes);
    },
    { prefix: '/api/account' },
  );

  return app;
}
