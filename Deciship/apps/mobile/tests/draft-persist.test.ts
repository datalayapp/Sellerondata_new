import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));

import type { Draft } from '../src/draft/DraftContext';
import {
  createDraftSync,
  deleteDraft,
  deleteSpareDraft,
  draftHasContent,
  draftKey,
  draftPayload,
  DRAFT_TTL_MS,
  DRAFT_WRITE_DELAY_MS,
  lockedReason,
  parseStoredDraft,
  restoreDraft,
  resumeStep,
  saveDraftToQueue,
  spareDraftKey,
  sweepExpiredDrafts,
  writeDraft,
  writeSpareDraft,
  type RestoreDeps,
} from '../src/draft/persist';
import { getRow, insertRow, markSending, markSent, rowExists, SENT_KEEP_MS, updateUnsent, type QueuePhoto } from '../src/queue/store';
import type { MeasurementPayload } from '../src/api/endpoints';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const ayseB = { personId: 'ayse', orgId: 'firmaB' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };
const NOW = 1_762_900_000_000;

let ids = 0;
const blank = (over: Partial<Draft> = {}): Draft => ({
  clientId: `c${++ids}`,
  trackingRaw: '',
  weightKg: null,
  weightMethod: 'MANUAL',
  ocrWeightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  dimMethod: 'MANUAL',
  dimConfidence: null,
  boxPresetId: null,
  photos: [],
  note: '',
  startedAt: NOW - 1000,
  ...over,
});

const full = (over: Partial<Draft> = {}) =>
  blank({
    trackingRaw: 'TRK1',
    weightKg: 2.4,
    lengthCm: 40,
    widthCm: 30,
    heightCm: 20,
    photos: [
      { id: 'p1', uri: 'file:///cache/box1.jpg', kind: 'PHOTO_BOX', width: 1600, height: 1200 },
      { id: 'p2', uri: 'file:///cache/box2.jpg', kind: 'PHOTO_BOX' },
    ],
    ...over,
  });

const rawValue = async (scope: typeof ayseA) =>
  (await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', draftKey(scope) as never))?.value ?? null;
/** Kapsamın yedek anahtarlarındaki taslaklar (korumalı açılış). */
const spares = async (scope: typeof ayseA) =>
  (await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key", `${draftKey(scope)}:%` as never)).map((r) => ({
    key: r.key,
    draft: parseStoredDraft(r.value, NOW),
  }));

function deps(over: Partial<RestoreDeps> = {}) {
  const deleted: string[] = [];
  return {
    deleted,
    value: {
      exists: () => true,
      rowExists,
      deletePhoto: (uri: string) => deleted.push(uri),
      now: NOW,
      ...over,
    } satisfies RestoreDeps,
  };
}

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

describe('taslağın diskte saklanması', () => {
  it('yazılan taslak aynı kapsamla okunur, başka kapsamla okunmaz', async () => {
    const d = full();
    await writeDraft(ayseA, d, NOW);
    expect(draftKey(ayseA)).toBe('draft:ayse:firmaA');
    expect((await restoreDraft(ayseA, deps().value))?.draft).toEqual(d);
    expect(await restoreDraft(ayseB, deps().value)).toBeNull();
    expect(await restoreDraft(mehmetA, deps().value)).toBeNull();
  });

  it('disk biçimi v: 1, savedAt ve taslak', async () => {
    const d = full();
    await writeDraft(ayseA, d, NOW);
    expect(JSON.parse((await rawValue(ayseA))!)).toEqual({ v: 1, savedAt: NOW, draft: d });
  });

  it('v yanlışsa ya da JSON bozuksa null; okunamayan satıra dokunulmaz', async () => {
    const d = full();
    expect(parseStoredDraft(JSON.stringify({ v: 2, savedAt: NOW, draft: d }), NOW)).toBeNull();
    expect(parseStoredDraft('{bozuk', NOW)).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ v: 1, savedAt: NOW, draft: { ...d, clientId: '' } }), NOW)).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ v: 1, savedAt: NOW, draft: d }), NOW)).toEqual(d);

    await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', draftKey(ayseA) as never, '{bozuk' as never);
    const x = deps();
    expect(await restoreDraft(ayseA, x.value)).toBeNull();
    expect(await rawValue(ayseA)).toBe('{bozuk');
    expect(x.deleted).toEqual([]);
  });

  it('süresi dolan taslak silinir ve fotoğrafları silinir', async () => {
    const d = full();
    await writeDraft(ayseA, d, NOW - DRAFT_TTL_MS - 1);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)).toBeNull();
    const x = deps();
    expect(await restoreDraft(ayseA, x.value)).toBeNull();
    expect(await rawValue(ayseA)).toBeNull();
    expect(x.deleted).toEqual(['file:///cache/box1.jpg', 'file:///cache/box2.jpg']);
  });

  it('süresi dolmayan taslak kalır (süre son yazmadan sayılır)', async () => {
    await writeDraft(ayseA, full({ startedAt: NOW - DRAFT_TTL_MS * 2 }), NOW - DRAFT_TTL_MS + 1000);
    expect(await restoreDraft(ayseA, deps().value)).not.toBeNull();
  });

  it('olmayan fotoğraf listeden çıkar ve sayılır', async () => {
    await writeDraft(ayseA, full(), NOW);
    const r = await restoreDraft(ayseA, deps({ exists: (uri) => uri.endsWith('box1.jpg') }).value);
    expect(r?.missingPhotos).toBe(1);
    expect(r?.draft.photos.map((p) => p.id)).toEqual(['p1']);
  });

  it('taslak kimliği kuyruktaysa (kayıt alınmış) satır ve taslak fotoğrafları silinir, null döner', async () => {
    const d = full();
    await writeDraft(ayseA, d, NOW);
    // Kaydet ile kuyruğa girdi, taslak silinmeden uygulama kapandı. Kuyruk kendi kopyasını tutar.
    await insertRow(ayseA, {
      clientId: d.clientId,
      data: draftPayload(d, new Date(NOW)),
      photos: [{ uri: `file:///doc/queue/${d.clientId}/0.jpg`, kind: 'PHOTO_BOX' }],
    });
    const x = deps();
    expect(await restoreDraft(ayseA, x.value)).toBeNull();
    expect(await rawValue(ayseA)).toBeNull();
    // Yalnız taslak dosyaları silinir; kuyruğun kopyasına dokunulmaz.
    expect(x.deleted).toEqual(['file:///cache/box1.jpg', 'file:///cache/box2.jpg']);
    expect(x.deleted.some((u) => u.includes('/queue/'))).toBe(false);
    expect(await rowExists(d.clientId)).toBe(true);
  });

  it('KALANLAR 6.7-a: bilerek yeniden ölçülen kaydın kimliği taslakta saklanır ve kuyruğa giden kayda yazılır', async () => {
    const d = full({ replacesId: 'srv-eski' });
    expect(draftPayload(d, new Date(NOW)).replacesId).toBe('srv-eski');
    expect('replacesId' in draftPayload(full(), new Date(NOW))).toBe(false);
    await writeDraft(ayseA, d, NOW);
    const raw = await rawValue(ayseA);
    expect(parseStoredDraft(raw!, NOW)?.replacesId).toBe('srv-eski');
  });

  it('taslak kimliği kuyruk kimliğidir; aynı taslak iki kez kaydedilirse kuyrukta tek satır kalır', async () => {
    const d = full();
    const payload = draftPayload(d, new Date(NOW));
    expect(payload.clientId).toBe(d.clientId);
    await insertRow(ayseA, { clientId: payload.clientId, data: payload, photos: [] });
    await insertRow(ayseA, { clientId: payload.clientId, data: draftPayload(d, new Date(NOW + 5000)), photos: [] });
    const n = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM queue');
    expect(n?.n).toBe(1);
  });

  it('taslak ömrü 2 gün ve gönderilmiş satırın saklanma süresinden kısa', () => {
    expect(DRAFT_TTL_MS).toBe(2 * 24 * 3600 * 1000);
    expect(DRAFT_TTL_MS).toBeLessThan(SENT_KEEP_MS);
  });

  it('süpürme: süresi dolan bütün taslaklar (her kişi) silinir; dolmayan ve okunamayan kalır; kuyruk dosyasına dokunulmaz', async () => {
    const oldA = full({ photos: [{ id: 'p1', uri: 'file:///cache/a.jpg', kind: 'PHOTO_BOX' }] });
    const oldM = full({ photos: [{ id: 'p2', uri: 'file:///cache/m.jpg', kind: 'PHOTO_BOX' }] });
    await writeDraft(ayseA, oldA, NOW - DRAFT_TTL_MS - 1);
    await writeDraft(mehmetA, oldM, NOW - DRAFT_TTL_MS - 1);
    await writeDraft(ayseB, full(), NOW - 1000);
    await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', 'draft:zeynep:firmaA' as never, '{bozuk' as never);
    await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', 'presets:ayse:firmaA' as never, '[]' as never);
    await insertRow(ayseA, { clientId: 'q1', data: draftPayload(full({ clientId: 'q1' }), new Date(NOW)), photos: [{ uri: 'file:///doc/queue/q1/0.jpg', kind: 'PHOTO_BOX' }] });
    const deleted: string[] = [];
    expect(await sweepExpiredDrafts((u) => deleted.push(u), NOW)).toBe(2);
    expect(await rawValue(ayseA)).toBeNull();
    expect(await rawValue(mehmetA)).toBeNull();
    expect(await rawValue(ayseB)).not.toBeNull();
    expect((await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'draft:zeynep:firmaA' as never))?.value).toBe('{bozuk');
    expect(await db.getFirstAsync('SELECT value FROM kv WHERE key = ?', 'presets:ayse:firmaA' as never)).not.toBeNull();
    expect(deleted.sort()).toEqual(['file:///cache/a.jpg', 'file:///cache/m.jpg']);
    expect(await rowExists('q1')).toBe(true);
  });

  it('kayıt yolu: satır yazıldı ama kaydet hata verdi → değer düzeltildi → yeniden kaydet → kuyrukta tek satır, yeni değer', async () => {
    const q = {
      getLocal: (id: string) => getRow(ayseA, id),
      enqueue: async (data: MeasurementPayload, photos: QueuePhoto[]) => {
        await insertRow(ayseA, { clientId: data.clientId, data, photos });
      },
      editLocal: (id: string, data: MeasurementPayload, photos: QueuePhoto[]) => updateUnsent(ayseA, id, data, photos),
    };
    const d = full({ weightKg: 2.4 });
    // İlk deneme: satır yazıldı, sonrasında (liste yenilemesi) hata.
    await expect(
      saveDraftToQueue(d, new Date(NOW), {
        ...q,
        enqueue: async (data, photos) => {
          await q.enqueue(data, photos);
          throw new Error('reload');
        },
      }),
    ).rejects.toThrow('reload');
    // Kişi ağırlığı düzeltip yeniden kaydetti.
    await expect(saveDraftToQueue({ ...d, weightKg: 3.1 }, new Date(NOW + 1000), q)).resolves.toBe('updated');
    const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM queue');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.data).weightKg).toBe(3.1);
    expect(JSON.parse(rows[0]!.data).clientId).toBe(d.clientId);
  });

  it('kayıt yolu: satır gönderilmişse ikinci kayıt açılmaz', async () => {
    const d = full();
    await insertRow(ayseA, { clientId: d.clientId, data: draftPayload(d, new Date(NOW)), photos: [] });
    await markSent(d.clientId, 'srv1');
    const enqueue = vi.fn(async () => undefined);
    const editLocal = vi.fn((id: string, data: MeasurementPayload, photos: QueuePhoto[]) => updateUnsent(ayseA, id, data, photos));
    await expect(saveDraftToQueue({ ...d, weightKg: 9 }, new Date(NOW), { getLocal: (id) => getRow(ayseA, id), enqueue, editLocal })).resolves.toBe('alreadySent');
    expect(enqueue).not.toHaveBeenCalled();
    const rows = await db.getAllAsync<{ data: string; status: string }>('SELECT data, status FROM queue');
    expect(rows.map((r) => r.status)).toEqual(['SENT']);
    expect(JSON.parse(rows[0]!.data).weightKg).toBe(2.4);
  });

  it('kayıt yolu (Y48): satır şu an gönderiliyorsa "gönderiliyor" döner, "gönderildi" demez; ikinci kayıt açılmaz', async () => {
    const d = full();
    await insertRow(ayseA, { clientId: d.clientId, data: draftPayload(d, new Date(NOW)), photos: [] });
    expect(await markSending(ayseA, d.clientId)).toBe(true);
    const enqueue = vi.fn(async () => undefined);
    const editLocal = vi.fn(async () => true);
    await expect(saveDraftToQueue({ ...d, weightKg: 9 }, new Date(NOW), { getLocal: (id) => getRow(ayseA, id), enqueue, editLocal })).resolves.toBe('sending');
    expect(enqueue).not.toHaveBeenCalled();
    expect(editLocal).not.toHaveBeenCalled();
    const rows = await db.getAllAsync<{ data: string; status: string }>('SELECT data, status FROM queue');
    expect(rows.map((r) => r.status)).toEqual(['SENDING']);
    expect(JSON.parse(rows[0]!.data).weightKg).toBe(2.4);
  });

  it('kayıt yolu (Y48): okurken bekliyordu, düzeltme anında gönderime alındı → "gönderiliyor"; gönderilmişse "gönderildi"', async () => {
    const d = full();
    await insertRow(ayseA, { clientId: d.clientId, data: draftPayload(d, new Date(NOW)), photos: [] });
    const q = (after: () => Promise<unknown>) => ({
      getLocal: (id: string) => getRow(ayseA, id),
      enqueue: async () => undefined,
      // Okuma PENDING gördü; yazmadan hemen önce gönderim başladı (ya da bitti).
      editLocal: async (id: string, data: MeasurementPayload, photos: QueuePhoto[]) => {
        await after();
        return updateUnsent(ayseA, id, data, photos);
      },
    });
    await expect(saveDraftToQueue({ ...d, weightKg: 9 }, new Date(NOW), q(() => markSending(ayseA, d.clientId)))).resolves.toBe('sending');
    const e = full();
    await insertRow(ayseA, { clientId: e.clientId, data: draftPayload(e, new Date(NOW)), photos: [] });
    await expect(saveDraftToQueue({ ...e, weightKg: 9 }, new Date(NOW), q(() => markSent(e.clientId, 'srv9')))).resolves.toBe('alreadySent');
    expect(lockedReason(null)).toBe('alreadySent');
    expect(lockedReason({ status: 'SENDING' })).toBe('sending');
    expect(lockedReason({ status: 'SENT' })).toBe('alreadySent');
  });

  it('yedek anahtar (Y48): asıl anahtar boşsa en eski yedek asıl anahtara taşınır; asıl doluysa yedeğe dokunulmaz', async () => {
    const main = full({ trackingRaw: 'ASIL' });
    const older = full({ trackingRaw: 'ESKI-YEDEK' });
    const newer = full({ trackingRaw: 'YENI-YEDEK' });
    await writeDraft(ayseA, main, NOW - 3000);
    await writeSpareDraft(ayseA, newer, NOW - 1000);
    await writeSpareDraft(ayseA, older, NOW - 2000);
    // Başka kapsamın yedeği karışmaz.
    await writeSpareDraft(ayseB, full({ trackingRaw: 'B-YEDEK' }), NOW - 5000);
    expect(spareDraftKey(ayseA, older.clientId)).toBe(`draft:ayse:firmaA:${older.clientId}`);

    expect((await restoreDraft(ayseA, deps().value))?.draft).toEqual(main);
    expect((await spares(ayseA)).length).toBe(2);

    await deleteDraft(ayseA);
    expect((await restoreDraft(ayseA, deps().value))?.draft).toEqual(older);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)).toEqual(older);
    expect((await spares(ayseA)).map((s) => s.draft?.trackingRaw)).toEqual(['YENI-YEDEK']);

    await deleteDraft(ayseA);
    expect((await restoreDraft(ayseA, deps().value))?.draft).toEqual(newer);
    expect(await spares(ayseA)).toEqual([]);
    expect((await spares(ayseB)).length).toBe(1);
  });

  it('yedek anahtar (Y48): süresi dolmuş ya da kuyruğa girmiş yedek taşınmaz, silinir; süpürme yedekleri de kapsar', async () => {
    const queued = full({ trackingRaw: 'KUYRUKTA', photos: [{ id: 'q', uri: 'file:///cache/q.jpg', kind: 'PHOTO_BOX' }] });
    const old = full({ trackingRaw: 'ESKI', photos: [{ id: 'o', uri: 'file:///cache/o.jpg', kind: 'PHOTO_BOX' }] });
    await writeSpareDraft(ayseA, queued, NOW - 1000);
    await insertRow(ayseA, { clientId: queued.clientId, data: draftPayload(queued, new Date(NOW)), photos: [] });
    await writeSpareDraft(ayseA, old, NOW - DRAFT_TTL_MS - 1);
    const x = deps();
    expect(await restoreDraft(ayseA, x.value)).toBeNull();
    expect(await spares(ayseA)).toEqual([]);
    expect(await rawValue(ayseA)).toBeNull();
    expect(x.deleted.sort()).toEqual(['file:///cache/o.jpg', 'file:///cache/q.jpg']);

    await writeSpareDraft(mehmetA, full(), NOW - DRAFT_TTL_MS - 1);
    expect(await sweepExpiredDrafts(() => undefined, NOW)).toBe(1);
    expect(await spares(mehmetA)).toEqual([]);
  });

  it('kayıt yolu: kuyrukta yoksa yeni satır', async () => {
    const d = full();
    const enqueue = vi.fn(async (data: MeasurementPayload, photos: QueuePhoto[]) => insertRow(ayseA, { clientId: data.clientId, data, photos }));
    await expect(saveDraftToQueue(d, new Date(NOW), { getLocal: (id) => getRow(ayseA, id), enqueue, editLocal: async () => false })).resolves.toBe('queued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('resumeStep: ilk eksik adım', () => {
    expect(resumeStep(blank(), 2)).toBe('scan');
    expect(resumeStep(blank({ trackingRaw: 'T' }), 2)).toBe('weight');
    expect(resumeStep(blank({ trackingRaw: 'T', weightKg: 1, lengthCm: 10, widthCm: 10 }), 2)).toBe('dims');
    expect(resumeStep(full({ photos: [{ id: 'p1', uri: 'u', kind: 'PHOTO_BOX' }] }), 2)).toBe('photos');
    expect(resumeStep(full(), 2)).toBe('summary');
    // Tartı fotoğrafı koli fotoğrafı sayılmaz.
    expect(resumeStep(full({ photos: [{ id: 's', uri: 'u', kind: 'PHOTO_SCALE' }] }), 1)).toBe('photos');
    expect(resumeStep(full({ photos: [] }), 0)).toBe('summary');
  });

  it('draftHasContent: yalnız başlama zamanı ve kimlik dolu taslak boş', () => {
    expect(draftHasContent(blank())).toBe(false);
    expect(draftHasContent(blank({ trackingRaw: '  ' }))).toBe(false);
    expect(draftHasContent(blank({ trackingRaw: 'T' }))).toBe(true);
    expect(draftHasContent(blank({ weightKg: 1 }))).toBe(true);
    expect(draftHasContent(blank({ heightCm: 3 }))).toBe(true);
    expect(draftHasContent(blank({ photos: [{ id: 'p', uri: 'u', kind: 'PHOTO_SCALE' }] }))).toBe(true);
    expect(draftHasContent(blank({ note: 'n' }))).toBe(true);
  });

  it('deleteDraft yalnız kendi kapsamını siler', async () => {
    await writeDraft(ayseA, full(), NOW);
    await writeDraft(ayseB, full(), NOW);
    await deleteDraft(ayseA);
    expect(await rawValue(ayseA)).toBeNull();
    expect(await rawValue(ayseB)).not.toBeNull();
  });
});

describe('taslak eşitlemesi (yükleme kapısı, kapsam, gecikmeli yazma)', () => {
  type Loaded = { owner: typeof ayseA; draft: Draft; missing: number };

  function harness() {
    const loads: Loaded[] = [];
    const restores: string[] = [];
    const sync = createDraftSync({
      restore: async (sc) => {
        restores.push(draftKey(sc));
        return restoreDraft(sc, deps().value);
      },
      write: (sc, d) => writeDraft(sc, d, NOW),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d, NOW),
      removeSpare: deleteSpareDraft,
      fresh: () => blank(),
      onLoaded: (owner, draft, missing) => loads.push({ owner, draft, missing }),
    });
    const last = () => loads[loads.length - 1]!;
    return { sync, loads, restores, last };
  }

  const settle = async (sync: ReturnType<typeof createDraftSync>, ms = DRAFT_WRITE_DELAY_MS) => {
    await sync.idle();
    await vi.advanceTimersByTimeAsync(ms);
    await sync.idle();
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('yükleme bitmeden hiçbir şey yazılmaz: açılıştaki boş taslak diskteki taslağı ezemez', async () => {
    const saved = full();
    await writeDraft(ayseA, saved, NOW - 5000);
    const before = await rawValue(ayseA);
    const h = harness();

    // Açılış: kapsam henüz yok, bellekte sahipsiz boş taslak.
    h.sync.setScope(null);
    h.sync.changed({ owner: null, draft: blank() }, true);
    h.sync.changed({ owner: null, draft: blank({ trackingRaw: 'YENI' }) });
    await h.sync.flush();
    await settle(h.sync);
    expect(await rawValue(ayseA)).toBe(before);

    // Kapsam geldi; okuma sürerken sahipsiz durum yine yazılmaz.
    h.sync.setScope(ayseA);
    h.sync.changed({ owner: null, draft: blank() }, true);
    await settle(h.sync);
    expect(h.last().draft).toEqual(saved);
    expect(h.sync.ready()).toBe(true);
    // Okunan durum aynen geri yazılmaz (kayıt zamanı değişmez).
    h.sync.changed({ owner: ayseA, draft: h.last().draft });
    await settle(h.sync);
    expect(await rawValue(ayseA)).toBe(before);
  });

  /** Okuması istenince bozulan veritabanı: `broken` doğruyken her okuma fırlatır. */
  function flaky() {
    const state = { broken: true, reads: 0 };
    const loads: { owner: typeof ayseA; draft: Draft; missing: number }[] = [];
    const sync = createDraftSync({
      restore: async (sc) => {
        state.reads++;
        if (state.broken) throw new Error('SQLITE_BUSY');
        return restoreDraft(sc, deps().value);
      },
      write: (sc, d) => writeDraft(sc, d, NOW),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d, NOW),
      removeSpare: deleteSpareDraft,
      fresh: () => blank(),
      onLoaded: (owner, draft, missing) => loads.push({ owner, draft, missing }),
    });
    return { state, loads, sync };
  }

  it('okuma hatası: kapı kapalı kalır, hiçbir şey yazılmaz; okuma düzelince taslak geri gelir', async () => {
    const saved = full();
    await writeDraft(ayseA, saved, NOW - 5000);
    const before = await rawValue(ayseA);
    const f = flaky();
    f.sync.setScope(ayseA);
    await f.sync.idle();
    expect(f.sync.ready()).toBe(false);
    expect(f.loads).toEqual([]);
    // Kapı kapalıyken bellekte sahipsiz durum: ne değişiklik ne silme diske gider.
    f.sync.changed({ owner: null, draft: blank() }, true);
    await f.sync.flush();
    expect(await rawValue(ayseA)).toBe(before);
    // 1 sn sonra yeniden denenir; bu sefer okuma çalışır.
    f.state.broken = false;
    await vi.advanceTimersByTimeAsync(1000);
    await f.sync.idle();
    expect(f.state.reads).toBe(2);
    expect(f.sync.ready()).toBe(true);
    expect(f.loads[0]?.draft).toEqual(saved);
    expect(await rawValue(ayseA)).toBe(before);
  });

  it('okuma sürekli hata verirse kapı korumalı açılır: reset ve yeni içerik diskteki satırı silmez, ezmez', async () => {
    await writeDraft(ayseA, full(), NOW - 5000);
    const before = await rawValue(ayseA);
    const f = flaky();
    f.sync.setScope(ayseA);
    await f.sync.idle();
    await vi.advanceTimersByTimeAsync(1000);
    await f.sync.idle();
    expect(f.sync.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    await f.sync.idle();
    // Üç deneme tükendi: kullanıcı kilitlenmez, ama anahtar korunur.
    expect(f.state.reads).toBe(3);
    expect(f.sync.ready()).toBe(true);
    expect(f.sync.guarded()).toBe(true);
    const fresh = f.loads[0]!.draft;
    expect(draftHasContent(fresh)).toBe(false);
    // "Yeni ölçüm" → reset(true): boş taslak beklemeden yazılır → silme olurdu.
    f.sync.changed({ owner: ayseA, draft: blank() }, true);
    await f.sync.idle();
    expect(await rawValue(ayseA)).toBe(before);
    // Kişi yeni içerik girdi; okuma hâlâ bozuk → üstüne yazılmaz.
    f.sync.changed({ owner: ayseA, draft: { ...fresh, trackingRaw: 'YENI' } });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect(await rawValue(ayseA)).toBe(before);
    await f.sync.flush();
    expect(await rawValue(ayseA)).toBe(before);
  });

  it('korumalı açılıştan sonra okuma düzelince, bellek boşsa saklı taslak geri gelir', async () => {
    const saved = full();
    await writeDraft(ayseA, saved, NOW - 5000);
    const f = flaky();
    f.sync.setScope(ayseA);
    await f.sync.idle();
    await vi.advanceTimersByTimeAsync(4000);
    await f.sync.idle();
    expect(f.sync.guarded()).toBe(true);
    f.sync.changed({ owner: ayseA, draft: f.loads[0]!.draft });
    f.state.broken = false;
    // Uygulama öne geldi.
    await f.sync.retry();
    expect(f.loads.length).toBe(2);
    expect(f.loads[1]?.draft).toEqual(saved);
    expect(f.sync.guarded()).toBe(false);
  });

  it('korumalı açılışta okuma düzelir ve saklı taslak yoksa yeni içerik yazılır; saklı taslak varsa yazılmaz', async () => {
    // Saklı taslak yok.
    const f = flaky();
    f.sync.setScope(ayseA);
    await f.sync.idle();
    await vi.advanceTimersByTimeAsync(4000);
    await f.sync.idle();
    expect(f.sync.guarded()).toBe(true);
    f.state.broken = false;
    f.sync.changed({ owner: ayseA, draft: { ...f.loads[0]!.draft, trackingRaw: 'YENI' } });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.trackingRaw).toBe('YENI');
    expect(f.sync.guarded()).toBe(false);

    // Saklı taslak var (B kapsamı).
    const saved = full();
    await writeDraft(ayseB, saved, NOW - 5000);
    const before = await rawValue(ayseB);
    const g = flaky();
    g.sync.setScope(ayseB);
    await g.sync.idle();
    await vi.advanceTimersByTimeAsync(4000);
    await g.sync.idle();
    g.state.broken = false;
    g.sync.changed({ owner: ayseB, draft: { ...g.loads[0]!.draft, trackingRaw: 'BASKA' } });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await g.sync.idle();
    expect(await rawValue(ayseB)).toBe(before);
    // Bellekte içerik varken öne gelme de saklı taslağı ezmez, belleği de değiştirmez.
    await g.sync.retry();
    expect(g.loads.length).toBe(1);
    expect(await rawValue(ayseB)).toBe(before);
  });

  /** Okuma üç kez hata verir: kapı korumalı açılır. */
  const exhaust = async (sync: ReturnType<typeof createDraftSync>) => {
    await sync.idle();
    await vi.advanceTimersByTimeAsync(1000);
    await sync.idle();
    await vi.advanceTimersByTimeAsync(3000);
    await sync.idle();
  };

  it('korumalı açılışta yeni ölçüm (Y48): okuma bozukken yedek anahtara yazılır, asıl anahtar olduğu gibi kalır; sonraki açılışta saklı taslak, o bitince yeni ölçüm geri gelir', async () => {
    const saved = full({ trackingRaw: 'SAKLI' });
    await writeDraft(ayseA, saved, NOW - 5000);
    const before = await rawValue(ayseA);
    const f = flaky();
    f.sync.setScope(ayseA);
    await exhaust(f.sync);
    expect(f.sync.guarded()).toBe(true);
    const fresh = f.loads[0]!.draft;
    const typed = { ...fresh, trackingRaw: 'YENI', weightKg: 3.2 };
    f.sync.changed({ owner: ayseA, draft: typed });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect(await rawValue(ayseA)).toBe(before);
    expect(await spares(ayseA)).toEqual([{ key: spareDraftKey(ayseA, fresh.clientId), draft: typed }]);
    // Arka plana geçerken (flush) de yalnız yedek güncellenir.
    f.sync.changed({ owner: ayseA, draft: { ...typed, note: 'n' } });
    await f.sync.flush();
    expect(await rawValue(ayseA)).toBe(before);
    expect((await spares(ayseA))[0]?.draft?.note).toBe('n');

    // Uygulama kapandı, yeniden açıldı; okuma düzeldi: önce saklı taslak gelir.
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    expect(h.last().draft).toEqual(saved);
    // Saklı taslak bitti (kaydedildi): asıl anahtar boşaldı; sonraki açılışta yeni ölçüm gelir.
    h.sync.changed({ owner: ayseA, draft: blank() }, true);
    await h.sync.idle();
    const again = harness();
    again.sync.setScope(ayseA);
    await settle(again.sync);
    expect(again.last().draft).toEqual({ ...typed, note: 'n' });
    expect(await spares(ayseA)).toEqual([]);
  });

  it('korumalı açılışta (Y48): okuma düzelir ama başka saklı taslak çıkarsa yeni ölçüm yedeğe yazılır; taslak kaydedilip boşalınca yedek silinir', async () => {
    const saved = full({ trackingRaw: 'SAKLI' });
    await writeDraft(ayseA, saved, NOW - 5000);
    const before = await rawValue(ayseA);
    const f = flaky();
    f.sync.setScope(ayseA);
    await exhaust(f.sync);
    f.state.broken = false;
    const fresh = f.loads[0]!.draft;
    f.sync.changed({ owner: ayseA, draft: { ...fresh, trackingRaw: 'BASKA' } });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect(await rawValue(ayseA)).toBe(before);
    expect((await spares(ayseA)).map((s) => s.draft?.trackingRaw)).toEqual(['BASKA']);
    expect(f.sync.guarded()).toBe(true);
    // Kaydedildi → reset: boş taslak beklemeden; bu oturumun yedeği silinir, asıl anahtar kalır.
    f.sync.changed({ owner: ayseA, draft: blank() }, true);
    await f.sync.idle();
    expect(await spares(ayseA)).toEqual([]);
    expect(await rawValue(ayseA)).toBe(before);
  });

  it('korumalı açılışta (Y48): yedeği yazılmış taslak, okuma düzelince kendi yedeği olarak tanınır ve asıl anahtara geçer', async () => {
    const f = flaky();
    f.sync.setScope(ayseA);
    await exhaust(f.sync);
    const typed = { ...f.loads[0]!.draft, trackingRaw: 'YENI' };
    f.sync.changed({ owner: ayseA, draft: typed });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect((await spares(ayseA)).length).toBe(1);
    expect(await rawValue(ayseA)).toBeNull();
    f.state.broken = false;
    await f.sync.retry();
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DELAY_MS);
    await f.sync.idle();
    expect(f.sync.guarded()).toBe(false);
    expect(f.loads.length).toBe(1);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)).toEqual(typed);
    expect(await spares(ayseA)).toEqual([]);
  });

  it('korumalı açılış her kapsam için hatırlanır (Y48): A korumalıyken B de korumalı açılırsa A için bekleyen değişiklik A anahtarını ezmez', async () => {
    const savedA = full({ trackingRaw: 'A-SAKLI' });
    await writeDraft(ayseA, savedA, NOW - 5000);
    const beforeA = await rawValue(ayseA);
    const f = flaky();
    f.sync.setScope(ayseA);
    await exhaust(f.sync);
    expect(f.sync.guarded()).toBe(true);
    const a = f.loads[0]!.draft;
    // Firma B'ye geçildi; B de okunamıyor. B okunurken bellek hâlâ A'nın taslağı ve kişi yazmaya devam ediyor.
    f.sync.setScope(ayseB);
    f.sync.changed({ owner: ayseA, draft: { ...a, trackingRaw: 'A-YENI' } });
    await exhaust(f.sync);
    expect(f.loads.map((l) => l.owner)).toEqual([ayseA, ayseB]);
    // Sağlayıcı gibi: bellek B'nin taslağına geçti.
    f.sync.changed({ owner: ayseB, draft: f.loads[1]!.draft });
    expect(f.sync.guarded()).toBe(true);
    expect(await rawValue(ayseA)).toBe(beforeA);
    expect((await spares(ayseA)).map((s) => s.draft?.trackingRaw)).toEqual(['A-YENI']);
    // A'ya dönülür, okuma düzelmiş: A'nın saklı taslağı geri gelir; yeni ölçüm yedekte sırasını bekler.
    f.state.broken = false;
    f.sync.setScope(ayseA);
    await settle(f.sync);
    expect(f.loads[2]).toMatchObject({ owner: ayseA, draft: savedA });
    expect((await spares(ayseA)).length).toBe(1);
  });

  it('yeniden deneme zamanlayıcısı (Y48): okuma sıradayken öne gelme ikinci okuma başlatmaz; sağlayıcı ayrılınca zamanlayıcı kalmaz', async () => {
    const saved = full();
    await writeDraft(ayseA, saved, NOW - 5000);
    let reads = 0;
    let fail = true;
    const gate: { open?: () => void } = {};
    const loads: Draft[] = [];
    const sync = createDraftSync({
      restore: async (sc) => {
        reads++;
        if (fail) throw new Error('SQLITE_BUSY');
        await new Promise<void>((res) => (gate.open = res));
        return restoreDraft(sc, deps().value);
      },
      write: (sc, d) => writeDraft(sc, d, NOW),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d, NOW),
      removeSpare: deleteSpareDraft,
      fresh: () => blank(),
      onLoaded: (_o, d) => loads.push(d),
    });
    sync.setScope(ayseA);
    await sync.idle();
    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    // Öne geldi: okuma yeniden başlar ve sürerken bir öne gelme daha.
    fail = false;
    void sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2);
    void sync.retry();
    gate.open?.();
    await sync.idle();
    await vi.advanceTimersByTimeAsync(5000);
    await sync.idle();
    expect(reads).toBe(2);
    expect(loads).toEqual([saved]);

    // Okuma bozuk, yeniden deneme bekliyor; sağlayıcı ayrıldı: zamanlayıcı durur, bir daha okunmaz.
    fail = true;
    sync.setScope(ayseB);
    await sync.idle();
    expect(reads).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    await sync.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await sync.idle();
    expect(reads).toBe(3);
  });

  it('okuma hatası sırasında firma değişirse eski kapsam yeniden denenmez', async () => {
    const f = flaky();
    f.sync.setScope(ayseA);
    await f.sync.idle();
    f.state.broken = false;
    f.sync.setScope(ayseB);
    await f.sync.idle();
    await vi.advanceTimersByTimeAsync(5000);
    await f.sync.idle();
    expect(f.loads.map((l) => l.owner)).toEqual([ayseB]);
  });

  it('açılışta süresi dolmuş taslaklar bir kez süpürülür', async () => {
    const sweep = vi.fn(async () => 0);
    const sync = createDraftSync({
      restore: (sc) => restoreDraft(sc, deps().value),
      write: (sc, d) => writeDraft(sc, d, NOW),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d, NOW),
      removeSpare: deleteSpareDraft,
      fresh: () => blank(),
      onLoaded: () => undefined,
      sweep,
    });
    sync.setScope(ayseA);
    await sync.idle();
    sync.setScope(ayseB);
    await sync.idle();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('değişiklik 300 ms sonra yazılır; içerik kalmazsa silinir; reset beklemeden siler', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    const d = { ...h.last().draft, trackingRaw: 'TRK9' };
    h.sync.changed({ owner: ayseA, draft: d });
    await h.sync.idle();
    expect(await rawValue(ayseA)).toBeNull();
    await settle(h.sync);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.trackingRaw).toBe('TRK9');

    h.sync.changed({ owner: ayseA, draft: { ...d, trackingRaw: '' } });
    await settle(h.sync);
    expect(await rawValue(ayseA)).toBeNull();

    h.sync.changed({ owner: ayseA, draft: { ...d, weightKg: 3 } });
    await settle(h.sync);
    expect(await rawValue(ayseA)).not.toBeNull();
    // reset: yeni boş taslak, beklemeden.
    h.sync.changed({ owner: ayseA, draft: blank() }, true);
    await h.sync.idle();
    expect(await rawValue(ayseA)).toBeNull();
  });

  it('arka plana geçerken bekleyen yazma hemen yapılır', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    h.sync.changed({ owner: ayseA, draft: { ...h.last().draft, weightKg: 5 } });
    await h.sync.flush();
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.weightKg).toBe(5);
  });

  it('kapsam A → B: A için gecikmeli yazma A anahtarına gider, B anahtarına gitmez; A silinmez', async () => {
    const forB = full({ trackingRaw: 'B-TASLAK' });
    await writeDraft(ayseB, forB, NOW);
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    const a = { ...h.last().draft, trackingRaw: 'A-TASLAK', weightKg: 1.5 };
    h.sync.changed({ owner: ayseA, draft: a });
    // 300 ms dolmadan firma değişti.
    h.sync.setScope(ayseB);
    await settle(h.sync);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)).toEqual(a);
    expect(parseStoredDraft((await rawValue(ayseB))!, NOW)).toEqual(forB);
    expect(h.last()).toMatchObject({ owner: ayseB, draft: forB });
  });

  it('geçiş sürerken eski taslakta yapılan değişiklik de kendi anahtarına gider', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    const a = h.last().draft;
    h.sync.setScope(ayseB);
    // B okunurken bellek hâlâ A'nın taslağı.
    h.sync.changed({ owner: ayseA, draft: { ...a, note: 'geçişte' } });
    await settle(h.sync);
    expect(h.last().owner).toEqual(ayseB);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.note).toBe('geçişte');
    expect(await rawValue(ayseB)).toBeNull();
  });

  it('kapsam A → B → A: A taslağı ve fotoğrafları korunur, geri gelir', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    const a = { ...h.last().draft, ...full({ clientId: h.last().draft.clientId }) };
    h.sync.changed({ owner: ayseA, draft: a });
    await settle(h.sync);
    h.sync.setScope(ayseB);
    await settle(h.sync);
    h.sync.changed({ owner: ayseB, draft: { ...h.last().draft, trackingRaw: 'B1' } });
    await settle(h.sync);
    h.sync.setScope(ayseA);
    await settle(h.sync);
    expect(h.last()).toMatchObject({ owner: ayseA, draft: a, missing: 0 });
    expect(parseStoredDraft((await rawValue(ayseB))!, NOW)?.trackingRaw).toBe('B1');
  });

  it('kapsam null iken okunmaz, yazılmaz; aynı kapsam dönünce yeniden okunmaz, arada yapılan değişiklik yazılır', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    const a = { ...h.last().draft, trackingRaw: 'A1' };
    h.sync.changed({ owner: ayseA, draft: a });
    await settle(h.sync);

    h.sync.setScope(null);
    const during = { ...a, weightKg: 7 };
    h.sync.changed({ owner: ayseA, draft: during });
    await h.sync.flush();
    await settle(h.sync);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.weightKg).toBeNull();
    expect(h.sync.ready()).toBe(false);

    h.sync.setScope(ayseA);
    await settle(h.sync);
    expect(h.restores).toEqual(['draft:ayse:firmaA']);
    expect(h.loads.length).toBe(1);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.weightKg).toBe(7);
  });

  it('kapsam null iken başka kişi gelirse öncekinin bekleyen değişikliği kendi anahtarına yazılır', async () => {
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    h.sync.setScope(null);
    h.sync.changed({ owner: ayseA, draft: { ...h.last().draft, trackingRaw: 'A-NULL' } });
    h.sync.setScope(mehmetA);
    await settle(h.sync);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.trackingRaw).toBe('A-NULL');
    expect(await rawValue(mehmetA)).toBeNull();
    expect(h.last().owner).toEqual(mehmetA);
  });

  it('kuyruğa girmiş taslak açılışta geri gelmez (kaydet sonrası, silmeden önce kapanma)', async () => {
    const d = full();
    await writeDraft(ayseA, d, NOW);
    await insertRow(ayseA, { clientId: d.clientId, data: draftPayload(d, new Date(NOW)), photos: [] });
    const h = harness();
    h.sync.setScope(ayseA);
    await settle(h.sync);
    expect(h.last().draft.clientId).not.toBe(d.clientId);
    expect(draftHasContent(h.last().draft)).toBe(false);
    expect(await rawValue(ayseA)).toBeNull();
  });

  it('eksik fotoğraflı taslağın temizlenmiş hâli bir sonraki eşitlemede yazılır', async () => {
    await writeDraft(ayseA, full(), NOW - 1000);
    const loads: { draft: Draft; missing: number }[] = [];
    const sync = createDraftSync({
      restore: (sc) => restoreDraft(sc, deps({ exists: (u) => u.endsWith('box1.jpg') }).value),
      write: (sc, d) => writeDraft(sc, d, NOW),
      remove: deleteDraft,
      writeSpare: (sc, d) => writeSpareDraft(sc, d, NOW),
      removeSpare: deleteSpareDraft,
      fresh: () => blank(),
      onLoaded: (_o, draft, missing) => loads.push({ draft, missing }),
    });
    sync.setScope(ayseA);
    await settle(sync);
    expect(loads[0]?.missing).toBe(1);
    sync.changed({ owner: ayseA, draft: loads[0]!.draft });
    await settle(sync);
    expect(parseStoredDraft((await rawValue(ayseA))!, NOW)?.photos.length).toBe(1);
  });
});
