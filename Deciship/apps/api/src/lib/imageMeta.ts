/**
 * Y24: ölçüm fotoğrafının üst verisi kaydetmeden önce (ve kanıt ZIP'ine girerken yeniden, `services/evidence.ts`)
 * temizlenir. Fotoğraflar kanıt ZIP'iyle kargo firmasına gider; EXIF konum (GPS), cihaz ve zaman, C2PA/JUMBF imza ve cihaz
 * bilgisi taşıyabilir. Saf işlev: bağımlılık yok, diske ve ağa dokunmaz.
 *
 * Kural İZİN LİSTESİDİR (bilinmeyen taşıyıcı kalmasın): yalnız görüntüyü çizmek için gerekenler kalır, gerisi kalkar.
 * - JPEG: SOFn, DHT, DQT, DRI, DAC, SOS, DNL (yapıları denetlenir), APP0 "JFIF", APP2 "ICC_PROFILE", APP14 "Adobe" ve
 *   bu işlevin yazdığı asgari yön EXIF'i. APP1 (EXIF, XMP), APP3–APP13, APP15 (JUMBF/C2PA APP11 dahil), COM, APP2 MPF,
 *   taramalar arasındaki üst veri kesimleri ve görüntü bittikten (EOI) sonraki ek veri (ikinci görüntüler, hareketli
 *   fotoğraf videosu) kalkar. MPF için seçim: dizin ve gömülü görüntüler birlikte atılır (her birini ayrıca temizlemek
 *   yerine). Kesimler arasındaki artık baytlar libjpeg gibi atlanır (sonraki 0xFF'ye). Sıkıştırılmış veri bayt bayt kalır.
 * - PNG: IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, bKGD, pHYs, cICP, APNG (acTL, fcTL, fdAT) ve asgari
 *   `eXIf`. Bilinmeyen yardımcı parça (tEXt, iTXt, zTXt, tIME, caBX…) ve IEND sonrası kalkar; bilinmeyen zorunlu parça
 *   okunamaz sayılır.
 * - WebP: VP8, VP8L, VP8X, ALPH, ANIM, ANMF, ICCP ve asgari EXIF; gerisi (XMP, C2PA, bilinmeyen) ve RIFF dışı ek veri
 *   kalkar; VP8X bayrakları ve RIFF boyu düzelir.
 *
 * Yön: EXIF yön etiketi (0x0112) 2–8 ise yalnız onu taşıyan asgari bir EXIF özgün kesimin yerine yazılır; fotoğraf yan
 * dönmez. Etiket 1, yok ya da okunamıyorsa EXIF yazılmaz (gizlilik önce gelir). Zaten asgari olan EXIF olduğu gibi kalır:
 * ikinci temizlik dosyayı değiştirmez.
 *
 * Bozuk dosya (yapı okunamıyor, beklenmeyen işaret, tablo yapısı tutmuyor, PNG'de IEND yok, RIFF boyu tutmuyor, MPF'li
 * dosyada görüntü sonu bulunamıyor, `MAX_SEGMENTS`'ten çok kesim): girdi OLDUĞU GİBİ döner (`unparsed`); asla yarım çıktı
 * yok. JPEG görüntü verisinin içinde kesikse (EOI yok, MPF yok) başlık temizlenir, kalan veri alındığı gibi kopyalanır.
 * HEIC/HEIF ve tanınmayan tür olduğu gibi döner (`unsupported`). Süre ve bellek: tek geçiş, kesim sayısı sınırlı, çıktı
 * yalnız kalan aralıklardan kurulur.
 */
import zlib from 'node:zlib';

export type StripOutcome =
  /** üst veri kaldırıldı */
  | 'stripped'
  /** kaldırılacak bir şey yoktu: girdi aynen döner */
  | 'clean'
  /** yapı okunamadı (bozuk/kesik): girdi aynen döner */
  | 'unparsed'
  /** desteklenmeyen tür (HEIC/HEIF…): girdi aynen döner */
  | 'unsupported';

export type StripResult = {
  buffer: Buffer;
  outcome: StripOutcome;
  format: 'jpeg' | 'png' | 'webp' | null;
  /** Korunan yön (2–8); yoksa null. */
  orientation: number | null;
};

/** Temizlenmiş sayılan sonuç (kanıt ZIP'ine girebilir). */
export const isCleanOutcome = (o: StripOutcome) => o === 'stripped' || o === 'clean';

/** Dosya başına en çok bu kadar kesim/parça; üstü `unparsed` (çok parçalı dosyayla işlemciyi tutma, inceleme B1). */
export const MAX_SEGMENTS = 4096;

/** Yapı okunamadı: girdi olduğu gibi döner. */
class Unparsed extends Error {}
const fail = (): never => {
  throw new Unparsed('unparsed image structure');
};

type Stripped = { out: Buffer | null; orientation: number | null };

const latin = (s: string) => Buffer.from(s, 'latin1');
const EXIF_ID = latin('Exif\0\0');
const JFIF_ID = latin('JFIF\0');
const ICC_ID = latin('ICC_PROFILE\0');
const ADOBE_ID = latin('Adobe');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const startsWith = (b: Buffer, prefix: Buffer) => b.length >= prefix.length && b.subarray(0, prefix.length).equals(prefix);

export function stripImageMetadata(input: Buffer): StripResult {
  const format = formatOf(input);
  if (!format) return { buffer: input, outcome: 'unsupported', format: null, orientation: null };
  let r: Stripped;
  try {
    r = format === 'jpeg' ? stripJpeg(input) : format === 'png' ? stripPng(input) : stripWebp(input);
  } catch (e) {
    if (e instanceof Unparsed || e instanceof RangeError) return { buffer: input, outcome: 'unparsed', format, orientation: null };
    throw e;
  }
  if (!r.out) return { buffer: input, outcome: 'clean', format, orientation: r.orientation };
  return { buffer: r.out, outcome: 'stripped', format, orientation: r.orientation };
}

function formatOf(b: Buffer): StripResult['format'] {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (startsWith(b, PNG_SIG)) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Kalan aralıklar; bitişik aralıklar birleşir: parça sayısı kaldırılan kesim sayısıyla sınırlı. */
class Output {
  private readonly parts: Buffer[] = [];
  private start = -1;
  private end = -1;
  private readonly src: Buffer;
  constructor(src: Buffer) {
    this.src = src;
  }
  keep(s: number, e: number): void {
    if (e <= s) return;
    if (s === this.end) {
      this.end = e;
      return;
    }
    this.flush();
    this.start = s;
    this.end = e;
  }
  add(b: Buffer): void {
    this.flush();
    this.parts.push(b);
  }
  private flush(): void {
    if (this.start >= 0) this.parts.push(this.src.subarray(this.start, this.end));
    this.start = -1;
    this.end = -1;
  }
  done(): Buffer {
    this.flush();
    return Buffer.concat(this.parts);
  }
}

// ---------------------------------------------------------------------------------------------
// EXIF yönü (TIFF yapısı)

/** TIFF başlığından IFD0'daki yön etiketi (1–8); yoksa ya da yapı geçersizse null. */
export function readTiffOrientation(t: Buffer): number | null {
  if (t.length < 8) return null;
  const order = t.toString('latin1', 0, 2);
  const le = order === 'II' ? true : order === 'MM' ? false : null;
  if (le === null) return null;
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > t.length) return null;
  const count = Math.min(u16(ifd), MAX_SEGMENTS);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) !== 0x0112) continue;
    // SHORT, tek değer; değer alanın ilk iki baytında
    if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return null;
    const v = u16(e + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

/** Yalnız yön etiketini taşıyan TIFF (büyük sonlu, tek girdili IFD0, sonraki IFD yok): 26 bayt. */
export function orientationTiff(v: number): Buffer {
  const t = Buffer.alloc(26);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);
  t.writeUInt16BE(0x0112, 10);
  t.writeUInt16BE(3, 12);
  t.writeUInt32BE(1, 14);
  t.writeUInt16BE(v, 18);
  t.writeUInt32BE(0, 22);
  return t;
}

const keptOrientation = (v: number | null) => (v !== null && v >= 2 && v <= 8 ? v : null);

/** TIFF zaten bu işlevin yazdığı asgari biçimde mi (yalnız yön 2–8). */
function isMinimalTiff(t: Buffer): boolean {
  const v = keptOrientation(readTiffOrientation(t));
  return v !== null && t.equals(orientationTiff(v));
}

/** EXIF verisinden (önekli ya da öneksiz) yön. */
const exifOrientation = (data: Buffer) => keptOrientation(readTiffOrientation(startsWith(data, EXIF_ID) ? data.subarray(EXIF_ID.length) : data));

// ---------------------------------------------------------------------------------------------
// JPEG

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const DHT = 0xc4;
const DAC = 0xcc;
const DQT = 0xdb;
const DNL = 0xdc;
const DRI = 0xdd;
const SOS = 0xda;
const EOI = 0xd9;
/** Atılan (üst veri ya da uzantı) kesimler: APPn, COM, JPGn. */
const isDroppable = (m: number) => (m >= 0xe0 && m <= 0xef) || m === 0xfe || (m >= 0xf0 && m <= 0xfd);
const isStandalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

/** Görüntünün çizimi için gereken kesimin yapısı tutuyor mu; tutmuyorsa sahte işaret ya da bozuk dosya. */
function tableValid(marker: number, p: Buffer): boolean {
  if (SOF.has(marker)) return p.length >= 6 && p.length === 6 + 3 * p[5]!;
  if (marker === SOS) return p.length >= 1 && p[0]! >= 1 && p[0]! <= 4 && p.length === 1 + 2 * p[0]! + 3;
  if (marker === DRI || marker === DNL) return p.length === 2;
  if (marker === DAC) return p.length % 2 === 0;
  if (marker === DQT) {
    let k = 0;
    while (k < p.length) {
      const precision = p[k]! >> 4;
      if (precision > 1) return false;
      k += 1 + (precision ? 128 : 64);
    }
    return k === p.length;
  }
  if (marker === DHT) {
    let k = 0;
    while (k < p.length) {
      if (p[k]! >> 4 > 1 || (p[k]! & 0x0f) > 3 || k + 17 > p.length) return false;
      let symbols = 0;
      for (let j = 1; j <= 16; j++) symbols += p[k + j]!;
      k += 17 + symbols;
    }
    return k === p.length;
  }
  return false;
}
const isTable = (m: number) => SOF.has(m) || m === DHT || m === DQT || m === DRI || m === DAC;

function exifSegment(v: number): Buffer {
  const tiff = orientationTiff(v);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(2 + EXIF_ID.length + tiff.length, 2);
  return Buffer.concat([head, EXIF_ID, tiff]);
}

function stripJpeg(b: Buffer): Stripped {
  const out = new Output(b);
  out.keep(0, 2);
  let pos = 2;
  let removed = false;
  let orientation: number | null = null;
  let exifSeen = false;
  let mpf = false;
  let segments = 0;
  // ---- başlık: ilk SOS'a kadar
  for (;;) {
    if (++segments > MAX_SEGMENTS) fail();
    if (pos >= b.length) fail();
    if (b[pos] !== 0xff) {
      // kesimler arası artık bayt: libjpeg gibi sonraki işarete atlanır (atılır)
      const next = b.indexOf(0xff, pos);
      if (next < 0) fail();
      removed = true;
      pos = next;
    }
    let p = pos + 1;
    while (p < b.length && b[p] === 0xff) p++; // işaret öncesi doldurma baytları kesimle birlikte
    if (p >= b.length) fail();
    const marker = b[p]!;
    p++;
    // SOS'tan önce görüntü verisi, RST/TEM, ikinci SOI ya da EOI olamaz
    if (marker === 0x00 || marker === 0xd8 || marker === EOI || isStandalone(marker)) fail();
    if (p + 2 > b.length) fail();
    const len = b.readUInt16BE(p);
    if (len < 2 || p + len > b.length) fail();
    const end = p + len;
    const payload = b.subarray(p + 2, end);
    if (marker === SOS) {
      if (!tableValid(marker, payload)) fail();
      out.keep(pos, end);
      pos = end;
      break;
    }
    if (isTable(marker)) {
      if (!tableValid(marker, payload)) fail();
      out.keep(pos, end);
    } else if ((marker === 0xe0 && startsWith(payload, JFIF_ID)) || (marker === 0xe2 && startsWith(payload, ICC_ID)) || (marker === 0xee && startsWith(payload, ADOBE_ID))) {
      out.keep(pos, end);
    } else if (marker === 0xe1 && !exifSeen && startsWith(payload, EXIF_ID)) {
      exifSeen = true;
      const tiff = payload.subarray(EXIF_ID.length);
      orientation = keptOrientation(readTiffOrientation(tiff));
      if (isMinimalTiff(tiff)) {
        out.keep(pos, end); // zaten asgari: olduğu gibi
      } else {
        removed = true;
        if (orientation) out.add(exifSegment(orientation));
      }
    } else if (isDroppable(marker)) {
      if (marker === 0xe2 && startsWith(payload, latin('MPF\0'))) mpf = true;
      removed = true;
    } else {
      fail(); // DNL, DHP, EXP, ayrılmış işaret: SOS'tan önce beklenmez
    }
    pos = end;
  }
  // ---- taramalar: sıkıştırılmış veri, aralarında tablolar ve başka SOS'lar
  let run = pos;
  let i = pos;
  let imageEnd = -1;
  const n = b.length;
  while (i + 1 < n) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x00 || isStandalone(m)) {
      i += 2;
      continue;
    }
    if (m === EOI) {
      imageEnd = i + 2;
      break;
    }
    if (++segments > MAX_SEGMENTS) fail();
    if (i + 4 > n) fail();
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > n) fail();
    const end = i + 2 + len;
    if (m === SOS || m === DNL || m === DHT || m === DQT || m === DRI || m === DAC) {
      if (!tableValid(m, b.subarray(i + 4, end))) fail();
    } else if (isDroppable(m)) {
      out.keep(run, i);
      removed = true;
      run = end;
    } else {
      fail(); // SOI, SOFn, ayrılmış: tarama arasında olamaz (bozuk ya da sahte işaret)
    }
    i = end;
  }
  if (imageEnd >= 0) {
    out.keep(run, imageEnd);
    if (imageEnd < n) removed = true; // ek veri (ikinci görüntüler, video) atılır
  } else {
    // görüntü sonu yok: MPF'li dosyada gömülü görüntüler ayıklanamaz (temiz sayılmaz)
    if (mpf) fail();
    out.keep(run, n);
  }
  if (!removed) return { out: null, orientation };
  return { out: out.done(), orientation };
}

// ---------------------------------------------------------------------------------------------
// PNG

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'cICP', 'acTL', 'fcTL', 'fdAT']);
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function stripPng(b: Buffer): Stripped {
  const out = new Output(b);
  out.keep(0, 8);
  let pos = 8;
  let removed = false;
  let orientation: number | null = null;
  let exifSeen = false;
  let chunks = 0;
  for (;;) {
    if (++chunks > MAX_SEGMENTS) fail();
    if (pos + 12 > b.length) fail();
    const len = b.readUInt32BE(pos);
    if (len > 0x7fffffff || pos + 12 + len > b.length) fail();
    if (!isLetter(b[pos + 4]!) || !isLetter(b[pos + 5]!) || !isLetter(b[pos + 6]!) || !isLetter(b[pos + 7]!)) fail();
    const type = b.toString('latin1', pos + 4, pos + 8);
    if (chunks === 1 && type !== 'IHDR') fail();
    const end = pos + 12 + len;
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'eXIf' && !exifSeen) {
      exifSeen = true;
      orientation = exifOrientation(data);
      if (isMinimalTiff(data)) {
        out.keep(pos, end);
      } else {
        removed = true;
        if (orientation) out.add(pngChunk('eXIf', orientationTiff(orientation)));
      }
    } else if (PNG_KEEP.has(type)) {
      out.keep(pos, end);
    } else if ((b[pos + 4]! & 0x20) === 0) {
      fail(); // bilinmeyen zorunlu parça: çözücü de açamaz
    } else {
      removed = true; // bilinmeyen ya da üst veri taşıyan yardımcı parça
    }
    pos = end;
    if (type === 'IEND') {
      if (pos < b.length) removed = true;
      break;
    }
  }
  if (!removed) return { out: null, orientation };
  return { out: out.done(), orientation };
}

// ---------------------------------------------------------------------------------------------
// WebP (RIFF)

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat(data.length % 2 ? [head, data, Buffer.alloc(1)] : [head, data]);
}

function stripWebp(b: Buffer): Stripped {
  const riffEnd = 8 + b.readUInt32LE(4);
  if (riffEnd < 12 || riffEnd > b.length) fail();
  type Chunk = { fourcc: string; raw: Buffer };
  const chunks: Chunk[] = [];
  let pos = 12;
  let removed = riffEnd < b.length; // RIFF dışındaki ek veri
  let orientation: number | null = null;
  let exifSeen = false;
  let exifOut = false;
  let count = 0;
  while (pos < riffEnd) {
    if (++count > MAX_SEGMENTS) fail();
    if (pos + 8 > riffEnd) fail();
    const fourcc = b.toString('latin1', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    let end = pos + 8 + size + (size % 2);
    // son parçanın doldurma baytı bazı yazıcılarda yok
    if (end > riffEnd) {
      if (pos + 8 + size !== riffEnd) fail();
      end = riffEnd;
    }
    const data = b.subarray(pos + 8, pos + 8 + size);
    if (fourcc === 'EXIF' && !exifSeen) {
      exifSeen = true;
      orientation = exifOrientation(data);
      if (isMinimalTiff(data)) {
        chunks.push({ fourcc, raw: b.subarray(pos, end) });
        exifOut = true;
      } else {
        removed = true;
        if (orientation) {
          chunks.push({ fourcc, raw: riffChunk('EXIF', orientationTiff(orientation)) });
          exifOut = true;
        }
      }
    } else if (WEBP_KEEP.has(fourcc)) {
      chunks.push({ fourcc, raw: b.subarray(pos, end) });
    } else {
      removed = true; // XMP, C2PA, bilinmeyen
    }
    pos = end;
  }
  if (!chunks.some((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L' || c.fourcc === 'ANMF')) fail(); // görüntü parçası yok
  if (!removed) return { out: null, orientation };
  const body = chunks.map((c) => {
    if (c.fourcc !== 'VP8X' || c.raw.length < 9) return c.raw;
    const copy = Buffer.from(c.raw);
    copy[8] = (copy[8]! & ~(VP8X_EXIF | VP8X_XMP)) | (exifOut ? VP8X_EXIF : 0);
    return copy;
  });
  const payload = Buffer.concat(body);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  return { out: Buffer.concat([head, payload]), orientation };
}
