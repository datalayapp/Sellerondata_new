// Bağımlılık kurulumu (Mesaj 10 planı 3.3). Yalnız Node yerleşik modülleri.
// Yerelde yalnız node_modules OLMAYAN klasörde `npm ci`. Var olan node_modules'a dokunulmaz, silinmez.
// Kullanım: node scripts/install.mjs [--ci] [--group quick|db] [--dry-run]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

// Sıra önemli: önce ortak paketler; en sonda lint araçları (kök node_modules oluşmasın diye tools/lint altında).
const DIRS = [
  { dir: 'Platform/packages/contracts', groups: ['quick'] },
  // Bağımlılıksız; tip denetimi ve testi (tc:format, format) için typescript ister.
  { dir: 'Platform/packages/format', groups: ['quick'] },
  { dir: 'Platform/packages/auth-kit', groups: ['quick', 'db'] },
  { dir: 'Platform/packages/product-kit', groups: ['quick', 'db'] },
  { dir: 'Platform/packages/shell', groups: ['quick'] },
  // db: API çekirdeği file: bağıyla çalışma anında yükler; exceljs vb. çekirdeğin node_modules klasöründen çözülür.
  { dir: 'Deciship/packages/core', groups: ['quick', 'db'] },
  // quick: npm test tip denetimini, api-unit ve api-cli parçalarını da koşar.
  { dir: 'Deciship/apps/api', groups: ['quick', 'db'] },
  { dir: 'Deciship/apps/web', groups: ['quick'] },
  { dir: 'Deciship/apps/mobile', groups: ['quick'] },
  { dir: 'Platform/apps/account-api', groups: ['quick', 'db'] },
  { dir: 'Platform/apps/hub-web', groups: ['quick'] },
  // Tip denetimi (tc:platform-e2e) @playwright/test ve @types/node ister; tarayıcı indirmez.
  { dir: 'Platform/e2e', groups: ['quick'] },
  { dir: 'tools/lint', groups: ['quick'] },
];

const args = process.argv.slice(2);
let ci = false, group = null, dry = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--ci') ci = true;
  else if (a === '--dry-run') dry = true;
  else if (a === '--group') group = args[++i];
  else if (a === '--help' || a === '-h') {
    console.log('Kullanım: node scripts/install.mjs [--ci] [--group quick|db] [--dry-run]\n' +
      'Yerelde yalnız node_modules olmayan klasörde `npm ci` çalışır; var olana dokunmaz.\n' +
      '--ci: her klasörde `npm ci` (Windows\'ta dolu klasörü reddeder). --dry-run: yalnız ne yapılacağını yazar.');
    process.exit(0);
  } else { console.error(`Bilinmeyen bağımsız değişken: ${a}`); process.exit(2); }
}
if (group && !['quick', 'db'].includes(group)) { console.error('--group quick ya da db olmalı'); process.exit(2); }

let bad = false;
for (const { dir, groups } of DIRS) {
  if (group && !groups.includes(group)) continue;
  const abs = path.join(ROOT, dir);
  if (!existsSync(path.join(abs, 'package.json'))) { console.log(`atlandı: ${dir} (package.json yok)`); continue; }
  const has = existsSync(path.join(abs, 'node_modules'));
  if (has && !ci) { console.log(`var: ${dir} (dokunulmadı)`); continue; }
  if (has && ci && WIN) {
    console.error(`reddedildi: ${dir} içinde node_modules var; Windows'ta --ci dolu klasörü silebilir (junction riski). Elle ve dikkatle kaldırın.`);
    bad = true;
    continue;
  }
  console.log(`${dry ? 'kurulacak' : 'kuruluyor'}: ${dir} (npm ci)`);
  if (dry) continue;
  const r = spawnSync('npm ci', { cwd: abs, shell: true, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`HATA: ${dir} kurulamadı`); bad = true; }
}
process.exit(bad ? 1 : 0);
