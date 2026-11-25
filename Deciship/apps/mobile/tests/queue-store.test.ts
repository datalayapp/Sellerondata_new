import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, SCHEMA_VERSION } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));

import {
  countUnsent,
  deletableOtherSessions,
  deleteOtherSessions,
  deleteUnsent,
  dueRows,
  findUnsentByTracking,
  getRow,
  insertRow,
  markSending,
  markSent,
  pendingByOrg,
  recoverInterrupted,
  reinsertRow,
  rowExists,
  rowsSince,
  summarizeOtherSessions,
  unsentGroups,
  updateUnsent,
} from '../src/queue/store';
import type { MeasurementPayload } from '../src/api/endpoints';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const ayseB = { personId: 'ayse', orgId: 'firmaB' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };

const payload = (clientId: string, trackingRaw = `TRK-${clientId}`): MeasurementPayload => ({
  clientId,
  trackingRaw,
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightKg: 1,
  dimMethod: 'MANUAL',
  weightMethod: 'MANUAL',
  measuredAt: new Date().toISOString(),
  photoKinds: [],
});

const add = (scope: typeof ayseA, clientId: string, tracking?: string) => insertRow(scope, { clientId, data: payload(clientId, tracking), photos: [] });

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

describe('şema göçü', () => {
  it('eski tabloya sütun ekler, eski satırı silmez, sahipsiz bırakır', async () => {
    const old = openTestDb();
    old.raw.exec(`
      CREATE TABLE queue (clientId TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL, data TEXT NOT NULL, photos TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL DEFAULT 0, lastError TEXT, serverId TEXT, createdAt INTEGER NOT NULL, sentAt INTEGER);
      CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO kv VALUES ('me', '{}'), ('presets', '[]'), ('kalsin', '1');
    `);
    old.raw
      .prepare(`INSERT INTO queue (clientId, userId, data, photos, status, createdAt) VALUES ('eski', 'u1', ?, '[]', 'PENDING', 1)`)
      .run(JSON.stringify(payload('eski')));

    await migrate(old);

    const row = old.raw.prepare('SELECT * FROM queue').get() as { clientId: string; personId: unknown; orgId: unknown };
    expect(row.clientId).toBe('eski');
    expect(row.personId).toBeNull();
    expect(row.orgId).toBeNull();
    expect((old.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((old.raw.prepare('SELECT key FROM kv').all() as { key: string }[]).map((k) => k.key)).toEqual(['kalsin']);

    db = old;
    expect(await dueRows(ayseA, true, true)).toEqual([]);
    expect(summarizeOtherSessions(await unsentGroups(), ayseA, 'ayse')).toEqual({ samePerson: 0, otherPerson: 1, total: 1 });
  });

  it('iki kez çalışınca bozulmaz', async () => {
    await add(ayseA, 'c1');
    await migrate(db);
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual(['c1']);
  });

  it('yarıda kalmış göçü tamamlar (sütun var, sürüm yok)', async () => {
    const half = openTestDb();
    half.raw.exec(`CREATE TABLE queue (clientId TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL, data TEXT NOT NULL, photos TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL DEFAULT 0, lastError TEXT, serverId TEXT, createdAt INTEGER NOT NULL, sentAt INTEGER, personId TEXT);`);
    await migrate(half);
    const names = (half.raw.prepare('PRAGMA table_info(queue)').all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain('orgId');
  });
});

describe('kapsam: kayıt yalnız kişi + firma sahibine görünür', () => {
  beforeEach(async () => {
    await add(ayseA, 'a1');
    await add(ayseB, 'b1');
    await add(mehmetA, 'm1');
  });

  it('dueRows yalnız sahibin kaydını verir (store.ts:40 hatası)', async () => {
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual(['a1']);
    expect((await dueRows(ayseB, true)).map((r) => r.clientId)).toEqual(['b1']);
    expect((await dueRows(mehmetA, false, true)).map((r) => r.clientId)).toEqual(['m1']);
    expect(await dueRows({ personId: 'yabanci', orgId: 'firmaA' }, true, true)).toEqual([]);
  });

  it('aynı firmada başka kişi, aynı kişide başka firma görmez', async () => {
    expect((await rowsSince(ayseA, 0)).map((r) => r.clientId)).toEqual(['a1']);
    expect(await getRow(mehmetA, 'a1')).toBeNull();
    expect(await getRow(ayseB, 'a1')).toBeNull();
    expect((await getRow(ayseA, 'a1'))?.clientId).toBe('a1');
  });

  it('sayımlar kapsamlıdır', async () => {
    expect(await countUnsent(ayseA)).toEqual({ pending: 1, error: 0 });
    expect(await countUnsent({ personId: 'yok', orgId: 'yok' })).toEqual({ pending: 0, error: 0 });
  });

  it('başka oturumun kaydı düzenlenemez, silinemez, SENDING yapılamaz', async () => {
    expect(await markSending(mehmetA, 'a1')).toBe(false);
    expect(await updateUnsent(mehmetA, 'a1', payload('a1', 'SALDIRI'), [])).toBe(false);
    expect(await deleteUnsent(ayseB, 'a1')).toBeNull();
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.data.trackingRaw).toBe('TRK-a1');
  });

  it('mükerrer uyarısı başka oturumun takip numarasını ele vermez', async () => {
    await add(mehmetA, 'm2', 'AYNI-NO');
    expect(await findUnsentByTracking(ayseA, 'AYNI-NO')).toBeNull();
    expect((await findUnsentByTracking(mehmetA, 'aynı-no'.replace('ı', 'I')))?.clientId).toBe('m2');
  });

  it('mükerrer uyarısı sunucuyla aynı kuralla eşler: okuyucu işareti ve FedEx 34 hane (core trackingCandidates)', async () => {
    // Eski sürümün kuyruğa yazdığı işaretli ham değer de bulunur.
    await add(mehmetA, 'n1', `]C1${'7948'}${String.fromCharCode(0x1d)}12345305`);
    expect((await findUnsentByTracking(mehmetA, '7948 1234 5305'))?.clientId).toBe('n1');
    expect((await findUnsentByTracking(mehmetA, '9632001960000000000400794812345305'))?.clientId).toBe('n1');
  });

  it('kapsamlı silme ve Geri al sahibini korur', async () => {
    const removed = await deleteUnsent(ayseA, 'a1');
    expect(removed?.personId).toBe('ayse');
    expect(await rowExists('a1')).toBe(false);
    await reinsertRow(removed!);
    expect((await getRow(ayseA, 'a1'))?.orgId).toBe('firmaA');
    expect(await getRow(mehmetA, 'a1')).toBeNull();
  });
});

describe('çıkış ve hesap değişimi', () => {
  it('oturum olmasa da kayıt silinmez, sahibi dönünce yine gönderilebilir', async () => {
    await add(ayseA, 'a1');
    await recoverInterrupted();
    expect(summarizeOtherSessions(await unsentGroups(), null, null)).toEqual({ samePerson: 0, otherPerson: 1, total: 1 });
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual(['a1']);
  });

  it('yarıda kalan SENDING sahibine PENDING döner', async () => {
    await add(ayseA, 'a1');
    expect(await markSending(ayseA, 'a1')).toBe(true);
    await recoverInterrupted();
    expect((await getRow(ayseA, 'a1'))?.status).toBe('PENDING');
  });

  it('gönderilmiş kayıt başka oturum uyarısında sayılmaz', async () => {
    await add(ayseA, 'a1');
    await markSent('a1', 'srv1');
    expect((await unsentGroups()).length).toBe(0);
  });
});

describe('sahibi dönmeyen kayıtların silinmesi', () => {
  const firmaBKisi = { personId: 'zeynep', orgId: 'firmaB' };

  beforeEach(async () => {
    await add(ayseA, 'a1'); // etkin oturumun kendi kaydı
    await add(ayseB, 'b1'); // aynı kişi, başka firma
    await add(mehmetA, 'm1'); // başka kişi, etkin firma
    await add(firmaBKisi, 'z1'); // başka kişi, başka firma
    await add(mehmetA, 'm2');
    await markSent('m2', 'srv');
    db.raw
      .prepare(`INSERT INTO queue (clientId, userId, data, photos, status, createdAt) VALUES ('eski', 'u1', ?, '[]', 'PENDING', 1)`)
      .run(JSON.stringify(payload('eski')));
  });

  it('izinsiz kişi yalnız kendi başka firmadaki kaydını siler', async () => {
    expect(deletableOtherSessions(await unsentGroups(), ayseA, false)).toBe(1);
    expect(await deleteOtherSessions(ayseA, false)).toEqual(['b1']);
    for (const id of ['a1', 'm1', 'z1', 'eski', 'm2']) expect(await rowExists(id), id).toBe(true);
    expect(await rowExists('b1')).toBe(false);
  });

  it('manage izni etkin firmadaki başka kişinin kaydını da siler, başka firmanınkini silmez', async () => {
    expect(deletableOtherSessions(await unsentGroups(), ayseA, true)).toBe(2);
    expect((await deleteOtherSessions(ayseA, true)).sort()).toEqual(['b1', 'm1']);
    for (const id of ['a1', 'z1', 'eski', 'm2']) expect(await rowExists(id), id).toBe(true);
  });

  it('izinsiz kişide başkasının kaydı için silinebilir sayı sıfır, uyarı sayısı durur', async () => {
    const groups = [
      { personId: 'mehmet', orgId: 'firmaA', count: 4 },
      { personId: 'zeynep', orgId: 'firmaB', count: 2 },
    ];
    expect(deletableOtherSessions(groups, ayseA, false)).toBe(0);
    expect(summarizeOtherSessions(groups, ayseA, 'ayse').total).toBe(6);
  });

  it('sahibi bilinmeyen eski satır yetkiyle de silinmez, etkin firmayla eşleşmez', async () => {
    expect(await deleteOtherSessions(mehmetA, true)).not.toContain('eski');
    expect(await rowExists('eski')).toBe(true);
    expect(deletableOtherSessions([{ personId: null, orgId: null, count: 1 }], mehmetA, true)).toBe(0);
  });

  it('silinebilir sayı ile gerçekten silinen aynı', async () => {
    for (const [scope, manage] of [[ayseA, false], [ayseB, true], [mehmetA, true], [firmaBKisi, true]] as const) {
      const expected = deletableOtherSessions(await unsentGroups(), scope, manage);
      expect((await deleteOtherSessions(scope, manage)).length).toBe(expected);
    }
  });

  it('oturumun kendi kaydına asla dokunmaz, başka kayıt yoksa bir şey silmez', async () => {
    await deleteOtherSessions(ayseA, true);
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual(['a1']);
    expect(await deleteOtherSessions(ayseA, false)).toEqual([]);
  });
});

describe('başka oturum özeti', () => {
  const groups = [
    { personId: 'ayse', orgId: 'firmaA', count: 2 },
    { personId: 'ayse', orgId: 'firmaB', count: 3 },
    { personId: 'mehmet', orgId: 'firmaA', count: 4 },
    { personId: null, orgId: null, count: 1 },
  ];

  it('kendi oturumunu saymaz, kişi ve firmayı ayırır', () => {
    expect(summarizeOtherSessions(groups, ayseA, 'ayse')).toEqual({ samePerson: 3, otherPerson: 5, total: 8 });
    expect(summarizeOtherSessions(groups, mehmetA, 'mehmet')).toEqual({ samePerson: 0, otherPerson: 6, total: 6 });
  });

  it('firması olmayan oturumda kişinin tüm kayıtları aynı kişi sayılır', () => {
    expect(summarizeOtherSessions(groups, null, 'ayse')).toEqual({ samePerson: 5, otherPerson: 5, total: 10 });
  });

  it('firma başına bekleyen yalnız kişinin kendisi için', () => {
    expect(pendingByOrg(groups, 'ayse')).toEqual({ firmaA: 2, firmaB: 3 });
    expect(pendingByOrg(groups, null)).toEqual({});
  });
});
