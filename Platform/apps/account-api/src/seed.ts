import { PLAN_EARLY_ACCESS, PRODUCTS } from '@sellerondata/contracts';
import { disconnectPrisma, prisma, type Tx } from './db.ts';
import { env, LOCAL_HOSTS } from './env.ts';
import { hashPassword } from './lib/crypto.ts';

/**
 * Geliştirme tohumu. Üretimde çalışmaz. Tekrar çalıştırılabilir: kişileri, rolleri ve şifreleri bu listeye geri getirir.
 * Kimlikler sabittir: DeciShip tohumu aynı firma ve üyelik kimliklerine bağlanabilir.
 */

export const SEED_PASSWORD = 'Demo12345!';

export const SEED_ORGS = {
  demo: { id: '00000000-0000-7000-8000-00000000a001', name: 'Demo Lojistik', country: 'TR', currency: 'TRY' as const },
  second: { id: '00000000-0000-7000-8000-00000000a002', name: 'İkinci Firma', country: 'TR', currency: 'TRY' as const },
};

/** Araç rolleri: `null` o araçta erişim yok. TagPress'te firma sahibi ve yöneticiler Yönetici (ADMIN), çalışanlar Kullanıcı (USER). */
type SeedMembership = { id: string; org: keyof typeof SEED_ORGS; orgRole: 'OWNER' | 'ADMIN' | 'MEMBER'; deciship: string | null; tagpress: string | null };
/** Tohumun rol verdiği araçlar (kayıttaki anahtarlar). */
export const SEED_PRODUCTS = ['deciship', 'tagpress'] as const;

type SeedPerson = { id: string; name: string; email: string | null; phone: string | null; memberships: SeedMembership[] };

export const SEED_PEOPLE: SeedPerson[] = [
  {
    id: '00000000-0000-7000-8000-00000000b001',
    name: 'Selin Sahip',
    email: 'sahip@demo.sellerondata.com',
    phone: '+905550000001',
    memberships: [{ id: '00000000-0000-7000-8000-00000000c001', org: 'demo', orgRole: 'OWNER', deciship: 'ADMIN', tagpress: 'ADMIN' }],
  },
  {
    id: '00000000-0000-7000-8000-00000000b002',
    name: 'Yasin Yönetici',
    email: 'yonetici@demo.sellerondata.com',
    phone: null,
    memberships: [{ id: '00000000-0000-7000-8000-00000000c002', org: 'demo', orgRole: 'ADMIN', deciship: 'ADMIN', tagpress: 'ADMIN' }],
  },
  {
    id: '00000000-0000-7000-8000-00000000b003',
    name: 'Deniz Denetleyici',
    email: 'denetleyici@demo.sellerondata.com',
    phone: null,
    memberships: [{ id: '00000000-0000-7000-8000-00000000c003', org: 'demo', orgRole: 'MEMBER', deciship: 'AUDITOR', tagpress: 'USER' }],
  },
  {
    id: '00000000-0000-7000-8000-00000000b004',
    name: 'Mert Muhasebe',
    email: 'muhasebe@demo.sellerondata.com',
    phone: null,
    memberships: [{ id: '00000000-0000-7000-8000-00000000c004', org: 'demo', orgRole: 'MEMBER', deciship: 'ACCOUNTING', tagpress: 'USER' }],
  },
  {
    // Telefonlu, e-postasız. Şifre kodu akışı bununla denenir.
    id: '00000000-0000-7000-8000-00000000b005',
    name: 'Ömer Ölçüm',
    email: null,
    phone: '+905550000005',
    memberships: [{ id: '00000000-0000-7000-8000-00000000c005', org: 'demo', orgRole: 'MEMBER', deciship: 'MEASURE', tagpress: 'USER' }],
  },
  {
    id: '00000000-0000-7000-8000-00000000b006',
    name: 'Eda Erişimsiz',
    email: 'erisimyok@demo.sellerondata.com',
    phone: null,
    memberships: [{ id: '00000000-0000-7000-8000-00000000c006', org: 'demo', orgRole: 'MEMBER', deciship: null, tagpress: null }],
  },
  {
    // İki firmada üye. Firma değiştirme bununla denenir.
    id: '00000000-0000-7000-8000-00000000b007',
    name: 'Ceren Çokfirma',
    email: 'cokfirma@demo.sellerondata.com',
    phone: null,
    memberships: [
      { id: '00000000-0000-7000-8000-00000000c007', org: 'demo', orgRole: 'MEMBER', deciship: 'ACCOUNTING', tagpress: 'USER' },
      { id: '00000000-0000-7000-8000-00000000c008', org: 'second', orgRole: 'ADMIN', deciship: 'ADMIN', tagpress: 'ADMIN' },
    ],
  },
  {
    id: '00000000-0000-7000-8000-00000000b008',
    name: 'İpek İkinci',
    email: 'sahip2@demo.sellerondata.com',
    phone: null,
    memberships: [{ id: '00000000-0000-7000-8000-00000000c009', org: 'second', orgRole: 'OWNER', deciship: 'ADMIN', tagpress: 'ADMIN' }],
  },
];

export function assertSeedAllowed(nodeEnv: string | undefined, appBaseUrl?: string) {
  if (nodeEnv === 'production') {
    throw new Error('Geliştirme tohumu üretimde çalışmaz.');
  }
  if (appBaseUrl) {
    let host: string | null = null;
    try {
      host = new URL(appBaseUrl).hostname;
    } catch {
      /* geçersiz adres yerel sayılmaz */
    }
    if (!host || !LOCAL_HOSTS.includes(host)) {
      throw new Error(`Geliştirme tohumu yalnız yerel adreste çalışır (APP_BASE_URL=${appBaseUrl}).`);
    }
  }
}

async function upsertMembership(tx: Tx, personId: string, m: SeedMembership) {
  const orgId = SEED_ORGS[m.org].id;
  await tx.membership.upsert({
    where: { id: m.id },
    create: { id: m.id, personId, orgId, orgRole: m.orgRole },
    update: { orgRole: m.orgRole, status: 'ACTIVE' },
  });
  await tx.productAccess.deleteMany({ where: { membershipId: m.id } });
  for (const product of SEED_PRODUCTS) {
    const role = m[product];
    if (role) await tx.productAccess.create({ data: { membershipId: m.id, product, role } });
  }
}

export async function seedDevData() {
  assertSeedAllowed(env.nodeEnv, env.appBaseUrl);
  const passwordHash = await hashPassword(SEED_PASSWORD);
  await prisma.$transaction(async (tx) => {
    for (const org of Object.values(SEED_ORGS)) {
      await tx.organization.upsert({
        where: { id: org.id },
        // Demo firması Merkez'de onaylı açılır (Merkez kurulumu tamam): demo doğrudan araç kurulumuna geçer.
        create: { id: org.id, name: org.name, country: org.country, currency: org.currency, companyConfirmedAt: new Date() },
        update: { name: org.name },
      });
      // Her araca etkin abonelik. Kapalı (`off`) araçta Hesap aboneliği ve rolü saymaz (`productAccessFor`); `pilot`e geçince demo
      // firmada araç ve roller hemen açılır (pilotta erişimi abonelik verir).
      for (const product of SEED_PRODUCTS) {
        await tx.subscription.upsert({
          where: { orgId_product: { orgId: org.id, product } },
          create: { orgId: org.id, product, status: 'ACTIVE', plan: PLAN_EARLY_ACCESS },
          update: { status: 'ACTIVE', plan: PLAN_EARLY_ACCESS },
        });
      }
    }
    for (const p of SEED_PEOPLE) {
      await tx.person.upsert({
        where: { id: p.id },
        // Demo e-postaları doğrulanmış yazılır: doğrulama açıkken de girilebilsin.
        create: { id: p.id, name: p.name, email: p.email, phone: p.phone, passwordHash, emailVerifiedAt: p.email ? new Date() : null, pendingEmail: null },
        update: { name: p.name, email: p.email, phone: p.phone, passwordHash, emailVerifiedAt: p.email ? new Date() : null, pendingEmail: null },
      });
      // Tek OWNER dizini: önce OWNER olmayanlar, sonra OWNER. Tekrar çalıştırmada rol değişmiş olabilir.
      for (const m of p.memberships.filter((x) => x.orgRole !== 'OWNER')) await upsertMembership(tx, p.id, m);
    }
    for (const p of SEED_PEOPLE) {
      for (const m of p.memberships.filter((x) => x.orgRole === 'OWNER')) await upsertMembership(tx, p.id, m);
    }
  });
}

/**
 * Tohumdan sonra veritabanında gerçekten duran demo kişi ve üyelik sayısı (tohum kimlikleriyle, etkin üyelik).
 * Komut bununla "yüklendi" der: sayılar listeyle tutmazsa sessizce başarılı bitmez.
 */
export async function countSeededData(): Promise<{ people: number; memberships: number }> {
  const [people, memberships] = await Promise.all([
    prisma.person.count({ where: { id: { in: SEED_PEOPLE.map((p) => p.id) } } }),
    prisma.membership.count({ where: { id: { in: SEED_PEOPLE.flatMap((p) => p.memberships.map((m) => m.id)) }, status: 'ACTIVE' } }),
  ]);
  return { people, memberships };
}

/** Çıktının son satırı; `scripts/demo.ps1` tohumun gerçekten yüklendiğini bununla anlar (ASCII: konsol kod sayfasından etkilenmez). */
export const SEED_OK_MARKER = 'SEED-OK';

/**
 * Çalıştırma girişinin gövdesi (`scripts/seed.ts`, imajda `node dist/seed.js`). Bu dosya kendini çalıştırmaz: `lib/demo.ts`
 * üzerinden `main.ts` de içe aktarır, tsup bölmesinde gövdesi ortak parçaya taşınır ve "ana dosya mı" denetimi orada hep yanlış
 * döner (komut hiçbir şey yapmadan 0 ile biterdi). Çıkış: 0 yüklendi ve sayıldı, 1 hata ya da eksik kayıt.
 */
export async function runSeedCommand(): Promise<number> {
  try {
    assertSeedAllowed(env.nodeEnv, env.appBaseUrl);
    await seedDevData();
    const want = { people: SEED_PEOPLE.length, memberships: SEED_PEOPLE.reduce((n, p) => n + p.memberships.length, 0) };
    const got = await countSeededData();
    if (got.people !== want.people || got.memberships !== want.memberships) {
      console.error(`Tohum eksik yüklendi: ${got.people}/${want.people} kişi, ${got.memberships}/${want.memberships} etkin üyelik.`);
      return 1;
    }
    console.log(`Tohum yüklendi. Şifre: ${SEED_PASSWORD}`);
    for (const p of SEED_PEOPLE) {
      const orgs = p.memberships
        .map((m) => `${SEED_ORGS[m.org].name}: ${m.orgRole}, ${SEED_PRODUCTS.map((k) => `${PRODUCTS[k].name} ${m[k] ?? 'erişim yok'}`).join(', ')}`)
        .join('; ');
      console.log(`  ${p.email ?? p.phone}  ${p.name}  (${orgs})`);
    }
    console.log(`${SEED_OK_MARKER} people=${got.people} memberships=${got.memberships}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await disconnectPrisma();
  }
}
