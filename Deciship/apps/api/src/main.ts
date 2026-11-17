import { env } from './env.ts';
import { buildApp } from './app.ts';
import { disconnectPrisma } from './db.ts';
import { startBackground } from './services/background.ts';
import { checkStartup } from './startup.ts';

await checkStartup();

const app = await buildApp({ logger: true });

// Arka plan işleri (Mesaj 7, KALANLAR 6.17), tek başlatıcı `services/background.ts`:
//  - `JOB_RUNNER=on` (varsayılan): bu süreç HTTP'nin yanında iş kuyruğunu, ölçüm taramasını ve saatlik bakımı çalıştırır.
//  - `off`: hiçbirini çalıştırmaz; işi ayrı iş çalıştırıcı kabı (`node dist/worker.js`) alır. Yalnız kuyruğa yazar.
//  - `inline` yalnız testler içindir (işi başlatan istek çalıştırır); bakım açık kalır.
const background = startBackground(app.log, { jobs: env.jobRunner === 'on', maintenance: env.jobRunner !== 'off' });
if (env.jobRunner === 'inline') app.log.warn('JOB_RUNNER=inline: jobs run inside the starting request (tests only)');
if (env.jobRunner === 'off') app.log.info('JOB_RUNNER=off: background jobs and maintenance run in the worker container (dist/worker.js)');
// Silinenlerin kalıcı temizliği varsayılan kapalı (karar 2026-11-12: canlıda purge:preview ile bakıp 30 gün açılır).
if (env.jobRunner !== 'off' && (env.deletedInvoicePurgeDays === null || env.deletedMeasurementPhotoPurgeDays === null)) {
  app.log.warn('DELETED_INVOICE_PURGE_DAYS / DELETED_MEASUREMENT_PHOTO_PURGE_DAYS off: deleted invoices and deleted measurement photos are kept (set 30 to purge; check npm run purge:preview first)');
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  // Önce arka plan: yeni iş alınmaz, süren işler JOB_SHUTDOWN_GRACE_MS bekler, bitmeyenlerin kirası bırakılır. Aynı sürede
  // ölçüm karşılaştırma sırası boşaltılır; bitmeyenin işareti kalır, tarama ya da bakım tamamlar (Mesaj 7, §4.10).
  await background.stop();
  await app.close();
  await disconnectPrisma();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: env.port, host: env.host });
  if (!env.anthropicKey) app.log.warn('ANTHROPIC_API_KEY boş: PDF fatura ve tartı okuma kapalı (503 AI_DISABLED)');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
