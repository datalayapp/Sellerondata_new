import { PRODUCTS } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { PLAN_RE, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, isSubscriptionStatus, setSubscription } from '../src/lib/subscriptions.ts';
import { UsageError, formatDay, intArg, operatorArg, orgIdArg, parseCommandArgs, productArg, runSupportCommand } from '../src/lib/support.ts';

/**
 * Tek aboneliği değiştirir: ilk açılış, durdurma (READ_ONLY), iptal (CANCELED, okunur kalma süresi --days),
 * geri açma, plan. Aynı durum ve plan: değişiklik yok, çıkış 0. Denetim izine operatörle yazılır.
 * Geliştirmede: npm run subscription:set -- <orgId> <ürün> <durum> --operator <ad>. İmajda: node dist/subscription-set.js ...
 */
const USAGE = 'subscription-set <orgId> <ürün> <ACTIVE|READ_ONLY|CANCELED> --operator <ad> [--plan <plan>] [--days <n>] [--reason <metin>]';

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    operator: { type: 'string' },
    plan: { type: 'string' },
    days: { type: 'string' },
    reason: { type: 'string' },
  });
  if (positionals.length !== 3) throw new UsageError('Üç değer gerekir: firma, ürün, durum.');
  const orgId = orgIdArg(positionals[0]);
  const product = productArg(positionals[1]);
  const status = positionals[2];
  if (!isSubscriptionStatus(status)) throw new UsageError(`Durum geçersiz: ${status} (ACTIVE, READ_ONLY, CANCELED).`);
  const operator = operatorArg(values.operator);
  if (values.plan !== undefined && !PLAN_RE.test(values.plan)) throw new UsageError(`Plan geçersiz: ${values.plan}`);
  const days = intArg('days', values.days, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);
  if (days !== undefined && status !== 'CANCELED') throw new UsageError('--days yalnız CANCELED ile verilir.');

  const r = await prisma.$transaction((tx) =>
    setSubscription(tx, orgId, product, { status, plan: values.plan, days }, { operator, reason: values.reason, via: 'set' }),
  );
  const head = `${r.orgName} · ${PRODUCTS[product].name}`;
  if (!r.changed) {
    console.log(`${head}: zaten ${r.to} (${r.plan}), değişiklik yok.${days !== undefined ? ' --days uygulanmadı.' : ''}`);
  } else if (r.firstOpen) {
    const owner = r.ownerRoleGranted ? ' Sahibe aracın sahip rolü verildi.' : '';
    console.log(`${head}: açıldı, ACTIVE (${r.plan}, sürüm ${r.version}). ${r.announced} üyelik araca duyuruldu.${owner}`);
  } else if (r.from === r.to) {
    console.log(`${head}: plan ${r.plan} (sürüm ${r.version}). Durum ${r.to}, jetonlar değişmez.`);
  } else {
    const until = r.deleteAfter ? ` ${formatDay(r.deleteAfter)} tarihine kadar okunur, sonra erişim biter (veri silinmez).` : '';
    console.log(`${head}: ${r.from} → ${r.to} (sürüm ${r.version}). ${r.bumped} üyeliğin jetonu yenilenecek.${until}`);
  }
});
