/**
 * 15-B7: makineye göre ölçeklenen süre sınırı. Sabit milisaniye (ör. 100 ms) paylaşılan, yavaş CI makinesinde kodda
 * değişiklik yokken kırılır. Taban, aynı koşuda aynı boyda zararsız işin süresidir; sınır `max(enAz, taban × kat)`.
 * Hızlı makinede sınır yine `enAz` kalır; doğrusal olmayan (patlayan) ya da gerçekten 10 kat yavaşlayan iş tabanın
 * 5 katını yine aşar. Taban ölçülemeyecek kadar küçükse `enAz` geçerlidir.
 */
export function timeBudget(baseMs: number, { factor = 5, minMs = 100 }: { factor?: number; minMs?: number } = {}): number {
  return Math.max(minMs, baseMs * factor);
}

/** Senkron işin sonucu ve süresi (ms). */
export function timeSync<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

/** Asenkron işin sonucu ve süresi (ms). */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}
