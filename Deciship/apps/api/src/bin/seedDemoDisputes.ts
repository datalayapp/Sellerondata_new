import { seedDemoDisputes } from '../seedDemoDisputes.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run seed:demo-disputes, imajda node dist/seedDemoDisputes.js (Platform demo betiği). Gövde seedDemoDisputes.ts. */
runCli(async () => {
  await seedDemoDisputes({ waitForCompanyMs: 30_000 });
  return 0;
});
