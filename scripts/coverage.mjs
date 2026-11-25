// İsteğe bağlı kapsam ölçümü (15-B14): yalnız hesap motoru (Deciship/packages/core), para modülleri.
// Kullanım: node scripts/coverage.mjs        (kök: npm run coverage:core, bkz. rapor)
// Eşik yok; yalnız satır/dal oranını raporlar, özet .test-logs/coverage-<tarih>.txt dosyasına yazılır.
// Çıkış: 0 koştu, 2 koşmadı (kapsam paketi kurulu değil; hiçbir şey kurulmaz), vitest'in kodu başarısızsa o.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'Deciship', 'packages', 'core');
const MODULES = ['src/compare.ts', 'src/tariff.ts', 'src/calc.ts'];

const req = createRequire(path.join(CORE, 'package.json'));
try {
  req.resolve('@vitest/coverage-v8/package.json');
} catch {
  console.error(
    'koşmadı: kapsam paketi (@vitest/coverage-v8) kurulu değil; bu betik hiçbir şey kurmaz.\n' +
      'Kurmak için (vitest ile aynı sürüm): cd Deciship/packages/core && npm install -D @vitest/coverage-v8@<vitest sürümü>',
  );
  process.exit(2);
}

const args = [
  'vitest', 'run', '--coverage', '--coverage.provider=v8', '--coverage.reporter=text-summary', '--coverage.reporter=text',
  ...MODULES.map((m) => `--coverage.include=${m}`),
];
const r = spawnSync('npx', args, { cwd: CORE, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(out);

const day = new Date().toISOString().slice(0, 10);
const dir = path.join(ROOT, '.test-logs');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `coverage-${day}.txt`);
writeFileSync(file, `Kapsam (hesap motoru: ${MODULES.join(', ')}) ${day}\n\n${out}`);
console.log(`\nÖzet yazıldı: ${path.relative(ROOT, file)}`);
process.exit(r.status ?? 1);
