// Araç listesi araç kaydından (`Platform/packages/contracts/src/products.ts`, KALANLAR 6.26). Araca bağlı olmayan senaryolar
// (sistem bütünlüğü, uygulama seçici, firma ayrımı, demo hesapları) her araç için kendiliğinden koşar. Araca özgü bilgi
// (kaplar, sayfalar, örnek veri) yalnız buradaki `TOOLS` sürücüsündedir: yeni araç açılınca (`launch` 'off' değil) sürücüsü
// yazılmadan `00-sistem` düşer. DeciShip'in kendi iş senaryoları (fatura, itiraz, Pano) kendi dosyalarında kalır.
import { PRODUCT_LAUNCHES, PRODUCT_REGISTRY, type ProductEntry, type ProductLaunch } from '../../packages/contracts/src/products.ts';
import { FEDEX_INVOICE, MobileApi, SAMPLE_PERIOD, addCarrierAndTariff, confirmCompany, loadMeasurements, measurementBody, sampleMeasurements, uploadInvoice, type Owner } from './api.ts';
import { stackEnv } from './sys.ts';

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
