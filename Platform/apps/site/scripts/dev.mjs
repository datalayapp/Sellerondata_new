// Geliştirme: dist/ derle, 5190'da sun, src/ ve public/ değişince yeniden derle.
// Derleme her seferinde ayrı süreçte koşar: ESM modül önbelleği eski metni tutmasın.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { watch, existsSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SITE_DIST ? path.resolve(process.env.SITE_DIST) : path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5190);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };

const build = () =>
  new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
      if (err) console.error(stderr || err.message);
      else process.stdout.write(stdout);
      resolve();
    });
  });

await build();
let timer;
for (const dir of ['src', 'public', 'scripts']) {
  watch(path.join(ROOT, dir), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(build, 150);
  });
}

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(DIST, p);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) {
      // nginx.conf ile aynı: /en/ altı EN 404, gerisi TR 404.
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      createReadStream(path.join(DIST, p.startsWith('/en/') ? 'en/404.html' : '404.html')).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`site: http://localhost:${PORT}`));
