/**
 * Yarım ölçümün (taslak) telefonda saklanması. Yer: yerel veritabanındaki `kv` tablosu, anahtar `draft:<kişi>:<firma>`.
 * Saf modül: React ve dosya sistemi almaz. Dosya işlemleri `restoreDraft`'a dışarıdan verilir (testte sahte).
 */
import { getDb } from '../queue/db';
import { sameScope, scopeKey, type SessionScope } from '../auth/token';
import type { MeasurementPayload } from '../api/endpoints';
import type { Draft, DraftPhoto } from './DraftContext';
import { needsRestore } from './owner';
import { recordExpiredDraft } from './expiredNotice';
import { SENT_KEEP_MS, type QueuePhoto, type QueueRow } from '../queue/store';

/**
 * Taslak ömrü (son yazmadan): 2 gün. Gönderilmiş satırın telefonda kalma süresinden (`SENT_KEEP_MS`, 3 gün) kısa olmalı;
 * yoksa kaydedilmiş ama silinememiş taslak, kuyruk satırı temizlendikten sonra "yarım ölçüm" diye geri gelirdi.
 */
export const DRAFT_TTL_MS = Math.min(2 * 24 * 3600 * 1000, SENT_KEEP_MS - 24 * 3600 * 1000);
/** Aynı süre gün olarak (silinme bildiriminin metni). */
export const DRAFT_TTL_DAYS = Math.round(DRAFT_TTL_MS / (24 * 3600 * 1000));
export const DRAFT_WRITE_DELAY_MS = 300;
const VERSION = 1;

type Stored = { v: typeof VERSION; savedAt: number; draft: Draft };

/** Kişi ve firma, `scopeKey` ile aynı sırada. */
export function draftKey(scope: SessionScope): string {
  return `draft:${scope.personId}:${scope.orgId}`;
}

/**
 * Yedek anahtar: korumalı açılışta (asıl anahtar okunamadı ya da başka bir saklı taslak tutuyor) yeni ölçüm buraya yazılır,
 * asıl anahtara dokunulmaz. Kimlik başına ayrı anahtar: iki korumalı oturumun yedeği birbirini ezmez. Asıl anahtar boşalınca
 * en eski yedek oraya taşınır (`restoreDraft`). Süpürme (`draft:%`) yedekleri de kapsar.
 */
export function spareDraftKey(scope: SessionScope, clientId: string): string {
  return `${draftKey(scope)}:${clientId}`;
}

/** Saklamaya değer bir şey girildi mi? Yalnız başlama zamanı ve kimlik dolu taslak boştur. */
export function draftHasContent(d: Draft): boolean {
  return (
    d.trackingRaw.trim() !== '' ||
    d.weightKg !== null ||
    d.lengthCm !== null ||
    d.widthCm !== null ||
    d.heightCm !== null ||
    d.photos.length > 0 ||
    d.note.trim() !== ''
  );
}

export type ResumeStep = 'scan' | 'weight' | 'dims' | 'photos' | 'summary';

/** İlk eksik adım. Sıra akışla aynı: Barkod → Ağırlık → Ölçü → Fotoğraf → Özet. Koşullar özet ekranının denetimiyle aynı. */
export function resumeStep(d: Draft, requiredBoxPhotos: number): ResumeStep {
  if (!d.trackingRaw.trim()) return 'scan';
  if (!d.weightKg) return 'weight';
  if (!d.lengthCm || !d.widthCm || !d.heightCm) return 'dims';
  if (d.photos.filter((p) => p.kind === 'PHOTO_BOX').length < requiredBoxPhotos) return 'photos';
  return 'summary';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function decodePhoto(v: unknown): DraftPhoto | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.uri !== 'string' || !v.uri || typeof v.kind !== 'string') return null;
  const p: DraftPhoto = { id: v.id, uri: v.uri, kind: v.kind as DraftPhoto['kind'] };
  const width = numOrNull(v.width);
  const height = numOrNull(v.height);
  if (width !== null) p.width = width;
  if (height !== null) p.height = height;
  return p;
}

/** Biçim `v: 1`. Tanınmayan sürüm ya da bozuk değer `null`. TTL burada bakılmaz. */
function decodeStored(raw: string): Stored | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== VERSION || typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
  const d = parsed.draft;
  if (!isObj(d) || typeof d.clientId !== 'string' || !d.clientId || typeof d.startedAt !== 'number' || !Array.isArray(d.photos)) return null;
  const photos = d.photos.map(decodePhoto);
  if (photos.some((p) => p === null)) return null;
  return {
    v: VERSION,
    savedAt: parsed.savedAt,
    draft: {
      clientId: d.clientId,
      trackingRaw: str(d.trackingRaw),
      weightKg: numOrNull(d.weightKg),
      weightMethod: (str(d.weightMethod) || 'MANUAL') as Draft['weightMethod'],
      ocrWeightKg: numOrNull(d.ocrWeightKg),
      lengthCm: numOrNull(d.lengthCm),
      widthCm: numOrNull(d.widthCm),
      heightCm: numOrNull(d.heightCm),
      dimMethod: (str(d.dimMethod) || 'MANUAL') as Draft['dimMethod'],
      dimConfidence: numOrNull(d.dimConfidence),
      boxPresetId: typeof d.boxPresetId === 'string' && d.boxPresetId ? d.boxPresetId : null,
      photos: photos as DraftPhoto[],
      note: str(d.note),
      startedAt: d.startedAt,
      ...(typeof d.replacesId === 'string' && d.replacesId ? { replacesId: d.replacesId } : {}),
    },
  };
}

const expired = (s: Stored, now: number) => now - s.savedAt > DRAFT_TTL_MS;

/** `v !== 1`, bozuk JSON ya da süresi dolmuş taslak → `null`. */
export function parseStoredDraft(raw: string, now: number): Draft | null {
  const s = decodeStored(raw);
  return s && !expired(s, now) ? s.draft : null;
}

export async function writeDraft(scope: SessionScope, d: Draft, now = Date.now()): Promise<void> {
  const db = await getDb();
  const value: Stored = { v: VERSION, savedAt: now, draft: d };
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', draftKey(scope), JSON.stringify(value));
}

export async function deleteDraft(scope: SessionScope): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM kv WHERE key = ?', draftKey(scope));
}

/** Korumalı açılışta yeni ölçüm: yedek anahtara (bkz. `spareDraftKey`). */
export async function writeSpareDraft(scope: SessionScope, d: Draft, now = Date.now()): Promise<void> {
  const db = await getDb();
  const value: Stored = { v: VERSION, savedAt: now, draft: d };
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', spareDraftKey(scope, d.clientId), JSON.stringify(value));
}

export async function deleteSpareDraft(scope: SessionScope, clientId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM kv WHERE key = ?', spareDraftKey(scope, clientId));
}

export type RestoreDeps = {
  exists: (uri: string) => boolean;
  /** Kuyrukta bu kimlikte satır var mı (kimin olursa olsun)? */
  rowExists: (clientId: string) => Promise<boolean>;
  /** Yalnız taslak dosyasını siler. Kuyruk kendi kopyasını tutar (`copyToQueue`). */
  deletePhoto: (uri: string) => void;
  /**
   * Bulunan fotoğrafın kalıcı adresi (11-B4 geçişi): önbellekteki eski taslak fotoğrafı kalıcı klasöre kopyalanır, yeni
   * adres döner; zaten kalıcıysa ya da kopyalanamazsa aynı adres (`migrateDraftPhoto`).
   */
  keepPhoto?: (clientId: string, p: DraftPhoto, index: number) => string;
  now?: number;
};

/**
 * Kapsamın taslağını okur.
 * - Yok ya da okunamıyor → `null` (okunamayan satıra dokunulmaz; ilk yazma üstüne yazar).
 * - Süresi (`DRAFT_TTL_MS`) dolmuş → bildirim bırakılır (`recordExpiredDraft`), satır ve taslak fotoğrafları silinir, `null`.
 * - Kimliği kuyrukta → kayıt zaten alınmış: satır ve taslak fotoğrafları silinir, `null` (çift kayıt önlemi).
 * - Dosyası bulunmayan fotoğraflar listeden çıkar, sayısı döner.
 * - Bulunan fotoğraf kalıcı klasörde değilse oraya kopyalanır (`keepPhoto`) ve yeni adresler hemen satıra yazılır (kayıt
 *   zamanı değişmez). Önbellekteki eski dosya silinmez; kopyalanamayan fotoğraf eski adresiyle kalır.
 * - Asıl anahtarda geçerli taslak yoksa (yok, okunamıyor, süresi dolmuş, kuyrukta) en eski geçerli yedek (`spareDraftKey`)
 *   asıl anahtara taşınır ve o döner. Okunamayan asıl satır yalnız bu durumda ezilir (zaten ilk yazma üstüne yazardı).
 */
export async function restoreDraft(scope: SessionScope, deps: RestoreDeps): Promise<{ draft: Draft; missingPhotos: number } | null> {
  const db = await getDb();
  const now = deps.now ?? Date.now();
  /** Geçerliyse taslak; süresi dolmuşsa ya da kimliği kuyruktaysa satır ve taslak fotoğrafları silinir. */
  const usable = async (key: string, raw: string): Promise<Stored | null> => {
    const stored = decodeStored(raw);
    if (!stored) return null;
    const isExpired = expired(stored, now);
    if (isExpired || (await deps.rowExists(stored.draft.clientId))) {
      // Önce bildirim, sonra silme: arada kapanırsa taslak yerinde kalır, bildirim iki kez yazılmaz (kimlik başına tek satır).
      if (isExpired) await recordExpiredDraft(key, stored.draft, now);
      await db.runAsync('DELETE FROM kv WHERE key = ?', key);
      stored.draft.photos.forEach((p) => deps.deletePhoto(p.uri));
      return null;
    }
    return stored;
  };
  const found = async (key: string, s: Stored) => {
    let moved = false;
    const photos: DraftPhoto[] = [];
    s.draft.photos.forEach((p, i) => {
      if (!deps.exists(p.uri)) return;
      const uri = deps.keepPhoto ? deps.keepPhoto(s.draft.clientId, p, i) : p.uri;
      if (uri !== p.uri) moved = true;
      photos.push(uri === p.uri ? p : { ...p, uri });
    });
    const draft = { ...s.draft, photos };
    if (moved) {
      // Yeni adresler hemen diske: yoksa önbellek temizlenince eski adres "bulunamadı" olurdu (kopya dursa da).
      const value: Stored = { v: VERSION, savedAt: s.savedAt, draft };
      await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
    }
    return { draft, missingPhotos: s.draft.photos.length - photos.length };
  };

  const main = draftKey(scope);
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', main);
  const stored = row ? await usable(main, row.value) : null;
  if (stored) return found(main, stored);

  const prefix = `${main}:`;
  const spares = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE substr(key, 1, ?) = ?', prefix.length, prefix);
  const valid: { key: string; raw: string; s: Stored }[] = [];
  for (const r of spares) {
    const s = await usable(r.key, r.value);
    if (s) valid.push({ key: r.key, raw: r.value, s });
  }
  if (!valid.length) return null;
  valid.sort((a, b) => a.s.savedAt - b.s.savedAt || (a.key < b.key ? -1 : 1));
  const first = valid[0]!;
  // Önce asıl anahtara yazılır, sonra yedek silinir: arada kapanırsa taslak iki yerde kalır, kaybolmaz.
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', main, first.raw);
  await db.runAsync('DELETE FROM kv WHERE key = ?', first.key);
  return found(main, first.s);
}

/** Kuyruğa giden kayıt. Kimlik taslağın kimliğidir: aynı taslak ikinci kez kaydedilirse kuyrukta tek satır kalır. */
export function draftPayload(d: Draft, measuredAt: Date): MeasurementPayload {
  return {
    clientId: d.clientId,
    trackingRaw: d.trackingRaw,
    lengthCm: d.lengthCm!,
    widthCm: d.widthCm!,
    heightCm: d.heightCm!,
    weightKg: d.weightKg!,
    dimMethod: d.dimMethod,
    weightMethod: d.weightMethod,
    ...(d.ocrWeightKg !== null ? { ocrWeightKg: d.ocrWeightKg } : {}),
    ...(d.dimConfidence !== null ? { dimConfidence: Math.round(d.dimConfidence * 1000) / 1000 } : {}),
    ...(d.boxPresetId ? { boxPresetId: d.boxPresetId } : {}),
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
    measuredAt: measuredAt.toISOString(),
    photoKinds: d.photos.map((p) => p.kind),
    ...(d.replacesId ? { replacesId: d.replacesId } : {}),
  };
}

/**
 * Açılış süpürmesi: süresi dolmuş bütün taslaklar (her kişi ve firma) için bildirim bırakılır, satırıyla ve taslak
 * fotoğraflarıyla silinir. Süresi dolmamış ya da okunamayan taslağa dokunulmaz. Kuyruk dosyaları taslakta yer almaz.
 */
export async function sweepExpiredDrafts(deletePhoto: (uri: string) => void, now = Date.now()): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'draft:%'");
  let n = 0;
  for (const r of rows) {
    const s = decodeStored(r.value);
    if (!s || !expired(s, now)) continue;
    await recordExpiredDraft(r.key, s.draft, now);
    await db.runAsync('DELETE FROM kv WHERE key = ?', r.key);
    s.draft.photos.forEach((p) => deletePhoto(p.uri));
    n++;
  }
  return n;
}

/**
 * Diskteki bütün taslakların (her kişi, firma ve yedek) andığı kimlikler ve fotoğraf adresleri: sahipsiz taslak klasörü
 * süpürmesi bunlara dokunmaz. Okunamayan satırlar da metin olarak taranır (kimlik ve `drafts/<klasör>/` geçen her adres),
 * çünkü ileride okunabilir hâle gelebilirler. Okuma hata verirse fırlatır: süpürme yapılmaz.
 */
export async function draftFileRefs(): Promise<{ ids: string[]; uris: string[] }> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'draft:%'");
  const ids = new Set<string>();
  const uris = new Set<string>();
  for (const r of rows) {
    const s = decodeStored(r.value);
    if (s) {
      ids.add(s.draft.clientId);
      s.draft.photos.forEach((p) => uris.add(p.uri));
    }
    for (const m of r.value.matchAll(/"clientId"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!);
    for (const m of r.value.matchAll(/[^"\s]*\/drafts\/[^"\s]*/g)) uris.add(m[0]);
  }
  return { ids: [...ids], uris: [...uris] };
}

export type SaveOutcome = 'queued' | 'updated' | 'alreadySent' | 'sending';

/**
 * Özet ekranının kayıt yolu. Kimlik taslağın kimliğidir:
 * - kuyrukta yoksa yeni satır;
 * - gönderilmemiş satır varsa (önceki deneme yarıda kaldı) güncel değerlerle güncellenir, kuyrukta tek satır kalır;
 * - satır gönderilmişse (`alreadySent`) ya da şu an gönderiliyorsa (`sending`) yeni kayıt açılmaz.
 */
export async function saveDraftToQueue(
  d: Draft,
  measuredAt: Date,
  q: {
    getLocal: (clientId: string) => Promise<QueueRow | null>;
    enqueue: (data: MeasurementPayload, photos: QueuePhoto[]) => Promise<void>;
    editLocal: (clientId: string, data: MeasurementPayload, photos: QueuePhoto[]) => Promise<boolean>;
  },
): Promise<SaveOutcome> {
  const payload = draftPayload(d, measuredAt);
  const photos: QueuePhoto[] = d.photos.map((p) => ({ uri: p.uri, kind: p.kind }));
  const existing = await q.getLocal(d.clientId);
  if (!existing) {
    await q.enqueue(payload, photos);
    return 'queued';
  }
  if (existing.status === 'PENDING' || existing.status === 'ERROR') {
    if (await q.editLocal(d.clientId, payload, photos)) return 'updated';
    // Bu arada gönderime alınmış olabilir: neden yeniden okunur.
    return lockedReason(await q.getLocal(d.clientId));
  }
  return lockedReason(existing);
}

/**
 * Kayıttan sonra taslak ne olur? `sending`: gönderimin sonucu belli değil, taslak tutulur. Gönderim başarısız olursa satır
 * kuyrukta PENDING/ERROR olarak kalır (`flush.ts` `markRetry`/`markError`, kapanmada `recoverInterrupted`); kişi yeniden
 * Kaydet'e basınca taslaktaki son değerler satıra yazılır (`updated`). Başarılıysa sonraki kayıt `alreadySent` olur.
 */
export function draftAfterSave(outcome: SaveOutcome): 'keep' | 'drop' {
  return outcome === 'sending' ? 'keep' : 'drop';
}

/** Gönderilmemiş kayıt düzenlenemedi: şu an gönderiliyor mu, yoksa gönderildi (ya da artık yok) mu? */
export function lockedReason(row: Pick<QueueRow, 'status'> | null): 'sending' | 'alreadySent' {
  return row?.status === 'SENDING' ? 'sending' : 'alreadySent';
}

/** Bellekteki taslak ve sahibi. Sahip yalnız diskten okuma bitince atanır; sahipsiz durum hiç yazılmaz. */
export type HeldDraft = { owner: SessionScope | null; draft: Draft };

type Restored = { draft: Draft; missingPhotos: number } | null;

export type DraftSyncDeps = {
  /** Okuma. Fırlatırsa (veritabanı geçici hatası) "taslak yok" sayılmaz: kapı kapalı kalır, yeniden denenir. */
  restore: (scope: SessionScope) => Promise<Restored>;
  write: (scope: SessionScope, d: Draft) => Promise<void>;
  remove: (scope: SessionScope) => Promise<void>;
  /** Korumalı kapsamda yeni ölçüm yedek anahtara yazılır (`writeSpareDraft`). Zorunlu: yoksa yeni ölçüm kaybolurdu. */
  writeSpare: (scope: SessionScope, d: Draft) => Promise<void>;
  removeSpare: (scope: SessionScope, clientId: string) => Promise<void>;
  fresh: () => Draft;
  /** Kapsamın taslağı okundu (yoksa boş taslak): bellek buna geçer. */
  onLoaded: (owner: SessionScope, draft: Draft, missingPhotos: number) => void;
  /** İlk başarılı okumadan sonra bir kez: süresi dolmuş taslakların süpürülmesi. */
  sweep?: () => Promise<unknown>;
  onError?: (e: unknown) => void;
  delayMs?: number;
  /** Okuma hatasından sonra yeniden deneme aralıkları. Hepsi tükenince kapı korumalı açılır. */
  retryDelaysMs?: readonly number[];
};

export const DRAFT_READ_RETRY_MS = [1000, 3000] as const;

/**
 * Taslağın disk eşitlemesi. React'tan bağımsızdır, testte gerçek veritabanıyla sınanır. Kurallar:
 * 1. Sahipsiz durum (açılıştaki boş taslak) yazılmaz; diskten okuma bitmeden hiçbir yazma ya da silme olmaz.
 * 2. Yazma, durumun kendi sahibinin anahtarına gider; kapsam bu arada değişse de.
 * 3. Kapsam null iken okunmaz, yazılmaz; bekleyen değişiklik kapsam dönünce yazılır.
 * 4. Başka kapsama geçince önceki sahibin bekleyen değişikliği kendi anahtarına yazılır, taslağı silinmez.
 * 5. Disk işlemleri sırayla: A'nın son yazması bitmeden A yeniden okunmaz.
 * 6. Okuma hata verirse kapı kapalı kalır; 1 sn ve 3 sn sonra (ve uygulama öne gelince) yeniden denenir. Denemeler tükenince
 *    kullanıcı kilitlenmesin diye kapı "korumalı" açılır: o anahtar hiç silinmez; üstüne ancak yeniden okuma başarıyla
 *    "orada saklı taslak yok" (ya da "saklı olan bu taslak") derse yazılır. Okuma yine hata verirse ya da başka bir saklı
 *    taslak çıkarsa asıl anahtar olduğu gibi kalır, yeni ölçüm yedek anahtara (`spareDraftKey`) yazılır: kaybolmaz.
 * 7. Korumalı açılış her kapsam için ayrı hatırlanır: A korumalıyken B de korumalı açılırsa A'nın anahtarı korunmaya devam eder.
 * 8. Yeniden deneme zamanlayıcısı yalnız o anki kapsamındır: kapsam değişince ve sağlayıcı ayrılınca (`dispose`) durur;
 *    aynı kapsam için okuma zaten sıradaysa öne gelme ikinci okuma başlatmaz.
 */
export function createDraftSync(deps: DraftSyncDeps) {
  // Tipin dışından (JS, `as never`) eksik verilirse sessizce yazmamak yerine hemen düşer.
  if (typeof deps.writeSpare !== 'function' || typeof deps.removeSpare !== 'function') throw new Error('createDraftSync: writeSpare ve removeSpare zorunlu');
  const delay = deps.delayMs ?? DRAFT_WRITE_DELAY_MS;
  const retries = deps.retryDelaysMs ?? DRAFT_READ_RETRY_MS;
  let scope: SessionScope | null = null;
  /** Belleğin sahibi: son tamamlanan okuma (ya da korumalı açılış). */
  let loaded: SessionScope | null = null;
  /** Okunamadan açılan kapsamlar (`scopeKey`): anahtarları korunur. */
  const guarded = new Set<string>();
  /** Korumalı kapsamda bu oturumda yazılan yedeğin kimliği (kapsam başına). */
  const spareOf = new Map<string, string>();
  /** Sırada ya da sürmekte olan okumalar (kapsam başına sayı). */
  const reading = new Map<string, number>();
  const isGuarded = (s: SessionScope | null) => !!s && guarded.has(scopeKey(s)!);
  const unguard = (s: SessionScope) => {
    const k = scopeKey(s)!;
    guarded.delete(k);
    // Yedek ya asıl anahtara taşındı ya da sırasını bekliyor: artık bu oturumun değil, silinmez.
    spareOf.delete(k);
  };
  /** Okuması hata verip yeniden denenmeyi bekleyen kapsam ve deneme sayısı. */
  let failing: { scope: SessionScope; count: number } | null = null;
  /** Diskten yeni okunmuş taslak: aynen geri yazılmaz. */
  let fromDisk: Draft | null = null;
  let latest: HeldDraft | null = null;
  let pending: HeldDraft | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let loadSeq = 0;
  let swept = false;
  /** Sağlayıcı ayrıldı (`dispose`): yeni yeniden deneme zamanlayıcısı kurulmaz. */
  let disposed = false;

  const run = (op: () => Promise<void>) => {
    chain = chain.then(op).catch((e) => deps.onError?.(e));
    return chain;
  };
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  /**
   * Korumalı anahtara yazmadan önce okuma başarıyla "saklı taslak yok" (ya da "saklı olan bu taslak") demeli.
   * Diyemezse yeni ölçüm yedek anahtara yazılır; asıl anahtara dokunulmaz.
   */
  const guardedWrite = async (owner: SessionScope, d: Draft) => {
    let stored: Restored = null;
    let readable = true;
    try {
      stored = await deps.restore(owner);
    } catch (e) {
      deps.onError?.(e);
      readable = false;
    }
    if (readable && (!stored || stored.draft.clientId === d.clientId)) {
      unguard(owner);
      await deps.write(owner, d);
      return;
    }
    // Okunamıyor ya da başka bir saklı taslak var (sonraki açılışta geri gelir): yeni ölçüm yedeğe.
    const k = scopeKey(owner)!;
    const prev = spareOf.get(k);
    await deps.writeSpare(owner, d);
    spareOf.set(k, d.clientId);
    // Önceki yedek bu oturumun bitmiş (kaydedilmiş ya da silinmiş) taslağıdır.
    if (prev && prev !== d.clientId) await deps.removeSpare(owner, prev);
  };

  /** Korumalı kapsamda taslak boşaldı (kaydedildi ya da silindi): bu oturumun yedeği de silinir. Asıl anahtara dokunulmaz. */
  const dropSpare = async (owner: SessionScope) => {
    const k = scopeKey(owner)!;
    const prev = spareOf.get(k);
    if (!prev) return;
    spareOf.delete(k);
    await deps.removeSpare(owner, prev);
  };

  const persist = (p: HeldDraft) => {
    const owner = p.owner!;
    const d = p.draft;
    return run(async () => {
      if (isGuarded(owner)) {
        // Korumalı anahtar hiç silinmez; içerik varsa yalnız güvenli yazma denenir.
        await (draftHasContent(d) ? guardedWrite(owner, d) : dropSpare(owner));
        return;
      }
      await (draftHasContent(d) ? deps.write(owner, d) : deps.remove(owner));
    });
  };
  const readyFor = (owner: SessionScope | null) => !!owner && sameScope(scope, owner) && sameScope(loaded, owner);
  /** Başka sahibin bekleyen değişikliği kendi anahtarına gider; yenisi onu ezmez. */
  const handOver = (next: SessionScope) => {
    if (pending?.owner && !sameScope(pending.owner, next)) {
      const p = pending;
      pending = null;
      void persist(p);
    }
  };

  /** Bekleyen yazmayı hemen yapar. Kapsam yokken yazmaz, bekletir. */
  const flush = () => {
    clearTimer();
    if (!pending?.owner || !scope) return chain;
    const p = pending;
    pending = null;
    return persist(p);
  };

  const schedule = (now: boolean) => {
    clearTimer();
    if (!pending || !readyFor(pending.owner)) return;
    if (now) void flush();
    else timer = setTimeout(() => void flush(), delay);
  };

  const adopt = (next: SessionScope, draft: Draft, missing: number, fromStore: boolean) => {
    handOver(next);
    loaded = next;
    // Okunan (ya da boş başlayan) durum geri yazılmaz. Yalnız eksik fotoğraf çıktıysa temizlenmiş hâl yazılır.
    fromDisk = fromStore && missing > 0 ? null : draft;
    deps.onLoaded(next, draft, missing);
  };

  const load = (next: SessionScope, seq: number) => {
    const k = scopeKey(next)!;
    reading.set(k, (reading.get(k) ?? 0) + 1);
    const done = () => {
      const n = (reading.get(k) ?? 1) - 1;
      if (n > 0) reading.set(k, n);
      else reading.delete(k);
    };
    return run(async () => {
      try {
        await loadNow(next, seq);
      } finally {
        done();
      }
    });
  };

  const loadNow = async (next: SessionScope, seq: number) => {
    let r: Restored;
    try {
      r = await deps.restore(next);
    } catch (e) {
      deps.onError?.(e);
      if (seq !== loadSeq || !sameScope(scope, next) || disposed) return;
      const count = (failing && sameScope(failing.scope, next) ? failing.count : 0) + 1;
      failing = { scope: next, count };
      if (count <= retries.length) {
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (seq === loadSeq && sameScope(scope, next)) void load(next, seq);
        }, retries[count - 1]);
        return;
      }
      // Denemeler tükendi: kullanıcı kilitlenmesin, ama bu anahtar korunur.
      failing = null;
      if (!sameScope(loaded, next)) {
        guarded.add(scopeKey(next)!);
        adopt(next, deps.fresh(), 0, false);
      }
      return;
    }
    if (seq !== loadSeq || !sameScope(scope, next)) return;
    failing = null;
    const wasGuarded = isGuarded(next);
    // Korumalı açılıştan sonra okuma düzeldi. Bellekte kullanıcının yeni içeriği varsa bellek kalır;
    // başka bir saklı taslak varsa anahtar korunmaya devam eder (üstüne yazılmaz, yeni ölçüm yedekte kalır).
    if (wasGuarded && latest && sameScope(latest.owner, next) && draftHasContent(latest.draft)) {
      if (!r || r.draft.clientId === latest.draft.clientId) {
        // Saklı taslak yok ya da saklı olan bu taslağın yedeğiydi: bellekteki içerik artık asıl anahtara yazılabilir.
        unguard(next);
        pending = latest;
        schedule(false);
      }
      return;
    }
    if (wasGuarded) unguard(next);
    adopt(next, r?.draft ?? deps.fresh(), r?.missingPhotos ?? 0, !!r);
    if (!swept && deps.sweep) {
      swept = true;
      await deps.sweep().catch((e) => deps.onError?.(e));
    }
  };

  return {
    /** Oturumun kapsamı değişti (ya da ilk kez geldi). */
    setScope(next: SessionScope | null) {
      scope = next;
      disposed = false;
      clearRetry();
      if (!next) {
        clearTimer();
        return;
      }
      if (!needsRestore(scopeKey(loaded), scopeKey(next))) {
        // Kapsam geri geldi: arada yapılan değişiklik yazılır.
        schedule(false);
        return;
      }
      // Önceki sahibin son değişikliği kendi anahtarına.
      void flush();
      failing = null;
      void load(next, ++loadSeq);
    },
    /** Uygulama öne geldi: okunamamış ya da korumalı açılmış kapsam yeniden okunur. Okuması zaten sıradaysa ikincisi başlamaz. */
    retry() {
      if (!scope) return chain;
      const current = scope;
      const isFailing = !!failing && sameScope(failing.scope, current);
      if (!isFailing && !isGuarded(current)) return chain;
      if (reading.has(scopeKey(current)!)) return chain;
      clearRetry();
      if (isFailing) failing = { scope: current, count: 0 };
      return load(current, loadSeq);
    },
    /** Bellekteki durum değişti. `now`: beklemeden yaz (taslak silme). */
    changed(held: HeldDraft, now = false) {
      if (!held.owner) return;
      latest = held;
      handOver(held.owner);
      if (held.draft === fromDisk) return;
      fromDisk = null;
      pending = held;
      schedule(now);
    },
    flush,
    /**
     * Sağlayıcı ayrılıyor: bekleyen yazma beklenmeden yapılır, yeniden deneme zamanlayıcısı durur. Eşitleme kullanılmaya
     * devam edebilir (React geliştirme kipinde sağlayıcı ayrılıp yeniden bağlanır): sonraki `setScope` okumayı yeniden başlatır.
     */
    dispose() {
      disposed = true;
      clearRetry();
      failing = null;
      return flush();
    },
    /** Sıradaki tüm disk işlemleri bitince. */
    idle: () => chain,
    ready: () => readyFor(loaded),
    /** Okunamadan açılmış (anahtarı korunan) kapsam mı? */
    guarded: () => isGuarded(scope),
  };
}

export type DraftSync = ReturnType<typeof createDraftSync>;
