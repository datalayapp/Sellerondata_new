import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORG_PURGE_DAYS_DEFAULT, type CloseOrgBody, type CloseOrgResponse, type AuthResponse, type ReopenOrgBody } from '@sellerondata/contracts';
import { Button, Empty, Field, ME_QUERY_KEY, Modal, ModalAction, Notice, PageHeader, Tag, beginOrgChange, currentLocale, shellTimeZone, toast, useMe } from '@sellerondata/shell';
import { asList, type OrgMember } from '../../api/types.ts';
import { canSubmitClose, closeErrorKey, closedOrgDate, closedOrgOf, noteReopened, purgePreview, reopenErrorOf, takeReopened } from '../../lib/closeOrg.ts';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { client } from '../../lib/session.ts';

/**
 * Tuvaldeki uzun tarih: "13 Aralık 2026" / "13 December 2026". Kapalı firmanın tarihi o firmanın saat diliminde (`timeZone`, `/me`
 * `orgs[].timeZone`); verilmezse etkin firmanınkinde (kabuk `shellTimeZone`; kapatma penceresinde kapatılan firma etkin firmadır).
 */
export const longDate = (iso: string, timeZone?: string) => closedOrgDate(iso, currentLocale(), timeZone, shellTimeZone());

/** Sekmenin oturum deposu (`sessionStorage`); erişilemezse (kapalı depo) yok. */
const flashStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Geri açmadan sonra sayfa baştan yüklenir: başarı iletisi yüklemeden sonra, bir kez (Merkez çerçevesi çağırır). */
export function useReopenedNotice() {
  const { t } = useTranslation();
  useEffect(() => {
    const org = takeReopened(flashStorage());
    if (org !== null) toast.ok(t('closeOrg.reopened', { org }));
  }, [t]);
}

/**
 * Oturum değişti (etkin firma başka firmaya geçti ya da boşaldı): kişi ve sorgu önbelleği silinir, sayfa baştan yüklenir.
 * Kabuğun `leaveOrg` kalıbıyla aynı.
 */
function useReloadSession() {
  const qc = useQueryClient();
  return () => {
    beginOrgChange();
    qc.clear();
    window.location.assign('/home');
  };
}

/**
 * Firma sayfasının en altı, yalnız sahibe: kırmızı çerçeveli bölüm, düğme onay penceresini açar.
 * Görünürlüğü çağıran denetler (`canCloseOrg`); sunucu da sahip olmayanı `403 FORBIDDEN` ile reddeder.
 */
export function CloseOrgSection({ orgName }: { orgName: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="d9-panel d9-danger" aria-labelledby="close-org-title">
      <h2 id="close-org-title">{t('closeOrg.sectionTitle')}</h2>
      <p>{t('closeOrg.sectionBody', { days: ORG_PURGE_DAYS_DEFAULT })}</p>
      <div className="d9-acts">
        <Button kind="danger-outline" onClick={() => setOpen(true)}>
          {t('closeOrg.open')}
        </Button>
      </div>
      {open && <CloseOrgDialog orgName={orgName} onClose={() => setOpen(false)} />}
    </section>
  );
}

function CloseOrgDialog({ orgName, onClose }: { orgName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const scope = useScope();
  const reload = useReloadSession();
  // Kişi sayısı Ekip ekranının listesiyle aynı sorgu (önbellekte varsa yeniden gelmez); gelmezse sayısız metin yazılır.
  const members = useQuery({ queryKey: [...scope, 'members'], queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const go = useMutation({
    mutationFn: () => client.post<CloseOrgResponse>('/api/account/org/close', { confirmName: typed, password } satisfies CloseOrgBody),
    onSuccess: reload,
  });
  const errKey = go.isError ? closeErrorKey(go.error) : null;
  const ready = canSubmitClose(typed, password, orgName);
  return (
    <Modal
      title={t('closeOrg.title', { org: orgName })}
      onClose={onClose}
      busy={go.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="danger" loading={go.isPending} disabled={!ready} onClick={() => go.mutate()}>
            {t('closeOrg.confirm')}
          </ModalAction>
        </>
      }
    >
      <div className="form-stack">
        <ul className="d9-close-list">
          <li>{members.data ? t('closeOrg.listTeam', { count: members.data.length }) : t('closeOrg.listTeamAll')}</li>
          <li>{t('closeOrg.listData', { days: ORG_PURGE_DAYS_DEFAULT })}</li>
          <li>{t('closeOrg.listReopen', { date: longDate(purgePreview()) })}</li>
          <li>{t('closeOrg.listBilling')}</li>
        </ul>
        <Field
          label={
            <>
              {t('closeOrg.nameLabel')} <b>{orgName}</b>
            </>
          }
          htmlFor="close-org-name"
        >
          <input id="close-org-name" className="inp" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <Field label={t('closeOrg.password')} htmlFor="close-org-pw">
          <input id="close-org-pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {go.isError && <Notice tone="err">{errKey ? t(errKey) : apiMessage(go.error, t('common.unexpected'))}</Notice>}
      </div>
    </Modal>
  );
}

/**
 * Kapalı firmanın tek ekranı (`/account/company/closed/:orgId`, firma seçicideki kapalı öğe buraya bağlanır): ne zaman kapandı, ne
 * zamana kadar geri açılabilir, tek birincil eylem "Firmayı geri aç". Firma `/me`'de kapalı olarak yoksa (sahip değil, geri açıldı,
 * silindi) sakin "geri açılamaz" hali.
 */
export function ClosedOrg() {
  const { t } = useTranslation();
  const { orgId } = useParams();
  const { me } = useMe();
  const org = closedOrgOf(me, orgId);
  const [asking, setAsking] = useState(false);
  return (
    <div className="hub-page d9">
      <PageHeader title={org?.name ?? t('closeOrg.pageTitle')} />
      <div className="d9-wrap d9-narrow">
        {org ? (
          <section className="d9-panel d9-center d9-closed" aria-labelledby="closed-org-title">
            <Tag tone="red" small>
              {t('closeOrg.closedTag')}
            </Tag>
            <h2 id="closed-org-title">{t('closeOrg.closedTitle', { org: org.name })}</h2>
            <p>
              {t('closeOrg.closedBody', {
                closedAt: org.closedAt ? longDate(org.closedAt, org.timeZone) : '—',
                purgeAfter: org.purgeAfter ? longDate(org.purgeAfter, org.timeZone) : '—',
              })}
            </p>
            <div className="d9-acts">
              <Button onClick={() => setAsking(true)}>{t('closeOrg.reopen')}</Button>
            </div>
            {asking && <ReopenDialog orgId={org.id} orgName={org.name} onClose={() => setAsking(false)} />}
          </section>
        ) : (
          <section className="d9-panel d9-center">
            <Empty
              icon="lock"
              title={t('closeOrg.goneTitle')}
              actions={
                <Link className="btn btn-secondary" to="/home">
                  {t('tool.backHub')}
                </Link>
              }
            >
              {t('closeOrg.goneBody')}
            </Empty>
          </section>
        )}
      </div>
    </div>
  );
}

function ReopenDialog({ orgId, orgName, onClose }: { orgId: string; orgName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const reload = useReloadSession();
  const [password, setPassword] = useState('');
  const go = useMutation({
    mutationFn: () => client.post<AuthResponse>('/api/account/org/reopen', { orgId, password } satisfies ReopenOrgBody),
    onSuccess: () => {
      noteReopened(flashStorage(), orgName);
      reload();
    },
    // Firma artık geri açılamıyorsa (süre doldu, zaten açık, sahip değil) liste yenilenir; ekran sakin hale düşer, metin pencerede kalır.
    onError: (e) => {
      if (reopenErrorOf(e).gone) void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
  const err = go.isError ? reopenErrorOf(go.error) : null;
  return (
    <Modal
      title={t('closeOrg.reopenTitle', { org: orgName })}
      onClose={onClose}
      busy={go.isPending}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="prim" loading={go.isPending} disabled={!password} onClick={() => go.mutate()}>
            {t('closeOrg.reopen')}
          </ModalAction>
        </>
      }
    >
      <div className="form-stack">
        <p>{t('closeOrg.reopenBody')}</p>
        <Field label={t('closeOrg.password')} htmlFor="reopen-org-pw" help={t('closeOrg.reopenPasswordHelp')}>
          <input id="reopen-org-pw" className="inp" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {err && <Notice tone="err">{err.key ? t(err.key) : apiMessage(go.error, t('common.unexpected'))}</Notice>}
      </div>
    </Modal>
  );
}
