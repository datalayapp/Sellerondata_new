/**
 * İş çalıştırıcı girişi (KALANLAR 6.17): `node dist/worker.js`. Aynı imajdan, HTTP dinlemeden yalnız arka plan işlerini
 * çalıştırır: iş kuyruğu (PDF fatura ve tarife okuma, toplu yeniden hesap), ölçüm karşılaştırma taraması ve saatlik bakım
 * (`services/background.ts`, HTTP girişiyle aynı başlatıcı). HTTP kopyaları bu durumda `JOB_RUNNER=off` ile açılır.
 * Dosyalar yerel diskte (`STORAGE_DIR`): iki kap aynı hacmi bağlar. Örnek compose parçası `Platform/docs/mimari/07-guvenlik.md`.
 *
 * - Bu süreç her zaman iş alır: ortak ortam dosyasındaki `JOB_RUNNER=off` burada yok sayılır (`inline` üretimde zaten açılmaz).
 * - Sağlık: veritabanına kısa bir sorgu başarılı olunca `WORKER_HEALTH_FILE` (varsayılan `<tmp>/deciship-worker.alive`)
 *   `HEALTH_INTERVAL_MS`'de bir yenilenir. Docker sağlık denetimi dosyanın yaşına bakar (60 sn'den eskiyse sağlıksız).
 *   Bu zamanlayıcı süreci açık tutan tek şeydir (döngünün zamanlayıcıları `unref`).
 * - Kapanış (SIGTERM, SIGINT; testlerde IPC `shutdown` iletisi, Windows'ta sinyal süreci doğrudan öldürür): yeni iş alınmaz,
 *   süren işler `JOB_SHUTDOWN_GRACE_MS` bekler, bitmeyenlerin kirası bırakılır; sonra dosya çalışanları ve veritabanı
 *   bağlantısı kapanır, sağlık dosyası silinir, süreç 0 ile çıkar. Compose `stop_grace_period` bundan en az 15 sn uzun olmalı.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disconnectPrisma, prisma } from './db.ts';
import { env } from './env.ts';
import { closeFileWorkers } from './lib/fileWorkers.ts';
import { startBackground } from './services/background.ts';
import { checkStartup } from './startup.ts';

/** Sağlık dosyasının yenilenme aralığı. Denetim eşiği (60 sn) bunun birkaç katı: tek kaçan tur sağlıksız saydırmaz. */
const HEALTH_INTERVAL_MS = 15_000;

// ---------- günlük: Fastify (pino) satırlarıyla aynı biçim, tek satır JSON ----------

const errFields = (v: unknown) =>
  v instanceof Error ? { type: v.name, message: v.message, stack: v.stack, ...('code' in v ? { code: (v as { code?: unknown }).code } : {}) } : v;

function line(level: number, o: unknown, msg: string): void {
  const fields = o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, errFields(v)])) : {};
  const out = JSON.stringify({ level, time: Date.now(), pid: process.pid, hostname: os.hostname(), name: 'deciship-worker', ...fields, msg });
  (level >= 40 ? process.stderr : process.stdout).write(`${out}\n`);
}

const log = {
  info: (o: unknown, msg: string) => line(30, o, msg),
  warn: (o: unknown, msg: string) => line(40, o, msg),
  error: (o: unknown, msg: string) => line(50, o, msg),
};

// ---------- açılış ----------

await checkStartup();

if (env.jobRunner !== 'on') log.info({ jobRunner: process.env.JOB_RUNNER }, 'JOB_RUNNER ignored in the worker: this process always runs jobs');
// `kickJob` (işleyicinin eklediği iş) döngüyü uyandırsın, ölçüm sırası arka plan yolunu kullansın.
process.env.JOB_RUNNER = 'on';

const healthFile = process.env.WORKER_HEALTH_FILE?.trim() || path.join(os.tmpdir(), 'deciship-worker.alive');
let healthy = false;
const beat = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    fs.writeFileSync(healthFile, `${new Date().toISOString()}\n`);
    if (!healthy) log.info({ healthFile }, 'worker healthy');
    healthy = true;
  } catch (err) {
    if (healthy) log.warn({ err }, 'worker health check failed (database unreachable?)');
    healthy = false;
  }
};

const background = startBackground(log, { jobs: true, maintenance: true });
log.info({ slots: { ai: env.jobSlotsAi, recalc: env.jobSlotsRecalc }, pollMs: env.jobPollMs }, 'worker started');
void beat();
const healthTimer = setInterval(() => void beat(), HEALTH_INTERVAL_MS);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'worker stopping');
  clearInterval(healthTimer);
  fs.rmSync(healthFile, { force: true });
  // Kapanış sırasında sinyal tekrar gelirse beklemeden çık (ikinci Ctrl+C).
  const force = () => process.exit(1);
  process.once('SIGINT', force);
  process.once('SIGTERM', force);
  await background.stop();
  await closeFileWorkers().catch((err: unknown) => log.warn({ err }, 'file workers did not close cleanly'));
  await disconnectPrisma().catch(() => undefined);
  log.info({}, 'worker stopped');
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// Windows'ta sinyal süreci doğrudan öldürür: testler kapanışı IPC iletisiyle ister (yalnız IPC kanalı varsa).
if (process.send) {
  process.on('message', (m) => {
    if (m === 'shutdown') void shutdown('ipc');
  });
}
