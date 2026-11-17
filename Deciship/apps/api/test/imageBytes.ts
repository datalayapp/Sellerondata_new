/**
 * Y24 test yardımcısı: fotoğraf üst verisi testlerinin (`imageMeta.test.ts`, `imageMeta.perf.test.ts`) elle, bayt bayt
 * kurulan JPEG, PNG ve WebP yapı taşları. Saf işlevler; veritabanı yok.
 */
import zlib from 'node:zlib';
import { orientationTiff } from '../src/lib/imageMeta.ts';

export const SECRET = 'GPS-SECRET-41.0082N-28.9784E';
export const hasSecret = (b: Buffer) => b.includes(Buffer.from('SECRET'));

// ---------- JPEG yapı taşları ----------

export const SOI = Buffer.from([0xff, 0xd8]);
export const EOI = Buffer.from([0xff, 0xd9]);
export function seg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
export const latin = (s: string) => Buffer.from(s, 'latin1');
export const APP0 = seg(0xe0, latin('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
export const ICC = seg(0xe2, Buffer.concat([latin('ICC_PROFILE\0\x01\x01'), Buffer.alloc(20, 7)]));
export const ADOBE = seg(0xee, latin('Adobe\0\x64\0\0\0\0\x01'));
export const COM = seg(0xfe, latin('kutu'));
export const DQT = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
export const SOF = seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
export const DHT = seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from([1, ...Array(15).fill(0)]), Buffer.from([0])]));
export const SOS = seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
/** Sıkıştırılmış veri: doldurulmuş 0xFF00 ve RST0 içerir (EOI sanılmamalı). */
export const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]);
export const XMP = seg(0xe1, Buffer.concat([latin('http://ns.adobe.com/xap/1.0/\0'), latin(`<x:xmpmeta><exif:GPSLatitude>${SECRET}</exif:GPSLatitude></x:xmpmeta>`)]));
export const IPTC = seg(0xed, Buffer.concat([latin('Photoshop 3.0\0'), latin(`8BIM\x04\x04\0\0\0\0\0\x20${SECRET}`)]));
export const MPF = seg(0xe2, Buffer.concat([latin('MPF\0'), latin('MM\0*\0\0\0\x08'), Buffer.alloc(16)]));

export type Entry = [tag: number, type: number, count: number, value: number | Buffer];

/** IFD0 girdileriyle TIFF; ASCII ya da 4 bayttan uzun değerler sonra gelen veri alanına yazılır. */
export function tiff(entries: Entry[], le = false): Buffer {
  const ifdSize = 2 + entries.length * 12 + 4;
  const data: Buffer[] = [];
  let dataAt = 8 + ifdSize;
  const ifd = Buffer.alloc(ifdSize);
  const w16 = (b: Buffer, v: number, o: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b: Buffer, v: number, o: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  w16(ifd, entries.length, 0);
  entries.forEach(([tag, type, count, value], i) => {
    const e = 2 + i * 12;
    w16(ifd, tag, e);
    w16(ifd, type, e + 2);
    w32(ifd, count, e + 4);
    if (Buffer.isBuffer(value)) {
      w32(ifd, dataAt, e + 8);
      data.push(value);
      dataAt += value.length;
    } else if (type === 3) {
      w16(ifd, value, e + 8);
    } else {
      w32(ifd, value, e + 8);
    }
  });
  const head = Buffer.alloc(8);
  head.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(head, 42, 2);
  w32(head, 8, 4);
  return Buffer.concat([head, ifd, ...data]);
}

export const MAKE = (s: string): Entry => [0x010f, 2, s.length + 1, latin(`${s}\0`)];
export const ORIENT = (v: number): Entry => [0x0112, 3, 1, v];
export const GPS_TEXT = (): Entry => [0x8825, 7, SECRET.length, latin(SECRET)];
export const exifSeg = (t: Buffer) => seg(0xe1, Buffer.concat([latin('Exif\0\0'), t]));
export const minimalExif = (v: number) => exifSeg(orientationTiff(v));

export const jpeg = (...head: Buffer[]) => Buffer.concat([SOI, ...head, DQT, SOF, DHT, SOS, SCAN, EOI]);
export const image = Buffer.concat([DQT, SOF, DHT, SOS, SCAN, EOI]);

// ---------- PNG ----------

export function chunk(type: string, data: Buffer, crcOverride?: number): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcOverride ?? zlib.crc32(Buffer.concat([latin(type), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
export const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0])));
export const IEND = chunk('IEND', Buffer.alloc(0));
export const PHYS = chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));

/** Bütün parçaların CRC'si doğru mu, dosya IEND ile bitiyor mu. */
export function pngValid(b: Buffer): boolean {
  if (!b.subarray(0, 8).equals(PNG_SIG)) return false;
  let p = 8;
  for (;;) {
    const len = b.readUInt32BE(p);
    const type = b.subarray(p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if ((zlib.crc32(Buffer.concat([type, data])) >>> 0) !== b.readUInt32BE(p + 8 + len)) return false;
    p += 12 + len;
    if (type.toString('latin1') === 'IEND') return p === b.length;
  }
}

// ---------- WebP ----------

export function riff(fourcc: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat(data.length % 2 ? [h, data, Buffer.alloc(1)] : [h, data]);
}
export function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(12);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(4 + body.length, 4);
  h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, body]);
}
export const vp8x = (flags: number) => riff('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
export const VP8 = riff('VP8 ', Buffer.from([1, 2, 3, 4, 5])); // tek boy: doldurma baytıyla
export const ICCP = riff('ICCP', Buffer.alloc(6, 9));

// ---------- B1: büyük, kötü niyetli girdiler (doğruluk imageMeta.test.ts, süre imageMeta.perf.test.ts) ----------

export const MB8 = 8 * 1024 * 1024;

/** 8 MB RST, küçük COM, doldurma: beklenen sonuçlarıyla; `plain` aynı boyda zararsız JPEG (süre tabanı, sonucu clean). */
export function b1Jpeg(): { plain: Buffer; cases: [name: string, input: Buffer, outcome: string][] } {
  const rsts = Buffer.alloc(MB8);
  for (let k = 0; k < MB8; k += 2) {
    rsts[k] = 0xff;
    rsts[k + 1] = 0xd0;
  }
  const tinyComs = Buffer.alloc(MB8);
  for (let k = 0; k + 4 <= MB8; k += 4) tinyComs.set([0xff, 0xfe, 0x00, 0x02], k);
  return {
    plain: Buffer.concat([SOI, DQT, SOF, DHT, SOS, Buffer.alloc(MB8, 0x55), EOI]),
    cases: [
      ['SOS öncesi RST', Buffer.concat([SOI, rsts, image]), 'unparsed'],
      ['SOS öncesi 2 milyon küçük COM', Buffer.concat([SOI, tinyComs, image]), 'unparsed'],
      ['SOS öncesi 8 MB doldurma', Buffer.concat([SOI, Buffer.alloc(MB8, 0xff), DQT, SOF, DHT, SOS, SCAN, EOI]), 'clean'],
      ['taramada 4 milyon RST', Buffer.concat([SOI, APP0, exifSeg(tiff([GPS_TEXT()])), DQT, SOF, DHT, SOS, rsts, EOI]), 'stripped'],
      ['taramada 2 milyon küçük COM', Buffer.concat([SOI, APP0, DQT, SOF, DHT, SOS, tinyComs, EOI]), 'unparsed'],
    ],
  };
}

/** 8 MB küçük parçalı PNG (sonucu unparsed); `plain` aynı boyda zararsız PNG, tek IDAT ve kalkacak bir tEXt (stripped). */
export function b1Png(): { input: Buffer; plain: Buffer } {
  const tiny = chunk('tIME', Buffer.alloc(0));
  const input = Buffer.concat([PNG_SIG, IHDR, Buffer.concat(Array(700_000).fill(tiny)), IDAT, IEND]);
  return { input, plain: Buffer.concat([PNG_SIG, IHDR, chunk('tEXt', latin('Comment\0x')), chunk('IDAT', Buffer.alloc(input.length, 0x55)), IEND]) };
}

/** 8 MB küçük parçalı WebP (sonucu unparsed); `plain` aynı boyda zararsız WebP, tek büyük parça ve bir XMP (stripped). */
export function b1Webp(): { input: Buffer; plain: Buffer } {
  const input = webp(VP8, Buffer.concat(Array(1_000_000).fill(riff('XYZW', Buffer.alloc(0)))));
  return { input, plain: webp(VP8, riff('XMP ', latin('x')), riff('XYZW', Buffer.alloc(input.length, 0x55))) };
}
