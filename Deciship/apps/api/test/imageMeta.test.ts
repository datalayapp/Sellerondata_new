import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { orientationTiff, readTiffOrientation, stripImageMetadata } from '../src/lib/imageMeta.ts';
import {
  ADOBE, APP0, b1Jpeg, b1Png, b1Webp, chunk, COM, DHT, DQT, EOI, exifSeg, GPS_TEXT, hasSecret, ICC, ICCP, IDAT, IEND, IHDR, image, IPTC, jpeg,
  latin, MAKE, minimalExif, MPF, ORIENT, PHYS, PNG_SIG, pngValid, riff, SCAN, SECRET, seg, SOF, SOI, SOS, tiff, VP8, vp8x, webp, XMP, type Entry,
} from './imageBytes.ts';

/**
 * Y24: ölçüm fotoğrafının üst verisi (EXIF konum, XMP, IPTC) kaydetmeden önce kalkar. Saf işlev; veritabanı yok. Bütün
 * görüntüler elle, bayt bayt kurulur (yapı taşları `imageBytes.ts`): hangi kesimin kalıp hangisinin gittiği tam olarak
 * görülsün. Büyük girdilerin süre sınırı (B1) kapı dışında: `imageMeta.perf.test.ts` (`npm run test:perf`).
 */

describe('JPEG', () => {
  it('EXIF (konum, cihaz), XMP, IPTC ve COM kalkar; yön 6 asgari EXIF ile aynı yerde; ICC ve Adobe kalır; görüntü verisi bayt bayt aynı', () => {
    const exif = exifSeg(tiff([MAKE('SecretCam'), ORIENT(6), GPS_TEXT()]));
    const input = jpeg(APP0, exif, XMP, ICC, IPTC, ADOBE, COM);
    expect(hasSecret(input)).toBe(true);
    const r = stripImageMetadata(input);
    expect(r).toMatchObject({ outcome: 'stripped', format: 'jpeg', orientation: 6 });
    expect(hasSecret(r.buffer)).toBe(false);
    expect(r.buffer.includes(latin('SecretCam'))).toBe(false);
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, minimalExif(6), ICC, ADOBE, image]))).toBe(true);
    expect(readTiffOrientation(orientationTiff(6))).toBe(6);
  });

  it('küçük sonlu (II) TIFF ve EXIF ilk kesimken de yön korunur', () => {
    const r = stripImageMetadata(jpeg(exifSeg(tiff([ORIENT(8), MAKE('X')], true)), APP0));
    expect(r.orientation).toBe(8);
    expect(r.buffer.equals(Buffer.concat([SOI, minimalExif(8), APP0, image]))).toBe(true);
  });

  it('yön 1, yön yok ya da yön etiketi bozuk: EXIF hiç yazılmaz', () => {
    for (const entries of [[ORIENT(1), MAKE('A')], [MAKE('A')], [[0x0112, 4, 1, 6] as Entry], [ORIENT(9)], [ORIENT(0)]]) {
      const r = stripImageMetadata(jpeg(APP0, exifSeg(tiff(entries))));
      expect(r.outcome).toBe('stripped');
      expect(r.orientation).toBeNull();
      expect(r.buffer.equals(Buffer.concat([SOI, APP0, image]))).toBe(true);
    }
  });

  it('okunamayan TIFF (başlık yanlış, IFD dışarıda): EXIF kalkar, yön yazılmaz', () => {
    for (const t of [latin('XX\0*\0\0\0\x08'), latin('MM\0\x2b\0\0\0\x08'), latin('MM\0*\0\0\xff\xff'), latin('MM')]) {
      const r = stripImageMetadata(jpeg(APP0, exifSeg(t)));
      expect(r).toMatchObject({ outcome: 'stripped', orientation: null });
      expect(r.buffer.equals(Buffer.concat([SOI, APP0, image]))).toBe(true);
    }
  });

  it('izin listesi: her taşıyıcı kalkar (APP1 XMP, APP3–APP13, APP11 JUMBF/C2PA, APP15, COM, JFXX, APP2 FPXR/MPF, APP14 Adobe olmayan, JPGn)', () => {
    const carriers: [string, Buffer][] = [
      ['APP1 XMP', XMP],
      ['APP3', seg(0xe3, latin(`META${SECRET}`))],
      ['APP11 JUMBF', seg(0xeb, Buffer.concat([latin('JP\0\x01\0\0\0\x01'), latin(`jumb c2pa ${SECRET}`)]))],
      ['APP12 Ducky', seg(0xec, latin(`Ducky${SECRET}`))],
      ['APP13 IPTC', IPTC],
      ['APP15', seg(0xef, latin(SECRET))],
      ['COM', seg(0xfe, latin(SECRET))],
      ['APP0 JFXX', seg(0xe0, latin(`JFXX\0\x10${SECRET}`))],
      ['APP0 AVI1', seg(0xe0, latin(`AVI1${SECRET}`))],
      ['APP2 FPXR', seg(0xe2, latin(`FPXR\0${SECRET}`))],
      ['APP2 MPF', Buffer.concat([MPF.subarray(0, 2), Buffer.from([0, MPF.length - 2 + SECRET.length]), MPF.subarray(4), latin(SECRET)])],
      ['APP14 başka', seg(0xee, latin(`Other${SECRET}`))],
      ['JPG0 (F0)', seg(0xf0, latin(SECRET))],
    ];
    for (const [name, c] of carriers) {
      const r = stripImageMetadata(jpeg(APP0, c));
      expect(r.outcome, name).toBe('stripped');
      expect(hasSecret(r.buffer), name).toBe(false);
      expect(r.buffer.equals(Buffer.concat([SOI, APP0, image])), name).toBe(true);
    }
  });

  it('temiz dosya aynen döner (aynı nesne): testlerin örnek JPEG\'i ve EOI\'siz kısa dosya dahil', () => {
    const clean = jpeg(APP0, ICC, ADOBE);
    const r = stripImageMetadata(clean);
    expect(r.outcome).toBe('clean');
    expect(r.buffer).toBe(clean);
    const helper = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );
    expect(stripImageMetadata(helper)).toMatchObject({ outcome: 'clean' });
    expect(stripImageMetadata(helper).buffer).toBe(helper);
    const tagged = Buffer.concat([helper, latin('FIRM-B-123')]);
    expect(stripImageMetadata(tagged).buffer).toBe(tagged);
  });

  it('EOI sonrası ek veri (ikinci görüntü kendi EXIF\'iyle) ve ona işaret eden MPF kalkar', () => {
    const second = jpeg(exifSeg(tiff([GPS_TEXT()])));
    const r = stripImageMetadata(Buffer.concat([jpeg(APP0, exifSeg(tiff([ORIENT(3)])), MPF, ICC), second]));
    expect(r).toMatchObject({ outcome: 'stripped', orientation: 3 });
    expect(hasSecret(r.buffer)).toBe(false);
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, minimalExif(3), ICC, image]))).toBe(true);
  });

  it('yalnız EOI sonrası ek veri varsa da kalkar', () => {
    const r = stripImageMetadata(Buffer.concat([jpeg(APP0), latin(`trailer ${SECRET}`)]));
    expect(r.outcome).toBe('stripped');
    expect(r.buffer.equals(jpeg(APP0))).toBe(true);
  });

  it('EOI yoksa (görüntü verisinde kesik): başlık temizlenir, kalan veri alındığı gibi; MPF\'li dosyada okunamaz sayılır', () => {
    const cut = Buffer.concat([SOI, APP0, exifSeg(tiff([GPS_TEXT()])), DQT, SOF, DHT, SOS, SCAN.subarray(0, 5)]);
    const r = stripImageMetadata(cut);
    expect(r.outcome).toBe('stripped');
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, DQT, SOF, DHT, SOS, SCAN.subarray(0, 5)]))).toBe(true);
    const withMpf = Buffer.concat([SOI, APP0, MPF, DQT, SOF, DHT, SOS, SCAN.subarray(0, 5), jpeg(exifSeg(tiff([GPS_TEXT()])))]);
    // ikinci görüntünün SOI'si tarama verisinde: okunamaz, temiz sayılmaz
    expect(stripImageMetadata(withMpf)).toMatchObject({ outcome: 'unparsed', buffer: withMpf });
    const mpfNoEoi = Buffer.concat([SOI, APP0, MPF, DQT, SOF, DHT, SOS, SCAN.subarray(0, 5)]);
    expect(stripImageMetadata(mpfNoEoi)).toMatchObject({ outcome: 'unparsed', buffer: mpfNoEoi });
  });

  it('aşamalı JPEG: taramalar arası DHT içindeki FF D9 baytı EOI sanılmaz; taramalar arası APP1 ve COM kalkar', () => {
    const trickyDht = seg(0xc4, Buffer.from([0x10, 2, ...Array(15).fill(0), 0xff, 0xd9]));
    const between = exifSeg(tiff([GPS_TEXT()]));
    const comBetween = seg(0xfe, latin(SECRET));
    const input = Buffer.concat([SOI, APP0, DQT, SOF, DHT, SOS, SCAN, between, trickyDht, comBetween, SOS, SCAN, EOI, latin(SECRET)]);
    const r = stripImageMetadata(input);
    expect(r.outcome).toBe('stripped');
    expect(hasSecret(r.buffer)).toBe(false);
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, DQT, SOF, DHT, SOS, SCAN, trickyDht, SOS, SCAN, EOI]))).toBe(true);
  });

  it('tarama içindeki sahte işaret (yapısı tutmayan tablo, SOI, SOF) EOI\'yi atlatamaz: okunamaz', () => {
    const fakeDht = Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0x30]), Buffer.alloc(0x2e, 0x55)]); // sayılar tutmuyor
    const fakeSoi = Buffer.from([0xff, 0xd8]);
    const fakeSof = seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
    for (const fake of [fakeDht, fakeSoi, fakeSof]) {
      const input = Buffer.concat([SOI, APP0, DQT, SOF, DHT, SOS, SCAN, fake, SCAN, EOI, jpeg(exifSeg(tiff([GPS_TEXT()])))]);
      expect(stripImageMetadata(input)).toMatchObject({ outcome: 'unparsed', buffer: input });
    }
  });

  it('kesimler arası artık baytlar libjpeg gibi atlanır (atılır); doldurma baytları kalır', () => {
    const input = Buffer.concat([SOI, APP0, latin('xx\x12'), DQT, Buffer.from([0x00, 0x34]), SOF, DHT, SOS, SCAN, EOI]);
    const r = stripImageMetadata(input);
    expect(r.outcome).toBe('stripped');
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, image]))).toBe(true);
    const filledDqt = Buffer.concat([Buffer.from([0xff]), DQT]);
    const filled = Buffer.concat([SOI, APP0, exifSeg(tiff([MAKE('A')])), filledDqt, SOF, DHT, SOS, SCAN, EOI]);
    expect(stripImageMetadata(filled).buffer.equals(Buffer.concat([SOI, APP0, filledDqt, SOF, DHT, SOS, SCAN, EOI]))).toBe(true);
  });

  it('iki kez temizlemek bir şey değiştirmez; asgari EXIF olduğu gibi kalır, yanındaki XMP ve ikinci EXIF kalkar', () => {
    const once = stripImageMetadata(jpeg(APP0, exifSeg(tiff([ORIENT(6), GPS_TEXT()])), XMP)).buffer;
    expect(stripImageMetadata(once)).toMatchObject({ outcome: 'clean', buffer: once, orientation: 6 });
    const r = stripImageMetadata(jpeg(APP0, minimalExif(6), XMP, exifSeg(tiff([GPS_TEXT()]))));
    expect(r).toMatchObject({ outcome: 'stripped', orientation: 6 });
    expect(r.buffer.equals(Buffer.concat([SOI, APP0, minimalExif(6), image]))).toBe(true);
  });

  it('bozuk yapı: girdi aynen döner (unparsed), asla yarım çıktı yok', () => {
    const exif = exifSeg(tiff([GPS_TEXT()]));
    const bad = [
      Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff]), latin('Exif\0\0')]), // boy taşıyor
      Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), image]), // boy < 2
      Buffer.concat([SOI, exif, Buffer.from([0xff, 0x00]), image]), // SOS'tan önce 0xFF00
      Buffer.concat([SOI, exif, Buffer.from([0xff, 0xd0]), image]), // SOS'tan önce RST
      Buffer.concat([SOI, exif, Buffer.from([0xff, 0x01]), image]), // SOS'tan önce TEM
      Buffer.concat([SOI, exif, EOI]),
      Buffer.concat([SOI, APP0, exif, DQT]), // SOS yok
      Buffer.concat([SOI, exif, SOI, image]),
      Buffer.concat([SOI, exif, Buffer.from([0xff, 0xff, 0xff])]),
      Buffer.concat([SOI, exif, latin('artık bayt, işaret yok')]),
      Buffer.concat([SOI, exif, seg(0xdb, Buffer.alloc(10, 1)), SOF, DHT, SOS, SCAN, EOI]), // DQT yapısı tutmuyor
      Buffer.concat([SOI, exif, DQT, seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 2, 1, 0x11, 0])), DHT, SOS, SCAN, EOI]), // SOF bileşen sayısı
      Buffer.concat([SOI, exif, DQT, SOF, DHT, seg(0xda, Buffer.from([1, 1, 0])), SCAN, EOI]), // SOS boyu
      Buffer.concat([SOI, exif, seg(0xdc, Buffer.from([0, 1])), DQT, SOF, DHT, SOS, SCAN, EOI]), // SOS'tan önce DNL
    ];
    for (const b of bad) {
      const r = stripImageMetadata(b);
      expect(r.outcome).toBe('unparsed');
      expect(r.buffer).toBe(b);
    }
  });

  it('her kesilme noktasında: atmaz; SOS\'tan önce kesikse aynen döner, sonra kesikse görüntü verisi alındığı gibi kalır', () => {
    const full = jpeg(APP0, exifSeg(tiff([ORIENT(6), GPS_TEXT()])), XMP, ICC, IPTC);
    const sosAt = full.indexOf(SOS);
    for (let n = 3; n < full.length; n++) {
      const cut = full.subarray(0, n);
      const r = stripImageMetadata(cut);
      if (n < sosAt + SOS.length) {
        expect(r.outcome, `n=${n}`).toBe('unparsed');
        expect(r.buffer, `n=${n}`).toBe(cut);
      } else {
        expect(r.outcome, `n=${n}`).toBe('stripped');
        expect(hasSecret(r.buffer), `n=${n}`).toBe(false);
        expect(r.buffer.subarray(r.buffer.length - (n - sosAt)).equals(cut.subarray(sosAt)), `n=${n}`).toBe(true);
      }
    }
  });

  it('rastgele bayt bozulmaları: hiç atmaz, çıktı ya girdinin kendisi ya da üst verisiz', () => {
    const full = jpeg(APP0, exifSeg(tiff([ORIENT(6), MAKE('SecretCam')])), ICC);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 2000; k++) {
      const b = Buffer.from(full);
      for (let j = 0; j < 3; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const r = stripImageMetadata(b);
      if (r.outcome !== 'stripped') expect(r.buffer).toBe(b);
      else expect(r.buffer.length).toBeLessThanOrEqual(b.length + 34);
    }
  });

  it('B1: 8 MB RST, doldurma, küçük kesim ya da taramada RST dolu dosya doğru sonuç verir (süre: imageMeta.perf.test.ts)', () => {
    const { plain, cases } = b1Jpeg();
    expect(stripImageMetadata(plain).outcome).toBe('clean');
    for (const [name, b, outcome] of cases) expect(stripImageMetadata(b).outcome, name).toBe(outcome);
  });
});


describe('PNG', () => {
  it('eXIf, tEXt, zTXt, iTXt (XMP) ve IEND sonrası kalkar; yön asgari eXIf ile kalır; CRC\'ler geçerli', () => {
    const input = Buffer.concat([
      PNG_SIG,
      IHDR,
      chunk('eXIf', tiff([ORIENT(6), GPS_TEXT()])),
      chunk('tEXt', latin(`Comment\0${SECRET}`)),
      chunk('iTXt', latin(`XML:com.adobe.xmp\0\0\0\0\0<x>${SECRET}</x>`)),
      chunk('zTXt', Buffer.concat([latin('Raw\0\0'), zlib.deflateSync(latin(SECRET))])),
      PHYS,
      IDAT,
      IEND,
      latin(SECRET),
    ]);
    const r = stripImageMetadata(input);
    expect(r).toMatchObject({ outcome: 'stripped', format: 'png', orientation: 6 });
    expect(hasSecret(r.buffer)).toBe(false);
    expect(r.buffer.equals(Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', orientationTiff(6)), PHYS, IDAT, IEND]))).toBe(true);
    expect(pngValid(r.buffer)).toBe(true);
  });

  it('izin listesi: her taşıyıcı kalkar (caBX/C2PA, tIME, özel yardımcı parça); bilinen zararsızlar kalır; bilinmeyen zorunlu parça okunamaz', () => {
    const kept = [
      chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
      chunk('sRGB', Buffer.from([0])),
      chunk('cHRM', Buffer.alloc(32, 1)),
      chunk('sBIT', Buffer.from([8, 8, 8])),
      chunk('bKGD', Buffer.from([0, 0, 0, 0, 0, 0])),
      chunk('cICP', Buffer.from([1, 13, 0, 1])),
      PHYS,
    ];
    for (const [name, c] of [
      ['caBX', chunk('caBX', latin(`jumb c2pa ${SECRET}`))],
      ['tIME', chunk('tIME', Buffer.from([7, 234, 11, 12, 1, 2, 3]))],
      ['prVt', chunk('prVt', latin(SECRET))],
      ['tEXt', chunk('tEXt', latin(`Comment\0${SECRET}`))],
      ['dSIG', chunk('dSIG', latin(SECRET))],
    ] as [string, Buffer][]) {
      const r = stripImageMetadata(Buffer.concat([PNG_SIG, IHDR, ...kept, c, IDAT, IEND]));
      expect(r.outcome, name).toBe('stripped');
      expect(r.buffer.equals(Buffer.concat([PNG_SIG, IHDR, ...kept, IDAT, IEND])), name).toBe(true);
    }
    const unknownCritical = Buffer.concat([PNG_SIG, IHDR, chunk('ABCD', latin(SECRET)), IDAT, IEND]);
    expect(stripImageMetadata(unknownCritical)).toMatchObject({ outcome: 'unparsed', buffer: unknownCritical });
  });

  it('B1: 8 MB küçük parçalı PNG okunamaz sayılır, aynı boyda zararsız eşi temizlenir (süre: imageMeta.perf.test.ts)', () => {
    const { input, plain } = b1Png();
    expect(stripImageMetadata(plain).outcome).toBe('stripped');
    expect(stripImageMetadata(input).outcome).toBe('unparsed');
  });

  it('"Exif\\0\\0" önekli eXIf de okunur; yön 1 ise eXIf yazılmaz', () => {
    const withPrefix = Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', Buffer.concat([latin('Exif\0\0'), tiff([ORIENT(5)])])), IDAT, IEND]);
    expect(stripImageMetadata(withPrefix).orientation).toBe(5);
    const upright = Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', tiff([ORIENT(1), GPS_TEXT()])), IDAT, IEND]);
    const r = stripImageMetadata(upright);
    expect(r.buffer.equals(Buffer.concat([PNG_SIG, IHDR, IDAT, IEND]))).toBe(true);
  });

  it('temiz PNG aynen döner; temizlenmiş PNG ikinci kez değişmez', () => {
    const clean = Buffer.concat([PNG_SIG, IHDR, PHYS, IDAT, IEND]);
    const r = stripImageMetadata(clean);
    expect(r.outcome).toBe('clean');
    expect(r.buffer).toBe(clean);
    const once = stripImageMetadata(Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', tiff([ORIENT(7), GPS_TEXT()])), IDAT, IEND])).buffer;
    expect(stripImageMetadata(once)).toMatchObject({ outcome: 'clean', buffer: once });
  });

  it('bozuk ya da kesik PNG aynen döner: IEND yok, ilk parça IHDR değil, boy taşıyor, tür adı geçersiz', () => {
    const meta = chunk('tEXt', latin(`c\0${SECRET}`));
    const noIend = Buffer.concat([PNG_SIG, IHDR, meta, IDAT]);
    const notIhdr = Buffer.concat([PNG_SIG, meta, IHDR, IDAT, IEND]);
    const overLength = Buffer.concat([PNG_SIG, IHDR, meta.subarray(0, meta.length - 3)]);
    const badType = Buffer.concat([PNG_SIG, IHDR, chunk('t$Xt', latin('x')), meta, IDAT, IEND]);
    for (const bad of [noIend, notIhdr, overLength, badType]) {
      const r = stripImageMetadata(bad);
      expect(r.outcome).toBe('unparsed');
      expect(r.buffer).toBe(bad);
    }
    // her kesilme noktası: IEND'e varmadan kesik = aynen
    const full = Buffer.concat([PNG_SIG, IHDR, meta, IDAT, IEND]);
    for (let n = 9; n < full.length; n++) expect(stripImageMetadata(full.subarray(0, n)).outcome, `n=${n}`).toBe('unparsed');
  });
});


describe('WebP', () => {
  it('EXIF ve XMP parçaları kalkar, VP8X bayrakları ve RIFF boyu düzelir; yön asgari EXIF ile kalır', () => {
    const input = webp(vp8x(0x20 | 0x08 | 0x04), ICCP, VP8, riff('EXIF', tiff([ORIENT(6), GPS_TEXT()])), riff('XMP ', latin(`<x>${SECRET}</x>`)));
    const r = stripImageMetadata(input);
    expect(r).toMatchObject({ outcome: 'stripped', format: 'webp', orientation: 6 });
    expect(hasSecret(r.buffer)).toBe(false);
    expect(r.buffer.equals(webp(vp8x(0x20 | 0x08), ICCP, VP8, riff('EXIF', orientationTiff(6))))).toBe(true);
    expect(r.buffer.readUInt32LE(4)).toBe(r.buffer.length - 8);
    // ikinci temizlik değiştirmez (asgari EXIF ve bayrağı kalır)
    expect(stripImageMetadata(r.buffer)).toMatchObject({ outcome: 'clean', buffer: r.buffer });
    // asgari EXIF'in yanında XMP varsa yalnız XMP kalkar, EXIF bayrağı kalır
    const mixed = webp(vp8x(0x08 | 0x04), VP8, riff('EXIF', orientationTiff(3)), riff('XMP ', latin(SECRET)));
    expect(stripImageMetadata(mixed).buffer.equals(webp(vp8x(0x08), VP8, riff('EXIF', orientationTiff(3))))).toBe(true);
  });

  it('izin listesi: C2PA ve bilinmeyen parça kalkar; ALPH, ANIM, ICCP kalır', () => {
    const ALPH = riff('ALPH', Buffer.alloc(4, 3));
    for (const [name, c] of [
      ['C2PA', riff('C2PA', latin(`jumb ${SECRET}`))],
      ['XYZW', riff('XYZW', latin(SECRET))],
      ['XMP ', riff('XMP ', latin(SECRET))],
    ] as [string, Buffer][]) {
      const r = stripImageMetadata(webp(vp8x(0x20 | 0x10 | 0x04), ICCP, ALPH, VP8, c));
      expect(r.outcome, name).toBe('stripped');
      expect(r.buffer.equals(webp(vp8x(0x20 | 0x10), ICCP, ALPH, VP8)), name).toBe(true);
    }
    // görüntü parçası olmayan RIFF okunamaz
    const noImage = webp(vp8x(0), ICCP);
    expect(stripImageMetadata(noImage)).toMatchObject({ outcome: 'unparsed', buffer: noImage });
  });

  it('B1: 8 MB küçük parçalı WebP okunamaz sayılır, aynı boyda zararsız eşi temizlenir (süre: imageMeta.perf.test.ts)', () => {
    const { input, plain } = b1Webp();
    expect(stripImageMetadata(plain).outcome).toBe('stripped');
    expect(stripImageMetadata(input).outcome).toBe('unparsed');
  });

  it('yön yoksa EXIF bayrağı da kalkar; RIFF dışı ek veri kalkar', () => {
    const input = Buffer.concat([webp(vp8x(0x08), VP8, riff('EXIF', Buffer.concat([latin('Exif\0\0'), tiff([GPS_TEXT()])]))), latin(SECRET)]);
    const r = stripImageMetadata(input);
    expect(r.buffer.equals(webp(vp8x(0), VP8))).toBe(true);
  });

  it('temiz WebP aynen; bozuk RIFF (boy taşıyor, parça taşıyor) aynen', () => {
    const clean = webp(VP8);
    expect(stripImageMetadata(clean).buffer).toBe(clean);
    const exif = riff('EXIF', tiff([GPS_TEXT()]));
    const long = webp(vp8x(0x08), VP8, exif);
    long.writeUInt32LE(long.length + 100, 4);
    const chunkOver = webp(vp8x(0x08), VP8, exif);
    chunkOver.writeUInt32LE(9999, 12 + 18 + 4);
    for (const bad of [long, chunkOver, long.subarray(0, 20)]) {
      const r = stripImageMetadata(bad);
      expect(r.outcome).toBe('unparsed');
      expect(r.buffer).toBe(bad);
    }
  });
});

describe('desteklenmeyen tür', () => {
  it('HEIC ve tanınmayan içerik aynen döner (unsupported)', () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), latin('ftypheic'), Buffer.alloc(12), latin(SECRET)]);
    const r = stripImageMetadata(heic);
    expect(r).toMatchObject({ outcome: 'unsupported', format: null });
    expect(r.buffer).toBe(heic);
    expect(stripImageMetadata(Buffer.alloc(0)).outcome).toBe('unsupported');
    expect(stripImageMetadata(Buffer.from([0xff, 0xd8])).outcome).toBe('unsupported');
  });
});
