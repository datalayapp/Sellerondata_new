import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development' } } } } }));

import { ApiError, SCOPE_MISMATCH } from '../src/api/client';
import type { MeasurementPayload } from '../src/api/endpoints';
import type { SessionScope } from '../src/auth/token';
import { classifySendError, flushAllowed, measuredAtRetryAt, PAUSE_MS, recoverQueueSession, REJECT_CODES, runFlush, wirePayload } from '../src/queue/flush';
import { dueRows, getRow, insertRow, markRetry, type QueueRow } from '../src/queue/store';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const ayseB = { personId: 'ayse', orgId: 'firmaB' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };

const add = (scope: SessionScope, clientId: string) =>
  insertRow(scope, {
    clientId,
    data: {
      clientId,
      trackingRaw: clientId,
      lengthCm: 1,
      widthCm: 1,
      heightCm: 1,
      weightKg: 1,
      dimMethod: 'MANUAL',
      weightMethod: 'MANUAL',
      measuredAt: '2026-11-06T10:00:00.000Z',
      photoKinds: [],
    } satisfies MeasurementPayload,
    photos: [],
  });

function deps(scope: SessionScope, overrides: Partial<Parameters<typeof runFlush>[0]> = {}) {
  const sent: string[] = [];
  return {
    sent,
    value: {
      scope,
      currentScope: () => scope,
      send: async (row: QueueRow) => {
        sent.push(row.clientId);
        return `srv-${row.clientId}`;
      },
      describe: (e: unknown) => String((e as Error).message),
      ...overrides,
    },
  };
}

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
  await add(ayseA, 'a1');
  await add(ayseA, 'a2');
  await add(ayseB, 'b1');
  await add(mehmetA, 'm1');
});

describe('recoverQueueSession: firmasız jetonda takılı kuyruk', () => {
  it('kişinin bekleyen kaydı varsa oturumu toparlamayı dener', async () => {
    const recover = vi.fn(async () => ayseA);
    await expect(recoverQueueSession('ayse', recover)).resolves.toEqual(ayseA);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('kişinin kaydı yoksa jeton döndürülmez (başkasının kaydı sayılmaz)', async () => {
    const recover = vi.fn(async () => null);
    await expect(recoverQueueSession('zeynep', recover)).resolves.toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it('oturumda kişi yoksa denemez', async () => {
    const recover = vi.fn(async () => null);
    await expect(recoverQueueSession(null, recover)).resolves.toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it('toparlanamazsa kayıt kaybolmaz, gönderim olmaz', async () => {
    await expect(recoverQueueSession('ayse', async () => null)).resolves.toBeNull();
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual(['a1', 'a2']);
  });

  it('firma geri gelince yalnız o firmanın kaydı gider, öteki bekler', async () => {
    const scope = await recoverQueueSession('ayse', async () => ayseB);
    const d = deps(scope!);
    await runFlush(d.value);
    expect(d.sent).toEqual(['b1']);
    expect((await getRow(ayseA, 'a1'))?.status).toBe('PENDING');
    expect((await getRow(mehmetA, 'm1'))?.status).toBe('PENDING');
  });
});

describe('runFlush', () => {
  it('yalnız oturumun kayıtlarını gönderir, diğerlerine dokunmaz', async () => {
    const d = deps(ayseA);
    await runFlush(d.value);
    expect(d.sent).toEqual(['a1', 'a2']);
    expect((await getRow(ayseA, 'a1'))?.status).toBe('SENT');
    expect((await getRow(ayseB, 'b1'))?.status).toBe('PENDING');
    expect((await getRow(mehmetA, 'm1'))?.status).toBe('PENDING');
  });

  it('hesap değişiminde sahibin kaydı beklemiş, sonra yalnız sahibine gitmiş olur', async () => {
    const mehmet = deps(mehmetA);
    await runFlush(mehmet.value);
    expect(mehmet.sent).toEqual(['m1']);

    const ayse = deps(ayseA);
    await runFlush(ayse.value);
    expect(ayse.sent).toEqual(['a1', 'a2']);

    const firmaB = deps(ayseB);
    await runFlush(firmaB.value);
    expect(firmaB.sent).toEqual(['b1']);
  });

  it('oturum döngü ortasında değişirse durur', async () => {
    let scope: SessionScope | null = ayseA;
    const sent: string[] = [];
    await runFlush({
      scope: ayseA,
      currentScope: () => scope,
      send: async (row) => {
        sent.push(row.clientId);
        scope = mehmetA; // ilk gönderim sürerken hesap değişti
        return 'x';
      },
      describe: () => '',
    });
    expect(sent).toEqual(['a1']);
    expect((await getRow(ayseA, 'a2'))?.status).toBe('PENDING');
  });

  it('oturum kapanırsa hiçbir kayıt gitmez, kayıtlar silinmez', async () => {
    const d = deps(ayseA, { currentScope: () => null });
    await runFlush(d.value);
    expect(d.sent).toEqual([]);
    expect((await dueRows(ayseA, false)).length).toBe(2);
  });

  it('SCOPE_MISMATCH: kayıt PENDING kalır, deneme sayılmaz, döngü durur', async () => {
    const d = deps(ayseA, {
      send: async () => {
        throw new ApiError(-1, SCOPE_MISMATCH, 'x');
      },
    });
    await runFlush(d.value);
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toBe(0);
    expect((await getRow(ayseA, 'a2'))?.attempts).toBe(0);
  });

  it('READ_ONLY: kayıt kaybolmaz, ERROR olmaz, döngü durur, profil yenilenir', async () => {
    const onPaused = vi.fn();
    let calls = 0;
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        calls++;
        throw new ApiError(403, 'READ_ONLY', 'salt okunur');
      },
      describe: (e) => (e as Error).message,
      onPaused,
    });
    expect(calls).toBe(1);
    expect(onPaused).toHaveBeenCalledOnce();
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.lastError).toBe('salt okunur');
    expect(row?.attempts).toBe(1);
  });

  it('ağ hatası: kayıt bekler, sıradakine geçilmez', async () => {
    let calls = 0;
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        calls++;
        throw new ApiError(0, 'NETWORK', 'yok');
      },
      describe: () => 'yok',
    });
    expect(calls).toBe(1);
    expect((await getRow(ayseA, 'a1'))?.status).toBe('PENDING');
  });

  it('KALANLAR 4.9: sunucuya ulaşılamıyorsa hiçbir kayıt yüklenmez, deneme sayılmaz, ağ sorunu bildirilir', async () => {
    const onTrouble = vi.fn();
    const d = deps(ayseA, { reachable: async () => false, onTrouble });
    await runFlush(d.value, true, true);
    expect(d.sent).toEqual([]);
    expect(onTrouble).toHaveBeenCalledExactlyOnceWith({ kind: 'network', retryAfterMs: null });
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(0);
  });

  it('KALANLAR 4.9: sunucu yoklaması yalnız gönderilecek kayıt varken yapılır, turda bir kez', async () => {
    const reachable = vi.fn(async () => true);
    const idle = deps(mehmetA, { currentScope: () => mehmetA, reachable });
    await runFlush(idle.value);
    expect(reachable).toHaveBeenCalledOnce();
    expect(idle.sent).toEqual(['m1']);
    reachable.mockClear();
    await runFlush(idle.value);
    expect(reachable).not.toHaveBeenCalled();
  });

  it('kayda özgü red ERROR olur, sıradaki gönderilir', async () => {
    const sent: string[] = [];
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async (row) => {
        if (row.clientId === 'a1') throw new ApiError(400, 'VALIDATION', 'geçersiz');
        sent.push(row.clientId);
        return 'x';
      },
      describe: () => 'geçersiz',
    });
    expect((await getRow(ayseA, 'a1'))?.status).toBe('ERROR');
    expect(sent).toEqual(['a2']);
  });

  it('KALANLAR 6.7: MEASURED_AT_INVALID: ölçüm anı telefona göre yakın gelecekteyse o an gelince yeniden denenir, çok eskiyse ya da uzak gelecekteyse Hatalı', async () => {
    const now = Date.parse('2026-11-06T10:00:00.000Z');
    const at = (ms: number) => new Date(now + ms).toISOString();
    const MIN = 60_000;
    const setAt = (clientId: string, measuredAt: string) =>
      db.runAsync('UPDATE queue SET data = ? WHERE clientId = ?', JSON.stringify({ clientId, trackingRaw: clientId, lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, dimMethod: 'MANUAL', weightMethod: 'MANUAL', measuredAt, photoKinds: [] }), clientId);
    await setAt('a1', at(2 * 3600_000)); // telefon saati ölçümden sonra düzelmiş: an 2 saat ileride
    await setAt('a2', '1970-01-01T00:00:00.000Z');
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        throw new ApiError(400, 'MEASURED_AT_INVALID', 'saat');
      },
      describe: () => 'saat',
      now: () => now,
    });
    const a1 = await getRow(ayseA, 'a1');
    expect(a1?.status).toBe('PENDING');
    // en çok ROW_DELAY_MAX_MS (30 dk) sonra; an geldikçe yaklaşır
    expect(a1?.nextAttemptAt).toBe(now + 30 * MIN);
    expect((await getRow(ayseA, 'a2'))?.status).toBe('ERROR');

    // an 20 dk ileride: sunucu payı (15 dk) dolunca + 1 dk
    expect(measuredAtRetryAt({ data: { measuredAt: at(20 * MIN) } as MeasurementPayload }, now)).toBe(now + 6 * MIN);
    expect(measuredAtRetryAt({ data: { measuredAt: at(7 * 3600_000) } as MeasurementPayload }, now)).toBeNull();
    expect(measuredAtRetryAt({ data: { measuredAt: at(-MIN) } as MeasurementPayload }, now)).toBeNull();
  });

  it('KALANLAR 6.7-b: gönderilen gövde gönderim anındaki telefon saatini taşır (kuyruk satırı değişmez)', async () => {
    const row = (await getRow(ayseA, 'a1'))!;
    const wire = wirePayload(row.data, Date.parse('2026-11-08T09:00:00.000Z'));
    expect(wire).toEqual({ ...row.data, sentAt: '2026-11-08T09:00:00.000Z' });
    expect((await getRow(ayseA, 'a1'))!.data.sentAt).toBeUndefined();
  });

  it('yetki engelinde otomatik gönderim durur, elle gönderim çalışır (403 döngüsü)', () => {
    const now = Date.now();
    const until = now + PAUSE_MS;
    expect(flushAllowed(now, until, false)).toBe(false);
    expect(flushAllowed(now, until, true)).toBe(true);
    expect(flushAllowed(until, until, false)).toBe(true);
    expect(flushAllowed(now, 0, false)).toBe(true);
  });

  it('503 AUTH_UNAVAILABLE geçici sayılır', () => {
    expect(classifySendError(new ApiError(503, 'AUTH_UNAVAILABLE', ''))).toBe('retry');
    expect(classifySendError(new ApiError(401, 'TOKEN_EXPIRED', ''))).toBe('retry');
    expect(classifySendError(new ApiError(403, 'NO_PRODUCT_ACCESS', ''))).toBe('paused');
    expect(classifySendError(new ApiError(422, 'PHOTO_REQUIRED', ''))).toBe('rejected');
    expect(classifySendError(new Error('dosya'))).toBe('retry');
  });

  it('yalnız bilinen kayda özgü kodlar red sayılır; adres, dosya sınırı ve bilinmeyen kod sunucu ayarı sorunudur', () => {
    // Kayda özgü: kayıt düzeltilmeden geçmez, ERROR olur.
    expect(classifySendError(new ApiError(400, 'VALIDATION', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(400, 'EMPTY_FILE', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(400, 'INVALID_FILE', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(400, 'VALUE_OUT_OF_RANGE', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(409, 'TRACKING_IN_USE', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(422, 'PHOTO_REQUIRED', ''))).toBe('rejected');
    // KALANLAR 6.7: telefon saati sunucunun kabul aralığı dışında; yeniden göndermek düzeltmez, döngüye girmez.
    expect(classifySendError(new ApiError(400, 'MEASURED_AT_INVALID', ''))).toBe('rejected');
    // Eskiden "Hatalı" damgası yiyenler: sunucu ayarı sorunu, kayıt bekler.
    expect(classifySendError(new ApiError(404, 'NOT_FOUND', ''))).toBe('config');
    expect(classifySendError(new ApiError(404, 'HTTP_404', ''))).toBe('config');
    expect(classifySendError(new ApiError(405, 'HTTP_405', ''))).toBe('config');
    // API'nin 413'leri (errors.ts) kayda özgüdür: fotoğraf azaltılır. Ağ geçidinin JSON olmayan 413'ü sunucu ayarıdır.
    expect(classifySendError(new ApiError(413, 'FILE_TOO_LARGE', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(413, 'TOO_MANY_FILES', ''))).toBe('rejected');
    expect(classifySendError(new ApiError(413, 'HTTP_413', ''))).toBe('config');
    expect(classifySendError(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', ''))).toBe('config');
    expect(classifySendError(new ApiError(400, 'FST_ERR_X', ''))).toBe('config');
    expect(classifySendError(new ApiError(400, 'BAD_REQUEST', ''))).toBe('config');
    expect(classifySendError(new ApiError(403, 'HTTP_403', ''))).toBe('config');
    // Kayda özgü kod beklenmeyen durumla gelirse de red sayılmaz.
    expect(classifySendError(new ApiError(404, 'VALIDATION', ''))).toBe('config');
    // Ölçüm gönderiminde dönmeyen sürüm kodları listede yok.
    expect(REJECT_CODES.has('NOT_LATEST_VERSION')).toBe(false);
    expect(REJECT_CODES.has('NEWER_EXISTS')).toBe(false);
  });

  it('sunucu ayarı sorunu tek kayıtta: kayıt ERROR olmaz, uzun ertelenir, sıradaki sağlam kayıt gönderilir', async () => {
    const onPaused = vi.fn();
    const sent: string[] = [];
    const now = Date.now();
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async (row) => {
        if (row.clientId === 'a1') throw new ApiError(404, 'NOT_FOUND', 'adres yok');
        sent.push(row.clientId);
        return 'x';
      },
      describe: (e) => (e as Error).message,
      onPaused,
      now: () => now,
    });
    expect(sent).toEqual(['a2']);
    // Arkasından kayıt gitti: sunucu bütünüyle bozuk sayılmaz.
    expect(onPaused).not.toHaveBeenCalled();
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('adres yok');
    expect(row?.nextAttemptAt).toBe(now + 10 * 60 * 1000);
    expect((await getRow(ayseA, 'a2'))?.status).toBe('SENT');
  });

  it('arka arkaya iki kayıt sunucu ayarı sorunu alırsa döngü durur, onPaused(config)', async () => {
    await add(ayseA, 'a3');
    const onPaused = vi.fn();
    let calls = 0;
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        calls++;
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'tür');
      },
      describe: (e) => (e as Error).message,
      onPaused,
    });
    expect(calls).toBe(2);
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused).toHaveBeenCalledWith('config');
    expect((await getRow(ayseA, 'a1'))?.status).toBe('PENDING');
    expect((await getRow(ayseA, 'a2'))?.status).toBe('PENDING');
    expect((await getRow(ayseA, 'a3'))?.attempts).toBe(0);
  });

  it('tur sunucu ayarı sorunuyla biterse kullanıcıya söylenir', async () => {
    const onPaused = vi.fn();
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async (row) => {
        if (row.clientId === 'a2') throw new ApiError(404, 'NOT_FOUND', '');
        return 'x';
      },
      describe: () => '',
      onPaused,
    });
    expect(onPaused).toHaveBeenCalledWith('config');
  });

  it('elle "Gönder": baştaki kayıt yine sunucu ayarı sorunu alsa da arkadaki gönderilir', async () => {
    // Önce otomatik tur: a1 ertelendi, a2 (ör. bağlantı) bekledi.
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async (row) => {
        if (row.clientId === 'a1') throw new ApiError(404, 'NOT_FOUND', '');
        throw new ApiError(0, 'NETWORK', '');
      },
      describe: () => '',
    });
    expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual([]);
    const sent: string[] = [];
    await runFlush(
      {
        scope: ayseA,
        currentScope: () => ayseA,
        send: async (row) => {
          if (row.clientId === 'a1') throw new ApiError(404, 'NOT_FOUND', '');
          sent.push(row.clientId);
          return 'x';
        },
        describe: () => '',
      },
      true,
    );
    expect(sent).toEqual(['a2']);
    expect((await getRow(ayseA, 'a2'))?.status).toBe('SENT');
    // Sunucu düzelince elle gönderim ertelenmiş kaydı da gönderir.
    const d = deps(ayseA);
    await runFlush(d.value, true);
    expect(d.sent).toEqual(['a1']);
  });

  it('413 FILE_TOO_LARGE kayda özgüdür: kayıt Hatalı olur, sıradaki gönderilir', async () => {
    const sent: string[] = [];
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async (row) => {
        if (row.clientId === 'a1') throw new ApiError(413, 'FILE_TOO_LARGE', 'büyük');
        sent.push(row.clientId);
        return 'x';
      },
      describe: (e) => (e as Error).message,
    });
    expect((await getRow(ayseA, 'a1'))?.status).toBe('ERROR');
    expect(sent).toEqual(['a2']);
  });

  it('yetki engelinde onPaused(access) çağrılır', async () => {
    const onPaused = vi.fn();
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        throw new ApiError(403, 'NO_PRODUCT_ACCESS', '');
      },
      describe: () => '',
      onPaused,
    });
    expect(onPaused).toHaveBeenCalledWith('access');
  });
});

describe('426 UPGRADE_REQUIRED: kuyruk dokunulmadan korunur (Mesaj 13 §3.5)', () => {
  const upgrade = () => new ApiError(426, 'UPGRADE_REQUIRED', 'eski surum', { minVersion: '9.0.0', updateUrl: null });

  it('sınıf: UPGRADE_REQUIRED ya da 426 her zaman "upgrade"', () => {
    expect(classifySendError(upgrade())).toBe('upgrade');
    expect(classifySendError(new ApiError(426, 'HTTP_426', ''))).toBe('upgrade');
    // Kod geldi ama durum beklenmedik: yine kayda özgü sayılmaz.
    expect(classifySendError(new ApiError(400, 'UPGRADE_REQUIRED', ''))).toBe('upgrade');
  });

  it('kayıt ERROR olmaz, silinmez, attempts artmaz, lastError değişmez; döngü hemen durur, onPaused(upgrade)', async () => {
    const onPaused = vi.fn();
    let calls = 0;
    await runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        calls++;
        throw upgrade();
      },
      describe: () => 'BU METIN KAYDA YAZILMAMALI',
      onPaused,
    });
    expect(calls).toBe(1);
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onPaused).toHaveBeenCalledWith('upgrade');
    for (const id of ['a1', 'a2']) {
      const row = await getRow(ayseA, id);
      expect(row?.status).toBe('PENDING');
      expect(row?.attempts).toBe(0);
      expect(row?.lastError).toBeNull();
      expect(row?.nextAttemptAt).toBe(0);
    }
  });

  it('önceki deneme sayısı ve hata metni olduğu gibi kalır', async () => {
    await markRetry('a1', 3, 0, 'baglanti yok');
    await runFlush({ ...deps(ayseA).value, send: async () => { throw upgrade(); } });
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toBe('baglanti yok');
  });

  it('elle "Gönder" ile denenen Hatalı kayıt 426 alırsa Hatalı kalır, sayacı artmaz, bekleyene dönmez', async () => {
    await runFlush({
      ...deps(ayseA).value,
      send: async (row) => {
        if (row.clientId === 'a1') throw new ApiError(400, 'VALIDATION', 'gecersiz');
        throw new ApiError(0, 'NETWORK', '');
      },
      describe: (e) => (e as Error).message,
    });
    expect((await getRow(ayseA, 'a1'))?.status).toBe('ERROR');
    await runFlush({ ...deps(ayseA).value, send: async () => { throw upgrade(); } }, true);
    const row = await getRow(ayseA, 'a1');
    expect(row?.status).toBe('ERROR');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('gecersiz');
  });

  it('kayıt yalnız 426 alan oturumun değil; başka oturumların kayıtlarına hiç dokunulmaz', async () => {
    await runFlush({ ...deps(ayseA).value, send: async () => { throw upgrade(); } });
    expect((await getRow(ayseB, 'b1'))).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect((await getRow(mehmetA, 'm1'))).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('güncelleme durumu açıkken runFlush hiçbir kaydı göndermez (elle "Gönder" dahil)', async () => {
    const d = deps(ayseA, { blocked: () => true });
    await runFlush(d.value);
    await runFlush(d.value, true);
    await runFlush(d.value, false, true);
    expect(d.sent).toEqual([]);
    expect(await getRow(ayseA, 'a1')).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('durum döngü ortasında açılırsa sıradaki kayıt gönderilmez', async () => {
    let blocked = false;
    const d = deps(ayseA, { blocked: () => blocked });
    const send = d.value.send;
    d.value.send = async (row: QueueRow) => {
      const id = await send(row);
      blocked = true; // başka bir istek 426 aldı
      return id;
    };
    await runFlush(d.value);
    expect(d.sent).toEqual(['a1']);
    expect((await getRow(ayseA, 'a2'))?.status).toBe('PENDING');
  });

  it('flushAllowed: güncelleme gerekirken zamanlayıcı, öne alma ve elle gönderim kapalı', () => {
    const now = Date.now();
    expect(flushAllowed(now, 0, false, true)).toBe(false);
    expect(flushAllowed(now, 0, true, true)).toBe(false);
    expect(flushAllowed(now, now + PAUSE_MS, true, true)).toBe(false);
    // Güncelleme gerekmiyorsa eski kurallar.
    expect(flushAllowed(now, 0, false, false)).toBe(true);
    expect(flushAllowed(now, now + PAUSE_MS, true, false)).toBe(true);
    expect(flushAllowed(now, now + PAUSE_MS, false)).toBe(false);
  });

  it('bayrak kalkınca bekleyen kayıt kendiliğinden (öne almadan, zorlamadan) gönderilir', async () => {
    let blocked = false;
    await runFlush({ ...deps(ayseA).value, send: async () => { blocked = true; throw upgrade(); } });
    expect(blocked).toBe(true);
    blocked = false;
    const d = deps(ayseA, { blocked: () => blocked });
    await runFlush(d.value);
    expect(d.sent).toEqual(['a1', 'a2']);
    expect((await getRow(ayseA, 'a1'))?.status).toBe('SENT');
  });
});

/**
 * Y53 (SPEC §6.2): API ölçüm uçlarının kayda özgü hata kodları (`apps/api/src/lib/measurementCodes.ts`) ile buradaki
 * `REJECT_CODES` birebir aynı; ölçüm ucunda yazılan her kod iki API listesinden birinde. API yeni bir kayda özgü kod
 * eklerse bu test düşer: kod mobil listeye de yazılır (eklenmezse kayıt kaybolmaz, "sunucu ayarı sorunu" diye bekler).
 */
describe('red kodları API ile aynı (Y53)', () => {
  const apiFile = (rel: string) => readFileSync(new URL(`../../api/src/${rel}`, import.meta.url), 'utf8');
  const listOf = (src: string, name: string) => {
    const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src)?.[1];
    expect(body, name).toBeDefined();
    return [...body!.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!);
  };
  const codes = apiFile('lib/measurementCodes.ts');
  const reject = listOf(codes, 'MEASUREMENT_REJECT_CODES');
  const other = listOf(codes, 'MEASUREMENT_OTHER_CODES');

  it('kayda özgü kodlar iki tarafta aynı', () => {
    expect([...REJECT_CODES].sort()).toEqual([...reject].sort());
    expect(reject.filter((c) => other.includes(c))).toEqual([]);
  });

  it('ölçüm ucunda yazılan her kod API listelerinden birinde', () => {
    const route = apiFile('routes/measurements.ts');
    const used = new Set<string>();
    for (const m of route.matchAll(/(?:badRequest|conflict)\(\s*'([A-Z0-9_]+)'/g)) used.add(m[1]!);
    for (const m of route.matchAll(/new AppError\(\s*\d+\s*,\s*'([A-Z0-9_]+)'/g)) used.add(m[1]!);
    if (/\bemptyFile\(/.test(route)) used.add('EMPTY_FILE');
    if (/\bnotFound\(/.test(route)) used.add('NOT_FOUND');
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((c) => !reject.includes(c) && !other.includes(c))).toEqual([]);
  });
});
