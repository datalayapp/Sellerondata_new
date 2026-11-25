import crypto from 'node:crypto';
import { resolveTestDbHost } from '../../../../scripts/lib/pg-guard.mjs';

/**
 * vitest.config ve globalSetup ortak kullanır. Gerçek Postgres (compose, 5434), gerçek roller.
 * Bu bilgisayar gerçek kullanımdaysa (Platform/.env SOD_GERCEK_KULLANIM) 5434'e bağlanılmaz: varsayılan 5435, 5434 hata.
 */
const host = resolveTestDbHost();
/** Koşu başına ayrı veritabanı: makinede aynı anda başka koşu (başka ajan, değerlendirici) varsa birbirinin verisini silmesin. */
process.env.SOD_TEST_DB ??= `sellerondata_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
export const TEST_DB_NAME = process.env.SOD_TEST_DB;
export const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
export const TEST_APP_URL = `postgresql://sod_platform:sod_platform_dev@${host}/${TEST_DB_NAME}`;
export const TEST_ADMIN_URL = `postgresql://sod_platform_admin:sod_platform_admin_dev@${host}/${TEST_DB_NAME}`;
export const TEST_DECISHIP_ADMIN_URL = `postgresql://sod_deciship_admin:sod_deciship_admin_dev@${host}/${TEST_DB_NAME}`;
export const TEST_MIGRATE_URL = `${TEST_ADMIN_URL}?schema=platform`;
export const TEST_DECISHIP_URL = `postgresql://sod_deciship:sod_deciship_dev@${host}/${TEST_DB_NAME}`;
export const TEST_ORIGIN = 'http://localhost:8088';
/** Tanıtım sitesi kökeni (SITE_ORIGINS). Yalnız site-session ve logout uçlarında geçerli. */
export const TEST_SITE_ORIGIN = 'http://localhost:8089';
export const TEST_EVENT_URL = 'http://deciship.test/api/deciship/internal/events';
/** TagPress (`pilot`) olay adresi: kapalı olmayan her ürünün adresi olmalı (üretim denetimi; geliştirmede uyarı). */
export const TEST_TAGPRESS_EVENT_URL = 'http://tagpress.test/api/tagpress/internal/events';

export function testSigningKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'EdDSA', use: 'sig' });
}
