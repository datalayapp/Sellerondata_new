/**
 * İtiraz süresi hatırlatmasını bir kez çalıştırır (Mesaj 14 §4.4). Saatlik bakım işi aynısını kendisi yapar; bu komut deneme ve
 * destek içindir.
 *
 *   npm run reminders:once -- [--send] [--now] [--company <id>]
 *   Üretim kabında: node dist/cli/reminders.js [--send] [--now] [--company <id>]
 *
 * Varsayılan KURU çalışmadır: hiçbir şey gönderilmez, her firma için gönderilecek özet tek satırda yazılır (adres boşken de
 * çalışır). Gerçek gönderim yalnız açık `--send` ile. `--dry` kuru çalışmayı açıkça ister; `--send` ile birlikte verilemez.
 * `--now`: firmanın 09:00–19:00 penceresini yok sayar. `--company`: yalnız o firma. Çıktı ASCII İngilizce
 * (test/i18n.test.ts kaynakta Türkçe harf arar); anahtar ve posta içeriği yazılmaz.
 */
import { missingProductionEnv } from '../env.ts';
import { runDisputeReminders, type ReminderPlan, type ReminderResult } from '../services/reminders.ts';

export type CliOut = { log: (line: string) => void; error: (line: string) => void };

const HELP = ['Usage:', '  reminders:once -- [--send] [--now] [--company <id>]', '  Without --send nothing is sent: the run only prints what would be sent.'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReminderArgs = { now: boolean; send: boolean; companyId?: string };

/** Bilinmeyen bayrak ya da eksik değer hatadır; gönderim yalnız `--send` ile (yanlış yazılmış bayrak gönderime dönmez). */
export function parseReminderArgs(argv: string[]): ReminderArgs {
  const out: ReminderArgs = { now: false, send: false };
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--now') out.now = true;
    else if (a === '--send') out.send = true;
    else if (a === '--dry') dry = true;
    else if (a === '--company') {
      const v = argv[++i]?.trim();
      if (!v || !UUID.test(v)) throw new Error('--company needs a company id (uuid)');
      out.companyId = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (dry && out.send) throw new Error('--dry and --send cannot be used together');
  return out;
}

export function formatReminderResult(r: ReminderResult, dry: boolean): string {
  if (r.disabled) return 'Reminders are off: ACCOUNT_NOTIFY_URL is empty (run without --send to see what would be sent).';
  const parts = [`companies=${r.companies}`, `checked=${r.checked}`, dry ? `planned=${r.planned}` : `sent=${r.sent}`, `duplicate=${r.duplicate}`, `skipped=${r.skipped}`, `failed=${r.failed}`];
  if (r.capped) parts.push('capped=yes');
  return `${dry ? 'Dry run (nothing sent; add --send to send)' : 'Done'}: ${parts.join(' ')}`;
}

/** Kuru çalışmanın satırı: firma, anahtar, fatura sayısı, en yakın son güne kalan gün. Posta metni ve fatura no yazılmaz. */
export function formatReminderPlan(p: ReminderPlan): string {
  return `Would send: company=${p.companyId} key=${p.dedupeKey} invoices=${p.invoices} nearestDaysLeft=${p.nearestDaysLeft}`;
}

const stderrLog = {
  warn: (obj: unknown, msg: string) => console.error(`warn: ${msg} ${JSON.stringify(obj)}`),
  error: (obj: unknown, msg: string) => console.error(`error: ${msg} ${JSON.stringify(obj)}`),
};

export async function runRemindersCli(argv: string[], out: CliOut = { log: (l) => console.log(l), error: (l) => console.error(l) }): Promise<number> {
  let args: ReminderArgs;
  try {
    args = parseReminderArgs(argv);
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    for (const l of HELP) out.error(l);
    return 2;
  }
  const missing = missingProductionEnv();
  if (missing.length) {
    out.error(`Error: missing production settings: ${missing.join(', ')}`);
    return 1;
  }
  const dry = !args.send;
  try {
    const r = await runDisputeReminders(new Date(), {
      ignoreQuietHours: args.now,
      dryRun: dry,
      companyId: args.companyId,
      log: stderrLog,
      onPlan: (p) => out.log(formatReminderPlan(p)),
    });
    out.log(formatReminderResult(r, dry));
    if (dry) return r.failed > 0 ? 1 : 0;
    return r.disabled || (r.failed > 0 && r.sent + r.duplicate === 0) ? 1 : 0;
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
