import { runOrphansCli } from '../cli/storageOrphans.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run storage:orphans, imajda node dist/cli/storageOrphans.js. Gövde cli/storageOrphans.ts. */
runCli(runOrphansCli);
