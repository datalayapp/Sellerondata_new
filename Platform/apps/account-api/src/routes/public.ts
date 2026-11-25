import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ORG_ROLES,
  ORG_ROLE_LABEL,
  PERMISSION_LABEL,
  PRODUCTS,
  PRODUCT_KEYS,
  type CatalogResponse,
  type ClientPolicy,
  type Permission,
} from '@sellerondata/contracts';
import { env } from '../env.ts';
import { localeOf } from '../i18n.ts';
import { keys } from '../lib/keys.ts';
import { productLaunches } from '../lib/launch.ts';

function catalogFor(req: FastifyRequest): CatalogResponse {
  const locale = localeOf(req);
  const launches = productLaunches();
  return {
    locale,
    registrationEnabled: env.registrationEnabled,
    signupMode: env.signupMode,
    mailEnabled: env.mailEnabled,
    products: PRODUCT_KEYS.map((key) => {
      const p = PRODUCTS[key];
      return {
        key,
        name: p.name,
        tagline: p.tagline[locale],
        basePath: p.basePath,
        color: p.color,
        // Firmadan bağımsız: yalnız herkese açık ürün "açık". `pilot` ürünün bir firmada açık olduğu `/me`'den okunur.
        available: launches[key] === 'public',
        launch: launches[key],
        roles: p.roles.map((r) => ({
          key: r.key,
          label: r.label[locale],
          description: r.description[locale],
          permissions: r.permissions,
        })),
      };
    }),
    orgRoles: ORG_ROLES.map((key) => ({ key, label: ORG_ROLE_LABEL[key][locale] })),
    permissions: (Object.keys(PERMISSION_LABEL) as Permission[]).map((key) => ({ key, label: PERMISSION_LABEL[key][locale] })),
  };
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return { keys: keys().publicJwks };
  });

  // Açık uç: eski uygulama da güncelleme ekranını gösterebilsin diye 426 denetiminden muaftır.
  // Önbelleğe alınmaz: telefonun HTTP önbelleği eski kararı tutarsa "Yeniden denetle" yanılır. Sürümler `env`'de katı x.y.z.
  app.get('/client-policy', async (_req, reply): Promise<ClientPolicy> => {
    void reply.header('cache-control', 'no-cache');
    return { mobile: { minVersion: env.minMobileVersion, latestVersion: env.mobileLatestVersion, updateUrl: env.mobileUpdateUrl } };
  });

  app.get('/catalog', async (req, reply) => {
    void reply.header('cache-control', 'public, max-age=300').header('vary', 'Accept-Language');
    return catalogFor(req);
  });
}
