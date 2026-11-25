/**
 * 11-B4: yarım ölçümün (taslak) fotoğrafları önbellekte değil, kalıcı belge klasöründe (`drafts/<clientId>/`) durur.
 * Telefon önbelleği temizlese de kanıt fotoğrafı kaybolmaz. Eski taslakların önbellek adresleri geri yüklemede taşınır.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/queue/schema';
import { openTestDb, type TestDb } from './helpers';
import { fakeFs } from './fakeFs';

let db: TestDb;
vi.mock('../src/queue/db', () => ({ getDb: async () => db }));
vi.mock('expo-file-system', async () => (await import('./fakeFs')).fakeFsModule);
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg' } }));

import type { Draft } from '../src/draft/DraftContext';
import { deleteDraftPhoto, isDraftFile, keepDraftPhoto, migrateDraftPhoto, sweepOrphanDraftDirs } from '../src/draft/photoFiles';
import { draftFileRefs, draftKey, parseStoredDraft, restoreDraft, sweepExpiredDrafts, writeDraft, writeSpareDraft, DRAFT_TTL_MS, type RestoreDeps } from '../src/draft/persist';
import { copyIntoDraft, fileExists } from '../src/lib/images';
import { rowExists } from '../src/queue/store';

const ayseA = { personId: 'ayse', orgId: 'firmaA' };
const mehmetA = { personId: 'mehmet', orgId: 'firmaA' };
const CACHE = 'file:///cache/ImageManipulator/';
const DRAFTS = 'file:///doc/drafts/';

let ids = 0;
const draft = (over: Partial<Draft> = {}): Draft => ({
  clientId: `c${++ids}`,
  trackingRaw: 'TRK1',
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

/** DraftProvider'ın geri yüklemeye verdiği gerçek bağımlılıklar (dosya sistemi sahte). */
const realDeps = (over: Partial<RestoreDeps> = {}): RestoreDeps => ({
  exists: fileExists,
  rowExists,
  deletePhoto: (u) => deleteDraftPhoto(u),
  keepPhoto: migrateDraftPhoto,
  now: Date.now(),
  ...over,
});

const stored = async (scope: typeof ayseA) => {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', draftKey(scope) as never);
  return row ? parseStoredDraft(row.value, Date.now()) : null;
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 6, 17, 0));
  fakeFs.reset();
  db = openTestDb();
  await migrate(db);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('taslağa giren fotoğraf kalıcı klasöre kopyalanır (11-B4)', () => {
  it('taslak fotoğrafı önbellekte değil: önbellek silinse de dosya yerinde', () => {
    const cache = fakeFs.put(`${CACHE}a.jpg`, 'KOLI');
    const uri = keepDraftPhoto('c-live', cache, 'p-1');
    expect(uri.startsWith(`${DRAFTS}c-live/`)).toBe(true);
    expect(isDraftFile(uri)).toBe(true);
    expect(fakeFs.read(uri)).toBe('KOLI');
    // Kaynak hemen silinmez: ekran (ör. tartı okuması) o adresi hâlâ kullanıyor olabilir.
    expect(fakeFs.has(cache)).toBe(true);
    fakeFs.clearCache();
    expect(fakeFs.has(uri)).toBe(true);
    expect(fileExists(uri)).toBe(true);
  });

  it('kopyalama başarısızsa eski adres kalır, fotoğraf kaybolmaz', () => {
    const cache = fakeFs.put(`${CACHE}b.jpg`);
    fakeFs.failCopy = true;
    expect(keepDraftPhoto('c-fail', cache, 'p-2')).toBe(cache);
    expect(fakeFs.has(cache)).toBe(true);
  });

  it('zaten taslak klasöründeki ya da kuyruktaki dosya yeniden kopyalanmaz', () => {
    const inDraft = fakeFs.put(`${DRAFTS}c-x/p.jpg`);
    const inQueue = fakeFs.put('file:///doc/queue/q1/0.jpg');
    expect(keepDraftPhoto('c-x', inDraft, 'p-3')).toBe(inDraft);
    expect(keepDraftPhoto('c-x', inQueue, 'p-4')).toBe(inQueue);
    expect(fakeFs.filesUnder(DRAFTS)).toEqual([inDraft]);
  });

  it('dosya kendi üstüne kopyalanmaz (Android `overwrite` önce hedefi siler)', () => {
    const own = fakeFs.put(`${DRAFTS}c-own/m0-p1.jpg`, 'KOLI');
    expect(copyIntoDraft('c-own', own, 'm0-p1.jpg')).toBe(own);
    expect(fakeFs.read(own)).toBe('KOLI');
  });

  it('dosya adında ve klasör adında yol ayıracı kullanılmaz', () => {
    const cache = fakeFs.put(`${CACHE}c.jpg`);
    const uri = keepDraftPhoto('c/../queue', cache, '../x');
    expect(isDraftFile(uri)).toBe(true);
    expect(uri.slice(DRAFTS.length).split('/').length).toBe(2);
    expect(fakeFs.filesUnder('file:///doc/queue/')).toEqual([]);
  });
});

describe('taslak fotoğrafının silinmesi (temizlik)', () => {
  it('kalıcı kopya, bu oturumda alınan önbellek kaynağı ve boşalan klasör silinir; kuyruk dosyasına dokunulmaz', () => {
    const cache = fakeFs.put(`${CACHE}d.jpg`);
    const a = keepDraftPhoto('c-del', cache, 'p-a');
    const b = keepDraftPhoto('c-del', fakeFs.put(`${CACHE}e.jpg`), 'p-b');
    const queued = fakeFs.put('file:///doc/queue/c-del/0.jpg');
    deleteDraftPhoto(a);
    expect(fakeFs.has(a)).toBe(false);
    expect(fakeFs.has(cache)).toBe(false);
    // Klasörde başka fotoğraf var: klasör kalır.
    expect(fakeFs.hasDir(`${DRAFTS}c-del/`)).toBe(true);
    deleteDraftPhoto(b);
    expect(fakeFs.hasDir(`${DRAFTS}c-del/`)).toBe(false);
    // Taslakların kök klasörü silinmez.
    expect(fakeFs.hasDir(DRAFTS)).toBe(true);
    deleteDraftPhoto(queued);
    expect(fakeFs.has(queued)).toBe(true);
  });

  it('yeni kopya aynı kaynaktan alındıysa o kaynak silinmez', () => {
    const cache = fakeFs.put(`${CACHE}f.jpg`);
    const first = keepDraftPhoto('c-same', cache, 'p-1');
    const second = keepDraftPhoto('c-same', cache, 'p-2');
    deleteDraftPhoto(first, new Set([cache, second]));
    expect(fakeFs.has(first)).toBe(false);
    expect(fakeFs.has(cache)).toBe(true);
    expect(fakeFs.has(second)).toBe(true);
    // Korunan adresin kendisi de silinmez.
    deleteDraftPhoto(cache, new Set([cache]));
    expect(fakeFs.has(cache)).toBe(true);
  });

  it('süresi dolan taslak: fotoğrafları ve klasörü silinir (geri yükleme ve açılış süpürmesi)', async () => {
    const d = draft({ photos: [{ id: 'p1', uri: keepDraftPhoto('c-exp', fakeFs.put(`${CACHE}g.jpg`), 'p1'), kind: 'PHOTO_BOX' }], clientId: 'c-exp' });
    await writeDraft(ayseA, d, Date.now() - DRAFT_TTL_MS - 1);
    expect(await restoreDraft(ayseA, realDeps())).toBeNull();
    expect(fakeFs.filesUnder(DRAFTS)).toEqual([]);
    expect(fakeFs.hasDir(`${DRAFTS}c-exp/`)).toBe(false);

    const m = draft({ photos: [{ id: 'p1', uri: keepDraftPhoto('c-exp2', fakeFs.put(`${CACHE}h.jpg`), 'p1'), kind: 'PHOTO_BOX' }], clientId: 'c-exp2' });
    await writeDraft(mehmetA, m, Date.now() - DRAFT_TTL_MS - 1);
    expect(await sweepExpiredDrafts((u) => deleteDraftPhoto(u), Date.now())).toBe(1);
    expect(fakeFs.hasDir(`${DRAFTS}c-exp2/`)).toBe(false);
  });
});

describe('eski taslakların geçişi (önbellek adresi → kalıcı klasör)', () => {
  it('bulunan fotoğraf kalıcı klasöre kopyalanır ve yeni adres diske yazılır; bulunamayan sayılır; önbellek sonra silinse de kaybolmaz', async () => {
    const box = fakeFs.put(`${CACHE}box.jpg`, 'KOLI');
    const d = draft({
      photos: [
        { id: 'p1', uri: box, kind: 'PHOTO_BOX', width: 1600, height: 1200 },
        { id: 'p2', uri: `${CACHE}gone.jpg`, kind: 'PHOTO_SCALE' },
      ],
    });
    const savedAt = Date.now() - 1000;
    await writeDraft(ayseA, d, savedAt);
    const r = await restoreDraft(ayseA, realDeps());
    expect(r?.missingPhotos).toBe(1);
    const [p] = r!.draft.photos;
    expect(r!.draft.photos.length).toBe(1);
    expect(p).toMatchObject({ id: 'p1', kind: 'PHOTO_BOX', width: 1600, height: 1200 });
    expect(p!.uri.startsWith(`${DRAFTS}${d.clientId}/`)).toBe(true);
    expect(fakeFs.read(p!.uri)).toBe('KOLI');
    // Disk satırı yeni adresle; süre sayacı (savedAt) değişmez.
    expect((await stored(ayseA))?.photos.map((x) => x.uri)).toEqual([p!.uri]);
    const raw = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', draftKey(ayseA) as never);
    expect(JSON.parse(raw!.value).savedAt).toBe(savedAt);

    // Ertesi gün telefon önbelleği temizledi: fotoğraf yine yerinde.
    fakeFs.clearCache();
    const again = await restoreDraft(ayseA, realDeps());
    expect(again?.missingPhotos).toBe(0);
    expect(again?.draft.photos.map((x) => x.uri)).toEqual([p!.uri]);
  });

  it('kopyalama başarısızsa eski adres kalır, fotoğraf eksik sayılmaz; sonraki açılışta yeniden denenir', async () => {
    const box = fakeFs.put(`${CACHE}box2.jpg`);
    const d = draft({ photos: [{ id: 'p1', uri: box, kind: 'PHOTO_BOX' }] });
    await writeDraft(ayseA, d, Date.now() - 1000);
    fakeFs.failCopy = true;
    const r = await restoreDraft(ayseA, realDeps());
    expect(r?.missingPhotos).toBe(0);
    expect(r?.draft.photos.map((x) => x.uri)).toEqual([box]);
    expect(fakeFs.has(box)).toBe(true);
    expect((await stored(ayseA))?.photos.map((x) => x.uri)).toEqual([box]);
    fakeFs.failCopy = false;
    const next = await restoreDraft(ayseA, realDeps());
    expect(next?.draft.photos[0]?.uri.startsWith(`${DRAFTS}${d.clientId}/`)).toBe(true);
  });

  it('yedek anahtardan asıl anahtara taşınan taslağın fotoğrafları da geçer', async () => {
    const box = fakeFs.put(`${CACHE}spare.jpg`);
    const d = draft({ photos: [{ id: 'p1', uri: box, kind: 'PHOTO_BOX' }] });
    await writeSpareDraft(ayseA, d, Date.now() - 1000);
    const r = await restoreDraft(ayseA, realDeps());
    expect(r?.draft.photos[0]?.uri.startsWith(`${DRAFTS}${d.clientId}/`)).toBe(true);
    expect((await stored(ayseA))?.photos[0]?.uri).toBe(r?.draft.photos[0]?.uri);
  });
});

describe('açılışta sahipsiz taslak klasörleri', () => {
  it('yalnız hiçbir taslağın sahiplenmediği klasör silinir; geçerli taslak, saklı taslaklar, okunamayan satırın andığı ve bu oturumda açılan klasör kalır', async () => {
    const orphan = fakeFs.put(`${DRAFTS}c-orphan/p.jpg`);
    const current = fakeFs.put(`${DRAFTS}c-current/p.jpg`);
    const storedFile = fakeFs.put(`${DRAFTS}c-stored/p.jpg`);
    // Fotoğrafı başka bir taslağın klasöründe duran taslak (klasör adı kimliğinden farklı).
    const foreign = fakeFs.put(`${DRAFTS}c-foreign/p.jpg`);
    const unreadable = fakeFs.put(`${DRAFTS}c-unreadable/p.jpg`);
    const session = keepDraftPhoto('c-session', fakeFs.put(`${CACHE}s.jpg`), 'p');
    const queued = fakeFs.put('file:///doc/queue/c-orphan/0.jpg');

    await writeDraft(ayseA, draft({ clientId: 'c-stored', photos: [{ id: 'p', uri: storedFile, kind: 'PHOTO_BOX' }] }), Date.now());
    await writeSpareDraft(mehmetA, draft({ clientId: 'c-other', photos: [{ id: 'p', uri: foreign, kind: 'PHOTO_BOX' }] }), Date.now());
    await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', 'draft:zeynep:firmaA' as never, `{"v":9,"x":"${unreadable}"` as never);

    const refs = await draftFileRefs();
    const n = sweepOrphanDraftDirs({ ids: [...refs.ids, 'c-current'], uris: refs.uris });
    expect(n).toBe(1);
    expect(fakeFs.has(orphan)).toBe(false);
    expect(fakeFs.hasDir(`${DRAFTS}c-orphan/`)).toBe(false);
    for (const f of [current, storedFile, foreign, unreadable, session, queued]) expect(fakeFs.has(f)).toBe(true);
  });

  it('taslak klasörü yoksa süpürme bir şey yapmaz', () => {
    expect(sweepOrphanDraftDirs({ ids: [], uris: [] })).toBe(0);
  });

  it('DraftProvider: fotoğraf girişi kalıcı kopyadan geçer, geri yükleme geçişi ve sahipsiz klasör süpürmesi bağlı', () => {
    const src = readFileSync(new URL('../src/draft/DraftContext.tsx', import.meta.url), 'utf8');
    const body = (name: string) => src.slice(src.indexOf(`const ${name} = useCallback(`), src.indexOf('[change]', src.indexOf(`const ${name} = useCallback(`)));
    expect(body('addPhoto')).toMatch(/keepDraftPhoto\(/);
    expect(body('replacePhotoOfKind')).toMatch(/keepDraftPhoto\(/);
    expect(src).toMatch(/keepPhoto: migrateDraftPhoto/);
    expect(src).toMatch(/sweepOrphanDraftDirs\(/);
  });
});
