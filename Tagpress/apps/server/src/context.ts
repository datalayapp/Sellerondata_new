import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { type AiGateway, type AiGatewayOptions, allowanceLimit, createAiGateway, withAiJob } from "./adapters/ai-gateway.ts";
import { type AppConfig, type DataPaths, dataPaths, orgDataPaths } from "./config.ts";
import { createDatabase } from "./db/factory.ts";
import { EventBus } from "./events.ts";
import type { FeatureGateReport } from "./features/gate.ts";
import { FeatureService } from "./features/service.ts";
import { currentOrg, maintenance, runInOrg } from "./org/context.ts";
import { LocalOrgResolver, type OrgResolver, PlatformOrgResolver } from "./org/resolver.ts";
import { PlatformOrgService } from "./org/platform-service.ts";
import { PLATFORM_SCHEMA } from "./platform/identity.ts";
import { LiveStreams } from "./platform/live-streams.ts";
import { type ProductIdentity, pgDb } from "@sellerondata/product-kit";
import { OrgRoots } from "./org/roots.ts";
import { OrgSeeder } from "./org/seed.ts";
import { OrgService } from "./org/service.ts";
import type { TenantDbLike } from "./org/tenant-db.ts";
import { Tenancy, type TenancyMode } from "./org/tenancy.ts";
import type { Ports, PortsFactory } from "./ports.ts";
import { AdjustService } from "./services/adjust.ts";
import { BatchService } from "./services/batches.ts";
import { type BootstrapResult, importMigrationPackages } from "./services/bootstrap.ts";
import { CostService } from "./services/costs.ts";
import { FontService } from "./services/fonts.ts";
import { installMaxConcurrency } from "./services/generation/fair.ts";
import { ProgressLog } from "./services/generation/progress.ts";
import { GenerationQueue } from "./services/generation/queue.ts";
import { GenerationService } from "./services/generation/service.ts";
import { TargetResolver } from "./services/generation/target.ts";
import { ImportService, enqueueOrExplain } from "./services/import/service.ts";
import { RowValidator } from "./services/import/validator.ts";
import { JobService } from "./services/jobs/service.ts";
import { CutChangeService } from "./services/jobs/cut-change.ts";
import { LanguageService } from "./services/languages.ts";
import { ProfileService } from "./services/profiles.ts";
import { LearnService } from "./services/learn.ts";
import { LearnProposalService, ReferenceService } from "./services/references.ts";
import { DesignSessionService } from "./services/session.ts";
import { BuilderService, type BuilderTranscriber } from "./services/builder/service.ts";
import { type BuilderLoopOptions, type BuilderModelPort, createBuilderModel, createClaude, transcribe } from "@tagpress/ai";
import { MODELS } from "@tagpress/domain";
import { type LegacyDecrypt, legacyDpapi } from "./services/dpapi.ts";
import { type MasterKeyProvider, defaultKeyProvider } from "./services/secret-box.ts";
import { SecretService } from "./services/secrets.ts";
import { KeyGuard } from "./services/key-guard.ts";
import { SettingsService } from "./services/settings.ts";
import { SetupService } from "./services/setup.ts";
import { TemplateService } from "./services/templates.ts";
import { UndoService } from "./services/undo.ts";
import { LanguagePackageService } from "./services/language-package.ts";
import { TemplateTaskService } from "./services/template-tasks.ts";
import { TrialService } from "./services/trial/service.ts";
import { VariantService } from "./services/variants.ts";
import { PrintExportService } from "./services/print/exports.ts";
import { PrintRenderInputBuilder } from "./services/print/render-input.ts";
import { PrintSessionService } from "./services/print/sessions.ts";
import { ShelfQuery } from "./services/print/shelf.ts";
import { PrintTemplateService } from "./services/print/templates.ts";
import { type Clock, DAY_MS, systemClock } from "./util/clock.ts";
import { fail } from "./util/errors.ts";
import { defaultPorts } from "./wiring.ts";

export interface ContextOptions {
  config: AppConfig;
  /** Yeni (ve taze kurulumdaki ilk) firmaya ürünün varsayılan içeriği kurulsun mu. Uygulamada açık; testlerde varsayılan kapalı. */
  seedDefaults?: boolean;
  /** Port bağlantıları: hazır nesne ya da bağlam olanaklarıyla çağrılan fabrika (`productionPorts()`). */
  ports?: Partial<Ports> | PortsFactory;
  /** API anahtarlarının ana anahtar kaynağı. Varsayılan: `TAGPRESS_SECRET_KEY`, yoksa veri klasöründeki `ana-anahtar.json`. */
  secretKeys?: MasterKeyProvider;
  /** Eski DPAPI kayıtlarının çözücüsü (taşıma için). Varsayılan: Windows'ta DPAPI, başka yerde yok (null). */
  legacyDpapi?: LegacyDecrypt | null;
  clock?: Clock;
  /** Kuyruğu başlat (testlerde kapatılabilir). Varsayılan true. */
  startQueue?: boolean;
  /** AI işlerinde anahtar ön denetimi. Varsayılan: gerçek bağlantı fabrikası (`ports` işlevi) verildiyse true. */
  enforceKeys?: boolean;
  /** Postgres adresi (doluysa platform veritabanı; boşsa veri klasöründeki SQLite). `db/factory.ts`. */
  databaseUrl?: string | null;
  /** Firma kapsamı kipi; varsayılan `config.tenancy` (`TAGPRESS_TENANCY=audit` değilse `strict`). */
  tenancy?: TenancyMode;
  /** İsteğin firmasını bulan çözücü; varsayılan `LocalOrgResolver` (tek yerel firma). İzolasyon testleri kendi çözücüsünü verir. */
  resolver?: OrgResolver;
  /**
   * Sitedeki oluşturucunun modeli ve satır okuması (testler sahte verir). Verilmezse: gerçek bağlantı fabrikası
   * (`ports` işlevi) varsa kayıtlı Anthropic anahtarıyla gerçek model, yoksa model yok (409 `missing-key`).
   */
  builder?: { model?: () => BuilderModelPort | null; transcriber?: () => BuilderTranscriber | null; loop?: BuilderLoopOptions };
  /**
   * Platform kipi, testler: yapay zekâ geçidinin ağı (`fetch`: aylık hak; oluşturucu istemcileri de bununla gider) ve saati.
   * Geçidin adresi ve jetonu `config.platform.aiGateway`'den.
   */
  aiGateway?: AiGatewayOptions;
}

/** Bütün servislerin tek yerde kurulduğu bağlam. Rotalar yalnızca bunu görür. */
export async function createContext(opts: ContextOptions) {
  const config = opts.config;
  const installPaths = dataPaths(config.dataDir);
  for (const dir of [config.dataDir, installPaths.sharedFonts, installPaths.backups]) mkdirSync(dir, { recursive: true });
  const clock = opts.clock ?? systemClock;

  // Firma kapsamı (SUNUCU-PLANI §2.5): servisler ve rotalar yalnız `tdb`'yi (TenantDb) görür; ham bağlantı yalnız bakım
  // kapsamında (`tdb.maintenance`). Firma bağlamı olmayan çağrı her kipte hata verir.
  const tenancy = new Tenancy({ mode: opts.tenancy ?? config.tenancy });
  if (tenancy.mode === "audit") warnAuditMode();
  // Veritabanı (`db/factory.ts`): `databaseUrl` doluysa Postgres (senkron köprü + async havuz), yoksa veri klasöründeki
  // SQLite (bekleyen göç varsa önce yedek `yedek/db-<tarih>-goc-<n>-oncesi/`, sonra göç).
  const database = createDatabase({ dataDir: config.dataDir, databaseUrl: opts.databaseUrl ?? null }, { tenancy });
  const tdb = database.tdb;
  const settings = new SettingsService(tdb);
  const roots = new OrgRoots(config.dataDir, settings, tenancy);
  const orgs: OrgService = new OrgService(
    tdb,
    clock,
    () => roots.reload(),
    opts.seedDefaults ? new OrgSeeder({ db: tdb, clock, dataDir: config.dataDir, rootOf: (id) => roots.rootOf(id) }) : null,
  );
  let resolver: OrgResolver;
  // Platform kipi (`TAGPRESS_AUTH=platform`): firma kaydı product-kit `Company` (Hesap'tan); `orgs` (kurulum tablosu) yoktur.
  const platformMode = config.auth === "platform";
  let platformOrgs: PlatformOrgService | null = null;
  try {
    if (platformMode) {
      if (!database.pool) throw new Error("Platform kipi Postgres ister (DATABASE_URL). Yerel kip için TAGPRESS_AUTH=local.");
      platformOrgs = new PlatformOrgService({
        db: pgDb(database.pool),
        schema: PLATFORM_SCHEMA,
        tx: (fn) => tdb.tx(fn),
        settings,
        // Yeni firmanın varsayılan içeriği ilk istekte (`seedDefaults: false` yalnız testlerde açıkça).
        seeder: opts.seedDefaults === false ? { seed: () => null } : new OrgSeeder({ db: tdb, clock, dataDir: config.dataDir, rootOf: (id) => roots.rootOf(id) }),
        clock,
      });
      platformOrgs.start();
      resolver = opts.resolver ?? new PlatformOrgResolver(platformOrgs);
    } else {
      // Taze kurulumda "Firmam" burada açılır (göç 9 veri varsa sahibin firmasını zaten açmıştır).
      orgs.ensureLocal();
      roots.reload();
      const local = new LocalOrgResolver(orgs, config.org);
      local.assertUsable();
      resolver = opts.resolver ?? local;
    }
  } catch (err) {
    await platformOrgs?.stop();
    await database.close();
    throw err;
  }
  // Dosya yolları geçerli firmanın köküne göre (dosya düzeni 1'de sahibin kökü veri klasörünün kendisi; A3 taşır).
  const paths: DataPaths = orgDataPaths(config.dataDir, () => roots.current("paths"));
  const events = new EventBus(tenancy, { production: !config.dev });
  // Açık SSE akışları (R1): jeton bitişi, üye çıkarma, firma kapanışı ve uygulama kapanışında kapanır.
  const liveStreams = new LiveStreams();
  // Özellik anahtarları ve kurulum (SUNUCU-PLANI §3): firma ayarı `features`, `setup`; kayıt yoksa varsayılanlar ve `pending`.
  const features = new FeatureService(settings, clock, events);
  const setup = new SetupService(settings, features, clock, events);
  const secrets = new SecretService(settings, clock, {
    keys: opts.secretKeys ?? defaultKeyProvider(config.dataDir),
    legacyDpapi: opts.legacyDpapi === undefined ? legacyDpapi() : opts.legacyDpapi,
    source: platformMode ? "platform" : "local",
  });
  // Platform kipi: yapay zekâ yalnız SellerOnData geçidinden (`AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN`); adres boşsa yapay zekâ
  // kapalı (409 `ai-unavailable`), anahtara düşülmez. Yerel kipte geçit yok (sahibin kayıtlı anahtarı).
  const aiGateway: AiGateway | null = platformMode ? createAiGateway(config.platform?.aiGateway ?? null, opts.aiGateway) : null;
  const aiFetch = opts.aiGateway?.fetch ? { fetch: opts.aiGateway.fetch } : {};
  let secretsReport: Awaited<ReturnType<SecretService["init"]>>;
  try {
    if (platformMode) {
      // Platform kipinde yapay zekâ anahtarı TagPress'te tutulmaz (geçitte; `settings` kurulum tablosunda RLS yok): anahtar
      // uçları 409 `managed-by-platform`, ana anahtar dosyası açılmaz, kayıt taşınmaz. Tabloda anahtar kalmışsa açılış durur.
      assertNoStoredKeys(tdb);
      secretsReport = await secrets.init();
    } else {
      // Ana anahtar bozuksa açılış burada durur (açık hata); eski biçimli anahtarlar burada taşınır.
      secretsReport = await secrets.init();
    }
  } catch (err) {
    await platformOrgs?.stop();
    await database.close();
    throw err;
  }
  const keyGuard = new KeyGuard(platformMode ? { gateway: aiGateway } : secrets, opts.enforceKeys ?? typeof opts.ports === "function");
  const references = new ReferenceService(tdb, events, clock);
  /** Paylaşılan nesne: gerçek paketler sonradan bağlansa da bütün servisler aynı nesneyi görür. */
  const ports: Ports = defaultPorts(
    typeof opts.ports === "function"
      ? opts.ports({
          paths,
          dataDir: config.dataDir,
          // Platform kipinde anahtar okunmaz (`platformAi`; `SecretService.get` platformda hata verir).
          apiKey: (provider) => (platformMode ? null : secrets.get(provider)),
          ...(platformMode ? { platformAi: { gateway: aiGateway } } : {}),
          referenceImages: (languageId, templateKey, limit, excludeId) => references.trainImages(paths.root, languageId, templateKey, limit, excludeId),
          breakExamples: (languageId) => references.breakExamples(languageId),
          // Benzer örneklerin şablon alanı oranı (çağrı anında; `templates` ve `ports` aşağıda kurulur).
          templateAspect: async (languageId, templateKey, profile) => {
            const t = templates.find(languageId, templateKey);
            const imagePath = t ? templates.imagePath(languageId, t) : null;
            if (!t || !imagePath || !existsSync(imagePath) || !ports.geometry) return undefined;
            const a = (await ports.geometry.forTemplate({ template: t, imagePath, profile })).areaBounds;
            return a.h > 0 ? Math.round((a.w / a.h) * 100) / 100 : undefined;
          },
        })
      : opts.ports,
  );
  // Kesim değişince onayların düşmesi (`services/jobs/cut-change.ts`): şablon kaydı ve tasarım dili yayını kancaları.
  const cutChange = new CutChangeService(tdb, clock, events);
  const profiles = new ProfileService(tdb, events, clock, cutChange.profilePublishedHook());
  const languages = new LanguageService(tdb, paths, profiles, settings, events, clock);
  const templates = new TemplateService(tdb, paths, events, clock, cutChange.templateSavedHook((languageId) => profiles.active(languageId)?.data ?? null));
  const fonts = new FontService(paths, () => ports.fontCatalog);
  const validator = new RowValidator(tdb, paths, profiles, templates, ports);
  const jobs = new JobService(tdb, validator, events, clock);
  const batches = new BatchService(tdb, events, clock);
  const variants = new VariantService(tdb, paths, jobs, events, clock);
  const undo = new UndoService(tdb, paths, events, clock, (jobId) => jobs.syncAfterVariants(jobId), () => templates.purgeTemporary(DAY_MS));
  const costs = new CostService(tdb, clock);
  const progress = new ProgressLog(tdb, events, clock);
  // Arka plan işlerinin kurulum geneli üst sınırı (`TAGPRESS_MAX_CONCURRENCY`, yoksa `install.maxConcurrency`, yoksa 4).
  const maxConcurrency = () => installMaxConcurrency(settings);
  const queue = new GenerationQueue(tdb, events, clock, () => settings.get().concurrency, (id, s) => jobs.setGenState(id, s), {
    maxConcurrency,
    onAbandoned: (id) => jobs.setStatus(id, jobs.liveVariants(id).length ? "ready" : "failed", "Üretim yarıda kaldı."),
  });
  const generation = new GenerationService({ db: tdb, paths, ports, jobs, variants, templates, profiles, settings, costs, progress, queue, keyGuard });
  // Anahtar yoksa (yerel) ya da yapay zekâ kapalı, durdurulmuş, hak dolmuşsa (platform) içe aktarma ve elle iş yine
  // tamamlanır: işler açılır, kuyruğa girmez, neden yanıtta (`notQueued`); üretim sonra başlatılır.
  const importer = new ImportService(tdb, languages, validator, batches, jobs, enqueueOrExplain((ids) => generation.enqueue({ jobIds: ids }).queued));
  const learn = new LearnProposalService(tdb, clock);
  const designSessions = new DesignSessionService(tdb, profiles, events, clock);
  // Sitede tasarım dili oluşturucu (SUNUCU-PLANI §4, C3): model ve okuma yalnız gerçek bağlantılarda anahtarla kurulur.
  const realAi = typeof opts.ports === "function";
  const builderKey = () => secrets.get("anthropic");
  /** Platform kipi: geçit yoksa oluşturucu açık hatayla durur (anahtara düşülmez). */
  const requireGateway = (): AiGateway => {
    if (!aiGateway) throw fail("ai-unavailable");
    return aiGateway;
  };
  const builder = new BuilderService({
    db: tdb,
    paths,
    clock,
    events,
    settings,
    languages,
    profiles,
    templates,
    references,
    ports,
    model:
      opts.builder?.model ??
      (() => {
        if (!realAi) return null;
        if (platformMode) {
          // Bir model nesnesi bir iştir (tur): bütün istekleri aynı istek kimliğiyle, arka plan işi olarak.
          const gw = requireGateway();
          return createBuilderModel({ apiKey: gw.token, baseURL: gw.anthropicBaseUrl, gateway: { ...gw.options({ origin: "job" }), purpose: "builder-turn" }, ...aiFetch });
        }
        const apiKey = builderKey();
        return apiKey ? createBuilderModel({ apiKey }) : null;
      }),
    transcriber:
      opts.builder?.transcriber ??
      (() => {
        if (!realAi) return null;
        let claude: ReturnType<typeof createClaude>;
        if (platformMode) {
          const gw = requireGateway();
          claude = createClaude({ apiKey: gw.token, baseURL: gw.anthropicBaseUrl, model: MODELS.daily, gateway: gw.options({ purpose: "builder-transcribe", origin: "job" }), ...aiFetch });
        } else {
          const apiKey = builderKey();
          if (!apiKey) return null;
          claude = createClaude({ apiKey, model: MODELS.daily });
        }
        // Bir ölçümün bütün okumaları tek istek zincirinde (geçidin süren iş payı).
        const requestId = `okuma-${randomUUID()}`;
        return { transcribe: async (png, o) => withAiJob({ requestId }, () => transcribe(claude, png, o.signal ? { signal: o.signal } : {})) };
      }),
    ...(opts.builder?.loop ? { loop: opts.builder.loop } : {}),
    ...(platformMode
      ? { keySource: "product" as const, allowance: () => monthlyAllowance(), refreshAllowance: async () => (aiGateway ? aiGateway.ensureFresh(currentOrg().orgId) : null) }
      : {}),
  });
  const learning = new LearnService({ db: tdb, paths, profiles, templates, references, proposals: learn, sessions: designSessions, events, clock, maxConcurrency });
  const targets = new TargetResolver(ports, templates);
  const adjust = new AdjustService({ db: tdb, paths, ports, jobs, variants, templates, profiles, targets, undo, events, clock });
  const trials = new TrialService({ paths, ports, templates, profiles, references, costs });
  const templateTasks = new TemplateTaskService({ db: tdb, keyGuard, ports, templates, profiles, costs, trials, clock, maxConcurrency });
  const languagePackages = new LanguagePackageService({ paths, languages, profiles, templates, clock });
  // Baskı masası: şablon yuvaları değişince taslak oturumlardaki öğeler eşitlenir.
  let printSessionsRef: PrintSessionService | null = null;
  const printTemplates = new PrintTemplateService(tdb, languages, settings, events, clock, (t, prev) => printSessionsRef?.syncTemplate(t, prev));
  const printShelf = new ShelfQuery(tdb, profiles, () => ports.printPlanner, (languageId) => printTemplates.list(languageId), () => printSessionsRef);
  const printSessions = new PrintSessionService({ db: tdb, ports, profiles, templates: printTemplates, jobs, variants, undo, events, clock });
  printSessionsRef = printSessions;
  const printRender = new PrintRenderInputBuilder({ paths, jobs, variants, profiles, templates, targets });
  // Çıktı klasörü geçerli firmanın `baski/` klasörü (`paths.prints`, her erişimde).
  const printExports = new PrintExportService({ db: tdb, paths, maxConcurrency, ports, sessions: printSessions, templates: printTemplates, profiles, builder: printRender, events, clock });

  /** Platform kipi: geçidin aylık hakkı (önbellekten; oluşturucu bütçesi). Okunmadıysa null (yerel değerler geçer). */
  function monthlyAllowance() {
    const a = aiGateway?.peek(currentOrg().orgId);
    return a ? allowanceLimit(a) : null;
  }

  const ctx = {
    config,
    paths,
    /** Firma kapsamlı veritabanı erişimi (`org/tenant-db.ts`, `TenantDbLike`); servislerin ve rotaların tek yolu. */
    tdb,
    /** Async Postgres havuzu (platform kipi; product-kit, olaylar, Merkez uçları). SQLite'ta null. */
    pool: database.pool,
    /** Platform kipinin firmaları (`org/platform-service.ts`); yerel kipte null. */
    platformOrgs,
    /** Platform kipinin kimlik izdüşümü tutamağı (product-kit; `app.ts` kurar). Yerel kipte null. */
    identity: null as ProductIdentity | null,
    /** Ham bağlantı YALNIZ bakım ve göç için (`maintenance(…)` içinde; dışında sıkı kipte hata). */
    maintenanceDb: tdb.maintenance,
    tenancy,
    orgs,
    roots,
    resolver,
    features,
    setup,
    /** Özellik kapısının uç kaydı (`app.ts` `registerFeatureGate`; uygulama kurulunca dolar). */
    featureGate: null as FeatureGateReport | null,
    clock,
    events,
    /** Açık SSE akışları (`platform/live-streams.ts`). */
    liveStreams,
    ports,
    settings,
    secrets,
    profiles,
    languages,
    templates,
    cutChange,
    fonts,
    validator,
    jobs,
    batches,
    variants,
    undo,
    costs,
    progress,
    queue,
    generation,
    importer,
    references,
    learn,
    learning,
    designSessions,
    builder,
    adjust,
    trials,
    templateTasks,
    keyGuard,
    languagePackages,
    printTemplates,
    printShelf,
    printSessions,
    printRender,
    printExports,
    bootstrap: null as BootstrapResult | null,
    /** Açılışta anahtar taşıma/döndürme özeti (değer içermez). */
    secretsReport,
    /** Platform kipinin yapay zekâ geçidi (`adapters/ai-gateway.ts`); yerel kipte ve adres boşsa null. */
    aiGateway,
    /** Kuyruğu durdurur, veritabanını kapatır. */
    async close() {
      clearInterval(timer);
      liveStreams.closeAll();
      await platformOrgs?.stop();
      await queue.stop();
      await templateTasks.idle();
      await printExports.idle();
      await learning.stopAll();
      await builder.stopAll();
      await database.close();
      // Teşhis: TAGPRESS_TENANCY_AUDIT=<dosya> ise kapsam dışı erişim listesi (denetim kipi, düşen olaylar) JSON satırı olarak eklenir.
      const auditFile = process.env.TAGPRESS_TENANCY_AUDIT?.trim();
      if (auditFile && tenancy.audit.total) appendFileSync(auditFile, `${JSON.stringify({ total: tenancy.audit.total, entries: tenancy.audit.list() })}\n`);
    },
  };

  // Açılış, firma firma (her biri kendi bağlamında): aktarım paketleri (yalnız o firmanın `aktarim/` klasörü), dillerin
  // şablon klasörleri, kalıcı temizlik.
  const active = () => (platformOrgs ? platformOrgs.list() : orgs.list().filter((o) => !o.closedAt));
  const bootstrap: BootstrapResult = { imported: [], errors: [] };
  for (const org of active()) {
    await runInOrg(org.id, async () => {
      mkdirSync(paths.previews, { recursive: true });
      if (config.bootstrapPackages) {
        const b = await importMigrationPackages({ paths, languages, templates, references, settings });
        bootstrap.imported.push(...b.imported);
        bootstrap.errors.push(...b.errors);
      }
      for (const l of languages.list()) await templates.sync(l.id);
      await undo.purge();
    });
  }
  ctx.bootstrap = bootstrap;

  // Kurulum geneli kurtarma (bakım kapsamı): yarım kalan her görev kendi firmasında işlenir (`runInOrg(task.orgId)`);
  // üst üste yarıda kalanın işi `onAbandoned` ile "ready"/"failed" olur.
  queue.recover();
  if (platformOrgs) {
    // Platform kipi (R1): durumu okunmamış firma kapalı sayılır. Bekleyen/çalışan görevi olan firmaların durumu kuyruk
    // başlamadan okunur (kapalı firmanın görevi `queued` kalır); sonraki her tazelemede kuyruk dürtülür (açılan firma sürer).
    const pendingOrgs = maintenance(
      () => (tdb.maintenance.prepare("SELECT DISTINCT org_id FROM gen_tasks WHERE status IN ('queued', 'running')").all() as { org_id: string }[]).map((r) => r.org_id),
      "kuyruk firmaları",
    );
    await platformOrgs.prime(pendingOrgs);
    if (opts.startQueue !== false) platformOrgs.onRefreshed(() => queue.kick());
  }
  if (opts.startQueue !== false) queue.kick();
  maintenance(() => printExports.recover(), "baskı çıktısı kurtarma");
  // Günlük bakım: kalıcı temizlik (firma firma).
  const timer = setInterval(() => {
    for (const org of active()) void runInOrg(org.id, () => undo.purge()).catch(() => undefined);
  }, 60 * 60_000);
  timer.unref();
  return ctx;
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;

/** Platform kipi: kurulum ayarlarında (`settings`, RLS yok) yapay zekâ anahtarı kaydı (`key:<sağlayıcı>`) olmamalı. */
export function assertNoStoredKeys(tdb: Pick<TenantDbLike, "install">): void {
  const rows = tdb.install.prepare("SELECT key FROM settings WHERE key LIKE 'key:%'").all() as { key: string }[];
  if (rows.length) {
    throw new Error(`Platform kipinde yapay zekâ anahtarı TagPress'te tutulmaz (geçitte); settings tablosunda kayıt var: ${rows.map((r) => r.key).join(", ")}. Kayıtları silin.`);
  }
}

let auditWarned = false;
/** Denetim kipi yalnız açık ayarla (`TAGPRESS_TENANCY=audit`) ve uyarıyla açılır (süreç başına bir kez). */
function warnAuditMode(): void {
  if (auditWarned) return;
  auditWarned = true;
  console.warn("UYARI: firma kapsamı denetim kipinde (TAGPRESS_TENANCY=audit): bakım bağlantısının kapsam dışı kullanımı hata vermez, yalnız sayılır. Teşhis içindir; olağan kip strict.");
}
