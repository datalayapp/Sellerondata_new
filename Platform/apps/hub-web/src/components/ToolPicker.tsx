import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRODUCTS, PRODUCT_KEYS, type ProductKey } from '@sellerondata/contracts';
import { ProductMark, isProductOpen, useMe } from '@sellerondata/shell';

/**
 * Araç seçici (Genel Bakış ve Analiz): [Tümü] · açık araçlar · yakında gelenler.
 * Genel Bakış'ta "Tümü" yok (`withAll={false}`): her zaman tek aracın özetine bakılır.
 * Seçim adreste durur; her seçenek gerçek bağlantıdır, geri/ileri çalışır.
 * Yakında araçlar seçilemez. İzni olmayan açık araç hiç görünmez.
 */
export function ToolPicker({
  allowed,
  current,
  hrefFor,
  onBand,
  withAll = true,
}: {
  onBand?: boolean;
  withAll?: boolean;
  allowed: ProductKey[];
  current: ProductKey | null;
  hrefFor: (key: ProductKey | null) => string;
}) {
  const { t } = useTranslation();
  const { me } = useMe();
  if (allowed.length === 0) return null;
  return (
    <nav className={`ptabs hub-tool-tabs${onBand ? ' on-band' : ''}`} aria-label={t('analytics.toolTabs')}>
      {withAll && (
        <Link to={hrefFor(null)} className={`hub-tool-tab${current === null ? ' on' : ''}`} aria-current={current === null ? 'page' : undefined}>
          {t('common.all')}
        </Link>
      )}
      {PRODUCT_KEYS.map((key) => {
        const def = PRODUCTS[key];
        if (!isProductOpen(me, key)) {
          return (
            <span key={key} className="hub-tool-tab is-soon" role="link" aria-disabled="true">
              <ProductMark product={key} size={18} />
              {def.name}
              <small>{t('common.soon')}</small>
            </span>
          );
        }
        if (!allowed.includes(key)) return null;
        return (
          <Link key={key} to={hrefFor(key)} className={`hub-tool-tab${key === current ? ' on' : ''}`} aria-current={key === current ? 'page' : undefined}>
            <ProductMark product={key} size={18} />
            {def.name}
          </Link>
        );
      })}
    </nav>
  );
}
