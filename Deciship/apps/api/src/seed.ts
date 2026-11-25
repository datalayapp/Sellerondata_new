/**
 * Geliştirme tohumunun dışa aktarımı (testler buradan alır); gövde dev-seed.ts'te (seedDemoDisputes.ts de kullanır).
 * Çalıştırma girişi src/bin/seed.ts (`npm run seed`, imajda `node dist/seed.js`); bu dosya kendini çalıştırmaz.
 */
export { SEED_COMPANY, SEED_MEMBERS, seed } from './dev-seed.ts';
