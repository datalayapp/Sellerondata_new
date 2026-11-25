# Merkez (hub-web): ürün gerçeği

Kaynak: `Platform/docs/ARCHITECTURE.md` §8 ve `Platform/docs/KARARLAR.md`. "Varsayım" yazan satırlar çıkarımdır; çelişirse KARARLAR geçerlidir.

## Kullanıcı ve iş
- Birincil: Türkiye'de e-ticaret/ihracat yapan KOBİ'nin sahibi veya operasyon yöneticisi. Sabah masaüstünde açar: "para nerede kaçıyor, ne bekliyor?" (Varsayım: masaüstü, ofis ışığı, günde birkaç kez kısa oturum.)
- İkincil: Denetleyici ve Muhasebe rolleri, derine inip dışa aktarır. Ölçüm rolü web'de yalnız sade görünüm alır, işi mobilde.
- İş: araçların sayılarını okumak, kişileri ve yetkileri yönetmek. İş işlemi araçta kalır; Merkez derin bağlantı verir.

## Konum
Merkez bir geçiş sayfası değil, işletmenin sayılarının okunduğu kontrol merkezidir. Ürün etiketleri ürün API'sinden gelir, Merkez ürüne özel metin bilmez.

## Kısıtlar
- Tasarım kuralları `Platform/docs/DESIGN.md` içindedir (bağlayıcı); burada tekrarlanmaz. Kabuk D09 "Renk bandı" (`packages/shell`), IBM Plex Sans/Mono. Birincil düğme rengi: Merkez'de lacivert `#0f2a5c`, her araçta aracın kendi rengi (DeciShip `#1d5bd8`). Ürün rengi işarette, etkin araç belirtecinde ve o aracın içindeki birincil düğmede.
- Deneme süresi yok. Ödeme placeholder. Yalnız DeciShip çalışır; OrderLoom ve TagPress tıklanamaz.
- TR + EN. Metinler kısa, net, süssüz. AA kontrast, klavye, odak halkası.

## Platform
web
