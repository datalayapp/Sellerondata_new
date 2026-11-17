import { disconnectPrisma } from '../src/db.ts';
import { announceAllOrgs } from '../src/lib/orgs.ts';

/** Her firmayı ürünlere güncel ad, para birimi ve ülkesiyle yeniden duyurur. Tekrar çalıştırmak zararsız. İmajda: node dist/org-announce.js */
const count = await announceAllOrgs();
console.log(`${count} firma yeniden duyuruldu.`);
await disconnectPrisma();
