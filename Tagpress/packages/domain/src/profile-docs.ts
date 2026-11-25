/**
 * Profil alanlarının insan dilinde açıklaması. Arayüz (Tasarım dili sekmesi), MCP sunucusu ve
 * AI talimatları alan adlarını kullanıcıya bu tablodan anlatır. Yeni bir profil alanı eklenirse buraya da yazılır
 * (`profile-docs.test.ts` eksik alanı yakalar).
 *
 * enforcement:
 *  - "motor": deterministik motor kesin uygular; AI değiştiremez.
 *  - "ai": AI'a yol gösterir; motor zorlamaz.
 *  - "ikisi": AI'a söylenir ve motor/doğrulama da denetler.
 *  - "sistem": üretimi değil uygulamanın davranışını etkiler (baskı, sticker, kalite işaretleri).
 * level: "temel" ayarlar varsayılan olarak görünür; "ileri" katlıdır.
 */
export type Enforcement = "motor" | "ai" | "ikisi" | "sistem";

export interface FieldDoc {
  label: string;
  help: string;
  enforcement: Enforcement;
  level: "temel" | "ileri";
  group: ProfileGroup;
  /** Sayısal alanlarda gösterim: "oran" → yüzde, "em", "px", "pt". */
  unit?: "oran" | "em" | "px" | "pt" | "karakter" | "satır";
  /** Arayüzde gösterilmez (eski, artık kullanılmayan alan; geriye uyumluluk için şemada kalır). */
  hidden?: boolean;
}

export type ProfileGroup =
  | "genel"
  | "fontlar"
  | "ozel-karakterler"
  | "boyut"
  | "bosluk"
  | "baglaclar"
  | "satir-bolme"
  | "kalinlik-renk"
  | "cikti"
  | "sticker"
  | "baski"
  | "kalite";

export const PROFILE_GROUPS: { id: ProfileGroup; label: string; help: string }[] = [
  { id: "genel", label: "Genel", help: "Tasarım dilinin adı ve ayarla söylenemeyen tarz notu." },
  { id: "fontlar", label: "Fontlar", help: "Hangi fontlar, hangi satırlarda ve hangi sınırlarla kullanılır." },
  { id: "ozel-karakterler", label: "Özel karakterler", help: "Belirli karakterleri başka bir fonttan ya da boyuttan basma kuralları." },
  { id: "boyut", label: "Boyut ve doluluk", help: "Yazının ne kadar büyük olduğu ve satırların birbirine oranı." },
  { id: "bosluk", label: "Satır aralığı ve hizalama", help: "Satırlar arasındaki görünen boşluk ve hizalama." },
  { id: "baglaclar", label: "Bağlaçlar", help: "&, and, e, y gibi bağlaçların nasıl dizildiği." },
  { id: "satir-bolme", label: "Satır bölme", help: "Metnin satırlara nasıl bölündüğü." },
  { id: "kalinlik-renk", label: "Kalınlık ve renk", help: "Harf kalınlığı ve yazı rengi." },
  { id: "cikti", label: "Etiket ölçüleri", help: "Kesim şekli, etiket boyutları ve şablonun yeri." },
  { id: "sticker", label: "Sticker", help: "Sticker siparişlerinin tespiti ve sayfaları." },
  { id: "baski", label: "Baskı", help: "Baskı sayfalarında fazlalık ve çözünürlük kuralları." },
  { id: "kalite", label: "Kalite işaretleri", help: "Varyasyonların kontrol ve okunurluk işaretleri." },
];

export const PROFILE_DOCS: Record<string, FieldDoc> = {
  name: { label: "Ad", help: "Tasarım dilinin adı.", enforcement: "sistem", level: "temel", group: "genel" },
  description: { label: "Açıklama", help: "Kısa tanım: kimin, hangi işler için.", enforcement: "sistem", level: "temel", group: "genel" },
  "ai.instructions": {
    label: "Tarz notu",
    help: "Ayarla söylenemeyen tarz (ör. 'zarif, ferah, romantik'). Kesin kurallar buraya değil, ilgili ayara yazılır.",
    enforcement: "ai",
    level: "temel",
    group: "genel",
  },

  "fonts.list": { label: "Font listesi", help: "Kullanılabilen fontlar, türleri, rolleri ve sınırları.", enforcement: "ikisi", level: "temel", group: "fontlar" },
  "fonts.mixing": {
    label: "Bir etikette font ailesi",
    help: "Tek aile: bütün satırlar aynı fontla (özel karakter kuralları hariç). İki aile ya da serbest.",
    enforcement: "ikisi",
    level: "temel",
    group: "fontlar",
  },

  glyphRules: {
    label: "Özel karakter kuralları",
    help: "Ör. '&' her zaman IM FELL ile ve yarım boyutta; kelime başındaki büyük A başka fonttan. Her satırda geçerli.",
    enforcement: "motor",
    level: "temel",
    group: "ozel-karakterler",
  },

  "sizing.fill": {
    label: "Doluluk",
    help: "Yazı, alana sığabileceği en büyük boyutun bu oranında olur. 1 = tamamen dolu.",
    enforcement: "motor",
    level: "temel",
    group: "boyut",
    unit: "oran",
  },
  "sizing.fillLocked": { label: "Doluluk sabit", help: "Açıkken her tasarım aynı doluluğu kullanır; kapalıyken AI önerebilir.", enforcement: "motor", level: "ileri", group: "boyut" },
  "sizing.tiers.primary": { label: "Ana satır", help: "En büyük satır (genelde isim). Diğer oranlar buna göre.", enforcement: "motor", level: "ileri", group: "boyut", unit: "oran" },
  "sizing.tiers.secondary": { label: "İkincil satır", help: "Ana satırdan küçük destek satırları.", enforcement: "motor", level: "temel", group: "boyut", unit: "oran" },
  "sizing.tiers.tertiary": { label: "Üçüncül satır", help: "En küçük satırlar (tarih, yer, uzun mesaj).", enforcement: "motor", level: "temel", group: "boyut", unit: "oran" },
  "sizing.tiers.connector": { label: "Tek başına bağlaç", help: "Kendi satırındaki bağlacın ana satıra oranı.", enforcement: "motor", level: "temel", group: "boyut", unit: "oran" },
  "sizing.tiersLocked": { label: "Oranları motor uygulasın", help: "Açıkken AI yalnızca satırın sınıfını seçer, boyutu bu oranlar belirler.", enforcement: "motor", level: "ileri", group: "boyut" },
  "sizing.connectorScales": { label: "Bağlaca özel oran", help: "Belirli bir bağlaç için farklı oran (ör. 'e' 0,45).", enforcement: "motor", level: "ileri", group: "boyut" },
  "sizing.maxCapHeight": {
    label: "Harf yüksekliği sınırı",
    help: "Kısa metinler aşırı büyümesin: büyük harf yüksekliği en fazla kesim çapının bu oranı.",
    enforcement: "motor",
    level: "temel",
    group: "boyut",
    unit: "oran",
  },
  "sizing.minPt": { label: "En küçük punto", help: "Hiçbir satır bunun altına inmez.", enforcement: "motor", level: "ileri", group: "boyut", unit: "pt" },
  "sizing.maxPt": { label: "En büyük punto", help: "Hiçbir satır bunun üstüne çıkmaz.", enforcement: "motor", level: "ileri", group: "boyut", unit: "pt" },
  "sizing.breathing": { label: "Nefes payı", help: "Yazı ile dekor arasında bırakılan boşluk (kesim çapına oran).", enforcement: "motor", level: "ileri", group: "boyut", unit: "oran" },
  "sizing.edgeMargin": { label: "Kesim payı", help: "Yazı ile kesim çizgisi arasında bırakılan boşluk (kesim çapına oran).", enforcement: "motor", level: "ileri", group: "boyut", unit: "oran" },
  "sizing.initials.oneLine": { label: "Baş harfler tek satırda", help: "Yalnızca baş harf ('A & M') asla alt alta dizilmez.", enforcement: "motor", level: "temel", group: "boyut" },
  "sizing.initials.maxCapHeight": { label: "Baş harf yüksekliği", help: "Yalnızca baş harf olan etikette harf yüksekliği sınırı. Boş = genel sınır.", enforcement: "motor", level: "ileri", group: "boyut", unit: "oran" },

  "spacing.align": { label: "Hizalama", help: "Satırlar mürekkep kutusuna göre ortalanır (ya da sola/sağa yaslanır).", enforcement: "motor", level: "temel", group: "bosluk" },
  "spacing.inkGaps.normal": { label: "Satır arası", help: "Satırlar arasında görünen boşluk, küçük satırın puntosuna oran.", enforcement: "motor", level: "temel", group: "bosluk", unit: "oran" },
  "spacing.inkGaps.beforeLast": { label: "Son küçük satırdan önce", help: "Tarih/yer gibi son küçük satırdan önceki boşluk.", enforcement: "motor", level: "temel", group: "bosluk", unit: "oran" },
  "spacing.inkGaps.connector": { label: "Bağlaç çevresi", help: "Tek başına bağlaç satırının üstü ve altındaki boşluk.", enforcement: "motor", level: "temel", group: "bosluk", unit: "oran" },
  "spacing.beforeLastRatio": { label: "Son satır eşiği", help: "Son satır üstündekinin bu oranından küçükse 'son küçük satır' sayılır.", enforcement: "motor", level: "ileri", group: "bosluk", unit: "oran" },

  "connectors.words": { label: "Bağlaçlar", help: "Bağlaç sayılan kelime ve semboller (&, and, e, y…).", enforcement: "ikisi", level: "temel", group: "baglaclar" },
  "connectors.shiftEm": {
    label: "Bağlaç sağa kayması",
    help: "İki el yazısı ismin arasındaki tek başına bağlaç, isimlerin ortasından bu kadar sağa (isim puntosu cinsinden).",
    enforcement: "motor",
    level: "ileri",
    group: "baglaclar",
    unit: "em",
  },
  "connectors.separateDangling": { label: "Asılı bağlaç olmaz", help: "'Elena' / 'e Martina' gibi satır başında/sonunda kalan bağlaç kendi satırına alınır.", enforcement: "motor", level: "temel", group: "baglaclar" },
  "connectors.allowSymbolSpacing": { label: "& çevresine boşluk", help: "'Mina&Ali' yazısında & çevresine nefes boşluğu eklenebilir (metin değişmiş sayılmaz).", enforcement: "ikisi", level: "ileri", group: "baglaclar" },

  "lineBreaking.maxLineChars": { label: "Satır uzunluğu sınırı", help: "Hiçbir satır bu kadar karakteri geçmez.", enforcement: "ikisi", level: "temel", group: "satir-bolme", unit: "karakter" },
  "lineBreaking.typicalLines": { label: "Tipik satır sayısı", help: "Çoğu etiketin satır aralığı (en az – en çok).", enforcement: "ai", level: "ileri", group: "satir-bolme", unit: "satır" },
  "lineBreaking.maxLines": { label: "En fazla satır", help: "Hiçbir etiket bundan çok satır olmaz.", enforcement: "ikisi", level: "ileri", group: "satir-bolme", unit: "satır" },
  "lineBreaking.nameOwnLine": { label: "İsim kendi satırında", help: "Kişi adı kendi satırında ve en büyük satırdır.", enforcement: "ikisi", level: "temel", group: "satir-bolme" },
  "lineBreaking.coupleStack": { label: "Çiftler alt alta", help: "Çift isimlerinde isim / & / isim dizilişi: her zaman, adaylardan biri ya da hiç.", enforcement: "ikisi", level: "temel", group: "satir-bolme" },
  "lineBreaking.keepShortGreetings": { label: "Kısa selam bölünmez", help: "Açıkken en çok üç kelimelik selam ve teşekkür ifadeleri ('Thank You', 'Merry Christmas') hiç bölünmez; motor ve AI denetler. Bazı selamları bölüyorsanız (ör. bayram selamı iki satır) kapatın ve ayrımı satır bölme notlarına ve örneklere yazın.", enforcement: "ikisi", level: "temel", group: "satir-bolme" },
  "lineBreaking.dateOwnLine": { label: "Tarih kendi satırında", help: "Tarih ayrı satırda durur.", enforcement: "ikisi", level: "temel", group: "satir-bolme" },
  "lineBreaking.customerBreaks": { label: "Müşterinin satır sonları", help: "Müşteri çift boşlukla satır verdiyse: ipucu, kesin ya da yok say.", enforcement: "ikisi", level: "ileri", group: "satir-bolme" },
  "lineBreaking.noLoneWords": { label: "Tek başına satır olamayanlar", help: "Edat ve tanımlıklar (di, de, of, la…) ait olduğu ifadeyle kalır.", enforcement: "ikisi", level: "temel", group: "satir-bolme" },
  "lineBreaking.notes": { label: "Satır bölme notları", help: "Kurallarla söylenemeyen bölme alışkanlıkları (AI okur).", enforcement: "ai", level: "temel", group: "satir-bolme" },
  "lineBreaking.examples": { label: "Örnek bölmeler", help: "Metin → satırlar örnekleri. AI'a gösterilir; kuraldan güçlüdür.", enforcement: "ai", level: "temel", group: "satir-bolme" },

  "weight.mode": { label: "Kalınlaştırma", help: "Kontur: yazının kendi rengiyle ince kontur (fontta Bold yoksa). Gerçek: fontun kalın stili.", enforcement: "motor", level: "temel", group: "kalinlik-renk" },
  "weight.widthEm": { label: "Kontur kalınlığı", help: "Ana satır puntosunun oranı. Etiket başına tek değer.", enforcement: "motor", level: "temel", group: "kalinlik-renk", unit: "em" },
  "weight.minPx": { label: "En ince kontur", help: "Kontur en az bu kadar (px). 0 = sınır yok.", enforcement: "motor", level: "ileri", group: "kalinlik-renk", unit: "px" },
  "weight.maxPx": { label: "En kalın kontur", help: "Kontur en fazla bu kadar (px). 0 = sınır yok.", enforcement: "motor", level: "ileri", group: "kalinlik-renk", unit: "px" },
  "weight.align": { label: "Kontur hizası", help: "Dışa: harf içi boşluklar kapanmaz.", enforcement: "motor", level: "ileri", group: "kalinlik-renk" },
  "color.text": { label: "Yazı rengi", help: "Varsayılan yazı rengi.", enforcement: "motor", level: "temel", group: "kalinlik-renk" },
  "color.onDark": { label: "Koyu zeminde yazı rengi", help: "Zemin koyuysa kullanılacak renk.", enforcement: "motor", level: "ileri", group: "kalinlik-renk" },
  "color.autoContrast": { label: "Otomatik kontrast", help: "Zemin koyuysa kendiliğinden açık renge geç.", enforcement: "motor", level: "ileri", group: "kalinlik-renk" },

  "output.designFramePx": { label: "Tasarım alanı", help: "Bütün hesapların yapıldığı kare alan (px).", enforcement: "sistem", level: "ileri", group: "cikti", unit: "px" },
  "output.cut": { label: "Kesim şekli", help: "Etiketin kesim çizgisi (daire, oval, dikdörtgen…).", enforcement: "motor", level: "ileri", group: "cikti" },
  "output.templateBox": { label: "Şablonun yeri", help: "Şablon görselinin tasarım alanındaki konumu ve boyutu.", enforcement: "sistem", level: "ileri", group: "cikti" },
  "output.sizes": { label: "Etiket boyutları", help: "JSON'daki boyut adı → cm ve çerçeve boyutu (px). Tasarım varsayılan boyutta yapılır; diğer boyutlarda şablon ve yazı orantılı ölçeklenir (içerik ölçeği, yoksa frame / tasarım alanı).", enforcement: "sistem", level: "ileri", group: "cikti" },
  "output.defaultSize": { label: "Varsayılan boyut", help: "Siparişte boyut yazmıyorsa.", enforcement: "sistem", level: "ileri", group: "cikti" },

  "stickers.enabled": { label: "Sticker siparişleri", help: "Açıkken bazı siparişler etiket yerine sticker olarak hazırlanır.", enforcement: "sistem", level: "temel", group: "sticker" },
  "stickers.detect": { label: "Sticker nasıl anlaşılır", help: "Ürün alanı olan sipariş ya da şablonu boş sipariş.", enforcement: "sistem", level: "ileri", group: "sticker" },
  "stickers.sheets": { label: "Sticker sayfaları", help: "Sticker sayfaları: ürün anahtar kelimeleri ve ölçüler. Ölçüler pt cinsindendir (1 pt = 1/72 inç ≈ 0,35 mm; 108 pt = 38,1 mm).", enforcement: "sistem", level: "ileri", group: "sticker" },

  "printing.labelExtraMin": { label: "Etiket fazlalığı (en az)", help: "Sipariş adedinin üstüne basılan en az fazla etiket.", enforcement: "sistem", level: "temel", group: "baski" },
  "printing.labelExtraMax": { label: "Etiket fazlalığı (en çok)", help: "Büyük siparişlerde basılan en çok fazla etiket.", enforcement: "sistem", level: "temel", group: "baski" },
  "printing.labelRoundUpMaxExtra": { label: "Sayfayı tamamla", help: "Kalan etiketler tam sayfaya en çok bu kadar eksikse sayfa aynı siparişle tamamlanır.", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.labelExtraScaleLow": { label: "Fazlalık ölçeği (alt adet)", help: "Bu adet ve altında en az fazlalık basılır.", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.labelExtraScaleHigh": { label: "Fazlalık ölçeği (üst adet)", help: "Bu adet ve üstünde en çok fazlalık basılır; arası orantılıdır.", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.separateSameDesign": { label: "Aynı tasarımı ayır", help: "Aynı tasarım numaralı siparişler aynı karışık sayfaya konmaz (karışmasın diye).", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.stickerExtraMin": { label: "Sticker fazlalığı (en az)", help: "Sticker siparişlerinde adedin üstüne en az fazla.", enforcement: "sistem", level: "temel", group: "baski" },
  "printing.stickerExtraMax": { label: "Sticker fazlalığı (en çok)", help: "Sticker siparişlerinde adedin üstüne en çok fazla.", enforcement: "sistem", level: "temel", group: "baski" },
  "printing.stickerDpi": { label: "Sticker çözünürlüğü", help: "Sticker sayfalarının PNG ve raster PDF çözünürlüğü (dpi). Sticker'ın boyutu değişmez (mm); 300 yazıcılar için yeterli.", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.dpi": { label: "Baskı çözünürlüğü", help: "PNG çıktısının ve raster PDF'in çözünürlüğü (dpi). 300 yazıcılar için yeterli.", enforcement: "sistem", level: "ileri", group: "baski" },
  "printing.orderNamePattern": { label: "Sipariş adı deseni", help: "Baskı sayfasındaki sipariş adı (hücre etiketi). {orderNo}, {quantity}, {template}, {size}, {seq} ve sipariş dosyasındaki alan adları kullanılabilir; boşsa sipariş adı basılmaz.", enforcement: "sistem", level: "ileri", group: "baski" },
  "quality.suspectScore": { label: "Kontrol eşiği", help: "Bu puanın altındaki varyasyon 'kontrol et' işaretlenir.", enforcement: "sistem", level: "ileri", group: "kalite" },
  "quality.readableMinPt": { label: "Okunurluk sınırı", help: "En küçük satır bunun altındaysa uyarı verilir.", enforcement: "sistem", level: "ileri", group: "kalite", unit: "pt" },
};
