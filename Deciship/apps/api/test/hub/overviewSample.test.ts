// Merkez Genel Bakış (Y122): deneme turu açıkken overview yanıtı "örnek veri" der; tur yoksa alan hiç gelmez (kayıtlı gerçek yanıtlarla uyum).
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db.ts';
import { getApp, inCompany, registerCompany, uniq } from '../helpers.ts';

const API = '/api/deciship';

/** Bayrağı doğrudan yazar ya da kaldırır (örnek veri yüklemeden; turun kendisi `demoTour.test.ts`'te). */
const setDemoFlag = (companyId: string, on: boolean) =>
  inCompany(companyId, async () => {
    const { settings } = await prisma.company.findFirstOrThrow({ where: { id: companyId }, select: { settings: true } });
    const { demo: _demo, ...rest } = settings as Record<string, unknown>;
    const next = on ? { ...rest, demo: { startedAt: new Date().toISOString(), byMemberId: null } } : rest;
    await prisma.company.update({ where: { id: companyId }, data: { settings: next as object } });
  });

describe('Merkez overview: örnek veri işareti (Y122)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getApp();
  });

  const overview = async (auth: { authorization: string }) => {
    const res = await app.inject({ method: 'GET', url: `${API}/platform/overview`, headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  it('tur açıkken sample: true; tur yoksa ya da bitince alan yok', async () => {
    const a = await registerCompany(app, uniq('Örnek Veri '));
    expect(await overview(a.auth)).not.toHaveProperty('sample');

    await setDemoFlag(a.companyId, true);
    expect((await overview(a.auth)).sample).toBe(true);

    await setDemoFlag(a.companyId, false);
    expect(await overview(a.auth)).not.toHaveProperty('sample');
  });

  it('başka firmanın turu bu firmanın yanıtına sızmaz', async () => {
    const a = await registerCompany(app, uniq('Tur Açık '));
    const b = await registerCompany(app, uniq('Tur Yok '));
    await setDemoFlag(a.companyId, true);
    expect((await overview(a.auth)).sample).toBe(true);
    expect(await overview(b.auth)).not.toHaveProperty('sample');
  });
});
