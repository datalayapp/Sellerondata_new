import { cleanTracking, normalizeTracking } from '../tracking';
import { PDF_AMOUNT_WINDOW_LINES, pdfTextHasAmount } from './pdfCheck';

/**
 * Y31: yapay zekânın PDF faturada hiç okumadığı (atladığı) satırların izi. Sayfa metnindeki takip no adayları, okunan
 * satırların takip no'larıyla karşılaştırılır; karşılığı olmayan aday "okunmamış olabilir" diye raporlanır. Fatura yine
 * yüklenir; satıra bayrak konmaz (satır faturada yok), sayı içe aktarma raporuna yazılır.
 *
 * Sahte olumluya karşı kurallar (fatura no, vergi no, telefon, IBAN, tutar, referans takip no'ya benzeyebilir):
 * - Biçim okunan satırlardan öğrenilir: adayın yazımı (rakam/harf deseni ve boşlukla bölünmüş gruplar, ör. "7948 1234
 *   5306") metinde bulunan bir okunmuş takip no'nunkiyle birebir aynı olmalı. Okunan hiçbir takip no metinde yoksa
 *   (taranmış belge, okunanlar yanlış) aday aranmaz. 8 karakterden kısa takip no'lardan biçim öğrenilmez.
 * - Aday bağımsız parçadır: nokta/virgül içeren sayılar (tutar, tarih) aday değildir; çok gruplu yazımda komşu grup aynı
 *   uzunluktaysa (IBAN, uzun hesap no) aday daha büyük bir sayının parçasıdır, alınmaz.
 * - Aynı metin satırında önünde bir etiket varsa (VKN, vergi dairesi, tel, IBAN, fatura, sipariş, referans, müşteri…)
 *   alınmaz; satırda toplam sözcüğü (toplam, ara toplam, total, yekün, devreden) varsa o satırdan aday alınmaz.
 * - Türkiye telefonu biçimindeki 12 / 11 haneli sayı ("902125551234", "05321234567") okunan takip no'lar bu biçimde
 *   değilse aday değildir.
 * - Okunan bir takip no'nun geçtiği metin satırındaki aday o satırın başka bir sütunudur (referans vb.), alınmaz. Okunan
 *   satırın tutarı henüz görünmeden (en çok 3 satır içinde) gelen aday da o satırın parçası sayılır.
 * - Adayın satırında ya da izleyen en çok 3 satırda (sonraki satır başına kadar) sıfırdan büyük, iki ondalıklı bir tutar
 *   olmalı: gönderi satırının ücreti vardır; başlık ve altbilgideki numaraların çoğu yoktur.
 * - Okunan takip no ile aynı (normalleştirilmiş), biri ötekinin en az 10 karakterlik soneki ya da `exclude` (fatura no,
 *   okunan referanslar) içindeki değer aday değildir.
 * Yakalamadığı: satır sonu olmayan metin (bütün sayfa tek satır: okunan satırla aynı satırda kalır), yazımı okunanlardan
 * farklı takip no, satır sonunda bölünmüş takip no, tutarı olmayan satır, etiketli satırdaki takip no. Bunlar sessiz kalır
 * (bugünkü davranış), yanlış uyarı üretmez.
 * Maliyet (inceleme 4): metin `PDF_MISSED_MAX_TEXT_CHARS`'tan büyükse tarama yapılmaz (`tooLarge`, raporda not); metin
 * satır satır iki geçişte okunur, parçalar bellekte tutulmaz.
 */

/** Bir adayın en çok kaç boşlukla ayrılmış gruptan oluşabileceği ("7948 1234 5306" üç grup). */
export const PDF_MISSED_MAX_GROUPS = 4;
/** Biçim öğrenilen takip no'nun en kısa hâli. */
export const PDF_MISSED_MIN_LENGTH = 8;
/** Rapora yazılan en çok aday (sayı tamdır). */
export const PDF_MISSED_MAX_LIST = 200;
/** Taranan en büyük metin (karakter, bütün sayfalar). Üstünde tarama yapılmaz: istek iş parçacığını kilitlemesin. */
export const PDF_MISSED_MAX_TEXT_CHARS = 2_000_000;
/** Sonek eşleşmesinin en kısa hâli (core `MIN_SUFFIX_MATCH` ile aynı). */
const SUFFIX_LEN = 10;

export type PdfMissedRead = { trackingNo: string; reference?: string | null };
export type PdfMissedResult = {
  /** Okunmamış olabilecek farklı takip no sayısı. */
  count: number;
  /** Metindeki sırayla, en çok `PDF_MISSED_MAX_LIST`. */
  trackings: string[];
  /** Metin tarama sınırını aştı: denetim yapılmadı (sayı 0 "aday yok" demek değildir). */
  tooLarge?: boolean;
};

/** Satırda önünde bunlardan biri varsa sayı takip no değildir (büyük harf, Türkçe harfler sadeleştirilmiş, işaretsiz). */
const LABELS = new Set([
  'VKN', 'TCKN', 'TC', 'VERGI', 'VD', 'DAIRESI', 'KIMLIK', 'TAX', 'TIN', 'VAT',
  'TEL', 'TELEFON', 'GSM', 'CEP', 'FAKS', 'FAX', 'PHONE',
  'IBAN', 'HESAP', 'ACCOUNT', 'ACCT', 'ABONE',
  'FATURA', 'INVOICE', 'ETTN', 'UUID', 'BELGE', 'SERI', 'SERIAL',
  'MERSIS', 'SICIL', 'POSTA', 'PK',
  'SIPARIS', 'ORDER', 'REF', 'REFERANS', 'REFERENCE', 'MUSTERI', 'CUSTOMER',
]);

/** Bu sözcüklerden biri geçen metin satırı toplam / devir satırıdır; aday alınmaz. */
const TOTAL_WORDS = new Set(['TOPLAM', 'ARATOPLAM', 'GENELTOPLAM', 'TOTAL', 'SUBTOTAL', 'YEKUN', 'DEVREDEN', 'DEVIR', 'NAKLI']);

/** Türkiye telefonu: 90 + alan/GSM kodu (2–5) + 9 hane, ya da 0 + 10 hane. */
const PHONE_LIKE = /^(?:90[2-5]\d{9}|0[2-5]\d{9})$/;

const TR_FOLD: Record<string, string> = { İ: 'I', I: 'I', ı: 'I', i: 'I', Ş: 'S', ş: 'S', Ğ: 'G', ğ: 'G', Ü: 'U', ü: 'U', Ö: 'O', ö: 'O', Ç: 'C', ç: 'C' };
const labelKey = (raw: string) =>
  raw
    .replace(/[İIıiŞşĞğÜüÖöÇç]/g, (c) => TR_FOLD[c] ?? c)
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

type Atom = { value: string; mask: string; groupLen: number; digits: boolean };
type Token = { raw: string; atom: Atom | null };

/** Sözcük ayraçları: boşluk ve iki nokta, noktalı virgül, dikey çizgi ("Takip:7948…"). Nokta ve virgül ayraç değil. */
const SPLIT = /[\s:;|]+/;

function atomOf(raw: string): Atom | null {
  const t = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase();
  if (!t || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(t)) return null;
  const value = t.replace(/-/g, '');
  return { value, mask: t.replace(/[0-9]/g, '9').replace(/[A-Z]/g, 'A'), groupLen: value.length, digits: /^\d+$/.test(value) };
}

function tokenize(line: string): Token[] {
  const out: Token[] = [];
  for (const raw of line.split(SPLIT)) if (raw) out.push({ raw, atom: atomOf(raw) });
  return out;
}

/** Takip no'nun karşılaştırma biçimi: harf/rakam dışı atılmış, büyük harf; FedEx 34 haneli barkodda son 12 hane. */
const keyOf = (raw: string) => normalizeTracking(raw ?? '').replace(/[^A-Z0-9]/g, '');

/**
 * Sayfa metninde geçen ama `read` satırlarında karşılığı olmayan takip no adayları (kurallar dosya başında). Saf işlev;
 * maliyet metin uzunluğuyla doğrusal.
 */
export function pdfMissedTrackings(pageTexts: readonly string[], read: readonly PdfMissedRead[], opts: { exclude?: readonly (string | null | undefined)[] } = {}): PdfMissedResult {
  const empty: PdfMissedResult = { count: 0, trackings: [] };
  const reads = new Set<string>();
  for (const r of read) {
    const k = keyOf(r.trackingNo);
    if (!k) continue;
    reads.add(k);
    const full = cleanTracking(r.trackingNo).replace(/[^A-Z0-9]/g, '');
    if (full) reads.add(full);
  }
  const longReads = [...reads].filter((r) => r.length >= PDF_MISSED_MIN_LENGTH);
  if (!longReads.length) return empty;
  const readLens = [...new Set(longReads.map((r) => r.length))];
  const maxLen = Math.max(...readLens);
  const bySuffix = new Map<string, string[]>();
  for (const r of reads) {
    if (r.length < SUFFIX_LEN) continue;
    const s = r.slice(-SUFFIX_LEN);
    const list = bySuffix.get(s);
    if (list) list.push(r);
    else bySuffix.set(s, [r]);
  }
  const excluded = new Set<string>();
  for (const e of opts.exclude ?? []) {
    const k = keyOf(e ?? '');
    if (k) excluded.add(k);
  }
  for (const r of read) {
    const k = keyOf(r.reference ?? '');
    if (k) excluded.add(k);
  }

  if (pageTexts.reduce((n, t) => n + t.length, 0) > PDF_MISSED_MAX_TEXT_CHARS) return { count: 0, trackings: [], tooLarge: true };
  const phoneReads = longReads.some((r) => PHONE_LIKE.test(r));

  // Satırlar akışla okunur: parçalar her geçişte satır başına yeniden çıkarılır, bellekte tutulmaz.
  const lines = pageTexts.join('\n').split('\n');

  // 1) Biçim: okunan takip no'ların metindeki yazımları (1–4 grup)
  const shapes = new Set<string>();
  for (const line of lines) {
    const toks = tokenize(line);
    for (let s = 0; s < toks.length; s++) {
      let value = '';
      let mask = '';
      for (let k = 0; k < PDF_MISSED_MAX_GROUPS && s + k < toks.length; k++) {
        const a = toks[s + k]!.atom;
        if (!a) break;
        value += a.value;
        mask += (k ? ' ' : '') + a.mask;
        if (value.length > maxLen) break;
        if (value.length >= PDF_MISSED_MIN_LENGTH && reads.has(value)) shapes.add(mask);
      }
    }
  }
  if (!shapes.size) return empty;

  const isRead = (v: string): boolean => {
    if (reads.has(v) || reads.has(keyOf(v))) return true;
    if (v.length < SUFFIX_LEN) return false;
    return (bySuffix.get(v.slice(-SUFFIX_LEN)) ?? []).some((r) => r.endsWith(v) || v.endsWith(r));
  };

  // Okunan bir takip no'nun (herhangi bir yazımla) geçtiği metin satırı. Yalnız adayların çevresinde sorulur.
  const readLineMemo = new Map<number, boolean>();
  const isReadLine = (i: number): boolean => {
    const memo = readLineMemo.get(i);
    if (memo != null) return memo;
    const stripped = (lines[i] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let hit = false;
    for (const L of readLens) {
      for (let p = 0; p + L <= stripped.length && !hit; p++) hit = reads.has(stripped.slice(p, p + L));
      if (hit) break;
    }
    readLineMemo.set(i, hit);
    return hit;
  };
  const amountMemo = new Map<number, boolean>();
  const hasAmount = (i: number): boolean => {
    const memo = amountMemo.get(i);
    if (memo != null) return memo;
    const v = pdfTextHasAmount(lines[i] ?? '');
    amountMemo.set(i, v);
    return v;
  };

  /** Çok gruplu adayın komşusu aynı türde ve aynı uzunlukta grupsa aday daha büyük bir sayının parçasıdır. */
  const extendsInto = (nb: Atom | null | undefined, edge: Atom) => !!nb && nb.digits === edge.digits && nb.groupLen === edge.groupLen;

  // 2) Adaylar: biçime uyan, okunmamış, etiketsiz, bağımsız parçalar (önce satır elemeleri olmadan)
  const found: { line: number; value: string }[] = [];
  lines.forEach((text, line) => {
    const toks = tokenize(text);
    const keys = toks.map((t) => labelKey(t.raw));
    if (keys.some((k) => TOTAL_WORDS.has(k))) return;
    for (let s = 0; s < toks.length; s++) {
      if (!toks[s]!.atom) continue;
      let value = '';
      let mask = '';
      let best: { k: number; value: string } | null = null;
      for (let k = 0; k < PDF_MISSED_MAX_GROUPS && s + k < toks.length; k++) {
        const a = toks[s + k]!.atom;
        if (!a) break;
        value += a.value;
        mask += (k ? ' ' : '') + a.mask;
        if (value.length > maxLen) break;
        if (shapes.has(mask)) best = { k: k + 1, value };
      }
      if (!best) continue;
      const first = toks[s]!.atom!;
      const last = toks[s + best.k - 1]!.atom!;
      const labelled = keys.slice(0, s).some((k) => LABELS.has(k));
      const partOfLonger = best.k > 1 && (extendsInto(toks[s - 1]?.atom, first) || extendsInto(toks[s + best.k]?.atom, last));
      const phone = !phoneReads && PHONE_LIKE.test(best.value);
      if (!labelled && !partOfLonger && !phone && !excluded.has(best.value) && !isRead(best.value)) found.push({ line, value: best.value });
      s += best.k - 1;
    }
  });
  if (!found.length) return empty;

  // 3) Satır elemeleri: okunan satırın parçası değil, ücreti var
  const candidateLines = new Set(found.filter((f) => !isReadLine(f.line)).map((f) => f.line));
  const rowStart = (i: number) => candidateLines.has(i) || isReadLine(i);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.value) || !candidateLines.has(f.line)) continue;
    // okunan satır yakında ve tutarı henüz görünmedi: aday o satırın bir sütunudur
    let absorbed = false;
    for (let j = f.line - 1; j >= Math.max(0, f.line - PDF_AMOUNT_WINDOW_LINES); j--) {
      if (hasAmount(j)) break;
      if (isReadLine(j)) {
        absorbed = true;
        break;
      }
      if (candidateLines.has(j)) break;
    }
    if (absorbed) continue;
    let paid = false;
    for (let j = f.line; j < lines.length && j <= f.line + PDF_AMOUNT_WINDOW_LINES; j++) {
      if (j > f.line && rowStart(j)) break;
      if (hasAmount(j)) {
        paid = true;
        break;
      }
    }
    if (!paid) continue;
    seen.add(f.value);
    out.push(f.value);
  }
  return { count: out.length, trackings: out.slice(0, PDF_MISSED_MAX_LIST) };
}
