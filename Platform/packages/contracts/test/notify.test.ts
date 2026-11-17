import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNoticeText,
  defangLinkText,
  DEV_PRODUCT_NOTIFY_SECRET,
  foldLinkText,
  isLinkLikeName,
  isNoticeActionPath,
  isNoticePlainText,
  isValidNotifySecret,
  NOTICE_DEDUPE_KEY,
  NOTICE_LIMITS,
  NOTICE_RESEND_AFTER_MINUTES,
  NOTIFY_PATH,
  NOTIFY_SECRET_MIN_LENGTH,
  PRODUCT_NOTICE_STATUSES,
  SUPPORT_EMAIL,
  supportMailto,
} from '../src/index.ts';

test('bildirim ucu iç yoldur ve gelistirme anahtarı en kısa uzunluğu karşılar', () => {
  assert.equal(NOTIFY_PATH, '/api/account/internal/notify');
  assert.match(NOTIFY_PATH, /(^|\/)internal(\/|$)/);
  assert.ok(DEV_PRODUCT_NOTIFY_SECRET.length >= NOTIFY_SECRET_MIN_LENGTH);
  assert.equal(NOTIFY_SECRET_MIN_LENGTH, 32);
  assert.doesNotMatch(DEV_PRODUCT_NOTIFY_SECRET, /[,=\s]/);
});

test('NOTICE_LIMITS plan değerleri', () => {
  assert.deepEqual(
    { ...NOTICE_LIMITS },
    { dedupeKey: 120, subject: 120, linesMin: 1, linesMax: 10, line: 300, actionLabel: 40, actionPath: 200, footer: 200, bodyBytes: 16384, perOrgPerDay: 30, windowHours: 24 },
  );
  assert.deepEqual([...PRODUCT_NOTICE_STATUSES], ['queued', 'duplicate', 'no_recipients', 'limited', 'disabled']);
  // Yarım kalmış gönderimin yeniden denenme eşiği (Y129): postaların bitmesine yetecek kadar uzun, saatlik turdan kısa.
  assert.equal(NOTICE_RESEND_AFTER_MINUTES, 10);
});

test('tekrar anahtarı', () => {
  for (const ok of ['ttk3:0192f0c1-aaaa-7bbb-8ccc-0123456789ab', 'ttk1:x', 'a.b_c-d', 'A'.repeat(120)]) assert.ok(NOTICE_DEDUPE_KEY.test(ok), ok);
  for (const bad of ['', 'a'.repeat(121), 'boşluk var', 'a/b', 'a\nb', 'ç']) assert.ok(!NOTICE_DEDUPE_KEY.test(bad), bad);
});

test('eylem yolu yalnız o aracın sayfasına gider', () => {
  for (const ok of ['/deciship/invoices/abc', '/deciship/invoices?status=open&q=12', '/deciship/invoices?status=TO_DISPUTE']) assert.ok(isNoticeActionPath('deciship', ok), ok);
  const bad = [
    '/deciship', // önek eğik çizgiyle biter
    '/decishipx/a',
    '/orderloom/a', // başka araç
    'https://evil.example/deciship/',
    '//evil.example/deciship/',
    '/deciship//evil.example',
    '/deciship/../account/security',
    '/deciship/a b',
    '/deciship/<script>',
    '/deciship/a#b',
    '/deciship/a%2e%2e',
    // nokta yok: alan adına ya da dosyaya benzeyen yol kurulamaz
    '/deciship/x.y',
    '/deciship/evil.example',
    `/deciship/${'a'.repeat(200)}`,
  ];
  for (const p of bad) assert.ok(!isNoticeActionPath('deciship', p), p);
});

test('üretim bildirim anahtarı: 32..512 görünür ASCII, geliştirme anahtarı değil', () => {
  for (const ok of ['a'.repeat(32), 'a'.repeat(512), `${'x'.repeat(30)}!~`, 'Z9+/=_-.'.repeat(4)]) assert.ok(isValidNotifySecret(ok), ok);
  const bad = [
    '',
    'a'.repeat(31),
    'a'.repeat(513),
    DEV_PRODUCT_NOTIFY_SECRET,
    `${'a'.repeat(31)} `, // boşluk
    `${'a'.repeat(32)}\n`,
    `${'a'.repeat(31)}ç`, // ASCII dışı
    `${'a'.repeat(31)}\u007f`,
  ];
  for (const b of bad) assert.ok(!isValidNotifySecret(b), JSON.stringify(b));
});

test('bildirim metni: ortak doğrulayıcı ve temizleyici', () => {
  const CF = String.fromCodePoint(0x202e); // sağdan sola yön karakteri
  const ZW = String.fromCodePoint(0x200b); // sıfır genişlikli boşluk
  for (const ok of ['Aras Kargo F123', '  kırpılır  ', 'a.b', '<b>kaçışı Hesap yapar</b>']) assert.ok(isNoticePlainText(ok, 120), ok);
  for (const bad of ['', '   ', 'a\nb', 'a\tb', `a${CF}b`, `a${ZW}b`, 'http://x', 'HTTPS:x', 'www.x', 'a ://b', 'x'.repeat(121)]) {
    assert.ok(!isNoticePlainText(bad, 120), JSON.stringify(bad));
  }
  // temizleyici: denetim boşluk olur, biçim karakteri silinir, boşluk tekleşir
  assert.equal(cleanNoticeText(`  Aras${CF}\r\nKargo${ZW}  \u0000X `, 60), 'Aras Kargo X');
  assert.equal(cleanNoticeText(`${CF}${ZW}`, 60), '');
  // kesme: sınırı aşmaz, sonu U+2026, vekil çifti bölünmez
  assert.equal(cleanNoticeText('a'.repeat(100), 10), `${'a'.repeat(9)}${String.fromCodePoint(0x2026)}`);
  const cutEmoji = cleanNoticeText(`abcdefgh${String.fromCodePoint(0x1f4e6)}xyz`, 10);
  assert.ok(cutEmoji.length <= 10);
  assert.ok(isNoticePlainText(cutEmoji, 10), cutEmoji);
  // bağlantı biçimini silmez (çağıran genel metinle değiştirir); temizlenmiş her kısa metin kurala uyar
  assert.equal(cleanNoticeText('www.kotu.example', 60), 'www.kotu.example');
  for (const raw of [`F${CF}1`, 'F\u00001', `Kargo${String.fromCodePoint(0x2028)}A`, 'x\ud800y']) {
    assert.ok(isNoticePlainText(cleanNoticeText(raw, 60), 60), JSON.stringify(raw));
  }
});

/** ASCII metnin tam genişlik karşılığı (U+FF01..U+FF5E); kaynakta özel karakter tutulmaz. */
const fullWidth = (s: string) => [...s].map((c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)).join('');
const IDEO_DOT = String.fromCodePoint(0x3002);

test('ad kuralı (Y36): tam genişlik ve ideografik nokta da bağlantı sayılır; çıplak alan adı ve gerçek firma adları serbest', () => {
  assert.equal(fullWidth('www.'), '\uff57\uff57\uff57\uff0e');
  for (const bad of ['Firma http://x.com', 'Git www.x.com', 'a://b', fullWidth('www.') + 'kotu', `Firma ${fullWidth('https:')}kotu`, `a${fullWidth('://')}b`, `www${IDEO_DOT}kotu`, `WWW${String.fromCodePoint(0xff61)}x`]) {
    assert.ok(isLinkLikeName(bad), JSON.stringify(bad));
  }
  for (const ok of ['Örnek A.Ş.', '3M', 'Kargo.com Lojistik', 'firma.com', 'Ali Yılmaz', 'Örnek San.Tic.Ltd.Şti.', 'E.ON', 'Www Yapı', 'HTTP Kargo']) {
    assert.ok(!isLinkLikeName(ok), ok);
  }
  assert.equal(foldLinkText(`${fullWidth('Kargo.com')}${IDEO_DOT}tr`), 'Kargo.com.tr');
});

test('postada ad bağlantı olmaktan çıkar (defangLinkText)', () => {
  assert.equal(defangLinkText('Kargo.com Lojistik'), 'Kargo. com Lojistik');
  assert.equal(defangLinkText('ornek.com.tr'), 'ornek. com. tr');
  assert.equal(defangLinkText(`${fullWidth('kotu.com')}`), 'kotu. com');
  assert.equal(defangLinkText(`kotu${IDEO_DOT}com`), 'kotu. com');
  assert.equal(defangLinkText('ali@kotu.example'), 'ali@kotu. example');
  assert.equal(defangLinkText('xn--rnek-zoa.xn--p1ai'), 'xn--rnek-zoa. xn--p1ai');
  // Kuraldan önce yazılmış adlar
  assert.equal(defangLinkText('Git www.x.com'), 'Git www. x. com');
  assert.equal(defangLinkText('http://kotu'), 'http: //kotu');
  // Gerçek adlar aynen kalır: Türkçe kısaltma, tek harf, rakam
  for (const same of ['Örnek A.Ş.', '3M', 'Ltd.Şti.', 'J.P. Ticaret', 'Sürüm 2.0', 'Ayşe', '']) assert.equal(defangLinkText(same), same);
  // Bilinçli yan etki: ASCII kısaltma alan adına benzer, noktadan sonra boşluk girer (yalnız postada)
  assert.equal(defangLinkText('Ltd.Sti.'), 'Ltd. Sti.');
  assert.equal(defangLinkText('Örnek San.Tic.Ltd.Şti.'), 'Örnek San. Tic. Ltd.Şti.');
});

test('destek bağlantısı', () => {
  assert.equal(SUPPORT_EMAIL, 'destek@sellerondata.com');
  assert.equal(supportMailto(), 'mailto:destek@sellerondata.com');
  assert.equal(supportMailto(['', null, undefined, '  ']), 'mailto:destek@sellerondata.com');
  assert.equal(
    supportMailto(['Destek isteği', 'Örnek A.Ş.', null, 'Faturalar & itiraz']),
    `mailto:destek@sellerondata.com?subject=${encodeURIComponent('Destek isteği · Örnek A.Ş. · Faturalar & itiraz')}`,
  );
  assert.doesNotMatch(supportMailto(['a&cc=x@y.z']), /&cc=/);
});
