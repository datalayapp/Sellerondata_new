/**
 * Y59 test yardımcısı: PDF ön denetimi testlerinin (`pdfGuard.test.ts`, `pdfGuard.perf.test.ts`) elle kurulan PDF baytları.
 * Saf işlevler; veritabanı yok.
 */
import { deflateSync } from 'node:zlib';

export const MB = 1024 * 1024;

/** Tek içerik akışlı PDF (nesne 4). `extra`: ek nesneler; `trailer`: ek dosya sonu alanları. */
export function pdfWith(dict: string, data: Buffer, o: { extra?: string[]; trailer?: string } = {}): Buffer {
  const objs = [
    Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'),
    Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'),
    Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >> endobj\n'),
    Buffer.concat([Buffer.from(`4 0 obj ${dict} stream\n`), data, Buffer.from('\nendstream endobj\n')]),
    ...(o.extra ?? []).map((x) => Buffer.from(x, 'latin1')),
  ];
  let pdf = Buffer.from('%PDF-1.7\n');
  const offs: number[] = [];
  for (const x of objs) {
    offs.push(pdf.length);
    pdf = Buffer.concat([pdf, x]);
  }
  const xref = pdf.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offs) x += `${String(off).padStart(10, '0')} 00000 n \n`;
  x += `trailer << /Size ${objs.length + 1} /Root 1 0 R ${o.trailer ?? ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(x, 'latin1')]);
}

/** Yüz binlerce "stream" sözcüğü (zlib açılmadan geçmeli). */
export const manyStreams = () => Buffer.from('%PDF-1.4\n' + 'stream\nxx\n'.repeat(300_000), 'latin1');

/**
 * Ayrıştırma tavanları: dev /Filter dizisi (1M giriş, ~4 MB) ve dev sözlük (300 bin giriş), her biri aynı boyda zararsız
 * eşiyle (süre tabanı). Dev sözlüğün tabanı aynı metnin yorum satırındaki hâlidir: rakamlı metinde nesne başlığı taraması
 * düz metinden ~10 kat pahalıdır.
 */
export function parseCeilingCases() {
  const data = deflateSync(Buffer.from('BT ET'));
  const entries = Array.from({ length: 300_000 }, (_, i) => `/K${i} 1`).join(' ');
  return {
    data,
    arrayBase: pdfWith('<< /Filter /FlateDecode >>', data, { extra: [`% ${'x'.repeat(4_000_000)}\n`] }),
    array: pdfWith(`<< /Filter [${'/Fl '.repeat(1_000_000)}] >>`, data),
    dictBase: pdfWith('<< /Filter /FlateDecode >>', data, { extra: [`% ${entries}\n`] }),
    dict: pdfWith(`<< /Filter /FlateDecode ${entries} >>`, data),
  };
}
