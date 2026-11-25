import { PRODUCTS } from '@sellerondata/contracts';
import { PLAN_RE, launchProduct } from '../src/lib/subscriptions.ts';
import { UsageError, operatorArg, parseCommandArgs, productArg, runSupportCommand } from '../src/lib/support.ts';

/**
 * Herkese açık (public) aracı aboneliği olmayan her firmaya açar (geri doldurma). Abonelik satırı olan firmaya (durdurulmuş, iptal)
 * ve kapatılmış firmaya dokunmaz. Tekrar çalıştırmak zararsız: ikinci koşu 0 açar.
 * Geliştirmede: npm run product:launch -- <ürün> --operator <ad> [--dry-run]. İmajda: node dist/product-launch.js ...
 */
const USAGE = 'product-launch <ürün> --operator <ad> [--plan <plan>] [--dry-run]';

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    operator: { type: 'string' },
    plan: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  if (positionals.length !== 1) throw new UsageError('Tek değer gerekir: ürün.');
  const product = productArg(positionals[0]);
  const operator = operatorArg(values.operator);
  if (values.plan !== undefined && !PLAN_RE.test(values.plan)) throw new UsageError(`Plan geçersiz: ${values.plan}`);

  const r = await launchProduct(product, { operator, plan: values.plan, dryRun: values['dry-run'] === true });
  const name = PRODUCTS[product].name;
  for (const o of r.orgs) console.log(`  ${r.dryRun ? 'açılacak' : 'açıldı'}: ${o.name} (${o.id})`);
  const closed = r.closed ? `, ${r.closed} kapatılmış firma atlandı` : '';
  if (r.dryRun) {
    console.log(`${name} (deneme, yazılmadı): ${r.orgs.length} firmaya açılacak, ${r.skipped} firmada zaten abonelik var (dokunulmayacak)${closed}.`);
  } else {
    console.log(`${name}: ${r.opened} firmaya açıldı, ${r.skipped} firmada zaten abonelik var (dokunulmadı)${closed}.`);
  }
});
