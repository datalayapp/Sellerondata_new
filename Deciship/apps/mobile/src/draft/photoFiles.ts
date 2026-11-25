/**
 * Yarım ölçümün (taslak) fotoğraf dosyaları (11-B4). Taslağa giren her fotoğrafın kalıcı kopyası `drafts/<clientId>/`
 * altında durur; önbellek (`Paths.cache`) telefon temizleyince silinir, kanıt fotoğrafı kaybolurdu.
 *
 * Kurallar:
 * - Kopyalama başarısızsa eski adres kalır (fotoğraf kaybolmaz); sonraki açılışta geri yükleme yeniden dener.
 * - Önbellekteki kaynak kopyadan hemen sonra silinmez: ekran o adresi hâlâ kullanıyor olabilir (ör. tartı okuması, kart
 *   ölçümü). Bu oturumda alınan kaynak, taslak fotoğrafı silinince birlikte silinir; uygulama arada kapanırsa önbellekte
 *   kalır, telefonun kendisi temizler.
 * - Kuyruğun kopyalarına (`queue/<clientId>/`) asla dokunulmaz. Klasör yalnız boşalınca silinir; dolu klasörü yalnız
 *   açılış süpürmesi, hiçbir taslak onu anmıyorsa siler.
 */
import { Directory, Paths } from 'expo-file-system';
import { copyIntoDraft, deleteQuietly, dirPrefix, draftsRoot } from '../lib/images';
import type { DraftPhoto } from './DraftContext';

const under = (uri: string, dir: () => Directory): boolean => {
  try {
    return uri.startsWith(dirPrefix(dir().uri));
  } catch {
    return false;
  }
};

/** Kuyruğun kendi kopyaları (`queue/<clientId>/`). Taslak temizliği bunlara asla dokunmaz. */
export function isQueueFile(uri: string): boolean {
  return under(uri, () => new Directory(Paths.document, 'queue'));
}

export function isDraftFile(uri: string): boolean {
  return under(uri, draftsRoot);
}

/** Klasör ve dosya adı: yalnız harf, rakam, `-`, `_` (yol ayıracı ya da `..` yok). */
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '_';

/** Taslağın klasör adı. */
export const draftFolder = (clientId: string) => safe(clientId);

/** Kalıcı kopya → bu oturumda kopyalandığı önbellek kaynağı. */
const sources = new Map<string, string>();
/** Bu oturumda açılan klasörler: açılış süpürmesi bunlara dokunmaz (diske yazılmadan önceki ilk 300 ms dahil). */
const opened = new Set<string>();

/**
 * Taslağa giren fotoğraf: kalıcı klasöre kopyalanır, yeni adres döner. Zaten taslak klasöründe ya da kuyruktaysa aynı adres.
 * Kopyalanamazsa eski adres döner (fotoğraf kaybolmaz).
 */
export function keepDraftPhoto(clientId: string, uri: string, name: string): string {
  if (!uri || isDraftFile(uri) || isQueueFile(uri)) return uri;
  const folder = draftFolder(clientId);
  opened.add(folder);
  try {
    const kept = copyIntoDraft(folder, uri, `${safe(name)}.jpg`);
    sources.set(kept, uri);
    return kept;
  } catch (e) {
    console.warn('draft photo copy', e);
    return uri;
  }
}

/**
 * Geri yüklemede eski taslağın fotoğrafı (önbellek adresi): kalıcı klasöre kopyalanır. Ad sırası ve kimliğiyle sabittir;
 * yarıda kalan deneme yeniden yapılınca aynı dosyanın üstüne yazılır. Kaynak silinmez: bellekteki taslak (korumalı açılış)
 * eski adresi tutuyor olabilir. Kopyalanamazsa eski adres döner.
 */
export function migrateDraftPhoto(clientId: string, p: DraftPhoto, index: number): string {
  if (isDraftFile(p.uri) || isQueueFile(p.uri)) return p.uri;
  const folder = draftFolder(clientId);
  opened.add(folder);
  try {
    return copyIntoDraft(folder, p.uri, `m${index}-${safe(p.id)}.jpg`);
  } catch (e) {
    console.warn('draft photo migrate', e);
    return p.uri;
  }
}

/** `drafts/<klasör>/` boşaldıysa silinir. Kökün kendisi ya da daha derin bir yol silinmez. */
function removeEmptyFolder(uri: string): void {
  try {
    const root = dirPrefix(draftsRoot().uri);
    const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
    const name = parent.slice(root.length, -1);
    if (!parent.startsWith(root) || !name || name.includes('/')) return;
    const dir = new Directory(parent);
    if (dir.exists && dir.list().length === 0) dir.delete();
  } catch {
    /* yok say */
  }
}

/**
 * Taslak fotoğrafı silinir: kalıcı kopya, bu oturumda alınmışsa önbellekteki kaynağı ve boşalan klasörü. Kuyruk dosyasına
 * dokunulmaz. `keep`: hâlâ kullanılan adresler (aynı kaynaktan yeni kopya alındıysa kaynak ve yeni kopya) silinmez.
 */
export function deleteDraftPhoto(uri: string, keep?: ReadonlySet<string>): void {
  if (!uri || isQueueFile(uri) || keep?.has(uri)) return;
  deleteQuietly(uri);
  const src = sources.get(uri);
  sources.delete(uri);
  if (src && !keep?.has(src) && !isQueueFile(src) && !isDraftFile(src)) deleteQuietly(src);
  if (isDraftFile(uri)) removeEmptyFolder(uri);
}

/**
 * Açılış süpürmesi: hiçbir taslağın sahiplenmediği `drafts/<klasör>/` silinir. Bir klasör şu durumlardan biriyle kalır:
 * adı bilinen bir taslak kimliği (`ids`: diskteki bütün taslaklar ve bellekteki geçerli taslak), bir taslak fotoğrafının
 * adresi onu anıyor (`uris`; okunamayan satırlar da taranır) ya da bu oturumda açıldı. Okuma hatasında çağrılmaz.
 */
export function sweepOrphanDraftDirs(keep: { ids: Iterable<string>; uris: Iterable<string> }): number {
  let n = 0;
  try {
    const root = draftsRoot();
    if (!root.exists) return 0;
    const ids = new Set([...keep.ids].map(draftFolder));
    const uris = [...keep.uris];
    for (const e of root.list()) {
      if (!(e instanceof Directory)) continue;
      const name = e.name || dirPrefix(e.uri).slice(0, -1).split('/').pop() || '';
      if (!name || ids.has(name) || opened.has(name)) continue;
      const mark = `/drafts/${name}/`;
      if (uris.some((u) => u.includes(mark) || u.startsWith(dirPrefix(e.uri)))) continue;
      try {
        e.delete();
        n++;
      } catch {
        /* yok say */
      }
    }
  } catch (e) {
    console.warn('draft orphan sweep', e);
  }
  return n;
}
