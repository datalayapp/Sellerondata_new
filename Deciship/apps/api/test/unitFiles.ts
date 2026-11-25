import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 15-B5, Aşama 0.3: veritabanı istemeyen API test dosyaları; liste elle değil, dosyaların içe aktarımlarından çıkar.
 * Hızlı grupta (`npm run test:unit`, parça `api-unit`) Postgres'siz koşarlar; ana yapılandırma (`vitest.config.ts`)
 * bunları dışlar, iki kez koşmazlar. `scripts/t.mjs` de bu listeye bakar (düz Node 24 ile yüklenir: yalnız node
 * yerleşikleri, tip silinebilir sözdizimi).
 *
 * Kural: `test/**\/*.test.ts` dosyası (`*.perf.test.ts` hariç; onlar `vitest.perf.config.ts`'te) aşağıdakilerden birini
 * doğrudan ya da `test/` altındaki bir yardımcı üzerinden (zincirle) içe aktarmıyorsa veritabanısızdır:
 * - `src/db.ts`, `src/app.ts`, `src/seed.ts`, `src/generated/**` (Prisma, `buildApp`, tohum),
 * - `test/helpers.ts` (`getApp` …), `test/fixtures.ts`, `test/globalSetup.ts`,
 * - `pg`, `@prisma/*` paketleri.
 * Dosya yine de veritabanında koşmalıysa ilk satırlarından birine `// test-layer: db` yazılır (bugün kullanan yok).
 *
 * Yanlış sınıflama sessiz kalmaz: veritabanısız sayılan dosya Postgres'e bağlanmaya kalkarsa `test/noDbGuard.ts`
 * dosyayı kırar; o dosyaya `// test-layer: db` eklenir ya da içe aktarımı düzeltilir.
 */

const API_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TEST_DIR = path.join(API_DIR, 'test');

/** Depo köküne değil API klasörüne göre, `/` ayraçlı yol (`test/x.test.ts`, `src/db.ts`). */
const rel = (abs: string) => path.relative(API_DIR, abs).split(path.sep).join('/');

const DB_LOCAL = [/^src\/(db|app|seed)\.ts$/, /^src\/generated\//, /^test\/(helpers|fixtures|globalSetup)\.ts$/];
const DB_PACKAGE = /^(pg|pg-[\w-]+|@prisma\/[\w-]+)(\/|$)/;
const OPT_OUT = /^\s*\/\/\s*test-layer:\s*db\s*$/m;
/** `import … from 'x'`, `export … from 'x'`, `import 'x'`, `import('x')`; satır başındaki (yorum olmayan) bildirimler. */
const IMPORT_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

const memo = new Map<string, boolean>();

/** Dosya (ya da içe aktardığı bir test yardımcısı) veritabanına dokunan bir modülü içe aktarıyor mu? */
function touchesDb(abs: string, seen: Set<string>): boolean {
  const cached = memo.get(abs);
  if (cached !== undefined) return cached;
  if (seen.has(abs)) return false;
  seen.add(abs);
  let source = '';
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  let db = false;
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? '';
    if (!spec.startsWith('.')) {
      if (DB_PACKAGE.test(spec)) db = true;
    } else {
      const target = path.resolve(path.dirname(abs), spec);
      const r = rel(target);
      if (DB_LOCAL.some((re) => re.test(r))) db = true;
      // test/ altındaki yardımcılar zincirle izlenir (disputeHelpers → helpers gibi); src içi izlenmez
      else if (r.startsWith('test/') && /\.[cm]?ts$/.test(r) && touchesDb(target, seen)) db = true;
    }
    if (db) break;
  }
  memo.set(abs, db);
  return db;
}

function listTestFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => path.join(dir, f))
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.perf.test.ts'))
    .sort();
}

function isUnit(abs: string): boolean {
  if (OPT_OUT.test(fs.readFileSync(abs, 'utf8'))) return false;
  return !touchesDb(abs, new Set());
}

/** Veritabanısız test dosyaları, API klasörüne göre (`test/x.test.ts`). */
export const UNIT_TEST_FILES: string[] = listTestFiles(TEST_DIR).filter(isUnit).map(rel);

/** Başarım katmanı (süre eşikli, kapı değil): `npm run test:perf`, `vitest.perf.config.ts`. */
export const PERF_TEST_GLOB = 'test/**/*.perf.test.ts';
/**
 * KALANLAR 6.14: veritabanlı başarım dosyaları (`*.db.perf.test.ts`; büyük firma verisini kendisi üretir). Postgres ister:
 * `npm run test:perf:db`, `vitest.perf-db.config.ts`; veritabanısız başarım yapılandırması bunları dışlar.
 */
export const PERF_DB_TEST_GLOB = 'test/**/*.db.perf.test.ts';
