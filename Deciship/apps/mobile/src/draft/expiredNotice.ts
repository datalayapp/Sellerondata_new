/**
 * Süresi dolup silinen yarım ölçümün bildirimi (11-B5). Çalışan cuma başladığı ölçümün pazartesi sessizce yok olduğunu
 * bilmeliydi. Silmeyi yapan yerler (`restoreDraft`, `sweepExpiredDrafts`) burada bir satır bırakır; Bugün ekranı onu
 * kapatılana kadar gösterir.
 *
 * Yer: yerel `kv` tablosu, anahtar `expiredDraft:<clientId>` (taslak başına tek satır: aynı taslak iki kez bildirilmez).
 * Değer, silinen taslağın satır anahtarını (`draft:<kişi>:<firma>` ya da yedek `…:<clientId>`) taşır; kişi ve firma
 * yalnız kendi bildirimini görür. Saf modül: React almaz.
 */
import { getDb } from '../queue/db';

const PREFIX = 'expiredDraft:';
const VERSION = 1;

export type ExpiredNotice = { clientId: string; trackingRaw: string; startedAt: number; deletedAt: number };
type Stored = ExpiredNotice & { v: typeof VERSION; rowKey: string };

const listeners = new Set<() => void>();

/** Bildirim eklendi ya da kapatıldı. Dönen işlev aboneliği bırakır. */
export function onExpiredNoticesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const emit = () =>
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.warn('expired draft listener', e);
    }
  });

/** Silinen taslak için bildirim bırakır. Taslak satırı silinmeden önce çağrılır: arada kapanırsa taslak yerinde kalır. */
export async function recordExpiredDraft(
  rowKey: string,
  d: { clientId: string; trackingRaw: string; startedAt: number },
  now: number,
): Promise<void> {
  const db = await getDb();
  const value: Stored = { v: VERSION, rowKey, clientId: d.clientId, trackingRaw: d.trackingRaw, startedAt: d.startedAt, deletedAt: now };
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', `${PREFIX}${d.clientId}`, JSON.stringify(value));
  emit();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function decode(raw: string): Stored | null {
  try {
    const p: unknown = JSON.parse(raw);
    if (!isObj(p) || p.v !== VERSION || typeof p.rowKey !== 'string' || typeof p.clientId !== 'string' || typeof p.startedAt !== 'number') return null;
    return {
      v: VERSION,
      rowKey: p.rowKey,
      clientId: p.clientId,
      trackingRaw: typeof p.trackingRaw === 'string' ? p.trackingRaw : '',
      startedAt: p.startedAt,
      deletedAt: typeof p.deletedAt === 'number' ? p.deletedAt : p.startedAt,
    };
  } catch {
    return null;
  }
}

/** Kapsamın (`draftKey`) kapatılmamış bildirimleri, başlama sırasıyla. Yedek anahtardaki taslağınki de sayılır. */
export async function listExpiredNotices(ownerKey: string): Promise<ExpiredNotice[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM kv WHERE substr(key, 1, ?) = ?', PREFIX.length, PREFIX);
  return rows
    .map((r) => decode(r.value))
    .filter((s): s is Stored => !!s && (s.rowKey === ownerKey || s.rowKey.startsWith(`${ownerKey}:`)))
    .sort((a, b) => a.startedAt - b.startedAt || (a.clientId < b.clientId ? -1 : 1))
    .map(({ clientId, trackingRaw, startedAt, deletedAt }) => ({ clientId, trackingRaw, startedAt, deletedAt }));
}

/** Kapatıldı: bir daha görünmez. */
export async function dismissExpiredNotices(clientIds: readonly string[]): Promise<void> {
  if (!clientIds.length) return;
  const db = await getDb();
  for (const id of clientIds) await db.runAsync('DELETE FROM kv WHERE key = ?', `${PREFIX}${id}`);
  emit();
}

type T = (key: string, opts: Record<string, unknown>) => string;

/** Tek bildirimin metni. `when`: başlama anının gün ve saat yazımı (ekran biçimleyicisi). `days`: `DRAFT_TTL_DAYS`. */
export function expiredNoticeText(n: Pick<ExpiredNotice, 'trackingRaw' | 'startedAt'>, t: T, when: (ms: number) => string, days: number): string {
  const tracking = n.trackingRaw.trim();
  return tracking
    ? t('draft.expiredText', { when: when(n.startedAt), tracking, days })
    : t('draft.expiredTextNoTracking', { when: when(n.startedAt), days });
}
