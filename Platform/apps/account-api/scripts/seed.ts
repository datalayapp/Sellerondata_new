import { runSeedCommand } from '../src/seed.ts';

/**
 * Geliştirme tohumunun çalıştırma girişi. Geliştirmede: npm run seed. İmajda: node dist/seed.js
 * Gövde `src/seed.ts`te. Bu dosyayı hiçbir modül içe aktarmaz: tsup gövdeyi her zaman bu girişte bırakır (test/cli-entries.test.mjs).
 */
process.exitCode = await runSeedCommand();
