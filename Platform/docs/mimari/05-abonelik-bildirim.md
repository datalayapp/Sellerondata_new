# Mimari: abonelik, firma dili, araç bildirimi (§6 alt bölümleri)

Dizin ve diğer parçalar: `Platform/docs/ARCHITECTURE.md`. Bu bölümler §6 "Hesap API"ye aittir.

### Abonelik durumları ve destek komutları

`Subscription` satırı `(firma, ürün)` başına bir tanedir. Durumlar:
- `ACTIVE`;
- `READ_ONLY` (durdurma: okur, yazamaz);
- `CANCELED` (iptal: `deleteAfter` gününe kadar okunur, varsayılan 90 gün; sonra jetonda ve `/me`'de ürün düşer).

**Hiçbir durum veri silmez**; silme işi yok. `CANCELED` doğrudan `READ_ONLY` olamaz, önce `ACTIVE`. Aynı durum ve plan tekrar verilirse değişiklik olmaz: olay, sürüm artışı ve denetim kaydı yok.

- **Durum değişince epoch artar:** durdurma, iptal, geri açma ve ilk açılışta firmadaki bütün üyeliklerin epoch'u artar ve `member.upserted` gider; eski jetonlar araçta `401 TOKEN_STALE` alır, istemci sessizce yeniler, 10 dk beklenmez. Durum değişirken arada katılan üye de (davet kilidiyle yeniden listelenir) artırılır. Yalnız plan değişirse epoch artmaz (jetondaki plan en çok 10 dk eski kalabilir).
- **İlk açılış:** `subscription.updated` ve `org.updated` gider; sahibin bu üründe rolü yoksa aracın sahip rolü verilir; bütün üyeler araca duyurulur (rolü yoksa `role: null`). Yeni olay türü yoktur.
- **Kapalı firma (destek komutu):** `org:close` bütün abonelikleri iptal eder ve bekleyen katılma davetlerini düşürür; bundan sonra davet `409 ORG_CLOSED`. Telefon sıfırlama kodları (`PHONE_RESET`) korunur. `org:reopen` kapatma kaydına bakıp eski durumlara döner.
- **Yalnız sunucuda:** abonelik değiştirmenin HTTP ucu yoktur (`POST /org/billing/*` 501 kalır). Komutlar operatör adı ister ve denetim izine yazar (`support.subscription_changed`, `support.org_closed`, `support.org_reopened`). Mantık `account-api/src/lib/subscriptions.ts`. Çalıştırma: `KURULUM.md` "Destek komutları".
- **Müşteriye görünen iz:** `GET /org/audit` `support.*` kayıtlarının `operator` ve `reason` alanlarını göndermez; işlemin kendisi (ürün, eski ve yeni durum) görünür. Operatör ve iç gerekçe yalnız veritabanındaki kayıtta kalır.
- **Kullanılmamış kayıt temizliği:** `signup:purge --operator <ad> [--days 7] [--limit 500] [--yes]` (imajda `node dist/signup-purge.js`) yalnız elle çalışır, bakım turunda yoktur. `--yes` yoksa listeyi (adres maskeli) yazar, çıkış 2. Mantık `account-api/src/lib/signupPurge.ts`.
  - Aday kişinin bütün koşulları:
    - e-postası doğrulanmamış, bekleyen e-postası ve telefonu yok, askıda değil, `--days` günden (en az 7) eski;
    - hiç `Session` satırı, şifre sıfırlama jetonu ya da kullanılmış bağlantısı yok; son `--days` gün içinde üretilmiş tek kullanımlık jetonu yok (doğru şifreyle giriş denemesi ve "yeniden gönder" yeni doğrulama bağlantısı üretir: kişi hesabıyla ilgileniyor);
    - denetim izinde kendi firmasının `org.created` kaydından başka kaydı yok (kişiyi hedef alan kayıtlardan yalnız `login.locked` sayılmaz);
    - tek üyeliği, tek üyesi kendisi olan firmada `lastActiveAt` boş OWNER; firmada hiç davet, bildirim, ödeme alanı ve `org.created` dışında iz yok; adresine başka firmadan davet yok.
  - Kişi başına ayrı işlem, kilit sırası firma → abonelik → kişi → üyelik → davet, koşullar kilit altında yeniden denetlenir.
  - Silmeden önce `member.removed` (epoch + 1) ve `subscription.updated` (`CANCELED`, sürüm + 1) kuyruğa girer, firma silinince de teslim edilir (DeciShip'teki firma satırı kalır). İz `support.signup_purged` (kişi düzeyi, adres yazılmaz).
  - Kural: Hesap servisine oturum satırı ya da denetim izi bırakmayan yeni bir giriş/kullanım yolu eklenirse aday koşuluna da eklenmeli.
- `product:launch` yalnız aboneliği olmayan, kapatılmamış firmalara açar; `public` olmayan araca reddeder.

### Firma dili ve saat dilimi

Firmanın dili ve saat dilimi Merkez › Firma ekranından, yönetici tarafından `PATCH /org` ile değişir; tek kaynak Hesap servisidir.

- **Dil** (`locale`, `tr|en`): davet postaları bu dilde gider. Araç bildirimi ise alıcının kendi dilinde gider (`Person.locale`). Dil ürüne olayla gitmez, sürüm artırmaz.
- **Saat dilimi** (`timeZone`): kısa liste `contracts/src/timezones.ts` `TIME_ZONES` (16 değer); listede olmayan 400 `VALIDATION`. Firma açılışında ülkeden önerilir (`defaultTimeZone`: TR İstanbul, GB Londra, DE Berlin, FR Paris, NL Amsterdam, US New York, diğerleri İstanbul); ekranda ülke değişince saat dilimine dokunulmadıysa önerilen seçilir. Göçten önce açılmış firmalar `Europe/Istanbul` aldı.
- **Olayla yayılma:** değişen saat dilimi sürümü artırır ve `org.updated` ile araçlara gider; araç sürüm koşulu tutarsa kendi kopyasına yazar (DeciShip `settings.timeZone`, `identity.ts`). Varsayılan değer yalnız gerçekten söylendiğinde gider (firma açılışı, saat dilimini değiştiren `PATCH`): yeniden duyurular varsayılanı göndermez, araçta önceden yazılmış değer ezilmez. Eski sürümlü olay yeni değeri ezmez; alanı olmayan olay kayıtlı değere dokunmaz.
- `GET /me` `activeOrg` `locale` ve `timeZone` taşır (sözleşmede isteğe bağlı).
- DeciShip `PATCH /settings` `timeZone` kabul etmez: tek yazar Hesap'tır.
- Saat dilimi faturanın hesap dayanağına girmez (`Deciship/SPEC.md` §3.14): donmuş sonuçlar değişmez.
- **Sunucuda kullanıldığı yerler:** DeciShip pano ve ölçüm "bugün"ü, tarih süzgeçleri, Merkez dönemleri, CSV ve rapor saatleri, itiraz kanıtındaki ölçüm saati, hatırlatmanın saat penceresi ve takvim günü, yapay zekâ dönemi, tarife geri yükleme etiketindeki saat, dosyada tarih yoksa fatura tarihinin "bugün"ü.
- **Web arayüzünde:**
  - Kabuk `/me` gelince (ve ilk karede önbellekteki `/me`'den) `activeOrg.timeZone`'u `setShellTimeZone` ile atar; çıkışta ve 401'de temizler. Tek kaynak `shell/src/timeZone.ts` (`shellTimeZone()`; React'siz, düz Node testleri için alt giriş `@sellerondata/shell/time-zone`).
  - Bu saat diliminde yazan ve güne çevirenler: kabuk biçimlemesi (`formatDate`, `formatDateTime`, `formatRelative`, `formatHubValue`), Merkez hazır aralıkları (`lib/period.ts` `isoDay`, `rangeDates`), Etkinlik gün grubu ve gün süzgeci, DeciShip paneli `fmtDate`, `fmtDateTime`, `isoDate`, `monthKey`, `recentMonthKeys`.
  - Gün hesabı `@sellerondata/format/zoned` (`zonedDay`, `addDays`, `addMonths`; `formatToParts`'sız, telefonda da çalışır).
  - Yalnız gün olan değer ("2026-10-27": fatura tarihi, gönderim günü) takvim günüdür: UTC'de yazılır, hiçbir saat dilimi onu kaydırmaz.
  - Saat dilimi atanmamışsa (firma yok, alanı göndermeyen sunucu, `/me` gelmeden önce önbelleksiz ilk kare) her yer tarayıcının saatini kullanır.
- **Mobilde** aynı kural: `apps/mobile/src/lib/format.ts` `setFormatTimeZone` (`me.activeOrg.timeZone`); bilinmiyorsa telefonun saati.
- **Bilerek sabit kalanlar (para etkili):** itiraz süreleri ve son gün rozeti Türkiye günüyle (`disputes.ts`, `invoiceHints`, Merkez `daysUntil` `DUE_DATE_TIME_ZONE`, panel `turkeyDate`); TCMB kur günü (`fx.ts`); Excel gün hücresi okuma (`parseDayInput`, İstanbul); saklanan gün alanlarının UTC yazımı.

### Araç bildirimi

`POST /api/account/internal/notify`: bir araç "bu firmada şu izni taşıyanlara bu metni gönder" der; alıcıyı, adresi ve dili Hesap servisi seçer. Araç kişilerin e-posta adresini öğrenmez. İlk kullanıcısı DeciShip'in itiraz süresi hatırlatmasıdır (`Deciship/SPEC.md` §5.14). Kod `account-api/src/routes/internal.ts`, `lib/productNotice.ts`; sözleşme `contracts/src/notify.ts`.

- **Dışarıya kapalı:** gateway ve geliştirme kapısı `internal` geçen her yolu 404 yapar; üretimde `account-api` portu dışarı açık değildir. Kullanıcı oturumu kabul edilmez.
- **Kimlik:** `authorization: Bearer <anahtar>`.
  - Ürün anahtardan çözülür: sunulan anahtar `PRODUCT_NOTIFY_SECRETS` haritasındaki (`urun=anahtar`) her anahtarla özetlenip sabit süreli karşılaştırılır; gövdedeki `product` bu ürünle aynı olmalı (bir araç başka aracın adına isteyemez). Tutmazsa 401 `UNAUTHORIZED`, gövde doğrulamasından önce.
  - Anahtar günlüğe ve yanıta girmez. Biçim: 32–512 yazdırılabilir ASCII (`isValidNotifySecret`); iki ürün aynı anahtarı paylaşamaz; üretimde geliştirme anahtarı (`DEV_PRODUCT_NOTIFY_SECRET`) ya da kısa anahtar servisi başlatmaz. Harita boşsa uç kapalıdır (her istek 401).
- **Gövde** (en çok 16 KB; aşan 400 `VALIDATION`): `{ product, orgId, dedupeKey (/^[a-z0-9:._-]{1,120}$/i), audience: { permission }, message: { tr, en } }`; her dilde `{ subject ≤120, lines 1..10 × ≤300, action?: { label ≤40, path ≤200 }, footer? ≤200 }`. İzin `${product}.` ile başlar ve katalogda olmalı.
  - Metin düz metindir: denetim ve biçim karakteri, satır ayırıcı ve bağlantı biçimi (`http`, `://`, `www.`) reddedilir (`isNoticePlainText`), HTML'de kaçışlanır.
  - Postada konu, satırlar, düğme etiketi ve dipnot ayrıca `defangLinkText` ile katlanıp etkisizleşir: faturadan gelen tam genişlikli ya da çıplak alan adı (`evil-kargo.com/odeme`) tıklanır bağlantıya dönmez ("evil-kargo. com").
  - Eylem yolu yalnız aracın kendi sayfasıdır (`isNoticeActionPath`: `/${product}/` ile başlar, `..` ve `//` yok); bağlantı Hesap'ta `APP_BASE_URL + path` ile kurulur, gövdede adres taşınmaz.
- **Alıcı:** firmada etkin üyeliği olan, askıda olmayan, e-postası doğrulanmış ve o araçtaki rolü istenen izni veren kişiler. Alıcı listesi yanıtta dönmez, yalnız sayı.
- **Sınırlar:** `(product, orgId, dedupeKey)` tekildir, tekrar istek `duplicate` (gönderilmiş ya da gönderimi süren); firma başına araç başına 24 saatte en çok 30 ileti (`limited`); aboneliği etkin olmayan ya da kapalı araçta `disabled`. Tekrar ve tavan aynı işlemde, firma kilidi altında. Satır yalnız posta kuyruğa girince yazılır: `no_recipients`, `disabled`, `limited` iz bırakmaz.
- **Yanıt** `200 { status: 'queued'|'duplicate'|'no_recipients'|'limited'|'disabled', recipients }`; diğerleri 400 `VALIDATION`, 404 `ORG_NOT_FOUND`.
- **Gönderim:** mevcut posta kuyruğu (`queueMail`), kişinin diline göre TR ya da EN; bir alıcının postası kurulamazsa kalanlar yine gider. Yerelde `MailLog` (`POSTA.bat`). Bütün postaların denemesi bitince (başarılı ya da kalıcı hatalı) satıra `sentAt` yazılır; yanıt bunu en çok 3 sn bekler (`NOTICE_SEND_WAIT_MS`, aracın 5 sn sınırının altında), süre dolarsa yine `queued` döner.
- **Yarım kalan gönderim:**
  - `sentAt` boş ve son deneme (`attemptedAt`) `NOTICE_RESEND_AFTER_MINUTES` (10 dk) öncesindeyse aynı anahtarla ve **aynı gövdeyle** gelen istek postaları yeniden kuyruğa alır ve `queued` döner; daha yeni denemede ya da başka metin veya izinle `duplicate`.
  - Gövde, ilk istekte saklanan özetle karşılaştırılır (`bodyHash`: izin + iki dildeki metin, sıralı JSON'un SHA-256'sı; gövdenin kendisi saklanmaz): ilk istekte gitmemiş bir metin yeniden gönderim yoluyla gönderilemez.
  - Deneme anı uygulamanın değil veritabanının saatiyle (`now()`) yazılır ve karşılaştırılır: kopyalar arası saat kayması erken göndertmez. Aynı firma kilidi ve koşullu yazım (`sentAt IS NULL AND attemptedAt <= now() - eşik AND bodyHash = …`) iki kopyanın çift göndermesini önler.
  - `attemptedAt` ya da `bodyHash` boş satır (kademeli yayında bu sütunları bilmeyen eski kodun yazdığı) ve göçten önceki satırlar gönderilmiş sayılır.
  - Yeniden gönderim aynı satırdır: `createdAt` değişmez, 24 saat tavanı yeniden sorulmaz (ileti bir kez sayılmıştır); abonelik (`disabled`) ve alıcı kuralları yeniden uygulanır.
- **Temizlik:** `ProductNotice` satırları 30 gün sonra saatlik bakımda silinir.
- **Bilinen sınırlar:**
  - Yeniden gönderim yalnız araç aynı anahtarla yeniden sorarsa olur; Hesap gövdeyi saklamaz. Süreç `queued` yanıtından sonra (3 sn bekleme dolmuş, postalar sürüyorken) durursa DeciShip o günü cevaplanmış sayar ve yeniden başlamadıkça sormaz.
  - Kalıcı hatada (ör. adres reddedildi) `sentAt` yine yazılır: tekrar etmek düzeltmez, öbür alıcılara çift posta gider.
  - Teslim **en az bir kezdir**: alıcı başına gönderim izi tutulmaz; süreç birkaç alıcıya gönderdikten sonra durursa yeniden gönderim bütün alıcılara gider, o alıcılar postayı iki kez alır.
  - DeciShip'in aynı günkü gövdesi turlar arasında değişebilir (araya yüklenen fatura): o zaman yarım kalan posta yeniden gönderilmez.
