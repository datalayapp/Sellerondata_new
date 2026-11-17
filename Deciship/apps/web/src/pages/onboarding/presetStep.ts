/** Kurulum Özeti ve Merkez aynı tanımı okur: `boxPresetsReady` API'den gelir. */
export function presetStepState(ready: boolean, done: boolean, skipped: boolean): 'ok' | 'skipped' | 'todo' {
  if (ready) return 'ok';
  return skipped || done ? 'skipped' : 'todo';
}
