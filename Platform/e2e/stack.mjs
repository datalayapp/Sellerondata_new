// Uçtan uca test yığını. Kendi proje adı, hacmi ve portları vardır (e2e/.env.e2e); canlı `sellerondata` projesine dokunmaz.
//   node stack.mjs up       BASLAT.bat akışını çalıştırır, satırları zaman damgasıyla .stack/baslat.log dosyasına yazar
//   node stack.mjs reset    yalnız sod-e2e: SIFIRLA.bat akışı (hacimleri siler)
//   node stack.mjs stop     yalnız sod-e2e: DURDUR.bat akışı
//   node stack.mjs ps
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SOD_E2E_ROOT: kaydedilmiş sürümün kopyası (snapshot.mjs). Yoksa bu depo.
export const PLATFORM = process.env.SOD_E2E_ROOT ? path.resolve(process.env.SOD_E2E_ROOT) : path.resolve(HERE, '..');
export const PROJECT = 'sod-e2e';

export function stackEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(HERE, '.env.e2e'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  if (out.SOD_PROJECT !== PROJECT || !out.SOD_PGDATA_VOLUME?.startsWith('sod_e2e_') || !out.SOD_STORAGE_VOLUME?.startsWith('sod_e2e_')) {
    throw new Error('e2e/.env.e2e kendi proje adını ve hacimlerini vermiyor: canlı veriye dokunabilirdi, durduruldu.');
  }
  return out;
}

const env = () => ({ ...process.env, ...stackEnv() });

export function compose(...args) {
  const r = spawnSync('docker', ['compose', '-p', PROJECT, ...args], { cwd: PLATFORM, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} başarısız: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Bat dosyasını gerçek kullanıcı gibi çalıştırır. `-Yes` yalnız soruları atlar, `-NoBrowser` tarayıcı açmaz. */
export function runBat(bat, { log } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = log ? fs.createWriteStream(log) : null;
    const child = spawn('cmd.exe', ['/c', path.join(PLATFORM, bat), '-Yes', '-NoBrowser'], { cwd: PLATFORM, env: env(), windowsHide: true });
    const emit = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const stamped = `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${line}`;
        out?.write(stamped + '\n');
        console.log(stamped);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('close', (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      out?.end(`çıkış ${code}, toplam ${seconds} sn\n`);
      resolve({ code, seconds });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  fs.mkdirSync(path.join(HERE, '.stack'), { recursive: true });
  if (cmd === 'up') {
    const { code } = await runBat('BASLAT.bat', { log: path.join(HERE, '.stack', 'baslat.log') });
    process.exit(code ?? 1);
  } else if (cmd === 'reset') {
    process.exit((await runBat('SIFIRLA.bat')).code ?? 1);
  } else if (cmd === 'stop') {
    process.exit((await runBat('DURDUR.bat')).code ?? 1);
  } else if (cmd === 'ps') {
    console.log(compose('ps', '--format', 'table {{.Name}}\t{{.Status}}'));
  } else {
    console.error('Kullanım: node stack.mjs up|reset|stop|ps');
    process.exit(2);
  }
}
