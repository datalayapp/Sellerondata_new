import { PRODUCTS } from '@sellerondata/contracts';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, closeOrg, previewCloseOrg } from '../src/lib/subscriptions.ts';
import { UsageError, formatDay, intArg, operatorArg, orgIdArg, parseCommandArgs, runSupportCommand } from '../src/lib/support.ts';

/**
 * Firmayı kapatır: bütün abonelikler iptal (--days gün okunur, varsayılan 90), bekleyen davetler düşer, jetonlar yenilenir.
 * Veri silinmez; org:reopen geri alır. --yes yoksa yalnız ne olacağını yazar (çıkış 2).
 * Geliştirmede: npm run org:close -- <orgId> --operator <ad> --yes. İmajda: node dist/org-close.js ...
 */
const USAGE = 'org-close <orgId> --operator <ad> --yes [--days 90] [--reason <metin>]';

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    operator: { type: 'string' },
    yes: { type: 'boolean' },
    days: { type: 'string' },
    reason: { type: 'string' },
  });
  if (positionals.length !== 1) throw new UsageError('Tek değer gerekir: firma.');
  const orgId = orgIdArg(positionals[0]);
  const operator = operatorArg(values.operator);
  const days = intArg('days', values.days, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);

  if (values.yes !== true) {
    const p = await previewCloseOrg(orgId, { days });
    const subs = p.subscriptions.length
      ? p.subscriptions.map((s) => `${PRODUCTS[s.product].name} ${s.from} → CANCELED`).join(', ')
      : 'iptal edilecek abonelik yok';
    console.log(
      `${p.orgName} (${orgId}) kapatılacak: ${subs} (${formatDay(p.deleteAfter)} tarihine kadar okunur), ${p.pendingInvitations} bekleyen davet düşecek. Veri silinmez.`,
    );
    console.error('Onaylamak için --yes ekleyin. Hiçbir şey değişmedi.');
    return 2;
  }

  const r = await closeOrg(orgId, { operator, days, reason: values.reason });
  if (!r.changed) {
    console.log(`${r.orgName}: kapatılacak abonelik yok (hepsi zaten iptal), değişiklik yok.`);
    return 0;
  }
  const subs = r.canceled.map((p) => `${PRODUCTS[p].name} iptal`).join(', ');
  const until = r.deleteAfter ? ` (${formatDay(r.deleteAfter)} tarihine kadar okunur)` : '';
  console.log(
    `${r.orgName} kapatıldı: ${subs}${until}, ${r.invitationsRevoked} bekleyen davet düştü. ${r.bumped} üyeliğin jetonu yenilenecek. Geri almak: org:reopen.`,
  );
});
