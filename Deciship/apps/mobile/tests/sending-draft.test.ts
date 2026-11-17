/**
 * Y48 inceleme maddesi: özet ekranında kayıt "şu an gönderiliyor" (SENDING) dönerse taslak silinmez. Burada her gönderim
 * sonucunda kuyruk satırının akıbeti sınanır: başarısız gönderimde ölçüler ve fotoğraf yolları kuyrukta kalır, satır yeniden
 * gönderilebilir; tutulan taslakla yeniden Kaydet son değerleri satıra yazar.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development' } } } } }));

import { ApiError } from '../src/api/client';
import type { MeasurementPayload } from '../src/api/endpoints';
import type { Draft } from '../src/draft/DraftContext';
import { createDraftSync, deleteDraft, draftAfterSave, saveDraftToQueue, writeDraft, type SaveOutcome } from '../src/draft/persist';
import { runFlush } from '../src/queue/flush';
import { dueRows, getRow, insertRow, recoverInterrupted, updateUnsent, type QueuePhoto, type QueueRow } from '../src/queue/store';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };

const draft = (over: Partial<Draft> = {}): Draft => ({
  clientId: 'c-sending',
  trackingRaw: 'TRK-S',
  weightKg: 2.4,
  weightMethod: 'MANUAL',
  ocrWeightKg: null,
  lengthCm: 40,
  widthCm: 30,
  heightCm: 20,
  dimMethod: 'MANUAL',
  dimConfidence: null,
  boxPresetId: null,
  photos: [
    { id: 'p1', uri: 'file:///cache/box1.jpg', kind: 'PHOTO_BOX' },
    { id: 'p2', uri: 'file:///cache/scale.jpg', kind: 'PHOTO_SCALE' },
  ],
  note: '',
  startedAt: 1_762_900_000_000,
  ...over,
});

/** Kuyruğun kendi kopyaları (`copyToQueue` gibi): taslak dosyalarından ayrı yol. */
const queuePath = (clientId: string, i: number) => `file:///doc/queue/${clientId}/${i}.jpg`;

/** QueueContext'in özet ekranına verdiği üç işlem, gerçek kuyruk tablosu üzerinde. */
const q = {
  getLocal: (id: string) => getRow(ayseA, id),
  enqueue: async (data: MeasurementPayload, photos: QueuePhoto[]) =>
    insertRow(ayseA, { clientId: data.clientId, data, photos: photos.map((p, i) => ({ kind: p.kind, uri: queuePath(data.clientId, i) })) }),
  editLocal: (id: string, data: MeasurementPayload, photos: QueuePhoto[]) =>
    updateUnsent(ayseA, id, data, photos.map((p, i) => ({ kind: p.kind, uri: queuePath(id, i) }))),
};

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

/**
 * İlk Kaydet satırı yazar. Gönderim başlar; gönderim sürerken kişi taslağı düzeltip yeniden Kaydet'e basar (`sending`,
 * taslak tutulur); sonra gönderim `fail` ile biter. Satır ve tutulan taslak döner.
 */
async function sendingThenFail(fail: unknown) {
  const d = draft();
  await expect(saveDraftToQueue(d, new Date(), q)).resolves.toBe('queued');
  const corrected = { ...d, weightKg: 3.1 };
  let during: SaveOutcome | null = null;
  await runFlush({
    scope: ayseA,
    currentScope: () => ayseA,
    send: async () => {
      expect((await getRow(ayseA, d.clientId))?.status).toBe('SENDING');
      during = await saveDraftToQueue(corrected, new Date(), q);
      throw fail;
    },
    describe: (e) => String((e as Error).message),
  });
  expect(during).toBe('sending');
  expect(draftAfterSave(during!)).toBe('keep');
  return { d, corrected, row: (await getRow(ayseA, d.clientId))! };
}

/** Ölçüler ve fotoğraf yolları ilk kayıttaki gibi kuyrukta. */
function expectIntact(row: QueueRow, d: Draft) {
  expect(row).not.toBeNull();
  expect(row.data).toMatchObject({ lengthCm: d.lengthCm, widthCm: d.widthCm, heightCm: d.heightCm, weightKg: d.weightKg, trackingRaw: d.trackingRaw });
  expect(row.photos).toEqual([
    { kind: 'PHOTO_BOX', uri: queuePath(d.clientId, 0) },
    { kind: 'PHOTO_SCALE', uri: queuePath(d.clientId, 1) },
  ]);
}

/** Tutulan taslakla yeniden Kaydet son değeri yazar; satır yeniden gönderilir ve gider. */
async function resaveAndSend(corrected: Draft) {
  await expect(saveDraftToQueue(corrected, new Date(), q)).resolves.toBe('updated');
  const after = (await getRow(ayseA, corrected.clientId))!;
  expect(after.status).toBe('PENDING');
  expect(after.data.weightKg).toBe(3.1);
  expect(after.photos.length).toBe(2);
  expect((await dueRows(ayseA, false)).map((r) => r.clientId)).toEqual([corrected.clientId]);
  const sent: QueueRow[] = [];
  await runFlush({ scope: ayseA, currentScope: () => ayseA, send: async (r) => (sent.push(r), 'srv-1'), describe: String });
  expect(sent.map((r) => r.data.weightKg)).toEqual([3.1]);
  expect((await getRow(ayseA, corrected.clientId))?.status).toBe('SENT');
}

describe('SENDING iken taslak tutulur; gönderim başarısız → ölçüm kuyrukta kalır ve yeniden gönderilir', () => {
  it('ağ hatası: satır PENDING, değerler ve fotoğraflar yerinde', async () => {
    const { d, corrected, row } = await sendingThenFail(new ApiError(0, 'NETWORK', 'yok'));
    expect(row.status).toBe('PENDING');
    expectIntact(row, d);
    await resaveAndSend(corrected);
  });

  it('5xx (geçici sunucu hatası): satır PENDING, değerler ve fotoğraflar yerinde', async () => {
    const { d, corrected, row } = await sendingThenFail(new ApiError(503, 'UNAVAILABLE', 'meşgul'));
    expect(row.status).toBe('PENDING');
    expectIntact(row, d);
    await resaveAndSend(corrected);
  });

  it('4xx kayda özgü ret: satır ERROR (Hatalı), değerler ve fotoğraflar yerinde; düzeltilip yeniden gönderilir', async () => {
    const { d, corrected, row } = await sendingThenFail(new ApiError(400, 'VALIDATION', 'geçersiz'));
    expect(row.status).toBe('ERROR');
    expect(row.lastError).toBe('geçersiz');
    expectIntact(row, d);
    await resaveAndSend(corrected);
  });

  it('4xx sunucu ayarı sorunu (404): satır PENDING (uzun erteleme), Hatalı olmaz', async () => {
    const { d, corrected, row } = await sendingThenFail(new ApiError(404, 'NOT_FOUND', 'yok'));
    expect(row.status).toBe('PENDING');
    expectIntact(row, d);
    await resaveAndSend(corrected);
  });

  it('yetki engeli (403 READ_ONLY) ve ApiError olmayan hata: satır PENDING', async () => {
    const a = await sendingThenFail(new ApiError(403, 'READ_ONLY', 'salt okunur'));
    expect(a.row.status).toBe('PENDING');
    expectIntact(a.row, a.d);
    db = openTestDb();
    await migrate(db);
    const b = await sendingThenFail(new Error('dosya okunamadı'));
    expect(b.row.status).toBe('PENDING');
    expectIntact(b.row, b.d);
    await resaveAndSend(b.corrected);
  });

  it('uygulama gönderim sırasında kapandı: satır SENDING kalır, açılışta PENDING olur, değerler ve fotoğraflar yerinde', async () => {
    const d = draft();
    await saveDraftToQueue(d, new Date(), q);
    let during: SaveOutcome | null = null;
    // Gönderim hiç bitmez (süreç öldü): satır SENDING'de takılı.
    void runFlush({
      scope: ayseA,
      currentScope: () => ayseA,
      send: async () => {
        during = await saveDraftToQueue({ ...d, weightKg: 3.1 }, new Date(), q);
        return new Promise<string>(() => undefined);
      },
      describe: String,
    });
    await vi.waitFor(() => expect(during).toBe('sending'));
    expect((await getRow(ayseA, d.clientId))?.status).toBe('SENDING');
    // Yeniden açılış (QueueContext: `recoverInterrupted` gönderimden önce).
    await recoverInterrupted();
    const row = (await getRow(ayseA, d.clientId))!;
    expect(row.status).toBe('PENDING');
    expectIntact(row, d);
    await resaveAndSend({ ...d, weightKg: 3.1 });
  });

  it('başarılı gönderimden sonra tutulan taslakla yeniden Kaydet "gönderildi" der, ikinci kayıt açılmaz; taslak düşer', async () => {
    const d = draft();
    await saveDraftToQueue(d, new Date(), q);
    await runFlush({ scope: ayseA, currentScope: () => ayseA, send: async () => 'srv-ok', describe: String });
    const outcome = await saveDraftToQueue({ ...d, weightKg: 3.1 }, new Date(), q);
    expect(outcome).toBe('alreadySent');
    expect(draftAfterSave(outcome)).toBe('drop');
    expect(draftAfterSave('queued')).toBe('drop');
    expect(draftAfterSave('updated')).toBe('drop');
    const n = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM queue');
    expect(n?.n).toBe(1);
  });
});

describe('korumalı kapsamın yedek yazması zorunlu bağımlılık', () => {
  const base = {
    restore: async () => null,
    write: (sc: typeof ayseA, d: Draft) => writeDraft(sc, d),
    remove: deleteDraft,
    fresh: () => draft(),
    onLoaded: () => undefined,
  };

  it('writeSpare ya da removeSpare verilmezse eşitleme kurulmaz (sessizce yazmamak yerine düşer)', () => {
    expect(() => createDraftSync({ ...base, removeSpare: async () => undefined } as never)).toThrow(/writeSpare/);
    expect(() => createDraftSync({ ...base, writeSpare: async () => undefined } as never)).toThrow(/removeSpare/);
    expect(() => createDraftSync({ ...base, writeSpare: async () => undefined, removeSpare: async () => undefined })).not.toThrow();
  });

  it('DraftProvider yedek yazmayı ve silmeyi her zaman bağlar', () => {
    const src = readFileSync(new URL('../src/draft/DraftContext.tsx', import.meta.url), 'utf8');
    const start = src.indexOf('createDraftSync({');
    expect(start).toBeGreaterThan(0);
    // Çağrının gövdesi: sonraki `onError` satırına kadar.
    const call = src.slice(start, src.indexOf('onError:', start));
    expect(call).toMatch(/writeSpare: \(sc, d\) => writeSpareDraft\(sc, d\)/);
    expect(call).toMatch(/removeSpare: deleteSpareDraft/);
  });
});
