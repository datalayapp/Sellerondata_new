import type { FastifyInstance } from 'fastify';
import { createToolResolver, providerOfPath, routePathOf, toolAuthHook } from '../auth/tool.ts';
import type { ProductKey } from '@sellerondata/contracts';

/**
 * Araç yolları kapsamı (`/internal`, yalnız iç ağ; gateway `internal` geçen yolu dışarıya 404 yapar). Kapsamdaki HER rota ve kapsamın
 * 404 yanıtı araç jetonu ister (`toolAuthHook`): kanca kapsama bağlıdır, yol kodlanarak (`/%69nternal/…`) gelse de eşleşen rotada
 * çalışır. Rotalar bu kapsama `InternalRoutes` ile eklenir (vekil G2, durum ve hak G3); kapsam dışına araç yolu yazılmaz.
 * İzin listesi: kapsamda kayıtlı olmayan yol jetonlu istekte de 404 (sağlayıcı biçiminde), yukarı akışa hiçbir şey gitmez.
 */
export type InternalRoutes = (scope: FastifyInstance) => void | Promise<void>;

export type InternalScopeOptions = {
  tokens: () => ReadonlyMap<ProductKey, string>;
  routes: readonly InternalRoutes[];
};

export async function internalScope(scope: FastifyInstance, opts: InternalScopeOptions) {
  scope.addHook('onRequest', toolAuthHook(createToolResolver(opts.tokens)));
  scope.setNotFoundHandler((req, reply) => {
    void reply.header('cache-control', 'no-store');
    if (providerOfPath(routePathOf(req)) === 'gemini') {
      return reply.status(404).send({ error: { code: 404, message: 'path not allowed by gateway', status: 'NOT_FOUND' } });
    }
    return reply.status(404).send({ type: 'error', error: { type: 'not_found_error', message: 'path not allowed by gateway' } });
  });
  for (const register of opts.routes) await register(scope);
}
