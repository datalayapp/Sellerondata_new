import {
  PURGE_SKIP_TEXT,
  SIGNUP_PURGE_DAYS_DEFAULT,
  SIGNUP_PURGE_DAYS_MAX,
  SIGNUP_PURGE_DAYS_MIN,
  SIGNUP_PURGE_LIMIT_MAX,
  findSignupPurgeCandidates,
  purgeSignups,
} from '../src/lib/signupPurge.ts';
import { UsageError, formatDay, intArg, operatorArg, parseCommandArgs, runSupportCommand } from '../src/lib/support.ts';

/**
 * Hiç kullanılmamış kayıtları siler (04-B8): --days günden eski (varsayılan 7, en az 7), e-postası doğrulanmamış, hiç oturum
 * açmamış, kayıttan sonra iz bırakmamış kişi ve tek başına sahibi olduğu firma. Geri alınamaz. Otomatik çalışmaz.
 * --yes yoksa yalnız ne silineceğini yazar (çıkış 2). Adres çıktıda maskelidir.
 * Geliştirmede: npm run signup:purge -- --operator <ad> [--yes]. İmajda: node dist/signup-purge.js ...
 */
const USAGE = `signup-purge --operator <ad> [--days ${SIGNUP_PURGE_DAYS_DEFAULT}] [--limit <n>] [--yes]`;

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    operator: { type: 'string' },
    yes: { type: 'boolean' },
    days: { type: 'string' },
    limit: { type: 'string' },
  });
  if (positionals.length) throw new UsageError(`Beklenmeyen değer: ${positionals.join(' ')}`);
  const operator = operatorArg(values.operator);
  const days = intArg('days', values.days, SIGNUP_PURGE_DAYS_MIN, SIGNUP_PURGE_DAYS_MAX) ?? SIGNUP_PURGE_DAYS_DEFAULT;
  const limit = intArg('limit', values.limit, 1, SIGNUP_PURGE_LIMIT_MAX);

  if (values.yes !== true) {
    const list = await findSignupPurgeCandidates({ days, limit });
    for (const c of list) console.log(`${c.personId} ${c.maskedEmail} firma ${c.orgIds.join(', ')} kayıt ${formatDay(c.createdAt)}`);
    console.log(
      list.length
        ? `${list.length} kayıt silinecek (${days} günden eski, e-postası doğrulanmamış, hiç giriş yapılmamış). Kişi ve firma satırları silinir, geri alınamaz.`
        : 'Silinecek kayıt yok.',
    );
    console.error('Onaylamak için --yes ekleyin. Hiçbir şey değişmedi.');
    return 2;
  }

  const r = await purgeSignups({ operator, days, limit });
  for (const p of r.purged) console.log(`silindi: ${p.personId} ${p.maskedEmail} firma ${p.orgIds.join(', ')}`);
  for (const s of r.skipped) console.log(`atlandı: ${s.personId} ${s.maskedEmail} (${PURGE_SKIP_TEXT[s.reason]})`);
  for (const f of r.failed) console.error(`hata: ${f.personId} ${f.maskedEmail}: ${f.error}`);
  console.log(`${r.purged.length} kayıt silindi, ${r.skipped.length} atlandı, ${r.failed.length} hata. Ürünlere bildirim kuyrukta.`);
  return r.failed.length ? 1 : 0;
});
