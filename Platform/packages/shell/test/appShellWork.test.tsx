// @vitest-environment happy-dom
// Tezgâh çalışma düzeni (TagPress, 2. aşama): `work` bant boyu, `workspace` düzeni ve TagPress bandı.
// Görünüm tarayıcıda (görsel takım) doğrulanır; burada DOM, durum ve CSS kurallarının kapsamı.
import { act, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { MeResponse } from '@sellerondata/contracts';
import { AppShell, bandTheme, type AppShellProps } from '../src/AppShell.tsx';
import { PageHeader } from '../src/primitives.tsx';
import { useHeadSlot, type BandSize } from '../src/headSlot.ts';
import { DECISHIP_BAND, HUB_BAND, TAGPRESS_BAND } from '../src/bands.generated.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const beforeEach: (fn: () => void) => void;
declare const afterEach: (fn: () => void) => void;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: MeResponse = {
  person: { id: 'p1', name: 'Elif Kaya', email: 'elif@atlas.test', phone: null, locale: 'tr', emailVerified: true },
  orgs: [{ id: 'o1', name: 'Lavanda Atölye', orgRole: 'OWNER', status: 'ACTIVE' }],
  activeOrg: { id: 'o1', name: 'Lavanda Atölye', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1' },
  products: [{ key: 'tagpress', available: true, subscription: null, role: 'ADMIN', permissions: ['tagpress.web.access'] }],
};

let host: HTMLDivElement;
let root: Root;
const render = (node: ReactNode) => act(() => root.render(node));
const $ = (sel: string) => host.querySelector<HTMLElement>(sel);

function shell(children: ReactNode, over: Partial<AppShellProps> = {}) {
  return (
    <AppShell
      currentProduct="tagpress"
      currentPath="/uretim"
      me={ME}
      productNav={[{ items: [{ href: '/uretim', label: 'Üretim' }, { href: '/ayarlar', label: 'Ayarlar' }] }]}
      onLogout={() => undefined}
      onSwitchOrg={() => undefined}
      onChangeLocale={() => undefined}
      {...over}
    >
      {children}
    </AppShell>
  );
}

/** Aracın iş satırı: baş yuvasına taşınır, bandın boyunu bildirir (TagPress'in kullanacağı desen). */
function WorkRow({ size = 'work', children }: { size?: BandSize; children: ReactNode }) {
  const slot = useHeadSlot();
  const setSize = slot?.setSize;
  useLayoutEffect(() => {
    if (!setSize) return;
    setSize(size);
    return () => setSize(null);
  }, [setSize, size]);
  return slot?.el ? createPortal(children, slot.el) : null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('TagPress bandı', () => {
  it('bandTheme("tagpress") Tezgâh bandının üretilmiş değerleri; Merkez ve DeciShip aynı', () => {
    expect(bandTheme('tagpress')).toEqual({ ...TAGPRESS_BAND });
    expect(bandTheme('tagpress')['--sod-band']).toBe('#644acb');
    expect(bandTheme('tagpress')['--sod-band-cta-ink']).toBe('#644acb');
    expect(bandTheme('hub')).toEqual({ ...HUB_BAND });
    expect(bandTheme('deciship')).toEqual({ ...DECISHIP_BAND });
    // Bandı tokens.json'da olmayan araç katalog renginden türer (kalıp değişmedi).
    expect(bandTheme('orderloom')['--sod-band']).toMatch(/^color-mix\(in srgb, #[0-9a-f]{6} 82%, #000\)$/);
  });

  it('kabuk TagPress bandını satır içi taşır', () => {
    render(shell(null));
    const s = $('.sod-shell')!;
    expect(s.getAttribute('data-sod-product')).toBe('tagpress');
    expect(s.style.getPropertyValue('--sod-band')).toBe('#644acb');
    expect(s.style.getPropertyValue('--sod-band-on')).toBe('#f2effe');
    expect(s.style.getPropertyValue('--sod-band-accent')).toBe('#d0c5fd');
  });
});

describe('work bant boyu', () => {
  it('iş satırı baş yuvasına taşınır, bant ve kabuk work boyunu taşır; ayrılınca başlıksız banda döner', () => {
    function Page() {
      const [on, setOn] = useState(true);
      return (
        <>
          {on && (
            <WorkRow>
              <div className="tz-ctx">Üretim</div>
            </WorkRow>
          )}
          <button id="off" onClick={() => setOn(false)} />
        </>
      );
    }
    render(shell(<Page />));
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('work');
    expect($('.sod-shell')!.getAttribute('data-sod-size')).toBe('work');
    expect($('.sod-band .sod-head > .tz-ctx')!.textContent).toBe('Üretim');
    expect($('main .tz-ctx')).toBeNull();
    act(() => $('#off')!.click());
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('none');
    expect($('.sod-shell')!.hasAttribute('data-sod-size')).toBe(false);
    expect($('.sod-shell')!.hasAttribute('data-sod-workspace')).toBe(false);
  });

  it('workspace verilmezse kabuk bugünkü gibi: yeni öznitelik yok, ⊞ logo kilidinin yanında', () => {
    render(shell(<PageHeader title="Ekip" />, { currentProduct: 'hub', currentPath: '/home' }));
    const s = $('.sod-shell')!;
    expect(s.hasAttribute('data-sod-workspace')).toBe(false);
    expect(s.hasAttribute('data-sod-size')).toBe(false);
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('standard');
    expect(Array.from($('.sod-top > .sod-lead')!.children).map((n) => n.className)).toEqual(['sod-brand', 'sod-pop-wrap sod-apps']);
  });
});

describe('workspace (Tezgâh düzeni)', () => {
  it('sayfa boy bildirmeden bant work boyunda (ilk çizimde zıplama yok)', () => {
    render(shell(<p>içerik</p>, { workspace: true }));
    const s = $('.sod-shell')!;
    expect(s.hasAttribute('data-sod-workspace')).toBe(true);
    expect(s.getAttribute('data-sod-size')).toBe('work');
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('work');
  });

  it('kılavuzlu akış standart bant ister; ayrılınca work boyuna döner', () => {
    function Page() {
      const [guided, setGuided] = useState(true);
      return (
        <>
          {guided ? (
            <WorkRow size="standard">
              <div className="tz-hd">Kurulum</div>
            </WorkRow>
          ) : (
            <WorkRow>
              <div className="tz-ctx">Üretim</div>
            </WorkRow>
          )}
          <button id="done" onClick={() => setGuided(false)} />
        </>
      );
    }
    render(shell(<Page />, { workspace: true }));
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('standard');
    expect($('.sod-shell')!.hasAttribute('data-sod-size')).toBe(false);
    expect($('.sod-shell')!.hasAttribute('data-sod-workspace')).toBe(true);
    expect($('.sod-head > .tz-hd')!.textContent).toBe('Kurulum');
    act(() => $('#done')!.click());
    expect($('header.sod-band')!.getAttribute('data-size')).toBe('work');
    expect($('.sod-head > .tz-ctx')!.textContent).toBe('Üretim');
    expect($('.sod-head > .tz-hd')).toBeNull();
  });

  it('üst satır Merkez ve DeciShip ile aynı: [logo kilidi][⊞], menü, sağ küme [aracın alanı][firma][avatar]; DOM sırası = görsel sıra', () => {
    render(shell(null, { workspace: true, headerSlot: <span className="tp-act">Üretiliyor 2</span> }));
    expect(Array.from($('.sod-top')!.children).map((n) => n.className.split(' ')[0])).toEqual(['sod-lead', 'sod-nav', 'sod-top-r']);
    expect(Array.from($('.sod-top > .sod-lead')!.children).map((n) => n.className)).toEqual(['sod-brand', 'sod-pop-wrap sod-apps']);
    expect(Array.from($('.sod-top-r')!.children).map((n) => n.className)).toEqual(['sod-top-slot', 'sod-pop-wrap', 'sod-pop-wrap']);
    expect($('.sod-top-r .sod-apps')).toBeNull();
    expect($('.sod-top-r .sod-top-slot .tp-act')!.textContent).toBe('Üretiliyor 2');
    const buttons = Array.from($('.sod-top')!.querySelectorAll('button[aria-haspopup="menu"]'));
    expect(buttons.map((b) => b.className)).toEqual(['sod-sw', 'sod-firm', 'sod-av']);
    expect($('.sod-firm-n')!.textContent).toBe('Lavanda Atölye');
    // ⊞ logonun yanında çalışır; TagPress kendi içindeyken açık sayılır.
    act(() => $('.sod-lead .sod-sw')!.click());
    expect($('.sod-lead .sod-apps [role="menu"] [aria-current="page"]')!.textContent).toContain('TagPress');
  });

  it('üst satır workspace olsa da olmasa da aynı DOM: yalnız kökteki öznitelik farklı', () => {
    const topOf = () => {
      const top = $('.sod-top')!.cloneNode(true) as HTMLElement;
      // useId kimlikleri iki çizimde farklı olabilir; yapı karşılaştırılır.
      top.querySelectorAll('[id], [aria-controls]').forEach((n) => (n.removeAttribute('id'), n.removeAttribute('aria-controls')));
      return top.outerHTML;
    };
    const nav = [{ items: [{ href: '/uretim', label: 'Üretim', icon: 'home' as const }, { href: '/ayarlar', label: 'Ayarlar', icon: 'gear' as const, badge: <em className="tp-eks">Eksik</em> }] }];
    render(shell(null, { productNav: nav }));
    const plain = topOf();
    render(shell(null, { productNav: nav, workspace: true }));
    expect($('.sod-shell')!.hasAttribute('data-sod-workspace')).toBe(true);
    expect(topOf()).toBe(plain);
    // Simge (A · bölmeli sekmeler) ve rozet workspace'te de çizilir.
    const links = Array.from(host.querySelectorAll<HTMLElement>('.sod-nav a'));
    expect(links.map((a) => a.querySelector('svg') !== null)).toEqual([true, true]);
    expect(links[1]!.querySelector('.tp-eks')!.textContent).toBe('Eksik');
  });

  it('sütun (column): kökte data-sod-column; üst satır, bant ve içerik yapısı aynı kalır; çalışırken açılıp kapanır', () => {
    function Page() {
      return (
        <WorkRow>
          <div className="tz-ctx">Ayarlar / Üretim</div>
        </WorkRow>
      );
    }
    render(shell(<Page />, { workspace: true }));
    const s = () => $('.sod-shell')!;
    expect(s().hasAttribute('data-sod-column')).toBe(false);
    const top = $('.sod-top')!.outerHTML;
    render(shell(<Page />, { workspace: true, column: true }));
    expect(s().hasAttribute('data-sod-column')).toBe(true);
    expect(s().hasAttribute('data-sod-workspace')).toBe(true);
    expect(s().getAttribute('data-sod-size')).toBe('work');
    expect($('.sod-top')!.outerHTML).toBe(top);
    // Baş yuvası ve içerik aynı yerde: sütun yalnız CSS'tir (bant > .sod-wrap > .sod-head, kabuk > main.sod-main).
    expect($('.sod-shell > header.sod-band > .sod-wrap > .sod-head > .tz-ctx')!.textContent).toBe('Ayarlar / Üretim');
    expect($('.sod-shell > main.sod-main')).not.toBeNull();
    // Sayfa değişince araç yeniden verir: öznitelik kalkar, bant work boyunda kalır.
    render(shell(<Page />, { workspace: true, column: false }));
    expect(s().hasAttribute('data-sod-column')).toBe(false);
    expect(s().getAttribute('data-sod-size')).toBe('work');
  });

  it('column workspace olmadan anlamsız: Merkez ve DeciShip kökünde öznitelik çıkmaz', () => {
    render(shell(<PageHeader title="Ekip" />, { currentProduct: 'hub', currentPath: '/home', column: true }));
    expect($('.sod-shell')!.hasAttribute('data-sod-column')).toBe(false);
    expect($('.sod-shell')!.hasAttribute('data-sod-workspace')).toBe(false);
  });

  it('logo kilidi TagPress / SellerOnData, aracın ana sayfasına gider', () => {
    render(shell(null, { workspace: true }));
    const a = $('.sod-brand a.sod-brand-main')!;
    expect(a.getAttribute('href')).toBe('/tagpress/');
    expect(a.querySelector('.sod-brand-n')!.textContent).toBe('TagPress');
    expect(a.querySelector('.sod-brand-sub')!.textContent).toBe('SellerOnData');
  });
});
