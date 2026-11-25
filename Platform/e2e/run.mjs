// `npm run e2e`: yığını BASLAT.bat akışıyla açar, testleri çalıştırır. Yığın açık kalır; temizlemek için `npm run stack:reset`.
//   E2E_NO_UP=1  yığın zaten açık, derleme atlanır
//   Sonraki argümanlar Playwright'a geçer: npm run e2e -- tests/10-site-kayit.spec.ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBat } from './stack.mjs';

if (!process.env.E2E_NO_UP) {
  const { code } = await runBat('BASLAT.bat', {});
  if (code !== 0) process.exit(code ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'node_modules', '@playwright', 'test', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], { stdio: 'inherit', cwd: here });
process.exit(r.status ?? 1);
