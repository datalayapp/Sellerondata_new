# TagPress Tezgâh arayüzü: uygulama planı

> Hazırlanış: 2026-11-21. Kaynaklar: `Tagpress/YOL-HARITASI.md` (onaylı kararlar), `Tagpress/docs/tezgah-tuval.html` (görünümün tek kaynağı), bugünkü `Tagpress/apps/web/src`, `Platform/packages/{tokens,shell,contracts}`, `Platform/templates/tool-web`, `Deciship/apps/web` i18n kurulumu, `Platform/docs/DESIGN.md`.
> **[V]** ile başlayan maddeler varsayımdır. Kullanıcı aksini söylerse plan o maddede değişir.

## 0. Kısaca

- Yeni arayüz, eskisinin yanında ikinci bir giriş sayfasında (`tezgah.html`) kurulur. Eski uygulama geçiş dalgasına kadar varsayılan kalır. İki sayfanın CSS'i karışmaz: Tailwind ve "Baskı Provası" teması yeni sayfaya hiç yüklenmez.
- 1. aşamada Platform paketleri bağlanmaz. TagPress kendi ince kabuğunu kurar; kabuk platform kabuğunun ölçülerini, CSS değişken adlarını ve i18next kurulumunu birebir izler. Belirteç değerleri kopyalanır ve bir test, kopyanın `tokens.json`'dan kaymadığını denetler.
- Önce Dalga 0: sözleşme, altyapı, rotalar, yer tutucular ve kısayol kaydı. Sonra temel bileşenler ile ekranlar dalgalar hâlinde, aynı anda en çok 4 ajanla. Ajanlar commit atmaz; commit'i orkestratör atar.
- Saf mantık dosyaları (testli olanlar) korunur; yalnız içlerindeki Türkçe metin sözlüğe taşınır, test beklentileri aynı Türkçe sonucu denetler. Bütün `.tsx` ekran bileşenleri ve `src/ui/**` yeniden yazılır.
- Klavye kısayolları tek kayıttan gelir: düğme ipucu, rozet, `aria-keyshortcuts` ve `?` listesi aynı kaynaktan okunur.

## 1. Platform paketleriyle ilişki (1. aşama)

> Bugünkü hâl (2. aşama): platform kipinde `@sellerondata/shell` bağlı (`AppShell workspace`, bant boyu `work`; paketler pnpm `link:` ile, Vite `dedupe`), belirteçlerin tek kaynağı `Platform/packages/tokens/tokens.json` (`bands.tagpress`, `surfaces.tagpressWeb` → üretilen `src/tezgah/tokens.generated.css`). `src/tezgah/tokens.css` yalnız yerel kipte yüklenen `base` kopyasıdır. Bu bölümün geri kalanı 1. aşamanın gerekçesidir.

**Karar: `@sellerondata/shell` ve `@sellerondata/tokens` şimdi bağlanmaz. TagPress `src/tezgah/` içinde ince bir kabuk kurar; platformun ölçülerini ve adlarını izler, belirteç değerlerini kopyalar, kopyanın kaymadığını testle doğrular.**

Gerekçe:
- **pnpm ile `file:` sürtünmesi.** pnpm `file:` klasörünü kopyalayarak kurar (Platform değişikliği yeniden kurulana kadar görünmez); `link:` ise kabuğun `react`, `i18next`, `@sellerondata/contracts` içe aktarmalarını Platform klasöründen çözer (iki React kopyası ya da çözülemeyen içe aktarma). Kökteki `file:` denetimleri npm için yazılmış; workspaces kararı (KALANLAR 6.27) açık.
- **Kabuk oturuma bağlı.** `AppShell` `me`, `onLogout`, `onSwitchOrg` ister; `SessionBanner`, `usePrefetchProducts`, `ErrorBoundary` Merkez yollarını varsayar. Girişsiz uygulamada boş kalır ya da yanlış yere götürür.
- **Kabukta Tezgâh bandı yok.** Bant yalnız `standard` (en az 240 px) ve `hero`; içerik 1240 px `.sod-wrap` içinde. Onaylı karar 72 + 44 px alçak bant ve kenardan kenara çalışma alanı istiyor; bu Platform kabuğunda yeni bant boyu demek (2. aşama işi).
- **Belirteç paketinin çalışma zamanı çıktısı yok.** Uygulamalar üretilmiş CSS'i kabuktan alır; belirteçleri bağlamak kabuğu bağlamak demektir.

Uyumun korunması:
- CSS değişkenleri platform adlarıyla: `--bg`, `--surface`, `--surface-2/-3`, `--border`, `--line`, `--line-soft`, `--text`, `--text-2/-3`, `--placeholder`, `--success/-bg/-line`, `--danger…`, `--warning…`, `--r-ctl`, `--r-btn`, `--r-card`, `--r-pill`, `--sh-lg`, `--f`, `--fm`, `--sod-band…`. Tezgâh'a özgü olanlar `--tz-` önekiyle.
- Bant renkleri kabuğun `bandTheme('tagpress')` formülüyle aynı (`#644acb`, `#533da9`, `#f2effe`, `#d0c5fd`).
- Kayma testi `src/tezgah/tokens.test.ts`: `tokens.css`'teki `base` kopyası `tokens.json` ile eşit mi, üretilen `tokens.generated.css` güncel mi; bant değerleri formülle eşit mi; ana metin/zemin çiftleri en az 4.5:1 mi; kesim ve cetvel renkleri tanımlı mı.
- i18n `i18next` + `react-i18next` ile DeciShip'teki gibi: ad alanı = dosya adı, `initShellI18n` ile aynı imza. İlk dil kuralı `pickInitialLocale` ile aynı; kopyası `src/i18n/locale.ts`'te, bir test `Platform/packages/contracts/src/locale.ts` ile aynı sonucu verdiğini denetler.
- Üst satırın DOM'u ve ölçüleri kabukla piksel aynı (DESIGN §4): marka kilidi en az 160 px, menü 15/20 ve araları 24 px, sağ küme 44 px.

2. aşamada yapıldı: Platform kabuğuna `BandSize: 'work'` ve `AppShell workspace` eklendi; `tokens.json`'a `surfaces.tagpressWeb` girdi, `--tz-*` oradan üretilir; platform kipinde `TopRow` yerine `AppShell` (`src/oturum/Kabuk.tsx`), yerel kipte `src/tezgah/cerceve/` üst satırı kaldı; platform kipinde dil kabuğun `initShellI18n`'iyle (`src/oturum/giris.tsx`), yerel kipte `src/i18n/index.ts`.

## 2. Geçiş stratejisi

- **Yan yana giriş.** Dalga 0 `apps/web/tezgah.html` ve `src/tezgah/main.tsx` ekler; Vite derleme girdisine iki HTML yazılır (**[V]** Vite 8'de `build.rolldownOptions.input`; doğrulanacak). Sunucu `dist` içindeki dosyayı olduğu gibi sunar (`apps/server/src/app.ts`). Geliştirmede `127.0.0.1:5421/tezgah.html#/uretim`, derlenmişte `5420/tezgah.html`.
- **Klasör düzeni.** `src/tezgah/` temel katman; `src/ekranlar/<ekran>/` yeni ekranlar; `src/ortak/` alan bileşenleri (şablon seçici, etiket görseli); `src/i18n/` ve `src/locales/{tr,en}/` sözlük. Eski kod (`src/screens/**`, `src/ui/**`, `src/App.tsx`, `src/main.tsx`, `src/index.css`) geçişe kadar yerinde.
- **Paylaşılan mantık yerinde kalır.** Yeni ekranlar saf dosyaları bugünkü yolundan içe aktarır (ör. `../../screens/uretim/jobs.ts`). `src/ekranlar/<ekran>/mantik/` altına taşıma geçiş dalgasında, tek commit'te. Temele alınan iki dosya (`screens/baski/canvas-math.ts` + testi, `useCanvasView.ts`) Dalga 0'da `src/tezgah/tuval/` altına taşınır; eski yolda tek satırlık yeniden dışa aktarma kalır.
- **Eski uygulama çalışır kalır.** Saf dosyalardaki metin `i18n.t` ile sözlükten okunur; eski giriş sözlüğü TR'ye sabitlenmiş başlatır (`initI18n({ forceLocale: 'tr' })`). Testler TR sözlüğünü yükleyen yardımcıyla (`src/i18n/test.ts`) aynı beklentilerle koşar.
- **Eski tema.** `index.css`, Tailwind ve Schibsted/JetBrains yazı tipleri yalnız eski girişte yüklenir; geçiş dalgasında silinir, paketleri (`tailwindcss`, `@tailwindcss/vite`, `@fontsource-variable/schibsted-grotesk`, `@fontsource/jetbrains-mono`, kullanılmıyorsa `clsx`) çıkar.
- **`.impeccable` kancası.** Kanca en yakın `DESIGN.md`'yi (`Tagpress/DESIGN.md`, eski palet) okur; böyle kalırsa yeni dosyalardaki mor, 6/8/10 px köşe ve IBM Plex "DESIGN.md dışında" diye işaretlenir. Dalga 0 ilk iş: `Tagpress/DESIGN.md`'yi Tezgâh'a göre yeniden yazar (ön bilgi blokta renk, yazı, köşe ölçeği `tokens.css` ile aynı; metin kısa, `docs/tezgah-tuval.html`'e işaret eder); `.impeccable/design.json`, `tasarim-brifi.md`, `review*/`, `yon-secimi.json` silinir; `ignoreValues` içindeki baskı verisi istisnaları (`#000`, `#1a4db3`) kalır.

## 3. Temel katman

### 3.1 Belirteçler (bugün `tokens.json` → `src/tezgah/tokens.generated.css`; değerler aynı)

- **Platformdan kopya** (kayma testi denetler): bütün `base` değerleri; `--primary #7a5af8`, `--primary-text #5b3fd6`, `--primary-soft #efebff`; bant `--sod-band #644acb`, `-2 #533da9`, `-on #f2effe`, `-accent #d0c5fd`, `-cta #fff`, `-cta-ink #644acb`.
- **Maketten, TagPress'e özgü:** `--primary-line #d6ccfb`; `--focus #7a5af8`, `--focus-ring 0 0 0 3px rgba(122,90,248,.18)`. **[V]** `--primary-hover` / `--primary-active` `color-mix` ile %88 / %78 siyah karışımı.
- **Tezgâh renkleri:** `--tz-canvas #e8e6ee`, `--tz-canvas-grid rgba(84,74,120,.08)`; cetvel `--tz-ruler-bg #fbfafc`, `--tz-ruler-line #dcd8e5`, `--tz-ruler-major #6e6782`, `--tz-ruler-minor #a8a1b8`, `--tz-ruler-hi rgba(122,90,248,.2)`; kesim çizgisi `--tz-cut #e0218a` (yalnız baskı önizlemesinde), kesim işareti `--tz-crop #9a92b3`; tuval üstü ad `--tz-artboard-ink #5f5a70`; noktalar `--tz-dot-warn #f79009`, `--tz-dot-busy #1d5bd8`.
- **Tezgâh ölçüleri:** bant `--tz-top-h 72px`, `--tz-work-h 44px`, `--tz-band-full 240px`; ray `--tz-rail-w 48px`, `--tz-rail-btn 38px`; paneller `--tz-panel-l 280px` (240–330), `--tz-panel-r 300px` (300/310/330), başlık `--tz-panel-head 40px`; şeritler `--tz-strip-h 44px`, `--tz-status-h 28px`, `--tz-selbar-h 42px`; cetvel `--tz-ruler 22px`, ızgara `--tz-grid-mm 5`; alan `--tz-ctl-h 30px` (köşe 6), araç düğmesi `--tz-tool 32px` (köşe 8), sayfa düğmesi 40 px (köşe 10), kılavuzlu akış düğmesi 48 px (köşe 12); liste satırı 46 px, tablo satırı 38 px, tablo başlığı 34 px.
- **Yazı:** gövde 14/1.45; panel metni 13; panel başlığı 14/600; bölüm başlığı Mono 11, büyük harf, .06em; küçük metin 12; durum satırı Mono 11.5; kısayol rozeti Mono 10.5, 18 px, alt kenarı 2 px. IBM Plex Sans 400/500/600 ve Mono 400/500, `@fontsource` ile pakete gömülü (DeciShip ile aynı sürüm); Google Fonts yok.
- **Tema:** yalnız açık tema (bkz. §12).

### 3.2 CSS kuralları

- Düz CSS, Tailwind yok. Her bileşenin CSS'i yanında (`Panel.css`, `Panel.tsx` içe aktarır); paralel ajanlar aynı dosyaya dokunmaz.
- Önekler: temel `tz-`; Üretim `ur-`, Düzelt `dz-`, İçe aktarma `ia-`, Baskı masası `bm-`, Sayfa şablonları ve Arşiv `bs-`, Tasarım dili `td-`, Şablonlar `sb-`, Ayarlar `ay-`, Kurulum `kr-`, ortak `or-`.
- Ekranlar renk ve ölçüyü elle yazmaz, yalnız `var(--…)`. Yeni değer gerekirse orkestratörden istenir.
- `src/tezgah/base.css`: sıfırlama, odak çizgisi (2 px mor, 2 px açıklık), `.tz-mono` (tabular-nums), `prefers-reduced-motion`, `forced-colors` asgarisi.

### 3.3 Bileşen sözleşmesi (`src/tezgah/index.ts`)

Dalga 0 bu imzaları gerçek kod olarak yazar; her bileşenin en sade çizimi (doğru HTML ve erişilebilirlik öznitelikleriyle) aynı commit'e girer. Ekran ajanları bu imzalara karşı yazar. Sözleşme Dalga 0'dan sonra donar; değişikliği yalnız orkestratör yapar.

```ts
// Çerçeve
AppFrame { band: 'work' | 'full'; active: NavId | null; workRow?: ReactNode; fullBand?: ReactNode; children }
// NavId: 'uretim' | 'tasarim-dili' | 'sablonlar' | 'baski' | 'ayarlar'. Üst satır içeride çizilir: marka, 5 menü, sağ küme.
WorkRow { back?: { command: CommandId; onClick(): void }; crumbs: Crumb[]; tabs?: BandTabs; flow?: FlowStep[];
          meta?: ReactNode; actions?: ReactNode }        // en sağda her zaman ? düğmesi
Crumb { label: string; onClick?(): void; menu?: (close: () => void) => ReactNode;
        rename?: { value: string; onRename(v: string): void } }
FlowStep { id: string; label: string; count?: number; error?: boolean; active?: boolean; hint?: string; onClick(): void }   // hint: ipucu
BandTabs { items: { id: string; label: string; count?: number }[]; value: string; onChange(id: string): void }
BandButton { label: string; icon?: IconName; command?: CommandId; cta?: boolean; quiet?: boolean; iconOnly?: boolean;
             disabled?: boolean; menuItems?: (MenuItem | 'sep')[]; onClick?(): void }
// iconOnly varsayılanı: quiet && icon; false → ikon + yazı. menuItems: düğme menü açar (sağda ⌄)
FullBand { kicker: Crumb[]; title: string; sub?: string; aside?: ReactNode }   BandCard { children; footer?: ReactNode }
StepChips { steps: string[]; current: number }              // current sıfırdan başlar
// Yerleşim
Workspace { rail?: ReactNode; left?: ReactNode; leftWidth?: 240 | 260 | 270 | 280 | 300 | 330; right?: ReactNode;
            rightWidth?: 300 | 310 | 330; children }    // orta sütun; yükseklik = pencere − bant
Rail { label: string; items: (RailItem | 'divider')[]; value: string; onChange(id: string): void }  // ok tuşlarıyla gezilir
RailItem { id: string; icon: IconName; command: CommandId }   // adı ve kısayolu ipucunda
Panel { side: 'left' | 'right'; title?: ReactNode; count?: ReactNode; actions?: ReactNode; footer?: ReactNode; children }
PanelSection { heading?: string; aside?: ReactNode; children }   PropRow { label: string; htmlFor?: string; children }
PropPair { children }
CollapsedGroup { title: string; summary?: ReactNode; defaultOpen?: boolean; persistKey?: string; children }
CenterColumn { strip?: ReactNode; selectionBar?: ReactNode; status?: ReactNode; children }
ToolStrip { children }   ToolGroup / ToolDivider / ToolSpacer / ToolLabel { children? }
SelectionBar { label: string; onClear(): void; children }       // Esc = onClear (kayıt Esc'i işlemediyse)
StatusBar { children; end?: ReactNode }                          // end: ZoomControl
ListRow { leading?: ReactNode; title: ReactNode; sub?: ReactNode; trailing?: ReactNode; current?: boolean;
          multi?: boolean; checkbox?: { checked: boolean; onChange(v: boolean): void }; onClick(e: MouseEvent): void }  // 46 px; e: Ctrl/Shift tık
Tabs { items: TabItem[]; value: string; onChange(id: string): void }
TabItem { id: string; label: string; count?: number; menu?: boolean; menuItems?: (MenuItem | 'sep')[] }
// menuItems: sekme menü açar (tık, Enter, ↓); oklarla gelince seçilmez, seçimi öğe yapar
// Düğme ve rozet
Button { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; size?: 'mini' | 'tool' | 'page' | 'guided';
         icon?: IconName; command?: CommandId; kbd?: boolean; wide?: boolean; loading?: boolean; chevron?: boolean } & ButtonHTMLAttributes
IconButton { icon: IconName; label?: string; command?: CommandId; size?: 26 | 28 | 32; pressed?: boolean }
// IconButton: label ya da command zorunlu. Button, IconButton, BandButton, RailItem ipucunu Tooltip ile gösterir
// (tarayıcı title'ı yok; ad + kısayol; klavye odağında ve pasif düğmede de); `title` verilirse ipucu metni o olur.
Kbd { command?: CommandId; keys?: string; combo?: string | string[]; on?: 'primary' | 'band' }
// keys: görünen metin ("Enter"); combo (ya da keys içinde) kayıt yazımı "mod+enter" → Windows "Ctrl Enter", Mac "⌘ Enter"
// Form (30 px)
TextField / TextArea { value: string; onChange(v: string): void; invalid?; unit?: string; autoGrow?: boolean }
SearchField { value; onChange; command?: CommandId }
Select<T> { value: T; options: { value: T; label: string }[]; onChange(v: T): void; invalid?: boolean }
NumberStepper { value: number; step: number; min?: number; max?: number; format(v: number): string; onChange(v: number): void;
                editable?: boolean; parse?(text: string): number | null }   // editable: elle yazılır (Enter/odak kaybı uygular, geçersizde eski değer)
Segmented<T> { value: T; options: { value: T; label: string }[]; onChange(v: T): void }
Switch { checked: boolean; onChange(v: boolean): void; label: string; id?; 'aria-labelledby'?; 'aria-describedby'? }
Checkbox { checked: boolean | 'mixed'; onChange(v: boolean): void; label: string }
Field { label: string; hint?: string; error?: string; children }            // üstte etiketli (Ayarlar, pencereler)
// Field: metin alanı ve Select'e id + invalid; Switch, Segmented, Checkbox'a aria-labelledby (etiketin kimliği)
// Durum
StatusDot { tone: 'ok' | 'warn' | 'error' | 'busy' | 'ready' | 'idle' | 'info'; label?: string }   // nokta + görünür kısa metin
IssueBadge { tone: 'error' | 'warn'; children }     Tag { tone: 'neutral' | 'accent' | 'info'; children }
IssueBox { tone: 'error' | 'warn' | 'ok' | 'info'; children; fixes?: ReactNode }   // info: mavi bilgi notu
ProgressBar { value: number; max: number; label: string }
EmptyState { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode }
// Tuval (dünya birimi mm)
useViewport({ world: Rect; pad?: number; min?: number; max?: number }): ViewApi
// ViewApi = { view, size, zoomIn, zoomOut, fit(r?: Rect), actual, toRect(r: Rect), zoomLabel, bind, canvas }
// (canvas: alttaki useCanvasView; sürükleme ve istemci → dünya dönüşümü için)
CanvasViewport { api: ViewApi; rulers?: boolean; grid?: boolean; highlight?: { x?: [number, number]; y?: [number, number] };
                 overlay?: ReactNode; onBackground?(e: PointerEvent): void; children }
ZoomControl { api: ViewApi; presets: ('fit' | 'actual' | 'selection')[]; onSelection?(): void;
              labels?: { fit?: string; actual?: string; selection?: string } }  // tuval kısayollarını da bağlar
Artboard { x: number; y: number; w?: number; h?: number; name: ReactNode; tag?: ReactNode; selected?: boolean; below?: ReactNode; children }
SelectionBox { rect: Rect; handles?: boolean; sizeLabel?: string }
CutPath { shape: 'circle' | 'rect' | 'path'; d?: string; rect: Rect }
CropMarks { rect: Rect }   CanvasDock { children }   // tuvalin altında yüzen kutu ("Şunu değiştir")
// Katmanlar
Popover { trigger(p: TriggerProps, open: boolean): ReactNode; align?: 'start' | 'end'; width?: number; open?: boolean;
          onOpenChange?(o: boolean): void; children(close: () => void): ReactNode; role?: 'dialog' | 'menu' }
Menu { trigger(p: TriggerProps): ReactNode; items: (MenuItem | 'sep')[]; align?: 'start' | 'end' }
MenuItem { label: string; icon?: IconName; command?: CommandId; danger?: boolean; disabled?: boolean; onSelect(): void }
Dialog { title: string; onClose(): void; size?: 'sm' | 'md' | 'lg'; dirty?: boolean; busy?: boolean;
         footer?: ReactNode; children }
// Dialog: odak tuzağı, Esc; değişiklik varsa sarı onay şeridi (platform DESIGN §4b)
useToast(): (t: { message: ReactNode; tone?: 'default' | 'success' | 'error';
                  action?: { label: string; run(): void | Promise<void> }; duration?: number }) => void
// Bildirimler açık modal pencere varken en üstteki pencerenin içinde (görünür, tıklanır, geri al çalışır)
useConfirm(): (o: { title: string; body?: ReactNode; confirmLabel?: string; tone?: 'default' | 'danger' }) => Promise<boolean>
useLeaveGuard(dirty: boolean, o?: { title?: string; body?: ReactNode; confirm?: string; allow?(nextHash: string): boolean }): { pass(): void }
// dirty iken adres değişimi (üst menü, Alt 1–5, geri düğmesi, tarayıcı geri) onay ister; sekme kapatmada tarayıcı uyarısı.
// pass(): bir sonraki gezinme sorulmaz (kaydedip hemen gitmek için). go(…, replace) olay üretmez, bekçiye takılmaz.
// Basılı düğme: Button/IconButton aria-pressed="true" → mor zeminli etkin görünüm
Tooltip { content?: ReactNode; command?: CommandId; children: ReactElement }
Icon { name: IconName; size?: 18 | 15 | 12 }   // maketteki sprite adları + 'info', 'list', 'unlock'; lucide karşılığı olanlar lucide'den
// Ortak alan bileşenleri (src/ortak/)
TemplatePicker (bugünkü TemplatePickerProps aynen)   TemplateThumb { url: string; size: number }
LabelImage { src: string; widthMm: number; heightMm: number; alt: string; dimmed?: boolean; children? }   // bindirme için
JobStatusDot { status: JobStatus; withLabel?: boolean }   DesignLanguageSwitcher {}
ElleEkle { open: boolean; languageId: string; onClose(): void; onAdded(jobId: string): void }
```

- `useToast` ve `useConfirm` bugünkü `ui/feedback.tsx` ile aynı imzada; böylece `screens/uretim/data.ts` ve `screens/baski/useSessionEditor.ts` iki girişte de çalışır. Dalga 0 iki hook'un context'ini nötr bir dosyaya (`src/lib/notify.ts`) taşır; eski ve yeni sağlayıcı aynı context'i doldurur.
- **[V]** Üst satırın sağ kümesi 1. aşamada: ⊞ ve avatar yok; firma düğmesinin yerinde aynı biçimde `DesignLanguageSwitcher`; üretim sürerken "Üretiliyor 2 · sırada 3" mavi noktayla; bağlantı yalnız koptuğunda kırmızı noktayla; günün maliyeti Ayarlar > Maliyet'e ve Üretim'in durum satırına geçer.

## 4. i18n

- **Yapı:** `src/i18n/index.ts` `initI18n({ forceLocale? })`; kaynaklar `import.meta.glob('../locales/*/*.json')` (DeciShip kalıbı); `defaultNS: 'common'`, `fallbackLng: 'en'`; platformdaki çift noktayı teke indiren son işleyici. Çerçeve metinleri `frame` ad alanında (`shell` adı 2. aşamada kabuğun olacak).
- **İlk dil.** `src/i18n/locale.ts` `detectLocale()`: yerel kayıt `tagpress.arayuzDili` → `sod_lang` çerezi → `navigator.languages` içindeki ilk tr/en → İngilizce. `setLocale()` yerel kayda ve çereze yazar. `studio.dil` anahtarı tasarım dili seçimi içindir. Kodda "language" = tasarım dili, "locale" = arayüz dili; yeni kodda tasarım dili kancası `useDesignLanguage`.
- **Ad alanları** (dosya adı = ad alanı, İngilizce camelCase): genel `common`, `frame`, `shortcuts`, `errors`, `issues`, `shared`; ekranlar `production`, `adjust`, `importDesk`, `printDesk`, `printTemplates`, `printArchive`, `designLanguage`, `designLanguageLab`, `profile`, `templates`, `settings`, `setup`. Dalga 0 hepsini TR ve EN'de iskelet olarak açar; her dosyanın tek sahibi vardır (§8).
- **Anahtarlar:** `<ad alanı>:<bölge>.<öğe>`, İngilizce camelCase (ör. `production:queue.title`). Çoğul `_one`/`_other`; değişken `{{n}}`; cümle parçalardan birleştirilmez. Kısayol adları: genel ve tuval komutları `shortcuts:<id>`, ekran komutları `<ekran ad alanı>:shortcuts.<id>`.
- **Dile özgü mantık:** `screens/tasarim-dili/tr.ts` (ek uyumu, `pctOwn`, `joinList`, `num`) `src/i18n/dil/tr.ts`'e taşınır, yanına `en.ts`; i18next biçimleyicisi olarak kaydedilir (`"{{v, pctOwn}}"`: TR "%97'si", EN "97%"). Liste birleştirme EN'de `Intl.ListFormat`; TR'de bugünkü işlev. Para ve sayı biçimi `src/i18n/bicim.ts`'te etkin dile göre; TR çıktısı aynı. Eski yolda yeniden dışa aktaran dosya kalır; `anlatim.test.ts` değişmez.
- **Sunucudan gelen Türkçe** (geçici). `src/i18n/sunucu.ts`: `serverText(e)` (hata kodu sözlükte varsa `errors:<code>`; yoksa TR'de sunucu metni, EN'de `errors:generic` + ayrıntı ipucunda asıl metin), `issueText(issue)` (`issues:<code>` yoksa sunucu mesajı), `fixLabel(fix)` (`issues:fix.<kind>` + `{{value}}`), `undoText(token)`. Sunucunun kod + parametre göndermesi ayrı iş.
- **Domain kaynaklı Türkçe.** `PROFILE_GROUPS` ve `PROFILE_DOCS` (yaklaşık 86 etiket ve açıklama) web'de `profile:groups.<id>` ve `profile:fields.<yol>.{label,help}` anahtarlarına bağlanır; anahtar yoksa domain metni. `locales.test.ts` her alanın TR ve EN anahtarını denetler.
- **Denetim:** `apps/web/scripts/check-i18n.mjs`, `Platform/scripts/check-i18n.mjs`'i çağırır (`--src src/tezgah,src/ekranlar,src/ortak,src/i18n --strict`); `package.json`'a `check:i18n`; kök `scripts/parts.mjs`'e `tp-web-i18n` parçası, `scripts/test-changed.mjs`'e `i18n` alanı. Betik TR/EN eşliği, boş değer, yasak sözcük, eksik anahtar, kodda kalan Türkçeyi yakalar. Kullanılmayan anahtarı `locales.test.ts` yakalar. Geçiş dalgasında `--src src`.

## 5. Kısayol kaydı (`src/tezgah/kisayol/`)

```ts
type Scope = 'genel' | 'tuval' | 'uretim' | 'duzelt' | 'iceAktar' | 'baskiMasa' | 'baskiSablon' | 'tasarimDili'
           | 'sablonlar' | 'ayarlar' | 'kurulum'
interface Command { id: CommandId; scope: Scope; keys: string[]; group: string; badge?: 'primary' | 'frequent';
                    inInput?: boolean; repeat?: boolean; passive?: boolean }   // passive: işleyicisi kayıtta değil (Boşluk)
defineCommands(list: Command[]): void                        // her ekranın kisayollar.ts dosyası
useCommands(scope: Scope, handlers: Partial<Record<CommandId, (e: KeyboardEvent) => unknown>>,   // false: olay serbest
            opts?: { enabled?: boolean; modal?: boolean }): void   // modal: alt kip / açık pencere
useCommand(id: CommandId): { label: string; keysText: string; ariaKeyShortcuts: string; showBadge: boolean; tooltip: string }
```

- **Kimlik ve ad.** Genel ve tuval komutları `shortcuts:<kimlik>` (ör. `canvas.fit`); ekran komutunun kimliği `<kapsam>.<ad>` (ör. `uretim.approve`), adı `<ekran ad alanı>:shortcuts.<ad>` (`production:shortcuts.approve`). Tuval kullanan kapsamlar `CANVAS_SCOPES` (duzelt, baskiMasa, baskiSablon, sablonlar, tasarimDili); çakışma denetimi genel + (tuval) + ekran kümesine bakar. `ZoomControl` bağlıyken tuval komutlarının işleyicisini kendisi verir.
- **Tek kaynak.** `Button` ve `IconButton` `command` alırsa adını, ipucunu ("Onayla · 2") ve `aria-keyshortcuts`'u kayıttan alır. Rozet yalnız `badge` işaretli komutta. `?` listesi etkin kapsamların komutlarını gruplu gösterir; tuval komutlarından yalnız işleyicisi verilenler (ve `passive`) görünür.
- **Serbest bırakma.** İşleyici `false` dönerse olay işlenmemiş sayılır: `preventDefault` yapılmaz, başka kayıt denenmez (ör. odaktaki düğmede Enter düğmeye tıklar). Dönüş yoksa olay engellenir.
- **Tuş adları.** Kayıtta `mod+s`, `shift+n`, `1-9`, `space`, `?`. Ekranda Windows'ta "Ctrl S", Mac'te "⌘ S"; boşluk TR "Boşluk", EN "Space".
- **Klavye düzeni.** Simge tuşları (`=`, `-`, `[`, `]`, `,`, `.`, `/`, `?`) üretilen karakterle (`e.key`) eşleşir; hangi bileşimle yazıldığı önemsiz (Türkçe Q'da `=` Shift 0, `[` AltGr 8; Shift ve AltGr yok sayılır). Harf, rakam, adlı tuş ve `mod+`/`alt+` fiziksel kalır. Bir olay hem karakterle hem fiziksel eşleşirse karakter kazanır (Türkçe'de Shift 0 = `=` büyütür, `shift+0` gerçek boyuta düşmez). `?` listesi simgeyi olduğu gibi yazar; tuşu olmayan komut listede yok.
- **Dağıtıcı.** Pencerede tek `keydown` dinleyicisi (yakalama evresi; işlediği olayı `preventDefault` eder). Kapsam önceliği: alt kip (`modal`) > ekran > tuval > `genel` (Alt+1–5 menü, `?`); aynı düzeyde sonra kaydolan kazanır. Yazı alanında çalışmaz (istisna `inInput`: Esc, Ctrl Enter, Ctrl S); açık pencerede (`dialog[open]`, `aria-modal`) yalnız `modal` kayıtlar çalışır. Ortak tuval komutları `tuval` kapsamında: Ctrl −, Ctrl =, Shift 1 sığdır, 1 ya da Shift 0 gerçek boyut, Shift 2 seçime, Boşluk ile kaydır.
- **Testler** (`kisayol.test.tsx`): aynı anda etkin kapsamlarda iki komut aynı tuşu taşımaz; her komutun TR ve EN adı var; bir ekranda en çok 1 `primary` ve 4 `frequent` rozet; yazı alanında komut çalışmaz.
- **[V]** Düzelt'te tuşlar makete uyar: Enter metni düzenler, Ctrl S kaydeder (bugün Enter kaydediyor).

## 6. Rotalar

- `lib/route.ts` genişler: `RouteId = Tab | 'duzelt' | 'kurulum' | 'vitrin'`. `TABS` aynen kalır.
- Rotalar: `#/uretim?parti=&is=` (tek ekran); `#/uretim/ice-aktar`; `#/duzelt/<varyantId>?don=<geri dönülecek hash>` (etkin menü `don` adresinin sekmesi); `#/tasarim-dili/<bölüm>[/<grup>]`; `#/sablonlar[/<anahtar>]`; `#/baski`, `#/baski/masa/<oturum>`, `#/baski/sablonlar[/<id>]`, `#/baski/arsiv`; `#/ayarlar/<bölüm>`; `#/kurulum[/<adım>]`; `#/vitrin` (yalnız geliştirmede, bütün temel bileşenler).
- Eski bağlantılar çalışır: `#/uretim/karsilastir?is=` → `#/uretim?is=`.
- Dalga 0 `src/tezgah/rotalar.tsx` içinde her rotayı tembel yüklenen `src/ekranlar/<ekran>/index.tsx`'e bağlar; başlangıçta yer tutucu. Ekran ajanı yalnız kendi `index.tsx`'ini değiştirir.

### Yerleşim

- **İki tür ekran; tek kaynak** `lib/route.ts` `screenKind(route)` (`work` | `column`). Platformda `oturum/Kabuk.tsx` kabuğa `AppShell column` verir; `TezgahApp` türü bağlamla (`tezgah/cerceve/duzen.ts`) çerçeveye, çalışma alanına ve iş satırına geçirir. Yeni rota eklenince türü burada yazılır.
- **Çalışma ekranları** kenardan kenara (bant kenarı 24 px, paneller kenarlara yaslı, orta esner): İçe aktar (`#/uretim/ice-aktar`), Düzelt, Şablon düzenleyici (`#/sablonlar/<anahtar>`), Baskı masası, Sayfa şablonu düzenleyici (`#/baski/sablonlar/<id>`); vitrin. Telefonda bunların yerine "geniş ekranda açın" notu (`lib/route.ts` `phoneNote`); Üretim ile Tasarım dili › Kurallar, Dene ve Oluştur sütunda durur ama telefonda da not gösterir.
- **Form ve liste ekranları** Merkez/DeciShip sütununda: en çok 1240 px (`--sod-wrap`), kenar 32 px (telefonda 16, `--gutter`), ortada, yanlar zemin; başlık (iş satırı ya da tam bant) içerikle aynı hizada. Üretim (`#/uretim`: alım alanı ve üç bölümlü kart ızgarası; karta tıklayınca 520 px sağ panel sütunun hemen sağında, bitişik açılır (aralık 12 px); sütun sola kayar ve ikisi birlikte ortalanır, sığmazsa sütun daralır, panel küçülmez; geçiş 280 ms, hareketi azaltta yok; iş satırı kıpırdamaz; içerik `.ur-page` ile 1240 sütunundan ekran genişliğine taşar, genişliği `.ur-grp` verir), Kurulum, Ayarlar (bölüm listesi 260 px + form en çok 720 px, beyaz yaprak), Tasarım dili (bütün bölümleri: Özet, Kurallar, Dene, Sürümler, Öğren, Örnekler, Oluştur), Şablon kütüphanesi (`#/sablonlar`), Sayfa şablonları, Arşiv. İçerik kenarını TagPress verir (`.tz-app--col .tz-main`: `max-width: var(--sod-wrap)`, `padding-inline: var(--gutter)`); platformda bandın baş yuvasını kabuk hizalar, yerelde `cerceve.css`.
- **Üst satır ve iş satırı** platformda her ekranda Merkez ve DeciShip sütununda (1240 px, ortada; çalışma ekranında da, altındaki çalışma alanı kenardan kenara); ekran türü değişince zıplamaz. Menü platformda kabuğun bölmeli sekmeleri, her öğe simgeli (`cerceve.tsx` `NAV_ICON`). Kurulum bitmemişse (`setup.status` `completed` değil) ve kişi yönetebiliyorsa (`access.manage`; yerelde her zaman) menünün başında "Kurulum · Eksik" (bayrak simgesi, sarı rozet), Kurulum ekranındayken seçili; son bilinen durum oturumda saklanır (`lib/setupMenu.ts`). Yerel kipin kendi üst satırında da aynı öğe.
- **Tablet (761–1023 px).** Çalışma ekranında tuval tam genişlik; sol ve sağ panel iş satırındaki iki simgeli düğmeyle tuvalin üstüne çekmece olarak açılır (aynı anda biri; `Workspace` paneli `duzen.ts`'e bildirir, `WorkRow` düğmeyi çizer). Kurulum'da özellik listesi tür kartlarının altına iner, adım çipleri başlığın altına. Üst satırda üretim durumu ve tasarım dili seçici gizlenir (salt okunur uyarısı kalır).
- **Telefon (≤ 760 px).** Form ekranları tek sütun: Kurulum'da tür kartları iki sütun, özellik listesi altta, "Devam et" tam genişlik ve üstte, "Atla" altında, başlık 26 px ve kırılır, adım çiplerinde yalnız etkin adımın adı; Ayarlar'da bölüm listesi formun üstünde yatay kayan sekmeler, yaprak kenardan kenara; sütundaki öteki çalışma alanlarında paneller alt alta. Çalışma ekranları yerine not ("Bu ekran geniş ekranda çalışır"; `cerceve.tsx` `NarrowNote`, `rotalar.tsx` `screenFor`).

## 7. Mantık dosyaları: korunanlar ve yeniden yazılanlar

**Korunan (saf ya da veri katmanı; içteki metin sözlüğe geçer, testleri aynı kalır):**
- `lib/`: `api.ts` (`errorText` yerine `serverText`), `events.ts`, `liveSync.ts`+test, `format.ts`+test, `route.ts` (genişler), `language.tsx`. `hotkeys.ts` kısayol dağıtıcısına dönüşür; eskisi geçişe kadar durur.
- `uretim/`: `jobs.ts`+test, `data.ts`, `hooks.ts`; Düzelt mantığı `adjust-edit`, `adjust-history`, `adjust-math`, `adjust-select`, `adjust-view` (testleriyle) ve `adjust-svg.ts`; `import/rows.ts`+test.
- `baski/`: `api.ts`, `useSessionEditor.ts`; `desk-model`, `grid`, `selection`, `shelf`, `slot-geometry` (testleriyle); `templates/draft`+test, `templates/marks.ts`; temele taşınan `canvas-math`+test ve `useCanvasView`.
- `sablonlar/`: `decor.ts`, `endpoints.ts`, `draft`, `shapeMath`, `templateList` (son üçü testiyle).
- `tasarim-dili/`: `describe.ts`, `diffView.ts`, `compare.ts`, `formSpec`+test, `learnRead`+test, `profilePath.ts`, `schematic.ts`, `contract.ts`, `sections.ts` (adlar sözlüğe); `tr.ts` `i18n/dil/` altına; `work.tsx`'in context ve kanca kısmı korunur, görünümü yeniden yazılır.
- `ayarlar/`: `format.ts`+test.

**Yeniden yazılan:** bütün ekran `.tsx` dosyaları (`work.tsx` dışında) ve `src/ui/**`. `ui/Num.tsx`'in davranışı `src/tezgah/Num.tsx`'e testiyle geçer; test sayısı düşmez.

**Önce çıkar, sonra çiz.** Büyük bileşenlerde test edilmemiş mantık var (`AdjustDialog.tsx` 1131 satır, `ImportDesk.tsx` 1130, `baski/desk/Desk.tsx` 943, `uretim/Desk.tsx` 680, `sablonlar/TemplateEditor.tsx` 682). Paket önce bu mantığı saf ve testli bir modüle çıkarır, eski bileşen yeni modülü kullanır ve aynı çalışır (birinci commit); yeni ekran ikinci commit'tir.

## 8. İş paketleri

| Kod | Paket | Büyüklük | Model | Dalga |
|---|---|---|---|---|
| S0 | Sözleşme ve altyapı | L | Opus | 0 |
| T1 | Temel: çerçeve, yerleşim, form, düğme, durum | L | Sonnet | 1 |
| T2 | Temel: tuval, katmanlar, kısayol listesi | L | Opus | 1 |
| OR | Ortak alan bileşenleri ve Kurulum yer tutucusu | M | Sonnet | 1 |
| AY | Ayarlar | M | Sonnet | 1 |
| UR | Üretim (tek ekran) | L | Opus | 2 |
| DZ | Düzelt (tam ekran düzenleyici) | L | Opus | 2 |
| IA | İçe aktarma masası | L | Opus | 2 |
| TDA | Tasarım dili A: çerçeve, Özet, Kurallar, Sürümler, Oluştur yer tutucusu | M | Sonnet | 2 |
| BM | Baskı masası | L | Opus | 3 |
| BS | Sayfa şablonları ve Arşiv | M | Opus | 3 |
| SB | Şablonlar | L | Opus | 3 |
| TDB | Tasarım dili B: Dene, Örnekler, Öğren | M–L | Opus | 3 |
| GC | Geçiş ve temizlik | M | Sonnet | 4 |

Her pakette ortak kabul ölçütleri:
- `pnpm test` ve `pnpm typecheck` yeşil; `check:i18n --strict` paketin klasörlerinde temiz.
- **Eylem eşleme tablosu** ajanın raporunda: bugünkü her düğme, menü öğesi ve kısayol yeni yerinde; maketin "Ne sadeleşti" listesine uyar; kalkan eylem yok.
- Ekranda tek mor birincil düğme; kısayol rozeti kurala uyar; her ikon düğmesinin adı var; Tab sırası mantıklı, odak görünür.
- Paket kendi duman testini ekler (§10).

**S0. Sözleşme ve altyapı** (Opus, tek ajan). Sahip: `apps/web/{tezgah.html, vite.config.ts, package.json, scripts/}`, `src/tezgah/**`, `src/i18n/**`, `src/locales/**` (iskelet), `src/lib/{route.ts, notify.ts}`, `src/ekranlar/*/index.tsx` (yer tutucular), `src/ortak/*` (sade çizimler), `src/main.tsx` (yalnız i18n satırı), `Tagpress/DESIGN.md`, `.impeccable/`, kök `scripts/parts.mjs` ve `scripts/test-changed.mjs`, `Platform/docs/DESIGN.md` §7 (TagPress için Tezgâh notu).
- Bağımlılıkları tek seferde ekler (sonraki dalgalarda yeni paket eklenmez): web'e `i18next`, `react-i18next`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`; Tagpress köküne `happy-dom` (geliştirme).
- Üç commit: C1 i18n, giriş sayfası, bağımlılıklar, denetim betiği; C2 belirteçler, DESIGN.md, `.impeccable`; C3 sözleşme ve sade çizimler, rotalar, yer tutucular, kısayol kaydı ve genel komutlar, ikon listesi.
- Kabul: `tezgah.html` her rotada çerçeveyi ve yer tutucuyu açar; eski uygulama aynı çalışır; kayma, karşıtlık, kısayol ve sözlük testleri yeşil; impeccable kancası yeni Tezgâh dosyasında renk uyarısı vermez.

**T1. Temel çizim 1** (Sonnet). Sahip: `src/tezgah/{cerceve, yerlesim, dugme, form, durum}/**`, `src/tezgah/vitrin/temel.tsx`, `locales/*/frame.json`.
- Maketin CSS'ini sözleşmedeki bileşenlere birebir uygular (`.bd`, `.ws`, `.pnl`, `.sec`, `.gc`, `.tb`, `.rail`, `.sb`, `.selbar`, `.fi`, `.seg`, `.st`, `.sw`, `.cbx`, `.bt`, `.ib`, `.tg`, `.dot`, `.iss`).
- Kabul: vitrin sayfası maketin "Dilin kuralları" bölümüyle ve altı maketteki öğelerle ekran görüntüsünde örtüşür; `CollapsedGroup` ve `Rail` klavye testleri geçer.

**T2. Temel çizim 2** (Opus). Sahip: `src/tezgah/{tuval, katman, kisayol/ShortcutsPanel*, ikon}/**`, `src/tezgah/vitrin/tuval.tsx`.
- Tuval: cetvel, 5 mm ızgara, cetvel vurgusu, yakınlaştırma (canvas-math `rulerStep`, `rulerTicks`), `Artboard`, seçim tutamakları, kesim çizgisi ve işareti, yüzen kutu. Katmanlar: `Popover`, `Menu`, `Dialog` (odak tuzağı, sarı onay şeridi), `Toast` (geri al), `Confirm`, `Tooltip`. `?` listesi ve kapsam yığını.
- Kabul: tekerlek ve kısayolla yakınlaştırma; sığdır, %100, seçime; pencerede Esc ve odak dönüşü; geri al bildirimi; hepsinin happy-dom testi var.

**OR. Ortak alan bileşenleri ve Kurulum** (Sonnet). Sahip: `src/ortak/**`, `locales/*/shared.json`, `src/ekranlar/kurulum/**`, `locales/*/setup.json`.
- Taşınan: `ui/TemplatePicker` ve `ui/proof`'taki iş durumu eşlemesinin mantığı; `uretim/import/ManualAdd` yerine `ElleEkle`.
- Kurulum yalnız kabuk: 240 px bant, banda binen kart, 3 adım çipi, seçilebilen 6 tür kartı, özellik listesi (yalnız görünüm, kaydedilmez), "Atla, varsayılanla başla" (Üretim'e gider), "Devam et" (adım 2 ve 3 yer tutucu). Özellik anahtarları ve kalıcı kayıt yol haritasının 5. adımı.
- Kabul: maket 6 ile görsel örtüşme; Enter "Devam et"i çalıştırır.

**AY. Ayarlar** (Sonnet; maket yok, kurallardan türetilir). Sahip: `src/ekranlar/ayarlar/**`, `locales/*/settings.json`, `screens/ayarlar/format.ts`.
- Yerleşim: iş satırında "Ayarlar / <bölüm>"; solda 260 px bölüm listesi; ortada en çok 720 px genişlikte panel bölümleri ve `Field` formları.
- Bölümler: Bağlantılar (anahtar ekle ve sil), Üretim, Fontlar (yükle, örnek), Maliyet, Tasarım dilleri (oluştur, varsayılan yap, yeniden adlandır, sil), Dil (TR ve EN; eski "Görünüm"ün yerine, tema §12'ye bağlı).
- Kabul: bugünkü 6 bölümün bütün işlevleri; dil değişince ekran anında çevrilir, seçim yeniden açılışta korunur.

**UR. Üretim** (Opus). Sahip: `src/ekranlar/uretim/**`, `locales/*/production.json`, `screens/uretim/{data.ts, jobs.ts, jobs.test.ts, hooks.ts}`.
- Yeniden yazılan: `UretimScreen`, `BatchColumn`, `BulkBar`, `Compare`, `Desk`, `Details`, `FlowStrip`, `ImageGenerate`, `IssueList`, `ProofGrid`, `Shortcuts`, `VariantProof`, `badges`.
- Kabul (maket 1):
  - Kuyruk: arama (/), 3 sekme ve "Diğer", sıralama, içe aktar, elle ekle; toplu şeritte Üret (U), En iyiyi onayla (A), Sil (Del), ⋯ (AI notu, Görselle üret).
  - Öneriler: Onayla 1–9, Düzelt (D, `#/duzelt`'e gider), işaret, sil; Yeni varyasyon (R), Görselle üret, Atla, "Şunu değiştir" (C); önceki ve sonraki iş.
  - Sağ panel: müşteri metni (E), sipariş no, adet, boyut, şablon (düzenleyicide aç), sorun ve düzeltmesi, kapalı gruplarda AI notu ve Ayrıntılar (satırlar, maliyet, günlük); alttaki birincil "V2'yi onayla" (Enter).
  - Akış adımları ve "En iyilerini onayla"; karşılaştırma ritmi (onayla, sonrakine geç; J/K ya da oklar) korunur.
  - Dosyayı ekrana bırakınca içe aktarma açılır; parti seçme, yeniden adlandırma, silme çalışır.
  - Durum satırında şablon, ölçü, süre ve maliyet.

**DZ. Düzelt** (Opus). Sahip: `src/ekranlar/duzelt/**`, `locales/*/adjust.json`, `screens/uretim/adjust-*.ts` ve testleri, `AdjustDialog`'dan çıkarılacak mantık.
- Kabul (maket 2):
  - Satır seçimi (liste ve Tab); oklarla 1 px, Shift ile 10 px; H, V, C ortalama; - = boyut; [ ] ve , . kalınlık; geri al, ileri al, 0 ile sıfırla.
  - Metin (Enter), font, konum, ortalama hedefi (kapalı grup), başlıktaki çöp kutusuyla düzeltmeyi kaldırma.
  - Otomatik denetim ve yeniden yerleşim bugünkü uçlarla. Kaydet (Ctrl S); Vazgeç ve geri dönüş (Esc, `don` adresine); kaydedilmemiş değişiklikle çıkarken onay.
  - Durum satırında düzeltme özeti ve ok adımı; yakınlaştırma sığdır, %100, seçime. Tuval birimi mm (tasarım pikseli etiket ölçüsünden çevrilir).

**IA. İçe aktarma masası** (Opus). Sahip: `src/ekranlar/ice-aktar/**`, `locales/*/importDesk.json`, `screens/uretim/import/{rows.ts, rows.test.ts}`, `ImportDesk`'ten çıkarılacak mantık.
- Kabul (maket 3):
  - 4 süzgeç; sonraki sorun N, önceki Shift N; satır ekle. Seçim şeridinde Şablon ata, Dahil et, Hariç tut. Space ile dahil et ya da çıkar; hariç satır üstü çizili.
  - Hücreler yerinde düzenlenir (Enter; metinde Ctrl Enter kaydeder); sorunlu satırın altında düzeltme düğmeleri ("Düz harfe çevir" geri alınabilir).
  - Sağda özet, toplu bağlantılar, kapalı grupta alan eşlemesi; İçe aktar ve "İçe aktar ve üret" (Ctrl Enter); Vazgeç; "Başka dosya".
  - Müşteri metni yalnız kullanıcı düzenlerse değişir.

**TDA. Tasarım dili A** (Sonnet). Sahip: `src/ekranlar/tasarim-dili/{index.tsx, ozet, kurallar, surumler, olustur}/**`, `locales/*/{designLanguage, profile}.json`, `screens/tasarim-dili/{describe, diffView, formSpec, profilePath, sections, contract, work.tsx}`.
- İş satırında dilin adı ve 7 sekme; bugünkü `DraftStrip` iş satırının `meta` alanına "taslak" bilgisi, Dene ve Yayınla olarak girer. Özet: dilin okunur kuralları. Kurallar: grup listesi solda, alanlar sağ panelde, şema önizlemesi ortada. Sürümler: liste, fark, geri dön. Oluştur: bugünkü anlatım Tezgâh görünümünde, yer tutucu (sitede oluşturma akışı ayrı iş).
- Kabul: 4 bölümün bütün işlevleri; yayınla ve geri dön onaylı; `profile` sözlüğü bütün alanları kapsar.

**BM. Baskı masası** (Opus). Sahip: `src/ekranlar/baski/{index.tsx, BaskiSekmeleri.tsx, masa}/**`, `locales/*/printDesk.json`, `screens/baski/{api.ts, desk-model*, grid*, selection*, shelf*, useSessionEditor.ts}`.
- Kabul (maket 4):
  - Raf boyuta göre gruplu; gruplarda Planla ve Oturuma ekle; dizilmiş işler "göster" satırında; kart ve özet görünümü. Sürükle-bırak: Shift ile kalanların hepsi, Alt ile serbest.
  - Sayfa ekle, Yeniden planla (kilitli sayfalar ve elle konanlar korunur), geri al ve ileri al.
  - Seçim şeridinde Hizala menüsü, yuvaya al, yuvadan çıkar, Yazıyı düzelt (Enter, Düzelt rotasına), çoğalt (Ctrl D), sil.
  - Sayfa: ad, kilit, silme, şablon, kopya, sipariş adı. Dosya: PDF/PNG ve kapsam; şablon değerleri ve dosya ayrıntısı kapalı grupta.
  - "Dosyayı üret", "Basıldı olarak işaretle"; taslak oturumlar, oturum adı, ⋯ (arşiv, sil). Hepsini sığdır ve gerçek boyut. Kesim çizgisi yalnız önizlemede.

**BS. Sayfa şablonları ve Arşiv** (Opus; maket yok). Sahip: `src/ekranlar/baski/{sablonlar, arsiv}/**`, `locales/*/{printTemplates, printArchive}.json`, `screens/baski/{slot-geometry*, templates/draft*, templates/marks.ts}`.
- Şablon listesi, yuva düzenleyici tuvali, özellik paneli, çoğalt ve arşivle; Arşiv'de liste, açma ve yeniden basma.
- Kabul: bugünkü `TemplatesView`, `TemplateEditor`, `SlotCanvas`, `panels` ve `ArchiveView` işlevlerinin hepsi.

**SB. Şablonlar** (Opus; maket yok). Sahip: `src/ekranlar/sablonlar/**`, `locales/*/templates.json`, `screens/sablonlar/{decor, draft*, endpoints, shapeMath*, templateList*}`.
- Solda kütüphane (ara, eşitle, yükle); ortada cetvelli tuvalde şablon görseli ve yazı alanı şekli; rayda seç, şekil, kaydır; sağda şekil, dolgu, süs ayarları; Dene kapalı grupta ya da yüzen kutuda; yükleme ve üretme pencereleri, eşitleme raporu, önceki ve sonraki şablon.
- Kabul: bugünkü bütün işlevler; şablon pikseline dokunulmaz.

**TDB. Tasarım dili B** (Opus). Sahip: `src/ekranlar/tasarim-dili/{dene, ornekler, ogren}/**`, `locales/*/designLanguageLab.json`, `screens/tasarim-dili/{compare.ts, learnRead*, schematic.ts}`; `work.tsx` 3. dalgada TDB'ye geçer.
- Kabul: Dene (kendi metinle, ücretsiz motor denemesi ve onaylı ücretli deneme; maliyet önce söylenir), Örnekler (referans görünümü), Öğren (önce/sonra ölçümü, uygula, reddet, geri al).

**GC. Geçiş ve temizlik** (Sonnet). Sahip: bütün `apps/web`.
- `index.html` ve `main.tsx` Tezgâh girişine döner, `tezgah.html` kalkar; `src/screens/**/*.tsx`, `src/ui/**`, `App.tsx`, `index.css`, `theme.ts` silinir; saf dosyalar testleriyle `src/ekranlar/<ekran>/mantik/` altına taşınır; Tailwind ve eski yazı tipleri çıkar; `check:i18n` bütün `src` üzerinde; README "Günlük kullanım", `SONRAKI-OTURUM/TEST-ADIMLARI.md`, YOL-HARITASI "Durum" ve KALANLAR güncellenir.
- Kabul: test sayısı düşmez (yalnız yer değiştirir); eski rotalar çalışır; derlenmiş uygulama 5420'de Tezgâh ile açılır.

## 9. Dalgalar, paralellik, commit sınırları

- **Dalga 0** (1 ajan): S0, üç commit; her birinden sonra testler yeşil. Sonunda sözleşme donar.
- **Dalga 1** (4 ajan): T1, T2, OR, AY. AY ve OR sade çizimlere karşı yazar; görünüm denetimi T1/T2'den sonra. Dört ayrı commit.
- **Dalga 2** (4 ajan): UR, DZ, IA, TDA (T1 ve T2 bitmiş olmalı). UR, DZ, IA ikişer commit (mantık çıkarma + i18n hazırlığı; sonra yeni ekran ve testleri); TDA tek commit.
- **Dalga 3** (4 ajan): BM, BS, SB, TDB. BM'nin Düzelt rotasına ihtiyacı var (2. dalgada hazır).
- **Dalga 4** (1 ajan + orkestratör): GC tek commit; ardından tam görsel ve erişilebilirlik turu, tam test koşusu.

Kurallar:
- Aynı anda en çok 4 ajan. Ajanlar commit atmaz, sunucu başlatmaz; yalnız kendi dosyalarının testini (`pnpm vitest run <dosya>`) ve paketin tip denetimini koşar.
- Sahiplik çakışmaz. Paylaşılan dosyada (sözleşme, `rotalar.tsx`, `package.json`, `common.json`, `frame.json`, `shortcuts.json`, `lib/*`) değişiklik gerekirse ajan raporunda ister, orkestratör yapar.

## 10. Doğrulama

- **Saf testler.** Mevcut testler her commit'te yeşil kalır (web'de 24 dosyada yaklaşık 289 test); yer değiştirse de beklentileri aynı.
- **Yeni testler:** belirteç kayması ve karşıtlık; sözlük eşliği ve kapsamı; kısayol kaydı; `pickInitialLocale` eşliği; `serverText`, `issueText`, `fixLabel`. Bileşen testleri happy-dom'da (dosya başında `// @vitest-environment happy-dom`), `react-dom/client` + `act` ve `src/tezgah/test/render.tsx` yardımcısıyla; yeni test kitaplığı eklenmez.
- **Ekran duman testi.** Her paket: sahte `fetch` (domain tiplerine uyan küçük örnekler) ile ekran açılır; ana denetimler orada mı, en çok bir `.tz-btn--primary` var mı, her ikon düğmesinin adı var mı, kısayol paneli açılıyor mu. e2e eklenmez.
- **Görsel kontrol** (orkestratör; tek sahip, tek tarayıcı): web derlenir; veri `data/` klasöründen kopyalanır ve kopyadan API anahtarları silinir (yanlışlıkla ücretli çağrı olmasın); sunucu `TAGPRESS_DATA_DIR=<kopya>`, `PORT=5499` ile arka planda başlar; `apps/web/scripts/gorsel.mjs` (playwright-core; **[V]** kurulu Edge ya da Chrome kanalı) her rotanın ve `docs/tezgah-tuval.html` içindeki altı maketin ekran görüntüsünü 1320 px'te alır; çıktı `%LOCALAPPDATA%\SellerOnData\gorsel\tagpress\<tarih>\`; maket ile ekran gözle karşılaştırılır (piksel farkı aranmaz); sunucu PID ile kapatılır, `netstat` ile doğrulanır. Her dalga sonunda yapılır; sapmalar sonraki dalganın ilk işi.
- **Erişilebilirlik asgarisi:** görünür odak; ikon düğmelerinde ad ve `aria-keyshortcuts`; rayda ok tuşları, sekmelerde `tablist`; pencerede odak tuzağı ve odağın tetikleyiciye dönmesi; `CollapsedGroup` için `aria-expanded`; seçim şeridi ve bildirimler `aria-live`; yalnız klavyeyle ana akış (içe aktar, onayla, düzelt, baskıya diz, dosyayı üret); `prefers-reduced-motion`, `forced-colors`. 32 px araç düğmeleri kabul; kılavuzlu akışta 48 px.

## 11. Riskler

1. **Sözleşme değişirse ekranlar bekler.** Önlem: Dalga 0'da sade ama çalışan çizimler; donmuş sözleşme; sapmayı ajan raporunda söyler.
2. **Büyük bileşenlerdeki test edilmemiş mantık yeniden yazımda bozulabilir.** Önlem: "önce çıkar, sonra çiz" ve eylem eşleme tablosu.
3. **Paylaşılan dosyada çakışma** (`package.json`, kilit dosyası, rota dosyası, sözlükler). Önlem: hepsi Dalga 0'da açılır, sonra yeni bağımlılık eklenmez.
4. **Eski ekranlar anahtar gösterebilir.** Önlem: eski giriş TR'ye sabitlenmiş başlatma; testler TR yardımcısıyla.
5. **impeccable kancası yanlış yöne iter.** Önlem: Dalga 0 C2.
6. **Maketi olmayan ekranlar** (Şablonlar, Ayarlar, Tasarım dilinin 6 bölümü, Sayfa şablonları, Arşiv). §12'ye bağlı.
7. **EN arayüzde Türkçe sunucu mesajı** (hata, sorun, geri al). Geçici çözüm §4; kalıcısı ayrı iş.
8. **Baskı masasında başarım** (çok sayfa, canlı sürükleme). Önlem: canvas-math'in ayrıntı düzeyi ve görünürlük işlevleri korunur.
9. **2. aşama Platform değişikliği ister** (kabukta alçak bant yok).
10. **Bellek.** Aynı anda bir başsız tarayıcı ve tek sunucu (5499); ajanlar sunucu açmaz.
11. **Kısayol değişikliği alışkanlığı bozabilir** (Düzelt'te Enter ve Ctrl S). `?` listesi ve README'de söylenir.

## 12. Kullanıcı kararları (2026-11-21, hepsi onaylandı)

1. **Koyu tema kaldırılır.** Yalnız açık tema; Ayarlar'da "Görünüm" bölümünün yerine "Dil" (TR, EN) gelir.
2. **Maketi olmayan ekranlar.** Tuval ekranları (Şablonlar, Tasarım dili bölümleri, Sayfa şablonları) 3. dalgadan önce tek tuval turunda gösterilir. Form ve tablo ekranları (Ayarlar, Arşiv) dilin kurallarından türetilir, ekran görüntüsüyle onaya sunulur.
3. **Üretim'in büyük ızgarası kalır:** kuyruk başlığındaki ikonla açılan ikinci görünüm (Büyük, Orta, Liste).
4. **Parti listesi:** iş satırındaki parti adı açılır menüdür (gün gün gruplu; yeniden adlandır ve sil orada). Ayrı sütun yok.
5. **"Hazır" durumu koyu nötr noktadır.** Mor yalnız seçim ve eylem için.
6. **Yalnız masaüstü web.** 1280 px ve üstü için tasarım; 1024–1279 arasında sol panel kapanabilir; altında "geniş pencere gerekir" notu. TagPress mobil uygulamada yer almaz.

### İkinci tuval (2026-11-21, onaylandı)

Maketi olmayan ekranların tasarımı `docs/tezgah-tuval-2.html` içinde (Şablonlar, Tasarım dili bölümleri, Sayfa şablonları, Üretim ızgarası, Ayarlar, Arşiv, süslü yazı ayrıntısı); kullanıcı tamamını onayladı. Kararlar:

7. **Sağ üst köşe:** girişsiz dönemde tasarım dili seçici; firma ve hesap menüsü entegrasyonda gelir.
8. **Şablon kütüphanesi:** sol panelde liste + ayrıca tam genişlikte büyük ızgara görünümü (başlıktaki ikonla).
9. **Kurallar ekranının ortası:** oran şeması yerine seçili örneğin canlı, ücretsiz motor önizlemesi (şema küçük yardımcı olarak kalabilir).
10. **Örnek ayrıntısı:** sağ panelde (pencere değil).

