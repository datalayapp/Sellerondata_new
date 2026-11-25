// Ana sayfa metni. Sahibi: ana sayfa ajanı. Biçim: { tr: {...}, en: {...} }; title ve description zorunlu (description 50-200 karakter).
// Kaynak: TR = Main.dc.html panosu. Kendi metin uydurulmaz.
// Not: panodaki "kredi kartı istenmez" / "needs no credit card" check.mjs kuralı gereği "Erken erişimde ücret yok." biçiminde yazılır.
export default {
  tr: {
    title: 'SellerOnData: satıcılar için birbirine bağlı araçlar',
    description: 'Kargo faturasındaki fazlayı bulan, siparişi dağıtan, etiketi hazırlayan araçlar tek hesapta. DeciShip bugün açık ve erken erişimde ücretsiz.',
    eyebrow: 'E-TİCARET SATICILARI İÇİN',
    h1a: 'Siz satışa odaklanın.',
    h1b: 'Arka ofis bizden.',
    lead: 'Kargoda fazla ödemeyi yakalayan, siparişi ekibinize dağıtan, etiketinizi hazırlayan araçlar. DeciShip bugün açık; OrderLoom ve TagPress geldikçe aynı hesaba eklenir.',
    browse: 'Ürünlere göz atın',
    // Hero şemasında logonun üstündeki etiket (dekoratif SVG içinde).
    hub: 'Tek hesap',
    whyTitle: 'Bir hesap. İhtiyacınız kadar araç.',
    why: [
      { t: 'Tek giriş', d: 'Ekibiniz tek hesapla girer; yeni araçlar aynı hesaba eklenir.' },
      { t: 'İhtiyacınız kadar', d: 'Bugün DeciShip ile başlayın, diğerleri geldikçe ekleyin.' },
      { t: 'Hepsi tek ekranda', d: "Kullandığınız araçların özeti Merkez'de." },
    ],
    productsTitle: 'ÜRÜNLERİMİZ',
    explore: 'İnceleyin',
    cards: {
      deciship: { aria: "DeciShip'i inceleyin", slogan: 'Kargoya fazla ödemeyin.', sub: 'Koliyi paketlerken ölçün. Faturadaki fazlayı DeciShip bulur, itirazınızı hazırlar.' },
      orderloom: { aria: "OrderLoom'u inceleyin", slogan: 'Hiçbir sipariş arada kaybolmasın.', sub: 'Siparişler tek listede, işler ekibinizde, kimin ne yaptığı kayıtta.' },
      tagpress: { aria: "TagPress'i inceleyin", slogan: 'Tasarımcı beklemeden etiket.', sub: 'Ne istediğinizi yazın; yapay zekâ önersin, siz düzenleyip yazdırın.' },
    },
    stepsEyebrow: 'NASIL BAŞLARSINIZ',
    stepsTitle: 'Başlamak üç adım sürer.',
    steps: [
      { t: 'Hesabınızı açın', d: 'Firmanızı bir kez kaydedin. Erken erişimde ücret yok.' },
      { t: "Merkez'den aracınızı açın", d: 'İhtiyacınız olan aracı seçin, kurulumunu ve ayarlarını tek yerden yapın.' },
      { t: 'Ekibinizi ekleyin', d: "Çalışanlarınızı Merkez'den ekleyin, her araçta ne göreceklerini belirleyin." },
    ],
  },
  en: {
    title: 'SellerOnData: connected tools for e-commerce sellers',
    description: 'Tools that find carrier overcharges, assign orders and prepare labels, under one account. DeciShip is open today and free during early access.',
    eyebrow: 'FOR E-COMMERCE SELLERS',
    h1a: 'You focus on selling.',
    h1b: 'We handle the back office.',
    lead: 'Tools that catch carrier overcharges, assign orders to your team and prepare your labels. DeciShip is open today; OrderLoom and TagPress join the same account as they launch.',
    browse: 'Browse products',
    hub: 'One account',
    whyTitle: 'One account. As many tools as you need.',
    why: [
      { t: 'One sign-in', d: 'Your team signs in with one account; new tools are added to it.' },
      { t: 'Only what you need', d: 'Start with DeciShip today and add the others as they launch.' },
      { t: 'Everything on one screen', d: 'A summary of the tools you use is in Hub.' },
    ],
    productsTitle: 'OUR PRODUCTS',
    explore: 'Explore',
    cards: {
      deciship: { aria: 'Explore DeciShip', slogan: 'Stop overpaying on shipping.', sub: 'Measure the parcel as you pack it. DeciShip finds the overcharge on the invoice and prepares your dispute.' },
      orderloom: { aria: 'Explore OrderLoom', slogan: 'Never lose an order along the way.', sub: 'Orders in one list, jobs with your team, a record of who did what.' },
      tagpress: { aria: 'Explore TagPress', slogan: 'Labels without waiting for a designer.', sub: 'Describe what you want; AI suggests, you edit and print.' },
    },
    stepsEyebrow: 'HOW TO GET STARTED',
    stepsTitle: 'Getting started takes three steps.',
    steps: [
      { t: 'Create your account', d: 'Register your company once. Early access is free.' },
      { t: 'Open your tool from Hub', d: 'Pick the tool you need and set it up in one place.' },
      { t: 'Add your team', d: 'Add your team members in Hub and choose what each one sees in every tool.' },
    ],
  },
};
