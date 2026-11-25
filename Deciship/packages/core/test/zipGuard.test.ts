/**
 * Mesaj 6 (03-B2): dosya açılmadan önce boyut ve satır sınırı. Zip bombası (beyanı doğru ya da yalan), 200 MB üstü
 * açılmış boyut, ZIP64 beyanı, satır sınırı (CSV, XLSX, tarife). Zip'ler burada elle yazılır (deflate: node:zlib).
 */
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ROWS, DEFAULT_MAX_UNCOMPRESSED_BYTES, InvoiceFileError, readTable, readTariffFile, tooManyRowsError } from '../src/index';
import { checkZipSize, countJsZipInflated, ZIP_MAX_ENTRIES, zipDeclaredSize, zipEntries, type JsZipLike } from '../src/invoice/zipGuard';
import { bigCsv, bigXlsx } from './fixtures/robustness/build';

const MB = 1024 * 1024;

type Part = { name: string; data: Uint8Array; store?: boolean; declaredSize?: number; zip64Size?: number };

/** En küçük zip yazıcı: yerel başlık + veri, merkez dizini, dizin sonu. `declaredSize` beyanı ezer (yalan söyleyen zip). */
function makeZip(parts: Part[], opts: { count?: number } = {}): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = Buffer.from(p.name, 'utf8');
    const body = p.store ? Buffer.from(p.data) : deflateRawSync(p.data);
    const method = p.store ? 0 : 8;
    const size = p.declaredSize ?? p.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(Math.min(size, 0xffffffff), 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);
    const extra = p.zip64Size != null ? Buffer.alloc(12) : Buffer.alloc(0);
    if (p.zip64Size != null) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(p.zip64Size), 4);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(p.zip64Size != null ? 0xffffffff : Math.min(size, 0xffffffff), 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name, extra);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = opts.count ?? parts.length;
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

async function fileError(p: Promise<unknown>): Promise<InvoiceFileError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceFileError);
    return e as InvoiceFileError;
  }
  throw new Error('hata bekleniyordu');
}

describe('zip merkezi dizini', () => {
  it('gerçek bir XLSX: parçalar okunur, beyan edilen boyut gerçek açılmış boyuttur', async () => {
    const bytes = await bigXlsx(50);
    const entries = zipEntries(bytes)!;
    expect(entries.map((e) => e.name)).toContain('xl/workbook.xml');
    const declared = zipDeclaredSize(bytes)!;
    expect(declared).toBeGreaterThan(bytes.length);
    expect(await checkZipSize(bytes, 10 * MB)).toEqual({ ok: true, size: declared });
  });

  it('zip olmayan ya da kırpılmış dosyaya güvenilmez; okuyucu açamaz: XLSX_UNREADABLE', async () => {
    const good = await bigXlsx(5);
    expect(zipEntries(new TextEncoder().encode('a,b\n1,2'))).toBeNull();
    expect(zipEntries(good.subarray(0, good.length - 30))).toBeNull();
    expect(await checkZipSize(good.subarray(0, 200), MB)).toEqual({ ok: false, reason: 'untrusted' });
    expect((await fileError(readTable('k.xlsx', good.subarray(0, 200)))).code).toBe('XLSX_UNREADABLE');
  });

  it('sıkıştırmasız parça ve sınırın tam üstü/altı', async () => {
    const z = makeZip([{ name: 'a.xml', data: new Uint8Array(1000), store: true }]);
    expect(await checkZipSize(z, 1000)).toEqual({ ok: true, size: 1000 });
    expect(await checkZipSize(z, 999)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });
});

describe('zip bombası', () => {
  it('beyanı doğru bomba: dizindeki boyut sınırı aşınca açmadan reddedilir', async () => {
    const z = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(8 * MB) }]);
    expect(z.length).toBeLessThan(64 * 1024);
    expect(await checkZipSize(z, 4 * MB)).toEqual({ ok: false, reason: 'tooLarge', size: 8 * MB });
  });

  it('yalan beyanlı bomba: dizinde 100 bayt yazsa da gerçekten açılan sayılır ve sınırda durulur', async () => {
    const z = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(8 * MB), declaredSize: 100 }]);
    expect(zipDeclaredSize(z)).toBe(100);
    const r = await checkZipSize(z, 4 * MB);
    expect(r).toMatchObject({ ok: false, reason: 'tooLarge' });
    // Sınırı aşınca durur: tamamını (8 MB) açmaz
    expect((r as { size: number }).size).toBeLessThan(8 * MB);
  });

  it('ZIP64 beyanı (5 GB) okunur ve reddedilir', async () => {
    const z = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(10), zip64Size: 5 * 1024 * MB }]);
    expect(zipEntries(z)![0]!.uncompressedSize).toBe(5 * 1024 * MB);
    expect(await checkZipSize(z, 200 * MB)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('çok fazla parça açılmadan reddedilir', async () => {
    const z = makeZip([{ name: 'a.xml', data: new Uint8Array(1), store: true }], { count: ZIP_MAX_ENTRIES + 1 });
    expect(await checkZipSize(z, 200 * MB)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('varsayılan sınır 200 MB: 210 MB açılan .xlsx `XLSX_TOO_LARGE` ile, exceljs açmadan reddedilir', async () => {
    const z = makeZip([
      { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') },
      { name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(210 * MB) },
    ]);
    expect(z.length).toBeLessThan(MB);
    const e = await fileError(readTable('bomba.xlsx', z));
    expect(e.code).toBe('XLSX_TOO_LARGE');
    expect(e.message).toMatch(/açılmış hâli çok büyük/);
    // tarife okuması da aynı denetimden geçer
    expect((await fileError(readTariffFile('bomba.xlsx', z))).code).toBe('XLSX_TOO_LARGE');
  });

  it('sınır seçenekle küçültülür; yalan beyanlı bomba da `XLSX_TOO_LARGE`', async () => {
    const z = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(3 * MB), declaredSize: 10 }]);
    expect((await fileError(readTable('bomba.xlsx', z, { maxUncompressedBytes: 2 * MB }))).code).toBe('XLSX_TOO_LARGE');
  });
});

describe('satır sınırı', () => {
  it('CSV: sınır kadar veri satırı okunur, bir fazlası `TOO_MANY_ROWS` ({limit} Türkçe biçimli)', async () => {
    expect((await readTable('f.csv', bigCsv(10), { maxRows: 10 })).rows).toHaveLength(10);
    const e = await fileError(readTable('f.csv', bigCsv(11), { maxRows: 10 }));
    expect(e.code).toBe('TOO_MANY_ROWS');
    expect(e.params).toEqual({ limit: '10' });
    const big = await fileError(readTable('f.csv', bigCsv(3), { maxRows: 2 }));
    expect(big.message).toContain('en çok 2');
  });

  it('XLSX: sınır kadar okunur, fazlası reddedilir; varsayılan 200.000', async () => {
    expect((await readTable('f.xlsx', await bigXlsx(10), { maxRows: 10 })).rows).toHaveLength(10);
    expect((await fileError(readTable('f.xlsx', await bigXlsx(11), { maxRows: 10 }))).code).toBe('TOO_MANY_ROWS');
    // sayfanın kendisi sınırın çok üstündeyse matris kurulmadan
    expect((await fileError(readTable('f.xlsx', await bigXlsx(60), { maxRows: 10 }))).params).toEqual({ limit: '10' });
    expect(DEFAULT_MAX_ROWS).toBe(200_000);
    expect(DEFAULT_MAX_UNCOMPRESSED_BYTES).toBe(200 * MB);
    expect(tooManyRowsError(DEFAULT_MAX_ROWS).message).toContain('en çok 200.000');
  });

  it('tarife dosyası: CSV ve XLSX sayfası satır sınırına uyar', async () => {
    const csv = new TextEncoder().encode(['Ağırlık;A;B', ...Array.from({ length: 12 }, (_, i) => `${i + 1};${i};${i}`)].join('\n'));
    expect((await readTariffFile('t.csv', csv, { maxRows: 13 })).prices).toHaveLength(13);
    expect((await fileError(readTariffFile('t.csv', csv, { maxRows: 12 }))).code).toBe('TOO_MANY_ROWS');
    expect((await fileError(readTariffFile('t.xlsx', await bigXlsx(30), { maxRows: 20 }))).code).toBe('TOO_MANY_ROWS');
    expect((await readTariffFile('t.xlsx', await bigXlsx(30), { maxRows: 31 })).prices).toHaveLength(31);
  });
});

// ---------------------------------------------------------------------------------------------
// R2 (Mesaj 6 incelemesi): denetimi atlatan yapılar. Okuyucu (exceljs → JSZip) başka bir dizin okuyabiliyorsa dosya açılmaz;
// açılırsa sayım JSZip'in kendi görüşüyle yapılır.

/** İncelemedeki kanıt: 32 bitlik zararsız "yem" dizin + ZIP64 kayıtlarında gerçek (bomba) dizin; EOCD disk alanı 0xFFFF. */
function decoyZip(bombSize: number, bombName = 'xl/worksheets/sheet1.xml'): Uint8Array {
  const local = (name: Buffer, method: number, data: Buffer, usize: number) => {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(name.length, 26);
    return Buffer.concat([h, name, data]);
  };
  const cen = (name: Buffer, method: number, csize: number, usize: number, off: number) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(method, 10);
    h.writeUInt32LE(csize, 20);
    h.writeUInt32LE(usize, 24);
    h.writeUInt16LE(name.length, 28);
    h.writeUInt32LE(off, 42);
    return Buffer.concat([h, name]);
  };
  const bName = Buffer.from(bombName);
  const bData = deflateRawSync(Buffer.alloc(bombSize, 0x20));
  const dName = Buffer.from('a.txt');
  const dData = Buffer.from('hi');
  const parts: Buffer[] = [];
  let off = 0;
  const push = (b: Buffer) => {
    parts.push(b);
    const at = off;
    off += b.length;
    return at;
  };
  const bOff = push(local(bName, 8, bData, bombSize));
  const dOff = push(local(dName, 0, dData, dData.length));
  const decoyCd = cen(dName, 0, dData.length, dData.length, dOff);
  const decoyCdOff = push(decoyCd);
  const realCd = cen(bName, 8, bData.length, bombSize, bOff);
  const realCdOff = push(realCd);
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeBigUInt64LE(1n, 24);
  z64.writeBigUInt64LE(1n, 32);
  z64.writeBigUInt64LE(BigInt(realCd.length), 40);
  z64.writeBigUInt64LE(BigInt(realCdOff), 48);
  const z64Off = push(z64);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(z64Off), 8);
  loc.writeUInt32LE(1, 16);
  push(loc);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 4);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(decoyCd.length, 12);
  eocd.writeUInt32LE(decoyCdOff, 16);
  push(eocd);
  return new Uint8Array(Buffer.concat(parts));
}

async function loadJsZip(bytes: Uint8Array): Promise<JsZipLike> {
  const mod = (await import('jszip')) as unknown as { default: { loadAsync(b: Uint8Array): Promise<JsZipLike> } };
  return mod.default.loadAsync(bytes);
}

describe('kapalı uçlu yapı ve okuyucunun gözüyle sayım (R2)', () => {
  it('yalan merkez dizin (disk alanı 0xFFFF, ZIP64 kayıtlarında başka dizin): kendi ayrıştırmaya güvenilmez, JSZip görüşü bombayı sayar', async () => {
    const z = decoyZip(3 * MB);
    expect(z.length).toBeLessThan(64 * 1024);
    expect(zipEntries(z)).toBeNull();
    expect(await checkZipSize(z, MB)).toEqual({ ok: false, reason: 'untrusted' });
    expect((await fileError(readTable('yem.xlsx', z, { maxUncompressedBytes: MB }))).code).toBe('XLSX_TOO_LARGE');
    expect((await fileError(readTariffFile('yem.xlsx', decoyZip(3 * MB, 'xl/media/image1.png'), { maxUncompressedBytes: MB }))).code).toBe('XLSX_TOO_LARGE');
    // dizin denetimi atlatılsa bile okuyucunun kendi ayrıştırmasıyla sayım sınırda durur
    expect(await countJsZipInflated(await loadJsZip(z), MB)).toMatchObject({ ok: false, reason: 'tooLarge' });
    // xl/media (görsel) parçası da sayılır
    expect(await countJsZipInflated(await loadJsZip(decoyZip(3 * MB, 'xl/media/image1.png')), MB)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('disk alanları 0 değilse kendi ayrıştırmaya güvenilmez', async () => {
    const good = makeZip([{ name: 'a.xml', data: new Uint8Array(100) }]);
    expect(await checkZipSize(good, MB)).toMatchObject({ ok: true });
    for (const at of [4, 6]) {
      const bad = Buffer.from(good);
      bad.writeUInt16LE(1, bad.length - 22 + at);
      expect(await checkZipSize(new Uint8Array(bad), MB)).toEqual({ ok: false, reason: 'untrusted' });
    }
  });

  it('başa önek ya da sona bayt eklenmiş xlsx: kendi ayrıştırmaya güvenilmez ama okunur (Mesaj 6 öncesi gibi)', async () => {
    const good = Buffer.from(await bigXlsx(5));
    const expected = await readTable('iyi.xlsx', new Uint8Array(good));
    // başa: yine "PK\x03\x04" ile başlar (biçim tanınır), ofsetler kayar; JSZip kaydırarak okur
    const prepended = new Uint8Array(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60), good]));
    expect(await checkZipSize(prepended, 10 * MB)).toEqual({ ok: false, reason: 'untrusted' });
    expect(await readTable('on.xlsx', prepended)).toEqual(expected);
    const trailing = new Uint8Array(Buffer.concat([good, Buffer.from('çöp')]));
    expect(await checkZipSize(trailing, 10 * MB)).toEqual({ ok: false, reason: 'untrusted' });
    expect(await readTable('son.xlsx', trailing)).toEqual(expected);
    expect((await readTariffFile('son.xlsx', trailing)).prices?.length).toBeGreaterThan(0);
    // BOM önekli .xlsx (ilk bayt "PK" değil) Mesaj 6'dan önce de tanınmıyordu (`detectFormat`); değişmedi
    const bom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]));
    expect((await fileError(readTable('bom.xlsx', bom))).code).toBe('XLSX_UNREADABLE');
    // yapısı güvenilmez (sona bayt eklenmiş) yalan beyanlı bomba yine sayılır ve reddedilir
    const bombTrailing = new Uint8Array(Buffer.concat([Buffer.from(makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(3 * MB), declaredSize: 10 }])), Buffer.from('x')]));
    expect(await checkZipSize(bombTrailing, MB)).toEqual({ ok: false, reason: 'untrusted' });
    expect((await fileError(readTable('b.xlsx', bombTrailing, { maxUncompressedBytes: MB }))).code).toBe('XLSX_TOO_LARGE');
  });

  it('ZIP64 bulucusu varken 32 bitlik kayıt ZIP64 istemiyorsa güvenilmez; tutarlı ZIP64 okunur', async () => {
    const z = decoyZip(10);
    const fixed = Buffer.from(z);
    fixed.writeUInt16LE(0, fixed.length - 22 + 4); // disk alanı düzeltildi: ZIP64 bulucusu yine de tutarsız
    expect(zipEntries(new Uint8Array(fixed))).toBeNull();
    const z64 = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(10), zip64Size: 10 }]);
    expect(zipEntries(z64)![0]!.uncompressedSize).toBe(10);
  });

  it('depodaki bütün örnek ve fikstür Excel dosyaları denetimden geçer ve okunur', async () => {
    const roots = [path.resolve(import.meta.dirname, '../../../samples'), path.resolve(import.meta.dirname, 'fixtures')];
    const files = roots.flatMap((r) => fs.readdirSync(r, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.xlsx')).map((f) => path.join(r, f)));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const bytes = new Uint8Array(fs.readFileSync(f));
      expect(await checkZipSize(bytes, 200 * MB), f).toMatchObject({ ok: true });
      expect(await countJsZipInflated(await loadJsZip(bytes), 200 * MB), f).toMatchObject({ ok: true });
    }
  });
});
