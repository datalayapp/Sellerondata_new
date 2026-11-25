// TagPress platform kipinde: Merkez'den açılır, kabuk bandında çalışır, işi Merkez Genel Bakış'a yansır, rolleri Ekip'te,
// Kullanıcı rolü ayarları görmez, firma değişince veri karışmaz. Araç kayıtta kapalıyken (`launch: 'off'`) bu dosyada senaryo
// yoktur (atlanmaz: liste boştur); `pilot`te firmaya abonelik `openTool` ile verilir, `public`te kayıt açar.
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { PASSWORD, WebApi, provisionDeciship, registerOwner, type Owner } from '../lib/api.ts';
import { RUNNING_PRODUCTS, addTagpressJob, openTool, productRoles } from '../lib/products.ts';
import { APP, uniq } from '../lib/sys.ts';
import { openApps } from '../lib/shell.ts';

type Kpi = { id: string; label: string; value: number | null };

async function jobsKpi(api: WebApi): Promise<Kpi> {
  const o = await api.get<{ kpis: Kpi[] }>('/api/tagpress/platform/overview');
  const k = o.kpis.find((x) => x.id === 'jobs');
  if (!k) throw new Error('TagPress Genel Bakış yanıtında `jobs` göstergesi yok');
  return k;
}

/** Üye: e-posta davetini API ile kabul eder. Açık araçlarda davet rolü, TagPress'te verilen rol. */
async function addMember(owner: Owner, tagpress: string, name: string) {
  const email = `${uniq('uye')}@e2e.sellerondata.test`;
  const roles = { ...productRoles(), tagpress };
  const inv = await owner.api.post<{ link: string }>('/api/account/org/members/invite', { kind: 'EMAIL', email, name, orgRole: 'MEMBER', productRoles: roles });
  const token = new URL(inv.link).pathname.split('/').pop()!;
  const api = await WebApi.create();
  await api.post(`/api/account/invites/${token}/accept`, { name, password: PASSWORD, client: 'web' });
  const me = await api.me();
  return { api, email, name, me };
}

async function switchOrg(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: `Firma: ${from}` }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(to) }).click();
  await expect(page.getByRole('button', { name: `Firma: ${to}` })).toBeVisible();
}

const selectedRole = (page: Page, person: string) => page.getByRole('combobox', { name: `${person} TagPress rolü` }).locator('option:checked');

for (const product of RUNNING_PRODUCTS.filter((p) => p.key === 'tagpress')) {
  test.describe(`${product.name}: platform kipi`, () => {
    test('Merkez\'den açılır, iş Genel Bakış\'a yansır, roller Ekip\'te, Kullanıcı ayarları görmez, firma değişince veri karışmaz', async ({ openAs }) => {
      test.setTimeout(300_000);
      const tag = uniq('').toUpperCase();
      const owner = await registerOwner({ orgName: `Etiket Atölye ${tag}` });
      // DeciShip kurulu: Merkez başlangıç sayfası yerine Genel Bakış açılır (bütün araçların kurulumu açıkken başlangıç sayfası).
      await provisionDeciship(owner);
      await openTool(owner, product.key);
      const orgA = owner.me.activeOrg!.name;

      // ⊞ menüsünde TagPress; tıklayınca /tagpress/ kabuk bandıyla, yeniden giriş yok.
      const page = await openAs(owner.api);
      await page.goto('/home');
      const apps = await openApps(page);
      const item = apps.getByRole('menuitem', { name: new RegExp(product.name) });
      await expect(item).toHaveAttribute('href', `/${product.key}/`);
      await item.click();
      await expect(page).toHaveURL(new RegExp(`${APP}/${product.key}/`));
      await expect(page).not.toHaveURL(/login/);
      await expect(page.locator('.sod-brand-n')).toHaveText(product.name);
      await expect(page.getByRole('button', { name: `Firma: ${orgA}` })).toBeVisible();

      // İş eklenir: TagPress üretim listesinde görünür, Merkez'in `jobs` göstergesi bir artar.
      const before = await jobsKpi(owner.api);
      const job = await addTagpressJob(owner.api, tag);
      await page.goto(`/${product.key}/#/uretim`);
      await expect(page.locator('body')).toContainText(job.orderNo);
      const after = await jobsKpi(owner.api);
      expect(after.value).toBe((before.value ?? 0) + 1);

      await page.goto(`/home?tool=${product.key}`);
      const detail = page.locator(`section[aria-labelledby="hub-detail-${product.key}"]`);
      const row = detail.locator('.hub-ledger-row', { hasText: after.label });
      await expect(row.locator('.hub-ledger-value')).toHaveText(String(after.value));

      // Ekip: TagPress sütunu, sahip Yönetici, davetle gelen üye Kullanıcı.
      const member = await addMember(owner, 'USER', 'Kerem Kullanıcı');
      expect(member.me.products.find((p) => p.key === product.key)?.role).toBe('USER');
      await page.goto('/account/team');
      await expect(page.getByRole('heading', { name: 'Ekip ve yetkiler' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: product.name })).toBeVisible();
      await expect(selectedRole(page, owner.name)).toHaveText('Yönetici');
      await expect(selectedRole(page, member.name)).toHaveText('Kullanıcı');

      // Kullanıcı rolü Ayarlar › Özellikler'i görmez, özellik değiştiremez; sahip görür.
      await page.goto(`/${product.key}/#/ayarlar/ozellikler`);
      await expect(page.getByRole('button', { name: 'Özellikler', exact: true })).toBeVisible();
      const memberPage = await openAs(member.api);
      await memberPage.goto(`/${product.key}/#/ayarlar/ozellikler`);
      await memberPage.waitForLoadState('networkidle');
      await expect(memberPage).not.toHaveURL(/login/);
      await expect(memberPage.getByRole('button', { name: 'Özellikler', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('heading', { name: 'Özellikler', exact: true })).toHaveCount(0);
      const patch = await member.api.raw().patch('/api/tagpress/features', { data: {}, headers: { 'X-SOD-Org': owner.me.activeOrg!.id } });
      expect(patch.status()).toBe(403);
      expect(((await patch.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
      await member.api.dispose();

      // Firma değiştirme: ikinci firmada A'nın işi görünmez; geri dönünce yerinde.
      const orgB = `Etiket İkinci ${tag}`;
      await owner.api.post('/api/account/orgs', { name: orgB, country: 'TR' });
      await owner.api.me();
      await owner.api.post('/api/account/auth/switch-org', { orgId: owner.me.activeOrg!.id });
      owner.me = await owner.api.me();
      await page.goto(`/${product.key}/#/uretim`);
      await expect(page.locator('body')).toContainText(job.orderNo);
      await switchOrg(page, orgA, orgB);
      await page.goto(`/${product.key}/#/uretim`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('body')).not.toContainText(job.orderNo);
      // Geri dönüş Merkez'den: pilotta ikinci firmanın TagPress aboneliği yoktur, araç sayfası erişim ekranı olabilir.
      await page.goto('/home');
      await switchOrg(page, orgB, orgA);
      await page.goto(`/${product.key}/#/uretim`);
      await expect(page.locator('body')).toContainText(job.orderNo);
    });
  });
}
