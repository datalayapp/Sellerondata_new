/**
 * Arka plan işlerinin tek başlatıcısı (KALANLAR 6.17). HTTP girişi (`main.ts`) ve iş çalıştırıcı girişi (`worker.ts`) yalnız
 * bunu çağırır; hangi sürecin ne çalıştıracağı burada değil, girişte seçilir.
 *
 * - `jobs`: iş kuyruğu döngüsü (`startJobRunner`: PDF ve tarife okuma, toplu yeniden hesap) ve yarıda kalmış ölçüm
 *   karşılaştırmalarının sık taraması (`startMeasurementSweep`).
 * - `maintenance`: saatlik bakım (`startMaintenance`: süresi dolan kayıtlar, dosya temizliği, silinenlerin kalıcı temizliği,
 *   eski işler, itiraz hatırlatması, yarım firma silmeleri).
 *
 * Kapanış (`stop`): yeni iş ve yeni bakım turu başlamaz; süren işler, ölçüm karşılaştırma sırası ve süren bakım turu en çok
 * `graceMs` (`JOB_SHUTDOWN_GRACE_MS`) beklenir. Bitmeyen işin kirası bırakılır (deneme geri sayılır, başka kopya hemen alır);
 * bitmeyen karşılaştırmanın işareti kalır, tarama tamamlar; yarım bakım turu bir sonraki turda sürer (her adımı tek başına
 * güvenlidir). Ölçüm sırası `jobs` kapalıyken de boşaltılır: HTTP süreci ölçüm kaydından sonra karşılaştırmayı kendisi sıraya
 * koyar (`measurementQueue.ts`), bu sıra iş tablosuna girmez.
 */
import { env } from '../env.ts';
import { startJobRunner, type JobLog } from './jobs/runner.ts';
import { startMaintenance } from './maintenance.ts';
import { drainMeasurementQueue, startMeasurementSweep } from './measurementQueue.ts';

export type BackgroundOptions = { jobs: boolean; maintenance: boolean };
export type Background = { stop(): Promise<void> };

const within = async (work: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
};

export function startBackground(log: JobLog, o: BackgroundOptions): Background {
  const stopMaintenance = o.maintenance ? startMaintenance(log) : null;
  const runner = o.jobs ? startJobRunner(log) : null;
  const stopSweep = o.jobs ? startMeasurementSweep(log) : null;
  let stopping: Promise<void> | null = null;

  return {
    stop() {
      stopping ??= (async () => {
        const graceMs = env.jobShutdownGraceMs;
        stopSweep?.();
        const maintenance = stopMaintenance?.().catch((err: unknown) => log.warn({ err }, 'maintenance did not stop cleanly'));
        await Promise.all([
          runner?.stop().catch((err: unknown) => log.warn({ err }, 'job runner did not stop cleanly')),
          drainMeasurementQueue(graceMs).catch((err: unknown) => log.warn({ err }, 'measurement recompare queue did not drain cleanly')),
          maintenance ? within(maintenance, graceMs) : undefined,
        ]);
      })();
      return stopping;
    },
  };
}
