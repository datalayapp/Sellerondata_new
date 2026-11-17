import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useHoldsPermission } from '../auth/AuthContext';

/** 404: kısa açıklama, panoya dönüş; kayıt bağlantısıysa firma seçiciye yönlendirme. */
export function NotFoundPage() {
  const { t } = useTranslation();
  const canInvoices = useHoldsPermission('deciship.invoices.view');
  return (
    <div className="content">
      <section className="lost" aria-labelledby="lost-h">
        <p className="lost-code mono">{t('notFound.eyebrow')}</p>
        <h1 id="lost-h">{t('notFound.title')}</h1>
        <p>{t('notFound.text')}</p>
        <div className="lost-acts">
          <Link className="btn btn-primary" to="/">
            {t('notFound.back')}
          </Link>
          {canInvoices && (
            <Link className="btn btn-secondary" to="/invoices">
              {t('notFound.invoices')}
            </Link>
          )}
        </div>
        <p className="lost-note">{t('notFound.otherFirm')}</p>
      </section>
    </div>
  );
}
