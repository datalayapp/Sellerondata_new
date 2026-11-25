import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export const MAX_EDGE = 1600;

export type Photo = { uri: string; width: number; height: number };

/** Uzun kenarı 1600 px'e indirir, JPEG %80 kaydeder. */
export async function compressPhoto(uri: string, width: number, height: number, maxEdge = MAX_EDGE): Promise<Photo> {
  const ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > maxEdge) {
    if (width >= height) ctx.resize({ width: maxEdge });
    else ctx.resize({ height: maxEdge });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  if (out.uri !== uri) deleteQuietly(uri);
  return { uri: out.uri, width: out.width, height: out.height };
}

/** Boyutu bilinmeyen bir görüntüyü (ör. yerel modül anlık görüntüsü) sıkıştırır. */
export async function compressUnknown(uri: string): Promise<Photo> {
  const probe = await ImageManipulator.manipulate(uri).renderAsync();
  return compressPhoto(uri, probe.width, probe.height);
}

export function queueDir(clientId: string): Directory {
  const dir = new Directory(Paths.document, 'queue', clientId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export async function copyToQueue(clientId: string, uri: string, index: number | string): Promise<string> {
  const dir = queueDir(clientId);
  const target = new File(dir, `${index}.jpg`);
  if (target.exists) target.delete();
  await new File(uri).copy(target);
  return target.uri;
}

/**
 * Yarım ölçümün (taslak) fotoğrafları: kalıcı belge klasörü `drafts/<klasör>/`. Sıkıştırılmış çekim önbellekte
 * (`cacheDirectory/ImageManipulator`) doğar; telefon önbelleği temizleyince silinir, taslak 2 gün bekleyebilir.
 */
export function draftsRoot(): Directory {
  return new Directory(Paths.document, 'drafts');
}

/** Klasör adresinin sonunda tek `/` (önek karşılaştırması `drafts2/` gibi komşuyu kapsamasın). */
export function dirPrefix(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

/**
 * Dosyayı `drafts/<folder>/<name>` olarak kopyalar; kaynak yerinde kalır. Kopya doğrulanamazsa fırlatır (çağıran eski
 * adresi tutar). `folder` ve `name` yol ayıracı içermemeli (çağıran temizler).
 */
export function copyIntoDraft(folder: string, uri: string, name: string): string {
  const dir = new Directory(draftsRoot(), folder);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, name);
  // Kendi üstüne kopyalama yok: Android'de `overwrite` önce hedefi (yani kaynağı) siler.
  if (uri === target.uri || uri.endsWith(`/drafts/${folder}/${name}`)) return uri;
  new File(uri).copySync(target, { overwrite: true });
  if (!target.exists) throw new Error('draft photo copy missing');
  return target.uri;
}

export function deleteQueueDir(clientId: string): void {
  try {
    const dir = new Directory(Paths.document, 'queue', clientId);
    if (dir.exists) dir.delete();
  } catch {
    /* yok say */
  }
}

export function deleteQuietly(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* yok say */
  }
}

export function fileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}
