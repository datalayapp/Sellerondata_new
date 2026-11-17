/**
 * Y80-E5: kaydı olmayan disk dosyalarının raporu (`npm run storage:orphans`). **Yalnız okur, hiçbir şey silmez ve yazmaz.**
 * 06-B7: ters yön de raporlanır: `missing` = kaydı (temizlenmemiş `File`, `TariffDocument`) duruyor ama dosya diskte yok.
 *
 * Depo düzeni `storeBuffer`: `<companyId>/<ay>/<uuid>.<uzantı>`. Her firma klasörü kendi firmasının bağlamında (RLS)
 * `File.path` ve `TariffDocument.path` ile karşılaştırılır; böylece bakım kapsamına yeni ilke gerekmez.
 *
 * - `orphan`: yolu hiçbir kayıt göstermiyor (yarıda düşen yükleme, silinemeyen disk dosyası, silinmiş firmanın klasörü).
 * - `purged`: yalnız temizlenmiş (`purgedAt`) satır gösteriyor; diskten silinmesi gerekirdi (silme hatası).
 * - `young`: kaydı yok ama `minAgeMs`'ten yeni (yükleme sürüyor olabilir: dosya kayıttan önce yazılır); listelenmez, sayılır.
 * - Firma klasörü olmayan üst klasörler (`fx` kur önbelleği vb.) taranmaz, adları yazılır; kökteki dosyalar `orphan` sayılır.
 * - Sembolik bağlantı izlenmez (sayılır, listelenmez).
 * - `missing`: veritabanındaki her firma (bakım kapsamıyla `Company` okunur) ve disk klasörü olan her firma taranır; kaydın yolu
 *   taranan klasörde yoksa ayrıca `stat` ile bakılır (bağlantı vb.). Yol depo kökünün dışına çıkıyorsa da kayıp sayılır.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma, withCompany, withMaintenanceScope } from '../db.ts';
import { env } from '../env.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bu süreden yeni kayıtsız dosya "yükleme sürüyor olabilir" sayılır. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const QUERY_CHUNK = 500;

export type StorageEntry = { path: string; size: number; mtime: Date };
export type OrphanEntry = StorageEntry & { companyId: string | null; reason: 'orphan' | 'purged'; companyKnown: boolean };
export type MissingEntry = {
  companyId: string;
  source: 'file' | 'tariffDocument';
  id: string;
  path: string;
  kind: string | null;
  invoiceId: string | null;
  measurementId: string | null;
  size: number;
};
export type OrphanReport = {
  root: string;
  scanned: number;
  bytes: number;
  orphans: OrphanEntry[];
  young: number;
  links: number;
  otherDirs: string[];
  missing: MissingEntry[];
  missingCount: number;
};

/** Klasörü özyinelemeli gezer; `rel` köke göre posix yolu. Bağlantılar izlenmez. */
async function walk(abs: string, rel: string, out: StorageEntry[], counts: { links: number }): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    const a = path.join(abs, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) counts.links++;
    else if (e.isDirectory()) await walk(a, r, out, counts);
    else if (e.isFile()) {
      const st = await fs.stat(a);
      out.push({ path: r, size: st.size, mtime: st.mtime });
    }
  }
}

/** Firma bağlamında: verilen yollardan hangileri canlı kayıtta, hangileri yalnız temizlenmiş satırda. */
async function knownPaths(companyId: string, paths: string[]): Promise<{ live: Set<string>; purged: Set<string>; companyKnown: boolean }> {
  return withCompany(companyId, async () => {
    const live = new Set<string>();
    const purged = new Set<string>();
    for (let i = 0; i < paths.length; i += QUERY_CHUNK) {
      const chunk = paths.slice(i, i + QUERY_CHUNK);
      const files = await prisma.file.findMany({ where: { companyId, path: { in: chunk } }, select: { path: true, purgedAt: true } });
      for (const f of files) (f.purgedAt ? purged : live).add(f.path);
      const docs = await prisma.tariffDocument.findMany({ where: { companyId, path: { in: chunk } }, select: { path: true } });
      for (const d of docs) live.add(d.path);
    }
    for (const p of live) purged.delete(p);
    const companyKnown = (await prisma.company.count({ where: { id: companyId } })) > 0;
    return { live, purged, companyKnown };
  });
}

/** Dosya olarak diskte var mı; yol kökün dışına çıkıyorsa yok sayılır. */
async function existsAsFile(root: string, rel: string): Promise<boolean> {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** Firmanın kayıtlı ama diskte olmayan dosyaları; `onDisk` o firmanın taranmış klasöründeki yollar (varsa). */
async function findMissing(companyId: string, root: string, onDisk: Set<string> | null): Promise<MissingEntry[]> {
  const out: MissingEntry[] = [];
  const present = async (p: string) => (onDisk?.has(p) ? true : existsAsFile(root, p));
  let cursor: string | undefined;
  for (;;) {
    const page = await withCompany(companyId, () =>
      prisma.file.findMany({
        where: { companyId, purgedAt: null },
        select: { id: true, path: true, kind: true, invoiceId: true, measurementId: true, size: true },
        orderBy: { id: 'asc' },
        take: QUERY_CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for (const f of page) {
      if (!(await present(f.path))) out.push({ companyId, source: 'file', id: f.id, path: f.path, kind: f.kind, invoiceId: f.invoiceId, measurementId: f.measurementId, size: f.size });
    }
    if (page.length < QUERY_CHUNK) break;
    cursor = page[page.length - 1]!.id;
  }
  cursor = undefined;
  for (;;) {
    const page = await withCompany(companyId, () =>
      prisma.tariffDocument.findMany({
        where: { companyId },
        select: { id: true, path: true, size: true },
        orderBy: { id: 'asc' },
        take: QUERY_CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for (const d of page) {
      if (!(await present(d.path))) out.push({ companyId, source: 'tariffDocument', id: d.id, path: d.path, kind: null, invoiceId: null, measurementId: null, size: d.size });
    }
    if (page.length < QUERY_CHUNK) break;
    cursor = page[page.length - 1]!.id;
  }
  return out;
}

/** Raporu üretir. Hiçbir dosyaya ve satıra yazmaz. */
export async function scanStorageOrphans(o: { now?: number; minAgeMs?: number; root?: string } = {}): Promise<OrphanReport> {
  const now = o.now ?? Date.now();
  const minAgeMs = o.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const root = path.resolve(o.root ?? env.storageDir);
  const report: OrphanReport = { root, scanned: 0, bytes: 0, orphans: [], young: 0, links: 0, otherDirs: [], missing: [], missingCount: 0 };
  const folderPaths = new Map<string, Set<string>>();
  let top: import('node:fs').Dirent[];
  try {
    top = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    top = [];
  }
  const counts = { links: 0 };
  const isYoung = (f: StorageEntry) => now - f.mtime.getTime() < minAgeMs;
  for (const e of top.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isSymbolicLink()) {
      counts.links++;
      continue;
    }
    if (e.isFile()) {
      const st = await fs.stat(path.join(root, e.name));
      const f = { path: e.name, size: st.size, mtime: st.mtime };
      report.scanned++;
      if (isYoung(f)) report.young++;
      else report.orphans.push({ ...f, companyId: null, reason: 'orphan', companyKnown: false });
      continue;
    }
    if (!e.isDirectory()) continue;
    if (!UUID.test(e.name)) {
      report.otherDirs.push(e.name);
      continue;
    }
    const files: StorageEntry[] = [];
    await walk(path.join(root, e.name), e.name, files, counts);
    report.scanned += files.length;
    folderPaths.set(e.name, new Set(files.map((f) => f.path)));
    if (!files.length) continue;
    const { live, purged, companyKnown } = await knownPaths(e.name, files.map((f) => f.path));
    for (const f of files) {
      if (live.has(f.path)) continue;
      if (purged.has(f.path)) {
        report.orphans.push({ ...f, companyId: e.name, reason: 'purged', companyKnown });
        continue;
      }
      if (isYoung(f)) {
        report.young++;
        continue;
      }
      report.orphans.push({ ...f, companyId: e.name, reason: 'orphan', companyKnown });
    }
  }
  report.links = counts.links;
  // Ters yön: veritabanındaki firmalar + disk klasörleri. Firma listesi alınamazsa yalnız disk klasörleriyle devam edilir.
  const ids = new Set(folderPaths.keys());
  try {
    const rows = await withMaintenanceScope(() => prisma.company.findMany({ select: { id: true }, orderBy: { id: 'asc' } }));
    // klasör adı firma kimliğinin kendisidir (`storeBuffer`); büyük/küçük harf dönüştürülmez
    for (const c of rows) ids.add(c.id);
  } catch {
    // bakım kapsamı Company okuyamıyorsa disk klasörleriyle yetinilir
  }
  for (const id of [...ids].sort()) {
    const set = folderPaths.get(id) ?? null;
    report.missing.push(...(await findMissing(id, root, set)));
  }
  report.missingCount = report.missing.length;
  report.bytes = report.orphans.reduce((s, f) => s + f.size, 0);
  return report;
}
