import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { flushMail } from '../src/lib/mailer.ts';
import { addMember, getApp, randomEmail, randomTrPhone, registerOrg } from './helpers.ts';

/** İmajda çalışan biçim: derlenmiş `dist/*.js`. Geliştirme araçları (tsx) imajda yoktur. */
const API_ROOT = path.resolve(import.meta.dirname, '..');

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [`dist/${script}.js`, ...args], {
    cwd: API_ROOT,
    env: { ...process.env, NODE_ENV: 'test', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('derlenmiş destek komutları', () => {
  beforeAll(() => {
    execSync('npx tsup', { cwd: API_ROOT, stdio: 'pipe' });
  }, 180_000);

  it('outbox-requeue DEAD satırları geri alır', async () => {
    await getApp();
    await registerOrg(await getApp());
    await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { status: 'DEAD', lastError: 'x' } });
    const res = run('outbox-requeue');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('yeniden kuyruğa');
    expect(await prisma.outboxDelivery.count({ where: { status: 'DEAD' } })).toBe(0);
    await prisma.outboxDelivery.updateMany({ where: { status: 'PENDING' }, data: { status: 'DELIVERED' } });
  });

  it('signup-invite: üretir (bağlantı), listeler (jetonsuz), iptal eder; kullanım hataları 2', async () => {
    const email = randomEmail('cli-davet');
    const made = run('signup-invite', ['--email', email, '--operator', 'destek-ali', '--days', '3']);
    expect(made.status, made.stderr).toBe(0);
    const token = /\/register\?invite=([A-Za-z0-9_-]+)/.exec(made.stdout)?.[1] as string;
    expect(token).toHaveLength(43);

    const list = run('signup-invite', ['--list', '--email', email]);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain(email);
    expect(list.stdout).toContain('bekliyor');
    expect(list.stdout).not.toContain(token);

    const revoked = run('signup-invite', ['--revoke', email, '--operator', 'destek-ali']);
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(revoked.stdout).toContain('1 bekleyen davet iptal edildi');
    expect(run('signup-invite', ['--list', '--email', email]).stdout).toContain('süresi doldu ya da iptal');
    expect(run('signup-invite', ['--revoke', email, '--operator', 'destek-ali']).stdout).toContain('hiçbir şey değişmedi');

    for (const args of [[], ['--revoke', email], ['--list', '--revoke', email], ['--list', '--operator', 'x'], ['--email', email, '--operator', 'x', '--limit', '3']]) {
      const bad = run('signup-invite', args);
      expect(bad.status, args.join(' ')).toBe(2);
      expect(bad.stderr).toContain('Kullanım: signup-invite');
    }
  });

  it('phone-release numarayı ayırır', async () => {
    const app = await getApp();
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const res = run('phone-release', [phone, '--operator', 'destek-ali']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(member.personId);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: member.personId } })).phone).toBeNull();
  });

  it('phone-release operatörsüz çalışmaz, USER ortam değişkenine güvenmez', async () => {
    const app = await getApp();
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const member = await addMember(app, owner.orgId, { phone });
    const res = run('phone-release', [phone]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--operator');
    expect((await prisma.person.findUniqueOrThrow({ where: { id: member.personId } })).phone).toBe(phone);
  });

  it('phone-restore askıyı geri alır, izde operatör yazar', async () => {
    const app = await getApp();
    const owner = await registerOrg(app);
    const phone = randomTrPhone();
    const worker = await addMember(app, owner.orgId, { email: null, phone });
    expect(run('phone-release', [phone, '--operator', 'destek-ali']).status).toBe(0);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).suspendedAt).not.toBeNull();
    expect(run('phone-restore', [worker.personId, phone]).status).toBe(1);
    const res = run('phone-restore', [worker.personId, phone, '--operator', 'destek-ali']);
    expect(res.status, res.stderr).toBe(0);
    expect(await prisma.person.findUniqueOrThrow({ where: { id: worker.personId } })).toMatchObject({ phone, suspendedAt: null });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'support.phone_restored', target: worker.personId } });
    expect(audit.meta).toMatchObject({ operator: 'destek-ali' });
  });

  it('phone-release argümansız ve bilinmeyen numarada hata kodu döner', () => {
    expect(run('phone-release').status).toBe(1);
    const unknown = run('phone-release', [randomTrPhone(), '--operator', 'destek-ali']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('bulunamadı');
  });
});

/** Abonelik ve firma komutları. Çıkış: 0 başarı ya da değişiklik yok, 1 iş hatası, 2 kullanım hatası ya da eksik onay. */
describe('abonelik destek komutları', () => {
  const OP = ['--operator', 'destek-ali'];
  const subOf = (orgId: string) => prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'deciship' } } });
  const nameOf = async (orgId: string) => (await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).name;
  /**
   * Kayıt doğrulama postasını arka planda, kişi kilidi altında hazırlar. `spawnSync` bu sürecin olay döngüsünü durdurur: yarım kalan
   * işlem kilidi bırakmaz, komut kişiyi bekler. Komuttan önce arka plan işi biter.
   */
  async function freshOrg() {
    const owner = await registerOrg(await getApp());
    await flushMail();
    return owner;
  }

  it('subscription-set: firma adıyla geçişi yazar; aynı durum değişiklik yok; CANCELED → READ_ONLY iş hatası', async () => {
    const owner = await freshOrg();
    const name = await nameOf(owner.orgId);
    const res = run('subscription-set', [owner.orgId, 'deciship', 'READ_ONLY', ...OP, '--reason', 'deneme']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`${name} · DeciShip: ACTIVE → READ_ONLY (sürüm 2)`);
    expect(res.stdout).toContain('1 üyeliğin jetonu yenilenecek');

    const same = run('subscription-set', [owner.orgId, 'deciship', 'READ_ONLY', ...OP]);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('değişiklik yok');
    expect((await subOf(owner.orgId)).version).toBe(2);

    const cancel = run('subscription-set', [owner.orgId, 'deciship', 'CANCELED', ...OP, '--days', '7']);
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(cancel.stdout).toContain('tarihine kadar okunur');
    const back = run('subscription-set', [owner.orgId, 'deciship', 'READ_ONLY', ...OP]);
    expect(back.status).toBe(1);
    expect(back.stderr).toContain('Önce ACTIVE');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: owner.orgId, action: 'support.subscription_changed' }, orderBy: { createdAt: 'asc' } });
    expect(audit.meta).toMatchObject({ operator: 'destek-ali', via: 'set', reason: 'deneme' });
  });

  it('subscription-set kullanım hataları 2 döner ve hiçbir şey değiştirmez: operatör, UUID, ürün, durum, --days', async () => {
    const owner = await freshOrg();
    const cases: [string[], string][] = [
      [[owner.orgId, 'deciship', 'READ_ONLY'], '--operator'],
      [[owner.orgId, 'deciship', 'READ_ONLY', '--operator', '  '], '--operator'],
      [[owner.orgId.slice(0, 8), 'deciship', 'READ_ONLY', ...OP], 'UUID'],
      [['Demo Lojistik', 'deciship', 'READ_ONLY', ...OP], 'UUID'],
      [[owner.orgId, 'DeciShip', 'READ_ONLY', ...OP], 'Bilinmeyen ürün'],
      [[owner.orgId, 'deciship', 'PAUSED', ...OP], 'Durum geçersiz'],
      [[owner.orgId, 'deciship', 'CANCELED', ...OP, '--days', '0'], '--days'],
      [[owner.orgId, 'deciship', 'CANCELED', ...OP, '--days', '2.5'], '--days'],
      [[owner.orgId, 'deciship', 'READ_ONLY', ...OP, '--days', '5'], 'yalnız CANCELED'],
      [[owner.orgId, 'deciship', 'READ_ONLY', ...OP, '--bilinmeyen'], 'Kullanım'],
      [[owner.orgId, 'deciship'], 'Kullanım'],
    ];
    for (const [args, message] of cases) {
      const res = run('subscription-set', args);
      expect(res.status, `${args.join(' ')}: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain(message);
    }
    expect(await subOf(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(await prisma.auditLog.count({ where: { orgId: owner.orgId, action: 'support.subscription_changed' } })).toBe(0);
  });

  it('org-close --yes olmadan ne olacağını yazar ve 2 döner; --yes ile kapatır; org-reopen geri açar', async () => {
    const owner = await freshOrg();
    const name = await nameOf(owner.orgId);
    const dry = run('org-close', [owner.orgId, ...OP]);
    expect(dry.status).toBe(2);
    expect(dry.stdout).toContain(`${name} (${owner.orgId}) kapatılacak: DeciShip ACTIVE → CANCELED`);
    expect(dry.stderr).toContain('--yes');
    expect((await subOf(owner.orgId)).status).toBe('ACTIVE');
    expect(run('org-close', [owner.orgId, '--yes']).status).toBe(2);

    const res = run('org-close', [owner.orgId, ...OP, '--yes', '--days', '30', '--reason', 'müşteri istedi']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`${name} kapatıldı: DeciShip iptal`);
    expect((await subOf(owner.orgId)).status).toBe('CANCELED');
    const again = run('org-close', [owner.orgId, ...OP, '--yes']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('değişiklik yok');

    expect(run('org-reopen', [owner.orgId]).status).toBe(2);
    const reopen = run('org-reopen', [owner.orgId, ...OP]);
    expect(reopen.status, reopen.stderr).toBe(0);
    expect(reopen.stdout).toContain(`${name} yeniden açıldı: DeciShip ACTIVE.`);
    expect(await subOf(owner.orgId)).toMatchObject({ status: 'ACTIVE', canceledAt: null, deleteAfter: null });
    const closed = await prisma.auditLog.findFirstOrThrow({ where: { orgId: owner.orgId, action: 'support.org_closed' } });
    expect(closed.meta).toMatchObject({ operator: 'destek-ali', days: 30, reason: 'müşteri istedi' });
  });

  it('org-reopen kapatılmamış firmada iş hatası; bilinmeyen firma iş hatası', async () => {
    const owner = await freshOrg();
    const res = run('org-reopen', [owner.orgId, ...OP]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('kapatma kaydı yok');
    const unknown = run('org-close', ['00000000-0000-4000-8000-000000000000', ...OP, '--yes']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Firma bulunamadı');
  });

  it('product-launch --dry-run yazmaz; gerçek koşu aboneliği olmayan firmaya açar; operatörsüz 2', async () => {
    const owner = await freshOrg();
    await prisma.subscription.deleteMany({ where: { orgId: owner.orgId } });
    const name = await nameOf(owner.orgId);
    expect(run('product-launch', ['deciship']).status).toBe(2);
    const dry = run('product-launch', ['deciship', ...OP, '--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`açılacak: ${name} (${owner.orgId})`);
    expect(await prisma.subscription.count({ where: { orgId: owner.orgId } })).toBe(0);
    const res = run('product-launch', ['deciship', ...OP]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`açıldı: ${name} (${owner.orgId})`);
    expect(res.stdout).toMatch(/DeciShip: \d+ firmaya açıldı, \d+ firmada zaten abonelik var \(dokunulmadı\)/);
    expect(await subOf(owner.orgId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    const again = run('product-launch', ['deciship', ...OP]);
    expect(again.stdout).toContain('DeciShip: 0 firmaya açıldı');
    const off = run('product-launch', ['orderloom', ...OP]);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('yalnız public');
  });

  it('servisin açılışta reddedeceği PRODUCT_LAUNCH ile komut çalışmaz (çıkış 1), abonelik yazılmaz', async () => {
    const owner = await freshOrg();
    const bad = { PRODUCT_LAUNCH: 'orderloom=pilot' };
    const res = run('subscription-set', [owner.orgId, 'orderloom', 'ACTIVE', ...OP], bad);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PRODUCT_LAUNCH');
    expect(await prisma.subscription.count({ where: { orgId: owner.orgId, product: 'orderloom' } })).toBe(0);
    // Yazmayan komutlar da durur: yanlış ortamda yanlış sonuç vermesin.
    expect(run('org-list', ['--limit', '1'], bad).status).toBe(1);
    expect(run('subscription-set', [owner.orgId, 'deciship', 'READ_ONLY', ...OP], { PRODUCT_LAUNCH: 'deciship=beta' }).status).toBe(1);
    expect((await subOf(owner.orgId)).status).toBe('ACTIVE');
    // Geçerli ama uyarılı ayar: komut çalışır, uyarı stderr'e yazılır.
    const warned = run('org-list', ['--limit', '1'], { PRODUCT_LAUNCH: 'deciship=off' });
    expect(warned.status, warned.stderr).toBe(0);
    expect(warned.stderr).toContain('UYARI');
  });

  it('members-announce firma adıyla duyurur, epoch artmaz; org-list --json ve düz çıktı', async () => {
    const app = await getApp();
    const owner = await registerOrg(app);
    await addMember(app, owner.orgId, { deciship: 'MEASURE' });
    await flushMail();
    const name = await nameOf(owner.orgId);
    const epoch0 = (await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId } })).epoch;
    const res = run('members-announce', ['deciship', '--org', owner.orgId]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`${name} · DeciShip: 2 üyelik yeniden duyuruldu.`);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: owner.membershipId } })).epoch).toBe(epoch0);
    expect(run('members-announce', ['deciship', '--org', 'abc']).status).toBe(2);
    expect(run('members-announce', ['orderloom']).status).toBe(1);

    const list = run('org-list', ['--q', name, '--json']);
    expect(list.status, list.stderr).toBe(0);
    const rows = JSON.parse(list.stdout) as { id: string; ownerEmail: string; members: { total: number } }[];
    expect(rows).toEqual([expect.objectContaining({ id: owner.orgId, ownerEmail: owner.email, members: { active: 2, total: 2 } })]);
    const plain = run('org-list', ['--q', name]);
    expect(plain.stdout).toContain(`${owner.orgId} · ${name} · TR · `);
    expect(plain.stdout).toContain('deciship:ACTIVE/early_access');
    expect(run('org-list', ['--status', 'PAUSED']).status).toBe(2);
    expect(run('org-list', ['--limit', '0']).status).toBe(2);
  });
});
