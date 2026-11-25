// Yalnız VITE_MOCK=1. Sahte API'yi tarayıcıda başlatır (işleyiciler `handlers.ts`). main.tsx yalnız geliştirme modunda ve dinamik içe aktarır.
import { setupWorker } from 'msw/browser';
import { isProductKey } from '@sellerondata/contracts';
import { accountHandlers, productHandlers } from './handlers.ts';
import { groupRecordings, usesRecordings, type Recorded, type Recordings } from './hub.ts';

/** Araçların gerçek yanıt kayıtları (`e2e/fixtures/<anahtar>-real/*.json`); yalnız örnek üreticisi olmayan araçlarınki yüklenir. */
const RECORDING_FILES = import.meta.glob<Recorded>('../../e2e/fixtures/*-real/*.json', { import: 'default' });

async function loadRecordings(): Promise<Partial<Record<string, Recordings>>> {
  const wanted = Object.entries(RECORDING_FILES).filter(([file]) => {
    const key = /\/([a-z][a-z0-9]*)-real\//.exec(file)?.[1];
    return isProductKey(key) && usesRecordings(key);
  });
  return groupRecordings(Object.fromEntries(await Promise.all(wanted.map(async ([file, load]) => [file, await load()] as const))));
}

export async function startMocks() {
  const recordings = await loadRecordings();
  const worker = setupWorker(...accountHandlers, ...productHandlers((key) => recordings[key]));
  await worker.start({ quiet: true });
}
