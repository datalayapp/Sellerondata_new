import Fastify, { type FastifyInstance } from 'fastify';
import type { HubColumn, HubDatasetPage, HubRow, Locale, Permission } from '@sellerondata/contracts';
import {
  queryInt,
  registerHubRoutes,
  registerProductIdentity,
  requestLocale,
  withOrg,
  type HubCtx,
  type ProductIdentity,
  type PurgeConfig,
  type SqlDb,
} from '../../src/index.ts';
import { ORNEKARAC, ORNEKARAC_SCHEMA } from './product.ts';

/**
 * Örnek Araç'ın API'si: ikinci bir aracın product-kit ile ne kadar az kod yazdığını gösterir (Mesaj 11 §3.10).
 * Kimlik + bir yazma ucu + Merkez sağlayıcıları (Genel Bakış tek KPI ve kurulum, `kayitlar` veri kümesi, Etkinlik boş) + kalıcı
 * silme (kendi tablosu, eki diskte olan satırlar).
 */

const LABELS = {
  tr: {
    items: 'Kayıt',
    dataset: 'Kayıtlar',
    title: 'Başlık',
    createdAt: 'Eklenme',
    titleRequired: 'Başlık 1–200 karakter olmalı',
    setup: 'Örnek Araç kurulumunu tamamlayın',
    firstItem: 'İlk kaydı ekleyin',
  },
  en: {
    items: 'Records',
    dataset: 'Records',
    title: 'Title',
    createdAt: 'Added',
    titleRequired: 'Title must be 1–200 characters',
    setup: 'Finish setting up Sample Tool',
    firstItem: 'Add the first record',
  },
} as const satisfies Record<Locale, Record<string, string>>;

const DATASET = 'kayitlar';
const PAGE_SIZE = 50;
const EXPORT_BATCH = 500;

type ItemRow = { id: string; title: string; createdAt: Date };

export const SETUP_HREF = '/ornekarac/kurulum';

export type OrnekAppOptions = {
  db: SqlDb;
  jwksUrl: string;
  fetch?: typeof fetch;
  allowedOrigins: readonly string[];
  /** Testin dosya kancaları (gerçek araçta diskteki ek ve firmanın klasörü silinir). */
  purgeHooks?: Pick<PurgeConfig, 'onRowsDeleted' | 'onPurged'>;
  /** Bakım zamanlayıcısı (varsayılan paketin; 0 kapalı). */
  purgeRetryEveryMs?: number;
};

export async function buildOrnekApp(opts: OrnekAppOptions): Promise<{ app: FastifyInstance; identity: ProductIdentity }> {
  const { db } = opts;
  const app = Fastify();
  const P = (p: keyof typeof ORNEKARAC.permissions) => p as Permission; // fikstür kayıtta değil: izin türü `Permission` dışında

  const identity = registerProductIdentity(app, {
    product: ORNEKARAC.key,
    definition: ORNEKARAC,
    db,
    schema: ORNEKARAC_SCHEMA,
    jwksUrl: opts.jwksUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    allowedOrigins: opts.allowedOrigins,
    // Firma kalıcı silinirken aracın kendi satırları (üyeye ve firmaya yabancı anahtarlı) üyeden önce gider; ekin yolu
    // parçanın commit'inden sonra dosya kancasına verilir.
    // Gerçek araçta `onRowsDeleted` ekleri, `onPurged` firmanın klasörünü siler (kalan her şeyi kapsar); burada test kancaları.
    purge: { tables: [{ table: 'Item', returning: ['attachment'] }], onRowsDeleted: async () => {}, onPurged: async () => {}, ...opts.purgeHooks },
    ...(opts.purgeRetryEveryMs === undefined ? {} : { purgeRetryEveryMs: opts.purgeRetryEveryMs }),
  });

  app.post('/api/ornekarac/items', { onRequest: app.requirePermission(P('ornekarac.items.write')) }, async (req, reply) => {
    const body = (req.body ?? {}) as { title?: unknown; attachment?: unknown };
    const { title } = body;
    const attachment = typeof body.attachment === 'string' ? body.attachment : null;
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: LABELS[requestLocale(req, req.auth.locale)].titleRequired } });
    }
    const [row] = await withOrg(db, req.auth.orgId, (tx) =>
      tx.query<{ id: string }>(`INSERT INTO ornekarac."Item" ("orgId", "title", "attachment", "createdBy") VALUES ($1, $2, $3, $4) RETURNING "id"`, [
        req.auth.orgId,
        title.trim(),
        attachment,
        req.auth.membershipId,
      ]),
    );
    return reply.status(201).send({ id: row!.id });
  });

  app.get('/api/ornekarac/items', { onRequest: app.requirePermission(P('ornekarac.data.view')) }, async (req) =>
    withOrg(db, req.auth.orgId, (tx) => tx.query<{ id: string; title: string }>(`SELECT "id", "title" FROM ornekarac."Item" ORDER BY "createdAt", "id"`)),
  );

  const columns = (locale: Locale): HubColumn[] => [
    { id: 'title', label: LABELS[locale].title, format: 'text' },
    { id: 'createdAt', label: LABELS[locale].createdAt, format: 'datetime' },
  ];
  const toRow = (r: ItemRow): HubRow => ({ id: r.id, cells: { title: r.title, createdAt: r.createdAt.toISOString() } });
  const readPage = (ctx: HubCtx, limit: number, offset: number) =>
    withOrg(db, ctx.orgId, (tx) =>
      tx.query<ItemRow>(`SELECT "id", "title", "createdAt" FROM ornekarac."Item" ORDER BY "createdAt", "id" LIMIT $1 OFFSET $2`, [limit, offset]),
    );

  registerHubRoutes(app, {
    product: ORNEKARAC.key,
    definition: ORNEKARAC,
    providers: {
      overview: async (ctx, period) => {
        const [count] = await withOrg(db, ctx.orgId, (tx) =>
          tx.query<{ n: number; any: boolean }>(
            `SELECT count(*) FILTER (WHERE "createdAt" >= $1 AND "createdAt" < $2)::int AS n, count(*) > 0 AS any FROM ornekarac."Item"`,
            [period.start, period.end],
          ),
        );
        const L = LABELS[ctx.locale];
        // Kurulum: aracın kendi adımı VE firma bilgilerinin Merkez onayı (onay Merkez'in panelinde, burada adım değil).
        const firstItem = count?.any === true;
        const completed = ctx.companyConfirmed && firstItem;
        return {
          product: ORNEKARAC.key,
          from: period.from,
          to: period.to,
          kpis: [{ id: 'items', label: L.items, value: count?.n ?? 0, format: 'number' }],
          alerts: [],
          setup: {
            completed,
            href: SETUP_HREF,
            label: completed ? '' : L.setup,
            steps: [{ id: 'first-item', label: L.firstItem, done: firstItem, href: SETUP_HREF, required: true }],
          },
        };
      },
      datasets: {
        list: async (ctx) => ({
          product: ORNEKARAC.key,
          datasets: [{ id: DATASET, label: LABELS[ctx.locale].dataset, filters: [], exportable: ctx.can('ornekarac.data.export') }],
        }),
        page: async (ctx, id, query): Promise<HubDatasetPage | null> => {
          if (id !== DATASET) return null;
          const page = queryInt(query.page, 1, 'page', ctx.locale);
          const [total] = await withOrg(db, ctx.orgId, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ornekarac."Item"`));
          const rows = await readPage(ctx, PAGE_SIZE, (page - 1) * PAGE_SIZE);
          return { id, page, pageSize: PAGE_SIZE, total: total?.n ?? 0, columns: columns(ctx.locale), rows: rows.map(toRow) };
        },
        export: async (ctx, id) => {
          if (id !== DATASET) return null;
          return {
            columns: columns(ctx.locale),
            async *batches() {
              for (let offset = 0; ; offset += EXPORT_BATCH) {
                const rows = await readPage(ctx, EXPORT_BATCH, offset);
                if (rows.length) yield rows.map(toRow);
                if (rows.length < EXPORT_BATCH) return;
              }
            },
          };
        },
      },
      // activity verilmedi: Merkez boş Etkinlik sayfası alır.
    },
  });

  await app.ready();
  return { app, identity };
}
