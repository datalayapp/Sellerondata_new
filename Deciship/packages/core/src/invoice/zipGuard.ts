/**
 * Zip (XLSX) açılmadan önce açılmış boyut denetimi (Mesaj 6, 03-B2: sıkıştırma bombası).
 *
 * İki adım, ikisi de exceljs/JSZip dosyayı belleğe açmadan önce:
 * 1. Merkez dizininde yazan açılmış boyutların toplamı (hızlı ret; dosyanın kendi beyanı).
 * 2. Beyan yalan olabilir (JSZip boyut uyuşmazlığını ancak açtıktan sonra fark eder). Bu yüzden sıkıştırılmış
 *    parçalar akışla açılır, çıktı yalnız sayılır ve sınır aşılınca hemen durulur; bellekte tutulmaz.
 *
 * Saf modül: yalnız `Uint8Array`, `DataView` ve web standardı `DecompressionStream` (Node 24 ve tarayıcı). Yeni bağımlılık yok.
 * Merkez dizini bulunamayan ya da yapısı kapalı uçlu kurallara uymayan zip'te bu modülün sayımı `untrusted` döner: dosya
 * yalnız bu yüzden reddedilmez (Mesaj 6'dan önce okunan, sonuna bayt eklenmiş dosyalar okunmaya devam eder); karar 3. adımdadır.
 *
 * 3. Asıl sayım okuyucunun kendi görüşüyle yapılır (`countJsZipInflated`): exceljs dosyayı JSZip ile açar; aynı JSZip
 *    ayrıştırması (açmadan) alınır ve her parça akışla, bütçeyle sayılır. Böylece bu modülün ayrıştırması ile JSZip'inki
 *    ayrışsa bile (yalan dizin, kaydırılmış ofset) sayılan, gerçekten açılacak olandır.
 */

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Merkez dizinindeki bir kayıt. Boyutlar dosyanın beyanıdır. */
export type ZipEntry = {
  name: string;
  /** 0 = sıkıştırmasız, 8 = deflate; başkasını JSZip zaten açamaz */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

/** Gerçek bir XLSX birkaç yüz parçadan fazla olmaz; bunu aşan zip açılmadan reddedilir (nesne yükü de bellektir). */
export const ZIP_MAX_ENTRIES = 20_000;

function u64(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  // 2^53 üstü güvenli sayı değil: zaten sınırın çok üstünde, sonsuz say
  return hi >= 0x200000 ? Number.POSITIVE_INFINITY : hi * 0x100000000 + lo;
}

type Directory = { count: number; cdSize: number; cdOffset: number };

/**
 * Dizin sonu kaydı (ZIP64 dahil). Zip değilse ya da kayıt tutarsızsa `null`. Kapalı uçlu (Mesaj 6 R2): okuyucunun (JSZip)
 * başka bir dizin okuyabileceği her yapıda bu modülün ayrıştırmasına güvenilmez (`untrusted`; dosya reddedilmez, karar
 * JSZip'in gördüğünü bütçeyle sayan adımdadır):
 * - dizin sonu kaydı dosyanın son kaydı değil (sonda bayt ya da yorum uzunluğu tutmuyor);
 * - disk alanları 0 değil (JSZip `0xFFFF` görünce ZIP64 kayıtlarına geçer) ya da bu disk/toplam kayıt sayısı farklı;
 * - ZIP64 bulucusu var ama 32 bitlik kayıt ZIP64 istemiyor (ya da tersi);
 * - merkez dizini dizin sonu kaydına bitişik değil (başa ya da araya eklenmiş bayt: JSZip ofsetleri kaydırır).
 */
function locateDirectory(bytes: Uint8Array): Directory | null {
  if (bytes.length < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Dizin sonu kaydı: son 22 bayt + en çok 64 KB yorum
  // Sondan ilk imza: JSZip de aynısını alır (`lastIndexOfSignature`)
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - U16_MAX);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  if (eocd + 22 + dv.getUint16(eocd + 20, true) !== bytes.length) return null;
  const disk = dv.getUint16(eocd + 4, true);
  const cdDisk = dv.getUint16(eocd + 6, true);
  let onDisk = dv.getUint16(eocd + 8, true);
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) return null;
  const hasLocator = eocd >= 20 && dv.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG;
  const wantsZip64 = onDisk === U16_MAX || count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX;
  if (hasLocator !== wantsZip64) return null;
  let dirEnd = eocd;
  if (wantsZip64) {
    const loc = eocd - 20;
    if (dv.getUint32(loc + 4, true) !== 0 || dv.getUint32(loc + 16, true) !== 1) return null;
    const z64 = u64(dv, loc + 8);
    if (!(z64 + 56 <= loc) || dv.getUint32(z64, true) !== ZIP64_EOCD_SIG) return null;
    if (dv.getUint32(z64 + 16, true) !== 0 || dv.getUint32(z64 + 20, true) !== 0) return null;
    onDisk = u64(dv, z64 + 24);
    count = u64(dv, z64 + 32);
    cdSize = u64(dv, z64 + 40);
    cdOffset = u64(dv, z64 + 48);
    dirEnd = z64;
  }
  if (onDisk !== count) return null;
  if (cdOffset + cdSize !== dirEnd) return null;
  return { count, cdSize, cdOffset };
}

/** Merkez dizinini okur. Zip değilse, dizin tutarsızsa ya da `ZIP_MAX_ENTRIES`'ı aşıyorsa `null`. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const dir = locateDirectory(bytes);
  if (!dir || dir.count > ZIP_MAX_ENTRIES) return null;
  const { count, cdSize, cdOffset } = dir;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new TextDecoder('utf-8');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || dv.getUint32(p, true) !== CEN_SIG) return null;
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localHeaderOffset = dv.getUint32(p + 42, true);
    const nameAt = p + 46;
    const extraAt = nameAt + nameLen;
    if (extraAt + extraLen + commentLen > end) return null;
    if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      // ZIP64 ek alanı (0x0001): yalnız 0xFFFFFFFF olan alanlar, bu sırayla
      let q = extraAt;
      let found = false;
      while (q + 4 <= extraAt + extraLen) {
        const id = dv.getUint16(q, true);
        const size = dv.getUint16(q + 2, true);
        if (id === 0x0001) {
          let r = q + 4;
          const take = () => {
            if (r + 8 > q + 4 + size) return Number.NaN;
            const v = u64(dv, r);
            r += 8;
            return v;
          };
          if (uncompressedSize === U32_MAX) uncompressedSize = take();
          if (compressedSize === U32_MAX) compressedSize = take();
          if (localHeaderOffset === U32_MAX) localHeaderOffset = take();
          found = true;
          break;
        }
        q += 4 + size;
      }
      if (!found || [uncompressedSize, compressedSize, localHeaderOffset].some(Number.isNaN)) return null;
    }
    out.push({ name: names.decode(bytes.subarray(nameAt, extraAt)), method, compressedSize, uncompressedSize, localHeaderOffset });
    p = extraAt + extraLen + commentLen;
  }
  return out;
}

/** Beyan edilen açılmış toplam boyut (bayt); zip okunamazsa `null`. */
export function zipDeclaredSize(bytes: Uint8Array): number | null {
  const entries = zipEntries(bytes);
  if (!entries) return null;
  return entries.reduce((s, e) => s + e.uncompressedSize, 0);
}

/** Parçanın sıkıştırılmış verisi (yerel başlıktan sonra). Tutarsızsa `null`. */
function entryData(bytes: Uint8Array, e: ZipEntry): Uint8Array | null {
  const at = e.localHeaderOffset;
  if (!(at + 30 <= bytes.length)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(at, true) !== LOC_SIG) return null;
  const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
  const stop = start + e.compressedSize;
  if (!(stop <= bytes.length)) return null;
  return bytes.subarray(start, stop);
}

/**
 * Deflate verisini açar, çıktıyı sayar, `budget` aşılınca durur (çıktı tutulmaz). Bozuk veride o ana kadar sayılanı döner:
 * bozuk parçayı JSZip de açamaz, okuma "okunamadı" ile biter.
 */
async function inflatedLength(data: Uint8Array, budget: number): Promise<number> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budget) break;
    }
  } catch {
    // bozuk akış: sayılan kadar
  } finally {
    reader.cancel().catch(() => {});
  }
  return total;
}

export type ZipSizeCheck =
  | { ok: true; size: number }
  /** bu modülün ayrıştırması dosyaya güvenemedi (yapı kuralı ya da dizin okunamadı): karar JSZip sayımına kalır */
  | { ok: false; reason: 'untrusted' }
  /** JSZip parçayı açamadı (bozuk veri, boyut tutmuyor): exceljs de açamaz */
  | { ok: false; reason: 'unreadable' }
  | { ok: false; reason: 'tooLarge'; size: number };

/**
 * Zip'in açılmış hâli `maxBytes` içinde mi? Önce beyan (hızlı ret), sonra deflate parçaları gerçekten açılıp sayılır.
 * `size`: beyan ile sayılanın büyüğü (sınır aşıldıysa o ana kadarki toplam).
 */
export async function checkZipSize(bytes: Uint8Array, maxBytes: number): Promise<ZipSizeCheck> {
  const dir = locateDirectory(bytes);
  if (dir && dir.count > ZIP_MAX_ENTRIES) return { ok: false, reason: 'tooLarge', size: Number.POSITIVE_INFINITY };
  const entries = zipEntries(bytes);
  if (!entries) return { ok: false, reason: 'untrusted' };
  const declared = entries.reduce((s, e) => s + e.uncompressedSize, 0);
  if (declared > maxBytes) return { ok: false, reason: 'tooLarge', size: declared };
  let actual = 0;
  for (const e of entries) {
    if (e.method === 8) {
      const data = entryData(bytes, e);
      if (!data) return { ok: false, reason: 'untrusted' };
      actual += await inflatedLength(data, maxBytes - actual);
    } else {
      actual += e.method === 0 ? e.compressedSize : e.uncompressedSize;
    }
    if (actual > maxBytes) return { ok: false, reason: 'tooLarge', size: actual };
  }
  return { ok: true, size: Math.max(declared, actual) };
}

/** JSZip'in `loadAsync` sonucunun kullanılan kısmı (core JSZip'e tür olarak bağlanmaz; exceljs'in bağımlılığıdır). */
export type JsZipLike = { files: Record<string, { dir: boolean; internalStream(type: 'uint8array'): JsZipStream }> };
type JsZipStream = {
  on(event: 'data', f: (chunk: Uint8Array) => void): JsZipStream;
  on(event: 'error', f: (e: unknown) => void): JsZipStream;
  on(event: 'end', f: () => void): JsZipStream;
  resume(): JsZipStream;
  pause(): JsZipStream;
};

/**
 * JSZip'in göreceği parçaları gerçekten açıp sayar (çıktı tutulmaz; bütçe aşılınca akış durdurulur). Bozuk parça
 * (açılamayan, boyutu tutmayan) `unreadable`: exceljs de açamaz.
 */
export async function countJsZipInflated(zip: JsZipLike, maxBytes: number): Promise<ZipSizeCheck> {
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > ZIP_MAX_ENTRIES) return { ok: false, reason: 'tooLarge', size: Number.POSITIVE_INFINITY };
  let total = 0;
  for (const entry of entries) {
    const r = await new Promise<'ok' | 'tooLarge' | 'unreadable'>((resolve) => {
      let done = false;
      const finish = (v: 'ok' | 'tooLarge' | 'unreadable') => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const stream = entry.internalStream('uint8array');
      stream
        .on('data', (chunk) => {
          if (done) return;
          total += chunk.byteLength;
          if (total > maxBytes) {
            stream.pause();
            finish('tooLarge');
          }
        })
        .on('error', () => finish('unreadable'))
        .on('end', () => finish('ok'))
        .resume();
    });
    if (r === 'tooLarge') return { ok: false, reason: 'tooLarge', size: total };
    if (r === 'unreadable') return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, size: total };
}
