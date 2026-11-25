import { trackingCandidates } from '@deciship/core/tracking';
import { stripScanNoise } from '@deciship/core/trackingFormat';
import { getDb } from './db';
import type { MeasurementItem, MeasurementPayload, PhotoKind } from '../api/endpoints';
import type { SessionScope } from '../auth/token';

export type QueueStatus = 'PENDING' | 'SENDING' | 'SENT' | 'ERROR';
export type QueuePhoto = { uri: string; kind: PhotoKind };

export type QueueRow = {
  clientId: string;
  /** Yazan kişi ve firma. Eski sürümden kalan satırda null: sahibi bilinemez, gönderilmez. */
  personId: string | null;
  orgId: string | null;
  data: MeasurementPayload;
  photos: QueuePhoto[];
  status: QueueStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  serverId: string | null;
  createdAt: number;
  sentAt: number | null;
};

type DbRow = Omit<QueueRow, 'data' | 'photos'> & { data: string; photos: string };

function decode(r: DbRow): QueueRow {
  return { ...r, data: JSON.parse(r.data) as MeasurementPayload, photos: JSON.parse(r.photos) as QueuePhoto[] };
}

/**
 * Kapsam koşulu. Kuyruğun tüm okuma ve yazmaları bundan geçer: bir oturum başka kişinin veya firmanın
 * kaydını göremez, gönderemez, değiştiremez. NULL sütun `=` ile eşleşmez, eski satırlar da dışarıda kalır.
 */
const IN_SCOPE = 'personId = ? AND orgId = ?';

export async function insertRow(scope: SessionScope, row: Pick<QueueRow, 'clientId' | 'data' | 'photos'>): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO queue (clientId, userId, personId, orgId, data, photos, status, attempts, nextAttemptAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, ?)`,
    row.clientId,
    scope.personId,
    scope.personId,
    scope.orgId,
    JSON.stringify(row.data),
    JSON.stringify(row.photos),
    Date.now(),
  );
}

/**
 * Kayıt beklemesinin (`nextAttemptAt`) en uzun süresi. Bundan daha ileride bekleme ancak telefon saati geri alındığında olur:
 * o kayıt beklemiyor sayılır, kuyruk saat yetişene dek (saatler, günler) takılı kalmaz.
 */
export const ROW_DELAY_MAX_MS = 30 * 60_000;

export async function dueRows(scope: SessionScope, includeErrors: boolean, ignoreBackoff = false): Promise<QueueRow[]> {
  const db = await getDb();
  const owner = [scope.personId, scope.orgId];
  const now = Date.now();
  const rows = includeErrors
    ? await db.getAllAsync<DbRow>(`SELECT * FROM queue WHERE ${IN_SCOPE} AND status IN ('PENDING','ERROR') ORDER BY createdAt`, ...owner)
    : ignoreBackoff
      ? await db.getAllAsync<DbRow>(`SELECT * FROM queue WHERE ${IN_SCOPE} AND status = 'PENDING' ORDER BY createdAt`, ...owner)
      : await db.getAllAsync<DbRow>(
          `SELECT * FROM queue WHERE ${IN_SCOPE} AND status = 'PENDING' AND (nextAttemptAt <= ? OR nextAttemptAt > ?) ORDER BY createdAt`,
          ...owner,
          now,
          now + ROW_DELAY_MAX_MS,
        );
  return rows.map(decode);
}

export async function rowsSince(scope: SessionScope, sinceMs: number): Promise<QueueRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<DbRow>(
    `SELECT * FROM queue WHERE ${IN_SCOPE} AND (createdAt >= ? OR status != 'SENT') ORDER BY createdAt DESC`,
    scope.personId,
    scope.orgId,
    sinceMs,
  );
  return rows.map(decode);
}

/**
 * Takip no karşılaştırma anahtarları: sunucudaki `/measurements/check` ile aynı kural (core `stripScanNoise` +
 * `trackingCandidates`: boşluk/tire, okuyucu işaretleri, büyük harf; FedEx 34 haneli barkodda son 12 ve 15 hane de).
 */
function trackingKeys(raw: string): string[] {
  return trackingCandidates(stripScanNoise(raw));
}

/** Aynı takip no'lu, henüz gönderilmemiş (kuyrukta/hatalı) en son kayıt — mükerrer uyarısı için. Yalnız bu oturumun kayıtları. */
export async function findUnsentByTracking(scope: SessionScope, tracking: string): Promise<QueueRow | null> {
  const keys = trackingKeys(tracking);
  if (!keys.length) return null;
  const db = await getDb();
  const rows = await db.getAllAsync<DbRow>(`SELECT * FROM queue WHERE ${IN_SCOPE} AND status != 'SENT' ORDER BY createdAt DESC`, scope.personId, scope.orgId);
  for (const r of rows) {
    const row = decode(r);
    if (trackingKeys(row.data.trackingRaw).some((k) => keys.includes(k))) return row;
  }
  return null;
}

export async function countUnsent(scope: SessionScope): Promise<{ pending: number; error: number }> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ pending: number | null; error: number | null }>(
    `SELECT SUM(CASE WHEN status IN ('PENDING','SENDING') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS error FROM queue WHERE ${IN_SCOPE}`,
    scope.personId,
    scope.orgId,
  );
  return { pending: r?.pending ?? 0, error: r?.error ?? 0 };
}

export type UnsentGroup = { personId: string | null; orgId: string | null; count: number };

/** Telefondaki tüm gönderilmemiş kayıtlar, sahibine göre. Satır içeriği dönmez: uyarı yalnız sayı gösterir. */
export async function unsentGroups(): Promise<UnsentGroup[]> {
  const db = await getDb();
  return db.getAllAsync<UnsentGroup>(`SELECT personId, orgId, COUNT(*) AS count FROM queue WHERE status != 'SENT' GROUP BY personId, orgId`);
}

export type OtherSessions = {
  /** Aynı kişinin başka firmadaki kayıtları: firma değiştirince gönderilir. */
  samePerson: number;
  /** Başka kişinin ya da sahibi bilinmeyen kayıtlar. */
  otherPerson: number;
  total: number;
};

/** Bu oturumda gönderilmeyecek kayıtların özeti. */
export function summarizeOtherSessions(groups: readonly UnsentGroup[], scope: SessionScope | null, personId: string | null): OtherSessions {
  let samePerson = 0;
  let otherPerson = 0;
  for (const g of groups) {
    if (scope && g.personId === scope.personId && g.orgId === scope.orgId) continue;
    if (personId && g.personId === personId) samePerson += g.count;
    else otherPerson += g.count;
  }
  return { samePerson, otherPerson, total: samePerson + otherPerson };
}

/**
 * Bu oturumda silinebilen başka oturum kayıtlarının sayısı. Kural `deleteOtherSessions` ile aynıdır:
 * kişinin kendi kayıtları (başka firmadakiler dahil), `canManage` ise etkin firmadaki başka kişilerin kayıtları.
 */
export function deletableOtherSessions(groups: readonly UnsentGroup[], scope: SessionScope | null, canManage: boolean): number {
  if (!scope) return 0;
  let n = 0;
  for (const g of groups) {
    const ownOther = g.personId === scope.personId && g.orgId !== scope.orgId;
    const managed = canManage && g.personId !== null && g.personId !== scope.personId && g.orgId === scope.orgId;
    if (ownOther || managed) n += g.count;
  }
  return n;
}

/**
 * Sahibi dönmeyen kayıtları kalıcı olarak siler. Silinen `clientId`leri döner, dosyaları çağıran temizler.
 * Kişi kendi kayıtlarını silebilir. Başkasınınkini silmek için `canManage` (etkin oturumda `deciship.measurements.manage`)
 * gerekir ve kayıt etkin firmaya ait olmalıdır. Başka firmanın kaydı ve sahibi bilinmeyen eski satır silinmez.
 */
export async function deleteOtherSessions(scope: SessionScope, canManage: boolean): Promise<string[]> {
  const db = await getDb();
  const own = '(personId = ? AND (orgId IS NULL OR orgId != ?))';
  const where = canManage ? `${own} OR (personId != ? AND orgId = ?)` : own;
  const params = canManage ? [scope.personId, scope.orgId, scope.personId, scope.orgId] : [scope.personId, scope.orgId];
  const rows = await db.getAllAsync<{ clientId: string }>(`SELECT clientId FROM queue WHERE status != 'SENT' AND (${where})`, ...params);
  await db.runAsync(`DELETE FROM queue WHERE status != 'SENT' AND (${where})`, ...params);
  return rows.map((r) => r.clientId);
}

/** Kişinin firma başına bekleyen kayıtları: firma seçiminde gösterilir. */
export function pendingByOrg(groups: readonly UnsentGroup[], personId: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!personId) return out;
  for (const g of groups) {
    if (g.personId === personId && g.orgId) out[g.orgId] = (out[g.orgId] ?? 0) + g.count;
  }
  return out;
}

/** Yalnızca hâlâ gönderilmemişse ve bu oturumunsa SENDING yapar (bu arada yerelde silinmiş olabilir). */
export async function markSending(scope: SessionScope, clientId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE queue SET status = 'SENDING' WHERE clientId = ? AND ${IN_SCOPE} AND status IN ('PENDING','ERROR')`,
    clientId,
    scope.personId,
    scope.orgId,
  );
  return r.changes > 0;
}

export async function markSent(clientId: string, serverId: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queue SET status = 'SENT', serverId = ?, sentAt = ?, lastError = NULL, photos = '[]' WHERE clientId = ?`,
    serverId,
    Date.now(),
    clientId,
  );
}

export async function markRetry(clientId: string, attempts: number, nextAttemptAt: number, error: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queue SET status = 'PENDING', attempts = ?, nextAttemptAt = ?, lastError = ? WHERE clientId = ?`,
    attempts,
    nextAttemptAt,
    error,
    clientId,
  );
}

export async function markError(clientId: string, attempts: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE queue SET status = 'ERROR', attempts = ?, lastError = ? WHERE clientId = ?`, attempts, error, clientId);
}

/** Gönderilmiş satır bu süre telefonda kalır (çift kayıt denetimi için). Taslak ömrü bundan kısa olmalı (`DRAFT_TTL_MS`). */
export const SENT_KEEP_MS = 3 * 24 * 3600 * 1000;

export async function recoverInterrupted(): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE queue SET status = 'PENDING' WHERE status = 'SENDING'`);
  await db.runAsync(`DELETE FROM queue WHERE status = 'SENT' AND sentAt < ?`, Date.now() - SENT_KEEP_MS);
}

export async function getRow(scope: SessionScope, clientId: string): Promise<QueueRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<DbRow>(`SELECT * FROM queue WHERE clientId = ? AND ${IN_SCOPE}`, clientId, scope.personId, scope.orgId);
  return r ? decode(r) : null;
}

/** Satır hâlâ duruyor mu (kimin olursa olsun)? Dosya temizliği için; içerik dönmez. */
export async function rowExists(clientId: string): Promise<boolean> {
  const db = await getDb();
  return (await db.getFirstAsync<{ clientId: string }>('SELECT clientId FROM queue WHERE clientId = ?', clientId)) !== null;
}

/**
 * Henüz gönderilmemiş (PENDING/ERROR) kaydı yerelde günceller; hatalı kayıt yeniden kuyruğa girer.
 * Kayıt bu arada gönderilmeye başladıysa ya da gönderildiyse `false` döner.
 */
export async function updateUnsent(scope: SessionScope, clientId: string, data: MeasurementPayload, photos: QueuePhoto[]): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE queue SET data = ?, photos = ?, status = 'PENDING', attempts = 0, nextAttemptAt = 0, lastError = NULL
     WHERE clientId = ? AND ${IN_SCOPE} AND status IN ('PENDING','ERROR')`,
    JSON.stringify(data),
    JSON.stringify(photos),
    clientId,
    scope.personId,
    scope.orgId,
  );
  return r.changes > 0;
}

/**
 * Gönderilmiş kayıt sunucuda düzeltildi (yeni sürüm, yeni kimlik): telefondaki satır yeni değerleri ve kimliği alır. Barkod
 * ekranının "Son okunanlar" listesi ve Bugün'ün yerel satırları eski değeri göstermesin. Durum, gönderim anı ve ölçüm anı
 * değişmez. Yalnız bu oturumun gönderilmiş satırı; telefonda karşılığı yoksa `false`.
 */
export async function updateSentFromServer(scope: SessionScope, oldServerId: string, next: MeasurementItem): Promise<boolean> {
  const db = await getDb();
  const rows = await db.getAllAsync<DbRow>(
    `SELECT * FROM queue WHERE serverId = ? AND ${IN_SCOPE} AND status = 'SENT'`,
    oldServerId,
    scope.personId,
    scope.orgId,
  );
  let changed = false;
  for (const r of rows) {
    const { note: _note, boxPresetId: _preset, dimConfidence: _conf, ...rest } = decode(r).data;
    const data: MeasurementPayload = {
      ...rest,
      trackingRaw: next.trackingRaw,
      lengthCm: next.lengthCm,
      widthCm: next.widthCm,
      heightCm: next.heightCm,
      weightKg: next.weightKg,
      dimMethod: next.dimMethod,
      weightMethod: next.weightMethod,
      ...(next.note ? { note: next.note } : {}),
      ...(next.boxPresetId ? { boxPresetId: next.boxPresetId } : {}),
      ...(typeof next.dimConfidence === 'number' ? { dimConfidence: next.dimConfidence } : {}),
      // Ambalaj sunucudaki yeni sürümden; eski sunucu göndermezse telefondaki değer kalır.
      ...(next.packaging ? { packaging: next.packaging } : {}),
    };
    const res = await db.runAsync(
      `UPDATE queue SET data = ?, serverId = ? WHERE clientId = ? AND serverId = ? AND ${IN_SCOPE} AND status = 'SENT'`,
      JSON.stringify(data),
      next.id,
      r.clientId,
      oldServerId,
      scope.personId,
      scope.orgId,
    );
    if (res.changes > 0) changed = true;
  }
  return changed;
}

/** Gönderilmemiş kaydı kuyruktan çıkarır (dosyalar çağıranda kalır). Silinen satırı döner. */
export async function deleteUnsent(scope: SessionScope, clientId: string): Promise<QueueRow | null> {
  const db = await getDb();
  const row = await getRow(scope, clientId);
  if (!row || (row.status !== 'PENDING' && row.status !== 'ERROR')) return null;
  const r = await db.runAsync(
    `DELETE FROM queue WHERE clientId = ? AND ${IN_SCOPE} AND status IN ('PENDING','ERROR')`,
    clientId,
    scope.personId,
    scope.orgId,
  );
  return r.changes > 0 ? row : null;
}

/** Silinen gönderilmemiş kaydı aynen geri koyar (Geri al). Sahibi değişmez. */
export async function reinsertRow(row: QueueRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO queue (clientId, userId, personId, orgId, data, photos, status, attempts, nextAttemptAt, lastError, serverId, createdAt, sentAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.clientId,
    row.personId ?? 'legacy',
    row.personId,
    row.orgId,
    JSON.stringify(row.data),
    JSON.stringify(row.photos),
    row.status === 'ERROR' ? 'ERROR' : 'PENDING',
    row.attempts,
    0,
    row.lastError,
    null,
    row.createdAt,
    null,
  );
}
