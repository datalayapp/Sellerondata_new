import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, fakeToken, openTestDb, type TestDb } from './helpers';
import { migrate } from '../src/queue/schema';

let db: TestDb;
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
// İstemci sürümü `expo-constants`ten okunur (Mesaj 13); yerel modül Node'da yüklenemez.
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('../src/queue/db', () => ({
  kvGet: async (key: string) => {
    const row = (await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key as never)) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  },
  kvSet: async (key: string, value: unknown) => {
    await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key as never, JSON.stringify(value) as never);
  },
}));

import type { MeResponse } from '@sellerondata/contracts';
import { currentSessionScope, hasSession, onSessionChanged, productFetch, setServerUrl, setTokens } from '../src/api/client';
import { cacheOwnedBy, createHubCache } from '../src/hub/cache';
import { APP_ROUTES } from '../src/hub/links';
import { createSessionCacheGuard, sessionOwnerKey } from '../src/hub/sessionGuard';
import { clearHubCache, hubCache } from '../src/hub/store';

const AYSE_A = fakeToken({ sub: 'ayse', org: 'firmaA' });
const AYSE_B = fakeToken({ sub: 'ayse', org: 'firmaB' });
const MEHMET_A = fakeToken({ sub: 'mehmet', org: 'firmaA' });

function me(personId: string, orgId: string): MeResponse {
  return {
    person: { id: personId, name: personId, email: null, phone: null, locale: 'tr', emailVerified: false },
    orgs: [{ id: orgId, name: orgId, orgRole: 'OWNER', status: 'ACTIVE' }],
    activeOrg: { id: orgId, name: orgId, country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm' },
    products: [],
  };
}

/** Uygulamanın yeniden açılması: bellek boş, yalnız diskteki kayıt okunur. */
async function reopen() {
  const fresh = createHubCache({
    get: async () => {
      const row = (await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'hub.cache.v1' as never)) as { value: string } | null;
      return row ? JSON.parse(row.value) : null;
    },
    set: async () => undefined,
  });
  await fresh.load();
  return fresh;
}

const REVENUE = 'ayse:firmaA:overview';

/** AuthContext'in kurduğu bağlantının aynısı. */
function startSession() {
  const guard = createSessionCacheGuard(sessionOwnerKey, clearHubCache);
  const off = onSessionChanged(() => guard.onChange());
  return { guard, off };
}

async function seedAyse() {
  hubCache.bind('ayse|firmaA', me('ayse', 'firmaA'));
  hubCache.write(REVENUE, { ciro: 123456 });
  await hubCache.settled();
}

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
  await clearHubCache();
  await hubCache.settled();
  await setServerUrl('http://gw:8088');
  await setTokens(AYSE_A, 'rt1');
});

describe('Merkez önbelleği: çıkış sonrası başka kişi önceki kişinin verisini görmez', () => {
  it('önkoşul: çıkış olmadan veri diskte duruyor ve aynı kişi çevrimdışı okur', async () => {
    await seedAyse();
    const again = await reopen();
    expect(again.lastMe()?.person.id).toBe('ayse');
    expect(again.read(REVENUE)?.data).toEqual({ ciro: 123456 });
  });

  it('çıkış: kişi, kayıtlar ve disk boş; sonraki kişi çevrimdışı hiçbir şey görmez', async () => {
    const { guard, off } = startSession();
    guard.arm();
    await seedAyse();

    await setTokens(null, null);
    await hubCache.settled();
    off();

    expect(hubCache.lastMe()).toBeNull();
    expect(hubCache.read(REVENUE)).toBeNull();
    const nextPerson = await reopen();
    expect(nextPerson.lastMe()).toBeNull();
    expect(nextPerson.read(REVENUE)).toBeNull();
  });

  it('zorunlu çıkış (yenileme 401) da siler', async () => {
    const { guard, off } = startSession();
    guard.arm();
    await seedAyse();
    vi.stubGlobal('fetch', async () => errorResponse(401, 'UNAUTHORIZED'));
    await productFetch('deciship', '/x');
    vi.unstubAllGlobals();
    await hubCache.settled();
    off();
    expect(hasSession()).toBe(false);
    expect((await reopen()).read(REVENUE)).toBeNull();
  });

  it('hesap değişimi siler', async () => {
    const { guard, off } = startSession();
    guard.arm();
    await seedAyse();
    await setTokens(MEHMET_A, 'rt9');
    await hubCache.settled();
    off();
    const again = await reopen();
    expect(again.lastMe()).toBeNull();
    expect(again.read(REVENUE)).toBeNull();
  });

  it('firma değişimi siler', async () => {
    const { guard, off } = startSession();
    guard.arm();
    await seedAyse();
    await setTokens(AYSE_B, 'rt1');
    await hubCache.settled();
    off();
    expect((await reopen()).read(REVENUE)).toBeNull();
  });

  it('jeton yenilemesi aynı kişi + firmada silmez', async () => {
    const { guard, off } = startSession();
    guard.arm();
    await seedAyse();
    await setTokens(fakeToken({ sub: 'ayse', org: 'firmaA', ep: 5 }), 'rt2');
    await hubCache.settled();
    off();
    expect((await reopen()).read(REVENUE)?.data).toEqual({ ciro: 123456 });
  });

  it('açılış: oturum varsa çevrimdışı veri korunur, oturum yoksa silinir (Beni hatırla kapalı)', async () => {
    await seedAyse();
    const withSession = createSessionCacheGuard(sessionOwnerKey, clearHubCache);
    withSession.arm();
    await hubCache.settled();
    expect((await reopen()).read(REVENUE)?.data).toEqual({ ciro: 123456 });

    await setTokens(null, null);
    const noSession = createSessionCacheGuard(sessionOwnerKey, clearHubCache);
    noSession.arm();
    await hubCache.settled();
    expect((await reopen()).lastMe()).toBeNull();
  });

  it('yolda kalan yazma çıkıştan sonra veriyi geri getirmez', async () => {
    await seedAyse();
    const since = hubCache.generation();
    await clearHubCache();
    hubCache.write(REVENUE, { ciro: 999 }, since);
    await hubCache.settled();
    expect(hubCache.read(REVENUE)).toBeNull();
    expect((await reopen()).read(REVENUE)).toBeNull();
  });

  it('yolda kalan okuma temizlenen veriyi belleğe geri yüklemez', async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = createHubCache({ get: () => new Promise((r) => (release = r)), set: async () => undefined });
    const loading = slow.load();
    await slow.clear();
    release({ scope: 'ayse|firmaA', me: me('ayse', 'firmaA'), entries: { x: { at: 1, data: 1 } } });
    await loading;
    expect(slow.lastMe()).toBeNull();
    expect(slow.read('x')).toBeNull();
  });

  it('sahipsiz kayıt yeni kişiye taşınmaz', async () => {
    hubCache.write('sahipsiz', { ciro: 1 });
    hubCache.bind('mehmet|firmaA', me('mehmet', 'firmaA'));
    expect(hubCache.read('sahipsiz')).toBeNull();
  });

  it('temizlik başarısız olsa da çevrimdışı gösterim sahibini denetler', () => {
    expect(cacheOwnedBy(me('ayse', 'firmaA'), { personId: 'ayse', orgId: 'firmaA' })).toBe(true);
    expect(cacheOwnedBy(me('ayse', 'firmaA'), { personId: 'mehmet', orgId: 'firmaA' })).toBe(false);
    expect(cacheOwnedBy(me('ayse', 'firmaA'), { personId: 'ayse', orgId: 'firmaB' })).toBe(false);
    expect(cacheOwnedBy(me('ayse', 'firmaA'), null)).toBe(false);
    expect(cacheOwnedBy(null, { personId: 'ayse', orgId: 'firmaA' })).toBe(false);
    expect(currentSessionScope()).toEqual({ personId: 'ayse', orgId: 'firmaA' });
  });

  it('AuthContext koruyucuyu bağlıyor', () => {
    const src = readFileSync('src/auth/AuthContext.tsx', 'utf8');
    expect(src).toContain('hubCacheGuard.onChange()');
    expect(src).toContain('hubCacheGuard.arm()');
    expect(src.match(/clearHubCache\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Merkez derin bağlantıları', () => {
  it('ölçüm ekranları DeciShip sekmesinde', () => {
    expect(APP_ROUTES.measurements).toBe('/deciship/history');
    expect(APP_ROUTES.measurement('a/b')).toBe('/deciship/measurement/a%2Fb');
  });
});
