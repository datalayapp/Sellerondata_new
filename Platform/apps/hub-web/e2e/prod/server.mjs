// Üretim derlemesini gateway'in CSP başlığıyla sunar. Geçiş testi için. `/deciship/*` taslağa, kalan yollar Merkez'e.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, 'dist');
const port = Number(process.env.PORT ?? 5181);
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ext = path.extname(url.pathname);
  const file = ext ? url.pathname : /^\/deciship(\/|$)/.test(url.pathname) ? '/dev/deciship-stub/index.html' : '/index.html';
  try {
    const body = await readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`prod test server :${port}`));
