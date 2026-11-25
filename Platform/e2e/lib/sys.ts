// Gerçek sisteme erişim: adresler, veri yolu, compose işlemleri. Yalnız `sod-e2e` projesine dokunur.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const PLATFORM = process.env.SOD_E2E_ROOT ? path.resolve(process.env.SOD_E2E_ROOT) : path.resolve(E2E_DIR, '..');
export const SAMPLES = path.resolve(PLATFORM, '..', 'Deciship', 'samples');
export const SHOTS = path.join(E2E_DIR, 'screenshots');
export const METRICS = path.join(E2E_DIR, '.stack', 'metrics.json');

const PROJECT = 'sod-e2e';

export function stackEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(E2E_DIR, '.env.e2e'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  if (out.SOD_PROJECT !== PROJECT || !out.SOD_PGDATA_VOLUME?.startsWith('sod_e2e_') || !out.SOD_STORAGE_VOLUME?.startsWith('sod_e2e_') || !out.SOD_TAGPRESS_STORAGE_VOLUME?.startsWith('sod_e2e_')) throw new Error('e2e/.env.e2e kendi hacmini vermiyor');
  return out;
}

const ENV = stackEnv();
export const APP = ENV.APP_BASE_URL!;
export const SITE = ENV.SITE_BASE_URL!;

export function compose(...args: string[]): string {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, ...args], { cwd: PLATFORM, env: { ...process.env, ...ENV }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Süper kullanıcıyla sorgu. Yalnız test kurulumu ve gözlem içindir: ör. hız sınırı kovalarını boşaltmak. */
export function sql(query: string): string {
  return compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'sellerondata', '-Atc', query).trim();
}

/**
 * Hız sınırı IP başına: tüm testler aynı makineden gelir, kayıt saatte 5'te kesilirdi. Sınırı kapatmıyoruz, sayacını testler arasında boşaltıyoruz.
 * Tablo `platform."RateBucket"`.
 */
export function clearRateLimits() {
  sql('DELETE FROM platform."RateBucket"');
}

export function stopService(name: string) {
  compose('stop', name);
}
export function startService(name: string) {
  compose('start', name);
}

export function recordMetric(name: string, value: number | string) {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(METRICS, 'utf8'));
  } catch {
    /* ilk ölçüm */
  }
  all[name] = value;
  fs.mkdirSync(path.dirname(METRICS), { recursive: true });
  fs.writeFileSync(METRICS, JSON.stringify(all, null, 2));
}

let seq = 0;
export function uniq(prefix: string) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}
/** Benzersiz Türkiye cep numarası (ulusal biçim, kullanıcı böyle yazar). */
export function uniqPhone() {
  seq += 1;
  const tail = (Date.now() % 1_000_0000).toString().padStart(7, '0');
  return `0532${String((Number(tail) + seq * 137) % 10_000_000).padStart(7, '0')}`;
}
