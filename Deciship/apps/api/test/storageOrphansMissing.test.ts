import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { env } from '../src/env.ts';
import { formatOrphanReport } from '../src/cli/storageOrphans.ts';
import { scanStorageOrphans } from '../src/services/storageOrphans.ts';
import { companyFixture, type Fixture } from './fixtures.ts';
import { getApp, inCompany } from './helpers.ts';

/** 06-B7: kaydı olup diskte olmayan dosyalar (`missing`); rapor hiçbir şeye yazmaz. */
describe('yetim raporu: kaydı var, diskte yok', () => {
  let app: FastifyInstance;
  let A: Fixture;
  beforeAll(async () => {
    app = await getApp();
    A = await companyFixture(app);
  });

  it('silinen fatura dosyası ve ölçüm fotoğrafı missing; duran dosya ve temizlenmiş satır değil', async () => {
    const files = await inCompany(A.companyId, () => prisma.file.findMany({ where: { companyId: A.companyId, purgedAt: null } }));
    const src = files.find((f) => f.kind === 'INVOICE_SOURCE')!;
    const photo = files.find((f) => f.measurementId === A.measurement.id)!;
    expect(src && photo).toBeTruthy();
    const keep = files.filter((f) => f.id !== src.id && f.id !== photo.id);
    // temizlenmiş satır: diskte yok ama sayılmaz
    const purged = await inCompany(A.companyId, () =>
      prisma.file.create({ data: { companyId: A.companyId, kind: 'INVOICE_SOURCE', mime: 'text/csv', size: 1, path: `${A.companyId}/gone/p.csv`, sha256: 'x', createdById: A.admin.userId, purgedAt: new Date() } }),
    );
    for (const f of [src, photo]) fs.rmSync(path.join(env.storageDir, f.path), { force: true });

    const r = await scanStorageOrphans();
    const mine = r.missing.filter((m) => m.companyId === A.companyId);
    const byId = new Map(mine.map((m) => [m.id, m]));
    expect(byId.get(src.id)).toMatchObject({ source: 'file', kind: 'INVOICE_SOURCE', path: src.path, size: src.size, invoiceId: src.invoiceId, measurementId: null });
    expect(byId.get(photo.id)).toMatchObject({ source: 'file', kind: photo.kind, measurementId: A.measurement.id });
    for (const k of keep) if (fs.existsSync(path.join(env.storageDir, k.path))) expect(byId.has(k.id)).toBe(false);
    expect(byId.has(purged.id)).toBe(false);
    expect(r.missingCount).toBe(r.missing.length);

    const lines = formatOrphanReport(r);
    expect(lines).toContain(`MISSING ${src.path} source=file id=${src.id} kind=INVOICE_SOURCE${src.invoiceId ? ` invoice=${src.invoiceId}` : ''}`);
    expect(lines.some((l) => l.startsWith(`MISSING ${photo.path} source=file id=${photo.id} kind=${photo.kind}`) && l.endsWith(`measurement=${A.measurement.id}`))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(new RegExp(` missing=${r.missingCount} `));
  });
});
