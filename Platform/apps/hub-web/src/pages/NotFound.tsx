import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Empty, PageHeader } from '@sellerondata/shell';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="hub-page d9">
      <PageHeader title={t('notFound.title')} />
      <div className="d9-wrap d9-narrow">
        <section className="d9-panel d9-center">
          <Empty
            icon="search"
            title={t('notFound.body')}
            actions={
              <Link className="btn btn-secondary" to="/home">
                {t('tool.backHub')}
              </Link>
            }
          />
        </section>
      </div>
    </div>
  );
}
