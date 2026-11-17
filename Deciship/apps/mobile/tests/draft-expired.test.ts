/**
 * 11-B5 (bildirim): süresi dolup silinen yarım ölçüm çalışana bir kez söylenir. Bilgi yerel `kv` tablosunda kalır:
 * uygulama yeniden açılsa da kapatılana kadar durur, kapatılınca bir daha görünmez. Süre (`DRAFT_TTL_MS`) değişmez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));

import type { Draft } from '../src/draft/DraftContext';
import { dismissExpiredNotices, expiredNoticeText, listExpiredNotices, onExpiredNoticesChanged } from '../src/draft/expiredNotice';
import { draftKey, draftPayload, restoreDraft, sweepExpiredDrafts, writeDraft, writeSpareDraft, DRAFT_TTL_DAYS, DRAFT_TTL_MS } from '../src/draft/persist';
import { insertRow, rowExists } from '../src/queue/store';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const ayseB = { personId: 'ayse', orgId: 'firmaB' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };

let ids = 0;
const draft = (over: Partial<Draft> = {}): Draft => ({
  clientId: `e${++ids}`,
  trackingRaw: 'TRK-CUMA',
  weightKg: 2.4,
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
  startedAt: Date.now(),
  ...over,
});

const deps = () => ({ exists: () => true, rowExists, deletePhoto: () => undefined, now: Date.now() });
const friday = () => new Date(2026, 10, 6, 17, 0);
const monday = () => new Date(2026, 10, 9, 9, 0);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(friday());
  db = openTestDb();
  await migrate(db);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('süresi dolan yarım ölçüm bildirimi', () => {
  it('süre dolunca bildirim bir kez görünür: yeniden açılışta durur, kapatılınca bir daha görünmez', async () => {
    const d = draft();
    await writeDraft(ayseA, d, Date.now());
    vi.setSystemTime(monday());
    expect(await restoreDraft(ayseA, deps())).toBeNull();

    const list = await listExpiredNotices(draftKey(ayseA));
    expect(list).toEqual([{ clientId: d.clientId, trackingRaw: 'TRK-CUMA', startedAt: friday().getTime(), deletedAt: monday().getTime() }]);
    // Uygulama kapanıp açıldı, bilgi kapatılmadı: hâlâ orada.
    expect(await listExpiredNotices(draftKey(ayseA))).toEqual(list);
    // Başka kişi ya da başka firma görmez.
    expect(await listExpiredNotices(draftKey(ayseB))).toEqual([]);
    expect(await listExpiredNotices(draftKey(mehmetA))).toEqual([]);

    await dismissExpiredNotices([d.clientId]);
    expect(await listExpiredNotices(draftKey(ayseA))).toEqual([]);
    // Taslak artık yok: yeniden okuma ve süpürme bilgiyi geri getirmez.
    expect(await restoreDraft(ayseA, deps())).toBeNull();
    await sweepExpiredDrafts(() => undefined, Date.now());
    expect(await listExpiredNotices(draftKey(ayseA))).toEqual([]);
  });

  it('süresi dolmayan ya da kuyruğa girmiş (kaydedilmiş) taslak için bildirim yok', async () => {
    await writeDraft(ayseA, draft(), Date.now());
    vi.setSystemTime(new Date(Date.now() + DRAFT_TTL_MS - 60_000));
    expect(await restoreDraft(ayseA, deps())).not.toBeNull();

    const q = draft();
    await writeDraft(ayseB, q, Date.now());
    await insertRow(ayseB, { clientId: q.clientId, data: draftPayload({ ...q, lengthCm: 1, widthCm: 1, heightCm: 1 }, new Date()), photos: [] });
    expect(await restoreDraft(ayseB, deps())).toBeNull();

    expect(await listExpiredNotices(draftKey(ayseA))).toEqual([]);
    expect(await listExpiredNotices(draftKey(ayseB))).toEqual([]);
  });

  it('açılış süpürmesi de bildirim bırakır; her kişi kendi bildirimini görür; yedek anahtardaki taslak da sayılır', async () => {
    const m = draft({ trackingRaw: '' });
    const spare = draft({ trackingRaw: 'YEDEK' });
    await writeDraft(mehmetA, m, Date.now());
    await writeSpareDraft(ayseA, spare, Date.now() - 1000);
    vi.setSystemTime(monday());
    expect(await sweepExpiredDrafts(() => undefined, Date.now())).toBe(2);
    expect((await listExpiredNotices(draftKey(mehmetA))).map((n) => n.clientId)).toEqual([m.clientId]);
    expect((await listExpiredNotices(draftKey(ayseA))).map((n) => n.trackingRaw)).toEqual(['YEDEK']);
  });

  it('bildirim eklenince ve kapatılınca dinleyiciye haber verilir', async () => {
    const seen = vi.fn();
    const off = onExpiredNoticesChanged(seen);
    const d = draft();
    await writeDraft(ayseA, d, Date.now());
    vi.setSystemTime(monday());
    await restoreDraft(ayseA, deps());
    expect(seen).toHaveBeenCalledTimes(1);
    await dismissExpiredNotices([d.clientId]);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    await dismissExpiredNotices([d.clientId]);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('metin: gün ve saat, takip no varsa takip no; süre gün olarak', () => {
    const t = (key: string, o: Record<string, unknown>) => `${key}|${JSON.stringify(o)}`;
    const when = (ms: number) => `W${ms}`;
    const base = { clientId: 'x', startedAt: 5, deletedAt: 9 };
    // Süre kullanıcı kararıyla değişirse metin kendiliğinden uyar.
    expect(DRAFT_TTL_DAYS).toBe(2);
    expect(expiredNoticeText({ ...base, trackingRaw: ' TRK9 ' }, t, when, DRAFT_TTL_DAYS)).toBe(`draft.expiredText|${JSON.stringify({ when: 'W5', tracking: 'TRK9', days: 2 })}`);
    expect(expiredNoticeText({ ...base, trackingRaw: '  ' }, t, when, DRAFT_TTL_DAYS)).toBe(`draft.expiredTextNoTracking|${JSON.stringify({ when: 'W5', days: 2 })}`);
  });
});
