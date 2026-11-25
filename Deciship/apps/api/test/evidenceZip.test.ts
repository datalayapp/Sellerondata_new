import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { MESSAGES } from '../src/i18n/messages.ts';
import { absolutePath } from '../src/lib/storage.ts';
import { dosDateTime, isSafeZipName, zipChunks } from '../src/lib/zip.ts';
import { disputeChargeUnit, EVIDENCE_MAX_PHOTOS, loadDisputeDraft, signatureContact, streamEvidenceZip } from '../src/services/evidence.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { createWorker, getApp, inCompany, JPEG, multipart } from './helpers.ts';

const API = '/api/deciship';
const SAFE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `wall`: DOS tarih alanındaki duvar saati, "YYYY-MM-DD HH:mm:ss" (saniye 2'lik). */
type Entry = { name: string; data: Buffer; crcOk: boolean; method: number; wall: string };

function dosWall(time: number, date: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${1980 + (date >> 9)}-${p((date >> 5) & 15)}-${p(date & 31)} ${p(time >> 11)}:${p((time >> 5) & 63)}:${p((time & 31) * 2)}`;
}

/** Duvar saati metni ile anın o dilimdeki saati arasındaki fark, saniye. */
function wallSkewSec(wall: string, at: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const x: Record<string, string> = {};
  for (const part of f.formatToParts(at)) x[part.type] = part.value;
  const expected = Date.UTC(+x.year!, +x.month! - 1, +x.day!, +x.hour!, +x.minute!, +x.second!);
  const [d, t] = wall.split(' ');
  const [y, mo, da] = d!.split('-').map(Number);
  const [h, mi, se] = t!.split(':').map(Number);
  return Math.abs(Date.UTC(y!, mo! - 1, da!, h!, mi!, se!) - expected) / 1000;
}

/** Testin kendi ZIP okuyucusu (merkez dizinden): yazıcıyla aynı koddan gelmesin. */
function readZip(buf: Buffer): Entry[] {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);
  const out: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const wall = dosWall(buf.readUInt16LE(p + 12), buf.readUInt16LE(p + 14));
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    expect(buf.subarray(local + 30, local + 30 + lName).toString('latin1')).toBe(name);
    const start = local + 30 + lName + lExtra;
    const data = buf.subarray(start, start + size);
    out.push({ name, data, method, wall, crcOk: (zlib.crc32(data) >>> 0) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const textOf = (e: Entry) => e.data.subarray(3).toString('utf8');

/** Ölçüm, verilen fotoğraf içerikleriyle (API içeriği çözmez). */
async function measure(app: FastifyInstance, auth: { authorization: string }, trackingRaw: string, photos: Buffer[]) {
  const data = {
    clientId: crypto.randomUUID(),
    trackingRaw,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 15,
    weightKg: 2,
    dimMethod: 'MANUAL',
    weightMethod: 'MANUAL',
    measuredAt: new Date().toISOString(),
    photoKinds: photos.map((_, i) => (i === 0 ? 'PHOTO_BOX' : 'PHOTO_SCALE')),
  };
  const form = multipart([{ name: 'data', value: JSON.stringify(data) }, ...photos.map((d, i) => ({ name: 'photos', filename: `p${i}.jpg`, contentType: 'image/jpeg', data: d }))]);
  const r = await app.inject({ method: 'POST', url: `${API}/measurements`, headers: { ...auth, ...form.headers }, payload: form.payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().measurement as { id: string; trackingNo: string };
}

async function verifyLine(app: FastifyInstance, f: Fixture) {
  const line = (await app.inject({ method: 'GET', url: `${API}/invoices/${f.invoiceId}/lines`, headers: f.admin.auth })).json().items.find((l: { id: string }) => l.id === f.lineId);
  expect(line.status).toBe('DIFF');
  expect(line.diffAmount).toBeGreaterThan(0);
  const r = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${f.lineId}`, headers: f.admin.auth, payload: { decision: 'VERIFIED' } });
  expect(r.statusCode, r.body).toBe(200);
}

const zipUrl = (f: Fixture, q = '') => `${API}/invoices/${f.invoiceId}/dispute/evidence.zip${q}`;

describe('ZIP yazıcısı', () => {
  it('güvensiz ve yinelenen adları reddeder; boş arşiv geçerlidir', async () => {
    for (const bad of ['', '../a.txt', 'a/b.txt', 'a\\b.txt', '.gizli', 'C:x.txt', 'ç.txt', 'a b.txt', 'a..b', '-a.txt', 'a\u0000.txt']) {
      expect(isSafeZipName(bad), bad).toBe(false);
    }
    expect(isSafeZipName('01-ABC123-kutu-1.jpg')).toBe(true);
    const collect = async (entries: { name: string; data: Buffer }[]) => {
      const parts: Buffer[] = [];
      for await (const c of zipChunks(entries)) parts.push(c);
      return Buffer.concat(parts);
    };
    await expect(collect([{ name: '../x.txt', data: Buffer.from('x') }])).rejects.toThrow(/Unsafe/);
    await expect(collect([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'A.TXT', data: Buffer.from('2') }])).rejects.toThrow(/Duplicate/);
    expect(readZip(await collect([]))).toEqual([]);
    const two = readZip(await collect([{ name: 'a.txt', data: Buffer.from('merhaba') }, { name: 'b.bin', data: Buffer.alloc(0) }]));
    expect(two.map((e) => [e.name, e.data.toString(), e.crcOk, e.method])).toEqual([['a.txt', 'merhaba', true, 0], ['b.bin', '', true, 0]]);
  });

  it('giriş tarihi verilen saat diliminin duvar saatiyle yazılır (yoksa UTC)', async () => {
    const at = new Date('2026-10-21T11:32:10.000Z');
    const wallOf = (d: { time: number; date: number }) => dosWall(d.time, d.date);
    expect(wallOf(dosDateTime(at, 'Europe/Istanbul'))).toBe('2026-10-21 14:32:10');
    expect(wallOf(dosDateTime(at, 'America/New_York'))).toBe('2026-10-21 07:32:10');
    expect(wallOf(dosDateTime(at))).toBe('2026-10-21 11:32:10');
    // gece yarısını aşan kayma günü de değiştirir
    expect(wallOf(dosDateTime(new Date('2026-10-21T22:30:00.000Z'), 'Europe/Istanbul'))).toBe('2026-10-22 01:30:00');
    const parts: Buffer[] = [];
    for await (const c of zipChunks([{ name: 'a.txt', data: Buffer.from('x'), mtime: at }], { timeZone: 'Europe/Istanbul' })) parts.push(c);
    expect(readZip(Buffer.concat(parts))[0]!.wall).toBe('2026-10-21 14:32:10');
  });
});

describe('itiraz kanıt ZIP\'i', () => {
  let app: FastifyInstance;
  let A: Fixture;
  let B: Fixture;
  let bSecret: Buffer;

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
    B = await companyFixture(app);
    await verifyLine(app, A);
    await verifyLine(app, B);
    // B firmasında A'nın takip numarasıyla, ayırt edilebilir içerikli iki fotoğraflı ölçüm: eşleşme takip no ile yapılsa bile
    // A'nın ZIP'ine girmemeli.
    bSecret = Buffer.concat([JPEG, Buffer.from(`FIRM-B-${crypto.randomUUID()}`)]);
    const bWorker = await createWorker(app, B.admin.auth);
    await measure(app, bWorker.auth, A.measurement.trackingNo, [bSecret, bSecret]);
    // ölçüm anı sabit: İstanbul'da 21.10.2026 14:32
    await inCompany(A.companyId, () => prisma.measurement.update({ where: { id: A.measurement.id }, data: { measuredAt: new Date('2026-10-21T11:32:00.000Z') } }));
  });

  it('metin + fotoğraf; metin /dispute ile aynı; ad ve yol güvenli; ölçen kişinin adı yok', async () => {
    const r = await app.inject({ method: 'GET', url: zipUrl(A), headers: A.admin.auth });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="itiraz-kanit-[A-Za-z0-9._-]+\.zip"$/);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const entries = readZip(r.rawPayload);
    const tracking = A.measurement.trackingNo.replace(/[^A-Za-z0-9]/g, '');
    expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt', `01-${tracking}-kutu-1.jpg`]);
    expect(entries.every((e) => e.crcOk && e.method === 0 && SAFE_ENTRY.test(e.name))).toBe(true);
    // firmanın saat dilimi (varsayılan İstanbul): Windows Gezgini DOS saatini yerel sayar
    for (const e of entries) expect(wallSkewSec(e.wall, new Date(), 'Europe/Istanbul'), e.wall).toBeLessThan(120);
    expect(entries[1]!.data.equals(JPEG)).toBe(true);
    // B'nin fotoğrafı hiçbir girişte yok
    expect(entries.some((e) => e.data.includes(Buffer.from('FIRM-B-')))).toBe(false);

    const letter = entries[0]!;
    expect([...letter.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = textOf(letter);
    expect(text).toContain('\r\n');
    expect(text).toContain('depo çalışanımız');
    expect(text).toContain('14:32');
    expect(text).toContain('ZIP');
    expect(text).not.toContain('Çalışan Test');
    expect(text).not.toContain(MESSAGES['evidence.missing'].tr.slice(0, 10));

    const dispute = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute`, headers: A.admin.auth });
    expect(dispute.statusCode, dispute.body).toBe(200);
    const d = dispute.json() as { subject: string; body: string; photoCount: number };
    expect(text.replace(/\r\n/g, '\n')).toBe(`${d.subject}\n\n${d.body}`);
    expect(d.photoCount).toBe(1);
  });

  // KALANLAR 1.12: yurt içi taşıyıcıda (fikstür Aras, bölen 3000) ücretli ağırlık desidir; imzada istek başlıklarındaki
  // e-posta ve telefon (web Merkez hesabından gönderir); ZIP'teki mektup penceredeki metinle aynı
  it('desi birimi; imzada başlıktan e-posta ve telefon, ZIP mektubu aynı; bozuk ya da satır sonlu değer yazılmaz', async () => {
    const sign = { 'x-signature-email': encodeURIComponent('elif@demo.com'), 'x-signature-phone': encodeURIComponent('+905321234567') };
    const dispute = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute`, headers: { ...A.admin.auth, ...sign } });
    expect(dispute.statusCode, dispute.body).toBe(200);
    const d = dispute.json() as { subject: string; body: string };
    // ölçüm 30×20×15 / 3000 = 3 desi, faturada 5 desi; gerçek ağırlık kg kalır
    expect(d.body).toContain('Bizim ölçümümüz: 30×20×15 cm, 2,0 kg, ücretli 3,0 desi');
    // faturada yalnız desi sütunu (ölçü ve gerçek ağırlık yok): desi mi kg mı belirledi bilinmez
    expect(d.body).toContain('Faturalanan: ücretli 5,0 desi/kg');
    expect(d.body).not.toMatch(/ücretli [\d,]+ kg/);
    expect(d.body).toMatch(/Saygılarımızla,\n[^\n]+\n[^\n]+\nE-posta: elif@demo\.com\nTel: \+90 532 123 45 67$/);

    const zip = await app.inject({ method: 'GET', url: zipUrl(A), headers: { ...A.admin.auth, ...sign } });
    expect(zip.statusCode).toBe(200);
    expect(textOf(readZip(zip.rawPayload)[0]!).replace(/\r\n/g, '\n')).toBe(`${d.subject}\n\n${d.body}`);

    // başlık yoksa imza bugünkü gibi (ad ve firma); bozuk e-posta, satır sonu ya da harfli telefon yazılmaz
    const plain = (await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute`, headers: A.admin.auth })).json().body as string;
    expect(plain).not.toContain('E-posta:');
    expect(plain).not.toContain('Tel:');
    const bad = await app.inject({
      method: 'GET',
      url: `${API}/invoices/${A.invoiceId}/dispute`,
      headers: { ...A.admin.auth, 'x-signature-email': encodeURIComponent('elif@demo.com\nBcc: x@y.z'), 'x-signature-phone': encodeURIComponent('ara beni') },
    });
    expect(bad.json().body).toBe(plain);
    const broken = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute`, headers: { ...A.admin.auth, 'x-signature-email': '%E0%A4%A' } });
    expect(broken.json().body).toBe(plain);
    // EN etiketleri
    const en = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/dispute?lang=en`, headers: { ...A.admin.auth, ...sign } });
    expect(en.json().body).toMatch(/\nEmail: elif@demo\.com\nPhone: \+90 532 123 45 67$/);
    expect(en.json().body).toContain('chargeable 3.0 desi');
  });

  it('birim kuralı ve imza başlıklarının denetimi (saf)', () => {
    // tarife sürümünün böleni karar verir; sürüm yoksa taşıyıcı kodu
    expect(disputeChargeUnit(3000, 'fedex')).toBe('desi');
    expect(disputeChargeUnit(5000, 'aras')).toBe('kg');
    expect(disputeChargeUnit(null, 'aras')).toBe('desi');
    expect(disputeChargeUnit(null, 'fedex')).toBe('kg');
    // "Diğer" taşıyıcı adıyla (KALANLAR 1.1 incelemesi): Sürat desi, TNT ve adsız kg; PTT desi
    expect(disputeChargeUnit(null, 'generic', 'Sürat Kargo')).toBe('desi');
    expect(disputeChargeUnit(null, 'generic', 'TNT Express')).toBe('kg');
    expect(disputeChargeUnit(null, 'generic')).toBe('kg');
    expect(disputeChargeUnit(null, null)).toBe('kg');
    expect(disputeChargeUnit(null, 'ptt')).toBe('desi');
    const enc = encodeURIComponent;
    expect(signatureContact({ 'x-signature-email': enc(' a@b.co '), 'x-signature-phone': enc('+90 532 123 45 67') })).toEqual({ email: 'a@b.co', phone: '+90 532 123 45 67' });
    expect(signatureContact({})).toEqual({});
    for (const email of ['a@b', 'a b@c.d', 'a@b.c\r\nX: y', `${'a'.repeat(250)}@b.co`]) expect(signatureContact({ 'x-signature-email': enc(email) }), email).toEqual({});
    for (const phone of ['12', '+90 532 <b>', '+90532\n1234567']) expect(signatureContact({ 'x-signature-phone': enc(phone) }), phone).toEqual({});
  });

  it('İngilizce: dosya adları ve metin İngilizce', async () => {
    const r = await app.inject({ method: 'GET', url: zipUrl(A, '?lang=en'), headers: A.admin.auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('dispute-evidence-');
    const entries = readZip(r.rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['00-dispute-letter.txt', `01-${A.measurement.trackingNo.replace(/[^A-Za-z0-9]/g, '')}-box-1.jpg`]);
    // firma ve kişi adı veridir (Türkçe kalabilir); şablon metni İngilizce
    const text = textOf(entries[0]!);
    expect(text).toContain('by our warehouse staff');
    expect(text).toContain('attached ZIP file');
    expect(text).not.toContain('depo');
  });

  it('başka firma: fatura id ile 404; ölçüm rolü 403', async () => {
    const other = await app.inject({ method: 'GET', url: zipUrl(A), headers: B.admin.auth });
    expect(other.statusCode).toBe(404);
    expect(other.headers['content-type']).toContain('json');
    const worker = await app.inject({ method: 'GET', url: zipUrl(A), headers: A.worker.auth });
    expect(worker.statusCode).toBe(403);
  });

  it('fiyat izni ya da bütün ölçümleri görme izni yoksa servis metni üretmez (403, veritabanına gitmeden)', async () => {
    const fake = (permissions: string[]) =>
      ({ auth: { orgId: A.companyId, membershipId: A.admin.userId, name: 'X', permissions }, headers: {}, log: { warn() {} } }) as unknown as FastifyRequest;
    const reply = {} as FastifyReply;
    await expect(streamEvidenceZip(fake(['deciship.data.export', 'deciship.measurements.view_all']), reply, A.invoiceId, 'tr')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(streamEvidenceZip(fake(['deciship.data.export', 'deciship.prices.view']), reply, A.invoiceId, 'tr')).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(loadDisputeDraft(fake(['deciship.data.export']), A.invoiceId, 'tr')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('listede satır yoksa 400 NO_VERIFIED_LINES', async () => {
    const C = await companyFixture(app);
    const r = await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('NO_VERIFIED_LINES');
  });

  it('adet ve boyut sınırı akış başlamadan: 413 EVIDENCE_TOO_LARGE', async () => {
    const C = await companyFixture(app);
    await verifyLine(app, C);
    const extra = (n: number, size: number) =>
      Array.from({ length: n }, () => ({
        companyId: C.companyId,
        kind: 'PHOTO_OTHER' as const,
        mime: 'image/jpeg',
        size,
        path: `${C.companyId}/yok/${crypto.randomUUID()}.jpg`,
        sha256: 'x',
        measurementId: C.measurement.id,
        createdById: C.admin.userId,
      }));
    // 1 mevcut + 1.000 = 1.001 fotoğraf
    await inCompany(C.companyId, () => prisma.file.createMany({ data: extra(EVIDENCE_MAX_PHOTOS, 1) }));
    const many = await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth });
    expect(many.statusCode).toBe(413);
    expect(many.headers['content-type']).toContain('json');
    expect(many.json().error).toEqual({ code: 'EVIDENCE_TOO_LARGE', message: MESSAGES['err.evidenceTooLarge'].tr });
    await inCompany(C.companyId, () => prisma.file.deleteMany({ where: { measurementId: C.measurement.id, kind: 'PHOTO_OTHER' } }));

    await inCompany(C.companyId, () => prisma.file.createMany({ data: extra(1, 600 * 1024 * 1024) }));
    const big = await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('EVIDENCE_TOO_LARGE');
    await inCompany(C.companyId, () => prisma.file.deleteMany({ where: { measurementId: C.measurement.id, kind: 'PHOTO_OTHER' } }));
    expect((await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth })).statusCode).toBe(200);
  });

  it('eksik dosya ve depo dışını gösteren yol atlanır, metinde not edilir; garip fatura no dosya adında temizlenir', async () => {
    const C = await companyFixture(app);
    await verifyLine(app, C);
    const photo = await inCompany(C.companyId, () => prisma.file.findFirstOrThrow({ where: { id: C.photoId } }));
    expect(fs.existsSync(absolutePath(photo.path))).toBe(true);
    // ikinci kayıt: depo kökünün dışını gösteren yol (kullanıcı girdisi değil, ama kayıt bozulsa bile okunmaz)
    await inCompany(C.companyId, () =>
      prisma.file.create({
        data: { companyId: C.companyId, kind: 'PHOTO_SCALE', mime: 'image/jpeg', size: 10, path: '../../../../../../Windows/win.ini', sha256: 'x', measurementId: C.measurement.id, createdById: C.admin.userId },
      }),
    );
    await inCompany(C.companyId, async () => {
      await prisma.file.update({ where: { id: C.photoId }, data: { path: `${C.companyId}/yok/${crypto.randomUUID()}.jpg` } });
      await prisma.invoice.update({ where: { id: C.invoiceId }, data: { invoiceNo: 'F/../"x\r\nSet-Cookie: a' } });
    });
    const r = await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="itiraz-kanit-[A-Za-z0-9._-]+\.zip"$/);
    expect(r.headers['set-cookie']).toBeUndefined();
    const entries = readZip(r.rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt', '01-eksik-dosyalar.txt']);
    // kargo firmasına giden mektup: iç not yok, fotoğraf sayısı ZIP'in içeriğini anlatır (eklenen fotoğraf yok)
    const letter = textOf(entries[0]!);
    expect(letter).not.toContain('bulunamadı');
    expect(letter).not.toContain('Not:');
    expect(letter).not.toContain('ekteki ZIP');
    expect(letter).not.toMatch(/Fotoğraf: \d/);
    // iç not ayrı dosyada: hangi satırın hangi fotoğrafı
    expect([...entries[1]!.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const tracking = C.measurement.trackingNo;
    const safe = tracking.replace(/[^A-Za-z0-9]/g, '');
    expect(textOf(entries[1]!).replace(/\r\n/g, '\n')).toBe(
      [
        'Not: 2 fotoğraf dosyası bulunamadı ve ZIP dosyasına eklenmedi.',
        '',
        `1) Takip no ${tracking}: 01-${safe}-kutu-1.jpg`,
        `1) Takip no ${tracking}: 01-${safe}-tarti-1.jpg`,
      ].join('\n'),
    );

    const en = readZip((await app.inject({ method: 'GET', url: zipUrl(C, '?lang=en'), headers: C.admin.auth })).rawPayload);
    expect(en.map((e) => e.name)).toEqual(['00-dispute-letter.txt', '01-missing-files.txt']);
    expect(textOf(en[1]!)).toContain(`1) Tracking no. ${tracking}: 01-${safe}-scale-1.jpg`);
    expect(textOf(en[1]!)).toContain('Note: 2 photos could not be found');
  });

  it('eksik dosya yoksa iç not dosyası da yok', async () => {
    const r = await app.inject({ method: 'GET', url: zipUrl(A), headers: A.admin.auth });
    expect(readZip(r.rawPayload).some((e) => /eksik|missing/.test(e.name))).toBe(false);
  });

  it('ZIP adı takip no\'dan yalnız harf ve rakam alır', async () => {
    const C = await companyFixture(app);
    await verifyLine(app, C);
    await inCompany(C.companyId, () => prisma.invoiceLine.update({ where: { id: C.lineId }, data: { trackingNo: '../EV\\IL/ 12:*?' } }));
    const entries = readZip((await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth })).rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt', '01-EVIL12-kutu-1.jpg']);
  });

  it('mükerrer satırda kanıt ve fotoğraf yok', async () => {
    const C = await companyFixture(app);
    await verifyLine(app, C);
    await inCompany(C.companyId, () => prisma.invoiceLine.update({ where: { id: C.lineId }, data: { diffTypes: ['DUPLICATE'], status: 'DIFF' } }));
    const r = await app.inject({ method: 'GET', url: zipUrl(C), headers: C.admin.auth });
    expect(r.statusCode).toBe(200);
    const entries = readZip(r.rawPayload);
    expect(entries.map((e) => e.name)).toEqual(['00-itiraz-metni.txt']);
    expect(textOf(entries[0]!)).not.toContain('depo çalışanımız');
  });

  it('Excel raporunda ölçüm zamanı, ölçen, yöntem, fotoğraf; PDF raporunda tek Ölçüm sütunu', async () => {
    const x = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/report.xlsx`, headers: A.admin.auth });
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as never);
    const ws = wb.getWorksheet('Tüm satırlar')!;
    const head = ws.getRow(1).values as unknown[];
    const col = (h: string) => {
      const i = head.indexOf(h);
      expect(i, h).toBeGreaterThan(0);
      return i;
    };
    const rows = Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2));
    const measured = rows.find((row) => row.getCell(col('Takip no')).value === A.measurement.trackingNo)!;
    expect(measured.getCell(col('Ölçüm zamanı')).value).toBe('21.10.2026 14:32');
    expect(measured.getCell(col('Ölçen')).value).toBe('Çalışan Test');
    expect(measured.getCell(col('Ölçüm yöntemi')).value).toBe('Elle (metre) · elle girildi');
    expect(measured.getCell(col('Fotoğraf')).value).toBe(1);
    const unmeasured = rows.find((row) => row !== measured)!;
    expect(unmeasured.getCell(col('Ölçen')).value ?? '').toBe('');
    expect(unmeasured.getCell(col('Fotoğraf')).value ?? null).toBeNull();

    const en = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/report.xlsx`, headers: { ...A.admin.auth, 'accept-language': 'en' } });
    const wbEn = new ExcelJS.Workbook();
    await wbEn.xlsx.load(en.rawPayload as never);
    const headEn = wbEn.getWorksheet('All lines')!.getRow(1).values as unknown[];
    expect(headEn).toEqual(expect.arrayContaining(['Measured at', 'Measured by', 'Measurement method', 'Photos']));

    const pdf = await app.inject({ method: 'GET', url: `${API}/invoices/${A.invoiceId}/report.pdf`, headers: A.admin.auth });
    expect(pdf.statusCode).toBe(200);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.rawPayload), useSystemFonts: false, verbosity: 0 }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + ' ';
    expect(text).toContain('Ölçüm');
    expect(text).toContain('21.10.2026 14:32');
    expect(text).toContain('fotoğraf');
    // rapor firmanın kendisi içindir; ad PDF'te yok (sütun Excel'de)
    expect(text).not.toContain('Çalışan Test');
  });

});
