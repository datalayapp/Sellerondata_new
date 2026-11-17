import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES, PRODUCTS, PRODUCT_KEYS, PRODUCT_PALETTE, productRole, type Locale, type MeResponse, type ProductKey } from '@sellerondata/contracts';
import { Icon, type IconName } from './icons.tsx';
import { AppsGlyph, ProductMark, faviconHref, type ShellProduct } from './marks.tsx';
import { formatDate, initials } from './format.ts';
import { isProductOpen, productHref, setShellDocumentTitle, usePrefetchProducts } from './navigation.ts';
import { currentLocale } from './i18n/setup.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SessionBanner } from './SessionBanner.tsx';
import { DECISHIP_BAND, HUB_BAND } from './bands.generated.ts';
import { HeadSlotContext, type BandSize, type HeadSlot } from './headSlot.ts';

export type LinkRenderProps = {
  href: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  'aria-current'?: 'page';
  'aria-label'?: string;
  'data-sod-tool'?: string;
  role?: string;
  style?: CSSProperties;
};

export type ProductNavItem = {
  href: string;
  label: string;
  /** Geniş ekranda sekmenin solunda (A · bölmeli sekmeler); telefonda ve menü sığmayınca çizilmez. */
  icon?: IconName;
  /** Yol tam eşleşsin mi (kök menü öğesi için). */
  end?: boolean;
  badge?: ReactNode;
};
export type ProductNavGroup = { label?: string; items: ProductNavItem[] };

export type AppShellProps = {
  /** Etkin alan: Merkez için "hub", ürün için anahtarı. Bandın rengi ve logo kilidi buna göre. */
  currentProduct: ShellProduct;
  /**
   * Aracın menüsü: bandın üst satırında yatay. Gruplar düzleşir (grup adı çizilmez).
   * Düğüm verilirse menü yerine olduğu gibi oturur. Yoksa menü yok.
   */
  productNav?: ProductNavGroup[] | ReactNode;
  /** Sekme başlığı. Bantta görünmez: sayfa adı `PageHeader`'ın `h1`idir. */
  pageTitle?: string | null;
  /** Bandın başlık bölgesinin üstünde kırıntı. Çoğu sayfada yok; `PageHeader.crumbs` tercih edilir. */
  breadcrumb?: ReactNode;
  /** Etkin menü öğesi ve sayfa değişimi için geçerli yol. Router'dan veya location'dan. */
  currentPath: string;
  me: MeResponse | null;
  onLogout: () => void | Promise<void>;
  onSwitchOrg: (orgId: string) => void | Promise<void>;
  onChangeLocale: (locale: Locale) => void | Promise<void>;
  /** Uygulama içi bağlantı. Verilmezse düz `<a>`, yani tam sayfa gezinti. react-router gerekmez. */
  renderLink?: (props: LinkRenderProps) => ReactNode;
  /** Bu `href` uygulamanın kendi yolu mu? Değilse `renderLink` çağrılmaz, tam sayfa gidilir. */
  isLocalHref?: (href: string) => boolean;
  /** Sağ kümenin başında, uygulamaya özel alan (ör. "Örnek veri" etiketi). */
  headerSlot?: ReactNode;
  /** Hesap menüsü yolları. Merkez'de, her uygulamadan aynıdır. `profile`, `security`, `firms`: Hesabım'ın üç bölümü. */
  /** `closedOrg`: kapalı firmanın "geri aç" ekranının kökü; öğe `<closedOrg>/<orgId>` bağlantısıdır (yalnız sahibin listesinde görünür). */
  accountPaths?: { profile: string; security: string; firms?: string; company: string; newCompany?: string; closedOrg?: string };
  /** Destek bağlantısı (`mailto:`; bkz. `supportMailto` @sellerondata/contracts). Verilirse avatar menüsünde "Yardım ve destek" çıkar; verilmezse öğe çizilmez. */
  supportHref?: string;
  children: ReactNode;
};

const DEFAULT_ACCOUNT = { profile: '/account/profile', security: '/account/security', firms: '/account/firms', company: '/account/company', newCompany: '/account/company/new', closedOrg: '/account/company/closed' };
/** Dil adı kendi dilinde (hesap menüsü, giriş ekranı dil menüsü). */
export const LOCALE_NAME: Record<Locale, string> = { tr: 'Türkçe', en: 'English' }; // i18n-ok: dil adı kendi dilinde yazılır
const HUB_HOME = '/home';

/**
 * Bant belirteçleri. Merkez grafit + güneş (tanıtım sitesinin gece mavisinden ayrışır); ürünler kendi rengi,
 * bantta birincil düğme beyaz zemin + ürün rengi yazı.
 * DeciShip değerleri tasarımdan sabit; diğer ürünler katalog renginden aynı kalıpla türer.
 */
export function bandTheme(product: ShellProduct): Record<`--sod-${string}`, string> {
  if (product === 'hub') return { ...HUB_BAND };
  // Yeni araç bandı için tokens.json'a bant girdisi ve bu eşlemeye satır gerekir (rapor Y maddesi).
  if (product === 'deciship') return { ...DECISHIP_BAND };
  const c = PRODUCTS[product].color;
  return {
    '--sod-band': `color-mix(in srgb, ${c} 82%, #000)`,
    '--sod-band-2': `color-mix(in srgb, ${c} 68%, #000)`,
    '--sod-band-on': `color-mix(in srgb, ${c} 10%, #fff)`,
    '--sod-band-accent': `color-mix(in srgb, ${c} 35%, #fff)`,
    '--sod-band-cta': '#ffffff',
    '--sod-band-cta-hover': `color-mix(in srgb, ${c} 10%, #fff)`,
    '--sod-band-cta-ink': `color-mix(in srgb, ${c} 82%, #000)`,
    '--sod-product': c,
  };
}

const isNavGroups = (x: unknown): x is ProductNavGroup[] => Array.isArray(x) && (x.length === 0 || (typeof x[0] === 'object' && x[0] !== null && 'items' in x[0]));

function matches(path: string, item: ProductNavItem) {
  const p = path.replace(/\/+$/, '') || '/';
  const h = item.href.replace(/\/+$/, '') || '/';
  return item.end ? p === h : p === h || p.startsWith(`${h}/`);
}

// SSR'da uyarı vermesin; tarayıcıda boyamadan önce çalışsın.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Kabuk (D09 Renk bandı). Üst bant: logo kilidi + yatay ürün menüsü + sağ küme [⊞ uygulamalar] [firma] [avatar].
 * Altında sayfa başlığı bölgesi: `PageHeader` buraya taşınır. İçerik bandın altına biner (`.sod-lift`).
 */
export function AppShell(props: AppShellProps) {
  const { currentProduct, productNav, pageTitle, breadcrumb, currentPath, me, children, headerSlot } = props;
  const { t, i18n } = useTranslation('shell');
  const mainRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const lastPath = useRef(currentPath);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<BandSize>('none');

  const productName = currentProduct === 'hub' ? t('rail.hub') : PRODUCTS[currentProduct].name;
  const theme = useMemo(() => bandTheme(currentProduct), [currentProduct]);

  usePrefetchProducts(currentProduct, me);

  useEffect(() => {
    setShellDocumentTitle(productName, pageTitle);
  }, [productName, pageTitle, i18n.language]);

  useEffect(() => {
    const href = faviconHref(currentProduct);
    if (!href) return;
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][data-sod]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.sod = '1';
      document.head.appendChild(link);
    }
    link.href = href;
  }, [currentProduct]);

  // Ürün teması kök öğede de dursun: gövdeye açılan modal ve bildirim aynı birincil rengi alır.
  useIsoLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.sodProduct = currentProduct;
    return () => {
      if (root.dataset.sodProduct === currentProduct) delete root.dataset.sodProduct;
    };
  }, [currentProduct]);

  // Sayfa değişince odak yeni sayfanın başlığına (bandın `h1`'i) gider; başlık henüz yoksa (sayfa parçası yükleniyor) içeriğe,
  // başlık gelince ona. Kişi arada tıklar ya da tuşa basarsa beklenen odak bırakılır.
  const titlePending = useRef(false);
  const focusTitle = useCallback((h1: HTMLElement | null | undefined) => {
    if (!titlePending.current || !h1?.isConnected) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== mainRef.current) return;
    titlePending.current = false;
    h1.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const drop = () => {
      titlePending.current = false;
    };
    document.addEventListener('pointerdown', drop, true);
    document.addEventListener('keydown', drop, true);
    return () => {
      document.removeEventListener('pointerdown', drop, true);
      document.removeEventListener('keydown', drop, true);
    };
  }, []);
  const pageTitleEl = () => shellRef.current?.querySelector<HTMLElement>('.sod-head h1.ptitle');

  // Sayfa değişince: odak içeriğe taşınır, kaydırma başa döner, telefonda etkin menü öğesi görünür kalır.
  useEffect(() => {
    const nav = navRef.current;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && cur && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2);
    }
    // Yalnız gerçek yol değişiminde (ilk açılışta değil). Önceki yol saklanır: etki yeniden koşsa da (React StrictMode
    // geliştirmede etkiyi iki kez çalıştırır) aynı yolda odak taşınmaz, sayfa kaydırılmaz.
    if (lastPath.current === currentPath) return;
    lastPath.current = currentPath;
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
    titlePending.current = true;
    focusTitle(pageTitleEl());
  }, [currentPath, focusTitle]);

  // ==== SABİT ÜST SATIR (deneme) — başlangıç ====
  // Geri almak: bu bloğu, aşağıdaki `ref={shellRef}`i ve shell.css'teki "SABİT ÜST SATIR" bloğunu silin.
  // Yerleşim CSS'tedir (her genişlikte, yalnız ekran ortamı; telefonda sekme satırı da sabit kalır); burada yalnız durum yazılır: sayfa kaydırıldı mı
  // (`html[data-sod-stuck]`), üst satırın ve oturum uyarısının yüksekliği (`--sod-bar-h`, `--sod-status-h`).
  useEffect(() => {
    const shellEl = shellRef.current;
    if (!shellEl) return;
    const root = document.documentElement;
    let raf = 0;
    const stuck = () => root.toggleAttribute('data-sod-stuck', window.scrollY > 0);
    const sizes = () => {
      raf = 0;
      const top = shellEl.querySelector<HTMLElement>('.sod-top');
      const status = shellEl.querySelector<HTMLElement>(':scope > .sod-status');
      if (top) root.style.setProperty('--sod-bar-h', `${top.offsetHeight}px`);
      root.style.setProperty('--sod-status-h', `${status?.offsetHeight ?? 0}px`);
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(sizes);
    };
    sizes();
    stuck();
    // Belge boyu değişince (oturum uyarısı gelip gidince, pencere daralınca) yükseklikler yeniden okunur.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue);
    ro?.observe(shellEl);
    window.addEventListener('scroll', stuck, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('scroll', stuck);
      root.removeAttribute('data-sod-stuck');
      root.style.removeProperty('--sod-bar-h');
      root.style.removeProperty('--sod-status-h');
    };
  }, []);
  // ==== SABİT ÜST SATIR — bitiş ====

  // ==== A · BÖLMELİ SEKMELER — sığdırma ====
  // Geniş ekranda menü tek satırdır, sarılmaz. Sığmazsa önce simgeler gizlenir (`data-compact`); yine sığmazsa oluk yatay
  // kayar ve etkin sekme görünür alana getirilir. Ölçüm aynı karede yapılır (boyamadan önce), titreme olmaz.
  useIsoLayoutEffect(() => {
    const nav = navRef.current;
    const top = nav?.parentElement;
    if (!nav || !top) return;
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 761px)') : null;
    const over = () => nav.scrollWidth > nav.clientWidth + 1;
    // Kayan olukta devamı olan kenar solar (`data-fade`: l, r, lr).
    const edges = () => {
      const fade = !wide?.matches || !over() ? '' : `${nav.scrollLeft > 1 ? 'l' : ''}${nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 ? 'r' : ''}`;
      if (fade) nav.dataset.fade = fade;
      else delete nav.dataset.fade;
    };
    const fit = () => {
      delete nav.dataset.compact;
      if (wide?.matches && over()) {
        nav.dataset.compact = '';
        const cur = nav.querySelector<HTMLElement>('[aria-current="page"]');
        if (cur && over()) nav.scrollLeft = Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2);
      }
      edges();
    };
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(top);
    wide?.addEventListener('change', fit);
    nav.addEventListener('scroll', edges, { passive: true });
    let live = true;
    void document.fonts?.ready.then(() => live && fit());
    return () => {
      live = false;
      ro?.disconnect();
      wide?.removeEventListener('change', fit);
      nav.removeEventListener('scroll', edges);
      delete nav.dataset.fade;
    };
  }, [productNav, currentPath, i18n.language]);
  // ==== A · BÖLMELİ SEKMELER — bitiş ====

  const slot = useMemo<HeadSlot>(() => ({ el: slotEl, setSize: (s) => setSize(s ?? 'none'), titleMounted: focusTitle }), [slotEl, focusTitle]);

  // "İçeriğe geç" sayfanın başlığına gider (yoksa içeriğe): başlık ve sayfa düğmeleri bandın içinde, içeriğin önünde.
  const skipToContent = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const target = pageTitleEl() ?? mainRef.current;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  return (
    <HeadSlotContext.Provider value={slot}>
      <div ref={shellRef} className="sod-shell" data-sod-product={currentProduct} style={theme as CSSProperties}>
        <a href="#sod-main" className="sod-skip" onClick={skipToContent}>
          {t('top.skip')}
        </a>
        <SessionBanner orgName={me?.activeOrg?.name} />

        <header className="sod-band" data-size={size}>
          <div className="sod-wrap">
            <div className="sod-top">
              {/* A · bölmeli sekmeler: ⊞ logo kilidinin hemen sağında (geniş ekran); telefonda gizli, geçiş alttaki çubukta (AppDock). */}
              <div className="sod-lead">
                <Brand {...props} productName={productName} />
                <AppsMenu {...props} />
              </div>
              {isNavGroups(productNav) ? (
                productNav.some((g) => g.items.length) ? (
                  <nav ref={navRef} className="sod-nav" aria-label={t('top.nav', { name: productName })}>
                    <NavItems {...props} groups={productNav} />
                  </nav>
                ) : null
              ) : productNav ? (
                // Düğüm kendi <nav>'ını taşıyabilir: kapsayıcı yalnız yerleşim, sarmalayıcılar CSS'te düzleşir.
                <div ref={navRef as React.RefObject<HTMLDivElement>} className="sod-nav is-node">
                  {productNav}
                </div>
              ) : null}
              <div className="sod-top-r">
                {headerSlot && <div className="sod-top-slot">{headerSlot}</div>}
                <OrgMenu {...props} />
                <UserMenu {...props} />
              </div>
            </div>
            {breadcrumb && <div className="sod-band-crumb">{breadcrumb}</div>}
            <div ref={setSlotEl} className="sod-head" />
          </div>
        </header>

        <main ref={mainRef} id="sod-main" className="sod-main" tabIndex={-1}>
          <ErrorBoundary
            resetKey={currentPath}
            home={
              currentProduct === 'hub'
                ? { href: HUB_HOME, label: t('boundary.homeHub') }
                : { href: `${PRODUCTS[currentProduct].basePath}/`, label: t('boundary.homeProduct', { name: PRODUCTS[currentProduct].name }) }
            }
          >
            {children}
          </ErrorBoundary>
        </main>
        <AppDock {...props} />
      </div>
    </HeadSlotContext.Provider>
  );
}

function ShellLink({
  renderLink,
  isLocalHref,
  ...link
}: LinkRenderProps & { renderLink?: AppShellProps['renderLink']; isLocalHref?: AppShellProps['isLocalHref'] }) {
  if (renderLink && (!isLocalHref || isLocalHref(link.href))) return <>{renderLink(link)}</>;
  const { onClick, children, ...rest } = link;
  return (
    <a {...rest} onClick={onClick}>
      {children}
    </a>
  );
}

/**
 * Logo kilidi: işaret 28 px solda, sağında iki satır (ad 17/600, altında "SellerOnData" 12/400). Merkez'de ad "MERKEZ"
 * (büyük harf CSS'te; metin "Merkez" kalır, sekme başlığı ve testler onu okur). Tek bağlantı, dokunma hedefi 44 px:
 * Merkez'de `/home`, üründe ürünün ana sayfası. Merkez'e geçiş ⊞ ve (telefonda) alttaki uygulama çubuğunda.
 */
function Brand({ currentProduct, renderLink, isLocalHref, productName }: AppShellProps & { productName: string }) {
  const hub = currentProduct === 'hub';
  return (
    <div className="sod-brand">
      <ShellLink
        renderLink={renderLink}
        isLocalHref={isLocalHref}
        href={hub ? HUB_HOME : `${PRODUCTS[currentProduct].basePath}/`}
        className={`sod-brand-main${hub ? ' is-hub' : ''}`}
        aria-label={hub ? `SellerOnData ${productName}` : undefined}
      >
        <span className="sod-brand-mark" style={{ viewTransitionName: 'sod-brand-mark' } as CSSProperties}>
          <ProductMark product={currentProduct} size={28} />
        </span>
        <span className="sod-brand-txt">
          <span className="sod-brand-n">{productName}</span>
          <span className="sod-brand-sub">SellerOnData</span>
        </span>
      </ShellLink>
    </div>
  );
}

function NavItems({ groups, currentPath, renderLink, isLocalHref }: AppShellProps & { groups: ProductNavGroup[] }) {
  return (
    <>
      {groups.flatMap((g) =>
        g.items.map((it) => {
          const active = matches(currentPath, it);
          return (
            <ShellLink
              key={it.href}
              renderLink={renderLink}
              isLocalHref={isLocalHref}
              href={it.href}
              className={active ? 'active' : undefined}
              aria-current={active ? 'page' : undefined}
            >
              {/* A · bölmeli sekmeler: simge yalnız süs (aria-hidden); telefonda ve dar sığmada CSS gizler. */}
              {it.icon && <Icon name={it.icon} size={16} />}
              <span>{it.label}</span>
              {it.badge}
            </ShellLink>
          );
        }),
      )}
    </>
  );
}

/** Sağ kümedeki açılır menü. Düğmenin altına, sağa hizalı açılır. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Gizli öğe (CSS ile gizlenen) okla gezilmez.
  const items = () =>
    Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []).filter((n) => n.getClientRects().length > 0);
  useEffect(() => {
    if (!open) return;
    // Firma menüsü seçili firmadan başlar; hesap menüsünde dil seçimi alt grupta, ilk öğeden başlanır.
    (wrap.current?.querySelector<HTMLElement>('.sod-pop > [aria-checked="true"]') ?? items()[0])?.focus();
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = items();
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length]?.focus();
    }
  };
  const close = useCallback(() => setOpen(false), []);
  return { open, setOpen, close, wrap, trigger, onKeyDown };
}

/**
 * Uygulamanın gidilecek yolu: Merkez'in ana sayfası ya da ürünün yolu (`productHref`: web izni yoksa "erişim yok" sayfası).
 * Açık olmayan ürün için `null`: tıklanamaz ("Yakında"). İçinde bulunulan ürün açık sayılır. ⊞ menüsü ve alt çubuk aynı kuralı kullanır.
 */
function appHref(me: MeResponse | null, currentProduct: ShellProduct, key: ShellProduct): string | null {
  if (key === 'hub') return HUB_HOME;
  return isProductOpen(me, key) || currentProduct === key ? productHref(me, key) : null;
}

/** Uygulama listesi: Merkez ve ürünler. Açık olmayan ürün tıklanamaz ("Yakında"). ⊞ menüsü kullanır; telefonda alt çubuk (`AppDock`). */
function AppItems({ currentProduct, me, renderLink, isLocalHref, onItem }: AppShellProps & { onItem: () => void }) {
  const { t } = useTranslation('shell');
  const row = (key: ShellProduct, name: string) => {
    const href = appHref(me, currentProduct, key);
    const active = currentProduct === key;
    const body = (
      <>
        <ProductMark product={key} size={24} />
        <span className="sod-pop-text">
          <b>{name}</b>
          {!href && <small>{t('rail.soon')}</small>}
        </span>
        {active && <Icon name="check" />}
      </>
    );
    if (!href) {
      // Tıklanamaz: bağlantı değil, odak almaz. Ekran okuyucu "Yakında" bilgisini okur.
      return (
        <span key={key} role="menuitem" aria-disabled="true" className="sod-pop-item is-soon" title={t('rail.soonHint', { name })}>
          {body}
        </span>
      );
    }
    return (
      <ShellLink
        key={key}
        renderLink={renderLink}
        isLocalHref={isLocalHref}
        href={href}
        role="menuitem"
        className="sod-pop-item"
        aria-current={active ? 'page' : undefined}
        data-sod-tool={active ? undefined : key}
        onClick={onItem}
      >
        {body}
      </ShellLink>
    );
  };
  return (
    <>
      {row('hub', t('rail.hub'))}
      {/* Merkez araçlardan hafif ayrı dursun (kullanıcı isteği 2026-11-13). */}
      <div className="sod-pop-sep" role="separator" />
      {PRODUCT_KEYS.map((key: ProductKey) => row(key, PRODUCTS[key].name))}
    </>
  );
}

// Paleti olmayan yeni araç: tonlar katalog renginden türer (bandTheme ile aynı kalıp).
const PALETTE = PRODUCT_PALETTE as Partial<Record<ProductKey, { soft: string; text: string }>>;

/** Alt çubuk hücresinin renkleri: çizgi (`--sod-dock-c`), zemin tonu (`--sod-dock-soft`), ad (`--sod-dock-ink`). Merkez'in değerleri CSS'te. */
function dockTone(key: ProductKey): CSSProperties {
  const c = PRODUCTS[key].color;
  const pal = PALETTE[key];
  return {
    '--sod-dock-c': c,
    '--sod-dock-soft': pal?.soft ?? `color-mix(in srgb, ${c} 10%, #fff)`,
    '--sod-dock-ink': pal?.text ?? `color-mix(in srgb, ${c} 82%, #000)`,
  } as CSSProperties;
}

/**
 * ==== ALT UYGULAMA ÇUBUĞU (A3 · üstte kalın çizgi) ====
 * Telefonda (≤ 760) ekranın altında sabit: Merkez, sonra ürünler (`PRODUCT_KEYS` sırası); yollar ve izin kuralı ⊞ menüsüyle aynı (`appHref`).
 * İçinde bulunulan uygulama `aria-current="page"` taşır. Açık olmayan ürün soluk, bağlantı değil, odak almaz; ekran okuyucu "Yakında" okur.
 * Geniş ekranda CSS gizler. Yükseklik ve alttaki sabit öğelerin payı shell.css "ALT UYGULAMA ÇUBUĞU" bloğunda (`--sod-dock-h`).
 */
function AppDock({ currentProduct, me, renderLink, isLocalHref }: AppShellProps) {
  const { t } = useTranslation('shell');
  const cell = (key: ShellProduct, name: string) => {
    const href = appHref(me, currentProduct, key);
    const active = currentProduct === key;
    const style = key === 'hub' ? undefined : dockTone(key);
    const body = (
      <>
        <ProductMark product={key} size={24} />
        <span className="sod-dock-n">{name}</span>
      </>
    );
    if (!href) {
      return (
        <span key={key} className="sod-dock-i is-soon" aria-disabled="true" title={t('rail.soonHint', { name })} style={style}>
          {body}
          <span className="sr-only">{t('rail.soon')}</span>
        </span>
      );
    }
    return (
      <ShellLink
        key={key}
        renderLink={renderLink}
        isLocalHref={isLocalHref}
        href={href}
        className="sod-dock-i"
        aria-current={active ? 'page' : undefined}
        data-sod-tool={active ? undefined : key}
        style={style}
      >
        {body}
      </ShellLink>
    );
  };
  return (
    <nav className="sod-dock" aria-label={t('apps.label')}>
      {cell('hub', t('rail.hub'))}
      {PRODUCT_KEYS.map((key: ProductKey) => cell(key, PRODUCTS[key].name))}
    </nav>
  );
}

function AppsMenu(props: AppShellProps) {
  const { t } = useTranslation('shell');
  const pop = usePopover();
  const id = useId();
  return (
    <div className="sod-pop-wrap sod-apps" ref={pop.wrap} onKeyDown={pop.onKeyDown}>
      <button
        ref={pop.trigger}
        type="button"
        className="sod-sw"
        aria-label={t('apps.button')}
        title={t('apps.button')}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        onClick={() => pop.setOpen((v) => !v)}
      >
        <AppsGlyph size={24} />
      </button>
      {pop.open && (
        <div className="sod-pop" id={id} role="menu" aria-label={t('apps.label')}>
          <div className="sod-pop-head">{t('apps.label')}</div>
          <AppItems {...props} onItem={pop.close} />
        </div>
      )}
    </div>
  );
}

function OrgMenu({ me, onSwitchOrg, renderLink, isLocalHref, accountPaths = DEFAULT_ACCOUNT }: AppShellProps) {
  const { t } = useTranslation('shell');
  const pop = usePopover();
  const id = useId();
  const locale = currentLocale();
  const org = me?.activeOrg;
  const label = org?.name ?? t('org.none');
  const canManage = org?.orgRole === 'OWNER' || org?.orgRole === 'ADMIN';
  // Etkin firmadaki araç rolü: diğer firmalarınki yalnız o firmaya geçince bilinir.
  const toolRoles = (me?.products ?? []).flatMap((p) => {
    const role = productRole(p.key, p.role);
    return role ? [`${PRODUCTS[p.key].name}: ${role.label[locale]}`] : [];
  });
  return (
    <div className="sod-pop-wrap" ref={pop.wrap} onKeyDown={pop.onKeyDown}>
      <button
        ref={pop.trigger}
        type="button"
        className="sod-firm"
        aria-label={t('org.button', { name: label })}
        title={t('org.tipCompany', { name: label })}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        onClick={() => pop.setOpen((v) => !v)}
      >
        {/* Firma seçici A (kullanıcı kararı 2026-11-13): bina simgesi + kalın firma adı, her ekranda aynı. */}
        <Icon name="building" size={18} className="sod-firm-ic" />
        <span className="sod-firm-n">{label}</span>
        <Icon name="chev" size={14} />
      </button>
      {pop.open && (
        <div className="sod-pop" id={id} role="menu" aria-label={t('org.label')}>
          <div className="sod-pop-head">{t('org.label')}</div>
          {(me?.orgs ?? []).map((o) => {
            // Kapalı firma (yalnız sahibine gelir): etkin yapılamaz; soluk ad + saklama bitişi, seçilince Merkez'in "geri aç" ekranı.
            if (o.orgStatus === 'CLOSED') {
              return (
                <ShellLink
                  key={o.id}
                  renderLink={renderLink}
                  isLocalHref={isLocalHref}
                  href={`${accountPaths.closedOrg ?? DEFAULT_ACCOUNT.closedOrg}/${encodeURIComponent(o.id)}`}
                  role="menuitem"
                  className="sod-pop-item is-closed"
                  onClick={pop.close}
                >
                  <span className="sod-pop-text">
                    <b className="sod-ellipsis">{o.name}</b>
                    <small>{o.purgeAfter ? t('org.closedUntil', { date: formatDate(o.purgeAfter, locale) }) : t('org.closed')}</small>
                  </span>
                </ShellLink>
              );
            }
            const suspended = o.status === 'SUSPENDED';
            const selected = o.id === org?.id;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={suspended || undefined}
                className="sod-pop-item"
                onClick={() => {
                  if (suspended) return;
                  pop.setOpen(false);
                  if (!selected) void onSwitchOrg(o.id);
                }}
              >
                <span className="sod-pop-text">
                  <b className="sod-ellipsis">{o.name}</b>
                  <small>{suspended ? t('org.suspended') : [t(`org.roles.${o.orgRole}`), ...(selected ? toolRoles : [])].join(' · ')}</small>
                </span>
                {selected && <Icon name="check" />}
              </button>
            );
          })}
          {(canManage || me?.account?.canCreateOrg || me?.account?.createOrgRequiresEmail) && <div className="sod-pop-sep" />}
          {canManage && (
            <ShellLink renderLink={renderLink} isLocalHref={isLocalHref} href={accountPaths.company} role="menuitem" className="sod-pop-item" onClick={pop.close}>
              <Icon name="building" />
              <span className="sod-pop-text">{t('org.settings')}</span>
            </ShellLink>
          )}
          {(me?.account?.canCreateOrg || me?.account?.createOrgRequiresEmail) && (
            <ShellLink renderLink={renderLink} isLocalHref={isLocalHref} href={accountPaths.newCompany ?? DEFAULT_ACCOUNT.newCompany} role="menuitem" className="sod-pop-item" onClick={pop.close}>
              <Icon name="plus" />
              <span className="sod-pop-text">{t('org.create')}</span>
            </ShellLink>
          )}
        </div>
      )}
    </div>
  );
}

/** Avatar menüsü: kişi, Hesabım (profil), güvenlik, firmalarım, destek, dil, çıkış. */
function UserMenu({ me, onLogout, onChangeLocale, renderLink, isLocalHref, accountPaths = DEFAULT_ACCOUNT, supportHref }: AppShellProps) {
  const { t, i18n } = useTranslation('shell');
  const pop = usePopover();
  const id = useId();
  const name = me?.person.name ?? '';
  const sub = me?.person.email ?? me?.person.phone ?? '';
  const lng = (i18n.language === 'en' ? 'en' : 'tr') as Locale;
  const [langOpen, setLangOpen] = useState(false);
  // Menü her açılışta dil satırı kapalı başlar.
  useEffect(() => {
    if (!pop.open) setLangOpen(false);
  }, [pop.open]);
  return (
    <div className="sod-pop-wrap" ref={pop.wrap} onKeyDown={pop.onKeyDown}>
      <button
        ref={pop.trigger}
        type="button"
        className="sod-av"
        aria-label={t('user.button', { name })}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        onClick={() => pop.setOpen((v) => !v)}
      >
        {name ? initials(name) : <Icon name="user" size={18} />}
      </button>
      {pop.open && (
        <div className="sod-pop" id={id} role="menu" aria-label={t('user.label')}>
          <div className="sod-pop-who">
            <b className="sod-ellipsis">{name}</b>
            {sub && <small className="sod-ellipsis">{sub}</small>}
          </div>
          <ShellLink renderLink={renderLink} isLocalHref={isLocalHref} href={accountPaths.profile} role="menuitem" className="sod-pop-item" onClick={pop.close}>
            <Icon name="user" />
            <span className="sod-pop-text">{t('user.profile')}</span>
          </ShellLink>
          <ShellLink renderLink={renderLink} isLocalHref={isLocalHref} href={accountPaths.security} role="menuitem" className="sod-pop-item" onClick={pop.close}>
            <Icon name="lock" />
            <span className="sod-pop-text">{t('user.security')}</span>
          </ShellLink>
          <ShellLink renderLink={renderLink} isLocalHref={isLocalHref} href={accountPaths.firms ?? DEFAULT_ACCOUNT.firms} role="menuitem" className="sod-pop-item" onClick={pop.close}>
            <Icon name="building" />
            <span className="sod-pop-text">{t('user.firms')}</span>
          </ShellLink>
          {supportHref && (
            <a href={supportHref} role="menuitem" className="sod-pop-item" onClick={pop.close}>
              <Icon name="help" />
              <span className="sod-pop-text">{t('user.support')}</span>
            </a>
          )}
          <div className="sod-pop-sep" />
          {/* Dil: sitedeki hesap panelindeki gibi tek satır (🌐 Dil · Türkçe ⌄), açılınca seçenekler; çıkışın hemen üstünde. */}
          <button
            type="button"
            role="menuitem"
            className="sod-pop-item sod-pop-lang"
            aria-expanded={langOpen}
            aria-controls={langOpen ? `${id}-langs` : undefined}
            onClick={() => setLangOpen((v) => !v)}
          >
            <Icon name="globe" />
            <span className="sod-pop-text">{t('lang.label')}</span>
            <span className="sod-pop-lang-cur" lang={lng}>
              {LOCALE_NAME[lng]}
            </span>
            <Icon name="chev" />
          </button>
          {langOpen && (
            <div role="group" id={`${id}-langs`} aria-label={t('lang.label')} className="sod-pop-langs">
              {LOCALES.map((l) => (
                <button
                  key={l}
                  type="button"
                  role="menuitemradio"
                  aria-checked={l === lng}
                  lang={l}
                  className="sod-pop-item"
                  onClick={() => {
                    pop.setOpen(false);
                    pop.trigger.current?.focus();
                    if (l !== lng) void onChangeLocale(l);
                  }}
                >
                  <span className="sod-pop-text">{LOCALE_NAME[l]}</span>
                  {l === lng && <Icon name="check" />}
                </button>
              ))}
            </div>
          )}
          {/* Telefonda ⊞ gizli: uygulama geçişi alttaki çubukta (AppDock), burada tekrarlanmaz. */}
          <button
            type="button"
            role="menuitem"
            className="sod-pop-item"
            onClick={() => {
              pop.setOpen(false);
              void onLogout();
            }}
          >
            <Icon name="logout" />
            <span className="sod-pop-text">{t('user.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
