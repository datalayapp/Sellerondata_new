import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '../src/db.ts';
import { createTestAccount, makeApp } from './helpers.ts';

/**
 * Varsayılan reddet: kayıtlı her rota kimliksiz istekte 401 döner; açık yollar yalnız listedekiler. Yeni rota (G2, G3, G4) kendi
 * kancası olmadan eklenirse bu test kırılır. Olay alıcısı (G4) imzalı jetonla korunur; eklenince açık listeye gerekçesiyle yazılır.
 */
// Olay alıcısı kimlik başlığı istemez: gövdedeki imzalı olay jetonuyla korunur (jetonsuz 400 INVALID_EVENT, test/events.test.ts).
const OPEN = new Set(['GET /api/ai/health', 'POST /api/ai/internal/events']);

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp(await createTestAccount());
});
afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('rota tablosu', () => {
  it('açık yollar dışında her rota kimliksiz 401', async () => {
    const routes = app.sodRoutes.filter((r) => !OPEN.has(r));
    expect(routes.length).toBeGreaterThan(3);
    for (const r of routes) {
      const [method, url] = r.split(' ') as [string, string];
      const res = await app.inject({ method: method as 'GET', url: url.replace(/:(\w+)/g, 'anthropic') });
      expect(res.statusCode, r).toBe(401);
    }
  });

  it('sağlık ucu açık; bilinmeyen Merkez yolu 404 (platform biçimi)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ai/health' })).json()).toEqual({ ok: true });
    const res = await app.inject({ method: 'GET', url: '/api/ai/yok' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
