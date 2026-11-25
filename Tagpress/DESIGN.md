---
name: TagPress Tezgâh
description: Etiket tasarım ve üretim aracı; araç rayı, cetvelli tuval, özellik paneli ve durum satırı. SellerOnData kabuğunun ölçülerini ve TagPress morunu izler.
colors:
  bg: "#f5f3ee"
  surface: "#ffffff"
  surface-2: "#faf9f6"
  surface-3: "#ebe8e1"
  border: "#e4e1da"
  line: "#d9d6cf"
  line-soft: "#eeebe5"
  border-strong: "#8f8a80"
  border-hover: "#6b665d"
  text: "#0f1a2e"
  text-2: "#475467"
  text-3: "#5f6b7f"
  placeholder: "#8d93a0"
  primary: "#7a5af8"
  primary-text: "#5b3fd6"
  primary-soft: "#efebff"
  primary-line: "#d6ccfb"
  focus: "#7a5af8"
  band: "#644acb"
  band-2: "#533da9"
  band-on: "#f2effe"
  band-accent: "#d0c5fd"
  band-error: "#ffb4ab"
  success: "#067647"
  success-bg: "#ecfdf3"
  success-line: "#abefc6"
  danger: "#c4271b"
  danger-hover: "#b42318"
  danger-bg: "#fef3f2"
  danger-line: "#fecdca"
  warning: "#b54708"
  warning-bg: "#fffaeb"
  warning-line: "#fedf89"
  canvas: "#e8e6ee"
  canvas-grid: "rgba(84, 74, 120, 0.08)"
  ruler-bg: "#fbfafc"
  ruler-line: "#dcd8e5"
  ruler-major: "#6e6782"
  ruler-minor: "#a8a1b8"
  ruler-hi: "rgba(122, 90, 248, 0.2)"
  cut: "#e0218a"
  crop: "#9a92b3"
  artboard-ink: "#5f5a70"
  dot-warn: "#f79009"
  dot-busy: "#1d5bd8"
  dot-ready: "#475467"
  info: "#174bb5"
  info-bg: "#e8eefc"
  info-line: "#c7d7f8"
  row-multi: "#f8f6ff"
  row-active: "#fbfaff"
  card-selected: "#fcfbff"
  check-line: "#a9a39a"
  tip-bg: "#1a1726"
  white: "#ffffff"
  # platform kopyası (tokens.css platform:base bloğu; Tezgâh'ta tagpress bloğu ezer)
  platform-primary: "#1d5bd8"
  platform-primary-hover: "#174bb5"
  platform-primary-active: "#133f99"
  platform-primary-soft: "#e8eefc"
  platform-primary-line: "#c7d7f8"
  night: "#0a1a3a"
  brand-ink: "#0f2a5c"
  accent: "#fdb022"
  focus-on-dark: "#b5cbff"
  hub-band: "#2a2d34"
  hub-band-2: "#363a43"
  hub-band-on: "#d3d6dc"
  hub-cta-hover: "#fec04d"
  chart-2: "#dc6803"
  chart-3: "#0e9384"
  chart-prev: "#98a2b3"
typography:
  body:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.45"
  panel:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  panel-title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  nav:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "20px"
  guided:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: "44px"
  sub:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "17px"
    lineHeight: "24px"
  small:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
  section:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.06em"
  status:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "11.5px"
  kbd:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 500
  rail-key:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "9px"
    fontWeight: 500
rounded:
  kbd: "4px"
  zoom: "5px"
  field: "6px"
  tool: "8px"
  rail: "9px"
  page: "10px"
  guided: "12px"
  card: "16px"
  pill: "999px"
spacing:
  top-row: "72px"
  work-row: "44px"
  full-band: "240px"
  rail: "48px"
  rail-button: "38px"
  panel-left: "280px"
  panel-right: "300px"
  panel-head: "40px"
  tool-strip: "44px"
  status-bar: "28px"
  selection-bar: "42px"
  ruler: "22px"
  field: "30px"
  tool-button: "32px"
  page-button: "40px"
  guided-button: "48px"
  list-row: "46px"
  table-row: "38px"
---

# TagPress Tezgâh

Görünümün tek kaynağı `docs/tezgah-tuval.html` (dilin kuralları ve altı onaylı maket). Değerlerin tek kaynağı
`Platform/packages/tokens/tokens.json` (`base`, `products.tagpress`, `bands.tagpress`, `surfaces.tagpressWeb`); üretilen
`apps/web/src/tezgah/tokens.generated.css` (aracın rengi ve `--tz-*`), yerel kipte ayrıca `tokens.css` (`base` kopyası). Yukarıdaki
ön bilgi onların aynasıdır (impeccable kancası buradan okur). Uygulama planı `ARAYUZ-PLANI.md`.

- **Kabuk:** platformun üst satırı (72 px, her ekranda Merkez ve DeciShip sütununda: 1240 px, ortada) ve TagPress bandı (`#644acb`). Platform kipinde
  ortak kabuk (`AppShell workspace`, bant boyu `work`): Merkez ve DeciShip'teki gibi ⊞ logonun sağında, menü bölmeli
  sekmeler (simgeli), kurulum bitmemişse başında "Kurulum · Eksik". Yerel kipte aynı ölçülerle kendi üst satırı
  (`tezgah/cerceve`; ⊞ ve hesap yok, alt çizgili menü, "Kurulum · Eksik" aynı kuralla). Çalışma ekranlarında altında
  yalnız 44 px iş satırı; kılavuzlu akışlarda (Kurulum) 240 px bant ve banda binen kart.
- **Yerleşim:** çalışma ekranları (tuvalli, panelli) kenardan kenara; form ve liste ekranları (Kurulum, Ayarlar, listeler)
  Merkez/DeciShip sütununda (en çok 1240 px, kenar 32, telefonda 16, ortada). Tablette çalışma ekranının panelleri
  tuvalin üstüne çekmece; telefonda çalışma ekranı yerine kısa not. Tür listesi ve dar ekran kuralları `ARAYUZ-PLANI.md`
  "Yerleşim".
- **Izgara:** ray 48 · sol panel 240–330 · esnek tuval · özellik paneli 300–330. Araç şeridi 44, durum satırı 28.
- **Renk:** bant yalnız üst satır ve iş satırında. Mor (`#7a5af8`) etkin araç, seçim, tutamak, cetvel vurgusu, odak ve
  tek birincil eylem; mor durum göstermez. Rozet yalnız sorun (kırmızı hata, turuncu uyarı); öteki durumlar küçük nokta.
  Kesim çizgisi (`#e0218a`) yalnız baskı önizlemesinde.
- **Yoğunluk:** panel metni 13 px; alan 30 px (köşe 6), araç düğmesi 32 px (köşe 8), sayfa düğmesi 40 px (köşe 10),
  kılavuzlu akış düğmesi 48 px (köşe 12); liste satırı 46, tablo satırı 38.
- **Kısayol:** rozet yalnız birincil düğmede ve ekranın en sık 2–4 işinde; gerisi ipucunda ve `?` listesinde.
- **Yazı:** IBM Plex Sans ve Mono, pakete gömülü. Yalnız açık tema.
- Baskı verisindeki renkler (`#000`, `#1a4db3` gibi) arayüz rengi değildir; `.impeccable/config.json` istisnaları bunlar için.
