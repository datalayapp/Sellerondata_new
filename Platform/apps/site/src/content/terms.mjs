// Kullanım koşulları metni (noindex). Pano: Kosullar.dc.html. Sahibi: hukuki sayfalar ajanı.
// İşaretler: [[...]] yer tutucu, {mail} e-posta bağlantısı.
// Blok türleri: { p }, { ul: [...] }, { link: 'privacy', label } (Gizlilik sayfasına bağlantı).
export default {
  tr: {
    title: 'Kullanım koşulları | SellerOnData',
    description: "SellerOnData'yı kullanırken sizin ve bizim neye uyacağımızı sade bir dille anlatan kullanım koşulları.",
    eyebrow: 'YASAL',
    h1: 'Kullanım koşulları',
    lead: 'Kullanırken sizin ve bizim neye uyacağımızı sade bir dille anlatır.',
    updated: 'Son güncelleme: [TARİH]',
    note: 'Taslak: bu metin hukukçu onayı bekliyor. Yayından önce güncellenecek.',
    toc: 'İÇİNDEKİLER',
    questions: 'Sorularınız için:',
    sections: [
      { t: 'Taraflar ve kapsam', b: [
        { p: 'SellerOnData hizmetini DatalaYapp ("biz") sunar. Hizmeti kullanan firma ve onun adına giren kişiler ("siz") bu koşullara tabidir.' },
        { p: 'Hesap açmak ya da hizmeti kullanmak bu koşulları kabul ettiğiniz anlamına gelir. [[DOĞRULANACAK]] Bir firma adına kabul ediyorsanız, firmayı bağlama yetkiniz olduğunu belirtmiş olursunuz.' },
        { p: 'Şirket bilgileri. Unvan: [[ŞİRKET UNVANI]] · Adres: [[ADRES]] · Vergi no: [[VERGİ NO]]' },
      ] },
      { t: 'Hizmetin tanımı', b: [
        { p: 'SellerOnData, e-ticaret satıcıları için birbirine bağlı araçlar sunar. Araçlar tek hesapta çalışır; her biri tek başına da kullanılabilir.' },
        { ul: ['DeciShip: kargo faturasındaki fazla ödemeyi bulmaya yardım eder. Açıktır.', 'OrderLoom: sipariş ve iş dağıtımı için hazırlanıyor. Henüz açık değildir.', 'TagPress: etiket tasarımı ve baskısı için hazırlanıyor. Henüz açık değildir.'] },
        { p: 'Araçlar yardımcı bilgi üretir. Kargo firmasına itiraz etmek ya da bir kararı uygulamak size aittir.' },
      ] },
      { t: 'Hesap, firma ve çalışanlar', b: [
        { p: 'Hesap, kişiye değil firmaya aittir. Bir kişi birden çok firmada yer alabilir; her firmanın verisi ayrı tutulur.' },
        { ul: ['Firma yöneticisi çalışan ekler, çıkarır ve her çalışana yetki verir.', 'Yöneticinin verdiği yetkiler, çalışanın neleri görüp yapabileceğini belirler.', 'Giriş bilgilerinizi korumak ve başkasına vermemek sizin sorumluluğunuzdadır.', 'Hesabınızda izinsiz bir kullanım fark ederseniz bize hemen bildirin.'] },
      ] },
      { t: 'Kullanım kuralları', b: [
        { p: 'Hizmeti hukuka ve dürüstlüğe uygun kullanacağınızı kabul edersiniz. Şunları yapmayın:' },
        { ul: ['Hizmeti yasa dışı bir amaçla ya da başkalarının haklarını ihlal etmek için kullanmak.', 'Hesaba, sisteme ya da başka firmaların verisine yetkisiz erişmeye çalışmak.', 'Hizmeti aksatacak, aşırı yük bindirecek ya da güvenliğini zayıflatacak işlemler yapmak.', 'Hizmeti ya da yazılımını kopyalamak, tersine mühendislikle çözmek veya izinsiz yeniden satmak.', 'Yanlış ya da yanıltıcı bilgiyle hesap açmak.'] },
        { p: 'Bu kurallara uyulmazsa erişimi sınırlayabilir ya da hesabı kapatabiliriz. Ayrıntılar: [[İHLAL VE UYARI SÜRECİ]]' },
      ] },
      { t: 'Ücretler ve erken erişim', b: [
        { p: 'Erken erişim döneminde DeciShip ücretsizdir.' },
        { p: 'Ücretli planlar açıklanırsa önceden duyurulur. [[DOĞRULANACAK]]' },
      ] },
      { t: 'Verileriniz', b: [
        { p: 'Hizmete yüklediğiniz verinin sahibi sizsiniz. Bu koşullar veri üzerindeki hakkınızı bize devretmez.' },
        { p: 'Veriyi yalnız hizmeti sunmak, güvenliğini sağlamak ve yasal yükümlülükleri yerine getirmek için işleriz. Yüklediğiniz verinin hukuka uygun olduğundan siz sorumlusunuz.' },
        { p: 'Kişisel verilerin nasıl işlendiği, saklama süresi ve haklarınız Gizlilik sayfasındadır.' },
        { link: 'privacy', label: 'Gizlilik ve KVKK sayfasını okuyun' },
      ] },
      { t: 'Hizmet sürekliliği ve sorumluluk sınırı', b: [
        { p: 'Hizmeti kesintisiz ve hatasız sunmayı hedefleriz. Bakım, arıza ya da bizim dışımızdaki nedenlerle kesinti olabilir; bunu garanti edemeyiz.' },
        { p: 'Araçların sonuçları sizin yüklediğiniz veriye ve üçüncü tarafların bilgilerine dayanır. Bu sonuçlara dayanarak aldığınız kararlar size aittir.' },
        { p: 'Yasanın izin verdiği ölçüde, dolaylı zararlardan ve kâr kaybından sorumlu değiliz. Sorumluluğumuzun üst sınırı: [[SORUMLULUK SINIRI]]' },
        { p: 'Yasanın sınırlamaya izin vermediği haller saklıdır.' },
      ] },
      { t: 'Hesabın kapatılması', b: [
        { p: 'Hesabınızı kapatmak için bize yazabilirsiniz. Kapatma süreci: [[DOLDURULACAK]]. 4. bölümdeki kurallar ihlal edilirse hesabı biz de kapatabiliriz.' },
        { p: 'Kapatmadan sonra verinizi dışa aktarma imkânı: [[VERİ ALMA SÜRESİ]]' },
        { p: 'Sonrasında veri, Gizlilik sayfasındaki saklama kurallarına göre silinir ya da yasanın gerektirdiği kadar saklanır. [[DOĞRULANACAK]]' },
      ] },
      { t: 'Değişiklikler', b: [
        { p: 'Hizmet gelişirken bu koşulları güncelleyebiliriz. Önemli değişiklikleri e-posta ya da uygulama içinden bildirmeyi hedefleriz. [[DOĞRULANACAK]]' },
        { p: 'Bildirimden sonra hizmeti kullanmaya devam etmeniz yeni koşulları kabul ettiğiniz anlamına gelir. Kabul etmezseniz hesabınızın kapatılmasını isteyebilirsiniz. Bildirim süresi: [[BİLDİRİM SÜRESİ]]' },
      ] },
      { t: 'Uygulanacak hukuk ve yetkili mahkeme', b: [
        { p: 'Bu koşullara Türkiye Cumhuriyeti hukuku uygulanır.' },
        { p: 'Uyuşmazlıklarda yetkili mahkeme ve icra daireleri: [[DOLDURULACAK]]' },
      ] },
    ],
  },
  en: {
    title: 'Terms of use | SellerOnData',
    description: 'The terms for using SellerOnData, in plain language: what you and we agree to follow.',
    eyebrow: 'LEGAL',
    h1: 'Terms of use',
    lead: 'Explains in plain language what you and we agree to follow when you use SellerOnData.',
    updated: 'Last updated: [DATE]',
    note: 'Draft: pending legal review. The Turkish version prevails.',
    toc: 'CONTENTS',
    questions: 'Questions?',
    sections: [
      { t: 'Parties and scope', b: [
        { p: 'DatalaYapp ("we") provides the SellerOnData service. The company that uses the service, and the people who sign in on its behalf ("you"), are subject to these terms.' },
        { p: 'Creating an account or using the service means you accept these terms. [[TO BE VERIFIED]] If you accept on behalf of a company, you confirm that you have the authority to bind it.' },
        { p: 'Company details. Company name: [[COMPANY NAME]] · Address: [[ADDRESS]] · Tax ID: [[TAX ID]]' },
      ] },
      { t: 'Description of the service', b: [
        { p: 'SellerOnData provides connected tools for e-commerce sellers. The tools work under one account, and each can also be used on its own.' },
        { ul: ['DeciShip: helps find overcharges on carrier invoices. It is open.', 'OrderLoom: being prepared for orders and job assignment. It is not open yet.', 'TagPress: being prepared for label design and printing. It is not open yet.'] },
        { p: 'The tools produce supporting information. Disputing a charge with the carrier, or acting on any decision, is up to you.' },
      ] },
      { t: 'Account, company and team members', b: [
        { p: "The account belongs to the company, not to a person. One person can belong to more than one company; each company's data is kept separate." },
        { ul: ['The company admin adds and removes team members and grants permissions to each one.', 'The permissions the admin grants determine what a team member can see and do.', 'You are responsible for protecting your sign-in details and not sharing them with anyone.', 'If you notice unauthorized use of your account, tell us immediately.'] },
      ] },
      { t: 'Rules of use', b: [
        { p: 'You agree to use the service lawfully and in good faith. Do not:' },
        { ul: ['Use the service for an unlawful purpose or to violate the rights of others.', "Attempt unauthorized access to an account, the system or other companies' data.", 'Perform actions that disrupt the service, overload it or weaken its security.', 'Copy the service or its software, reverse engineer it or resell it without permission.', 'Create an account with false or misleading information.'] },
        { p: 'If these rules are not followed, we may restrict access or close the account. Details: [[VIOLATION AND WARNING PROCESS]]' },
      ] },
      { t: 'Fees and early access', b: [
        { p: 'DeciShip is free during early access.' },
        { p: 'If paid plans are announced, they will be announced in advance. [[TO BE VERIFIED]]' },
      ] },
      { t: 'Your data', b: [
        { p: 'You own the data you upload to the service. These terms do not transfer your rights in the data to us.' },
        { p: 'We process the data only to provide the service, keep it secure and meet legal obligations. You are responsible for making sure the data you upload is lawful.' },
        { p: 'How personal data is processed, how long it is kept and your rights are described on the Privacy page.' },
        { link: 'privacy', label: 'Read the Privacy and KVKK page' },
      ] },
      { t: 'Service continuity and limit of liability', b: [
        { p: 'We aim to provide the service without interruption or errors. Maintenance, faults or causes beyond our control may cause outages, and we cannot guarantee otherwise.' },
        { p: "The tools' results rely on the data you upload and on information from third parties. Decisions you make based on these results are yours." },
        { p: 'To the extent the law allows, we are not liable for indirect damages or loss of profit. Our liability is capped at: [[LIABILITY LIMIT]]' },
        { p: 'Cases where the law does not allow limitation are reserved.' },
      ] },
      { t: 'Closing your account', b: [
        { p: 'You can write to us to close your account. Closing process: [[TO BE COMPLETED]]. We may also close the account if the rules in section 4 are violated.' },
        { p: 'Option to export your data after closure: [[DATA EXPORT PERIOD]]' },
        { p: 'After that, the data is deleted under the retention rules on the Privacy page, or kept for as long as the law requires. [[TO BE VERIFIED]]' },
      ] },
      { t: 'Changes', b: [
        { p: 'As the service evolves, we may update these terms. We aim to notify you of important changes by email or in the app. [[TO BE VERIFIED]]' },
        { p: 'If you keep using the service after a notice, you accept the new terms. If you do not accept them, you can ask for your account to be closed. Notice period: [[NOTICE PERIOD]]' },
      ] },
      { t: 'Governing law and competent court', b: [
        { p: 'These terms are governed by the law of the Republic of Türkiye.' },
        { p: 'Competent courts and enforcement offices for disputes: [[TO BE COMPLETED]]' },
      ] },
    ],
  },
};
