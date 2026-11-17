import { runRemindersCli } from '../cli/reminders.ts';
import { runCli } from './runCli.ts';

/** Çalıştırma girişi: npm run reminders:once, imajda node dist/cli/reminders.js. Gövde cli/reminders.ts. */
runCli(runRemindersCli);
