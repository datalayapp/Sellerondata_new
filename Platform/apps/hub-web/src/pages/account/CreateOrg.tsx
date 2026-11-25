import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ApiError, Button, Empty, Field, Notice, PageHeader, SessionBanner, useMe, useSessionActions } from '@sellerondata/shell';
import { closedOrgsOf } from '../../lib/closeOrg.ts';
import { apiMessage } from '../../lib/hooks.ts';
import { useLogoutAction } from '../../lib/logout.ts';
import { COUNTRIES } from './Company.tsx';
import { longDate } from './CloseOrg.tsx';
import { AuthFrame } from '../auth/Auth.tsx';

function CreateOrgForm() {
  const { t } = useTranslation();
  const { me } = useMe();
  if (me?.account?.createOrgRequiresEmail) {
    // Firma sahibinin e-postası zorunlu: şifresini kurtarabilecek başka kimse yok.
    return (
      <div className="form-stack">
        <Notice tone="warn">{t('createOrg.needsEmail')}</Notice>
        <Link className="btn btn-primary hub-auth-submit" to="/account/profile">
          {t('createOrg.addEmail')}
        </Link>
      </div>
    );
  }
  return <CreateOrgFields />;
}

function CreateOrgFields() {
  const { t, i18n } = useTranslation();
  const { me } = useMe();
  const { createOrg } = useSessionActions();
  const [name, setName] = useState('');
  const [country, setCountry] = useState(me?.account?.defaultCountry ?? 'TR');
  const create = useMutation({ mutationFn: () => createOrg({ name: name.trim(), country }) });
  const closed = create.error instanceof ApiError && create.error.code === 'REGISTRATION_CLOSED';
  const countries = new Intl.DisplayNames([i18n.language], { type: 'region' });
  return (
    <form
      className="form-stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field label={t('company.name')} htmlFor="new-org" className="req">
        <input id="new-org" className="inp" required autoFocus autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('company.country')} htmlFor="new-org-country">
        <select id="new-org-country" className="sel" value={country} onChange={(e) => setCountry(e.target.value)}>
          {Array.from(new Set([country, ...COUNTRIES])).map((c) => (
            <option key={c} value={c}>
              {countries.of(c) ?? c}
            </option>
          ))}
        </select>
      </Field>
      {create.isError && <Notice tone={closed ? 'info' : 'err'}>{apiMessage(create.error, t('common.unexpected'))}</Notice>}
      <p className="hub-sheet-note flush">{t('createOrg.note')}</p>
      <Button type="submit" className="hub-auth-submit" loading={create.isPending} disabled={closed}>
        {t('createOrg.submit')}
      </Button>
    </form>
  );
}

/** Firma seçiciden "Yeni firma". Kabuk içinde, mevcut firma arkada durur. */
export function NewCompany() {
  const { t } = useTranslation();
  const { me } = useMe();
  return (
    <div className="hub-page d9">
      <PageHeader title={t('createOrg.title')} sub={t('createOrg.sub')} />
      <div className="d9-wrap d9-narrow">
        <section className="d9-panel d9-lift d9-form" aria-label={t('createOrg.title')}>
          {me?.account?.canCreateOrg === false && !me.account.createOrgRequiresEmail ? (
            <Empty compact icon="lock" title={t('createOrg.closedTitle')}>
              {t('createOrg.closedBody')}
            </Empty>
          ) : (
            <CreateOrgForm />
          )}
        </section>
      </div>
    </div>
  );
}

/** Etkin firması olmayan kişi: tam ekran. Askıdaki üyeliği varsa onu da söyler. */
export function NoCompanyScreen() {
  const { t } = useTranslation();
  const { me } = useMe();
  const leaveSession = useLogoutAction({ hard: true });
  // E-postasız kişide `canCreateOrg` false döner: kapalı değil, önce e-posta gerekiyor.
  const canCreate = (me?.account?.canCreateOrg || me?.account?.createOrgRequiresEmail) ?? false;
  const suspended = me?.orgs.filter((o) => o.status === 'SUSPENDED') ?? [];
  // Kapattığı firma (yalnız sahibe gelir): firma seçici bu ekranda yok, geri açma yolu buradan.
  const closed = closedOrgsOf(me);
  // Etkin firma yok ve askıda üyelik var: kişi firmasız değil, askıda.
  const isSuspended = (me?.account?.suspendedOrgCount ?? suspended.length) > 0;
  const foot = (
    <p>
      <Link className="link-btn" to="/account/profile">{t('createOrg.account')}</Link>
      {' · '}
      <button type="button" className="link-btn" onClick={leaveSession}>
        {t('createOrg.logout')}
      </button>
    </p>
  );
  return (
    // Firma oluştur yalnız hiç üyeliği olmayan kişiye: askıdaki üye yanlış yola girmesin.
    <AuthFrame title={isSuspended ? t('createOrg.suspendedTitle') : canCreate ? t('createOrg.emptyTitle') : t('createOrg.closedTitle')} sub={isSuspended ? t('createOrg.suspendedBody') : canCreate ? t('createOrg.emptySub') : t('createOrg.closedBody')} foot={foot}>
      <SessionBanner />
      {closed.map((o) => (
        <Notice
          key={o.id}
          tone="info"
          action={
            <Link className="act link-btn" to={`/account/company/closed/${encodeURIComponent(o.id)}`}>
              {t('closeOrg.reopen')}
            </Link>
          }
        >
          {t('closeOrg.noOrgHint', { org: o.name, date: o.purgeAfter ? longDate(o.purgeAfter, o.timeZone) : '—' })}
        </Notice>
      ))}
      {suspended.length > 0 && <p className="hub-suspended-orgs">{suspended.map((o) => o.name).join(', ')}</p>}
      {canCreate && !isSuspended && <CreateOrgForm />}
    </AuthFrame>
  );
}
