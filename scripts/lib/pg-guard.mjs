// Gerçek veri koruması (KALANLAR 2.1): bu bilgisayar gerçek kullanıma geçtiyse (Platform/.env SOD_GERCEK_KULLANIM dolu,
// Platform/scripts/gercek-kullanim.ps1 yazar) Docker yığınının Postgres'inde (SOD_POSTGRES_PORT, varsayılan 5434) gerçek veri
// vardır: testler ona bağlanmaz. Kök koşucular (scripts/lib/pg.mjs) o portu yoklamaz; paket içinden koşulan veritabanı testleri
// (DeciShip API ve Hesap servisi test/testEnv.ts, auth-kit ve product-kit .db testleri) adresi buradan alır.
// İşaret varken: TEST_DB_HOST verilmezse localhost:5435 (npm run pg:baslat); gerçek porta işaret eden TEST_DB_HOST ya da
// TEST_SUPER_URL hata verir. Kaçış (önerilmez): TEST_ALLOW_REAL_PG=1. Docker ve ağ istemez; dosyayı eşzamanlı okur.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REAL_USE_MARK = 'SOD_GERCEK_KULLANIM';
export const ALLOW_FLAG = 'TEST_ALLOW_REAL_PG';
export const DEFAULT_REAL_PORT = 5434;
export const SAFE_PORT = 5435;
export const PLATFORM_ENV_FILE = fileURLToPath(new URL('../../Platform/.env', import.meta.url));

/** .env metninde değer: satır yoksa null, tekrarlarda sonuncusu; tırnak soyulur, tırnaksızda " #" sonrası yorum. */
export function envFileValue(text, name) {
  let value = null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${esc}\\s*=(.*)$`);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    else if (v.includes(' #')) v = v.slice(0, v.indexOf(' #')).trimEnd();
    value = v;
  }
  return value;
}

/**
 * Koruma durumu: { mark (işaret değeri ya da null), realPort, allow }. `envText` verilirse dosya okunmaz (test için).
 * İşaret ve port yalnız Platform/.env'den okunur (işlem ortamından değil): koruma kabukta unutulan bir değişkenle kalkmasın.
 */
export function realUseGuard({ env = process.env, envFile = PLATFORM_ENV_FILE, envText } = {}) {
  let text = envText;
  if (text === undefined) {
    try {
      text = readFileSync(envFile, 'utf8');
    } catch {
      text = '';
    }
  }
  const mark = envFileValue(text, REAL_USE_MARK)?.trim() || null;
  const portText = envFileValue(text, 'SOD_POSTGRES_PORT')?.trim();
  const realPort = /^\d{1,5}$/.test(portText ?? '') ? Number(portText) : DEFAULT_REAL_PORT;
  return { mark, realPort, allow: env[ALLOW_FLAG] === '1' };
}

// "localhost:5435" | "127.0.0.1" | "[::1]:5435" -> { host, port }
export function parseHost(v) {
  const m = String(v).trim().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2] ?? 5432) };
}

/** postgresql://kullanıcı:parola@host:port/db -> { host, port }; okunamazsa null. */
export function hostOfUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 5432) };
  } catch {
    return null;
  }
}

export function isLocalHost(host) {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/** Adres gerçek verinin Postgres'i mi: engelse açıklama, değilse null. */
export function blockedReason(host, port, guard) {
  if (!guard?.mark || guard.allow) return null;
  if (Number(port) !== guard.realPort || !isLocalHost(host)) return null;
  return (
    `Bu bilgisayar gerçek kullanımda (Platform/.env ${REAL_USE_MARK}=${guard.mark}): ${host}:${port} gerçek verinin Postgres'i, ` +
    `testler ona bağlanmaz. Test Postgres'i: npm run pg:baslat (localhost:${SAFE_PORT}), gerekiyorsa TEST_DB_HOST=localhost:${SAFE_PORT}. ` +
    `Kaçış (önerilmez): ${ALLOW_FLAG}=1.`
  );
}

/**
 * Paket testlerinin Postgres adresi (testEnv.ts ve .db testleri). TEST_DB_HOST > işaret varken localhost:5435 > localhost:5434.
 * Gerçek porta işaret eden TEST_DB_HOST ya da TEST_SUPER_URL hata atar: test hiç bağlanmadan durur.
 */
export function resolveTestDbHost(env = process.env, guard = realUseGuard({ env })) {
  const host = env.TEST_DB_HOST || (guard.mark && !guard.allow ? `localhost:${SAFE_PORT}` : `localhost:${DEFAULT_REAL_PORT}`);
  const targets = [parseHost(host)];
  if (env.TEST_SUPER_URL) targets.push(hostOfUrl(env.TEST_SUPER_URL));
  for (const t of targets) {
    const reason = t && blockedReason(t.host, t.port, guard);
    if (reason) throw new Error(reason);
  }
  return host;
}
