import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ORG_TIME_ZONE, LOCALES, NAME_MAX_LENGTH, ORG_CURRENCIES, TIME_ZONES, defaultTimeZone, isCompanyConfirmed, isOrgTimeZone, type Locale } from '@sellerondata/contracts';
import { ApiError, ME_QUERY_KEY } from '@sellerondata/shell';
import { ActionMenu, Button, ErrorState, Field, Modal, ModalAction, Notice, PageHeader, Skel, toast, useMe } from '@sellerondata/shell';
import { asList, type OrgInfo, type OrgMember } from '../../api/types.ts';
import { isOwner } from '../../lib/access.ts';
import { canCloseOrg } from '../../lib/closeOrg.ts';
import { apiMessage, useScope } from '../../lib/hooks.ts';
import { isHubPath, safeNext } from '../../lib/nav.ts';
import { client } from '../../lib/session.ts';
import { CloseOrgSection } from './CloseOrg.tsx';

export const COUNTRIES = ['TR', 'US', 'DE', 'GB', 'NL', 'FR'];
const CURRENCIES = ORG_CURRENCIES;

/** Eski sunucu (ya da sahte sunucu) dil ve saat dilimini göndermeyebilir: sunucunun varsayılanı gösterilir. */
const orgLocale = (o: OrgInfo): Locale => (o.locale === 'en' ? 'en' : 'tr');
const orgTimeZone = (o: OrgInfo): string => (isOrgTimeZone(o.timeZone) ? o.timeZone : DEFAULT_ORG_TIME_ZONE);

/** "Europe/Istanbul (GMT+3)": IANA adı her dilde aynı ve ayırt edicidir; bugünkü fark yanında. */
function timeZoneLabel(zone: string): string {
  const name = zone.replace(/_/g, ' ');
  if (zone === 'UTC') return name;
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return offset ? `${name} (${offset})` : name;
  } catch {
    return name;
  }
}

export function Company() {
  const { t, i18n } = useTranslation();
  const { me } = useMe();
  const scope = useScope();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: [...scope, 'org'], queryFn: () => client.get<OrgInfo>('/api/account/org') });
  const [name, setName] = useState('');
  const [country, setCountry] = useState('TR');
  const [currency, setCurrency] = useState('TRY');
  const [locale, setLocale] = useState<Locale>('tr');
  const [timeZone, setTimeZone] = useState<string>(DEFAULT_ORG_TIME_ZONE);
  /** Kişi saat dilimini bu düzenlemede elle seçtiyse ülke değişimi onu değiştirmez. */
  const [timeZoneTouched, setTimeZoneTouched] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  // Merkez kurulumu: firma onay bekliyorsa (`companyConfirmedAt: null`) tek birincil eylem "Onayla"; alan yoksa onaylı sayılır.
  const pendingConfirm = !!org.data && !isCompanyConfirmed(org.data);

  useEffect(() => {
    if (!org.data) return;
    setName(org.data.name);
    setCountry(org.data.country);
    setCurrency(org.data.currency);
    setLocale(orgLocale(org.data));
    setTimeZone(orgTimeZone(org.data));
    setTimeZoneTouched(false);
  }, [org.data]);

  const changeCountry = (next: string) => {
    setCountry(next);
    // Dokunulmamış saat dilimi yeni ülkenin önerisine geçer (kaydetmeden önce görünür); kayıtlı ülkeye dönünce kayıtlı değere.
    if (!timeZoneTouched) setTimeZone(org.data && next === org.data.country ? orgTimeZone(org.data) : defaultTimeZone(next));
  };

  const save = useMutation({
    mutationFn: (confirm: boolean) => client.patch('/api/account/org', { name: name.trim(), country, currency, locale, timeZone, ...(confirm ? { confirmCompany: true } : {}) }),
    onSuccess: async (_data, confirm) => {
      await Promise.all([qc.invalidateQueries({ queryKey: [...scope, 'org'] }), qc.invalidateQueries({ queryKey: ME_QUERY_KEY })]);
      toast.ok(confirm ? t('company.confirmed') : t('company.saved'));
      // Gelinen yere dönüş (`?next=`): yalnız aynı kökende göreli yol; Merkez yolu router ile, aracın yolu tam sayfa.
      if (!next) return;
      const to = safeNext(next);
      if (isHubPath(to)) navigate(to);
      else window.location.assign(to);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(pendingConfirm);
  };
  const dirty =
    !!org.data &&
    (name !== org.data.name || country !== org.data.country || currency !== org.data.currency || locale !== orgLocale(org.data) || timeZone !== orgTimeZone(org.data));
  const countries = new Intl.DisplayNames([i18n.language], { type: 'region' });
  const languages = new Intl.DisplayNames([i18n.language], { type: 'language' });
  /** `maxLength` fazlasını sessizce keser (yapıştırmada da); alan sınıra dayanınca kişi bilsin. API sınırı aynı sabittir. */
  const nameAtLimit = name.length >= NAME_MAX_LENGTH;

  return (
    <div className="hub-page d9">
      <PageHeader title={t('company.title')} sub={t('company.sub')} />
      <div className="d9-wrap d9-narrow">
        <section className="d9-panel d9-lift d9-form" aria-label={t('company.title')}>
          <div className="d9-panel-h">
            <ActionMenu
              iconOnly
              label={t('d9.company.more')}
              items={[
                { label: t('company.transferAction'), icon: 'users', onSelect: () => setTransfer(true), disabled: !isOwner(me), hint: isOwner(me) ? undefined : t('company.ownerOnly') },
                { label: t('createOrg.title'), icon: 'plus', onSelect: () => navigate('/account/company/new') },
              ]}
            />
          </div>
          {org.isError ? (
            <ErrorState error={org.error} onRetry={() => org.refetch()} />
          ) : org.isPending ? (
            <div className="d9-skel">
              <Skel h={40} />
              <Skel h={40} />
            </div>
          ) : (
            <form onSubmit={submit} className="d9-fields">
              {pendingConfirm && (
                <Notice tone="info">
                  <b>{t('company.confirmTitle')}</b> {t('company.confirmBody')}
                  {next && <> {t('company.confirmReturn')}</>}
                </Notice>
              )}
              <Field label={t('company.name')} htmlFor="org-name" className="req" help={nameAtLimit ? <span id="org-name-limit" role="status">{t('company.nameClipped', { max: NAME_MAX_LENGTH })}</span> : undefined}>
                <input id="org-name" className="inp" required maxLength={NAME_MAX_LENGTH} aria-describedby={nameAtLimit ? 'org-name-limit' : undefined} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="d9-row">
                <Field label={t('company.country')} htmlFor="org-country">
                  <select id="org-country" className="sel" value={country} onChange={(e) => changeCountry(e.target.value)}>
                    {Array.from(new Set([country, ...COUNTRIES])).map((c) => (
                      <option key={c} value={c}>
                        {countries.of(c) ?? c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('company.currency')} htmlFor="org-currency">
                  <select id="org-currency" className="sel" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="d9-help">{t('company.currencyHelp')}</p>
              <div className="d9-row">
                <Field label={t('company.locale')} htmlFor="org-locale">
                  <select id="org-locale" className="sel" aria-describedby="org-locale-help" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {languages.of(l) ?? l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('company.timeZone')} htmlFor="org-time-zone">
                  <select
                    id="org-time-zone"
                    className="sel"
                    aria-describedby="org-time-zone-help"
                    value={timeZone}
                    onChange={(e) => {
                      setTimeZone(e.target.value);
                      setTimeZoneTouched(true);
                    }}
                  >
                    {TIME_ZONES.map((z) => (
                      <option key={z} value={z}>
                        {timeZoneLabel(z)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="d9-help" id="org-locale-help">
                {t('company.localeHelp')}
              </p>
              <p className="d9-help" id="org-time-zone-help">
                {t('company.timeZoneHelp')}
              </p>
              {save.isError && <Notice tone="err">{apiMessage(save.error, t('common.unexpected'))}</Notice>}
              <div className="d9-acts">
                {/* Onay bekleyen firmada değişiklik olmasa da onaylanabilir: alanlar onayla birlikte gider. */}
                <Button type="submit" loading={save.isPending} disabled={!pendingConfirm && !dirty}>
                  {pendingConfirm ? t('company.confirm') : t('common.save')}
                </Button>
              </div>
            </form>
          )}
        </section>
        {/* En altta, yalnız sahibe: firmayı kapatma. Ad, kayıtlı ad: düzenlenip kaydedilmemiş ad onaylanmaz. */}
        {canCloseOrg(me) && org.data && <CloseOrgSection orgName={org.data.name} />}
      </div>
      {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
    </div>
  );
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useMe();
  const scope = useScope();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: [...scope, 'members'], queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  const options = (members.data ?? []).filter((m) => m.id !== me?.activeOrg?.membershipId && m.status === 'ACTIVE');
  const [membershipId, setMembershipId] = useState('');
  const [password, setPassword] = useState('');
  const go = useMutation({
    mutationFn: () => client.post('/api/account/org/transfer-ownership', { membershipId, password }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast.ok(t('company.transferred'));
      onClose();
    },
  });
  return (
    <Modal
      title={t('company.transferTitle')}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="danger" loading={go.isPending} disabled={!membershipId || !password} onClick={() => go.mutate()}>
            {t('company.transferConfirm')}
          </ModalAction>
        </>
      }
    >
      <div className="form-stack">
        <Field label={t('company.transferTo')} htmlFor="tr-to" help={options.length ? t('company.transferEmailRule') : t('company.transferNone')}>
          <select id="tr-to" className="sel" value={membershipId} onChange={(e) => setMembershipId(e.target.value)}>
            <option value="">{t('company.choosePerson')}</option>
            {options.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.email || m.emailVerified === false}>
                {!m.email ? t('company.transferNoEmail', { name: m.name }) : m.emailVerified === false ? t('company.transferNotVerified', { name: m.name }) : m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('company.transferPassword')} htmlFor="tr-pw" help={t('company.transferPasswordHelp')}>
          <input id="tr-pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {go.isError && <Notice tone="err">{transferError(go.error, t)}</Notice>}
      </div>
    </Modal>
  );
}

/** Devir reddi: doğrulanmamış e-posta ile e-postasız durumu ayrı metinle anlatılır. */
function transferError(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError && e.code === 'OWNER_REQUIRES_EMAIL') {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    return reason === 'EMAIL_NOT_VERIFIED' ? t('company.ownerRequiresVerified') : t('company.ownerRequiresEmail');
  }
  return apiMessage(e, t('common.unexpected'));
}
