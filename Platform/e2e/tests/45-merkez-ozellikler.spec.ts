import fs from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { test, expect } from '../lib/fixtures.ts';
import { FEDEX_INVOICE, MobileApi, SAMPLE_PERIOD, addCarrierAndTariff, confirmCompany, loadMeasurements, measurementBody, provisionDeciship, registerOwner, sampleMeasurements, uploadInvoice, type WebApi } from '../lib/api.ts';
import { APP, SAMPLES, recordMetric } from '../lib/sys.ts';
import { openLanguage } from '../lib/shell.ts';

const money = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '');
/** Bugünden `n` gün önce, firmanın saat diliminde. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });

type Overview = {
  alerts: { title: string; dueAt?: string }[];
  leaders?: { id: string; label: string; name: string; value: { value: number } }[];
  setup?: { completed: boolean; href: string; steps?: { id: string; label: string; done: boolean; required: boolean; href: string }[] };
};

/** İkinci fatura: aynı örnek değil, kendi dosyası ve eşlemesiyle. */
async function uploadSecondInvoice(api: WebApi, carrierId: string, date: string) {
  const expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected.json'), 'utf8')) as { invoices: { file: string; invoiceNo: string; currency: string; suggestedMapping: unknown }[] };
  const inv = expected.invoices.find((i) => i.file.includes('11736'))!;
  const pv = await api.ctx.post('/api/deciship/invoices/preview', {
    headers: { 'X-SOD-Org': api.orgId! },
    multipart: { carrierId, file: { name: path.basename(inv.file), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fs.readFileSync(path.join(SAMPLES, inv.file)) } },
  });
  expect(pv.ok(), await pv.text()).toBeTruthy();
  const preview = await pv.json();
  await api.post('/api/deciship/invoices', { fileId: preview.fileId, carrierId, invoiceNo: inv.invoiceNo, invoiceDate: date, currency: inv.currency, mapping: inv.suggestedMapping, acknowledgeIssues: true });
}

test.describe('Merkez: son gün, başlangıç, kaçak, firma başlığı, yoğunluk', () => {
  test('dueAt: itiraz son günü rozetle yazılır, bugün biten en üstte', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Son Gün Lojistik' });
    // Kurulu firma: Merkez'de onaylı (yoksa Genel Bakış yerine başlangıç sayfası açılır).
    await confirmCompany(owner.api);
    const { carrierId } = await addCarrierAndTariff(owner.api);
    await loadMeasurements(owner.email, owner.password);
    // İtiraz süresi fatura tarihinden 8 gün: biri bugün biter, biri 3 gün sonra.
    await uploadInvoice(owner.api, carrierId, { ...FEDEX_INVOICE, date: daysAgo(8) });
    await uploadSecondInvoice(owner.api, carrierId, daysAgo(5));

    const ov = await owner.api.get<Overview>(`/api/deciship/platform/overview?from=${daysAgo(29)}&to=${daysAgo(0)}`);
    const due = ov.alerts.filter((a) => a.dueAt).map((a) => a.dueAt);
    expect(due).toContain(daysAgo(0));
    expect(due).toContain(daysAgo(-3));

    const page = await openAs(owner.api);
    await page.goto('/home');
    const queue = page.locator('.hub-queue');
    await expect(queue).toContainText('Son gün bugün');
    await expect(queue).toContainText('3 gün kaldı');
    const items = queue.locator('li');
    await expect(items.first()).toContainText('Son gün bugün');
    await expect(items.first()).toContainText(FEDEX_INVOICE.no);
    await page.reload();

    await (await openLanguage(page)).getByRole('menuitemradio', { name: 'English' }).click();
    await expect(queue.locator('li').first()).not.toContainText('Son gün');
    await expect(queue).toContainText(/3 days left/i);
  });

  test('setup.steps: başlangıç sayfası aracın API adımlarını sayar, sıradaki adıma götürür, adım bitince sayaç ilerler', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Başlangıç Lojistik' });
    // Merkez kurulumu (firma onayı) burada API ile; arayüzdeki akış 10-site-kayit ve 30-kurulum-fatura'da.
    await confirmCompany(owner.api);
    const read = () => owner.api.get<Overview>(`/api/deciship/platform/overview?from=${daysAgo(29)}&to=${daysAgo(0)}`);
    const before = await read();
    expect(before.setup?.completed).toBe(false);
    const steps = before.setup!.steps!;
    const required = steps.filter((s) => s.required);
    expect(required.length).toBeGreaterThan(0);
    const doneBefore = required.filter((s) => s.done).length;
    const first = required.find((s) => !s.done)!;

    const page = await openAs(owner.api);
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Genel Bakış', level: 1 })).toBeVisible();
    // Merkez kurulumu: zorunlu tek adım (firma onayı) tamam, ekip isteğe bağlı.
    const hubSetup = page.getByRole('region', { name: 'Merkez kurulumu' });
    await expect(hubSetup.locator('.hub-start-count')).toHaveText('1/1');
    await expect(hubSetup).toContainText('Ekibi davet edin');
    // Araç kurulumu: sayaç ve "Sıradaki" aracın overview `setup.steps`'inden (Merkez adım bilmez).
    const row = page.getByRole('region', { name: 'Araç kurulumları' }).locator('li', { hasText: 'DeciShip' });
    await expect(row).toContainText(`${doneBefore}/${required.length} adım · Sıradaki: ${first.label}`);
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(doneBefore));
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuemax', String(required.length));

    // Sıradaki adım gerçek kurulum sayfasına gider
    const go = row.getByRole('link', { name: 'Kuruluma devam et' });
    await expect(go).toHaveAttribute('href', first.href);
    await go.click();
    await expect(page).toHaveURL(new RegExp(first.href.split('?')[0]!));

    // Sihirbazla taşıyıcı eklenince sayaç API ile birlikte ilerler
    await page.locator('label.ob-car', { hasText: 'FedEx' }).click();
    await page.getByRole('button', { name: 'Ekle ve devam et' }).click();
    await expect(page.locator('#ob-step-title')).toContainText('Örnek faturalar');
    const after = await read();
    const requiredAfter = after.setup!.steps!.filter((s) => s.required);
    const doneAfter = requiredAfter.filter((s) => s.done).length;
    expect(doneAfter).toBeGreaterThan(doneBefore);
    const nextAfter = requiredAfter.find((s) => !s.done)!;
    await page.goto('/home');
    await expect(row).toContainText(`${doneAfter}/${required.length} adım · Sıradaki: ${nextAfter.label}`);
    await expect(row.getByRole('link', { name: 'Kuruluma devam et' })).toHaveAttribute('href', nextAfter.href);
  });

  test('leaders: en çok fazla ödeme çıkanlar API ile kuruşuna aynı (TR+EN)', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Kaçak Lojistik' });
    await provisionDeciship(owner);
    const q = SAMPLE_PERIOD.query;
    const ov = await owner.api.get<Overview>(`/api/deciship/platform/overview?${q}`);
    expect(ov.leaders?.length).toBeGreaterThan(0);
    const fedex = ov.leaders!.find((l) => l.name === 'FedEx')!;
    expect(fedex.value.value).toBe(FEDEX_INVOICE.overcharge);

    const page = await openAs(owner.api);
    await page.goto(`/home?range=custom&${q}`);
    const box = page.locator('.hub-topleak');
    await expect(box.getByRole('heading', { name: 'En çok fazla ödeme çıkanlar' })).toBeVisible();
    await expect(box.locator('li', { hasText: 'FedEx' }).locator('.amt')).toHaveText(/611,20/);
    // En çok tutan tür ölçü farkı (#5305); #5288 mükerreri "İncele", fazla ödemeye ve bu listeye girmez (KALANLAR 1.8)
    await expect(box.locator('li', { hasText: 'Ölçü farkı' }).locator('.amt')).toHaveText(/458,50/);
    await expect(box.locator('li', { hasText: 'Mükerrer' })).toHaveCount(0);
    // Pay ("toplamın %100 kadarı") .amt içinde yalnız ekran okuyucuya: görünen tutar baş rakamla aynı.
    const fedexAmt = box.locator('li', { hasText: 'FedEx' }).locator('.amt');
    await expect(fedexAmt.locator('.sr-only')).toHaveText(/toplamın %\s?100 kadarı/);
    const shown = await fedexAmt.evaluate((el) => Array.from(el.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only'))).map((n) => n.textContent).join(''));
    expect(money(shown)).toBe(money(await page.locator('.hub-hero').innerText()));

    await (await openLanguage(page)).getByRole('menuitemradio', { name: 'English' }).click();
    await expect(box.locator('li', { hasText: 'FedEx' }).locator('.amt')).toHaveText(/611\.20/);
    await expect(box.locator('li', { hasText: 'Dimension discrepancy' }).locator('.amt')).toHaveText(/458\.50/);
  });

  test('X-SOD-Org: çerezli yazma başlıksız ve yanlış firmayla 409, doğru firmayla geçer; Bearer ve okuma muaf', async () => {
    const owner = await registerOwner({ orgName: 'Başlık Alfa' });
    const alfa = owner.me.activeOrg!.id;
    const ctx = owner.api.raw();
    const code = async (r: Awaited<ReturnType<typeof ctx.post>>) => ((await r.json()) as { error?: { code?: string } }).error?.code;

    for (const [name, call] of [
      ['Hesap', (h: Record<string, string>) => ctx.patch('/api/account/org', { data: { name: 'Başlık Alfa' }, headers: h })],
      ['DeciShip', (h: Record<string, string>) => ctx.post('/api/deciship/carriers', { data: { code: 'ups' }, headers: h })],
    ] as const) {
      const none = await call({});
      expect(none.status(), `${name} başlıksız`).toBe(409);
      expect(await code(none)).toBe('ORG_MISMATCH');
      const wrong = await call({ 'X-SOD-Org': '00000000-0000-7000-8000-000000000000' });
      expect(wrong.status(), `${name} yanlış firma`).toBe(409);
      expect(await code(wrong)).toBe('ORG_MISMATCH');
      const right = await call({ 'X-SOD-Org': alfa });
      expect(right.status(), `${name} doğru firma`).toBeLessThan(300);
    }

    // Okuma ve oturum uçları başlık istemez
    expect((await ctx.get('/api/deciship/carriers')).status()).toBe(200);
    expect((await ctx.get('/api/account/me')).status()).toBe(200);
    await owner.api.post('/api/account/orgs', { name: 'Başlık Beta', country: 'TR' });
    expect((await ctx.post('/api/account/auth/switch-org', { data: { orgId: alfa } })).status()).toBe(200);

    // Bearer: başlık gerekmez
    const mobile = await MobileApi.login(owner.email, owner.password);
    const m = await mobile.postMeasurement({ ...measurementBody(sampleMeasurements()[0]!), trackingRaw: `BAS${Date.now()}` });
    expect(m.status, m.text).toBe(201);
    await mobile.dispose();
  });

  test('firma başına sınır: 429 + Retry-After, başka firma etkilenmez, tarayıcı bekleyip yeniden dener, bölüm hatası çıkmaz', async ({ openAs }) => {
    const owner = await registerOwner({ orgName: 'Yoğun Lojistik' });
    await provisionDeciship(owner);
    const other = await registerOwner({ orgName: 'Sakin Lojistik' });
    await provisionDeciship(other);
    const url = `/api/deciship/platform/analytics?${SAMPLE_PERIOD.query}`;
    const burst = (n: number) => Promise.all(Array.from({ length: n }, () => owner.api.raw().get(url)));

    const res = await burst(40);
    const statuses = res.map((r) => r.status());
    recordMetric('limit_40_paralel', statuses.reduce<Record<number, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}) as unknown as string);
    expect(statuses.every((s) => s === 200 || s === 429), statuses.join()).toBe(true);
    const limited = res.filter((r) => r.status() === 429);
    expect(limited.length, 'sınır çalışmalı').toBeGreaterThan(0);
    expect(Number(limited[0]!.headers()['retry-after'])).toBeGreaterThan(0);
    expect(((await limited[0]!.json()) as { error: { code: string } }).error.code).toBe('TOO_MANY_REQUESTS');

    // Yuvalar boşaldı
    await expect.poll(async () => (await owner.api.raw().get(url)).status(), { timeout: 10_000 }).toBe(200);

    // Aynı anda başka firma sınıra takılmaz
    const during = burst(40);
    const calm = await Promise.all(Array.from({ length: 4 }, () => other.api.raw().get(url)));
    expect(calm.map((r) => r.status())).toEqual([200, 200, 200, 200]);
    await during;

    // Tarayıcı: yük sürerken /home açılır
    const page = await openAs(owner.api);
    const seen: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/platform/overview')) seen.push(r.status());
    });
    // Boşluksuz yük: dört koşucu art arda istek atar. Tarayıcı sınıra rastlayana kadar sayfa yeniden açılır.
    let run = true;
    const runners = Array.from({ length: 4 }, async () => {
      while (run) await burst(10);
    });
    let gotoAt = Date.now();
    for (let i = 0; i < 12 && !seen.includes(429); i += 1) {
      gotoAt = Date.now();
      await page.goto(`/home?${SAMPLE_PERIOD.hub}`);
      await page.waitForResponse((r) => r.url().includes('/platform/overview'), { timeout: 15_000 }).catch(() => undefined);
    }
    run = false;
    expect(seen.includes(429), `tarayıcı sınıra takılmalı: ${seen.join()}`).toBe(true);
    await Promise.all(runners);
    await expect(page.locator('.hub-hero')).toContainText('611,20', { timeout: 20_000 });
    recordMetric('limit_tarayici_yeniden_deneme_ms', Date.now() - gotoAt);
    expect(seen.at(-1)).toBe(200);
    await expect(page.getByText('DeciShip verisi alınamadı.')).toHaveCount(0);
  });
});

test('güvenlik: bu dosya gerçek sisteme gider', async () => {
  const ctx = await request.newContext({ baseURL: APP });
  expect((await ctx.get('/api/deciship/health')).status()).toBe(200);
  await ctx.dispose();
});
