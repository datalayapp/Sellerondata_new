import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { prisma, withCompany } from '../db.ts';
import { env } from '../env.ts';
import { AppError, notFound } from '../errors.ts';
import { m } from '../i18n/index.ts';

const FILE_TOKEN_TTL_SEC = 10 * 60;

export function sha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpg': 'jpg',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Ölçüm fotoğrafı olarak kabul edilen türler (SVG/HTML gibi betik taşıyabilen türler değil). */
export const PHOTO_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export function extFor(mime: string, fileName?: string): string {
  const fromName = fileName ? path.extname(fileName).slice(1).toLowerCase() : '';
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[mime] ?? 'bin';
}

/** Disk ya da kota dolu (06-B4): kullanıcıya genel hata yerine anlaşılır ileti. */
const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

export function isStorageFullError(e: unknown): boolean {
  return STORAGE_FULL_CODES.has(String((e as NodeJS.ErrnoException | null)?.code ?? ''));
}

/** 507 `STORAGE_FULL`: sunucunun diski doldu; dosya kaydedilmedi. Metin isteğin dilinde. */
export function storageFull(): AppError {
  return new AppError(507, 'STORAGE_FULL', m('err.storageFull'));
}

/**
 * Dosyayı depoya yazar: `<companyId>/<ay>/<uuid>.<uzantı>`. 06-B4: önce aynı klasörde geçici ada (`….tmp`) yazılır, diske
 * işlenir (`fsync`), sonra son adına taşınır (`rename`, aynı dosya sisteminde bölünmez): yarım dosya hiçbir zaman son adla
 * görünmez. Yazma düşerse geçici dosya silinir; disk doluysa (ENOSPC, EDQUOT) 507 `STORAGE_FULL`. Çağıran, dosyanın
 * kaydı (`File` satırı) yazılamazsa `discardStored` ile dosyayı siler.
 */
export async function storeBuffer(companyId: string, buf: Buffer, ext: string) {
  const month = new Date().toISOString().slice(0, 7);
  const rel = path.posix.join(companyId, month, `${crypto.randomUUID()}.${ext}`);
  const abs = path.join(env.storageDir, rel);
  const tmp = `${abs}.tmp`;
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(buf);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (isStorageFullError(e)) throw storageFull();
    throw e;
  }
  return { path: rel, size: buf.length, sha256: sha256(buf) };
}

/**
 * 06-B4: dosya yazıldı ama kaydı yazılamadı (veritabanı hatası): dosya sahipsiz kalmasın. Silme hatası kaydın hatasını
 * gölgelemez (yetim raporu `storage:orphans` sonra gösterir).
 *
 * Mesaj 6 bağımsız inceleme (veri kaybı): kaydın hatası her zaman "yazılmadı" demek değildir. Bağlantı, veritabanı kaydı
 * (ya da işlemin COMMIT'ini) işledikten sonra yanıt gelmeden koparsa istemci hata alır ama satır vardır; dosyayı silmek
 * kaydı dosyasız bırakırdı (fatura kaynağı, tarife PDF'i geri gelmez). Bu yüzden silmeden önce yolu gösteren kayıt
 * (`File`, `TariffDocument`) aranır: varsa silinmez; arama da yapılamazsa (veritabanı hâlâ yanıt vermiyor) silinmez.
 * Sahipsiz kalan dosyayı yetim raporu gösterir; kayıp dosya ise geri getirilemez.
 */
export async function discardStored(rel: string, log?: { warn: (o: object, msg: string) => void }): Promise<void> {
  try {
    if (await storedPathReferenced(rel)) {
      log?.warn({ path: rel }, 'stored file kept: a record points to it although its write reported an error');
      return;
    }
    await deleteStored(rel);
  } catch (e) {
    log?.warn({ err: e, path: rel }, 'stored file could not be removed after its record failed');
  }
}

/** Yolu gösteren kayıt var mı (yol `<companyId>/…`: firmanın bağlamında, RLS ile). */
async function storedPathReferenced(rel: string): Promise<boolean> {
  const companyId = rel.split('/')[0] ?? '';
  const [file, doc] = await withCompany(companyId, () =>
    Promise.all([
      prisma.file.findFirst({ where: { companyId, path: rel }, select: { id: true } }),
      prisma.tariffDocument.findFirst({ where: { companyId, path: rel }, select: { id: true } }),
    ]),
  );
  return file !== null || doc !== null;
}

export function absolutePath(rel: string): string {
  const root = path.resolve(env.storageDir);
  const abs = path.resolve(root, rel);
  // "storage2/..." gibi kardeş klasörler de reddedilsin (yalnız root'un içi)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Geçersiz dosya yolu');
  return abs;
}

/** Kayıt duruyor ama dosya diskte yoksa kullanıcı hatası değil, ama sunucu hatası da değil: 404. */
export async function readStored(rel: string): Promise<Buffer> {
  try {
    return await fs.readFile(absolutePath(rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(m('file.notFound'));
    throw e;
  }
}

/**
 * Saklanan tek dosyayı siler (Mesaj 7, `services/fileCleanup.ts`). Dosya zaten yoksa sorun değil (ENOENT yutulur);
 * diğer hata atılır, çağıran günlüğe yazar. Yol `absolutePath` ile depo kökünün içine bağlanır; kökün kendisi ve klasörler
 * silinmez (`unlink` klasörde hata verir, özyinelemeli silme yok).
 */
export async function deleteStored(rel: string): Promise<void> {
  const abs = absolutePath(rel);
  if (abs === path.resolve(env.storageDir)) throw new Error('Geçersiz dosya yolu');
  try {
    await fs.unlink(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', `file:${env.fileTokenSecret}`).update(payload).digest('base64url');
}

export type FileGrant = { fileId: string; companyId: string; membershipId: string; epoch: number };

/**
 * İmzalı dosya bağlantısı. Yalnız Bearer oturumu içindir: mobilde `<Image uri>` başlık taşımıyor. Web çerezle gelir, jeton üretilmez.
 * Bağlantı adreste taşındığı için günlüğe ve Referer'a düşebilir: kısa ömürlü, tek dosyaya ve kişiye bağlıdır,
 * üyelik askıya alınır ya da yetkisi değişirse (epoch) süresi dolmadan düşer.
 */
export function signFileToken(grant: FileGrant, ttlSec = FILE_TOKEN_TTL_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = Buffer.from(JSON.stringify({ f: grant.fileId, c: grant.companyId, m: grant.membershipId, p: grant.epoch, e: exp })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifyFileToken(token: string): FileGrant | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  // Uzunluk bayt olarak karşılaştırılır: çok baytlı karakter içeren imza timingSafeEqual'ı patlatmasın.
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { f: string; c: string; m: string; p: number; e: number };
    if (data.e < Math.floor(Date.now() / 1000)) return null;
    return { fileId: data.f, companyId: data.c, membershipId: data.m, epoch: data.p };
  } catch {
    return null;
  }
}

/**
 * Dosya bağlantısının kökü. Üretimde yapılandırmadan (`APP_BASE_URL`): Host ve X-Forwarded-* başlıklarını istemci ya da
 * yanlış ayarlanmış bir vekil yazabilir, bağlantı başka adrese ya da düz HTTP'ye gitmesin. Geliştirmede istekten
 * (gateway'in yazdığı X-Forwarded-Host/-Proto, yoksa Host): telefon bilgisayarın ağ adresiyle bağlanır.
 */
export function publicBase(req: FastifyRequest): string {
  if (env.isProduction) return env.appBaseUrl;
  const fwdHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) ?? req.headers.host ?? `localhost:${env.port}`;
  const fwdProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto) ?? req.protocol ?? 'http';
  return `${proto}://${host}`;
}

/** Çerezli oturumda adres yalındır: yetki istekte denetlenir. Bearer oturumunda imzalı. */
export function fileUrl(req: FastifyRequest, fileId: string, companyId: string): string {
  const url = `${publicBase(req)}/api/deciship/files/${fileId}`;
  if (!req.headers.authorization && req.headers.cookie) return url;
  const auth = req.auth as { membershipId: string; epoch?: number };
  return `${url}?t=${signFileToken({ fileId, companyId, membershipId: auth.membershipId, epoch: auth.epoch ?? 0 })}`;
}

/** Günlüğe jeton yazılmaz. */
export function redactFileToken(url: string | undefined): string | undefined {
  return url?.replace(/([?&]t=)[^&]*/g, '$1[gizli]');
}
