import { ORG_LIST_LIMIT_DEFAULT, ORG_LIST_LIMIT_MAX, isSubscriptionStatus, listOrgs } from '../src/lib/subscriptions.ts';
import { UsageError, formatDay, intArg, parseCommandArgs, productArg, runSupportCommand } from '../src/lib/support.ts';

/**
 * Firmaları listeler: id · ad · ülke · açılış · üye (etkin/toplam) · sahip e-postası · son etkinlik · abonelikler. Salt okur.
 * Geliştirmede: npm run org:list -- [--q <ad>] [--product <ürün>] [--status <durum|none>] [--limit 50] [--json]. İmajda: node dist/org-list.js ...
 */
const USAGE = 'org-list [--q <ad parçası>] [--product <anahtar>] [--status ACTIVE|READ_ONLY|CANCELED|none] [--limit 50] [--json]';

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    q: { type: 'string' },
    product: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (positionals.length) throw new UsageError(`Beklenmeyen değer: ${positionals.join(' ')}`);
  const product = values.product === undefined ? undefined : productArg(values.product);
  const status = values.status;
  if (status !== undefined && status !== 'none' && !isSubscriptionStatus(status)) throw new UsageError(`Durum geçersiz: ${status}`);
  const limit = intArg('limit', values.limit, 1, ORG_LIST_LIMIT_MAX) ?? ORG_LIST_LIMIT_DEFAULT;

  const rows = await listOrgs({ q: values.q, product, status, limit });
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('Eşleşen firma yok.');
    return;
  }
  for (const o of rows) {
    const subs = o.subscriptions.map((s) => `${s.product}:${s.status}/${s.plan}`).join(' ') || 'abonelik yok';
    console.log(
      [
        o.id,
        o.name,
        o.country,
        formatDay(o.createdAt),
        `üye ${o.members.active}/${o.members.total}`,
        o.ownerEmail ?? '-',
        o.lastActiveAt ? formatDay(o.lastActiveAt) : '-',
        subs,
      ].join(' · '),
    );
  }
  if (rows.length === limit) console.log(`(ilk ${limit} firma; daha fazlası için --limit)`);
});
