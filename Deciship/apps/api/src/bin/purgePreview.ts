import { runPurgePreviewCli } from '../cli/purgePreview.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run purge:preview, imajda node dist/cli/purgePreview.js. Gövde cli/purgePreview.ts. */
runCli(runPurgePreviewCli);
