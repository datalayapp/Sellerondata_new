# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: React 19 + Vite + TanStack Query + Tailwind 4 (yerel Fastify sunucusu derlenmiş arayüzü 5420 portundan sunar). Figma eklentisi yok (2026-10-10'da kaldırıldı).

## Users

- **Birincil (bugün):** işletme sahibi ve tasarımcı. Kendi bilgisayarında, gün içinde düzenli olarak, ofis ışığında çalışır. Günde 10–20 sipariş (bazen bir partide 25–60). Müşterilerin kutlama/hatıra etiketlerini (düğün, vaftiz, doğum günü, teşekkür; İngilizce, İtalyanca, İspanyolca, Portekizce…) hazırlar ve uygulamanın Baskı masasında basar (önceden Figma'da yapıyordu). Teknik kararları bırakır, ürün kararlarını kendi verir. Türkçe konuşur.
- **Sonraki (ürün satılabilir olunca):** başka şablon tasarımcıları. Kendi şablonları, fontları ve tarzlarıyla gelirler; sistemi ilk günden anlayıp kendi işlerine hemen entegre edebilmeleri gerekir.
- **Yönetici rolü:** tasarım dilini (tarzı) Claude Code + Opus ile oluşturan kişi (bugün aynı kişi).

## Product Purpose

Sipariş JSON'undaki müşteri metinlerini etiket şablonlarına AI ile yerleştirmek ve Figma'da yapılan elle düzeltmeyi ortadan kaldırmak. Başarı: kullanıcı bir partiyi içe aktarır, sorunları içe aktarmada görür ve düzeltir, tek seferde üretir, varyasyonları yan yana karşılaştırıp onaylar ve Baskı masasında basar; elle düzeltme gerekmez ya da Düzelt penceresinde çok küçüktür. Hatasızlık hızdan önce gelir.

## Positioning

Genel bir AI tasarım aracı değil: kullanıcının KENDİ tarzını (tasarım dili) ölçerek öğrenen ve her etikete kesin kurallarla uygulayan bir çalışma masası. AI yalnızca tasarım niyeti üretir (satır bölme, satır sınıfı, font); yerleşimi gerçek font ölçümleriyle deterministik motor yapar. Kullanıcının düzeltmelerinden (Düzelt penceresi; eski Figma işlerinden aktarılan referanslar) öğrenir ve önerilerini önce/sonra göstererek onaya sunar.

## Operating Context

- Akış: JSON dosyası → içe aktarma incelemesi (satır satır düzenleme, sorunlar) → üretim (her iş için 1+ varyasyon) → karşılaştırma ve onay → Baskı masası (sayfa şablonları, PDF/PNG çıktı, basılanlar arşivi).
- Etiketler renkli, çoğunlukla yuvarlak (2,5 / 3,8 / 5,2 cm); şablonlar çiçek çelengi, altın halka, kraft, pastel, koyu zemin gibi çok renkli görseller. Arayüz bu görsellerin renklerini bozmamalı; etiket görseli her ekranda başroldedir.
- Sticker siparişleri (zeminsiz yazı, sayfalara dizilir) ve görüntü modeliyle üretim (şablona yaz — şablona asla dokunmadan; temadan yeni şablon) de akışın parçası.

## Capabilities and Constraints

- Terimler: Parti (bir JSON içe aktarımı), İş (bir sipariş), Şablon, Varyasyon (V1, V2…), AI notu, Tasarım dili (profil + şablonlar + fontlar), Onayla, Baskı masası, Sorun, Düzelt.
- Müşteri metni hiçbir otomatik adımda değişmez; değişiklik yalnızca kullanıcının elle düzenlemesiyle olur.
- Her otomatik değişiklik açıklanabilir ve geri alınabilir (silme dahil).
- Şimdilik kimlik doğrulama yok, tek kullanıcı; mimari çok kullanıcıya hazır.
- Arayüz Türkçe; metinler ileride İngilizceye çevrilebilir tutulur.
- Bugünkü sistemin bütün yetenekleri korunur; ayrıntılar saklı, sık işler görünür.

## Brand Commitments

- Ad: **TagPress** (eski adı Etiket Studio).
- Ses: sade, net, Türkçe; teknik jargon yok ("geometri", "niyet", "prompt" gibi kelimeler kullanıcıya gösterilmez).
- Etiket görselleri ve renkleri en önemli içeriktir; arayüz onlarla yarışmaz.

## Evidence on Hand

- Gerçek şablonlar (54 PNG), gerçek fontlar, kullanıcının Figma'da düzelttiği 220 etiket ve eski sistemin varyasyonları (aktarım ile `data/` altında).
- Örnek sipariş dosyası: `C:\Users\Gokcan\Desktop\Etiketler.json` (25 sipariş).
- Uydurulmaması gerekenler: müşteri, fiyat, kullanım istatistiği iddiaları.

## Product Principles

1. Sık iş düşünmeden yapılır: içe aktar → üret → karşılaştır → onayla → gönder, birkaç tık ve klavye.
2. Sorun erken ve yerinde görünür; her sorunun yanında düzeltme yolu vardır.
3. Etiket başroldedir: kararlar her zaman büyük ve doğru renkli önizlemeyle verilir.
4. Tarz veridir: kullanıcı kendi tasarım dilini okuyabilir, deneyebilir, geri alabilir.
5. Hiçbir şey sessizce değişmez ya da kaybolmaz: açıklanabilir, geri alınabilir.

## Accessibility & Inclusion

Klavye ile tam kullanım (kısayollar), görünür odak, renk dışında da durum ayrımı (ikon/metin), WCAG AA kontrastı, `prefers-reduced-motion`.
