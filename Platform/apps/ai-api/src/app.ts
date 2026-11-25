import Fastify, { type FastifyInstance } from 'fastify';
import { createJwksClient, type JwksClient } from '@sellerondata/auth-kit';
import type { Writable } from 'node:stream';
import { env } from './env.ts';
import { getPrisma, type PrismaClient } from './db.ts';
import { registerErrorHandling } from './errors.ts';
import { createPlatformAuth, type PlatformAuth } from './auth/platform.ts';
import { internalScope, type InternalRoutes } from './internal/scope.ts';
import { createProviderProbe, type ProviderProbe } from './keystore/probe.ts';
import { registerSecret, scrubSecrets } from './keystore/scrub.ts';
import { KeyStore } from './keystore/store.ts';
import { adminKeyRoutes } from './routes/admin-keys.ts';
import { proxyRoutes } from './proxy/routes.ts';
import { createLimits, type Limits } from './limits/index.ts';
import { internalStatusRoutes } from './routes/internal-status.ts';
import { allowanceRoutes } from './routes/allowance.ts';
import { spendRoutes } from './routes/spend.ts';
import { adminRoutes } from './routes/admin.ts';
import { eventRoutes } from './routes/events.ts';
import { createMaintenance } from './maintenance/index.ts';

/**
 * Geçidin bağımlılıkları: rotalar (G1 anahtar, G2 vekil, G3 tavan, G4 Merkez) buradan alır. Testler sahtesini verir.
 */
export type AppDeps = {
  prisma: PrismaClient;
  keys: KeyStore;
  probe: ProviderProbe;
  jwks: JwksClient;
  /** Merkez uçlarının kancaları: `authenticate` → `requireOperator` → `requireStepUp` (auth/platform.ts). */
  auth: PlatformAuth;
  /** Yukarı akış ve sınama çağrıları (testte sahte sağlayıcı). */
  fetch: typeof fetch;
  /** Tavanlar, pay, hız (G3, limits/index.ts). Verilmezse gerçek tavanlar; testte `allowAll` ya da sahte. */
  limits?: Limits;
};

export type BuildAppOptions = {
  logger?: boolean;
  /** Günlük hedefi (test yakalayıcısı). Verilmezse standart çıktı. */
  logStream?: Writable;
  logLevel?: string;
  prisma?: PrismaClient;
  jwks?: JwksClient;
  /** JWKS getirme (testte sahte Hesap). */
  jwksFetch?: typeof fetch;
  /** Sağlayıcı çağrıları (testte sahte sağlayıcı). */
  fetch?: typeof fetch;
  probe?: ProviderProbe;
  /** Ek araç yolları (test). Kalıcı araç yolları aşağıdaki listeye yazılır. */
  internalRoutes?: (deps: AppDeps) => InternalRoutes[];
  /** Tavanlar (G3). Verilmezse `createLimits` (gerçek tavanlar, defterden). */
  limits?: Limits;
  /** G4 bakım turu aralığı, ms (0: kapalı). Verilmezse 1 saat; testte (`NODE_ENV=test`) kapalı. */
  maintenanceEveryMs?: number;
};

/** Araç yollarının kökü (`AI_GATEWAY_PATHS`'in hepsi bununla başlar). */
export const INTERNAL_PREFIX = '/internal';

/** Yol sorgu dizgesi günlüğe yazılmaz (araç yanlışlıkla `?key=` gönderse de düşmesin). */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q < 0 ? url : `${url.slice(0, q)}?…`;
}

function loggerOptions(opts: BuildAppOptions) {
  if (!opts.logger) return false;
  return {
    level: opts.logLevel ?? 'info',
    ...(opts.logStream ? { stream: opts.logStream } : {}),
    // İstekten yalnız yöntem, yol ve adres; başlık (anahtar, jeton, çerez) ve gövde hiç yazılmaz.
    serializers: {
      req(req: { method: string; url: string; ip?: string }) {
        return { method: req.method, url: safeUrl(req.url), remoteAddress: req.ip };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
    redact: {
      paths: ['headers', 'body', 'key', 'token', 'req.headers', 'req.body', 'err.config', 'err.headers', 'err.request', 'err.response'],
      censor: '[gizli]',
    },
    // İkinci kat: bilinen gizli değerler ve anahtar biçimleri satır yazılmadan önce silinir (keystore/scrub.ts).
    hooks: { streamWrite: scrubSecrets },
  };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const hops = env.trustProxyHops;
  const app = Fastify({
    logger: loggerOptions(opts),
    // Merkez uçlarında küçük gövde; vekil yolları kendi sınırını rotada verir (AI_LIMIT_DEFAULTS.maxBodyBytes).
    bodyLimit: 64 * 1024,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });

  registerErrorHandling(app);

  // Varsayılan reddet testi rota listesini buradan alır: listedeki açık yollar dışında her uç kimlik ister.
  const routes: string[] = [];
  app.decorate('sodRoutes', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routes.push(`${method} ${route.url}`);
  });

  // Postgres metinde NUL kabul etmez: 500 yerine 400.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.includes('%00')) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Bad request' } });
  });

  const prisma = opts.prisma ?? getPrisma();
  const fetchImpl = opts.fetch ?? fetch;
  const jwks = opts.jwks ?? createJwksClient({ url: env.jwksUrl, fetch: opts.jwksFetch, onRefreshError: (err) => app.log.warn({ errName: (err as Error)?.name }, 'JWKS tazelenemedi') });
  const probe = opts.probe ?? createProviderProbe({ baseUrls: () => env.providerBaseUrls, fetch: fetchImpl });
  const keys = new KeyStore({
    prisma,
    ring: () => env.keyRing,
    probe,
    onSealError: (info) => app.log.error(info, 'anahtar mührü açılamadı (AI_KEY_MASTER / AI_KEY_MASTER_PREVIOUS)'),
  });
  const auth = createPlatformAuth({ jwks, allowedOrigins: () => env.allowedOrigins });
  const limits = opts.limits ?? createLimits({ prisma });
  const deps: AppDeps = { prisma, keys, probe, jwks, auth, fetch: fetchImpl, limits };
  app.decorate('aiDeps', deps);
  // Jetonlar açılışta bir kez okunur (assertConfig doğruladı); günlük süzgecine girer.
  const toolTokens = env.toolTokens;
  for (const t of toolTokens.values()) registerSecret(t);

  // ---------- Açık uçlar (kimliksiz): yalnız bunlar ----------
  app.get('/api/ai/health', async () => ({ ok: true }));

  // ---------- Merkez uçları (Hesap erişim jetonu) ----------
  adminKeyRoutes(app, deps);
  // G4: harcama görünümü, yönetici tavan ve durum uçları, olay alıcısı (`/api/ai/internal/events`, imzalı), bakım turu.
  spendRoutes(app, { prisma, auth });
  adminRoutes(app, { prisma, auth, keys });
  eventRoutes(app, { prisma, jwks });
  const maintenance = createMaintenance({ prisma, log: app.log, everyMs: opts.maintenanceEveryMs });
  app.addHook('onReady', async () => maintenance.start());
  app.addHook('onClose', async () => maintenance.stop());

  // ---------- Araç yolları (araç jetonu; yalnız iç ağ) ----------
  const internalRoutes: InternalRoutes[] = [
    ...(opts.internalRoutes?.(deps) ?? []),
    // G3: GET /internal/status, GET /internal/allowance (testin verdiği aynı adresli yol önce kaydolur, bunlar onu atlar).
    internalStatusRoutes({ prisma, keys }),
    allowanceRoutes({ prisma }),
    // G2: vekil (Anthropic messages, count_tokens; Gemini generateContent, streamGenerateContent); testin verdiği aynı adresli yol önce kaydolur, vekil onu atlar.
    proxyRoutes(deps),
  ];
  await app.register(internalScope, { prefix: INTERNAL_PREFIX, tokens: () => toolTokens, routes: internalRoutes });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    sodRoutes: string[];
    aiDeps: AppDeps;
  }
}
