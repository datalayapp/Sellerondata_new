import { env } from '../src/env.ts';
import {
  SIGNUP_INVITE_DAYS_DEFAULT,
  SIGNUP_INVITE_DAYS_MAX,
  SIGNUP_INVITE_DAYS_MIN,
  SIGNUP_INVITE_LIST_MAX,
  createSignupInvite,
  listSignupInvites,
  revokeSignupInvites,
  type SignupInviteStatus,
} from '../src/lib/signupInvites.ts';
import { UsageError, formatDay, intArg, operatorArg, parseCommandArgs, runSupportCommand } from '../src/lib/support.ts';

/**
 * Kayıt daveti (kullanıcı kararı 2026-11-12, kapalı deneme). Üç kullanım:
 * - Üret: --email <adres> --operator <ad> [--days 14] [--lang tr|en]. Tek kullanımlık, yalnız o adresle. Bağlantı çıktıya yazılır,
 *   posta gönderilmez: operatör kişiye kendisi iletir. Jeton saklanmaz, bağlantı yeniden gösterilemez; kaybolursa yeni davet üretilir.
 * - İptal: --revoke <adres> --operator <ad>. Adresin kullanılmamış bütün davetleri hemen geçersiz olur; açılmış hesaba dokunmaz.
 * - Liste: --list [--email <adres>] [--limit 50]. Jeton gösterilmez.
 * Geliştirmede: npm run signup:invite -- …. İmajda: node dist/signup-invite.js …
 */
const USAGE = [
  `signup-invite --email <adres> --operator <ad> [--days ${SIGNUP_INVITE_DAYS_DEFAULT}] [--lang tr|en]`,
  '       signup-invite --revoke <adres> --operator <ad>',
  '       signup-invite --list [--email <adres>] [--limit 50]',
].join('\n');

const STATUS_TEXT: Record<SignupInviteStatus, string> = { pending: 'bekliyor', used: 'kullanıldı', expired: 'süresi doldu ya da iptal' };

await runSupportCommand(USAGE, async () => {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2), {
    email: { type: 'string' },
    operator: { type: 'string' },
    days: { type: 'string' },
    lang: { type: 'string' },
    revoke: { type: 'string' },
    list: { type: 'boolean' },
    limit: { type: 'string' },
  });
  if (positionals.length) throw new UsageError(`Beklenmeyen değer: ${positionals.join(' ')}`);
  if (values.list && values.revoke !== undefined) throw new UsageError('--list ile --revoke birlikte kullanılmaz.');

  if (values.list) {
    if (values.days !== undefined || values.lang !== undefined || values.operator !== undefined) throw new UsageError('--list yalnız --email ve --limit alır.');
    const limit = intArg('limit', values.limit, 1, SIGNUP_INVITE_LIST_MAX) ?? 50;
    const rows = await listSignupInvites({ email: values.email, limit });
    for (const r of rows) {
      const when = r.usedAt ? `kullanım ${formatDay(r.usedAt)}` : `son gün ${formatDay(r.expiresAt)}`;
      console.log(`${r.id} ${r.email} ${STATUS_TEXT[r.status]} (üretim ${formatDay(r.createdAt)}, ${when}, ${r.createdBy})`);
    }
    console.log(rows.length ? `${rows.length} davet.` : 'Davet yok.');
    return 0;
  }

  if (values.limit !== undefined) throw new UsageError('--limit yalnız --list ile.');
  const operator = operatorArg(values.operator);

  if (values.revoke !== undefined) {
    if (values.email !== undefined || values.days !== undefined || values.lang !== undefined) throw new UsageError('--revoke yalnız adres ve --operator alır.');
    if (!values.revoke.trim()) throw new UsageError('--revoke <adres> zorunlu.');
    const n = await revokeSignupInvites({ email: values.revoke, operator });
    console.log(n ? `${n} bekleyen davet iptal edildi.` : 'Bu adrese bekleyen davet yok; hiçbir şey değişmedi.');
    return 0;
  }

  if (!values.email?.trim()) throw new UsageError('--email <adres> zorunlu: davet yalnız bu adresle kullanılır.');
  const days = intArg('days', values.days, SIGNUP_INVITE_DAYS_MIN, SIGNUP_INVITE_DAYS_MAX) ?? SIGNUP_INVITE_DAYS_DEFAULT;
  if (values.lang !== undefined && values.lang !== 'tr' && values.lang !== 'en') throw new UsageError(`--lang tr ya da en olmalı: ${values.lang}`);

  const invite = await createSignupInvite({ email: values.email, operator, days, lang: values.lang as 'tr' | 'en' | undefined });
  console.log(invite.url);
  console.log(`Kayıt daveti ${invite.id}: ${invite.email}, ${formatDay(invite.expiresAt)} tarihine kadar, tek kullanımlık.`);
  if (invite.personExists) console.error('UYARI: bu adresle hesap zaten var; kayıt "e-posta kullanılıyor" der. Kişi giriş yapabilir.');
  if (env.signupMode !== 'invite') console.error(`UYARI: SIGNUP_MODE=${env.signupMode}: kayıt şu an davetsiz de açık, davet gerekmez.`);
  return 0;
});
