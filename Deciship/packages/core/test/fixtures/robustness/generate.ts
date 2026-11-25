/** Fikstürleri diske yazar: `npx tsx test/fixtures/robustness/generate.ts [hedef-klasör] [--big]` (packages/core içinde). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bigCsv, bigXlsx, FIXTURE_DIR, FIXTURES } from './build';

const args = process.argv.slice(2);
const out = resolve(args.find((a) => !a.startsWith('--')) ?? FIXTURE_DIR);
mkdirSync(out, { recursive: true });
for (const f of FIXTURES) writeFileSync(resolve(out, f.name), await f.bytes());
if (args.includes('--big')) {
  // Büyük dosyalar repoya girmez; testler bunları bellekte üretir.
  writeFileSync(resolve(out, 'big-5000-fedex.csv'), bigCsv(5000, { prefixFedex11735: true }));
  writeFileSync(resolve(out, 'big-20000-fedex.csv'), bigCsv(20000));
  writeFileSync(resolve(out, 'big-20000-ups.xlsx'), await bigXlsx(20000));
}
console.log(`${FIXTURES.length} fikstür → ${out}`);
