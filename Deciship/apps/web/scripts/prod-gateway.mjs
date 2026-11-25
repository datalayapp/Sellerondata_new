// Üretim paketleriyle tek köken: `/deciship/*` DeciShip, geri kalanı Merkez, `/api/*` 503 (testler kendisi yanıtlar).
// Görünüm geçişini geliştirme sunucusunda sınamak yanıltır: tek tek yüklenen modüller tarayıcının 4 sn sınırını aşar, geçiş atlanır.
//   node scripts/prod-gateway.mjs --build   iki uygulamayı derler ve çıkar (Merkez çıktısı node_modules/.cache altına, Platform'a yazılmaz)
//   node scripts/prod-gateway.mjs           sunar (PROD_GATEWAY_PORT, varsayılan 5393)
import { execSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '..');
const hubRoot = path.resolve(web, '../../../Platform/apps/hub-web');
const webDist = path.join(web, 'dist');
const hubDist = path.join(web, 'node_modules/.cache/hub-dist');

if (process.argv.includes('--build')) {
  execSync('npx vite build', { cwd: web, stdio: 'inherit' });
  execSync(`npx vite build --outDir "${hubDist}" --emptyOutDir`, { cwd: hubRoot, stdio: 'inherit' });
  process.exit(0);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(res, file) {
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const port = Number(process.env.PROD_GATEWAY_PORT ?? 5393);
createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x');
  if (pathname.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'prod-gateway: API yok' } }));
    return;
  }
  const inApp = pathname === '/deciship' || pathname.startsWith('/deciship/');
  const root = inApp ? webDist : hubDist;
  const rel = inApp ? pathname.slice('/deciship'.length) : pathname;
  const file = path.join(root, path.normalize(rel));
  if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return send(res, file);
  send(res, path.join(root, 'index.html'));
}).listen(port, '127.0.0.1', () => console.log(`prod-gateway http://localhost:${port}`));
