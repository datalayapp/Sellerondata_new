import { PRODUCTS } from '@sellerondata/contracts';
import { announceMembers } from '../src/lib/subscriptions.ts';
import { UsageError, orgIdArg, parseCommandArgs, productArg, runSupportCommand } from '../src/lib/support.ts';

/**
 * Aboneliği olan firmaların bilgisini ve üyelerini yalnız bu ürüne yeniden duyurur. Epoch ve sürüm artmaz; tekrar çalıştırmak zararsız.
 * off → pilot dönüşünden sonra kullanılır (kapalıyken olay gitmez).
 * Geliştirmede: npm run members:announce -- <ürün> [--org <orgId>]. İmajda: node dist/members-announce.js ...
 */
const USAGE = 'members-announce <ürün> [--org <orgId>]';

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), { org: { type: 'string' } });
  if (positionals.length !== 1) throw new UsageError('Tek değer gerekir: ürün.');
  const product = productArg(positionals[0]);
  const orgId = values.org === undefined ? undefined : orgIdArg(values.org);

  const r = await announceMembers(product, { orgId });
  const name = PRODUCTS[product].name;
  if (orgId) console.log(`${r.orgName} · ${name}: ${r.members} üyelik yeniden duyuruldu.`);
  else console.log(`${name}: ${r.orgs} firmada ${r.members} üyelik yeniden duyuruldu.`);
});
