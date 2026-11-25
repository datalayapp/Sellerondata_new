import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Icon, PageHeader, formatPhone, initials, useMe, type IconName } from '@sellerondata/shell';

/** Hesabım'ın üç bölümü; her biri kendi adresinde (tasarım tuvali "Hesabım", 2026-11-13). */
const SECTIONS: { to: string; key: 'profile' | 'security' | 'firms'; icon: IconName }[] = [
  { to: '/account/profile', key: 'profile', icon: 'user' },
  { to: '/account/security', key: 'security', icon: 'lock' },
  { to: '/account/firms', key: 'firms', icon: 'building' },
];

/**
 * Hesabım çerçevesi: başlık bantta (baş harf dairesi, ad, iletişim + "tüm firmalarınızda aynı"), gövdede solda ayar menüsü,
 * sağda seçili bölüm (`<Outlet />`). Merkez'in kabuğunda çizilir (HubLayout); firmasız kişi de girer (ShellFrame istisnası).
 * Dar ekranda menü içeriğin üstünde yatay satır olur (account.css).
 */
export function AccountLayout() {
  const { t } = useTranslation();
  const { me } = useMe();
  if (!me) return null;
  const p = me.person;
  const contact = p.email ?? (p.phone ? formatPhone(p.phone) : null);
  return (
    <div className="hub-page acc">
      <PageHeader
        title={p.name}
        sub={[contact, t('accountArea.head.same')].filter(Boolean).join(' · ')}
        media={
          <span className="phead-av" aria-hidden="true">
            {initials(p.name)}
          </span>
        }
      />
      <div className="d9-wrap">
        <div className="acc-side d9-lift">
          <nav className="acc-nav" aria-label={t('accountArea.nav.label')}>
            {SECTIONS.map((s) => (
              <NavLink key={s.key} to={s.to}>
                <Icon name={s.icon} />
                <span>{t(`accountArea.nav.${s.key}`)}</span>
              </NavLink>
            ))}
          </nav>
          <div className="acc-main">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Panel: başlık (isteğe bağlı kısa açıklama) ve satırlar. */
export function Panel({ id, title, sub, children }: { id: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="acc-card" aria-labelledby={id}>
      <div className="acc-card-head">
        <h2 id={id}>{title}</h2>
        {sub && <p className="acc-card-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** Panel satırı: etiket, değer (altında kısa not), eylemler; düzenleme satırın altında açılır. */
export function Row({
  label,
  value,
  note,
  actions,
  className,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`acc-row${className ? ` ${className}` : ''}`}>
      <span className="acc-lab">{label}</span>
      <span className="acc-val">
        {value}
        {note}
      </span>
      <span className="acc-acts">{actions}</span>
      {children && <div className="acc-edit">{children}</div>}
    </div>
  );
}
