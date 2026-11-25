import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { CLIENT_HEADER, errorMessage, isBelowMinimum, localeFromAcceptLanguage, parseClientHeader } from '@sellerondata/contracts';
import { runInCompany, withCompany } from './db.ts';
import { env } from './env.ts';
import { AppError, registerErrorHandling } from './errors.ts';
import { m, registerLocale } from './i18n/index.ts';
import { registerIdentity, type IdentityOptions } from './identity.ts';
import { can } from './lib/access.ts';
import { closeFileWorkers } from './lib/fileWorkers.ts';
import { registerRateLimit } from './lib/rateLimit.ts';
import { redactFileToken } from './lib/storage.ts';
import { carrierRoutes } from './routes/carriers.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { demoRoutes } from './routes/demo.ts';
import { disputeRoutes } from './routes/disputes.ts';
import { fileRoutes } from './routes/files.ts';
import { invoiceRoutes } from './routes/invoices.ts';
import { jobRoutes } from './routes/jobs.ts';
import { meRoutes } from './routes/me.ts';
import { measurementRoutes } from './routes/measurements.ts';
import { hubRoutes } from './routes/platform.ts';
import { settingsRoutes } from './routes/settings.ts';
import { tariffRoutes } from './routes/tariffs.ts';
import { visionRoutes } from './routes/vision.ts';
import { DEMO_BLOCKED, demoActive } from './services/demoTour.ts';
import { closeInlineJobs } from './services/jobs/runner.ts';

export const API_PREFIX = '/api/deciship';

/** 426 denetiminden muaf yollar. */
const UPGRADE_EXEMPT = new Set([`${API_PREFIX}/health`]);

/** Fiyat görme izni olmayan kişinin hiç almaması gereken anahtarlar (SPEC §5). */
export const MONEY_KEY = /price|pricing|amount|expected|diff|net|billed|overcharge/i;
/** Başka sözcüğün parçası olabilen para sözcükleri: yalnız deve notasyonundaki tam sözcük olarak (`rateKg` evet, `generated` hayır). */
const MONEY_WORDS = new Set(['cost', 'costs', 'charge', 'charges', 'fee', 'fees', 'rate', 'rates', 'fx', 'totals', 'discount', 'fuel', 'breakdown']);

function isMoneyKey(key: string): boolean {
  if (key === 'BAD_NET') return false; // yükleme özeti nedeni (`importReport.byReason`): satır sayısı, tutar değil
  if (MONEY_KEY.test(key)) return true;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
  // `total` tek başına sayfa toplamıdır (satır sayısı); `verifiedTotal` gibi bileşik ad tutardır.
  if (words.length > 1 && words.at(-1) === 'total') return true;
  return words.some((w) => MONEY_WORDS.has(w));
}

/**
 * Son güvence. Asıl sınır serileştiricilerdeki açık alan setidir (`serializeMeasurement`, `settingsFor`): yeni bir alan
 * oraya kendiliğinden girmez. Burası bir uçta o set unutulursa devreye girer.
 */
export function stripMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!isMoneyKey(k)) out[k] = stripMoney(v);
    return out;
  }
  return value;
}

/** `guarded`: rota kendi `onRequest` kancasını taşıyor. Herkese açık uç listesi testte, kısadır. */
export type RouteEntry = { method: string; url: string; guarded: boolean; methodCount: number };

declare module 'fastify' {
  interface FastifyInstance {
    /** Kayıtlı uçların listesi. Testler izin matrisini ve firma izolasyonunu buradan üretir: yeni uç testi kırar. */
    routeTable: RouteEntry[];
  }
}

export type BuildAppOptions = { logger?: boolean; identity?: IdentityOptions };

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // İstek günlüğüne imzalı dosya bağlantısı yazılmaz.
    logger: opts.logger
      ? { serializers: { req: (req) => ({ method: req.method, url: redactFileToken(req.url), host: req.host, remoteAddress: req.ip }) } }
      : false,
    bodyLimit: 20 * 1024 * 1024,
    // İsteğin tamamı bu sürede gelmeli (yavaş yükleyen bağlantı sonsuza kadar tutmasın). Yanıt akışı ayrı süreyle kesilir.
    requestTimeout: 5 * 60_000,
    trustProxy: (_address, hop) => hop < env.trustProxyHops,
  });

  const routeTable: RouteEntry[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (route) => {
    const methods = [route.method].flat();
    const guarded = [route.onRequest].flat().filter(Boolean).length > 0;
    for (const method of methods) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routeTable.push({ method, url: route.url, guarded, methodCount: methods.length });
    }
  });

  registerErrorHandling(app);
  registerLocale(app);
  // Mobil uygulamanın desteklenmeyen sürümü: 426. Başlık yoksa ya da bozuksa denetim yok (web, curl, eski APK etkilenmez).
  // Kimlik ve hız sınırından önce: eski sürüm kova harcamaz. Oturuma dokunmaz.
  app.addHook('onRequest', async (req) => {
    const min = env.minMobileVersion;
    if (!min) return;
    const client = parseClientHeader(req.headers[CLIENT_HEADER.toLowerCase()] as string | undefined);
    if (!client || !isBelowMinimum(client.version, min)) return;
    if (UPGRADE_EXEMPT.has(req.url.split('?')[0]!)) return;
    const message = errorMessage('UPGRADE_REQUIRED', localeFromAcceptLanguage(req.headers['accept-language']));
    throw new AppError(426, 'UPGRADE_REQUIRED', message, { minVersion: min, updateUrl: null });
  });
  await app.register(cors, {
    // Çerezli oturum: yalnız izinli kökenler. Üretimde tek köken, gateway arkasında CORS devreye girmez.
    origin: env.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Disposition'],
  });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 20, fields: 20 } });
  registerIdentity(app, opts.identity);

  // Kimlik `onRequest`te denetlenir, gövde sonra okunur. Gövde akış olaylarıyla okunduğu için AsyncLocalStorage bağlamı
  // işleyiciye kadar taşınmaz: firma bağlamı işleyiciden hemen önce yeniden açılır.
  app.addHook('preHandler', (req, _reply, done) => {
    if (req.auth) runInCompany(req.auth.orgId, done);
    else done();
  });

  // Mesaj 14 §4.3: örnek veriyle deneme açıkken taşıyıcı, tarife ve fatura ekleyen uçlar kapalı (`DEMO_BLOCKED`): "Denemeyi
  // bitir" firmanın bütün taşıyıcılarını, tarifelerini ve faturalarını siler, bu yüzden deneme sırasında gerçeği eklenemez.
  // Kimlik ve izin denetiminden sonra, işleyiciden önce; yalnız listedeki uçlarda firma ayarı okunur.
  app.addHook('preHandler', async (req) => {
    if (!req.auth) return;
    const url = req.routeOptions.url;
    if (!url?.startsWith(API_PREFIX) || !DEMO_BLOCKED.has(`${req.method} ${url.slice(API_PREFIX.length)}`)) return;
    const companyId = req.auth.orgId;
    if (await withCompany(companyId, () => demoActive(companyId))) throw new AppError(409, 'DEMO_ACTIVE', m('err.demoActive', undefined, req.locale));
  });

  // Hız sınırı ve ağır yazma yuvası: rota kimlik/izin denetiminden sonra, gövde okunmadan önce (lib/rateLimit.ts).
  registerRateLimit(app, API_PREFIX);

  // Defence in depth: whatever a route returns, someone without price access never sees money fields.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (req.auth && !can(req, 'deciship.prices.view')) return stripMoney(payload);
    return payload;
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      await api.register(meRoutes);
      await api.register(settingsRoutes);
      await api.register(demoRoutes);
      await api.register(measurementRoutes);
      await api.register(fileRoutes);
      await api.register(visionRoutes);
      await api.register(carrierRoutes);
      await api.register(tariffRoutes);
      await api.register(invoiceRoutes);
      await api.register(disputeRoutes);
      await api.register(jobRoutes);
      await api.register(dashboardRoutes);
      // Merkez sözleşmesi (ARCHITECTURE §7). Yalnız okuma: salt okunur abonelikte de açık.
      await api.register(hubRoutes, { guard: (permission) => app.requirePermission(permission, { readOnlyExempt: true }) });
    },
    { prefix: API_PREFIX },
  );

  // Dosya okuma worker'ları (lib/fileWorkers.ts) kapanışta sonlanır; süreç (ve test koşusu) asılı kalmaz.
  // Satır içi kipte (JOB_RUNNER=inline) süren işlerin kirası bırakılır, kalp atışı zamanlayıcıları kapanır. Döngü kipinin
  // çalıştırıcısını buildApp açmaz; main.ts durdurur.
  app.addHook('onClose', async () => {
    await closeInlineJobs();
    await closeFileWorkers();
  });

  return app;
}
