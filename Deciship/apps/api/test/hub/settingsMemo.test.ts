/**
 * 19-B14: Merkez isteğinde firma ayarı istek başına bir kez okunur (`limited` kapsamı); kapsam dışında her çağrı okur.
 * Analiz isteği aynı ayarı en az altı kez okuyordu.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPrisma, withCompany } from '../../src/db.ts';
import { companySettings, withSettingsMemo } from '../../src/services/hub/metrics.ts';
import { getApp, registerCompany } from '../helpers.ts';

describe('firma ayarı istek başına bir kez', () => {
  let companyId = '';
  let auth: { authorization: string };

  beforeAll(async () => {
    const app = await getApp();
    const admin = await registerCompany(app, 'Ayar Belleği');
    companyId = admin.companyId;
    auth = admin.auth;
  });
  afterEach(() => vi.restoreAllMocks());

  it('kapsam içinde tek okuma, aynı sonuç; kapsam dışında her çağrı okur', async () => {
    const spy = vi.spyOn(getPrisma().company, 'findFirst');
    const inScope = await withCompany(companyId, () => withSettingsMemo(() => Promise.all([companySettings(companyId), companySettings(companyId), companySettings(companyId)])));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(inScope[1]).toEqual(inScope[0]);
    spy.mockClear();
    const outside = await withCompany(companyId, async () => [await companySettings(companyId), await companySettings(companyId)]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(outside[0]).toEqual(inScope[0]);
  });

  it('Analiz isteği firma ayarını bir kez okur', async () => {
    const app = await getApp();
    const spy = vi.spyOn(getPrisma().company, 'findFirst');
    const r = await app.inject({ method: 'GET', url: '/api/deciship/platform/analytics', headers: auth });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    const settingsReads = spy.mock.calls.filter(([arg]) => JSON.stringify((arg as { select?: unknown } | undefined)?.select) === JSON.stringify({ settings: true })).length;
    expect(settingsReads).toBe(1);
  });
});
