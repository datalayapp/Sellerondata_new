/**
 * PDF ön denetimi (Mesaj 6 R2, Y59): pdfjs'e (ve pdf-lib'e) vermeden önce akışların açılmış toplamı sayılır. pdfjs akışları
 * yığın DIŞI bellekte (Uint8Array) açar; `resourceLimits` bunu saymaz: 300 KB'lık bir PDF yüzlerce MB açılabilir.
 *
 * 1. Ham deneme (sözlüğe güvenmez; ikinci inceleme beş atlatma yolu gösterdi: sözlükte "(obj)" dizesi, dolaylı
 *    `/Filter 6 0 R`, ad kaçışı `/#46lateDecode`, 8 KB'tan büyük sözlük, `stream` sözcüğünden sonra boşluk):
 *    - baytlarda geçen HER `stream` anahtar sözcüğünden sonra pdfjs gibi satır sonuna dek atlanır (`skipToNextLine`);
 *    - oradan başlayan veri zlib akışı olarak denenir: başlık geçersizse (iki bayt, pdfjs'in denetimiyle aynı) hiç
 *      açılmaz, geçerliyse akış kendi sonunda durur. Çıktı yalnız sayılır, tutulmaz; bütçe aşılınca hemen durulur.
 * 2. Zincir (Y59): akışın sözlüğü nesne başlığından (`N G obj`) pdfjs gibi sözcük sözcük okunur (kaçışlı adlar, dizgiler,
 *    dolaylı `/Filter` ve `/Length`). Süzgeç tek Flate değilse (Flate'ten önce ASCIIHex/ASCII85, Flate → Flate, LZW,
 *    RunLength, Brotli) ya da belge şifreliyse zincir sırayla açılır ve her aşamanın çıktısı toplanır (pdfjs her aşamanın
 *    tamponunu tutar). Akışın sonu: doğrulanan `/Length` (ardında `endstream`), yoksa sonraki `endstream` (pdfjs de böyle).
 *    Akış başına sayılan, iki denemenin büyüğüdür.
 * 3. Şifreli belge (Y59): Standart güvenlik, boş kullanıcı parolası (pdfjs'in parolasız açabildiği tek durum): RC4 (V1/V2,
 *    R2–R4), AESV2 (V4) ve AESV3 (V5, R5/R6). Akış önce çözülür, sonra zincir. Parolalı belgeyi pdfjs açmaz (bomba yok).
 * 4. Süre (Y59): denetim en çok `deadlineMs` sürer (varsayılan `PDF_GUARD_DEADLINE_MS`); aşılırsa `reason: 'time'` (API
 *    422 `FILE_TOO_COMPLEX`). Çok sayıda `stream` sözcüğü artık zlib nesnesi açmaz (başlık ön denetimi), süre yine sınırlı.
 *
 * Sayılmayan (bilinçli, çalışanın bellek bekçisine kalır: `FILE_WORKER_RSS_LIMIT_MB`): görüntü süzgeçleri (DCT, JPX,
 * JBIG2, CCITT; pdfjs metin okurken görüntü açmaz ama içerik akışına konmuşsa açar), tahmin edici (`/Predictor`, çıktısı
 * girdisinden büyük değil), standart dışı güvenlik işleyicisi ve sözlüğü okunamayan akışın zinciri (yalnız ham deneme).
 * Reddetme yalnız sayılan toplam sınırı aşınca: emin olunamayan türde gerçek fatura reddedilmez.
 */
import crypto from 'node:crypto';
import { createBrotliDecompress, createInflate, type Inflate, type BrotliDecompress } from 'node:zlib';

const STREAM = Buffer.from('stream', 'latin1');
const ENDSTREAM = Buffer.from('endstream', 'latin1');
const CHUNK = 16 * 1024;
/** Ön denetimin kendi süre sınırı (dosya başına süre `FILE_WORKER_TIMEOUT_MS`, varsayılan 60 sn, bunun üstündedir). */
export const PDF_GUARD_DEADLINE_MS = 15_000;

export type PdfSizeCheck = { ok: true; size: number } | { ok: false; size: number; reason: 'size' | 'time' | 'complex' };

/**
 * Ayrıştırma tavanları (güvenlik incelemesi): tek ayrıştırmada en çok `PDF_GUARD_MAX_VALUES` değer, ad/sözcük en çok
 * `MAX_TOKEN` bayt, dizgiden en çok `MAX_STRING` bayt tutulur, süzgeç zinciri en çok `MAX_FILTERS`, nesne başlığı en çok
 * `MAX_HEADERS`. Akış sözlüğünde (ya da dolaylı süzgeç / şifre / dosya sonu nesnesinde) tavan aşılırsa denetim
 * `reason: 'complex'` ile durur (API 422 `FILE_TOO_COMPLEX`): gerçek PDF'te bu nesneler birkaç düzine değerdir. Süre
 * ayrıştırıcının iç döngülerinde de denetlenir.
 */
export const PDF_GUARD_MAX_VALUES = 4096;
const MAX_TOKEN = 4096;
const MAX_STRING = 4096;
export const PDF_GUARD_MAX_FILTERS = 16;
const MAX_HEADERS = 250_000;
const MAX_TRAILERS = 64;

/** Ön denetimin kendi sınırı aşıldı (süre ya da ayrıştırma tavanı): bütün denetim durur. */
class GuardAbort extends Error {
  constructor(readonly reason: 'time' | 'complex') {
    super(`pdf guard: ${reason}`);
  }
}
/** Tek ayrıştırmanın tavanı aşıldı; çağıran adayı bırakır ya da `GuardAbort('complex')` yapar. */
class LexLimit extends Error {}
export type PdfGuardOptions = { deadlineMs?: number };

// ---------------------------------------------------------------------------------------------
// Açma (sayarak)

/** zlib başlığı (RFC 1950): pdfjs `FlateStream` aynı iki denetimi yapar; geçersizse açılmaz. */
function zlibHeaderOk(buf: Uint8Array, at: number): boolean {
  if (at + 1 >= buf.length) return false;
  const cmf = buf[at]!;
  const flg = buf[at + 1]!;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

/**
 * `input`'u `make()`'in açıcısından geçirir. Döner: açılan bayt, tüketilen girdi ve (`keep` ise) çıktı. `budget` aşılınca
 * durur. Bozuk veride o ana kadar açılan sayılır (pdfjs de orada durur ama tamponu tutar). Geri basınçla parça parça verilir.
 */
function decompress(
  make: () => Inflate | BrotliDecompress,
  input: Uint8Array,
  budget: number,
  keep: boolean,
): Promise<{ out: number; consumed: number; data: Buffer | null }> {
  return new Promise((resolve) => {
    const z = make();
    const parts: Buffer[] = [];
    let out = 0;
    let pos = 0;
    let done = false;
    const finish = (ended: boolean) => {
      if (done) return;
      done = true;
      const consumed = ended ? z.bytesWritten : 0;
      z.removeAllListeners('data');
      z.on('error', () => {});
      z.destroy();
      resolve({ out, consumed, data: keep ? Buffer.concat(parts) : null });
    };
    z.on('data', (c: Buffer) => {
      out += c.length;
      if (keep) parts.push(c);
      if (out > budget) finish(false);
    });
    z.on('end', () => finish(true));
    z.on('error', () => finish(false));
    const pump = () => {
      while (!done && pos < input.length) {
        const c = input.subarray(pos, Math.min(input.length, pos + CHUNK));
        pos += c.length;
        if (!z.write(c)) {
          z.once('drain', pump);
          return;
        }
      }
      if (!done) z.end();
    };
    pump();
  });
}

/** ASCIIHex: onaltılık haneler, boşluk ve geçersiz karakter atlanır, `>` biter (pdfjs `AsciiHexStream`). */
function asciiHex(input: Uint8Array, budget: number): Buffer {
  const out = Buffer.allocUnsafe(Math.min(budget + 1, Math.ceil(input.length / 2) + 1));
  let n = 0;
  let hi = -1;
  for (let i = 0; i < input.length && n < out.length; i++) {
    const c = input[i]!;
    if (c === 0x3e) break;
    const d = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (d < 0) continue;
    if (hi < 0) hi = d;
    else {
      out[n++] = (hi << 4) | d;
      hi = -1;
    }
  }
  if (hi >= 0 && n < out.length) out[n++] = hi << 4;
  return out.subarray(0, n);
}

/** ASCII85: `z` dört sıfır, `~` biter, eksik son grup kısaltılır (pdfjs `Ascii85Stream`). */
function ascii85(input: Uint8Array, budget: number): Buffer {
  const cap = Math.min(budget + 1, input.length * 4 + 4);
  const parts: Buffer[] = [];
  let cur = Buffer.allocUnsafe(Math.min(cap, 1 << 20));
  let n = 0;
  let total = 0;
  const put = (b: number) => {
    if (n === cur.length) {
      parts.push(cur);
      cur = Buffer.allocUnsafe(Math.min(cap - total, 1 << 20) || 1);
      n = 0;
    }
    cur[n++] = b;
    total++;
  };
  const group: number[] = [];
  for (let i = 0; i < input.length && total < cap; i++) {
    const c = input[i]!;
    if (c === 0x7e) break;
    if (c === 0x7a && group.length === 0) {
      for (let k = 0; k < 4 && total < cap; k++) put(0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      for (let k = 3; k >= 0 && total < cap; k--) put((v >>> (k * 8)) & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 1 && total < cap) {
    const len = group.length - 1;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    for (let k = 3; k >= 4 - len && total < cap; k--) put((v >>> (k * 8)) & 0xff);
  }
  parts.push(cur.subarray(0, n));
  return Buffer.concat(parts);
}

/** RunLength: 0–127 sonraki n+1 bayt, 129–255 sonraki bayt 257−n kez, 128 biter. */
function runLength(input: Uint8Array, budget: number, keep: boolean): Buffer | number {
  const parts: Buffer[] = [];
  let total = 0;
  let i = 0;
  while (i < input.length && total <= budget) {
    const len = input[i++]!;
    if (len === 128) break;
    if (len < 128) {
      const piece = Buffer.from(input.subarray(i, Math.min(input.length, i + len + 1)));
      i += len + 1;
      if (keep) parts.push(piece);
      total += piece.length;
    } else {
      if (i >= input.length) break;
      const count = 257 - len;
      if (keep) parts.push(Buffer.alloc(count, input[i]!));
      i++;
      total += count;
    }
  }
  return keep ? Buffer.concat(parts) : total;
}

/** LZW (PDF, 9–12 bit, 256 temizle, 257 son, `earlyChange` varsayılan 1; pdfjs `LZWStream`). */
function lzw(input: Uint8Array, budget: number, earlyChange: number, keep: boolean): Buffer | number {
  const parts: Buffer[] = [];
  let total = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let width = 9;
  let prev = -1;
  let bitBuf = 0;
  let bits = 0;
  let pos = 0;
  const scratch = new Uint8Array(4096);
  for (;;) {
    while (bits < width && pos < input.length) {
      bitBuf = ((bitBuf << 8) | input[pos++]!) >>> 0;
      bits += 8;
    }
    if (bits < width) break;
    const code = (bitBuf >>> (bits - width)) & ((1 << width) - 1);
    bits -= width;
    bitBuf &= (1 << bits) - 1;
    if (code === 256) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (code === 257) break;
    let entry: number;
    if (code < next) entry = code;
    else if (code === next && prev >= 0)
      entry = prev; // KwKwK: önceki + önceki'nin ilk baytı
    else break; // geçersiz kod: pdfjs de orada durur
    // çıktı: girişin baytları (sondan başa)
    let len = length[entry]!;
    let e = entry;
    for (let k = len - 1; k >= 0; k--) {
      scratch[k] = suffix[e]!;
      e = prefix[e]!;
    }
    const first = scratch[0]!;
    if (code === next) {
      scratch[len] = first;
      len++;
    }
    if (keep) parts.push(Buffer.from(scratch.subarray(0, len)));
    total += len;
    if (total > budget) break;
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      length[next] = length[prev]! + 1;
      next++;
    }
    prev = code;
    if (next + earlyChange >= 1 << width && width < 12) width++;
  }
  return keep ? Buffer.concat(parts) : total;
}

// ---------------------------------------------------------------------------------------------
// Sözcük okuyucu (pdfjs `Lexer`/`Parser`'ın yeterli kısmı)

type PdfName = { name: string };
type PdfRef = { ref: [number, number] };
type PdfStr = { str: Buffer };
type PdfValue = number | boolean | null | PdfName | PdfRef | PdfStr | PdfValue[] | Map<string, PdfValue> | { kw: string };

const isWs = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isName = (v: unknown): v is PdfName => typeof v === 'object' && v !== null && 'name' in v;
const isRef = (v: unknown): v is PdfRef => typeof v === 'object' && v !== null && 'ref' in v;
const isStr = (v: unknown): v is PdfStr => typeof v === 'object' && v !== null && 'str' in v;

class Lexer {
  private values = 0;
  constructor(
    readonly buf: Uint8Array,
    public pos: number,
    readonly end: number,
    readonly deadline: number,
  ) {}

  skipWs() {
    while (this.pos < this.end) {
      const c = this.buf[this.pos]!;
      if (isWs(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  private regular(): string {
    const s = this.pos;
    while (this.pos < this.end && !isWs(this.buf[this.pos]!) && !isDelim(this.buf[this.pos]!)) this.pos++;
    if (this.pos - s > MAX_TOKEN) throw new LexLimit();
    return Buffer.from(this.buf.subarray(s, this.pos)).toString('latin1');
  }

  /** Bir değer; okunamazsa hata. `depth` iç içe sözlük/dizi sınırı. */
  value(depth = 0): PdfValue {
    if (depth > 64) throw new LexLimit();
    if (++this.values > PDF_GUARD_MAX_VALUES) throw new LexLimit();
    if ((this.values & 255) === 0 && Date.now() > this.deadline) throw new GuardAbort('time');
    this.skipWs();
    if (this.pos >= this.end) throw new Error('pdf eof');
    const c = this.buf[this.pos]!;
    if (c === 0x3c && this.buf[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const map = new Map<string, PdfValue>();
      for (;;) {
        this.skipWs();
        if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return map;
        }
        const key = this.value(depth + 1);
        if (!isName(key)) throw new Error('pdf dict key');
        map.set(key.name, this.value(depth + 1));
      }
    }
    if (c === 0x3c) {
      const s = ++this.pos;
      while (this.pos < this.end && this.buf[this.pos] !== 0x3e) this.pos++;
      const hex = Buffer.from(this.buf.subarray(s, Math.min(this.pos, s + 2 * MAX_STRING)))
        .toString('latin1')
        .replace(/[^0-9a-fA-F]/g, '');
      this.pos++;
      return { str: Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex') };
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (this.buf[this.pos] === 0x5d) {
          this.pos++;
          return arr;
        }
        arr.push(this.value(depth + 1));
      }
    }
    if (c === 0x28) return { str: this.literal() };
    if (c === 0x2f) {
      this.pos++;
      // ad kaçışı: #xx
      return { name: this.regular().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    const word = this.regular();
    if (!word) throw new Error('pdf token');
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // "N G R" dolaylı başvuru
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const g = this.regular();
        if (/^\d+$/.test(g)) {
          this.skipWs();
          if (this.buf[this.pos] === 0x52 && (this.pos + 1 >= this.end || isWs(this.buf[this.pos + 1]!) || isDelim(this.buf[this.pos + 1]!))) {
            this.pos++;
            return { ref: [n, Number(g)] };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { kw: word };
  }

  private literal(): Buffer {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = this.buf[this.pos++]!;
      if (c === 0x5c) {
        const d = this.buf[this.pos++]!;
        const esc: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        // dizgiden en çok MAX_STRING bayt tutulur (gerekenler: /O, /U, /ID; kısa)
        const keep = out.length < MAX_STRING;
        if (d in esc) keep && out.push(esc[d]!);
        else if (d >= 0x30 && d <= 0x37) {
          let v = d - 0x30;
          for (let k = 0; k < 2 && this.buf[this.pos]! >= 0x30 && this.buf[this.pos]! <= 0x37; k++) v = v * 8 + (this.buf[this.pos++]! - 0x30);
          if (keep) out.push(v & 0xff);
        } else if (d === 0x0d) {
          if (this.buf[this.pos] === 0x0a) this.pos++;
        } else if (d !== 0x0a && keep) out.push(d);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      if (out.length < MAX_STRING) out.push(c);
    }
    return Buffer.from(out);
  }
}

// ---------------------------------------------------------------------------------------------
// Belge: nesne başlıkları, başvuru çözme, akış sözlüğü

type Header = { num: number; gen: number; body: number };

/** Nesne başlığı "N G obj". PDF boşluğu NUL dahildir; `\s` değil (0xA0 PDF boşluğu değildir). */
const PDF_WS = `[${String.fromCharCode(0)}\\t\\n\\f\\r ]+`;
const HEADER_RE = new RegExp(`(\\d{1,10})${PDF_WS}(\\d{1,5})${PDF_WS}obj(?![A-Za-z0-9])`, 'g');

class PdfIndex {
  readonly headers: Header[] = [];
  private readonly byNum = new Map<number, Header[]>();
  private readonly resolving = new Set<string>();

  constructor(
    readonly buf: Uint8Array,
    readonly deadline: number,
  ) {
    const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1');
    for (const m of text.matchAll(HEADER_RE)) {
      if (this.headers.length >= MAX_HEADERS) throw new GuardAbort('complex');
      if ((this.headers.length & 4095) === 0 && Date.now() > deadline) throw new GuardAbort('time');
      const h = { num: Number(m[1]), gen: Number(m[2]), body: m.index + m[0].length };
      this.headers.push(h);
      const list = this.byNum.get(h.num) ?? [];
      list.push(h);
      this.byNum.set(h.num, list);
    }
  }

  /** Dolaylı başvuruyu çözer (son tanım geçerli: artımlı güncelleme). Nesne akışındaysa ya da okunamazsa `undefined`. */
  resolve(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (!isRef(v)) return v;
    const key = `${v.ref[0]} ${v.ref[1]}`;
    if (depth > 8 || this.resolving.has(key)) return undefined;
    const h = (this.byNum.get(v.ref[0]) ?? []).filter((x) => x.gen === v.ref[1]).at(-1);
    if (!h) return undefined;
    this.resolving.add(key);
    try {
      return this.resolve(this.lexer(h.body, this.buf.length).value(), depth + 1);
    } catch (e) {
      // dolaylı süzgeç / uzunluk / şifre nesnesi tavanı aştı: gerçek PDF'te olmaz
      if (e instanceof LexLimit) throw new GuardAbort('complex');
      if (e instanceof GuardAbort) throw e;
      return undefined;
    } finally {
      this.resolving.delete(key);
    }
  }

  lexer(pos: number, end: number): Lexer {
    return new Lexer(this.buf, pos, end, this.deadline);
  }

  /** `stream` sözcüğünün (konum `at`) sözlüğü ve nesne numarası: en yakın üç başlıktan sözlüğü tam `at`'ta biten. */
  streamAt(at: number): { header: Header; dict: Map<string, PdfValue> } | null {
    let lo = 0;
    let hi = this.headers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.headers[mid]!.body < at) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1, tries = 0; i >= 0 && tries < 3; i--, tries++) {
      const h = this.headers[i]!;
      try {
        const lx = this.lexer(h.body, at);
        const dict = lx.value();
        lx.skipWs();
        if (dict instanceof Map && lx.pos === at) return { header: h, dict };
      } catch (e) {
        if (e instanceof GuardAbort) throw e;
        // en yakın başlık (akışın kendi sözlüğü) tavanı aştı: dev sözlük/dizi. Daha geridekiler başka nesnedir: aday bırakılır.
        if (e instanceof LexLimit && tries === 0) throw new GuardAbort('complex');
      }
    }
    return null;
  }

  /**
   * Son dosya sonu sözlükleri (`trailer` ve `/Type /XRef` akışları), konum sırasıyla. Sondan başa en çok `MAX_TRAILERS`
   * aday (geçerli olan sondakidir; metindeki "trailer" sözcükleri süreyi uzatmasın).
   */
  trailers(): Map<string, PdfValue>[] {
    const out: { at: number; dict: Map<string, PdfValue> }[] = [];
    const buf = Buffer.from(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    let n = 0;
    for (
      let at = buf.lastIndexOf('trailer', buf.length, 'latin1');
      at >= 0 && n < MAX_TRAILERS;
      at = at > 0 ? buf.lastIndexOf('trailer', at - 1, 'latin1') : -1, n++
    ) {
      try {
        const d = this.lexer(at + 7, this.buf.length).value();
        if (d instanceof Map) out.push({ at, dict: d });
      } catch (e) {
        if (e instanceof GuardAbort) throw e;
        // okunamayan ya da tavanı aşan "trailer" sözcüğü (metinde geçebilir): aday değil
      }
    }
    n = 0;
    for (
      let at = buf.lastIndexOf('/XRef', buf.length, 'latin1');
      at >= 0 && n < MAX_TRAILERS;
      at = at > 0 ? buf.lastIndexOf('/XRef', at - 1, 'latin1') : -1, n++
    ) {
      const s = buf.indexOf(STREAM, at);
      if (s < 0) continue;
      const r = this.streamAt(s);
      const type = r?.dict.get('Type');
      if (r && isName(type) && type.name === 'XRef') out.push({ at, dict: r.dict });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.dict);
  }
}

// ---------------------------------------------------------------------------------------------
// Şifre çözme (Standart güvenlik işleyicisi, boş kullanıcı parolası)

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
type Crypt = { method: 'rc4' | 'aes128' | 'aes256' | 'none'; key: Buffer; perObject: boolean };

function rc4(key: Buffer, data: Uint8Array): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.allocUnsafe(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}

/** R6 parola özeti (ISO 32000-2, Algoritma 2.B), boş parola ve kullanıcı anahtarı için. */
function hash2B(salt: Buffer): Buffer {
  let k = crypto.createHash('sha256').update(salt).digest();
  for (let i = 0; ; i++) {
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => k));
    const c = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    const e = Buffer.concat([c.update(k1), c.final()]);
    let mod = 0;
    for (let b = 0; b < 16; b++) mod += e[b]!;
    k = crypto
      .createHash(['sha256', 'sha384', 'sha512'][mod % 3]!)
      .update(e)
      .digest();
    if (i >= 63 && e[e.length - 1]! <= i + 1 - 32) break;
  }
  return k.subarray(0, 32);
}

const strOf = (v: PdfValue | undefined): Buffer | null => (isStr(v) ? v.str : null);
const numOf = (v: PdfValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Belgenin şifresi: yok (`null`), kurulamadı (`'unknown'`) ya da çözücü. */
function cryptOf(index: PdfIndex): Crypt | null | 'unknown' {
  const trailers = index.trailers();
  const withEnc = trailers.filter((t) => t.has('Encrypt')).at(-1);
  if (!withEnc) return null;
  try {
    const enc = index.resolve(withEnc.get('Encrypt'));
    if (!(enc instanceof Map)) return 'unknown';
    const filter = enc.get('Filter');
    if (!isName(filter) || filter.name !== 'Standard') return 'unknown';
    const v = numOf(enc.get('V')) ?? 0;
    const r = numOf(enc.get('R')) ?? 0;
    const o = strOf(index.resolve(enc.get('O')));
    const u = strOf(index.resolve(enc.get('U')));
    if (!o || !u) return 'unknown';
    // akışların süzgeci (V4/V5): /StmF → /CF içindeki /CFM
    let cfm = v >= 4 ? 'Identity' : 'V2';
    if (v >= 4) {
      const stmf = enc.get('StmF');
      const name = isName(stmf) ? stmf.name : 'Identity';
      if (name !== 'Identity') {
        const cf = index.resolve(enc.get('CF'));
        const entry = cf instanceof Map ? index.resolve(cf.get(name)) : undefined;
        const m = entry instanceof Map ? entry.get('CFM') : undefined;
        cfm = isName(m) ? m.name : 'None';
      }
    }
    if (cfm === 'Identity' || cfm === 'None') return { method: 'none', key: Buffer.alloc(0), perObject: false };
    if (v >= 5) {
      // AESV3: dosya anahtarı /UE'den (boş parola, kullanıcı anahtar tuzu U[40..48])
      const ue = strOf(index.resolve(enc.get('UE')));
      if (!ue || u.length < 48) return 'unknown';
      const salt = u.subarray(40, 48);
      const h = r >= 6 ? hash2B(salt) : crypto.createHash('sha256').update(salt).digest();
      const d = crypto.createDecipheriv('aes-256-cbc', h, Buffer.alloc(16));
      d.setAutoPadding(false);
      return { method: 'aes256', key: Buffer.concat([d.update(ue.subarray(0, 32)), d.final()]), perObject: false };
    }
    // V1/V2/V4 (Algoritma 2): MD5(pad(parola) + O + P + ID[0] (+ ffffffff))
    const ids = index.resolve(
      trailers
        .filter((t) => t.has('ID'))
        .at(-1)
        ?.get('ID'),
    );
    const id0 = Array.isArray(ids) ? (strOf(index.resolve(ids[0])) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const p = Buffer.alloc(4);
    p.writeInt32LE((numOf(enc.get('P')) ?? 0) | 0);
    const lenBits = v === 1 ? 40 : (numOf(enc.get('Length')) ?? 40);
    const n = Math.min(16, Math.max(5, Math.floor(lenBits / 8)));
    const meta = enc.get('EncryptMetadata');
    const md = crypto.createHash('md5').update(PAD).update(o.subarray(0, 32)).update(p).update(id0);
    if (r >= 4 && meta === false) md.update(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    let key = md.digest();
    if (r >= 3) for (let i = 0; i < 50; i++) key = crypto.createHash('md5').update(key.subarray(0, n)).digest();
    return { method: cfm === 'AESV2' ? 'aes128' : 'rc4', key: key.subarray(0, n), perObject: true };
  } catch (e) {
    if (e instanceof GuardAbort) throw e;
    return 'unknown';
  }
}

/** Akış verisini çözer (pdfjs `CipherTransform`); AES'te ilk 16 bayt IV, sondaki dolgu atılır. */
function decrypt(c: Crypt, h: Header, data: Uint8Array): Buffer {
  if (c.method === 'none') return Buffer.from(data);
  let key = c.key;
  if (c.perObject) {
    const ext = Buffer.from([h.num & 0xff, (h.num >> 8) & 0xff, (h.num >> 16) & 0xff, h.gen & 0xff, (h.gen >> 8) & 0xff]);
    const md = crypto.createHash('md5').update(c.key).update(ext);
    if (c.method === 'aes128') md.update(Buffer.from('sAlT', 'latin1'));
    key = md.digest().subarray(0, Math.min(16, c.key.length + 5));
  }
  if (c.method === 'rc4') return rc4(key, data);
  if (data.length < 32) return Buffer.alloc(0);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  const d = crypto.createDecipheriv(c.method === 'aes128' ? 'aes-128-cbc' : 'aes-256-cbc', key, data.subarray(0, 16));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(body), d.final()]);
  const pad = out[out.length - 1] ?? 0;
  return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

// ---------------------------------------------------------------------------------------------
// Zincir

const FILTERS: Record<string, string> = {
  FlateDecode: 'flate',
  Fl: 'flate',
  LZWDecode: 'lzw',
  LZW: 'lzw',
  ASCII85Decode: 'a85',
  A85: 'a85',
  ASCIIHexDecode: 'ahx',
  AHx: 'ahx',
  RunLengthDecode: 'rl',
  RL: 'rl',
  BrotliDecode: 'brotli',
  Crypt: 'crypt',
};

type Stage = { kind: string; earlyChange: number };

/** Sözlükteki süzgeç zinciri; okunamayan ya da bilinmeyen süzgeçte zincir orada biter (sonrası sayılmaz). */
function stagesOf(index: PdfIndex, dict: Map<string, PdfValue>): Stage[] | null {
  const f = index.resolve(dict.get('Filter'));
  if (f === undefined || f === null) return [];
  if (Array.isArray(f) && f.length > PDF_GUARD_MAX_FILTERS) throw new GuardAbort('complex');
  const names = Array.isArray(f) ? f.map((x) => index.resolve(x)) : [f];
  const parms = index.resolve(dict.get('DecodeParms'));
  const out: Stage[] = [];
  for (const [i, n] of names.entries()) {
    if (!isName(n)) return out.length ? out : null;
    const kind = FILTERS[n.name];
    if (!kind) break;
    const p = index.resolve(Array.isArray(parms) ? parms[i] : i === 0 ? parms : undefined);
    const ec = p instanceof Map ? numOf(index.resolve(p.get('EarlyChange'))) : null;
    if (kind !== 'crypt') out.push({ kind, earlyChange: ec === 0 ? 0 : 1 });
  }
  return out;
}

/** Akışın verisinin sonu: doğrulanan `/Length` (ardında `endstream`), yoksa sonraki `endstream`, yoksa dosya sonu. */
function dataEnd(index: PdfIndex, dict: Map<string, PdfValue>, start: number): number {
  const buf = Buffer.from(index.buf.buffer, index.buf.byteOffset, index.buf.byteLength);
  const len = numOf(index.resolve(dict.get('Length')));
  if (len != null && len >= 0 && start + len <= buf.length) {
    let e = start + len;
    while (e < buf.length && isWs(buf[e]!)) e++;
    if (buf.subarray(e, e + ENDSTREAM.length).equals(ENDSTREAM)) return start + len;
  }
  const next = buf.indexOf(ENDSTREAM, start);
  return next >= 0 ? next : buf.length;
}

/** Zinciri açar, aşamaların çıktısını toplar (son aşamanın çıktısı tutulmaz). `budget` aşılınca durur. */
async function chainSize(input: Uint8Array, stages: Stage[], budget: number): Promise<number> {
  let data: Uint8Array = input;
  let total = 0;
  for (const [i, s] of stages.entries()) {
    const left = budget - total;
    if (left < 0) break;
    const last = i === stages.length - 1;
    let out: Uint8Array;
    if (s.kind === 'flate' || s.kind === 'brotli') {
      if (s.kind === 'flate' && !zlibHeaderOk(data, 0)) break;
      const r = await decompress(s.kind === 'flate' ? createInflate : createBrotliDecompress, data, left, !last);
      total += r.out;
      if (last || !r.data) break;
      out = r.data;
    } else {
      const r =
        s.kind === 'ahx'
          ? asciiHex(data, left)
          : s.kind === 'a85'
            ? ascii85(data, left)
            : s.kind === 'rl'
              ? runLength(data, left, !last)
              : lzw(data, left, s.earlyChange, !last);
      if (typeof r === 'number') {
        total += r;
        break;
      }
      out = r;
      total += out.length;
    }
    if (!out.length) break;
    data = out;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------

/** `stream` sözcüğünden sonra pdfjs gibi satır sonuna dek atlar: CR, LF ya da CRLF'den sonrası verinin başıdır. */
function skipToNextLine(buf: Buffer, at: number): number {
  let i = at;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === 0x0a) return i + 1;
    if (c === 0x0d) return buf[i + 1] === 0x0a ? i + 2 : i + 1;
    i++;
  }
  return i;
}

const END = Buffer.from('end', 'latin1');

/**
 * Akışların açılmış toplamı `maxBytes` içinde mi? Sınır aşılınca hemen döner (`ok: false`, `reason: 'size'`); süre
 * aşılınca `reason: 'time'`. Yalnız sayar; PDF'i doğrulamaz (bozuk PDF'i pdfjs reddeder).
 */
export async function checkPdfInflatedSize(bytes: Uint8Array, maxBytes: number, opts: PdfGuardOptions = {}): Promise<PdfSizeCheck> {
  const deadline = Date.now() + (opts.deadlineMs ?? PDF_GUARD_DEADLINE_MS);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Dizin ve şifre yalnız gerektiğinde (ilk akışta) kurulur
  let index: PdfIndex | null = null;
  let crypt: Crypt | null | 'unknown' = null;
  const indexed = () => {
    if (!index) {
      index = new PdfIndex(buf, deadline);
      crypt = cryptOf(index);
    }
    return index;
  };
  let total = 0;
  try {
    return await scan();
  } catch (e) {
    // süre ya da ayrıştırma tavanı ayrıştırıcının içinde aşıldı
    if (e instanceof GuardAbort) return { ok: false, size: total, reason: e.reason };
    throw e;
  }

  async function scan(): Promise<PdfSizeCheck> {
    let pos = 0;
    for (;;) {
      const at = buf.indexOf(STREAM, pos);
      if (at < 0) break;
      if (Date.now() > deadline) return { ok: false, size: total, reason: 'time' };
      pos = at + STREAM.length;
      // "endstream" içindeki "stream" akış başı değildir (pdfjs için de)
      if (at >= 3 && buf.subarray(at - 3, at).equals(END)) continue;
      const start = skipToNextLine(buf, pos);
      if (start >= buf.length) break;
      const budget = maxBytes - total;
      // 1. ham deneme (sözlükten bağımsız)
      const raw = zlibHeaderOk(buf, start) ? await decompress(createInflate, buf.subarray(start), budget, false) : { out: 0, consumed: 0 };
      // 2. sözlükten zincir (şifreli belgede önce çözülür)
      let chained = 0;
      const ix = indexed();
      const found = ix.streamAt(at);
      if (found) {
        const stages = stagesOf(ix, found.dict) ?? [];
        const type = found.dict.get('Type');
        const c = crypt as Crypt | null | 'unknown';
        const encrypted = c !== null && c !== 'unknown' && c.method !== 'none' && !(isName(type) && type.name === 'XRef');
        const trivial = stages.length === 0 || (stages.length === 1 && stages[0]!.kind === 'flate');
        if (stages.length && (encrypted || !trivial)) {
          const data = buf.subarray(start, dataEnd(ix, found.dict, start));
          chained = await chainSize(encrypted ? decrypt(c as Crypt, found.header, data) : data, stages, budget);
        }
      }
      total += Math.max(raw.out, chained);
      if (total > maxBytes) return { ok: false, size: total, reason: 'size' };
      // açılan akışın sıkıştırılmış gövdesi yeniden taranmaz
      if (raw.consumed > 0) pos = Math.max(pos, start + raw.consumed);
    }
    return { ok: true, size: total };
  }
}
