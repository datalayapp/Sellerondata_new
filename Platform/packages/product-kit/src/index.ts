/**
 * @sellerondata/product-kit: her aracın API'sinde aynı olan işler (Mesaj 11, 01-B8).
 *
 * ```ts
 * const db = pgDb(new pg.Pool({ connectionString }));
 * const identity = registerProductIdentity(app, {
 *   product: 'orderloom', db, schema: 'orderloom', jwksUrl, allowedOrigins,
 *   purge: { tables: ['OrderLine', { table: 'Attachment', returning: ['path'] }, 'Order'], onRowsDeleted, onPurged },
 * });
 * registerHubRoutes(app, { product: 'orderloom', providers: { overview: async (ctx, period) => ({ … }) } });
 * app.post('/api/orderloom/orders', { onRequest: app.requirePermission('orderloom.orders.write') }, async (req) =>
 *   withOrg(db, req.auth.orgId, (tx) => tx.query('INSERT INTO orderloom."Order" …')));
 * ```
 * Göç: aracın ilk göçüne `memberProjectionSql({ schema, appRole })` çıktısı konur. Örnek araç: `test/ornekarac/`.
 * Firma kaydı (saat dilimi, Merkez onayı): `readOrgProfile`; Merkez çatısı kendisi okur. İstek dışı yetki: `loadMemberAccess` +
 * `memberPermissions`. Kalıcı silme parça parça (`purge.ts`); aracın testi `identity.checkPurgeTables()` ve `identity.checkGrants()` için
 * `[]` beklesin.
 * Bakım turu (saatlik) bitmemiş silmeleri sürdürür ve 30 günü dolan olay kimliklerini siler (`cleanupProcessedEvents`).
 * Merkez'in saf parçaları (dönem, CSV, saat dilimi, yuva sayacı) ayrıca `@sellerondata/product-kit/pure` girişinde (`src/pure/`).
 */
export {
  pgDb,
  setTxOrg,
  sqlIdent,
  sqlTableIdent,
  withEventScope,
  withMaintenanceScope,
  withOrg,
  MAINTENANCE_SCOPE,
  ORG_SETTING,
  SCOPE_SETTING,
  type SqlDb,
} from './db.ts';
export { memberProjectionSql, PROCESSED_EVENT_TTL_DAYS, PROCESSED_EVENT_TTL_MS } from './projection.ts';
export { checkProjectionGrants, PROJECTION_COLUMN_UPDATES, PROJECTION_TABLE_PRIVILEGES, type GrantIssue } from './grants.ts';
export { isOrgClosed, PURGE_FIRST_RUN_MS, PURGE_RETRY_EVERY_MS, registerProductIdentity, type ProductIdentity, type ProductIdentityOptions } from './identity.ts';
export { readOrgProfile, type OrgProfile } from './org.ts';
export { loadMemberAccess, memberPermissions, type MemberAccess } from './members.ts';
export {
  PURGE_BATCH_SIZE,
  PURGE_RUN_LIMIT,
  PURGE_RUN_MS,
  PURGE_SLICE_MS,
  type PurgeConfig,
  type PurgeOptions,
  type PurgeResult,
  type PurgeRunOptions,
  type PurgeTable,
  type PurgeTableIssue,
} from './purge.ts';
export { KitError, KIT_MESSAGES, kitError, kitMessage, sendKitError, type KitMessageKey } from './errors.ts';
export { registerHubRoutes, type HubCtx, type HubExport, type HubOrgSource, type HubProviders, type HubRoutesOptions } from './hub/routes.ts';
export { parsePeriod, type PeriodCtx } from './hub/period.ts';
export {
  bucketize,
  bucketSize,
  isoShift,
  makePeriod,
  MAX_RANGE_DAYS,
  previousPeriod,
  resolvePeriod,
  validDay,
  type Period,
  type PeriodIssue,
} from './pure/period.ts';
export { CSV_BOM, csvHeader, csvRows, csvSeparator, neutralizeCsv } from './pure/csv.ts';
export { personalCache, queryInt, requestLocale, streamIdleTimeout } from './hub/http.ts';
export { createOrgLimiter, type OrgLimiter, type OrgLimiterOptions, type SlotPool } from './hub/limiter.ts';
export { DEFAULT_TIME_ZONE, isTimeZone, zonedDate } from './pure/time.ts';
export { createSlotCounter, releaseWhenBoth, type SlotCounter } from './pure/slots.ts';
