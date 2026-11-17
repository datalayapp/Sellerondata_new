import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Sıkıştırmasız (stored), akışlı ZIP yazıcısı. Yeni bağımlılık yok: CRC `zlib.crc32` ile.
 *
 * Her giriş tek parça bellekte gelir (ölçüm fotoğrafı birkaç MB): boyut ve CRC yerel başlıktan önce bilinir, veri tanımlayıcısı
 * (bit 3) gerekmez; Windows Gezgini, macOS Arşiv İzlencesi ve `unzip` sorunsuz açar. Arşiv aynı anda tek giriş kadar bellek tutar.
 * ZIP64 yok: toplam 4 GB'ı ya da 65.535 girişi aşan arşiv hata verir (çağıran çok daha önce sınırlar: kanıt ZIP'i 500 MB).
 */

export type ZipEntry = { name: string; data: Buffer; mtime?: Date };

/**
 * Arşiv içi ad: yalnız ASCII harf, rakam, nokta, tire, alt çizgi; harf ya da rakamla başlar. Yol ayırıcı ("/", "\"), "..",
 * sürücü harfi, boşluk, denetim karakteri giremez: açılırken klasör dışına yazamaz, hiçbir işletim sisteminde bozulmaz.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeZipName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes('..');
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export type ZipOptions = {
  /**
   * DOS tarih alanı saat dilimi taşımaz; açan program (Windows Gezgini, Arşiv İzlencesi) onu yerel saat sayar. Firmanın saat
   * dilimi (IANA adı) verilirse o dilimdeki duvar saati yazılır; verilmezse UTC.
   */
  timeZone?: string;
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Anın verilen saat dilimindeki takvim ve saat bileşenleri. */
function wallClock(at: Date, timeZone: string | undefined) {
  if (!timeZone) {
    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate(), hour: at.getUTCHours(), minute: at.getUTCMinutes(), second: at.getUTCSeconds() };
  }
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    partsFormatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

/** MS-DOS saat/tarih alanları (2 saniye çözünürlük, 1980 öncesi 1980). */
export function dosDateTime(at: Date, timeZone?: string): { time: number; date: number } {
  const w = wallClock(at, timeZone);
  const year = Math.min(2107, Math.max(1980, w.year));
  const time = (w.hour << 11) | (w.minute << 5) | Math.floor(w.second / 2);
  const date = ((year - 1980) << 9) | (w.month << 5) | w.day;
  return { time, date };
}

type CentralRecord = { name: Buffer; crc: number; size: number; offset: number; time: number; date: number };

function localHeader(name: Buffer, crc: number, size: number, time: number, date: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(10, 4); // gereken sürüm 1.0 (stored)
  h.writeUInt16LE(0, 6); // bayrak yok (ad ASCII)
  h.writeUInt16LE(0, 8); // yöntem 0 = stored
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name]);
}

function centralHeader(r: CentralRecord): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4); // oluşturan sürüm 2.0, MS-DOS
  h.writeUInt16LE(10, 6);
  h.writeUInt16LE(0, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(r.time, 12);
  h.writeUInt16LE(r.date, 14);
  h.writeUInt32LE(r.crc, 16);
  h.writeUInt32LE(r.size, 20);
  h.writeUInt32LE(r.size, 24);
  h.writeUInt16LE(r.name.length, 28);
  h.writeUInt16LE(0, 30); // ek alan
  h.writeUInt16LE(0, 32); // yorum
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // iç öznitelik
  h.writeUInt32LE(0, 38); // dış öznitelik
  h.writeUInt32LE(r.offset, 42);
  return Buffer.concat([h, r.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(size, 12);
  h.writeUInt32LE(offset, 16);
  h.writeUInt16LE(0, 20);
  return h;
}

/**
 * ZIP baytlarını parça parça üretir. Güvensiz ad, yinelenen ad, 4 GB ya da 65.535 giriş sınırı hata verir: akış o noktada kesilir,
 * yarım dosya geçerli bir arşiv gibi görünmez (merkez dizini yazılmamıştır).
 */
export async function* zipChunks(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, opts: ZipOptions = {}): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for await (const entry of entries) {
    if (!isSafeZipName(entry.name)) throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(entry.name)}`);
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    seen.add(key);
    if (central.length >= MAX_ENTRIES) throw new Error('ZIP entry limit exceeded');
    const name = Buffer.from(entry.name, 'ascii');
    const size = entry.data.length;
    if (offset + 30 + name.length + size > MAX_U32) throw new Error('ZIP size limit exceeded');
    const crc = zlib.crc32(entry.data) >>> 0;
    const { time, date } = dosDateTime(entry.mtime ?? new Date(), opts.timeZone);
    const local = localHeader(name, crc, size, time, date);
    central.push({ name, crc, size, offset, time, date });
    yield local;
    if (size) yield entry.data;
    offset += local.length + size;
  }
  const dir = Buffer.concat(central.map(centralHeader));
  if (offset + dir.length > MAX_U32) throw new Error('ZIP size limit exceeded');
  yield dir;
  yield endOfCentralDirectory(central.length, dir.length, offset);
}

export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, opts: ZipOptions = {}): Readable {
  return Readable.from(zipChunks(entries, opts), { objectMode: false });
}
