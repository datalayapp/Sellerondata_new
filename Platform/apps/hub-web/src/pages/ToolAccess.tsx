import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PRODUCTS, PRODUCT_KEYS, type ProductKey } from '@sellerondata/contracts';
import { Empty, Icon, PageHeader, currentLocale, useMe } from '@sellerondata/shell';
import { ShellFrame } from '../components/HubLayout.tsx';
import { roleDescriptionOf, roleLabelOf } from '../lib/access.ts';
import { NotFound } from './NotFound.tsx';

/**
 * Rayda DeciShip'e tıklayan ama `web.access` izni olmayan kişi buraya gelir (§8).
 * Rol varsa "bu rol mobil uygulamada çalışır", rol yoksa "erişiminiz yok". Etkin araç bu sayfada da bellidir.
 */
export function ToolAccess() {
  const { t } = useTranslation();
  const { product } = useParams();
  const { me } = useMe();
  const key = product as ProductKey;
  if (!PRODUCT_KEYS.includes(key)) {
    return (
      <ShellFrame pageTitle={t('nav.notFound')}>
        <NotFound />
      </ShellFrame>
    );
  }
  const def = PRODUCTS[key];
  const locale = currentLocale();
  const p = me?.products.find((x) => x.key === key);
  // Rol adı Hesap'tan (`roleLabel`: özel rol ya da adı değişmiş hazır rol); açıklama yalnız hazır rolde (katalog).
  const role = roleLabelOf(p, locale);
  const roleDescription = roleDescriptionOf(p, locale);
  const webOk = p?.permissions.includes(`${key}.web.access`);
  // Bu firmada açık değil: kayıtta kapalıysa "yakında", açık ama firmaya açılmamışsa "firmanızda açık değil".
  const open = p ? p.available : def.launch === 'public';
  const soon = (p?.launch ?? def.launch) === 'off';
  return (
    <ShellFrame currentProduct={key} pageTitle={!open ? t('tool.noAccessShort') : role ? t('tool.mobileShort') : t('tool.noAccessShort')} withNav={false}>
      <div className="hub-page d9">
        <PageHeader title={def.name} />
        <div className="d9-wrap d9-narrow">
          {!open ? (
            <section className="d9-panel d9-center">
              <Empty
                icon="lock"
                title={soon ? t('tool.soonTitle', { name: def.name }) : t('tool.notOpenTitle', { name: def.name })}
                actions={
                  <Link className="btn btn-secondary" to="/home">
                    {t('tool.backHub')}
                  </Link>
                }
              >
                {soon ? t('soon.body') : t('tool.notOpenBody')}
              </Empty>
            </section>
          ) : webOk ? (
            <section className="d9-panel d9-center">
              <Empty
                icon="check"
                good
                title={t('tool.okTitle', { name: def.name })}
                actions={
                  <a className="btn btn-primary" href={`${def.basePath}/`}>
                    {t('home.openTool', { name: def.name })}
                  </a>
                }
              />
            </section>
          ) : role ? (
            <section className="d9-panel d9-center d9-mobile" aria-labelledby="hub-tool-title">
              <span className="d9-mobile-ic">
                <Icon name="phone" size={24} />
              </span>
              <div>
                <h2 id="hub-tool-title">{t('simple.mobileTitle')}</h2>
                <p>{t('simple.mobileBody', { role, tool: def.name })}</p>
                {roleDescription && <p className="d9-mobile-role">{roleDescription}</p>}
                <ol className="d9-steps">
                  <li>{t('simple.step1')}</li>
                  <li>{t('simple.step2')}</li>
                  <li>{t('simple.step3')}</li>
                </ol>
                <div className="d9-app-slot">
                  <span className="qr" aria-hidden="true">
                    <Icon name="phone" size={20} />
                  </span>
                  <p>{t('simple.appSlot')}</p>
                </div>
                <Link className="btn btn-secondary d9-mobile-back" to="/home">
                  {t('tool.backHub')}
                </Link>
              </div>
            </section>
          ) : (
            <section className="d9-panel d9-center">
              <Empty
                icon="lock"
                title={t('tool.noAccessTitle', { name: def.name })}
                actions={
                  <Link className="btn btn-secondary" to="/home">
                    {t('tool.backHub')}
                  </Link>
                }
              >
                {t('tool.noAccessBody')}
              </Empty>
            </section>
          )}
        </div>
      </div>
    </ShellFrame>
  );
}
