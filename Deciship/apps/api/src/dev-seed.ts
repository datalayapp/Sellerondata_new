import { prisma, withCompany } from './db.ts';
import { env } from './env.ts';
import { DEFAULT_BOX_PRESETS, DEFAULT_SETTINGS } from './lib/settings.ts';
import { loadSampleData } from './services/companyData.ts';

/**
 * Geliştirme tohumunun gövdesi; çalıştırma girişi seed.ts (girişi başka giriş içe aktarırsa tsup onu ortak parçaya
 * taşır ve `node dist/seed.js` kendini çalıştırmaz: seedDemoDisputes.ts bu dosyayı kullanır).
 * Geliştirme tohumu. Hesap tohumuyla (Platform/apps/account-api/src/seed.ts) aynı firma ve üyelik kimliklerini kullanır,
 * giriş bilgileri oradadır. Kişi ve şifre burada yoktur. Varsayılan olarak boş başlar; `samples: true` (ya da `--samples`)
 * örnek taşıyıcı, tarife ve ölçümleri de yükler.
 */
export const SEED_COMPANY = { id: '00000000-0000-7000-8000-00000000a001', name: 'Demo Lojistik' };

export const SEED_MEMBERS = [
  { id: '00000000-0000-7000-8000-00000000c001', personId: '00000000-0000-7000-8000-00000000b001', name: 'Selin Sahip', role: 'ADMIN' },
  { id: '00000000-0000-7000-8000-00000000c002', personId: '00000000-0000-7000-8000-00000000b002', name: 'Yasin Yönetici', role: 'ADMIN' },
  { id: '00000000-0000-7000-8000-00000000c003', personId: '00000000-0000-7000-8000-00000000b003', name: 'Deniz Denetleyici', role: 'AUDITOR' },
  { id: '00000000-0000-7000-8000-00000000c004', personId: '00000000-0000-7000-8000-00000000b004', name: 'Mert Muhasebe', role: 'ACCOUNTING' },
  { id: '00000000-0000-7000-8000-00000000c005', personId: '00000000-0000-7000-8000-00000000b005', name: 'Ömer Ölçüm', role: 'MEASURE' },
] as const;

export async function seed(opts: { reset?: boolean; samples?: boolean; log?: (s: string) => void } = {}) {
  if (env.isProduction) throw new Error('Geliştirme tohumu üretimde çalışmaz.');
  const log = opts.log ?? ((s: string) => console.log(s));
  const companyId = SEED_COMPANY.id;

  return withCompany(companyId, async () => {
    const existing = await prisma.company.findFirst({ where: { id: companyId } });
    if (existing) {
      if (!opts.reset) {
        log('Demo firma zaten var; sıfırlamak için: npm run seed -- --reset');
        return companyId;
      }
      await prisma.company.delete({ where: { id: companyId } });
      log('Mevcut demo firma silindi');
    }

    await prisma.company.create({ data: { id: companyId, name: SEED_COMPANY.name, settings: { ...DEFAULT_SETTINGS, country: 'TR' } } });
    await prisma.boxPreset.createMany({ data: DEFAULT_BOX_PRESETS.map((p) => ({ ...p, companyId })) });
    await prisma.member.createMany({ data: SEED_MEMBERS.map((m) => ({ ...m, companyId })) });

    if (opts.samples) await loadSampleData(companyId, { log });
    else log('Boş sistem: örnek veri yüklenmedi (--samples ile yüklenir)');
    return companyId;
  });
}
