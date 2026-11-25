/**
 * 06-B4: dosya önce geçici ada yazılıp son adına taşınır; yazma düşerse geçici dosya kalmaz, disk doluysa kullanıcı
 * anlaşılır ileti (507 `STORAGE_FULL`, TR+EN) alır; dosyanın kaydı yazılamazsa saklanan dosya silinir (sahipsiz dosya yok).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPrisma, prisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { AppError } from '../src/errors.ts';
import { withLocale } from '../src/i18n/index.ts';
import { MESSAGES } from '../src/i18n/messages.ts';
import { storeBuffer } from '../src/lib/storage.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany, multipart, uniq } from './helpers.ts';

const API = '/api/deciship';

/** Firmanın depo klasöründeki bütün dosyalar (geçici dahil), köke göre. */
function filesOf(companyId: string): string[] {
  const root = path.join(env.storageDir, companyId);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
}

/** `fs.open` ile açılan tutamağın yazması disk dolu hatası verir (ilk baytlar yazılmış gibi: yarım dosya). */
function failNextWrite() {
  const real = fsp.open.bind(fsp);
  return vi.spyOn(fsp, 'open').mockImplementationOnce(async (file, flags) => {
    const h = await real(file, flags);
    vi.spyOn(h, 'writeFile').mockImplementationOnce(async (data) => {
      await h.write(Buffer.from(data as Buffer).subarray(0, 4));
      throw enospc();
    });
    return h;
  });
}

describe('dosya yazımı (06-B4)', () => {
  let app: FastifyInstance;
  let A: Fixture;

  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
  });
  afterEach(() => vi.restoreAllMocks());

  const csvForm = () =>
    multipart([
      { name: 'carrierId', value: A.carrierId },
      { name: 'file', filename: 'fatura.csv', contentType: 'text/csv', data: Buffer.from(['Takip No;Desi;Tutar', `${uniq('77')};5;50`].join('\n')) },
    ]);
  const preview = (locale = 'tr') => {
    const form = csvForm();
    return app.inject({ method: 'POST', url: `${API}/invoices/preview`, headers: { ...A.admin.auth, ...form.headers, 'accept-language': locale }, payload: form.payload });
  };

  it('geçici adla yazar, son adına taşır; geçici dosya kalmaz, içerik aynı', async () => {
    const before = new Set(filesOf(A.companyId));
    const buf = Buffer.from('merhaba depo');
    const s = await storeBuffer(A.companyId, buf, 'csv');
    const added = filesOf(A.companyId).filter((f) => !before.has(f));
    expect(added).toEqual([path.join(env.storageDir, s.path)]);
    expect(fs.readFileSync(added[0]!)).toEqual(buf);
    expect(added.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('disk dolunca 507 STORAGE_FULL (TR+EN); yarım dosya ne son adla ne geçici adla kalır', async () => {
    const before = filesOf(A.companyId).length;
    failNextWrite();
    const err = await withLocale('en', () => storeBuffer(A.companyId, Buffer.alloc(1024, 1), 'csv')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(507);
    expect((err as AppError).code).toBe('STORAGE_FULL');
    expect((err as AppError).message).toBe(MESSAGES['err.storageFull'].en);
    expect(filesOf(A.companyId)).toHaveLength(before);
  });

  it('önizleme: disk doluyken kullanıcı anlaşılır ileti alır, dosya ve kayıt kalmaz', async () => {
    const files = filesOf(A.companyId).length;
    const rows = await inCompany(A.companyId, () => prisma.file.count({ where: { companyId: A.companyId } }));
    failNextWrite();
    const res = await preview();
    expect(res.statusCode, res.body).toBe(507);
    expect(res.json().error).toEqual({ code: 'STORAGE_FULL', message: MESSAGES['err.storageFull'].tr });
    expect(filesOf(A.companyId)).toHaveLength(files);
    expect(await inCompany(A.companyId, () => prisma.file.count({ where: { companyId: A.companyId } }))).toBe(rows);
  });

  it('önizleme: dosyanın kaydı yazılamazsa saklanan dosya silinir (sahipsiz dosya kalmaz)', async () => {
    const files = filesOf(A.companyId).length;
    vi.spyOn(getPrisma().file, 'create').mockRejectedValueOnce(new Error('veritabanı yanıt vermedi'));
    const res = await preview();
    expect(res.statusCode).toBe(500);
    expect(filesOf(A.companyId)).toHaveLength(files);
    // sonraki yükleme olağan
    const ok = await preview();
    expect(ok.statusCode, ok.body).toBe(200);
    expect(filesOf(A.companyId)).toHaveLength(files + 1);
  });

  it('bağımsız inceleme: kayıt yazıldığı hâlde hata dönerse (bağlantı yanıttan önce koptu) dosya silinmez', async () => {
    const delegate = getPrisma().file;
    const real = delegate.create.bind(delegate);
    let written = '';
    vi.spyOn(delegate, 'create').mockImplementationOnce((async (args: Parameters<typeof real>[0]) => {
      const row = await real(args);
      written = row.path;
      throw new Error('Server has closed the connection');
    }) as never);
    const res = await preview();
    // bağlantı kopması: "veritabanı şu an yanıt vermiyor" (503)
    expect(res.statusCode).toBe(503);
    expect(written).not.toBe('');
    // kayıt duruyor; dosyası da diskte (silinseydi kayıt dosyasız kalırdı: veri kaybı)
    expect(await inCompany(A.companyId, () => prisma.file.count({ where: { companyId: A.companyId, path: written } }))).toBe(1);
    expect(fs.existsSync(path.join(env.storageDir, written))).toBe(true);
  });

  it('bağımsız inceleme: kaydın hatasından sonra kayıt araması da yapılamazsa dosya silinmez (yetim raporu gösterir)', async () => {
    const files = filesOf(A.companyId).length;
    const delegate = getPrisma().file;
    vi.spyOn(delegate, 'create').mockImplementationOnce((async () => {
      vi.spyOn(delegate, 'findFirst').mockRejectedValueOnce(new Error('veritabanı yanıt vermedi'));
      throw new Error('veritabanı yanıt vermedi');
    }) as never);
    const res = await preview();
    expect(res.statusCode).toBe(500);
    expect(filesOf(A.companyId)).toHaveLength(files + 1);
  });
});
