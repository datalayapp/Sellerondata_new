/**
 * Büyük fatura dosyaları (5.000 ve 20.000 satır): okuma, eşleme + ayrıştırma ve okuma kontrolü süreleriyle. Doğruluk
 * `invoice-robustness.test.ts`'te (kapı), süre sınırı `invoice-robustness.perf.test.ts`'te (`npm run test:perf`, kapı değil).
 */
import { mappingDiagnostics, parseRows, readTable, suggestMapping } from '../src/index';

export async function measureBigFile(name: string, bytes: Uint8Array) {
  const t0 = performance.now();
  const t = await readTable(name, bytes);
  const t1 = performance.now();
  const s = suggestMapping(t.headers, 'generic', t.rows);
  const p = parseRows(t, s.mapping);
  const t2 = performance.now();
  const d = mappingDiagnostics(t, s.mapping, { divisor: 5000 });
  const t3 = performance.now();
  const ms = { read: Math.round(t1 - t0), parse: Math.round(t2 - t1), verify: Math.round(t3 - t2) };
  console.log(`[süre] ${name}: oku ${ms.read} ms, eşle+ayrıştır ${ms.parse} ms, okuma kontrolü ${ms.verify} ms, satır ${p.lines.length}`);
  return { t, p, d, ms };
}
