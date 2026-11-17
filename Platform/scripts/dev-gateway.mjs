// Geliştirme gateway'i: tek köken http://localhost:8088. Bağımlılıksız Node vekili.
// Üretim gateway'inin (gateway/conf/default.conf) yönlendirme tablosunun geliştirme karşılığıdır.
//   /api/account   -> account-api   :4100
//   /api/<anahtar> -> aracın API'si (kayıttan: deploy.api.dev; <ANAHTAR>_API_PORT ile ezilir; DeciShip :4000)
//   /<anahtar>     -> aracın web'i  (kayıttan: deploy.web.dev; <ANAHTAR>_WEB_PORT ile ezilir; DeciShip :5173, Vite base /deciship/)
//   gerisi         -> hub-web       :5180 (Vite)
// Araç yönlendirmesi Platform/packages/contracts/src/products.ts kaydından okunur (Node'un tip ayıklaması ile, derleme adımı yok).
// WebSocket (Vite HMR) geçirilir. */internal/* her zaman 404. CSP yoktur: Vite geliştirmede satır içi betik kullanır.
import http from 'node:http';
import net from 'node:net';
import { productTargets } from './dev-gateway-targets.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY = pathToFileURL(fileURLToPath(new URL('../packages/contracts/src/products.ts', import.meta.url))).href;
const { PRODUCT_REGISTRY } = await import(REGISTRY);

const PORT = Number(process.env.GATEWAY_PORT ?? 8088);
const T = {
  account: Number(process.env.ACCOUNT_PORT ?? 4100),
  hub: Number(process.env.HUB_PORT ?? 5180),
};

const PRODUCT_TARGETS = productTargets(PRODUCT_REGISTRY, process.env);

/** Yalnız yol kısmı, %xx çözülmüş ve ./.. sadeleştirilmiş (nginx ile aynı kural). */
function normalize(rawUrl) {
  let p;
  try {
    p = new URL(rawUrl, 'http://x').pathname;
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  return p.replace(/\/{2,}/g, '/');
}

const isInternal = (p) => /(^|\/)internal(\/|$)/i.test(p);

function pick(path) {
  if (path.startsWith('/api/account/')) return T.account;
  for (const [key, t] of Object.entries(PRODUCT_TARGETS)) {
    if (t.api && path.startsWith(`/api/${key}/`)) return t.api;
    if (t.web && (path === `/${key}` || path.startsWith(`/${key}/`))) return t.web;
  }
  return T.hub;
}

/** Her istekte karar: 'redirect' | 'notfound' | port. */
function route(rawUrl) {
  const path = normalize(rawUrl);
  if (path === null) return 'notfound';
  if (isInternal(path)) return 'notfound';
  if (path === '/') return 'redirect';
  // Tanımsız /api/* (kayıtta olmayan araç dahil) hub'a düşmez: JSON 404.
  if (path.startsWith('/api/') && pick(path) === T.hub) return 'notfound';
  return pick(path);
}

function forwardHeaders(req) {
  const h = { ...req.headers };
  const ip = req.socket.remoteAddress ?? '';
  h['x-forwarded-for'] = ip;
  h['x-real-ip'] = ip;
  h['x-forwarded-proto'] = 'http';
  h['x-forwarded-host'] = req.headers.host ?? '';
  return h;
}

const server = http.createServer((req, res) => {
  const target = route(req.url ?? '/');
  if (target === 'redirect') {
    res.writeHead(302, { location: '/home' }).end();
    return;
  }
  if (target === 'notfound') {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND"}}');
    return;
  }
  const up = http.request(
    { host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"SERVICE_UNAVAILABLE"}}');
  });
  req.pipe(up);
});

// WebSocket / HTTP yükseltmeleri (Vite HMR): ham TCP köprüsü.
server.on('upgrade', (req, socket, head) => {
  // Vite HMR kökte (/) bağlanır: yönlendirme değil, hub-web'e geçir.
  const r = route(req.url ?? '/');
  const target = r === 'redirect' ? T.hub : r;
  if (typeof target !== 'number') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const up = net.connect(target, '127.0.0.1', () => {
    const headers = forwardHeaders(req);
    let head0 = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) head0 += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    up.write(`${head0}\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  const tools = Object.entries(PRODUCT_TARGETS).map(([k, t]) => `${k}-web ${t.web ?? '-'}, ${k}-api ${t.api ?? '-'}`).join(', ');
  console.log(`dev-gateway http://localhost:${PORT}  (hub ${T.hub}, ${tools}, account ${T.account})`);
});

export { route, normalize };
