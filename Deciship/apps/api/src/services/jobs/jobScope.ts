/**
 * Çalışan arka plan işinin kimliği, işleyicinin async bağlamında (`runner.ts` işleyiciyi bunun içinde çalıştırır). Yapay
 * zekâ sayacı (`aiMeter.ts`) bununla "bu iş içinde ücretli sonuçsuz kalmış içerik" kaydını veritabanında arar: süreç içi
 * hatırlama (30 dk) başka kopyada, yeniden başlamadan sonra ya da uzun beklemeli yeniden denemede yoktur. Ayrı dosya:
 * `aiMeter.ts` çalıştırıcıyı içe aktarmasın (döngü).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type JobScope = { jobId: string; createdAt: Date };

const store = new AsyncLocalStorage<JobScope>();

export function runInJobScope<T>(scope: JobScope, work: () => T): T {
  return store.run(scope, work);
}

export function currentJobScope(): JobScope | undefined {
  return store.getStore();
}
