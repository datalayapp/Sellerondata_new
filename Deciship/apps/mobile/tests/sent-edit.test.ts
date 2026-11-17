import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));

import { getRow, insertRow, markSending, markSent, rowsSince, updateSentFromServer } from '../src/queue/store';
import type { MeasurementItem, MeasurementPayload } from '../src/api/endpoints';

/**
 * Gezide: barkod ekranındaki "Son okunanlar" (kuyruğun bugünkü satırları) gönderilmiş ölçüm düzeltildikten sonra eski değeri
 * gösteriyordu. Düzeltme sunucuya kaydedilince telefondaki gönderilmiş satır yeni sürüme taşınır.
 */
const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };

const payload = (clientId: string): MeasurementPayload => ({
  clientId,
  trackingRaw: 'TRK-1',
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightKg: 1,
  dimMethod: 'MANUAL',
  weightMethod: 'SCALE_OCR',
  dimConfidence: 0.8,
  boxPresetId: 'kutu1',
  note: 'eski not',
  measuredAt: new Date().toISOString(),
  photoKinds: ['BOX'],
});

const version = (id: string, over: Partial<MeasurementItem> = {}): MeasurementItem => ({
  id,
  trackingNo: 'TRK1',
  trackingRaw: 'TRK-1',
  lengthCm: 20,
  widthCm: 30,
  heightCm: 40,
  weightKg: 2.5,
  dimMethod: 'MANUAL',
  weightMethod: 'MANUAL',
  measuredAt: new Date().toISOString(),
  note: null,
  boxPresetId: null,
  dimConfidence: null,
  ...over,
});

async function sent(scope: typeof ayseA, clientId: string, serverId: string) {
  await insertRow(scope, { clientId, data: payload(clientId), photos: [] });
  await markSending(scope, clientId);
  await markSent(clientId, serverId);
}

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

describe('gönderilmiş ölçüm sunucuda düzeltildi', () => {
  it('telefondaki satır yeni değerleri ve yeni sürümün kimliğini alır; durum ve gönderim anı değişmez', async () => {
    await sent(ayseA, 'c1', 'v1');
    const before = (await getRow(ayseA, 'c1'))!;
    expect(await updateSentFromServer(ayseA, 'v1', version('v2', { trackingRaw: 'TRK-9' }))).toBe(true);
    const row = (await getRow(ayseA, 'c1'))!;
    expect(row.serverId).toBe('v2');
    expect(row.status).toBe('SENT');
    expect(row.sentAt).toBe(before.sentAt);
    expect(row.data).toMatchObject({ clientId: 'c1', trackingRaw: 'TRK-9', lengthCm: 20, widthCm: 30, heightCm: 40, weightKg: 2.5, weightMethod: 'MANUAL' });
    // Sunucu alanı boşalttıysa eski değer kalmaz.
    expect(row.data.note).toBeUndefined();
    expect(row.data.boxPresetId).toBeUndefined();
    expect(row.data.dimConfidence).toBeUndefined();
    // Son okunanlar listesi (bugünkü satırlar) yeni değeri görür.
    const recent = await rowsSince(ayseA, 0);
    expect(recent.map((r) => r.data.weightKg)).toEqual([2.5]);
  });

  it('ikinci düzeltme zinciri izler (eski kimlik → yeni kimlik)', async () => {
    await sent(ayseA, 'c1', 'v1');
    await updateSentFromServer(ayseA, 'v1', version('v2'));
    await updateSentFromServer(ayseA, 'v2', version('v3', { weightKg: 7 }));
    const row = (await getRow(ayseA, 'c1'))!;
    expect(row.serverId).toBe('v3');
    expect(row.data.weightKg).toBe(7);
  });

  it('başka oturumun satırına dokunmaz; telefonda karşılığı yoksa bir şey değişmez', async () => {
    await sent(mehmetA, 'c2', 'v1');
    expect(await updateSentFromServer(ayseA, 'v1', version('v2'))).toBe(false);
    expect((await getRow(mehmetA, 'c2'))!.serverId).toBe('v1');
    expect(await updateSentFromServer(ayseA, 'yok', version('v9'))).toBe(false);
  });

  it('gönderilmemiş satıra dokunmaz', async () => {
    await insertRow(ayseA, { clientId: 'c3', data: payload('c3'), photos: [] });
    await db.runAsync(`UPDATE queue SET serverId = 'v1' WHERE clientId = 'c3'`);
    expect(await updateSentFromServer(ayseA, 'v1', version('v2'))).toBe(false);
    expect((await getRow(ayseA, 'c3'))!.data.weightKg).toBe(1);
  });

  it('düzeltme ekranı sunucu kaydından sonra kuyruğa bildirir', () => {
    const src = readFileSync('app/(tabs)/deciship/measurement/edit.tsx', 'utf8');
    const afterPatch = src.slice(src.indexOf('await Api.patchMeasurement('));
    expect(afterPatch.slice(0, 400)).toContain('noteServerEdit(');
  });
});
