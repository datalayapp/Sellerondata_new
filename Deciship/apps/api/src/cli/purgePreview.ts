/**
 * Silinenlerin kalıcı temizliğinin kuru çalışması (kullanıcı kararı 2026-11-12): bugün kaç silinmiş fatura ve kaç silinmiş
 * ölçüm fotoğrafı kalıcı silinmeye aday, kaç silinmiş fatura itiraz kaydı yüzünden korunuyor. **Hiçbir şey silmez ve
 * yazmaz** (her firma salt okunur işlemde; kural `services/deletedPurge.ts`; süre veritabanı saatinden).
 *
 *   npm run purge:preview -- [--invoice-days <n|off>] [--photo-days <n|off>] [--company <id>] [--json]
 *   Üretim kabında: node dist/cli/purgePreview.js [...]
 *
 * Süre verilmezse ortamdaki değer (`DELETED_INVOICE_PURGE_DAYS`, `DELETED_MEASUREMENT_PHOTO_PURGE_DAYS`); değişken boş ya da
 * `off` ise (varsayılan) kararın 30 günüyle sayılır ve satırda "currently off" yazar. Bayrağın değeri ortamla aynı kuraldır
 * (`parsePurgeDays`: `0`, `off` o türü saymaz; en az 7). Çıkış kodu: 0 bitti, 2 bozuk bayrak, 1 hata. Çıktı ASCII İngilizce.
 */
import { env, parsePurgeDays, PURGE_DEFAULT_DAYS } from '../env.ts';
import { previewDeletedPurge, type PurgePreview } from '../services/deletedPurge.ts';

export type CliOut = { log: (line: string) => void; error: (line: string) => void };
/** `undefined`: bayrak yok (ortam ya da 30); `null`: bayrakla kapalı. */
export type PurgePreviewArgs = { invoiceDays?: number | null; photoDays?: number | null; companyId?: string; json: boolean };

const HELP = [
  'Usage:',
  '  purge:preview -- [--invoice-days <n|off>] [--photo-days <n|off>] [--company <id>] [--json]',
  '  Counts deleted invoices and deleted measurement photos that maintenance would delete permanently. Nothing is deleted.',
];

function days(flag: string, raw: string | undefined): number | null {
  const r = parsePurgeDays(raw);
  if (raw === undefined || !raw.trim() || !r.ok) throw new Error(`${flag} needs a whole number of days or off`);
  return r.days;
}

export function parsePurgePreviewArgs(argv: string[]): PurgePreviewArgs {
  const out: PurgePreviewArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--invoice-days') out.invoiceDays = days(a, argv[++i]);
    else if (a === '--photo-days') out.photoDays = days(a, argv[++i]);
    else if (a === '--company') {
      const id = argv[++i];
      if (!id) throw new Error('--company needs an id');
      out.companyId = id;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export function formatPurgePreview(r: PurgePreview, enabled: { invoices: boolean; photos: boolean }): string[] {
  const state = (on: boolean, d: number | null) => (d == null ? 'not counted' : `${d} days${on ? '' : ' (currently off; counted as if enabled)'}`);
  const lines = [`invoices: ${state(enabled.invoices, r.invoiceDays)}, photos: ${state(enabled.photos, r.photoDays)}, clock=database`];
  for (const c of r.companies) {
    lines.push(`company=${c.companyId} invoices=${c.invoices} keptForDispute=${c.invoicesKeptForDispute} photos=${c.photos} photoMB=${(c.photoBytes / 1024 / 1024).toFixed(1)}`);
  }
  const t = r.totals;
  lines.push(`Done (nothing deleted): companies=${r.companies.length} invoices=${t.invoices} keptForDispute=${t.invoicesKeptForDispute} photos=${t.photos} photoMB=${(t.photoBytes / 1024 / 1024).toFixed(1)}`);
  return lines;
}

export async function runPurgePreviewCli(argv: string[], out: CliOut = { log: (l) => console.log(l), error: (l) => console.error(l) }): Promise<number> {
  let args: PurgePreviewArgs;
  try {
    args = parsePurgePreviewArgs(argv);
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    for (const l of HELP) out.error(l);
    return 2;
  }
  try {
    const enabled = { invoices: env.deletedInvoicePurgeDays != null, photos: env.deletedMeasurementPhotoPurgeDays != null };
    const r = await previewDeletedPurge({
      invoiceDays: args.invoiceDays !== undefined ? args.invoiceDays : (env.deletedInvoicePurgeDays ?? PURGE_DEFAULT_DAYS),
      photoDays: args.photoDays !== undefined ? args.photoDays : (env.deletedMeasurementPhotoPurgeDays ?? PURGE_DEFAULT_DAYS),
      ...(args.companyId ? { companyIds: [args.companyId] } : {}),
    });
    if (args.json) out.log(JSON.stringify({ ...r, enabled }));
    else for (const l of formatPurgePreview(r, enabled)) out.log(l);
    return 0;
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
