import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development' } } } } }));

import { ApiError, parseRetryAfter, SCOPE_MISMATCH } from '../src/api/client';
import type { MeasurementPayload } from '../src/api/endpoints';
import type { SessionScope } from '../src/auth/token';
import { createRecovery, PAUSE_MS, runFlush, serverTrouble } from '../src/queue/flush';
import {
  afterTrouble,
  backoffMs,
  createFlushGate,
  NETWORK_MAX_MS,
  nextFlushPlan,
  NO_BACKOFF,
  RETRY_AFTER_CAP_MS,
  SERVER_BASE_MS,
  SERVER_MAX_MS,
  type FlushGate,
  type FlushTrigger,
} from '../src/queue/schedule';
import { getRow, insertRow, type QueueRow } from '../src/queue/store';

const ayse: SessionScope = { personId: 'ayse', orgId: 'firmaA' };
const mid = () => 0.5; // dağılımsız: bekleme tam üstel değer

const add = (clientId: string) =>
  insertRow(ayse, {
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

const unavailable = () => new ApiError(503, 'DB_UNAVAILABLE', 'meşgul', undefined, 3000);

/**
 * `QueueContext`in yaptığının aynısı: tetik → plan → tur; tur sonucu kapıya yazılır. Sağlayıcı React'te çizilemediği için (Node
 * ortamı) bağlantı burada aynen kurulur. Gönderilen kayıtların listesi döner.
 */
function harness(send: (row: QueueRow) => Promise<string | null>, gate: FlushGate = createFlushGate(mid)) {
  const sent: string[] = [];
  const onPaused = vi.fn();
  return {
    gate,
    sent,
    onPaused,
    async trigger(t: FlushTrigger, blocked = false) {
      const plan = gate.plan(t, Date.now(), blocked);
      if (!plan.run) return plan;
      await runFlush(
        {
          scope: ayse,
          currentScope: () => ayse,
          send: async (row) => {
            sent.push(row.clientId);
            return send(row);
          },
          describe: (e) => String((e as Error).message),
          onSent: () => gate.success(),
          onTrouble: (tr) => {
            gate.trouble(Date.now(), tr);
            return gate.state.backoff.until;
          },
          onPaused: (reason) => {
            onPaused(reason);
            gate.pause(Date.now() + PAUSE_MS);
          },
        },
        plan.includeErrors,
        plan.ignoreRowBackoff,
      );
      return plan;
    },
  };
}

beforeEach(async () => {
  // Yalnız `Date` sahte: SQLite ve sözler gerçek zamanlayıcıyla çalışır. Saat yalnız `advanceTimersByTime` ile ilerler.
  vi.useFakeTimers({ toFake: ['Date'] });
  db = openTestDb();
  await migrate(db);
  await add('r1');
  await add('r2');
  await add('r3');
});

afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe('G1 / 11-B1: sunucu hatasında kuyruk fotoğrafları sürekli yeniden yüklemez', () => {
  it('503: tur ilk kayıtta durur, sıradakiler yüklenmez; kayıtlar kaybolmaz, Hatalı olmaz', async () => {
    const h = harness(async () => {
      throw unavailable();
    });
    await h.trigger('timer');
    expect(h.sent).toEqual(['r1']);
    for (const id of ['r1', 'r2', 'r3']) expect((await getRow(ayse, id))?.status).toBe('PENDING');
    expect((await getRow(ayse, 'r2'))?.attempts).toBe(0);
  });

  it('503 sürerken 95 sn boyunca 15 sn zamanlayıcı: en çok 3 yükleme (eskiden 8 tur × 3 kayıt)', async () => {
    const h = harness(async () => {
      throw unavailable();
    });
    for (let t = 0; t <= 95_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    // Bekleme 15, 30, 60 sn: 0., 15., 45. saniyede birer yükleme, sonraki 105. saniyede.
    expect(h.sent.length).toBeLessThanOrEqual(3);
    expect(h.sent.length).toBeGreaterThanOrEqual(2);
  });

  it('503 sonrası ikinci zamanlayıcı turu bekleme dolmadan hiç göndermez; dolunca bir kayıt dener', async () => {
    const h = harness(async () => {
      throw unavailable();
    });
    await h.trigger('timer');
    expect(h.sent).toHaveLength(1);
    tick(SERVER_BASE_MS - 1000);
    await h.trigger('timer');
    await h.trigger('auto');
    expect(h.sent).toHaveLength(1);
    tick(2000);
    await h.trigger('timer');
    expect(h.sent).toHaveLength(2);
  });

  it('bekleme üstel büyür, 10 dakikada durur; dağılım ±%15', () => {
    expect(backoffMs(1, 'server', mid)).toBe(SERVER_BASE_MS);
    expect(backoffMs(2, 'server', mid)).toBe(SERVER_BASE_MS * 2);
    expect(backoffMs(3, 'server', mid)).toBe(SERVER_BASE_MS * 4);
    expect(backoffMs(30, 'server', mid)).toBe(SERVER_MAX_MS);
    expect(backoffMs(30, 'network', mid)).toBe(NETWORK_MAX_MS);
    expect(backoffMs(1, 'server', () => 0)).toBe(Math.round(SERVER_BASE_MS * 0.85));
    expect(backoffMs(1, 'server', () => 1)).toBe(Math.round(SERVER_BASE_MS * 1.15));
  });

  it('kısa retry-after (veritabanı 3 sn) beklemeyi kısaltmaz: kesinti sürdükçe bekleme yine büyür', () => {
    let b = NO_BACKOFF;
    b = afterTrouble(b, 0, { kind: 'server', retryAfterMs: 3000 }, mid);
    expect(b.until).toBe(SERVER_BASE_MS);
    b = afterTrouble(b, b.until, { kind: 'server', retryAfterMs: 3000 }, mid);
    expect(b.until - SERVER_BASE_MS).toBe(SERVER_BASE_MS * 2);
    expect(b.failures).toBe(2);
  });

  it('başarı beklemeyi sıfırlar: sunucu dönünce kalan kayıtlar aynı turda gider', async () => {
    let down = true;
    const h = harness(async (row) => {
      if (down) throw unavailable();
      return `srv-${row.clientId}`;
    });
    await h.trigger('timer');
    down = false;
    tick(SERVER_BASE_MS * 2);
    await h.trigger('timer');
    expect(h.gate.state.backoff).toEqual(NO_BACKOFF);
    for (const id of ['r1', 'r2', 'r3']) expect((await getRow(ayse, id))?.status, id).toBe('SENT');
    // Her kayıt bir kez başarıyla gitti; kesintide yalnız r1 denenmişti.
    expect(h.sent).toEqual(['r1', 'r1', 'r2', 'r3']);
  });

  it('uygulama öne gelince bekleme atlanır, bir kez denenir; tur yine ilk hatada durur', async () => {
    const h = harness(async () => {
      throw unavailable();
    });
    await h.trigger('timer');
    // Veritabanı kesintisinin `retry-after: 3` süresi geçti, üstel bekleme (15 sn) sürüyor.
    tick(4000);
    await h.trigger('timer');
    expect(h.sent).toEqual(['r1']);
    await h.trigger('foreground');
    // Kayıt beklemesi de atlanır: baştaki kayıt (r1) yeniden denenir, sıradakiler yüklenmez.
    expect(h.sent).toEqual(['r1', 'r1']);
  });

  it('elle "Gönder" beklemeyi atlar (tek yükleme), hatalıları da dener', async () => {
    const h = harness(async () => {
      throw unavailable();
    });
    await h.trigger('timer');
    tick(4000);
    await h.trigger('manual');
    expect(h.sent).toEqual(['r1', 'r1']);
  });

  it('tek kaydın 500 hatası sıradakini tıkamaz; arka arkaya iki 500 turu durdurur ve bekleme kurar', async () => {
    const one = harness(async (row) => {
      if (row.clientId === 'r1') throw new ApiError(500, 'INTERNAL', 'x');
      return 'ok';
    });
    await one.trigger('timer');
    expect(one.sent).toEqual(['r1', 'r2', 'r3']);
    expect(one.gate.state.backoff).toEqual(NO_BACKOFF);

    db = openTestDb();
    await migrate(db);
    await add('r1');
    await add('r2');
    await add('r3');
    const all = harness(async () => {
      throw new ApiError(500, 'INTERNAL', 'x');
    });
    await all.trigger('timer');
    expect(all.sent).toEqual(['r1', 'r2']);
    expect(all.gate.state.backoff.failures).toBe(1);
    expect((await getRow(ayse, 'r3'))?.attempts).toBe(0);
  });

  it('ağ geçidi 502/504 ve hesap servisine ulaşılamadı (AUTH_UNAVAILABLE) da turu durdurur', () => {
    expect(serverTrouble(new ApiError(502, 'HTTP_502', ''))).toEqual({ kind: 'server', retryAfterMs: null });
    expect(serverTrouble(new ApiError(504, 'HTTP_504', ''))).toEqual({ kind: 'server', retryAfterMs: null });
    expect(serverTrouble(new ApiError(503, 'AUTH_UNAVAILABLE', ''))).toEqual({ kind: 'server', retryAfterMs: null });
    expect(serverTrouble(new ApiError(0, 'NETWORK', ''))).toEqual({ kind: 'network', retryAfterMs: null });
    expect(serverTrouble(new ApiError(429, 'TOO_MANY_REQUESTS', '', undefined, 7000))).toEqual({ kind: 'rateLimit', retryAfterMs: 7000 });
    // Kayda özgü, yetki, sürüm ve kapsam hataları burada değil; mevcut sınıfları geçerli.
    expect(serverTrouble(new ApiError(500, 'INTERNAL', ''))).toBeNull();
    expect(serverTrouble(new ApiError(400, 'VALIDATION', ''))).toBeNull();
    expect(serverTrouble(new ApiError(403, 'READ_ONLY', ''))).toBeNull();
    expect(serverTrouble(new ApiError(426, 'UPGRADE_REQUIRED', ''))).toBeNull();
    expect(serverTrouble(new ApiError(401, 'TOKEN_EXPIRED', ''))).toBeNull();
    expect(serverTrouble(new ApiError(-1, SCOPE_MISMATCH, ''))).toBeNull();
    expect(serverTrouble(new Error('dosya'))).toBeNull();
  });
});

describe('429: retry-after dolmadan hiçbir tetik göndermez', () => {
  const limited = () => new ApiError(429, 'TOO_MANY_REQUESTS', 'çok', undefined, 20_000);

  it('zamanlayıcı, öne gelme, elle Gönder ve ağ dönüşü süre dolmadan göndermez; dolunca gönderir', async () => {
    let limit = true;
    const h = harness(async (row) => {
      if (limit) throw limited();
      return `srv-${row.clientId}`;
    });
    await h.trigger('timer');
    expect(h.sent).toEqual(['r1']);
    limit = false;
    tick(19_000);
    for (const t of ['timer', 'auto', 'foreground', 'manual', 'online'] as const) {
      const plan = await h.trigger(t);
      expect(plan, t).toEqual({ run: false, why: 'retryAfter' });
    }
    expect(h.sent).toEqual(['r1']);
    tick(1000);
    await h.trigger('timer');
    expect((await getRow(ayse, 'r2'))?.status).toBe('SENT');
    expect((await getRow(ayse, 'r3'))?.status).toBe('SENT');
  });

  it('hız sınırı süresini söylediyse bekleme büyümez (büyük kuyruk boşalırken olağan)', () => {
    let b = NO_BACKOFF;
    b = afterTrouble(b, 0, { kind: 'rateLimit', retryAfterMs: 20_000 }, mid);
    b = afterTrouble(b, 20_000, { kind: 'rateLimit', retryAfterMs: 20_000 }, mid);
    expect(b).toEqual({ failures: 0, until: 40_000, hardUntil: 40_000 });
  });

  it('çok uzun ya da süresiz 429: en çok 60 sn uyulur; süresizse üstel bekleme', () => {
    expect(afterTrouble(NO_BACKOFF, 0, { kind: 'rateLimit', retryAfterMs: 3_600_000 }, mid).hardUntil).toBe(RETRY_AFTER_CAP_MS);
    expect(afterTrouble(NO_BACKOFF, 0, { kind: 'rateLimit', retryAfterMs: null }, mid)).toEqual({ failures: 1, until: SERVER_BASE_MS, hardUntil: 0 });
  });

  it('retry-after başlığı: saniye ya da tarih; okunamayan yok sayılır', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(' 1.5 ')).toBe(1500);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(parseRetryAfter(new Date(Date.now() - 10_000).toUTCString())).toBeUndefined();
    expect(parseRetryAfter('yarın')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('ağ hatası', () => {
  it('tur durur, kısa bekleme (en çok 60 sn); ağ geri gelince hemen dener', async () => {
    let offline = true;
    const h = harness(async (row) => {
      if (offline) throw new ApiError(0, 'NETWORK', 'yok');
      return `srv-${row.clientId}`;
    });
    await h.trigger('timer');
    expect(h.sent).toEqual(['r1']);
    expect(h.gate.state.backoff.until - Date.now()).toBeLessThanOrEqual(NETWORK_MAX_MS);
    offline = false;
    await h.trigger('online');
    expect((await getRow(ayse, 'r3'))?.status).toBe('SENT');
  });
});

describe('nextFlushPlan: mevcut engeller aynen', () => {
  const s = (o: Partial<Parameters<typeof nextFlushPlan>[2]> = {}) => ({ blocked: false, pausedUntil: 0, backoff: NO_BACKOFF, ...o });

  it('güncelleme gerekirken (426) hiçbir tetik göndermez', () => {
    for (const t of ['timer', 'auto', 'foreground', 'manual', 'online'] as const) {
      expect(nextFlushPlan(t, 0, s({ blocked: true })), t).toEqual({ run: false, why: 'blocked' });
    }
  });

  it('yetki engelinde otomatik ve öne gelme göndermez; elle ve ağ dönüşü dener (bugünkü kural)', () => {
    const st = s({ pausedUntil: PAUSE_MS });
    expect(nextFlushPlan('timer', 0, st).run).toBe(false);
    expect(nextFlushPlan('auto', 0, st).run).toBe(false);
    expect(nextFlushPlan('foreground', 0, st).run).toBe(false);
    expect(nextFlushPlan('manual', 0, st)).toEqual({ run: true, includeErrors: true, ignoreRowBackoff: true });
    expect(nextFlushPlan('online', 0, st)).toEqual({ run: true, includeErrors: true, ignoreRowBackoff: true });
    expect(nextFlushPlan('timer', PAUSE_MS, st)).toEqual({ run: true, includeErrors: false, ignoreRowBackoff: false });
  });

  it('zamanlayıcı ve otomatik tetik kayıt beklemesine de uyar (eskiden zamanlayıcı atlıyordu)', () => {
    expect(nextFlushPlan('timer', 0, s())).toEqual({ run: true, includeErrors: false, ignoreRowBackoff: false });
    expect(nextFlushPlan('auto', 0, s())).toEqual({ run: true, includeErrors: false, ignoreRowBackoff: false });
    expect(nextFlushPlan('foreground', 0, s())).toEqual({ run: true, includeErrors: false, ignoreRowBackoff: true });
  });

  it('telefon saati geri alınırsa bekleme takılı kalmaz (bekleme en uzun süresinden ileride)', () => {
    const g = createFlushGate(mid);
    const day = 24 * 3600_000;
    g.trouble(day, { kind: 'server', retryAfterMs: 5000 });
    g.pause(day + PAUSE_MS);
    expect(g.plan('timer', day + 1000, false).run).toBe(false);
    // Saat bir gün geri alındı.
    expect(g.plan('timer', 1000, false).run).toBe(true);
    expect(g.plan('manual', 1000, false).run).toBe(true);
    // PAUSE_MS ile kapıdaki üst sınır aynı.
    expect(nextFlushPlan('timer', 0, s({ pausedUntil: PAUSE_MS })).run).toBe(false);
    expect(nextFlushPlan('timer', 0, s({ pausedUntil: PAUSE_MS + 1 })).run).toBe(true);
  });

  it('oturum değişince (reset) bekleme ve engel kalkar', () => {
    const g = createFlushGate(mid);
    g.trouble(0, { kind: 'server', retryAfterMs: 5000 });
    g.pause(PAUSE_MS);
    expect(g.plan('timer', 1000, false).run).toBe(false);
    g.reset();
    expect(g.plan('timer', 1000, false).run).toBe(true);
  });
});

/**
 * Bağımsız inceleme senaryoları (Mesaj 9): sahte saatle uzun kesinti, kesintide yeni kayıt, hız sınırı + elle Gönder, başta
 * bozuk kayıt, telefon saatinin geri alınması. Her senaryoda: kayıt kaybolmaz, Hatalı olmaz, her kayıt sunucuya bir kez
 * başarıyla ulaşır (sunucu `clientId` ile tekilleştirir; yine de boşa yükleme sayılır).
 */
describe('senaryo: uzun kesinti ve geri dönüş', () => {
  const TICK = 15_000;
  const statuses = async (ids: string[]) => Promise.all(ids.map(async (id) => (await getRow(ayse, id))?.status));
  /** Uygulama önde: her 15 sn'de zamanlayıcı. */
  async function foregroundFor(h: ReturnType<typeof harness>, ms: number, each?: (t: number) => Promise<void>) {
    for (let t = 0; t < ms; t += TICK) {
      await each?.(t);
      await h.trigger('timer');
      tick(TICK);
    }
  }

  it('30 dk 503: kesintide en çok 10 yükleme; sunucu dönünce en geç ~12 dk içinde hepsi bir kez gider', async () => {
    let down = true;
    const ok: string[] = [];
    const h = harness(async (row) => {
      if (down) throw unavailable();
      ok.push(row.clientId);
      return `srv-${row.clientId}`;
    });
    await foregroundFor(h, 30 * 60_000);
    expect(h.sent.length).toBeLessThanOrEqual(10);
    expect(await statuses(['r1', 'r2', 'r3'])).toEqual(['PENDING', 'PENDING', 'PENDING']);
    down = false;
    const back = Date.now();
    while (ok.length < 3 && Date.now() - back < 13 * 60_000) {
      await h.trigger('timer');
      tick(TICK);
    }
    expect(Date.now() - back).toBeLessThanOrEqual(Math.ceil(SERVER_MAX_MS * 1.15) + 2 * TICK);
    expect(ok.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(await statuses(['r1', 'r2', 'r3'])).toEqual(['SENT', 'SENT', 'SENT']);
  });

  it('kesinti sırasında 20 yeni ölçüm: kayıt anındaki gönderim beklemeye uyar (yükleme yok); dönünce 23 kayıt bir kez gider', async () => {
    let down = true;
    const ok: string[] = [];
    const h = harness(async (row) => {
      if (down) throw new ApiError(502, 'HTTP_502', 'gateway');
      ok.push(row.clientId);
      return `srv-${row.clientId}`;
    });
    await h.trigger('timer');
    const fresh: string[] = [];
    // Her 30 sn'de bir ölçüm kaydedilir; kayıt `flush()` ('auto') çağırır.
    await foregroundFor(h, 10 * 60_000, async (t) => {
      if (t % 30_000 === 0 && fresh.length < 20) {
        const id = `n${fresh.length + 1}`;
        fresh.push(id);
        await add(id);
        await h.trigger('auto');
      }
    });
    expect(fresh).toHaveLength(20);
    // 10 dakikada en çok birkaç yükleme (bekleme 15, 30, 60, 120, 240 sn): kayıt başına yükleme yok.
    expect(h.sent.length).toBeLessThanOrEqual(7);
    down = false;
    await h.trigger('foreground');
    const all = ['r1', 'r2', 'r3', ...fresh];
    expect(ok.sort()).toEqual([...all].sort());
    expect((await statuses(all)).every((s) => s === 'SENT')).toBe(true);
  });

  it('429 retry-after sürerken elle Gönder hiçbir şey yüklemez; süre dolunca elle Gönder hatalı kaydı da gönderir', async () => {
    let limit = true;
    const h = harness(async (row) => {
      if (row.clientId === 'r2' && h.sent.filter((x) => x === 'r2').length === 1) throw new ApiError(400, 'VALIDATION', 'bozuk');
      if (limit) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'çok', undefined, 30_000);
      return `srv-${row.clientId}`;
    });
    // Önce r2 kayda özgü redle Hatalı olur (r1 ve r3 bu arada hız sınırına takılmasın diye sınır kapalı).
    limit = false;
    await h.trigger('timer');
    expect(await statuses(['r1', 'r2', 'r3'])).toEqual(['SENT', 'ERROR', 'SENT']);
    await add('r4');
    limit = true;
    await h.trigger('timer');
    const before = h.sent.length;
    for (let i = 0; i < 5; i++) {
      tick(5000);
      expect((await h.trigger('manual')).run, `elle ${i}`).toBe(false);
    }
    expect(h.sent.length).toBe(before);
    limit = false;
    tick(5001);
    await h.trigger('manual');
    expect(await statuses(['r2', 'r4'])).toEqual(['SENT', 'SENT']);
  });
});

describe('senaryo: başta bozuk kayıt', () => {
  it('baştaki iki kayıt her zaman 500 alsa da arkadakiler gönderilir (sonsuza dek beklemez)', async () => {
    await add('r4');
    const h = harness(async (row) => {
      if (row.clientId === 'r1' || row.clientId === 'r2') throw new ApiError(500, 'INTERNAL', 'bozuk kayıt');
      return `srv-${row.clientId}`;
    });
    // Bekleme (15 sn) bitince ilk zamanlayıcı turu bozuk kayıtları atlar: arkadakiler bir dakika içinde gider.
    for (let t = 0; t < 60_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    expect((await getRow(ayse, 'r3'))?.status).toBe('SENT');
    expect((await getRow(ayse, 'r4'))?.status).toBe('SENT');
    for (let t = 0; t < 9 * 60_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    // Bozuk kayıtlar kaybolmaz, Hatalı olmaz (sunucu hatası kayda özgü sayılmaz), seyrek denenir.
    expect((await getRow(ayse, 'r1'))?.status).toBe('PENDING');
    expect(h.sent.filter((x) => x === 'r1').length).toBeLessThanOrEqual(8);
  });

  it('bozuk kayıtlar arkadakiler gittikten sonra da denenmeye devam eder ama her 15 sn değil', async () => {
    const h = harness(async (row) => {
      if (row.clientId === 'r1' || row.clientId === 'r2') throw new ApiError(500, 'INTERNAL', 'bozuk kayıt');
      return `srv-${row.clientId}`;
    });
    for (let t = 0; t < 60 * 60_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    const r1 = h.sent.filter((x) => x === 'r1').length;
    expect(r1).toBeGreaterThanOrEqual(3);
    expect(r1).toBeLessThanOrEqual(20);
    expect((await getRow(ayse, 'r3'))?.status).toBe('SENT');
  });
});

describe('senaryo: telefon saati geri alındı', () => {
  it('kayıt beklemesi saat yetişene dek kuyruğu kilitlemez (zamanlayıcı da gönderir)', async () => {
    let down = true;
    const h = harness(async (row) => {
      if (down) throw unavailable();
      return `srv-${row.clientId}`;
    });
    // Birkaç kesinti turu: kayıt beklemesi büyür.
    for (let t = 0; t < 20 * 60_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    down = false;
    // Saat bir gün geri alındı.
    vi.setSystemTime(Date.now() - 24 * 3600_000);
    await h.trigger('timer');
    tick(15_000);
    await h.trigger('timer');
    for (const id of ['r1', 'r2', 'r3']) expect((await getRow(ayse, id))?.status, id).toBe('SENT');
  });
});

describe('soğuk açılış', () => {
  it('önceki oturumdan kalan kayıt beklemesi açılışta beklenmez: sunucu düzeldiyse hemen gider', async () => {
    let down = true;
    const h = harness(async (row) => {
      if (down) throw unavailable();
      return `srv-${row.clientId}`;
    });
    for (let t = 0; t < 30 * 60_000; t += 15_000) {
      await h.trigger('timer');
      tick(15_000);
    }
    // Uygulama öldürüldü, sunucu düzeldi, uygulama yeniden açıldı: kapı bellekte, sıfırdan.
    down = false;
    const fresh = harness(async (row) => `srv-${row.clientId}`);
    await fresh.trigger('foreground');
    for (const id of ['r1', 'r2', 'r3']) expect((await getRow(ayse, id))?.status, id).toBe('SENT');
    // Zamanlayıcı ('auto' gibi) kayıt beklemesine uyardı: baştaki kayıt dakikalarca beklerdi.
    expect(h.sent.filter((x) => x === 'r1').length).toBeGreaterThan(3);
  });
});

describe('11-B11: açılıştaki geri alma hata verirse kuyruk kilitli kalmaz', () => {
  it('ilk deneme hata verir (depolama dolu): sonraki gönderim yeniden dener, başarılıysa bir daha çalışmaz', async () => {
    let calls = 0;
    const r = createRecovery(async () => {
      calls++;
      if (calls === 1) throw new Error('disk I/O error');
    });
    await expect(r.ready()).rejects.toThrow('disk I/O error');
    await expect(r.ready()).resolves.toBeUndefined();
    await r.ready();
    await r.ready();
    expect(calls).toBe(2);
  });

  it('aynı anda bekleyenler tek geri almayı paylaşır (iki kez SENDING → PENDING yok)', async () => {
    let calls = 0;
    let release!: () => void;
    const r = createRecovery(
      () =>
        new Promise<void>((res) => {
          calls++;
          release = res;
        }),
    );
    const a = r.ready();
    const b = r.ready();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  it('QueueContext gönderimden önce geri almayı bekler; reddedilmiş söz saklanmaz', () => {
    const src = readFileSync('src/queue/QueueContext.tsx', 'utf8');
    expect(src).toContain('createRecovery(recoverInterrupted)');
    expect(src).toContain('await recovery.ready();');
    // Soğuk açılışta `active` olayı gelmez: ilk gönderim öne gelme gibi kayıt beklemesini atlar.
    expect(src).toMatch(/recovery\s*\.ready\(\)\s*\.then\(reload\)\s*\.then\(\(\) => run\('foreground'\)\)/);
    expect(src).not.toMatch(/recovered\.current\s*=\s*recoverInterrupted\(\)/);
  });
});
