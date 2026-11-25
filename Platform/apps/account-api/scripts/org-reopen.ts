import { PRODUCTS, isProductKey } from '@sellerondata/contracts';
import { reopenOrg, type ReopenSkip } from '../src/lib/subscriptions.ts';
import { UsageError, operatorArg, orgIdArg, parseCommandArgs, runSupportCommand } from '../src/lib/support.ts';

/**
 * org:close'un tersi: son kapatmanın iptal ettiği ve hâlâ iptal olan abonelikleri eski durumuna döndürür. Kapatmadan sonra elle
 * değiştirilmiş abonelik atlanır. Davetler geri gelmez.
 * Geliştirmede: npm run org:reopen -- <orgId> --operator <ad>. İmajda: node dist/org-reopen.js ...
 */
const USAGE = 'org-reopen <orgId> --operator <ad>';

const REASON: Record<ReopenSkip['reason'], string> = {
  not_canceled: 'iptal durumunda değil',
  changed_after_close: 'kapatmadan sonra elle değiştirilmiş (subscription:set ile bakın)',
  off: 'araç kapalı (off)',
};

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), { operator: { type: 'string' } });
  if (positionals.length !== 1) throw new UsageError('Tek değer gerekir: firma.');
  const orgId = orgIdArg(positionals[0]);
  const operator = operatorArg(values.operator);

  const r = await reopenOrg(orgId, { operator });
  const name = (p: string) => (isProductKey(p) ? PRODUCTS[p].name : p);
  if (r.details.length) {
    console.log(`${r.orgName} yeniden açıldı: ${r.details.map((d) => `${name(d.product)} ${d.to}`).join(', ')}.`);
  } else {
    console.log(`${r.orgName}: geri alınacak abonelik yok, değişiklik yok.`);
  }
  for (const s of r.skipped) console.log(`  ${r.orgName} · ${name(s.product)} atlandı: ${REASON[s.reason]}`);
});
