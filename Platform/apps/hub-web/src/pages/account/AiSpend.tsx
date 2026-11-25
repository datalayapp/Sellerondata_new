import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { SpendView } from './AiSpendParts.tsx';

/*
 * Abonelik › Yapay zekâ harcaması (`/account/billing/ai`): firmanın bütün araçlardaki yapay zekâ harcaması, TL. Yalnız firma sahibi
 * ve yöneticisi (rota `RequireAccess isOrgAdmin`; uç da aynı kuralı uygular). DeciShip'in araç ayrıntısı
 * (`/account/billing/ai/deciship`) ayrı sayfadır; araç kırılımındaki bağlantı oraya gider.
 */
export function AiSpendPage() {
  const { t } = useTranslation();
  return (
    <SpendView
      scope="org"
      title={t('aiSpend.title')}
      crumbs={
        <>
          <Link to="/account/billing">{t('nav.billing')}</Link>
          <span className="sep" aria-hidden="true">
            ›
          </span>
        </>
      }
    />
  );
}
