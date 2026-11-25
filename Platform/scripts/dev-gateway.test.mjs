// node --test scripts/dev-gateway.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { productTargets } from './dev-gateway-targets.mjs';

const P = { gw: 28088, account: 24100, api: 24000, web: 25173, hub: 25180, tpapi: 25422, tpweb: 25423, ai: 24300 };
const fakes = [];
let gw;

function fake(name, port) {
  const s = http.createServer((req, res) => res.end(`${name} ${req.url} xff=${req.headers['x-forwarded-for']}`));
  // WebSocket yükseltmesini kabul edip bir satır geri yazar
  s.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Fake: ${name}\r\n\r\n`);
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => { fakes.push(s); r(); }));
}
const get = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: P.gw, path }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  }).on('error', reject);
});

before(async () => {
  // Sıra önemli: fakes[3] hub ("yukarı akış kapalıyken" onu kapatır).
  for (const [n, port] of [['account', P.account], ['api', P.api], ['web', P.web], ['hub', P.hub], ['tpapi', P.tpapi], ['tpweb', P.tpweb], ['ai', P.ai]]) await fake(n, port);
  gw = spawn(process.execPath, [new URL('./dev-gateway.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: {
      ...process.env, GATEWAY_PORT: P.gw, ACCOUNT_PORT: P.account, DECISHIP_API_PORT: P.api, DECISHIP_WEB_PORT: P.web, HUB_PORT: P.hub,
      TAGPRESS_API_PORT: P.tpapi, TAGPRESS_WEB_PORT: P.tpweb, AI_API_PORT: P.ai,
    },
    stdio: 'pipe',
  });
  await new Promise((r) => gw.stdout.once('data', r));
});
after(() => { gw.kill(); fakes.forEach((s) => s.close()); });

for (const [path, who] of [
  ['/home', 'hub'], ['/login', 'hub'], ['/assets/x.js', 'hub'], ['/orderloom/x', 'hub'],
  ['/deciship/', 'web'], ['/deciship/measurements', 'web'], ['/deciship', 'web'], ['/@vite/client', 'hub'],
  ['/api/account/health', 'account'], ['/api/deciship/health', 'api'],
  // TagPress web aracı (kayıtta deploy.api/web): web /tagpress/ altında, API /api/tagpress/ altında.
  ['/tagpress/', 'tpweb'], ['/tagpress/x', 'tpweb'], ['/tagpress', 'tpweb'], ['/api/tagpress/health', 'tpapi'], ['/api/tagpress/jobs?x=1', 'tpapi'],
  // Yapay zekâ geçidi: Merkez uçları /api/ai/ altında (araç yolları /api/ai/internal/* aşağıda 404).
  ['/api/ai/health', 'ai'], ['/api/ai/spend/summary?days=30', 'ai'], ['/api/ai/admin/keys', 'ai'],
]) test(`${path} -> ${who}`, async () => {
  const r = await get(path);
  assert.equal(r.status, 200);
  assert.ok(r.body.startsWith(`${who} ${path}`), r.body);
  assert.ok(r.body.includes('xff=127.0.0.1') || r.body.includes('xff=::1') || r.body.includes('xff=::ffff:127.0.0.1'), r.body);
});

test('/ -> /home', async () => {
  const r = await get('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/home');
});

for (const p of ['/api/deciship/internal/events', '/api/tagpress/internal/events', '/tagpress/internal/x', '/api/account/internal/x', '/INTERNAL/x', '/api/deciship/%69nternal/events', '/api//deciship/internal/x', '/deciship/internal/x', '/api/deciship/internal%2Fevents', '/api/unknown', '/api/orderloom/x', '/api/ai/internal/events', '/api/ai/internal/anthropic/v1/messages', '/api/ai/%69nternal/status', '/api/aix'])
  test(`404 ${p}`, async () => assert.equal((await get(p)).status, 404));

for (const [path, who] of [['/', 'hub'], ['/deciship/', 'web']]) test(`WebSocket ${path} -> ${who}`, async () => {
  const sock = net.connect(P.gw, '127.0.0.1');
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const data = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
  sock.destroy();
  assert.match(data, /101 Switching Protocols/);
  assert.match(data, new RegExp(`x-fake: ${who}`, 'i'));
});

test('WebSocket internal engellenir', async () => {
  const sock = net.connect(P.gw, '127.0.0.1');
  sock.write('GET /api/deciship/internal/x HTTP/1.1\r\nHost: l\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n');
  const data = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
  sock.destroy();
  assert.match(data, /404/);
});

test('yukarı akış kapalıyken 503', async () => {
  fakes[3].close(); // hub
  await new Promise((r) => setTimeout(r, 50));
  const r = await get('/home');
  assert.equal(r.status, 503);
});

test('deploy.dev yoksa açılışta uyarı, yönlendirme yok; ortam değişkeni kurtarır', () => {
  const reg = [{ key: 'ornekarac', deploy: { api: { service: 'a', port: 1 }, web: { service: 'w', port: 80, dev: 5999 } } }];
  const warns = [];
  assert.deepEqual(productTargets(reg, {}, (m) => warns.push(m)), { ornekarac: { api: undefined, web: 5999 } });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /ornekarac API.*deploy.api.dev yok.*ORNEKARAC_API_PORT/);
  const w2 = [];
  assert.equal(productTargets(reg, { ORNEKARAC_API_PORT: '4777' }, (m) => w2.push(m)).ornekarac.api, 4777);
  assert.equal(w2.length, 0);
  assert.deepEqual(productTargets([{ key: 'x', deploy: { api: { service: 'a', port: 1 } } }], {}, () => {}), {});
});
