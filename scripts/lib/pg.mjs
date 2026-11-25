// Test Postgres'i nerede (KALANLAR 0.1). Kök koşucular (scripts/test.mjs, t.mjs, test-changed.mjs) ortak kullanır.
// Öncelik: TEST_DB_HOST (ör. localhost:5435) > SOD_PG_PORT > ilk açık olan: 5434 (Docker, Platform\BASLAT.bat),
// 5435 (Docker'sız yerel, npm run pg:baslat). Bulunan adres alt süreçlere TEST_DB_HOST ile geçer: bütün veritabanı
// testleri (DeciShip API, hesap servisi, auth-kit, product-kit) bu değişkeni okur.
// Gerçek kullanımda (Platform/.env SOD_GERCEK_KULLANIM dolu) gerçek verinin portu (SOD_POSTGRES_PORT, 5434) hiç yoklanmaz,
// TEST_DB_HOST ya da SOD_PG_PORT ona işaret ederse reddedilir (scripts/lib/pg-guard.mjs).
import net from 'node:net';
import { blockedReason, parseHost, realUseGuard, SAFE_PORT } from './pg-guard.mjs';

export { parseHost };

export const DOCKER_PORT = 5434;
export const LOCAL_PORT = 5435;
export const PG_HINT = `Docker ${DOCKER_PORT}: Platform\\BASLAT.bat; yerel ${LOCAL_PORT}: npm run pg:baslat`;

export function probe(host, port, ms = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Yoklanacak portlar: gerçek kullanımda gerçek verinin portu çıkarılır. */
export function candidatePorts(guard) {
  const all = [[DOCKER_PORT, 'Docker'], [LOCAL_PORT, 'yerel']];
  return all.filter(([port]) => !blockedReason('localhost', port, guard));
}

function blocked(addr, source, reason) {
  console.error(reason);
  return { ok: false, blocked: true, addr, source, reason };
}

/**
 * Hedef Postgres. Dönen: { ok, host, port, addr, source } (ok=false ise addr denenen adreslerin listesi).
 * `env` verilen ortamdır (varsayılan process.env); değiştirilmez.
 */
export async function findPg(env = process.env, guard = realUseGuard({ env })) {
  if (env.TEST_DB_HOST) {
    const t = parseHost(env.TEST_DB_HOST);
    if (!t) return { ok: false, addr: env.TEST_DB_HOST, source: 'TEST_DB_HOST (okunamadı)' };
    const reason = blockedReason(t.host, t.port, guard);
    if (reason) return blocked(env.TEST_DB_HOST, 'TEST_DB_HOST', reason);
    return { ok: await probe(t.host, t.port), ...t, addr: env.TEST_DB_HOST, source: 'TEST_DB_HOST' };
  }
  if (env.SOD_PG_PORT) {
    const port = Number(env.SOD_PG_PORT);
    const reason = blockedReason('localhost', port, guard);
    if (reason) return blocked(`localhost:${port}`, 'SOD_PG_PORT', reason);
    return { ok: await probe('localhost', port), host: 'localhost', port, addr: `localhost:${port}`, source: 'SOD_PG_PORT' };
  }
  const ports = candidatePorts(guard);
  for (const [port, source] of ports) {
    if (await probe('localhost', port)) return { ok: true, host: 'localhost', port, addr: `localhost:${port}`, source };
  }
  if (ports.length < 2) {
    console.error(
      `Bu bilgisayar gerçek kullanımda (Platform/.env SOD_GERCEK_KULLANIM=${guard.mark}): ${guard.realPort} gerçek verinin Postgres'i, ` +
        `testler ona bağlanmaz. Test Postgres'i kapalı: npm run pg:baslat (localhost:${SAFE_PORT}).`,
    );
  }
  return { ok: false, addr: ports.map(([p]) => `localhost:${p}`).join(', '), source: 'yoklama' };
}

/** Bulunan Postgres'i alt süreçlerin ortamına yazar (TEST_DB_HOST). */
export function pgEnv(found) {
  return found?.ok && found.host ? { TEST_DB_HOST: `${found.host.includes(':') ? `[${found.host}]` : found.host}:${found.port}` } : {};
}
