import { seed } from '../dev-seed.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run seed -- [--reset] [--samples], imajda node dist/seed.js. Gövde dev-seed.ts. */
runCli(async (argv) => {
  await seed({ reset: argv.includes('--reset'), samples: argv.includes('--samples') });
  return 0;
});
