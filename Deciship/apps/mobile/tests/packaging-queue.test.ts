import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development' } } } } }));

import type { Draft } from '../src/draft/DraftContext';
import { draftPayload, parseStoredDraft, writeDraft, draftKey } from '../src/draft/persist';
import { wirePayload } from '../src/queue/flush';
import { getRow, insertRow, markSending, markSent, updateSentFromServer, updateUnsent } from '../src/queue/store';
import { packagingOf } from '../src/lib/packaging';
import type { MeasurementItem, MeasurementPayload } from '../src/api/endpoints';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const NOW = 1_762_900_000_000;

const draft = (over: Partial<Draft> = {}): Draft => ({
  clientId: 'c1',
  trackingRaw: '771234567890',
  weightKg: 1.8,
  weightMethod: 'MANUAL',
  ocrWeightKg: null,
  lengthCm: 30,
  widthCm: 25,
  heightCm: 8,
  dimMethod: 'MANUAL',
  dimConfidence: null,
  boxPresetId: null,
  photos: [],
  note: '',
  startedAt: NOW - 1000,
  ...over,
});

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

describe('ambalaj taslakta ve kuyrukta', () => {
  it('kuyruğa giden yükte ambalaj var; taslakta yoksa kendi ambalajı', () => {
    expect(draftPayload(draft({ packaging: 'PAK' }), new Date(NOW)).packaging).toBe('PAK');
    expect(draftPayload(draft(), new Date(NOW)).packaging).toBe('OWN');
  });

  it('taslak diske yazılıp okununca ambalaj kalır; tanınmayan değer atılır', async () => {
    await writeDraft(ayseA, draft({ packaging: 'ENVELOPE' }), NOW);
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', draftKey(ayseA) as never);
    expect(parseStoredDraft(row!.value, NOW)!.packaging).toBe('ENVELOPE');
    const bad = JSON.stringify({ v: 1, savedAt: NOW, draft: { ...draft(), packaging: 'KUTU' } });
    const parsed = parseStoredDraft(bad, NOW)!;
    expect('packaging' in parsed).toBe(false);
    expect(packagingOf(parsed)).toBe('OWN');
  });

  it('gönderim gövdesi ambalajı taşır', async () => {
    const data = draftPayload(draft({ packaging: 'PAK' }), new Date(NOW));
    await insertRow(ayseA, { clientId: 'c1', data, photos: [] });
    const row = (await getRow(ayseA, 'c1'))!;
    expect(wirePayload(row.data, NOW).packaging).toBe('PAK');
  });

  it('eski kuyruk kaydı (alan yok) kendi ambalajı sayılır; gövdeye uydurma değer eklenmez', async () => {
    const { packaging: _p, ...old } = draftPayload(draft(), new Date(NOW));
    await insertRow(ayseA, { clientId: 'c1', data: old as MeasurementPayload, photos: [] });
    const row = (await getRow(ayseA, 'c1'))!;
    expect(row.data.packaging).toBeUndefined();
    expect(packagingOf(row.data)).toBe('OWN');
    expect('packaging' in wirePayload(row.data, NOW)).toBe(false);
  });

  it('gönderilmemiş kaydın düzeltmesi ambalajı değiştirir', async () => {
    const data = draftPayload(draft(), new Date(NOW));
    await insertRow(ayseA, { clientId: 'c1', data, photos: [] });
    expect(await updateUnsent(ayseA, 'c1', { ...data, packaging: 'ENVELOPE' }, [])).toBe(true);
    expect((await getRow(ayseA, 'c1'))!.data.packaging).toBe('ENVELOPE');
  });

  it('gönderilmiş kayıt sunucuda düzeltilince telefondaki satır yeni ambalajı alır; eski sunucu göndermezse eskisi kalır', async () => {
    await insertRow(ayseA, { clientId: 'c1', data: draftPayload(draft({ packaging: 'PAK' }), new Date(NOW)), photos: [] });
    await markSending(ayseA, 'c1');
    await markSent('c1', 'v1');
    const next = (id: string, over: Partial<MeasurementItem> = {}): MeasurementItem => ({
      id,
      trackingNo: '771234567890',
      trackingRaw: '771234567890',
      lengthCm: 30,
      widthCm: 25,
      heightCm: 8,
      weightKg: 1.8,
      dimMethod: 'MANUAL',
      weightMethod: 'MANUAL',
      measuredAt: new Date(NOW).toISOString(),
      ...over,
    });
    await updateSentFromServer(ayseA, 'v1', next('v2'));
    expect((await getRow(ayseA, 'c1'))!.data.packaging).toBe('PAK');
    await updateSentFromServer(ayseA, 'v2', next('v3', { packaging: 'OWN' }));
    expect((await getRow(ayseA, 'c1'))!.data.packaging).toBe('OWN');
  });
});
