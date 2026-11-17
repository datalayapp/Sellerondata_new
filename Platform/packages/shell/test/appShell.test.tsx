// @vitest-environment happy-dom
import { StrictMode, act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PRODUCTS, PRODUCT_KEYS, PRODUCT_PALETTE, type MeResponse } from '@sellerondata/contracts';
import { AppShell, type AppShellProps } from '../src/AppShell.tsx';
import { PageHeader } from '../src/primitives.tsx';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const beforeEach: (fn: () => void) => void;
declare const afterEach: (fn: () => void) => void;
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: MeResponse = {
  person: { id: 'p1', name: 'Elif Kaya', email: 'elif@atlas.test', phone: null, locale: 'tr', emailVerified: true },
  orgs: [
    { id: 'o1', name: 'Atlas Ev Tekstil', orgRole: 'OWNER', status: 'ACTIVE' },
    { id: 'o2', name: 'Bora Dış Ticaret', orgRole: 'MEMBER', status: 'ACTIVE' },
  ],
  activeOrg: { id: 'o1', name: 'Atlas Ev Tekstil', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1' },
  products: [{ key: 'deciship', available: true, subscription: null, role: 'ADMIN', permissions: ['deciship.web.access'] }],
};

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => root.render(node));
}

function shell(children: ReactNode, over: Partial<AppShellProps> = {}) {
  return (
    <AppShell
      currentProduct="hub"
      currentPath="/home"
      me={ME}
      productNav={[
        { items: [{ href: '/home', label: 'Genel Bakış' }, { href: '/analytics', label: 'Analiz' }] },
        { label: 'Hesap', items: [{ href: '/account/team', label: 'Ekip ve yetkiler' }] },
      ]}
      onLogout={() => undefined}
      onSwitchOrg={() => undefined}
      onChangeLocale={() => undefined}
      {...over}
    >
      {children}
    </AppShell>
  );
}

const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PageHeader', () => {
  it('AppShell içinde bandın başlık bölgesine taşınır, içerikte kalmaz', () => {
    render(shell(<PageHeader hero eyebrow="Pazartesi" title="Genel Bakış" sub="4 madde bekliyor" actions={<button className="btn btn-primary">Aç</button>} />));
    const band = $('header.sod-band')!;
    expect(band.getAttribute('data-size')).toBe('hero');
    const head = band.querySelector('.sod-head .phead.is-band.is-hero');
    expect(head).not.toBeNull();
    expect(head!.querySelector('h1.ptitle')!.textContent).toBe('Genel Bakış');
    expect(head!.querySelector('.peyebrow')!.textContent).toBe('Pazartesi');
    expect(head!.querySelector('.psub')!.textContent).toBe('4 madde bekliyor');
    expect(head!.querySelector('.pactions .btn-primary')).not.toBeNull();
    expect($('main .phead')).toBeNull();
    expect($$('h1')).toHaveLength(1);
  });

  it('ilk boyamada başlık bantta: ayrı bir kare beklemez; varsayılan standart bant', () => {
    // act tek bir commit gibi çalışır; ref + layout effect güncellemesi boyamadan önce eşzamanlı işlenir.
    render(shell(<PageHeader title="Ekip" />));
    expect($('.sod-band .ptitle')!.textContent).toBe('Ekip');
    expect($('.sod-band')!.getAttribute('data-size')).toBe('standard');
    expect($('.sod-band .phead.is-hero')).toBeNull();
  });

  it('standart bantta satırlar içerik olmasa da yer tutar (sabit yükseklik)', () => {
    render(shell(<PageHeader title="Ekip" />));
    const head = $('.sod-band .phead.is-band')!;
    expect(head.querySelector('.phead-main > .phead-kicker')).not.toBeNull();
    expect(head.querySelector('.phead-main > .psub')!.textContent).toBe('');
    expect(head.querySelector(':scope > .pactions')!.childElementCount).toBe(0);
    render(shell(<PageHeader title="Fatura" crumbs={<a href="/x">Faturalar</a>} eyebrow="Ekim" sub="FedEx" short actions={<button className="btn">Yükle</button>} />));
    expect($('.sod-band')!.getAttribute('data-size')).toBe('standard'); // eski `short` etkisiz
    expect($('.sod-band .phead-kicker .crumb a')!.textContent).toBe('Faturalar');
    expect($('.sod-band .phead-kicker .peyebrow')!.textContent).toBe('Ekim');
  });

  it('media: başlığın solunda çizilir (Hesabım baş harf dairesi); verilmezse yer tutmaz', () => {
    render(shell(<PageHeader title="Selin Sahip" media={<span className="phead-av" aria-hidden="true">SS</span>} />));
    const head = $('.sod-band .phead.is-band')!;
    expect(head.classList.contains('has-media')).toBe(true);
    expect(head.querySelector(':scope > .phead-media + .phead-main')).not.toBeNull();
    expect(head.querySelector('.phead-media .phead-av')!.textContent).toBe('SS');
    render(shell(<PageHeader title="Ekip" />));
    expect($('.sod-band .phead-media')).toBeNull();
    expect($('.sod-band .phead.has-media')).toBeNull();
  });

  it('sekmeler bantta değil içeriğin başında; bant standart', () => {
    render(shell(<PageHeader title="Ekip" tabs={<div className="ptabs" role="tablist" />} />));
    expect($('.sod-band')!.getAttribute('data-size')).toBe('standard');
    expect($('main .phead-tabs .ptabs')).not.toBeNull();
    expect($('.sod-band .ptabs')).toBeNull();
  });

  it('başlık kalkınca bant başlıksız (standart yükseklikte) kalır', () => {
    function Page() {
      const [on, setOn] = useState(true);
      return (
        <>
          {on && <PageHeader hero title="Analiz" />}
          <button id="off" onClick={() => setOn(false)} />
        </>
      );
    }
    render(shell(<Page />));
    expect($('.sod-band')!.getAttribute('data-size')).toBe('hero');
    act(() => $('#off')!.click());
    expect($('.sod-band')!.getAttribute('data-size')).toBe('none');
    expect($('.sod-band .ptitle')).toBeNull();
  });

  it('AppShell dışında satır içi çizilir', () => {
    render(<PageHeader title="Giriş" sub="Hesabınıza girin" tabs={<div className="ptabs" />} />);
    const head = host.firstElementChild as HTMLElement;
    expect(head.className).toBe('phead has-tabs');
    expect(head.querySelector('.phead-main h1.ptitle')!.textContent).toBe('Giriş');
    expect(head.querySelector('.ptabs')).not.toBeNull();
  });
});

describe('AppShell', () => {
  it('gruplar tek yatay menüde düzleşir, etkin öğe aria-current taşır', () => {
    render(shell(null, { currentPath: '/analytics/deciship' }));
    const nav = $('.sod-top nav.sod-nav')!;
    expect($$('.sod-top nav.sod-nav a').map((a) => a.textContent)).toEqual(['Genel Bakış', 'Analiz', 'Ekip ve yetkiler']);
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Analiz');
    // Sayfada iki gezinti var: ürün menüsü (etkin sayfa) ve alttaki uygulama çubuğu (etkin uygulama); her birinde tek etkin öğe.
    expect($$('nav [aria-current="page"]').map((n) => n.closest('nav')!.className)).toEqual(['sod-nav', 'sod-dock']);
  });

  it('menü öğesinin simgesi verilirse çizilir, yalnız süs (aria-hidden)', () => {
    render(shell(null, { productNav: [{ items: [{ href: '/home', label: 'Genel Bakış', icon: 'home' }, { href: '/analytics', label: 'Analiz' }] }] }));
    const links = $$('.sod-top nav.sod-nav a');
    expect(links[0]!.querySelector('svg.i')!.getAttribute('aria-hidden')).toBe('true');
    expect(links[0]!.querySelector('svg.i')!.getAttribute('data-i')).toBe('home');
    expect(links[1]!.querySelector('svg')).toBeNull();
    expect(links.map((a) => a.textContent)).toEqual(['Genel Bakış', 'Analiz']);
  });

  it('sabit üst satır: kaydırma durumu ve yükseklikler kök öğeye yazılır, kabuk kalkınca silinir', () => {
    render(shell(null));
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--sod-status-h')).toBe('0px');
    expect(root.hasAttribute('data-sod-stuck')).toBe(false);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(root.hasAttribute('data-sod-stuck')).toBe(true);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(root.hasAttribute('data-sod-stuck')).toBe(false);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    act(() => window.dispatchEvent(new Event('scroll')));
    render(null);
    expect(root.hasAttribute('data-sod-stuck')).toBe(false);
    expect(root.style.getPropertyValue('--sod-status-h')).toBe('');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  it('düğüm menü kendi <nav>ını taşır, kabuk iç içe nav açmaz', () => {
    render(shell(null, { productNav: <nav aria-label="DeciShip menüsü"><a href="/deciship/">Pano</a></nav> }));
    expect($('.sod-top .sod-nav.is-node > nav > a')!.textContent).toBe('Pano');
    expect($$('nav nav')).toHaveLength(0);
  });

  // A · bölmeli sekmeler: ⊞ sağ kümeden logo kilidinin hemen sağına taşındı (DOM sırası = görsel ve klavye sırası).
  it('üst satır sırası: logo, uygulamalar, menü; sağ kümede firma ve avatar', () => {
    render(shell(null));
    const lead = $('.sod-top > .sod-lead')!;
    expect(Array.from(lead.children).map((n) => n.className)).toEqual(['sod-brand', 'sod-pop-wrap sod-apps']);
    expect(Array.from($('.sod-top')!.children).map((n) => n.className.split(' ')[0])).toEqual(['sod-lead', 'sod-nav', 'sod-top-r']);
    const r = $('.sod-top-r')!;
    const buttons = Array.from(r.querySelectorAll('button[aria-haspopup="menu"]'));
    expect(buttons.map((b) => b.className)).toEqual(['sod-firm', 'sod-av']);
    expect(r.querySelector('.sod-firm-n')!.textContent).toBe('Atlas Ev Tekstil');
    expect(r.querySelector('.sod-av')!.textContent).toBe('EK');
  });

  it('ürün bandı: iki satırlı logo kilidi (ad, altında SellerOnData) ürünün ana sayfasına gider, renk ürünün', () => {
    render(shell(null, { currentProduct: 'deciship', currentPath: '/deciship/' }));
    const s = $('.sod-shell')!;
    expect(s.getAttribute('data-sod-product')).toBe('deciship');
    expect(s.style.getPropertyValue('--sod-band')).toBe('#1d5bd8');
    expect(s.style.getPropertyValue('--sod-band-cta-ink')).toBe('#1d5bd8');
    const links = $$('.sod-brand a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/deciship/');
    expect(links[0]!.querySelector('.sod-mark')).not.toBeNull();
    expect($$('.sod-brand .sod-brand-txt > span').map((n) => [n.className, n.textContent])).toEqual([
      ['sod-brand-n', 'DeciShip'],
      ['sod-brand-sub', 'SellerOnData'],
    ]);
    expect(document.documentElement.dataset.sodProduct).toBe('deciship');
  });

  it('Merkez bandı: grafit; logo kilidi MERKEZ / SellerOnData, erişilebilir ad "SellerOnData Merkez"', () => {
    render(shell(null));
    const s = $('.sod-shell')!;
    expect(s.style.getPropertyValue('--sod-band')).toBe('#2a2d34');
    expect(s.style.getPropertyValue('--sod-band-cta')).toBe('#fdb022');
    const link = $('.sod-brand a.sod-brand-main.is-hub')!;
    expect(link.getAttribute('href')).toBe('/home');
    expect(link.getAttribute('aria-label')).toBe('SellerOnData rail.hub');
    expect(link.querySelector('.sod-brand-n')!.textContent).toBe('rail.hub');
    expect(link.querySelector('.sod-brand-sub')!.textContent).toBe('SellerOnData');
  });

  it('uygulama menüsü: açık olmayan ürün bağlantı değil, tıklanamaz', () => {
    render(shell(null));
    act(() => $('.sod-sw')!.click());
    const menu = $('.sod-apps [role="menu"]')!;
    const soon = Array.from(menu.querySelectorAll('[aria-disabled="true"]'));
    // `me` yokken yalnız kayıtta launch === 'public' olan araç açıktır.
    expect(soon.map((n) => n.textContent)).toEqual(PRODUCT_KEYS.filter((k) => PRODUCTS[k].launch !== 'public').map((k) => `${PRODUCTS[k].name}rail.soon`));
    expect(soon.every((n) => n.tagName === 'SPAN')).toBe(true);
    expect(menu.querySelector('a[href="/deciship/"]')).not.toBeNull();
    expect(menu.querySelector('a[aria-current="page"]')!.getAttribute('href')).toBe('/home');
  });

  it('uygulama menüsü: açıklık sunucu yanıtından okunur; web yüzü olmayan açık araç Merkezde o araca süzülür', () => {
    const open: MeResponse = {
      ...ME,
      products: [...ME.products, { key: 'orderloom', available: true, launch: 'pilot', subscription: null, role: null, permissions: [] }],
    };
    render(shell(null, { me: open }));
    act(() => $('.sod-sw')!.click());
    const menu = $('.sod-apps [role="menu"]')!;
    // Sunucu yanıtında bulunmayan ya da kayıtta launch === 'off' olan araç Yakında kalır (orderloom burada pilot olarak açıldı).
    const stillSoon = PRODUCT_KEYS.filter((k) => k !== 'deciship' && k !== 'orderloom' && PRODUCTS[k].launch === 'off');
    expect(Array.from(menu.querySelectorAll('[aria-disabled="true"]')).map((n) => n.textContent)).toEqual(stillSoon.map((k) => `${PRODUCTS[k].name}rail.soon`));
    expect(menu.querySelector('a[href="/home?tool=orderloom"]')).not.toBeNull();
  });

  // Alt uygulama çubuğu (A3): telefonda görünür (CSS); DOM her genişlikte aynı.
  const dockCells = () => Array.from($('nav.sod-dock')!.children) as HTMLElement[];
  const cellName = (n: HTMLElement) => n.querySelector('.sod-dock-n')!.textContent;

  it('alt uygulama çubuğu: Merkez, sonra ürünler katalog sırasında; her hücrede işaret ve ad', () => {
    render(shell(null));
    const dock = $('nav.sod-dock')!;
    expect(dock.getAttribute('aria-label')).toBe('apps.label');
    expect(dockCells().map(cellName)).toEqual(['rail.hub', ...PRODUCT_KEYS.map((k) => PRODUCTS[k].name)]);
    expect(dockCells().every((n) => n.className.startsWith('sod-dock-i') && n.querySelector(':scope > svg.sod-mark') !== null)).toBe(true);
    // Merkez'deyken Merkez etkin; ana sayfaya gider, renkleri CSS'te (satır içi ton yok).
    const current = dock.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/home');
    expect(cellName(current[0] as HTMLElement)).toBe('rail.hub');
    expect((current[0] as HTMLElement).style.getPropertyValue('--sod-dock-c')).toBe('');
    // Etkin olmayan açık ürün: ürünün ana sayfası, önceden yükleme işareti taşır.
    const ds = dock.querySelector<HTMLElement>('a[href="/deciship/"]')!;
    expect(ds.hasAttribute('aria-current')).toBe(false);
    expect(ds.getAttribute('data-sod-tool')).toBe('deciship');
  });

  it('alt uygulama çubuğu: üründe o ürün etkin, hücre ürünün renklerini taşır', () => {
    render(shell(null, { currentProduct: 'deciship', currentPath: '/deciship/' }));
    const current = $$('nav.sod-dock [aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/deciship/');
    expect(cellName(current[0]!)).toBe('DeciShip');
    expect(current[0]!.style.getPropertyValue('--sod-dock-c')).toBe(PRODUCTS.deciship.color);
    expect(current[0]!.style.getPropertyValue('--sod-dock-soft')).toBe(PRODUCT_PALETTE.deciship.soft);
    expect(current[0]!.style.getPropertyValue('--sod-dock-ink')).toBe(PRODUCT_PALETTE.deciship.text);
    expect($('nav.sod-dock a[href="/home"]')!.hasAttribute('aria-current')).toBe(false);
  });

  it('alt uygulama çubuğu: açık olmayan ürün bağlantı değil, odak almaz, "Yakında" okunur', () => {
    render(shell(null));
    const open = (k: string) => ME.products.some((p) => p.key === k && p.available);
    const soon = dockCells().filter((n) => n.getAttribute('aria-disabled') === 'true');
    expect(soon.map(cellName)).toEqual(PRODUCT_KEYS.filter((k) => !open(k)).map((k) => PRODUCTS[k].name));
    expect(soon.length).toBeGreaterThan(0);
    for (const n of soon) {
      expect(n.tagName).toBe('SPAN');
      expect(n.hasAttribute('href')).toBe(false);
      expect(n.hasAttribute('tabindex')).toBe(false);
      expect(n.querySelector('a')).toBeNull();
      expect(n.classList.contains('is-soon')).toBe(true);
      expect(n.querySelector('.sr-only')!.textContent).toBe('rail.soon');
    }
    // açık olanlar bağlantı
    expect(dockCells().filter((n) => n.tagName === 'A').map(cellName)).toEqual(['rail.hub', ...PRODUCT_KEYS.filter(open).map((k) => PRODUCTS[k].name)]);
  });

  it('alt uygulama çubuğu: web izni olmayan kişi ⊞ menüsündeki gibi "erişim yok" sayfasına gider', () => {
    const noWeb: MeResponse = { ...ME, products: [{ ...ME.products[0]!, permissions: [] }] };
    render(shell(null, { me: noWeb }));
    expect($('nav.sod-dock a[data-sod-tool="deciship"]')!.getAttribute('href')).toBe('/account/tool-access/deciship');
    act(() => $('.sod-sw')!.click());
    expect($('.sod-apps [role="menu"] a[data-sod-tool="deciship"]')!.getAttribute('href')).toBe('/account/tool-access/deciship');
  });

  it('avatar menüsü uygulama listesini taşımaz (telefonda geçiş alttaki çubukta)', () => {
    render(shell(null));
    act(() => $('.sod-av')!.click());
    const menu = $('.sod-top-r [role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('user.label');
    expect(menu.querySelector('.sod-pop-apps')).toBeNull();
    expect(menu.querySelector('a[href="/home"], a[href="/deciship/"]')).toBeNull();
  });

  it('firma menüsü firma değiştirir; hesap menüsü dili ve çıkışı taşır', () => {
    const onSwitchOrg = vi.fn();
    const onLogout = vi.fn();
    const onChangeLocale = vi.fn();
    render(shell(null, { onSwitchOrg, onLogout, onChangeLocale }));
    act(() => $('.sod-firm')!.click());
    const other = $$('[role="menuitemradio"]').find((n) => n.textContent?.includes('Bora'))!;
    act(() => other.click());
    expect(onSwitchOrg).toHaveBeenCalledWith('o2');
    expect($('a[href="/account/company"]')).toBeNull(); // menü kapandı

    act(() => $('.sod-av')!.click());
    // Dil sitedeki gibi tek satır: seçenekler kapalı başlar, satıra basınca açılır; satır çıkışın hemen üstünde.
    expect($$('[role="menuitemradio"]').filter((n) => n.hasAttribute('lang'))).toHaveLength(0);
    const langRow = $('.sod-pop-lang')!;
    expect(langRow.getAttribute('aria-expanded')).toBe('false');
    const items = $$('.sod-pop [role="menuitem"]');
    expect(items[items.length - 1]!.textContent).toBe('user.logout');
    expect(items[items.length - 2]).toBe(langRow);
    act(() => langRow.click());
    expect(langRow.getAttribute('aria-expanded')).toBe('true');
    const en = $$('[role="menuitemradio"]').find((n) => n.getAttribute('lang') === 'en')!;
    act(() => en.click());
    expect(onChangeLocale).toHaveBeenCalledWith('en');
    act(() => $('.sod-av')!.click());
    expect($('a[href="/account/profile"]')).not.toBeNull();
    const logout = $$('[role="menuitem"]').find((n) => n.textContent === 'user.logout')!;
    act(() => logout.click());
    expect(onLogout).toHaveBeenCalled();
  });

  it('kapalı firma (yalnız sahibine gelir): etkin yapılamaz, "geri aç" ekranına bağlantıdır', () => {
    const onSwitchOrg = vi.fn();
    const me: MeResponse = {
      ...ME,
      orgs: [...ME.orgs, { id: 'o3', name: 'Kapalı Ticaret', orgRole: 'OWNER', status: 'ACTIVE', orgStatus: 'CLOSED', closedAt: '2026-11-13T10:00:00Z', purgeAfter: '2026-12-13T10:00:00Z' }],
    };
    render(shell(null, { me, onSwitchOrg }));
    act(() => $('.sod-firm')!.click());
    expect($$('[role="menuitemradio"]').some((n) => n.textContent?.includes('Kapalı Ticaret'))).toBe(false);
    const closed = $('a.sod-pop-item.is-closed')!;
    expect(closed.getAttribute('href')).toBe('/account/company/closed/o3');
    expect(closed.textContent).toContain('org.closedUntil');
    act(() => closed.click());
    expect(onSwitchOrg).not.toHaveBeenCalled();
  });

  it('avatar menüsü Hesabım\'ın üç bölümüne doğrudan götürür: Hesabım (profil), Güvenlik, Firmalarım', () => {
    render(shell(null));
    act(() => $('.sod-av')!.click());
    const links = $$('.sod-pop a[role="menuitem"]').map((n) => [n.textContent, n.getAttribute('href')]);
    expect(links.slice(0, 3)).toEqual([
      ['user.profile', '/account/profile'],
      ['user.security', '/account/security'],
      ['user.firms', '/account/firms'],
    ]);
  });

  it('avatar menüsünde destek öğesi yalnız supportHref verilince çizilir', () => {
    render(shell(null));
    act(() => $('.sod-av')!.click());
    expect($$('[role="menuitem"]').some((n) => n.textContent === 'user.support')).toBe(false);
    act(() => $('.sod-av')!.click());

    const href = 'mailto:destek@sellerondata.com?subject=Destek';
    render(shell(null, { supportHref: href }));
    act(() => $('.sod-av')!.click());
    const item = $$('a[role="menuitem"]').find((n) => n.textContent === 'user.support')!;
    expect(item.getAttribute('href')).toBe(href);
  });

  it('sekme başlığı ve oturum uyarısı yeri korunur', () => {
    render(shell(<p>içerik</p>, { pageTitle: 'Analiz' }));
    expect(document.title).toBe('Analiz · rail.hub');
    expect($('main#sod-main')!.textContent).toBe('içerik');
    expect($('.sod-skip')!.getAttribute('href')).toBe('#sod-main');
  });
});

describe('Sayfa değişiminde odak', () => {
  const page = (path: string, title?: string) => shell(title ? <PageHeader title={title} /> : <p>yükleniyor</p>, { currentPath: path });

  it('yeni sayfanın başlığına (bandın h1) gider; ilk açılışta odak yerinde kalır', () => {
    render(page('/home', 'Genel Bakış'));
    expect(document.activeElement).toBe(document.body);
    render(page('/analytics', 'Analiz'));
    const h1 = $('.sod-head h1.ptitle')!;
    expect(h1.textContent).toBe('Analiz');
    expect(h1.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(h1);
  });

  it('yalnız gerçek yol değişiminde: StrictMode çift etkisinde ve aynı yolda yeniden çizimde odak ve kaydırma yerinde kalır', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    try {
      render(<StrictMode>{page('/account/team', 'Ekip ve yetkiler')}</StrictMode>);
      expect(document.activeElement).toBe(document.body);
      render(<StrictMode>{shell(<PageHeader title="Ekip ve yetkiler" sub="pencere açık" />, { currentPath: '/account/team' })}</StrictMode>);
      expect(document.activeElement).toBe(document.body);
      expect(scrollTo).not.toHaveBeenCalled();
      render(<StrictMode>{page('/home', 'Genel Bakış')}</StrictMode>);
      expect(document.activeElement).toBe($('.sod-head h1.ptitle'));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      scrollTo.mockRestore();
    }
  });

  it('başlık sonra gelirse (sayfa parçası yükleniyor) önce içerik, başlık çizilince başlık odak alır', () => {
    render(page('/home', 'Genel Bakış'));
    render(page('/analytics'));
    expect(document.activeElement).toBe($('main#sod-main'));
    render(page('/analytics', 'Analiz'));
    expect(document.activeElement).toBe($('.sod-head h1.ptitle'));
  });

  it('arada tıklayan ya da tuşa basan kişinin odağı başlığa çekilmez', () => {
    render(page('/home', 'Genel Bakış'));
    render(page('/analytics'));
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    render(page('/analytics', 'Analiz'));
    expect(document.activeElement).toBe($('main#sod-main'));
  });

  it('"İçeriğe geç" sayfanın başlığına gider, başlık yoksa içeriğe', () => {
    render(page('/home', 'Genel Bakış'));
    act(() => void $('.sod-skip')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe($('.sod-head h1.ptitle'));
    render(page('/home'));
    act(() => void $('.sod-skip')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe($('main#sod-main'));
  });
});
