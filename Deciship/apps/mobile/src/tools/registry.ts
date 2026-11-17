import { PRODUCT_REGISTRY, type MeResponse, type ProductKey, type ProductLaunch } from '@sellerondata/contracts';
import { decishipAccess, type AppBand, type ToolAccess } from '../auth/access';

/**
 * Mobilde ekranı olan araçlar. Yeni araç buraya tek satır eklenir; erişilebilirlik (hazır mı, kişinin rolü var mı)
 * sunucudan (`me.products[]`) gelir, burada yalnız mobil ekranın adresi ve kimliği tutulur.
 */
export type MobileTool = {
  key: ProductKey;
  /** Mobil ekranın açılış adresi. Yoksa araç mobilde "Web'de aç" olarak görünür. */
  href?: '/deciship/today';
  band: AppBand;
  access: (me: MeResponse | null | undefined) => ToolAccess;
};

/** Araç bu firmada açık mı: sunucu `available` der ve `launch` varsa `off` değildir. `launch` yoksa (eski sunucu) yalnız `available`. */
export const isProductOpen = (p: { available: boolean; launch?: ProductLaunch }): boolean => p.available && p.launch !== 'off';

/** Mobil açılış adresi tek kaynaktan: araç kaydındaki `mobile.entry`. */
const entryOf = (key: ProductKey) => PRODUCT_REGISTRY.find((e) => e.key === key)?.mobile?.entry as '/deciship/today' | undefined;

// `access` döngüsel içe aktarma yüzünden çağrı anında çözülür.
export const MOBILE_TOOLS: Partial<Record<ProductKey, MobileTool>> = {
  deciship: { key: 'deciship', href: entryOf('deciship'), band: 'deciship', access: (me) => decishipAccess(me) },
};

const none = (): ToolAccess => ({ state: 'no_access', canUse: false, canWrite: false, canCapture: false, canViewAll: false, has: () => false });

/** Kayıtlı aracın kendi kuralı; kayıtta yoksa genel kural: ürün hazır + abonelik var + kişinin rolü var. */
export function toolAccess(me: MeResponse | null | undefined, key: ProductKey): ToolAccess {
  const own = MOBILE_TOOLS[key];
  if (own) return own.access(me);
  if (!me?.activeOrg) return { ...none(), state: 'no_org' };
  const product = me.products.find((p) => p.key === key);
  if (!product || !isProductOpen(product) || !product.subscription || !product.role) return none();
  const canWrite = product.subscription.status === 'ACTIVE';
  return {
    state: canWrite ? 'active' : 'read_only',
    canUse: true,
    canWrite,
    canCapture: false,
    canViewAll: false,
    has: (permission) => product.permissions.includes(permission),
  };
}
