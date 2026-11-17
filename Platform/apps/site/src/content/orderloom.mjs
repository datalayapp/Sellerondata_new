// OrderLoom ürün sayfası metni. Kaynak: OrderLoom.dc.html (TR).
// Ürün henüz açık değil: "Yakında" rozeti yok, birincil eylem konu satırlı mailto ("Açıldığında haber verin").
export default {
  tr: {
    title: 'OrderLoom: sipariş ve ekip · SellerOnData',
    description: 'Siparişleri tek listede toplayın, işleri ekibinize dağıtın, kimin ne yaptığını kayıtta görün. Yakında; açıldığında haber verin.',
    eyebrow: 'ORDERLOOM · SİPARİŞ VE EKİP',
    h1: 'Hiçbir sipariş arada kaybolmasın.',
    lead: 'Siparişler tek listede, işler ekibinizde, kimin ne yaptığı kayıtta.',
    primary: 'Açıldığında haber verin',
    subject: 'OrderLoom açıldığında haber verin',
    howLink: 'Nasıl çalışacak',
    howId: 'nasil',
    why: {
      eyebrow: 'NE KAZANDIRIR',
      title: 'Sipariş çoğaldıkça iş karışmasın.',
      items: [
        { title: 'Sipariş gözden kaçmasın', text: 'Bütün siparişleriniz tek listede dursun; hangisinin beklediği belli olsun.' },
        { title: 'Herkes işini bilsin', text: 'Her iş bir çalışana verilsin; kimin neyi yapacağı baştan belli olsun.' },
        { title: 'Emeğin karşılığı net', text: 'Yapılan her iş kayda geçsin; hakediş bu kayıttan çıksın.' },
      ],
    },
    how: {
      eyebrow: 'NASIL ÇALIŞACAK',
      title: 'Siparişten hakedişe.',
      steps: [
        { title: 'Siparişler toplansın', text: 'Gelen her sipariş tek listede yerini alacak.' },
        { title: 'İşi siz dağıtın', text: 'Her işi hangi çalışanın yapacağını siz seçeceksiniz.' },
        { title: 'Emek kayda geçsin', text: 'Biten iş kaydedilecek; hakediş bu kayıttan hesaplanacak.' },
      ],
    },
    faqTitle: 'Sık sorulanlar',
    faq: [
      { q: 'OrderLoom ne zaman açılacak?', a: 'Hazırlıyoruz; açıldığında ilk sizin duymanız için bize yazın.' },
      { q: 'Diğer ürünler olmadan kullanabilir miyim?', a: 'Evet; OrderLoom tek başına çalışacak, diğer ürünleri kullanmanız gerekmeyecek.' },
      { q: 'Bugün hesap açarsam ne olur?', a: "Hesabınız bugün DeciShip'i açar; OrderLoom hazır olduğunda aynı hesaba eklenecek." },
      { q: 'Ücretli olacak mı?', a: 'Erken erişimde ücret yok; sonrası için Fiyatlar sayfasına göz atabilirsiniz.' },
    ],
    eco: 'OrderLoom tek başına çalışacak; diğer ürünlerle aynı hesapta, aynı ekiple birleşecek.',
    ecoLink: 'Diğer ürünler',
    close: { title: 'İlk duyan siz olun.', text: 'Erken erişimde ücret yok.', label: 'Açıldığında haber verin' },
  },
  en: {
    title: 'OrderLoom: orders and team · SellerOnData',
    description: 'Keep orders in one list, assign jobs to your team and see who did what. Coming soon; get notified when it launches.',
    eyebrow: 'ORDERLOOM · ORDERS AND TEAM',
    h1: 'Never lose an order along the way.',
    lead: 'Orders in one list, jobs with your team, a record of who did what.',
    primary: 'Notify me at launch',
    subject: 'Notify me when OrderLoom launches',
    howLink: 'How it will work',
    howId: 'how-it-works',
    why: {
      eyebrow: 'WHAT YOU GET',
      title: 'Keep work in order as orders grow.',
      items: [
        { title: 'No order slips through', text: 'All your orders stay in one list, so you can see which one is waiting.' },
        { title: 'Everyone knows their job', text: 'Each job goes to one team member, so it is clear from the start who does what.' },
        { title: 'Clear credit for the work done', text: 'Every finished job is recorded, and piecework pay comes from that record.' },
      ],
    },
    how: {
      eyebrow: 'HOW IT WILL WORK',
      title: 'From order to piecework pay.',
      steps: [
        { title: 'Orders come together', text: 'Every incoming order takes its place in one list.' },
        { title: 'You assign the work', text: 'You choose which team member does each job.' },
        { title: 'Work gets recorded', text: 'Finished jobs will be recorded, and piecework pay will be calculated from that record.' },
      ],
    },
    faqTitle: 'Frequently asked questions',
    faq: [
      { q: 'When will OrderLoom launch?', a: 'We are preparing it. Write to us and you will be the first to hear when it opens.' },
      { q: 'Can I use it without the other products?', a: 'Yes. OrderLoom will work on its own; you will not need the other products.' },
      { q: 'What happens if I create an account today?', a: 'Your account opens DeciShip today; OrderLoom will be added to the same account when it is ready.' },
      { q: 'Will it be paid?', a: 'Early access is free. For what comes after, see the Pricing page.' },
    ],
    eco: 'OrderLoom will work on its own; it will also join the other products in the same account, with the same team.',
    ecoLink: 'Other products',
    close: { title: 'Be the first to hear.', text: 'Early access is free.', label: 'Notify me at launch' },
  },
};
