import { useEffect } from 'react';
import { PRODUCTS, PRODUCT_KEYS, type MeResponse, type ProductKey } from '@sellerondata/contracts';
import type { ShellProduct } from './marks.tsx';

const HUB_HOME = '/home';

/** Aracın web uygulaması var ve girişi bir izne bağlı mı? Yoksa aracın yolları Merkez'indir. */
function webAccessOf(key: ProductKey) {
  const def = PRODUCTS[key];
  return def.deploy?.web && def.webAccess ? def.webAccess : undefined;
}

/**
 * Araç bu firmada açık mı? `me` varsa sunucunun hükmü (`me.products[].available`: `public`, ya da `pilot` ve canlı abonelik).
 * `me` yokken (yükleniyor, giriş yok) kayıttaki varsayılan: `launch === 'public'`.
 */
export function isProductOpen(me: MeResponse | null, key: ProductKey): boolean {
  if (!me) return PRODUCTS[key].launch === 'public';
  return me.products.find((p) => p.key === key)?.available === true;
}

/**
 * Rayın araca gittiği yol. Web erişimi olmayan kişi "bu rol mobilde çalışır" sayfasına gider (§8).
 * Web'i olmayan araç (kayıtta `deploy.web` ya da `webAccess` yok): Merkez'de o araca süzülmüş Genel Bakış.
 */
export function productHref(me: MeResponse | null, key: ProductKey, noAccessBase = '/account/tool-access'): string {
  const web = webAccessOf(key);
  if (!web) return `${HUB_HOME}?tool=${key}`;
  if (!me) return PRODUCTS[key].basePath + '/';
  const p = me.products.find((x) => x.key === key);
  if (p?.permissions.includes(web)) return PRODUCTS[key].basePath + '/';
  return `${noAccessBase}/${key}`;
}

/**
 * Açık araçları önceden yükler (§8). Gezinti tam sayfa olduğu için bu geçişi anlık yapan tek şey budur.
 * - `<link rel="prefetch">` her zaman.
 * - Speculation Rules varsa üstüne gelince önceden çizim. Satır içi kural CSP'de
 *   `script-src 'inline-speculation-rules'` ister; izin yoksa tarayıcı sessizce yok sayar, prefetch yine çalışır.
 */
export function usePrefetchProducts(current: ShellProduct, me: MeResponse | null) {
  useEffect(() => {
    if (!me) return;
    const urls = PRODUCT_KEYS.filter((k) => {
      const web = webAccessOf(k);
      return k !== current && !!web && me.products.find((p) => p.key === k)?.permissions.includes(web);
    }).map((k) => PRODUCTS[k].basePath + '/');
    if (current !== 'hub') urls.push(HUB_HOME);
    const nodes: HTMLElement[] = [];
    for (const href of urls) {
      if (document.head.querySelector(`link[rel="prefetch"][href="${href}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      link.as = 'document';
      document.head.appendChild(link);
      nodes.push(link);
    }
    if (urls.length && HTMLScriptElement.supports?.('speculationrules')) {
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify({
        prerender: [{ where: { selector_matches: 'a[data-sod-tool]' }, eagerness: 'moderate' }],
      });
      document.head.appendChild(s);
      nodes.push(s);
    }
    return () => nodes.forEach((n) => n.remove());
  }, [current, me]);
}

/** Sekme başlığı ve simgesi: "Faturalar · DeciShip". Etkin araç sekmede de belli olur. */
export function setShellDocumentTitle(productName: string, page?: string | null) {
  document.title = page ? `${page} · ${productName}` : productName;
}
