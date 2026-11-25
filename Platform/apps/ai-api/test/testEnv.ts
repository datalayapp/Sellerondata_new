import crypto from 'node:crypto';
import { resolveTestDbHost } from '../../../../scripts/lib/pg-guard.mjs';

/**
 * vitest.config ve globalSetup ortak kullanır. Gerçek Postgres (varsayılan `scripts/lib/pg-guard.mjs`: gerçek kullanım kümesine
 * bağlanmaz; `TEST_DB_HOST=localhost:5435`), gerçek roller (`sod_ai_admin`, `sod_ai`).
 * Koşu başına ayrı veritabanı (`sellerondata_ai_test_<pid>_<rastgele>`), bitişte silinir; incelemek için `AI_TEST_DB` verin.
 */
const host = resolveTestDbHost();
process.env.AI_TEST_DB ??= `sellerondata_ai_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
export const TEST_DB_NAME = process.env.AI_TEST_DB;
export const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
const dbUrl = (user: string, password: string, db = TEST_DB_NAME) => {
  const u = new URL(SUPER_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
};
export const TEST_APP_URL = dbUrl('sod_ai', process.env.SOD_AI_DB_PASSWORD ?? 'sod_ai_dev');
export const TEST_ADMIN_URL = dbUrl('sod_ai_admin', process.env.SOD_AI_ADMIN_DB_PASSWORD ?? 'sod_ai_admin_dev');
export const TEST_MIGRATE_URL = `${TEST_ADMIN_URL}?schema=ai`;
export const TEST_SUPER_DB_URL = (() => {
  const u = new URL(SUPER_URL);
  u.pathname = `/${TEST_DB_NAME}`;
  return u.toString();
})();

export const TEST_ORIGIN = 'http://localhost:8088';
export const TEST_JWKS_URL = 'http://account.test/api/account/.well-known/jwks.json';
export const TEST_ANTHROPIC_URL = 'http://anthropic.test';
export const TEST_GEMINI_URL = 'http://gemini.test';

/**
 * Koşu başına rastgele araç jetonları ve ana anahtar (sabit değer testte bile depoya girmesin). Yapılandırma bir kez üretir, ortam
 * değişkeniyle çalışanlara geçer (çalışan dosyayı yeniden içe aktarınca aynı değer).
 */
process.env.AI_TEST_TOKEN_DECISHIP ??= `deciship-test-${crypto.randomBytes(16).toString('hex')}`;
process.env.AI_TEST_TOKEN_TAGPRESS ??= `tagpress-test-${crypto.randomBytes(16).toString('hex')}`;
process.env.AI_TEST_KEY_MASTER ??= crypto.randomBytes(32).toString('base64');
export const TEST_TOOL_TOKENS = {
  deciship: process.env.AI_TEST_TOKEN_DECISHIP,
  tagpress: process.env.AI_TEST_TOKEN_TAGPRESS,
} as const;
export const TEST_KEY_MASTER = process.env.AI_TEST_KEY_MASTER;
