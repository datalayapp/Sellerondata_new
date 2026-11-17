// node --test scripts/lib/pg-guard.test.mjs  (Postgres ve Docker istemez)
// Gerçek kullanımda (Platform/.env SOD_GERCEK_KULLANIM) testler gerçek verinin Postgres'ine bağlanmaz: kök koşucuların
// yoklaması (scripts/lib/pg.mjs) ve paket testlerinin adresi (scripts/lib/pg-guard.mjs resolveTestDbHost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockedReason, envFileValue, realUseGuard, resolveTestDbHost } from './pg-guard.mjs';
import { candidatePorts, findPg } from './pg.mjs';

const REAL = realUseGuard({ env: {}, envText: 'SOD_GERCEK_KULLANIM=2026-11-17\n' });
const DEMO = realUseGuard({ env: {}, envText: '# SOD_GERCEK_KULLANIM=2026-11-17\nSOD_GERCEK_KULLANIM=\n' });
const ALLOWED = realUseGuard({ env: { TEST_ALLOW_REAL_PG: '1' }, envText: 'SOD_GERCEK_KULLANIM=2026-11-17\n' });

test('.env değeri: son tekrar, tırnak, yorum; satır yoksa null', () => {
  assert.equal(envFileValue('A=1\nA=2\n', 'A'), '2');
  assert.equal(envFileValue('A="x # y"\r\nB=z # yorum\r\n', 'A'), 'x # y');
  assert.equal(envFileValue('B=z # yorum\n', 'B'), 'z');
  assert.equal(envFileValue('# A=1\nAB=2\n', 'A'), null);
});

test('işaret ve gerçek port Platform/.env dosyasından okunur; dosya yoksa işaret yok', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pg-guard-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'SOD_POSTGRES_PORT=15434\r\nSOD_GERCEK_KULLANIM=2026-11-17\r\n');
    assert.deepEqual(realUseGuard({ env: {}, envFile: file }), { mark: '2026-11-17', realPort: 15434, allow: false });
    assert.deepEqual(realUseGuard({ env: {}, envFile: path.join(dir, 'yok.env') }), { mark: null, realPort: 5434, allow: false });
    // Ortamdaki işaret sayılmaz: koruma yalnız dosyadan açılır ve kapanır.
    assert.equal(realUseGuard({ env: { SOD_GERCEK_KULLANIM: 'x' }, envFile: path.join(dir, 'yok.env') }).mark, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(DEMO, { mark: null, realPort: 5434, allow: false });
});

test('engel yalnız işaret varken, gerçek portta ve yerel adreste', () => {
  for (const h of ['localhost', '127.0.0.1', '::1']) assert.match(blockedReason(h, 5434, REAL), /npm run pg:baslat/);
  assert.equal(blockedReason('localhost', 5435, REAL), null);
  assert.equal(blockedReason('db.ornek', 5434, REAL), null);
  assert.equal(blockedReason('localhost', 5434, DEMO), null);
  assert.equal(blockedReason('localhost', 5434, ALLOWED), null);
});

test('paket testlerinin adresi: işaret varken varsayılan 5435, 5434 reddedilir', () => {
  assert.equal(resolveTestDbHost({}, DEMO), 'localhost:5434');
  assert.equal(resolveTestDbHost({}, REAL), 'localhost:5435');
  assert.equal(resolveTestDbHost({ TEST_DB_HOST: 'localhost:5435' }, REAL), 'localhost:5435');
  assert.equal(resolveTestDbHost({ TEST_DB_HOST: 'localhost:5434' }, DEMO), 'localhost:5434');
  assert.throws(() => resolveTestDbHost({ TEST_DB_HOST: 'localhost:5434' }, REAL), /gerçek kullanımda.*npm run pg:baslat/s);
  assert.throws(() => resolveTestDbHost({ TEST_DB_HOST: '127.0.0.1:5434' }, REAL), /SOD_GERCEK_KULLANIM=2026-11-17/);
  assert.throws(
    () => resolveTestDbHost({ TEST_DB_HOST: 'localhost:5435', TEST_SUPER_URL: 'postgresql://postgres:x@localhost:5434/postgres' }, REAL),
    /gerçek verinin Postgres/,
  );
  assert.equal(resolveTestDbHost({ TEST_DB_HOST: 'localhost:5434' }, ALLOWED), 'localhost:5434');
});

test('kök koşucu: gerçek port yoklanmaz, elle verilen adres bağlanmadan reddedilir', async () => {
  assert.deepEqual(candidatePorts(DEMO).map(([p]) => p), [5434, 5435]);
  assert.deepEqual(candidatePorts(REAL).map(([p]) => p), [5435]);
  const err = console.error;
  const said = [];
  console.error = (m) => said.push(String(m));
  try {
    const a = await findPg({ TEST_DB_HOST: 'localhost:5434' }, REAL);
    assert.equal(a.ok, false);
    assert.equal(a.blocked, true);
    const b = await findPg({ SOD_PG_PORT: '5434' }, REAL);
    assert.equal(b.blocked, true);
  } finally {
    console.error = err;
  }
  assert.equal(said.length, 2);
  assert.match(said[0], /npm run pg:baslat/);
});
