// DeciShip ürün sayfası metni. Kaynak: DeciShip.dc.html (TR).
// Destek satırı panoda yok; karar gereği SSS'nin altına sade bir satır olarak eklendi.
export default {
  tr: {
    title: 'DeciShip: kargo faturası denetimi · SellerOnData',
    description: 'Koliyi paketlerken ölçün, kargo faturasındaki fazlayı DeciShip bulsun ve itiraz metnini hazırlasın. Erken erişimde ücretsiz.',
    eyebrow: 'DECISHIP · KARGO FATURASI DENETİMİ',
    h1: 'Kargoya fazla ödemeyin.',
    lead: 'Koliyi paketlerken ölçün. Faturadaki fazlayı DeciShip bulur, itirazınızı hazırlar.',
    primary: 'Hesap aç',
    howLink: 'Nasıl çalışır',
    howId: 'nasil',
    why: {
      eyebrow: 'NE KAZANDIRIR',
      title: 'Fazla ödediğinizi bilin, geri isteyin.',
      items: [
        { title: 'Kanıt elinizde', text: 'Koli paketlenirken ölçülür ve fotoğraflanır; itirazınız sözle değil kayıtla yapılır.' },
        { title: 'Farkın nedeni belli', text: 'Her farkın yanında nedeni yazar; neye itiraz edeceğinizi tahmin etmezsiniz.' },
        { title: 'İtiraz yazısı hazır', text: 'Kargo firmasına gidecek itiraz metni ve rapor sizin için hazırlanır.' },
      ],
    },
    how: {
      eyebrow: 'NASIL ÇALIŞIR',
      title: 'Paketleme masasından itiraza.',
      steps: [
        { title: 'Paketlerken ölçün', text: 'Çalışanınız telefonla barkodu okutur; ölçü, kilo ve fotoğraf kayda geçer.' },
        { title: 'Faturayı yükleyin', text: 'Her satır ölçümünüzle ve tarifenizle karşılaştırılır.' },
        { title: 'İtiraz edin', text: 'Fazla çıkan satırlar için itiraz metni ve rapor sizi bekler.' },
      ],
    },
    faqTitle: 'Sık sorulanlar',
    faq: [
      { q: 'Küçük sapmalar da fark sayılır mı?', a: "Hayır; varsayılan tolerans 1 cm ve 0,1 kg'dır, ayarlardan değişir." },
      { q: 'Hangi fatura dosyalarını yükleyebilirim?', a: 'CSV ve Excel faturalarını yükleyebilirsiniz; PDF faturalar yapay zekâ ile okuma açıksa yüklenir.' },
      { q: 'KDV nasıl hesaba katılır?', a: "Tarife KDV hariç girilir; fatura KDV dahilse DeciShip karşılaştırmadan önce KDV'yi çıkarır." },
      { q: 'Ölçüm uygulaması hangi telefonlarda çalışır?', a: "Şimdilik Android'de çalışır; internet yokken ölçümler bekler, bağlantı gelince gönderilir." },
    ],
    // Destek satırı: e-posta adresi altbilgiyle aynı (common.mjs footer.email); konu EN.md mailto tablosundan.
    support: { text: 'Sorunuzun yanıtı burada yoksa bize yazın:', subject: 'Destek' },
    eco: 'DeciShip tek başına çalışır. OrderLoom ve TagPress geldikçe aynı hesapta, aynı ekiple birleşir.',
    ecoLink: 'Diğer ürünler',
    close: { title: 'Sıradaki faturanızı denetleyin.', text: 'Erken erişimde ücret yok.', label: 'Hesap aç' },
  },
  en: {
    title: 'DeciShip: carrier invoice audit · SellerOnData',
    description: 'Measure parcels as you pack them. DeciShip finds overcharges on carrier invoices and prepares your dispute. Free during early access.',
    eyebrow: 'DECISHIP · CARRIER INVOICE AUDIT',
    h1: 'Stop overpaying on shipping.',
    lead: 'Measure the parcel as you pack it. DeciShip finds the overcharge on the invoice and prepares your dispute.',
    primary: 'Create account',
    howLink: 'How it works',
    howId: 'how-it-works',
    why: {
      eyebrow: 'WHAT YOU GET',
      title: 'Know what you overpaid. Ask for it back.',
      items: [
        { title: 'Proof in hand', text: 'The parcel is measured and photographed as it is packed, so your dispute rests on a record, not on your word.' },
        { title: 'Every discrepancy has a reason', text: 'Each discrepancy comes with its reason, so you never have to guess what to dispute.' },
        { title: 'Dispute letter ready', text: 'The dispute text and report for the carrier are prepared for you.' },
      ],
    },
    how: {
      eyebrow: 'HOW IT WORKS',
      title: 'From the packing table to the dispute.',
      steps: [
        { title: 'Measure while you pack', text: 'Your team member scans the barcode with a phone; dimensions, weight and a photo are recorded.' },
        { title: 'Upload the invoice', text: 'Every line is compared with your measurement and your tariff.' },
        { title: 'File a dispute', text: 'A dispute text and report wait for every line that comes out higher.' },
      ],
    },
    faqTitle: 'Frequently asked questions',
    faq: [
      { q: 'Do small deviations count as discrepancies?', a: 'No. The default tolerance is 1 cm and 0.1 kg, and you can change it in settings.' },
      { q: 'Which invoice files can I upload?', a: 'Upload CSV and Excel invoices; PDF invoices can be uploaded when AI reading is enabled.' },
      { q: 'How is VAT handled?', a: 'Enter your tariff excluding VAT. If the invoice includes VAT, DeciShip removes it before comparing.' },
      { q: 'Which phones does the measuring app run on?', a: 'For now, on Android. Without internet, measurements wait and are sent when the connection returns.' },
    ],
    support: { text: 'Question not answered here? Write to us:', subject: 'Support' },
    eco: 'DeciShip works on its own. As OrderLoom and TagPress launch, they join the same account and the same team.',
    ecoLink: 'Other products',
    close: { title: 'Audit your next invoice.', text: 'Early access is free.', label: 'Create account' },
  },
};
