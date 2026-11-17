/**
 * Y59: PDF ön denetimi (`pdfGuard`), veritabanısız saf testler. Elle kurulmuş küçük PDF baytları: Flate'ten önce başka
 * süzgeç, Flate → Flate, LZW, RunLength, Brotli, şifreli belge (RC4, AESV2; gerçek araçla şifrelenmiş RC4 ve AES-256
 * örnekleri `pdf-fixtures/`), çok sayıda `stream` sözcüğü ve süre sınırı. Uçtan uca 413 / 422 hâli `fileWorker.test.ts`.
 * PDF yapı taşları `pdfBytes.ts`; büyük girdilerin süre ölçümü kapı dışında: `pdfGuard.perf.test.ts` (`npm run test:perf`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPdfText } from '../src/lib/fileWorkers.ts';
import { checkPdfInflatedSize } from '../src/workers/pdfGuard.ts';
import { manyStreams, MB, parseCeilingCases, pdfWith } from './pdfBytes.ts';

const zeros = (n: number) => Buffer.alloc(n);
/** Sıkışmayan (sayılabilir) içerik: rastgele ama tekrarlanabilir baytlar. */
const noise = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919 + (i >> 3)) & 0xff));

const ahx = (b: Buffer) => Buffer.from(b.toString('hex') + '>', 'latin1');
function a85(b: Buffer): Buffer {
  let s = '';
  for (let i = 0; i < b.length; i += 4) {
    const chunk = Buffer.concat([b.subarray(i, i + 4), Buffer.alloc(4)]).subarray(0, 4);
    const n = chunk.readUInt32BE(0);
    const len = Math.min(4, b.length - i);
    if (n === 0 && len === 4) {
      s += 'z';
      continue;
    }
    let v = n;
    const d: string[] = [];
    for (let k = 0; k < 5; k++) {
      d.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    s += d.slice(0, len + 1).join('');
  }
  return Buffer.from(s + '~>', 'latin1');
}
/** RunLength: 128'lik tekrarlar (2 bayttan 128 bayt), artanı tek tek. */
function rl(b: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    let run = 1;
    while (i + run < b.length && run < 128 && b[i + run] === b[i]) run++;
    if (run >= 2) {
      out.push(257 - run, b[i]!);
      i += run;
    } else {
      out.push(0, b[i]!);
      i++;
    }
  }
  out.push(128);
  return Buffer.from(out);
}
/** LZW (9 bit; 200 kodda bir tablo temizlenir ki genişlik değişmesin). Çözücü 9–12 bit ve erken değişimi destekler. */
function lzw(data: Buffer): Buffer {
  const out: number[] = [];
  let acc = 0;
  let nb = 0;
  const emit = (c: number) => {
    acc = (acc << 9) | c;
    nb += 9;
    while (nb >= 8) {
      out.push((acc >>> (nb - 8)) & 0xff);
      nb -= 8;
    }
    acc &= (1 << nb) - 1;
  };
  let dict = new Map<number, number>();
  let next = 258;
  let codes = 0;
  emit(256);
  let p = data[0]!;
  for (let i = 1; i < data.length; i++) {
    const c = data[i]!;
    const hit = dict.get(p * 256 + c);
    if (hit !== undefined) {
      p = hit;
      continue;
    }
    emit(p);
    codes++;
    dict.set(p * 256 + c, next++);
    p = c;
    if (codes >= 200) {
      emit(256);
      dict = new Map();
      next = 258;
      codes = 0;
    }
  }
  emit(p);
  emit(257);
  if (nb > 0) out.push((acc << (8 - nb)) & 0xff);
  return Buffer.from(out);
}

describe('Y59: Flate dışı ve zincirli süzgeçler sayılır (ham deneme bunları göremez)', () => {
  const text = noise(50_000);
  it('çözücüler doğru: tek aşamalı LZW, RunLength, ASCII85, ASCIIHex akışının sayılan boyu içeriğin boyuna eşit', async () => {
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter /LZWDecode >>`, lzw(text)), MB)).size).toBe(text.length);
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter /RunLengthDecode >>`, rl(text)), MB)).size).toBe(text.length);
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter /ASCII85Decode >>`, a85(text)), MB)).size).toBe(text.length);
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter /AHx >>`, ahx(text)), MB)).size).toBe(text.length);
    // LZW tekrar (KwKwK) durumu: sıfırlar
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter /LZW >>`, lzw(zeros(30_000))), MB)).size).toBe(30_000);
  });

  const BOMBS: Record<string, (n: number) => { dict: string; data: Buffer; extra?: string[] }> = {
    'ASCIIHex → Flate': (n) => ({ dict: '<< /Filter [/ASCIIHexDecode /FlateDecode] >>', data: ahx(deflateSync(zeros(n))) }),
    'ASCII85 → Flate': (n) => ({ dict: '<< /Filter [/A85 /Fl] >>', data: a85(deflateSync(zeros(n))) }),
    'Flate → Flate': (n) => ({ dict: '<< /Filter [/FlateDecode /FlateDecode] >>', data: deflateSync(deflateSync(zeros(n))) }),
    LZW: (n) => ({ dict: '<< /Filter /LZWDecode >>', data: lzw(zeros(n)) }),
    RunLength: (n) => ({ dict: '<< /Filter /RunLengthDecode >>', data: rl(zeros(n)) }),
    Brotli: (n) => ({ dict: '<< /Filter /BrotliDecode >>', data: brotliCompressSync(zeros(n)) }),
    'dolaylı ve kaçışlı zincir': (n) => ({ dict: '<< /Filter 6 0 R /Length 7 0 R >>', data: ahx(deflateSync(zeros(n))), extra: ['6 0 obj [/#41SCIIHexDecode /FlateDecode] endobj\n'] }),
  };
  for (const [name, make] of Object.entries(BOMBS)) {
    it(`${name}: sınırı aşan reddedilir, altındaki geçer`, async () => {
      const big = make(4 * MB);
      const r = await checkPdfInflatedSize(pdfWith(big.dict, big.data, { extra: big.extra }), 2 * MB);
      expect(r).toMatchObject({ ok: false, reason: 'size' });
      const small = make(MB);
      expect((await checkPdfInflatedSize(pdfWith(small.dict, small.data, { extra: small.extra }), 2 * MB)).ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Şifreli belge

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}

/** Boş kullanıcı parolalı Standart şifre (R3 RC4-128 ya da R4 AESV2), nesne 4'ün akışı şifreli. */
function encryptedPdf(plain: Buffer, method: 'rc4' | 'aes'): Buffer {
  const o = crypto.createHash('sha256').update('owner').digest();
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const p = -3904;
  const pb = Buffer.alloc(4);
  pb.writeInt32LE(p);
  let key = crypto.createHash('md5').update(PAD).update(o).update(pb).update(id).digest();
  for (let i = 0; i < 50; i++) key = crypto.createHash('md5').update(key).digest();
  const md = crypto.createHash('md5').update(key).update(Buffer.from([4, 0, 0, 0, 0]));
  if (method === 'aes') md.update('sAlT');
  const objKey = md.digest();
  let data: Buffer;
  if (method === 'rc4') data = rc4(objKey, plain);
  else {
    const iv = Buffer.alloc(16, 7);
    const c = crypto.createCipheriv('aes-128-cbc', objKey, iv);
    data = Buffer.concat([iv, c.update(plain), c.final()]);
  }
  const enc =
    method === 'rc4'
      ? `6 0 obj << /Filter /Standard /V 2 /R 3 /Length 128 /O <${o.toString('hex')}> /U <${'00'.repeat(32)}> /P ${p} >> endobj\n`
      : `6 0 obj << /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${o.toString('hex')}> /U <${'00'.repeat(32)}> /P ${p} >> endobj\n`;
  return pdfWith(`<< /Length ${data.length} /Filter /FlateDecode >>`, data, { extra: [enc], trailer: `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]` });
}

describe('Y59: şifreli belgenin akışları çözülüp sayılır', () => {
  for (const method of ['rc4', 'aes'] as const) {
    it(`${method}: bomba reddedilir, küçük belge geçer`, async () => {
      expect(await checkPdfInflatedSize(encryptedPdf(deflateSync(zeros(4 * MB)), method), 2 * MB)).toMatchObject({ ok: false, reason: 'size' });
      const ok = await checkPdfInflatedSize(encryptedPdf(deflateSync(zeros(MB)), method), 2 * MB);
      expect(ok).toEqual({ ok: true, size: MB });
    });
  }

  it('gerçek araçla şifrelenmiş örnekler (RC4 R3, AES-256 R6): içerik akışları çözülür, aynı boy; sınırın çok altında', async () => {
    const sizes: number[] = [];
    for (const name of ['encrypted-rc4-12p.pdf', 'encrypted-aes256-12p.pdf']) {
      const r = await checkPdfInflatedSize(fs.readFileSync(new URL(`./pdf-fixtures/${name}`, import.meta.url)), 2 * MB);
      expect(r.ok, name).toBe(true);
      sizes.push(r.size);
    }
    // eski denetim şifreli akışları hiç saymıyordu (0); 12 sayfanın içerik akışları
    expect(sizes[0]).toBeGreaterThan(12 * 50);
    expect(sizes[1]).toBe(sizes[0]);
  });
});

describe('Y59: çok sayıda stream sözcüğü ve süre sınırı', () => {
  it('yüz binlerce "stream" sözcüğü zlib açmadan geçer; süre sınırı aşılınca reason "time" (süre: pdfGuard.perf.test.ts)', async () => {
    const many = manyStreams();
    expect((await checkPdfInflatedSize(many, 2 * MB)).ok).toBe(true);
    expect(await checkPdfInflatedSize(many, 2 * MB, { deadlineMs: -1 })).toMatchObject({ ok: false, reason: 'time' });
  });

  it('düz Flate akışı bugünkü gibi bir kez sayılır (ham deneme ve zincir üst üste eklenmez)', async () => {
    const r = await checkPdfInflatedSize(pdfWith(`<< /Filter /FlateDecode >>`, deflateSync(zeros(MB))), 2 * MB);
    expect(r).toEqual({ ok: true, size: MB });
  });
});

describe('Y59 güvenlik incelemesi: ayrıştırma tavanları (dev sözlük, dev dizi, uzun zincir)', () => {
  it('akış sözlüğünde dev /Filter dizisi (1M giriş, ~4 MB) ve dev sözlük: "complex"; zararsız eşleri geçer (süre: pdfGuard.perf.test.ts)', async () => {
    const c = parseCeilingCases();
    const data = c.data;
    expect((await checkPdfInflatedSize(c.arrayBase, 300 * MB)).ok).toBe(true);
    expect(await checkPdfInflatedSize(c.array, 300 * MB)).toMatchObject({ ok: false, reason: 'complex' });
    expect((await checkPdfInflatedSize(c.dictBase, 300 * MB)).ok).toBe(true);
    expect(await checkPdfInflatedSize(c.dict, 300 * MB)).toMatchObject({ ok: false, reason: 'complex' });
    // dosya okuma yolunda: 422 FILE_TOO_COMPLEX (pdfjs'e hiç gitmez)
    await expect(readPdfText(pdfWith(`<< /Filter [${'/Fl '.repeat(10_000)}] >>`, data), { companyId: 'A' })).rejects.toMatchObject({ statusCode: 422, code: 'FILE_TOO_COMPLEX' });
  });

  it('dolaylı /Filter dev diziye, süzgeç zinciri 16 üstü: "complex"; 16 ve altı sayılır', async () => {
    const data = deflateSync(Buffer.from('BT ET'));
    const indirect = pdfWith('<< /Filter 6 0 R >>', data, { extra: [`6 0 obj [${'/AHx '.repeat(100_000)}] endobj\n`] });
    expect(await checkPdfInflatedSize(indirect, MB)).toMatchObject({ ok: false, reason: 'complex' });
    expect(await checkPdfInflatedSize(pdfWith(`<< /Filter [${'/AHx '.repeat(17)}] >>`, data), MB)).toMatchObject({ ok: false, reason: 'complex' });
    expect((await checkPdfInflatedSize(pdfWith(`<< /Filter [${'/AHx '.repeat(15)}/Fl] >>`, data), MB)).ok).toBe(true);
  });

  it('yanlış alarm yok: metinde çok sayıda "trailer" sözcüğü ve başka nesnede büyük dizi olan belge geçer', async () => {
    const plain = Buffer.from('BT (trailer trailer) Tj ET');
    const pdf = pdfWith(`<< /Length ${plain.length} >>`, plain, {
      extra: [`7 0 obj [${'0 '.repeat(20_000)}] endobj\n`, ...Array.from({ length: 200 }, (_, i) => `% trailer ${i}\n`)],
    });
    expect(await checkPdfInflatedSize(pdf, MB)).toEqual({ ok: true, size: 0 });
  });
});
