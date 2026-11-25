# DeciShip SPEC — İtiraz takibi: API sözleşmesi

Dizin ve diğer bölümler: [SPEC.md](../SPEC.md). Belge ile kod çelişirse kod doğrudur; bu dosya düzeltilir. Kurallar, veri modeli, "geçerli satır" ve "TTK": [itiraz.md](itiraz.md).

## API sözleşmesi

- Sarmal: mevcut uçlar gibi `{ data }` sarmalı yoktur; liste `{ items, total, page, pageSize, ... }`.
- Tarih alanları `YYYY-MM-DD` dizgesi, zaman damgaları ISO. Para alanları `number` (2 ondalık).
- `prices.view` yoksa sunucu para anahtarlarını siler (adlar bunun için seçildi; liste aşağıda "Para anahtarları"); arayüz bu alanlar yokken de çalışır.

```ts
type DisputeChannel = 'EMAIL' | 'PORTAL' | 'OTHER';
type DisputeLineOutcome = 'PENDING' | 'RECOVERED' | 'REJECTED';
type InvoiceDisputeStatus = 'NONE' | 'SENT' | 'CLOSED';
type DisputeListStatus = 'UNSENT' | 'SENT' | 'CLOSED';   // UNSENT: listede satır var, paket gönderilmedi

type PersonRef = { id: string; name: string };

type DisputeSums = {                // hepsi fatura para biriminde
  claimedAmount: number;            // gönderilen talep
  recoveredAmount: number;          // canlı dekont toplamı
  rejectedAmount: number;           // reddedilen satırların talebi
  pendingAmount: number;            // sonuçsuz satırların talebi
  shortfallAmount: number;          // kısmi geri almada talep − geri alınan
};

type DisputeLineView = {
  id: string; invoiceLineId: string; lineNo: number | null; trackingNo: string | null;
  claimedAmount: number; outcome: DisputeLineOutcome; recoveredAmount: number | null;
  resultId: string | null;
};

type DisputeResultView = {
  id: string; kind: 'RECOVERED' | 'REJECTED';
  creditNoteNo: string | null; resultOn: string; reason: string | null;
  amount: number;                   // RECOVERED: dekont toplamı; REJECTED: reddedilen talep
  lines: { disputeLineId: string; amount: number }[];
  enteredBy: PersonRef; enteredAt: string;
  revertedAt: string | null; revertedBy: PersonRef | null; revertReason: string | null;
};

type DisputeRound = {
  id: string; round: number; currency: string;
  sentOn: string; channel: DisputeChannel; channelNote: string | null; reference: string | null;
  sentBy: PersonRef; createdAt: string;
  ttk: 'ON_TIME' | 'LATE' | null;   // TTK uygulanmıyorsa null
  ttkSentOn: string;                // TTK'ya esas gönderim günü (itiraz.md "TTK"); yeniden gönderimde ilk gönderim, sentOn son gönderim
  withdrawnAt: string | null; withdrawnBy: PersonRef | null; withdrawReason: string | null;
  supersededById: string | null;
  supersededAt: string | null;      // yerini yeniye bıraktığı an (ISO)
  version: number;
  sums: DisputeSums;                // yalnız bu turun satırları
  lines: DisputeLineView[];
  results: DisputeResultView[];     // geri alınanlar dahil, yeni önce
};

// GET /invoices/:id yanıtına eklenir
type InvoiceDispute = {
  status: InvoiceDisputeStatus;
  active: DisputeRound | null;      // geri çekilmemiş ve yerine yenisi gelmemiş tur
  history: DisputeRound[];          // geri çekilen / yerini yeniye bırakan turlar, yeni önce
  sendableLineCount: number;        // şimdi gönderilse pakete girecek satır sayısı
  sendableAmount: number;           // o satırların talebi
  unsentLineCount: number;          // listede olup etkin turda olmayan satır; son cevabı red olan satır sayılmaz
  unsentAmount: number;             // o satırların talebi
  recalcPendingLines: number;       // gönderilecek satırlardan yeniden hesap bekleyen (recalcPending dolu); engellemez, uyarı için
  selectionDigest: string | null;   // gönderilecek kümenin özeti (itiraz metniyle aynı); satır yoksa null
  sums: DisputeSums | null;         // faturanın itiraz toplamı (itiraz.md "geçerli satır"); hiç gönderilmediyse null; GET /invoices disputeSums ile aynı
};
// satır nesnesine (GET /invoices/:id/lines items[]) eklenir:
//   dispute: { outcome: DisputeLineOutcome; recoveredAmount: number | null } | null
// fatura liste öğesine (GET /invoices items[]) eklenir:
//   disputeStatus: InvoiceDisputeStatus; disputeSums: DisputeSums | null

// GET /disputes?status=UNSENT|SENT|CLOSED&q=&carrierId=&page=&pageSize=
type DisputeListItem = {
  invoiceId: string; invoiceNo: string; invoiceDate: string | null; currency: string;
  carrier: { id: string; name: string; code: string } | null;
  status: DisputeListStatus;
  disputeId: string | null; round: number | null;
  sentOn: string | null; channel: DisputeChannel | null; sentBy: PersonRef | null;
  lineCount: number;                // UNSENT: gönderilecek satır; diğerleri: paketteki satır
  resolvedCount: number;
  sums: DisputeSums;                // UNSENT için claimedAmount = gönderilecek talep, diğerleri 0
  deadlines: { ttk?: DeadlineInfo; carrier?: DeadlineInfo };   // core disputeDeadlines ile aynı biçim
  ttkStatus: 'ON_TIME' | 'LATE' | null;
  ttkSentOn: string | null;         // etkin turun TTK'ya esas gönderim günü; UNSENT'te null
  unsentLineCount: number;          // UNSENT: = lineCount; SENT/CLOSED: gönderimden sonra listeye eklenen satır
  unsentAmount: number;             // o satırların talebi
};
type DisputeListResponse = {
  items: DisputeListItem[]; total: number; page: number; pageSize: number;
  summary: {                        // süzgeçten bağımsız, firmanın tamamı
    counts: { UNSENT: number; SENT: number; CLOSED: number; ALL: number };   // aşağıda "Gönderimden sonra listeye eklenen satırlar"
    byCurrency: (DisputeSums & { currency: string; unsentAmount: number })[];
    dueSoon: DisputeListItem[];     // unsentLineCount > 0, süresi 7 gün içinde dolan veya dolmuş, en çok 5
  };
};

// Değiştirici istekler (izin: deciship.disputes.manage). Hepsi { dispute: InvoiceDispute } döner; gönderme 201, diğerleri 200.
// POST /invoices/:id/disputes        { sentOn, channel, channelNote?, reference?, selectionDigest }
// POST /disputes/:id/resend          { version, sentOn, channel, channelNote?, reference?, selectionDigest }
//                                    selectionDigest (zorunlu): metnin (ya da kartta görünen kümenin) özeti; yoksa 400, tutmazsa 409 SELECTION_CHANGED
// POST /disputes/:id/withdraw        { version, reason }
// POST /disputes/:id/results         { version, kind, resultOn, creditNoteNo?, reason?,
//                                      lines: { disputeLineId, amount? }[] }   // RECOVERED'da amount zorunlu
// POST /dispute-results/:id/revert   { version, reason }   // version: girişin turunun sürümü (önceki turdaki girişte o turun)

// GET /dashboard yanıtına: recoveredTotal, disputePendingTotal (birincil para birimi) ve byCurrency[] öğelerine aynı iki alan.
// Merkez KPI kimlikleri: 'recovered', 'disputePending'.
```

### Sözleşme ayrıntıları

#### Yanıtlar

- `GET /invoices/:id` → `{ invoice: { ...mevcut alanlar, dispute: InvoiceDispute } }` (yani `invoice.dispute`).
- `GET /invoices/:id/lines` → `items[].dispute: { outcome, recoveredAmount } | null`: satırın geçerli itiraz satırı. Etkin turda değilse de, yerini yeniye bırakmış turda `RECOVERED` kalmış satır `{ outcome: 'RECOVERED', recoveredAmount }` gösterir (para geri alındı). Geri çekilen turun satırı sayılmaz: hiç geçerli satırı yoksa null.
- `GET /invoices` → `items[].disputeStatus`, `items[].disputeSums`.
- `GET /disputes` → `{ items, total, page, pageSize, summary }` (sayfa boyu varsayılan 25, en çok 200). Dönem: tüm zamanlar (Pano seçili ay, Merkez seçili dönem fatura tarihine göre; web İtirazlar toplamlarında "Tüm zamanlar" yazar).

#### Doğrulama kuralları

- `sentOn` ve `resultOn` gelecekte olamaz (TR saatine göre bugün en geç); `sentOn` fatura tarihinden önce olamaz; `resultOn` turun `sentOn`'undan önce olamaz.
- `channel = OTHER` ise `channelNote` zorunlu (en çok 500 karakter); `reference` en çok 200 karakter.
- `creditNoteNo` RECOVERED'da zorunlu (en çok 64 karakter). Nedenler en çok 1000 karakter.
- RECOVERED'da satır `amount` zorunlu ve > 0; `amount` en çok iki ondalık (1,005 yuvarlanmaz, 400).
- Gönderilebilir satır: `VERIFIED`, durumu `DIFF`, talebi > 0 (`buildDisputeText` ile aynı talep), geçerli sonucu `RECOVERED` olmayan.

#### Hata kodları

- 400:
  - `VALIDATION` (`details[].path` alan adı): `sentOn` fatura tarihinden önce, `channel = OTHER` iken `channelNote` boş, sonuç satırı bu turda değil ya da iki kez yazılmış, RECOVERED'da `amount` yok ya da ≤ 0, `amount` ikiden çok ondalıklı, `selectionDigest` yok.
  - `NO_SENDABLE_LINES`, `AMOUNT_EXCEEDS_CLAIM`, `REASON_REQUIRED`, `CREDIT_NOTE_REQUIRED`, `SENT_ON_IN_FUTURE`, `RESULT_ON_IN_FUTURE` (`resultOn` gelecekte), `RESULT_ON_BEFORE_SENT` (`details[].path = resultOn`).
- 409:
  - `DISPUTE_ACTIVE`: etkin tur varken gönderme. Geri çekilmiş turdan sonra yeniden `POST /invoices/:id/disputes` yeni tur açar (tur no artar).
  - `STALE`: eski `version`; ya da etkin olmayan (geri çekilmiş ya da yerini yeniye bırakmış) turda sonuç girme, geri çekme, yeniden gönderme (ekran yenilenmeli). Sonuç geri alma geri çekilmiş turda `STALE`; yerini yeniye bırakmış turda itiraz.md "Sonuç geri alma" kuralıyla serbest.
  - `SELECTION_CHANGED` (gönderme, yeniden gönderme), `RESULT_LINES_RESENT` (önceki turdaki girişin satırı yeni turda), `LINE_NOT_PENDING`, `HAS_RECOVERED_RESULTS`.
  - `LINE_IN_DISPUTE`: etkin turdaki satırda karar, takip no ve ölçüm eşleşmesi değiştirilemez, satır seçilerek yeniden hesaplanamaz (`PATCH /invoice-lines/:id` ve `recalculate` `lineIds`; itiraz.md "Gönderilmiş itirazda hesap kilidi"); not ve "Kontrol ettim" değişir.
  - `INVOICE_HAS_DISPUTE`: silmede, `PATCH /invoices/:id` hesap alanlarında, `recalculate` `basis: 'tariff' | 'rules'` ya da `patch` ile.
  - `LINE_CHANGED`: `PATCH /invoice-lines/:id` `expectedDecision` tutmadı.
- 404: başka firmanın ya da olmayan kayıt (kayıt gövdeden önce aranır; başka firmanın kimliği her gövdeyle 404).

#### Gönderimden sonra listeye eklenen satırlar

- Etkin turu olan faturada "İtiraz listesinde", talebi > 0, geçerli sonucu `RECOVERED` olmayan ve etkin turda olmayan satırlar "gönderilmemiş"tir (`unsentLineCount/unsentAmount`). Fatura durumu değişmez (SENT/CLOSED etkin tura göre); yeniden gönderme bunları da pakete alır.
- `GET /disputes` sayımları:
  - `summary.counts.SENT/CLOSED` etkin turu olan faturaları böler.
  - `counts.UNSENT` gönderilecek satırı olan faturalardır (hiç gönderilmemiş + gönderimden sonra satır eklenmiş); ikinci grup SENT/CLOSED içinde de sayılır, sayıların toplamı fatura sayısını aşabilir. "Tümü" için `counts.ALL` (listedeki fatura sayısı, süzgeçsiz) kullanılır.
  - `status=UNSENT` süzgeci `unsentLineCount > 0` olanları verir (öğenin `status`'u SENT/CLOSED olabilir).
  - `byCurrency[].unsentAmount` hepsinin `unsentAmount` toplamı; diğer alanlar SENT+CLOSED faturaların geçerli satır toplamı; firma para birimi önce.
- Mutabakat (test: `disputes.test.ts`): Pano "İtiraz listesinde" (`verifiedTotal`) = geri alınan + eksik kalan + reddedilen + bekleyen + gönderilmemiş (aynı fatura kümesinde, kuruşu kuruşuna).

#### Sıra, arama ve süresi yaklaşanlar (`GET /disputes`)

- Sıra: önce `unsentLineCount > 0` olanlar (süresi en yakın önce, süresi geçenler sonra), sonra diğerleri (SENT ve CLOSED birlikte) `sentOn` yeniden eskiye.
- `q`: fatura no ya da taşıyıcı adı içinde, büyük/küçük harf duyarsız.
- Esas süre = açık olan ilk süre (TTK, sonra taşıyıcı), hepsi geçtiyse sonuncusu.
- `dueSoon`: `unsentLineCount > 0` ve esas süre `daysLeft ≤ 7`; sıra: dolmamışlar kalan güne göre, sonra dolmuşlar (en yeni dolan önce); en çok 5.

#### Merkez ve Pano

- Pano `recoveredTotal`, `disputePendingTotal` (üst düzey ve `byCurrency[]`).
- Merkez Genel Bakış ve Analiz KPI'ları `recovered`, `disputePending` (yalnız `prices.view` ile; bağlantı `/deciship/disputes`, bekleyen için `?status=SENT`).
- Veri setleri: `invoices` sütunları `dispute` (İşlendi / İtiraz gönderildi / Kapandı), `sentOn`, `recovered` (para), süzgeç `filter.dispute=NONE|SENT|CLOSED`; `invoice-lines` sütunları `disputeOutcome`, `recovered` (para).

#### Para anahtarları

- `prices.view` yoksa silinir (app.ts `stripMoney`): `claimedAmount`, `recoveredAmount`, `rejectedAmount`, `pendingAmount`, `shortfallAmount`, `sendableAmount`, `unsentAmount`, `amount`, `recoveredTotal`, `disputePendingTotal`.
- Kalır: durumlar, sayılar, tarihler, `creditNoteNo`, `version`, kişiler, `selectionDigest`.

#### Web

Web (`apps/web`) bu sözleşmeye göre yazıldı; MSW mock'u (`apps/web/src/mocks/disputes.ts`) aynı kuralları uygular (yanıt `{ dispute }`, gönderme 201, `RESULT_ON_IN_FUTURE`, `supersededAt`, `sums`, geçerli satır kuralı, sıra, esas süre, TTK zinciri). Web'e özgü:

- Değiştirici yanıtı `{ dispute }` dışında çıplak gelse de okunur (zarar yok).
- Satırın kararı arayüzde yalnız etkin turdaki satırda kilitli gösterilir (`invoice.dispute.active.lines`); satırdaki `dispute` yalnız sonuç etiketi için kullanılır.
- Web hata durumuna değil koda bakar. `STALE`, `DISPUTE_ACTIVE`, `LINE_NOT_PENDING`, `HAS_RECOVERED_RESULTS`, `LINE_IN_DISPUTE` sonrası faturayı yeniden okur. `INVOICE_HAS_DISPUTE` silmede, fatura düzenlemede (taşıyıcı, tarih, tarife, para birimi; düzenleme penceresi bu alanları kilitli gösterir) ve yeniden hesapta kendi cümlesiyle söylenir.
- Sade arayüz kararıyla web `carrierId` göndermiyor, `pageSize=25` istiyor.
- İtirazlar listesinin "Süre" sütunu tek satırdır: gönderilmemişte esas süre, gönderilmişte TTK varsa TTK'ya göre zamanında mı.
