import { expect, test, type Locator, type Page } from '@playwright/test';
import { APP, mockSession, type Person } from '../helpers';

/*
 * Görsel karşılaştırma (Mesaj 12 §3.6). Yalnız `playwright.visual.config.ts` koşar; olağan `npm run test:e2e` bu klasörü atlar.
 * Görüntü adı: deciship-<dil>-<genişlik>-<ekran>.png (taban klasörü VISUAL_DIR).
 *
 * Sabitlenenler: saat (page.clock.setFixedTime 2026-11-10T10:00+03:00), animasyon (animations: 'disabled'), imleç (caret: 'hide'),
 * mock gecikmesi (sod_mock_fast=1), yazı tipi (document.fonts.ready), yükleme iskeleti (.skel sıfır olana kadar beklenir).
 *
 * TOLERANS: toHaveScreenshot maxDiffPixels 40, threshold 0.2. Yuvarlak köşe kenar yumuşatması koşudan koşuya birkaç piksel oynuyor
 * (1-25 piksel gözlendi); gerçek stil farkı (dolgu, köşe, gölge, renk, yerleşim) yüzlerce piksel üretir. Stiller kapatılmaz.
 *
 * MASKELENENLER: şimdilik yok. Kararsızlık denetimi (ikinci koşu) bir ekranı değiştirirse seçici aşağıdaki MASKS tablosuna
 * ekran adıyla eklenir ve neden yanına yazılır (ör. 'olcumler-1440': ['.dt .rel-time'] // göreli saat). Listeden çıkarılan ekran da buraya yorumlanır.
 */
const MASKS: Record<string, string[]> = {};

const FIXED_NOW = new Date('2026-11-10T10:00:00+03:00');
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

type Lang = 'tr' | 'en';

async function open(page: Page, person: Person, lang: Lang = 'tr', hooks: Record<string, string> = {}) {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockSession(page, person, { sod_mock_locale: lang, ...hooks });
  await page.evaluate((l) => {
    document.cookie = `sod_lang=${l}; Path=/`;
  }, lang);
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skel')).toHaveCount(0, { timeout: 8000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function snap(page: Page, key: string, name: string, fullPage = false, pose?: (p: Page) => Promise<void>) {
  // Kararlılık: geçişler ve bulanıklık kapatılır, imleç sayfa dışına alınır (hover kalıntısı olmasın). Köşe, gölge ve renkler korunur.
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;scroll-behavior:auto!important}' });
  await page.mouse.move(0, 0);
  await settle(page);
  // Bildirim ekranlarında (x04, x05) tıklanan öğe odakta kalmasın: odak halkası kenar pikselleri titreyebilir.
  if (/^x0[45]-/.test(key)) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Y105: üstüne gelme ve odak hâli imleç sıfırlanıp sayfa durulduktan sonra kurulur (yukarıdaki mouse.move onu silmesin).
  if (pose) await pose(page);
  const mask = (MASKS[key] ?? []).map((s) => page.locator(s));
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage, animations: 'disabled', caret: 'hide', maxDiffPixels: 40, threshold: 0.2, mask });
}

const rowSel = 'table.dt tbody tr.clickable';

interface Shot {
  id: string;
  person: Person;
  hooks?: Record<string, string>;
  full?: boolean;
  /** yalnız bu genişlikte (varsayılan: ikisi de) */
  only?: number;
  run: (page: Page) => Promise<void>;
}

/** `scripts/platform-shots.mjs` içindeki 23 ekran (aynı sıra ve numara). Çekmece (10) yalnız 390'da vardır (orada < 1024). */
const SCREENS: Shot[] = [
  { id: '01-pano', person: 'owner', run: async (p) => { await p.goto(`${APP}/`); await p.waitForSelector('.dash-hero-v:not(:has(.skel))'); } },
  { id: '02-olcumler', person: 'owner', run: async (p) => { await p.goto(`${APP}/measurements`); await p.waitForSelector(rowSel); } },
  { id: '03-olcum-panel', person: 'owner', run: async (p) => { await p.goto(`${APP}/measurements`); await p.waitForSelector(rowSel); await p.click(rowSel); await p.waitForSelector('.panel .cmp'); } },
  { id: '04-faturalar', person: 'owner', run: async (p) => { await p.goto(`${APP}/invoices`); await p.waitForSelector(rowSel); } },
  { id: '05-fatura-detay', person: 'owner', run: async (p) => { await p.goto(`${APP}/invoices`); await p.waitForSelector(rowSel); await p.click(rowSel); await p.waitForSelector('.lines-dt tbody tr'); } },
  {
    id: '06-fatura-satir',
    person: 'owner',
    run: async (p) => { await p.goto(`${APP}/invoices`); await p.waitForSelector(rowSel); await p.click(rowSel); await p.waitForSelector('.lines-dt tbody tr'); await p.click('.lines-dt tbody tr.clickable'); await p.waitForSelector('.panel .pn-sub'); },
  },
  { id: '07-tarifeler', person: 'owner', run: async (p) => { await p.goto(`${APP}/tariffs`); await p.waitForSelector('.tl-table tbody tr, .empty'); } },
  { id: '08-tarife-duzenle', person: 'owner', run: async (p) => { await p.goto(`${APP}/tariffs/t1`); await p.waitForSelector('.te-main'); } },
  { id: '09-ayarlar', person: 'owner', full: true, run: async (p) => { await p.goto(`${APP}/settings`); await p.waitForSelector('#s-name'); } },
  // 10-cekmece (390'da çekmece) çıkarıldı: güncel arayüzde .sod-burger / çekmece yok, 390'da menü üst şeritte bağlantı olarak durur (platform-shots.mjs eski).
  { id: '11-kurulum', person: 'fresh', run: async (p) => { await p.goto(`${APP}/`); await p.waitForSelector('.ob-main'); } },
  { id: '12-kurulum-ozet', person: 'fresh', full: true, run: async (p) => { await p.goto(`${APP}/setup?adim=ozet`); await p.waitForSelector('.ds-team'); } },
  { id: '13-muhasebe-fatura', person: 'accounting', run: async (p) => { await p.goto(`${APP}/invoices/i1`); await p.waitForSelector('.lines-dt tbody tr'); } },
  { id: '14-izin-yok', person: 'accounting', run: async (p) => { await p.goto(`${APP}/tariffs/new`); await p.waitForSelector('.ds-access-card'); } },
  { id: '15-mobil-rol', person: 'measure', run: async (p) => { await p.goto(`${APP}/`); await p.waitForSelector('.ds-access-card'); } },
  { id: '16-erisim-yok', person: 'noRole', run: async (p) => { await p.goto(`${APP}/`); await p.waitForSelector('.ds-access-card'); } },
  { id: '17-salt-okunur', person: 'owner', hooks: { sod_mock_readonly: '1' }, run: async (p) => { await p.goto(`${APP}/invoices`); await p.waitForSelector(rowSel); } },
  { id: '18-salt-okunur-tarife', person: 'owner', hooks: { sod_mock_readonly: '1' }, run: async (p) => { await p.goto(`${APP}/tariffs/t1`); await p.waitForSelector('.te-main'); } },
  {
    id: '19-hesap-kesik',
    person: 'owner',
    run: async (p) => {
      await p.goto(`${APP}/invoices`);
      await p.waitForSelector(rowSel);
      await p.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
      await p.reload();
      await p.waitForSelector('.sod-status');
      await p.waitForSelector(rowSel);
    },
  },
  { id: '20-muhasebe-tarifeler', person: 'accounting', run: async (p) => { await p.goto(`${APP}/tariffs`); await p.waitForSelector('.tl-table tbody tr'); } },
  {
    id: '21-muhasebe-tarife',
    person: 'accounting',
    run: async (p) => {
      await p.goto(`${APP}/tariffs/t1`);
      await p.waitForSelector('fieldset.te-ro #t-name');
      await p.fill('#q-c', 'DE');
      await p.click('.qt-btn');
      await p.waitForSelector('.quote-res');
    },
  },
  {
    id: '22-muhasebe-tarife-tam',
    person: 'accounting',
    full: true,
    run: async (p) => {
      await p.goto(`${APP}/tariffs/t1`);
      await p.waitForSelector('fieldset.te-ro #t-name');
      await p.fill('#q-c', 'DE');
      await p.click('.qt-btn');
      await p.waitForSelector('.quote-res');
    },
  },
  { id: '23-askida', person: 'accounting', hooks: { sod_mock_suspended: '1' }, run: async (p) => { await p.goto(`${APP}/invoices`); await p.waitForSelector('.ds-access-card'); } },
];

/** Plan §3.6 ek durumlar (TR, iki genişlik). Seçiciler mevcut e2e desenlerinden (unsaved-guards, flow-review, MeasurementPanel). */
async function openInvoiceMenu(p: Page) {
  await p.goto(`${APP}/invoices`);
  await p.locator('.inv-list td.card-title', { hasText: '9-482-11735' }).first().click();
  await p.locator('.inv-more').getByRole('button', { name: 'Diğer' }).click();
}
async function openInvoiceEdit(p: Page) {
  await openInvoiceMenu(p);
  await p.getByRole('menuitem', { name: 'Düzenle' }).click();
  await p.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' }).waitFor();
}

const EXTRAS: Shot[] = [
  { id: 'x01-fatura-duzenle-pencere', person: 'owner', run: openInvoiceEdit },
  {
    id: 'x02-fatura-duzenle-esc-onay-seridi',
    person: 'owner',
    run: async (p) => {
      await openInvoiceEdit(p);
      await p.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' }).locator('#e-ino').fill('YENI-NO-1');
      await p.keyboard.press('Escape');
      await p.getByRole('dialog', { name: 'Fatura bilgilerini düzenle' }).getByRole('alert').filter({ hasText: 'Yazdıklarınız silinsin mi?' }).waitFor();
    },
  },
  { id: 'x03-diger-menusu-acik', person: 'owner', run: async (p) => { await openInvoiceMenu(p); await p.getByRole('menuitem', { name: 'Düzenle' }).waitFor(); } },
  {
    id: 'x04-bildirim-ayarlar-kaydet',
    person: 'owner',
    run: async (p) => {
      await p.goto(`${APP}/settings`);
      await p.locator('#s-edge').fill('0.7');
      await p.getByRole('button', { name: 'Kaydet' }).first().click();
      await p.locator('.toast').first().waitFor();
    },
  },
  {
    id: 'x05-bildirim-geri-al-eylemli',
    person: 'owner',
    run: async (p) => {
      await p.goto(`${APP}/measurements`);
      await p.waitForSelector(rowSel);
      await p.click(rowSel);
      const panel = p.locator('.panel');
      await panel.waitFor();
      await panel.getByRole('button', { name: 'Ölçümü sil' }).click();
      await p.getByRole('dialog').getByRole('button', { name: 'Sil' }).click();
      await p.locator('.toast', { hasText: 'Ölçüm silindi' }).waitFor();
    },
  },
  {
    // Mock listede sayfa boyutundan fazla kayıt yoksa sayfalayıcı çıkmaz; ekran yine de alınır (taban "sayfalayıcı yok" halidir).
    id: 'x06-sayfalayicili-liste',
    person: 'owner',
    run: async (p) => { await p.goto(`${APP}/measurements?page=1`); await p.waitForSelector(rowSel); },
  },
  {
    // Boş firma (p9/o3): liste sayfası boş durumu ya da kurulum yönlendirmesi; ne açılıyorsa o taban olur.
    id: 'x07-bos-durum',
    person: 'fresh',
    run: async (p) => { await p.goto(`${APP}/invoices`); },
  },
  {
    // Mock sunucu hata düğmesi: hesap servisi kesik bandı (sod_mock_account_down), 19 ile aynı kanca; ek olarak liste sorgusuna ölçüm hatası yoktur.
    id: 'x08-hata-durumu',
    person: 'owner',
    run: async (p) => {
      await p.goto(`${APP}/measurements`);
      await p.waitForSelector(rowSel);
      await p.evaluate(() => localStorage.setItem('sod_mock_account_down', '1'));
      await p.reload();
      await p.waitForSelector('.sod-status');
    },
  },
  {
    id: 'x09-olcum-yan-paneli-acik',
    person: 'owner',
    run: async (p) => { await p.goto(`${APP}/measurements`); await p.waitForSelector(rowSel); await p.click(rowSel); await p.waitForSelector('.panel .cmp'); },
  },
  {
    // Ayarlar'da tolerans boş + Kaydet: alan hatası (touched).
    id: 'x10-form-hatasi',
    person: 'owner',
    run: async (p) => {
      await p.goto(`${APP}/settings`);
      await p.locator('#s-edge').fill('');
      await p.getByRole('button', { name: 'Kaydet' }).first().click();
    },
  },
];

/*
 * Y105 · 600–767 px kart tabloları. Kabuğun medya kuralı (≤ 767 px) açıktır; DeciShip tablosu ise kendi kabının genişliğine
 * bakar (kap sorgusu dtw: < 600 kart, 600+ tablo; app.css "Tablo kart kipi"). 720'de kap 600'ün üstünde kalır: kabuğun kart
 * kuralını geri alan tablo düzeni çizilir. 620'de kap 600'ün altına iner: kart. Bu aralık 1440 ve 390 tabanlarında hiç görünmez.
 * Her ekran beklenen kipte olduğunu (başlık satırı görünür mü) çekmeden önce doğrular: kip kayarsa taban sessizce değişmesin.
 */
const MID_SIZES = [
  { width: 720, height: 900, cards: false },
  { width: 620, height: 900, cards: true },
] as const;

async function expectTableMode(p: Page, table: string, cards: boolean) {
  const head = p.locator(`${table} thead`).first();
  await expect(head, cards ? `${table} kart olmalı` : `${table} tablo olmalı`).toBeAttached();
  expect(await head.evaluate((el) => getComputedStyle(el).display), `${table} kipi`).toBe(cards ? 'none' : 'table-header-group');
}

interface MidShot {
  id: string;
  person: Person;
  hooks?: Record<string, string>;
  table: string;
  /** tablo ilk ekranın altında kalıyorsa tam sayfa */
  full?: boolean;
  run: (page: Page) => Promise<void>;
}

/** Doğrudan adresle açılır: listeden tıklamak fare etkileşimi sayılır, sonraki odak :focus-visible olmaz. */
const openInvoiceI1 = async (p: Page) => {
  await p.goto(`${APP}/invoices/i1`);
  await p.waitForSelector('.lines-dt tbody tr');
};

const MID_SCREENS: MidShot[] = [
  { id: 'm01-pano', person: 'owner', table: '.dt.dt-cards', run: SCREENS[0].run },
  { id: 'm02-olcumler', person: 'owner', table: '.m-table', run: SCREENS[1].run },
  { id: 'm03-faturalar', person: 'owner', table: '.inv-list', run: SCREENS[3].run },
  { id: 'm04-fatura-satirlari', person: 'owner', table: '.lines-dt', full: true, run: openInvoiceI1 },
  { id: 'm05-tarifeler', person: 'owner', table: '.tl-table', run: async (p) => { await p.goto(`${APP}/tariffs`); await p.waitForSelector('.tl-table tbody tr'); } },
  { id: 'm06-itirazlar', person: 'owner', hooks: { sod_mock_disputes: '1' }, table: '.dsp-list', full: true, run: async (p) => { await p.goto(`${APP}/disputes`); await p.waitForSelector('.dsp-list tbody tr'); } },
];

for (const { width, height, cards } of MID_SIZES) {
  test.describe(`DeciShip TR ${width} (600–767)`, () => {
    test.use({ viewport: { width, height } });
    for (const s of MID_SCREENS) {
      test(`${s.id}`, async ({ page }) => {
        await open(page, s.person, 'tr', s.hooks);
        await s.run(page);
        await expectTableMode(page, s.table, cards);
        await snap(page, `${s.id}-${width}`, `deciship-tr-${width}-${s.id}`, s.full);
      });
    }
  });
}

/*
 * Y105 · üstüne gelme ve odak. Ortak CSS'in (:hover, :focus-visible) gerilemesi olağan ekranlarda görünmez: imleç sayfa dışında,
 * odakta öğe yok. `pose` hâli kurar ve kurulduğunu doğrular (odakta :focus-visible eşleşiyor mu); çekim aynı snap ile.
 * Satır hâlleri üç kipte: masaüstü tablo (1440), 600–767 tablo (720, kabuğun kart kuralı geri alınmış), kart (620).
 */
interface StateShot {
  id: string;
  person: Person;
  widths: readonly number[];
  /** 600–767 genişlikte kipi doğrulanacak tablo */
  table?: string;
  run: (page: Page) => Promise<void>;
  pose: (page: Page) => Promise<void>;
}

const firstInvoiceRow = (p: Page) => p.locator('.inv-list tbody tr.clickable').first();
const uploadButton = (p: Page) => p.getByRole('link', { name: 'Fatura yükle' }).first();
/** Fatura ayrıntısında seçili olmayan ilk sekme ("Fark var") */
const secondTab = (p: Page) => p.locator('.inv-tabs').getByRole('tab').nth(1);

async function focusVisible(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  expect(await target.evaluate((el) => el === document.activeElement && el.matches(':focus-visible')), 'odak halkası görünür olmalı (:focus-visible)').toBe(true);
}

const STATES: StateShot[] = [
  { id: 'h01-satir-ustune-gelme', person: 'owner', widths: [1440, 720, 620], table: '.inv-list', run: SCREENS[3].run, pose: (p) => firstInvoiceRow(p).hover() },
  { id: 'h02-dugme-ustune-gelme', person: 'owner', widths: [1440, 720], run: SCREENS[3].run, pose: (p) => uploadButton(p).hover() },
  { id: 'h03-sekme-ustune-gelme', person: 'owner', widths: [1440], run: openInvoiceI1, pose: (p) => secondTab(p).hover() },
  { id: 'f01-satir-odak', person: 'owner', widths: [1440, 720, 620], table: '.inv-list', run: SCREENS[3].run, pose: (p) => focusVisible(firstInvoiceRow(p)) },
  { id: 'f02-dugme-odak', person: 'owner', widths: [1440, 720], run: SCREENS[3].run, pose: (p) => focusVisible(uploadButton(p)) },
  { id: 'f03-alan-odak', person: 'owner', widths: [1440, 720], run: SCREENS[8].run, pose: (p) => focusVisible(p.locator('#s-edge')) },
  { id: 'f04-sekme-odak', person: 'owner', widths: [1440], run: openInvoiceI1, pose: (p) => focusVisible(secondTab(p)) },
];

for (const width of [...new Set(STATES.flatMap((s) => s.widths))]) {
  test.describe(`DeciShip TR ${width} üstüne gelme ve odak`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const s of STATES) {
      if (!s.widths.includes(width)) continue;
      test(`${s.id}`, async ({ page }) => {
        await open(page, s.person, 'tr');
        await s.run(page);
        const mid = MID_SIZES.find((m) => m.width === width);
        if (s.table && mid) await expectTableMode(page, s.table, mid.cards);
        await snap(page, `${s.id}-${width}`, `deciship-tr-${width}-${s.id}`, false, s.pose);
      });
    }
  });
}

/** EN: Pano, Faturalar, Fatura detayı, Tarife düzenle, Ayarlar; yalnız 1440. */
const EN_SCREENS: Shot[] = [
  { id: '01-pano', person: 'owner', run: SCREENS[0].run },
  { id: '04-faturalar', person: 'owner', run: SCREENS[3].run },
  { id: '05-fatura-detay', person: 'owner', run: SCREENS[4].run },
  { id: '08-tarife-duzenle', person: 'owner', run: SCREENS[7].run },
  { id: '09-ayarlar', person: 'owner', full: true, run: SCREENS[8].run },
];

for (const { width, height } of SIZES) {
  test.describe(`DeciShip TR ${width}`, () => {
    test.use({ viewport: { width, height } });
    for (const s of [...SCREENS, ...EXTRAS]) {
      if (s.only && s.only !== width) continue;
      test(`${s.id}`, async ({ page }) => {
        await open(page, s.person, 'tr', s.hooks);
        await s.run(page);
        await snap(page, `${s.id}-${width}`, `deciship-tr-${width}-${s.id}`, s.full);
      });
    }
  });
}

test.describe('DeciShip EN 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  for (const s of EN_SCREENS) {
    test(`${s.id}`, async ({ page }) => {
      await open(page, s.person, 'en', s.hooks);
      await s.run(page);
      await snap(page, `${s.id}-1440-en`, `deciship-en-1440-${s.id}`, s.full);
    });
  }
});
