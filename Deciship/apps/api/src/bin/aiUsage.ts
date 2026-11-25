import { runAiUsageCli } from '../cli/aiUsage.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run ai:usage / ai:grant, imajda node dist/aiUsage.js. Gövde cli/aiUsage.ts. */
runCli(runAiUsageCli);
