import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRODUCTS, type ProductKey } from '@sellerondata/contracts';
import { PageHeader, ProductMark, Tag, currentLocale, useMe } from '@sellerondata/shell';
import { ShellFrame } from '../components/HubLayout.tsx';

/** `/orderloom*`, `/tagpress*`: rayda tıklanmaz; adresi yazan da burada ne olduğunu ve nereye döneceğini okur. */
export function ComingSoon({ product }: { product: ProductKey }) {
  const { t } = useTranslation();
  const def = PRODUCTS[product];
  const { me } = useMe();
  // Kayıtta açık ama bu firmada açılmamış araç: "yakında" demek yanıltır.
  const notOpen = (me?.products.find((x) => x.key === product)?.launch ?? def.launch) !== 'off';
  return (
    <ShellFrame currentProduct={product} pageTitle={t('common.soon')} withNav={false}>
      <div className="hub-page d9">
        <PageHeader title={def.name} sub={def.tagline[currentLocale()]} />
        <div className="d9-wrap d9-narrow">
          <section className="d9-panel d9-center d9-soon" aria-label={def.name}>
            <ProductMark product={product} size={56} />
            <div>
              <p>
                <Tag tone="gray">{notOpen ? t('tool.notOpenTitle', { name: def.name }) : t('common.soon')}</Tag>
              </p>
              <p className="d9-help">{notOpen ? t('tool.notOpenBody') : t('soon.body')}</p>
              <Link className="btn btn-secondary" to="/home">
                {t('tool.backHub')}
              </Link>
            </div>
          </section>
        </div>
      </div>
    </ShellFrame>
  );
}
