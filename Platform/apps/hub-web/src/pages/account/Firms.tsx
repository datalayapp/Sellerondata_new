import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ORG_ROLE_LABEL, isOrgClosedEntry, type Locale } from '@sellerondata/contracts';
import { Icon, Notice, Tag, useMe, useSessionActions } from '@sellerondata/shell';
import { apiMessage } from '../../lib/hooks.ts';
import { Panel, Row } from './AccountLayout.tsx';
import { longDate } from './CloseOrg.tsx';
import { LeaveDialog } from './LeaveOrg.tsx';

/** Firmalarım'ın adresi; başka firmadan ayrılırken geçişten sonra buraya `?leave=<firma>` ile dönülür. */
export const FIRMS_PATH = '/account/firms';

/**
 * Hesabım › Firmalarım (`/account/firms`). Her firma için rol, etkin firma, "Merkez'de aç" (geçiş), firmadan ayrılma.
 * Ayrılma etkin firmadan yapılır (`POST /org/leave`): başka firmadan ayrılmak için önce o firmaya geçilir, onay penceresi
 * geçişten sonra açılır (`?leave=<firma>`). Sahip ayrılamaz.
 * Kapalı firma (yalnız sahibine gelir, `orgStatus: 'CLOSED'`) aynı listede "Kapalı" etiketi, kalıcı silinme tarihi ve
 * "Geri aç" (kapalı firma ekranı) ile görünür.
 */
export function FirmsPage() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language === 'en' ? 'en' : 'tr') as Locale;
  const { me } = useMe();
  const { switchOrg } = useSessionActions();
  const [params, setParams] = useSearchParams();
  const [leaving, setLeaving] = useState(false);
  const active = me?.activeOrg ?? null;
  const account = me?.account;
  const go = useMutation({ mutationFn: ({ id, to }: { id: string; to: string }) => switchOrg(id, to) });

  useEffect(() => {
    const id = params.get('leave');
    if (!id) return;
    if (active?.id === id && account?.canLeaveActiveOrg) setLeaving(true);
    params.delete('leave');
    setParams(params, { replace: true });
    // Yalnız ilk açılışta: geçişten sonra gelen istek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return null;
  const o = (k: string) => t(`accountArea.orgs.${k}`);
  const owns = me.orgs.some((x) => x.orgRole === 'OWNER' && !isOrgClosedEntry(x));
  const canCreate = !!(account?.canCreateOrg || account?.createOrgRequiresEmail);
  // Yalnız kapalı firması kalan kişi de "henüz firmada değilsiniz" okur; kapalı firmalar altında listelenir.
  const openCount = me.orgs.filter((x) => !isOrgClosedEntry(x)).length;
  return (
    <Panel id="acc-orgs" title={o('title')} sub={o('sub')}>
      {openCount === 0 && (
        <p className="acc-card-text">
          {o('none')}{' '}
          <Link className="acc-foot-link" to="/home">
            {o('create')}
          </Link>
        </p>
      )}
      {me.orgs.map((org) => {
        const name = (
          <>
            <Icon name="building" />
            <b>{org.name}</b>
          </>
        );
        if (isOrgClosedEntry(org)) {
          return (
            <Row
              key={org.id}
              className="is-closed"
              label={name}
              value={
                <Tag tone="gray" small>
                  {o('closed')}
                </Tag>
              }
              note={org.purgeAfter ? <small>{t('accountArea.orgs.purgeOn', { date: longDate(org.purgeAfter, org.timeZone) })}</small> : null}
              actions={
                <Link className="acc-act" to={`/account/company/closed/${encodeURIComponent(org.id)}`}>
                  {o('reopen')}
                </Link>
              }
            />
          );
        }
        const isActive = org.id === active?.id;
        const ok = org.status === 'ACTIVE';
        const canLeave = ok && org.orgRole !== 'OWNER' && (!isActive || !!account?.canLeaveActiveOrg);
        const busy = go.isPending && go.variables?.id === org.id;
        const note = !ok ? <small className="warn">{o('suspended')}</small> : isActive ? <small>{o('active')}</small> : null;
        return (
          <Row
            key={org.id}
            label={name}
            value={ORG_ROLE_LABEL[org.orgRole][lang]}
            note={note}
            actions={
              ok ? (
                <>
                  {isActive ? (
                    <Link className="acc-act" to="/home">
                      {o('open')}
                    </Link>
                  ) : (
                    <button type="button" className="acc-act" disabled={busy} onClick={() => go.mutate({ id: org.id, to: '/home' })}>
                      {o('open')}
                    </button>
                  )}
                  {/* Tehlikeli eylem kırmızı ve sonda. */}
                  {canLeave && (
                    <button
                      type="button"
                      className="acc-act danger"
                      disabled={busy}
                      onClick={() => (isActive ? setLeaving(true) : go.mutate({ id: org.id, to: `${FIRMS_PATH}?leave=${encodeURIComponent(org.id)}` }))}
                    >
                      {t('leave.action')}
                    </button>
                  )}
                </>
              ) : null
            }
          />
        );
      })}
      {go.isError && <Notice tone="err">{apiMessage(go.error, t('common.unexpected'))}</Notice>}
      {active?.orgRole === 'OWNER' ? (
        <p className="acc-card-foot">
          {t('accountArea.orgs.ownerBody', { org: active.name })}{' '}
          <Link className="acc-foot-link" to="/account/company">
            {o('ownerAction')}
          </Link>
        </p>
      ) : (
        owns && <p className="acc-card-foot">{o('ownerNote')}</p>
      )}
      {canCreate && openCount > 0 && (
        <div className="acc-card-end">
          <Link className="btn btn-secondary btn-sm" to="/account/company/new">
            {o('createNew')}
          </Link>
        </div>
      )}
      {leaving && active && account && (
        <LeaveDialog orgName={active.name} requiresPassword={account.leaveRequiresPassword} riskyRecovery={account.passwordRecovery !== 'email'} onClose={() => setLeaving(false)} />
      )}
    </Panel>
  );
}
