/**
 * Y80-E5: kaydı olmayan disk dosyalarının raporu; 06-B7: ters yön, kaydı olup diskte olmayan dosyalar (`MISSING` satırı).
 * **Yalnız raporlar, hiçbir şey silmez ve yazmaz** (kural `services/storageOrphans.ts`).
 *
 *   npm run storage:orphans -- [--min-age-hours <n>] [--json]
 *   Üretim kabında: node dist/cli/storageOrphans.js [--min-age-hours <n>] [--json]
 *
 * Haftada bir elle ya da zamanlanmış görevle çalıştırılır. `--min-age-hours` (varsayılan 1): bundan yeni kayıtsız dosya
 * "yükleme sürüyor olabilir" sayılır, listelenmez. `--json`: makine için tek JSON. Çıkış kodu: 0 tarama bitti (yetim olsa da),
 * 2 bozuk bayrak, 1 hata. Çıktı ASCII İngilizce (test/i18n.test.ts kaynakta Türkçe harf arar); dosya içeriği yazılmaz.
 */
import { ORPHAN_MIN_AGE_MS, scanStorageOrphans, type OrphanReport } from '../services/storageOrphans.ts';

export type CliOut = { log: (line: string) => void; error: (line: string) => void };
export type OrphanArgs = { minAgeMs: number; json: boolean };

const HELP = ['Usage:', '  storage:orphans -- [--min-age-hours <n>] [--json]', '  Reports files on disk that no record points to, and records whose file is missing on disk. Nothing is deleted.'];

export function parseOrphanArgs(argv: string[]): OrphanArgs {
  const out: OrphanArgs = { minAgeMs: ORPHAN_MIN_AGE_MS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--min-age-hours') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error('--min-age-hours needs a number >= 0');
      out.minAgeMs = v * 60 * 60 * 1000;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export function formatOrphanReport(r: OrphanReport): string[] {
  const lines = r.orphans.map(
    (f) => `${f.reason === 'purged' ? 'PURGED' : 'ORPHAN'} ${f.path} size=${f.size} modified=${f.mtime.toISOString()}${f.companyId && !f.companyKnown ? ' company=unknown' : ''}`,
  );
  for (const m of r.missing) {
    lines.push(
      `MISSING ${m.path} source=${m.source} id=${m.id} kind=${m.kind ?? 'none'}` +
        (m.invoiceId ? ` invoice=${m.invoiceId}` : '') +
        (m.measurementId ? ` measurement=${m.measurementId}` : ''),
    );
  }
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  lines.push(
    `Done (nothing deleted): root=${r.root} scanned=${r.scanned} orphans=${r.orphans.length} orphanMB=${mb} missing=${r.missingCount} recentSkipped=${r.young} links=${r.links}` +
      (r.otherDirs.length ? ` otherDirs=${r.otherDirs.join(',')}` : ''),
  );
  return lines;
}

export async function runOrphansCli(argv: string[], out: CliOut = { log: (l) => console.log(l), error: (l) => console.error(l) }): Promise<number> {
  let args: OrphanArgs;
  try {
    args = parseOrphanArgs(argv);
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    for (const l of HELP) out.error(l);
    return 2;
  }
  try {
    const r = await scanStorageOrphans({ minAgeMs: args.minAgeMs });
    if (args.json) out.log(JSON.stringify(r));
    else for (const l of formatOrphanReport(r)) out.log(l);
    return 0;
  } catch (err) {
    out.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
