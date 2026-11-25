import { disconnectPrisma } from '../src/db.ts';
import { releasePhone } from '../src/lib/support.ts';

/**
 * Numarayı kişiden ayırır (ARCHITECTURE §11). Oturumlar düşer. Kişinin başka girişi yoksa askıya alır. Denetim izine son 4 hane ve operatör yazılır.
 * Geliştirmede: npm run phone:release -- <telefon> --operator <ad>. İmajda: node dist/phone-release.js <telefon> --operator <ad>
 */
const args = process.argv.slice(2);
const flag = args.indexOf('--operator');
const operator = flag >= 0 ? args[flag + 1] : undefined;
const phone = args.find((a, i) => !a.startsWith('--') && i !== flag + 1);
if (!phone || !operator?.trim()) {
  console.error('Kullanım: phone-release <telefon> --operator <ad>');
  process.exitCode = 1;
} else {
  try {
    const { personId, suspended } = await releasePhone(phone, { operator });
    console.log(`Numara ayrıldı. Kişi: ${personId}${suspended ? ' (başka girişi olmadığı için askıya alındı)' : ''}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}
