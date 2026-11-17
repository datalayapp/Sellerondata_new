import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveTestDbHost } from '../../../../scripts/lib/pg-guard.mjs';

/**
 * vitest.config ve globalSetup ortak kullanır. Gerçek Postgres (Platform compose, 5434), gerçek roller.
 * Uygulama `sod_deciship`, migration `sod_deciship_admin`, test veritabanını süper kullanıcı açar.
 * Bu bilgisayar gerçek kullanımdaysa (Platform/.env SOD_GERCEK_KULLANIM) 5434'e bağlanılmaz: varsayılan 5435, 5434 hata.
 */
const host = resolveTestDbHost();
/**
 * 15-B10: ad verilmezse koşu başına ayrı veritabanı (Hesap servisindeki desen): aynı anda başka koşu (başka ajan,
 * tek dosya kısayolu) birbirinin bağlantılarını kesip veritabanını silmesin. Ad env üzerinden taşınır: yapılandırma,
 * globalSetup ve test çalışanları bu modülü ayrı ayrı yükler, hepsi aynı adı görür. Kendi ürettiği adı globalSetup
 * koşu sonunda siler (`TEST_DB_AUTO`); dışarıdan verilen ad incelemek için yerinde kalır.
 */
if (!process.env.TEST_DB_NAME) {
  process.env.TEST_DB_NAME = `deciship_apitest_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  process.env.TEST_DB_AUTO = '1';
}
export const TEST_DB_NAME = process.env.TEST_DB_NAME;
export const TEST_DB_AUTO = process.env.TEST_DB_AUTO === '1';
export const SUPER_URL = process.env.TEST_SUPER_URL ?? `postgresql://postgres:sod_postgres_dev@${host}/postgres`;
export const TEST_DB_URL = `postgresql://sod_deciship:sod_deciship_dev@${host}/${TEST_DB_NAME}`;
export const TEST_ADMIN_URL = `postgresql://sod_deciship_admin:sod_deciship_admin_dev@${host}/${TEST_DB_NAME}`;
export const TEST_MIGRATE_URL = `${TEST_ADMIN_URL}?schema=deciship&options=-c%20TimeZone%3DUTC`;
export const TEST_ORIGIN = 'http://localhost:8088';

/** Test veritabanının süper kullanıcı adresi. Yalnız kurulum ve RLS'yi dışarıdan doğrulayan testler kullanır. */
export function testSuperDbUrl(): string {
  const url = new URL(SUPER_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

/**
 * Test dosya klasörü veritabanı adına göre ayrılır: aynı anda farklı test DB'leriyle çalışan
 * koşular birbirinin dosyalarını silmez.
 */
export function testStorageDir(dbName = TEST_DB_NAME): string {
  return path.join(os.tmpdir(), `deciship-test-storage-${dbName.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'}`);
}

/**
 * İki yapılandırmanın (veritabanlı `vitest.config.ts`, veritabanısız `vitest.unit.config.ts`) ortak ortamı.
 * Veritabanı adresi ve dosya klasörü burada yok: her yapılandırma kendisi verir.
 */
export const BASE_TEST_ENV = {
  NODE_ENV: 'test',
  ANTHROPIC_API_KEY: '',
  VISION_URL: 'http://127.0.0.1:59999',
  ALLOWED_ORIGINS: TEST_ORIGIN,
  FILE_TOKEN_SECRET: 'test-file-token-secret-test-file-token-secret',
  // Sıfırlama ucu matrise girsin. Kapalı durumu ayrı testte (permissionMatrix.test.ts) denenir.
  ENABLE_DATA_RESET: 'true',
  // Mesaj 6: API hız sınırı testlerde kapalı, açık hâli kendi testinde denenir; dosya okuma ana süreçte (worker testi `thread` dener).
  API_RATE_LIMIT: 'off',
  FILE_WORKER_MODE: 'inline',
  // Mesaj 7: işi başlatan istek onu sonuna kadar çalıştırır; testler arka plan döngüsü açmaz (açık döngüyü kendi testi dener).
  JOB_RUNNER: 'inline',
  // Sistemin günlük yapay zekâ tavanı bütün firmaların toplamıdır; test veritabanı dosyalar arasında ortak olduğundan başka
  // dosyanın kayıtları sonucu değiştirmesin. Açık hâli, varsayılanı ve `off` kendi testinde (test/aiDailyBudget.test.ts).
  AI_DAILY_BUDGET_TRY: 'off',
};
