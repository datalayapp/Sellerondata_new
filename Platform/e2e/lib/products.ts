// Araç listesi araç kaydından (`Platform/packages/contracts/src/products.ts`, KALANLAR 6.26). Araca bağlı olmayan senaryolar
// (sistem bütünlüğü, uygulama seçici, firma ayrımı, demo hesapları) her araç için kendiliğinden koşar. Araca özgü bilgi
// (kaplar, sayfalar, örnek veri) yalnız buradaki `TOOLS` sürücüsündedir: yeni araç açılınca (`launch` 'off' değil) sürücüsü
// yazılmadan `00-sistem` düşer. DeciShip'in kendi iş senaryoları (fatura, itiraz, Pano) kendi dosyalarında kalır.
import { PRODUCT_LAUNCHES, PRODUCT_REGISTRY, type ProductEntry, type ProductLaunch } from '../../packages/contracts/src/products.ts';
import { FEDEX_INVOICE, MobileApi, SAMPLE_PERIOD, addCarrierAndTariff, confirmCompany, loadMeasurements, measurementBody, sampleMeasurements, uploadInvoice, type Owner, type WebApi } from './api.ts';
import { compose, stackEnv } from './sys.ts';

export type Product = ProductEntry & { launch: ProductLaunch };

/**
 * Yığının `PRODUCT_LAUNCH` ezmesi (`orderloom=pilot,tagpress=off`; Hesap servisi `src/lib/launch.ts` ile aynı biçim). Compose
 * `.env.e2e`'yi süreç ortamının üstüne koyar (`sys.ts` `compose`); sıra burada da aynı. Gerçek durum `00-sistem`'de katalogla
 * karşılaştırılır.
 */
function launchOverrides(): Map<string, ProductLaunch> {
  const out = new Map<string, ProductLaunch>();
  const raw = stackEnv().PRODUCT_LAUNCH ?? process.env.PRODUCT_LAUNCH ?? '';
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, value] = part.split('=').map((s) => s.trim());
    if (!key || !PRODUCT_LAUNCHES.includes(value as ProductLaunch)) throw new Error(`PRODUCT_LAUNCH okunamadı: ${part}`);
    out.set(key, value as ProductLaunch);
  }
  return out;
}

const overrides = launchOverrides();

/** Kayıttaki bütün araçlar, yığındaki açılış durumuyla. */
export const PRODUCTS: readonly Product[] = (PRODUCT_REGISTRY as readonly ProductEntry[]).map((e) => ({ ...e, launch: overrides.get(e.key) ?? e.launch }));
/** Kapta çalışan araçlar (pilot dahil): sağlık, olay hedefi, sürücü zorunlu. */
export const RUNNING_PRODUCTS = PRODUCTS.filter((p) => p.launch !== 'off');
/**
 * Kayıtla yeni firmaya açılan araçlar (`public`): uygulama seçicide bağlantı, firma ayrımı testi. Pilot araç firmaya
 * `subscription:set` ile verilir (Hesap servisi betiği, API'si yok): e2e onu henüz açamaz, seçicide de sınamaz.
 */
export const PUBLIC_PRODUCTS = PRODUCTS.filter((p) => p.launch === 'public');
/** Merkez'de "Yakında" görünen, tıklanmayan araçlar. */
export const OFF_PRODUCTS = PRODUCTS.filter((p) => p.launch === 'off');

/** Araçta bir firmaya kurulmuş veri. İşaretler o firmaya özgüdür: başka firmanın hiçbir yüzeyinde görünmemeli. */
export type ToolSeed = {
  /** Aracın arayüzünde, Merkez veri setlerinde, CSV'de ve etkinlikte görünen metinler (ör. fatura no). */
  markers: string[];
  /** Firmaya bağlı kayıtların API adresleri: başka firmadan (çerez ya da Bearer) 404. */
  privateApi: string[];
  /** Aynı kayıtların araçtaki sayfaları: başka firmada açılınca işaret görünmez. */
  privatePages: string[];
};

export type ToolDriver = {
  /** Sürekli çalışan kaplar (sağlık denetimi). Aracın API ve web kabı kayıttan (`deploy`) gelir; burada ek kaplar. */
  extraServices: string[];
  /** Tek seferlik kaplar: başarıyla bitmiş olmalı. */
  oneShot: string[];
  /** Firmanın verisini listeleyen sayfalar: firma ayrımında açılır, HTML olarak sunulduğu sistem testinde denetlenir. */
  pages: string[];
  /** Örnek verinin dönemi (`from=…&to=…`): Merkez Genel Bakış ve Analiz bu aralıkla açılır. Yoksa varsayılan dönem. */
  period?: string;
  /** Merkez kurulumu (firma onayı) ve aracın gerçek verisi; `tag` işaretlere girer (büyük harf ve rakam). */
  seed(owner: Owner, tag: string): Promise<ToolSeed>;
};

/**
 * Aracı sahibin firmasına açar. `public` araçta kayıt zaten açmıştır (sahibe sahip rolü). `pilot` araçta firmaya abonelik Hesap
 * servisinin `subscription-set` betiğiyle verilir (API'si yok; ilk açılışta sahibe aracın sahip rolü); jetonda rol olsun diye sahip
 * yeniden girer. Kapalı araç açılmaz.
 */
export async function openTool(owner: Owner, key: string): Promise<void> {
  const p = PRODUCTS.find((x) => x.key === key);
  if (!p || p.launch === 'off') throw new Error(`openTool: ${key} kapalı ya da kayıtta yok`);
  const hasRole = () => owner.me.products.some((x) => x.key === key && !!x.role && !!x.subscription);
  if (hasRole()) return;
  const orgId = owner.me.activeOrg?.id;
  if (!orgId) throw new Error('openTool: etkin firma yok');
  compose('exec', '-T', 'account-api', 'node', 'dist/subscription-set.js', orgId, key, 'ACTIVE', '--operator', 'e2e');
  owner.me = await owner.api.login(owner.email, owner.password);
  if (owner.me.activeOrg?.id !== orgId) {
    await owner.api.post('/api/account/auth/switch-org', { orgId });
    owner.me = await owner.api.me();
  }
  if (!hasRole()) throw new Error(`openTool: ${p.name} açıldı ama sahibin rolü yok`);
}

/**
 * TagPress'e elle bir iş: dil yoksa açar (`POST /api/tagpress/languages`), işi `POST /api/tagpress/jobs/manual` ile ekler. Sipariş
 * no (`TP-<etiket>`) aracın üretim listesinde, Merkez'in iş veri setinde ve CSV'de görünen metindir; etiket yazısı Merkez'e çıkmaz.
 */
export async function addTagpressJob(api: WebApi, tag: string, languageId?: string): Promise<{ id: string; orderNo: string; languageId: string }> {
  const lang = languageId ?? (await api.post<{ id: string }>('/api/tagpress/languages', { name: `E2E ${tag}` })).id;
  const orderNo = `TP-${tag}`;
  const job = await api.post<{ id: string }>('/api/tagpress/jobs/manual', { languageId: lang, text: `Ayrım ${tag}`, orderNo, quantity: 1 });
  if (!job?.id) throw new Error('TagPress işi eklenmedi');
  return { id: job.id, orderNo, languageId: lang };
}

/** Araç başına e2e sürücüsü. Yeni araç: kayıt girdisinden sonra buraya bir girdi (KOD-HARITASI "Yeni araç eklemek"). */
export const TOOLS: Readonly<Record<string, ToolDriver>> = {
  deciship: {
    extraServices: ['vision'],
    oneShot: ['deciship-migrate'],
    pages: ['/deciship/invoices', '/deciship/measurements', '/deciship/setup'],
    period: SAMPLE_PERIOD.query,
    async seed(owner, tag) {
      owner.me = await confirmCompany(owner.api);
      const { carrierId } = await addCarrierAndTariff(owner.api);
      await loadMeasurements(owner.email, owner.password);
      // Örnek ölçümlerin takip no'ları her firmada aynı: firmaya özgü bir ölçüm de gönderilir (ölçüm listesi, veri seti).
      const tracking = `AYRIM${tag}`;
      const mobile = await MobileApi.login(owner.email, owner.password);
      const m = await mobile.postMeasurement({ ...measurementBody(sampleMeasurements()[0]!), trackingRaw: tracking, measuredAt: new Date(Date.now() - 60_000).toISOString() });
      await mobile.dispose();
      if (m.status !== 201) throw new Error(`işaret ölçümü: ${m.status} ${m.text}`);
      const invoiceNo = `${FEDEX_INVOICE.no}-${tag}`;
      const invoiceId = await uploadInvoice(owner.api, carrierId, FEDEX_INVOICE, `-${tag}`);
      return {
        markers: [invoiceNo, tracking],
        privateApi: [`/api/deciship/invoices/${invoiceId}`, `/api/deciship/measurements/${(m.body as { measurement: { id: string } }).measurement.id}`],
        privatePages: [`/deciship/invoices/${invoiceId}`],
      };
    },
  },
  tagpress: {
    // Yapay zekâ geçidi TagPress'in yanında çalışır; araç ondan bağımsız açılır ama yığında olmalı.
    extraServices: ['ai-api'],
    oneShot: ['tagpress-migrate', 'ai-migrate'],
    pages: ['/tagpress/#/uretim'],
    async seed(owner, tag) {
      await openTool(owner, 'tagpress');
      owner.me = await confirmCompany(owner.api);
      const job = await addTagpressJob(owner.api, tag);
      return {
        markers: [job.orderNo],
        privateApi: [`/api/tagpress/jobs/${job.id}`],
        privatePages: [`/tagpress/#/uretim?is=${job.id}`],
      };
    },
  },
};

/** Aracın sürücüsü; yoksa ne yapılacağını söyleyen hata. */
export function toolOf(p: Product): ToolDriver {
  const d = TOOLS[p.key];
  if (!d) throw new Error(`${p.name} (${p.key}) açık ama e2e sürücüsü yok: Platform/e2e/lib/products.ts TOOLS'a ekleyin`);
  return d;
}

/** Aracın sürekli çalışan bütün kapları: kayıttaki API ve web servisi + sürücünün ekleri. */
export function servicesOf(p: Product): string[] {
  return [p.deploy?.api?.service, p.deploy?.web?.service, ...toolOf(p).extraServices].filter((s): s is string => Boolean(s));
}

/**
 * Davet ve rol değişimi için araç başına rol (`productRoles`): her açık araçta kayıttaki davet rolü (`inviteRole`), istenen
 * araçta verilen rol. Bilinmeyen araç ya da kayıtta olmayan rol hata: test yanlış rolle sessizce geçmesin.
 */
export function productRoles(pick: Record<string, string | null> = {}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of PUBLIC_PRODUCTS) out[p.key] = p.inviteRole;
  for (const [key, role] of Object.entries(pick)) {
    const p = PUBLIC_PRODUCTS.find((x) => x.key === key);
    if (!p) throw new Error(`productRoles: ${key} açık bir araç değil`);
    if (role !== null && !p.roles.some((r) => r.key === role)) throw new Error(`productRoles: ${p.name} aracında ${role} rolü yok`);
    out[key] = role;
  }
  return out;
}
