// İletişim metni. Kaynak: Iletisim.dc.html (TR), EN.md "## Iletisim" + "Duyuru bağlantı konuları (mailto)" (EN).
// Sunucu yok: kartlar konu satırlı mailto bağlantısıdır (form yok).
export default {
  tr: {
    title: 'İletişim · SellerOnData',
    description: 'Destek, tanışma ya da ürün haberleri için bize yazın. Konuya uygun kartı seçin, ekibimiz size dönsün.',
    eyebrow: 'İLETİŞİM',
    h1: 'Bize yazın.',
    lead: 'Konuya uygun kartı seçin, ekibimiz size dönsün.',
    cards: [
      { icon: 'help', t: 'Destek', d: 'Hesabınız ya da DeciShip hakkında bir sorunuz mu var? Yazın, birlikte çözelim.', cta: 'Destek isteyin', subject: 'Destek' },
      { icon: 'chat', t: 'Ekibinize uygun mu?', d: 'Ekibinizin iş akışını anlatın, size uygun kullanımı birlikte konuşalım.', cta: 'Bize yazın', subject: 'Tanışma' },
      { icon: 'bell', t: 'Yeni ürünler', d: 'OrderLoom ve TagPress açıldığında ilk siz haber alın.', cta: 'Açıldığında haber verin', subject: 'Yeni ürünler açıldığında haber verin' },
    ],
    infoTitle: 'İletişim bilgileri',
    labels: { email: 'E-POSTA', phone: 'TELEFON', address: 'ADRES', company: 'ŞİRKET' },
    companyVal: 'DatalaYapp · [ŞİRKET UNVANI]',
  },
  en: {
    title: 'Contact · SellerOnData',
    description: 'Write to us for support, an introduction or product news. Pick the card that fits your topic and our team will get back to you.',
    eyebrow: 'CONTACT',
    h1: 'Write to us.',
    lead: 'Pick the card that fits your topic and our team will get back to you.',
    cards: [
      { icon: 'help', t: 'Support', d: 'Have a question about your account or DeciShip? Write to us and we will sort it out together.', cta: 'Get support', subject: 'Support' },
      { icon: 'chat', t: 'Is it right for your team?', d: 'Tell us how your team works and we will talk through how to use it.', cta: 'Write to us', subject: 'Introduction' },
      { icon: 'bell', t: 'New products', d: 'Be the first to hear when OrderLoom and TagPress launch.', cta: 'Notify me at launch', subject: 'Notify me when new products launch' },
    ],
    infoTitle: 'Contact details',
    labels: { email: 'EMAIL', phone: 'PHONE', address: 'ADDRESS', company: 'COMPANY' },
    companyVal: 'DatalaYapp · [COMPANY NAME]',
  },
};
