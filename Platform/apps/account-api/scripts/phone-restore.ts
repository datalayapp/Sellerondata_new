import { disconnectPrisma } from '../src/db.ts';
import { restorePerson } from '../src/lib/support.ts';

/**
 * phone-release'in tersi: askıyı kaldırır, numarayı yazar, komutun askıya aldığı üyelikleri açar.
 * Geliştirmede: npm run phone:restore -- <kişi> <telefon> --operator <ad>. İmajda: node dist/phone-restore.js <kişi> <telefon> --operator <ad>
 */
const args = process.argv.slice(2);
const flag = args.indexOf('--operator');
const operator = flag >= 0 ? args[flag + 1] : undefined;
const [personId, phone] = args.filter((a, i) => !a.startsWith('--') && i !== flag + 1);
if (!personId || !operator?.trim()) {
  console.error('Kullanım: phone-restore <kişi> [telefon] --operator <ad>');
  process.exitCode = 1;
} else {
  try {
    const { reactivated } = await restorePerson(personId, { phone, operator });
    console.log(`Kişi geri alındı: ${personId}. Açılan üyelik: ${reactivated}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}
