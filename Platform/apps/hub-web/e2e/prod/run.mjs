// `npm run test:prod`: üretim derlemesini (taslak girişiyle) alır, CSP'li sunucuda geçiş testini çalıştırır.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(import.meta.dirname, 'dist');
const run = (args, env = {}) => {
  const r = spawnSync('npx', args, { cwd, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(['vite', 'build', '--outDir', JSON.stringify(outDir), '--emptyOutDir'], { SOD_E2E_STUB: '1' });
run(['playwright', 'test', '--config', 'e2e/prod/playwright.config.ts']);
