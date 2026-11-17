// Üst çubuk panelleri (details[name="ust"]: Ürünlerimiz, profil, mobil menü). CSP script-src 'self' ile uyumlu, satır içi betik yok.
// Betik yoksa paneller yine <details> olarak açılıp kapanır; bu dosya yalnız kolaylık ekler:
// - Esc: açık paneli kapatır, odağı kendi summary'sine döndürür.
// - Dışarı tıklama: açık paneli kapatır; tıklanan yer odak almadıysa odak summary'ye döner (başka bir öğeye geçen odağı çalmaz).
// - Panel içindeki bağlantıya tıklama: paneli kapatır (aynı sayfadaki #bağlantılarda panel açık kalmasın).
// - `name` özniteliğini desteklemeyen tarayıcıda biri açılınca diğerlerini kapatır.
(() => {
  const SEL = 'details[name="ust"]';
  const openOnes = () => Array.from(document.querySelectorAll(SEL + '[open]'));
  const nativeName = typeof HTMLDetailsElement !== 'undefined' && 'name' in HTMLDetailsElement.prototype;

  function close(d, focus) {
    if (!d.open) return;
    const hadFocus = d.contains(document.activeElement);
    d.open = false;
    if (focus || hadFocus) d.querySelector('summary')?.focus();
  }

  // toggle olayı kabarmaz; yakalama evresinde dinlenir.
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      // Panel kapanınca içindeki açık alt liste (hesap panelinde dil seçimi) de kapanır: yeniden açılışta kapalı gelsin.
      if (d instanceof HTMLDetailsElement && d.matches(SEL) && !d.open) for (const x of d.querySelectorAll('details[open]')) x.open = false;
      if (nativeName || !(d instanceof HTMLDetailsElement) || !d.matches(SEL) || !d.open) return;
      for (const o of openOnes()) if (o !== d) o.open = false;
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = openOnes();
    if (!open.length) return;
    // Odağı içeren panel öncelikli; yoksa açık olanların hepsi.
    const owner = open.find((d) => d.contains(document.activeElement));
    for (const d of open) close(d, d === owner || !owner);
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    for (const d of openOnes()) {
      if (!d.contains(t)) close(d, !document.activeElement || document.activeElement === document.body);
      else if (t.closest('a[href]') && !t.closest('summary')) d.open = false;
    }
  });
})();

// Tek hesap: sitenin "kimim" yoklaması (ARCHITECTURE §5 "Tek hesap: site, Merkez, araçlar").
// - Uygulamanın kökeni <body data-app>'tan okunur; istek kimlikli (çerez) ve salt okunur bir uca gider. Jeton gelmez.
// - Giriş yapılmışsa <body data-session="in">: CSS [data-auth=in] öğelerini açar, [data-auth=out] öğelerini gizler.
// - Ad, firma ve baş harfler yalnız textContent ile yazılır (HTML olarak yorumlanmaz).
// - Hata, zaman aşımı (3 sn) veya beklenmeyen yanıt: "giriş yapılmamış" kalır. Kimlik bilgisi sitede hiç sorulmaz.
// - Sekmeye dönüşte ve geri/ileri önbellekten gelişte yeniden yoklar: başka sekmede çıkış yapıldıysa güncellenir.
(() => {
  const body = document.body;
  let app;
  try {
    const u = new URL(body.dataset.app || '');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    app = u.origin;
  } catch {
    return;
  }
  const API = app + '/api/account/auth';
  const TIMEOUT_MS = 3000;
  const lang = document.documentElement.lang || 'tr';
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  /** İstek: zaman aşımında iptal. Yanıt yoksa veya ağ hatasıysa null. */
  async function call(path, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fetch(API + path, { credentials: 'include', cache: 'no-store', mode: 'cors', redirect: 'error', ...init, signal: ctl.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** { signedIn: true, ... } | { signedIn: false } | null (bilinmiyor: ağ hatası, zaman aşımı, beklenmeyen yanıt). */
  async function probe() {
    const res = await call('/site-session', { method: 'GET' });
    if (!res || !res.ok) return null;
    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    if (data.signedIn === false) return { signedIn: false };
    if (data.signedIn !== true || typeof data.name !== 'string' || !data.name.trim()) return null;
    return {
      signedIn: true,
      name: data.name.trim().slice(0, 120),
      orgName: typeof data.orgName === 'string' && data.orgName.trim() ? data.orgName.trim().slice(0, 120) : null,
      canManageOrg: data.canManageOrg === true,
    };
  }

  /** "Ayşe Yılmaz" -> "AY". Tek ad: ilk iki harf değil, ilk harf. Birleşik karakterler bölünmez. */
  function initials(name) {
    const words = name.split(/\s+/).filter(Boolean);
    const first = (w) => (w ? Array.from(w)[0] : '');
    const pick = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
    return pick.toLocaleUpperCase(lang === 'tr' ? 'tr-TR' : 'en-US');
  }

  const text = (sel, value) => all(sel).forEach((el) => (el.textContent = value));
  const show = (sel, on) => all(sel).forEach((el) => (el.hidden = !on));

  function apply(state) {
    const s = state && state.signedIn ? state : null;
    if (!s) {
      // Giriş yapılmamışa dönerken açık hesap paneli varsa odak kaybolmasın.
      const panel = document.querySelector('details.acct');
      const hadFocus = panel && panel.contains(document.activeElement);
      delete body.dataset.session;
      text('[data-sod="name"]', '');
      text('[data-sod="org"]', '');
      text('[data-sod="initials"]', '');
      show('[data-sod="org"]', false);
      show('[data-sod="team"]', false);
      if (hadFocus) panel.querySelector('summary')?.focus();
      return;
    }
    text('[data-sod="name"]', s.name);
    text('[data-sod="org"]', s.orgName || '');
    text('[data-sod="initials"]', initials(s.name));
    show('[data-sod="org"]', !!s.orgName);
    show('[data-sod="team"]', s.canManageOrg);
    body.dataset.session = 'in';
  }

  let seq = 0;
  async function refresh() {
    const mine = ++seq;
    const state = await probe();
    if (mine !== seq) return; // Daha yeni bir yoklama başladı: eski yanıt arayüzü ezmesin.
    apply(state);
  }

  async function logout(button) {
    show('[data-sod="logout-error"]', false);
    button.disabled = true;
    const res = await call('/logout', { method: 'POST', headers: { 'X-SOD-CSRF': '1' } });
    const ok = !!res && res.ok;
    const mine = ++seq;
    const state = await probe();
    button.disabled = false;
    if (mine !== seq) return;
    if (state) {
      apply(state);
      // Yoklama hâlâ "giriş yapılmış" diyorsa çıkış olmadı: arayüz yalan söylemez.
      if (state.signedIn) show('[data-sod="logout-error"]', true);
      return;
    }
    // Yoklama yanıt vermedi: çıkış uygulamadan onaylandıysa giriş yapılmamışa geç, yoksa olduğu gibi kal ve söyle.
    if (ok) apply({ signedIn: false });
    else show('[data-sod="logout-error"]', true);
  }

  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-sod="logout"]') : null;
    if (!t || t.disabled) return;
    e.preventDefault();
    void logout(t);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void refresh();
  });
  void refresh();
})();

// İlk açılış dili (kullanıcı kararı 2026-11-12): kayıtlı tercih (`sod_lang` çerezi), yoksa tarayıcının dilleri sırayla
// (ilk desteklenen; "tr-TR" → tr), o da yoksa İngilizce. Uygulamadaki kural `@sellerondata/contracts` `pickInitialLocale`;
// site paket içe aktaramaz, aşağıdaki iki işlev onun küçük kopyasıdır. `npm run check` işaretler arasını çıkarıp sınar.
// <dil-kurali>
function sodPickLang(saved, deviceLangs, supported) {
  const base = (v) => {
    if (typeof v !== 'string') return null;
    const b = (v.trim().replace(/_/g, '-').split('-')[0] || '').toLowerCase();
    return b && supported.indexOf(b) !== -1 ? b : null;
  };
  for (const s of Array.isArray(saved) ? saved : [saved]) {
    const l = base(s);
    if (l) return l;
  }
  for (const d of Array.isArray(deviceLangs) ? deviceLangs : []) {
    const l = base(d);
    if (l) return l;
  }
  return supported.indexOf('en') !== -1 ? 'en' : supported[0];
}

// Kendiliğinden dil yönlendirmesi: gidilecek adres ya da null. Çerez varsa (ziyaretçi seçmiş ya da uygulama yazmış) asla;
// oturumda bir kez (`seen`: bu sekmede daha önce bakıldı); bot ve otomasyonda yok; sayfanın karşılığı yoksa (404) yok.
function sodAutoLangTarget(o) {
  if (o.hasCookie || o.seen || o.webdriver) return null;
  if (/bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|pinterest|vkshare|w3c_validator|lighthouse|headless|preview/i.test(o.userAgent || '')) return null;
  const supported = Object.keys(o.alternates || {});
  if (supported.indexOf(o.lang) === -1) return null;
  const want = sodPickLang(null, o.languages, supported);
  const to = want === o.lang ? null : o.alternates[want];
  if (!to || to === o.pathname) return null;
  return to + (o.search || '') + (o.hash || '');
}
// </dil-kurali>

(() => {
  let seen = true;
  let hasCookie = true;
  try {
    hasCookie = /(?:^|;\s*)sod_lang=/.test(document.cookie);
    seen = sessionStorage.getItem('sod_lang_auto') === '1';
    sessionStorage.setItem('sod_lang_auto', '1');
  } catch {
    return; // Depolama yoksa "bir kez" garanti edilemez: yönlendirme yok.
  }
  const alternates = {};
  for (const l of document.querySelectorAll('link[rel="alternate"][hreflang]')) {
    const h = l.getAttribute('hreflang');
    if (h === 'x-default') continue;
    try {
      alternates[h] = new URL(l.getAttribute('href'), window.location.href).pathname;
    } catch {
      /* bozuk adres: o dil atlanır */
    }
  }
  const nav = window.navigator;
  const to = sodAutoLangTarget({
    hasCookie,
    seen,
    webdriver: nav.webdriver === true,
    userAgent: nav.userAgent,
    lang: document.documentElement.lang,
    languages: nav.languages && nav.languages.length ? Array.from(nav.languages) : [nav.language],
    alternates,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
  if (to) window.location.replace(to);
})();

// Dil seçici: seçilen dil `sod_lang` çerezine yazılır; uygulama (Merkez, DeciShip) aynı çerezi okur.
// Ad, yol ve alan uygulamanınkiyle aynı (Platform/packages/shell/src/i18n/setup.ts `writeLangCookie`). Çerez yazılınca
// kendiliğinden yönlendirme bir daha yapılmaz.
(() => {
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[hreflang][lang]') : null;
    const l = a && a.getAttribute('hreflang');
    if (l !== 'tr' && l !== 'en') return;
    try {
      const host = window.location.hostname;
      const domain = host === 'sellerondata.com' || host.endsWith('.sellerondata.com') ? '; Domain=.sellerondata.com' : '';
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `sod_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
    } catch {
      /* çerez yazılamazsa bağlantı yine çalışır */
    }
  });
})();
