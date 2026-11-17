import { afterAll } from 'vitest';
import { disconnectPrisma } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';

/** İşçi kapanırken yarım kalan arka plan işi (argon2, posta, veritabanı bağlantısı) bırakılmaz. */
afterAll(async () => {
  await flushMail();
  await disconnectPrisma();
});
